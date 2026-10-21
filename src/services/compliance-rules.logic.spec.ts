import { bvOn, getConfiguration, parseBvTable } from "../config";
import { BusinessCalendar } from "../util/by-calendar";
import { parseAmount } from "../util/money";
import {
  ageBand,
  ageOn,
  alertDueAt,
  bvAmount,
  cash,
  dueKind,
  effectiveDueAt,
  eligibilityReasons,
  ineligibleSeverity,
  type EligibilityFacts,
  inAgeBand,
  manyCards,
  netOut,
  payerMatchesIdentity,
  roundTrip,
  ruleDefinition,
  structuring,
  thirdParty,
  unverifiedPayer,
} from "./compliance-rules.logic";
import type { VerifiedIdentity, VerifiedName } from "./kyc-identity.port";
import { userComplianceReason } from "./ramp-policy.service";

const cfg = getConfiguration({
  DATABASE_URL: "postgresql://localhost:5432/x",
  REDIS_URL: "redis://localhost:6379",
  NATS_URL: "nats://localhost:4222",
  SESSION_SECRET: "s".repeat(32),
  KYC_FINGERPRINT_PEPPER: "p".repeat(32),
}).compliance;
const tm = cfg.tm;
const BV = parseAmount("45");
const byn = (v: string): bigint => parseAmount(v);

/** Іваноў Сяргей Мікалаевіч (be), Иванов Сергей Николаевич (ru), IVANOU SIARHEI (passport Latin). */
const IVANOU: VerifiedName[] = [
  { script: "be", last: "Іваноў", first: "Сяргей", middle: "Мікалаевіч" },
  { script: "ru", last: "Иванов", first: "Сергей", middle: "Николаевич" },
  { script: "lat", last: "IVANOU", first: "SIARHEI", middle: null },
];

describe("compliance rules: due dates in Belarusian business days (SPEC §11.6, ПВК pp.73–75)", () => {
  // 2026-11-07 (Saturday) is October Revolution Day; 2026-11-09 a Monday.
  const cal = new BusinessCalendar(["2026-11-07", "2026-12-25", "2027-01-01", "2027-01-07"]);

  it("a refusal or freeze is due at the end of the same business day (Minsk 23:59:59 = 20:59:59 UTC)", () => {
    expect(alertDueAt("same_day", new Date("2026-11-04T09:00:00Z"), cal)?.toISOString()).toBe(
      "2026-11-04T20:59:59.000Z",
    );
    // Raised on a Saturday: the first business day after.
    expect(alertDueAt("same_day", new Date("2026-11-07T09:00:00Z"), cal)?.toISOString()).toBe(
      "2026-11-09T20:59:59.000Z",
    );
    // 22:30 UTC on a Friday is already Saturday in Minsk.
    expect(alertDueAt("same_day", new Date("2026-11-06T22:30:00Z"), cal)?.toISOString()).toBe(
      "2026-11-09T20:59:59.000Z",
    );
  });

  it("a suspicious operation is due the next business day; a series 9 business days after the analysis month", () => {
    expect(alertDueAt("next_day", new Date("2026-11-06T10:00:00Z"), cal)?.toISOString()).toBe(
      "2026-11-09T20:59:59.000Z",
    );
    // December 2026: month end 31st (Thu); 9 business days after skip 1 and 7 Jan (holidays) and weekends → 15 Jan.
    expect(alertDueAt("series", new Date("2026-12-10T10:00:00Z"), cal)?.toISOString()).toBe(
      "2027-01-15T20:59:59.000Z",
    );
    expect(alertDueAt("none", new Date(), cal)).toBeNull();
  });

  it("severity decides the due kind: info none, block same day, review the rule's", () => {
    expect(dueKind("TM-THIRDPARTY", "info")).toBe("none");
    expect(dueKind("TM-CASH", "block")).toBe("same_day");
    expect(dueKind("TM-ROUNDTRIP", "review")).toBe("series");
    expect(dueKind("TM-CASH", "review")).toBe("next_day");
    expect(ruleDefinition("TM-SOMETHING-NEW")).toEqual({ severity: "review", due: "next_day" });
    expect(ruleDefinition("TM-PEP")).toMatchObject({ severity: "block", point: "consent" });
  });

  it("a caller's dueAt hint may tighten the legal deadline, never extend it; info alerts stay without one", () => {
    const legal = new Date("2026-11-04T20:59:59.000Z");
    expect(effectiveDueAt(legal, undefined)).toBe(legal);
    expect(effectiveDueAt(legal, null)).toBe(legal);
    expect(effectiveDueAt(legal, "2026-11-04T12:00:00.000Z")?.toISOString()).toBe(
      "2026-11-04T12:00:00.000Z",
    );
    expect(effectiveDueAt(legal, new Date("2026-11-05T20:59:59Z"))).toBe(legal);
    expect(effectiveDueAt(legal, "not a date")).toBe(legal);
    expect(effectiveDueAt(null, "2026-11-04T12:00:00.000Z")).toBeNull();
  });
});

