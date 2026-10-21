import { csvCell, parseCsv, toCsv } from "./csv";

describe("csv writer (RFC 4180, SPEC §8)", () => {
  it("quotes every cell, doubles quotes, ends every record with CRLF", () => {
    expect(
      toCsv(
        [
          ['say "hi"', "a,b", "line1\nline2", 42, 7n, true, null, undefined],
          [new Date("2026-10-19T08:00:00Z"), "", "Иван"],
        ],
        "human",
        ["text", "comma", "multi", "n", "big", "bool", "null", "undef"],
      ),
    ).toBe(
      '"text","comma","multi","n","big","bool","null","undef"\r\n' +
        '"say ""hi""","a,b","line1\nline2","42","7","true","",""\r\n' +
        '"2026-10-19T08:00:00.000Z","","Иван"\r\n',
    );
  });

  it("human mode defuses formula starts (= + - @ TAB CR) but keeps plain signed decimals", () => {
    expect(csvCell('=HYPERLINK("http://x")', "human")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1+cmd|' /C calc'!A0", "human")).toBe("\"'+1+cmd|' /C calc'!A0\"");
    expect(csvCell("-2+3", "human")).toBe('"\'-2+3"');
    expect(csvCell("@SUM(A1)", "human")).toBe('"\'@SUM(A1)"');
    expect(csvCell("\tx", "human")).toBe('"\'\tx"');
    expect(csvCell("\rx", "human")).toBe('"\'\rx"');
    expect(csvCell("-12.50", "human")).toBe('"-12.50"');
    expect(csvCell("+5", "human")).toBe('"+5"');
    expect(csvCell(-3, "human")).toBe('"-3"');
    expect(csvCell("a=b", "human")).toBe('"a=b"');
  });

  it("bank mode writes cells verbatim and refuses control characters", () => {
    expect(csvCell("=Ivanov", "bank")).toBe('"=Ivanov"');
    expect(csvCell("-12.50", "bank")).toBe('"-12.50"');
    expect(() => csvCell("Ivan\r\nPetrov", "bank")).toThrow(/control characters/);
    expect(() => csvCell("x\u0000", "bank")).toThrow(/control characters/);
    expect(() => csvCell(Number.NaN, "bank")).toThrow(/non-finite/);
  });
});

describe("csv reader (RFC 4180)", () => {
  it("reads quoted fields, escaped quotes, embedded line breaks, CRLF / LF and ; delimiters", () => {
    expect(parseCsv('a,"b ""q""","c\r\nd"\r\n1,,3\n')).toEqual([
      ["a", 'b "q"', "c\r\nd"],
      ["1", "", "3"],
    ]);
    expect(parseCsv("x;y\n\n1;2", { delimiter: ";" })).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
    expect(parseCsv('""')).toEqual([[""]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("round-trips the writer's output", () => {
    const rows = [
      ['he said "no"', "a,b", "x\ny"],
      ["", "-1", "Ўладзімір"],
    ];
    expect(parseCsv(toCsv(rows, "human"))).toEqual(rows);
  });

  it("refuses stray quotes, text after a closing quote, an unterminated quote and too many records", () => {
    expect(() => parseCsv('ab"c,d')).toThrow(/quote inside an unquoted field/);
    expect(() => parseCsv('"ab"c,d')).toThrow(/text after a closing quote/);
    expect(() => parseCsv('"abc,d')).toThrow(/unterminated quote/);
    expect(() => parseCsv("1\n2\n3\n", { maxRows: 2 })).toThrow(/more than 2 records/);
  });
});
