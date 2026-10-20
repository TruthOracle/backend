import {
  ibanBankCode,
  ibanCheckDigits,
  ibanLast4,
  ibanMod97,
  isValidByIban,
  maskIban,
  normalizeBic,
  normalizeIban,
  parseByIban,
} from "./iban";

describe("iban (SPEC §10.1)", () => {
  it("passes the published Belarusian examples and fails a one-character change (mod-97)", () => {
    expect(ibanMod97("BY86AKBB10100000002966000000")).toBe(1);
    expect(isValidByIban("BY86AKBB10100000002966000000")).toBe(true);
    expect(isValidByIban("BY13NBRB3600900000002Z00AB00")).toBe(true);
    expect(parseByIban("BY86AKBB10100000002966000001")).toEqual({
      ok: false,
      problem: "checksum",
    });
    expect(parseByIban("BY87AKBB10100000002966000000")).toEqual({
      ok: false,
      problem: "checksum",
    });
  });

  it("normalises spaces, dashes, lower case and Cyrillic look-alikes before checking", () => {
    expect(normalizeIban(" by86 akbb-1010 0000 0029 6600 0000 ")).toBe(
      "BY86AKBB10100000002966000000",
    );
    // Cyrillic В, У, А, К typed on a Russian keyboard
    expect(normalizeIban("ВУ86АКВВ10100000002966000000")).toBe("BY86AKBB10100000002966000000");
    expect(parseByIban("by86 akbb 1010 0000 0029 6600 0000")).toEqual({
      ok: true,
      iban: "BY86AKBB10100000002966000000",
      bankCode: "AKBB",
      balanceAccount: "1010",
      last4: "0000",
    });
  });

  it("refuses other countries, wrong lengths and layouts", () => {
    expect(parseByIban("")).toEqual({ ok: false, problem: "empty" });
    expect(parseByIban("DE89370400440532013000")).toEqual({ ok: false, problem: "country" });
    expect(parseByIban("BY86AKBB1010000000296600000")).toEqual({ ok: false, problem: "length" });
    // the balance account (characters 9–12) must be digits
    expect(parseByIban("BY86AKBBX0100000002966000000")).toEqual({ ok: false, problem: "format" });
    expect(parseByIban("BY86AKBB10100000002966000!00")).toEqual({ ok: false, problem: "format" });
  });

  it("computes check digits that round-trip", () => {
    const bban = "ALFA3014" + "1234567890123456";
    const iban = `BY${ibanCheckDigits("BY", bban)}${bban}`;
    expect(isValidByIban(iban)).toBe(true);
    expect(ibanBankCode(iban)).toBe("ALFA");
    expect(ibanLast4(iban)).toBe("3456");
  });

  it("masks to the last four characters only", () => {
    expect(maskIban("BY86AKBB10100000002966000000")).toBe("BY•• •••• … 0000");
    expect(maskIban("1234")).toBe("BY•• •••• … 1234");
  });

  it("accepts 8- and 11-character BICs only", () => {
    expect(normalizeBic(" alfaby2x ")).toBe("ALFABY2X");
    expect(normalizeBic("ALFABY2XXXX")).toBe("ALFABY2XXXX");
    expect(normalizeBic("ALFABY2")).toBeNull();
    expect(normalizeBic("")).toBeNull();
  });
});
