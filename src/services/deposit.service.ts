import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, Repository } from "typeorm";

import { Config } from "../config";
import { type DepositAttribution, DepositCreditEntity } from "../entities/deposit-credit.entity";
import { WalletEntity } from "../entities/wallet.entity";
import {
  type Actor,
  type InAppWalletOverview,
  type LedgerWallet,
  NatsSubjects,
  type ReconcileResult,
  type TransferRow,
} from "../types";
import { ApiError } from "../util/errors";
import { DUST, formatCC, parseCC } from "../util/money";
import { AuditService } from "./audit.service";
import { EnterpriseWalletService } from "./enterprise-wallet.service";
import { LedgerClientService } from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { PayoutService } from "./payout.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { UserService } from "./user.service";
import { ledgerWalletToApi, walletToApi } from "./wallet-link.service";

// ---------------------------------------------------------------------------------------------
// Pure derivation (ARCHITECTURE §8.3 steps 3–5, §8.4) — exact fixed point, no I/O
// ---------------------------------------------------------------------------------------------

export interface WalletLedgerInput {
  id: string;
  partyId: string;
  legacyCreditedCC: bigint;
  creditedCC: bigint;
  /** Settled Amulet inbound from this party to the treasury, already in 1e-10 units. */
  receivedCC: bigint;
}

export type DriftKind = "over_credit" | "ledger_below_expected";

export interface CreditPlan {
  /** received − legacy − credited per wallet (after the self-heal was applied to the primary). */
  owed: Map<string, bigint>;
  /** Legacy-path credit found on the ledger but not attributed: attributed to the primary (§8.3 step 4). */
  healDelta: bigint;
  drift: { kind: DriftKind; walletId: string | null; amountCC: bigint } | null;
  expected: bigint;
  ledgerDepositedCC: bigint;
  delta: bigint;
  /** Σ max(owed, 0) — exact. */
  amount: bigint;
  attribution: DepositAttribution[];
}

/**
 * Derive what the treasury owes the in-app wallet, per linked wallet. Identical derivation
 * principle to api/wallet/deposit.mjs (amounts never come from the client) extended to N wallets:
 *
 *   owed_w = received_w − legacy_credited_cc_w − credited_cc_w
 *   expected = legacy_credited_cc[primary] + Σ credited_cc ; delta = ledger.depositedCC − expected
 *
 * Negative owed or negative delta (beyond DUST) is drift the backend refuses to paper over;
 * positive delta is a credit that reached the ledger through the legacy path and is attributed to
 * the primary so the invariant `ledger.depositedCC == legacy[primary] + Σ credited_cc` holds exactly.
 */
export function planCredit(input: { wallets: WalletLedgerInput[]; primaryPartyId: string; ledgerDepositedCC: bigint }): CreditPlan {
  const primary = input.wallets.find((w) => w.partyId === input.primaryPartyId);
  if (!primary) throw new Error("planCredit: the primary party has no wallet row");

  const owed = new Map<string, bigint>();
  let creditedTotal = 0n;
  for (const w of input.wallets) {
    owed.set(w.id, w.receivedCC - w.legacyCreditedCC - w.creditedCC);
    creditedTotal += w.creditedCC;
  }
  const expected = primary.legacyCreditedCC + creditedTotal;
  const delta = input.ledgerDepositedCC - expected;
  const base = { expected, ledgerDepositedCC: input.ledgerDepositedCC, delta, healDelta: 0n, amount: 0n, attribution: [] as DepositAttribution[] };

  // Step 3: a wallet attributed more than it ever sent is an over-credit → hard error.
  for (const w of input.wallets) {
    const o = owed.get(w.id) ?? 0n;
    if (o < -DUST) return { ...base, owed, drift: { kind: "over_credit", walletId: w.id, amountCC: o } };
  }
  // Step 4: the ledger holding less than we attributed is unrecoverable drift; holding more is a
  // legacy credit that self-heals onto the primary.
  if (delta < -DUST) return { ...base, owed, drift: { kind: "ledger_below_expected", walletId: primary.id, amountCC: delta } };
  let healDelta = 0n;
  if (delta > DUST) {
    healDelta = delta;
    const healed = (owed.get(primary.id) ?? 0n) - healDelta;
    owed.set(primary.id, healed);
    if (healed < -DUST) return { ...base, owed, healDelta, drift: { kind: "over_credit", walletId: primary.id, amountCC: healed } };
  }
  // Step 5: every owed_w is already an exact 10-dp value; the sum is exact too.
  let amount = 0n;
  const attribution: DepositAttribution[] = [];
  for (const w of input.wallets) {
    const o = owed.get(w.id) ?? 0n;
    if (o <= 0n) continue;
    amount += o;
    attribution.push({ walletId: w.id, partyId: w.partyId, amountCC: formatCC(o) });
  }
  return { ...base, owed, healDelta, drift: null, amount, attribution };
}

