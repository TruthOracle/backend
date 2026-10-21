import { createHash } from "node:crypto";

import { canonicalJson } from "./admin-approval.logic";
import { isIsoDate } from "../util/by-calendar";
import { decodeText, type TextCharset } from "../util/charset";
import { parseCsv } from "../util/csv";
import { ApiError } from "../util/errors";
import { normalizeBic, normalizeIban } from "../util/iban";
import { AMOUNT_DECIMALS, formatAmount, parseAmount } from "../util/money";
import { luhnValid, normalizeReferenceText, parsePayoutReference } from "../util/payout-reference";
import { decodeXmlText, parseSafeXml } from "../util/safe-xml";

/**
 * Client-money statements as the bank produces them (SPEC §10.4, X3, X16): camt.053 (ISO 20022)
 * through the hardened XML parser, or the CSV layout of the spec through the strict RFC 4180 reader
 * (charset named by the uploader, never sniffed). Account, period and balances come FROM THE FILE.
 * Pure: the service checks the account, the chain and the size, stores and matches.
 */

export const STATEMENT_MAX_BYTES = 5 * 1024 * 1024;
export const STATEMENT_MAX_LINES = 50_000;

export interface ParsedLine {
  /** The bank's transaction id. */
  lineRef: string;
  bookingDate: string;
  valueDate: string | null;
  /** Signed 1e-10 units: + credit, − debit. */
  amount: bigint;
  currency: string;
  counterpartyName: string | null;
  /** Normalised (any country), or null when the bank gave none. */
  counterpartyIban: string | null;
  counterpartyBic: string | null;
  bankTxCode: string | null;
  returnInfo: boolean;
  returnCode: string | null;
  /** Remittance text, as given (sealed at rest). */
  purpose: string | null;
  /** `TO` + 12 digits found in the line's texts (homoglyphs folded, check digit verified). */
  reference: string | null;
  documentNo: string | null;
  /**
   * Every transaction's reference (C6): a batch-booked entry (several TxDtls) quotes no single
   * order, but each of its transactions may — the unpaid proofs and the partial batch rule read
   * these. A single transaction: `[reference]`; a CSV line: every reference of its purpose.
   */
  references: string[];
  /** Every transaction's numeric document number (InstrId), as `references`. */
  documentNos: string[];
  /** The bank's ids of the payment file an entry books (camt NtryDtls/Btch MsgId, PmtInfId). */
  batchRefs: string[];
  /**
   * R2a-5: each transaction of a batch-booked camt entry (2+ TxDtls) with the account and amount
   * the bank says it paid — the rules check them against the items they name. Empty otherwise.
   */
  transactions: ParsedTransaction[];
}

/** One transaction of a batch-booked camt entry, as the bank names it (R2a-5). */
export interface ParsedTransaction {
  reference: string | null;
  documentNo: string | null;
  /** The creditor's IBAN of a debit (the debtor's of a credit), normalised; null = none given. */
  iban: string | null;
  /** Its own amount, unsigned (`formatAmount`); null when the bank gave none. */
  amount: string | null;
}

/** The BLIND-INDEX purpose of a statement's canonical parse (`to_ramp_bank_statements.canonical_hash`). */
export const STATEMENT_CANONICAL_PURPOSE = "ramp-statement";

export interface ParsedStatement {
  format: "camt053" | "csv";
  account: string;
  currency: string;
  periodFrom: string;
  periodTo: string;
  opening: bigint;
  closing: bigint;
  lines: ParsedLine[];
}

export interface StatementParseOptions {
  /** The fiat (BYN): every amount is in it, in whole units of its smallest denomination. */
  currency: string;
  fiatDecimals: number;
}

export function invalid(why: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(422, "statement_invalid", `statement refused: ${why}`, details);
}

/** Decode, parse and check a statement file. */
export function parseStatement(
  input: { format: "camt053" | "csv"; bytes: Uint8Array; charset?: TextCharset },
  opts: StatementParseOptions,
): ParsedStatement {
  if (input.bytes.length === 0) throw invalid("the file is empty");
  if (input.bytes.length > STATEMENT_MAX_BYTES) throw invalid("the file is larger than 5 MB");
  const text = decodeText(input.bytes, input.charset ?? "utf-8");
  const parsed = input.format === "camt053" ? parseCamt053(text) : parseStatementCsv(text);
  checkStatement(parsed, opts);
  return parsed;
}

