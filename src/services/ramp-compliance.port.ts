import { Injectable, Logger } from "@nestjs/common";
import type { EntityManager } from "typeorm";

import type {
  ComplianceAlertSeverity,
  RampDirection,
  RampMethod,
  RampPayer,
  RampPayoutRail,
} from "../types";

/**
 * The ramp's compliance port (SPEC §9.4, §11; owner: S7a). The ramp asks it — and only it —
 * whether an account may use the ramp (`eligibility`, `consent`) and what to do at each value
 * point (`check`), whether an earlier decision still holds an order (`isHeld`), and raises
 * alerts other stages detect (`raise`, e.g. S6's TM-SHAREDIBAN, S7b's TM-LIST). Every call site is
 * in place (S5). Implementation: `ComplianceRulesService` binds itself when RAMP_COMPLIANCE=on
 * (off-prod `off` keeps the default: everything allowed, nothing held, no alert).
 *
 * Contract for the implementation:
 * - `eligibility` answers INTERNAL codes; the ramp shows `kyc_required`, `consent_required` and
 *   `additional_info_required` as they are and every other code as the neutral `compliance` (X6, M3).
 * - `check` is asked ONCE per order and point; the ramp stores the decision in `order.risk[point]`
 *   and later asks `isHeld(orderId)` until the AML decision clears it (§11.5). At the create points
 *   `ctx.orderId` is the id the order WILL get: its row does not exist yet (and never will on deny),
 *   so alerts must not reference it by foreign key.
 * - `deny` only for eligibility failures, sanctions, freezes and list hits (the create is refused
 *   neutrally); `review` never refuses — the value point holds instead.
 * - An unreadable source throws (fail closed, I7): the step stops and retries.
 * - C28: the ramp asks a create point through `checkCreate`, which raises nothing; the order's
 *   insert transaction then raises the decision's alerts (`recordCreate`), so an alert exists only
 *   for an order that exists (a refused or raced create rolls them back with it).
 * - C25: `returnRequested(orderId)` — AML decided `return` on an alert of the order: once nothing
 *   holds it (`isHeld` false) the ramp gives the payment back (refund / refund_bank), never mints
 *   or pays it out.
 */

/** Where the ramp asks for a decision (SPEC §9.4). */
export const COMPLIANCE_POINTS = [
  "onramp.create",
  "onramp.capture",
  "offramp.create",
  "offramp.payout",
] as const;
export type CompliancePoint = (typeof COMPLIANCE_POINTS)[number];

export type ComplianceVerdict = "allow" | "review" | "deny";
const VERDICTS: readonly string[] = ["allow", "review", "deny"];

export interface ComplianceDecision {
  decision: ComplianceVerdict;
  /** Rule ids that fired (TM-STRUCT, TM-CASH, …). */
  rules: string[];
  /** Alerts raised for this decision. */
  alertIds: string[];
}

/** What one decision is about. Amounts in 1e-10 units. */
export interface ComplianceContext {
  point: CompliancePoint;
  userId: string;
  orderId: string;
  direction: RampDirection;
  method: RampMethod | null;
  rail: RampPayoutRail | null;
  /** On-ramp: F charged (C at capture). Off-ramp: P paid out. */
  fiatAmount: bigint;
  /** On-ramp: N minted. Off-ramp: T withdrawn. */
  tokenAmount: bigint;
  currency: string;
  /** `onramp.capture`: who paid (the name is plaintext in memory only; ERIP channel / payer data, X14). */
  payer?: RampPayer | null;
  /** `onramp.capture`: the card that paid and its issuer country (TM-CARDS). */
  paymentMethodId?: string | null;
  cardIssuerCountry?: string | null;
  /** Off-ramp: where the fiat goes. */
  destination?:
    { kind: "card"; paymentMethodId: string } | { kind: "bank"; bankAccountId: string } | null;
}

export interface RampEligibilityAnswer {
  allowed: boolean;
  /** Internal codes (e.g. `consent_required`, `kyc_refresh_required`, `vendor_sanctions`, `frozen`). */
  reasons: string[];
}

/** Consent for the current RAMP_TERMS_VERSION (§11.2): every order stores the consent it was made under. */
export interface RampConsentAnswer {
  required: boolean;
  consentId: string | null;
}

/** C28: an alert a create decision rests on, raised with its order (`recordCreate`). */
export interface PendingAlert {
  userId: string;
  rule: string;
  severity: ComplianceAlertSeverity;
  point: CompliancePoint;
  orderId: string;
  figures: Record<string, unknown>;
  windowKey: string;
  /** The base value the thresholds used (1e-10 units). */
  bv: bigint | null;
}

/** C28: a decision whose alerts are not raised yet (`alertIds` empty until `recordCreate`). */
export interface CreateDecision extends ComplianceDecision {
  pending: PendingAlert[];
}