/**
 * Port of api/wallet/deposit.mjs: the commandId is DERIVED from the exact state the command was
 * computed against, so racing duplicates submit the same id (ledger command-dedup and the unique
 * write-ahead row reject all but one) while a legitimate later deposit sees new state and gets a
 * new id.
 */
export function depositCommandId(primaryPartyId: string, walletCid: string | null, amountCC: bigint, depositedCC: bigint): string {
  const stateHash = createHash("sha256")
    .update(`${primaryPartyId}|${walletCid ?? "create"}|${formatCC(amountCC)}|${formatCC(depositedCC)}`)
    .digest("hex")
    .slice(0, 40);
  return `deposit-${stateHash}`;
}

export function depositTxRef(commandId: string): string {
  return `reconcile:${commandId}`;
}

type ConfirmOutcome = "confirmed" | "failed" | "pending";

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

/**
 * Deposit reconciliation (docs/ARCHITECTURE.md §8.3). Money never trusts the client; every
 * treasury-signed credit is written ahead to `to_deposit_credits` and confirmed against the
 * ledger, so a crash between submit and confirm is repaired by the next confirm pass instead of
 * crediting twice.
 */
@Injectable()
export class DepositService {
  private readonly logger = new Logger(DepositService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
    @InjectRepository(DepositCreditEntity) private readonly credits: Repository<DepositCreditEntity>,
    private readonly users: UserService,
    private readonly ledger: LedgerClientService,
    private readonly wallet: EnterpriseWalletService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
    private readonly sentry: SentryService,
    private readonly payouts: PayoutService,
  ) {}

  private get treasury(): string {
    const treasury = this.config.treasuryPartyId;
    if (!treasury) throw new ApiError(502, "upstream_failed", "TREASURY_PARTY_ID is not configured");
    return treasury;
  }

  // ── §8.3 — POST /in-app-wallet/deposits/reconcile ──────────────────────────────────────────

  async reconcile(userId: string, actor: Actor): Promise<ReconcileResult> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    if (user.status !== "active") throw new ApiError(403, "user_suspended", "this account is suspended");
    if (!user.partyId) throw new ApiError(409, "no_primary_wallet", "link a Canton wallet before depositing");
    if (user.kycStatus === "blocked_duplicate") {
      throw new ApiError(409, "kyc_duplicate_identity", "deposits are disabled while an identity verification conflict is open");
    }

    // TTL sits above the worst-case history walk; correctness never depends on it (the
    // write-ahead row and ledger command-dedup do that) — it cheapens the common race to a 409.
    const lock = await this.redis.acquireLock(`lock:deposit:${userId}`, this.config.depositLockTtlMs);
    if (!lock.acquired) throw new ApiError(409, "deposit_in_progress", "a reconciliation for this account is already in progress");

