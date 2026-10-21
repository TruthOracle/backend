/**
 * The pure parts of compliance (SPEC §11.3–§11.6; S7a): the rule catalogue, legal due dates in
 * Belarusian business days, ages, BV thresholds, the third-party name test and the eligibility
 * reasons. No I/O: `ComplianceRulesService` gathers the facts and calls these.
 */
import type { ComplianceConfig, ComplianceRulesConfig } from "../config";
import type { ComplianceAlertSeverity } from "../types";
import { type BusinessCalendar, minskDate } from "../util/by-calendar";
import { formatAmount } from "../util/money";
import { nameKeys, nameTokenKeys } from "../util/name-fold";
import type { VerifiedIdentity, VerifiedName } from "./kyc-identity.port";

/**
 * When an alert must be decided (ПВК pp.73–75, Law 165 art.6): `same_day` — a refusal or a freeze,
 * end of the same business day; `next_day` — a suspicious operation, the next business day;
 * `series` — same-type operations, 9 business days after the analysis month; `none` — info.
 */
export type AlertDue = "same_day" | "next_day" | "series" | "none";

export interface RuleDefinition {
  severity: ComplianceAlertSeverity;
  due: AlertDue;
  /** What raised it when not a value point. */
  point?: string;
}

/** Every rule an alert can carry (SPEC §11.4, §11.6). Unknown rules raised by other stages: review, next day. */
export const RULE_CATALOGUE: Readonly<Record<string, RuleDefinition>> = {
  "TM-STRUCT": { severity: "review", due: "series" },
  "TM-AGE": { severity: "review", due: "series" },
  "TM-THIRDPARTY": { severity: "review", due: "next_day" },
  payer_unverified: { severity: "review", due: "next_day" },
  "TM-CASH": { severity: "review", due: "next_day" },
  "TM-ROUNDTRIP": { severity: "review", due: "series" },
  "TM-NETOUT": { severity: "review", due: "series" },
  "TM-CARDS": { severity: "review", due: "series" },
  "TM-SHAREDIBAN": { severity: "review", due: "next_day", point: "bank_account" },
  "TM-PRINCIPAL": { severity: "block", due: "same_day", point: "consent" },
  "TM-PEP": { severity: "block", due: "same_day", point: "consent" },
  "TM-SANCTIONS": { severity: "block", due: "same_day" },
  "TM-LIST": { severity: "block", due: "same_day", point: "screening" },
  "TM-FROZEN-ACTIVITY": { severity: "block", due: "same_day", point: "ledger" },
  // A value point reached while the account fails eligibility (an expired document, a vendor PEP
  // flag, a pending screening …): the money holds until AML decides (S7a; not a ПВК indicator).
  // Raised as `block` instead when a reason needs four eyes (PEP, principal, open block; C26).
  "TM-INELIGIBLE": { severity: "review", due: "next_day" },
};

export function ruleDefinition(rule: string): RuleDefinition {
  return RULE_CATALOGUE[rule] ?? { severity: "review", due: "next_day" };
}

/** The due kind of an alert of `severity` under `rule` (info never has one; block is a refusal). */
export function dueKind(rule: string, severity: ComplianceAlertSeverity): AlertDue {
  if (severity === "info") return "none";
  if (severity === "block") return "same_day";
  return ruleDefinition(rule).due;
}

