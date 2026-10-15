/**
 * Fixed-point amount arithmetic (docs/ARCHITECTURE.md §8.4, docs/TOKENS.md §2).
 *
 * Every amount inside the backend — whatever the instrument — is a `bigint` counting 1e-10 units
 * of that instrument: the scale of a Daml `Decimal`, so a value read from the ledger round-trips
 * exactly whether the token has 6 decimals (cBYN, TRO) or 10 (Canton Coin). Strings from the
 * ledger / wallet are parsed with a decimal parser, never `Number`, and the canonical wire form
 * (`formatAmount`) always emits exactly 10 decimals — what Daml's `Decimal` and the Enterprise
 * Wallet accept. The instrument's own `decimals` only matter at the edges: display, and the
 * quantisation of an amount that leaves the platform (`quantizeDown`, `formatAmountWithDecimals`).
 */

export const AMOUNT_DECIMALS = 10;
export const AMOUNT_SCALE = 10n ** BigInt(AMOUNT_DECIMALS);

/** 1e-9 units — anything at or below this is rounding noise, not a deposit. */
export const DUST = 10n;

export const ZERO = 0n;

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * Parse `"12.5"`, `"12.5000000000"`, `"-0.25"`, `".5"`, `"7"` or a finite JS number into
 * 1e-10 units. Digits beyond 10 decimals are rounded half away from zero (the ledger never
 * produces them; wallet rows carry at most 10). Throws on anything that is not a plain decimal.
 */
export function parseAmount(input: string | number | bigint): bigint {
  if (typeof input === "bigint") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input))
      throw new TypeError(`parseAmount: non-finite number ${String(input)}`);
    // toFixed avoids binary-fraction artefacts (0.1 + 0.2) and scientific notation (1e-7).
    return parseAmount(input.toFixed(AMOUNT_DECIMALS));
  }
  const raw = String(input).trim();
  const m = DECIMAL_RE.exec(raw);
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) {
    throw new TypeError(`parseAmount: not a decimal string: "${raw.slice(0, 40)}"`);
  }
  const negative = m[1] === "-";
  const whole = m[2] || "0";
  const frac = m[3] ?? "";
  let units =
    BigInt(whole) * AMOUNT_SCALE +
    BigInt((frac + "0".repeat(AMOUNT_DECIMALS)).slice(0, AMOUNT_DECIMALS));
  if (frac.length > AMOUNT_DECIMALS) {
    const nextDigit = Number(frac[AMOUNT_DECIMALS]);
    if (nextDigit >= 5) units += 1n;
  }
  return negative ? -units : units;
}

/** `null` instead of throwing — for upstream rows whose shape is not pinned. */
export function tryParseAmount(input: unknown): bigint | null {
  if (typeof input !== "string" && typeof input !== "number" && typeof input !== "bigint")
    return null;
  try {
    return parseAmount(input);
  } catch {
    return null;
  }
}

/** Format 1e-10 units as a decimal string with exactly 10 decimals (`"12.5000000000"`). */
export function formatAmount(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / AMOUNT_SCALE;
  const frac = (abs % AMOUNT_SCALE).toString().padStart(AMOUNT_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

/** An instrument's `decimals` must be a whole number within the fixed-point scale (CIP-56 tokens carry 0..10). */
export function assertDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > AMOUNT_DECIMALS) {
    throw new RangeError(
      `instrument decimals must be an integer in 0..${AMOUNT_DECIMALS}, got ${String(decimals)}`,
    );
  }
  return decimals;
}

/**
 * Truncate an amount to what an instrument with `decimals` can represent, toward zero: the part
 * below the instrument's smallest unit is dropped (never rounded up). This is what a payout or a
 * token-app call sends out — a 6-decimal token cannot settle 1e-10 units, and rounding up would
 * pay more than the wallet owes. The remainder (`amount - quantizeDown(amount, decimals)`) is the
 * dust that stays in-app. The result is still in 1e-10 units.
 */
export function quantizeDown(amount: bigint, decimals: number): bigint {
  const unit = 10n ** BigInt(AMOUNT_DECIMALS - assertDecimals(decimals));
  if (unit === 1n) return amount;
  // BigInt division truncates toward zero for both signs, which is what "the magnitude never grows" needs.
  return (amount / unit) * unit;
}

/**
 * Display / token-API form: exactly `decimals` fraction digits (none, and no decimal point, for a
 * 0-decimal instrument), after `quantizeDown`. `"12.500000"` for 6 decimals — what a CIP-56
 * registry or Cantor8's token-app expects for that instrument; the 10-dp `formatAmount` stays the
 * form for Daml commands and the wire.
 */
export function formatAmountWithDecimals(amount: bigint, decimals: number): string {
  const quantized = quantizeDown(amount, assertDecimals(decimals));
  const negative = quantized < 0n;
  const abs = negative ? -quantized : quantized;
  const whole = abs / AMOUNT_SCALE;
  if (decimals === 0) return `${negative ? "-" : ""}${whole.toString()}`;
  const frac = (abs % AMOUNT_SCALE).toString().padStart(AMOUNT_DECIMALS, "0").slice(0, decimals);
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export function addAmount(a: bigint, b: bigint): bigint {
  return a + b;
}

export function subAmount(a: bigint, b: bigint): bigint {
  return a - b;
}

/** -1 | 0 | 1 */
export function cmpAmount(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function absAmount(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function isDust(a: bigint): boolean {
  return absAmount(a) <= DUST;
}

/** Sum a list in fixed point. */
export function sumAmount(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** TypeORM column transformer for `numeric(38,10)` ↔ bigint. */
export const moneyTransformer = {
  to: (value: bigint | null | undefined): string | null =>
    value === null || value === undefined ? null : formatAmount(value),
  from: (value: string | null | undefined): bigint | null =>
    value === null || value === undefined ? null : parseAmount(value),
};
