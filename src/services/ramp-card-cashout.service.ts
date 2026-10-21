import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

import { Config } from "../config";
import type { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import { RAMP_PROVIDER, type Actor, type RampProvider, type RampRefund } from "../types";
import { formatAmount, parseAmount } from "../util/money";
import { displayPayoutReference } from "../util/payout-reference";
import {
  cardAvailable,
  cardPayoutOf,
  partsTotal,
  planCardRefunds,
  remainingRefundable,
  reservedByOthers,
  withReservations,
  type CardCashoutPart,
  type CardPayoutDetail,
  type CashoutInFlight,
  type RefundableCapture,
} from "./ramp-card-cashout.logic";
import { RampCompliancePort } from "./ramp-compliance.port";
import { RampGatesService } from "./ramp-gates.service";
import { RampJournalService } from "./ramp-journal.service";
import { RampOrderStore } from "./ramp-order-store.service";
import { RampReleaseGuard } from "./ramp-release-guard.service";
import { UserService } from "./user.service";

const SYSTEM: Actor = { type: "system" };
/** Off-ramp statuses whose parts no longer hold capacity (their unsent parts are dead). */
const TERMINAL_SQL = `('completed', 'failed', 'expired', 'cancelled', 'refunded')`;
/** The holds this engine sets on a `paying_out` order and lifts again (another kind is left alone). */
const OWN_HOLDS = new Set(["payout_gate", "compliance", "frozen"]);

/** A part the acquirer paid that its capture cannot take (C20): a person reconciles it. */
class PartNotRecordable extends Error {}

/** One part's lookups: what the acquirer holds for its key. */
export interface PartLookup {
  index: number;
  part: CardCashoutPart;
  refund: RampRefund | null;
}

/**
 * Card cash-out by partial refunds (SPEC §9.3, I5, #13; `cardCashout = refund`, bePaid's partial
 * refunds): the card's own captures pay it back, oldest first. Planned at creation (the plan
 * reserves capacity on each capture against every other cash-out), then in `paying_out` part by
 * part: the acquirer is asked for the part's key FIRST (I3); a part never created is sent only
 * after the payout gate, the freeze / compliance guard and a fresh capacity check of its capture,
 * and is marked `pending` BEFORE the call (write-ahead). A refund the acquirer confirms bumps the
 * on-ramp's `refunded_amount` by versioned CAS in the same transaction that marks the part
 * succeeded — so `explainedRefunds` never reads our own refund as an acquirer reversal. All parts
 * done → completed + `offramp.paid_card` (+ `psp.fee_accrued` when the acquirer charged refunds);
 * a part refused → needs_review(payout) (reverse / reverse_remainder are the operator's exits).
 */
@Injectable()
export class RampCardCashoutService {
  private readonly logger = new Logger(RampCardCashoutService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly store: RampOrderStore,
    @Inject(RAMP_PROVIDER) private readonly provider: RampProvider,
    private readonly journal: RampJournalService,
    private readonly gates: RampGatesService,
    private readonly release: RampReleaseGuard,
    private readonly users: UserService,
    @InjectRepository(RampPaymentMethodEntity)
    private readonly methods: Repository<RampPaymentMethodEntity>,
    private readonly compliance: RampCompliancePort,
  ) {}

  /** min(RAMP_CARD_REFUND_MAX_DAYS, the acquirer's refund window). */
  maxDays(): number {
    return Math.min(
      this.config.ramp.cardRefundMaxDays,
      this.provider.capabilities.cardRefundMaxDays,
    );
  }

  // ───────────────────────────────────────────── capacity ──────────────────────────────────

  /** The card's completed on-ramp captures inside the refund window, oldest first. */
  private async captures(
    userId: string,
    cardId: string,
  ): Promise<Omit<RefundableCapture, "reserved">[]> {
    const since = new Date(Date.now() - this.maxDays() * 86_400_000);
    const rows = await this.dataSource.query<
      { id: string; payment_id: string; captured_at: Date; captured: string; refunded: string }[]
    >(
      `SELECT id, provider_payment_id AS payment_id, captured_at, captured_amount::text AS captured,
              refunded_amount::text AS refunded
         FROM to_ramp_orders
        WHERE user_id = $1 AND direction = 'onramp' AND method = 'card' AND payment_method_id = $2
          AND provider = $3 AND status = 'completed' AND captured_amount IS NOT NULL
          AND provider_payment_id IS NOT NULL AND captured_at >= $4
        ORDER BY captured_at ASC, id ASC`,
      [userId, cardId, this.provider.name, since],
    );
    return rows.map((r) => ({
      onrampOrderId: r.id,
      paymentId: r.payment_id,
      capturedAt: new Date(r.captured_at),
      captured: parseAmount(r.captured),
      refunded: parseAmount(r.refunded),
    }));
  }

  /** The account's card cash-outs not yet terminal, with their parts. */
  private async inFlight(userId: string): Promise<CashoutInFlight[]> {
    const rows = await this.dataSource.query<{ id: string; parts: CardCashoutPart[] }[]>(
      `SELECT id, details -> 'cardPayout' -> 'parts' AS parts
         FROM to_ramp_orders
        WHERE user_id = $1 AND direction = 'offramp' AND payout_rail = 'card'
          AND status NOT IN ${TERMINAL_SQL}
          AND jsonb_typeof(details -> 'cardPayout' -> 'parts') = 'array'`,
      [userId],
    );
    return rows.map((r) => ({ offrampOrderId: r.id, parts: r.parts }));
  }

  private async reservedCaptures(
    userId: string,
    cardId: string,
    excludeOrderId: string | null,
  ): Promise<RefundableCapture[]> {
    const [captures, inFlight] = await Promise.all([
      this.captures(userId, cardId),
      this.inFlight(userId),
    ]);
    return withReservations(captures, reservedByOthers(inFlight, excludeOrderId, parseAmount));
  }

  /** available(card): what a cash-out (`excludeOrderId`: its own parts not counted) can take back now (#13). */
  async available(userId: string, cardId: string, excludeOrderId: string | null): Promise<bigint> {
    return cardAvailable(
      await this.reservedCaptures(userId, cardId, excludeOrderId),
      new Date(),
      this.maxDays(),
    );
  }

  /** The parts of a NEW cash-out of `amount` (fiat P) to the card, or null when it cannot take it. */
  async plan(
    userId: string,
    cardId: string,
    offrampOrderId: string,
    amount: bigint,
  ): Promise<CardCashoutPart[] | null> {
    return planCardRefunds({
      offrampOrderId,
      amount,
      captures: await this.reservedCaptures(userId, cardId, offrampOrderId),
      now: new Date(),
      maxDays: this.maxDays(),
      format: formatAmount,
    });
  }

  /**
   * Refunds of an on-ramp's capture we account for: `refunded_amount` + every cash-out part on it
   * that may be at the acquirer (`pending`) — in ONE statement, so a part recorded meanwhile is
   * counted exactly once (S2's open issue: the post-close poll must not read our own refund as an
   * acquirer reversal).
   */
  async explainedRefunds(onrampOrderId: string): Promise<bigint> {
    const { recorded, pending } = await this.refundsOf(onrampOrderId);
    return recorded + pending;
  }

  /**
   * The capture's `refunded_amount` and the Σ of cash-out parts pending on it, read in one
   * statement. A dispute's capture patch subtracts `pending` from the acquirer's refund total:
   * our own unrecorded parts are not the acquirer's refunds (C20).
   */
  async refundsOf(onrampOrderId: string): Promise<{ recorded: bigint; pending: bigint }> {
    const [row] = await this.dataSource.query<{ recorded: string; pending: string }[]>(
      `SELECT o.refunded_amount::text AS recorded, COALESCE((
                SELECT SUM((part ->> 'amount')::numeric)
                  FROM to_ramp_orders f,
                       jsonb_array_elements(CASE WHEN jsonb_typeof(f.details -> 'cardPayout' -> 'parts') = 'array'
                                                 THEN f.details -> 'cardPayout' -> 'parts' ELSE '[]'::jsonb END) part
                 WHERE f.user_id = o.user_id AND f.direction = 'offramp' AND f.payout_rail = 'card'
                   AND part ->> 'onrampOrderId' = o.id::text AND part ->> 'status' = 'pending'), 0)::text AS pending
         FROM to_ramp_orders o WHERE o.id = $1`,
      [onrampOrderId],
    );
    return row
      ? { recorded: parseAmount(row.recorded), pending: parseAmount(row.pending) }
      : { recorded: 0n, pending: 0n };
  }

  // ───────────────────────────────────────────── the paying_out step (refund mode) ──────────

  /**
   * One pass over a `paying_out` card cash-out in refund mode. True when the order moved on
   * (completed); false when it waits (a part at the acquirer, a hold) or went to review.
   */
  async step(order: RampOrderEntity): Promise<boolean> {
    const user = await this.users.findById(order.userId);
    if (user?.status !== "active") return this.toReview(order, "the account is not active");
    const card = order.paymentMethodId
      ? await this.methods.findOne({ where: { id: order.paymentMethodId } })
      : null;
    if (!card || card.status !== "active" || !card.payoutEligible || card.userId !== order.userId)
      return this.toReview(order, "the destination card is no longer eligible");
    let payout = cardPayoutOf(order.details);
    if (payout?.mode !== "refund" || payout.parts.length === 0) {
      // No plan stored (the mode changed after creation): plan now, against every other cash-out.
      const parts = await this.plan(order.userId, card.id, order.id, order.fiatAmount);
      if (!parts)
        return this.toReview(order, "the card's refundable remainder is short of this cash-out");
      if (!(await this.savePayout(order, { mode: "refund", parts }))) return false;
      payout = { mode: "refund", parts };
    }
    for (let index = 0; index < payout.parts.length; index += 1) {
      const part = payout.parts[index];
      if (part.status === "succeeded" || part.status === "void") continue;
      if (part.status === "failed")
        return this.toReview(order, `card refund part ${index + 1} was refused by the acquirer`);
      if ((await this.advancePart(order, index)) === "stop") return false;
      payout = cardPayoutOf(order.details) ?? payout;
    }
    if (!payout.parts.every((p) => p.status === "succeeded" || p.status === "void")) return false;
    return this.complete(order, payout, card.last4);
  }

  /** One part: look it up (I3), follow it, or — never created — send it through the gates. */
  private async advancePart(
    order: RampOrderEntity,
    index: number,
  ): Promise<"done" | "wait" | "stop"> {
    const part = (cardPayoutOf(order.details)?.parts ?? [])[index];
    if (!part) return "stop";
    let found: RampRefund | null;
    try {
      found = await this.provider.findRefund(part.paymentId, part.key);
    } catch (err) {
      await this.note(order, `refund lookup failed: ${(err as Error).message}`);
      return "stop";
    }
    if (found) return this.follow(order, index, found);
    // SPEC §6.4 / I10: no fiat leaves while the payout gate refuses or the user is held.
    const gate = await this.gates.payoutGate();
    if (!gate.ok) {
      await this.hold(order, "payout_gate", `${gate.reason}: ${gate.detail}`);
      return "stop";
    }
    const held = await this.release.hold(order);
    if (held) {
      await this.hold(order, held.reason, held.detail);
      return "stop";
    }
    // C25: AML decided this cash-out's value goes back — no further part leaves; reverse is the exit.
    if (await this.compliance.returnRequested(order.id)) {
      await this.store.review(
        order,
        ["paying_out"],
        "compliance",
        "AML decided not to pay this cash-out out",
        SYSTEM,
      );
      return "stop";
    }
    if (!(await this.unhold(order))) return "stop";
    // #13: the capture must still give this part — other cash-outs' parts reserve, ours never do.
    const amount = parseAmount(part.amount);
    const capture = (
      await this.reservedCaptures(order.userId, order.paymentMethodId ?? "", order.id)
    ).find((c) => c.onrampOrderId === part.onrampOrderId);
    if (!capture || remainingRefundable(capture) < amount) {
      await this.toReview(
        order,
        `the refundable remainder of capture ${part.onrampOrderId} is short of part ${index + 1}`,
      );
      return "stop";
    }
    // Write-ahead: `pending` before the call, so a crash or a poll counts it (explainedRefunds).
    if (
      !(await this.savePart(order, index, {
        ...part,
        status: "pending",
        at: new Date().toISOString(),
      }))
    )
      return "stop";
    try {
      await this.provider.refundPayment(
        part.paymentId,
        amount,
        part.key,
        displayPayoutReference(order.payoutReference),
      );
    } catch (err) {
      await this.attemptFailed(order, err);
      return "stop";
    }
    // The acquirer API decides (I2): read the refund back for its status and fee.
    try {
      found = await this.provider.findRefund(part.paymentId, part.key);
    } catch (err) {
      await this.note(order, `refund lookup failed: ${(err as Error).message}`);
      return "wait";
    }
    return found ? this.follow(order, index, found) : "wait";
  }

  private async follow(
    order: RampOrderEntity,
    index: number,
    refund: RampRefund,
  ): Promise<"done" | "wait" | "stop"> {
    const part = (cardPayoutOf(order.details)?.parts ?? [])[index];
    if (!part) return "stop";
    if (refund.status === "succeeded")
      return (await this.partSucceeded(order, index, refund)) ? "done" : "stop";
    if (refund.status === "failed") {
      await this.toReview(
        order,
        `card refund part ${index + 1} was refused by the acquirer`,
        {
          ...part,
          status: "failed",
          refundId: refund.refundId,
        },
        index,
      );
      return "stop";
    }
    if (part.status !== "pending" || part.refundId !== refund.refundId)
      await this.savePart(order, index, { ...part, status: "pending", refundId: refund.refundId });
    return "wait";
  }

  /**
   * The acquirer confirmed a part: ONE transaction bumps the on-ramp's `refunded_amount` (versioned
   * CAS on the locked row) and marks the part succeeded — a refund is never counted twice nor lost.
   */
  private async partSucceeded(
    order: RampOrderEntity,
    index: number,
    refund: RampRefund,
  ): Promise<boolean> {
    const payout = cardPayoutOf(order.details);
    const part = payout?.parts[index];
    if (!payout || !part) return false;
    const amount = parseAmount(part.amount);
    if (refund.amount !== amount || refund.currency !== order.fiatCurrency) {
      await this.toReview(order, `card refund part ${index + 1} was executed for another amount`);
      return false;
    }
    const parts = payout.parts.map((p, i) =>
      i === index
        ? {
            ...p,
            status: "succeeded" as const,
            refundId: refund.refundId,
            fee: refund.fee !== null ? formatAmount(refund.fee) : null,
            at: new Date().toISOString(),
          }
        : p,
    );
    try {
      await this.dataSource.transaction(async (m) => {
        const onramp = await this.store.lockForUpdate(m, part.onrampOrderId);
        if (!onramp || onramp.capturedAmount === null)
          throw new PartNotRecordable("the on-ramp is gone");
        const refunded = onramp.refundedAmount + amount;
        if (refunded > onramp.capturedAmount)
          throw new PartNotRecordable("the refunds would exceed the capture");
        const won =
          (await this.store.bump(
            onramp,
            { refundedAmount: refunded },
            {
              actor: SYSTEM,
              manager: m,
              detail: `card cash-out ${order.id} part ${index + 1}`,
            },
          )) &&
          (await this.store.bump(
            order,
            {},
            {
              actor: SYSTEM,
              manager: m,
              details: { cardPayout: { ...payout, parts } },
            },
          ));
        if (!won) throw new Error("an order changed meanwhile");
      });
    } catch (err) {
      this.logger.warn(
        `order ${order.id}: recording part ${index + 1} failed: ${(err as Error).message}`,
      );
      // The transaction rolled back; the entities may carry its writes: re-read before anything else.
      const fresh = await this.store.find(order.id);
      if (fresh) Object.assign(order, fresh);
      // C20: a paid part its capture cannot take never loops silently in paying_out: a person
      // reconciles it (a lost CAS or a database hiccup is retried by the next pass instead).
      if (err instanceof PartNotRecordable && order.status === "paying_out")
        await this.toReview(
          order,
          `card refund part ${index + 1} was paid but cannot be recorded on ${part.onrampOrderId}: ${err.message}`,
        );
      return false;
    }
    return true;
  }

  /** Every part paid: completed + `offramp.paid_card` (+ the acquirer's refund fees, when it charged any). */
  private async complete(
    order: RampOrderEntity,
    payout: CardPayoutDetail,
    last4: string | null,
  ): Promise<boolean> {
    const fees = payout.parts.reduce((s, p) => s + (p.fee ? parseAmount(p.fee) : 0n), 0n);
    return this.store.transition(
      order,
      ["paying_out"],
      "completed",
      { attempts: 0, lastError: null },
      {
        actor: SYSTEM,
        detail: `card cash-out refunded in ${payout.parts.length} part(s)`,
        details: {
          payout: { mode: "refund", cardLast4: last4, executedAt: new Date().toISOString() },
        },
        within: async (m, fresh) => {
          await this.journal.post(m, fresh, "offramp.paid_card");
          if (fees > 0n) await this.journal.post(m, fresh, "psp.fee_accrued", fees);
        },
      },
    );
  }

  // ───────────────────────────────────────────── the operator's exits ──────────────────────

  /**
   * Every part's standing at the acquirer (lookups by key, I3) for `reverse` / `reverse_remainder`
   * (SPEC §4.2): `paid` = Σ confirmed parts, `unpaid` = Σ parts definitively not paid (refused, or
   * never created), `inFlight` = parts the acquirer still processes. Throws when it cannot ask.
   */
  async standing(
    order: RampOrderEntity,
  ): Promise<{ paid: bigint; unpaid: bigint; inFlight: number; parts: PartLookup[] }> {
    const payout = cardPayoutOf(order.details);
    const parts: PartLookup[] = [];
    let paid = 0n;
    let unpaid = 0n;
    let inFlight = 0;
    for (const [index, part] of (payout?.parts ?? []).entries()) {
      const amount = parseAmount(part.amount);
      if (part.status === "void") continue;
      const refund =
        part.status === "succeeded"
          ? null
          : await this.provider.findRefund(part.paymentId, part.key);
      parts.push({ index, part, refund });
      if (part.status === "succeeded" || refund?.status === "succeeded") paid += amount;
      else if (!refund || refund.status === "failed") unpaid += amount;
      else inFlight += 1;
    }
    return { paid, unpaid, inFlight, parts };
  }

  /** Is this a refund-mode card cash-out (it has a plan)? */
  isRefundMode(order: RampOrderEntity): boolean {
    return cardPayoutOf(order.details)?.mode === "refund";
  }

  /** The parts total by status (10-dp strings parsed). */
  total(order: RampOrderEntity, statuses: CardCashoutPart["status"][]): bigint {
    return partsTotal(cardPayoutOf(order.details)?.parts ?? [], statuses, parseAmount);
  }

  // ───────────────────────────────────────────── writes ────────────────────────────────────

  private async savePayout(order: RampOrderEntity, payout: CardPayoutDetail): Promise<boolean> {
    return this.store.bump(order, {}, { actor: SYSTEM, details: { cardPayout: payout } });
  }

  private async savePart(
    order: RampOrderEntity,
    index: number,
    part: CardCashoutPart,
  ): Promise<boolean> {
    const payout = cardPayoutOf(order.details);
    if (!payout) return false;
    return this.savePayout(order, {
      ...payout,
      parts: payout.parts.map((p, i) => (i === index ? part : p)),
    });
  }

  /** needs_review(payout) — with the part's new state in the same write when given. */
  private async toReview(
    order: RampOrderEntity,
    reason: string,
    part?: CardCashoutPart,
    index?: number,
  ): Promise<false> {
    const payout = cardPayoutOf(order.details);
    const details =
      part && payout && index !== undefined
        ? { cardPayout: { ...payout, parts: payout.parts.map((p, i) => (i === index ? part : p)) } }
        : {};
    await this.store.review(order, ["paying_out"], "payout", reason, SYSTEM, {}, { details });
    return false;
  }

  /** SPEC §6.4 / I10: the step waits (`details.hold`); a hold of another kind is left alone. */
  private async hold(order: RampOrderEntity, reason: string, detail: string): Promise<void> {
    const current = order.details?.hold as { reason?: string } | null | undefined;
    if (current && (!OWN_HOLDS.has(current.reason ?? "") || current.reason === reason)) return;
    await this.store.bump(
      order,
      { lastError: `${reason}:${detail}`.slice(0, 800) },
      { actor: SYSTEM, details: { hold: { reason, detail, at: new Date().toISOString() } } },
    );
  }

  /** The gates pass again: lift our hold (false = the order moved meanwhile, or a foreign hold stays). */
  private async unhold(order: RampOrderEntity): Promise<boolean> {
    const current = order.details?.hold as { reason?: string } | null | undefined;
    if (!current) return true;
    if (!OWN_HOLDS.has(current.reason ?? "")) return false;
    return this.store.bump(
      order,
      { lastError: null },
      {
        actor: SYSTEM,
        details: {
          hold: null,
          holdEndedAt: new Date().toISOString(),
          holdEndedReason: current.reason,
        },
      },
    );
  }

  /** A refund call failed: count it; at RAMP_MAX_ATTEMPTS the order goes to review (SPEC §4.1). */
  private async attemptFailed(order: RampOrderEntity, err: unknown): Promise<void> {
    const attempts = await this.store.recordAttempt(order, err);
    this.logger.warn(
      `order ${order.id}: card refund attempt ${attempts} failed: ${(err as Error).message}`,
    );
    if (attempts >= this.config.ramp.maxAttempts && order.status === "paying_out")
      await this.toReview(
        order,
        `a card refund failed ${attempts} times: ${(err as Error).message}`,
      );
  }

  /** A read failed: say why on the order, count nothing (fail closed, I7). */
  private async note(order: RampOrderEntity, message: string): Promise<void> {
    await this.store.bump(order, { lastError: message.slice(0, 800) }, { actor: SYSTEM });
  }
}
