import { formatAmount } from "./money";
import {
  asDecimal,
  asEnum,
  asInt,
  asList,
  asOptional,
  asOptionalDecimal,
  asOptionalText,
  asTextList,
  bigintNumberTransformer,
  divDecimal,
  isoToDate,
  mulDecimal,
  ONE_DECIMAL,
  secondsToDate,
} from "./ledger-values";

describe("ledger value decoding", () => {
  it("decimals are fixed point, never Number", () => {
    expect(formatAmount(asDecimal("12.5"))).toBe("12.5000000000");
    expect(formatAmount(asDecimal("0.1234567891234"))).toBe("0.1234567891");
    expect(asDecimal(undefined)).toBe(0n);
    expect(asDecimal("nope")).toBe(0n);
    expect(asOptionalDecimal(null)).toBeNull();
    expect(asOptionalDecimal("1")).toBe(ONE_DECIMAL);
  });

  it("ints from strings or numbers", () => {
    expect(asInt("42")).toBe(42);
    expect(asInt(7)).toBe(7);
    expect(asInt("-3")).toBe(-3);
    expect(asInt("x")).toBe(0);
    expect(asInt(null)).toBe(0);
  });

  it("enums as strings or tagged objects", () => {
    expect(asEnum("Trading")).toBe("Trading");
    expect(asEnum({ tag: "Resolved" })).toBe("Resolved");
    expect(asEnum(5)).toBeNull();
  });

  it("optionals in both encodings", () => {
    expect(asOptional(null)).toBeNull();
    expect(asOptional(undefined)).toBeNull();
    expect(asOptional("cid")).toBe("cid");
    expect(asOptional({ Some: "cid" })).toBe("cid");
    expect(asOptional({ None: {} })).toBeNull();
    expect(asOptional({ proposer: "p" })).toEqual({ proposer: "p" });
    expect(asOptionalText({ Some: "x" })).toBe("x");
    expect(asOptionalText(3)).toBeNull();
  });

  it("lists", () => {
    expect(asList(["a"])).toEqual(["a"]);
    expect(asList("a")).toEqual([]);
    expect(asTextList(["a", 1, "b"])).toEqual(["a", "b"]);
  });

  it("times", () => {
    expect(secondsToDate("1760000000")?.getTime()).toBe(1_760_000_000_000);
    expect(secondsToDate(0)).toBeNull();
    expect(isoToDate("2026-01-01T00:00:00Z")?.getTime()).toBe(Date.UTC(2026, 0, 1));
    expect(isoToDate("garbage")).toBeNull();
  });

  it("fixed-point arithmetic", () => {
    expect(formatAmount(mulDecimal(ONE_DECIMAL * 3n, ONE_DECIMAL / 2n))).toBe("1.5000000000");
    expect(formatAmount(divDecimal(ONE_DECIMAL, ONE_DECIMAL * 3n))).toBe("0.3333333333");
    expect(formatAmount(divDecimal(ONE_DECIMAL * 2n, ONE_DECIMAL * 3n))).toBe("0.6666666667");
    expect(divDecimal(1n, 0n)).toBe(0n);
  });

  it("bigint columns round-trip as numbers", () => {
    expect(bigintNumberTransformer.to(42)).toBe("42");
    expect(bigintNumberTransformer.from("42")).toBe(42);
    expect(bigintNumberTransformer.from(null)).toBeNull();
    expect(bigintNumberTransformer.to(undefined)).toBeNull();
  });
});
