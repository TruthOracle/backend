import { Injectable } from "@nestjs/common";

import type { RampOrderEntity } from "../entities/ramp-order.entity";
import type { Actor } from "../types";
import { ComplianceFreezePort } from "./compliance-freeze.port";
import {
  anyFlagged,
  RampCompliancePort,
  riskEntry,
  storedDecision,
  type ComplianceContext,
  type ComplianceDecision,
  type CompliancePoint,
} from "./ramp-compliance.port";
import { RampOrderStore } from "./ramp-order-store.service";

const SYSTEM: Actor = { type: "system" };

/** Why fiat may not leave for an order now: the user is frozen, or a compliance decision holds it. */
export interface RampReleaseHold {
  reason: "frozen" | "compliance";
  detail: string;
}

/** The context of a decision about an existing order (`extra` adds the point's own data). */
export function complianceContext(
  order: RampOrderEntity,
  point: CompliancePoint,
  extra: Partial<ComplianceContext> = {},
): ComplianceContext {
  return {
    point,
    userId: order.userId,
    orderId: order.id,
    direction: order.direction,
    method: order.method,
    rail: order.payoutRail,
    fiatAmount: order.fiatAmount,
    tokenAmount: order.tokenAmount,
    currency: order.fiatCurrency,
    destination:
      order.direction !== "offramp"
        ? null
        : order.payoutRail === "bank" && order.bankAccountId
          ? { kind: "bank", bankAccountId: order.bankAccountId }
          : order.paymentMethodId
            ? { kind: "card", paymentMethodId: order.paymentMethodId }
            : null,
    ...extra,
  };
}

/**
 * The one check before fiat leaves for an order (SPEC §4.1, §9.4, I10): before MarkPaid, every card
 * refund part / OCT, an on-ramp refund, and — S6 — a bank batch inclusion, approval and the first
 * download. Order: the user frozen (S7b) → `frozen`; the point's decision (asked ONCE per order and
 * point, stored in `order.risk`) not allow → `compliance`; an earlier review / deny still held
 * (`isHeld`) → `compliance`. Returns null when the fiat may leave. Throws when a port cannot answer
 * (fail closed, I7).
 */
@Injectable()
export class RampReleaseGuard {
  constructor(
    private readonly compliance: RampCompliancePort,
    private readonly freeze: ComplianceFreezePort,
    private readonly store: RampOrderStore,
  ) {}

  /**
   * `point` = the decision this release needs (`offramp.payout` for every cash-out release); null
   * for an on-ramp refund (no point: freeze and earlier holds only).
   */
  async hold(
    order: RampOrderEntity,
    point: CompliancePoint | null = order.direction === "offramp" ? "offramp.payout" : null,
  ): Promise<RampReleaseHold | null> {
    if (await this.freeze.isFrozen(order.userId))
      return { reason: "frozen", detail: "the account is frozen" };
    if (point) {
      // A fresh review / deny holds at once (fail closed even if the alert is not visible yet);
      // a stored one holds while the port says so.
      const fresh = storedDecision(order.risk, point) === null;
      const decision = await this.decide(order, point, {});
      if (fresh && decision.decision !== "allow")
        return { reason: "compliance", detail: `${point}: ${decision.decision}` };
    }
    if (anyFlagged(order.risk) && (await this.compliance.isHeld(order.id)))
      return { reason: "compliance", detail: "a compliance review holds the order" };
    return null;
  }

  /**
   * The point's decision for the order: the stored one, else ask the port once and store it
   * (`order.risk[point]`, a version-bump write; a lost CAS only means it is asked again later).
   */
  async decide(
    order: RampOrderEntity,
    point: CompliancePoint,
    extra: Partial<ComplianceContext>,
  ): Promise<ComplianceDecision> {
    const stored = storedDecision(order.risk, point);
    if (stored) return stored;
    const decision = await this.compliance.check(point, complianceContext(order, point, extra));
    await this.store.bump(
      order,
      { risk: { ...(order.risk ?? {}), [point]: riskEntry(decision) } },
      { actor: SYSTEM, detail: `compliance ${point}: ${decision.decision}` },
    );
    return decision;
  }

  /** Is the account frozen (S7b)? */
  isFrozen(userId: string): Promise<boolean> {
    return this.freeze.isFrozen(userId);
  }

  /** Does an earlier decision still hold the order (S7a)? */
  async isHeld(order: RampOrderEntity): Promise<boolean> {
    return anyFlagged(order.risk) && this.compliance.isHeld(order.id);
  }

  /**
   * C25: did AML decide `return` on an alert of this order? A cash-out is then never paid out —
   * a hold that never lifts by itself (the bank batches ask it at every step).
   */
  returnRequested(order: Pick<RampOrderEntity, "id">): Promise<boolean> {
    return this.compliance.returnRequested(order.id);
  }
}