/** The figures every format must satisfy: currency, kopecks, dates inside the period, Σ = closing − opening. */
export function checkStatement(s: ParsedStatement, opts: StatementParseOptions): void {
  const kopeck = 10n ** BigInt(AMOUNT_DECIMALS - opts.fiatDecimals);
  if (!s.account) throw invalid("no account IBAN");
  if (s.currency !== opts.currency) throw invalid(`the account currency is not ${opts.currency}`);
  for (const d of [s.periodFrom, s.periodTo])
    if (!isIsoDate(d)) throw invalid(`the period date ${d.slice(0, 20)} is not a date`);
  if (s.periodFrom > s.periodTo) throw invalid("the period ends before it starts");
  if (s.opening % kopeck !== 0n || s.closing % kopeck !== 0n)
    throw invalid("a balance is not in whole kopecks");
  if (s.lines.length > STATEMENT_MAX_LINES) throw invalid(`more than ${STATEMENT_MAX_LINES} lines`);
  const refs = new Set<string>();
  let sum = 0n;
  for (const l of s.lines) {
    if (!l.lineRef || l.lineRef.length > 128 || !/^[\x20-\x7e]+$/.test(l.lineRef))
      throw invalid("a line has no usable bank reference (1–128 printable characters)");
    if (refs.has(l.lineRef)) throw invalid(`the line ${l.lineRef} appears twice`);
    refs.add(l.lineRef);
    if (l.currency !== opts.currency)
      throw invalid(`the line ${l.lineRef} is not in ${opts.currency}`);
    if (l.amount === 0n || l.amount % kopeck !== 0n)
      throw invalid(`the line ${l.lineRef} is zero or not in whole kopecks`);
    if (!isIsoDate(l.bookingDate) || l.bookingDate < s.periodFrom || l.bookingDate > s.periodTo)
      throw invalid(`the line ${l.lineRef} is booked outside the period`);
    if (l.valueDate !== null && !isIsoDate(l.valueDate))
      throw invalid(`the line ${l.lineRef} has a bad value date`);
    sum += l.amount;
  }
  if (sum !== s.closing - s.opening)
    throw invalid("the lines do not add up to closing − opening", {
      opening: formatAmount(s.opening),
      closing: formatAmount(s.closing),
      lines: formatAmount(sum),
    });
}

/** Free text as two downloads of one statement must agree on it: whitespace runs collapsed, trimmed. */
function sameText(t: string | null): string | null {
  return t === null ? null : t.replace(/\s+/g, " ").trim() || null;
}

/**
 * The parse two people's copies must share (SPEC §10.4, X3, C7): the format, account, period,
 * balances and EVERY field of every line the matcher or a proof reads — purpose, document numbers,
 * BIC, return information, the bank's transaction code, the per-transaction references — lines in
 * ref order. What is stored and matched is the uploader's parse, so nothing of it may differ from
 * the second person's copy; free text only compares within one format, so a CSV never stands for
 * a camt.053 (two downloads of one camt.053 differ only in their header and compare equal).
 */
export function canonicalStatement(s: ParsedStatement): string {
  const sorted = (v: readonly string[] | undefined): string[] => [...(v ?? [])].sort();
  return canonicalJson({
    format: s.format,
    account: s.account,
    currency: s.currency,
    periodFrom: s.periodFrom,
    periodTo: s.periodTo,
    opening: formatAmount(s.opening),
    closing: formatAmount(s.closing),
    lines: [...s.lines]
      .sort((a, b) => (a.lineRef < b.lineRef ? -1 : a.lineRef > b.lineRef ? 1 : 0))
      .map((l) => ({
        ref: l.lineRef,
        date: l.bookingDate,
        valueDate: l.valueDate,
        amount: formatAmount(l.amount),
        currency: l.currency,
        counterpartyName: sameText(l.counterpartyName),
        counterpartyIban: l.counterpartyIban,
        counterpartyBic: l.counterpartyBic,
        bankTxCode: l.bankTxCode,
        returnInfo: l.returnInfo,
        returnCode: l.returnCode,
        purpose: sameText(l.purpose),
        reference: l.reference,
        references: sorted(l.references),
        documentNo: l.documentNo,
        documentNos: sorted(l.documentNos),
        batchRefs: sorted(l.batchRefs),
        transactions: [...(l.transactions ?? [])].map((t) => canonicalJson(t)).sort(),
      })),
  });
}

