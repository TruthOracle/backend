import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";

import { Config } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import { PayoutEntity } from "../entities/payout.entity";
import type { WalletEntity } from "../entities/wallet.entity";
import {
  type ApiPayout,
  type ApiPayoutStatus,
  type ErrorCode,
  NatsSubjects,
  type PayoutStatus,
  type PendingPayoutRecord,
  TREASURY_TRANSFER_MODES,
  type TreasuryTransferMode,
  type TreasuryTransferRequest,
  USER_PAYOUT_PROCESSING,
} from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, quantizeDown } from "../util/money";
import { AuditService, type AuditInput } from "./audit.service";
import { EnterpriseWalletService, type TransferStatusResult } from "./enterprise-wallet.service";
import { InstrumentsService } from "./instruments.service";
import { KycService } from "./kyc.service";
import {
  LedgerClientService,
  userWalletCreateCommand,
  walletCreateCommandIdFor,
} from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { ComplianceFreezePort } from "./compliance-freeze.port";
import { RampCompliancePort } from "./ramp-compliance.port";
import { offrampLedgerOutcome, RampPolicyService } from "./ramp-policy.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { TreasuryTransferService } from "./treasury-transfer.service";
import { UserService } from "./user.service";
import { WalletLinkService } from "./wallet-link.service";

/**
 * Settlement of on-ledger PendingPayouts under the KYC gate (docs/ARCHITECTURE.md §9.4). Port of
 * the Vercel function `api/wallet/settle-payout.mjs` pm-frontend shipped before settlement moved
 * here (since removed there), extended with the `to_payouts` write-ahead arbiter, the closed
 * reason policy and the in-app path.
 *
 * The contract IS the authorisation: the payee, the instrument and the amount are read from the
 * on-ledger PendingPayout, which only the market and wallet choices can create. A caller supplies
 * a contract id and nothing else, so the worst a hostile caller can do is settle a payout that
 * the ledger already says is owed — to the party the ledger says owns it, in the token it names.
 * External settlement sends `amount` quantised down to the instrument's decimals (the dust stays
 * in-app and is recorded in `to_payouts.details.dust`, docs/TOKENS.md §4.3) through
 * `TreasuryTransferService` — the Enterprise Wallet's transfer or a registry-built
 * `TransferFactory_Transfer`, per the instrument's `transfer_mode`; the mode used is recorded on
 * the row (`details.transferMode`) so a later attempt asks the right status index.
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

/** `offramp` = a signed withdrawal bound to a card cash-out: MarkPaid only, the ramp pays the fiat (docs/RAMP.md §3.2). */
export type PayoutMode = "external" | "in_app" | "offramp" | "already_settled";

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
/**
 * Statuses the scan retries on its own; blocked rows wait for a user, a KYC approval or an operator —
 * except what ends by itself, so the scan re-checks it: the card exposure decays (SPEC §9.3), the
 * payout gate passes again (§6.4, S4), a freeze is lifted / a compliance review cleared (§11.5).
 */
