/**
 * Bank rail test kit (SPEC §10; S6): valid Belarusian IBANs, camt.053 and CSV statements the way a
 * bank (or the spec's CSV layout) writes them, and Minsk business days to date them. Statements
 * are base64 like the upload route expects.
 */
import { BusinessCalendar, minskDate } from "../../src/util/by-calendar";
import { ibanCheckDigits } from "../../src/util/iban";
import { STATEMENT_CSV_COLUMNS } from "../../src/services/ramp-bank-statement.parse";

/** A valid BY IBAN at bank `code` (the IBAN's characters 5–8 = the BIC's first four). */
export function byIban(code: string, tail: string): string {
  const bban = `${code}3014${tail.padStart(16, "0")}`;
  return `BY${ibanCheckDigits("BY", bban)}${bban}`;
}

export interface StatementEntry {
  ref: string;
  /** Decimal string, unsigned. */
  amount: string;
  credit?: boolean;
  date: string;
  iban?: string | null;
  bic?: string;
  name?: string;
  /** Remittance text (Ustrd / purpose). */
  purpose?: string;
  endToEnd?: string;
  documentNo?: string;
  /** A camt return reason (RtrInf/Rsn/Cd). */
  returnCode?: string;
  /**
   * A batch-booked entry (camt only): one TxDtls per transaction — its own EndToEndId / InstrId /
   * Ustrd, no counterparty — instead of the single one above; `entryInfo` = AddtlNtryInf.
   */
  transactions?: {
    endToEnd?: string;
    documentNo?: string;
    purpose?: string;
    /** R2a-5: the creditor's IBAN and the transaction's own amount, as some banks give them. */
    iban?: string;
    amount?: string;
  }[];
  entryInfo?: string;
}

