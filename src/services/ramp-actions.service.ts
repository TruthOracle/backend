import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { PayoutEntity } from "../entities/payout.entity";
import type { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import { isDefinitiveNo, isUnresolved } from "../entities/token-command.entity";
import {
  RAMP_PROVIDER,
  type Actor,
  type RampDirection,
  type RampOrderStatus,
  type RampProvider,
  type RampStep,
} from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, parseAmount } from "../util/money";
import { HOUR_MS } from "../util/time";
import { AuditService } from "./audit.service";
import { RampCardCashoutService } from "./ramp-card-cashout.service";
import { cardPayoutOf } from "./ramp-card-cashout.logic";
import { RampCompliancePort } from "./ramp-compliance.port";
import { RampReleaseGuard } from "./ramp-release-guard.service";
import { RampBankRailPort } from "./ramp-bank-rail.port";
import { EnterpriseWalletService } from "./enterprise-wallet.service";
import { RampCompensationService } from "./ramp-compensation.service";
import { RampDisputesService } from "./ramp-disputes.service";
import { RampGatesService } from "./ramp-gates.service";
import { RAMP_ORDER_LOCK_TTL_MS, RampFulfilmentService } from "./ramp-fulfilment.service";
import { RAMP_IP_RELEASES, RampJournalService } from "./ramp-journal.service";
import {
  creditBackInFlight,
  creditBackOf,
  isLegalTransition,
  RampOrderStore,
  type RampCreditBack,
  type RampOrderPatch,
} from "./ramp-order-store.service";
import { eripRefundProblem, offrampLedgerOutcome, RampPolicyService } from "./ramp-policy.service";
import { rampCommandId, remainderOf } from "./ramp-token-sync.service";
import { RedisService } from "./redis.service";
import { TokenCommandService } from "./token-command.service";
import { UserService } from "./user.service";
import { Config } from "../config";

/** SPEC §4.2's needs_review exits implemented here (refund_bank, bank_unpaid: S6). */
export const RAMP_ACTIONS = [
  "retry",
  "refund",
  "reverse",
  "reverse_remainder",
  "credit_back",
  "fail",
  "burn_uncredited",
] as const;
export type RampAction = (typeof RAMP_ACTIONS)[number];

/** Where an order's fiat goes (F2/F8): the card (a card cash-out, or the card an on-ramp refund goes back to) or the bank account. */
export type RampSnapshotDestination =
  | { kind: "card"; paymentMethodId: string; brand: string | null; last4: string | null }
  | { kind: "bank"; bankAccountId: string };

/**
 * F2/F8: the figures an approver signs off and the audit keeps — the amounts, whose money, and
 * where it goes (the user's wallet party for tokens; the card or bank account for fiat, as the
 * admin order API shows them). Set once on an order (a bank refund's account with a version
 * bump), so they never stale a pending approval the version alone would not.
 */
export interface RampOrderFigures {
  direction: RampDirection;
  userId: string;
  partyId: string;
  fiatAmount: string;
  fiatCurrency: string;
  tokenAmount: string;
  instrument: { admin: string; id: string };
  destination: RampSnapshotDestination | null;
}

/** What an approval snapshots (S4) — execution requires the same `version` under the order lock (H1). */
export interface RampOrderSnapshot extends RampOrderFigures {
  id: string;
  version: number;
  status: RampOrderStatus;
  reviewStep: RampStep | null;
  reviewFrom: string | null;
  mintCommandId: string | null;
  burnCommandId: string | null;
  remintCommandId: string | null;
  providerPaymentId: string | null;
  providerPayoutId: string | null;
  providerRefundId: string | null;
  pendingPayoutCid: string | null;
  capturedAmount: string | null;
  refundedAmount: string;
}

/** F2/F8: an order's figures (snapshot, audit rows). */
export function orderFigures(o: RampOrderEntity): RampOrderFigures {
  const card = (): RampSnapshotDestination | null =>
    o.paymentMethodId
      ? {
          kind: "card",
          paymentMethodId: o.paymentMethodId,
          brand: o.paymentMethod?.brand ?? null,
          last4: o.paymentMethod?.last4 ?? null,
        }
      : null;
  const bank = (): RampSnapshotDestination | null =>
    o.bankAccountId ? { kind: "bank", bankAccountId: o.bankAccountId } : null;
  return {
    direction: o.direction,
    userId: o.userId,
    partyId: o.partyId,
    fiatAmount: formatAmount(o.fiatAmount),
    fiatCurrency: o.fiatCurrency,
    tokenAmount: formatAmount(o.tokenAmount),
    instrument: { admin: o.instrumentAdmin, id: o.instrumentId },
    // A cash-out pays its rail; an on-ramp's money goes back to its bank refund's account, else its card.
    destination:
      o.direction === "offramp" ? (o.payoutRail === "bank" ? bank() : card()) : (bank() ?? card()),
  };
}

/** A 10-dp wire amount with its unit, trimmed for a sentence: `40.00 BYN`, `12.5 cBYN` → `12.50 cBYN`. */
export function moneyOf(amount: string, unit: string): string {
  const [whole, frac = ""] = amount.split(".");
  return `${whole}.${frac.replace(/0+$/, "").padEnd(2, "0")} ${unit}`;
}

/** Where the order's fiat goes, for a sentence. */
export function destinationText(s: Pick<RampOrderFigures, "destination">): string {
  const d = s.destination;
  if (!d) return "no card or bank account";
  if (d.kind === "bank") return `bank account ${d.bankAccountId}`;
  const label = [d.brand, `••${d.last4 ?? "????"}`].filter(Boolean).join(" ");
  return `card ${label} (${d.paymentMethodId})`;
}

export interface RampActionContext {
  actor: Actor;
  reason: string;
  /** S4's approval id when four-eyes executed it. */
  approvalId?: string | null;
}

/** `validate*` → what `execute*` would do, from FRESH reads (ledger, PayoutService row, token mirror, provider). */
export interface RampActionPlan {
  action: RampAction;
  orderId: string;
  /** The status it moves to (burn_uncredited: stays `chargeback`; credit_back: `refunded` once the Deposit confirms). */
  target: RampOrderStatus;
  /** A token command re-sent under its own id (I3: needs a second person). */
  resendCommandId: string | null;
  /** A reversal after an abandoned re-mint mints under `ramp-remint-<h>-<n>`. */
  newRemintCommandId: string | null;
  /** May one operator execute it (SPEC §4.2: only re-reads and upstream-deduped re-submits)? */
  singleControl: boolean;
  detail: string;
}

