import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { EntityManager, Repository } from "typeorm";

import { Config } from "../config";
import {
  RAMP_CLIENT_LIABILITY_ACCOUNTS,
  RampJournalEntity,
  type RampAccount,
} from "../entities/ramp-journal.entity";
import type { RampOrderEntity } from "../entities/ramp-order.entity";
import type { ApiRampJournalLine } from "../types";
import { AMOUNT_DECIMALS, formatAmount, parseAmount, quantizeDown } from "../util/money";

/**
 * Order-scoped posting kinds (SPEC §5). Line-scoped kinds (`psp.settlement`, `bank.fee`, …) are
 * S6's and go through `postEntry`. F charged, C captured, N minted, f fee (on-ramp); T withdrawn,
 * P paid, f fee (off-ramp); e a PSP fee; R a partial amount.
 */
export const RAMP_ORDER_KINDS = [
  "onramp.captured",
  "psp.fee_accrued",
  "onramp.minted",
  "onramp.refunded",
  "onramp.voided",
  "onramp.refund_queued",
  "refund.paid_bank",
  "refund.returned_bank",
  "onramp.chargeback",
  "onramp.chargeback_minted",
  "onramp.uncredited_burned",
  "onramp.chargeback_after_refund",
  "onramp.chargeback_reversed",
  "onramp.refund_cancelled",
  "onramp.refund_reinstated",
  "offramp.burned",
  "offramp.paid_card",
  "offramp.paid_bank",
  "offramp.returned_bank",
  "offramp.reminted",
  "offramp.reversed_partial",
] as const;
export type RampOrderKind = (typeof RAMP_ORDER_KINDS)[number];

/** Each gives issuance_pending back: refunded, voided, chargeback and refund_queued are mutually exclusive per order (#10). */
export const RAMP_IP_RELEASES: readonly RampOrderKind[] = [
  "onramp.refunded",
  "onramp.voided",
  "onramp.chargeback",
  "onramp.refund_queued",
];

/** The kinds the token sync posts when the command becomes recorded (#9). */
export const RAMP_TOKEN_KINDS: readonly RampOrderKind[] = [
  "onramp.minted",
  "offramp.burned",
  "offramp.reminted",
  "onramp.uncredited_burned",
];

type OrderFigures = Pick<
  RampOrderEntity,
  "direction" | "fiatAmount" | "tokenAmount" | "feeAmount" | "capturedAmount"
>;

/**
 * What an on-ramp's capture booked: `{charged F, net N, fee f}` when C = F, else the refund-only
 * basis `{C, C, 0}` (C ≠ F is never minted, only refunded; SPEC §5 `onramp.captured`).
 */
export function onrampBasis(order: OrderFigures): { charged: bigint; net: bigint; fee: bigint } {
  const captured = order.capturedAmount ?? order.fiatAmount;
  return captured === order.fiatAmount
    ? { charged: order.fiatAmount, net: order.tokenAmount, fee: order.feeAmount }
    : { charged: captured, net: captured, fee: 0n };
}

/** `e` when the acquirer reports none: ceil to the fiat's smallest unit of `amount × bps / 10 000`. */
export function accruedPspFee(
  amount: bigint,
  providerFee: bigint | null,
  bps: number,
  fiatDecimals: number,
): bigint {
  if (providerFee !== null && providerFee >= 0n) return providerFee;
  const raw = (amount * BigInt(bps) + 9_999n) / 10_000n;
  const down = quantizeDown(raw, fiatDecimals);
  return down === raw ? raw : down + 10n ** BigInt(AMOUNT_DECIMALS - fiatDecimals);
}

/**
 * One posting as `[account, signed amount]` lines (+ debit, − credit) — SPEC §5's table, pure
 * so it is unit-tested line by line. `extra` = e for `psp.fee_accrued`, R for the partial kinds,
 * the disputed amount D for the chargeback kinds (S8: a card cash-out's refunds already left the
 * capture; 0 = C).
 */
