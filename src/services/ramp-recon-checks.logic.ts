/**
 * Pure evaluators of the S4 reconciliation checks (SPEC §6.2). The services read the figures
 * (index, journal, mirror, token-app); these decide green / amber / red / unknown, so the rules
 * are unit-tested on their own. Amounts are bigint 1e-10 units; outputs carry 10-dp strings.
 */
import type { RampMethod, RampOrderStatus } from "../types";
import type { BusinessCalendar } from "../util/by-calendar";
import { formatAmount } from "../util/money";
import type { ReconCheckOutcome } from "./ramp-reconciliation.service";

/** A token-app monitor older than this makes supply_matches_issuance amber. */
export const MONITOR_STALE_SEC = 30 * 60;

// ───────────────────────────────────────────── token checks ───────────────────────────────

export interface TokenRecordLite {
  kind: "mint" | "burn";
  commandId: string | null;
  amount: bigint;
}

/** I9: every mirror record of the ramp instrument has a command row. */
export function evalRecordsKnown(input: {
  unknownRecords: TokenRecordLite[];
  /** The view is complete and fresh (the last sync pass paged everything recently). */
  complete: boolean;
  why: string | null;
}): ReconCheckOutcome {
  const n = input.unknownRecords.length;
  if (n > 0) {
    const net = input.unknownRecords.reduce(
      (s, r) => s + (r.kind === "mint" ? r.amount : -r.amount),
      0n,
    );
    return {
      status: "red",
      detail: `${n} token-app record(s) no command accounts for (I9): ${input.unknownRecords
        .slice(0, 5)
        .map((r) => `${r.kind} ${formatAmount(r.amount)} ${r.commandId ?? "(no id)"}`)
        .join("; ")}`,
      figures: { unknownRecords: n, unknownNet: formatAmount(net) },
    };
  }
  if (!input.complete) return { status: "unknown", detail: input.why ?? "token sync incomplete" };
  return {
    status: "green",
    detail: "every token-app record has a command",
    figures: { unknownRecords: 0 },
  };
}

export interface MismatchLite {
  commandId: string;
  resolvedBy: string | null;
  lastError: string | null;
}

/** How a mismatch stands: the compensation (`comp-…`) recorded / in flight / failed, or none. */
export type MismatchResolution = "resolved" | "in_flight" | "unresolved";

export function mismatchResolution(m: MismatchLite, compStatus: string | null): MismatchResolution {
  if (!m.resolvedBy) return "unresolved";
  // An approval id: the net was already right when it was resolved (S1 `compensate`).
  if (!m.resolvedBy.startsWith("comp-")) return "resolved";
  if (compStatus === "recorded") return "resolved";
  if (compStatus === "pending" || compStatus === "submitted" || compStatus === "unknown")
    return "in_flight";
  return "unresolved";
}

/** No unresolved mismatch, no command recorded twice; compensations in flight are amber. */
export function evalCommandsConsistent(input: {
  mismatches: { commandId: string; resolution: MismatchResolution }[];
  /** Rows with ≥ 2 records the sync has not flagged yet. */
  duplicates: string[];
  complete: boolean;
  why: string | null;
}): ReconCheckOutcome {
  const open = input.mismatches
    .filter((m) => m.resolution === "unresolved")
    .map((m) => m.commandId);
  const bad = [...new Set([...open, ...input.duplicates])];
  const inFlight = input.mismatches.filter((m) => m.resolution === "in_flight").length;
  const figures = {
    mismatches: input.mismatches.length,
    unresolved: bad.length,
    compensating: inFlight,
  };
  if (bad.length)
    return {
      status: "red",
      detail: `mismatched or recorded twice: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? " …" : ""}`,
      figures,
    };
  if (!input.complete)
    return { status: "unknown", detail: input.why ?? "token sync incomplete", figures };
  if (inFlight)
    return {
      status: "amber",
      detail: `${inFlight} compensation(s) waiting to be recorded`,
      figures,
    };
  return { status: "green", detail: "no unresolved mismatch", figures };
}