/** Where a review resumes when `details.reviewFrom` is missing (older rows). */
const STEP_STATUS: Record<RampStep, RampOrderStatus> = {
  payment: "paid",
  mint: "minting",
  credit: "crediting",
  withdrawal: "withdrawing",
  burn: "burning",
  payout: "paying_out",
  refund: "refunding",
  reversal: "reversing",
  compliance: "paid",
};
/** A capture approved from review resumes at `paid` (re-reading it), wherever it was seen. */
const CAPTURE_REVIEW_FROM: readonly string[] = [
  "awaiting_payment",
  "failed",
  "expired",
  "cancelled",
];
/**
 * C25: the only retry targets of an order AML decided to give back — an on-ramp's refund (by card,
 * or its bank refund in payout_queued / payout_sent: the way back) and a cash-out's burn or
 * reversal (they move nothing out). Any other target — a mint, a credit, a MarkPaid, a payout, or
 * one the order cannot resume at — is refused with the AML reason, before the legality check.
 */
const RETURN_TARGETS: Record<"onramp" | "offramp", readonly RampOrderStatus[]> = {
  onramp: ["refunding", "payout_queued", "payout_sent"],
  offramp: ["burning", "reversing"],
};
/**
 * A move out of review never runs while an approved credit-back's Deposit is in flight (C1); one
 * that failed for good (proven) is settled and no longer blocks.
 */
const NO_CREDIT_BACK = ["creditBack"] as const;

/**
 * F2/F8: what `ramp.order.<action>` moves — amount and unit — and for whom: the sentence the
 * approver signs off (the approvals list and the audit carry it).
 */
export function describeOrderAction(action: RampAction, s: RampOrderSnapshot): string {
  const at = `${s.direction} ${s.id} (${s.status}${s.reviewStep ? `, review ${s.reviewStep}` : ""})`;
  const fiat = moneyOf(s.fiatAmount, s.fiatCurrency);
  const tokens = moneyOf(s.tokenAmount, s.instrument.id);
  const who = `user ${s.userId} (wallet ${s.partyId})`;
  const to = destinationText(s);
  switch (action) {
    case "retry": {
      // Where it resumes, as validateRetry decides: a capture under review re-reads at `paid`.
      const capture =
        s.reviewStep === "payment" ||
        (s.reviewStep === "compliance" &&
          s.direction === "onramp" &&
          (s.reviewFrom === null || CAPTURE_REVIEW_FROM.includes(s.reviewFrom)));
      const target = capture
        ? "paid"
        : (s.reviewFrom ?? (s.reviewStep ? STEP_STATUS[s.reviewStep] : "its step"));
      return s.direction === "onramp"
        ? `retry ${at} at ${target}: ${fiat} paid by ${who} — ${tokens} minted to that wallet`
        : `retry ${at} at ${target}: ${tokens} withdrawn by ${who} — ${fiat} paid to ${to}`;
    }
    case "refund": {
      const refundable =
        s.capturedAmount === null
          ? s.fiatAmount
          : formatAmount(parseAmount(s.capturedAmount) - parseAmount(s.refundedAmount));
      return `refund ${moneyOf(refundable, s.fiatCurrency)} to ${to} of ${who}; nothing minted (${at})`;
    }
    case "reverse":
      return `re-mint ${tokens} and credit it back to ${who}: the ${fiat} cash-out to ${to} was not paid (${at})`;
    case "reverse_remainder":
      return `re-mint the unpaid remainder of the ${fiat} cash-out to ${to} (at most ${tokens}) and credit it back to ${who} (${at})`;
    case "credit_back":
      return `credit ${tokens} back to the in-app wallet of ${who}: the burn never landed, the ${fiat} was not paid (${at})`;
    case "fail":
      return s.direction === "onramp"
        ? `close ${at} as failed: the ${fiat} payment of ${who} holds no money — nothing minted or refunded`
        : `close ${at} as failed: the ${tokens} never left ${who} — nothing burned, no ${fiat} paid to ${to}`;
    case "burn_uncredited":
      return `burn ${tokens} minted for ${who} and never credited: the ${fiat} payment was charged back (${at})`;
  }
}

function refuse(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(409, "ramp_order_state", message, details);
}

/**
 * The operator's exits from `needs_review` (SPEC §4.2) as (validate, execute) pairs — S4 registers
 * each with its four-eyes approvals (`snapshot` → request; `validate` → fresh preconditions;
 * `execute` → the move). Execution holds `lock:ramp:<id>`, re-validates with FRESH reads (an
 * equal snapshot is necessary, not sufficient), and moves the order by a CAS on its version and
 * review step (H1); the order then advances at once. Until S4, the admin routes execute directly
 * (single operator).
 */
@Injectable()
export class RampActionsService {
  constructor(
    private readonly config: Config,
    private readonly store: RampOrderStore,
    private readonly fulfilment: RampFulfilmentService,
    private readonly policy: RampPolicyService,
    private readonly disputes: RampDisputesService,
    private readonly journal: RampJournalService,
    private readonly tokenCommands: TokenCommandService,
    @Inject(RAMP_PROVIDER) private readonly provider: RampProvider,
    @InjectRepository(PayoutEntity) private readonly payoutRows: Repository<PayoutEntity>,
    @InjectRepository(RampPaymentMethodEntity)
    private readonly methods: Repository<RampPaymentMethodEntity>,
    private readonly wallet: EnterpriseWalletService,
    private readonly users: UserService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly compensation: RampCompensationService,
    private readonly gates: RampGatesService,
    // S5: card cash-out parts, and the freeze / compliance guard every fiat-sending action checks.
    private readonly cashout: RampCardCashoutService,
    private readonly release: RampReleaseGuard,
    // S6: the bank rail answers for bank cash-outs (retry into payout_queued / payout_sent, reverse).
    private readonly bankRail: RampBankRailPort,
    // C25: an order AML decided to give back is refunded, never resumed into a mint or a payout.
    private readonly compliance: RampCompliancePort,
  ) {}

  /** The precondition snapshot an approval stores (with the figures, F2/F8). */
  async snapshot(orderId: string): Promise<RampOrderSnapshot> {
    const o = await this.requireOrder(orderId);
    return {
      ...orderFigures(o),
      id: o.id,
      version: o.version,
      status: o.status,
      reviewStep: o.reviewStep,
      reviewFrom: typeof o.details?.reviewFrom === "string" ? o.details.reviewFrom : null,
      mintCommandId: o.mintCommandId,
      burnCommandId: o.burnCommandId,
      remintCommandId: o.remintCommandId,
      providerPaymentId: o.providerPaymentId,
      providerPayoutId: o.providerPayoutId,
      providerRefundId: o.providerRefundId,
      pendingPayoutCid: o.pendingPayoutCid,
      capturedAmount: o.capturedAmount === null ? null : formatAmount(o.capturedAmount),
      refundedAmount: formatAmount(o.refundedAmount),
    };
  }

  /** Dispatch for S4's registry. */
  validate(action: RampAction, orderId: string): Promise<RampActionPlan> {
    switch (action) {
      case "retry":
        return this.validateRetry(orderId);
      case "refund":
        return this.validateRefund(orderId);
      case "reverse":
        return this.validateReverse(orderId);
      case "reverse_remainder":
        return this.validateReverseRemainder(orderId);
      case "credit_back":
        return this.validateCreditBack(orderId);
      case "fail":
        return this.validateFail(orderId);
      case "burn_uncredited":
        return this.validateBurnUncredited(orderId);
    }
  }

