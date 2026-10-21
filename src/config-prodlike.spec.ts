import { getConfiguration } from "./config";

/**
 * Prod-like refusals outside S3's block (SPEC §8: every "prod" refusal means prod-like, i.e.
 * APP_ENV=prod OR APP_NETWORK=mainnet OR RAMP_PROVIDER_MODE=live): S1's token-app caps and sync
 * switch, the KYC mock, unverified Postgres TLS (C32), and RAMP_SCAN_MS=0 (C33).
 */
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

/** Every refusal line (empty when it boots). */
function refusals(extra: Record<string, string>): string[] {
  try {
    getConfiguration({ ...BASE, ...extra });
    return [];
  } catch (err) {
    return (err as Error).message
      .split("\n")
      .slice(1)
      .map((l) => l.trim());
  }
}

/** A staging deployment on DevNet with a live PSP: prod-like although neither prod nor mainnet. */
const LIVE = {
  APP_ENV: "staging",
  APP_NETWORK: "devnet",
  RAMP_PROVIDER_MODE: "live",
  RAMP_ENABLED: "true",
  RAMP_PUBLIC_APP_URL: "https://app.test",
};
const LOOSE = {
  // KYC_PROVIDER unset = mock; no token-app caps; no token sync; unverified TLS to a remote DB.
  TOKEN_APP_SYNC_SEC: "0",
  DATABASE_URL: "postgresql://db.internal:5432/x",
  DB_SSL: "auto",
};
const C32 = [
  /^KYC_PROVIDER=mock is refused when prod-like \(APP_ENV=prod, APP_NETWORK=mainnet or RAMP_PROVIDER_MODE=live\)$/,
  /^DB_SSL=true\/auto does not verify the Postgres server certificate; .* when prod-like/,
  /^RAMP_ENABLED=true when prod-like .* requires TOKEN_APP_MAX_PER_CALL and TOKEN_APP_MAX_PER_DAY$/,
  /^TOKEN_APP_SYNC_SEC=0 \(no token sync\) is refused with the ramp enabled when prod-like/,
];

describe("prod-like refusals (SPEC §8)", () => {
  it("C32: RAMP_PROVIDER_MODE=live refuses the KYC mock, unverified DB TLS, missing token-app caps and no token sync", () => {
    const lines = refusals({ ...LIVE, ...LOOSE });
    for (const pattern of C32)
      expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it("C32: the same loose settings boot in a sandbox staging deployment (not prod-like)", () => {
    const lines = refusals({ ...LIVE, ...LOOSE, RAMP_PROVIDER_MODE: "sandbox" });
    for (const pattern of C32) expect(lines.filter((l) => pattern.test(l))).toEqual([]);
  });

  it("C32: prod and mainnet keep refusing them, with the prod-like wording", () => {
    const prod = refusals({ ...LIVE, ...LOOSE, RAMP_PROVIDER_MODE: "sandbox", APP_ENV: "prod" });
    for (const pattern of C32)
      expect(prod).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
    expect(refusals({ APP_NETWORK: "mainnet" })).toEqual(
      expect.arrayContaining([expect.stringMatching(C32[0])]),
    );
  });

  it("C33: RAMP_SCAN_MS=0 is refused when prod-like, with the ramp on or off; off-prod it still boots", () => {
    const scanOff =
      /^RAMP_SCAN_MS=0 \(turns off .*full reconciliation.*TM-FROZEN-ACTIVITY.*\) is refused when prod-like .*controls\/halt$/;
    for (const extra of [
      { ...LIVE, RAMP_SCAN_MS: "0" } as Record<string, string>,
      { APP_ENV: "prod", KYC_PROVIDER: "sumsub", RAMP_SCAN_MS: "0" },
      { APP_NETWORK: "mainnet", RAMP_SCAN_MS: "0" },
    ])
      expect(refusals(extra)).toEqual(expect.arrayContaining([expect.stringMatching(scanOff)]));
    expect(
      refusals({ RAMP_SCAN_MS: "0", RAMP_ENABLED: "true", RAMP_PUBLIC_APP_URL: "http://x" }),
    ).toEqual([]);
    // Prod-like with the loops on: no such refusal.
    expect(
      refusals({ APP_ENV: "prod", KYC_PROVIDER: "sumsub" }).filter((l) => scanOff.test(l)),
    ).toEqual([]);
  });

  it("R2b-4: with RAMP_ENABLED=false the scan still moves in-flight orders: compliance off, and with a token-app its missing caps, mint cap and sync, are refused prod-like", () => {
    const prodOff = { APP_ENV: "prod", KYC_PROVIDER: "sumsub", RAMP_ENABLED: "false" };
    const withTokenApp = {
      ...prodOff,
      TOKEN_APP_URL: "https://token-app.internal",
      TOKEN_APP_SYNC_SEC: "0",
    };
    const lines = refusals({ ...withTokenApp, RAMP_COMPLIANCE: "off" });
    for (const pattern of [
      /^RAMP_COMPLIANCE=off is refused when prod-like .*RAMP_ENABLED=false too$/,
      /^TOKEN_APP_URL when prod-like .* requires TOKEN_APP_MAX_PER_CALL and TOKEN_APP_MAX_PER_DAY, with RAMP_ENABLED=false too/,
      /^TOKEN_APP_SYNC_SEC=0 \(no token sync\) is refused with a TOKEN_APP_URL when prod-like/,
      /^TOKEN_APP_URL requires RAMP_MINT_DAILY_CAP when prod-like/,
    ])
      expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
    // Set, they boot; without a token-app only compliance is asked for; off-prod nothing.
    const set = refusals({
      ...withTokenApp,
      TOKEN_APP_SYNC_SEC: "30",
      TOKEN_APP_MAX_PER_CALL: "1000",
      TOKEN_APP_MAX_PER_DAY: "5000",
      RAMP_MINT_DAILY_CAP: "5000",
    });
    expect(set.filter((l) => /RAMP_COMPLIANCE|TOKEN_APP_|RAMP_MINT_DAILY_CAP/.test(l))).toEqual([]);
    expect(
      refusals({ ...prodOff, TOKEN_APP_SYNC_SEC: "0" }).filter((l) =>
        /RAMP_COMPLIANCE|TOKEN_APP_|RAMP_MINT_DAILY_CAP/.test(l),
      ),
    ).toEqual([]);
    expect(
      refusals({
        RAMP_COMPLIANCE: "off",
        TOKEN_APP_URL: "https://token-app.internal",
        TOKEN_APP_SYNC_SEC: "0",
      }),
    ).toEqual([]);
  });
});
