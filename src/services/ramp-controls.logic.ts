/**
 * Pure rules of the ramp controls (SPEC §6): run status, unknown → red escalation, the halt map,
 * the reserve gate's formula and the payout gate's conditions. No I/O — RampReconciliationService
 * and RampGatesService feed them figures; the unit specs pin the critique's numbers (#6).
 * Amounts are bigint 1e-10 units.
 */
import type { HaltScope, ReconStatus } from "../types";

export const ALL_SCOPES: readonly HaltScope[] = ["orders", "mints", "payouts"];

/** A mints halt holds re-mints only when one of these is among its failing checks (#6 d): a re-mint never raises liabilities. */
export const TOKEN_INTEGRITY_CHECKS: readonly string[] = [
  "token_records_known",
  "token_commands_consistent",
  "supply_matches_issuance",
];

/** Reserve gate (b): no red on these in the latest full run (SPEC §6.3). */
export const RESERVE_GATE_CHECKS: readonly string[] = [
  "journal_balanced",
  "token_records_known",
  "token_commands_consistent",
  "supply_matches_issuance",
];

/** Payout gate: no red AND no unknown on these in the latest full run (SPEC §6.4, X8). */
export const PAYOUT_GATE_CHECKS: readonly string[] = [
  "token_records_known",
  "token_commands_consistent",
  "treasury_covers_in_app",
  "supply_matches_issuance",
];

const SEVERITY: Record<ReconStatus, number> = { green: 0, amber: 1, unknown: 2, red: 3 };

/** A run's status: the worst of its checks (red > unknown > amber > green); green when empty. */
export function worstStatus(statuses: readonly ReconStatus[]): ReconStatus {
  return statuses.reduce<ReconStatus>(
    (worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst),
    "green",
  );
}

/**
 * SPEC §6.2: an unreadable HALTING check for longer than `maxMin` counts as red for its scopes.
 * `since` = when the current unknown streak began (null = it starts now).
 */
export function escalateUnknown(
  check: { status: ReconStatus; haltScopes: readonly HaltScope[] },
  since: Date | null,
  now: Date,
  maxMin: number,
): { status: ReconStatus; unknownSince: string | null; escalated: boolean } {
  if (check.status !== "unknown")
    return { status: check.status, unknownSince: null, escalated: false };
  const start = since ?? now;
  const escalated =
    check.haltScopes.length > 0 && now.getTime() - start.getTime() > maxMin * 60_000;
  return { status: escalated ? "red" : "unknown", unknownSince: start.toISOString(), escalated };
}

/** The scopes a set of checks halts: the union of the haltScopes of every red one. */
export function haltScopesOf(
  checks: readonly { status: ReconStatus; haltScopes: readonly HaltScope[] }[],
): HaltScope[] {
  const out = new Set<HaltScope>();
  for (const c of checks) if (c.status === "red") for (const s of c.haltScopes) out.add(s);
  return ALL_SCOPES.filter((s) => out.has(s));
}

/** Does a `mints` halt hold this kind of mint? Re-mints wait only for a token-integrity failure (#6 d). */
export function mintsHaltHolds(
  kind: "mint" | "remint",
  halt: { haltedScopes: readonly HaltScope[]; failingChecks: readonly { name: string }[] | null },
): boolean {
  if (!halt.haltedScopes.includes("mints")) return false;
  if (kind === "mint") return true;
  return (halt.failingChecks ?? []).some((c) => TOKEN_INTEGRITY_CHECKS.includes(c.name));
}

// ───────────────────────────────────────────── reserve (SPEC §5 identities, §6.3) ─────────────

/** Journal balances (+ debit, − credit) by account. */
export type JournalBalances = Partial<Record<string, bigint>>;

export interface ReserveFigures {
  /** A = safeguard_bank + provider_clearing (debit balances). */
  assets: bigint;
  safeguardBank: bigint;
  providerClearing: bigint;
  /** Credit balances shown positive: IP, CL, PO; bank suspense counts only as a credit. */
  issuancePending: bigint;
  customerLiability: bigint;
  payoutClearing: bigint;
  bankSuspense: bigint;
}

