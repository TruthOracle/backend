import type { ApplicantSummary } from "../types";
import { decideParams, validateDecision } from "./compliance-alerts.service";
import { identityFromApplicant } from "./kyc-identity.port";
import { mergeAml, refreshDueAt, riskLevelOf, sealedIdentityFrom } from "./kyc-identity.service";

const SUMMARY: ApplicantSummary = {
  answer: "GREEN",
  rejectType: null,
  labels: [],
  levelName: "basic-kyc-level",
  sandbox: false,
  documents: [{ docType: "ID_CARD", country: "BLR", number: "KH1" }],
  person: { firstName: "SIARHEI", lastName: "IVANOU", dob: "1990-05-17", country: "BLR" },
  identity: {
    names: [
      { firstName: "Сяргей", lastName: "Іваноў", middleName: "Мікалаевіч" },
      { firstName: "Сергей", lastName: "Иванов", middleName: "Николаевич" },
      { firstName: "SIARHEI", lastName: "IVANOU", middleName: null },
    ],
    birthPlace: "Minsk",
    birthCountry: "BLR",
    nationality: "BLR",
    residenceCountry: "BLR",
    address: { country: "BLR", region: "Minsk", city: "Minsk", line: "Nezavisimosti 4-12" },
    document: {
      type: "ID_CARD",
      country: "BLR",
      number: "KH1",
      personalNumber: "3170590A001PB1",
      issuedAt: "2021-03-01",
      expiresAt: "2031-03-01",
    },
    aml: null,
  },
};