const RETRIABLE: ReadonlySet<PayoutStatus> = new Set([
  "queued",
  "settling",
  "blocked_ramp_exposure",
  "blocked_payout_gate",
  "blocked_compliance",
]);
/** `force` may override these and nothing else (ARCHITECTURE §9.4) — never the exposure (I5) nor a freeze. */
const FORCEABLE: ReadonlySet<PayoutStatus> = new Set(["blocked_kyc", "blocked_wallet_revoked"]);
const NON_TERMINAL: PayoutStatus[] = [
  "queued",
  "settling",
  "blocked_kyc",
  "blocked_unknown_user",
  "blocked_unknown_reason",
  "blocked_wallet_revoked",
  "blocked_ramp_exposure",
  "blocked_payout_gate",
  "blocked_compliance",
  "failed",
];
const COMMAND_COLUMNS = {
  transferCommandId: "transfer_command_id",
  walletCreateCommandId: "wallet_create_command_id",
  settleCommandId: "settle_command_id",
  markPaidCommandId: "mark_paid_command_id",
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

/** One UserWallet per payee per package name: the shared deterministic id (ledger-client.service), re-exported for callers and tests. */
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

/** The off-ramp order a withdrawal was bound to (`to_payouts.details.offrampOrderId`), if any. */
function offrampOrderOf(row: PayoutEntity): string | null {
  const id = row.details?.offrampOrderId;
  return typeof id === "string" && id ? id : null;
}

function notFound(): ApiError {
  return new ApiError(404, "payout_not_found", "payout not found");
}

/**
 * C8 / C11 (I10, X6: no tipping-off): the internal holds the payee only ever sees as the one
 * neutral `processing` — a freeze, a compliance review, the payout gate. Operators see them all.
 */
const USER_NEUTRAL_STATUSES: ReadonlySet<PayoutStatus> = new Set([
  "blocked_compliance",
  "blocked_payout_gate",
]);

/** The status the PAYEE sees (C8 / C11): every internal hold is `processing`. */
export function userPayoutStatus(status: PayoutStatus): ApiPayoutStatus {
  return USER_NEUTRAL_STATUSES.has(status) ? USER_PAYOUT_PROCESSING : status;
}

function blockedCode(status: PayoutStatus, detail: string): ErrorCode {
  if (status === "blocked_ramp_exposure") return "ramp_exposure";
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
    case "blocked_ramp_exposure":
      return "value bought by card is inside the card dispute window; the withdrawal settles by itself when it ends";
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
    private readonly instruments: InstrumentsService,
    private readonly treasuryTransfers: TreasuryTransferService,
    private readonly sentry: SentryService,
    private readonly rampPolicy: RampPolicyService,
    private readonly freeze: ComplianceFreezePort,
    // Review group A (C25): a cash-out AML decided to give back is never MarkPaid.
    private readonly compliance: RampCompliancePort,
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

    // A withdrawal bound to a card cash-out settles by MarkPaid alone (docs/RAMP.md §3.2).
    if (offrampOrderOf(row)) return this.executeOfframp(ctx);
    // A recorded submit means money may already have moved: finish that path. Policy is never
    // re-evaluated past this point — a wallet revoked after the transfer must still be MarkPaid.
    if (row.transferCommandId) return this.executeExternal(ctx);
    if (row.settleCommandId || row.walletCreateCommandId) return this.executeInApp(ctx);
    if (!live.user || live.amount <= 0n) {
      return this.block(
        ctx,
        "failed",
        live.user ? "payout amount is not positive" : "payout has no payee",
      );
    }
    // An instrument the platform does not know or has disabled cannot leave (or be credited): the
    // row waits for an operator, who registers / enables the token and retries.
    const instrument = await this.instruments.get(live.instrument.admin, live.instrument.id);
    if (!instrument)
      return this.block(
        ctx,
        "blocked_unknown_reason",
        `instrument ${live.instrument.id} (${live.instrument.admin.slice(0, 24)}…) is not registered`,
      );
    if (!instrument.enabled)
      return this.block(
        ctx,
        "blocked_unknown_reason",
        `instrument ${instrument.symbol} is disabled`,
      );

    const policy = this.policyFor(live.reason);
    if (policy === "unknown")
      return this.block(
        ctx,
        "blocked_unknown_reason",
        `reason "${live.reason}" is not in the payout policy`,
      );
    if (policy === "in_app") {
      // SPEC §11.6 (B3): nothing is credited into a frozen account's in-app wallet; the payout
      // stays live and waits (`blocked_compliance`, retried by the scan, never forceable).
      if (wallet && (await this.freeze.isFrozen(wallet.userId)))
        return this.block(ctx, "blocked_compliance", "the payee account is frozen");
      return this.executeInApp(ctx);
    }

    // A signed withdrawal an off-ramp order of the payee's account waits for (same instrument,
    // exact amount) becomes that cash-out: the binding is a compare-and-set on the order.
    if (live.reason === "withdraw" && wallet) {
      const orderId = await this.rampPolicy.bindWithdrawal(
        {
          cid,
          userId: wallet.userId,
          party: live.user,
          instrument: live.instrument,
          amount: live.amount,
        },
        { type: actor.type, userId: actor.userId ?? null, sessionId: actor.sessionId ?? null },
      );
      if (orderId) {
        await this.transition(row, {
          details: { ...(row.details ?? {}), offrampOrderId: orderId },
        });
        return this.executeOfframp(ctx);
      }
    }

    // Tokens leave the platform: user active AND payee wallet active AND not frozen AND the KYC
    // gate AND within the card exposure — always evaluated on the PAYEE's account, never the caller's.
    const verdict = await this.externalVerdict(wallet, { live });
    if (verdict) {
      if (!(await this.mayForce(ctx, verdict.status, wallet?.userId ?? null)))
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

  /**
   * `live` adds the card-exposure check of a plain withdrawal (SPEC §9.3, I5: the balance above the
   * exposure may leave; retried as it decays); a cash-out passes `enforceKyc` instead (the ramp gates
   * on KYC whatever KYC_ENFORCE_WITHDRAWALS says) and no `live`: its order re-checks the exposure
   * before MarkPaid. A frozen payee (S7b) is `blocked_compliance` either way, neutral to the user.
   */
  private async externalVerdict(
    wallet: WalletEntity | null,
    opts: { live?: PendingPayoutRecord; enforceKyc?: boolean } = {},
  ): Promise<Verdict | null> {
    if (!wallet)
      return { status: "blocked_unknown_user", detail: "payee party is not linked to any account" };
    const user = await this.users.findById(wallet.userId);
    if (!user) return { status: "blocked_unknown_user", detail: "payee account not found" };
    if (wallet.status !== "active")
      return { status: "blocked_wallet_revoked", detail: "payee wallet is revoked" };
    if (user.status !== "active") return { status: "blocked_kyc", detail: "user_suspended" };
    // R2b-5: a party linked since the payee's last screening (or never screened) first; one that
    // cannot be screened holds the payout (I7).
    try {
      await this.freeze.screenNewParties(user.id);
    } catch (err) {
      return {
        status: "blocked_compliance",
        detail: `the payee's parties could not be screened: ${(err as Error).message}`,
      };
    }
    if (await this.freeze.isFrozen(user.id))
      return { status: "blocked_compliance", detail: "the payee account is frozen" };
    // The gate owns KYC_ENFORCE_WITHDRAWALS too (INTERNALS), but it is only consulted when the
    // flag is on: with enforcement off the answer is `allowed` by contract, and not calling it
    // keeps settlement independent of the KYC provider being reachable.
    const enforce = opts.enforceKyc ?? this.config.kycEnforceWithdrawals;
    if (enforce) {
      const gate = await this.kyc.withdrawalGate(user.id, { enforce });
      if (!gate.allowed) return { status: "blocked_kyc", detail: gate.reason ?? "kyc_required" };
    }
    if (opts.live) {
      const exposed = await this.rampPolicy.exposureHold(
        user.id,
        opts.live.user,
        opts.live.instrument,
        opts.live.amount,
      );
      if (exposed)
        return {
          status: "blocked_ramp_exposure",
          detail: `card value inside the dispute window: ${formatAmount(exposed.withdrawable)} can leave now`,
        };
    }
    return null;
  }

  // ───────────────────────────────────────────── external path ───────────────────────────────

  private async executeExternal(ctx: LiveContext): Promise<SettleResult> {
    const { cid, row, actor, live } = ctx;
    const { transferCommandId, markPaidCommandId } = commandIdsFor(cid);
    const instrument = await this.instruments.get(live.instrument.admin, live.instrument.id);
    if (!instrument)
      return this.block(
        ctx,
        "blocked_unknown_reason",
        `instrument ${live.instrument.id} is not registered`,
      );
    const sendable = quantizeDown(live.amount, instrument.decimals);
    if (sendable <= 0n) {
      return this.block(
        ctx,
        "failed",
        `payout of ${formatAmount(live.amount)} ${instrument.symbol} is below the instrument's smallest unit (${instrument.decimals} decimals)`,
      );
    }

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
      // What quantisation kept in-app and how the money leaves are facts of this settlement,
      // recorded before the money moves: a later attempt must ask the status index of the mode
      // that was used, not of the mode the instrument is configured with by then.
      const transferMode = this.instruments.transferModeOf(instrument);
      await this.transition(row, {
        details: {
          ...(row.details ?? {}),
          dust: formatAmount(live.amount - sendable),
          sent: formatAmount(sendable),
          transferMode,
        },
      });
      try {
        await this.treasuryTransfers.transfer(
          this.transferRequest(ctx, transferCommandId, sendable),
        );
      } catch (err) {
        // Unknown whether the wallet accepted it: the row keeps the id, the next attempt asks.
        throw await this.attemptFailed(ctx, err, "transfer");
      }
    } else {
      // Skip the transfer when a previous attempt already submitted it (crashed before
      // MarkPaid, or a concurrent request from another instance won). The payout is still
      // active, so finishing the job means archiving it — not paying again.
      const status = await this.treasuryTransfers.status(
        this.recordedTransferMode(row, instrument),
        row.transferCommandId,
      );
      if (!status.known) throw await this.stopUnknown(ctx, row.transferCommandId);
      if (!status.submitted) {
        if (await this.mayResendTransfer(ctx)) {
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
            await this.treasuryTransfers.transfer(
              this.transferRequest(ctx, row.transferCommandId, sendable),
            );
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

    // The tokens have moved. If MarkPaid fails the user still has their money; the row just lingers
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

  /** The treasury transfer of a payout: the payout's instrument, the payee, the amount quantised to the instrument's decimals. */
  private transferRequest(
    ctx: LiveContext,
    commandId: string,
    amount: bigint,
  ): TreasuryTransferRequest {
    const { cid, live } = ctx;
    return {
      instrument: live.instrument,
      to: live.user,
      amount,
      reason: live.reason || "payout",
      commandId,
      metadata: { kind: "truthoracle_admin_payout", pending_payout_cid: cid },
    };
  }

  /** The mode the recorded transfer was sent with (`details.transferMode`), else the instrument's current one. */
  private recordedTransferMode(
    row: PayoutEntity,
    instrument: InstrumentEntity | null,
  ): TreasuryTransferMode {
    const recorded = row.details?.transferMode;
    if (
      typeof recorded === "string" &&
      (TREASURY_TRANSFER_MODES as readonly string[]).includes(recorded)
    )
      return recorded as TreasuryTransferMode;
    return instrument
      ? this.instruments.transferModeOf(instrument)
      : this.config.treasuryTransferMode;
  }

  /**
   * Admin + force + reason (validated in settle()) and a row older than PAYOUT_RESEND_GRACE_MS —
   * never to a frozen payee (I10): a re-sent transfer moves money like a first one.
   */
  private async mayResendTransfer(ctx: SettleContext): Promise<boolean> {
    const { actor, row } = ctx;
    if (actor.type !== "admin" || !actor.force) return false;
    if (Date.now() - row.firstSeenAt.getTime() < this.config.payoutResendGraceMs) return false;
    if (row.userId && (await this.freeze.isFrozen(row.userId)))
      return this.block(ctx, "blocked_compliance", "the payee account is frozen");
    return true;
  }

  /**
   * `force` overrides a FORCEABLE status (a KYC block, a revoked wallet) and nothing else — and
   * never for a frozen payee (I10, SPEC §11.6): the freeze is asked FIRST, whatever blocked_*
   * status the verdict names, since a revoked wallet or a suspended account can sit on a frozen
   * one. A force the freeze refuses blocks the row `blocked_compliance` (never forceable).
   */
  private async mayForce(
    ctx: SettleContext,
    status: PayoutStatus,
    userId: string | null,
  ): Promise<boolean> {
    if (!(ctx.actor.force && FORCEABLE.has(status))) return false;
    if (userId && (await this.freeze.isFrozen(userId)))
      return this.block(ctx, "blocked_compliance", "the payee account is frozen");
    return true;
  }

  // ───────────────────────────────────────────── off-ramp path ───────────────────────────────

  /**
   * A cash-out (docs/RAMP.md §3.2): consume the PendingPayout with `MarkPaid { txHash = ramp:<order> }`
   * — nothing else moves here; the ramp burns and pays the fiat once this row is
   * `settled_external`. Until the first MarkPaid the payee is checked as for any withdrawal (KYC
   * per RAMP_REQUIRE_KYC). A recorded MarkPaid is retried under a fresh id only when the wallet
   * says it FAILED (a consuming choice cannot pay twice, but a fresh id after a merely unknown one
   * could misread a late-landing first attempt as the user's cancel); unknown waits.
   */
  private async executeOfframp(ctx: LiveContext): Promise<SettleResult> {
    const { cid, row, actor } = ctx;
    const orderId = offrampOrderOf(row) ?? "";
    const { markPaidCommandId } = commandIdsFor(cid);
    let markPaidId = markPaidCommandId;
    if (row.markPaidCommandId) {
      const status = await this.wallet.commandStatus(
        this.config.treasuryPartyId,
        row.markPaidCommandId,
      );
      if (this.readFailed(status)) throw await this.stopUnknown(ctx, row.markPaidCommandId);
      // Gone from the ledger: only the indexed archiving transaction says whose choice it was (C1).
      if (!(await this.stillLive(cid))) return this.resolveArchived(ctx);
      // Live: a FAILED MarkPaid is retried under a fresh id; anything else is in flight.
      if (!status.known || status.submitted) throw await this.inFlight(ctx, row.markPaidCommandId);
      markPaidId = retryCommandId(markPaidCommandId, row.attempts + 1);
    }
    // MarkPaid takes the user's tokens: only for an order still waiting for it (never after an
    // operator failed or the user cancelled the cash-out), and — the first time — only after the
    // checks of SPEC §4.1 run again with the live amount (H2, M2, E-D3).
    // C25: AML decided this cash-out's value goes back to the user: MarkPaid never runs (the user
    // may cancel; the order waits for a person). Never forceable.
    if (await this.compliance.returnRequested(orderId))
      return this.block(ctx, "blocked_compliance", "AML decided not to pay this cash-out");
    const refusal = await this.rampPolicy.markPaidRefusal(orderId, ctx.live);
    if (refusal) {
      if (!(await this.mayForce(ctx, refusal.status, row.userId)))
        return this.block(ctx, refusal.status, refusal.detail);
    }
    if (!row.markPaidCommandId) {
      const wallet = await this.walletLink.findByParty(ctx.live.user);
      const verdict = await this.externalVerdict(wallet, {
        enforceKyc: this.config.ramp.requireKyc,
      });
      if (verdict) {
        if (!(await this.mayForce(ctx, verdict.status, wallet?.userId ?? row.userId)))
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
            offrampOrderId: orderId,
            userId: row.userId,
          },
        });
      }
    }
    if (
      !(await this.claimCommand(row, "markPaidCommandId", markPaidId, {
        previous: row.markPaidCommandId,
        countAttempt: true,
      }))
    )
      throw await this.lostRace(ctx, markPaidId);
    try {
      await this.wallet.externalSubmit({
        commandId: markPaidId,
        commands: [this.exercisePayout(cid, "MarkPaid", { txHash: `ramp:${orderId}` })],
      });
    } catch (err) {
      throw await this.attemptFailed(ctx, err, "markpaid");
    }
    if (await this.stillLive(cid)) throw await this.inFlight(ctx, markPaidId);
    return this.resolveArchived(ctx);
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

    // The payee's wallet in the payout's instrument: a bond refund lands in the market's
    // collateral wallet, never in some other balance the party holds.
    let ledgerWallet = await this.ledger.fetchUserWallet(payee, live.instrument, {
      uncached: true,
    });
    if (!ledgerWallet) {
      const walletCreateCommandId = this.ledger.walletCreateCommandId(payee, live.instrument);
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
              instrument: live.instrument,
              auditObservers: this.config.auditObserverParties,
            }),
          ],
        });
      } catch (err) {
        throw await this.attemptFailed(ctx, err, "wallet-create");
      }
      ledgerWallet = await this.ledger.fetchUserWallet(payee, live.instrument, { uncached: true });
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

    // A cash-out is settled only on LEDGER proof that OUR MarkPaid (`txHash = ramp:<order>`)
    // archived the contract (C1): a wallet that still says "submitted" while the user's
    // CancelPayout archived it must not let the ramp burn or pay. Not indexed yet → in flight.
    const offrampOrderId = offrampOrderOf(row);
    if (offrampOrderId) {
      const outcome = offrampLedgerOutcome(
        await this.rampPolicy.payoutOnLedger(cid),
        offrampOrderId,
      );
      if (outcome === "mark_paid") return this.settled(ctx, "settled_external", "offramp");
      if (outcome === "cancelled") {
        await this.transition(row, { status: "archived", lastError: null });
        this.logger.log(`payout ${cid}: cash-out withdrawal cancelled by the user before MarkPaid`);
        return { payout: row, mode: "already_settled", onLedger: false };
      }
      if (outcome === "other") {
        this.sentry.captureMessage("cash-out PendingPayout archived by another choice", "error", {
          processor: "payout",
          cid,
        });
        return this.block(
          ctx,
          "failed",
          "the PendingPayout was archived by something other than the ramp's MarkPaid",
        );
      }
      throw await this.inFlight(ctx, row.markPaidCommandId ?? "the archive");
    }

    if (row.markPaidCommandId) return this.settled(ctx, "settled_external", "external");
    if (row.transferCommandId) {
      const instrument = await this.instruments.get(row.instrumentAdmin, row.instrumentId);
      const status = await this.treasuryTransfers.status(
        this.recordedTransferMode(row, instrument),
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
      instrumentAdmin: live.instrument.admin,
      instrumentId: live.instrument.id,
      amount: live.amount,
      reason: live.reason,
      details: {},
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
              instrument: live.instrument,
              amount: formatAmount(live.amount),
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
      {
        status: ctx.actor.type === "user" ? userPayoutStatus(ctx.row.status) : ctx.row.status,
        reason: "in_flight",
      },
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
    // C11: the payee's own route learns the neutral status only (operators the real one).
    throw new ApiError(409, blockedCode(status, detail), blockedMessage(status), {
      status: actor.type === "user" ? userPayoutStatus(status) : status,
    });
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
    mode: "external" | "in_app" | "offramp",
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
            instrument: { admin: row.instrumentAdmin, id: row.instrumentId },
            amount: formatAmount(row.amount),
            dust: typeof row.details?.dust === "string" ? row.details.dust : undefined,
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
        instrument: { admin: row.instrumentAdmin, id: row.instrumentId },
        amount: formatAmount(row.amount),
        reason: row.reason,
      },
      { msgId: `payout.settled:${cid}` },
    );
    this.logger.log(
      `payout ${cid}: settled ${formatAmount(row.amount)} ${row.instrumentId} to ${row.payeeParty} (${row.reason}) ${mode}${actor.type === "system" ? "" : ` by ${actor.type}`}`,
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
      out.push(row ? this.toUserApi(row, true) : this.unseenToApi(p, walletByParty.get(p.user)));
      seen.add(p.contractId);
    }
    for (const r of rows) {
      if (!seen.has(r.pendingPayoutCid)) out.push(this.toUserApi(r, false));
    }
    return out.sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));
  }

  // ───────────────────────────────────────────── operator MarkPaid (S4) ───────────────────────

  /** What a `payout.mark_paid` approval snapshots (SPEC §6.5): the payout as the requester saw it. */
  async markPaidSnapshot(cid: string): Promise<{
    cid: string;
    live: boolean;
    status: PayoutStatus | null;
    attempts: number;
    amount: string | null;
    payee: string | null;
    reason: string | null;
    userId: string | null;
  }> {
    const live = await this.ledger.fetchPendingPayout(cid, { uncached: true });
    const row = await this.payouts.findOne({ where: { pendingPayoutCid: cid } });
    if (!live && !row) throw notFound();
    const payee = live?.user ?? row?.payeeParty ?? null;
    const wallet = payee ? await this.walletLink.findByParty(payee) : null;
    return {
      cid,
      live: live !== null,
      status: row?.status ?? null,
      attempts: row?.attempts ?? 0,
      amount: live ? formatAmount(live.amount) : row ? formatAmount(row.amount) : null,
      payee,
      reason: live?.reason ?? row?.reason ?? null,
      userId: row?.userId ?? wallet?.userId ?? null,
    };
  }

  /**
   * `payout.mark_paid` preconditions (fresh reads, X1): the PendingPayout is live; the payee is not
   * frozen nor the payout held for compliance (C29); it is not bound to a ramp cash-out — nor could
   * it bind to one (a `withdraw` of an account with an off-ramp waiting for its signature) — and no
   * settlement command was recorded for it (then `settle` resumes it).
   */
  async validateMarkPaid(cid: string): Promise<PendingPayoutRecord> {
    const live = await this.ledger.fetchPendingPayout(cid, { uncached: true });
    if (!live)
      throw new ApiError(409, "payout_blocked", "the PendingPayout is no longer live", { cid });
    const row = await this.payouts.findOne({ where: { pendingPayoutCid: cid } });
    // C29 (I10, SPEC §11.6: admin actions' validate refuse `frozen`): no payout to a frozen
    // account, nor one a compliance hold blocks, is recorded as paid by hand. Asked of the freeze
    // itself — the row may not exist yet or still show another status (a freeze after the scan).
    const payee = await this.walletLink.findByParty(live.user);
    if (
      row?.status === "blocked_compliance" ||
      (payee && (await this.freeze.isFrozen(payee.userId)))
    )
      throw new ApiError(409, "payout_blocked", "this payout is held for compliance", {
        reason: "compliance_hold",
      });
    const bound = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM to_ramp_orders WHERE pending_payout_cid = $1 LIMIT 1`,
      [cid],
    );
    if ((row && offrampOrderOf(row)) || bound.length)
      throw new ApiError(
        409,
        "payout_blocked",
        "this withdrawal belongs to a ramp cash-out; only its order may consume it",
        {
          reason: "ramp_bound",
        },
      );
    if (live.reason === "withdraw") {
      const wallet = payee;
      const waiting = wallet
        ? await this.dataSource.query<{ id: string }[]>(
            `SELECT id FROM to_ramp_orders WHERE user_id = $1 AND direction = 'offramp' AND status = 'awaiting_withdrawal' LIMIT 1`,
            [wallet.userId],
          )
        : [];
      if (waiting.length)
        throw new ApiError(
          409,
          "payout_blocked",
          "the account has a cash-out waiting for this kind of withdrawal",
          {
            reason: "ramp_bindable",
            orderId: waiting[0].id,
          },
        );
    }
    if (
      row &&
      (row.transferCommandId ||
        row.settleCommandId ||
        row.markPaidCommandId ||
        row.walletCreateCommandId)
    )
      throw new ApiError(
        409,
        "payout_blocked",
        "a settlement was already recorded for this payout; settle resumes it",
        {
          reason: "settlement_recorded",
        },
      );
    if (row && TERMINAL.has(row.status))
      throw new ApiError(409, "payout_blocked", `the payout is already ${row.status}`, {
        status: row.status,
      });
    return live;
  }

  /**
   * An approved `payout.mark_paid` (SPEC §6.5, X1 — it replaces the relay's paste-a-hash MarkPaid):
   * the operator paid this PendingPayout outside the platform; `MarkPaid { txHash }` archives it
   * under the payout's own write-ahead command id, and the row settles on ledger proof.
   */
  async markPaidExternally(
    cid: string,
    input: { txHash: string; reason: string; approvalId: string | null },
    actor: PayoutActor,
  ): Promise<SettleResult> {
    const lock = await this.redis.acquireLock(`lock:payout:${cid}`, PAYOUT_LOCK_TTL_MS);
    if (!lock.acquired)
      throw new ApiError(
        409,
        "payout_blocked",
        "a settlement for this payout is already in progress",
        {
          reason: "settlement_in_progress",
        },
      );
    try {
      const live = await this.validateMarkPaid(cid);
      const wallet = await this.walletLink.findByParty(live.user);
      const row =
        (await this.payouts.findOne({ where: { pendingPayoutCid: cid } })) ??
        (await this.firstSight(live, wallet, actor));
      const ctx: LiveContext = { cid, row, live, actor };
      const { markPaidCommandId } = commandIdsFor(cid);
      if (
        !(await this.claimCommand(row, "markPaidCommandId", markPaidCommandId, {
          previous: null,
          countAttempt: true,
        }))
      )
        throw await this.lostRace(ctx, markPaidCommandId);
      await this.audit.record({
        ...this.actorFields(actor),
        action: "payout.marked_paid",
        subjectType: "payout",
        subjectId: cid,
        metadata: {
          txHash: input.txHash,
          reason: input.reason,
          approvalId: input.approvalId,
          amount: formatAmount(live.amount),
          payoutReason: live.reason,
          userId: row.userId,
        },
      });
      try {
        await this.wallet.externalSubmit({
          commandId: markPaidCommandId,
          commands: [this.exercisePayout(cid, "MarkPaid", { txHash: input.txHash })],
        });
      } catch (err) {
        throw await this.attemptFailed(ctx, err, "markpaid");
      }
      if (await this.stillLive(cid)) throw await this.inFlight(ctx, markPaidCommandId);
      return this.settled(ctx, "settled_external", "external");
    } finally {
      await lock.release();
    }
  }

  /**
   * The PAYEE's view of a payout (C8 / C11, I10): every internal hold as `processing` and never
   * an internal reason — `lastError` is null, or for `failed` the neutral sentence. Every user
   * route (GET /in-app-wallet[/payouts], the settle answer) serialises through this; `toApi` is
   * the operators' view.
   */
  toUserApi(payout: PayoutEntity, onLedger: boolean): ApiPayout {
    return {
      ...this.toApi(payout, onLedger),
      status: userPayoutStatus(payout.status),
      lastError: payout.status === "failed" ? blockedMessage("failed") : null,
    };
  }

  /** The operators' view (admin routes, approval results): the real status and last error. */
  toApi(payout: PayoutEntity, onLedger: boolean): ApiPayout {
    return {
      pendingPayoutCid: payout.pendingPayoutCid,
      payeeParty: payout.payeeParty,
      walletId: payout.payeeWalletId,
      instrument: this.instruments.refFor(payout.instrumentAdmin, payout.instrumentId),
      amount: formatAmount(payout.amount),
      reason: payout.reason,
      status: payout.status,
      retryAfterKyc: payout.status === "blocked_kyc",
      attempts: payout.attempts,
      lastError: payout.lastError,
      firstSeenAt: payout.firstSeenAt.toISOString(),
      settledAt: payout.settledAt ? payout.settledAt.toISOString() : null,
      onLedger,
      offrampOrderId: offrampOrderOf(payout),
    };
  }

  private unseenToApi(p: PendingPayoutRecord, wallet: WalletEntity | undefined): ApiPayout {
    return {
      pendingPayoutCid: p.contractId,
      payeeParty: p.user,
      walletId: wallet?.id ?? null,
      instrument: this.instruments.refOf(p.instrument),
      amount: formatAmount(p.amount),
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
