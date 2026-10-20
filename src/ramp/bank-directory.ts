/**
 * The Belarusian bank directory the bank rail checks IBANs against (SPEC §10.1, critique m2): a
 * DATED snapshot of the National Bank's BIC directory — every participant, not a hand-picked list —
 * with the sanctions flags of belarus-legal.md §4 laid over it. An IBAN's bank code (characters
 * 5–8) is the first four characters of its bank's BIC; an unknown code, or a code that is not a
 * bank (the NBRB, the settlement centre, the exchange, NKFOs, foreign banks), is
 * `bank_account_invalid`. `RAMP_BLOCKED_BANK_CODES` refuses listed banks on top.
 *
 * Source: https://www.nbrb.by/payment/bic-rb.xlsx, fetched 2026-10-19 (sha256 522eaae2…edd9caf;
 * 40 rows: 29 with an 8-character BIC kept, the 11 budget bodies with `BY000…` pseudo codes
 * left out). Regenerate from a fresh download (the generator lives with the S6 notes, not in the
 * repo) and re-date this header; never commit the download.
 *
 * Sanctions overlay (informational — the operator decides with RAMP_BLOCKED_BANK_CODES and
 * counsel): EU Reg 765/2006 Annexes IX / XV as consolidated 24.07.2026; UK consolidated list
 * 16.10.2026 (asset freezes); OFAC SDN.CSV scanned by BIC on 19.10.2026 — which also lists TK Bank
 * (BBTKBY2X, Iran / SDGT / NPWMD programmes), absent from belarus-legal.md's table. Absolutbank
 * (SDN, ABLTBY22) is no longer a directory participant.
 */

export const BANK_DIRECTORY_SOURCE = {
  url: "https://www.nbrb.by/payment/bic-rb.xlsx",
  fetchedAt: "2026-10-19",
  sha256: "522eaae26d2f477e6d0a9959eefbc33dfc877e6f013a2293894d63930edd9caf",
} as const;

/** Only `bank` entries hold an individual's current account. */
export type BankDirectoryKind = "bank" | "central_bank" | "non_bank" | "foreign_bank";

export interface BankSanctions {
  eu: readonly string[];
  us: readonly string[];
  uk: readonly string[];
}

export interface BankDirectoryEntry {
  /** The IBAN bank code = the BIC's first four characters. */
  code: string;
  bic: string;
  /** As the directory spells it. */
  name: string;
  /** The common English name (the UI and the bank file show it). */
  nameEn: string;
  unp: string | null;
  kind: BankDirectoryKind;
  sanctions: BankSanctions;
}

// prettier-ignore
type Row = [code: string, bic: string, name: string, nameEn: string, unp: string | null, kind: BankDirectoryKind];

// One directory row per line, as in the source file.
// prettier-ignore
const ROWS: readonly Row[] = [
  ["NBRB", "NBRBBY2X", "Национальный банк Республики Беларусь", "National Bank of the Republic of Belarus", "100665467", "central_bank"],
  ["BISC", "BISCBY25", "ОАО 'БМРЦ'", "BISC (interbank settlement centre)", "193002449", "non_bank"],
  ["SLAN", "SLANBY22", "ЗАО Банк ВТБ (Беларусь)", "VTB Bank (Belarus)", "101165625", "bank"],
  ["REDJ", "REDJBY22", "ЗАО 'Банк РРБ'", "Bank RRB", "100361187", "bank"],
  ["INEA", "INEARUMM", "Межгосударственный банк", "Interstate Bank (Moscow)", "102336693", "foreign_bank"],
  ["EABR", "EABRKZKA", "Евразийский банк развития", "Eurasian Development Bank (Almaty)", null, "foreign_bank"],
  ["MTBK", "MTBKBY22", "ЗАО 'МТбанк'", "MTBank", "100394906", "bank"],
  ["UNBS", "UNBSBY2X", "ЗАО 'БСБ Банк'", "BSB Bank", "807000069", "bank"],
  ["TECN", "TECNBY22", "ОАО 'Технобанк'", "Technobank", "100706562", "bank"],
  ["BCSX", "BCSXBY22", "ОАО 'Белорусская валютно-фондовая биржа'", "Belarusian Currency and Stock Exchange", "101541722", "non_bank"],
  ["BRRB", "BRRBBY2X", "ОАО 'Банк развития Республики Беларусь'", "Development Bank of the Republic of Belarus", "191683861", "bank"],
  ["BELB", "BELBBY2X", "ОАО 'Банк БелВЭБ'", "Bank BelVEB", "100010078", "bank"],
  ["ALFA", "ALFABY2X", "ЗАО 'Альфа-Банк'", "Alfa-Bank (Belarus)", "101541947", "bank"],
  ["MMBN", "MMBNBY22", "ОАО 'Банк Дабрабыт'", "Bank Dabrabyt", "807000002", "bank"],
  ["RSHN", "RSHNBY2X", "ЗАО 'Банк 'Решение'", "Bank Reshenie", "100789114", "bank"],
  ["ABIG", "ABIGBY25", "ОАО 'НКФО 'Белинкасгрупп'", "NKFO Belinkasgrupp", "807000270", "non_bank"],
  ["BBTK", "BBTKBY2X", "ЗАО 'ТК Банк'", "TK Bank", "807000163", "bank"],
  ["SSIS", "SSISBY25", "ОАО 'НКФО 'ЕРИП'", "NKFO ERIP", "807000268", "non_bank"],
  ["BPSB", "BPSBBY2X", "ОАО 'Сбер Банк'", "Sber Bank", "100219673", "bank"],
  ["AEBK", "AEBKBY2X", "ЗАО 'Нео Банк Азия'", "Neo Bank Asia", "807000071", "bank"],
  ["IRJS", "IRJSBY22", "ОАО 'СтатусБанк'", "StatusBank", "807000043", "bank"],
  ["BLBB", "BLBBBY2X", "ОАО 'Белинвестбанк'", "Belinvestbank", "807000028", "bank"],
  ["OLMP", "OLMPBY2X", "ОАО 'Белгазпромбанк'", "Belgazprombank", "100429079", "bank"],
  ["PJCB", "PJCBBY2X", "Приорбанк' ОАО", "Priorbank", "100220190", "bank"],
  ["BLNB", "BLNBBY2X", "ОАО 'БНБ-Банк'", "BNB-Bank", "100513485", "bank"],
  ["POIS", "POISBY2X", "ОАО 'Паритетбанк'", "Paritetbank", "100233809", "bank"],
  ["AKBB", "AKBBBY2X", "ОАО 'АСБ Беларусбанк'", "Belarusbank", "100325912", "bank"],
  ["ZEPT", "ZEPTBY2X", "ЗАО 'Цептер Банк'", "Zepter Bank", "807000214", "bank"],
  ["BAPB", "BAPBBY2X", "ОАО 'Белагропромбанк'", "Belagroprombank", "100693551", "bank"],
];