  execute(
    action: RampAction,
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
  ): Promise<RampOrderEntity> {
    switch (action) {
      case "retry":
        return this.executeRetry(orderId, snapshot, ctx);
      case "refund":
        return this.executeRefund(orderId, snapshot, ctx);
      case "reverse":
        return this.executeReverse(orderId, snapshot, ctx);
      case "reverse_remainder":
        return this.executeReverseRemainder(orderId, snapshot, ctx);
      case "credit_back":
        return this.executeCreditBack(orderId, snapshot, ctx);
      case "fail":
        return this.executeFail(orderId, snapshot, ctx);
      case "burn_uncredited":
        return this.executeBurnUncredited(orderId, snapshot, ctx);
    }
  }

  // ───────────────────────────────────────────── retry ──────────────────────────────────────

  /**
   * `retry` → `details.reviewFrom` when that status' entry conditions hold NOW (#5); a capture
   * under review (payment, or compliance at capture) resumes at `paid` after a re-read. A token
   * command the step needs is re-sent under its own id (S1 `validateResend`: unresolved or
   * rejected, no mirror record, inside the dedup window) — then it is four-eyes (I3).
   */
  async validateRetry(orderId: string): Promise<RampActionPlan> {
    const order = await this.requireReview(orderId);
    const from = typeof order.details?.reviewFrom === "string" ? order.details.reviewFrom : null;
    const step = order.reviewStep ?? "payment";
    const capture =
      step === "payment" ||
      (step === "compliance" &&
        order.direction === "onramp" &&
        (from === null || CAPTURE_REVIEW_FROM.includes(from)));
    const target = capture ? "paid" : ((from as RampOrderStatus | null) ?? STEP_STATUS[step]);
    // C25: AML decided the money goes back — refund / refund_bank (on), fail, credit_back or
    // reverse (off) end it; never a mint, a credit or a payout. Asked first, so the refusal says
    // why (a returned capture hold resumes at awaiting_payment, which no retry reaches).
    if (
      !RETURN_TARGETS[order.direction].includes(target) &&
      (await this.compliance.returnRequested(order.id))
    )
      throw refuse("AML decided to return this order's money; it is never minted or paid out", {
        use: order.direction === "onramp" ? "refund" : order.burnCommandId ? "reverse" : "fail",
      });
    if (!isLegalTransition("needs_review", target))
      throw refuse(`the order cannot resume at ${target}`);
    // C1: T may be burned and paid only while the failed credit-back is still proven never to land.
    await this.requireCreditBackNeverLanded(order);
    let resend: string | null = null;
    let newRemint: string | null = null;
    switch (target) {
      case "paid":
        // SPEC §11.5, I10 (C9): a compliance review holds the capture whatever the review step (a
        // payment problem can come with a create- or capture-point review); the AML decision ends
        // it (the processor resumes a compliance review), never a retry.
        if (await this.release.isHeld(order)) throw refuse("a compliance review holds this order");
        await this.requireNotFrozen(order);
        await this.requireCapturedWhole(order);
        break;
      case "minting":
        this.requireDirection(order, "onramp");
        if (order.details?.chargeback) throw refuse("a chargeback is open on this order");
        resend = await this.resendNeeded(order.mintCommandId, "refund it instead");
        break;
      case "crediting":
        this.requireDirection(order, "onramp");
        if (order.details?.chargeback) throw refuse("a chargeback is open on this order");
        if ((await this.disputes.mintState(order)) !== "recorded")
          throw refuse("the mint is not recorded");
        break;
      case "withdrawing": {
        this.requireDirection(order, "offramp");
        if (!order.pendingPayoutCid || order.burnCommandId)
          throw refuse("the order has no withdrawal waiting for MarkPaid");
        const ledger = await this.ledgerOutcome(order);
        if (ledger !== "live" && ledger !== "mark_paid")
          throw refuse(`the PendingPayout is ${ledger}; fail the order instead`);
        break;
      }
      case "burning":
        this.requireDirection(order, "offramp");
        resend = await this.resendNeeded(order.burnCommandId, "credit it back instead");
        break;
      case "paying_out":
        await this.requireBurnRecorded(order);
        await this.requirePayable(order);
        break;
      case "reversing":
        await this.requireBurnRecorded(order);
        // C4 / C34: after a reverse_remainder the paid parts stay paid — reversing's own entry
        // state is that the parts are settled as it left them; a whole reversal needs nothing paid.
        if (remainderOf(order) !== null) await this.requirePartsSettled(order);
        else await this.requireUnpaid(order);
        if (order.remintCommandId) {
          const row = await this.compensation.effectiveRow(order.remintCommandId);
          // R1-3: a rejected re-mint past the re-send window is as dead as an abandoned one (no
          // POST of it was ever accepted): the next generation, four-eyes and gated.
          if (row?.status === "abandoned" || (row && this.rejectedPastResend(row)))
            newRemint = this.nextRemintId(order);
          else resend = await this.resendNeeded(order.remintCommandId, "");
        }
        break;
      case "refunding":
        await this.requireRefundable(order);
        break;
      // S6: only the bank rail's batches and statements know whether these may resume (nothing is sent by a retry).
      case "payout_queued":
      case "payout_sent": {
        // C19: the issuer or the acquirer gave an on-ramp's money back while its bank refund was
        // queued: that refund never queues again (it was booked as owed until a person settles it).
        if (target === "payout_queued" && order.direction === "onramp" && order.details?.chargeback)
          throw refuse("a chargeback returned this payment; its bank refund is not paid");
        const problem = await this.bankRail.retryProblem(order, target);
        if (problem) throw refuse(problem);
        break;
      }
      default:
        throw refuse(`the order cannot resume at ${target}`);
    }
    return {
      action: "retry",
      orderId,
      target,
      resendCommandId: resend,
      newRemintCommandId: newRemint,
      singleControl: !resend && !newRemint && !(target === "reversing" && !order.remintCommandId),
      detail: `resume at ${target}`,
    };
  }

