import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

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
import { LedgerClientService, userWalletCreateCommand } from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { PayoutService } from "./payout.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { UserService } from "./user.service";
import { WalletLinkService, ledgerWalletToApi, walletToApi } from "./wallet-link.service";

// ---------------------------------------------------------------------------------------------
// Pure derivation (ARCHITECTURE §8.3 steps 3–5, §8.4) — exact fixed point, no I/O
// ---------------------------------------------------------------------------------------------

export interface WalletLedgerInput {
  id: string;
  partyId: string;
  creditedCC: bigint;
  /** Settled Amulet inbound from this party to the treasury, already in 1e-10 units. */
  receivedCC: bigint;
}

/**
 * `over_credit`: a wallet is attributed more than it ever sent. `ledger_below_expected` /
 * `ledger_above_expected`: the primary's on-ledger depositedCC differs from Σ credited_cc in
 * that direction. None of them self-resolves; an operator looks.
 */
export type DriftKind = "over_credit" | "ledger_below_expected" | "ledger_above_expected";

export interface CreditPlan {
  /** received − credited per wallet. */
  owed: Map<string, bigint>;
  drift: { kind: DriftKind; walletId: string | null; amountCC: bigint } | null;
  /** Σ credited_cc — what the ledger must show as depositedCC. */
  expected: bigint;
  ledgerDepositedCC: bigint;
  /** ledgerDepositedCC − expected. */
  delta: bigint;
  /** Σ max(owed, 0) — exact. */
  amount: bigint;
  attribution: DepositAttribution[];
}

/**
 * Derive what the treasury owes the in-app wallet, per linked wallet. Amounts never come from the
 * client; the derivation covers N wallets and is exact fixed point:
 *
 *   owed_w   = received_w − credited_cc_w
 *   expected = Σ credited_cc ; delta = ledger.depositedCC − expected
 *
 * Every credit the primary's UserWallet ever received went through this backend (greenfield —
 * ARCHITECTURE §18), so `ledger.depositedCC == Σ credited_cc` holds exactly after confirmation
 * and ANY deviation beyond DUST — negative owed, negative delta, positive delta — is drift the
 * backend refuses to paper over: nothing is credited, an operator is notified.
 */
