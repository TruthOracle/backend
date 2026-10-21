import { createHash } from "node:crypto";

/**
 * An order's payout reference (SPEC §3.1, m1): `TO` + 12 digits — 11 from sha256(order id) as a
 * number mod 1e11 (zero-padded), then a Luhn check digit. Set at creation for BOTH directions: the
 * ERIP account number (the 12 digits), the bank transfer's purpose and the card refund's
 * description. Stored as `TO123456789012`, shown as `TO-123456789012`. Digits only, so a payer
 * typing it on a Cyrillic keyboard can only get the two letters wrong — `parsePayoutReference`
 * folds those back.
 */

const PREFIX = "TO";
const BODY_MODULUS = 10n ** 11n;
/** Stored form (the migration's CHECK repeats it). */
export const PAYOUT_REFERENCE_RE = /^TO\d{12}$/;

/** Cyrillic capitals that look like Latin ones (А В Е К М Н О Р С Т Х) — m1. */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
};
/** Whitespace and every dash a bank's form or a keyboard may put inside the reference. */
const SEPARATORS = /[\s\-‐-―−﹘﹣－]/g;

/** The Luhn check digit of `digits` (the digit that makes `digits + d` pass mod 10). */
export function luhnCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error("luhn: digits only");
  let sum = 0;
  // From the right, the digit next to the check digit is doubled.
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** True when the last digit is the Luhn check digit of the rest. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  return luhnCheckDigit(digits.slice(0, -1)) === Number(digits[digits.length - 1]);
}

/**
 * The stored reference of an order. `attempt` > 0 re-derives after a unique-index collision (11
 * digits give ~1e11 values; a collision is rare but must never block an order).
 */
export function payoutReferenceFor(orderId: string, attempt = 0): string {
  const seed = attempt > 0 ? `${orderId}:${attempt}` : orderId;
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  const body = (BigInt(`0x${hex}`) % BODY_MODULUS).toString().padStart(11, "0");
  return `${PREFIX}${body}${luhnCheckDigit(body)}`;
}

/** The 12 digits (the ERIP account number). */
export function payoutReferenceDigits(reference: string): string {
  if (!PAYOUT_REFERENCE_RE.test(reference)) throw new Error("not a payout reference");
  return reference.slice(PREFIX.length);
}

/** `TO-123456789012` — what users, statements and files show. */
export function displayPayoutReference(reference: string): string {
  return `${PREFIX}-${payoutReferenceDigits(reference)}`;
}

/** Upper-case, Cyrillic homoglyphs folded to Latin, separators dropped. */
export function normalizeReferenceText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[АВЕКМНОРСТХ]/g, (c) => HOMOGLYPHS[c] ?? c)
    .replace(SEPARATORS, "");
}

/**
 * The first valid payout reference in free text (a bank line's purpose, a typed ERIP account) —
 * homoglyphs folded, spaces and dashes dropped, `TO-?(\d{12})` not followed by another digit, the
 * check digit verified. Returns the stored form (`TO` + 12 digits) or null.
 */
export function parsePayoutReference(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalized = normalizeReferenceText(text);
  for (const match of normalized.matchAll(/TO-?(\d{12})(?!\d)/g)) {
    if (luhnValid(match[1])) return `${PREFIX}${match[1]}`;
  }
  return null;
}