describe("compliance rules: people", () => {
  it("full years on a Minsk day; birthdays and 29 February", () => {
    expect(ageOn("2008-10-19", "2026-10-19")).toBe(18);
    expect(ageOn("2008-10-20", "2026-10-19")).toBe(17);
    expect(ageOn("2008-02-29", "2026-02-28")).toBe(17);
    expect(ageOn("2008-02-29", "2026-03-01")).toBe(18);
    expect(ageOn(null, "2026-10-19")).toBeNull();
    expect(ageOn("19.05.1990", "2026-10-19")).toBeNull();
    expect([20, 21, 59, 60].map(inAgeBand)).toEqual([true, false, false, true]);
  });

  it("a payer matches when ANY verified form shares a surname key: be / ru / Latin, either order, patronymic or not", () => {
    for (const payer of [
      "Иванов Сергей Николаевич",
      "Іваноў Сяргей",
      "IVANOU SIARHEI",
      "SERGEI IVANOV",
      "ivanov s.",
      "Ivanou-Petrova Anna",
    ])
      expect([payer, payerMatchesIdentity(payer, IVANOU)]).toEqual([payer, true]);
    for (const payer of ["Петров Сергей", "SIARHEI", "Ivanova Olga", "", "  "])
      expect([payer, payerMatchesIdentity(payer, IVANOU)]).toEqual([payer, false]);
    // Belarusian -оў and Russian -ов fold apart: without the ru form on file a Russian-written payer
    // is a hit (the ID card carries both; the provider must hand both over, M2).
    expect(payerMatchesIdentity("Иванов Сергей", [IVANOU[0], IVANOU[2]])).toBe(false);
    expect(payerMatchesIdentity("Ivanou Siarhei", [IVANOU[0]])).toBe(true);
    // A double-barrelled verified surname matches either part.
    const double: VerifiedName[] = [{ script: "lat", last: "PETROVA-VODKINA", first: "ANNA" }];
    expect(payerMatchesIdentity("Водкина Анна", double)).toBe(true);
    expect(payerMatchesIdentity("PETROVAVODKINA ANNA", double)).toBe(true);
  });
});

