import { decodeXmlText, parseSafeXml, scanXml } from "./safe-xml";

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <!-- a comment with <tags> inside -->
      <Ntry><Amt Ccy="BYN">1234567890123.4500000001</Amt><CdtDbtInd>CRDT</CdtDbtInd>
        <AddtlNtryInf><![CDATA[TO-123456789012 <payment>]]></AddtlNtryInf>
        <Nm>ООО &quot;Ромашка&quot; &amp; Co</Nm></Ntry>
      <Ntry><Amt Ccy="BYN">5.00</Amt></Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe("parseSafeXml (SPEC §8, X16)", () => {
  it("parses a camt.053-shaped statement: strings kept exact, attributes under @_, namespaces dropped", () => {
    const doc = parseSafeXml(CAMT) as {
      Document: { BkToCstmrStmt: { Stmt: { Ntry: Record<string, unknown>[] } } };
    };
    const [first, second] = doc.Document.BkToCstmrStmt.Stmt.Ntry;
    expect(first.Amt).toEqual({ "#text": "1234567890123.4500000001", "@_Ccy": "BYN" });
    expect(first.AddtlNtryInf).toBe("TO-123456789012 <payment>");
    expect(decodeXmlText(first.Nm as string)).toBe('ООО "Ромашка" & Co');
    expect(second.Amt).toEqual({ "#text": "5.00", "@_Ccy": "BYN" });
  });

  it.each([
    [
      "a DOCTYPE (XXE / billion laughs)",
      '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "y">]><d>&x;</d>',
      /DOCTYPE is not allowed/,
    ],
    [
      "an ENTITY outside a DOCTYPE",
      '<d><!ENTITY x SYSTEM "file:///etc/passwd"></d>',
      /ENTITY is not allowed/,
    ],
    ["a lower-case doctype", "<!doctype html><d/>", /DOCTYPE is not allowed/],
    ["any other declaration", "<d><!ELEMENT d ANY></d>", /declarations are not allowed/],
    [
      "a __proto__ element",
      "<d><__proto__><polluted>1</polluted></__proto__></d>",
      /__proto__ is not allowed/,
    ],
    [
      "a namespaced constructor element",
      "<d><x:constructor xmlns:x='u'/></d>",
      /constructor is not allowed/,
    ],
    ["a prototype attribute", '<d prototype="1"/>', /prototype is not allowed/],
    ["nesting deeper than 32", `${"<a>".repeat(33)}${"</a>".repeat(33)}`, /nesting deeper than 32/],
    ["an unterminated tag", '<d a="1', /unterminated attribute value/],
    ["an unbalanced close", "<d></d></e>", /unbalanced closing tag/],
    ["malformed markup", "<d><e></d>", /malformed at line 1/],
    ["text with a raw <", "<d>a < b</d>", /malformed tag/],
  ])("refuses %s", (_name, xml, pattern) => {
    expect(() => parseSafeXml(xml)).toThrow(pattern);
  });

  it("caps the element count and the length, and accepts exactly the limits", () => {
    const many = `<r>${"<e/>".repeat(50_000)}</r>`;
    expect(() => scanXml(many)).toThrow(/more than 50000 elements/);
    expect(() => scanXml(`<r>${"<e/>".repeat(49_999)}</r>`)).not.toThrow();
    expect(() => parseSafeXml(`${"<a>".repeat(32)}${"</a>".repeat(32)}`)).not.toThrow();
    expect(() => parseSafeXml("<r>x</r>", { maxLength: 4 })).toThrow(/too large/);
  });

  it("keeps a > inside attribute values; DOCTYPE text is refused anywhere, even inside a comment", () => {
    expect(parseSafeXml("<r a=\"x>y\" b='<z>'>v</r>")).toEqual({
      r: { "#text": "v", "@_a": "x>y", "@_b": "<z>" },
    });
    expect(() => parseSafeXml("<r><!-- <!DOCTYPE x> --></r>")).toThrow(/DOCTYPE is not allowed/);
  });

  it("scans a long run inside one tag in linear time (C24: no ReDoS), refused or not", () => {
    const run = "b".repeat(200_000);
    const ms = (xml: string) => {
      const t0 = performance.now();
      try {
        scanXml(xml);
      } catch {
        // A refusal is fine; only the time matters here.
      }
      return performance.now() - t0;
    };
    // The unanchored /name\s*=/g took ~25 s on this input (quadratic in the run's length).
    expect(ms(`<a ${run}>`)).toBeLessThan(1000);
    expect(ms(`<a ${run} c="1">`)).toBeLessThan(1000);
    expect(() => scanXml(`<a ${run}>`)).toThrow(/a tag longer than 8192 characters/);
    expect(() => scanXml(`<a b="${run}">`)).toThrow(/a tag longer than 8192 characters/);

    // With the per-tag cap lifted the walk itself stays linear: 1M chars, names still checked.
    const big = "b".repeat(1_000_000);
    const open = { maxTagLength: Number.MAX_SAFE_INTEGER };
    const t0 = performance.now();
    expect(() => scanXml(`<a ${big} c="1"></a>`, open)).not.toThrow();
    expect(() => scanXml(`<a ${big} constructor="1"/>`, open)).toThrow(/constructor is not/);
    expect(() => scanXml(`<a c='${big}' __proto__="1"/>`, open)).toThrow(/__proto__ is not/);
    expect(performance.now() - t0).toBeLessThan(1000);
    // A real camt.053 root tag is far below the cap.
    const root =
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">';
    expect(() => scanXml(`${root}</Document>`)).not.toThrow();
  });

  it("decodeXmlText decodes only predefined entities and numeric references", () => {
    expect(decodeXmlText("&lt;b&gt; &#1040;&#x0411; &apos;&quot; &unknown; &#0;")).toBe(
      "<b> АБ '\" &unknown; &#0;",
    );
  });
});
