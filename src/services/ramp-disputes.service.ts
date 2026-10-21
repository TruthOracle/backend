import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, type EntityManager, Repository } from "typeorm";

import { DepositCreditEntity } from "../entities/deposit-credit.entity";
import { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import { RampPayoutBatchEntity } from "../entities/ramp-payout-batch.entity";
import { isDefinitiveNo, type TokenCommandStatus } from "../entities/token-command.entity";
import type { Actor, RampOrderStatus, RampPayment } from "../types";
import { formatAmount, parseAmount } from "../util/money";
import { AuditService } from "./audit.service";
import { mintCreditCommandId } from "./deposit.service";
import { RampCardCashoutService } from "./ramp-card-cashout.service";
import { RampCompensationService } from "./ramp-compensation.service";
import { RampJournalService, type RampOrderKind } from "./ramp-journal.service";
import { RampOrderStore } from "./ramp-order-store.service";
import { SentryService } from "./sentry.service";
import { TokenCommandService } from "./token-command.service";
import { UserService } from "./user.service";

const SYSTEM: Actor = { type: "system" };

/**
 * The holds that lift by themselves (a freeze, a compliance hold, the payout gate) — the bank
 * batches' `isSelfLiftingHold`, kept here because importing that module would close a module
 * cycle through the fulfilment service. A chargeback stop never hides behind one (C5).
 */
const SELF_LIFTING_HOLDS: ReadonlySet<string> = new Set(["frozen", "compliance", "payout_gate"]);

/**
 * `refunded_amount` the acquirer's refund total implies (C20, H4): minus our own cash-out parts
 * it executed but we have not recorded yet (they are ours, recorded by their cash-out); kept
 * only when it moves the order's figure up and stays within the capture.
 */
export function acquirerRefunded(input: {
  acquirerTotal: bigint;
  pendingParts: bigint;
  recorded: bigint;
  captured: bigint;
}): bigint | null {
  const theirs = input.acquirerTotal - input.pendingParts;
  return theirs > input.recorded && theirs <= input.captured ? theirs : null;
}

/** Where an on-ramp's mint stands: never created, may land, never lands, or landed (a mismatch landed something). */
export type RampMintState = "none" | "unresolved" | "no" | "recorded";

export function mintStateOf(
  mintCommandId: string | null,
  row: { status: TokenCommandStatus } | null,
): RampMintState {
  if (!mintCommandId) return "none";
  // The row is written in the CAS that records the id; a missing one is treated as "may land".
  if (!row) return "unresolved";
  if (row.status === "recorded" || row.status === "mismatch") return "recorded";
  return isDefinitiveNo(row.status) ? "no" : "unresolved";
}

/**
 * What a chargeback or an acquirer-side reversal took back, for the books (S8): the acquirer's
 * reported amount (else all it could reach), never more than the capture left unrefunded — a card
 * cash-out's refund parts already went back to the card, so a dispute cannot reach them (C −
 * refunded). After the order's own refund (`afterRefund`) the issuer disputes the original: up to
 * C. `capped` = the acquirer reported more than that (an anomaly the operator reconciles).
 */
export function disputedAmount(input: {
  captured: bigint;
  refunded: bigint;
  reported: bigint | null;
  afterRefund: boolean;
}): { amount: bigint; capped: boolean } {
  const reach = input.afterRefund ? input.captured : input.captured - input.refunded;
  const cap = reach > 0n ? reach : 0n;
  if (input.reported === null) return { amount: cap, capped: false };
  if (input.reported > cap) return { amount: cap, capped: true };
  return { amount: input.reported > 0n ? input.reported : 0n, capped: false };
}

/** The kinds that book a chargeback receivable (a won dispute clears what they booked). */
const RECEIVABLE_KINDS: readonly RampOrderKind[] = [
  "onramp.chargeback_minted",
  "onramp.chargeback_after_refund",
];

/** Off-ramps a chargeback on the account stops (M2, E-D3): before MarkPaid they hold, after it they go to review. */
const HOLDABLE: readonly RampOrderStatus[] = ["awaiting_withdrawal", "withdrawing"];
const STOPPABLE: readonly RampOrderStatus[] = ["burning", "paying_out", "payout_queued"];

/** `details.chargeback` (SPEC §3.1). */
interface ChargebackDetail {
  state: "pending" | "charged_back" | "won";
  kind: "chargeback" | "psp_reversal";
  amount: string;
  at: string;
}

/**
 * Chargebacks and acquirer-side reversals (SPEC §4.1 #10, H4). The ORDER effect depends on where
 * the mint stands: nothing minted → `chargeback` releasing issuance_pending; a mint that may still
 * land → `details.chargeback = pending`, never credited, resolved when the mint resolves; minted →
 * `chargeback` + a receivable (and the four-eyes `burn_uncredited` while it was never credited); a
 * refunded order → `chargeback_after_refund`; a refund in flight stays. The SIDE effects — suspend
 * the account, block the card, stop every open off-ramp of the account, audit, alert — run for
 * every verified event in any status and never throw.
 */
@Injectable()
export class RampDisputesService {
  private readonly logger = new Logger(RampDisputesService.name);

  constructor(
    private readonly store: RampOrderStore,
    private readonly journal: RampJournalService,
    private readonly tokenCommands: TokenCommandService,
    private readonly users: UserService,
    @InjectRepository(RampPaymentMethodEntity)
    private readonly methods: Repository<RampPaymentMethodEntity>,
    @InjectRepository(DepositCreditEntity)
    private readonly credits: Repository<DepositCreditEntity>,
    private readonly audit: AuditService,
    private readonly sentry: SentryService,
    private readonly compensation: RampCompensationService,
    private readonly cashout: RampCardCashoutService,
  ) {}

  async mintState(order: RampOrderEntity): Promise<RampMintState> {
    // A compensated mismatch reads as what it was meant to be (RampCompensationService).
    const row = order.mintCommandId
      ? await this.compensation.effectiveRow(order.mintCommandId)
      : null;
    return mintStateOf(order.mintCommandId, row);
  }

  /** Was the mint's Deposit ever submitted (its write-ahead row exists and did not fail)? */
  async depositSubmitted(order: RampOrderEntity): Promise<boolean> {
    if (!order.mintCommandId) return false;
    const row = await this.credits.findOne({
      where: { commandId: mintCreditCommandId(order.mintCommandId) },
    });
    return Boolean(row && row.status !== "failed");
  }

  /** `payment.status = chargeback`. The event that carried it re-runs the side effects even when nothing changed. */
  async chargeback(
    order: RampOrderEntity,
    payment: RampPayment,
    trigger: "event" | "read",
  ): Promise<void> {
    await this.withSideEffects(order, "chargeback", trigger, () =>
      this.chargebackEffect(order, payment, "chargeback"),
    );
  }

  /**
   * The acquirer returned money we did not ask it to (H4): a refund beyond what the order explains,
   * or a captured payment it now reports failed.
   */
  async pspReversal(
    order: RampOrderEntity,
    payment: RampPayment,
    trigger: "event" | "read",
  ): Promise<void> {
    await this.withSideEffects(order, "psp_reversal", trigger, async () => {
      if (["refunding", "refunded", "chargeback"].includes(order.status)) return false;
      if (order.status === "paid" || order.status === "awaiting_payment")
        return this.store.review(
          order,
          [order.status],
          "payment",
          "the acquirer refunded the payment itself",
          SYSTEM,
          await this.capturePatch(order, payment),
          { within: (m, fresh) => this.journal.bookCapture(m, fresh, payment.fee) },
        );
      // C19: the acquirer gave the money back while our bank refund is queued or sent.
      if (order.status === "payout_queued" || order.status === "payout_sent")
        return this.bankRefundStopped(order, payment, "psp_reversal");
      const state = await this.mintState(order);
      if (state === "none" || state === "no") {
        // In review or closed with nothing minted: the operator's `fail` books `onramp.voided`.
        // Already recorded (a later poll of the same reversal): nothing changes, no side effects again.
        const patch = await this.capturePatch(order, payment);
        if (
          Object.keys(patch).length === 0 &&
          (await this.journal.posted(this.store.orders.manager, order.id, "onramp.captured"))
        )
          return false;
        return this.store.bump(order, patch, {
          actor: SYSTEM,
          within: (m, fresh) => this.journal.bookCapture(m, fresh, payment.fee),
        });
      }
      return this.chargebackEffect(order, payment, "psp_reversal");
    });
  }

  /**
   * The dispute was won: the receivable the chargeback booked comes back to provider_clearing
   * (once). C19: a bank refund cancelled against it (`onramp.refund_cancelled`) already cleared
   * it — the issuer takes the chargeback back from the user, who is owed the refund again
   * (`refundReinstated`). Once either is booked, a repeat (an event retry, the post-close poll)
   * changes nothing.
   */
  async disputeWon(order: RampOrderEntity): Promise<void> {
    const manager = this.store.orders.manager;
    const kinds = await this.journal.postedKinds(manager, order.id);
    if (kinds.has("onramp.chargeback_reversed") || kinds.has("onramp.refund_reinstated")) return;
    if (kinds.has("onramp.refund_cancelled")) return this.refundReinstated(order);
    const receivable = kinds.has("onramp.uncredited_burned")
      ? 0n
      : await this.journal.postedAmount(
          manager,
          order.id,
          RECEIVABLE_KINDS,
          "chargeback_receivable",
        );
    if (receivable <= 0n) {
      // Nothing receivable (nothing was minted, N was already burned, or nothing was left to
      // dispute): the books need a person.
      this.sentry.captureMessage("ramp dispute won without a receivable to clear", "error", {
        orderId: order.id,
        status: order.status,
      });
      return;
    }
    const won = await this.store.bump(
      order,
      {},
      {
        actor: SYSTEM,
        detail: "dispute won",
        details: { chargeback: { ...this.chargebackOf(order), state: "won" } },
        within: async (m, fresh) => {
          await this.journal.post(m, fresh, "onramp.chargeback_reversed", receivable);
        },
      },
    );
    if (!won) return;
    await this.audit.record({
      actorType: "system",
      action: "ramp.chargeback_reversed",
      subjectType: "ramp_order",
      subjectId: order.id,
      metadata: { userId: order.userId, fiatAmount: formatAmount(receivable) },
    });
    this.sentry.captureMessage("ramp dispute won: receivable cleared", "warning", {
      orderId: order.id,
    });
    // R1-2: N minted and never credited stays in the treasury, owed to a user who paid for it
    // after all — burn_uncredited is refused now; a person credits it (no product exit yet).
    if (
      order.direction === "onramp" &&
      !kinds.has("onramp.uncredited_burned") &&
      (await this.mintState(order)) === "recorded" &&
      !(await this.depositSubmitted(order))
    )
      this.sentry.captureMessage("ramp dispute won on an uncredited mint", "error", {
        orderId: order.id,
        burnRequested: order.details?.cbburnCommandId ? "true" : "false",
      });
  }

  /**
   * C19: a dispute won after `refund_cancel` — the user never got the cancelled bank refund and
   * now loses the chargeback too: ONE posting `onramp.refund_reinstated` owes it again (the
   * acquirer's money back on provider_clearing, owed by bank on payout_clearing) and the order
   * goes chargeback → needs_review(refund), where `refund_bank` (four-eyes) queues it. Anything
   * else (not closed as a chargeback, nothing cancelled) is a person's, paged.
   */
  private async refundReinstated(order: RampOrderEntity): Promise<void> {
    const owed = await this.journal.postedAmount(
      this.store.orders.manager,
      order.id,
      ["onramp.refund_cancelled"],
      "payout_clearing",
    );
    if (order.status !== "chargeback" || owed <= 0n) {
      this.sentry.captureMessage("ramp dispute won without a receivable to clear", "error", {
        orderId: order.id,
        status: order.status,
      });
      return;
    }
    const at = new Date().toISOString();
    const won = await this.store.review(
      order,
      ["chargeback"],
      "refund",
      "the dispute was won after its bank refund was cancelled: the refund is owed again",
      SYSTEM,
      {},
      {
        details: {
          chargeback: { ...this.chargebackOf(order), state: "won" },
          refundReinstated: { amount: formatAmount(owed), at },
        },
        within: async (m, fresh) => {
          await this.journal.post(m, fresh, "onramp.refund_reinstated", owed);
        },
      },
    );
    if (!won) return;
    await this.audit.record({
      actorType: "system",
      action: "ramp.refund_reinstated",
      subjectType: "ramp_order",
      subjectId: order.id,
      metadata: { userId: order.userId, fiatAmount: formatAmount(owed) },
    });
    this.sentry.captureMessage("ramp dispute won: cancelled bank refund owed again", "warning", {
      orderId: order.id,
    });
  }

  /**
   * A mint the order holds a pending chargeback for has resolved (the token sync's hook when it
   * is recorded, the mint step when it is definitive-no): → `chargeback` with the posting that
   * fits. Runs in `manager` when given (the sync transaction). False = nothing pending.
   */
  async resolvePending(
    order: RampOrderEntity,
    outcome: "recorded" | "no",
    opts: { manager?: EntityManager; alsoPost?: RampOrderKind } = {},
  ): Promise<boolean> {
    const pending = order.details?.chargeback as Partial<ChargebackDetail> | undefined;
    if (pending?.state !== "pending") return false;
    const kinds = await this.journal.postedKinds(
      opts.manager ?? this.store.orders.manager,
      order.id,
    );
    const kind: RampOrderKind =
      outcome === "recorded" ? "onramp.chargeback_minted" : this.releaseKind(kinds);
    // The amount the acquirer took, kept when the chargeback arrived (S8); a nil one books C.
    const disputed = typeof pending.amount === "string" ? parseAmount(pending.amount) : 0n;
    return this.store.transition(
      order,
      [order.status],
      "chargeback",
      {},
      {
        actor: SYSTEM,
        manager: opts.manager,
        detail: `chargeback after the mint resolved (${outcome})`,
        details: { chargeback: { ...pending, state: "charged_back" } },
        within: async (m, fresh) => {
          if (opts.alsoPost) await this.journal.post(m, fresh, opts.alsoPost);
          await this.journal.post(m, fresh, kind, disputed);
        },
      },
    );
  }

  /** The matrix by status and mint state; true when something changed. */
  private async chargebackEffect(
    order: RampOrderEntity,
    payment: RampPayment,
    kind: ChargebackDetail["kind"],
  ): Promise<boolean> {
    if (order.direction !== "onramp") {
      this.sentry.captureMessage("ramp chargeback on an off-ramp order", "error", {
        orderId: order.id,
      });
      return false;
    }
    if (order.status === "chargeback") return false;
    // Applied once per order: a bank refund stopped by a chargeback (C19) keeps its status.
    if ((order.details?.chargeback as ChargebackDetail | undefined)?.state === "charged_back")
      return false;
    if (order.status === "refunding") {
      // Our refund is in flight: it stays; an operator reconciles the two (SPEC §4.1).
      this.sentry.captureMessage("ramp chargeback while a refund is in flight", "error", {
        orderId: order.id,
      });
      return false;
    }
    // C19: an on-ramp's bank refund (refund_bank) queued or at the bank.
    if (order.status === "payout_queued" || order.status === "payout_sent")
      return this.bankRefundStopped(order, payment, kind);
    const capture = await this.capturePatch(order, payment);
    const detailOf = (amount: bigint, state: ChargebackDetail["state"]): ChargebackDetail => ({
      state,
      kind,
      amount: formatAmount(amount),
      at: new Date().toISOString(),
    });
    const kinds = await this.journal.postedKinds(this.store.orders.manager, order.id);
    if (order.status === "refunded") {
      if (
        kinds.has("onramp.chargeback_after_refund") ||
        (order.details?.chargeback as ChargebackDetail | undefined)?.state === "charged_back"
      )
        return false;
      const disputed = this.disputed(order, payment, kind, true);
      return this.store.bump(order, capture, {
        actor: SYSTEM,
        detail: "chargeback on a refunded order",
        details: { chargeback: detailOf(disputed, "charged_back") },
        within: async (m, fresh) => {
          if (disputed > 0n)
            await this.journal.post(m, fresh, "onramp.chargeback_after_refund", disputed);
        },
      });
    }
    const state = await this.mintState(order);
    if (state === "unresolved") {
      if ((order.details?.chargeback as ChargebackDetail | undefined)?.state === "pending")
        return false;
      return this.store.bump(order, capture, {
        actor: SYSTEM,
        detail: `${kind} while the mint is unresolved`,
        details: { chargeback: detailOf(this.disputed(order, payment, kind, false), "pending") },
        within: (m, fresh) => this.journal.bookCapture(m, fresh, payment.fee),
      });
    }
    const posting: RampOrderKind =
      state === "recorded" ? "onramp.chargeback_minted" : this.releaseKind(kinds);
    const disputed = this.disputed(
      order,
      payment,
      kind,
      posting === "onramp.chargeback_after_refund",
    );
    return this.store.transition(order, [order.status], "chargeback", capture, {
      actor: SYSTEM,
      detail:
        kind === "chargeback"
          ? "the issuer charged the payment back"
          : "the acquirer reversed the payment",
      details: { chargeback: detailOf(disputed, "charged_back") },
      within: async (m, fresh) => {
        await this.journal.bookCapture(m, fresh, payment.fee);
        // `onramp.chargeback` releases issuance_pending whole (nothing was minted or paid out);
        // a receivable is booked at what the dispute could reach — none when nothing was left.
        if (posting === "onramp.chargeback" || disputed > 0n)
          await this.journal.post(m, fresh, posting, disputed);
      },
    });
  }

  /**
   * The disputed amount of this event (`disputedAmount`): the reported chargeback, or the
   * acquirer's own refunds beyond ours for a reversal; capped at what the capture left unrefunded.
   */
  private disputed(
    order: RampOrderEntity,
    payment: RampPayment,
    kind: ChargebackDetail["kind"],
    afterRefund: boolean,
  ): bigint {
    const captured = order.capturedAmount ?? payment.capturedAmount ?? payment.amount;
    const ours = order.refundedAmount;
    // A chargeback leaves the acquirer's refund total as ours (a part it executed before we
    // recorded it counts); a reversal IS a refund of its own beyond ours.
    const refunded =
      kind === "chargeback" && payment.refundedAmount > ours && payment.refundedAmount <= captured
        ? payment.refundedAmount
        : ours;
    const reported =
      kind === "chargeback"
        ? payment.chargebackAmount
        : payment.refundedAmount > ours
          ? payment.refundedAmount - ours
          : null;
    const d = disputedAmount({ captured, refunded, reported, afterRefund });
    if (d.capped)
      this.sentry.captureMessage("ramp dispute above what the capture left unrefunded", "error", {
        orderId: order.id,
        kind,
        reported: formatAmount(reported as bigint),
        booked: formatAmount(d.amount),
      });
    if (d.amount === 0n && !afterRefund)
      this.sentry.captureMessage("ramp dispute on a capture refunded in full", "error", {
        orderId: order.id,
        kind,
      });
    return d.amount;
  }

  /** Nothing minted: release issuance_pending — unless a refund / void already did (#10: mutually exclusive). */
  private releaseKind(kinds: Set<string>): RampOrderKind {
    return ["onramp.refunded", "onramp.voided", "onramp.refund_queued"].some((k) => kinds.has(k))
      ? "onramp.chargeback_after_refund"
      : "onramp.chargeback";
  }

  /**
   * The first observation of the capture (a dispute or reversal implies one: an adapter that
   * cannot say how much is taken at F), and the refunds the order now explains — never our own
   * cash-out parts the acquirer executed before their cash-out recorded them: that cash-out
   * records them on this capture, and counting them here too would make it refuse them (C20).
   */
  private async capturePatch(
    order: RampOrderEntity,
    payment: RampPayment,
  ): Promise<Pick<RampOrderEntity, "capturedAmount" | "capturedAt" | "refundedAmount"> | object> {
    const captured = order.capturedAmount ?? payment.capturedAmount ?? payment.amount;
    const pending =
      payment.refundedAmount > order.refundedAmount
        ? (await this.cashout.refundsOf(order.id)).pending
        : 0n;
    const refunded = acquirerRefunded({
      acquirerTotal: payment.refundedAmount,
      pendingParts: pending,
      recorded: order.refundedAmount,
      captured,
    });
    return {
      ...(order.capturedAmount === null
        ? { capturedAmount: captured, capturedAt: new Date() }
        : {}),
      ...(refunded !== null ? { refundedAmount: refunded } : {}),
    };
  }

  /**
   * C19: the issuer charged back (or the acquirer itself returned) an on-ramp whose bank refund
   * (refund_bank) is queued or sent. The dispute is booked now (`onramp.chargeback_after_refund`:
   * the acquirer took the money; with `onramp.refund_queued` still owing it by bank, the two net
   * out until a person settles them) and the bank refund is stopped where it still can be: out of
   * the queue — or of a draft batch — into needs_review(refund); in an approved or exported batch
   * it is held (`details.hold`: the batch cannot go on until it is voided or cancelled). One the
   * bank already has cannot be stopped: it is flagged, and `details.chargeback` refuses another
   * bank refund once it comes back. Never an illegal transition, never a dead event.
   */
  private async bankRefundStopped(
    order: RampOrderEntity,
    payment: RampPayment,
    kind: ChargebackDetail["kind"],
  ): Promise<boolean> {
    if (order.direction !== "onramp") return false;
    if ((order.details?.chargeback as ChargebackDetail | undefined)?.state === "charged_back")
      return false;
    const capture = await this.capturePatch(order, payment);
    const disputed = this.disputed(order, payment, kind, true);
    const at = new Date().toISOString();
    const chargeback: ChargebackDetail = {
      state: "charged_back",
      kind,
      amount: formatAmount(disputed),
      at,
    };
    const within = async (m: EntityManager, fresh: RampOrderEntity): Promise<void> => {
      await this.journal.bookCapture(m, fresh, payment.fee);
      if (disputed > 0n)
        await this.journal.post(m, fresh, "onramp.chargeback_after_refund", disputed);
    };
    const what =
      kind === "chargeback"
        ? "the issuer charged the payment back"
        : "the acquirer returned the payment itself";
    this.sentry.captureMessage(
      `ramp ${kind} while a bank refund is ${order.status === "payout_sent" ? "at the bank" : "queued"}`,
      "error",
      {
        orderId: order.id,
      },
    );
    if (order.status === "payout_sent")
      return this.store.bump(order, capture, {
        actor: SYSTEM,
        detail: `${what} while the bank refund was already sent`,
        details: { chargeback },
        within,
      });
    const batchId = order.payoutBatchId;
    if (batchId && (await this.batchStatus(batchId)) !== "draft")
      return this.store.bump(order, capture, {
        actor: SYSTEM,
        detail: `${what}: the bank refund in batch ${batchId} is held`,
        expect: { payoutBatchId: batchId },
        details: { chargeback, hold: { reason: "chargeback", orderId: order.id, at } },
        within,
      });
    return this.store.review(
      order,
      ["payout_queued"],
      "refund",
      `${what}: the queued bank refund is not paid${batchId ? ` (it left draft batch ${batchId})` : ""}`,
      SYSTEM,
      { ...capture, payoutBatchId: null },
      {
        expect: { payoutBatchId: batchId },
        details: { chargeback, ...(batchId ? { leftBatchId: batchId } : {}) },
        within,
      },
    );
  }

  /** A payout batch's status (null when the row is gone). */
  private async batchStatus(batchId: string | null): Promise<string | null> {
    if (!batchId) return null;
    const b = await this.store.orders.manager
      .getRepository(RampPayoutBatchEntity)
      .findOne({ where: { id: batchId }, select: { id: true, status: true } });
    return b?.status ?? null;
  }

  private chargebackOf(order: RampOrderEntity): Partial<ChargebackDetail> {
    const c = order.details?.chargeback;
    return typeof c === "object" && c !== null ? c : {};
  }

  /**
   * The order effect, then the side effects — which run when the effect changed something or the
   * trigger is a verified webhook event (a poll that changes nothing does not re-suspend an
   * account an operator reinstated). A failing effect is re-thrown AFTER the side effects ran.
   */
  private async withSideEffects(
    order: RampOrderEntity,
    reason: ChargebackDetail["kind"],
    trigger: "event" | "read",
    effect: () => Promise<boolean>,
  ): Promise<void> {
    let changed = false;
    let failure: Error | null = null;
    try {
      changed = await effect();
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
    }
    if (changed || trigger === "event" || failure) await this.sideEffects(order, reason);
    if (failure) throw failure;
  }

  /** Suspend, block the card, stop the account's open off-ramps, audit, alert — each step on its own, never throwing. */
  async sideEffects(order: RampOrderEntity, reason: ChargebackDetail["kind"]): Promise<void> {
    const step = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        this.logger.error(`order ${order.id}: ${reason} ${what} failed: ${(err as Error).message}`);
        this.sentry.captureException(err, { processor: "ramp", orderId: order.id, step: what });
      }
    };
    await step("suspend", async () => {
      const user = await this.users.findById(order.userId);
      if (user?.status === "active")
        await this.users.suspend(order.userId, `ramp_${reason}`, SYSTEM);
    });
    await step("block card", async () => {
      if (order.paymentMethodId)
        await this.methods.update(
          { id: order.paymentMethodId },
          { status: "blocked", payoutEligible: false },
        );
    });
    await step("hold off-ramps", () => this.stopOfframps(order.userId, order.id, reason));
    await step("audit", () =>
      this.audit.record({
        actorType: "system",
        action: "ramp.chargeback",
        subjectType: "ramp_order",
        subjectId: order.id,
        metadata: {
          userId: order.userId,
          reason,
          status: order.status,
          fiatAmount: formatAmount(order.fiatAmount),
          mintCommandId: order.mintCommandId,
        },
      }),
    );
    this.sentry.captureMessage(`ramp ${reason}: account suspended`, "warning", {
      orderId: order.id,
      status: order.status,
    });
  }

  /**
   * Every open off-ramp of the account: before MarkPaid the withdrawal is deferred
   * (`details.hold`; the user may still cancel); after it the order waits in
   * needs_review(compliance) — no fiat leaves while the account is under a chargeback.
   */
  private async stopOfframps(userId: string, causeId: string, reason: string): Promise<void> {
    const open = await this.store.orders.find({
      where: { userId, direction: "offramp", status: In([...HOLDABLE, ...STOPPABLE]) },
    });
    for (const found of open) {
      // A write lost to a concurrent one is re-read and applied again: the stop is never dropped.
      let o: RampOrderEntity | null = found;
      for (let attempt = 0; o && attempt < 3; attempt += 1) {
        if (await this.stopOne(o, causeId, reason)) break;
        o = await this.store.find(o.id);
        if (o && !(HOLDABLE.includes(o.status) || STOPPABLE.includes(o.status))) o = null;
        if (o && attempt === 2)
          this.sentry.captureMessage("ramp chargeback could not stop a cash-out", "error", {
            orderId: o.id,
            causeId,
          });
      }
    }
  }

  /**
   * One cash-out of the charged-back account (SPEC §4.1, #4, C5). Before MarkPaid it is deferred;
   * an order in an approved or exported payout batch leaves payout_queued only through its batch,
   * so the hold blocks the batch's file and submission until it is voided or cancelled. A hold
   * that lifts by itself is overwritten — the chargeback must outlive it. A draft batch is not a
   * commitment: the order leaves it into review like an unbatched one. True when it is stopped.
   */
  private async stopOne(o: RampOrderEntity, causeId: string, reason: string): Promise<boolean> {
    const batched = o.status === "payout_queued" && o.payoutBatchId ? o.payoutBatchId : null;
    if (HOLDABLE.includes(o.status) || (batched && (await this.batchStatus(batched)) !== "draft")) {
      const hold = o.details?.hold as { reason?: string } | null | undefined;
      if (hold && !SELF_LIFTING_HOLDS.has(hold.reason ?? "")) return true;
      return this.store.bump(
        o,
        {},
        {
          actor: SYSTEM,
          details: {
            hold: {
              reason: "chargeback",
              orderId: causeId,
              at: new Date().toISOString(),
              ...(hold ? { replaced: hold.reason ?? null } : {}),
            },
          },
        },
      );
    }
    return this.store.review(
      o,
      [o.status],
      "compliance",
      `account ${reason} on ${causeId}${batched ? `; it left draft payout batch ${batched}` : ""}`,
      SYSTEM,
      batched ? { payoutBatchId: null } : {},
      batched
        ? {
            expect: { payoutBatchId: batched },
            details: {
              leftBatchId: batched,
              ...(o.details?.hold
                ? {
                    hold: null,
                    holdEndedReason: (o.details.hold as { reason?: string }).reason ?? null,
                  }
                : {}),
            },
          }
        : {},
    );
  }
}