/** What S7a implements. */
export interface RampComplianceImpl {
  eligibility(userId: string): Promise<RampEligibilityAnswer>;
  consent(userId: string): Promise<RampConsentAnswer>;
  check(point: CompliancePoint, ctx: ComplianceContext): Promise<ComplianceDecision>;
  isHeld(orderId: string): Promise<boolean>;
  /** Raise an alert detected outside a check (returns its id, or null when deduplicated). */
  raise(rule: string, userId: string, figures: Record<string, unknown>): Promise<string | null>;
  /** C28: the decision without raising its alerts (default: `check`, which raises them at once). */
  checkCreate?(point: CompliancePoint, ctx: ComplianceContext): Promise<CreateDecision>;
  /** C28: raise pending alerts inside `manager`'s transaction; their ids, in order. */
  recordCreate?(pending: readonly PendingAlert[], manager: EntityManager): Promise<string[]>;
  /** C25: did AML decide `return` on an alert of this order (default: false)? */
  returnRequested?(orderId: string): Promise<boolean>;
}

/** One stored decision (`to_ramp_orders.risk[point]`). */
export interface ComplianceRiskEntry extends ComplianceDecision {
  at: string;
}

export const ALLOW: ComplianceDecision = { decision: "allow", rules: [], alertIds: [] };

export function riskEntry(decision: ComplianceDecision, at = new Date()): ComplianceRiskEntry {
  return {
    decision: decision.decision,
    rules: [...decision.rules],
    alertIds: [...decision.alertIds],
    at: at.toISOString(),
  };
}

/** The stored decision of `point`, if any. */
export function storedDecision(
  risk: Record<string, unknown> | null | undefined,
  point: CompliancePoint,
): ComplianceRiskEntry | null {
  const entry = risk?.[point] as Partial<ComplianceRiskEntry> | undefined;
  if (!entry || typeof entry.decision !== "string") return null;
  return {
    // Anything but a known verdict reads as review (fail closed).
    decision: VERDICTS.includes(entry.decision) ? entry.decision : "review",
    rules: Array.isArray(entry.rules) ? entry.rules : [],
    alertIds: Array.isArray(entry.alertIds) ? entry.alertIds : [],
    at: typeof entry.at === "string" ? entry.at : "",
  };
}

/** Did any stored decision of the order say review or deny? */
export function anyFlagged(risk: Record<string, unknown> | null | undefined): boolean {
  return COMPLIANCE_POINTS.some((p) => {
    const d = storedDecision(risk, p);
    return d !== null && d.decision !== "allow";
  });
}

@Injectable()
export class RampCompliancePort implements RampComplianceImpl {
  private readonly logger = new Logger(RampCompliancePort.name);
  /** Bound implementations, the last one answering (the service at boot, a test stub layered over it). */
  private impls: RampComplianceImpl[] = [];

  /** Install an implementation (from its `onModuleInit`); returns the unbind, which restores the one below. */
  bind(impl: RampComplianceImpl): () => void {
    if (this.impls.includes(impl))
      throw new Error("this compliance implementation is already bound");
    if (this.impls.length > 0)
      this.logger.warn("compliance implementation layered over the bound one");
    this.impls.push(impl);
    this.logger.log("compliance implementation bound");
    return () => {
      this.impls = this.impls.filter((i) => i !== impl);
    };
  }

  get bound(): boolean {
    return this.impls.length > 0;
  }

  private get impl(): RampComplianceImpl | null {
    return this.impls[this.impls.length - 1] ?? null;
  }

  eligibility(userId: string): Promise<RampEligibilityAnswer> {
    return this.impl
      ? this.impl.eligibility(userId)
      : Promise.resolve({ allowed: true, reasons: [] });
  }

  consent(userId: string): Promise<RampConsentAnswer> {
    return this.impl
      ? this.impl.consent(userId)
      : Promise.resolve({ required: false, consentId: null });
  }

  check(point: CompliancePoint, ctx: ComplianceContext): Promise<ComplianceDecision> {
    return this.impl ? this.impl.check(point, ctx) : Promise.resolve({ ...ALLOW });
  }

  isHeld(orderId: string): Promise<boolean> {
    return this.impl ? this.impl.isHeld(orderId) : Promise.resolve(false);
  }

  raise(rule: string, userId: string, figures: Record<string, unknown>): Promise<string | null> {
    return this.impl ? this.impl.raise(rule, userId, figures) : Promise.resolve(null);
  }

  /** C28: a create point's decision; its alerts wait for the order's insert (`recordCreate`). */
  async checkCreate(point: CompliancePoint, ctx: ComplianceContext): Promise<CreateDecision> {
    const impl = this.impl;
    if (impl?.checkCreate) return impl.checkCreate(point, ctx);
    // A stub that answers nothing allows (as the ramp read `check` before C28).
    return { ...((await this.check(point, ctx)) ?? ALLOW), pending: [] };
  }

  /** C28: raise `pending` in the order's insert transaction (`manager`); their ids. */
  async recordCreate(pending: readonly PendingAlert[], manager: EntityManager): Promise<string[]> {
    if (pending.length === 0) return [];
    const impl = this.impl;
    // Fail closed: a decision with alerts must never create its order without them.
    if (!impl?.recordCreate)
      throw new Error("compliance alerts are pending but no implementation records them");
    return impl.recordCreate(pending, manager);
  }

  /**
   * C25: AML decided `return` on an alert of this order — once `isHeld` is false the ramp moves it
   * to needs_review(refund) and allows refund / refund_bank only; it never mints or pays it out.
   */
  returnRequested(orderId: string): Promise<boolean> {
    const impl = this.impl;
    return impl?.returnRequested ? impl.returnRequested(orderId) : Promise.resolve(false);
  }
}