    try {
      const primary = user.partyId;
      const treasury = this.treasury;

      // 1. confirm pass — anything still in flight blocks a new derivation (its amount is
      //    neither on the ledger nor attributed yet, so a new derivation would double count).
      const pass = await this.confirmForUser(userId);
      if (pass.pending.length > 0) {
        throw new ApiError(409, "deposit_in_progress", "a previous deposit credit is still being confirmed; try again shortly", {
          submitted: pass.pending.length,
          commandIds: pass.pending.map((r) => r.commandId),
        });
      }

      // 2. the COMPLETE treasury history, uncached on this route (paged as walletClient.mjs).
      const history = await this.wallet.transferHistory(treasury, { uncached: true });

      // 3–5. per-wallet attribution over every row (active AND revoked) in exact fixed point.
      const rows = await this.wallets.find({ where: { userId }, order: { createdAt: "ASC" } });
      const primaryRow = rows.find((w) => w.partyId === primary);
      if (!primaryRow) throw new ApiError(409, "no_primary_wallet", "the primary party has no linked wallet row");
      const ledgerBefore = await this.ledger.fetchUserWallet(primary, { uncached: true });
      const plan = planCredit({
        wallets: rows.map((w) => ({
          id: w.id,
          partyId: w.partyId,
          legacyCreditedCC: w.legacyCreditedCC,
          creditedCC: w.creditedCC,
          receivedCC: this.wallet.totalReceivedFrom(history, treasury, w.partyId),
        })),
        primaryPartyId: primary,
        ledgerDepositedCC: ledgerBefore?.depositedCC ?? 0n,
      });

      if (plan.drift) {
        await this.reportDrift(userId, primaryRow, plan, actor);
        throw new ApiError(409, "deposit_attribution_drift", "the in-app balance does not match the attributed deposits; an operator has been notified", {
          kind: plan.drift.kind,
          walletId: plan.drift.walletId,
          amountCC: formatCC(plan.drift.amountCC),
        });
      }
      if (plan.healDelta > 0n) await this.healPrimary(userId, primaryRow, plan, actor);

      if (plan.amount <= DUST) {
        return { credited: formatCC(0n), status: "nothing_outstanding", perWallet: [], ledger: ledgerBefore ? ledgerWalletToApi(ledgerBefore) : null };
      }

      // 6. write-ahead row keyed by the deterministic command id.
      const commandId = depositCommandId(primary, ledgerBefore?.contractId ?? null, plan.amount, ledgerBefore?.depositedCC ?? 0n);
      const txRef = depositTxRef(commandId);
      const credit = await this.writeAhead(userId, {
        ownerParty: primary,
        commandId,
        txRef,
        amountCC: plan.amount,
        attribution: plan.attribution,
        depositedCCBefore: ledgerBefore?.depositedCC ?? 0n,
        walletCidBefore: ledgerBefore?.contractId ?? null,
        actor,
      });

      // 7. submit as treasury.
      const commands = this.buildCommands(primary, ledgerBefore, plan.amount, txRef);
      let submitError: unknown = null;
      try {
        await this.wallet.externalSubmit({ commandId, commands });
      } catch (err) {
        // The command may or may not have reached the ledger: the row stays `submitted` and the
        // confirm pass below (or the next one) decides — never resubmit blindly.
        submitError = err;
        this.logger.warn(`deposit submit ${commandId} failed: ${(err as Error).message}`);
      }

      // 8. confirm immediately (best effort) and answer with the attribution.
      await this.confirmForUser(userId).catch((err: unknown) => {
        this.logger.warn(`post-submit confirm pass failed for ${commandId}: ${(err as Error).message}`);
      });
      const row = (await this.credits.findOne({ where: { id: credit.id } })) ?? credit;
      const ledgerAfter = await this.ledger.fetchUserWallet(primary, { uncached: true }).catch(() => ledgerBefore);
      const perWallet = plan.attribution.map((a) => ({ walletId: a.walletId, partyId: a.partyId, amountCC: a.amountCC }));

      if (row.status === "confirmed") {
        return { credited: formatCC(plan.amount), status: "confirmed", commandId, perWallet, ledger: ledgerAfter ? ledgerWalletToApi(ledgerAfter) : null };
      }
      if (submitError) {
        if (ApiError.is(submitError)) {
          throw new ApiError(submitError.status, submitError.code, submitError.message, { ...(submitError.details ?? {}), commandId, creditStatus: row.status });
        }
        throw submitError instanceof Error ? submitError : new Error("deposit submit failed", { cause: submitError });
      }
      return { credited: formatCC(plan.amount), status: "submitted", commandId, perWallet, ledger: ledgerAfter ? ledgerWalletToApi(ledgerAfter) : null };
    } finally {
      await lock.release();
    }
  }

  // ── confirm pass (§8.3 step 1; DepositConfirmProcessor every 60 s and on boot) ────────────

  /**
   * Confirm every `submitted` credit (of one user, or of everyone). Without `lockHeld` the
   * per-user deposit lock is taken and users whose lock is busy are skipped — the reconcile
   * holding it runs its own pass. Transitions are atomic (`WHERE status = 'submitted'`), so a
   * concurrent confirmer can never apply the attribution twice.
   */
  async confirmPending(userId?: string, opts: { lockHeld?: boolean } = {}): Promise<{ confirmed: number; failed: number }> {
    const rows = await this.credits.find({
      where: userId ? { userId, status: "submitted" } : { status: "submitted" },
      order: { createdAt: "ASC" },
    });
    const byUser = new Map<string, DepositCreditEntity[]>();
    for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

    let confirmed = 0;
    let failed = 0;
    for (const [uid, userRows] of byUser) {
      let lock: { acquired: boolean; release(): Promise<void> } | null = null;
      if (!opts.lockHeld) {
        lock = await this.redis.acquireLock(`lock:deposit:${uid}`, this.config.depositLockTtlMs);
        if (!lock.acquired) continue;
      }
      try {
        for (const row of userRows) {
          const outcome = await this.confirmRow(row);
          if (outcome === "confirmed") confirmed += 1;
          else if (outcome === "failed") failed += 1;
        }
      } catch (err) {
        // One user's upstream trouble must not stall everyone else's confirmations.
        this.logger.warn(`confirm pass for user ${uid} failed: ${(err as Error).message}`);
        this.sentry.captureException(err, { processor: "deposit-confirm", userId: uid });
        if (userId) throw err;
      } finally {
        if (lock) await lock.release();
      }
    }
    return { confirmed, failed };
  }

  private async confirmForUser(userId: string): Promise<{ confirmed: number; failed: number; pending: DepositCreditEntity[] }> {
    const result = await this.confirmPending(userId, { lockHeld: true });
    const pending = await this.credits.find({ where: { userId, status: "submitted" }, order: { createdAt: "ASC" } });
    return { ...result, pending };
  }

  private async confirmRow(row: DepositCreditEntity): Promise<ConfirmOutcome> {
    const onLedger = await this.ledger.fetchUserWallet(row.ownerParty, { uncached: true });
    if (this.isConfirmedOnLedger(row, onLedger)) {
      return (await this.markConfirmed(row)) ? "confirmed" : "pending";
    }
    // Only a ledger that still shows the PRE-state AND a wallet that says the command never
    // happened may fail the row; anything else is "in flight" and stays submitted (fail closed).
    if (!this.ledgerShowsPreState(row, onLedger)) return "pending";
    const status = await this.wallet.transferStatus(this.treasury, row.commandId);
    if (!status.known || status.submitted) return "pending";
    return (await this.markFailed(row, `wallet reports the command as ${status.status ?? "never submitted"}`)) ? "failed" : "pending";
  }

  private isConfirmedOnLedger(row: DepositCreditEntity, onLedger: LedgerWallet | null): boolean {
    if (!onLedger) return false;
    if (this.config.damlUserWalletHasDepositRefs) return onLedger.depositRefs.includes(row.txRef);
    return onLedger.depositedCC >= row.depositedCCBefore + row.amountCC;
  }

  /**
   * Pre-state: the Create never happened (no wallet), or the wallet's depositedCC is exactly what
   * it was before the submit — deposits are monotonic, so equality means no deposit landed even
   * if a withdrawal has since rotated the contract id.
   */
  private ledgerShowsPreState(row: DepositCreditEntity, onLedger: LedgerWallet | null): boolean {
    if (row.walletCidBefore === null) return onLedger === null;
    if (!onLedger) return false;
    if (this.config.damlUserWalletHasDepositRefs && onLedger.depositRefs.includes(row.txRef)) return false;
    return onLedger.depositedCC === row.depositedCCBefore;
  }

  /** Atomic `submitted → confirmed` + attribution bumps + audit, in one transaction. */
  private async markConfirmed(row: DepositCreditEntity): Promise<boolean> {
    const walletIds = row.attribution.map((a) => a.walletId);
    const done = await this.dataSource.transaction(async (manager) => {
      const res = await manager
        .getRepository(DepositCreditEntity)
        .update({ id: row.id, status: "submitted" }, { status: "confirmed", confirmedAt: new Date(), error: null });
      if (!res.affected) return false;
      const walletRepo = manager.getRepository(WalletEntity);
      for (const a of row.attribution) {
        const w = await walletRepo.findOne({ where: { id: a.walletId }, lock: { mode: "pessimistic_write" } });
        if (!w) throw new Error(`attribution wallet ${a.walletId} of credit ${row.id} is missing`);
        await walletRepo.update({ id: w.id }, { creditedCC: w.creditedCC + parseCC(a.amountCC) });
      }
      await this.audit.record(
        {
          actorType: "system",
          action: "deposit.credited",
          subjectType: "deposit_credit",
          subjectId: row.id,
          metadata: { userId: row.userId, commandId: row.commandId, amountCC: formatCC(row.amountCC), walletIds, attribution: row.attribution },
        },
        manager,
      );
      return true;
    });
    if (done) {
      this.logger.log(`deposit ${row.commandId} confirmed: ${formatCC(row.amountCC)} CC across ${walletIds.length} wallet(s)`);
      void this.publish(NatsSubjects.depositCredited, { userId: row.userId, depositCreditId: row.id, commandId: row.commandId, amountCC: formatCC(row.amountCC), walletIds });
    }
    return done;
  }

  private async markFailed(row: DepositCreditEntity, error: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const res = await manager.getRepository(DepositCreditEntity).update({ id: row.id, status: "submitted" }, { status: "failed", error: error.slice(0, 500) });
      if (!res.affected) return false;
      await this.audit.record(
        {
          actorType: "system",
          action: "deposit.failed",
          subjectType: "deposit_credit",
          subjectId: row.id,
          metadata: { userId: row.userId, commandId: row.commandId, amountCC: formatCC(row.amountCC), error: error.slice(0, 200) },
        },
        manager,
      );
      this.logger.warn(`deposit ${row.commandId} marked failed: ${error}`);
      return true;
    });
  }

  // ── write-ahead, self-heal, drift ─────────────────────────────────────────────────────────

  /**
   * INSERT … ON CONFLICT (command_id) DO NOTHING. No row inserted means the same state is
   * already being credited (`409 deposit_in_progress`) — except a row the confirm pass marked
   * `failed` (the wallet said the command never happened): that one is re-armed under the same
   * id, which the wallet reported safe to retry.
   */
  private async writeAhead(
    userId: string,
    input: {
      ownerParty: string;
      commandId: string;
      txRef: string;
      amountCC: bigint;
      attribution: DepositAttribution[];
      depositedCCBefore: bigint;
      walletCidBefore: string | null;
      actor: Actor;
    },
  ): Promise<DepositCreditEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(DepositCreditEntity);
      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(DepositCreditEntity)
        .values({
          userId,
          ownerParty: input.ownerParty,
          commandId: input.commandId,
          txRef: input.txRef,
          amountCC: input.amountCC,
          attribution: input.attribution,
          depositedCCBefore: input.depositedCCBefore,
          walletCidBefore: input.walletCidBefore,
          status: "submitted",
          error: null,
          confirmedAt: null,
        })
        .orIgnore()
        .returning("id")
        .updateEntity(false)
        .execute();
      const raw = result.raw as unknown;
      const inserted = Array.isArray(raw) && raw.length > 0;

      let rearmed = false;
      if (!inserted) {
        const clash = await repo.findOne({ where: { commandId: input.commandId } });
        if (!clash || clash.status !== "failed") {
          throw new ApiError(409, "deposit_in_progress", "this deposit is already being credited", { commandId: input.commandId });
        }
        const res = await repo.update(
          { id: clash.id, status: "failed" },
          {
            status: "submitted",
            error: null,
            confirmedAt: null,
            attribution: input.attribution,
            amountCC: input.amountCC,
            depositedCCBefore: input.depositedCCBefore,
            walletCidBefore: input.walletCidBefore,
            ownerParty: input.ownerParty,
            txRef: input.txRef,
          },
        );
        if (!res.affected) throw new ApiError(409, "deposit_in_progress", "this deposit is already being credited", { commandId: input.commandId });
        rearmed = true;
      }
      const row = await repo.findOne({ where: { commandId: input.commandId } });
      if (!row) throw new Error("write-ahead row vanished");

      await this.audit.record(
        {
          actorType: input.actor.type,
          actorUserId: input.actor.userId ?? null,
          actorSessionId: input.actor.sessionId ?? null,
          action: "deposit.submitted",
          subjectType: "deposit_credit",
          subjectId: row.id,
          metadata: {
            userId,
            commandId: input.commandId,
            amountCC: formatCC(input.amountCC),
            walletIds: input.attribution.map((a) => a.walletId),
            attribution: input.attribution,
            depositedCCBefore: formatCC(input.depositedCCBefore),
            walletCidBefore: input.walletCidBefore,
            rearmed,
          },
          ip: input.actor.ip ?? null,
        },
        manager,
      );
      return row;
    });
  }

  private buildCommands(primary: string, onLedger: LedgerWallet | null, amountCC: bigint, txRef: string): unknown[] {
    const amount = formatCC(amountCC);
    const templateId = this.ledger.templateId("UserWallet");
    if (onLedger) {
      return [{ ExerciseCommand: { templateId, contractId: onLedger.contractId, choice: "Deposit", choiceArgument: { amountCC: amount, txRef } } }];
    }
    // depositRefs only when the deployed Daml has the field: v13 1.0.0 has no such field, and on
    // 2.0.0 an omitted Optional defaults to None (the wallet then records refs from its first
    // Deposit exercise onward) — port of api/wallet/deposit.mjs.
    const createArguments: Record<string, unknown> = {
      admin: this.treasury,
      owner: primary,
      balanceCC: amount,
      depositedCC: amount,
      withdrawnCC: formatCC(0n),
    };
    if (this.config.damlUserWalletHasDepositRefs) createArguments.depositRefs = [txRef];
    return [{ CreateCommand: { templateId, createArguments } }];
  }

  /** Step 4 self-heal: attribute the unexplained ledger surplus to the primary (legacy-path credit). */
  private async healPrimary(userId: string, primaryRow: WalletEntity, plan: CreditPlan, actor: Actor): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WalletEntity);
      const locked = await repo.findOne({ where: { id: primaryRow.id }, lock: { mode: "pessimistic_write" } });
      if (!locked) throw new ApiError(409, "no_primary_wallet", "the primary wallet row vanished");
      const before = locked.creditedCC;
      await repo.update({ id: locked.id }, { creditedCC: before + plan.healDelta });
      primaryRow.creditedCC = before + plan.healDelta;
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "deposit.attribution_healed",
          subjectType: "wallet",
          subjectId: locked.id,
          metadata: {
            userId,
            amountCC: formatCC(plan.healDelta),
            creditedBefore: formatCC(before),
            ledgerDepositedCC: formatCC(plan.ledgerDepositedCC),
            expected: formatCC(plan.expected),
            path: "legacy",
          },
          ip: actor.ip ?? null,
        },
        manager,
      );
    });
    this.logger.warn(`deposit attribution healed for user ${userId}: +${formatCC(plan.healDelta)} CC to the primary wallet (legacy path)`);
    void this.publish(NatsSubjects.depositHealed, { userId, walletId: primaryRow.id, amountCC: formatCC(plan.healDelta) });
  }

  private async reportDrift(userId: string, primaryRow: WalletEntity, plan: CreditPlan, actor: Actor): Promise<void> {
    const drift = plan.drift;
    if (!drift) return;
    const subjectId = drift.walletId ?? primaryRow.id;
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "deposit.attribution_drift",
      subjectType: "wallet",
      subjectId,
      metadata: {
        userId,
        kind: drift.kind,
        amountCC: formatCC(drift.amountCC),
        ledgerDepositedCC: formatCC(plan.ledgerDepositedCC),
        expected: formatCC(plan.expected),
        delta: formatCC(plan.delta),
      },
      ip: actor.ip ?? null,
    });
    this.logger.error(`deposit attribution drift for user ${userId}: ${drift.kind} ${formatCC(drift.amountCC)} CC (ledger ${formatCC(plan.ledgerDepositedCC)}, expected ${formatCC(plan.expected)})`);
    this.sentry.captureMessage(`deposit attribution drift: ${drift.kind}`, "error", { userId, walletId: subjectId, kind: drift.kind });
    void this.publish(NatsSubjects.depositDrift, { userId, walletId: subjectId, kind: drift.kind, amountCC: formatCC(drift.amountCC) });
  }

  // ── GET /in-app-wallet ────────────────────────────────────────────────────────────────────

  async overview(userId: string): Promise<InAppWalletOverview> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    const primary = user.partyId;
    const rows = await this.wallets.find({ where: { userId }, order: { createdAt: "ASC" } });

    // The 15 s cached views are fine here; only the reconcile route insists on fresh reads.
    const onLedger = primary ? await this.ledger.fetchUserWallet(primary) : null;
    let byOwner = new Map<string, LedgerWallet>();
    try {
      byOwner = new Map((await this.ledger.fetchAllUserWallets()).map((w) => [w.owner, w]));
    } catch (err) {
      this.logger.warn(`ownLedgerWallet read failed: ${(err as Error).message}`);
    }
    let history: TransferRow[] | null = null;
    try {
      history = await this.wallet.transferHistory(this.treasury);
    } catch (err) {
      // The overview degrades (no receivedCC) rather than failing; reconcile surfaces the error.
      this.logger.warn(`history read failed for overview: ${(err as Error).message}`);
    }

    const wallets = rows.map((w) =>
      walletToApi(w, {
        ownLedgerWallet: w.partyId === primary ? null : (byOwner.get(w.partyId) ?? null),
        ...(history ? { receivedCC: this.wallet.totalReceivedFrom(history, this.treasury, w.partyId) } : {}),
      }),
    );

    const primaryRow = rows.find((w) => w.partyId === primary) ?? null;
    const legacyPrimaryCC = primaryRow?.legacyCreditedCC ?? 0n;
    const creditedTotalCC = rows.reduce((sum, w) => sum + w.creditedCC, 0n);
    const ledgerDepositedCC = onLedger?.depositedCC ?? 0n;
    const submitted = await this.credits.count({ where: { userId, status: "submitted" } });

    const payoutRows = await this.payouts.listForUser(userId);
    let active = new Set<string>();
    if (payoutRows.length > 0) {
      try {
        active = new Set((await this.ledger.fetchPendingPayouts()).map((p) => p.contractId));
      } catch (err) {
        this.logger.warn(`pending payouts read failed for overview: ${(err as Error).message}`);
      }
    }

    return {
      partyId: primary,
      ledger: onLedger ? ledgerWalletToApi(onLedger) : null,
      wallets,
      attribution: {
        legacyPrimaryCC: formatCC(legacyPrimaryCC),
        creditedTotalCC: formatCC(creditedTotalCC),
        ledgerDepositedCC: formatCC(ledgerDepositedCC),
        delta: formatCC(ledgerDepositedCC - legacyPrimaryCC - creditedTotalCC),
      },
      pending: { submitted },
      payouts: payoutRows.map((p) => this.payouts.toApi(p, active.has(p.pendingPayoutCid))),
    };
  }

  private async publish(subject: `truthoracle.${string}`, payload: object): Promise<void> {
    try {
      await this.nats.publish(subject, payload);
    } catch (err) {
      this.logger.warn(`publish ${subject} failed: ${(err as Error).message}`);
    }
  }
}

/** Exposed for composing packages that hold a transaction and need the same pessimistic read. */
export async function lockWalletRow(manager: EntityManager, walletId: string): Promise<WalletEntity | null> {
  return manager.getRepository(WalletEntity).findOne({ where: { id: walletId }, lock: { mode: "pessimistic_write" } });
}
