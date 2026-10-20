import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, In, Not, Repository } from "typeorm";

import { Config } from "../config";
import { RampBankAccountEntity } from "../entities/ramp-bank-account.entity";
import type { SessionEntity } from "../entities/session.entity";
import type { UserEntity } from "../entities/user.entity";
import { bankByCode, directoryEntry } from "../ramp/bank-directory";
import type {
  Actor,
  ApiAdminBankAccount,
  ApiRampBankAccount,
  RampBankAccountStatus,
  RampBankProof,
  RampNameForm,
} from "../types";
import { ApiError } from "../util/errors";
import { maskIban, parseByIban } from "../util/iban";
import { nameKeys, nameTokenKeys } from "../util/name-fold";
import { formatAmount, parseAmount } from "../util/money";
import { HOUR_MS, MINUTE_MS, toIso } from "../util/time";
import { AuditService } from "./audit.service";
import { KycIdentityPort, type VerifiedIdentity, type VerifiedName } from "./kyc-identity.port";
import {
  RAMP_IBAN_INDEX_PURPOSE,
  type RampBankDestination,
  type RampBankRailImpl,
  normalizeIbanForIndex,
} from "./ramp-bank-rail.port";
import { rampIbanAad } from "./ramp-bank-sealing.service";
import { RampCompliancePort } from "./ramp-compliance.port";
import { rampPayerAad } from "./ramp-payer-sealing.service";
import type { RampOrderEntity } from "../entities/ramp-order.entity";
import { RateLimitService } from "./rate-limit.service";
import { SealedDataService } from "./sealed-data.service";