describe("compliance rules: thresholds in base values (SPEC §11.4)", () => {
  it("BV math is exact and dated: 20 BV is 900 BYN at 45 and 950 at 47.50", () => {
    const table = parseBvTable("2026-01-01:45,2027-01-01:47.50").entries;
    expect(bvAmount(20, bvOn(table, "2026-12-31") as bigint)).toBe(byn("900"));
    expect(bvAmount(20, bvOn(table, "2027-01-01") as bigint)).toBe(byn("950"));
  });

  it("TM-STRUCT: 3 on-ramps in 24 h reaching 90 % of the daily max", () => {
    const dailyMax = byn("3000");
    expect(structuring(tm, { count: 3, sum: byn("2700"), dailyMax })).toMatchObject({
      rule: "TM-STRUCT",
      severity: "review",
      figures: { count: 3, sum: "2700.0000000000", pct: 90 },
    });
    expect(structuring(tm, { count: 3, sum: byn("2699.99"), dailyMax })).toBeNull();
    expect(structuring(tm, { count: 2, sum: byn("3000"), dailyMax })).toBeNull();
  });

  it("TM-AGE: under 21 or 60+ with 100 BV (4 500 BYN) of on + off in 30 days", () => {
    expect(ageBand(tm, BV, { age: 20, volume30d: byn("4500") })?.figures).toMatchObject({
      age: 20,
      threshold: "4500.0000000000",
    });
    expect(ageBand(tm, BV, { age: 61, volume30d: byn("4500") })).not.toBeNull();
    expect(ageBand(tm, BV, { age: 20, volume30d: byn("4499.99") })).toBeNull();
    expect(ageBand(tm, BV, { age: 35, volume30d: byn("100000") })).toBeNull();
    expect(ageBand(tm, BV, { age: null, volume30d: byn("100000") })).toBeNull();
  });

  it("TM-THIRDPARTY: only a BANK-supplied name counts; review from 20 BV (900 BYN), info below; a match is no hit", () => {
    const base = { names: IVANOU, payerName: "PETROV PAVEL", nameSource: "bank" };
    expect(thirdParty(tm, BV, { ...base, amount: byn("900") })?.severity).toBe("review");
    expect(thirdParty(tm, BV, { ...base, amount: byn("899.99") })?.severity).toBe("info");
    expect(thirdParty(tm, BV, { ...base, nameSource: "checkout", amount: byn("5000") })).toBeNull();
    expect(
      thirdParty(tm, BV, { ...base, payerName: "Иванов С.Н.", amount: byn("5000") }),
    ).toBeNull();
    expect(thirdParty(tm, BV, { ...base, payerName: null, amount: byn("5000") })).toBeNull();
  });

  it("payer_unverified: ERIP without a bank payer name; info below 100 BV per 30 days, review from it", () => {
    const base = { method: "erip", payerName: null, nameSource: null };
    expect(unverifiedPayer(tm, BV, { ...base, unverified30d: byn("4499") })?.severity).toBe("info");
    expect(unverifiedPayer(tm, BV, { ...base, unverified30d: byn("4500") })?.severity).toBe(
      "review",
    );
    // A checkout name is no bank name.
    expect(
      unverifiedPayer(tm, BV, {
        ...base,
        payerName: "X",
        nameSource: "checkout",
        unverified30d: 0n,
      }),
    ).not.toBeNull();
    expect(
      unverifiedPayer(tm, BV, { ...base, payerName: "X Y", nameSource: "bank", unverified30d: 0n }),
    ).toBeNull();
    expect(
      unverifiedPayer(tm, BV, { ...base, method: "card", unverified30d: byn("9999") }),
    ).toBeNull();
  });

  it("TM-CASH: ERIP cash or unknown (or no channel at all) is a review; RAMP_ERIP_ALLOW_CASH=false makes it a block", () => {
    for (const channel of ["cash", "unknown", null])
      expect(cash(cfg, { method: "erip", channel })?.severity).toBe("review");
    expect(cash(cfg, { method: "erip", channel: "online" })).toBeNull();
    expect(cash(cfg, { method: "card", channel: "cash" })).toBeNull();
    expect(cash({ eripAllowCash: false }, { method: "erip", channel: "cash" })?.severity).toBe(
      "block",
    );
  });

  it("TM-ROUNDTRIP: ≥ 50 BV (2 250 BYN) of on-ramps with trading ≤ 10 % of them", () => {
    expect(roundTrip(tm, BV, { onramps: byn("2250"), trading: byn("225") })).toMatchObject({
      rule: "TM-ROUNDTRIP",
      figures: { onramps: "2250.0000000000", trading: "225.0000000000", tradePct: 10 },
    });
    expect(roundTrip(tm, BV, { onramps: byn("2250"), trading: byn("225.01") })).toBeNull();
    expect(roundTrip(tm, BV, { onramps: byn("2249.99"), trading: 0n })).toBeNull();
  });

  it("TM-NETOUT: 30-day cash-outs − on-ramps − deposits above 200 BV (9 000 BYN)", () => {
    expect(
      netOut(tm, BV, { offramps: byn("12000"), onramps: byn("2000"), deposits: byn("999.99") })
        ?.figures,
    ).toMatchObject({ net: "9000.0100000000", threshold: "9000.0000000000" });
    expect(
      netOut(tm, BV, { offramps: byn("12000"), onramps: byn("2000"), deposits: byn("1000") }),
    ).toBeNull();
  });

  it("TM-CARDS: more than 3 distinct cards in 30 days", () => {
    expect(manyCards(tm, { cards: 4 })).toMatchObject({ rule: "TM-CARDS", severity: "review" });
    expect(manyCards(tm, { cards: 3 })).toBeNull();
  });
});