const EU_IX = "EU Reg 765/2006 Annex IX";
const EU_XV = "EU Reg 765/2006 Annex XV (transaction ban)";

/** belarus-legal.md §4, plus the OFAC scan by BIC (see the header). */
const SANCTIONS: Readonly<Record<string, Partial<BankSanctions>>> = {
  AKBB: { eu: [EU_IX] },
  BAPB: { eu: [EU_IX, EU_XV] },
  BLBB: { eu: [EU_IX, EU_XV], us: ["OFAC SDN BELARUS-EO14038 (GL 14 since 2026-03-26)"] },
  MMBN: { eu: [EU_IX, EU_XV], us: ["OFAC SDN BELARUS-EO14038"], uk: ["UK asset freeze BEL0120"] },
  BRRB: { eu: [EU_IX, EU_XV] },
  BELB: { us: ["OFAC SDN RUSSIA-EO14024"] },
  BPSB: { us: ["OFAC SDN RUSSIA-EO14024"] },
  SLAN: { us: ["OFAC SDN RUSSIA-EO14024"] },
  BBTK: { us: ["OFAC SDN IRAN / SDGT / NPWMD"] },
  ALFA: { uk: ["UK asset freeze BEL0166"] },
  OLMP: { us: ["parent Gazprombank is an OFAC SDN: check the 50 % rule"] },
};

export const BANK_DIRECTORY: readonly BankDirectoryEntry[] = ROWS.map(
  ([code, bic, name, nameEn, unp, kind]) => ({
    code,
    bic,
    name,
    nameEn,
    unp,
    kind,
    sanctions: {
      eu: SANCTIONS[code]?.eu ?? [],
      us: SANCTIONS[code]?.us ?? [],
      uk: SANCTIONS[code]?.uk ?? [],
    },
  }),
);

const BY_CODE = new Map(BANK_DIRECTORY.map((e) => [e.code, e]));
const BY_BIC = new Map(BANK_DIRECTORY.map((e) => [e.bic, e]));

/** The directory entry of an IBAN bank code (any kind), or null. */
export function directoryEntry(code: string): BankDirectoryEntry | null {
  return BY_CODE.get(code.toUpperCase()) ?? null;
}

/** The BANK holding accounts under this IBAN bank code (kind `bank` only), or null. */
export function bankByCode(code: string): BankDirectoryEntry | null {
  const entry = directoryEntry(code);
  return entry?.kind === "bank" ? entry : null;
}

/** The entry of an 8-character BIC, or of an 11-character branch BIC (its first eight). */
export function bankByBic(bic: string): BankDirectoryEntry | null {
  return BY_BIC.get(bic.toUpperCase().slice(0, 8)) ?? null;
}

export function isSanctioned(entry: BankDirectoryEntry): boolean {
  const s = entry.sanctions;
  return s.eu.length + s.us.length + s.uk.length > 0;
}