export function postingFor(
  kind: RampOrderKind,
  order: OrderFigures,
  extra: bigint = 0n,
): [RampAccount, bigint][] {
  const { charged, net, fee } = onrampBasis(order);
  // off-ramp: T = token_amount withdrawn, P = fiat_amount paid
  const T = order.tokenAmount;
  const P = order.fiatAmount;
  const f = order.feeAmount;
  switch (kind) {
    case "onramp.captured":
      return [
        ["provider_clearing", charged],
        ["issuance_pending", -net],
        ["fee_revenue", -fee],
      ];
    case "psp.fee_accrued":
      return [
        ["psp_fees", extra],
        ["provider_clearing", -extra],
      ];
    case "onramp.minted":
      return [
        ["issuance_pending", order.tokenAmount],
        ["customer_liability", -order.tokenAmount],
      ];
    case "onramp.refunded":
    case "onramp.voided":
    case "onramp.chargeback":
      return [
        ["issuance_pending", net],
        ["fee_revenue", fee],
        ["provider_clearing", -charged],
      ];
    case "onramp.refund_queued":
      return [
        ["issuance_pending", net],
        ["fee_revenue", fee],
        ["payout_clearing", -charged],
      ];
    case "refund.paid_bank":
      return [
        ["payout_clearing", charged],
        ["safeguard_bank", -charged],
      ];
    case "refund.returned_bank":
      // S8: the bank sent an on-ramp's refund back (line amount R = `extra`): owed again in full,
      // a return fee (F − R) is ours — as `offramp.returned_bank`.
      return [
        ["safeguard_bank", extra],
        ["bank_fees", charged - extra],
        ["payout_clearing", -charged],
      ];
    case "onramp.chargeback_minted":
    case "onramp.chargeback_after_refund": {
      const disputed = extra > 0n ? extra : charged;
      return [
        ["chargeback_receivable", disputed],
        ["provider_clearing", -disputed],
      ];
    }
    case "onramp.chargeback_reversed": {
      // `extra` = the receivable the chargeback booked (D).
      const disputed = extra > 0n ? extra : charged;
      return [
        ["provider_clearing", disputed],
        ["chargeback_receivable", -disputed],
      ];
    }
    case "onramp.refund_cancelled": {
      // C19: a chargeback returned the money a queued bank refund still owed — the refund's
      // liability is reversed against the receivable the chargeback booked (`extra` = the owed F).
      const owed = extra > 0n ? extra : charged;
      return [
        ["payout_clearing", owed],
        ["chargeback_receivable", -owed],
      ];
    }
    case "onramp.refund_reinstated": {
      // C19: a dispute won after refund_cancel — the acquirer holds the money again and the user,
      // whose chargeback the issuer took back, is owed the cancelled refund by bank again
      // (`extra` = the owed F that refund_cancelled netted).
      const owed = extra > 0n ? extra : charged;
      return [
        ["provider_clearing", owed],
        ["payout_clearing", -owed],
      ];
    }
    case "onramp.uncredited_burned":
      return [
        ["customer_liability", order.tokenAmount],
        ["fee_revenue", order.feeAmount],
        ["chargeback_receivable", -order.fiatAmount],
      ];
    case "offramp.burned":
      return [
        ["customer_liability", T],
        ["payout_clearing", -P],
        ["fee_revenue", -f],
      ];
    case "offramp.paid_card":
      // `extra` > 0: the parts a reverse_remainder leaves paid (SPEC §4.2); else all of P.
      return [
        ["payout_clearing", extra > 0n ? extra : P],
        ["provider_clearing", -(extra > 0n ? extra : P)],
      ];
    case "offramp.paid_bank":
      return [
        ["payout_clearing", P],
        ["safeguard_bank", -P],
      ];
    case "offramp.returned_bank":
      return [
        ["safeguard_bank", extra],
        ["bank_fees", P - extra],
        ["payout_clearing", -P],
      ];
    case "offramp.reminted":
      return [
        ["payout_clearing", P],
        ["fee_revenue", f],
        ["customer_liability", -T],
      ];
    case "offramp.reversed_partial":
      return [
        ["payout_clearing", extra],
        ["customer_liability", -extra],
      ];
  }
}

/** A posting any stage builds itself (S6's line-scoped kinds): the lines must sum to zero. */
export interface RampJournalEntryInput {
  kind: string;
  currency: string;
  lines: [RampAccount, bigint][];
  orderId?: string | null;
  statementLineId?: string | null;
  /** Written on the client-liability lines. */
  userId?: string | null;
}

/**
 * The append-only double-entry journal in fiat (SPEC §5). Order-scoped postings are written
 * inside the transaction that causes them — the order's compare-and-set, or the token sync's
 * transaction for the token kinds — so a posting exists exactly when its cause committed. Every
 * order-scoped kind posts at most once per order (`post` answers null for a repeat; the unique
 * index is the backstop) — except the bank refund kinds, booked once per statement line: a refund
 * the bank returned is paid again (S8) — and the issuance_pending releases are mutually exclusive.
 * Zero lines are skipped; a posting that does not sum to zero throws before anything is written.
 */
@Injectable()
export class RampJournalService {
  constructor(
    private readonly config: Config,
    @InjectRepository(RampJournalEntity) private readonly lines: Repository<RampJournalEntity>,
  ) {}

  /**
   * The FIRST observation of a capture (#12), whatever the order moves to: `onramp.captured` with
   * the order's captured amount C, and `psp.fee_accrued` (the acquirer's fee, else the method's
   * RAMP_<M>_PSP_FEE_BPS). Idempotent; the order must already carry `captured_amount`.
   */
  async bookCapture(
    manager: EntityManager,
    order: OrderFigures & Pick<RampOrderEntity, "id" | "userId" | "fiatCurrency" | "method">,
    providerFee: bigint | null,
  ): Promise<void> {
    if (order.capturedAmount === null)
      throw new Error(`ramp journal: order ${order.id} has no capture`);
    if (!(await this.post(manager, order, "onramp.captured"))) return;
    const fee = accruedPspFee(
      order.capturedAmount,
      providerFee,
      this.config.ramp.method[order.method ?? "card"].pspFeeBps,
      this.config.ramp.fiatDecimals,
    );
    if (fee > 0n) await this.post(manager, order, "psp.fee_accrued", fee);
  }