/** The last calendar day of the Minsk month of `instant`. */
function monthEnd(instant: Date): string {
  const [y, m] = minskDate(instant).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The legal deadline of an alert raised at `raisedAt` (UTC; 23:59:59 Minsk of the due business day). */
export function alertDueAt(
  kind: AlertDue,
  raisedAt: Date,
  calendar: BusinessCalendar,
): Date | null {
  switch (kind) {
    case "none":
      return null;
    case "same_day":
      return calendar.endOfBusinessDayUtc(calendar.addBusinessDays(raisedAt, 0));
    case "next_day":
      return calendar.endOfBusinessDayUtc(calendar.addBusinessDays(raisedAt, 1));
    case "series":
      return calendar.endOfBusinessDayUtc(calendar.addBusinessDays(monthEnd(raisedAt), 9));
  }
}

/**
 * The due date of an alert raised with a caller's hint (`figures.dueAt`, e.g. S7b's hit deadline):
 * the hint when it is a valid instant no later than the legal deadline, else the legal one — a hint
 * can tighten a deadline, never extend it. Info alerts have none (SPEC §11.6).
 */
export function effectiveDueAt(
  legal: Date | null,
  hint: Date | string | null | undefined,
): Date | null {
  if (legal === null || hint === null || hint === undefined) return legal;
  const at = hint instanceof Date ? hint : new Date(hint);
  if (Number.isNaN(at.getTime())) return legal;
  return at.getTime() < legal.getTime() ? at : legal;
}

// ───────────────────────────────────────────── people ─────────────────────────────────────

/** Full years from `birthDate` to `day` (both `YYYY-MM-DD`); null when the birth date is unusable. */
export function ageOn(birthDate: string | null, day: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate ?? "");
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!b || !d) return null;
  const [by, bm, bd] = b.slice(1).map(Number);
  const [dy, dm, dd] = d.slice(1).map(Number);
  let age = dy - by;
  if (dm < bm || (dm === bm && dd < bd)) age -= 1;
  return age;
}

/** ПВК p.64.12: under 21 or 60 and older. */
export function inAgeBand(age: number): boolean {
  return age < 21 || age >= 60;
}

/**
 * TM-THIRDPARTY's test (SPEC §11.4, M2): does a payer name share a surname key with ANY verified
 * name form? Every word of the payer string counts (its surname position is unknown); a verified
 * surname counts whole and per word (double-barrelled names). be / ru / Latin forms all fold to
 * shared keys (util/name-fold).
 */
export function payerMatchesIdentity(payerName: string, names: readonly VerifiedName[]): boolean {
  const payer = new Set([...nameTokenKeys(payerName).flat(), ...nameKeys(payerName)]);
  if (payer.size === 0) return false;
  return names.some((n) =>
    [...nameKeys(n.last), ...nameTokenKeys(n.last).flat()].some((k) => payer.has(k)),
  );
}

// ───────────────────────────────────────────── thresholds ────────────────────────────────

/** `count` base values in 1e-10 BYN units. */
export function bvAmount(count: number, bv: bigint): bigint {
  return BigInt(count) * bv;
}

/** One rule that fired. Figures: 10-dp strings, counts, thresholds — never PII. */
export interface RuleHit {
  rule: string;
  severity: ComplianceAlertSeverity;
  figures: Record<string, unknown>;
}

const money = (v: bigint): string => formatAmount(v);

/** TM-STRUCT (ПВК 64.5): ≥ count on-ramps in 24 h (this one included) summing ≥ pct % of the daily max. */
export function structuring(
  tm: ComplianceRulesConfig,
  f: { count: number; sum: bigint; dailyMax: bigint },
): RuleHit | null {
  if (f.count < tm.structCount) return null;
  if (f.sum * 100n < BigInt(tm.structPct) * f.dailyMax) return null;
  return {
    rule: "TM-STRUCT",
    severity: "review",
    figures: { count: f.count, sum: money(f.sum), dailyMax: money(f.dailyMax), pct: tm.structPct },
  };
}

/** TM-AGE (ПВК 64.12): under 21 or 60+ and Σ(on + off) in 30 days with this one ≥ RAMP_TM_AGE_BV. */
export function ageBand(
  tm: ComplianceRulesConfig,
  bv: bigint,
  f: { age: number | null; volume30d: bigint },
): RuleHit | null {
  if (f.age === null || !inAgeBand(f.age)) return null;
  const threshold = bvAmount(tm.ageBv, bv);
  if (f.volume30d < threshold) return null;
  return {
    rule: "TM-AGE",
    severity: "review",
    figures: {
      age: f.age,
      volume30d: money(f.volume30d),
      thresholdBv: tm.ageBv,
      threshold: money(threshold),
    },
  };
}

