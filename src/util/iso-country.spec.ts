import { alpha2Codes, isAlpha2, toAlpha2 } from "./iso-country";

describe("iso-country (SPEC §11.3)", () => {
  it("knows the 249 assigned ISO 3166-1 countries plus Kosovo, each alpha-2 once", () => {
    const codes = alpha2Codes();
    expect(codes).toHaveLength(250);
    expect(new Set(codes).size).toBe(250);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{2}$/);
  });

  it("maps the provider's alpha-3 codes and passes alpha-2 through; unknown or blank → null", () => {
    expect(toAlpha2("BLR")).toBe("BY");
    expect(toAlpha2("blr")).toBe("BY");
    expect(toAlpha2(" BY ")).toBe("BY");
    expect(toAlpha2("RUS")).toBe("RU");
    expect(toAlpha2("UKR")).toBe("UA");
    expect(toAlpha2("POL")).toBe("PL");
    expect(toAlpha2("LTU")).toBe("LT");
    expect(toAlpha2("DEU")).toBe("DE");
    expect(toAlpha2("GBR")).toBe("GB");
    expect(toAlpha2("XKX")).toBe("XK");
    expect(toAlpha2("XXX")).toBeNull();
    expect(toAlpha2("ZZ")).toBeNull();
    expect(toAlpha2("")).toBeNull();
    expect(toAlpha2(null)).toBeNull();
    expect(toAlpha2("BELARUS")).toBeNull();
    expect(isAlpha2("BY")).toBe(true);
    expect(isAlpha2("by")).toBe(false);
  });
});
