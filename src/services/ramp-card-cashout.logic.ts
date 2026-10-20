/**
 * Card cash-out by refunds (SPEC §9.3, #13) — the pure rules, unit-tested in
 * ramp-card-cashout.logic.spec.ts. A cash-out of P to a card is split into PARTS: partial refunds
 * of that card's own on-ramp captures, oldest first, each at most what its capture can still
 * refund (C − refunded − what OTHER in-flight cash-outs already planned on it), and only captures
 * younger than min(RAMP_CARD_REFUND_MAX_DAYS, the acquirer's limit). The order's own parts are
 * never counted against it (#13 a).
 */
import { DAY_MS } from "../util/time";

/** A card on-ramp capture a cash-out may refund. Amounts in 1e-10 units. */
export interface RefundableCapture {
  onrampOrderId: string;
  /** The acquirer's payment id (refunds go to it). */
  paymentId: string;
  capturedAt: Date;
  /** C. */
  captured: bigint;
  /** Σ refunds already executed and recorded on this capture (`refunded_amount`). */
  refunded: bigint;
  /** Σ planned or in-flight parts of OTHER cash-outs on this capture. */
  reserved: bigint;
}

/**
 * One part's life: `planned` (reserved, never sent) → `pending` (written BEFORE the refund call:
 * the acquirer may hold it) → `succeeded` (recorded with the on-ramp's refunded_amount) or
 * `failed` (the acquirer refused it, definitively); `void` = abandoned unsent by an operator's
 * reverse_remainder.
 */
export type CardCashoutPartStatus = "planned" | "pending" | "succeeded" | "failed" | "void";

/** `details.cardPayout.parts[]` (amounts as 10-dp strings: jsonb has no bigint). */
export interface CardCashoutPart {
  paymentId: string;
  onrampOrderId: string;
  amount: string;
  /** `cashout-<offrampId>-<onrampId>`: the merchant key the refund is created and found under. */
  key: string;
  status: CardCashoutPartStatus;
  refundId?: string | null;
  /** The acquirer's fee for this refund, when it charged one (10-dp string). */
  fee?: string | null;
  at?: string;
}

/** `details.cardPayout`. */
export interface CardPayoutDetail {
  mode: "refund" | "oct";
  parts: CardCashoutPart[];
}

export function cashoutPartKey(offrampOrderId: string, onrampOrderId: string): string {
  return `cashout-${offrampOrderId}-${onrampOrderId}`;
}

/** Captures a refund may still reach: inside the refund window. */
export function refundWindowStart(now: Date, maxDays: number): Date {
  return new Date(now.getTime() - maxDays * DAY_MS);
}

/** What one capture can still give (never negative). */
export function remainingRefundable(c: RefundableCapture): bigint {
  const left = c.captured - c.refunded - c.reserved;
  return left > 0n ? left : 0n;
}

/** available(card) = Σ remaining refundable of its captures inside the window (#13). */
export function cardAvailable(
  captures: readonly RefundableCapture[],
  now: Date,
  maxDays: number,
): bigint {
  const start = refundWindowStart(now, maxDays).getTime();
  return captures
    .filter((c) => c.capturedAt.getTime() >= start)
    .reduce((sum, c) => sum + remainingRefundable(c), 0n);
}

/**
 * The parts paying `amount` to the card: oldest capture first, each ≤ its remaining refundable,
 * captures inside the window only. null when the card cannot take `amount` now.
 */
export function planCardRefunds(input: {
  offrampOrderId: string;
  amount: bigint;
  captures: readonly RefundableCapture[];
  now: Date;
  maxDays: number;
  format: (units: bigint) => string;
}): CardCashoutPart[] | null {
  if (input.amount <= 0n) return null;
  const start = refundWindowStart(input.now, input.maxDays).getTime();
  const ordered = [...input.captures]
    .filter((c) => c.capturedAt.getTime() >= start)
    .sort(
      (a, b) =>
        a.capturedAt.getTime() - b.capturedAt.getTime() ||
        a.onrampOrderId.localeCompare(b.onrampOrderId),
    );
  const parts: CardCashoutPart[] = [];
  let left = input.amount;
  for (const c of ordered) {
    if (left === 0n) break;
    const take = remainingRefundable(c) < left ? remainingRefundable(c) : left;
    if (take <= 0n) continue;
    parts.push({
      paymentId: c.paymentId,
      onrampOrderId: c.onrampOrderId,
      amount: input.format(take),
      key: cashoutPartKey(input.offrampOrderId, c.onrampOrderId),
      status: "planned",
    });
    left -= take;
  }
  return left === 0n ? parts : null;
}

/** Σ of the parts in `statuses`. */
export function partsTotal(
  parts: readonly CardCashoutPart[],
  statuses: readonly CardCashoutPartStatus[],
  parse: (s: string) => bigint,
): bigint {
  return parts
    .filter((p) => statuses.includes(p.status))
    .reduce((sum, p) => sum + parse(p.amount), 0n);
}

/** `details.cardPayout` as stored, or null when absent / malformed. */
export function cardPayoutOf(
  details: Record<string, unknown> | null | undefined,
): CardPayoutDetail | null {
  const raw = details?.cardPayout as Partial<CardPayoutDetail> | undefined;
  if (!raw || (raw.mode !== "refund" && raw.mode !== "oct") || !Array.isArray(raw.parts))
    return null;
  return { mode: raw.mode, parts: raw.parts };
}

/** The planned or in-flight parts of one cash-out (an off-ramp to the card, not terminal). */
export interface CashoutInFlight {
  offrampOrderId: string;
  parts: readonly CardCashoutPart[];
}

/** Parts that hold capacity on a capture: not sent yet, or possibly at the acquirer. */
export const RESERVING_PARTS: readonly CardCashoutPartStatus[] = ["planned", "pending"];

/**
 * Σ reserving parts per on-ramp of every cash-out EXCEPT `excludeOrderId` — the order's own parts
 * never reduce what it may take (#13 a); every other in-flight cash-out does (#13).
 */
export function reservedByOthers(
  inFlight: readonly CashoutInFlight[],
  excludeOrderId: string | null,
  parse: (s: string) => bigint,
): Map<string, bigint> {
  const reserved = new Map<string, bigint>();
  for (const c of inFlight) {
    if (c.offrampOrderId === excludeOrderId) continue;
    for (const p of c.parts) {
      if (!RESERVING_PARTS.includes(p.status)) continue;
      reserved.set(p.onrampOrderId, (reserved.get(p.onrampOrderId) ?? 0n) + parse(p.amount));
    }
  }
  return reserved;
}

/** The captures with their `reserved` filled in from `reserved` (by on-ramp id). */
export function withReservations(
  captures: readonly Omit<RefundableCapture, "reserved">[],
  reserved: ReadonlyMap<string, bigint>,
): RefundableCapture[] {
  return captures.map((c) => ({ ...c, reserved: reserved.get(c.onrampOrderId) ?? 0n }));
}
