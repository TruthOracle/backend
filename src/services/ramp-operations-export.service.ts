import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Between, Repository } from "typeorm";

import { Config } from "../config";
import { RampOrderEntity } from "../entities/ramp-order.entity";
import { type CsvValue, toCsv } from "../util/csv";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";
import { displayPayoutReference } from "../util/payout-reference";
import { unseal } from "../util/sealed";
import { DAY_MS } from "../util/time";
import type { AdminActor } from "./admin.service";
import { AuditService } from "./audit.service";
import { KycIdentityPort, type VerifiedIdentity, type VerifiedName } from "./kyc-identity.port";
import { rampPayerAad } from "./ramp-payer-sealing.service";

/** SPEC §11.6: one export covers at most 31 days. */
export const EXPORT_MAX_DAYS = 31;
/** Larger ranges are split by the operator (a register beyond this is not a spreadsheet any more). */
export const EXPORT_MAX_ROWS = 20_000;

/** The register's columns, in order (one row per order created in the range). */
export const OPERATIONS_COLUMNS = [
  "order_id",
  "created_at",
  "updated_at",
  "status_changed_at",
  "completed_at",
  "direction",
  "method",
  "payout_rail",
  "status",
  "review_step",
  "fiat_currency",
  "fiat_amount",
  "token_amount",
  "fee_amount",
  "captured_amount",
  "captured_at",
  "refunded_amount",
  "instrument_admin",
  "instrument_id",
  "payout_reference",
  "user_id",
  "party_id",
  "kyc_name_be",
  "kyc_name_ru",
  "kyc_name_lat",
  "kyc_birth_date",
  "kyc_citizenship",
  "kyc_residence_country",
  "operator_name",
  "operator_unp",
  "operator_htp_ref",
  "operator_terms_version",
  "consent_id",
  "provider",
  "provider_payment_id",
  "provider_refund_id",
  "provider_payout_id",
  "pending_payout_cid",
  "mint_command_id",
  "burn_command_id",
  "payment_provider_txn_id",
  "payment_rrn",
  "payment_erip_txn_id",
  "payment_agent_code",
  "payment_agent_name",
  "payment_channel",
  "payment_payer_name_source",
  "payment_payer_name",
  "payment_payer_bank_bic",
  "payment_card_issuer",
  "payment_issuer_country",
  "payment_three_ds",
  "payment_fee",
  "payment_settled_at",
  "payout_mode",
  "payout_bank_bic",
  "payout_bank_name",
  "payout_iban_last4",
  "payout_card_last4",
  "payout_executed_at",
  "bank_account_id",
  "payout_batch_id",
] as const;

export interface OperationsExport {
  exportId: string;
  filename: string;
  rows: number;
  csv: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

function fullName(n: VerifiedName | undefined): string | null {
  return n ? [n.last, n.first, n.middle].filter(Boolean).join(" ") : null;
}

/**
 * The operations register (SPEC §11.6; R4 "prompt reproduction for the DFM"): every ramp order
 * created in [from, to] (UTC, ≤ 31 days) with its UTC timestamps, direction, method / rail,
 * status, amounts, fee, currency, the operator-of-record snapshot, the account, the verified KYC
 * name in every form as of the order (KycIdentityPort.asOf, C14 / C15 — an unreadable or missing
 * identity fails the whole export: `409 kyc_identity_unavailable`, an incomplete register is worse
 * than none), the `details.payment`
 * facts (the bank-supplied payer name unsealed), `details.payout`, provider ids and the payout
 * reference. The first CSV record names the export (id, time, range, row count); then the header;
 * cells in human mode (formula-safe). The row count is audited.
 */
@Injectable()
export class RampOperationsExportService {
  constructor(
    private readonly config: Config,
    @InjectRepository(RampOrderEntity) private readonly orders: Repository<RampOrderEntity>,
    private readonly identities: KycIdentityPort,
    private readonly audit: AuditService,
  ) {}

