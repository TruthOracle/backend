import {
  absAmount,
  addAmount,
  cmpAmount,
  DUST,
  formatAmount,
  formatAmountWithDecimals,
  isDust,
  moneyTransformer,
  parseAmount,
  quantizeDown,
  subAmount,
  sumAmount,
  tryParseAmount,
} from "./money";

describe("util/money", () => {
  it("parses plain decimals into 1e-10 units", () => {
    expect(parseAmount("12.5")).toBe(125_000_000_000n);
    expect(parseAmount("12.5000000000")).toBe(125_000_000_000n);
    expect(parseAmount("0.0000000001")).toBe(1n);
    expect(parseAmount("7")).toBe(70_000_000_000n);
    expect(parseAmount(".5")).toBe(5_000_000_000n);
    expect(parseAmount("-0.25")).toBe(-2_500_000_000n);
    expect(parseAmount("+3.")).toBe(30_000_000_000n);
    expect(parseAmount(" 1.5 ")).toBe(15_000_000_000n);
  });

  it("parses numbers through toFixed (no binary artefacts, no scientific notation)", () => {
    expect(parseAmount(0.1 + 0.2)).toBe(3_000_000_000n);
    expect(parseAmount(1e-7)).toBe(1_000n);
    expect(parseAmount(12.5)).toBe(125_000_000_000n);
    expect(parseAmount(2.0000000001)).toBe(20_000_000_001n);
  });

  it("rounds digits beyond 10 decimals half away from zero", () => {
    expect(parseAmount("1.00000000004")).toBe(10_000_000_000n);
    expect(parseAmount("1.00000000005")).toBe(10_000_000_001n);
    expect(parseAmount("-1.00000000005")).toBe(-10_000_000_001n);
  });

  it("rejects non-decimal input", () => {
    for (const bad of ["", "abc", "1e5", "1,5", "0x10", "--1", ".", "NaN", "Infinity"]) {
      expect(() => parseAmount(bad)).toThrow(TypeError);
    }
    expect(() => parseAmount(Number.NaN)).toThrow(TypeError);
    expect(() => parseAmount(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(tryParseAmount("abc")).toBeNull();
    expect(tryParseAmount(null)).toBeNull();
    expect(tryParseAmount("2")).toBe(20_000_000_000n);
  });

  it("formats with exactly 10 decimals", () => {
    expect(formatAmount(125_000_000_000n)).toBe("12.5000000000");
    expect(formatAmount(0n)).toBe("0.0000000000");
    expect(formatAmount(1n)).toBe("0.0000000001");
    expect(formatAmount(-2_500_000_000n)).toBe("-0.2500000000");
    expect(formatAmount(parseAmount("123456789012345678.1234567891"))).toBe(
      "123456789012345678.1234567891",
    );
  });

  it("round-trips numeric(38,10) through the column transformer", () => {
    expect(moneyTransformer.to(parseAmount("99.5"))).toBe("99.5000000000");
    expect(moneyTransformer.from("99.5000000000")).toBe(995_000_000_000n);
    expect(moneyTransformer.to(null)).toBeNull();
    expect(moneyTransformer.from(null)).toBeNull();
  });

  it("does exact arithmetic and comparisons", () => {
    expect(addAmount(parseAmount("0.1"), parseAmount("0.2"))).toBe(parseAmount("0.3"));
    expect(subAmount(parseAmount("1"), parseAmount("0.0000000001"))).toBe(
      parseAmount("0.9999999999"),
    );
    expect(cmpAmount(1n, 2n)).toBe(-1);
    expect(cmpAmount(2n, 2n)).toBe(0);
    expect(cmpAmount(3n, 2n)).toBe(1);
    expect(absAmount(-5n)).toBe(5n);
    expect(sumAmount([1n, 2n, 3n])).toBe(6n);
  });

  it("treats ≤ 1e-9 units as dust", () => {
    expect(DUST).toBe(10n);
    expect(isDust(10n)).toBe(true);
    expect(isDust(-10n)).toBe(true);
    expect(isDust(11n)).toBe(false);
  });

  describe("instrument decimals", () => {
    it("quantizeDown truncates toward zero to the instrument's smallest unit and keeps the 10-dp scale", () => {
      const amount = parseAmount("12.3456789012");
      expect(quantizeDown(amount, 6)).toBe(parseAmount("12.345678"));
      expect(amount - quantizeDown(amount, 6)).toBe(parseAmount("0.0000009012"));
      expect(quantizeDown(amount, 10)).toBe(amount);
      expect(quantizeDown(amount, 0)).toBe(parseAmount("12"));
      expect(quantizeDown(parseAmount("0.0000009"), 6)).toBe(0n);
      // Negative amounts shrink in magnitude too: a payout never grows by quantisation.
      expect(quantizeDown(parseAmount("-12.3456789"), 6)).toBe(parseAmount("-12.345678"));
      expect(quantizeDown(parseAmount("1.999999"), 2)).toBe(parseAmount("1.99"));
    });

    it("formatAmountWithDecimals emits exactly the instrument's decimals (none for a 0-decimal token)", () => {
      expect(formatAmountWithDecimals(parseAmount("12.5"), 6)).toBe("12.500000");
      expect(formatAmountWithDecimals(parseAmount("12.3456789012"), 6)).toBe("12.345678");
      expect(formatAmountWithDecimals(parseAmount("12.3456789012"), 10)).toBe("12.3456789012");
      expect(formatAmountWithDecimals(parseAmount("7"), 0)).toBe("7");
      expect(formatAmountWithDecimals(parseAmount("7.9"), 0)).toBe("7");
      expect(formatAmountWithDecimals(0n, 6)).toBe("0.000000");
      expect(formatAmountWithDecimals(parseAmount("-0.25"), 2)).toBe("-0.25");
    });

    it("refuses decimals outside 0..10", () => {
      expect(() => quantizeDown(1n, 11)).toThrow(RangeError);
      expect(() => quantizeDown(1n, -1)).toThrow(RangeError);
      expect(() => quantizeDown(1n, 2.5)).toThrow(RangeError);
      expect(() => formatAmountWithDecimals(1n, 18)).toThrow(RangeError);
    });
  });
});