  async executeRetry(
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
  ): Promise<RampOrderEntity> {
    return this.run("retry", orderId, snapshot, ctx, async (order) => {
      const plan = await this.validateRetry(orderId);
      const patch: RampOrderPatch = { attempts: 0, lastError: null };
      if (plan.newRemintCommandId) patch.remintCommandId = plan.newRemintCommandId;
      // A reverse_remainder re-mints only R (SPEC §4.2): every generation, and the gate, see R (C4, C34).
      const remainder = plan.target === "reversing" ? remainderOf(order) : null;
      const moveIt = (): Promise<void> =>
        this.move(order, plan, ctx, patch, async (m) => {
          if (plan.newRemintCommandId)
            await this.tokenCommands.recordIntent(m, {
              commandId: plan.newRemintCommandId,
              kind: "mint",
              instrument: { admin: order.instrumentAdmin, id: order.instrumentId },
              party: this.treasury,
              amount: remainder ?? order.tokenAmount,
              source: "ramp",
              ref: order.id,
            });
        });
      // SPEC §6.3: a mint re-sent under its id, a reversal's next re-mint, or a mint never sent at
      // all (its first POST follows the move, C35) passes the reserve gate first — under
      // lock:ramp-mint-gate with the move that records it.
      const resent = plan.resendCommandId
        ? await this.tokenCommands.status(plan.resendCommandId)
        : null;
      const unsent = await this.unsentMint(order, plan);
      const gateKind = plan.newRemintCommandId
        ? "remint"
        : resent?.kind === "mint" || unsent
          ? plan.target === "reversing"
            ? "remint"
            : "mint"
          : null;
      if (gateKind) {
        const locked = await this.gates.withMintGateLock(async () => {
          const verdict = await this.gates.reserveGate(order, gateKind, {
            resendOf: plan.resendCommandId ?? unsent ?? undefined,
            remainder: remainder ?? undefined,
          });
          if (!verdict.ok)
            throw new ApiError(
              409,
              "reserve_gate",
              `reserve_gate:${verdict.reason}: ${verdict.detail}`,
              {
                reason: verdict.reason,
              },
            );
          await moveIt();
        });
        if (!locked.acquired) throw refuse("the mint gate is busy; try again in a moment");
      } else await moveIt();
      if (plan.resendCommandId)
        await this.tokenCommands.resend(plan.resendCommandId, {
          actor: ctx.actor,
          approvalId: ctx.approvalId ?? null,
          reason: ctx.reason,
        });
      if (plan.newRemintCommandId) await this.tokenCommands.submit(plan.newRemintCommandId);
      // A withdrawal the payout row gave up on is resumed by the operator's settle (PayoutService §9.4).
      if (plan.target === "withdrawing" && order.pendingPayoutCid)
        await this.fulfilment.resumePayout(order.pendingPayoutCid, ctx.actor, ctx.reason);
    });
  }

  // ───────────────────────────────────────────── refund / reverse / credit back ──────────────

  /**
   * `refund` (on): captured, the mint never created or definitive-no, the provider can refund the
   * method (ERIP: non-cash, settled ≥ 24 h — else `refund_bank`, S6), the user not frozen and no
   * compliance hold → refunding.
   */
  async validateRefund(orderId: string): Promise<RampActionPlan> {
    const order = await this.requireReview(orderId);
    await this.requireRefundable(order);
    return this.plan("refund", orderId, "refunding", "refund the capture");
  }

  executeRefund(
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
  ): Promise<RampOrderEntity> {
    return this.run("refund", orderId, snapshot, ctx, async (order) => {
      await this.move(order, await this.validateRefund(orderId), ctx, {
        attempts: 0,
        lastError: null,
      });
    });
  }

  /**
   * `reverse` (off): the burn is RECORDED (H3) and the card was definitively not paid — OCT: the
   * acquirer shows no payout under the order, or a failed one (C3: a payout whose id we never
   * recorded is found by its merchant reference); refund mode: every part definitively unpaid
   * after its lookup → reversing (re-mint T + Deposit back). Restores the user's own balance, so a
   * freeze does not stop it (§11.6).
   */
  async validateReverse(orderId: string): Promise<RampActionPlan> {
    const order = await this.requireReview(orderId);
    await this.requireBurnRecorded(order);
    await this.requireUnpaid(order);
    if (order.remintCommandId)
      throw refuse("a re-mint already exists for this order; retry the reversal instead");
    return this.plan(
      "reverse",
      orderId,
      "reversing",
      "re-mint the burned amount and credit it back",
    );
  }

  executeReverse(
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
  ): Promise<RampOrderEntity> {
    return this.run("reverse", orderId, snapshot, ctx, async (order) => {
      const plan = await this.validateReverse(orderId);
      const payout = cardPayoutOf(order.details);
      if (payout?.mode !== "refund") {
        await this.move(order, plan, ctx, { attempts: 0, lastError: null });
        return;
      }
      // Unsent / refused parts stop reserving the card's capacity (#13).
      const won = await this.store.transition(
        order,
        ["needs_review"],
        "reversing",
        { attempts: 0, lastError: null },
        {
          actor: ctx.actor,
          detail: `reverse: ${ctx.reason}`,
          expect: { reviewStep: order.reviewStep },
          settled: NO_CREDIT_BACK,
          details: {
            cardPayout: {
              ...payout,
              parts: payout.parts.map((p) =>
                p.status === "succeeded" ? p : { ...p, status: "void" },
              ),
            },
          },
          within: (m) => this.auditAction(m, order, plan, ctx),
        },
      );
      if (!won) throw refuse("the order changed meanwhile; reload it");
    });
  }

  /**
   * `reverse_remainder` (off, refund mode; SPEC §4.2): the burn is recorded, some parts were paid
   * and every other part is definitively unpaid after its lookup → reversing with R = P − paid:
   * re-mint R (`offramp.reversed_partial` when it records) and credit it back. The paid parts —
   * also those the acquirer confirmed while the order sat in review — are recorded on their
   * on-ramps and booked as `offramp.paid_card` in the same transaction. Four-eyes.
   */
  async validateReverseRemainder(orderId: string): Promise<RampActionPlan> {
    const order = await this.requireReview(orderId);
    await this.requireBurnRecorded(order);
    // C20: a chargeback on the account stops a paying cash-out in compliance review — the user's
    // unpaid remainder must still be re-mintable from there (the account stays suspended).
    if (order.reviewStep !== "payout" && order.reviewStep !== "compliance")
      throw refuse("only a card cash-out in payout or compliance review");
    if (!this.cashout.isRefundMode(order))
      throw refuse("only a card cash-out paid by refunds has parts");
    if (order.remintCommandId) throw refuse("a re-mint already exists for this order");
    const standing = await this.standing(order);
    if (standing.inFlight > 0)
      throw refuse("a card refund part is still being processed by the acquirer");
    if (standing.paid === 0n) throw refuse("no part was paid; reverse the whole cash-out instead");
    const remainder = order.fiatAmount - standing.paid;
    if (remainder <= 0n) throw refuse("every part was paid; retry to complete the cash-out");
    if (standing.unpaid !== remainder)
      throw refuse("the parts do not add up to the cash-out; an operator must look", {
        paid: formatAmount(standing.paid),
        unpaid: formatAmount(standing.unpaid),
      });
    return this.plan(
      "reverse_remainder",
      orderId,
      "reversing",
      `re-mint the unpaid ${formatAmount(remainder)} and credit it back`,
    );
  }