  async operations(
    range: { from: string; to: string },
    actor: AdminActor,
  ): Promise<OperationsExport> {
    const from = new Date(range.from);
    const to = new Date(range.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from)
      throw new ApiError(400, "export_range", "to must be after from");
    if (to.getTime() - from.getTime() > EXPORT_MAX_DAYS * DAY_MS)
      throw new ApiError(400, "export_range", `an export covers at most ${EXPORT_MAX_DAYS} days`, {
        maxDays: EXPORT_MAX_DAYS,
      });
    const orders = await this.orders.find({
      where: { createdAt: Between(from, to) },
      order: { createdAt: "ASC", id: "ASC" },
      take: EXPORT_MAX_ROWS + 1,
    });
    if (orders.length > EXPORT_MAX_ROWS)
      throw new ApiError(
        400,
        "export_range",
        `more than ${EXPORT_MAX_ROWS} orders: export a shorter range`,
        {
          maxRows: EXPORT_MAX_ROWS,
        },
      );
    // C14 / C15: each order with the identity its account was verified with when the order was
    // made (the stored versions, whatever the KYC status is today; no provider refresh) — the
    // provider only for an approved account with nothing stored. An order whose account has no
    // identity at all fails the export: blank cells would make an incomplete register.
    const identities = new Map<string, VerifiedIdentity>();
    for (const o of orders) {
      let identity: VerifiedIdentity | null;
      try {
        identity =
          (await this.identities.asOf(o.userId, o.createdAt)) ??
          (await this.identities.stored(o.userId)) ??
          (await this.identities.get(o.userId));
      } catch (err) {
        throw new ApiError(
          409,
          "kyc_identity_unavailable",
          `the verified identity of account ${o.userId} cannot be read now: ${(err as Error).message}`.slice(
            0,
            300,
          ),
          { userId: o.userId },
        );
      }
      if (!identity)
        throw new ApiError(
          409,
          "kyc_identity_unavailable",
          `account ${o.userId} has no stored verified identity: the register would be incomplete`,
          { userId: o.userId, orderId: o.id },
        );
      identities.set(o.id, identity);
    }
    const exportId = randomUUID();
    const generatedAt = new Date();
    const meta: CsvValue[] = [
      "export_id",
      exportId,
      "generated_at",
      generatedAt,
      "from",
      from,
      "to",
      to,
      "rows",
      orders.length,
    ];
    const csv =
      toCsv([meta], "human") +
      toCsv(
        orders.map((o) => this.row(o, identities.get(o.id) ?? null)),
        "human",
        [...OPERATIONS_COLUMNS],
      );
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      ip: actor.ip,
      action: "ramp.operations.exported",
      subjectType: "ramp_export",
      subjectId: exportId,
      metadata: {
        from: from.toISOString(),
        to: to.toISOString(),
        rows: orders.length,
        operatorPerson: actor.personId,
      },
    });
    const day = (d: Date): string => d.toISOString().slice(0, 10);
    return {
      exportId,
      filename: `ramp-operations-${day(from)}-${day(to)}-${exportId.slice(0, 8)}.csv`,
      rows: orders.length,
      csv,
    };
  }

  private row(o: RampOrderEntity, identity: VerifiedIdentity | null): CsvValue[] {
    const pay = (o.details?.payment ?? {}) as Record<string, unknown>;
    const out = (o.details?.payout ?? {}) as Record<string, unknown>;
    const form = (script: VerifiedName["script"]): string | null =>
      fullName(identity?.names.find((n) => n.script === script));
    const op = o.operator;
    const amount = (v: bigint | null): string | null => (v === null ? null : formatAmount(v));
    return [
      o.id,
      o.createdAt,
      o.updatedAt,
      o.statusChangedAt,
      o.completedAt,
      o.direction,
      o.method,
      o.payoutRail,
      o.status,
      o.reviewStep,
      o.fiatCurrency,
      amount(o.fiatAmount),
      amount(o.tokenAmount),
      amount(o.feeAmount),
      amount(o.capturedAmount),
      o.capturedAt,
      amount(o.refundedAmount),
      o.instrumentAdmin,
      o.instrumentId,
      displayPayoutReference(o.payoutReference),
      o.userId,
      o.partyId,
      form("be"),
      form("ru"),
      form("lat"),
      identity?.birthDate ?? null,
      identity?.citizenship ?? null,
      identity?.residenceCountry ?? null,
      op?.name ?? null,
      op?.unp ?? null,
      op?.htpRef ?? null,
      op?.termsVersion ?? null,
      o.consentId,
      o.provider,
      o.providerPaymentId,
      o.providerRefundId,
      o.providerPayoutId,
      o.pendingPayoutCid,
      o.mintCommandId,
      o.burnCommandId,
      str(pay.providerTxnId),
      str(pay.rrn),
      str(pay.eripTxnId),
      str(pay.agentCode),
      str(pay.agentName),
      str(pay.channel),
      str(pay.payerNameSource),
      this.payerName(o, str(pay.payerNameSealed)),
      str(pay.payerBankBic),
      str(pay.cardIssuerName),
      str(pay.issuerCountry),
      str(pay.threeDs),
      str(pay.fee),
      str(pay.settledAt),
      str(out.mode),
      str(out.bankBic),
      str(out.bankName),
      str(out.ibanLast4),
      str(out.cardLast4),
      str(out.executedAt),
      o.bankAccountId,
      o.payoutBatchId,
    ];
  }

  /** The bank-supplied payer name, unsealed with the owner's AAD; an unreadable blob is marked, not hidden. */
  private payerName(o: RampOrderEntity, sealed: string | null): string | null {
    if (!sealed) return null;
    try {
      return unseal(sealed, this.config.sealing.data, rampPayerAad(o.userId, o.id));
    } catch {
      return "(unreadable)";
    }
  }
}
