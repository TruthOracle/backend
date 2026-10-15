/**
 * Decoding helpers for Daml values as the JSON Ledger API v2 serialises them (docs/INDEXER.md
 * "Value encoding"). Every helper is tolerant of the two encodings the participants have been
 * seen to emit — `verbose: false` compact values and the labelled form — and fails soft: a
 * shape that cannot be read yields `null` / `0n` and the caller decides whether that is fatal.
 * Nothing here ever goes through `Number` for a Decimal (util/money.ts, fixed point).
 */
import { formatAmount, parseAmount, tryParseAmount } from "./money";

/** Daml `Decimal` (10 dp) → 1e-10 units; `0n` when absent or malformed. */
export function asDecimal(value: unknown): bigint {
  return tryParseAmount(value) ?? 0n;
}

/** Daml `Decimal` → 1e-10 units or null when absent / malformed. */
export function asOptionalDecimal(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  return tryParseAmount(value);
}

/** Daml `Int` — the JSON API emits it as a string ("42") or a number; `0` when unreadable. */
export function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : 0;
  }
  return 0;
}

export function asOptionalInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asInt(value);
}

/** A Daml enum / payload-less variant: `"Trading"` or `{ tag: "Trading" }` (verbose form). */
export function asEnum(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as { tag?: unknown; constructor?: unknown };
    if (typeof v.tag === "string") return v.tag;
  }
  return null;
}

/** Daml `Optional a` — `null` / absent, the bare value, or `{ Some: v }` / `{ None: {} }` in the labelled form. */
export function asOptional(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "Some") return v.Some;
    if (keys.length === 1 && keys[0] === "None") return null;
  }
  return value;
}

export function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asOptionalText(value: unknown): string | null {
  const v = asOptional(value);
  return typeof v === "string" ? v : null;
}

export function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Daml `[a]` → array (a missing list reads as empty). */
export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asTextList(value: unknown): string[] {
  return asList(value)
    .map((v) => asText(v))
    .filter((v) => v !== "");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Daml `Int` epoch seconds → Date; null for 0 / unreadable (the contracts use 0 as "unset"). */
export function secondsToDate(value: unknown): Date | null {
  const n = asInt(value);
  if (n <= 0) return null;
  return new Date(n * 1000);
}

/** ISO-8601 timestamp string from the API → Date, null when unreadable. */
export function isoToDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function isoOrNull(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Fixed-point `a / b` to 10 dp (half away from zero); `0n` when `b` is zero. */
export function divDecimal(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  const scaled = a * 10_000_000_000n;
  const q = scaled / b;
  const r = scaled % b;
  const halfway = (r < 0n ? -r : r) * 2n >= (b < 0n ? -b : b);
  if (!halfway) return q;
  return scaled < 0n !== b < 0n ? q - 1n : q + 1n;
}

/** Fixed-point `a · b` (both 10 dp) to 10 dp, truncating. */
export function mulDecimal(a: bigint, b: bigint): bigint {
  return (a * b) / 10_000_000_000n;
}

export const ONE_DECIMAL = 10_000_000_000n;

/** TypeORM transformer: Postgres `bigint` (returned as a string) ↔ a JS number (offsets, node ids, market ids). */
export const bigintNumberTransformer = {
  to: (value: number | null | undefined): string | null =>
    value === null || value === undefined ? null : String(Math.trunc(value)),
  from: (value: string | number | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  },
};

/** TypeORM transformer for nullable `numeric(38,10)` columns (`moneyTransformer` already handles null; kept for readability). */
export const decimalTransformer = {
  to: (value: bigint | null | undefined): string | null =>
    value === null || value === undefined ? null : formatAmount(value),
  from: (value: string | null | undefined): bigint | null =>
    value === null || value === undefined ? null : parseAmount(value),
};