/** Adding an account needs a session authenticated this recently (SPEC §10.2, X10). */
export const RECENT_AUTH_MS = 15 * MINUTE_MS;
/** Accounts a user may add per rolling 24 h (removed ones included). */
export const BANK_ACCOUNT_ADDS_PER_DAY = 5;
/** Off-ramp statuses whose payout may still go to the account (the first-payout cap counts them). */
const OPEN_PAYOUT: readonly string[] = [
  "awaiting_withdrawal",
  "withdrawing",
  "burning",
  "payout_queued",
  "payout_sent",
  "needs_review",
];
/** A removal is refused while any order may still send money to the account. */
const IN_FLIGHT = [...OPEN_PAYOUT, "reversing"];
/** What a bank's payment order accepts as an individual's name (SPEC §10.3, X16). */
export const BENEFICIARY_NAME_RE = /^[\p{L}][\p{L} .'-]{0,139}$/u;

/** `Last First Middle` — the order Belarusian payment orders name an individual in. */
export function fullName(name: VerifiedName): string {
  return [name.last, name.first, name.middle]
    .filter((p) => p && p.trim())
    .join(" ")
    .trim();
}

/**
 * The bank-reported payer IS the account holder (X10, C10): one verified name form's surname AND
 * first name are among the payer string's words (any order, any script: be / ru / Latin fold to
 * shared keys). A relative sharing only the surname, or a third party, is not.
 */
export function payerIsHolder(payerName: string, names: readonly VerifiedName[]): boolean {
  const words = new Set([...nameTokenKeys(payerName).flat(), ...nameKeys(payerName)]);
  if (words.size === 0) return false;
  const named = (part: string | null | undefined): boolean =>
    !!part?.trim() && [...nameKeys(part), ...nameTokenKeys(part).flat()].some((k) => words.has(k));
  return names.some((n) => named(n.last) && named(n.first));
}

export function nameInForm(identity: VerifiedIdentity | null, form: RampNameForm): string | null {
  const name = identity?.names.find((n) => n.script === form);
  return name ? fullName(name) : null;
}

/** One refusal for every bank-level and shared-IBAN case: no enumeration (X10 c). */
function notUsable(): ApiError {
  return new ApiError(400, "bank_account_invalid", "this IBAN cannot be used for payouts");
}

const PROBLEM_TEXT: Record<string, string> = {
  empty: "enter an IBAN",
  country: "only Belarusian (BY) IBANs can receive payouts",
  length: "a Belarusian IBAN has 28 characters",
  format: "this is not a Belarusian IBAN",
  checksum: "the IBAN's check digits do not match (a typo?)",
};

/**
 * Users' payout bank accounts (SPEC §10.2) and the bank rail port's implementation. An account is
 * a BYN IBAN of a Belarusian bank (dated NBRB directory, RAMP_BLOCKED_BANK_CODES) in the user's
 * VERIFIED name — the name form is chosen, the name itself is read from the identity whenever a
 * payout file is built. Adding needs a fresh session, stays within the per-user limits, and a hit
 * on another user's IBAN answers like any unusable IBAN while it raises TM-SHAREDIBAN for both.
 * New accounts cool off, then become `active` only with a proof: a captured non-cash ERIP payment
 * from this IBAN (`payer_match`), the bank's name check (`bank_name_check`), or the four-eyes
 * `ramp.bank_account.verify` (`manual`). Until the first payout completes, at most
 * RAMP_BANK_FIRST_PAYOUT_MAX may be in flight to it.
 */
@Injectable()
export class RampBankAccountsService implements RampBankRailImpl {
  private readonly logger = new Logger(RampBankAccountsService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(RampBankAccountEntity) readonly accounts: Repository<RampBankAccountEntity>,
    private readonly sealed: SealedDataService,
    private readonly identity: KycIdentityPort,
    private readonly compliance: RampCompliancePort,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** The client-money account is configured (batches, statements). */
  get configured(): boolean {
    return Boolean(this.config.rampBank.accountIban);
  }

  /** Users may add accounts and cash out to them. */
  get offered(): boolean {
    return this.configured && this.config.ramp.payoutRails.includes("bank");
  }

  // ───────────────────────────────────────────── user API ───────────────────────────────────

  async list(userId: string): Promise<ApiRampBankAccount[]> {
    const rows = await this.accounts.find({
      where: { userId, status: Not("removed") },
      order: { createdAt: "ASC" },
    });
    for (const row of rows) await this.promote(row);
    const identity = rows.length ? await this.identity.get(userId).catch(() => null) : null;
    return rows.map((r) => this.toApi(r, identity));
  }

  async add(
    user: UserEntity,
    session: SessionEntity,
    input: { iban: string; nameForm: RampNameForm },
    actor: Actor,
  ): Promise<ApiRampBankAccount> {
    if (!this.offered)
      throw new ApiError(409, "ramp_rail_unavailable", "bank payouts are not available", {
        rail: "bank",
      });
    // The sign-in time from Postgres: a cached session carries no creation time.
    const [signedIn] = await this.dataSource.query<{ created_at: Date }[]>(
      `SELECT created_at FROM to_sessions WHERE id = $1 AND revoked_at IS NULL`,
      [session.id],
    );
    if (!signedIn || Date.now() - new Date(signedIn.created_at).getTime() > RECENT_AUTH_MS)
      throw new ApiError(401, "recent_auth_required", "sign in again to add a bank account");
    await this.rateLimit.hit("ramp_bank_account", `userId:${user.id}`, HOUR_MS, 10);
    if (user.kycStatus !== "approved")
      throw new ApiError(409, "kyc_required", "verify your identity first");
    let identity: VerifiedIdentity | null;
    try {
      identity = await this.identity.get(user.id);
    } catch {
      throw new ApiError(
        409,
        "kyc_identity_unavailable",
        "your verified identity cannot be read now",
      );
    }
    if (!identity) throw new ApiError(409, "kyc_required", "verify your identity first");
    if (!nameInForm(identity, input.nameForm))
      throw new ApiError(
        400,
        "validation_failed",
        "your verified identity has no name in this form",
        {
          nameForms: identity.names.map((n) => n.script),
        },
      );
    const parsed = parseByIban(input.iban);
    if (!parsed.ok)
      throw new ApiError(
        400,
        "bank_account_invalid",
        PROBLEM_TEXT[parsed.problem] ?? "invalid IBAN",
      );
    const bank = bankByCode(parsed.bankCode);
    if (!bank || this.config.rampBank.blockedBankCodes.includes(parsed.bankCode)) throw notUsable();

    const keys = this.sealed.blindIndexes(
      RAMP_IBAN_INDEX_PURPOSE,
      normalizeIbanForIndex(parsed.iban),
    );
    const existing = await this.accounts.find({
      where: keys.map((k) => ({ ibanHash: k.hash, ibanHashKid: k.kid })),
    });
    if (existing.some((a) => a.userId === user.id && a.status !== "removed"))
      throw new ApiError(409, "bank_account_exists", "this account is already on your list");
    const others = [...new Set(existing.filter((a) => a.userId !== user.id).map((a) => a.userId))];
    if (others.length) {
      await this.sharedIban(user.id, others, parsed.bankCode, parsed.last4, actor);
      throw notUsable();
    }

    const id = randomUUID();
    const index = this.sealed.blindIndex(
      RAMP_IBAN_INDEX_PURPOSE,
      normalizeIbanForIndex(parsed.iban),
    );
    const row = await this.dataSource.transaction(async (m) => {
      // Serialise one user's adds so the limits cannot be raced.
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ramp-bank-account:${user.id}`]);
      const [counts] = await m.query<{ live: number; recent: number }[]>(
        `SELECT count(*) FILTER (WHERE status <> 'removed')::int AS live,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS recent
           FROM to_ramp_bank_accounts WHERE user_id = $1`,
        [user.id],
      );
      if (counts.live >= this.config.rampBank.maxAccounts)
        throw new ApiError(409, "bank_account_limit", "remove an account before adding another", {
          max: this.config.rampBank.maxAccounts,
        });
      if (counts.recent >= BANK_ACCOUNT_ADDS_PER_DAY)
        throw new ApiError(409, "bank_account_limit", "too many accounts added today", {
          perDay: BANK_ACCOUNT_ADDS_PER_DAY,
        });
      const repo = m.getRepository(RampBankAccountEntity);
      const entity = repo.create({
        id,
        userId: user.id,
        ibanSealed: this.sealed.seal(parsed.iban, rampIbanAad(user.id, id)),
        ibanHash: index.hash,
        ibanHashKid: index.kid,
        ibanLast4: parsed.last4,
        country: "BY",
        bankCode: parsed.bankCode,
        bic: bank.bic,
        bankName: bank.nameEn,
        nameForm: input.nameForm,
        status: "cooling_off",
        coolingOffUntil: new Date(Date.now() + this.config.rampBank.accountCooloffHours * HOUR_MS),
        proof: null,
        proofRef: null,
        verifiedAt: null,
      });
      try {
        await repo.insert(entity);
      } catch (err) {
        // The partial unique index: another user registered the IBAN concurrently.
        if ((err as { code?: string }).code === "23505") throw notUsable();
        throw err;
      }
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "ramp.bank_account.added",
          subjectType: "ramp_bank_account",
          subjectId: id,
          metadata: {
            userId: user.id,
            bankCode: parsed.bankCode,
            ibanLast4: parsed.last4,
            nameForm: input.nameForm,
          },
          ip: actor.ip ?? null,
        },
        m,
      );
      return entity;
    });
    return this.toApi(await this.accounts.findOneByOrFail({ id: row.id }), identity);
  }

  /** TM-SHAREDIBAN for the adding user and every holder of the IBAN (SPEC §10.2); the add answers like any unusable IBAN. */
  private async sharedIban(
    userId: string,
    others: string[],
    bankCode: string,
    last4: string,
    actor: Actor,
  ): Promise<void> {
    const figures = { bankCode, ibanLast4: last4 };
    for (const u of [userId, ...others]) {
      try {
        await this.compliance.raise("TM-SHAREDIBAN", u, {
          ...figures,
          linkedUserIds: [userId, ...others].filter((x) => x !== u),
        });
      } catch (err) {
        this.logger.error(`TM-SHAREDIBAN for ${u} could not be raised: ${(err as Error).message}`);
      }
    }
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "ramp.bank_account.shared_iban",
      subjectType: "user",
      subjectId: userId,
      metadata: { ...figures, otherUsers: others.length },
      ip: actor.ip ?? null,
    });
  }

  async remove(userId: string, id: string, actor: Actor): Promise<ApiRampBankAccount> {
    const row = await this.accounts.findOne({ where: { id, userId } });
    if (!row || row.status === "removed")
      throw new ApiError(404, "not_found", "bank account not found");
    const [busy] = await this.dataSource.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM to_ramp_orders WHERE bank_account_id = $1 AND status = ANY($2::text[])`,
      [id, IN_FLIGHT],
    );
    if (busy.n > 0)
      throw new ApiError(
        409,
        "bank_account_in_use",
        "a payout to this account is still in progress",
      );
    const res = await this.accounts.update(
      { id, status: row.status },
      { status: "removed", removedAt: new Date() },
    );
    if (!res.affected)
      throw new ApiError(409, "bank_account_in_use", "the account changed; try again");
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "ramp.bank_account.removed",
      subjectType: "ramp_bank_account",
      subjectId: id,
      metadata: { userId, from: row.status },
      ip: actor.ip ?? null,
    });
    return this.toApi(await this.accounts.findOneByOrFail({ id }), null);
  }

  // ───────────────────────────────────────────── lifecycle ──────────────────────────────────

  /**
   * Move an account on when it is due: the cooling-off over → `pending_proof`, and → `active` as
   * soon as a proof exists. A compare-and-set on the status; the row is refreshed in place.
   */
  async promote(row: RampBankAccountEntity): Promise<RampBankAccountEntity> {
    if (row.status !== "cooling_off" && row.status !== "pending_proof") return row;
    if (row.coolingOffUntil.getTime() > Date.now()) return row;
    const proof = row.proof ? { proof: row.proof, ref: row.proofRef } : await this.findProof(row);
    const next: RampBankAccountStatus = proof ? "active" : "pending_proof";
    if (next === row.status) return row;
    const res = await this.accounts.update(
      { id: row.id, status: row.status },
      proof
        ? {
            status: next,
            proof: proof.proof,
            proofRef: proof.ref,
            verifiedAt: row.verifiedAt ?? new Date(),
          }
        : { status: next },
    );
    Object.assign(row, await this.accounts.findOneByOrFail({ id: row.id }));
    if (res.affected && next === "active")
      await this.audit.record({
        actorType: "system",
        action: "ramp.bank_account.activated",
        subjectType: "ramp_bank_account",
        subjectId: row.id,
        metadata: { userId: row.userId, proof: row.proof, proofRef: row.proofRef },
      });
    return row;
  }

  /** Every account due for a move (RampBankProcessor). */
  async promoteDue(): Promise<number> {
    const rows = await this.accounts.find({
      where: { status: In(["cooling_off", "pending_proof"]) },
      order: { coolingOffUntil: "ASC" },
      take: 500,
    });
    let moved = 0;
    for (const row of rows) {
      const before = row.status;
      if ((await this.promote(row)).status !== before) moved += 1;
    }
    return moved;
  }

  /**
   * A proof the system can see (X10): a captured non-cash ERIP payment of this user from this very
   * IBAN whose PAYER'S BANK named the account holder (`payer_match`, C10: the acquirer's payer IBAN
   * hash, the bank-reported payer name = the verified surname AND first name, the order on its way
   * to completion with nothing refunded, its capture allowed without TM-THIRDPARTY and no review
   * holding it), else the bank's name check when it is confirmed for the client-money bank
   * (`bank_name_check`). Anything unreadable proves nothing (fail closed: four-eyes manual proof).
   */
  async findProof(
    row: RampBankAccountEntity,
  ): Promise<{ proof: RampBankProof; ref: string | null } | null> {
    const payer = await this.payerProof(row).catch((err: Error) => {
      this.logger.warn(`account ${row.id}: payer_match not evaluated: ${err.message}`);
      return null;
    });
    if (payer) return { proof: "payer_match", ref: payer };
    return this.config.rampBank.nameChecked ? { proof: "bank_name_check", ref: null } : null;
  }

  /** The order proving the account by `payer_match` (C10), or null. */
  private async payerProof(row: RampBankAccountEntity): Promise<string | null> {
    // Matched in SQL under every index kid in the ring (C41: a payment after a rotation counts too).
    const payers = await this.dataSource.query<{ id: string; sealed: string }[]>(
      `SELECT id, details -> 'payment' ->> 'payerNameSealed' AS sealed
         FROM to_ramp_orders
        WHERE user_id = $1 AND direction = 'onramp' AND method = 'erip' AND captured_at IS NOT NULL
          AND status IN ('paid', 'minting', 'crediting', 'completed') AND refunded_amount = 0
          AND details -> 'payment' ->> 'channel' IN ('online', 'card')
          AND details -> 'payment' ->> 'payerNameSource' = 'bank'
          AND details -> 'payment' ->> 'payerNameSealed' IS NOT NULL
          AND risk -> 'onramp.capture' ->> 'decision' = 'allow'
          AND NOT (COALESCE(risk -> 'onramp.capture' -> 'rules', '[]'::jsonb) ? 'TM-THIRDPARTY')
          AND (details -> 'payment' -> 'payerIbanHash' ->> 'kid') || ':' || (details -> 'payment' -> 'payerIbanHash' ->> 'hash') = ANY($2::text[])
        ORDER BY captured_at DESC LIMIT 20`,
      [row.userId, this.keysOf(row)],
    );
    if (!payers.length) return null;
    const identity = await this.identity.get(row.userId);
    if (!identity) return null;
    for (const p of payers) {
      let name: string;
      try {
        name = this.sealed.unseal(p.sealed, rampPayerAad(row.userId, p.id));
      } catch {
        continue; // a payer name that does not open proves nothing
      }
      if (!payerIsHolder(name, identity.names)) continue;
      if (await this.compliance.isHeld(p.id)) continue;
      return p.id;
    }
    return null;
  }

  /** The account's IBAN under every index kid (`<kid>:<hash>`). */
  keysOf(row: RampBankAccountEntity): string[] {
    const iban = this.sealed.unseal(row.ibanSealed, rampIbanAad(row.userId, row.id));
    return this.sealed
      .blindIndexes(RAMP_IBAN_INDEX_PURPOSE, normalizeIbanForIndex(iban))
      .map((k) => `${k.kid}:${k.hash}`);
  }

  /** The plain IBAN for a payout file — unsealed with the ORDER's user id (a repointed row does not open). */
  ibanFor(row: RampBankAccountEntity, orderUserId: string): string {
    return this.sealed.unseal(row.ibanSealed, rampIbanAad(orderUserId, row.id));
  }

  /** A bank return named this account (a closed account, a name mismatch): no payout until re-proved. */
  async block(manager: EntityManager, accountId: string, reason: string): Promise<void> {
    await manager
      .getRepository(RampBankAccountEntity)
      .update(
        { id: accountId, status: In(["cooling_off", "pending_proof", "active"]) },
        { status: "blocked", blockedReason: reason.slice(0, 200) },
      );
    await this.audit.record(
      {
        actorType: "system",
        action: "ramp.bank_account.blocked",
        subjectType: "ramp_bank_account",
        subjectId: accountId,
        metadata: { reason: reason.slice(0, 200) },
      },
      manager,
    );
  }

  /** A payout to the account completed (the first one lifts the first-payout cap). */
  async markPaid(manager: EntityManager, accountId: string, orderId: string): Promise<void> {
    await manager.query(
      `UPDATE to_ramp_bank_accounts SET first_payout_order_id = COALESCE(first_payout_order_id, $2), last_used_at = now(), updated_at = now() WHERE id = $1`,
      [accountId, orderId],
    );
  }

  // ───────────────────────────────────────────── the rail port ──────────────────────────────

  /**
   * SPEC §10.2: the user's own, non-removed, ACTIVE (proved) account of a bank not blocked; while no
   * payout to it has completed, the open payouts to it (this one excluded) + `amount` stay within
   * RAMP_BANK_FIRST_PAYOUT_MAX.
   */
  async validateDestination(
    userId: string,
    bankAccountId: string,
    amount: bigint,
    opts: { orderId?: string | null } = {},
  ): Promise<RampBankDestination> {
    const row = await this.accounts.findOne({ where: { id: bankAccountId } });
    if (!row || row.userId !== userId || row.status === "removed")
      throw new ApiError(400, "bank_account_invalid", "choose one of your bank accounts");
    await this.promote(row);
    if (row.status !== "active")
      throw new ApiError(
        409,
        "ramp_rail_unavailable",
        "this bank account cannot receive payouts yet",
        {
          rail: "bank",
          reason: `bank_account_${row.status}`,
          usableFrom: row.status === "cooling_off" ? row.coolingOffUntil.toISOString() : null,
        },
      );
    if (this.config.rampBank.blockedBankCodes.includes(row.bankCode))
      throw new ApiError(409, "ramp_rail_unavailable", "payouts to this bank are not available", {
        rail: "bank",
        reason: "bank_blocked",
      });
    if (!row.firstPayoutOrderId) {
      const [open] = await this.dataSource.query<{ total: string }[]>(
        `SELECT COALESCE(SUM(fiat_amount), 0)::text AS total FROM to_ramp_orders
          WHERE bank_account_id = $1 AND direction = 'offramp' AND status = ANY($2::text[]) AND id <> COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [row.id, OPEN_PAYOUT, opts.orderId ?? null],
      );
      const inFlight = parseAmount(open.total);
      const cap = this.config.rampBank.firstPayoutMax;
      if (inFlight + amount > cap)
        throw new ApiError(
          409,
          "ramp_limit_exceeded",
          "the first payouts to a new account are limited",
          {
            limit: "bank_first_payout",
            max: formatAmount(cap),
            available: formatAmount(cap > inFlight ? cap - inFlight : 0n),
          },
        );
    }
    return this.destinationOf(row);
  }

  async describe(bankAccountId: string): Promise<RampBankDestination | null> {
    const row = await this.accounts.findOne({ where: { id: bankAccountId } });
    return row ? this.destinationOf(row) : null;
  }

  private destinationOf(row: RampBankAccountEntity): RampBankDestination {
    return {
      bankAccountId: row.id,
      bankName: row.bankName,
      bic: row.bic,
      ibanMasked: maskIban(row.ibanLast4),
    };
  }

  // ───────────────────────────────────────────── views ──────────────────────────────────────

  toApi(row: RampBankAccountEntity, identity: VerifiedIdentity | null): ApiRampBankAccount {
    return {
      id: row.id,
      ibanMasked: maskIban(row.ibanLast4),
      bankName: row.bankName,
      bic: row.bic,
      holderName: nameInForm(identity, row.nameForm),
      status: row.status,
      usableFrom: row.status === "cooling_off" ? row.coolingOffUntil.toISOString() : null,
      proof: row.proof,
    };
  }

  async adminList(filter: {
    status?: RampBankAccountStatus;
    userId?: string;
  }): Promise<ApiAdminBankAccount[]> {
    const rows = await this.accounts.find({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
      },
      order: { createdAt: "DESC" },
      take: 200,
    });
    return rows.map((r) => this.toAdminApi(r));
  }

  toAdminApi(r: RampBankAccountEntity): ApiAdminBankAccount {
    const entry = directoryEntry(r.bankCode);
    return {
      id: r.id,
      userId: r.userId,
      ibanMasked: maskIban(r.ibanLast4),
      bankCode: r.bankCode,
      bankName: r.bankName,
      bic: r.bic,
      nameForm: r.nameForm,
      status: r.status,
      coolingOffUntil: r.coolingOffUntil.toISOString(),
      proof: r.proof,
      proofRef: r.proofRef,
      verifiedAt: toIso(r.verifiedAt),
      firstPayoutOrderId: r.firstPayoutOrderId,
      lastUsedAt: toIso(r.lastUsedAt),
      sanctions: entry?.sanctions ?? { eu: [], us: [], uk: [] },
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** The account an order pays to (any status), for the batches and statements. */
  async forOrder(
    order: Pick<RampOrderEntity, "bankAccountId">,
  ): Promise<RampBankAccountEntity | null> {
    return order.bankAccountId
      ? this.accounts.findOne({ where: { id: order.bankAccountId } })
      : null;
  }
}