  executeReverseRemainder(
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
  ): Promise<RampOrderEntity> {
    return this.run("reverse_remainder", orderId, snapshot, ctx, async (order) => {
      const plan = await this.validateReverseRemainder(orderId);
      const standing = await this.standing(order);
      const payout = cardPayoutOf(order.details);
      if (!payout) throw refuse("the order has no card cash-out plan");
      const remainder = order.fiatAmount - standing.paid;
      const confirmed = standing.parts.filter(
        (l) => l.part.status !== "succeeded" && l.refund?.status === "succeeded",
      );
      const parts = payout.parts.map((p, i) => {
        if (p.status === "succeeded") return p;
        const late = confirmed.find((l) => l.index === i);
        return late
          ? {
              ...p,
              status: "succeeded" as const,
              refundId: late.refund?.refundId ?? null,
              fee: late.refund?.fee != null ? formatAmount(late.refund.fee) : null,
            }
          : { ...p, status: "void" as const };
      });
      const fees = parts.reduce((sum, p) => sum + (p.fee ? parseAmount(p.fee) : 0n), 0n);
      const won = await this.store.transition(
        order,
        ["needs_review"],
        "reversing",
        { attempts: 0, lastError: null },
        {
          actor: ctx.actor,
          detail: `reverse_remainder: ${ctx.reason}`,
          expect: { reviewStep: order.reviewStep },
          settled: NO_CREDIT_BACK,
          details: {
            cardPayout: {
              ...payout,
              parts,
              reversal: {
                remainder: formatAmount(remainder),
                paid: formatAmount(standing.paid),
                approvalId: ctx.approvalId ?? null,
                at: new Date().toISOString(),
              },
            },
          },
          within: async (m, fresh) => {
            await this.auditAction(m, order, plan, ctx);
            // Parts the acquirer paid while the order sat in review are recorded on their captures now.
            for (const late of confirmed) {
              const onramp = await this.store.lockForUpdate(m, late.part.onrampOrderId);
              if (!onramp || onramp.capturedAmount === null)
                throw refuse(`the on-ramp ${late.part.onrampOrderId} cannot take the refund`);
              const refunded = onramp.refundedAmount + parseAmount(late.part.amount);
              if (
                refunded > onramp.capturedAmount ||
                !(await this.store.bump(
                  onramp,
                  { refundedAmount: refunded },
                  { actor: ctx.actor, manager: m },
                ))
              )
                throw refuse(`the on-ramp ${late.part.onrampOrderId} changed meanwhile; try again`);
            }
            await this.journal.post(m, fresh, "offramp.paid_card", standing.paid);
            if (fees > 0n) await this.journal.post(m, fresh, "psp.fee_accrued", fees);
          },
        },
      );
      if (!won) throw refuse("the order changed meanwhile; reload it");
    });
  }

  /** The parts' standing at the acquirer; an unreadable lookup refuses (fail closed, I3). */
  private async standing(order: RampOrderEntity): ReturnType<RampCardCashoutService["standing"]> {
    try {
      return await this.cashout.standing(order);
    } catch (err) {
      throw refuse(
        `the acquirer could not be asked about the card refunds: ${(err as Error).message}`,
      );
    }
  }

  /**
   * `credit_back` (off, #1): review step withdrawal or burn, the LEDGER proves MarkPaid archived
   * the PendingPayout (the tokens are in the treasury), and the burn never lands (definitive-no)
   * or was never created → Deposit T back from treasury holdings → refunded. Posts nothing: the
   * supply never changed. C1: after a credit-back that failed for good — re-proven now on fresh
   * reads — it is asked again as a NEW generation under a new key (a failed key is never reused).
   */
  async validateCreditBack(orderId: string): Promise<RampActionPlan> {
    const order = await this.requireReview(orderId);
    this.requireDirection(order, "offramp");
    if (order.reviewStep !== "withdrawal" && order.reviewStep !== "burn")
      throw refuse("credit back is for a withdrawal or burn review");
    if ((await this.ledgerOutcome(order)) !== "mark_paid")
      throw refuse("the ledger does not show our MarkPaid archiving the PendingPayout");
    if (order.burnCommandId) {
      const row = await this.compensation.effectiveRow(order.burnCommandId);
      if (!row || !isDefinitiveNo(row.status))
        throw refuse(
          `the burn is ${row?.status ?? "unknown"}; only a burn that never lands is credited back`,
        );
    }
    const previous = creditBackOf(order);
    if (previous && previous.state !== "failed") throw refuse("a credit back is already under way");
    await this.requireCreditBackNeverLanded(order);
    const generation = this.creditBackGeneration(previous) + 1;
    return this.plan(
      "credit_back",
      orderId,
      "refunded",
      `Deposit the withdrawn tokens back${generation > 1 ? ` (generation ${generation}, a new key)` : ""}`,
    );
  }

  executeCreditBack(
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
  ): Promise<RampOrderEntity> {
    return this.run("credit_back", orderId, snapshot, ctx, async (order) => {
      const plan = await this.validateCreditBack(orderId);
      const previous = creditBackOf(order);
      const generation = this.creditBackGeneration(previous) + 1;
      const failed = previous
        ? [
            ...(previous.failed ?? []),
            {
              commandId: previous.commandId,
              error: previous.error ?? null,
              failedAt: previous.failedAt ?? null,
            },
          ]
        : [];
      // The Deposit is the step's (idempotent on this id); the order leaves review when it confirms.
      const won = await this.store.bump(
        order,
        { attempts: 0, lastError: null },
        {
          actor: ctx.actor,
          detail: `credit_back: ${ctx.reason}`,
          expect: { reviewStep: order.reviewStep },
          settled: NO_CREDIT_BACK,
          details: {
            creditBack: {
              commandId: rampCommandId("creditback", order.id, generation),
              generation,
              state: "submitted",
              at: new Date().toISOString(),
              approvalId: ctx.approvalId ?? null,
              ...(failed.length ? { failed } : {}),
            },
          },
          within: (m) => this.auditAction(m, order, plan, ctx),
        },
      );
      if (!won) throw refuse("the order changed meanwhile; reload it");
    });
  }

  /** The generation of the order's last credit-back key (0 = none yet; a key without one is 1). */
  private creditBackGeneration(cb: RampCreditBack | null): number {
    if (!cb) return 0;
    if (typeof cb.generation === "number" && cb.generation >= 1) return cb.generation;
    const m = /^ramp-creditback-[0-9a-f]{40}-(\d+)$/.exec(cb.commandId);
    return m ? Number(m[1]) : 1;
  }

  /**
   * C1: every credit-back key that failed for good — each earlier generation and the current one —
   * is re-proven on fresh reads (the wallet still reports its command FAILED, past
   * RAMP_CREDIT_BACK_FINAL_AFTER_MIN; the index and the ledger still show no Deposit with its
   * txRef) before another exit moves the same T — a retry that burns and pays it, or a new
   * generation. One landing late would credit T a second time.
   */
  private async requireCreditBackNeverLanded(order: RampOrderEntity): Promise<void> {
    const cb = creditBackOf(order);
    if (!cb) return;
    const unproven = await this.fulfilment.creditBackKeysUnproven(cb);
    if (unproven)
      throw refuse(
        `the failed credit back ${unproven.commandId} is not proven never to land: ${unproven.why}`,
      );
  }

  // ───────────────────────────────────────────── fail / burn uncredited ─────────────────────

