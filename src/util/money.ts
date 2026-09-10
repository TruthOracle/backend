/**
 * Fixed-point CC arithmetic (docs/ARCHITECTURE.md §8.4).
 *
 * CC has 10 decimals. Every amount inside the backend is a `bigint` counting 1e-10 CC units;
 * strings from the ledger / wallet are parsed with a decimal parser, never `Number`, and
 * formatting always emits exactly 10 decimals (what Daml's `Decimal` and the wallet accept).
 */

export const CC_DECIMALS = 10;
export const CC_SCALE = 10n ** BigInt(CC_DECIMALS);

/** 1e-9 CC — anything at or below this is rounding noise, not a deposit. */
export const DUST = 10n;

export const ZERO = 0n;

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * Parse `"12.5"`, `"12.5000000000"`, `"-0.25"`, `".5"`, `"7"` or a finite JS number into
 * 1e-10 units. Digits beyond 10 decimals are rounded half away from zero (the ledger never
 * produces them; wallet rows carry at most 10). Throws on anything that is not a plain decimal.
 */
export function parseCC(input: string | number | bigint): bigint {
  if (typeof input === "bigint") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError(`parseCC: non-finite number ${String(input)}`);
    // toFixed avoids binary-fraction artefacts (0.1 + 0.2) and scientific notation (1e-7).
    return parseCC(input.toFixed(CC_DECIMALS));
  }
  const raw = String(input).trim();
  const m = DECIMAL_RE.exec(raw);
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) {
    throw new TypeError(`parseCC: not a decimal string: "${raw.slice(0, 40)}"`);
  }
  const negative = m[1] === "-";
  const whole = m[2] || "0";
  const frac = m[3] ?? "";
  let units = BigInt(whole) * CC_SCALE + BigInt((frac + "0".repeat(CC_DECIMALS)).slice(0, CC_DECIMALS));
  if (frac.length > CC_DECIMALS) {
    const nextDigit = Number(frac[CC_DECIMALS]);
    if (nextDigit >= 5) units += 1n;
  }
  return negative ? -units : units;
}

/** `null` instead of throwing — for upstream rows whose shape is not pinned. */
export function tryParseCC(input: unknown): bigint | null {
  if (typeof input !== "string" && typeof input !== "number" && typeof input !== "bigint") return null;
  try {
    return parseCC(input);
  } catch {
    return null;
  }
}

/** Format 1e-10 units as a decimal string with exactly 10 decimals (`"12.5000000000"`). */
export function formatCC(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / CC_SCALE;
  const frac = (abs % CC_SCALE).toString().padStart(CC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export function addCC(a: bigint, b: bigint): bigint {
  return a + b;
}

export function subCC(a: bigint, b: bigint): bigint {
  return a - b;
}

/** -1 | 0 | 1 */
export function cmpCC(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxCC(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minCC(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function absCC(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function isDust(a: bigint): boolean {
  return absCC(a) <= DUST;
}

/** A JS number (only ever from legacy code paths) rounded to 10 decimals in fixed point. */
export function round10FromNumber(n: number): bigint {
  return parseCC(n);
}

/** Sum a list in fixed point. */
export function sumCC(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** TypeORM column transformer for `numeric(38,10)` ↔ bigint. */
export const moneyTransformer = {
  to: (value: bigint | null | undefined): string | null =>
    value === null || value === undefined ? null : formatCC(value),
  from: (value: string | null | undefined): bigint | null =>
    value === null || value === undefined ? null : parseCC(value),
};