/**
 * A line back from its sealed JSON (`raw_sealed` holds the parsed line, the amount as a decimal
 * string): the statement re-indexer rebuilds the canonical parse from what was stored (C41).
 */
export function lineFromSealed(raw: Record<string, unknown>): ParsedLine {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" ? v : null;
  };
  const list = (k: string): string[] =>
    Array.isArray(raw[k])
      ? (raw[k] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
  return {
    lineRef: str("lineRef") ?? "",
    bookingDate: str("bookingDate") ?? "",
    valueDate: str("valueDate"),
    amount: parseAmount(str("amount") ?? "0"),
    currency: str("currency") ?? "",
    counterpartyName: str("counterpartyName"),
    counterpartyIban: str("counterpartyIban"),
    counterpartyBic: str("counterpartyBic"),
    bankTxCode: str("bankTxCode"),
    returnInfo: raw.returnInfo === true,
    returnCode: str("returnCode"),
    purpose: str("purpose"),
    reference: str("reference"),
    documentNo: str("documentNo"),
    references: list("references"),
    documentNos: list("documentNos"),
    batchRefs: list("batchRefs"),
    transactions: Array.isArray(raw.transactions)
      ? (raw.transactions as unknown[])
          .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
          .map((t) => {
            const field = (k: string): string | null => (typeof t[k] === "string" ? t[k] : null);
            return {
              reference: field("reference"),
              documentNo: field("documentNo"),
              iban: field("iban"),
              amount: field("amount"),
            };
          })
      : [],
  };
}

/** Every valid payout reference of ONE text, in order, once each (the stored form `TO` + 12 digits). */
export function allPayoutReferences(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of normalizeReferenceText(text).matchAll(/TO-?(\d{12})(?!\d)/g))
    if (luhnValid(m[1])) out.add(`TO${m[1]}`);
  return [...out];
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ───────────────────────────────────────────── camt.053 ───────────────────────────────────

type Node = Record<string, unknown>;

function arr(v: unknown): unknown[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function at(v: unknown, ...path: string[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (Array.isArray(cur)) cur = cur[0];
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Node)[key];
  }
  return cur;
}

/** A leaf's text (an element with attributes keeps its text under `#text`), entities decoded. */
function text(v: unknown): string | null {
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "string") return decodeXmlText(v).trim() || null;
  if (v && typeof v === "object" && typeof (v as Node)["#text"] === "string")
    return text((v as Node)["#text"]);
  return null;
}

function dateOf(v: unknown): string | null {
  const t = text(at(v, "Dt")) ?? text(at(v, "DtTm"));
  return t ? t.slice(0, 10) : null;
}

const AMOUNT_RE = /^\d{1,15}(\.\d{1,5})?$/;

/** A camt amount with its credit/debit indicator, signed. */
function camtAmount(
  amt: unknown,
  indicator: unknown,
  where: string,
): { value: bigint; ccy: string } {
  const raw = text(amt);
  const attr = amt && typeof amt === "object" ? (amt as Node)["@_Ccy"] : undefined;
  const ccy = typeof attr === "string" ? attr : "";
  if (!raw || !AMOUNT_RE.test(raw)) throw invalid(`${where}: the amount is not a plain decimal`);
  const ind = text(indicator);
  if (ind !== "CRDT" && ind !== "DBIT") throw invalid(`${where}: CdtDbtInd must be CRDT or DBIT`);
  const value = parseAmount(raw);
  return { value: ind === "DBIT" ? -value : value, ccy };
}

const BOOKED = new Set(["BOOK"]);