  /**
   * `fail` (#1, M3). On-ramp: nothing minted and the acquirer shows no capture — or returned the
   * money itself (posts `onramp.voided` iff the capture was booked). Off-ramp: the PendingPayout is
   * live or the user's CancelPayout archived it, and no MarkPaid is pending or submitted; after
   * MarkPaid the only exits are retry and credit_back.
   */
  async validateFail(orderId: string): Promise<RampActionPlan> {
    const order = await this.requireReview(orderId);
    if (order.direction === "onramp") {
      const mint = await this.disputes.mintState(order);
      if (mint === "recorded" || mint === "unresolved")
        throw refuse("a mint exists for this order; it cannot be failed");
      // The capture was already given back another way (a bank refund queued or paid, a refund, a
      // chargeback): `fail` would book a second release (C19 — a person settles that one).
      const posted = await this.journal.postedKinds(this.store.orders.manager, order.id);
      const released = RAMP_IP_RELEASES.find((k) => posted.has(k));
      if (released) throw refuse(`the capture was already released (${released})`);
      if (order.providerPaymentId) {
        const p = await this.provider.getPayment(order.providerPaymentId);
        const captured = p.capturedAmount ?? null;
        const returnedByAcquirer =
          captured !== null && p.refundedAmount >= captured && !order.providerRefundId;
        if (captured !== null && !returnedByAcquirer)
          throw refuse("the payment was captured; refund it instead", { paymentStatus: p.status });
      }
      return this.plan("fail", orderId, "failed", "close the order: no money is held");
    }
    if (order.burnCommandId)
      throw refuse("the burn was recorded or attempted; use retry or credit_back");
    if (order.pendingPayoutCid) {
      const ledger = await this.ledgerOutcome(order);
      if (ledger !== "live" && ledger !== "cancelled")
        throw refuse(`the PendingPayout is ${ledger}; use retry or credit_back`);
      const row = await this.payoutRows.findOne({
        where: { pendingPayoutCid: order.pendingPayoutCid },
      });
      if (row?.markPaidCommandId) {
        const status = await this.wallet.commandStatus(this.treasury, row.markPaidCommandId);
        // Only a MarkPaid the wallet reports FAILED is known not to have run.
        if (!status.known || status.submitted)
          throw refuse("a MarkPaid is pending or submitted for this withdrawal");
      }
    }
    return this.plan(
      "fail",
      orderId,
      "failed",
      "close the cash-out: the tokens never left the user",
    );
  }

  executeFail(
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
  ): Promise<RampOrderEntity> {
    return this.run("fail", orderId, snapshot, ctx, async (order) => {
      const plan = await this.validateFail(orderId);
      await this.move(order, plan, ctx, { attempts: 0, lastError: null }, async (m, fresh) => {
        // M3: a booked capture the acquirer gave back is reversed.
        if (
          fresh.direction === "onramp" &&
          (await this.journal.posted(m, fresh.id, "onramp.captured"))
        )
          await this.journal.post(m, fresh, "onramp.voided");
      });
    });
  }

  /**
   * `burn_uncredited` (on, #10): a chargeback after a RECORDED mint that was never credited (no
   * Deposit ever submitted) → burn N from the treasury under `ramp-cbburn-<h>`; the token sync
   * books `onramp.uncredited_burned` when it is recorded.
   */
  async validateBurnUncredited(orderId: string): Promise<RampActionPlan> {
    const order = await this.requireOrder(orderId);
    this.requireDirection(order, "onramp");
    if (order.status !== "chargeback") throw refuse("only a charged-back order");
    if ((await this.disputes.mintState(order)) !== "recorded")
      throw refuse("the mint is not recorded");
    if (await this.disputes.depositSubmitted(order))
      throw refuse("the mint was credited (or its Deposit submitted); nothing is left to burn");
    if (
      !(await this.journal.posted(this.store.orders.manager, order.id, "onramp.chargeback_minted"))
    )
      throw refuse("the chargeback receivable is not booked");
    // R1-2: a won dispute gave the money back to us: the user paid for N and is owed it — burning
    // it would leave them nothing and the receivable at −F.
    if (
      (order.details?.chargeback as { state?: string } | undefined)?.state === "won" ||
      (await this.journal.posted(this.store.orders.manager, order.id, "onramp.chargeback_reversed"))
    )
      throw refuse("the dispute was won: the user paid for these tokens and is owed them");
    // `onramp.uncredited_burned` clears a receivable of F: a partial dispute (S8: the acquirer took
    // less) would leave it negative and the rest of the user's money unaccounted — a person settles it.
    const receivable = await this.journal.postedAmount(
      this.store.orders.manager,
      order.id,
      ["onramp.chargeback_minted"],
      "chargeback_receivable",
    );
    if (receivable !== order.fiatAmount)
      throw refuse(
        `a partial chargeback (${formatAmount(receivable)} of ${formatAmount(order.fiatAmount)}) is settled by hand`,
      );
    const previous =
      typeof order.details?.cbburnCommandId === "string" ? order.details.cbburnCommandId : null;
    // R1-3: a burn token-app refused, past the re-send window, is as dead as an abandoned one:
    // the next generation under a new id (a later landing of the old one is a mismatch).
    const row = previous ? await this.compensation.effectiveRow(previous) : null;
    if (previous && !(row && (row.status === "abandoned" || this.rejectedPastResend(row))))
      throw refuse("the burn was already requested");
    return {
      ...this.plan(
        "burn_uncredited",
        orderId,
        "chargeback",
        `burn the uncredited mint${previous ? ` (generation ${this.cbburnGeneration(order) + 1}, a new id)` : ""}`,
      ),
      target: "chargeback",
    };
  }

  /** The generation of the order's chargeback burn id (0 = none yet). */
  private cbburnGeneration(order: RampOrderEntity): number {
    const id = order.details?.cbburnCommandId;
    if (typeof id !== "string") return 0;
    const m = /^ramp-cbburn-[0-9a-f]{40}-(\d+)$/.exec(id);
    return m ? Number(m[1]) : 1;
  }

  executeBurnUncredited(
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
  ): Promise<RampOrderEntity> {
    return this.run("burn_uncredited", orderId, snapshot, ctx, async (order) => {
      const plan = await this.validateBurnUncredited(orderId);
      const commandId = rampCommandId("cbburn", order.id, this.cbburnGeneration(order) + 1);
      const won = await this.store.bump(
        order,
        {},
        {
          actor: ctx.actor,
          detail: `burn_uncredited: ${ctx.reason}`,
          details: { cbburnCommandId: commandId },
          within: async (m) => {
            await this.auditAction(m, order, plan, ctx);
            await this.tokenCommands.recordIntent(m, {
              commandId,
              kind: "burn",
              instrument: { admin: order.instrumentAdmin, id: order.instrumentId },
              party: this.treasury,
              amount: order.tokenAmount,
              source: "ramp",
              ref: order.id,
            });
          },
        },
      );
      if (!won) throw refuse("the order changed meanwhile; reload it");
      await this.tokenCommands.submit(commandId);
    });
  }

  // ───────────────────────────────────────────── execution ──────────────────────────────────