describe("compliance rules: eligibility (SPEC §11.3) and the user's reasons", () => {
  const today = "2026-10-19";
  const now = new Date("2026-10-19T10:00:00Z");
  const identity: VerifiedIdentity = {
    userId: "u",
    names: IVANOU,
    birthDate: "1990-05-17",
    citizenship: "BY",
    residenceCountry: "BY",
    level: "basic",
    verifiedAt: new Date("2026-01-10T00:00:00Z"),
    vendorPep: null,
    vendorSanctions: null,
    vendorAdverseMedia: null,
    doc: {
      type: "ID_CARD",
      country: "BY",
      number: "1",
      personalNumber: null,
      issuedAt: null,
      expiresAt: "2030-01-01",
    },
    refreshDueAt: new Date("2029-01-10T00:00:00Z"),
  };
  const facts = (
    over: Partial<EligibilityFacts> = {},
    id: Partial<VerifiedIdentity> = {},
  ): EligibilityFacts => ({
    identity: { ...identity, ...id },
    unavailable: false,
    today,
    now,
    frozen: false,
    consent: { actsForSelf: true, pepDeclared: false, principalCleared: true, pepCleared: true },
    openBlocks: [],
    ...over,
  });
  const reasons = (f: EligibilityFacts): string[] => eligibilityReasons(cfg, f);

  it("an adult BY resident with a clean, current identity and consent is eligible", () => {
    expect(reasons(facts())).toEqual([]);
  });

  it("names every failing condition", () => {
    expect(reasons(facts({ identity: null }))).toEqual(["kyc_required"]);
    expect(reasons(facts({ unavailable: true }))).toEqual(["kyc_identity_unavailable"]);
    expect(reasons(facts({}, { birthDate: "2008-10-20" }))).toEqual(["age_below_minimum"]);
    expect(reasons(facts({}, { birthDate: "2008-10-19" }))).toEqual([]);
    expect(reasons(facts({}, { birthDate: null }))).toEqual(["identity_incomplete"]);
    expect(reasons(facts({}, { residenceCountry: "LT" }))).toEqual(["residence_not_allowed"]);
    expect(reasons(facts({}, { residenceCountry: null }))).toEqual(["residence_not_allowed"]);
    expect(reasons(facts({}, { vendorPep: true }))).toEqual(["vendor_pep"]);
    expect(reasons(facts({}, { vendorSanctions: true }))).toEqual(["vendor_sanctions"]);
    expect(reasons(facts({}, { doc: { ...identity.doc!, expiresAt: "2026-10-18" } }))).toEqual([
      "kyc_refresh_required",
    ]);
    expect(reasons(facts({}, { refreshDueAt: new Date("2026-10-19T09:00:00Z") }))).toEqual([
      "kyc_refresh_required",
    ]);
    expect(
      reasons(
        facts({
          consent: {
            actsForSelf: false,
            pepDeclared: true,
            principalCleared: false,
            pepCleared: false,
          },
        }),
      ),
    ).toEqual(["principal_declared", "pep_declared"]);
    // Cleared by AML: eligible again.
    expect(
      reasons(
        facts({
          consent: {
            actsForSelf: false,
            pepDeclared: true,
            principalCleared: true,
            pepCleared: true,
          },
        }),
      ),
    ).toEqual([]);
    expect(reasons(facts({ openBlocks: ["TM-SANCTIONS"] }))).toEqual(["compliance_alert_open"]);
    expect(reasons(facts({ frozen: true }))).toEqual(["frozen"]);
  });

  it("blocked citizenships are refused even for residents", () => {
    const c = { ...cfg, blockedCitizenships: ["RU"] };
    expect(eligibilityReasons(c, facts({}, { citizenship: "RU" }))).toEqual([
      "citizenship_blocked",
    ]);
  });

  it("the user sees kyc_required, additional_info_required (identity refresh) or the neutral compliance only", () => {
    expect(userComplianceReason("kyc_required")).toBe("kyc_required");
    expect(userComplianceReason("kyc_refresh_required")).toBe("additional_info_required");
    for (const code of [
      "kyc_identity_unavailable",
      "identity_incomplete",
      "age_below_minimum",
      "residence_not_allowed",
      "citizenship_blocked",
      "vendor_pep",
      "vendor_sanctions",
      "principal_declared",
      "pep_declared",
      "compliance_alert_open",
      "frozen",
    ])
      expect([code, userComplianceReason(code)]).toEqual([code, "compliance"]);
  });
});

describe("C26: a value point's TM-INELIGIBLE severity", () => {
  it("is block (four-eyes) when a reason needs a senior decision (PEP, principal, an open block alert), else review", () => {
    for (const reasons of [
      ["pep_declared"],
      ["vendor_pep"],
      ["principal_declared"],
      ["compliance_alert_open"],
      ["kyc_refresh_required", "pep_declared"],
    ])
      expect([reasons, ineligibleSeverity(reasons)]).toEqual([reasons, "block"]);
    for (const reasons of [["kyc_refresh_required"], ["age_below_minimum"], []])
      expect([reasons, ineligibleSeverity(reasons)]).toEqual([reasons, "review"]);
    expect(ruleDefinition("TM-INELIGIBLE").severity).toBe("review");
  });
});