/** camt.053: exactly one `Stmt`; opening OPBD (or PRCD) and closing CLBD; booked entries only. */
export function parseCamt053(xml: string): ParsedStatement {
  const doc = parseSafeXml(xml);
  const stmts = arr(at(doc, "Document", "BkToCstmrStmt", "Stmt"));
  if (stmts.length !== 1) throw invalid("a camt.053 file must hold exactly one statement (Stmt)");
  const stmt = stmts[0];
  const account = normalizeIban(text(at(stmt, "Acct", "Id", "IBAN")) ?? "");
  let opening: { value: bigint; ccy: string; date: string | null } | null = null;
  let closing: { value: bigint; ccy: string; date: string | null } | null = null;
  for (const bal of arr(at(stmt, "Bal"))) {
    const code = text(at(bal, "Tp", "CdOrPrtry", "Cd"));
    if (code !== "OPBD" && code !== "PRCD" && code !== "CLBD") continue;
    const amount = {
      ...camtAmount(at(bal, "Amt"), at(bal, "CdtDbtInd"), `balance ${code}`),
      date: dateOf(at(bal, "Dt")),
    };
    if (code === "CLBD") {
      if (closing) throw invalid("two closing balances (CLBD)");
      closing = amount;
    } else {
      if (opening) throw invalid("two opening balances (OPBD / PRCD)");
      opening = amount;
    }
  }
  if (!opening || !closing)
    throw invalid("the opening (OPBD) and closing (CLBD) balances are required");
  const currency = text(at(stmt, "Acct", "Ccy")) ?? closing.ccy;
  if (opening.ccy !== currency || closing.ccy !== currency)
    throw invalid("a balance is not in the account currency");
  const from = text(at(stmt, "FrToDt", "FrDtTm"))?.slice(0, 10) ?? opening.date;
  const to = text(at(stmt, "FrToDt", "ToDtTm"))?.slice(0, 10) ?? closing.date;
  if (!from || !to) throw invalid("the statement period (FrToDt) is missing");
  const lines = arr(at(stmt, "Ntry")).map((ntry, i) => camtLine(ntry, i + 1));
  return {
    format: "camt053",
    account,
    currency,
    periodFrom: from,
    periodTo: to,
    opening: opening.value,
    closing: closing.value,
    lines,
  };
}