  /**
   * Under `lock:ramp:<id>`: refuse the order's own user (no self-dealing), require the snapshot's
   * version when there is one, then `apply` (which re-validates fresh and CASes); advance after.
   */
  private async run(
    action: RampAction,
    orderId: string,
    snapshot: RampOrderSnapshot | null,
    ctx: RampActionContext,
    apply: (order: RampOrderEntity) => Promise<void>,
  ): Promise<RampOrderEntity> {
    if (!ctx.reason?.trim()) throw new ApiError(400, "validation_failed", "a reason is required");
    const lock = await this.redis.acquireLock(`lock:ramp:${orderId}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired) throw refuse("the order is being processed; try again in a moment");
    try {
      const order = await this.requireOrder(orderId);
      if (ctx.actor.userId && ctx.actor.userId === order.userId)
        throw new ApiError(403, "forbidden", `an operator cannot ${action} their own order`);
      if (snapshot && snapshot.version !== order.version)
        throw refuse("the order changed since the action was requested", {
          expectedVersion: snapshot.version,
          version: order.version,
        });
      await apply(order);
    } finally {
      await lock.release();
    }
    await this.fulfilment.advance(orderId);
    return this.requireOrder(orderId);
  }

  /** needs_review → plan.target by CAS on the version AND the review step read under the lock (H1). */
  private async move(
    order: RampOrderEntity,
    plan: RampActionPlan,
    ctx: RampActionContext,
    patch: RampOrderPatch,
    within?: (
      m: Parameters<NonNullable<Parameters<RampOrderStore["transition"]>[4]["within"]>>[0],
      fresh: RampOrderEntity,
    ) => Promise<void>,
  ): Promise<void> {
    const won = await this.store.transition(order, ["needs_review"], plan.target, patch, {
      actor: ctx.actor,
      detail: `${plan.action}: ${ctx.reason}`,
      expect: { reviewStep: order.reviewStep },
      settled: NO_CREDIT_BACK,
      within: async (m, fresh) => {
        await this.auditAction(m, order, plan, ctx);
        if (within) await within(m, fresh);
      },
    });
    if (!won) throw refuse("the order changed meanwhile; reload it");
  }

  private async auditAction(
    manager: Parameters<AuditService["record"]>[1],
    order: RampOrderEntity,
    plan: RampActionPlan,
    ctx: RampActionContext,
  ): Promise<void> {
    await this.audit.record(
      {
        actorType: ctx.actor.type,
        actorUserId: ctx.actor.userId ?? null,
        actorSessionId: ctx.actor.sessionId ?? null,
        action: "ramp.admin_action",
        subjectType: "ramp_order",
        subjectId: order.id,
        metadata: {
          action: plan.action,
          reason: ctx.reason,
          approvalId: ctx.approvalId ?? null,
          from: order.status,
          to: plan.target,
          reviewStep: order.reviewStep,
          version: order.version,
          resend: plan.resendCommandId,
          userId: order.userId,
          // F2/F8: what the action moved, and for whom.
          figures: orderFigures(order),
        },
        ip: ctx.actor.ip ?? null,
      },
      manager,
    );
  }

  private plan(
    action: RampAction,
    orderId: string,
    target: RampOrderStatus,
    detail: string,
  ): RampActionPlan {
    // SPEC §4.2: everything but a plain retry needs a second person.
    return {
      action,
      orderId,
      target,
      resendCommandId: null,
      newRemintCommandId: null,
      singleControl: false,
      detail,
    };
  }

  // ───────────────────────────────────────────── preconditions (fresh reads) ────────────────

  private get treasury(): string {
    const treasury = this.config.treasuryPartyId;
    if (!treasury)
      throw new ApiError(502, "upstream_failed", "TREASURY_PARTY_ID is not configured");
    return treasury;
  }

  private async requireOrder(orderId: string): Promise<RampOrderEntity> {
    const order = await this.store.find(orderId);
    if (!order) throw new ApiError(404, "not_found", "order not found");
    return order;
  }

  /**
   * In review, with no credit-back in flight (C1): an approved credit-back's Deposit may still
   * land, so every other exit (a retry would MarkPaid-burn-pay the same T) waits until it confirms
   * and the order is refunded. Every `validate*` runs again under the order lock at execution.
   */
  private async requireReview(orderId: string): Promise<RampOrderEntity> {
    const order = await this.requireOrder(orderId);
    if (order.status !== "needs_review")
      throw refuse(`the order is ${order.status}, not needs_review`, { status: order.status });
    if (creditBackInFlight(order))
      throw refuse("a credit back is under way; the order is refunded once its Deposit confirms");
    return order;
  }

  private requireDirection(order: RampOrderEntity, direction: "onramp" | "offramp"): void {
    if (order.direction !== direction) throw refuse(`only an ${direction} order`);
  }

  /** The acquirer shows exactly F captured, nothing refunded; nothing minted; the account active. */
  private async requireCapturedWhole(order: RampOrderEntity): Promise<void> {
    this.requireDirection(order, "onramp");
    if (!order.providerPaymentId) throw refuse("the order has no payment");
    if (order.mintCommandId) throw refuse("a mint already exists for this order");
    if (order.details?.chargeback) throw refuse("a chargeback is open on this order");
    const p = await this.provider.getPayment(order.providerPaymentId);
    if (
      p.status !== "succeeded" ||
      p.capturedAmount !== order.fiatAmount ||
      p.refundedAmount > 0n ||
      p.currency !== order.fiatCurrency
    )
      throw refuse("the acquirer does not report this exact amount as captured; refund instead", {
        paymentStatus: p.status,
      });
    const user = await this.users.findById(order.userId);
    if (user?.status !== "active") throw refuse("the account is not active");
  }

  /**
   * Captured at the acquirer, nothing minted that may land, the acquirer refunds this method now
   * (ERIP: SPEC §9.2 — otherwise `refund_bank`, S6), the user not frozen and no compliance hold (I10).
   */
  private async requireRefundable(order: RampOrderEntity): Promise<void> {
    this.requireDirection(order, "onramp");
    if (!order.providerPaymentId) throw refuse("the order has no payment");
    const method = order.method ?? "card";
    if (method === "card" && !this.provider.capabilities.refundMethods.includes("card"))
      throw refuse("the acquirer cannot refund card payments");
    await this.requireNotFrozen(order);
    if (await this.release.isHeld(order)) throw refuse("a compliance review holds this order");
    // C19: the issuer or the acquirer already gave the money back (a chargeback, a PSP reversal).
    if (order.details?.chargeback) throw refuse("a chargeback is open on this order");
    const mint = await this.disputes.mintState(order);
    if (mint === "recorded" || mint === "unresolved")
      throw refuse(`the mint is ${mint}; a refund needs a mint that never lands`);
    const p = await this.provider.getPayment(order.providerPaymentId);
    if (p.capturedAmount === null) throw refuse("the acquirer shows no capture to refund");
    if (p.status === "chargeback") throw refuse("the payment was charged back");
    const erip = eripRefundProblem(order.method, p, this.provider.capabilities);
    if (erip) throw refuse(erip, { method: order.method, use: "refund_bank" });
  }

  /** SPEC §11.6: nothing that sends fiat to a frozen user (credit-backs and reversals restore balances: allowed). */
  private async requireNotFrozen(order: RampOrderEntity): Promise<void> {
    if (await this.release.isFrozen(order.userId)) throw refuse("the account is frozen");
  }

  private async requireBurnRecorded(order: RampOrderEntity): Promise<void> {
    this.requireDirection(order, "offramp");
    const row = order.burnCommandId
      ? await this.compensation.effectiveRow(order.burnCommandId)
      : null;
    if (row?.status !== "recorded")
      throw refuse(`the burn is ${row?.status ?? "not created"}; a reversal needs a recorded burn`);
  }

  /**
   * No fiat left: refund mode — every part definitively unpaid after its lookup; OCT — no payout
   * under the order at the acquirer, or a failed one (C3; lookup error → refuse).
   */
  private async requireUnpaid(order: RampOrderEntity): Promise<void> {
    // S6: a bank cash-out is unpaid when its batch history says so (never exported, voided, proven unpaid, returned).
    if (order.payoutRail === "bank") {
      const problem = await this.bankRail.reverseProblem(order);
      if (problem) throw refuse(problem);
      return;
    }
    if (this.cashout.isRefundMode(order)) {
      const standing = await this.standing(order);
      if (standing.inFlight > 0)
        throw refuse("a card refund part is still being processed by the acquirer");
      if (standing.paid > 0n)
        throw refuse("some card refund parts were paid; reverse the unpaid remainder instead", {
          paid: formatAmount(standing.paid),
        });
      return;
    }
    let payout;
    try {
      payout = order.providerPayoutId
        ? await this.provider.getPayout(order.providerPayoutId)
        : await this.provider.findPayoutByOrder(order.id);
    } catch (err) {
      throw refuse(`the acquirer could not be asked about a payout: ${(err as Error).message}`);
    }
    if (payout && payout.status !== "failed")
      throw refuse(`the acquirer shows a ${payout.status} payout for this order`, {
        payoutId: payout.payoutId,
      });
  }

  /**
   * reversing's own entry state after a reverse_remainder (C4, C34): the parts are as it left
   * them — nothing in flight at the acquirer, the paid Σ still what it recorded (its void parts
   * are not looked up again). Unreadable → refuse (I7).
   */
  private async requirePartsSettled(order: RampOrderEntity): Promise<void> {
    const reversal = (order.details?.cardPayout as { reversal?: { paid?: unknown } } | undefined)
      ?.reversal;
    const standing = await this.standing(order);
    if (standing.inFlight > 0)
      throw refuse("a card refund part is still being processed by the acquirer");
    if (typeof reversal?.paid !== "string" || standing.paid !== parseAmount(reversal.paid))
      throw refuse("the paid parts changed since the partial reversal; an operator must look", {
        paid: formatAmount(standing.paid),
        recorded: typeof reversal?.paid === "string" ? reversal.paid : null,
      });
  }

  /**
   * A mint (or re-mint) the resumed step will POST for the first time (C35): pending, never sent.
   * Its id, so the retry gates it like a re-send; null when the step needs no first POST.
   */
  private async unsentMint(order: RampOrderEntity, plan: RampActionPlan): Promise<string | null> {
    if (plan.resendCommandId || plan.newRemintCommandId) return null;
    const id =
      plan.target === "minting"
        ? order.mintCommandId
        : plan.target === "reversing"
          ? order.remintCommandId
          : null;
    if (!id) return null;
    const row = await this.compensation.effectiveRow(id);
    return row?.kind === "mint" && row.status === "pending" && row.attempts === 0 ? id : null;
  }

  /**
   * The card payout may be (re)attempted: account active and not frozen, card eligible; refund
   * mode — no part refused (those exits are reverse / reverse_remainder); OCT — the acquirer readable.
   */
  private async requirePayable(order: RampOrderEntity): Promise<void> {
    const user = await this.users.findById(order.userId);
    if (user?.status !== "active") throw refuse("the account is not active");
    await this.requireNotFrozen(order);
    const method = order.paymentMethodId
      ? await this.methods.findOne({ where: { id: order.paymentMethodId } })
      : null;
    if (!method || method.status !== "active" || !method.payoutEligible)
      throw refuse("the destination card is not eligible");
    const payout = cardPayoutOf(order.details);
    if (payout?.mode === "refund") {
      if (payout.parts.some((p) => p.status === "failed"))
        throw refuse(
          "a card refund part was refused; reverse the unpaid remainder (or all of it) instead",
        );
      return;
    }
    try {
      if (!order.providerPayoutId) await this.provider.findPayoutByOrder(order.id);
    } catch (err) {
      throw refuse(`the acquirer could not be asked about a payout: ${(err as Error).message}`);
    }
  }

  /**
   * The command a resumed token step needs re-sent, or null (recorded, or never sent — the step
   * submits it). S1's `validateResend` checks the mirror and the dedup window.
   */
  private async resendNeeded(
    commandId: string | null,
    definitiveNoHint: string,
  ): Promise<string | null> {
    if (!commandId) return null;
    const row = await this.compensation.effectiveRow(commandId);
    if (!row) throw refuse(`${commandId} has no command row`);
    if (row.status === "recorded") return null;
    if (row.status === "pending" && row.attempts === 0) return null;
    if (row.status === "mismatch") throw refuse(`${commandId} is a mismatch; compensate it first`);
    if (row.status === "abandoned")
      throw refuse(`${commandId} was abandoned${definitiveNoHint ? `; ${definitiveNoHint}` : ""}`);
    if (isUnresolved(row.status) || row.status === "rejected") {
      await this.tokenCommands.validateResend(commandId);
      return commandId;
    }
    return null;
  }

  /** A `rejected` command (every POST refused) whose last POST is past TOKEN_APP_RESEND_MAX_AGE_HOURS. */
  private rejectedPastResend(row: {
    status: string;
    lastPostAt: Date | null;
    createdAt: Date;
  }): boolean {
    const last = (row.lastPostAt ?? row.createdAt).getTime();
    return (
      row.status === "rejected" &&
      Date.now() - last >= this.config.tokenCommands.resendMaxAgeHours * HOUR_MS
    );
  }

  private nextRemintId(order: RampOrderEntity): string {
    const m = /-(\d+)$/.exec(order.remintCommandId ?? "");
    const generation =
      order.remintCommandId === rampCommandId("remint", order.id) ? 1 : Number(m?.[1] ?? 1);
    return rampCommandId("remint", order.id, generation + 1);
  }

  private async ledgerOutcome(
    order: RampOrderEntity,
  ): Promise<ReturnType<typeof offrampLedgerOutcome>> {
    if (!order.pendingPayoutCid) return "unindexed";
    return offrampLedgerOutcome(await this.policy.payoutOnLedger(order.pendingPayoutCid), order.id);
  }
}
