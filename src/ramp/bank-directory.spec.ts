import {
  BANK_DIRECTORY,
  BANK_DIRECTORY_SOURCE,
  bankByBic,
  bankByCode,
  directoryEntry,
  isSanctioned,
} from "./bank-directory";

describe("bank directory (SPEC §10.1, m2)", () => {
  it("is a dated snapshot of the NBRB directory with every Belarusian bank", () => {
    expect(BANK_DIRECTORY_SOURCE.fetchedAt).toBe("2026-10-19");
    const banks = BANK_DIRECTORY.filter((e) => e.kind === "bank");
    expect(banks).toHaveLength(22);
    // the banks the hand-picked v1 list missed (m2) are there too
    for (const code of ["BLNB", "TECN", "REDJ", "RSHN", "ZEPT", "BBTK", "IRJS", "AEBK"])
      expect(bankByCode(code)?.kind).toBe("bank");
    // one entry per code, and every bank's BIC starts with its code and is Belarusian
    expect(new Set(BANK_DIRECTORY.map((e) => e.code)).size).toBe(BANK_DIRECTORY.length);
    for (const b of banks) {
      expect(b.bic.slice(0, 4)).toBe(b.code);
      expect(b.bic.slice(4, 6)).toBe("BY");
    }
  });

  it("looks banks up by IBAN bank code and by BIC (branch BICs too)", () => {
    expect(bankByCode("akbb")?.nameEn).toBe("Belarusbank");
    expect(bankByBic("PJCBBY2X")?.nameEn).toBe("Priorbank");
    expect(bankByBic("PJCBBY2XXXX")?.code).toBe("PJCB");
    expect(bankByCode("ZZZZ")).toBeNull();
  });

  it("refuses participants that hold no individual accounts", () => {
    for (const code of ["NBRB", "BISC", "SSIS", "ABIG", "BCSX", "INEA", "EABR"]) {
      expect(directoryEntry(code)).not.toBeNull();
      expect(bankByCode(code)).toBeNull();
    }
  });

  it("carries the sanctions flags of belarus-legal.md §4 (+ the OFAC scan)", () => {
    expect(bankByCode("MMBN")?.sanctions).toEqual({
      eu: ["EU Reg 765/2006 Annex IX", "EU Reg 765/2006 Annex XV (transaction ban)"],
      us: ["OFAC SDN BELARUS-EO14038"],
      uk: ["UK asset freeze BEL0120"],
    });
    expect(bankByCode("ALFA")?.sanctions.uk).toEqual(["UK asset freeze BEL0166"]);
    expect(bankByCode("BBTK")?.sanctions.us).toEqual(["OFAC SDN IRAN / SDGT / NPWMD"]);
    const clean = ["PJCB", "MTBK", "POIS", "BLNB"].map((c) => bankByCode(c));
    expect(clean.every((b) => b && !isSanctioned(b))).toBe(true);
    expect(isSanctioned(bankByCode("AKBB")!)).toBe(true);
  });
});