function camtLine(ntry: unknown, n: number): ParsedLine {
  const where = `entry ${n}`;
  const status = text(at(ntry, "Sts", "Cd")) ?? text(at(ntry, "Sts"));
  if (!status || !BOOKED.has(status))
    throw invalid(`${where}: only booked entries (Sts BOOK) are accepted`);
  const { value, ccy } = camtAmount(at(ntry, "Amt"), at(ntry, "CdtDbtInd"), where);
  const txs = arr(at(ntry, "NtryDtls")).flatMap((d) => arr(at(d, "TxDtls")));
  const single = txs.length === 1 ? txs[0] : null;
  const lineRef =
    text(at(ntry, "AcctSvcrRef")) ??
    text(at(single, "Refs", "AcctSvcrRef")) ??
    text(at(ntry, "NtryRef"));
  if (!lineRef) throw invalid(`${where}: no bank reference (AcctSvcrRef / NtryRef)`);
  const debit = value < 0n;
  // The counterparty: the creditor of what we paid, the debtor of what we received.
  const party = debit ? "Cdtr" : "Dbtr";
  const counterpartyName = single
    ? (text(at(single, "RltdPties", party, "Nm")) ??
      text(at(single, "RltdPties", party, "Pty", "Nm")))
    : null;
  const iban = single ? text(at(single, "RltdPties", `${party}Acct`, "Id", "IBAN")) : null;
  const bic = single
    ? (text(at(single, "RltdAgts", `${party}Agt`, "FinInstnId", "BIC")) ??
      text(at(single, "RltdAgts", `${party}Agt`, "FinInstnId", "BICFI")))
    : null;
  const domain = text(at(ntry, "BkTxCd", "Domn", "Cd"));
  const family = text(at(ntry, "BkTxCd", "Domn", "Fmly", "Cd"));
  const sub = text(at(ntry, "BkTxCd", "Domn", "Fmly", "SubFmlyCd"));
  const proprietary = text(at(ntry, "BkTxCd", "Prtry", "Cd"));
  const bankTxCode = domain ? [domain, family, sub].filter(Boolean).join("/") : proprietary;
  const rtr = single ? at(single, "RtrInf") : undefined;
  const returnInfo = rtr !== undefined || sub === "RRTN" || /RRTN/.test(proprietary ?? "");
  const returnCode = returnInfo
    ? (text(at(rtr, "Rsn", "Cd")) ?? text(at(rtr, "Rsn", "Prtry")) ?? "RRTN")
    : null;
  const remittance = txs
    .flatMap((t) => arr(at(t, "RmtInf", "Ustrd")).map(text))
    .filter((t): t is string => !!t);
  const extra = [
    ...txs.map((t) => text(at(t, "AddtlTxInf"))),
    text(at(ntry, "AddtlNtryInf")),
  ].filter((t): t is string => !!t);
  const purpose = [...remittance, ...extra].join(" | ") || null;
  const endToEnd = single ? text(at(single, "Refs", "EndToEndId")) : null;
  const instrOf = (t: unknown): string | null =>
    text(at(t, "Refs", "InstrId")) ?? text(at(t, "Refs", "ChqNb"));
  const numeric = (v: string | null): string | null => (v && /^\d{1,18}$/.test(v) ? v : null);
  const instr = single ? instrOf(single) : null;
  const reference = single ? firstReference([endToEnd, ...remittance, ...extra, instr]) : null;
  const documentNo = numeric(instr);
  // C6: each transaction of a batch-booked entry on its own (its texts read one by one), with the
  // account and amount it paid (R2a-5).
  const transactions: ParsedTransaction[] =
    txs.length >= 2
      ? txs.map((t) => {
          const txIban = text(at(t, "RltdPties", `${party}Acct`, "Id", "IBAN"));
          const txAmount = text(at(t, "AmtDtls", "TxAmt", "Amt")) ?? text(at(t, "Amt"));
          return {
            reference: firstReference([
              text(at(t, "Refs", "EndToEndId")),
              ...arr(at(t, "RmtInf", "Ustrd")).map(text),
              text(at(t, "AddtlTxInf")),
              instrOf(t),
            ]),
            documentNo: numeric(instrOf(t)),
            iban: txIban ? normalizeIban(txIban) : null,
            amount:
              txAmount && AMOUNT_RE.test(txAmount) ? formatAmount(parseAmount(txAmount)) : null,
          };
        })
      : [];
  // R2a-8: an entry without transaction details names its payouts in its own text only.
  const perTx = single
    ? [{ reference, documentNo }]
    : txs.length
      ? transactions
      : allPayoutReferences(text(at(ntry, "AddtlNtryInf"))).map((r) => ({
          reference: r,
          documentNo: null,
        }));
  const batchRefs = arr(at(ntry, "NtryDtls"))
    .flatMap((d) => arr(at(d, "Btch")))
    .flatMap((b) => [text(at(b, "MsgId")), text(at(b, "PmtInfId"))])
    .filter((t): t is string => !!t && /^[\x20-\x7e]{1,140}$/.test(t));
  const unique = (v: (string | null)[]): string[] => [
    ...new Set(v.filter((x): x is string => !!x)),
  ];
  return {
    lineRef,
    bookingDate: dateOf(at(ntry, "BookgDt")) ?? "",
    valueDate: dateOf(at(ntry, "ValDt")),
    amount: value,
    currency: ccy,
    counterpartyName,
    counterpartyIban: iban ? normalizeIban(iban) : null,
    counterpartyBic: normalizeBic(bic),
    bankTxCode,
    returnInfo,
    returnCode,
    purpose,
    // A batch-booked entry (several transactions) quotes no single order.
    reference,
    documentNo,
    references: unique(perTx.map((t) => t.reference)),
    documentNos: unique(perTx.map((t) => t.documentNo)),
    batchRefs: unique(batchRefs),
    transactions,
  };
}

/**
 * The first valid reference among the texts, each read ON ITS OWN: the reference parser drops
 * spaces, so joining texts could glue a document number onto the reference's digits.
 */
function firstReference(texts: (string | null)[]): string | null {
  for (const t of texts) {
    const ref = parsePayoutReference(t);
    if (ref) return ref;
  }
  return null;
}

// ───────────────────────────────────────────── CSV ────────────────────────────────────────

