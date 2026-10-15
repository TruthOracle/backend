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
const DSO = "DSO::1220" + "d".repeat(64);
const TRO_ADMIN = "tro::1220" + "e".repeat(64);

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

  describe("instruments, treasury transfers, token-app and rewards (docs/TOKENS.md §4.7)", () => {
    it("reads the two env-configured instruments with the documented defaults", () => {
      const c = cfg({
        COLLATERAL_INSTRUMENT_ADMIN: DSO,
        COLLATERAL_INSTRUMENT_ID: "Amulet",
        COLLATERAL_INSTRUMENT_SYMBOL: "CC",
        COLLATERAL_INSTRUMENT_NAME: "Canton Coin",
        COLLATERAL_INSTRUMENT_DECIMALS: "10",
        COLLATERAL_REGISTRY_URL: "https://api.validator.test/api/validator/v0/scan-proxy/",
        COLLATERAL_REGISTRY_AUTH: "ledger",
        REWARDS_INSTRUMENT_ADMIN: TRO_ADMIN,
        REWARDS_INSTRUMENT_ID: "TRO",
        REWARDS_INSTRUMENT_NAME: "TruthOracle Token",
        AUDIT_OBSERVER_PARTIES: `${PARTY}, ${DSO}`,
      });
      expect(c.collateralInstrument).toEqual({
        admin: DSO,
        id: "Amulet",
        symbol: "CC",
        name: "Canton Coin",
        decimals: 10,
        registryUrl: "https://api.validator.test/api/validator/v0/scan-proxy",
        registryAuth: "ledger",
        walletInstrumentId: "Amulet",
      });
      // symbol / wallet id default to the token id, name to the id when blank, decimals to 6, auth to keycloak
      expect(c.rewardsInstrument).toEqual({
        admin: TRO_ADMIN,
        id: "TRO",
        symbol: "TRO",
        name: "TruthOracle Token",
        decimals: 6,
        registryUrl: "",
        registryAuth: "keycloak",
        walletInstrumentId: "TRO",
      });
      expect(c.hasCollateralInstrument).toBe(true);
      expect(c.hasRewardsInstrument).toBe(true);
      expect(c.auditObserverParties).toEqual([PARTY, DSO]);
      expect(c.treasuryTransferMode).toBe("wallet");
      expect(c.treasuryTransferTtlSec).toBe(600);
      expect(c.ledgerFreshOffsets).toBe(50);
      expect(c.acceptorScanMs).toBe(10_000);
      expect(c.tokenApp).toEqual({ url: "", appName: "truthoracle", keycloak: {} });
      expect(c.hasTokenApp).toBe(false);
      expect(c.rewardsEnabled).toBe(true);
      expect(c.rewardsScanMs).toBe(30_000);
      expect(c.rewardsAutoMint).toBe(false);
      expect(c.rewardsMintMin).toBe(10_000_000_000_000n);
    });

    it("without any instrument variables nothing is configured and the process still boots", () => {
      const c = cfg();
      expect(c.collateralInstrument.id).toBe("");
      expect(c.hasCollateralInstrument).toBe(false);
      expect(c.hasRewardsInstrument).toBe(false);
    });

    it("a rewards id without its admin leaves rewards unconfigured instead of refusing to boot (TRO may not exist on the network yet)", () => {
      const c = cfg({ REWARDS_INSTRUMENT_ID: "TRO" });
      expect(c.rewardsInstrument.id).toBe("TRO");
      expect(c.hasRewardsInstrument).toBe(false);
    });

    it("parses the registry / token-app Keycloak overrides and the transfer mode", () => {
      const c = cfg({
        TREASURY_TRANSFER_MODE: "registry",
        TREASURY_TRANSFER_TTL_SEC: "120",
        LEDGER_FRESH_OFFSETS: "0",
        ACCEPTOR_SCAN_MS: "0",
        REGISTRY_KEYCLOAK_URL: "https://kc.registry/",
        REGISTRY_KEYCLOAK_CLIENT_ID: "reg",
        TOKEN_APP_URL: "https://token-app.test/",
        TOKEN_APP_APP_NAME: "to-dev",
        TOKEN_APP_KEYCLOAK_CLIENT_SECRET: "s",
        REWARDS_ENABLED: "false",
        REWARDS_AUTO_MINT: "true",
        REWARDS_MINT_MIN: "12.5",
      });
      expect(c.treasuryTransferMode).toBe("registry");
      expect(c.treasuryTransferTtlSec).toBe(120);
      expect(c.ledgerFreshOffsets).toBe(0);
      expect(c.acceptorScanMs).toBe(0);
      expect(c.registryKeycloak).toEqual({ url: "https://kc.registry", clientId: "reg" });
      expect(c.tokenApp).toEqual({
        url: "https://token-app.test",
        appName: "to-dev",
        keycloak: { clientSecret: "s" },
      });
      expect(c.hasTokenApp).toBe(true);
      expect(c.rewardsEnabled).toBe(false);
      expect(c.rewardsAutoMint).toBe(true);
      expect(c.rewardsMintMin).toBe(125_000_000_000n);
    });

    it.each([
      [
        "a collateral id without its admin",
        { COLLATERAL_INSTRUMENT_ID: "cBYN" },
        /COLLATERAL_INSTRUMENT_ID is set without COLLATERAL_INSTRUMENT_ADMIN/,
      ],
      [
        "a collateral admin without its id",
        { COLLATERAL_INSTRUMENT_ADMIN: DSO },
        /COLLATERAL_INSTRUMENT_ADMIN is set without/,
      ],
      [
        "a collateral admin that is not a party",
        { COLLATERAL_INSTRUMENT_ADMIN: "dso", COLLATERAL_INSTRUMENT_ID: "Amulet" },
        /COLLATERAL_INSTRUMENT_ADMIN is not a Canton party id/,
      ],
      [
        "decimals above the fixed-point scale",
        {
          COLLATERAL_INSTRUMENT_ADMIN: DSO,
          COLLATERAL_INSTRUMENT_ID: "Amulet",
          COLLATERAL_INSTRUMENT_DECIMALS: "18",
        },
        /COLLATERAL_INSTRUMENT_DECIMALS/,
      ],
      [
        "negative decimals",
        {
          REWARDS_INSTRUMENT_ADMIN: TRO_ADMIN,
          REWARDS_INSTRUMENT_ID: "TRO",
          REWARDS_INSTRUMENT_DECIMALS: "-1",
        },
        /REWARDS_INSTRUMENT_DECIMALS/,
      ],
      [
        "an unknown registry auth",
        { COLLATERAL_REGISTRY_AUTH: "basic" },
        /COLLATERAL_REGISTRY_AUTH must be one of none, ledger, keycloak/,
      ],
      [
        "a relative registry URL",
        { REWARDS_REGISTRY_URL: "token-registry.test/api" },
        /REWARDS_REGISTRY_URL is not an absolute/,
      ],
      ["an unknown transfer mode", { TREASURY_TRANSFER_MODE: "manual" }, /treasuryTransferMode/],
      [
        "an audit observer that is not a party",
        { AUDIT_OBSERVER_PARTIES: "regulator" },
        /AUDIT_OBSERVER_PARTIES/,
      ],
      ["a relative token-app URL", { TOKEN_APP_URL: "token-app.test" }, /TOKEN_APP_URL/],
      ["an acceptor cadence between 0 and 1 s", { ACCEPTOR_SCAN_MS: "500" }, /ACCEPTOR_SCAN_MS/],
      ["a rewards scan under 1 s", { REWARDS_SCAN_MS: "10" }, /rewardsScanMs/],
      ["a malformed REWARDS_MINT_MIN", { REWARDS_MINT_MIN: "lots" }, /REWARDS_MINT_MIN/],
    ])("refuses %s", (_name, extra, pattern) => {
      expect(() => cfg(extra)).toThrow(pattern);
    });
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
      [
        "short KYC_FINGERPRINT_PEPPER",
        { KYC_FINGERPRINT_PEPPER: "short" },
        /KYC_FINGERPRINT_PEPPER/,
      ],
      ["short BACKEND_PROXY_SECRET", { BACKEND_PROXY_SECRET: "short" }, /BACKEND_PROXY_SECRET/],
      ["mock in prod", { APP_ENV: "prod", KYC_PROVIDER: "mock" }, /KYC_PROVIDER=mock/],
      [
        "mock on mainnet",
        {
          APP_NETWORK: "mainnet",
          KYC_PROVIDER: "mock",
          ZKPC_LEDGER_API_URL: "https://l",
          ZKPC_KEYCLOAK_URL: "https://k",
          ZKPC_KEYCLOAK_CLIENT_ID: "c",
          ZKPC_KEYCLOAK_CLIENT_SECRET: "s",
        },
        /KYC_PROVIDER=mock/,
      ],
      [
        "sbx token on mainnet",
        {
          APP_NETWORK: "mainnet",
          KYC_PROVIDER: "sumsub",
          SUMSUB_APP_TOKEN: "sbx:abc",
          ZKPC_LEDGER_API_URL: "https://l",
          ZKPC_KEYCLOAK_URL: "https://k",
          ZKPC_KEYCLOAK_CLIENT_ID: "c",
          ZKPC_KEYCLOAK_CLIENT_SECRET: "s",
        },
        /sandbox token/,
      ],
      ["mainnet without ZKPC", { APP_NETWORK: "mainnet", KYC_PROVIDER: "sumsub" }, /ZKPC_/],
      [
        "cookie domain with proxy secret",
        { COOKIE_DOMAIN: "example.com", BACKEND_PROXY_SECRET: "x".repeat(32) },
        /COOKIE_DOMAIN/,
      ],
      ["bad operator party", { ADMIN_OPERATORS: "not-a-party=abc" }, /ADMIN_OPERATORS/],
      ["bad origin", { FRONTEND_ORIGINS: "app.test" }, /origin entry/],
      ["bad rotation ack", { KYC_PEPPER_ROTATION_ACK: "nope" }, /KYC_PEPPER_ROTATION_ACK/],
      [
        "sumsub without a webhook secret",
        { KYC_PROVIDER: "sumsub", SUMSUB_APP_TOKEN: "prd:x", SUMSUB_SECRET_KEY: "k" },
        /SUMSUB_WEBHOOK_SECRET/,
      ],
      [
        "prod with unverified Postgres TLS",
        {
          APP_ENV: "prod",
          KYC_PROVIDER: "sumsub",
          DATABASE_URL: "postgresql://u:p@db.remote:5432/x",
        },
        /DB_SSL=verify/,
      ],
      [
        "prod with DB_SSL=true",
        { APP_ENV: "prod", KYC_PROVIDER: "sumsub", DB_SSL: "true" },
        /DB_SSL=verify/,
      ],
      [
        "a deposit lock TTL below the worst-case walk",
        { DEPOSIT_LOCK_TTL_MS: "1000" },
        /depositLockTtlMs/,
      ],
    ])("refuses %s", (_name, extra, pattern) => {
      expect(() => cfg(extra)).toThrow(pattern);
    });

    it("accepts the safe combinations", () => {
      // KYC enforcement is a plain flag: nothing else has to be attested first (ARCHITECTURE §18).
      expect(cfg({ KYC_ENFORCE_WITHDRAWALS: "true" }).kycEnforceWithdrawals).toBe(true);
      expect(cfg().kycEnforceWithdrawals).toBe(false);
      expect(
        cfg({
          APP_ENV: "prod",
          KYC_PROVIDER: "sumsub",
          DATABASE_URL: "postgresql://u:p@db.remote:5432/x",
          DB_SSL: "verify",
        }).dbSsl,
      ).toBe("verify");
      expect(
        cfg({
          APP_ENV: "prod",
          KYC_PROVIDER: "sumsub",
          DATABASE_URL: "postgresql://u:p@db.remote:5432/x",
          DB_SSL_INSECURE_ACK: "true",
        }).dbSslInsecureAck,
      ).toBe(true);
      expect(
        cfg({
          KYC_PROVIDER: "sumsub",
          SUMSUB_APP_TOKEN: "prd:x",
          SUMSUB_SECRET_KEY: "k",
          SUMSUB_WEBHOOK_SECRET: "w",
        }).sumsub.webhookSecret,
      ).toBe("w");
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
