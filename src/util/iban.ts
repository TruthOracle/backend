/**
 * Belarusian IBANs (SPEC §10.1; belarus-rails.md §5): `BY` + 2 check digits + 4-character bank
 * code (= the first 4 characters of the bank's BIC) + 4-digit balance account + 16 alphanumerics
 * = 28 characters, checked with ISO 13616 mod-97. Input is normalised first: upper case, spaces
 * and dashes dropped, Cyrillic look-alikes folded to Latin (a payer may type an IBAN on a Cyrillic
 * keyboard). The full IBAN is sealed at rest (I4); only the bank code and the last four characters
 * are kept in the clear.
 */

export const BY_IBAN_LENGTH = 28;
/** The stored form (after `normalizeIban`). */
export const BY_IBAN_RE = /^BY\d{2}[A-Z0-9]{4}\d{4}[A-Z0-9]{16}$/;

/** Cyrillic capitals that look like Latin ones (А В Е К М Н О Р С Т У Х І). */
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
  У: "Y",
  Х: "X",
  І: "I",
};
/** Whitespace and every dash a form or a keyboard may put inside an IBAN. */
const SEPARATORS = /[\s\-‐-―−﹘﹣－]/g;

export function normalizeIban(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[АВЕКМНОРСТУХІ]/g, (c) => HOMOGLYPHS[c] ?? c)
    .replace(SEPARATORS, "");
}

/** ISO 13616 / ISO 7064 mod-97 of an IBAN (first four characters moved to the end, letters → 10..35). */
export function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const c of rearranged) {
    const code = c.charCodeAt(0);
    let digits: string;
    if (code >= 48 && code <= 57) digits = c;
    else if (code >= 65 && code <= 90) digits = String(code - 55);
    else return -1;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder;
}

/** The two check digits that make `<country><digits><bban>` pass mod-97 (ISO 13616: 98 − mod97 with 00). */
export function ibanCheckDigits(country: string, bban: string): string {
  return String(98 - ibanMod97(`${country}00${bban}`)).padStart(2, "0");
}

export type IbanProblem = "empty" | "country" | "length" | "format" | "checksum";

export type ByIbanParse =
  | { ok: true; iban: string; bankCode: string; balanceAccount: string; last4: string }
  | { ok: false; problem: IbanProblem };

/** Normalise and check a Belarusian IBAN (country, length, layout, mod-97). */
export function parseByIban(raw: string | null | undefined): ByIbanParse {
  const iban = normalizeIban(raw ?? "");
  if (!iban) return { ok: false, problem: "empty" };
  if (!iban.startsWith("BY")) return { ok: false, problem: "country" };
  if (iban.length !== BY_IBAN_LENGTH) return { ok: false, problem: "length" };
  if (!BY_IBAN_RE.test(iban)) return { ok: false, problem: "format" };
  if (ibanMod97(iban) !== 1) return { ok: false, problem: "checksum" };
  return {
    ok: true,
    iban,
    bankCode: iban.slice(4, 8),
    balanceAccount: iban.slice(8, 12),
    last4: iban.slice(-4),
  };
}

export function isValidByIban(raw: string | null | undefined): boolean {
  return parseByIban(raw).ok;
}

/** Characters 5–8: the bank code (the first four characters of the bank's BIC). */
export function ibanBankCode(iban: string): string {
  return normalizeIban(iban).slice(4, 8);
}

export function ibanLast4(iban: string): string {
  return normalizeIban(iban).slice(-4);
}

/** `BY•• •••• … 1234` — what users, operators and logs see (F1's `maskIban`). */
export function maskIban(ibanOrLast4: string): string {
  const last4 = ibanOrLast4.length > 4 ? ibanLast4(ibanOrLast4) : ibanOrLast4;
  return `BY•• •••• … ${last4}`;
}

/** An 8- or 11-character BIC (`AAAABBCC[DDD]`), upper case; null when it is not one. */
export function normalizeBic(raw: string | null | undefined): string | null {
  const bic = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic) ? bic : null;
}
