import { bvOn, getConfiguration, parseBvTable, unreachableRules } from "./config";
import { parseAmount } from "./util/money";

/** The S7a block of config.ts (SPEC §11, §13 S7a); kept apart from config.spec.ts (parallel stages). */
const BASE: Record<string, string> = {
  APP_ENV: "dev",
  APP_NETWORK: "devnet",
  DATABASE_URL: "postgresql://localhost:5432/x",
  REDIS_URL: "redis://localhost:6379",
  NATS_URL: "nats://localhost:4222",
  SESSION_SECRET: "s".repeat(32),
  KYC_FINGERPRINT_PEPPER: "p".repeat(32),
  DATA_KEYS: `k1:${Buffer.alloc(32, 0x11).toString("base64")}`,
  DATA_KEY_ID: "k1",
  DATA_INDEX_KEYS: `i1:${Buffer.alloc(32, 0x22).toString("base64")}`,
  DATA_INDEX_KEY_ID: "i1",
};

function cfg(extra: Record<string, string> = {}): ReturnType<typeof getConfiguration> {
  return getConfiguration({ ...BASE, ...extra });
}

/** The boot refusal's message (empty when it boots). */
function issues(extra: Record<string, string>): string {
  try {
    cfg(extra);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

const PROD_RAMP = {
  APP_ENV: "prod",
  KYC_PROVIDER: "sumsub",
  RAMP_ENABLED: "true",
  RAMP_PUBLIC_APP_URL: "https://app.test",
};

describe("config: compliance (SPEC §11, §13 S7a)", () => {
  it("defaults: on, BV 45 from 2026, age 18, BY residents, 30-day identity refresh, cash ERIP = review, §11.4 thresholds", () => {
    const c = cfg().compliance;
    expect(c).toMatchObject({
      enabled: true,
      bvTable: [{ from: "2026-01-01", byn: parseAmount("45") }],
      minAge: 18,
      allowedResidence: ["BY"],
      blockedCitizenships: [],
      kycRefreshDays: 30,
      eripAllowCash: true,
      rulesVersion: "",
      allowUnreachable: false,
      tm: {
        structCount: 3,
        structPct: 90,
        ageBv: 100,
        thirdPartyBv: 20,
        unverifiedPayerBv: 100,
        roundtripDays: 30,
        roundtripBv: 50,
        roundtripTradePct: 10,
        netoutBv: 200,
        maxCards30d: 3,
      },
    });
    expect(cfg({ RAMP_COMPLIANCE: "off" }).compliance.enabled).toBe(false);
  });

  it("reads a dated BV table and answers the value in force on a Minsk day", () => {
    const { entries, issues: problems } = parseBvTable("2026-01-01:45, 2027-01-01:47.50");
    expect(problems).toEqual([]);
    expect(bvOn(entries, "2025-12-31")).toBeNull();
    expect(bvOn(entries, "2026-01-01")).toBe(parseAmount("45"));
    expect(bvOn(entries, "2026-12-31")).toBe(parseAmount("45"));
    expect(bvOn(entries, "2027-01-01")).toBe(parseAmount("47.5"));
    expect(parseBvTable("2027-01-01:47,2026-01-01:45").issues[0]).toMatch(/must ascend/);
    expect(parseBvTable("2026-01-01:0").issues[0]).toMatch(/BYN above 0/);
    expect(parseBvTable("2026-13-01:45").issues[0]).toMatch(/not <YYYY-MM-DD>/);
    expect(parseBvTable("").entries).toEqual([{ from: "2026-01-01", byn: parseAmount("45") }]);
  });

  it.each([
    ["an unknown mode", { RAMP_COMPLIANCE: "maybe" }, /RAMP_COMPLIANCE must be on or off/],
    ["a malformed BV entry", { RAMP_BV_TABLE: "2026:45" }, /RAMP_BV_TABLE entry/],
    ["a non-ISO residence", { RAMP_ALLOWED_RESIDENCE: "BLR" }, /RAMP_ALLOWED_RESIDENCE entry/],
    ["a non-ISO citizenship", { RAMP_BLOCKED_CITIZENSHIPS: "XX" }, /RAMP_BLOCKED_CITIZENSHIPS/],
    ["a percentage above 100", { RAMP_TM_STRUCT_PCT: "101" }, /RAMP_TM_STRUCT_PCT/],
    ["a non-integer threshold", { RAMP_TM_AGE_BV: "abc" }, /RAMP_TM_AGE_BV/],
    ["a refresh of 0 days", { RAMP_KYC_REFRESH_DAYS: "0" }, /RAMP_KYC_REFRESH_DAYS/],
    ["a malformed rules version", { RAMP_TM_RULES_VERSION: "v 1" }, /RAMP_TM_RULES_VERSION/],
  ])("refuses %s in any environment", (_name, extra, pattern) => {
    expect(() => cfg(extra)).toThrow(pattern);
  });

  it("prod-like with the ramp on: compliance on, a rules version and an adult minimum age", () => {
    const blank = issues({ ...PROD_RAMP, RAMP_COMPLIANCE: "off", RAMP_MIN_AGE: "16" });
    expect(blank).toMatch(/RAMP_COMPLIANCE=off is refused/);
    expect(blank).toMatch(/RAMP_TM_RULES_VERSION is required/);
    expect(blank).toMatch(/RAMP_MIN_AGE below 18 is refused/);
    const set = issues({ ...PROD_RAMP, RAMP_TM_RULES_VERSION: "pvk-2025.1" });
    expect(set).not.toMatch(/RAMP_COMPLIANCE|RAMP_TM_RULES_VERSION|RAMP_MIN_AGE|BV|unreachable/);
    // Off-prod the compliance block refuses none of these; prod-like with the ramp off only
    // RAMP_COMPLIANCE=off (R2b-4: the order scan still resumes held orders).
    expect(issues({ RAMP_COMPLIANCE: "off", RAMP_MIN_AGE: "16" })).toBe("");
    const rampOff = issues({ APP_ENV: "prod", KYC_PROVIDER: "sumsub", RAMP_COMPLIANCE: "off" });
    expect(rampOff).toMatch(
      /RAMP_COMPLIANCE=off is refused when prod-like .*RAMP_ENABLED=false too/,
    );
    expect(rampOff).not.toMatch(/RAMP_TM_RULES_VERSION|RAMP_MIN_AGE/);
    expect(issues({ APP_ENV: "prod", KYC_PROVIDER: "sumsub", RAMP_MIN_AGE: "16" })).toBe("");
  });

  it("prod-like with the ramp on: no per-order limit ≥ 1 000 BV nor a monthly one ≥ 2 000 BV (BV 45 → 45 000 / 90 000)", () => {
    const base = { ...PROD_RAMP, RAMP_TM_RULES_VERSION: "pvk-2025.1" };
    expect(issues({ ...base, RAMP_ONRAMP_MAX: "45000", RAMP_ONRAMP_DAILY_MAX: "50000" })).toMatch(
      /RAMP_ONRAMP_MAX at or above 1 000 BV/,
    );
    expect(issues({ ...base, RAMP_OFFRAMP_MONTHLY_MAX: "90000" })).toMatch(
      /RAMP_OFFRAMP_MONTHLY_MAX at or above 2 000 BV/,
    );
    // Just below the lines boots (the BV in force today decides where they are).
    expect(issues({ ...base, RAMP_ONRAMP_MAX: "44999.99" })).not.toMatch(/1 000 BV/);
    expect(issues({ ...base, RAMP_OFFRAMP_MONTHLY_MAX: "89999" })).not.toMatch(/2 000 BV/);
  });

  it("names every review threshold the limits can never reach; RAMP_TM_ALLOW_UNREACHABLE accepts them", () => {
    const bv = parseAmount("45");
    const ramp = {
      methods: ["card", "erip"] as ("card" | "erip")[],
      onramp: {
        min: parseAmount("10"),
        max: parseAmount("500"),
        dailyMax: parseAmount("600"),
        monthlyMax: parseAmount("2000"),
      },
      offramp: {
        min: parseAmount("10"),
        max: parseAmount("500"),
        dailyMax: parseAmount("600"),
        monthlyMax: parseAmount("2000"),
      },
    };
    const tm = cfg().compliance.tm;
    // STRUCT: 3 × 500 = 1 500 ≥ 90 % of 600 → reachable. AGE: 4 000 < 4 500. THIRDPARTY: 500 < 900.
    // payer_unverified: 2 000 < 4 500. ROUNDTRIP: 2 000 < 2 250. NETOUT: 2 000 ≤ 9 000.
    expect(unreachableRules(tm, bv, ramp).map((r) => r.split(" ")[0])).toEqual([
      "TM-AGE",
      "TM-THIRDPARTY",
      "payer_unverified",
      "TM-ROUNDTRIP",
      "TM-NETOUT",
    ]);
    // Too few orders fit in a day for TM-STRUCT: 3 × 250 = 750 > a 700 daily max … and 3 × 100 < 630.
    expect(
      unreachableRules({ ...tm, structCount: 3 }, bv, {
        ...ramp,
        onramp: { ...ramp.onramp, min: parseAmount("250"), dailyMax: parseAmount("700") },
      })[0],
    ).toMatch(/^TM-STRUCT/);
    expect(
      unreachableRules(tm, bv, {
        ...ramp,
        onramp: { ...ramp.onramp, max: parseAmount("100"), dailyMax: parseAmount("700") },
      })[0],
    ).toMatch(/^TM-STRUCT/);
    // The defaults (2 000 per order, 3 000 a day, 20 000 in 30 days) reach every rule.
    expect(unreachableRules(tm, bv, cfg({ RAMP_METHODS: "card,erip" }).ramp)).toEqual([]);

    const prod = {
      ...PROD_RAMP,
      RAMP_TM_RULES_VERSION: "pvk-2025.1",
      RAMP_ONRAMP_MONTHLY_MAX: "2000",
      RAMP_OFFRAMP_MONTHLY_MAX: "2000",
    };
    expect(issues(prod)).toMatch(/TM-AGE .* can never fire/);
    expect(issues(prod)).toMatch(/TM-NETOUT .* can never fire/);
    expect(issues({ ...prod, RAMP_TM_ALLOW_UNREACHABLE: "true" })).not.toMatch(/can never fire/);
  });
});