export function planCredit(input: { wallets: WalletLedgerInput[]; primaryPartyId: string; ledgerDepositedCC: bigint }): CreditPlan {
  const primary = input.wallets.find((w) => w.partyId === input.primaryPartyId);
  if (!primary) throw new Error("planCredit: the primary party has no wallet row");

  const owed = new Map<string, bigint>();
  let expected = 0n;
  for (const w of input.wallets) {
    owed.set(w.id, w.receivedCC - w.creditedCC);
    expected += w.creditedCC;
  }
  const delta = input.ledgerDepositedCC - expected;
  const base = { owed, expected, ledgerDepositedCC: input.ledgerDepositedCC, delta, amount: 0n, attribution: [] as DepositAttribution[] };

  // Step 3: a wallet attributed more than it ever sent is an over-credit → hard error.
  for (const w of input.wallets) {
    const o = owed.get(w.id) ?? 0n;
    if (o < -DUST) return { ...base, drift: { kind: "over_credit", walletId: w.id, amountCC: o } };
  }
  // Step 4: the ledger must hold exactly what was attributed — in either direction.
  if (delta < -DUST) return { ...base, drift: { kind: "ledger_below_expected", walletId: primary.id, amountCC: delta } };
  if (delta > DUST) return { ...base, drift: { kind: "ledger_above_expected", walletId: primary.id, amountCC: delta } };
  // Step 5: every owed_w is already an exact 10-dp value; the sum is exact too.
  let amount = 0n;
  const attribution: DepositAttribution[] = [];
  for (const w of input.wallets) {
    const o = owed.get(w.id) ?? 0n;
    if (o <= 0n) continue;
    amount += o;
    attribution.push({ walletId: w.id, partyId: w.partyId, amountCC: formatCC(o) });
  }
  return { ...base, drift: null, amount, attribution };
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
    private readonly walletLinks: WalletLinkService,
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

      if (plan.amount <= DUST) {
        return { credited: formatCC(0n), status: "nothing_outstanding", perWallet: [], ledger: ledgerBefore ? ledgerWalletToApi(ledgerBefore) : null };
      }

      // 6. the primary's UserWallet must exist BEFORE the write-ahead: it is created empty
      //    (0/0/0) under the one deterministic id every path uses (`wallet-create-<hash(package name, owner)>`),
      //    so a Create racing PayoutService's in-app path collides on ledger command-dedup instead
      //    of minting a second wallet. The credit itself is then always an Exercise Deposit, whose
      //    txRef the Daml refuses to credit twice.
      const ledgerWallet = ledgerBefore ?? (await this.ensureUserWallet(primary));

      // 7. write-ahead row keyed by the deterministic command id.
      const commandId = depositCommandId(primary, ledgerWallet.contractId, plan.amount, ledgerWallet.depositedCC);
      const txRef = depositTxRef(commandId);
      const credit = await this.writeAhead(userId, {
        ownerParty: primary,
        commandId,
        txRef,
        amountCC: plan.amount,
        attribution: plan.attribution,
        depositedCCBefore: ledgerWallet.depositedCC,
        walletCidBefore: ledgerWallet.contractId,
        actor,
      });

      // 8. submit as treasury.
      let submitError: unknown = null;
      try {
        await this.wallet.externalSubmit({ commandId, commands: [this.depositCommand(ledgerWallet, plan.amount, txRef)] });
      } catch (err) {
        // The command may or may not have reached the ledger: the row stays `submitted` and the
        // confirm pass below (or the next one) decides — never resubmit blindly.
        submitError = err;
        this.logger.warn(`deposit submit ${commandId} failed: ${(err as Error).message}`);
      }

      // 9. confirm immediately (best effort) and answer with the attribution and the row's REAL
      //    status — a row the pass could not confirm is `submitted` (the processor finishes it),
      //    never a guess.
      await this.confirmForUser(userId).catch((err: unknown) => {
        this.logger.warn(`post-submit confirm pass failed for ${commandId}: ${(err as Error).message}`);
      });
      const row = (await this.credits.findOne({ where: { id: credit.id } })) ?? credit;
      const ledgerAfter = await this.ledger.fetchUserWallet(primary, { uncached: true }).catch(() => ledgerWallet);
      const perWallet = plan.attribution.map((a) => ({ walletId: a.walletId, partyId: a.partyId, amountCC: a.amountCC }));
      const ledger = ledgerAfter ? ledgerWalletToApi(ledgerAfter) : null;

      if (row.status === "confirmed") {
        return { credited: formatCC(plan.amount), status: "confirmed", commandId, perWallet, ledger };
      }
      if (row.status === "failed") {
        throw new ApiError(502, "upstream_failed", "the deposit credit was not accepted by the ledger; retry the reconciliation", {
          commandId,
          creditStatus: row.status,
          creditId: row.id,
        });
      }
      if (submitError) {
        // Whatever the transport threw, the answer is an upstream failure that names the row: the
        // credit is written ahead and the confirm pass owns it from here.
        const base = ApiError.is(submitError)
          ? submitError
          : new ApiError(502, "upstream_failed", `deposit submit failed: ${submitError instanceof Error ? submitError.message : "unknown error"}`);
        throw new ApiError(base.status, base.code, base.message, { ...(base.details ?? {}), commandId, creditStatus: row.status, creditId: row.id });
      }
      return { credited: formatCC(plan.amount), status: "submitted", commandId, perWallet, ledger };
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
    // Only a ledger that still shows the PRE-state, after the grace period, AND a wallet that
    // reports the command as failed or unknown may fail the row; anything else is "in flight" and
    // stays submitted (fail closed). The grace period exists because the ACS lags an accepted
    // command and a wrong `failed` would re-arm the same command id for a second submission.
    if (!this.ledgerShowsPreState(row, onLedger)) return "pending";
    const ageMs = Date.now() - row.submittedAt.getTime();
    if (ageMs < this.config.depositConfirmGraceMs) return "pending";
    const status = await this.wallet.commandStatus(this.treasury, row.commandId);
    if (status.known && status.submitted) {
      // The wallet says it went through but the ledger disagrees past the grace period: an
      // operator must look — nothing is credited and nothing is re-armed.
      this.logger.warn(`deposit ${row.commandId}: wallet reports "${status.status ?? "submitted"}" but the ledger still shows the pre-state after ${Math.round(ageMs / 1000)} s`);
      this.sentry.captureMessage("deposit credit accepted by the wallet but absent from the ledger", "warning", { commandId: row.commandId });
      return "pending";
    }
    if (!status.known && status.status !== "not_found") return "pending";
    const reason = status.known ? `wallet reports the command as ${status.status ?? "failed"}` : "wallet does not know the command after the grace period";
    return (await this.markFailed(row, reason)) ? "failed" : "pending";
  }

  /**
   * THE confirmation rule: the Daml `Deposit` choice appends `txRef` to `UserWallet.depositRefs`
   * and refuses a repeat, so the wallet carrying the row's txRef is the on-ledger proof this exact
   * credit landed — whatever `depositedCC` did meanwhile (another Deposit, a rotated contract id).
   */
  private isConfirmedOnLedger(row: DepositCreditEntity, onLedger: LedgerWallet | null): boolean {
    return onLedger !== null && onLedger.depositRefs.includes(row.txRef);
  }

  /**
   * Pre-state: the wallet exists (every row records the wallet the Exercise was addressed to) and
   * does not carry the row's txRef — by the same Daml rule, this credit has not landed. No wallet
   * at all for a row that recorded one is anomalous and is treated as "in flight" (fail closed).
   */
  private ledgerShowsPreState(row: DepositCreditEntity, onLedger: LedgerWallet | null): boolean {
    return onLedger !== null && !onLedger.depositRefs.includes(row.txRef);
  }

  /**
   * The primary's empty UserWallet, created under the shared deterministic id. A dedup collision
   * (PayoutService or another instance created it a moment ago) is not an error: the fresh read
   * decides. A wallet that is accepted but not yet visible is a 502 the user retries.
   */
  private async ensureUserWallet(owner: string): Promise<LedgerWallet> {
    const commandId = this.ledger.walletCreateCommandId(owner);
    try {
      await this.wallet.externalSubmit({
        commandId,
        commands: [userWalletCreateCommand({ templateId: this.ledger.templateId("UserWallet"), admin: this.treasury, owner })],
      });
    } catch (err) {
      this.logger.warn(`UserWallet create ${commandId} did not succeed (${(err as Error).message}); re-reading the ledger`);
    }
    const created = await this.ledger.fetchUserWallet(owner, { uncached: true });
    if (!created) {
      throw new ApiError(502, "upstream_failed", "the in-app wallet is not yet visible on the ledger; try again shortly", { commandId });
    }
    return created;
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
      void this.nats.publishSafe(NatsSubjects.depositCredited, { userId: row.userId, depositCreditId: row.id, commandId: row.commandId, amountCC: formatCC(row.amountCC), walletIds });
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
      this.sentry.captureMessage("deposit credit marked failed", "warning", { commandId: row.commandId });
      return true;
    });
  }

  // ── write-ahead, drift ────────────────────────────────────────────────────────────────────

  /**
   * INSERT … ON CONFLICT (command_id) DO NOTHING. No row inserted means the same state is
   * already being credited (`409 deposit_in_progress`) — except a row the confirm pass marked
   * `failed` (past the grace period, ledger in the pre-state, wallet reporting the command as
   * failed or unknown): that one is re-armed under the same id with a fresh `submitted_at`.
   * Ledger command-dedup and the Daml txRef assertion are the backstops should the original
   * command land after all.
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
          submittedAt: new Date(),
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
            submittedAt: new Date(),
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

  private depositCommand(onLedger: LedgerWallet, amountCC: bigint, txRef: string): unknown {
    return {
      ExerciseCommand: {
        templateId: this.ledger.templateId("UserWallet"),
        contractId: onLedger.contractId,
        choice: "Deposit",
        choiceArgument: { amountCC: formatCC(amountCC), txRef },
      },
    };
  }

  /** Audit + Sentry + NATS for a refused reconciliation; the audit row is written outside the (absent) transaction so it survives the 409. */
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
    void this.nats.publishSafe(NatsSubjects.depositDrift, { userId, walletId: subjectId, kind: drift.kind, amountCC: formatCC(drift.amountCC) });
  }

  // ── GET /in-app-wallet ────────────────────────────────────────────────────────────────────

  async overview(userId: string): Promise<InAppWalletOverview> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    const primary = user.partyId;
    const rows = await this.wallets.find({ where: { userId }, order: { createdAt: "ASC" } });

    // The 15 s cached views are fine here; only the reconcile route insists on fresh reads.
    const onLedger = primary ? await this.ledger.fetchUserWallet(primary) : null;
    const own = await this.walletLinks.ownLedgerWallets(rows, primary);
    let history: TransferRow[] | null = null;
    try {
      history = await this.wallet.transferHistory(this.treasury);
    } catch (err) {
      // The overview degrades (no receivedCC) rather than failing; reconcile surfaces the error.
      this.logger.warn(`history read failed for overview: ${(err as Error).message}`);
    }

    const wallets = rows.map((w) =>
      walletToApi(w, {
        ownLedgerWallet: own.get(w.id) ?? null,
        ...(history ? { receivedCC: this.wallet.totalReceivedFrom(history, this.treasury, w.partyId) } : {}),
      }),
    );

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
        creditedTotalCC: formatCC(creditedTotalCC),
        ledgerDepositedCC: formatCC(ledgerDepositedCC),
        delta: formatCC(ledgerDepositedCC - creditedTotalCC),
      },
      pending: { submitted },
      payouts: payoutRows.map((p) => this.payouts.toApi(p, active.has(p.pendingPayoutCid))),
    };
  }

}