describe("KYC identity (SPEC §11.1, M2, M11)", () => {
  it("keeps every name form with its script, the art.8 data and alpha-2 countries", () => {
    expect(sealedIdentityFrom(SUMMARY)).toEqual({
      names: [
        { script: "be", last: "Іваноў", first: "Сяргей", middle: "Мікалаевіч" },
        { script: "ru", last: "Иванов", first: "Сергей", middle: "Николаевич" },
        { script: "lat", last: "IVANOU", first: "SIARHEI", middle: null },
      ],
      birthDate: "1990-05-17",
      birthPlace: "Minsk",
      birthCountry: "BY",
      citizenship: "BY",
      residenceCountry: "BY",
      address: { country: "BY", region: "Minsk", city: "Minsk", line: "Nezavisimosti 4-12" },
      doc: {
        type: "ID_CARD",
        country: "BY",
        number: "KH1",
        personalNumber: "3170590A001PB1",
        issuedAt: "2021-03-01",
        expiresAt: "2031-03-01",
      },
    });
    // A summary without the identity block (older in-memory summaries): the person, country as both.
    const { identity: _identity, ...bare } = SUMMARY;
    expect(sealedIdentityFrom(bare)).toMatchObject({
      names: [{ script: "lat", last: "IVANOU", first: "SIARHEI" }],
      citizenship: "BY",
      residenceCountry: "BY",
      doc: null,
    });
    // The live default maps the same way (vendor flags unknown).
    expect(identityFromApplicant("u", SUMMARY, null)).toMatchObject({
      citizenship: "BY",
      residenceCountry: "BY",
      vendorPep: null,
      vendorSanctions: null,
      names: [{ script: "be" }, { script: "ru" }, { script: "lat" }],
    });
  });

  it("merges AML evidence: any true wins, a screen turns unknown into false, nothing screened stays null", () => {
    expect(mergeAml(null, undefined)).toBeNull();
    expect(
      mergeAml(
        { pep: null, sanctions: true, adverseMedia: null, labels: ["sanctions"] },
        { pep: false, sanctions: false, adverseMedia: false, labels: [] },
      ),
    ).toEqual({ pep: false, sanctions: true, adverseMedia: false, labels: ["sanctions"] });
    expect(mergeAml({ pep: null, sanctions: null, adverseMedia: null, labels: [] })).toEqual({
      pep: null,
      sanctions: null,
      adverseMedia: null,
      labels: [],
    });
  });

  it("risk by vendor flags; re-verification due 3 / 2 / 1 years after the verification (ПВК pp.45–49)", () => {
    const flags = (o: Partial<{ pep: boolean; sanctions: boolean; adverseMedia: boolean }>) => ({
      pep: o.pep ?? false,
      sanctions: o.sanctions ?? false,
      adverseMedia: o.adverseMedia ?? false,
      labels: [],
    });
    expect(riskLevelOf(null)).toBe("low");
    expect(riskLevelOf(flags({}))).toBe("low");
    expect(riskLevelOf(flags({ adverseMedia: true }))).toBe("medium");
    expect(riskLevelOf(flags({ pep: true }))).toBe("high");
    expect(riskLevelOf(flags({ sanctions: true }))).toBe("high");
    const at = new Date("2026-02-28T10:00:00Z");
    expect(refreshDueAt(at, "low")?.toISOString()).toBe("2029-02-28T10:00:00.000Z");
    expect(refreshDueAt(at, "medium")?.toISOString()).toBe("2028-02-28T10:00:00.000Z");
    expect(refreshDueAt(at, "high")?.toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(refreshDueAt(null, "high")).toBeNull();
  });
});

describe("compliance alert decisions (SPEC §11.5, §6.5)", () => {
  it("decide params: clear | escalate | report | return; report needs the special-form number", () => {
    expect(decideParams({ decision: "clear" })).toEqual({ decision: "clear", reportRef: null });
    expect(decideParams({ decision: "return" })).toEqual({ decision: "return", reportRef: null });
    expect(decideParams({ decision: "report", reportRef: " SF-2026/0042 " })).toEqual({
      decision: "report",
      reportRef: "SF-2026/0042",
    });
    expect(() => decideParams({ decision: "report" })).toThrow(/reportRef/);
    expect(() => decideParams({ decision: "approve" })).toThrow(
      /clear, escalate, report or return/,
    );
    // A reportRef on another decision is dropped.
    expect(decideParams({ decision: "escalate", reportRef: "X" })).toEqual({
      decision: "escalate",
      reportRef: null,
    });
  });

  it("open → clear | escalate | report | return; escalated → clear | report | return; reported → clear | return; cleared and returned are final", () => {
    const s = (
      status: "open" | "escalated" | "reported" | "cleared" | "returned",
      orderId: string | null = "order-1",
      severity: "info" | "review" | "block" = "review",
    ) => ({ status, severity, decidedAt: null, orderId });
    const ok = (
      status: Parameters<typeof s>[0],
      decision: "clear" | "escalate" | "report" | "return",
      snapshot = s(status),
    ) => {
      try {
        validateDecision({ decision, reportRef: decision === "report" ? "R1" : null }, snapshot);
        return true;
      } catch {
        return false;
      }
    };
    // C25: `return` ends a hold of an order's payment (review / block), never an account-level one.
    expect([ok("open", "return"), ok("escalated", "return"), ok("reported", "return")]).toEqual([
      true,
      true,
      true,
    ]);
    expect([
      ok("returned", "clear"),
      ok("returned", "return"),
      ok("cleared", "return"),
      ok("open", "return", s("open", null)),
      ok("open", "return", s("open", "order-1", "info")),
    ]).toEqual([false, false, false, false, false]);
    expect([ok("open", "clear"), ok("open", "escalate"), ok("open", "report")]).toEqual([
      true,
      true,
      true,
    ]);
    expect([
      ok("escalated", "clear"),
      ok("escalated", "escalate"),
      ok("escalated", "report"),
    ]).toEqual([true, false, true]);
    expect([ok("reported", "clear"), ok("reported", "report")]).toEqual([true, false]);
    expect([ok("cleared", "clear"), ok("cleared", "report")]).toEqual([false, false]);
  });
});
