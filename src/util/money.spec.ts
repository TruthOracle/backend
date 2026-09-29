import { absCC, addCC, cmpCC, DUST, formatCC, isDust, moneyTransformer, parseCC, subCC, sumCC, tryParseCC } from "./money";

describe("util/money", () => {
  it("parses plain decimals into 1e-10 units", () => {
    expect(parseCC("12.5")).toBe(125_000_000_000n);
    expect(parseCC("12.5000000000")).toBe(125_000_000_000n);
    expect(parseCC("0.0000000001")).toBe(1n);
    expect(parseCC("7")).toBe(70_000_000_000n);
    expect(parseCC(".5")).toBe(5_000_000_000n);
    expect(parseCC("-0.25")).toBe(-2_500_000_000n);
    expect(parseCC("+3.")).toBe(30_000_000_000n);
    expect(parseCC(" 1.5 ")).toBe(15_000_000_000n);
  });

  it("parses numbers through toFixed (no binary artefacts, no scientific notation)", () => {
    expect(parseCC(0.1 + 0.2)).toBe(3_000_000_000n);
    expect(parseCC(1e-7)).toBe(1_000n);
    expect(parseCC(12.5)).toBe(125_000_000_000n);
    expect(parseCC(2.0000000001)).toBe(20_000_000_001n);
  });

  it("rounds digits beyond 10 decimals half away from zero", () => {
    expect(parseCC("1.00000000004")).toBe(10_000_000_000n);
    expect(parseCC("1.00000000005")).toBe(10_000_000_001n);
    expect(parseCC("-1.00000000005")).toBe(-10_000_000_001n);
  });

  it("rejects non-decimal input", () => {
    for (const bad of ["", "abc", "1e5", "1,5", "0x10", "--1", ".", "NaN", "Infinity"]) {
      expect(() => parseCC(bad)).toThrow(TypeError);
    }
    expect(() => parseCC(Number.NaN)).toThrow(TypeError);
    expect(() => parseCC(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(tryParseCC("abc")).toBeNull();
    expect(tryParseCC(null)).toBeNull();
    expect(tryParseCC("2")).toBe(20_000_000_000n);
  });

  it("formats with exactly 10 decimals", () => {
    expect(formatCC(125_000_000_000n)).toBe("12.5000000000");
    expect(formatCC(0n)).toBe("0.0000000000");
    expect(formatCC(1n)).toBe("0.0000000001");
    expect(formatCC(-2_500_000_000n)).toBe("-0.2500000000");
    expect(formatCC(parseCC("123456789012345678.1234567891"))).toBe("123456789012345678.1234567891");
  });

  it("round-trips numeric(38,10) through the column transformer", () => {
    expect(moneyTransformer.to(parseCC("99.5"))).toBe("99.5000000000");
    expect(moneyTransformer.from("99.5000000000")).toBe(995_000_000_000n);
    expect(moneyTransformer.to(null)).toBeNull();
    expect(moneyTransformer.from(null)).toBeNull();
  });

  it("does exact arithmetic and comparisons", () => {
    expect(addCC(parseCC("0.1"), parseCC("0.2"))).toBe(parseCC("0.3"));
    expect(subCC(parseCC("1"), parseCC("0.0000000001"))).toBe(parseCC("0.9999999999"));
    expect(cmpCC(1n, 2n)).toBe(-1);
    expect(cmpCC(2n, 2n)).toBe(0);
    expect(cmpCC(3n, 2n)).toBe(1);
    expect(absCC(-5n)).toBe(5n);
    expect(sumCC([1n, 2n, 3n])).toBe(6n);
  });

  it("treats ≤ 1e-9 CC as dust", () => {
    expect(DUST).toBe(10n);
    expect(isDust(10n)).toBe(true);
    expect(isDust(-10n)).toBe(true);
    expect(isDust(11n)).toBe(false);
  });
});
