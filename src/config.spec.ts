import { Config, getConfiguration, parseOperatorEntries, parseOperators } from "./config";

const BASE: Record<string, string> = {
  APP_ENV: "dev",
  APP_NETWORK: "devnet",
  DATABASE_URL: "postgresql://localhost:5432/x",
  REDIS_URL: "redis://localhost:6379",
  NATS_URL: "nats://localhost:4222",
  SESSION_SECRET: "s".repeat(32),
  KYC_FINGERPRINT_PEPPER: "p".repeat(32),
  // Explicit keyrings (SPEC §8): prod-like configurations refuse the SESSION_SECRET-derived ones.
  DATA_KEYS: `k1:${Buffer.alloc(32, 0x11).toString("base64")}`,
  DATA_KEY_ID: "k1",
  DATA_INDEX_KEYS: `i1:${Buffer.alloc(32, 0x22).toString("base64")}`,
  DATA_INDEX_KEY_ID: "i1",
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

  describe("fiat ramp (docs/RAMP.md §10)", () => {
    it("defaults to off with the mock acquirer, BYN at 2 decimals and placeholder limits", () => {
      const c = cfg();
      expect(c.ramp).toMatchObject({
        enabled: false,
        provider: "mock",
        instrument: null,
        fiatCurrency: "BYN",
        fiatDecimals: 2,
        requireKyc: true,
        require3ds: true,
        maxCards: 3,
        scanMs: 10_000,
      });
      expect(c.ramp.onramp).toEqual({
        min: 100_000_000_000n,
        max: 20_000_000_000_000n,
        dailyMax: 30_000_000_000_000n,
        monthlyMax: 200_000_000_000_000n,
      });
      // The mock derives its webhook secret from SESSION_SECRET.
      expect(c.ramp.mockWebhookSecret).toMatch(/^[0-9a-f]{64}$/);
    });

    it("parses RAMP_INSTRUMENT as <party>:<id>", () => {
      const c = cfg({ RAMP_INSTRUMENT: `${DSO}:cBYN`, RAMP_SCAN_MS: "0" });
      expect(c.ramp.instrument).toEqual({ admin: DSO, id: "cBYN" });
      expect(c.ramp.scanMs).toBe(0);
    });

    it.each([
      [
        "the mock acquirer enabled in prod",
        {
          APP_ENV: "prod",
          KYC_PROVIDER: "sumsub",
          RAMP_ENABLED: "true",
          RAMP_PUBLIC_APP_URL: "https://app.test",
        },
        /RAMP_PROVIDER=mock is refused/,
      ],
      ["an unknown acquirer", { RAMP_PROVIDER: "acme" }, /RAMP_PROVIDER must be one of/],
      ["the ramp enabled without its return page", { RAMP_ENABLED: "true" }, /RAMP_PUBLIC_APP_URL/],
      ["a malformed instrument", { RAMP_INSTRUMENT: "cBYN" }, /RAMP_INSTRUMENT must be/],
      ["a non-party instrument admin", { RAMP_INSTRUMENT: "admin:cBYN" }, /not a Canton party/],
      ["min above max", { RAMP_ONRAMP_MIN: "5000" }, /RAMP_ONRAMP_MIN must be positive/],
      ["daily above monthly", { RAMP_OFFRAMP_DAILY_MAX: "30000" }, /RAMP_OFFRAMP_DAILY_MAX/],
      ["a malformed amount", { RAMP_OFFRAMP_MAX: "free" }, /RAMP_OFFRAMP_\* amounts/],
      ["a scan between 0 and 1 s", { RAMP_SCAN_MS: "200" }, /RAMP_SCAN_MS/],
      ["a lowercase currency", { RAMP_FIAT_CURRENCY: "by" }, /ISO 4217/],
    ])("refuses %s", (_name, extra, pattern) => {
      expect(() => cfg(extra)).toThrow(pattern);
    });
  });

  describe("fiat ramp core (SPEC §13 S2)", () => {
    it("defaults: 60 min withdrawing timeout, 60 min credit-back finality, 72 h dead events, 5 min stale created, 48 h post-close poll, 240 bps card PSP fee", () => {
      expect(cfg().ramp).toMatchObject({
        checkoutHosts: [],
        withdrawingTimeoutMin: 60,
        creditBackFinalAfterMin: 60,
        eventDeadAfterHours: 72,
        createdStaleMin: 5,
        closedPollHours: 48,
      });
      expect(cfg().ramp.method.card.pspFeeBps).toBe(240);
    });

    it("parses RAMP_CHECKOUT_HOSTS as lower-case hosts", () => {
      expect(
        cfg({ RAMP_CHECKOUT_HOSTS: "Checkout.bePaid.by, secure.webpay.by" }).ramp.checkoutHosts,
      ).toEqual(["checkout.bepaid.by", "secure.webpay.by"]);
    });

    it.each([
      [
        "a zero withdrawing timeout",
        { RAMP_WITHDRAWING_TIMEOUT_MIN: "0" },
        /RAMP_WITHDRAWING_TIMEOUT_MIN/,
      ],
      [
        "a zero dead-letter age",
        { RAMP_EVENT_DEAD_AFTER_HOURS: "0" },
        /RAMP_EVENT_DEAD_AFTER_HOURS/,
      ],
      ["a stale-created age of 0", { RAMP_CREATED_STALE_MIN: "0" }, /RAMP_CREATED_STALE_MIN/],
      [
        "a credit-back failure final at once (W9g C1)",
        { RAMP_CREDIT_BACK_FINAL_AFTER_MIN: "0" },
        /RAMP_CREDIT_BACK_FINAL_AFTER_MIN must be an integer ≥ 1/,
      ],
      [
        "a non-numeric credit-back bound",
        { RAMP_CREDIT_BACK_FINAL_AFTER_MIN: "an hour" },
        /RAMP_CREDIT_BACK_FINAL_AFTER_MIN/,
      ],
      ["a negative post-close poll", { RAMP_CLOSED_POLL_HOURS: "-1" }, /RAMP_CLOSED_POLL_HOURS/],
      ["a PSP fee over 100 %", { RAMP_CARD_PSP_FEE_BPS: "10001" }, /RAMP_CARD_PSP_FEE_BPS/],
      [
        "a checkout host with a scheme",
        { RAMP_CHECKOUT_HOSTS: "https://checkout.bepaid.by" },
        /RAMP_CHECKOUT_HOSTS has a malformed host/,
      ],
      [
        "no post-close poll with the ramp on prod-like",
        {
          RAMP_ENABLED: "true",
          RAMP_PUBLIC_APP_URL: "https://app.test",
          RAMP_PROVIDER_MODE: "live",
          RAMP_CLOSED_POLL_HOURS: "0",
        },
        /RAMP_CLOSED_POLL_HOURS=0 \(no post-close poll\) is refused/,
      ],
    ])("refuses %s", (_name, extra, pattern) => {
      expect(() => cfg(extra)).toThrow(pattern);
    });

    it("the stale-created age is checked against the adapter's HTTP timeout", () => {
      // 1 min > 30 s: accepted; the refusal names the timeout when the age does not exceed it.
      expect(cfg({ RAMP_CREATED_STALE_MIN: "1" }).ramp.createdStaleMin).toBe(1);
      expect(() => cfg({ RAMP_CREATED_STALE_MIN: "0" })).toThrow(/HTTP timeout \(30 s\)/);
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

// ── token side and ZKPC (SPEC §7; stage S1) ──────────────────────────────────────────────────
describe("config: token side and ZKPC (SPEC §7)", () => {
  /** The refusal lines a configuration produces ([] when it boots) — robust to other stages' refusals. */
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
  const S1_LINE =
    /TOKEN_APP|REGISTRY_KEYCLOAK|KEYCLOAK_URL|REWARDS_|tripwire|RAMP_TOKEN|RAMP_RECON_EVERY_MIN|_REGISTRY_/;
  const MAINNET: Record<string, string> = {
    APP_NETWORK: "mainnet",
    KYC_PROVIDER: "sumsub",
    ZKPC_LEDGER_API_URL: "https://ledger.main.zkpc.cantor8.tech",
    ZKPC_KEYCLOAK_URL: "https://auth.main.zkpc.cantor8.tech",
    ZKPC_KEYCLOAK_CLIENT_ID: "zkpc-ledger",
    ZKPC_KEYCLOAK_CLIENT_SECRET: "zkpc-ledger-secret",
    KEYCLOAK_URL: "https://kc.wallet.test",
    KEYCLOAK_CLIENT_ID: "wallet-client",
    KEYCLOAK_CLIENT_SECRET: "wallet-secret",
  };
  const DEDICATED: Record<string, string> = {
    TOKEN_APP_URL: "https://token-app.main.zkpc.cantor8.tech",
    TOKEN_APP_KEYCLOAK_URL: "https://auth.main.zkpc.cantor8.tech",
    TOKEN_APP_KEYCLOAK_CLIENT_ID: "truthoracle-token-app",
    TOKEN_APP_KEYCLOAK_CLIENT_SECRET: "dedicated-secret",
  };

  it("defaults: no caps, a 60 s sync, 144 h re-send window, 15 / 120 min confirm / review", () => {
    expect(cfg().tokenCommands).toEqual({
      maxPerCall: null,
      maxPerDay: null,
      syncSec: 60,
      idleSyncMin: 15,
      resendMaxAgeHours: 144,
      confirmMin: 15,
      reviewAfterMin: 120,
    });
    expect(
      cfg({
        TOKEN_APP_MAX_PER_CALL: "2000",
        TOKEN_APP_MAX_PER_DAY: "50000.5",
        TOKEN_APP_SYNC_SEC: "0",
        RAMP_RECON_EVERY_MIN: "5",
        TOKEN_APP_RESEND_MAX_AGE_HOURS: "100",
        RAMP_TOKEN_CONFIRM_MIN: "10",
        RAMP_TOKEN_REVIEW_AFTER_MIN: "60",
      }).tokenCommands,
    ).toEqual({
      maxPerCall: 20_000_000_000_000n,
      maxPerDay: 500_005_000_000_000n,
      syncSec: 0,
      idleSyncMin: 5,
      resendMaxAgeHours: 100,
      confirmMin: 10,
      reviewAfterMin: 60,
    });
  });

  it.each([
    // any network
    [
      "a scheme-less TOKEN_APP_KEYCLOAK_URL (was silently replaced by KEYCLOAK_URL)",
      { TOKEN_APP_KEYCLOAK_URL: "auth.main.zkpc.cantor8.tech" },
      /^TOKEN_APP_KEYCLOAK_URL is not an absolute http\(s\) URL/,
    ],
    ["a malformed KEYCLOAK_URL", { KEYCLOAK_URL: "kc" }, /^KEYCLOAK_URL is not an absolute/],
    [
      "a non-http REGISTRY_KEYCLOAK_URL",
      { REGISTRY_KEYCLOAK_URL: "ftp://kc.registry" },
      /^REGISTRY_KEYCLOAK_URL is not an absolute/,
    ],
    [
      "a malformed ZKPC_KEYCLOAK_URL",
      { ZKPC_KEYCLOAK_URL: "zkpc" },
      /^ZKPC_KEYCLOAK_URL is not an absolute/,
    ],
    [
      "a malformed cap",
      { TOKEN_APP_MAX_PER_CALL: "lots" },
      /TOKEN_APP_MAX_PER_CALL must be a positive/,
    ],
    [
      "a zero daily cap",
      { TOKEN_APP_MAX_PER_DAY: "0" },
      /TOKEN_APP_MAX_PER_DAY must be a positive/,
    ],
    [
      "a per-call cap above the daily one",
      { TOKEN_APP_MAX_PER_CALL: "10", TOKEN_APP_MAX_PER_DAY: "5" },
      /TOKEN_APP_MAX_PER_CALL must be ≤/,
    ],
    ["a sync faster than 5 s", { TOKEN_APP_SYNC_SEC: "2" }, /TOKEN_APP_SYNC_SEC must be 0/],
    [
      "a re-send window past the 7-day dedup",
      { TOKEN_APP_RESEND_MAX_AGE_HOURS: "168" },
      /TOKEN_APP_RESEND_MAX_AGE_HOURS/,
    ],
    [
      "review before the confirm amber",
      { RAMP_TOKEN_CONFIRM_MIN: "30", RAMP_TOKEN_REVIEW_AFTER_MIN: "30" },
      /RAMP_TOKEN_REVIEW_AFTER_MIN must be greater/,
    ],
    [
      "the ramp enabled in prod without caps",
      { APP_ENV: "prod", RAMP_ENABLED: "true" },
      /requires TOKEN_APP_MAX_PER_CALL and TOKEN_APP_MAX_PER_DAY/,
    ],
    [
      "the ramp enabled in prod with the sync off",
      { APP_ENV: "prod", RAMP_ENABLED: "true", TOKEN_APP_SYNC_SEC: "0" },
      /TOKEN_APP_SYNC_SEC=0/,
    ],
    [
      "a rewards instrument equal to the collateral",
      {
        COLLATERAL_INSTRUMENT_ADMIN: DSO,
        COLLATERAL_INSTRUMENT_ID: "cBYN",
        REWARDS_INSTRUMENT_ADMIN: DSO,
        REWARDS_INSTRUMENT_ID: "cBYN",
      },
      /REWARDS_INSTRUMENT_\* must not be the ramp/,
    ],
    [
      "a rewards instrument equal to RAMP_INSTRUMENT",
      {
        RAMP_INSTRUMENT: `${TRO_ADMIN}:TRO`,
        REWARDS_INSTRUMENT_ADMIN: TRO_ADMIN,
        REWARDS_INSTRUMENT_ID: "TRO",
      },
      /REWARDS_INSTRUMENT_\* must not be the ramp/,
    ],
    // cross-network tripwire
    [
      "a devnet backend on the MainNet token-app",
      { TOKEN_APP_URL: "https://token-app.main.zkpc.cantor8.tech" },
      /^TOKEN_APP_URL is a mainnet Cantor8 host but APP_NETWORK=devnet/,
    ],
    [
      "a devnet ledger Keycloak on zkpc",
      { KEYCLOAK_URL: "https://auth.zkpc.cantor8.tech" },
      /^KEYCLOAK_URL is a mainnet Cantor8 host/,
    ],
    [
      "a mainnet backend on a devnet registry",
      {
        ...MAINNET,
        ...DEDICATED,
        COLLATERAL_REGISTRY_URL: "https://token-registry.dev.digik.cantor8.tech/api/c8",
        COLLATERAL_REGISTRY_AUTH: "none",
      },
      /^COLLATERAL_REGISTRY_URL is a devnet Cantor8 host but APP_NETWORK=mainnet/,
    ],
    [
      "a mainnet ledger on digik",
      { ...MAINNET, ZKPC_LEDGER_API_URL: "https://ledger.digik.cantor8.tech" },
      /^ZKPC_LEDGER_API_URL is a devnet Cantor8 host/,
    ],
    // mainnet
    [
      "mainnet token-app without its dedicated client",
      {
        ...MAINNET,
        TOKEN_APP_URL: DEDICATED.TOKEN_APP_URL,
        TOKEN_APP_KEYCLOAK_URL: DEDICATED.TOKEN_APP_KEYCLOAK_URL,
      },
      /TOKEN_APP_URL requires TOKEN_APP_KEYCLOAK_URL, TOKEN_APP_KEYCLOAK_CLIENT_ID and TOKEN_APP_KEYCLOAK_CLIENT_SECRET/,
    ],
    [
      "mainnet token-app reusing the wallet client",
      { ...MAINNET, ...DEDICATED, TOKEN_APP_KEYCLOAK_CLIENT_ID: "wallet-client" },
      /TOKEN_APP_KEYCLOAK_CLIENT_ID must be token-app's dedicated client/,
    ],
    [
      "mainnet token-app over http",
      { ...MAINNET, ...DEDICATED, TOKEN_APP_URL: "http://token-app.internal" },
      /APP_NETWORK=mainnet: TOKEN_APP_URL must be https/,
    ],
    [
      "mainnet token-app Keycloak over http",
      { ...MAINNET, ...DEDICATED, TOKEN_APP_KEYCLOAK_URL: "http://kc.internal" },
      /TOKEN_APP_KEYCLOAK_URL must be https/,
    ],
    [
      "mainnet keycloak registry auth without REGISTRY_KEYCLOAK_*",
      {
        ...MAINNET,
        COLLATERAL_REGISTRY_URL: "https://token-registry.main.zkpc.cantor8.tech/api/truthoracle",
        COLLATERAL_REGISTRY_AUTH: "keycloak",
      },
      /COLLATERAL_REGISTRY_AUTH=keycloak requires REGISTRY_KEYCLOAK_URL/,
    ],
    [
      "REWARDS_AUTO_MINT on mainnet",
      { ...MAINNET, REWARDS_AUTO_MINT: "true" },
      /REWARDS_AUTO_MINT=true is refused on APP_NETWORK=mainnet/,
    ],
  ])("refuses %s", (_name, extra, pattern) => {
    expect(refusals(extra)).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it("accepts the MainNet token-app values with the dedicated client, a public registry and the devnet layout on devnet", () => {
    expect(
      refusals({
        ...MAINNET,
        ...DEDICATED,
        COLLATERAL_INSTRUMENT_ADMIN: DSO,
        COLLATERAL_INSTRUMENT_ID: "cBYN",
        COLLATERAL_REGISTRY_URL: "https://token-registry.main.zkpc.cantor8.tech/api/truthoracle",
        COLLATERAL_REGISTRY_AUTH: "none",
        REWARDS_AUTO_MINT: "false",
        // R2b-4: a token-app on a prod-like deployment keeps its caps with the ramp off too.
        TOKEN_APP_MAX_PER_CALL: "2000",
        TOKEN_APP_MAX_PER_DAY: "10000",
        RAMP_MINT_DAILY_CAP: "10000",
      }).filter((l) => S1_LINE.test(l)),
    ).toEqual([]);
    const devnet = cfg({
      KEYCLOAK_URL: "https://auth.dev.digik.cantor8.tech",
      LEDGER_API_URL: "https://ledger.dev.digik.cantor8.tech",
      COLLATERAL_REGISTRY_URL: "https://token-registry.dev.digik.cantor8.tech/api/c8",
      TOKEN_APP_URL: "http://localhost:8000",
      REWARDS_AUTO_MINT: "true",
    });
    expect(devnet.rewardsAutoMint).toBe(true);
    // A non-Cantor8 host never trips the tripwire, whatever its name.
    expect(refusals({ TOKEN_APP_URL: "https://main.zkpc.example.org" })).toEqual([]);
  });
});

// ── platform security (SPEC §8; stage S3) ────────────────────────────────────────────────────
describe("config: platform security (SPEC §8)", () => {
  /** The refusal lines a configuration produces ([] when it boots) — robust to other stages' refusals. */
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
  const S3_LINE =
    /DATA_|RAMP_PROVIDER_MODE|RAMP_IP_AUTH|RAMP_WEBHOOK|RAMP_TRUSTED_EDGE|RAMP_REQUIRE_|must be https when prod-like|RAMP_PUBLIC_API_URL is required/;
  const key = (fill: number): string => Buffer.alloc(32, fill).toString("base64");
  const NO_KEYRINGS = {
    DATA_KEYS: "",
    DATA_KEY_ID: "",
    DATA_INDEX_KEYS: "",
    DATA_INDEX_KEY_ID: "",
  };
  const MAINNET_BASE: Record<string, string> = {
    APP_NETWORK: "mainnet",
    KYC_PROVIDER: "sumsub",
    ZKPC_LEDGER_API_URL: "https://ledger.main.zkpc.cantor8.tech",
    ZKPC_KEYCLOAK_URL: "https://auth.main.zkpc.cantor8.tech",
    ZKPC_KEYCLOAK_CLIENT_ID: "zkpc-ledger",
    ZKPC_KEYCLOAK_CLIENT_SECRET: "zkpc-ledger-secret",
  };
  const PROD_RAMP = {
    APP_ENV: "prod",
    KYC_PROVIDER: "sumsub",
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "https://app.test",
  };

  it("derives both keyrings from SESSION_SECRET off prod-like, under a kid that changes with the secret", () => {
    const dev = cfg(NO_KEYRINGS);
    expect(dev.sealing.derived).toEqual({ data: true, index: true });
    expect(dev.sealing.data.activeKid).toMatch(/^dev-[0-9a-f]{8}$/);
    expect(dev.sealing.index.activeKid).toMatch(/^dev-[0-9a-f]{8}$/);
    const dataKey = dev.sealing.data.keys.get(dev.sealing.data.activeKid);
    const indexKey = dev.sealing.index.keys.get(dev.sealing.index.activeKid);
    expect(dataKey).toHaveLength(32);
    expect(indexKey?.equals(dataKey as Buffer)).toBe(false);
    expect(cfg(NO_KEYRINGS).sealing.data.activeKid).toBe(dev.sealing.data.activeKid);
    expect(cfg({ ...NO_KEYRINGS, SESSION_SECRET: "t".repeat(32) }).sealing.data.activeKid).not.toBe(
      dev.sealing.data.activeKid,
    );
  });

  it("parses explicit keyrings (rotation: several kids, one active), the provider mode and the webhook source settings", () => {
    const c = cfg({
      DATA_KEYS: `k1:${key(1)},k2:${key(2)}`,
      DATA_KEY_ID: "k2",
      RAMP_IP_AUTH_PROVIDERS: "WebPay",
      RAMP_WEBHOOK_SOURCE_CIDRS: "webpay:203.0.113.0/24, webpay:2001:db8::/32",
      RAMP_WEBHOOK_IP_HEADER: "X-Forwarded-For",
      RAMP_TRUSTED_EDGE_CIDRS: "10.0.0.0/8 192.0.2.7",
    });
    expect(c.sealing.derived).toEqual({ data: false, index: false });
    expect(c.sealing.data.activeKid).toBe("k2");
    expect([...c.sealing.data.keys.keys()]).toEqual(["k1", "k2"]);
    expect(c.sealing.index.activeKid).toBe("i1");
    expect(c.rampProviderMode).toBe("sandbox");
    expect(c.rampWebhooks).toEqual({
      ipAuthProviders: ["webpay"],
      sourceCidrs: new Map([["webpay", ["203.0.113.0/24", "2001:db8::/32"]]]),
      ipHeader: "x-forwarded-for",
      trustedEdgeCidrs: ["10.0.0.0/8", "192.0.2.7"],
    });
  });

  it("isProdLike = APP_ENV=prod OR APP_NETWORK=mainnet OR RAMP_PROVIDER_MODE=live", () => {
    const of = (appEnv: string, appNetwork: string, rampProviderMode: string): boolean =>
      Object.assign(new Config(), { appEnv, appNetwork, rampProviderMode }).isProdLike;
    expect(of("dev", "devnet", "sandbox")).toBe(false);
    expect(of("staging", "devnet", "sandbox")).toBe(false);
    expect(of("prod", "devnet", "sandbox")).toBe(true);
    expect(of("dev", "mainnet", "sandbox")).toBe(true);
    expect(of("dev", "devnet", "live")).toBe(true);
    expect(cfg().isProdLike).toBe(false);
    expect(cfg({ APP_ENV: "prod", KYC_PROVIDER: "sumsub" }).isProdLike).toBe(true);
  });

  it.each([
    [
      "prod without DATA_KEYS",
      { APP_ENV: "prod", KYC_PROVIDER: "sumsub", DATA_KEYS: "", DATA_KEY_ID: "" },
      /^DATA_KEYS and DATA_KEY_ID are required when prod-like/,
    ],
    [
      "mainnet without DATA_INDEX_KEYS",
      { ...MAINNET_BASE, DATA_INDEX_KEYS: "", DATA_INDEX_KEY_ID: "" },
      /^DATA_INDEX_KEYS and DATA_INDEX_KEY_ID are required when prod-like/,
    ],
    [
      "RAMP_PROVIDER_MODE=live without keyrings",
      { RAMP_PROVIDER_MODE: "live", ...NO_KEYRINGS },
      /^DATA_KEYS and DATA_KEY_ID are required when prod-like/,
    ],
    [
      "the mock in live mode",
      { RAMP_PROVIDER_MODE: "live" },
      /^RAMP_PROVIDER_MODE=live is refused with RAMP_PROVIDER=mock/,
    ],
    [
      "an unknown provider mode",
      { RAMP_PROVIDER_MODE: "staging" },
      /^RAMP_PROVIDER_MODE must be one of sandbox, live/,
    ],
    [
      "a short data key",
      { DATA_KEYS: `k1:${Buffer.alloc(16).toString("base64")}` },
      /^DATA_KEYS key k1 must be base64 of exactly 32 bytes/,
    ],
    [
      "an active kid outside the keyring",
      { DATA_KEY_ID: "k9" },
      /^DATA_KEY_ID must name one of the kids in DATA_KEYS/,
    ],
    [
      "an index kid without index keys",
      { DATA_INDEX_KEYS: "" },
      /^DATA_INDEX_KEY_ID is set without DATA_INDEX_KEYS/,
    ],
    [
      "one key for sealing and indexing",
      { DATA_INDEX_KEYS: `i1:${Buffer.alloc(32, 0x11).toString("base64")}` },
      /^DATA_INDEX_KEYS must not reuse a DATA_KEYS key/,
    ],
    [
      "an IP-authenticated provider without CIDRs",
      { RAMP_IP_AUTH_PROVIDERS: "webpay" },
      /^RAMP_IP_AUTH_PROVIDERS lists webpay.*needs webpay:<cidr>/,
    ],
    [
      "a malformed source CIDR",
      { RAMP_WEBHOOK_SOURCE_CIDRS: "webpay:203.0.113.0/33" },
      /^RAMP_WEBHOOK_SOURCE_CIDRS has a malformed CIDR for webpay/,
    ],
    [
      "a source CIDR without its provider",
      { RAMP_WEBHOOK_SOURCE_CIDRS: "203.0.113.9" },
      /^RAMP_WEBHOOK_SOURCE_CIDRS entries must be <provider>:<cidr>/,
    ],
    [
      "a malformed trusted edge",
      { RAMP_TRUSTED_EDGE_CIDRS: "edge.example" },
      /^RAMP_TRUSTED_EDGE_CIDRS has a malformed CIDR/,
    ],
    [
      "a trusted edge of every peer",
      { RAMP_TRUSTED_EDGE_CIDRS: "0.0.0.0/0" },
      /^RAMP_TRUSTED_EDGE_CIDRS must not trust every peer/,
    ],
    [
      "an IP header nobody may set",
      { RAMP_WEBHOOK_IP_HEADER: "x-forwarded-for" },
      /^RAMP_WEBHOOK_IP_HEADER is honoured only from RAMP_TRUSTED_EDGE_CIDRS or with BACKEND_PROXY_SECRET/,
    ],
    [
      "a malformed IP header",
      { RAMP_WEBHOOK_IP_HEADER: "x forwarded", RAMP_TRUSTED_EDGE_CIDRS: "10.0.0.0/8" },
      /^RAMP_WEBHOOK_IP_HEADER must be a header name/,
    ],
    [
      "an enabled prod ramp without KYC",
      { ...PROD_RAMP, RAMP_REQUIRE_KYC: "false" },
      /^RAMP_REQUIRE_KYC=true is required when prod-like/,
    ],
    [
      "an enabled prod ramp without 3DS",
      { ...PROD_RAMP, RAMP_REQUIRE_3DS: "false" },
      /^RAMP_REQUIRE_3DS=true is required when prod-like/,
    ],
    [
      "an enabled prod ramp on an http app URL",
      { ...PROD_RAMP, RAMP_PUBLIC_APP_URL: "http://app.test" },
      /^RAMP_PUBLIC_APP_URL must be https when prod-like/,
    ],
    [
      "an enabled prod ramp on an http API URL",
      { ...PROD_RAMP, RAMP_PUBLIC_API_URL: "http://api.test" },
      /^RAMP_PUBLIC_API_URL must be https when prod-like/,
    ],
    [
      "a real acquirer without a notification URL",
      { ...PROD_RAMP, RAMP_PROVIDER: "bepaid" },
      /^RAMP_PUBLIC_API_URL is required with a real RAMP_PROVIDER/,
    ],
  ])("refuses %s", (_name, extra, pattern) => {
    expect(refusals(extra)).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it("accepts a prod-like deployment with both keyrings and an IP-authenticated provider behind a trusted edge", () => {
    expect(
      refusals({
        ...MAINNET_BASE,
        DATA_KEYS: `k1:${key(1)},k2:${key(2)}`,
        DATA_KEY_ID: "k2",
        RAMP_IP_AUTH_PROVIDERS: "webpay",
        RAMP_WEBHOOK_SOURCE_CIDRS: "webpay:203.0.113.0/24,webpay:2001:db8::/32",
        RAMP_WEBHOOK_IP_HEADER: "x-forwarded-for",
        RAMP_TRUSTED_EDGE_CIDRS: "10.0.0.0/8",
      }).filter((l) => S3_LINE.test(l)),
    ).toEqual([]);
    // The proxy secret alone also makes the header honourable; dev boots with derived keyrings.
    expect(
      refusals({ RAMP_WEBHOOK_IP_HEADER: "x-real-ip", BACKEND_PROXY_SECRET: "x".repeat(32) }),
    ).toEqual([]);
    expect(refusals(NO_KEYRINGS)).toEqual([]);
  });
});

describe("config: controls (SPEC §6, §13 S4)", () => {
  const A = "alice::1220" + "1".repeat(64);
  const B = "bob::1220" + "2".repeat(64);
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const PROD = {
    APP_ENV: "prod",
    KYC_PROVIDER: "sumsub",
    ADMIN_OPERATORS: `${A}#alice@ops+approver, ${B}#bob@approver`,
  };

  it("defaults: dual control, signatures, auto-halt and both gates on; 15 / 60 / 60 min; 2 business days", () => {
    const c = cfg().rampControls;
    expect(c).toMatchObject({
      dualControl: true,
      approvalSignatures: true,
      autoHalt: true,
      reserveGate: "enforce",
      payoutGate: "enforce",
      approvalTtlBdays: 2,
      reconEveryMin: 15,
      reconMaxAgeMin: 60,
      reconUnknownMaxMin: 60,
      reserveMaxAgeBdays: 2,
      reserveTolerance: 0n,
      mintDailyCap: null,
      pspSettleDays: 3,
      operatorMoneyMax: null,
      treasurySurplusMax: null,
      bankHolidays: [],
      bankWorkdays: [],
    });
  });

  it("parses <party>[=<key>]#<person>@<role>[+<role>]; dev entries without them are the party with every role", () => {
    const c = cfg({
      ADMIN_OPERATORS: `${A}=${KEY}#alice@ops+approver, ${B}, two::1220${"3".repeat(64)}#alice@aml`,
      ADMIN_OPERATOR_ACCOUNTS:
        "alice:6f1c2a3e-0000-4000-8000-000000000001, alice:6f1c2a3e-0000-4000-8000-000000000002",
      RAMP_MINT_DAILY_CAP: "5000",
      RAMP_BANK_HOLIDAYS: "2026-11-07, 2026-12-25",
      RAMP_BANK_WORKDAYS: "2026-11-14",
    });
    expect(c.adminOperators.get(A)).toBe(KEY);
    expect(c.adminOperatorDetails.get(A)).toEqual({
      party: A,
      pinnedKey: KEY,
      personId: "alice",
      roles: ["ops", "approver"],
      declared: { person: true, roles: true },
    });
    expect(c.adminOperatorDetails.get(B)).toMatchObject({
      personId: B,
      roles: ["ops", "approver", "aml", "export"],
      declared: { person: false, roles: false },
    });
    expect(c.adminOperatorDetails.get(`two::1220${"3".repeat(64)}`)).toMatchObject({
      personId: "alice",
      roles: ["aml"],
    });
    expect(c.rampControls.operatorAccounts.get("alice")).toEqual([
      "6f1c2a3e-0000-4000-8000-000000000001",
      "6f1c2a3e-0000-4000-8000-000000000002",
    ]);
    expect(c.rampControls.mintDailyCap).toBe(50_000_000_000_000n);
    expect(c.rampControls.bankHolidays).toEqual(["2026-11-07", "2026-12-25"]);
    expect(parseOperators(`${A}=${KEY}#alice@ops`).get(A)).toBe(KEY);
    expect(parseOperatorEntries(`${A}#alice`).operators.get(A)).toMatchObject({
      personId: "alice",
      declared: { person: true, roles: false },
    });
  });

  it("a prod-like deployment with two approver persons, signatures and both gates boots", () => {
    expect(() => cfg(PROD)).not.toThrow();
    // No operators at all: no admin console, nothing to approve — not refused.
    expect(() => cfg({ APP_ENV: "prod", KYC_PROVIDER: "sumsub" })).not.toThrow();
  });

  it.each([
    ["an unknown role", { ADMIN_OPERATORS: `${A}#alice@root` }, /unknown role "root"/],
    ["a malformed person id", { ADMIN_OPERATORS: `${A}#al!ice@ops` }, /person id/],
    [
      "a malformed account link",
      { ADMIN_OPERATOR_ACCOUNTS: "alice:not-a-uuid" },
      /ADMIN_OPERATOR_ACCOUNTS entries/,
    ],
    [
      "an account link of an unknown person",
      {
        ADMIN_OPERATORS: `${A}#alice@ops`,
        ADMIN_OPERATOR_ACCOUNTS: "carol:6f1c2a3e-0000-4000-8000-000000000001",
      },
      /names carol, who is not a person/,
    ],
    ["an unknown gate mode", { RAMP_RESERVE_GATE: "maybe" }, /RAMP_RESERVE_GATE must be one of/],
    [
      "a negative tolerance",
      { RAMP_RESERVE_TOLERANCE: "-1" },
      /RAMP_RESERVE_TOLERANCE must be a non-negative/,
    ],
    ["a zero daily cap", { RAMP_MINT_DAILY_CAP: "0" }, /RAMP_MINT_DAILY_CAP must be a positive/],
    [
      "a TTL of zero",
      { RAMP_APPROVAL_TTL_BDAYS: "0" },
      /RAMP_APPROVAL_TTL_BDAYS must be an integer ≥ 1/,
    ],
    [
      "a max age below the cadence",
      { RAMP_RECON_EVERY_MIN: "30", RAMP_RECON_MAX_AGE_MIN: "20" },
      /RAMP_RECON_MAX_AGE_MIN must be ≥/,
    ],
    [
      "a malformed holiday",
      { RAMP_BANK_HOLIDAYS: "2026-13-01" },
      /RAMP_BANK_HOLIDAYS entries must be YYYY-MM-DD/,
    ],
    ["a working weekday", { RAMP_BANK_WORKDAYS: "2026-11-13" }, /not a Saturday or Sunday/],
    [
      "a day both holiday and workday",
      { RAMP_BANK_HOLIDAYS: "2026-11-14", RAMP_BANK_WORKDAYS: "2026-11-14" },
      /in both/,
    ],
    [
      "undeclared roles prod-like",
      { ...PROD, ADMIN_OPERATORS: `${A}#alice, ${B}#bob@approver` },
      /must declare #<personId>@<role>/,
    ],
    [
      "dual control off prod-like",
      { ...PROD, RAMP_DUAL_CONTROL: "false" },
      /RAMP_DUAL_CONTROL=false is refused/,
    ],
    [
      "one person behind two approver parties prod-like",
      { ...PROD, ADMIN_OPERATORS: `${A}#alice@ops+approver, ${B}#alice@approver` },
      /at least 2 distinct persons with the approver role/,
    ],
    [
      "unsigned decisions prod-like",
      { ...PROD, RAMP_APPROVAL_SIGNATURES: "false" },
      /RAMP_APPROVAL_SIGNATURES=false is refused/,
    ],
    [
      "auto-halt off prod-like",
      { ...PROD, RAMP_AUTO_HALT: "false" },
      /RAMP_AUTO_HALT=false is refused/,
    ],
    [
      "a warning-only reserve gate prod-like",
      { ...PROD, RAMP_RESERVE_GATE: "warn" },
      /RAMP_RESERVE_GATE must be enforce/,
    ],
    [
      "the payout gate off prod-like",
      { ...PROD, RAMP_PAYOUT_GATE: "off" },
      /RAMP_PAYOUT_GATE must be enforce/,
    ],
    [
      "a reserve tolerance prod-like",
      { ...PROD, RAMP_RESERVE_TOLERANCE: "0.01" },
      /RAMP_RESERVE_TOLERANCE > 0/,
    ],
    [
      "the ramp on prod-like without a mint daily cap",
      {
        ...PROD,
        RAMP_ENABLED: "true",
        RAMP_PUBLIC_APP_URL: "https://app.test",
        TOKEN_APP_MAX_PER_CALL: "100",
        TOKEN_APP_MAX_PER_DAY: "1000",
      },
      /requires RAMP_MINT_DAILY_CAP/,
    ],
  ])("refuses %s", (_name, extra, pattern) => {
    expect(() => cfg(extra)).toThrow(pattern);
  });
});

describe("config: methods, rails, exposure, operator of record (SPEC §9, §13 S5)", () => {
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
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "https://app.test",
    RAMP_PROVIDER_MODE: "live",
  };
  const OPERATOR = {
    RAMP_OPERATOR_NAME: "TruthOracle LLC",
    RAMP_OPERATOR_UNP: "193456789",
    RAMP_OPERATOR_HTP_REF: "HTP-2026-0042",
    RAMP_TERMS_VERSION: "2026-10-01",
    RAMP_TERMS_URL: "https://truthoracle.example/terms/ramp",
  };

  it("defaults: card only, card rail, card 30 min / ERIP 1 day, PSP 240 / 120 bps, 180-day refunds, 120-day exposure", () => {
    const r = cfg().ramp;
    expect(r).toMatchObject({
      methods: ["card"],
      payoutRails: ["card"],
      cardRefundMaxDays: 180,
      cardExposureDays: 120,
      cardPayoutCountries: ["BY"],
      deeplinkSchemes: [],
      mockEripServiceCode: "100001",
      operator: { name: "", unp: "", htpRef: "" },
      termsVersion: "",
      termsUrl: "",
    });
    expect(r.method).toEqual({
      card: { ttlMin: 30, feeBps: 0, feeFixed: 0n, pspFeeBps: 240, pollMs: 60_000 },
      erip: { ttlMin: 1440, feeBps: 0, feeFixed: 0n, pspFeeBps: 120, pollMs: 300_000 },
    });
    expect(r.rail).toEqual({
      card: { feeBps: 0, feeFixed: 0n },
      bank: { feeBps: 0, feeFixed: 0n },
    });
  });

  it("parses methods, rails, per-method and per-rail fees, countries and schemes", () => {
    const r = cfg({
      RAMP_METHODS: "card, ERIP",
      RAMP_PAYOUT_RAILS: "bank,card",
      RAMP_ERIP_TTL_MIN: "720",
      RAMP_ERIP_FEE_BPS: "50",
      RAMP_ERIP_FEE_FIXED: "0.5",
      RAMP_ERIP_PSP_FEE_BPS: "100",
      RAMP_PAYOUT_BANK_FEE_FIXED: "1",
      RAMP_CARD_PAYOUT_COUNTRIES: "by,lt",
      RAMP_DEEPLINK_SCHEMES: "Belarusbank, mtbank",
    }).ramp;
    expect(r.methods).toEqual(["card", "erip"]);
    expect(r.payoutRails).toEqual(["bank", "card"]);
    expect(r.method.erip).toMatchObject({
      ttlMin: 720,
      feeBps: 50,
      feeFixed: 5_000_000_000n,
      pspFeeBps: 100,
    });
    expect(r.rail.bank.feeFixed).toBe(10_000_000_000n);
    expect(r.cardPayoutCountries).toEqual(["BY", "LT"]);
    expect(r.deeplinkSchemes).toEqual(["belarusbank", "mtbank"]);
  });

  it.each([
    ["an unknown method", { RAMP_METHODS: "card,krok" }, /RAMP_METHODS has an unknown entry: krok/],
    [
      "an unknown rail",
      { RAMP_PAYOUT_RAILS: "wire" },
      /RAMP_PAYOUT_RAILS has an unknown entry: wire/,
    ],
    ["a method twice", { RAMP_METHODS: "card,card" }, /RAMP_METHODS lists an entry twice/],
    [
      "a TTL under 5 min",
      { RAMP_CARD_TTL_MIN: "2" },
      /RAMP_CARD_TTL_MIN must be an integer in 5\.\.10080/,
    ],
    [
      "a method fee over 50 %",
      { RAMP_CARD_FEE_BPS: "6000" },
      /RAMP_CARD_FEE_BPS must be an integer in 0\.\.5000/,
    ],
    ["a malformed method fixed fee", { RAMP_ERIP_FEE_FIXED: "free" }, /RAMP_ERIP_FEE_FIXED/],
    ["a PSP fee over 100 %", { RAMP_ERIP_PSP_FEE_BPS: "10001" }, /RAMP_ERIP_PSP_FEE_BPS/],
    ["a rail fee over 50 %", { RAMP_PAYOUT_BANK_FEE_BPS: "5001" }, /RAMP_PAYOUT_BANK_FEE_BPS/],
    ["a zero refund window", { RAMP_CARD_REFUND_MAX_DAYS: "0" }, /RAMP_CARD_REFUND_MAX_DAYS/],
    ["a negative exposure window", { RAMP_CARD_EXPOSURE_DAYS: "-1" }, /RAMP_CARD_EXPOSURE_DAYS/],
    [
      "a malformed payout country",
      { RAMP_CARD_PAYOUT_COUNTRIES: "BLR" },
      /RAMP_CARD_PAYOUT_COUNTRIES/,
    ],
    [
      "a javascript deeplink scheme",
      { RAMP_DEEPLINK_SCHEMES: "javascript" },
      /RAMP_DEEPLINK_SCHEMES/,
    ],
    ["an https deeplink scheme", { RAMP_DEEPLINK_SCHEMES: "https" }, /RAMP_DEEPLINK_SCHEMES/],
    [
      "a non-digit ERIP service code",
      { RAMP_MOCK_ERIP_SERVICE_CODE: "12a" },
      /RAMP_MOCK_ERIP_SERVICE_CODE/,
    ],
  ])("refuses %s", (_name, extra, pattern) => {
    expect(() => cfg(extra)).toThrow(pattern);
  });

  it("prod-like with the ramp on: ERIP needs the bank rail, the exposure is on, the operator and terms are set", () => {
    const blank = issues(PROD_RAMP);
    expect(blank).toMatch(/RAMP_OPERATOR_NAME is required/);
    expect(blank).toMatch(/RAMP_OPERATOR_UNP must be the 9-digit UNP/);
    expect(blank).toMatch(/RAMP_OPERATOR_HTP_REF is required/);
    expect(blank).toMatch(/RAMP_TERMS_VERSION is required/);
    expect(blank).toMatch(/RAMP_TERMS_URL must be an https URL/);
    expect(issues({ ...PROD_RAMP, ...OPERATOR, RAMP_METHODS: "card,erip" })).toMatch(
      /RAMP_METHODS with erip requires RAMP_PAYOUT_RAILS to include bank/,
    );
    expect(issues({ ...PROD_RAMP, ...OPERATOR, RAMP_CARD_EXPOSURE_DAYS: "0" })).toMatch(
      /RAMP_CARD_EXPOSURE_DAYS=0 \(no card exposure\) is refused/,
    );
    expect(
      issues({ ...PROD_RAMP, ...OPERATOR, RAMP_TERMS_URL: "http://plain.example/terms" }),
    ).toMatch(/RAMP_TERMS_URL must be an https URL/);
    // A complete S5 block raises none of these (other stages' prod-like refusals may still apply;
    // S6's name RAMP_OPERATOR_* too, so its client-money block is complete here).
    const complete = issues({
      ...PROD_RAMP,
      ...OPERATOR,
      RAMP_METHODS: "card,erip",
      RAMP_PAYOUT_RAILS: "card,bank",
      RAMP_BANK_ACCOUNT_IBAN: "BY57ALFA30140000000000000001",
      RAMP_BANK_BIC: "ALFABY2X",
      RAMP_BANK_NAME: "Alfa-Bank",
      RAMP_BANK_HOLDER_NAME: "TruthOracle LLC",
      RAMP_BANK_HOLDER_UNP: "193456789",
      RAMP_BANK_MANUAL_PROOF: "true",
    });
    expect(complete).not.toMatch(
      /RAMP_OPERATOR|RAMP_TERMS|RAMP_METHODS|RAMP_PAYOUT_RAILS|RAMP_CARD_EXPOSURE/,
    );
    // Off-prod the blanks boot (dev shows no operator).
    expect(issues({ RAMP_ENABLED: "true", RAMP_PUBLIC_APP_URL: "http://localhost:5173" })).toBe("");
  });
});

describe("config: screening and freezes (SPEC §11.6, §13 S7b)", () => {
  it("defaults: a full re-screen every 30 days; a freezing list stale after 30 days", () => {
    expect(cfg().screening).toEqual({ rescreenDays: 30, listMaxAgeDays: 30 });
    expect(
      cfg({ RAMP_RESCREEN_DAYS: "90", RAMP_SCREENING_LIST_MAX_AGE_DAYS: "7" }).screening,
    ).toEqual({ rescreenDays: 90, listMaxAgeDays: 7 });
  });

  it("refuses a re-screen interval beyond 3 months (ПВК p.57), zero or garbage, and a bad list age", () => {
    for (const v of ["0", "91", "abc", "-5"])
      expect(() => cfg({ RAMP_RESCREEN_DAYS: v })).toThrow(
        /RAMP_RESCREEN_DAYS must be an integer from 1 to 90/,
      );
    for (const v of ["0", "366", "x"])
      expect(() => cfg({ RAMP_SCREENING_LIST_MAX_AGE_DAYS: v })).toThrow(
        /RAMP_SCREENING_LIST_MAX_AGE_DAYS must be an integer from 1 to 365/,
      );
  });
});

describe("config: bank rail (SPEC §10, §13 S6)", () => {
  const CLIENT = "BY57ALFA30140000000000000001";
  const PSP = "BY11MTBK30140000000000000003";
  const BANK = {
    RAMP_BANK_ACCOUNT_IBAN: CLIENT,
    RAMP_BANK_BIC: "ALFABY2X",
    RAMP_BANK_NAME: "Alfa-Bank",
    RAMP_BANK_HOLDER_NAME: "TruthOracle LLC",
    RAMP_BANK_HOLDER_UNP: "193456789",
    RAMP_PSP_SETTLEMENT_IBANS: PSP,
  };
  const PROD = {
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "https://app.test",
    RAMP_PROVIDER_MODE: "live",
    RAMP_OPERATOR_UNP: "193456789",
  };
  function issues(extra: Record<string, string>): string {
    try {
      cfg(extra);
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  }

  it("defaults: 24 h cooling-off, 2 accounts, 500 BYN first payouts, 3 settle days, КНП 40109, no fee auto-booking", () => {
    expect(cfg().rampBank).toEqual({
      accountIban: "",
      bic: "",
      bankName: "",
      holderName: "",
      holderUnp: "",
      pspSettlementIbans: [],
      payoutPurposeCode: "40109",
      payoutPurposeText: "Выплата по заказу {ref}",
      refundPurposeText: "Возврат средств по заказу {ref}",
      accountCooloffHours: 24,
      maxAccounts: 2,
      firstPayoutMax: 5_000_000_000_000n,
      nameChecked: false,
      manualProof: false,
      batchMax: 500,
      settleDays: 3,
      unmatchedDays: 3,
      returnFeeMax: 0n,
      feeMax: null,
      blockedBankCodes: [],
    });
    // IBANs are normalised (spaces, lower case) like user input
    expect(
      cfg({ RAMP_BANK_ACCOUNT_IBAN: "by57 alfa 3014 0000 0000 0000 0001" }).rampBank.accountIban,
    ).toBe(CLIENT);
  });

  it.each([
    [
      "a client IBAN failing mod-97",
      { RAMP_BANK_ACCOUNT_IBAN: "BY58ALFA30140000000000000001" },
      /RAMP_BANK_ACCOUNT_IBAN is not a valid Belarusian IBAN \(checksum\)/,
    ],
    [
      "a non-BY PSP settlement account",
      { RAMP_PSP_SETTLEMENT_IBANS: "DE89370400440532013000" },
      /RAMP_PSP_SETTLEMENT_IBANS entry is not a valid/,
    ],
    [
      "a BIC of another bank",
      { ...BANK, RAMP_BANK_BIC: "PJCBBY2X" },
      /not the bank of RAMP_BANK_ACCOUNT_IBAN/,
    ],
    [
      "the client account among the PSP settlement accounts",
      { ...BANK, RAMP_PSP_SETTLEMENT_IBANS: CLIENT },
      /must not be one of RAMP_PSP_SETTLEMENT_IBANS/,
    ],
    [
      "an 8-digit UNP",
      { RAMP_BANK_HOLDER_UNP: "12345678" },
      /RAMP_BANK_HOLDER_UNP must be 9 digits/,
    ],
    ["a 4-digit КНП", { RAMP_BANK_PAYOUT_PURPOSE_CODE: "4010" }, /RAMP_BANK_PAYOUT_PURPOSE_CODE/],
    [
      "a purpose text without {ref}",
      { RAMP_BANK_PAYOUT_PURPOSE_TEXT: "Выплата" },
      /RAMP_BANK_PAYOUT_PURPOSE_TEXT must contain \{ref\}/,
    ],
    [
      "a purpose text with a control character",
      { RAMP_BANK_REFUND_PURPOSE_TEXT: "Возврат\t{ref}" },
      /RAMP_BANK_REFUND_PURPOSE_TEXT/,
    ],
    [
      "a first-payout cap in tenths of a kopeck",
      { RAMP_BANK_FIRST_PAYOUT_MAX: "500.001" },
      /RAMP_BANK_FIRST_PAYOUT_MAX must be a positive amount in whole kopecks/,
    ],
    ["a zero first-payout cap", { RAMP_BANK_FIRST_PAYOUT_MAX: "0" }, /RAMP_BANK_FIRST_PAYOUT_MAX/],
    ["a negative bank fee max", { RAMP_BANK_FEE_MAX: "-1" }, /RAMP_BANK_FEE_MAX/],
    [
      "0 settle days",
      { RAMP_BANK_SETTLE_DAYS: "0" },
      /RAMP_BANK_SETTLE_DAYS must be an integer in 1..30/,
    ],
    ["11 accounts per user", { RAMP_MAX_BANK_ACCOUNTS: "11" }, /RAMP_MAX_BANK_ACCOUNTS/],
    [
      "a malformed blocked bank code",
      { RAMP_BLOCKED_BANK_CODES: "MMBN,TOOLONG" },
      /RAMP_BLOCKED_BANK_CODES entry/,
    ],
  ])("refuses %s", (_name, extra, pattern) => {
    expect(() => cfg(extra)).toThrow(pattern);
  });

  it("prod-like with the ramp on: the client-money account in full, held by the operator of record — and nothing else (one account)", () => {
    const blank = issues(PROD);
    expect(blank).toMatch(/RAMP_BANK_ACCOUNT_IBAN is required/);
    expect(blank).toMatch(/RAMP_BANK_BIC is required/);
    expect(blank).toMatch(/RAMP_BANK_NAME and RAMP_BANK_HOLDER_NAME are required/);
    expect(blank).toMatch(/RAMP_BANK_HOLDER_UNP \(9 digits\) is required/);
    expect(issues({ ...PROD, ...BANK, RAMP_BANK_HOLDER_UNP: "191234567" })).toMatch(
      /RAMP_BANK_HOLDER_UNP must equal RAMP_OPERATOR_UNP/,
    );
    // The client-money account alone is complete: the operator's own money sits in it (no second account).
    const complete = issues({ ...PROD, ...BANK, RAMP_PSP_SETTLEMENT_IBANS: "" });
    expect(complete).not.toMatch(/RAMP_BANK_|operator account/);
    // Off-prod nothing is required (dev runs without a bank).
    expect(
      cfg({ RAMP_ENABLED: "true", RAMP_PUBLIC_APP_URL: "http://localhost:5173" }).rampBank
        .accountIban,
    ).toBe("");
  });

  it("prod-like with the bank rail offered: an IBAN ownership proof the bank or operators provide (X10)", () => {
    const rail = { ...PROD, ...BANK, RAMP_PAYOUT_RAILS: "card,bank" };
    expect(issues(rail)).toMatch(
      /bank rail needs RAMP_BANK_NAME_CHECKED=true .* or RAMP_BANK_MANUAL_PROOF=true/,
    );
    expect(issues({ ...rail, RAMP_BANK_NAME_CHECKED: "true" })).not.toMatch(/RAMP_BANK_/);
    expect(issues({ ...rail, RAMP_BANK_MANUAL_PROOF: "true" })).not.toMatch(/RAMP_BANK_/);
    expect(
      issues({ ...rail, RAMP_BANK_MANUAL_PROOF: "true", RAMP_BANK_ACCOUNT_COOLOFF_HOURS: "0" }),
    ).toMatch(/RAMP_BANK_ACCOUNT_COOLOFF_HOURS below 1/);
  });
});