/** Amber: a command unresolved past RAMP_TOKEN_CONFIRM_MIN since its last POST (M9). */
export function evalCommandsConfirmed(input: {
  unresolved: { commandId: string; lastPostAt: Date | null; createdAt: Date }[];
  confirmMin: number;
  now: Date;
}): ReconCheckOutcome {
  const late = input.unresolved.filter(
    (c) =>
      input.now.getTime() - (c.lastPostAt ?? c.createdAt).getTime() > input.confirmMin * 60_000,
  );
  const figures = { unresolved: input.unresolved.length, overdue: late.length };
  if (late.length)
    return {
      status: "amber",
      detail: `unresolved for over ${input.confirmMin} min: ${late
        .slice(0, 5)
        .map((c) => c.commandId)
        .join(", ")}`,
      figures,
    };
  return { status: "green", detail: "every command resolved within the window", figures };
}

/**
 * token-app `/status` total supply (as of its `updated_at`) vs the mirror's net for records created
 * by then: above = a mint outside token-app (red); below, or a stale monitor = amber. When the
 * monitor ran after the mirror was paged, a surplus may be a record the page missed → unknown.
 */
export function evalSupply(input: {
  totalSupply: bigint | null;
  updatedAt: Date | null;
  monitorAgeSec: number | null;
  mirrorNet: bigint;
  mirrorAsOf: Date | null;
  error: string | null;
}): ReconCheckOutcome {
  if (input.totalSupply === null || !input.updatedAt)
    return {
      status: "unknown",
      detail: input.error ?? "token-app /status lists no supply for the instrument",
    };
  const figures = {
    totalSupply: formatAmount(input.totalSupply),
    mirrorNet: formatAmount(input.mirrorNet),
    updatedAt: input.updatedAt.toISOString(),
    monitorAgeSec: input.monitorAgeSec,
  };
  if (input.totalSupply > input.mirrorNet) {
    if (!input.mirrorAsOf || input.updatedAt.getTime() > input.mirrorAsOf.getTime())
      return {
        status: "unknown",
        detail:
          "supply is above the mirror, but the monitor ran after the last page; next pass decides",
        figures,
      };
    return {
      status: "red",
      detail: `token-app supply ${formatAmount(input.totalSupply)} is above our recorded net ${formatAmount(input.mirrorNet)} (a mint outside token-app)`,
      figures,
    };
  }
  if (input.monitorAgeSec !== null && input.monitorAgeSec > MONITOR_STALE_SEC)
    return {
      status: "amber",
      detail: `token-app monitor is ${input.monitorAgeSec} s old`,
      figures,
    };
  if (input.totalSupply < input.mirrorNet)
    return {
      status: "amber",
      detail: "token-app supply is below our recorded net (monitor lag?)",
      figures,
    };
  return { status: "green", detail: "supply equals the recorded net", figures };
}

// ───────────────────────────────────────────── treasury (#9 b) ────────────────────────────

/** C1: a credit-back key proven never to land that landed after all (where it shows). */
export interface LateCreditBack {
  orderId: string;
  commandId: string;
  where: "index" | "ledger";
  /** Another credit-back key of the same order landed too: T was credited twice. */
  twice: boolean;
}

/**
 * Treasury holdings vs what the treasury owes, all read at one index offset: in-app balances +
 * live PendingPayouts + market collateral + T of cash-outs whose PendingPayout our MarkPaid
 * archived while the burn has not landed. A burn still in flight makes that T ambiguous: red
 * only when holdings fall short even if every in-flight burn landed; unknown in between. C1: a
 * credit-back key proven never to land that landed after all is red when its order was credited
 * twice (another generation landed too) whatever the figures; alone it is amber — T is credited
 * once and every exit of the order re-proves the keys, but its review is a person's to settle.
 */
