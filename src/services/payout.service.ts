import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";

import { Config } from "../config";
import { PayoutEntity } from "../entities/payout.entity";
import type { WalletEntity } from "../entities/wallet.entity";
import {
  type ApiPayout,
  type ErrorCode,
  NatsSubjects,
  type PayoutStatus,
  type PendingPayoutRecord,
} from "../types";
import { ApiError } from "../util/errors";
import { formatCC } from "../util/money";
import { AuditService, type AuditInput } from "./audit.service";
import { EnterpriseWalletService, type TransferStatusResult } from "./enterprise-wallet.service";
import { KycService } from "./kyc.service";
import {
  LedgerClientService,
  userWalletCreateCommand,
  walletCreateCommandIdFor,
} from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { UserService } from "./user.service";
import { WalletLinkService } from "./wallet-link.service";

/**
 * Settlement of on-ledger PendingPayouts under the KYC gate (docs/ARCHITECTURE.md §9.4). Port of
 * truthoracle-canton/api/wallet/settle-payout.mjs, extended with the `to_payouts` write-ahead
 * arbiter, the closed reason policy and the in-app path.
 *
 * The contract IS the authorisation: the payee and the amount are read from the on-ledger
 * PendingPayout, which only the market choices can create. A caller supplies a contract id and
 * nothing else, so the worst a hostile caller can do is settle a payout that the ledger already
 * says is owed — to the party the ledger says owns it.
 *
 * Concurrency is the remaining way to abuse that: on the external path the transfer happens
 * BEFORE the consuming MarkPaid (money must move before the record archives), so two attempts
 * racing on the same cid would both read an active payout and both pay. Four layers close that:
 *
 *   1. The transfer commandId is DERIVED from the cid, so every settlement attempt for one
 *      payout submits the same id and ledger command-dedup rejects the copies.
 *   2. `to_payouts` records `settling` + the command id BEFORE the wallet is called, as a
 *      compare-and-set (`UPDATE … WHERE <command id column> IS NULL`): two instances that both
 *      got past the lock cannot both win it, and the loser never calls upstream. Once the row
 *      commits, `transfer()` is never called again for the payout — a retry asks the wallet
 *      whether the recorded id was submitted (failing CLOSED when it cannot tell) and resumes at
 *      MarkPaid, or hands the row to an operator. This doubles as crash recovery.
 *   3. Attempts are capped (`PAYOUT_MAX_ATTEMPTS`) → `failed` (admin queue). System scans that
 *      merely poll a recorded id do not count.
 *   4. A Redis lock `lock:payout:<cid>` turns most races into an immediate 409 before any
 *      upstream work happens. It is a crash ceiling, not the correctness mechanism.
 *
 * A consuming submit (MarkPaid / SettleToWallet) is only ever called "settled" once the ledger
 * shows the PendingPayout gone: the wallet accepting a command is not the ledger executing it.
 */

export interface PayoutActor {
  type: "user" | "admin" | "system";
  userId?: string;
  sessionId?: string;
  /** Admin only: override `blocked_kyc` / `blocked_wallet_revoked` (audited, needs `reason`). */
  force?: boolean;
  reason?: string;
  ip?: string | null;
}

export type PayoutMode = "external" | "in_app" | "already_settled";

export interface SettleResult {
  payout: PayoutEntity;
  mode: PayoutMode;
  /** false once the PendingPayout has been consumed — i.e. after every successful settlement. */
  onLedger: boolean;
}

/** Crash ceiling for the per-cid lock; correctness lives in the `to_payouts` row, not here. */
export const PAYOUT_LOCK_TTL_MS = 120_000;
/** The scan lock only stops instances doing the same work twice; per-cid locks guard the money. */
export const PAYOUT_SCAN_LOCK_TTL_MS = 5 * 60_000;

const TERMINAL: ReadonlySet<PayoutStatus> = new Set([
  "settled_external",
  "settled_in_app",
  "archived",
]);
/** Statuses the scan retries on its own; blocked rows wait for a user, a KYC approval or an operator. */
const RETRIABLE: ReadonlySet<PayoutStatus> = new Set(["queued", "settling"]);
/** `force` may override these and nothing else (ARCHITECTURE §9.4). */
const FORCEABLE: ReadonlySet<PayoutStatus> = new Set(["blocked_kyc", "blocked_wallet_revoked"]);
const NON_TERMINAL: PayoutStatus[] = [
  "queued",
  "settling",
  "blocked_kyc",
  "blocked_unknown_user",
  "blocked_unknown_reason",
  "blocked_wallet_revoked",
  "failed",
];
const COMMAND_COLUMNS = {
  transferCommandId: "transfer_command_id",
  walletCreateCommandId: "wallet_create_command_id",
  settleCommandId: "settle_command_id",
} as const;
type CommandField = keyof typeof COMMAND_COLUMNS;

function hash40(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 40);
}

/**
 * Stable per-payout ids (settle-payout.mjs `commandIdsFor`): every attempt to settle one cid
 * submits the same commands, so ledger command-dedup rejects the copies and a crashed attempt
 * can be recognised by asking the wallet about the id.
 */
export function commandIdsFor(pendingPayoutCid: string): {
  transferCommandId: string;
  markPaidCommandId: string;
  settleCommandId: string;
} {
  const cidHash = hash40(pendingPayoutCid);
  return {
    transferCommandId: `payout-${cidHash}`,
    markPaidCommandId: `markpaid-${cidHash}`,
    settleCommandId: `settle-${cidHash}`,
  };
}