export interface StatementSpec {
  account: string;
  from: string;
  to: string;
  opening: string;
  closing: string;
  entries: StatementEntry[];
  /** Header noise that differs between two downloads of the same statement. */
  messageId?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One transaction of a batch-booked camt entry. */
function batchTx(t: NonNullable<StatementEntry["transactions"]>[number]): string {
  const refs = `${t.endToEnd ? `<EndToEndId>${esc(t.endToEnd)}</EndToEndId>` : ""}${t.documentNo ? `<InstrId>${t.documentNo}</InstrId>` : ""}`;
  return (
    `<TxDtls>${refs ? `<Refs>${refs}</Refs>` : ""}` +
    (t.amount ? `<AmtDtls><TxAmt><Amt Ccy="BYN">${t.amount}</Amt></TxAmt></AmtDtls>` : "") +
    (t.iban
      ? `<RltdPties><Cdtr><Nm>Beneficiary</Nm></Cdtr><CdtrAcct><Id><IBAN>${t.iban}</IBAN></Id></CdtrAcct></RltdPties>`
      : "") +
    (t.purpose ? `<RmtInf><Ustrd>${esc(t.purpose)}</Ustrd></RmtInf>` : "") +
    `</TxDtls>`
  );
}

/** camt.053.001.02 as a bank exports it (booked entries, OPBD / CLBD). */
export function camt053(s: StatementSpec): string {
  const bal = (cd: string, amt: string, date: string): string => {
    const neg = amt.startsWith("-");
    return `<Bal><Tp><CdOrPrtry><Cd>${cd}</Cd></CdOrPrtry></Tp><Amt Ccy="BYN">${neg ? amt.slice(1) : amt}</Amt><CdtDbtInd>${neg ? "DBIT" : "CRDT"}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  };
  const ntry = (e: StatementEntry): string => {
    const party = e.credit ? "Dbtr" : "Cdtr";
    const refs = `${e.endToEnd ? `<EndToEndId>${esc(e.endToEnd)}</EndToEndId>` : ""}${e.documentNo ? `<InstrId>${e.documentNo}</InstrId>` : ""}`;
    return (
      `<Ntry><NtryRef>${esc(e.ref)}</NtryRef><Amt Ccy="BYN">${e.amount}</Amt><CdtDbtInd>${e.credit ? "CRDT" : "DBIT"}</CdtDbtInd>` +
      `<Sts>BOOK</Sts><BookgDt><Dt>${e.date}</Dt></BookgDt><ValDt><Dt>${e.date}</Dt></ValDt><AcctSvcrRef>${esc(e.ref)}</AcctSvcrRef>` +
      `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${e.credit ? "RCDT" : "ICDT"}</Cd><SubFmlyCd>${e.returnCode ? "RRTN" : "DMCT"}</SubFmlyCd></Fmly></Domn></BkTxCd>` +
      (e.transactions
        ? `<NtryDtls>${e.transactions.map(batchTx).join("")}</NtryDtls>` +
          (e.entryInfo ? `<AddtlNtryInf>${esc(e.entryInfo)}</AddtlNtryInf>` : "") +
          `</Ntry>`
        : `<NtryDtls><TxDtls>${refs ? `<Refs>${refs}</Refs>` : ""}` +
          `<RltdPties><${party}><Nm>${esc(e.name ?? "Counterparty")}</Nm></${party}>` +
          (e.iban ? `<${party}Acct><Id><IBAN>${e.iban}</IBAN></Id></${party}Acct>` : "") +
          `</RltdPties>` +
          (e.bic
            ? `<RltdAgts><${party}Agt><FinInstnId><BIC>${e.bic}</BIC></FinInstnId></${party}Agt></RltdAgts>`
            : "") +
          (e.purpose ? `<RmtInf><Ustrd>${esc(e.purpose)}</Ustrd></RmtInf>` : "") +
          (e.returnCode ? `<RtrInf><Rsn><Cd>${e.returnCode}</Cd></Rsn></RtrInf>` : "") +
          `</TxDtls></NtryDtls></Ntry>`)
    );
  };
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>` +
    `<GrpHdr><MsgId>${s.messageId ?? "MSG-1"}</MsgId><CreDtTm>${s.to}T21:00:00</CreDtTm></GrpHdr>` +
    `<Stmt><Id>STMT-${s.from}-${s.to}</Id><FrToDt><FrDtTm>${s.from}T00:00:00</FrDtTm><ToDtTm>${s.to}T23:59:59</ToDtTm></FrToDt>` +
    `<Acct><Id><IBAN>${s.account}</IBAN></Id><Ccy>BYN</Ccy></Acct>` +
    bal("OPBD", s.opening, s.from) +
    bal("CLBD", s.closing, s.to) +
    s.entries.map(ntry).join("") +
    `</Stmt></BkToCstmrStmt></Document>`
  );
}

/** The spec's CSV layout (`,`-delimited, UTF-8). */
export function statementCsv(s: StatementSpec): string {
  const q = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const rows = s.entries.map((e) =>
    [
      e.ref,
      e.date,
      e.date,
      `${e.credit ? "" : "-"}${e.amount}`,
      "BYN",
      e.name ?? "Counterparty",
      e.iban ?? "",
      e.bic ?? "",
      "",
      e.returnCode ?? "",
      e.purpose ?? e.endToEnd ?? "",
      e.documentNo ?? "",
    ]
      .map(q)
      .join(","),
  );
  return [
    `#account,${s.account}`,
    `#period,${s.from},${s.to}`,
    `#opening,${s.opening}`,
    `#closing,${s.closing}`,
    STATEMENT_CSV_COLUMNS.join(","),
    ...rows,
  ].join("\r\n");
}

export const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** The `n` most recent Belarusian business days up to today (Minsk), oldest first (weekends only here). */
export function recentBusinessDays(n: number, calendar = new BusinessCalendar()): string[] {
  const out: string[] = [];
  let d = minskDate(new Date());
  while (out.length < n) {
    if (calendar.isBusinessDay(d)) out.unshift(d);
    d = new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

/** The calendar day after `day`. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