export function evalTreasury(input: {
  holdings: bigint;
  walletBalances: bigint;
  livePayouts: bigint;
  marketCollateral: bigint;
  pendingBurns: bigint;
  inFlightBurns: bigint;
  surplusMax: bigint | null;
  offset: number;
  lateCreditBacks?: readonly LateCreditBack[];
}): ReconCheckOutcome {
  const base =
    input.walletBalances + input.livePayouts + input.marketCollateral + input.pendingBurns;
  const max = base + input.inFlightBurns;
  const figures = {
    offset: input.offset,
    holdings: formatAmount(input.holdings),
    walletBalances: formatAmount(input.walletBalances),
    livePayouts: formatAmount(input.livePayouts),
    marketCollateral: formatAmount(input.marketCollateral),
    burnsNotLanded: formatAmount(input.pendingBurns),
    burnsInFlight: formatAmount(input.inFlightBurns),
    liabilities: formatAmount(max),
    surplus: formatAmount(input.holdings - max),
  };
  const late = input.lateCreditBacks ?? [];
  const lateFigures = { ...figures, lateCreditBacks: late.map((l) => ({ ...l })) };
  const more = late.length > 1 ? ` (and ${late.length - 1} more)` : "";
  const twice = late.find((l) => l.twice);
  if (twice)
    return {
      status: "red",
      detail: `order ${twice.orderId} was credited back twice: credit-back ${twice.commandId}, proven never to land, landed (${twice.where}) besides another generation${more}`,
      figures: lateFigures,
    };
  if (input.holdings < base)
    return {
      status: "red",
      detail: `treasury holds ${formatAmount(input.holdings)}, owes ${formatAmount(base)} (offset ${input.offset})`,
      figures: late.length ? lateFigures : figures,
    };
  if (input.holdings < max)
    return {
      status: "unknown",
      detail: "the shortfall equals burns still in flight; the next run decides",
      figures: late.length ? lateFigures : figures,
    };
  if (late.length)
    return {
      status: "amber",
      detail: `credit-back ${late[0].commandId} of order ${late[0].orderId} was proven never to land but landed (${late[0].where}): the order is credited back once; settle its review by hand${more}`,
      figures: lateFigures,
    };
  if (input.surplusMax !== null && input.holdings - max > input.surplusMax)
    return {
      status: "amber",
      detail: `surplus ${formatAmount(input.holdings - max)} above RAMP_TREASURY_SURPLUS_MAX`,
      figures,
    };
  return { status: "green", detail: "holdings cover every in-app liability", figures };
}

// ───────────────────────────────────────────── stuck orders (M8) ──────────────────────────

const STUCK_EXCLUDED: readonly RampOrderStatus[] = [
  "completed",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "chargeback",
  "needs_review",
];

/** S6 replaces it with RAMP_BANK_SETTLE_DAYS. */
export const BANK_SETTLE_DAYS_DEFAULT = 3;
const CHECKOUT_GRACE_MS = 5 * 60_000;
const CARD_REFUND_MS = 24 * 3_600_000;
/** An ERIP refund may stay pending at the acquirer up to 11 days (belarus-rails §3). */
const ERIP_REFUND_MS = 12 * 24 * 3_600_000;

/**
 * Why an order counts as stuck now (null = not stuck), per status (M8): awaiting_payment only
 * after its expiry + grace; payout_queued after 1 business day; payout_sent after the settle
 * days; refunding after a day (card) / 12 days (ERIP); minting / burning after RAMP_TOKEN_CONFIRM_MIN; anything
 * else after RAMP_STUCK_AFTER_MIN. Orders deferred on purpose (`details.hold`) are not stuck.
 */
export function stuckReason(
  order: {
    status: RampOrderStatus;
    statusChangedAt: Date;
    expiresAt: Date | null;
    held: boolean;
    method?: RampMethod | null;
  },
  ctx: {
    now: Date;
    calendar: BusinessCalendar;
    confirmMin: number;
    stuckAfterMin: number;
    bankSettleDays: number;
  },
): string | null {
  if (STUCK_EXCLUDED.includes(order.status) || order.held) return null;
  const age = ctx.now.getTime() - order.statusChangedAt.getTime();
  const minutes = (m: number): string | null =>
    age > m * 60_000 ? `${order.status} for over ${m} min` : null;
  switch (order.status) {
    case "awaiting_payment":
      return order.expiresAt && ctx.now.getTime() > order.expiresAt.getTime() + CHECKOUT_GRACE_MS
        ? "awaiting_payment past its expiry"
        : null;
    case "payout_queued":
      return ctx.calendar.businessDaysBetween(order.statusChangedAt, ctx.now) > 1
        ? "payout_queued for over 1 business day"
        : null;
    case "payout_sent":
      return ctx.calendar.businessDaysBetween(order.statusChangedAt, ctx.now) > ctx.bankSettleDays
        ? `payout_sent for over ${ctx.bankSettleDays} business days`
        : null;
    case "refunding":
      if (order.method === "erip")
        return age > ERIP_REFUND_MS ? "refunding (ERIP) for over 12 days" : null;
      return age > CARD_REFUND_MS ? "refunding (card) for over a day" : null;
    case "minting":
    case "burning":
      return minutes(ctx.confirmMin);
    default:
      return minutes(ctx.stuckAfterMin);
  }
}