/** TM-THIRDPARTY (ПВК 64.13): a BANK-supplied payer name with no verified surname; review from RAMP_TM_THIRDPARTY_BV. */
export function thirdParty(
  tm: ComplianceRulesConfig,
  bv: bigint,
  f: {
    payerName: string | null;
    nameSource: string | null;
    amount: bigint;
    names: readonly VerifiedName[];
  },
): RuleHit | null {
  // Checkout cardholder names are typed by whoever pays: never evidence either way.
  if (f.nameSource !== "bank" || !f.payerName?.trim()) return null;
  if (payerMatchesIdentity(f.payerName, f.names)) return null;
  const threshold = bvAmount(tm.thirdPartyBv, bv);
  return {
    rule: "TM-THIRDPARTY",
    severity: f.amount >= threshold ? "review" : "info",
    figures: {
      amount: money(f.amount),
      thresholdBv: tm.thirdPartyBv,
      threshold: money(threshold),
      forms: f.names.length,
    },
  };
}

/** payer_unverified (X14): ERIP without a bank-supplied payer name; info below RAMP_TM_UNVERIFIED_PAYER_BV per 30 days, review from it. */
export function unverifiedPayer(
  tm: ComplianceRulesConfig,
  bv: bigint,
  f: {
    method: string | null;
    payerName: string | null;
    nameSource: string | null;
    unverified30d: bigint;
  },
): RuleHit | null {
  if (f.method !== "erip") return null;
  if (f.nameSource === "bank" && f.payerName?.trim()) return null;
  const threshold = bvAmount(tm.unverifiedPayerBv, bv);
  return {
    rule: "payer_unverified",
    severity: f.unverified30d >= threshold ? "review" : "info",
    figures: {
      unverified30d: money(f.unverified30d),
      thresholdBv: tm.unverifiedPayerBv,
      threshold: money(threshold),
    },
  };
}

/** TM-CASH (ПВК 64.19): an ERIP payment whose channel is cash — or unknown, which counts as cash (X14). */
export function cash(
  cfg: Pick<ComplianceConfig, "eripAllowCash">,
  f: { method: string | null; channel: string | null },
): RuleHit | null {
  if (f.method !== "erip") return null;
  if (f.channel !== "cash" && f.channel !== "unknown" && f.channel !== null) return null;
  return {
    rule: "TM-CASH",
    severity: cfg.eripAllowCash ? "review" : "block",
    figures: { channel: f.channel ?? "unknown" },
  };
}

/** TM-ROUNDTRIP (ПВК 64.16): on-ramps in the window ≥ RAMP_TM_ROUNDTRIP_BV with trading ≤ TRADE_PCT % of them. */
export function roundTrip(
  tm: ComplianceRulesConfig,
  bv: bigint,
  f: { onramps: bigint; trading: bigint },
): RuleHit | null {
  const threshold = bvAmount(tm.roundtripBv, bv);
  if (f.onramps < threshold || f.onramps <= 0n) return null;
  if (f.trading * 100n > BigInt(tm.roundtripTradePct) * f.onramps) return null;
  return {
    rule: "TM-ROUNDTRIP",
    severity: "review",
    figures: {
      days: tm.roundtripDays,
      onramps: money(f.onramps),
      trading: money(f.trading),
      tradePct: tm.roundtripTradePct,
      thresholdBv: tm.roundtripBv,
      threshold: money(threshold),
    },
  };
}

/** TM-NETOUT: 30-day cash-outs (this one included) − on-ramps − deposits > RAMP_TM_NETOUT_BV. */
export function netOut(
  tm: ComplianceRulesConfig,
  bv: bigint,
  f: { offramps: bigint; onramps: bigint; deposits: bigint },
): RuleHit | null {
  const threshold = bvAmount(tm.netoutBv, bv);
  const net = f.offramps - f.onramps - f.deposits;
  if (net <= threshold) return null;
  return {
    rule: "TM-NETOUT",
    severity: "review",
    figures: {
      offramps: money(f.offramps),
      onramps: money(f.onramps),
      deposits: money(f.deposits),
      net: money(net),
      thresholdBv: tm.netoutBv,
      threshold: money(threshold),
    },
  };
}

/** TM-CARDS: more distinct cards paying in 30 days (this one included) than RAMP_TM_MAX_CARDS_30D. */
export function manyCards(tm: ComplianceRulesConfig, f: { cards: number }): RuleHit | null {
  if (f.cards <= tm.maxCards30d) return null;
  return { rule: "TM-CARDS", severity: "review", figures: { cards: f.cards, max: tm.maxCards30d } };
}

