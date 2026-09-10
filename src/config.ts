import { createHash } from "node:crypto";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MinLength,
  validateSync,
} from "class-validator";

const APP_ENVS = ["dev", "staging", "prod"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const APP_NETWORKS = ["devnet", "mainnet"] as const;
export type AppNetwork = (typeof APP_NETWORKS)[number];

const DB_SSL_MODES = ["auto", "true", "false", "verify"] as const;
export type DbSslMode = (typeof DB_SSL_MODES)[number];

const KYC_PROVIDERS = ["mock", "sumsub"] as const;
export type KycProviderSetting = (typeof KYC_PROVIDERS)[number];

export interface KeycloakConfig {
  url: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

export interface ZkpcConfig {
  ledgerApiUrl: string;
  keycloakUrl: string;
  keycloakRealm: string;
  clientId: string;
  clientSecret: string;
}

export interface SumsubConfig {
  baseUrl: string;
  appToken: string;
  secretKey: string;
  webhookSecret: string;
  duplicateLabels: string[];
  allowSha1: boolean;
}

const MIN_SECRET_LENGTH = 32;

/**
 * Validated process configuration (docs/ARCHITECTURE.md §12, docs/INTERNALS.md "Config").
 * Built once in `getConfiguration()` from `process.env` and provided globally by
 * `AppModule.register(config)`; the process refuses to boot on invalid or unsafe values.
 * Keys are camelCase; every list / map / boolean / "auto" value is resolved here so the rest
 * of the code never reads `process.env`.
 */
export class Config {
  @IsIn(APP_ENVS as readonly string[])
  readonly appEnv!: AppEnv;

  @IsIn(APP_NETWORKS as readonly string[])
  readonly appNetwork!: AppNetwork;

  @IsInt()
  @Min(1)
  readonly port!: number;

  /** JSON structured logs. `LOG_JSON=auto` → true outside dev. */
  @IsBoolean()
  readonly logJson!: boolean;

  // ── datastores ──────────────────────────────────────────────────────────────
  @IsString()
  @IsNotEmpty({ message: "DATABASE_URL is required" })
  readonly databaseUrl!: string;

  @IsBoolean()
  readonly dbMigrateOnBoot!: boolean;

  @IsIn(DB_SSL_MODES as readonly string[])
  readonly dbSsl!: DbSslMode;

  /** PEM (inline or file path) the server certificate must chain to under `DB_SSL=verify`; resolved by data-source.ts. */
  @IsString()
  readonly dbSslCa!: string;

  /** Prod / mainnet refuse unverified TLS to Postgres unless this is set (RUNBOOK §1). */
  @IsBoolean()
  readonly dbSslInsecureAck!: boolean;

  @IsString()
  @IsNotEmpty({ message: "REDIS_URL is required" })
  readonly redisUrl!: string;

  @IsString()
  @IsNotEmpty({ message: "NATS_URL is required" })
  readonly natsUrl!: string;

  // ── sessions & cookies ──────────────────────────────────────────────────────
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, { message: "SESSION_SECRET must be at least 32 characters" })
  readonly sessionSecret!: string;

  @IsInt()
  @Min(1)
  readonly sessionTtlHours!: number;

  @IsInt()
  @Min(1)
  readonly adminSessionTtlHours!: number;

  /** `COOKIE_SECURE=auto` → true outside dev. */
  @IsBoolean()
  readonly cookieSecure!: boolean;

  /** Empty = host-only cookie (required while the Vercel proxy is in front — §4.1). */
  @IsString()
  readonly cookieDomain!: string;

  /** Exact origins or `https://*.vercel.app` patterns accepted by the CSRF guard (§6.7). */
  @IsArray()
  readonly frontendOrigins!: string[];

  /** Shared with api/proxy/backend.mjs; empty disables proxy-header trust entirely. */
  @IsString()
  readonly backendProxySecret!: string;

  /** Native / direct clients only; browser traffic is same-origin through the proxy. */
  @IsArray()
  readonly corsOrigins!: string[];

  // ── sign-in providers ───────────────────────────────────────────────────────
  @IsArray()
  readonly googleClientIds!: string[];

  /** `GOOGLE_NONCE_REQUIRED=auto` → true outside dev. */
  @IsBoolean()
  readonly googleNonceRequired!: boolean;

  @IsString()
  readonly telegramBotToken!: string;

  @IsString()
  readonly telegramBotUsername!: string;

  @IsInt()
  @Min(1)
  readonly telegramAuthMaxAgeSec!: number;

  @IsInt()
  @Min(1)
  readonly telegramInitDataMaxAgeSec!: number;

  @IsString()
  readonly telegramOidcClientId!: string;

  @IsString()
  readonly telegramOidcClientSecret!: string;

  @IsString()
  readonly telegramOidcIssuer!: string;

  /** partyId → pinned public key ("" when the entry has no key). */
  readonly adminOperators!: Map<string, string>;

  // ── Canton / ledger / wallet ────────────────────────────────────────────────
  @IsString()
  readonly ledgerApiUrl!: string;

  @IsString()
  readonly enterpriseWalletUrl!: string;

  @IsString()
  readonly treasuryPartyId!: string;

  @IsString()
  readonly enterpriseWalletAppName!: string;

  @IsString()
  readonly truthoraclePackageId!: string;

  @IsString()
  readonly truthoraclePackageName!: string;

  @IsBoolean()
  readonly damlUserWalletHasDepositRefs!: boolean;

  readonly keycloak!: KeycloakConfig;
  /** Per-target overrides; empty fields fall back to `keycloak`. */
  readonly ledgerKeycloak!: Partial<KeycloakConfig>;
  readonly walletKeycloak!: Partial<KeycloakConfig>;
  /** Mainnet ledger — the only ledger credentials read when appNetwork = mainnet. */
  readonly zkpc!: ZkpcConfig;

  // ── KYC ─────────────────────────────────────────────────────────────────────
  @IsIn(KYC_PROVIDERS as readonly string[])
  readonly kycProvider!: KycProviderSetting;

  @IsBoolean()
  readonly kycEnforceWithdrawals!: boolean;

  @IsString()
  @IsNotEmpty()
  readonly kycRequiredLevel!: string;

  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: "KYC_FINGERPRINT_PEPPER must be at least 32 characters",
  })
  readonly kycFingerprintPepper!: string;

  @IsString()
  readonly kycPepperRotationAck!: string;

  @IsBoolean()
  readonly legacyWalletEndpointsRetired!: boolean;

  @IsArray()
  readonly payoutExternalReasons!: string[];

  @IsArray()
  readonly payoutInappReasons!: string[];

  @IsInt()
  @Min(1)
  readonly payoutMaxAttempts!: number;

  @IsInt()
  @Min(1000)
  readonly payoutScanMs!: number;

  /**
   * How old a `to_payouts` row must be before an operator's `force` may re-send a transfer the
   * wallet reports as never submitted (`PAYOUT_RESEND_GRACE_MS`): a lagging transfer index must
   * have had time to catch up, otherwise the resend is the double-pay case.
   */
  @IsInt()
  @Min(0)
  readonly payoutResendGraceMs!: number;

  readonly sumsub!: SumsubConfig;

  // ── loops / caches / observability ─────────────────────────────────────────
  @IsInt()
  @Min(1000)
  readonly sessionCleanupMs!: number;

  @IsInt()
  @Min(0)
  readonly ledgerCacheMs!: number;

  /** Must cover the worst-case history walk; correctness never depends on it (§8.3). */
  @IsInt()
  @Min(60_000)
  readonly depositLockTtlMs!: number;

  /**
   * A `submitted` credit younger than this is never failed by the confirm pass, whatever the
   * wallet says (`DEPOSIT_CONFIRM_GRACE_MS`): the ACS lags the accepted command, and a wrong
   * `failed` would let the same command id be re-armed and re-submitted.
   */
  @IsInt()
  @Min(0)
  readonly depositConfirmGraceMs!: number;

  @IsString()
  @IsOptional()
  readonly sentryDsn!: string;

  /** `SWAGGER_ENABLED=auto` → true outside prod. Served at /api/docs (never via the proxy). */
  @IsBoolean()
  readonly swaggerEnabled!: boolean;

  // ── derived helpers ─────────────────────────────────────────────────────────
  get isMainnet(): boolean {
    return this.appNetwork === "mainnet";
  }

  get sessionTtlMs(): number {
    return this.sessionTtlHours * 60 * 60 * 1000;
  }

  get adminSessionTtlMs(): number {
    return this.adminSessionTtlHours * 60 * 60 * 1000;
  }

  /** sha256 hex of the pepper — compared with `to_settings.kyc_pepper_hash` at boot (§9.6). */
  get kycPepperHash(): string {
    return createHash("sha256").update(this.kycFingerprintPepper, "utf8").digest("hex");
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------------------------

function str(raw: string | undefined, fallback = ""): string {
  return raw === undefined ? fallback : raw.trim();
}

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** `auto` (or blank) → `autoValue`; anything else is parsed as a boolean. */
function parseAutoBool(raw: string | undefined, autoValue: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "auto") return autoValue;
  return parseBool(v, autoValue);
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `ADMIN_OPERATORS="party[=publicKey], party2=..."` → Map(party → pinned key or "").
 * Split on the FIRST "=": a party id is <hint>::<hex fingerprint> and never contains "=",
 * whereas a base64 key may carry "=" padding at its end (port of adminSession.mjs).
 */
export function parseOperators(raw: string | undefined): Map<string, string> {
  const operators = new Map<string, string>();
  for (const entry of parseList(raw)) {
    const split = entry.indexOf("=");
    if (split < 0) {
      operators.set(entry, "");
      continue;
    }
    const partyId = entry.slice(0, split).trim();
    const publicKey = entry.slice(split + 1).trim();
    if (partyId) operators.set(partyId, publicKey);
  }
  return operators;
}

function absoluteUrl(raw: string | undefined): string {
  const trimmed = str(raw).replace(/\/$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
}

function keycloakFrom(env: NodeJS.ProcessEnv, prefix: string): Partial<KeycloakConfig> {
  const out: Partial<KeycloakConfig> = {};
  const url = absoluteUrl(env[`${prefix}_URL`]);
  const realm = str(env[`${prefix}_REALM`]);
  const clientId = str(env[`${prefix}_CLIENT_ID`]);
  const clientSecret = str(env[`${prefix}_CLIENT_SECRET`]);
  if (url) out.url = url;
  if (realm) out.realm = realm;
  if (clientId) out.clientId = clientId;
  if (clientSecret) out.clientSecret = clientSecret;
  return out;
}

// ---------------------------------------------------------------------------------------------
// getConfiguration
// ---------------------------------------------------------------------------------------------

export function getConfiguration(env: NodeJS.ProcessEnv = process.env): Config {
  const appEnv = str(env.APP_ENV, "dev") as AppEnv;
  const appNetwork = str(env.APP_NETWORK, "devnet").toLowerCase() as AppNetwork;
  const isDev = appEnv === "dev";
  const isProd = appEnv === "prod";

  const raw = {
    appEnv,
    appNetwork,
    port: parseIntOr(env.PORT, 8091),
    logJson: parseAutoBool(env.LOG_JSON, !isDev),

    databaseUrl: str(env.DATABASE_URL),
    dbMigrateOnBoot: parseBool(env.DB_MIGRATE_ON_BOOT, true),
    dbSsl: str(env.DB_SSL, "auto") as DbSslMode,
    dbSslCa: str(env.DB_SSL_CA),
    dbSslInsecureAck: parseBool(env.DB_SSL_INSECURE_ACK, false),
    redisUrl: str(env.REDIS_URL),
    natsUrl: str(env.NATS_URL),

    sessionSecret: str(env.SESSION_SECRET),
    sessionTtlHours: parseIntOr(env.SESSION_TTL_HOURS, 168),
    adminSessionTtlHours: parseIntOr(env.ADMIN_SESSION_TTL_HOURS, 1),
    cookieSecure: parseAutoBool(env.COOKIE_SECURE, !isDev),
    cookieDomain: str(env.COOKIE_DOMAIN),
    frontendOrigins: parseList(env.FRONTEND_ORIGINS).map((o) => o.replace(/\/$/, "")),
    backendProxySecret: str(env.BACKEND_PROXY_SECRET),
    corsOrigins: parseList(env.CORS_ORIGINS).map((o) => o.replace(/\/$/, "")),

    googleClientIds: parseList(env.GOOGLE_CLIENT_IDS ?? env.GOOGLE_CLIENT_ID),
    googleNonceRequired: parseAutoBool(env.GOOGLE_NONCE_REQUIRED, !isDev),
    telegramBotToken: str(env.TELEGRAM_BOT_TOKEN),
    telegramBotUsername: str(env.TELEGRAM_BOT_USERNAME).replace(/^@/, ""),
    telegramAuthMaxAgeSec: parseIntOr(env.TELEGRAM_AUTH_MAX_AGE_SEC, 300),
    telegramInitDataMaxAgeSec: parseIntOr(env.TELEGRAM_INITDATA_MAX_AGE_SEC, 3600),
    telegramOidcClientId: str(env.TELEGRAM_OIDC_CLIENT_ID),
    telegramOidcClientSecret: str(env.TELEGRAM_OIDC_CLIENT_SECRET),
    telegramOidcIssuer: absoluteUrl(env.TELEGRAM_OIDC_ISSUER) || "https://oauth.telegram.org",
    adminOperators: parseOperators(env.ADMIN_OPERATORS),

    ledgerApiUrl: absoluteUrl(env.LEDGER_API_URL),
    enterpriseWalletUrl: absoluteUrl(env.ENTERPRISE_WALLET_URL),
    treasuryPartyId: str(env.TREASURY_PARTY_ID),
    enterpriseWalletAppName: str(env.ENTERPRISE_WALLET_APP_NAME, "truthoracle") || "truthoracle",
    truthoraclePackageId: str(env.TRUTHORACLE_PACKAGE_ID),
    truthoraclePackageName: str(env.TRUTHORACLE_PACKAGE_NAME),
    damlUserWalletHasDepositRefs: parseBool(env.DAML_USER_WALLET_HAS_DEPOSIT_REFS, false),
    keycloak: {
      url: absoluteUrl(env.KEYCLOAK_URL),
      realm: str(env.KEYCLOAK_REALM, "master") || "master",
      clientId: str(env.KEYCLOAK_CLIENT_ID),
      clientSecret: str(env.KEYCLOAK_CLIENT_SECRET),
    },
    ledgerKeycloak: keycloakFrom(env, "LEDGER_KEYCLOAK"),
    walletKeycloak: keycloakFrom(env, "WALLET_KEYCLOAK"),
    zkpc: {
      ledgerApiUrl: absoluteUrl(env.ZKPC_LEDGER_API_URL),
      keycloakUrl: absoluteUrl(env.ZKPC_KEYCLOAK_URL),
      keycloakRealm: str(env.ZKPC_KEYCLOAK_REALM, "master") || "master",
      clientId: str(env.ZKPC_KEYCLOAK_CLIENT_ID ?? env.ZKPC_CLIENT_ID),
      clientSecret: str(env.ZKPC_KEYCLOAK_CLIENT_SECRET ?? env.ZKPC_CLIENT_SECRET),
    },

    kycProvider: str(env.KYC_PROVIDER, "mock").toLowerCase() as KycProviderSetting,
    kycEnforceWithdrawals: parseBool(env.KYC_ENFORCE_WITHDRAWALS, false),
    kycRequiredLevel: str(env.KYC_REQUIRED_LEVEL, "basic-kyc-level") || "basic-kyc-level",
    kycFingerprintPepper: str(env.KYC_FINGERPRINT_PEPPER),
    kycPepperRotationAck: str(env.KYC_PEPPER_ROTATION_ACK).toLowerCase(),
    legacyWalletEndpointsRetired: parseBool(env.LEGACY_WALLET_ENDPOINTS_RETIRED, false),
    payoutExternalReasons: parseList(env.PAYOUT_EXTERNAL_REASONS ?? "withdraw"),
    payoutInappReasons: parseList(env.PAYOUT_INAPP_REASONS ?? "bond,model-prize"),
    payoutMaxAttempts: parseIntOr(env.PAYOUT_MAX_ATTEMPTS, 5),
    payoutScanMs: parseIntOr(env.PAYOUT_SCAN_MS, 30_000),
    payoutResendGraceMs: parseIntOr(env.PAYOUT_RESEND_GRACE_MS, 10 * 60_000),
    sumsub: {
      baseUrl: absoluteUrl(env.SUMSUB_BASE_URL) || "https://api.sumsub.com",
      appToken: str(env.SUMSUB_APP_TOKEN),
      secretKey: str(env.SUMSUB_SECRET_KEY),
      webhookSecret: str(env.SUMSUB_WEBHOOK_SECRET),
      duplicateLabels: parseList(env.SUMSUB_DUPLICATE_LABELS ?? "DUPLICATE").map((l) =>
        l.toUpperCase(),
      ),
      allowSha1: parseBool(env.SUMSUB_ALLOW_SHA1, false),
    },

    sessionCleanupMs: parseIntOr(env.SESSION_CLEANUP_MS, 3_600_000),
    ledgerCacheMs: parseIntOr(env.LEDGER_CACHE_MS, 15_000),
    depositLockTtlMs: parseIntOr(env.DEPOSIT_LOCK_TTL_MS, 300_000),
    depositConfirmGraceMs: parseIntOr(env.DEPOSIT_CONFIRM_GRACE_MS, 10 * 60_000),
    sentryDsn: str(env.SENTRY_DSN),
    swaggerEnabled: parseAutoBool(env.SWAGGER_ENABLED, !isProd),
  };

  // Object.assign (not class-transformer): plainToInstance would rebuild the Map as an empty one.
  const config = Object.assign(new Config(), raw);
  const errors = validateSync(config, { skipMissingProperties: false });
  const issues = errors.map(
    (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(", ")}`,
  );

  // ── boot refusals (ARCHITECTURE §12) — unsafe combinations, not just malformed values ──
  if (config.backendProxySecret && config.backendProxySecret.length < MIN_SECRET_LENGTH) {
    issues.push("BACKEND_PROXY_SECRET must be at least 32 characters when set");
  }
  if (config.kycProvider === "mock" && (isProd || config.isMainnet)) {
    issues.push("KYC_PROVIDER=mock is refused when APP_ENV=prod or APP_NETWORK=mainnet");
  }
  if (config.isMainnet && config.sumsub.appToken.startsWith("sbx:")) {
    issues.push("SUMSUB_APP_TOKEN is a sandbox token (sbx:) but APP_NETWORK=mainnet");
  }
  if (config.kycProvider === "sumsub" && config.sumsub.appToken && !config.sumsub.webhookSecret) {
    issues.push("KYC_PROVIDER=sumsub requires SUMSUB_WEBHOOK_SECRET (sessions would start while every webhook is rejected with 401)");
  }
  if ((isProd || config.isMainnet) && !config.dbSslInsecureAck) {
    const local = /(localhost|127\.0\.0\.1|@postgres[:/])/.test(config.databaseUrl);
    if (config.dbSsl === "true" || (config.dbSsl === "auto" && !local)) {
      issues.push("DB_SSL=true/auto does not verify the Postgres server certificate; set DB_SSL=verify (with DB_SSL_CA when needed) or DB_SSL_INSECURE_ACK=true to accept unverified TLS in prod / on mainnet");
    }
  }
  if (config.kycEnforceWithdrawals && !config.legacyWalletEndpointsRetired) {
    issues.push(
      "KYC_ENFORCE_WITHDRAWALS=true requires LEGACY_WALLET_ENDPOINTS_RETIRED=true (ARCHITECTURE §18: the gate is meaningless while the legacy money endpoints exist)",
    );
  }
  if (config.isMainnet) {
    const z = config.zkpc;
    if (!z.ledgerApiUrl || !z.keycloakUrl || !z.clientId || !z.clientSecret) {
      issues.push(
        "APP_NETWORK=mainnet requires ZKPC_LEDGER_API_URL, ZKPC_KEYCLOAK_URL, ZKPC_KEYCLOAK_CLIENT_ID and ZKPC_KEYCLOAK_CLIENT_SECRET (LEDGER_API_URL / KEYCLOAK_* are ignored for the ledger on mainnet)",
      );
    }
  }
  if (config.cookieDomain && config.backendProxySecret) {
    issues.push(
      "COOKIE_DOMAIN must stay empty while BACKEND_PROXY_SECRET is configured (proxied cookies are host-only, ARCHITECTURE §4.1)",
    );
  }
  if (config.kycPepperRotationAck && !/^[0-9a-f]{64}$/.test(config.kycPepperRotationAck)) {
    issues.push("KYC_PEPPER_ROTATION_ACK must be the sha256 hex of the new pepper");
  }
  for (const [party, key] of config.adminOperators) {
    if (!/^[A-Za-z0-9_.-]{1,255}::1220[0-9a-f]{64}$/.test(party)) {
      issues.push(`ADMIN_OPERATORS entry is not a Canton party id: ${party.slice(0, 24)}…`);
    }
    if (key && !/^[A-Za-z0-9+/=_-]{40,90}$/.test(key)) {
      issues.push(`ADMIN_OPERATORS pinned key for ${party.slice(0, 24)}… is not hex/base64`);
    }
  }
  for (const origin of [...config.frontendOrigins, ...config.corsOrigins]) {
    if (!/^https?:\/\/[A-Za-z0-9*.-]+(:\d+)?$/.test(origin)) {
      issues.push(`origin entry is not an origin (scheme://host[:port]): ${origin}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Invalid configuration:\n  ${issues.join("\n  ")}`);
  }
  return config;
}
