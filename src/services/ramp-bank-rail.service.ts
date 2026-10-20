import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import { RampBankAccountEntity } from "../entities/ramp-bank-account.entity";
import type { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPayoutBatchItemEntity } from "../entities/ramp-payout-batch-item.entity";
import { RampPayoutBatchEntity } from "../entities/ramp-payout-batch.entity";
import { RAMP_PROVIDER, type Actor, type RampProvider } from "../types";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";
import { AdminApprovalService } from "./admin-approval.service";
import type { AdminActor } from "./admin.service";
import { AuditService } from "./audit.service";
import {
  destinationText,
  moneyOf,
  orderFigures,
  RampActionsService,
  type RampOrderSnapshot,
} from "./ramp-actions.service";
import { RampBankAccountsService } from "./ramp-bank-accounts.service";
import { RampBankBatchesService } from "./ramp-bank-batches.service";
import {
  RampBankRailPort,
  type RampBankDestination,
  type RampBankRailImpl,
} from "./ramp-bank-rail.port";
import { RampCompensationService } from "./ramp-compensation.service";
import { bankAmountOf } from "./ramp-bank-ledger.service";
import { RampDisputesService } from "./ramp-disputes.service";
import { RAMP_ORDER_LOCK_TTL_MS, RampFulfilmentService } from "./ramp-fulfilment.service";
import { RampGatesService } from "./ramp-gates.service";
import { RAMP_IP_RELEASES, RampJournalService, type RampOrderKind } from "./ramp-journal.service";
import { RampOrderStore } from "./ramp-order-store.service";
import { RampReleaseGuard } from "./ramp-release-guard.service";
import { RedisService } from "./redis.service";
import { UserService } from "./user.service";