// ───────────────────────────────────────────── eligibility ───────────────────────────────

/** What eligibility is decided on (SPEC §11.3). */
export interface EligibilityFacts {
  /** The verified identity; null with `unavailable` false = no approved KYC. */
  identity: VerifiedIdentity | null;
  /** The identity could not be read or refreshed (provider unreachable): fail closed (I7). */
  unavailable: boolean;
  /** Minsk calendar day of the decision. */
  today: string;
  now: Date;
  frozen: boolean;
  /** The latest consent under the current terms, and whether its declarations were cleared by AML. */
  consent: {
    actsForSelf: boolean;
    pepDeclared: boolean;
    principalCleared: boolean;
    pepCleared: boolean;
  } | null;
  /** Rules of the account's undecided block alerts outside orders (TM-PEP, TM-PRINCIPAL, TM-SANCTIONS, …). */
  openBlocks: string[];
}

/**
 * INTERNAL eligibility codes (the ramp shows `kyc_required`, `additional_info_required` for
 * `kyc_refresh_required`, and `compliance` for everything else; `consent_required` comes from
 * `consent`). Order: what the user can fix first.
 */
export function eligibilityReasons(cfg: ComplianceConfig, f: EligibilityFacts): string[] {
  const out: string[] = [];
  if (f.unavailable) return ["kyc_identity_unavailable"];
  const id = f.identity;
  if (!id) return ["kyc_required"];
  const expired = id.doc?.expiresAt ? id.doc.expiresAt < f.today : false;
  const overdue = id.refreshDueAt ? id.refreshDueAt.getTime() <= f.now.getTime() : false;
  if (expired || overdue) out.push("kyc_refresh_required");
  const age = ageOn(id.birthDate, f.today);
  if (age === null) out.push("identity_incomplete");
  else if (age < cfg.minAge) out.push("age_below_minimum");
  if (!id.residenceCountry || !cfg.allowedResidence.includes(id.residenceCountry))
    out.push("residence_not_allowed");
  if (id.citizenship && cfg.blockedCitizenships.includes(id.citizenship))
    out.push("citizenship_blocked");
  if (id.vendorPep === true) out.push("vendor_pep");
  if (id.vendorSanctions === true) out.push("vendor_sanctions");
  // Screening is S7b's alone (its subjects / hits / freezes): ComplianceFreezePort.ordersDenied,
  // asked by the policy next to this, screens the account before an order and refuses on a hit.
  if (f.consent && !f.consent.actsForSelf && !f.consent.principalCleared)
    out.push("principal_declared");
  if (f.consent?.pepDeclared && !f.consent.pepCleared) out.push("pep_declared");
  if (f.openBlocks.length > 0) out.push("compliance_alert_open");
  if (f.frozen) out.push("frozen");
  return out;
}

/**
 * Eligibility codes a VALUE point (capture, payout) leaves to their own mechanism: a freeze holds
 * through the freeze port (S7b) and lifts with it; a vendor sanctions flag raises TM-SANCTIONS.
 * Every other failing code there becomes a TM-INELIGIBLE alert on the order (review, or block for
 * VALUE_POINT_BLOCK_REASONS, C26).
 */
export const VALUE_POINT_OWN_HOLDS: ReadonlySet<string> = new Set(["frozen", "vendor_sanctions"]);

/**
 * C26: eligibility codes only a four-eyes decision may release at a value point — a PEP (art.6:
 * senior approval), a declared principal, an undecided account-level block alert. Their
 * TM-INELIGIBLE is `block` (aml + another person with `approver`), never a single-control review.
 */
export const VALUE_POINT_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "vendor_pep",
  "pep_declared",
  "principal_declared",
  "compliance_alert_open",
]);

/** The severity of a value point's TM-INELIGIBLE for these reasons (C26). */
export function ineligibleSeverity(reasons: readonly string[]): "block" | "review" {
  return reasons.some((r) => VALUE_POINT_BLOCK_REASONS.has(r)) ? "block" : "review";
}
