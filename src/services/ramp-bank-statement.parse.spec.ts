import { ibanCheckDigits } from "../util/iban";
import { formatAmount, parseAmount } from "../util/money";
import { payoutReferenceFor } from "../util/payout-reference";
import {
  canonicalStatement,
  lineFromSealed,
  parseStatement,
  STATEMENT_CSV_COLUMNS,
  type ParsedStatement,
} from "./ramp-bank-statement.parse";

const iban = (code: string, tail: string): string => {
  const bban = `${code}3014${tail.padStart(16, "0")}`;
  return `BY${ibanCheckDigits("BY", bban)}${bban}`;
};
const CLIENT = iban("ALFA", "1");
const USER = iban("PJCB", "2");
const REF = payoutReferenceFor("00000000-0000-4000-8000-000000000001");
const SHOWN = `TO-${REF.slice(2)}`;
const OPTS = { currency: "BYN", fiatDecimals: 2 };

interface Entry {
  ref: string;
  amount: string;
  ind: "CRDT" | "DBIT";
  date?: string;
  iban?: string;
  bic?: string;
  name?: string;
  ustrd?: string;
  e2e?: string;
  instr?: string;
  rtr?: string;
  sub?: string;
  sts?: string;
}

function camt(o: {
  account?: string;
  from?: string;
  to?: string;
  opening: string;
  closing: string;
  entries: Entry[];
  extra?: string;
}): Uint8Array {
  const bal = (cd: string, amt: string): string =>
    `<Bal><Tp><CdOrPrtry><Cd>${cd}</Cd></CdOrPrtry></Tp><Amt Ccy="BYN">${amt}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-16</Dt></Dt></Bal>`;
  const ntry = (e: Entry): string => {
    const party = e.ind === "DBIT" ? "Cdtr" : "Dbtr";
    return (
      `<Ntry><NtryRef>${e.ref}</NtryRef><Amt Ccy="BYN">${e.amount}</Amt><CdtDbtInd>${e.ind}</CdtDbtInd>` +
      `<Sts>${e.sts ?? "BOOK"}</Sts><BookgDt><Dt>${e.date ?? "2026-10-16"}</Dt></BookgDt><ValDt><Dt>${e.date ?? "2026-10-16"}</Dt></ValDt>` +
      `<AcctSvcrRef>${e.ref}</AcctSvcrRef>` +
      `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>${e.sub ?? "DMCT"}</SubFmlyCd></Fmly></Domn></BkTxCd>` +
      `<NtryDtls><TxDtls><Refs>${e.e2e ? `<EndToEndId>${e.e2e}</EndToEndId>` : ""}${e.instr ? `<InstrId>${e.instr}</InstrId>` : ""}</Refs>` +
      `<RltdPties><${party}><Nm>${e.name ?? "Ivanou Ivan"}</Nm></${party}>${e.iban ? `<${party}Acct><Id><IBAN>${e.iban}</IBAN></Id></${party}Acct>` : ""}</RltdPties>` +
      (e.bic
        ? `<RltdAgts><${party}Agt><FinInstnId><BIC>${e.bic}</BIC></FinInstnId></${party}Agt></RltdAgts>`
        : "") +
      (e.ustrd ? `<RmtInf><Ustrd>${e.ustrd}</Ustrd></RmtInf>` : "") +
      (e.rtr ? `<RtrInf><Rsn><Cd>${e.rtr}</Cd></Rsn></RtrInf>` : "") +
      `</TxDtls></NtryDtls></Ntry>`
    );
  };
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>${o.extra ?? ""}<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>` +
    `<GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-10-17T06:00:00</CreDtTm></GrpHdr><Stmt><Id>S1</Id>` +
    `<FrToDt><FrDtTm>${o.from ?? "2026-10-16"}T00:00:00</FrDtTm><ToDtTm>${o.to ?? "2026-10-16"}T23:59:59</ToDtTm></FrToDt>` +
    `<Acct><Id><IBAN>${o.account ?? CLIENT}</IBAN></Id><Ccy>BYN</Ccy></Acct>` +
    bal("OPBD", o.opening) +
    bal("CLBD", o.closing) +
    o.entries.map(ntry).join("") +
    `</Stmt></BkToCstmrStmt></Document>`;
  return new TextEncoder().encode(xml);
}

function csv(meta: string[], rows: string[][], delimiter = ","): Uint8Array {
  const line = (cells: string[]): string => cells.join(delimiter);
  const text = [...meta, line([...STATEMENT_CSV_COLUMNS]), ...rows.map(line)].join("\r\n");
  return new TextEncoder().encode(text);
}

describe("statement parsing (SPEC §10.4, X3, X16)", () => {
  it("reads a camt.053: account, period and balances from the file, signed lines, the counterparty by direction", () => {
    const s = parseStatement(
      {
        format: "camt053",
        bytes: camt({
          opening: "1000.00",
          closing: "950.01",
          entries: [
            {
              ref: "B-1",
              amount: "50.00",
              ind: "DBIT",
              iban: USER,
              bic: "PJCBBY2X",
              ustrd: `Выплата по заказу ${SHOWN}`,
              instr: "17",
            },
            { ref: "B-2", amount: "0.01", ind: "CRDT", iban: USER, ustrd: "hello" },
          ],
        }),
      },
      OPTS,
    );
    expect(s).toMatchObject({
      format: "camt053",
      account: CLIENT,
      currency: "BYN",
      periodFrom: "2026-10-16",
      periodTo: "2026-10-16",
      opening: parseAmount("1000"),
      closing: parseAmount("950.01"),
    });
    expect(s.lines[0]).toMatchObject({
      lineRef: "B-1",
      amount: parseAmount("-50"),
      counterpartyIban: USER,
      counterpartyBic: "PJCBBY2X",
      reference: REF,
      documentNo: "17",
      returnInfo: false,
      bankTxCode: "PMNT/ICDT/DMCT",
    });
    expect(s.lines[1]).toMatchObject({ amount: parseAmount("0.01"), reference: null });
  });

  it("recognises returns by RtrInf or the RRTN sub-family, and references typed with Cyrillic letters (m1)", () => {
    const cyr = `Возврат ТО-${REF.slice(2, 8)} ${REF.slice(8)}`; // Cyrillic Т and О, a space inside
    const s = parseStatement(
      {
        format: "camt053",
        bytes: camt({
          opening: "0",
          closing: "100.00",
          entries: [
            { ref: "R-1", amount: "50.00", ind: "CRDT", ustrd: cyr, rtr: "AC04" },
            { ref: "R-2", amount: "50.00", ind: "CRDT", e2e: REF, sub: "RRTN" },
          ],
        }),
      },
      OPTS,
    );
    expect(s.lines.map((l) => [l.reference, l.returnInfo, l.returnCode])).toEqual([
      [REF, true, "AC04"],
      [REF, true, "RRTN"],
    ]);
  });

  it("refuses a statement that does not add up, books outside its period, repeats a line or is not booked", () => {
    const refuse = (bytes: Uint8Array): string => {
      try {
        parseStatement({ format: "camt053", bytes }, OPTS);
        return "accepted";
      } catch (err) {
        return (err as Error).message;
      }
    };
    const one: Entry = { ref: "X", amount: "10.00", ind: "CRDT" };
    expect(refuse(camt({ opening: "0", closing: "9.99", entries: [one] }))).toMatch(/add up/);
    expect(
      refuse(camt({ opening: "0", closing: "10.00", entries: [{ ...one, date: "2026-10-17" }] })),
    ).toMatch(/outside the period/);
    expect(refuse(camt({ opening: "0", closing: "20.00", entries: [one, one] }))).toMatch(/twice/);
    expect(
      refuse(camt({ opening: "0", closing: "10.00", entries: [{ ...one, sts: "PDNG" }] })),
    ).toMatch(/booked/);
    expect(
      refuse(camt({ opening: "0", closing: "10.001", entries: [{ ...one, amount: "10.001" }] })),
    ).toMatch(/kopecks/);
    expect(
      refuse(
        camt({ opening: "0", closing: "0", entries: [], from: "2026-10-17", to: "2026-10-16" }),
      ),
    ).toMatch(/ends before/);
  });

  it("refuses hostile XML before parsing it: DOCTYPE, entities, deep nesting, __proto__ (X16)", () => {
    const bad = (s: string): Uint8Array => new TextEncoder().encode(s);
    const expectRefused = (bytes: Uint8Array, re: RegExp): void =>
      expect(() => parseStatement({ format: "camt053", bytes }, OPTS)).toThrow(re);
    expectRefused(
      camt({ opening: "0", closing: "0", entries: [], extra: '<!DOCTYPE d [<!ENTITY x "y">]>' }),
      /DOCTYPE/,
    );
    expectRefused(bad(`<a>${"<b>".repeat(40)}${"</b>".repeat(40)}</a>`), /XML refused/);
    expectRefused(bad("<Document><__proto__><x>1</x></__proto__></Document>"), /XML refused/);
    expectRefused(
      bad("<Document><BkToCstmrStmt></BkToCstmrStmt></Document>"),
      /exactly one statement/,
    );
    expectRefused(bad("not xml"), /XML refused|statement/);
  });

  it("reads the CSV layout (`;` + decimal commas, windows-1251) and refuses a wrong header or missing metadata", () => {
    const rows = [
      [
        "L1",
        "2026-10-16",
        "",
        "-50,00",
        "BYN",
        "Іваноў",
        USER,
        "PJCBBY2X",
        "",
        "",
        `Выплата ${SHOWN}`,
        "17",
      ],
    ];
    const text = [
      `#account;${CLIENT}`,
      "#period;2026-10-16;2026-10-16",
      "#opening;100,00",
      "#closing;50,00",
    ];
    const bytes1251 = Buffer.from(
      new TextDecoder("utf-8").decode(csv(text, rows, ";")).replace(/[^ -~\r\n]/g, "?"),
      "latin1",
    );
    const s = parseStatement({ format: "csv", bytes: csv(text, rows, ";") }, OPTS);
    expect(s.lines[0]).toMatchObject({
      amount: parseAmount("-50"),
      reference: REF,
      counterpartyName: "Іваноў",
    });
    // a Windows-1251 file decodes when the uploader says so (bytes here are ASCII-only, still valid)
    expect(
      parseStatement({ format: "csv", bytes: bytes1251, charset: "windows-1251" }, OPTS).lines,
    ).toHaveLength(1);
    expect(() =>
      parseStatement({ format: "csv", bytes: csv(text.slice(0, 3), rows, ";") }, OPTS),
    ).toThrow(/#closing/);
    const badHeader = new TextEncoder().encode(`${text.join("\n")}\nline_ref;amount\nL1;-50,00`);
    expect(() => parseStatement({ format: "csv", bytes: badHeader }, OPTS)).toThrow(
      /column header/,
    );
  });

  it("gives two copies of one statement the same canonical parse only when every field the matcher reads agrees, in one format (C7)", () => {
    const entry = {
      ref: "L1",
      amount: "50.00",
      ind: "DBIT" as const,
      iban: USER,
      ustrd: `x ${SHOWN}`,
    };
    const read = (e: Entry[], extra?: string): ParsedStatement =>
      parseStatement(
        {
          format: "camt053",
          bytes: camt({ opening: "100.00", closing: "50.00", entries: e, extra }),
        },
        OPTS,
      );
    const fromCamt = read([entry]);
    // Another download of the same statement (header noise aside): equal.
    expect(canonicalStatement(read([entry], "<!-- downloaded again -->"))).toBe(
      canonicalStatement(fromCamt),
    );
    // The purpose, the document number, the BIC or the return code changed: never equal.
    for (const changed of [
      { ...entry, ustrd: SHOWN },
      { ...entry, instr: "101" },
      { ...entry, bic: "PJCBBY2X" },
      { ...entry, rtr: "AC04" },
    ])
      expect(canonicalStatement(read([changed]))).not.toBe(canonicalStatement(fromCamt));
    const meta = [
      `#account,${CLIENT}`,
      "#period,2026-10-16,2026-10-16",
      "#opening,100.00",
      "#closing,50.00",
    ];
    const row = (iban2: string, purpose = `x ${SHOWN}`): string[][] => [
      ["L1", "2026-10-16", "", "-50.00", "BYN", "Other name", iban2, "", "", "", purpose, ""],
    ];
    const asCsv = parseStatement({ format: "csv", bytes: csv(meta, row(USER)) }, OPTS);
    // A CSV never stands for a camt.053 (the uploader types every cell of a CSV).
    expect(canonicalStatement(asCsv)).not.toBe(canonicalStatement(fromCamt));
    expect(
      canonicalStatement(parseStatement({ format: "csv", bytes: csv(meta, row(USER)) }, OPTS)),
    ).toBe(canonicalStatement(asCsv));
    // Whitespace aside, a blanked or edited purpose differs; so does any changed figure.
    expect(
      canonicalStatement(
        parseStatement({ format: "csv", bytes: csv(meta, row(USER, `  x   ${SHOWN} `)) }, OPTS),
      ),
    ).toBe(canonicalStatement(asCsv));
    for (const r of [row(USER, SHOWN), row(iban("PJCB", "3"))])
      expect(
        canonicalStatement(parseStatement({ format: "csv", bytes: csv(meta, r) }, OPTS)),
      ).not.toBe(canonicalStatement(asCsv));
    // What raw_sealed keeps rebuilds the same canonical parse (the statement re-indexer, C41).
    const sealed = fromCamt.lines.map((l) =>
      lineFromSealed(
        JSON.parse(JSON.stringify({ ...l, amount: formatAmount(l.amount) })) as Record<
          string,
          unknown
        >,
      ),
    );
    expect(canonicalStatement({ ...fromCamt, lines: sealed })).toBe(canonicalStatement(fromCamt));
  });

  it("keeps every transaction's reference and document number of a batch-booked entry, and the bank's file ids (C6)", () => {
    const refs = ["01", "02", "03"].map((n) =>
      payoutReferenceFor(`00000000-0000-4000-8000-0000000000${n}`),
    );
    const tx = (r: string, n: string): string =>
      `<TxDtls><Refs><EndToEndId>${r}</EndToEndId><InstrId>${n}</InstrId></Refs><RmtInf><Ustrd>Выплата ${r}</Ustrd></RmtInf></TxDtls>`;
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>` +
      `<GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-10-17T06:00:00</CreDtTm></GrpHdr><Stmt><Id>S1</Id>` +
      `<FrToDt><FrDtTm>2026-10-16T00:00:00</FrDtTm><ToDtTm>2026-10-16T23:59:59</ToDtTm></FrToDt>` +
      `<Acct><Id><IBAN>${CLIENT}</IBAN></Id><Ccy>BYN</Ccy></Acct>` +
      `<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="BYN">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-16</Dt></Dt></Bal>` +
      `<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="BYN">250.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-16</Dt></Dt></Bal>` +
      `<Ntry><NtryRef>BULK-1</NtryRef><Amt Ccy="BYN">750.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>` +
      `<BookgDt><Dt>2026-10-16</Dt></BookgDt><AcctSvcrRef>BULK-1</AcctSvcrRef><NtryDtls>` +
      `<Btch><MsgId>PAIN-7</MsgId><PmtInfId>PP-BULK-42</PmtInfId><NbOfTxs>3</NbOfTxs></Btch>` +
      refs.map((r, i) => tx(r, String(101 + i))).join("") +
      `</NtryDtls><AddtlNtryInf>Bulk payment file PP-BULK-42</AddtlNtryInf></Ntry></Stmt></BkToCstmrStmt></Document>`;
    const [bulk] = parseStatement(
      { format: "camt053", bytes: new TextEncoder().encode(xml) },
      OPTS,
    ).lines;
    // No single order is quoted; each transaction is.
    expect(bulk).toMatchObject({
      reference: null,
      documentNo: null,
      counterpartyIban: null,
      references: refs,
      documentNos: ["101", "102", "103"],
      batchRefs: ["PAIN-7", "PP-BULK-42"],
    });
    // A CSV bulk line names every reference of its purpose and quotes no single order.
    const meta = [
      `#account,${CLIENT}`,
      "#period,2026-10-16,2026-10-16",
      "#opening,1000.00",
      "#closing,250.00",
    ];
    const shown = refs.map((r) => `TO-${r.slice(2)}`).join(" / ");
    const [csvBulk] = parseStatement(
      {
        format: "csv",
        bytes: csv(meta, [
          [
            "BULK-1",
            "2026-10-16",
            "",
            "-750.00",
            "BYN",
            "Bank",
            "",
            "",
            "",
            "",
            `Выплаты ${shown}`,
            "",
          ],
        ]),
      },
      OPTS,
    ).lines;
    expect(csvBulk).toMatchObject({ reference: null, references: refs, documentNos: [] });
  });

  /** One day's statement holding one debit entry (the given NtryDtls / AddtlNtryInf). */
  const oneEntry = (amount: string, details: string, info: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>` +
    `<GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-10-17T06:00:00</CreDtTm></GrpHdr><Stmt><Id>S1</Id>` +
    `<FrToDt><FrDtTm>2026-10-16T00:00:00</FrDtTm><ToDtTm>2026-10-16T23:59:59</ToDtTm></FrToDt>` +
    `<Acct><Id><IBAN>${CLIENT}</IBAN></Id><Ccy>BYN</Ccy></Acct>` +
    `<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="BYN">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-16</Dt></Dt></Bal>` +
    `<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="BYN">${formatAmount(parseAmount("1000") - parseAmount(amount)).replace(/0{8}$/, "")}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-16</Dt></Dt></Bal>` +
    `<Ntry><NtryRef>E-1</NtryRef><Amt Ccy="BYN">${amount}</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>` +
    `<BookgDt><Dt>2026-10-16</Dt></BookgDt><AcctSvcrRef>E-1</AcctSvcrRef>${details}` +
    `<AddtlNtryInf>${info}</AddtlNtryInf></Ntry></Stmt></BkToCstmrStmt></Document>`;
  const parseOne = (xml: string) =>
    parseStatement({ format: "camt053", bytes: new TextEncoder().encode(xml) }, OPTS);

  it("R2a-5: keeps each transaction's creditor IBAN and amount; the canonical parse covers them", () => {
    const refs = ["01", "02"].map((n) =>
      payoutReferenceFor(`00000000-0000-4000-8000-0000000000${n}`),
    );
    const tx = (r: string, to: string, amount: string): string =>
      `<TxDtls><Refs><EndToEndId>${r}</EndToEndId></Refs><AmtDtls><TxAmt><Amt Ccy="BYN">${amount}</Amt></TxAmt></AmtDtls>` +
      `<RltdPties><Cdtr><Nm>X</Nm></Cdtr><CdtrAcct><Id><IBAN>${to}</IBAN></Id></CdtrAcct></RltdPties></TxDtls>`;
    const statement = (to: string): ParsedStatement =>
      parseOne(
        oneEntry(
          "50.00",
          `<NtryDtls>${tx(refs[0], to, "30.00")}${tx(refs[1], USER, "20.00")}</NtryDtls>`,
          "Bulk payment file PP-1",
        ),
      );
    const [bulk] = statement(USER).lines;
    expect(bulk.transactions).toEqual([
      { reference: refs[0], documentNo: null, iban: USER, amount: formatAmount(parseAmount("30")) },
      { reference: refs[1], documentNo: null, iban: USER, amount: formatAmount(parseAmount("20")) },
    ]);
    expect(bulk).toMatchObject({ reference: null, counterpartyIban: null, references: refs });
    // A second copy whose first transaction went elsewhere is another statement.
    expect(canonicalStatement(statement(iban("POIS", "4")))).not.toBe(
      canonicalStatement(statement(USER)),
    );
    // What raw_sealed keeps brings them back.
    const sealed = lineFromSealed(
      JSON.parse(JSON.stringify({ ...bulk, amount: formatAmount(bulk.amount) })) as Record<
        string,
        unknown
      >,
    );
    expect(sealed.transactions).toEqual(bulk.transactions);
  });

  it("R2a-8: an entry without transaction details names the payouts of its entry text", () => {
    const [line] = parseOne(oneEntry("5.00", "", `payout ${SHOWN}`)).lines;
    expect(line).toMatchObject({
      reference: null,
      references: [REF],
      documentNos: [],
      transactions: [],
    });
  });
});