export const STATEMENT_CSV_COLUMNS = [
  "line_ref",
  "booking_date",
  "value_date",
  "amount",
  "currency",
  "counterparty_name",
  "counterparty_iban",
  "counterparty_bic",
  "bank_tx_code",
  "return_code",
  "purpose",
  "document_no",
] as const;

const CSV_AMOUNT_RE = /^[+-]?\d{1,15}([.,]\d{1,2})?$/;

function csvAmount(raw: string, where: string): bigint {
  const v = raw.trim();
  if (!CSV_AMOUNT_RE.test(v))
    throw invalid(`${where}: the amount is not a decimal with ≤ 2 places`);
  return parseAmount(v.replace(",", "."));
}

/**
 * The spec's CSV layout: metadata rows `#account`, `#period,<from>,<to>`, `#opening`, `#closing`
 * (optional `#currency`) before the column header, then one record per line. `;` or `,` delimited
 * — the first record (`#account…`) shows which; amounts may use a decimal comma with `;`.
 */
export function parseStatementCsv(text: string): ParsedStatement {
  const first = text.replace(/^\uFEFF/, "").trimStart();
  const delimiter = first.startsWith("#account;") ? ";" : ",";
  const rows = parseCsv(text, { delimiter, maxRows: STATEMENT_MAX_LINES + 16 });
  const meta = new Map<string, string[]>();
  let i = 0;
  for (; i < rows.length && rows[i][0]?.trim().startsWith("#"); i += 1) {
    const key = rows[i][0].trim().toLowerCase();
    if (meta.has(key)) throw invalid(`the metadata row ${key} appears twice`);
    meta.set(
      key,
      rows[i].slice(1).map((c) => c.trim()),
    );
  }
  const need = (key: string, n: number): string[] => {
    const v = meta.get(key);
    if (!v || v.length < n || v.slice(0, n).some((c) => !c))
      throw invalid(`the metadata row ${key} is missing or incomplete`);
    return v;
  };
  const account = normalizeIban(need("#account", 1)[0]);
  const [periodFrom, periodTo] = need("#period", 2);
  const opening = csvAmount(need("#opening", 1)[0], "#opening");
  const closing = csvAmount(need("#closing", 1)[0], "#closing");
  const currency = (meta.get("#currency")?.[0] || "BYN").toUpperCase();
  const header = rows[i]?.map((c) => c.trim().toLowerCase());
  if (!header || header.join(",") !== STATEMENT_CSV_COLUMNS.join(","))
    throw invalid(`the column header must be: ${STATEMENT_CSV_COLUMNS.join(",")}`);
  const lines = rows.slice(i + 1).map((r, k): ParsedLine => {
    const where = `record ${i + k + 2}`;
    if (r.length !== STATEMENT_CSV_COLUMNS.length)
      throw invalid(`${where}: expected ${STATEMENT_CSV_COLUMNS.length} cells`);
    const c = Object.fromEntries(
      STATEMENT_CSV_COLUMNS.map((name, j) => [name, r[j].trim()]),
    ) as Record<(typeof STATEMENT_CSV_COLUMNS)[number], string>;
    const purpose = c.purpose || null;
    const refs = allPayoutReferences(purpose);
    return {
      lineRef: c.line_ref,
      bookingDate: c.booking_date,
      valueDate: c.value_date || null,
      amount: csvAmount(c.amount, where),
      currency: (c.currency || currency).toUpperCase(),
      counterpartyName: c.counterparty_name || null,
      counterpartyIban: c.counterparty_iban ? normalizeIban(c.counterparty_iban) : null,
      counterpartyBic: normalizeBic(c.counterparty_bic),
      bankTxCode: c.bank_tx_code || null,
      returnInfo: c.return_code !== "",
      returnCode: c.return_code || null,
      purpose,
      // A bulk line naming several orders quotes no single one (as a batch-booked camt entry).
      reference: refs.length === 1 ? refs[0] : null,
      documentNo: /^\d{1,18}$/.test(c.document_no) ? c.document_no : null,
      // C6: a bulk line names every order it pays in its purpose; keep them all, not only the first.
      references: refs,
      documentNos: /^\d{1,18}$/.test(c.document_no) ? [c.document_no] : [],
      batchRefs: [],
      transactions: [],
    };
  });
  return { format: "csv", account, currency, periodFrom, periodTo, opening, closing, lines };
}