const SYSTEM: Actor = { type: "system" };
const PROOF_REF_RE = /^[\p{L}\p{N} .,:/#№_-]{1,200}$/u;

function refuse(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(409, "ramp_order_state", message, details);
}

/** How a refund_bank that payout_clearing already owes reads in the order's history. */
const AGAIN = {
  returned: " (after a bank return)",
  reinstated: " (reinstated by a won dispute)",
} as const;

/** Every posting that moves an on-ramp's bank refund on payout_clearing (−: owed by bank). */
const BANK_REFUND_KINDS: readonly RampOrderKind[] = [
  "onramp.refund_queued",
  "onramp.refund_cancelled",
  "onramp.refund_reinstated",
  "refund.paid_bank",
  "refund.returned_bank",
];

/** A chargeback stops a bank refund — but a dispute won after refund_cancel owes it again (C19). */
function chargebackOpen(order: RampOrderEntity, posted: ReadonlySet<string>): boolean {
  const cb = order.details?.chargeback as { state?: unknown } | null | undefined;
  if (!cb) return false;
  return !(cb.state === "won" && posted.has("onramp.refund_reinstated"));
}

/**
 * The bank rail as the rest of the ramp sees it (SPEC §9.4, §10): the RampBankRailPort's
 * implementation (bound when the client-money account is configured) — destinations from the
 * accounts, and the answers S4's actions need for bank cash-outs (`reverse`, `retry` into
 * `payout_queued` / `payout_sent`) — plus S6's order actions: `ramp.order.refund_bank` (an on-ramp
 * the acquirer cannot refund → a bank refund, M1 #12), `ramp.order.bank_unpaid` (statements prove a
 * submitted payout never left → requeue or reverse, #5 M7), the account proofs
 * `ramp.bank_account.verify|unblock`, and the aging of `payout_sent`.
 */
@Injectable()
export class RampBankRail implements RampBankRailImpl, OnModuleInit {
  private readonly logger = new Logger(RampBankRail.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly port: RampBankRailPort,
    private readonly accounts: RampBankAccountsService,
    private readonly batches: RampBankBatchesService,
    private readonly store: RampOrderStore,
    private readonly journal: RampJournalService,
    private readonly disputes: RampDisputesService,
    private readonly compensation: RampCompensationService,
    private readonly release: RampReleaseGuard,
    private readonly actions: RampActionsService,
    private readonly fulfilment: RampFulfilmentService,
    private readonly gates: RampGatesService,
    private readonly approvals: AdminApprovalService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    @Inject(RAMP_PROVIDER) private readonly provider: RampProvider,
    private readonly users: UserService,
  ) {}

  onModuleInit(): void {
    if (this.accounts.configured) this.port.bind(this);
    this.registerOrderActions();
    this.registerAccountActions();
  }

  // ───────────────────────────────────────────── the port ───────────────────────────────────

  validateDestination(
    userId: string,
    bankAccountId: string,
    amount: bigint,
    opts?: { orderId?: string | null },
  ): Promise<RampBankDestination> {
    return this.accounts.validateDestination(userId, bankAccountId, amount, opts);
  }

  describe(bankAccountId: string): Promise<RampBankDestination | null> {
    return this.accounts.describe(bankAccountId);
  }

  /**
   * `reverse` of a bank cash-out (and a retry into `reversing`): never while a batch holds it, never
   * after a matched debit without its return. A MATCHED RETURN (SPEC §4.2) proves the payment came
   * back whatever batch the order still names (C4: returned before the order left its batch).
   */
  async reverseProblem(order: RampOrderEntity): Promise<string | null> {
    if (order.payoutRail !== "bank") return "not a bank cash-out";
    const items = await this.dataSource
      .getRepository(RampPayoutBatchItemEntity)
      .find({ where: { orderId: order.id }, order: { createdAt: "DESC" } });
    if (items.some((i) => i.status === "included")) return "the order is in a live payout batch";
    const posted = await this.journal.postedKinds(this.dataSource.manager, order.id);
    const returned = posted.has("offramp.returned_bank") && items[0]?.status === "returned";
    if (order.payoutBatchId && !returned)
      return `the order is in payout batch ${order.payoutBatchId}: cancel or void it, or prove it unpaid (bank_unpaid)`;
    if (posted.has("offramp.paid_bank") && !posted.has("offramp.returned_bank"))
      return "a statement debit paid this order";
    return null;
  }

  /** `retry` into a bank status resumes waiting (nothing is sent by it): its own conditions only. */
  async retryProblem(
    order: RampOrderEntity,
    target: "payout_queued" | "payout_sent",
  ): Promise<string | null> {
    const from = typeof order.details?.reviewFrom === "string" ? order.details.reviewFrom : null;
    if (from !== target) return `the order left ${from ?? "an unknown status"}, not ${target}`;
    const posted = await this.journal.postedKinds(this.dataSource.manager, order.id);
    if (target === "payout_sent") {
      const item = await this.liveItem(order.id);
      if (!item || item.batch.status !== "submitted" || order.payoutBatchId !== item.batchId)
        return "the order is not in a submitted batch";
      if (await this.paidByStatement(order, posted)) return "a statement debit already paid it";
      return null;
    }
    if (order.payoutBatchId) return "the order is still in a payout batch";
    if (order.direction === "offramp" && !posted.has("offramp.burned"))
      return "the burn is not recorded";
    if (order.direction === "onramp" && !posted.has("onramp.refund_queued"))
      return "no bank refund is queued for this order";
    if (await this.release.isFrozen(order.userId)) return "the account is frozen";
    if (await this.release.isHeld(order)) return "a compliance review holds this order";
    // C5: a suspended account's payout never queues again (the draft would only send it back).
    if ((await this.users.findById(order.userId))?.status !== "active")
      return "the account is not active";
    if (!order.bankAccountId) return "the order has no bank account";
    try {
      if (order.direction === "offramp")
        await this.accounts.validateDestination(
          order.userId,
          order.bankAccountId,
          order.fiatAmount,
          {
            orderId: order.id,
          },
        );
      else await this.requireRefundAccount(order.userId, order.bankAccountId);
    } catch (err) {
      return `the bank account cannot take it: ${(err as Error).message}`;
    }
    return null;
  }

  private async liveItem(
    orderId: string,
  ): Promise<(RampPayoutBatchItemEntity & { batch: RampPayoutBatchEntity }) | null> {
    const item = await this.dataSource
      .getRepository(RampPayoutBatchItemEntity)
      .findOne({ where: { orderId, status: "included" } });
    if (!item) return null;
    const batch = await this.dataSource
      .getRepository(RampPayoutBatchEntity)
      .findOneByOrFail({ id: item.batchId });
    return Object.assign(item, { batch });
  }

  /**
   * A statement debit paid the order: an off-ramp's payout, or an on-ramp's bank refund not returned
   * since (S8: a returned refund is owed again and may be paid once more).
   */
  private async paidByStatement(order: RampOrderEntity, posted: Set<string>): Promise<boolean> {
    if (order.direction === "offramp") return posted.has("offramp.paid_bank");
    if (!posted.has("refund.paid_bank")) return false;
    const m = this.dataSource.manager;
    return (
      (await this.journal.postedCount(m, order.id, "refund.paid_bank")) >
      (await this.journal.postedCount(m, order.id, "refund.returned_bank"))
    );
  }

  /** An active, proved account of `userId` at a bank not blocked (a bank refund's destination). */
  private async requireRefundAccount(
    userId: string,
    accountId: string,
  ): Promise<RampBankAccountEntity> {
    const account = await this.accounts.accounts.findOne({ where: { id: accountId } });
    if (!account || account.userId !== userId)
      throw refuse("bankAccountId must name an account of the order's user");
    await this.accounts.promote(account);
    if (account.status !== "active")
      throw refuse(`the bank account is ${account.status}, not active`);
    if (this.config.rampBank.blockedBankCodes.includes(account.bankCode))
      throw refuse("payouts to this bank are blocked (RAMP_BLOCKED_BANK_CODES)");
    return account;
  }

  // ───────────────────────────────────────────── aging ──────────────────────────────────────

  /** `payout_sent` with no debit after RAMP_BANK_SETTLE_DAYS business days → needs_review(payout) (§4.1). */
  async ageSent(now = new Date()): Promise<number> {
    const days = this.config.rampBank.settleDays;
    const rows = await this.store.orders.find({
      where: { status: "payout_sent" },
      order: { statusChangedAt: "ASC" },
      take: 500,
    });
    let moved = 0;
    for (const o of rows) {
      if (this.gates.calendar.businessDaysBetween(o.statusChangedAt, now) <= days) continue;
      if (
        await this.store.review(
          o,
          ["payout_sent"],
          "payout",
          `no statement debit ${days} business days after the batch was submitted`,
          SYSTEM,
        )
      )
        moved += 1;
    }
    return moved;
  }

  // ───────────────────────────────────────────── refund_bank / bank_unpaid ──────────────────

  private registerOrderActions(): void {
    const subjectUser = async (id: string): Promise<string | null> =>
      (await this.store.find(id))?.userId ?? null;
    this.approvals.register<{ bankAccountId: string }, RampOrderSnapshot, unknown>({
      action: "ramp.order.refund_bank",
      subjectType: "ramp_order",
      requestRoles: ["ops"],
      params: (raw) => {
        const id = typeof raw.bankAccountId === "string" ? raw.bankAccountId.toLowerCase() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
          throw new ApiError(400, "validation_failed", "bankAccountId (uuid) is required");
        return { bankAccountId: id };
      },
      snapshot: (id) => this.actions.snapshot(id),
      validate: (p, _s, id) => this.validateRefundBank(id, p.bankAccountId),
      describe: (p, s) =>
        `refund ${moneyOf(s.capturedAmount ?? s.fiatAmount, s.fiatCurrency)} by bank transfer to bank account ${p.bankAccountId} of user ${s.userId} (on-ramp ${s.id}, ${s.status}${s.reviewStep ? `, review ${s.reviewStep}` : ""}; ${moneyOf(s.tokenAmount, s.instrument.id)} never minted)`,
      subjectUser,
      lockKey: () => null,
      execute: (p, s, ctx) =>
        this.executeRefundBank(ctx.subjectId, p.bankAccountId, s, {
          actor: ctx.actor,
          reason: ctx.reason,
          approvalId: ctx.approvalId,
        }),
    });
    this.approvals.register<{ then: "requeue" | "reverse" }, RampOrderSnapshot, unknown>({
      action: "ramp.order.bank_unpaid",
      subjectType: "ramp_order",
      requestRoles: ["ops"],
      params: (raw) => {
        if (raw.then !== "requeue" && raw.then !== "reverse")
          throw new ApiError(400, "validation_failed", "then must be requeue or reverse");
        return { then: raw.then };
      },
      snapshot: (id) => this.actions.snapshot(id),
      validate: (p, _s, id) => this.validateBankUnpaid(id, p.then).then(() => undefined),
      describe: (p, s) =>
        `${s.direction} ${s.id}: statements show no debit for its ${moneyOf(s.capturedAmount && s.direction === "onramp" ? s.capturedAmount : s.fiatAmount, s.fiatCurrency)} to ${destinationText(s)} of user ${s.userId} — ${p.then === "requeue" ? "queue that bank payment again" : `re-mint ${moneyOf(s.tokenAmount, s.instrument.id)} and credit it back to wallet ${s.partyId}`}`,
      subjectUser,
      lockKey: () => null,
      execute: (p, s, ctx) =>
        this.executeBankUnpaid(ctx.subjectId, p.then, s, {
          actor: ctx.actor,
          reason: ctx.reason,
          approvalId: ctx.approvalId,
        }),
    });
    this.approvals.register<Record<string, never>, RampOrderSnapshot, unknown>({
      action: "ramp.order.refund_cancel",
      subjectType: "ramp_order",
      requestRoles: ["ops"],
      snapshot: (id) => this.actions.snapshot(id),
      validate: (_p, _s, id) => this.refundCancelPlan(id).then(() => undefined),
      describe: (_p, s) =>
        `cancel the bank refund of ${moneyOf(s.capturedAmount ?? s.fiatAmount, s.fiatCurrency)} to ${destinationText(s)} for user ${s.userId} (on-ramp ${s.id}, charged back): onramp.refund_cancelled nets it against the chargeback receivable`,
      subjectUser,
      lockKey: () => null,
      execute: (_p, s, ctx) =>
        this.executeRefundCancel(ctx.subjectId, s, {
          actor: ctx.actor,
          reason: ctx.reason,
          approvalId: ctx.approvalId,
        }),
    });
  }

  /**
   * `refund_bank` (SPEC §4.2): an on-ramp in review whose capture the acquirer still shows whole and
   * unrefunded, whose mint never lands (or was never made), not frozen, no compliance hold, no
   * chargeback; the account an ACTIVE, proved account of the same user. C19: a dispute won after
   * `refund_cancel` owes the refund again — it is queued too; every other chargeback stays refused.
   */
  async validateRefundBank(orderId: string, bankAccountId: string): Promise<void> {
    await this.refundBankPlan(orderId, bankAccountId);
  }

  /**
   * The checks of `refund_bank`, and which kind it is: a first bank refund, or one payout_clearing
   * already owes again — the bank returned it (S8: `refund.returned_bank`), or a dispute won after
   * `refund_cancel` reinstated it (C19: `onramp.refund_reinstated`, the acquirer re-read showing the
   * dispute still won). Then nothing new is booked and nothing is refunded at the acquirer.
   */
  private async refundBankPlan(
    orderId: string,
    bankAccountId: string,
  ): Promise<{ again: "returned" | "reinstated" | null }> {
    const order = await this.store.find(orderId);
    if (!order) throw new ApiError(404, "not_found", "order not found");
    if (order.direction !== "onramp") throw refuse("only an on-ramp is refunded by bank transfer");
    if (order.status !== "needs_review")
      throw refuse(`the order is ${order.status}, not needs_review`);
    if (!this.accounts.configured)
      throw new ApiError(409, "ramp_rail_unavailable", "bank payouts are not configured", {
        rail: "bank",
      });
    const m = this.dataSource.manager;
    const posted = await this.journal.postedKinds(m, order.id);
    const from = order.reviewStep === "refund" ? order.details?.reviewFrom : null;
    const again =
      from === "refunded" && posted.has("refund.returned_bank")
        ? "returned"
        : from === "chargeback" && posted.has("onramp.refund_reinstated")
          ? "reinstated"
          : null;
    if (again) {
      const owed = -(await this.journal.postedAmount(
        m,
        order.id,
        BANK_REFUND_KINDS,
        "payout_clearing",
      ));
      if (owed !== bankAmountOf(order)) throw refuse(`no ${again} bank refund is owed`);
      if (chargebackOpen(order, posted)) throw refuse("a chargeback is open on this order");
      if (again === "reinstated") await this.requireDisputeWon(order);
      if (await this.release.isFrozen(order.userId)) throw refuse("the account is frozen");
      if (await this.release.isHeld(order)) throw refuse("a compliance review holds this order");
      await this.requireRefundAccount(order.userId, bankAccountId);
      return { again };
    }
    if (order.capturedAmount === null || !order.providerPaymentId)
      throw refuse("the order has no capture");
    if (order.refundedAmount > 0n)
      throw refuse("the acquirer refunded part of it; refund the rest there");
    if (order.details?.chargeback) throw refuse("a chargeback is open on this order");
    const mint = await this.disputes.mintState(order);
    if (mint === "recorded" || mint === "unresolved")
      throw refuse(`the mint is ${mint}; a refund needs a mint that never lands`);
    if (await this.release.isFrozen(order.userId)) throw refuse("the account is frozen");
    if (await this.release.isHeld(order)) throw refuse("a compliance review holds this order");
    const released = RAMP_IP_RELEASES.find((k) => posted.has(k));
    if (released) throw refuse(`the capture was already released (${released})`);
    let payment;
    try {
      payment = await this.provider.getPayment(order.providerPaymentId);
    } catch (err) {
      throw refuse(`the acquirer could not be asked: ${(err as Error).message}`);
    }
    if (
      payment.status === "chargeback" ||
      payment.capturedAmount !== order.capturedAmount ||
      payment.refundedAmount !== 0n
    )
      throw refuse("the acquirer does not show this capture whole and unrefunded");
    await this.requireRefundAccount(order.userId, bankAccountId);
    return { again: null };
  }

  /** C19: the acquirer still shows the dispute won (I2: re-read; unreadable → refused, I7). */
  private async requireDisputeWon(order: RampOrderEntity): Promise<void> {
    if (!order.providerPaymentId) throw refuse("the order has no capture");
    let payment;
    try {
      payment = await this.provider.getPayment(order.providerPaymentId);
    } catch (err) {
      throw refuse(`the acquirer could not be asked: ${(err as Error).message}`);
    }
    if (payment.status !== "chargeback_reversed")
      throw refuse(`the acquirer shows the payment ${payment.status}, not the dispute won`);
  }

  private async executeRefundBank(
    orderId: string,
    bankAccountId: string,
    snapshot: RampOrderSnapshot,
    ctx: { actor: AdminActor; reason: string; approvalId: string },
  ): Promise<unknown> {
    await this.underOrderLock(orderId, snapshot, ctx.actor, async (order) => {
      const { again } = await this.refundBankPlan(orderId, bankAccountId);
      const won = await this.store.transition(
        order,
        ["needs_review"],
        "payout_queued",
        // A re-send leaves the returned payment's batch for a new one (S8).
        {
          bankAccountId,
          attempts: 0,
          lastError: null,
          ...(again ? { payoutBatchId: null } : {}),
        },
        {
          actor: ctx.actor,
          detail: `refund_bank${again ? AGAIN[again] : ""}: ${ctx.reason}`,
          expect: again
            ? {
                reviewStep: order.reviewStep,
                bankAccountId: order.bankAccountId,
                payoutBatchId: order.payoutBatchId,
              }
            : { reviewStep: order.reviewStep, bankAccountId: null, payoutBatchId: null },
          details: {
            refundRail: "bank",
            bankRefund: { bankAccountId, approvalId: ctx.approvalId, at: new Date().toISOString() },
          },
          within: async (m, fresh) => {
            if (!again) await this.journal.post(m, fresh, "onramp.refund_queued");
            await this.auditAction(m, fresh, "refund_bank", ctx);
          },
        },
      );
      if (!won) throw refuse("the order changed meanwhile; reload it");
    });
    return this.store.toAdminApi((await this.store.find(orderId))!);
  }

  /**
   * `bank_unpaid {then}` (SPEC §4.2, #5, M7): an order of a SUBMITTED batch, in payout review;
   * confirmed statements cover every business day from the export to + RAMP_BANK_SETTLE_DAYS with
   * no debit and no return quoting it (also inside a batch-booked entry), none naming its batch and
   * no unexplained debit as large as it (C6: `unpaidProof`). `reverse` only for an off-ramp with a
   * recorded burn.
   */
  async validateBankUnpaid(
    orderId: string,
    then: "requeue" | "reverse",
  ): Promise<{
    order: RampOrderEntity;
    item: RampPayoutBatchItemEntity & { batch: RampPayoutBatchEntity };
  }> {
    const order = await this.store.find(orderId);
    if (!order) throw new ApiError(404, "not_found", "order not found");
    if (order.status !== "needs_review" || order.reviewStep !== "payout")
      throw refuse(
        `the order is ${order.status}${order.reviewStep ? ` (${order.reviewStep})` : ""}, not in payout review`,
      );
    const item = await this.liveItem(order.id);
    if (!item || item.batch.status !== "submitted" || !item.batch.submittedAt)
      throw refuse("the order is not in a submitted payout batch");
    const posted = await this.journal.postedKinds(this.dataSource.manager, order.id);
    if (await this.paidByStatement(order, posted)) throw refuse("a statement debit paid it");
    if (then === "reverse") {
      if (order.direction !== "offramp")
        throw refuse("only an off-ramp is reversed; requeue the refund");
      const burn = order.burnCommandId
        ? await this.compensation.effectiveRow(order.burnCommandId)
        : null;
      if (burn?.status !== "recorded") throw refuse("the burn is not recorded");
      if (order.remintCommandId) throw refuse("a re-mint already exists for this order");
    }
    // C6: from the EXPORT (the bank may execute the file before `submitted` is recorded); the
    // file is named by its id or the bank's reference; an unexplained debit of P or more blocks.
    const problem = await this.batches.unpaidProof({
      from: item.batch.exportedAt ?? item.batch.submittedAt,
      references: [order.payoutReference],
      documentNos: [item.documentNo],
      accountKeys: [`${item.ibanHashKid}:${item.ibanHash}`],
      batch: {
        id: item.batchId,
        total: item.batch.totalAmount,
        bankReference: item.batch.bankReference,
      },
      minAmount: item.amount,
      credits: true,
    });
    if (problem) throw refuse(`not proven unpaid: ${problem}`);
    return { order, item };
  }

  private async executeBankUnpaid(
    orderId: string,
    then: "requeue" | "reverse",
    snapshot: RampOrderSnapshot,
    ctx: { actor: AdminActor; reason: string; approvalId: string },
  ): Promise<unknown> {
    await this.underOrderLock(orderId, snapshot, ctx.actor, async (order) => {
      const { item } = await this.validateBankUnpaid(orderId, then);
      const won = await this.store.transition(
        order,
        ["needs_review"],
        then === "requeue" ? "payout_queued" : "reversing",
        { payoutBatchId: null, attempts: 0, lastError: null },
        {
          actor: ctx.actor,
          detail: `bank_unpaid (${then}): ${ctx.reason}`,
          expect: { reviewStep: "payout", payoutBatchId: item.batchId },
          details: { unpaidBatchId: item.batchId },
          within: async (m, fresh) => {
            const items = m.getRepository(RampPayoutBatchItemEntity);
            await items.update(
              { batchId: item.batchId, orderId, status: "included" },
              { status: "unpaid" },
            );
            if ((await items.count({ where: { batchId: item.batchId, status: "included" } })) === 0)
              await m
                .getRepository(RampPayoutBatchEntity)
                .update(
                  { id: item.batchId, status: "submitted" },
                  { status: "settled", settledAt: new Date() },
                );
            await this.auditAction(m, fresh, "bank_unpaid", ctx, { then, batchId: item.batchId });
          },
        },
      );
      if (!won) throw refuse("the order changed meanwhile; reload it");
    });
    return this.store.toAdminApi((await this.store.find(orderId))!);
  }

  /**
   * `refund_cancel` (C19): a chargeback (or the acquirer's own reversal) gave an on-ramp's money
   * back while its bank refund was still owed — `onramp.refund_queued` owes it by bank and
   * `onramp.chargeback_after_refund` holds it receivable. Allowed only when the bank never got the
   * refund (no batch, or a DRAFT batch it leaves) or gave it back (a confirmed statement's return,
   * a voided batch, a batch proven unpaid): ONE posting `onramp.refund_cancelled` nets the two and
   * the order closes as `chargeback`. Refused while the refund sits in an approved or exported
   * batch with no bank return yet, while the bank has it, and once a statement shows the bank paid
   * it — then the receivable stands. A partial dispute is settled by hand.
   */
  async refundCancelPlan(
    orderId: string,
  ): Promise<{ order: RampOrderEntity; owed: bigint; draftBatchId: string | null }> {
    const order = await this.store.find(orderId);
    if (!order) throw new ApiError(404, "not_found", "order not found");
    if (order.direction !== "onramp") throw refuse("only an on-ramp's bank refund is cancelled");
    const chargeback = order.details?.chargeback as { state?: unknown } | null | undefined;
    if (chargeback?.state !== "charged_back")
      throw refuse("no chargeback or acquirer reversal returned this payment");
    const m = this.dataSource.manager;
    const posted = await this.journal.postedKinds(m, order.id);
    if (!posted.has("onramp.refund_queued"))
      throw refuse("no bank refund is queued for this order");
    if (posted.has("onramp.refund_cancelled")) throw refuse("the bank refund is already cancelled");
    if (await this.paidByStatement(order, posted))
      throw refuse(
        "a statement debit shows the bank paid this refund: the chargeback receivable stands (the user got the money twice; recover it)",
      );
    const item = await this.liveItem(order.id);
    if (order.status === "payout_sent" || item?.batch.status === "submitted")
      throw refuse(
        `the bank has this refund (payout batch ${item?.batchId ?? order.payoutBatchId ?? "?"} submitted): wait for its debit or return, or prove it unpaid (bank_unpaid)`,
      );
    if (item && item.batch.status !== "draft")
      throw refuse(
        `the bank refund sits in ${item.batch.status} payout batch ${item.batchId} with no bank return yet: cancel or void the batch first`,
      );
    if (order.status !== "needs_review")
      throw refuse(`the order is ${order.status}, not needs_review`);
    const owed = -(await this.journal.postedAmount(
      m,
      order.id,
      ["onramp.refund_queued", "refund.paid_bank", "refund.returned_bank"],
      "payout_clearing",
    ));
    if (owed <= 0n) throw refuse("no bank refund is owed");
    const receivable = await this.journal.postedAmount(
      m,
      order.id,
      ["onramp.chargeback_after_refund", "onramp.chargeback_reversed"],
      "chargeback_receivable",
    );
    if (receivable !== owed)
      throw refuse(
        `a partial chargeback (${formatAmount(receivable)} receivable, ${formatAmount(owed)} owed) is settled by hand`,
      );
    return { order, owed, draftBatchId: item ? item.batchId : null };
  }

  private async executeRefundCancel(
    orderId: string,
    snapshot: RampOrderSnapshot,
    ctx: { actor: AdminActor; reason: string; approvalId: string },
  ): Promise<unknown> {
    await this.underOrderLock(orderId, snapshot, ctx.actor, async () => {
      const { order, owed, draftBatchId } = await this.refundCancelPlan(orderId);
      await this.dataSource.transaction(async (m) => {
        if (
          draftBatchId &&
          !(await this.batches.removeFromDraft(
            m,
            draftBatchId,
            order.id,
            ctx.actor,
            "a chargeback returned the payment; its bank refund is cancelled",
          ))
        )
          throw refuse(`payout batch ${draftBatchId} is no longer a draft; reload it`);
        const won = await this.store.transition(
          order,
          ["needs_review"],
          "chargeback",
          { payoutBatchId: null, attempts: 0, lastError: null },
          {
            actor: ctx.actor,
            manager: m,
            detail: `refund_cancel: ${ctx.reason}`,
            expect: { reviewStep: order.reviewStep, payoutBatchId: order.payoutBatchId },
            details: {
              refundCancelled: {
                amount: formatAmount(owed),
                approvalId: ctx.approvalId,
                at: new Date().toISOString(),
                ...(draftBatchId ? { leftBatchId: draftBatchId } : {}),
              },
            },
            within: async (mm, fresh) => {
              await this.journal.post(mm, fresh, "onramp.refund_cancelled", owed);
              await this.auditAction(mm, fresh, "refund_cancel", ctx, {
                amount: formatAmount(owed),
                ...(draftBatchId ? { leftBatchId: draftBatchId } : {}),
              });
            },
          },
        );
        if (!won) throw refuse("the order changed meanwhile; reload it");
      });
    });
    return this.store.toAdminApi((await this.store.find(orderId))!);
  }

  /** Under `lock:ramp:<id>` with the requested snapshot's version (I6, H1); never the operator's own order. */
  private async underOrderLock(
    orderId: string,
    snapshot: RampOrderSnapshot,
    actor: AdminActor,
    fn: (order: RampOrderEntity) => Promise<void>,
  ): Promise<void> {
    const lock = await this.redis.acquireLock(`lock:ramp:${orderId}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired) throw refuse("the order is being processed; try again in a moment");
    try {
      const order = await this.store.find(orderId);
      if (!order) throw new ApiError(404, "not_found", "order not found");
      if (order.userId === actor.userId)
        throw new ApiError(403, "forbidden", "an operator cannot act on their own order");
      if (order.version !== snapshot.version)
        throw refuse("the order changed since the action was requested", {
          expectedVersion: snapshot.version,
          version: order.version,
        });
      await fn(order);
    } finally {
      await lock.release();
    }
    await this.fulfilment.advance(orderId);
  }

  private async auditAction(
    m: Parameters<AuditService["record"]>[1],
    order: RampOrderEntity,
    action: string,
    ctx: { actor: AdminActor; reason: string; approvalId: string },
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.record(
      {
        actorType: "admin",
        actorUserId: ctx.actor.userId,
        actorSessionId: ctx.actor.sessionId,
        action: "ramp.admin_action",
        subjectType: "ramp_order",
        subjectId: order.id,
        metadata: {
          action,
          reason: ctx.reason,
          approvalId: ctx.approvalId,
          to: order.status,
          userId: order.userId,
          // F2/F8: what the action moved, and for whom.
          figures: orderFigures(order),
          ...extra,
        },
        ip: ctx.actor.ip,
      },
      m,
    );
  }

  // ───────────────────────────────────────────── account proofs (four-eyes) ─────────────────

  private registerAccountActions(): void {
    const snapshot = async (id: string): Promise<Record<string, unknown>> => {
      const a = await this.accounts.accounts.findOne({ where: { id } });
      if (!a) throw new ApiError(404, "not_found", "bank account not found");
      return {
        id: a.id,
        userId: a.userId,
        status: a.status,
        proof: a.proof,
        bankCode: a.bankCode,
        ibanLast4: a.ibanLast4,
      };
    };
    const subjectUser = async (id: string): Promise<string | null> =>
      (await this.accounts.accounts.findOne({ where: { id } }))?.userId ?? null;
    this.approvals.register<{ proofRef: string }, Record<string, unknown>, unknown>({
      action: "ramp.bank_account.verify",
      subjectType: "ramp_bank_account",
      requestRoles: ["ops"],
      params: (raw) => {
        const proofRef = typeof raw.proofRef === "string" ? raw.proofRef.trim() : "";
        if (!PROOF_REF_RE.test(proofRef))
          throw new ApiError(
            400,
            "validation_failed",
            "proofRef (the evidence's reference, ≤ 200 characters) is required",
          );
        return { proofRef };
      },
      snapshot,
      validate: async (_p, s) => {
        if (!this.config.rampBank.manualProof)
          throw new ApiError(
            409,
            "bank_account_invalid",
            "manual proofs are not enabled (RAMP_BANK_MANUAL_PROOF)",
          );
        if (s.status !== "cooling_off" && s.status !== "pending_proof")
          throw new ApiError(409, "bank_account_invalid", `the account is ${String(s.status)}`);
      },
      describe: (p, s) =>
        `prove bank account …${String(s.ibanLast4)} (${String(s.bankCode)}) by hand: ${p.proofRef}`,
      subjectUser,
      execute: async (p, _s, ctx) => {
        const res = await this.accounts.accounts.update(
          { id: ctx.subjectId, status: "pending_proof" },
          { proof: "manual", proofRef: p.proofRef, verifiedAt: new Date() },
        );
        // Still cooling off: the proof is recorded now, the account turns active when the period ends.
        if (!res.affected)
          await this.accounts.accounts.update(
            { id: ctx.subjectId, status: "cooling_off" },
            { proof: "manual", proofRef: p.proofRef, verifiedAt: new Date() },
          );
        await this.auditAccount("ramp.bank_account.verified", ctx.subjectId, ctx.actor, {
          approvalId: ctx.approvalId,
          proofRef: p.proofRef,
        });
        const row = await this.accounts.promote(
          await this.accounts.accounts.findOneByOrFail({ id: ctx.subjectId }),
        );
        return this.accounts.toAdminApi(row);
      },
    });
    this.approvals.register<Record<string, never>, Record<string, unknown>, unknown>({
      action: "ramp.bank_account.unblock",
      subjectType: "ramp_bank_account",
      requestRoles: ["ops"],
      snapshot,
      validate: async (_p, s) => {
        if (s.status !== "blocked")
          throw new ApiError(
            409,
            "bank_account_invalid",
            `the account is ${String(s.status)}, not blocked`,
          );
      },
      describe: (_p, s) => `unblock bank account …${String(s.ibanLast4)}: it must be proved again`,
      subjectUser,
      execute: async (_p, _s, ctx) => {
        const res = await this.accounts.accounts.update(
          { id: ctx.subjectId, status: "blocked" },
          {
            status: "pending_proof",
            proof: null,
            proofRef: null,
            verifiedAt: null,
            blockedReason: null,
          },
        );
        if (!res.affected)
          throw new ApiError(409, "bank_account_invalid", "the account changed meanwhile");
        await this.auditAccount("ramp.bank_account.unblocked", ctx.subjectId, ctx.actor, {
          approvalId: ctx.approvalId,
        });
        const row = await this.accounts.promote(
          await this.accounts.accounts.findOneByOrFail({ id: ctx.subjectId }),
        );
        return this.accounts.toAdminApi(row);
      },
    });
  }

  private async auditAccount(
    action: "ramp.bank_account.verified" | "ramp.bank_account.unblocked",
    id: string,
    actor: AdminActor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action,
      subjectType: "ramp_bank_account",
      subjectId: id,
      metadata,
      ip: actor.ip,
    });
  }
}