  /**
   * Post `kind` for the order once. Returns the entry id, or null when it was already posted.
   * Throws when another issuance_pending release of the order exists (a caller bug: it must pick
   * the variant first, e.g. `chargeback_after_refund`).
   */
  async post(
    manager: EntityManager,
    order: OrderFigures & Pick<RampOrderEntity, "id" | "userId" | "fiatCurrency">,
    kind: RampOrderKind,
    extra?: bigint,
  ): Promise<string | null> {
    const done = await this.postedKinds(manager, order.id);
    if (done.has(kind)) return null;
    if (RAMP_IP_RELEASES.includes(kind)) {
      const other = RAMP_IP_RELEASES.find((k) => done.has(k));
      if (other) throw new Error(`ramp journal: ${kind} after ${other} for order ${order.id}`);
    }
    return this.postEntry(manager, {
      kind,
      currency: order.fiatCurrency,
      lines: postingFor(kind, order, extra),
      orderId: order.id,
      userId: order.userId,
    });
  }

  /** Write one balanced entry (zero lines dropped). The generic path for S6's line-scoped kinds. */
  async postEntry(manager: EntityManager, input: RampJournalEntryInput): Promise<string> {
    const lines = input.lines.filter(([, amount]) => amount !== 0n);
    const sum = lines.reduce((s, [, a]) => s + a, 0n);
    if (sum !== 0n)
      throw new Error(`ramp journal: ${input.kind} does not balance (${formatAmount(sum)})`);
    if (lines.length === 0) throw new Error(`ramp journal: ${input.kind} has no lines`);
    const entryId = randomUUID();
    const repo = manager.getRepository(RampJournalEntity);
    await repo.insert(
      lines.map(([account, amount]) =>
        repo.create({
          entryId,
          kind: input.kind,
          orderId: input.orderId ?? null,
          statementLineId: input.statementLineId ?? null,
          userId: RAMP_CLIENT_LIABILITY_ACCOUNTS.includes(account) ? (input.userId ?? null) : null,
          account,
          currency: input.currency,
          amount,
        }),
      ),
    );
    return entryId;
  }

  async posted(manager: EntityManager, orderId: string, kind: RampOrderKind): Promise<boolean> {
    return (await this.postedKinds(manager, orderId)).has(kind);
  }

  /** The kinds already posted for an order. */
  /** Σ of one account's lines in an order's postings of `kinds` (e.g. the receivable a chargeback booked). */
  async postedAmount(
    manager: EntityManager,
    orderId: string,
    kinds: readonly RampOrderKind[],
    account: RampAccount,
  ): Promise<bigint> {
    const [row] = await manager.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ramp_journal
        WHERE order_id = $1 AND kind = ANY($2) AND account = $3`,
      [orderId, [...kinds], account],
    );
    return parseAmount(row.total);
  }

  /** How many entries of `kind` the order has (the bank refund kinds repeat after a return, S8). */
  async postedCount(manager: EntityManager, orderId: string, kind: RampOrderKind): Promise<number> {
    const [row] = await manager.query<{ n: number }[]>(
      `SELECT COUNT(DISTINCT entry_id)::int AS n FROM to_ramp_journal WHERE order_id = $1 AND kind = $2`,
      [orderId, kind],
    );
    return row?.n ?? 0;
  }

  async postedKinds(manager: EntityManager, orderId: string): Promise<Set<string>> {
    const rows = await manager.query<{ kind: string }[]>(
      `SELECT DISTINCT kind FROM to_ramp_journal WHERE order_id = $1`,
      [orderId],
    );
    return new Set(rows.map((r) => r.kind));
  }

  /** Σ per account (positive = debit balance). */
  async balances(manager?: EntityManager): Promise<Record<string, bigint>> {
    const rows = await (manager ?? this.lines.manager).query<{ account: string; total: string }[]>(
      `SELECT account, COALESCE(SUM(amount), 0)::text AS total FROM to_ramp_journal GROUP BY account`,
    );
    return Object.fromEntries(rows.map((r) => [r.account, parseAmount(r.total)]));
  }

  /** Entries whose lines do not sum to zero — must always be empty. */
  async unbalancedEntries(): Promise<string[]> {
    const rows = await this.lines.manager.query<{ entry_id: string }[]>(
      `SELECT entry_id FROM to_ramp_journal GROUP BY entry_id HAVING SUM(amount) <> 0 LIMIT 50`,
    );
    return rows.map((r) => r.entry_id);
  }

  async forOrder(orderId: string): Promise<ApiRampJournalLine[]> {
    const rows = await this.lines.find({ where: { orderId }, order: { id: "ASC" } });
    return rows.map((r) => ({
      entryId: r.entryId,
      kind: r.kind,
      orderId: r.orderId,
      statementLineId: r.statementLineId,
      userId: r.userId,
      account: r.account,
      currency: r.currency,
      amount: formatAmount(r.amount),
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
