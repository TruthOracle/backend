import { getConfiguration, parseOperators } from "./config";

const BASE: Record<string, string> = {
  APP_ENV: "dev",
  APP_NETWORK: "devnet",
  DATABASE_URL: "postgresql://localhost:5432/x",
  REDIS_URL: "redis://localhost:6379",
  NATS_URL: "nats://localhost:4222",
  SESSION_SECRET: "s".repeat(32),
  KYC_FINGERPRINT_PEPPER: "p".repeat(32),
};

const PARTY = "op::1220" + "a".repeat(64);

function cfg(extra: Record<string, string> = {}): ReturnType<typeof getConfiguration> {
  return getConfiguration({ ...BASE, ...extra });
}

describe("config", () => {
  it("parses lists, maps, booleans and auto values", () => {
    const c = cfg({
      FRONTEND_ORIGINS: "https://app.test, https://*.vercel.app",
      GOOGLE_CLIENT_IDS: "a.apps,b.apps",
      ADMIN_OPERATORS: `${PARTY}=deadbeef${"0".repeat(56)}, ${PARTY.replace("op::", "two::")}`,
      LOG_JSON: "auto",
      COOKIE_SECURE: "auto",
      SWAGGER_ENABLED: "auto",
      GOOGLE_NONCE_REQUIRED: "auto",
      KYC_ENFORCE_WITHDRAWALS: "yes",
      PAYOUT_INAPP_REASONS: "bond, model-prize",
      SUMSUB_DUPLICATE_LABELS: "duplicate,fraud",
    });
    expect(c.frontendOrigins).toEqual(["https://app.test", "https://*.vercel.app"]);
    expect(c.googleClientIds).toEqual(["a.apps", "b.apps"]);
    expect(c.adminOperators.get(PARTY)).toBe(`deadbeef${"0".repeat(56)}`);
    expect(c.adminOperators.get(PARTY.replace("op::", "two::"))).toBe("");
    expect(c.logJson).toBe(false);
    expect(c.cookieSecure).toBe(false);
    expect(c.swaggerEnabled).toBe(true);
    expect(c.googleNonceRequired).toBe(false);
    expect(c.kycEnforceWithdrawals).toBe(true);
    expect(c.payoutInappReasons).toEqual(["bond", "model-prize"]);
    expect(c.payoutExternalReasons).toEqual(["withdraw"]);
    expect(c.sumsub.duplicateLabels).toEqual(["DUPLICATE", "FRAUD"]);
    expect(c.kycPepperHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.sessionTtlMs).toBe(168 * 3_600_000);
    expect(c.adminSessionTtlMs).toBe(3_600_000);
  });

  it("resolves auto values differently outside dev/prod", () => {
    const staging = cfg({ APP_ENV: "staging", KYC_PROVIDER: "mock" });
    expect(staging.logJson).toBe(true);
    expect(staging.cookieSecure).toBe(true);
    expect(staging.googleNonceRequired).toBe(true);
    expect(staging.swaggerEnabled).toBe(true);
    const prod = cfg({ APP_ENV: "prod", KYC_PROVIDER: "sumsub" });
    expect(prod.swaggerEnabled).toBe(false);
  });

  it("parseOperators splits on the first = only", () => {
    const ops = parseOperators(`${PARTY}=abc==,x::1220${"b".repeat(64)}`);
    expect(ops.get(PARTY)).toBe("abc==");
    expect(ops.get(`x::1220${"b".repeat(64)}`)).toBe("");
  });

  describe("boot refusals (ARCHITECTURE §12)", () => {
    it.each([
      ["missing DATABASE_URL", { DATABASE_URL: "" }, /DATABASE_URL/],
      ["missing REDIS_URL", { REDIS_URL: "" }, /REDIS_URL/],
      ["missing NATS_URL", { NATS_URL: "" }, /NATS_URL/],
      ["short SESSION_SECRET", { SESSION_SECRET: "short" }, /SESSION_SECRET/],
      ["short KYC_FINGERPRINT_PEPPER", { KYC_FINGERPRINT_PEPPER: "short" }, /KYC_FINGERPRINT_PEPPER/],
      ["short BACKEND_PROXY_SECRET", { BACKEND_PROXY_SECRET: "short" }, /BACKEND_PROXY_SECRET/],
      ["mock in prod", { APP_ENV: "prod", KYC_PROVIDER: "mock" }, /KYC_PROVIDER=mock/],
      [
        "mock on mainnet",
        { APP_NETWORK: "mainnet", KYC_PROVIDER: "mock", ZKPC_LEDGER_API_URL: "https://l", ZKPC_KEYCLOAK_URL: "https://k", ZKPC_KEYCLOAK_CLIENT_ID: "c", ZKPC_KEYCLOAK_CLIENT_SECRET: "s" },
        /KYC_PROVIDER=mock/,
      ],
      [
        "sbx token on mainnet",
        { APP_NETWORK: "mainnet", KYC_PROVIDER: "sumsub", SUMSUB_APP_TOKEN: "sbx:abc", ZKPC_LEDGER_API_URL: "https://l", ZKPC_KEYCLOAK_URL: "https://k", ZKPC_KEYCLOAK_CLIENT_ID: "c", ZKPC_KEYCLOAK_CLIENT_SECRET: "s" },
        /sandbox token/,
      ],
      ["mainnet without ZKPC", { APP_NETWORK: "mainnet", KYC_PROVIDER: "sumsub" }, /ZKPC_/],
      ["cookie domain with proxy secret", { COOKIE_DOMAIN: "example.com", BACKEND_PROXY_SECRET: "x".repeat(32) }, /COOKIE_DOMAIN/],
      ["bad operator party", { ADMIN_OPERATORS: "not-a-party=abc" }, /ADMIN_OPERATORS/],
      ["bad origin", { FRONTEND_ORIGINS: "app.test" }, /origin entry/],
      ["bad rotation ack", { KYC_PEPPER_ROTATION_ACK: "nope" }, /KYC_PEPPER_ROTATION_ACK/],
      ["sumsub without a webhook secret", { KYC_PROVIDER: "sumsub", SUMSUB_APP_TOKEN: "prd:x", SUMSUB_SECRET_KEY: "k" }, /SUMSUB_WEBHOOK_SECRET/],
      ["prod with unverified Postgres TLS", { APP_ENV: "prod", KYC_PROVIDER: "sumsub", DATABASE_URL: "postgresql://u:p@db.remote:5432/x" }, /DB_SSL=verify/],
      ["prod with DB_SSL=true", { APP_ENV: "prod", KYC_PROVIDER: "sumsub", DB_SSL: "true" }, /DB_SSL=verify/],
      ["a deposit lock TTL below the worst-case walk", { DEPOSIT_LOCK_TTL_MS: "1000" }, /depositLockTtlMs/],
    ])("refuses %s", (_name, extra, pattern) => {
      expect(() => cfg(extra)).toThrow(pattern);
    });

    it("accepts the safe combinations", () => {
      // KYC enforcement is a plain flag: nothing else has to be attested first (ARCHITECTURE §18).
      expect(cfg({ KYC_ENFORCE_WITHDRAWALS: "true" }).kycEnforceWithdrawals).toBe(true);
      expect(cfg().kycEnforceWithdrawals).toBe(false);
      expect(cfg({ APP_ENV: "prod", KYC_PROVIDER: "sumsub", DATABASE_URL: "postgresql://u:p@db.remote:5432/x", DB_SSL: "verify" }).dbSsl).toBe("verify");
      expect(cfg({ APP_ENV: "prod", KYC_PROVIDER: "sumsub", DATABASE_URL: "postgresql://u:p@db.remote:5432/x", DB_SSL_INSECURE_ACK: "true" }).dbSslInsecureAck).toBe(true);
      expect(cfg({ KYC_PROVIDER: "sumsub", SUMSUB_APP_TOKEN: "prd:x", SUMSUB_SECRET_KEY: "k", SUMSUB_WEBHOOK_SECRET: "w" }).sumsub.webhookSecret).toBe("w");
      const knobs = cfg({ DEPOSIT_CONFIRM_GRACE_MS: "0", PAYOUT_RESEND_GRACE_MS: "0" });
      expect(knobs.depositConfirmGraceMs).toBe(0);
      expect(knobs.payoutResendGraceMs).toBe(0);
      expect(cfg().depositConfirmGraceMs).toBe(600_000);
      expect(cfg().payoutResendGraceMs).toBe(600_000);
      expect(() =>
        cfg({
          APP_NETWORK: "mainnet",
          KYC_PROVIDER: "sumsub",
          ZKPC_LEDGER_API_URL: "https://ledger.mainnet",
          ZKPC_KEYCLOAK_URL: "https://kc.mainnet",
          ZKPC_KEYCLOAK_CLIENT_ID: "cid",
          ZKPC_KEYCLOAK_CLIENT_SECRET: "sec",
        }),
      ).not.toThrow();
      expect(() => cfg({ COOKIE_DOMAIN: "example.com" })).not.toThrow();
    });
  });
});