/**
 * A consuming choice the wallet reported as failed (or never saw) may be retried — the ledger
 * rejects it once the contract is gone, so it cannot pay twice — but not under an id the ledger
 * may already have completed: the retry carries the attempt number.
 */
export function retryCommandId(base: string, attempt: number): string {
  return `${base}-r${attempt}`;
}

/** One UserWallet per payee — the shared deterministic id (ledger-client.service), re-exported for callers and tests. */
export { walletCreateCommandIdFor };

interface SettleContext {
  cid: string;
  row: PayoutEntity;
  /** The active PendingPayout, or null when the contract is no longer on the ledger. */
  live: PendingPayoutRecord | null;
  actor: PayoutActor;
}

interface LiveContext extends SettleContext {
  live: PendingPayoutRecord;
}

interface Verdict {
  status: PayoutStatus;
  detail: string;
}

function notFound(): ApiError {
  return new ApiError(404, "payout_not_found", "payout not found");
}

function blockedCode(status: PayoutStatus, detail: string): ErrorCode {
  if (status !== "blocked_kyc") return "payout_blocked";
  if (detail === "kyc_duplicate_identity") return "kyc_duplicate_identity";
  if (detail === "user_suspended") return "user_suspended";
  return "kyc_required";
}

function blockedMessage(status: PayoutStatus): string {
  switch (status) {
    case "blocked_kyc":
      return "identity verification is required before this withdrawal can be settled";
    case "blocked_unknown_user":
      return "the payee party is not linked to an account";
    case "blocked_unknown_reason":
      return "this payout reason is not in the settlement policy; an operator will review it";
    case "blocked_wallet_revoked":
      return "the payee wallet was unlinked; relink it or ask an operator";
    case "failed":
      return "settlement failed and needs an operator";
    default:
      return "this payout cannot be settled right now";
  }
}

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(PayoutEntity) private readonly payouts: Repository<PayoutEntity>,
    private readonly ledger: LedgerClientService,
    private readonly wallet: EnterpriseWalletService,
    private readonly redis: RedisService,
    private readonly nats: NatsService,
    private readonly audit: AuditService,
    private readonly kyc: KycService,
    private readonly walletLink: WalletLinkService,
    private readonly users: UserService,
    private readonly sentry: SentryService,
  ) {}

  // ───────────────────────────────────────────── entry point ─────────────────────────────────

  /**
   * The one settlement path for the processor, the user route and the admin route. Serialised
   * per cid by `lock:payout:<cid>`; everything else is decided by the `to_payouts` row.
   */
  async settle(cid: string, actor: PayoutActor): Promise<SettleResult> {
    if (actor.force) {
      if (actor.type !== "admin")
        throw new ApiError(403, "forbidden", "only an operator can force a settlement");
      if (!actor.reason?.trim())
        throw new ApiError(400, "validation_failed", "a reason is required to force a settlement");
    }
    const lock = await this.redis.acquireLock(`lock:payout:${cid}`, PAYOUT_LOCK_TTL_MS);
    if (!lock.acquired) {
      throw new ApiError(
        409,
        "payout_blocked",
        "a settlement for this payout is already in progress",
        {
          reason: "settlement_in_progress",
        },
      );
    }
    try {
      return await this.settleLocked(cid, actor);
    } finally {
      await lock.release();
    }
  }

  private async settleLocked(cid: string, actor: PayoutActor): Promise<SettleResult> {
    let known = await this.payouts.findOne({ where: { pendingPayoutCid: cid } });
    // Always a fresh read: a cached view could show a payout the user cancelled a moment ago as
    // still owed, and the transfer below is irreversible.
    const live = await this.ledger.fetchPendingPayout(cid, { uncached: true });
    // The ledger read takes a while; another instance may have moved the row meanwhile.
    if (known) known = (await this.payouts.findOne({ where: { id: known.id } })) ?? known;
    if (!live && !known) throw notFound();

    const payee = live?.user ?? known?.payeeParty ?? "";
    // payee → account through the wallet row, active OR revoked (a party is bound to its first
    // account forever, §8.1); a revoked row still tells us whose payout this is.
    const wallet = payee ? await this.walletLink.findByParty(payee) : null;
    // Ownership (user route): the payee must be one of the caller's wallets. A miss is a plain
    // 404 — never a hint that the cid exists.
    if (actor.type === "user" && (!wallet || wallet.userId !== actor.userId)) throw notFound();

    if (!live) {
      if (!known) throw notFound();
      return this.resolveArchived({ cid, row: known, live: null, actor });
    }

    const row = known ?? (await this.firstSight(live, wallet, actor));
    if (known) await this.refreshOwner(row, wallet);
    const ctx: LiveContext = { cid, row, live, actor };

    if (TERMINAL.has(row.status)) return { payout: row, mode: "already_settled", onLedger: true };

    // §9.4: past PAYOUT_MAX_ATTEMPTS the row belongs to the operator queue. Users are refused
    // BEFORE the recorded-command shortcuts below, so a retry can neither re-enter the upstream
    // path nor push `attempts` past the cap; operators keep the resume path.
    if (row.status === "failed" && actor.type !== "admin") {
      throw new ApiError(409, "payout_blocked", blockedMessage("failed"), { status: row.status });
    }

    // A recorded submit means money may already have moved: finish that path. Policy is never
    // re-evaluated past this point — a wallet revoked after the transfer must still be MarkPaid.
    if (row.transferCommandId) return this.executeExternal(ctx);
    if (row.settleCommandId || row.walletCreateCommandId) return this.executeInApp(ctx);
    if (!live.user || live.amountCC <= 0n) {
      return this.block(
        ctx,
        "failed",
        live.user ? "payout amount is not positive" : "payout has no payee",
      );
    }

    const policy = this.policyFor(live.reason);
    if (policy === "unknown")
      return this.block(
        ctx,
        "blocked_unknown_reason",
        `reason "${live.reason}" is not in the payout policy`,
      );
    if (policy === "in_app") return this.executeInApp(ctx);

    // External CC leaves the platform: user active AND payee wallet active AND the KYC gate —
    // always evaluated on the PAYEE's account, never the caller's.
    const verdict = await this.externalVerdict(wallet);
    if (verdict) {
      if (!(actor.force && FORCEABLE.has(verdict.status)))
        return this.block(ctx, verdict.status, verdict.detail);
      await this.audit.record({
        ...this.actorFields(actor),
        action: "payout.admin_override",
        subjectType: "payout",
        subjectId: cid,
        metadata: {
          overriddenStatus: verdict.status,
          detail: verdict.detail,
          reason: actor.reason,
          payoutReason: live.reason,
          userId: row.userId,
        },
      });
      this.logger.warn(`payout ${cid}: operator override of ${verdict.status} (${verdict.detail})`);
    }
    return this.executeExternal(ctx);
  }

  // ───────────────────────────────────────────── policy ──────────────────────────────────────

  /** Closed map (ARCHITECTURE §19): no default-external. In-app wins a misconfigured overlap — money stays on the platform. */
  private policyFor(reason: string): "external" | "in_app" | "unknown" {
    const r = reason.trim();
    if (!r) return "unknown";
    if (this.config.payoutInappReasons.includes(r)) return "in_app";
    if (this.config.payoutExternalReasons.includes(r)) return "external";
    return "unknown";
  }

  private async externalVerdict(wallet: WalletEntity | null): Promise<Verdict | null> {
    if (!wallet)
      return { status: "blocked_unknown_user", detail: "payee party is not linked to any account" };
    const user = await this.users.findById(wallet.userId);
    if (!user) return { status: "blocked_unknown_user", detail: "payee account not found" };
    if (wallet.status !== "active")
      return { status: "blocked_wallet_revoked", detail: "payee wallet is revoked" };
    if (user.status !== "active") return { status: "blocked_kyc", detail: "user_suspended" };
    // The gate owns KYC_ENFORCE_WITHDRAWALS too (INTERNALS), but it is only consulted when the
    // flag is on: with enforcement off the answer is `allowed` by contract, and not calling it
    // keeps settlement independent of the KYC provider being reachable.
    if (!this.config.kycEnforceWithdrawals) return null;
    const gate = await this.kyc.withdrawalGate(user.id);
    if (!gate.allowed) return { status: "blocked_kyc", detail: gate.reason ?? "kyc_required" };
    return null;
  }

  // ───────────────────────────────────────────── external path ───────────────────────────────

  private async executeExternal(ctx: LiveContext): Promise<SettleResult> {
    const { cid, row, actor } = ctx;
    const { transferCommandId, markPaidCommandId } = commandIdsFor(cid);
    const treasury = this.config.treasuryPartyId;

    if (!row.transferCommandId) {
      // Write-ahead (compare-and-set): once this commits, transfer() is called at most once for
      // this payout, ever — and an instance that lost the race never calls the wallet.
      if (
        !(await this.claimCommand(row, "transferCommandId", transferCommandId, {
          previous: null,
          countAttempt: true,
        }))
      ) {
        throw await this.lostRace(ctx, transferCommandId);
      }
      try {
        await this.wallet.transfer(this.transferArgs(ctx, transferCommandId));
      } catch (err) {
        // Unknown whether the wallet accepted it: the row keeps the id, the next attempt asks.
        throw await this.attemptFailed(ctx, err, "transfer");
      }
    } else {
      // Skip the transfer when a previous attempt already submitted it (crashed before
      // MarkPaid, or a concurrent request from another instance won). The payout is still
      // active, so finishing the job means archiving it — not paying again.
      const status = await this.wallet.transferStatus(treasury, row.transferCommandId);
      if (!status.known) throw await this.stopUnknown(ctx, row.transferCommandId);
      if (!status.submitted) {
        if (this.mayResendTransfer(ctx)) {
          // The operator's way out of a transfer that died before the wallet recorded it: force +
          // reason, past PAYOUT_RESEND_GRACE_MS (a lagging index has caught up by then), audited;
          // the identical command id keeps ledger dedup as the backstop.
          await this.audit.record({
            ...this.actorFields(actor),
            action: "payout.admin_override",
            subjectType: "payout",
            subjectId: cid,
            metadata: {
              detail: "resend_transfer",
              transferCommandId: row.transferCommandId,
              walletStatus: status.status,
              reason: actor.reason,
              userId: row.userId,
            },
          });
          this.logger.warn(
            `payout ${cid}: operator re-sends transfer ${row.transferCommandId} (wallet reported "${status.status ?? "unknown"}")`,
          );
          await this.transition(row, {
            status: "settling",
            attempts: row.attempts + 1,
            lastError: null,
          });
          try {
            await this.wallet.transfer(this.transferArgs(ctx, row.transferCommandId));
          } catch (err) {
            throw await this.attemptFailed(ctx, err, "transfer");
          }
        } else {
          // The wallet says the recorded transfer never happened. It is still never re-sent by
          // itself: a "not found" from a lagging index is exactly the case that double-pays. A
          // user's or operator's retry counts toward the cap (→ operator queue); the scan's own
          // polls do not, or every stuck row would be `failed` within minutes.
          await this.transition(row, {
            status: "settling",
            ...(actor.type === "system" ? {} : { attempts: row.attempts + 1 }),
          });
          throw await this.attemptFailed(
            ctx,
            new Error(
              `transfer ${row.transferCommandId} is recorded but the wallet reports "${status.status ?? "unknown"}"; refusing to transfer again`,
            ),
            "transfer-status",
          );
        }
      } else {
        this.logger.warn(
          `payout ${cid}: transfer ${row.transferCommandId} already submitted — resuming at MarkPaid`,
        );
        await this.transition(row, {
          status: "settling",
          attempts: row.attempts + 1,
          lastError: null,
        });
      }
    }

    // The CC has moved. If MarkPaid fails the user still has their money; the row just lingers
    // until the next settle attempt resumes here and archives it. A MarkPaid that was already
    // attempted (contract still live, so it did not land) is retried under a fresh id.
    const markPaidId = row.markPaidCommandId
      ? retryCommandId(markPaidCommandId, row.attempts)
      : markPaidCommandId;
    await this.transition(row, { markPaidCommandId: markPaidId });
    try {
      await this.wallet.externalSubmit({
        commandId: markPaidId,
        commands: [
          this.exercisePayout(cid, "MarkPaid", {
            txHash: row.transferCommandId ?? transferCommandId,
          }),
        ],
      });
    } catch (err) {
      throw await this.attemptFailed(ctx, err, "markpaid");
    }
    if (await this.stillLive(cid)) throw await this.inFlight(ctx, markPaidId);
    return this.settled(ctx, "settled_external", "external");
  }

  private transferArgs(
    ctx: LiveContext,
    commandId: string,
  ): Parameters<EnterpriseWalletService["transfer"]>[0] {
    const { cid, live } = ctx;
    return {
      to: live.user,
      amountCC: live.amountCC,
      reason: live.reason || "payout",
      commandId,
      metadata: {
        kind: "truthoracle_admin_payout",
        pending_payout_cid: cid,
        reason: live.reason || "payout",
      },
    };
  }

  /** Admin + force + reason (validated in settle()) and a row older than PAYOUT_RESEND_GRACE_MS. */
  private mayResendTransfer(ctx: SettleContext): boolean {
    const { actor, row } = ctx;
    if (actor.type !== "admin" || !actor.force) return false;
    return Date.now() - row.firstSeenAt.getTime() >= this.config.payoutResendGraceMs;
  }

  // ───────────────────────────────────────────── in-app path ─────────────────────────────────

  private async executeInApp(ctx: LiveContext): Promise<SettleResult> {
    const { cid, live, row } = ctx;
    const payee = live.user;
    const { settleCommandId } = commandIdsFor(cid);
    const treasury = this.config.treasuryPartyId;
    // One attempt per call, however many submissions it takes.
    let counted = false;
    const countOnce = (): boolean => {
      if (counted) return false;
      counted = true;
      return true;
    };

    let ledgerWallet = await this.ledger.fetchUserWallet(payee, { uncached: true });
    if (!ledgerWallet) {
      const walletCreateCommandId = walletCreateCommandIdFor(payee);
      if (row.walletCreateCommandId) {
        const status = await this.wallet.commandStatus(treasury, row.walletCreateCommandId);
        if (this.readFailed(status)) throw await this.stopUnknown(ctx, row.walletCreateCommandId);
        // Accepted but not yet visible on the ledger: creating again would race it.
        if (status.known && status.submitted)
          throw await this.inFlight(ctx, row.walletCreateCommandId);
        // Failed or unknown to the wallet: re-submit the SAME id — the per-owner id makes a Create
        // that did land (unindexed) collide on dedup instead of minting a second wallet.
        await this.transition(row, {
          status: "settling",
          attempts: countOnce() ? row.attempts + 1 : row.attempts,
          lastError: null,
        });
      } else if (
        !(await this.claimCommand(row, "walletCreateCommandId", walletCreateCommandId, {
          previous: null,
          countAttempt: countOnce(),
        }))
      ) {
        throw await this.lostRace(ctx, walletCreateCommandId);
      }
      try {
        await this.wallet.externalSubmit({
          commandId: walletCreateCommandId,
          commands: [
            userWalletCreateCommand({
              templateId: this.ledger.templateId("UserWallet"),
              admin: treasury,
              owner: payee,
            }),
          ],
        });
      } catch (err) {
        throw await this.attemptFailed(ctx, err, "wallet-create");
      }
      ledgerWallet = await this.ledger.fetchUserWallet(payee, { uncached: true });
      if (!ledgerWallet)
        throw await this.attemptFailed(
          ctx,
          new Error("UserWallet is not visible after create"),
          "wallet-create",
        );
    }

    let settleId = settleCommandId;
    if (row.settleCommandId) {
      const status = await this.wallet.commandStatus(treasury, row.settleCommandId);
      if (this.readFailed(status)) throw await this.stopUnknown(ctx, row.settleCommandId);
      if (status.known && status.submitted) throw await this.inFlight(ctx, row.settleCommandId);
      // The wallet says the recorded SettleToWallet failed (or never saw it). Unlike an external
      // transfer, re-submitting a CONSUMING choice cannot pay twice — the ledger rejects it once
      // the contract is gone — so the in-app path retries, under a fresh id.
      settleId = retryCommandId(settleCommandId, row.attempts + 1);
    }
    // `walletCid` is always the cid read moments ago: every Deposit / Credit replaces it.
    if (
      !(await this.claimCommand(row, "settleCommandId", settleId, {
        previous: row.settleCommandId,
        countAttempt: countOnce(),
      }))
    ) {
      throw await this.lostRace(ctx, settleId);
    }
    try {
      await this.wallet.externalSubmit({
        commandId: settleId,
        commands: [
          this.exercisePayout(cid, "SettleToWallet", { walletCid: ledgerWallet.contractId }),
        ],
      });
    } catch (err) {
      throw await this.attemptFailed(ctx, err, "settle-to-wallet");
    }
    if (await this.stillLive(cid)) throw await this.inFlight(ctx, settleId);
    return this.settled(ctx, "settled_in_app", "in_app");
  }

  private exercisePayout(
    cid: string,
    choice: "MarkPaid" | "SettleToWallet",
    choiceArgument: Record<string, unknown>,
  ): unknown {
    return {
      ExerciseCommand: {
        templateId: this.ledger.templateId("PendingPayout"),
        contractId: cid,
        choice,
        choiceArgument,
      },
    };
  }

  /** The wallet accepted a consuming command; only the ledger says whether it executed. */
  private async stillLive(cid: string): Promise<boolean> {
    return (await this.ledger.fetchPendingPayout(cid, { uncached: true })) !== null;
  }

  /** A command-status read that failed outright (network / 5xx) — not a 404, which is merely "unknown to the wallet". */
  private readFailed(status: TransferStatusResult): boolean {
    return !status.known && status.status !== "not_found";
  }

  // ───────────────────────────────────────────── archived contracts ──────────────────────────

  /**
   * The contract is gone: either a recorded submit consumed it (settled) or the user exercised
   * CancelPayout (archived). A recorded MarkPaid means the transfer was confirmed before it, so
   * the payout is settled without asking; a recorded transfer is asked about on the transfer
   * index; a recorded SettleToWallet the wallet cannot confirm is parked for an operator —
   * never labelled "archived" (the user would read "Cancelled" for a bond that may have landed).
   */
  private async resolveArchived(ctx: SettleContext): Promise<SettleResult> {
    const { row, cid } = ctx;
    if (TERMINAL.has(row.status)) return { payout: row, mode: "already_settled", onLedger: false };

    if (row.markPaidCommandId) return this.settled(ctx, "settled_external", "external");
    if (row.transferCommandId) {
      const status = await this.wallet.transferStatus(
        this.config.treasuryPartyId,
        row.transferCommandId,
      );
      if (!status.known) throw await this.stopUnknown(ctx, row.transferCommandId);
      if (status.submitted) return this.settled(ctx, "settled_external", "external");
      // Recorded but never submitted: the user cancelled between the write-ahead and the call.
    } else if (row.settleCommandId) {
      const status = await this.wallet.commandStatus(
        this.config.treasuryPartyId,
        row.settleCommandId,
      );
      if (this.readFailed(status)) throw await this.stopUnknown(ctx, row.settleCommandId);
      if (status.known && status.submitted) return this.settled(ctx, "settled_in_app", "in_app");
      const detail = `PendingPayout is gone but the wallet reports SettleToWallet ${row.settleCommandId} as ${status.status ?? "unknown"}; operator review required`;
      if (row.status !== "failed") {
        this.sentry.captureMessage(
          "in-app payout archived without a confirmed settlement",
          "error",
          { processor: "payout", cid },
        );
        this.logger.error(`payout ${cid}: ${detail}`);
      }
      return this.block(ctx, "failed", detail);
    }
    await this.transition(row, { status: "archived", lastError: null });
    this.logger.log(`payout ${cid}: archived on the ledger without a settlement (user cancel)`);
    return { payout: row, mode: "already_settled", onLedger: false };
  }

  // ───────────────────────────────────────────── row transitions ─────────────────────────────

  private async firstSight(
    live: PendingPayoutRecord,
    wallet: WalletEntity | null,
    actor: PayoutActor,
  ): Promise<PayoutEntity> {
    const fields = {
      pendingPayoutCid: live.contractId,
      userId: wallet?.userId ?? null,
      payeeParty: live.user,
      payeeWalletId: wallet?.id ?? null,
      amountCC: live.amountCC,
      reason: live.reason,
      status: "queued" as PayoutStatus,
      transferCommandId: null,
      walletCreateCommandId: null,
      settleCommandId: null,
      markPaidCommandId: null,
      attempts: 0,
      lastError: null,
      firstSeenAt: new Date(),
      settledAt: null,
    };
    try {
      return await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(PayoutEntity);
        const saved = await repo.save(repo.create(fields));
        await this.audit.record(
          {
            ...this.actorFields(actor),
            action: "payout.seen",
            subjectType: "payout",
            subjectId: live.contractId,
            metadata: {
              reason: live.reason,
              amountCC: formatCC(live.amountCC),
              payeeParty: live.user,
              userId: saved.userId,
              walletId: saved.payeeWalletId,
            },
          },
          manager,
        );
        return saved;
      });
    } catch (err) {
      // Another instance won the first-sight race on the unique cid: use its row.
      const existing = await this.payouts.findOne({ where: { pendingPayoutCid: live.contractId } });
      if (existing) return existing;
      throw err;
    }
  }

  /** A wallet linked (or revoked) after first sight changes who the payout belongs to. */
  private async refreshOwner(row: PayoutEntity, wallet: WalletEntity | null): Promise<void> {
    const userId = wallet?.userId ?? null;
    const walletId = wallet?.id ?? null;
    if (row.userId === userId && row.payeeWalletId === walletId) return;
    row.userId = userId;
    row.payeeWalletId = walletId;
    await this.payouts.save(row);
  }

  private async transition(
    row: PayoutEntity,
    patch: Partial<PayoutEntity>,
    audit?: AuditInput,
  ): Promise<PayoutEntity> {
    Object.assign(row, patch);
    if (!audit) return this.payouts.save(row);
    return this.dataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(PayoutEntity).save(row);
      await this.audit.record(audit, manager);
      return saved;
    });
  }

  /**
   * Compare-and-set write-ahead of a command id: the row must still carry `previous` in that
   * column (null = never claimed) and be in a non-terminal status. `false` means another instance
   * claimed it between our read and this write — the caller must not call upstream.
   */
  private async claimCommand(
    row: PayoutEntity,
    field: CommandField,
    commandId: string,
    opts: { previous: string | null; countAttempt: boolean },
  ): Promise<boolean> {
    const column = COMMAND_COLUMNS[field];
    const qb = this.payouts
      .createQueryBuilder()
      .update(PayoutEntity)
      .set({
        status: "settling",
        [field]: commandId,
        lastError: null,
        ...(opts.countAttempt ? { attempts: () => "attempts + 1" } : {}),
      })
      .where("id = :id AND status IN (:...statuses)", { id: row.id, statuses: NON_TERMINAL });
    if (opts.previous === null) qb.andWhere(`${column} IS NULL`);
    else qb.andWhere(`${column} = :previous`, { previous: opts.previous });
    const res = await qb.execute();
    if (!res.affected) return false;
    const fresh = await this.payouts.findOneByOrFail({ id: row.id });
    Object.assign(row, fresh);
    return true;
  }

  /** Another instance recorded the command id first: no upstream call, the row already says so. */
  private async lostRace(ctx: SettleContext, commandId: string): Promise<ApiError> {
    const fresh = await this.payouts.findOne({ where: { id: ctx.row.id } });
    if (fresh) Object.assign(ctx.row, fresh);
    this.logger.warn(
      `payout ${ctx.cid}: ${commandId} was claimed by another settlement; standing down`,
    );
    return new ApiError(
      409,
      "payout_blocked",
      "a settlement for this payout is already in progress",
      { status: ctx.row.status, reason: "in_flight" },
    );
  }

  /** Persist a blocked (or failed) verdict and throw the matching 409. Audited/published on change only. */
  private async block(ctx: SettleContext, status: PayoutStatus, detail: string): Promise<never> {
    const { row, cid, actor } = ctx;
    const changed = row.status !== status;
    const action = status === "failed" ? "payout.failed" : "payout.blocked";
    await this.transition(
      row,
      { status, lastError: detail },
      changed
        ? {
            ...this.actorFields(actor),
            action,
            subjectType: "payout",
            subjectId: cid,
            metadata: {
              status,
              detail,
              reason: row.reason,
              userId: row.userId,
              attempts: row.attempts,
            },
          }
        : undefined,
    );
    if (changed) {
      await this.nats.publishSafe(
        status === "failed" ? NatsSubjects.payoutFailed : NatsSubjects.payoutBlocked,
        { cid, userId: row.userId, payeeParty: row.payeeParty, status, detail },
        { msgId: `${action}:${cid}:${status}` },
      );
      this.logger.warn(`payout ${cid}: ${status} (${detail})`);
    }
    throw new ApiError(409, blockedCode(status, detail), blockedMessage(status), { status });
  }

  /** An attempt did upstream work and failed. Keeps `settling` (resume next time) until the cap → `failed`. */
  private async attemptFailed(ctx: SettleContext, err: unknown, phase: string): Promise<ApiError> {
    const { row, cid, actor } = ctx;
    const detail = `${phase}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 800);
    const exhausted = row.attempts >= this.config.payoutMaxAttempts;
    const status: PayoutStatus = exhausted ? "failed" : "settling";
    const becameFailed = exhausted && row.status !== "failed";
    await this.transition(
      row,
      { status, lastError: detail },
      becameFailed
        ? {
            ...this.actorFields(actor),
            action: "payout.failed",
            subjectType: "payout",
            subjectId: cid,
            metadata: { attempts: row.attempts, detail, reason: row.reason, userId: row.userId },
          }
        : undefined,
    );
    if (becameFailed) {
      await this.nats.publishSafe(
        NatsSubjects.payoutFailed,
        { cid, userId: row.userId, payeeParty: row.payeeParty, status, attempts: row.attempts },
        { msgId: `payout.failed:${cid}` },
      );
      this.logger.error(`payout ${cid}: giving up after ${row.attempts} attempt(s) — ${detail}`);
      this.sentry.captureMessage(
        `payout settlement failed after ${row.attempts} attempts`,
        "error",
        { processor: "payout", phase },
      );
    } else {
      this.logger.warn(`payout ${cid}: attempt ${row.attempts} failed at ${phase}: ${detail}`);
    }
    if (err instanceof ApiError) return err;
    return new ApiError(502, "upstream_failed", `payout settlement failed at ${phase}`, {
      status,
      attempts: row.attempts,
    });
  }

  /** Fail CLOSED: the wallet could not say what happened to a recorded id. No attempt is charged. */
  private async stopUnknown(ctx: SettleContext, commandId: string): Promise<ApiError> {
    await this.transition(ctx.row, {
      status: "settling",
      lastError: `status of ${commandId} could not be read; settlement paused`,
    });
    this.logger.warn(`payout ${ctx.cid}: wallet could not report ${commandId}; failing closed`);
    return new ApiError(
      502,
      "upstream_failed",
      "the wallet could not confirm a previous submission; settlement is paused and will be retried",
      {
        status: "settling",
      },
    );
  }

  /** A recorded submission is accepted but not yet on the ledger: wait for the next scan. */
  private async inFlight(ctx: SettleContext, commandId: string): Promise<ApiError> {
    await this.transition(ctx.row, {
      status: "settling",
      lastError: `${commandId} accepted by the wallet, waiting for the ledger`,
    });
    return new ApiError(
      409,
      "payout_blocked",
      "a previous submission for this payout is still in flight",
      { status: "settling", reason: "in_flight" },
    );
  }

  /** Terminal transition as a compare-and-set: whoever moves the row out of a non-terminal status audits and publishes once. */
  private async settled(
    ctx: SettleContext,
    status: "settled_external" | "settled_in_app",
    mode: "external" | "in_app",
  ): Promise<SettleResult> {
    const { row, cid, actor } = ctx;
    const won = await this.dataSource.transaction(async (manager) => {
      const res = await manager
        .getRepository(PayoutEntity)
        .createQueryBuilder()
        .update(PayoutEntity)
        .set({ status, settledAt: new Date(), lastError: null })
        .where("id = :id AND status IN (:...statuses)", { id: row.id, statuses: NON_TERMINAL })
        .execute();
      if (!res.affected) return false;
      await this.audit.record(
        {
          ...this.actorFields(actor),
          action: "payout.settled",
          subjectType: "payout",
          subjectId: cid,
          metadata: {
            mode,
            amountCC: formatCC(row.amountCC),
            reason: row.reason,
            userId: row.userId,
            transferCommandId: row.transferCommandId,
            markPaidCommandId: row.markPaidCommandId,
            walletCreateCommandId: row.walletCreateCommandId,
            settleCommandId: row.settleCommandId,
            attempts: row.attempts,
          },
        },
        manager,
      );
      return true;
    });
    const fresh = await this.payouts.findOne({ where: { id: row.id } });
    if (fresh) Object.assign(row, fresh);
    if (!won) return { payout: row, mode: "already_settled", onLedger: false };
    await this.nats.publishSafe(
      NatsSubjects.payoutSettled,
      {
        cid,
        userId: row.userId,
        payeeParty: row.payeeParty,
        mode,
        amountCC: formatCC(row.amountCC),
        reason: row.reason,
      },
      { msgId: `payout.settled:${cid}` },
    );
    this.logger.log(
      `payout ${cid}: settled ${formatCC(row.amountCC)} CC to ${row.payeeParty} (${row.reason}) ${mode}${actor.type === "system" ? "" : ` by ${actor.type}`}`,
    );
    return { payout: row, mode, onLedger: false };
  }

  private actorFields(
    actor: PayoutActor,
  ): Pick<AuditInput, "actorType" | "actorUserId" | "actorSessionId" | "ip"> {
    return {
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      ip: actor.ip ?? null,
    };
  }

  // ───────────────────────────────────────────── processor entry points ──────────────────────

  /**
   * One pass over the ledger (every PAYOUT_SCAN_MS): settle every active PendingPayout the row
   * does not hold back (new, queued, or a crashed `settling`), and resolve every open row whose
   * contract has vanished. Blocked rows are left alone — they wait for a user retry, a KYC
   * approval (`requeueBlockedKyc`) or an operator.
   */
  async scan(): Promise<void> {
    const live = await this.ledger.fetchPendingPayouts({ uncached: true });
    const liveCids = live.map((p) => p.contractId);
    const rows = await this.payouts.find({
      where:
        liveCids.length > 0
          ? [{ status: In(NON_TERMINAL) }, { pendingPayoutCid: In(liveCids) }]
          : { status: In(NON_TERMINAL) },
    });
    const byCid = new Map(rows.map((r) => [r.pendingPayoutCid, r]));
    const liveSet = new Set(liveCids);

    const todo: string[] = [];
    for (const p of live) {
      const row = byCid.get(p.contractId);
      if (!row || RETRIABLE.has(row.status)) todo.push(p.contractId);
      // A live PendingPayout whose row says "settled" must never exist silently: the user sees
      // "Settled", nothing was credited, and CancelPayout could still refund it (double pay).
      if (row && TERMINAL.has(row.status) && row.status !== "archived") {
        this.logger.error(
          `scan: ${p.contractId} is ${row.status} in to_payouts but still active on the ledger`,
        );
        this.sentry.captureMessage("settled payout still active on the ledger", "error", {
          processor: "payout-settlement",
          cid: p.contractId,
          status: row.status,
        });
      }
    }
    for (const r of rows) {
      if (!liveSet.has(r.pendingPayoutCid) && !TERMINAL.has(r.status))
        todo.push(r.pendingPayoutCid);
    }

    let settled = 0;
    let held = 0;
    let errored = 0;
    for (const cid of todo) {
      try {
        const result = await this.settle(cid, { type: "system" });
        if (result.mode !== "already_settled") settled += 1;
      } catch (err) {
        if (err instanceof ApiError) {
          // Blocked, paused, in flight or locked by another instance: the row already says why.
          held += 1;
          this.logger.debug(`scan: ${cid} held (${err.code}: ${err.message})`);
        } else {
          errored += 1;
          this.logger.error(`scan: ${cid} errored: ${(err as Error).message}`);
          this.sentry.captureException(err, { processor: "payout-settlement", cid });
        }
      }
    }
    if (todo.length > 0)
      this.logger.log(
        `scan: ${todo.length} payout(s) examined, ${settled} settled, ${held} held, ${errored} errored`,
      );
  }

  /** `truthoracle.kyc.status_changed` → approved: the user's `blocked_kyc` rows go back to the queue. */
  async requeueBlockedKyc(userId: string): Promise<number> {
    const rows = await this.payouts.find({ where: { userId, status: "blocked_kyc" } });
    for (const row of rows) {
      await this.transition(
        row,
        { status: "queued", lastError: null },
        {
          actorType: "system",
          action: "payout.requeued",
          subjectType: "payout",
          subjectId: row.pendingPayoutCid,
          metadata: { from: "blocked_kyc", trigger: "kyc.status_changed", userId },
        },
      );
    }
    if (rows.length > 0)
      this.logger.log(`requeued ${rows.length} blocked_kyc payout(s) for user ${userId}`);
    return rows.length;
  }

  // ───────────────────────────────────────────── reads ───────────────────────────────────────

  async listForUser(userId: string): Promise<PayoutEntity[]> {
    return this.payouts.find({ where: { userId }, order: { firstSeenAt: "DESC" } });
  }

  async listAll(filter: { status?: PayoutStatus } = {}): Promise<PayoutEntity[]> {
    return this.payouts.find({
      where: filter.status ? { status: filter.status } : {},
      order: { firstSeenAt: "DESC" },
      take: 500,
    });
  }

  /**
   * `GET /in-app-wallet/payouts`: the ledger's active PendingPayouts addressed to any of the
   * user's wallets merged with the user's rows. Ledger-only entries (not yet scanned) show as
   * `queued`; row-only entries are no longer on the ledger (`onLedger: false`).
   */
  async listMergedForUser(userId: string): Promise<ApiPayout[]> {
    const wallets = await this.walletLink.listForUser(userId);
    const walletByParty = new Map(wallets.map((w) => [w.partyId, w]));
    const parties = [...walletByParty.keys()];
    const [rows, live] = await Promise.all([
      this.payouts.find({
        where: parties.length > 0 ? [{ userId }, { payeeParty: In(parties) }] : { userId },
      }),
      this.ledger.fetchPendingPayouts(),
    ]);
    const byCid = new Map(rows.map((r) => [r.pendingPayoutCid, r]));
    const out: ApiPayout[] = [];
    const seen = new Set<string>();
    for (const p of live) {
      if (!walletByParty.has(p.user)) continue;
      const row = byCid.get(p.contractId);
      out.push(row ? this.toApi(row, true) : this.unseenToApi(p, walletByParty.get(p.user)));
      seen.add(p.contractId);
    }
    for (const r of rows) {
      if (!seen.has(r.pendingPayoutCid)) out.push(this.toApi(r, false));
    }
    return out.sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));
  }

  toApi(payout: PayoutEntity, onLedger: boolean): ApiPayout {
    return {
      pendingPayoutCid: payout.pendingPayoutCid,
      payeeParty: payout.payeeParty,
      walletId: payout.payeeWalletId,
      amountCC: formatCC(payout.amountCC),
      reason: payout.reason,
      status: payout.status,
      retryAfterKyc: payout.status === "blocked_kyc",
      attempts: payout.attempts,
      lastError: payout.lastError,
      firstSeenAt: payout.firstSeenAt.toISOString(),
      settledAt: payout.settledAt ? payout.settledAt.toISOString() : null,
      onLedger,
    };
  }

  private unseenToApi(p: PendingPayoutRecord, wallet: WalletEntity | undefined): ApiPayout {
    return {
      pendingPayoutCid: p.contractId,
      payeeParty: p.user,
      walletId: wallet?.id ?? null,
      amountCC: formatCC(p.amountCC),
      reason: p.reason,
      status: "queued",
      retryAfterKyc: false,
      attempts: 0,
      lastError: null,
      firstSeenAt: (p.createdAt ?? new Date()).toISOString(),
      settledAt: null,
      onLedger: true,
    };
  }
}