export function reserveFigures(b: JournalBalances): ReserveFigures {
  const safeguardBank = b.safeguard_bank ?? 0n;
  const providerClearing = b.provider_clearing ?? 0n;
  const suspense = -(b.bank_suspense ?? 0n);
  return {
    assets: safeguardBank + providerClearing,
    safeguardBank,
    providerClearing,
    issuancePending: -(b.issuance_pending ?? 0n),
    customerLiability: -(b.customer_liability ?? 0n),
    payoutClearing: -(b.payout_clearing ?? 0n),
    bankSuspense: suspense > 0n ? suspense : 0n,
  };
}

/** SPEC §5's identity: client liabilities IP + CL + PO + max(0, suspense) (what reserve_covers_liabilities compares). */
export function clientLiabilities(f: ReserveFigures): bigint {
  return f.issuancePending + f.customerLiability + f.payoutClearing + f.bankSuspense;
}

/**
 * The reserve gate's (d) inequality (#6, X5): `L_after ≤ A + tolerance` with
 * `L_after = S + IP + PO + max(0, suspense) + U + Δ` — S the recorded net issuance of the
 * instrument (every source; it replaces CL so non-ramp issuance is covered too), U the unresolved
 * non-ramp mints that may still land, Δ = 0 for an on-ramp mint (its N is already in IP) and
 * T − P for a re-mint (the burn moved T out of S and P into PO; the re-mint puts T back).
 */
export function reserveAfter(input: {
  figures: ReserveFigures;
  recordedSupply: bigint;
  unresolvedNonRampMints: bigint;
  delta: bigint;
  tolerance: bigint;
}): { assets: bigint; liabilitiesAfter: bigint; headroom: bigint; ok: boolean } {
  const f = input.figures;
  const liabilitiesAfter =
    input.recordedSupply +
    f.issuancePending +
    f.payoutClearing +
    f.bankSuspense +
    input.unresolvedNonRampMints +
    input.delta;
  const headroom = f.assets + input.tolerance - liabilitiesAfter;
  return { assets: f.assets, liabilitiesAfter, headroom, ok: headroom >= 0n };
}

// ───────────────────────────────────────────── gates' reading of the latest run ──────────────

export interface RunView {
  trigger: string;
  finishedAt: Date | null;
  checks: readonly { name: string; status: ReconStatus }[];
}

/**
 * Why the latest FULL run does not let a gate pass: none, too old, unfinished, or a red (and, for
 * the payout gate, an unknown) on one of `names`. null = it passes.
 */
export function runRefusal(
  run: RunView | null,
  names: readonly string[],
  opts: { now: Date; maxAgeMin: number; refuseUnknown: boolean },
): {
  reason: "recon_missing" | "recon_stale" | "recon_red" | "recon_unknown";
  detail: string;
} | null {
  if (!run || !run.finishedAt)
    return { reason: "recon_missing", detail: "no finished full reconciliation run" };
  const ageMin = (opts.now.getTime() - run.finishedAt.getTime()) / 60_000;
  if (ageMin > opts.maxAgeMin)
    return {
      reason: "recon_stale",
      detail: `the latest full reconciliation finished ${Math.floor(ageMin)} min ago (max ${opts.maxAgeMin})`,
    };
  const red = run.checks.filter((c) => names.includes(c.name) && c.status === "red");
  if (red.length)
    return { reason: "recon_red", detail: `red: ${red.map((c) => c.name).join(", ")}` };
  if (opts.refuseUnknown) {
    const unknown = run.checks.filter((c) => names.includes(c.name) && c.status === "unknown");
    if (unknown.length)
      return {
        reason: "recon_unknown",
        detail: `unknown: ${unknown.map((c) => c.name).join(", ")}`,
      };
  }
  return null;
}
