import { createHash } from "node:crypto";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from "class-validator";

import {
  ADMIN_ROLES,
  REGISTRY_AUTHS,
  TREASURY_TRANSFER_MODES,
  parseInstrumentKey,
  RAMP_METHODS,
  RAMP_PAYOUT_RAILS,
  type AdminRole,
  type InstrumentId,
  type RampMethod,
  type RampPayoutRail,
  type RampProviderName,
  type RegistryAuth,
  type TreasuryTransferMode,
} from "./types";
import { AMOUNT_DECIMALS, tryParseAmount } from "./util/money";
// platform security (SPEC §8; stage S3)
import { parseCidr } from "./util/cidr";
import { type Keyring, parseKeyring } from "./util/sealed";
// controls (SPEC §6; stage S4)
import { isIsoDate } from "./util/by-calendar";
// compliance (SPEC §11; stage S7a)
import { minskDate as minskDayOf } from "./util/by-calendar";
import { isAlpha2 } from "./util/iso-country";
// bank rail (SPEC §10; stage S6)
import { normalizeBic, normalizeIban, parseByIban } from "./util/iban";

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

/**
 * One of the two env-configured CIP-56 instruments (docs/TOKENS.md §4.1, §4.7). `admin` and `id`
 * identify it on the ledger; `symbol` / `name` / `decimals` are presentation; `registryUrl` /
 * `registryAuth` reach its off-ledger registry; `walletInstrumentId` is what the Cantor8 wallet
 * SDK's `send()` expects (defaults to `id`). An instrument with a blank `id` is "not configured".
 */
export interface InstrumentConfig {
  admin: string;
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  registryUrl: string;
  registryAuth: RegistryAuth;
  walletInstrumentId: string;
}

/** Cantor8's mint / burn service (docs/TOKENS.md §0, §4.4); blank `url` = every caller answers 503 token_app_unconfigured. */
export interface TokenAppConfig {
  url: string;
  appName: string;
  /** Bearer for token-app. Devnet: empty fields fall back to `keycloak`; mainnet: this client only (keycloak-token.service `resolveKeycloak`). */
  keycloak: Partial<KeycloakConfig>;
}

// ── token side and ZKPC (SPEC §7; stage S1) ──────────────────────────────────────────────────
/**
 * Token-app command ledger and sync (SPEC §7, §13 S1). Caps are 1e-10 units of the instrument
 * being minted or burned; null = no cap (refused prod-like while the ramp is enabled).
 */
export interface TokenCommandsConfig {
  /** `TOKEN_APP_MAX_PER_CALL`: the largest single mint or burn. */
  maxPerCall: bigint | null;
  /** `TOKEN_APP_MAX_PER_DAY`: rolling 24 h Σ mints of one instrument, every source. */
  maxPerDay: bigint | null;
  /** `TOKEN_APP_SYNC_SEC`: sync cadence while any command is unresolved; 0 = loop off (tests). */
  syncSec: number;
  /** `RAMP_RECON_EVERY_MIN` (S4's reconciliation cadence): sync cadence while nothing is unresolved. */
  idleSyncMin: number;
  /** `TOKEN_APP_RESEND_MAX_AGE_HOURS`: an approved re-send only inside the participant's 7-day dedup window. */
  resendMaxAgeHours: number;
  /** `RAMP_TOKEN_CONFIRM_MIN`: an unresolved command past this (since its last POST) is amber. */
  confirmMin: number;
  /** `RAMP_TOKEN_REVIEW_AFTER_MIN`: past this the order goes to review. */
  reviewAfterMin: number;
}

const RAMP_PROVIDERS: readonly RampProviderName[] = ["mock"];

/** One direction's limits (docs/RAMP.md §6, §10): fiat amounts in 1e-10 units. Fees are per method / rail (S5). */
export interface RampDirectionConfig {
  min: bigint;
  max: bigint;
  dailyMax: bigint;
  monthlyMax: bigint;
}

// ── methods, rails, exposure, operator of record (SPEC §9, §13; stage S5) ──

/** A customer fee: basis points of the amount plus a fixed part (fiat, 1e-10 units). */
export interface RampFeeConfig {
  feeBps: number;
  feeFixed: bigint;
}

/** One on-ramp payment method (SPEC §9.2): `RAMP_<M>_TTL_MIN`, `_FEE_BPS`, `_FEE_FIXED`, `_PSP_FEE_BPS`. */
export interface RampMethodConfig extends RampFeeConfig {
  ttlMin: number;
  /** PSP fee accrued per capture when the acquirer reports none (SPEC §5 psp.fee_accrued). */
  pspFeeBps: number;
  /** Poll an open checkout this often without a webhook: card 1 min, ERIP 5 min (fixed). */
  pollMs: number;
}

/** The operator of record (R1): stamped on every order, `GET /ramp.operator`; blanks refused prod-like. */
export interface RampOperatorConfig {
  name: string;
  /** 9-digit Belarusian taxpayer number. */
  unp: string;
  /** The HTP (Hi-Tech Park) residency reference. */
  htpRef: string;
}

/** `RAMP_*` (docs/RAMP.md §10). `enabled = false` refuses new orders; in-flight orders still finish. */
export interface RampConfig {
  enabled: boolean;
  provider: RampProviderName;
  /** `RAMP_INSTRUMENT` parsed; null = the default collateral. */
  instrument: InstrumentId | null;
  fiatCurrency: string;
  fiatDecimals: number;
  publicAppUrl: string;
  publicApiUrl: string;
  requireKyc: boolean;
  require3ds: boolean;
  onramp: RampDirectionConfig;
  offramp: RampDirectionConfig;
  maxCards: number;
  offrampSignTtlMin: number;
  scanMs: number;
  maxAttempts: number;
  stuckAfterMin: number;
  mockWebhookSecret: string;
  // ── S2 (SPEC §13) ──
  /** `RAMP_CHECKOUT_HOSTS`: the only hosts a checkout redirect may point at (E-D7); the mock uses RAMP_PUBLIC_APP_URL's. */
  checkoutHosts: string[];
  /** `RAMP_WITHDRAWING_TIMEOUT_MIN`: a bound withdrawal whose MarkPaid never ran → needs_review(withdrawal) (M8). */
  withdrawingTimeoutMin: number;
  /**
   * `RAMP_WITHDRAWAL_BIND_GRACE_MIN` (F5): an unsigned cash-out past its deadline waits this long
   * for a withdrawal signed in time to bind before it expires (0 = expire at the deadline).
   */
  withdrawalBindGraceMin: number;
  /**
   * `RAMP_CREDIT_BACK_FINAL_AFTER_MIN` (C1): a wallet failure of a credit-back Deposit proves it
   * never lands only once its last submission is older than this — longer than any ledger command
   * lifetime, so a timeout the ledger may still apply never opens a second generation.
   */
  creditBackFinalAfterMin: number;
  /** `RAMP_EVENT_DEAD_AFTER_HOURS`: a webhook failing this long is dead (an operator looks; H6). */
  eventDeadAfterHours: number;
  /** `RAMP_CREATED_STALE_MIN`: a `created` order this old is looked up at the acquirer (H5); > the adapter timeout. */
  createdStaleMin: number;
  /** `RAMP_CLOSED_POLL_HOURS`: closed and completed card on-ramps are re-read this long (late captures, chargebacks; H6). */
  closedPollHours: number;
  // ── S5 (SPEC §9, §13) ──
  /** `RAMP_METHODS` (card): on-ramp methods offered; must be a subset of the provider's. */
  methods: RampMethod[];
  /** Per method: TTL, customer fee, PSP fee accrual, poll cadence. */
  method: Record<RampMethod, RampMethodConfig>;
  /** `RAMP_PAYOUT_RAILS` (card): cash-out rails offered. */
  payoutRails: RampPayoutRail[];
  /** Per rail: `RAMP_PAYOUT_<R>_FEE_BPS|_FIXED`. */
  rail: Record<RampPayoutRail, RampFeeConfig>;
  /** `RAMP_CARD_REFUND_MAX_DAYS` (180): captures older than min(this, the provider's) are not refunded. */
  cardRefundMaxDays: number;
  /** `RAMP_CARD_EXPOSURE_DAYS` (120): card captures this recent limit every non-refund exit (I5). */
  cardExposureDays: number;
  /** `RAMP_CARD_PAYOUT_COUNTRIES` (BY): issuer countries an OCT may go to. */
  cardPayoutCountries: string[];
  /** `RAMP_DEEPLINK_SCHEMES`: bank-app link schemes an ERIP payment may carry (X15). */
  deeplinkSchemes: string[];
  /** `RAMP_MOCK_ERIP_SERVICE_CODE`: the mock acquirer's ERIP service code. */
  mockEripServiceCode: string;
  operator: RampOperatorConfig;
  /** `RAMP_TERMS_VERSION` / `RAMP_TERMS_URL`: the terms every order is made under (consent, S7a). */
  termsVersion: string;
  termsUrl: string;
}

/** The acquirer adapters' HTTP deadline (upstream-http's default); RAMP_CREATED_STALE_MIN must exceed it (H5). */
export const RAMP_PROVIDER_HTTP_TIMEOUT_MS = 30_000;

// ── platform security (SPEC §8; stage S3) ────────────────────────────────────────────────────
export const RAMP_PROVIDER_MODES = ["sandbox", "live"] as const;
export type RampProviderMode = (typeof RAMP_PROVIDER_MODES)[number];

/** `DATA_KEYS` / `DATA_KEY_ID` (sealing) and `DATA_INDEX_KEYS` / `DATA_INDEX_KEY_ID` (blind indexes). */
export interface SealingConfig {
  data: Keyring;
  index: Keyring;
  /** Rings derived from SESSION_SECRET (both env vars blank): dev / test only, prod-like refuses them. */
  derived: { data: boolean; index: boolean };
}

/** Webhook source checks (SPEC §8, X13). */
export interface RampWebhookConfig {
  /** `RAMP_IP_AUTH_PROVIDERS`: providers that authenticate deliveries by source IP (e.g. webpay). */
  ipAuthProviders: string[];
  /** `RAMP_WEBHOOK_SOURCE_CIDRS=<provider>:<cidr>[,…]`; malformed entries are kept so boot can name them. */
  sourceCidrs: Map<string, string[]>;
  /** `RAMP_WEBHOOK_IP_HEADER`, lower-case; "" = none. */
  ipHeader: string;
  /** `RAMP_TRUSTED_EDGE_CIDRS`: socket peers whose `ipHeader` is honoured. */
  trustedEdgeCidrs: string[];
}

// ── controls: halts, reconciliation, gates, four-eyes approvals (SPEC §6, §13; stage S4) ──
/** Operator roles (SPEC §6.5, X11) live in types.ts (the wire shares them); re-exported for config readers. */
export { ADMIN_ROLES, type AdminRole };

/** One `ADMIN_OPERATORS` entry: `<party>[=<pinnedKey>]#<personId>@<role>[+<role>]`. */
export interface AdminOperator {
  party: string;
  /** "" = no pinned key (the fingerprint binding of the sign-in still applies). */
  pinnedKey: string;
  /** The PERSON behind the party: four-eyes compares persons, never parties (X11). Default: the party. */
  personId: string;
  roles: AdminRole[];
  /** Whether the entry spelled out `#person` / `@roles` (prod-like requires both). */
  declared: { person: boolean; roles: boolean };
}

export const GATE_MODES = ["enforce", "warn", "off"] as const;
export type GateMode = (typeof GATE_MODES)[number];

/** `RAMP_*` controls of SPEC §6 / §13 S4. Amounts in 1e-10 units of the fiat / the ramp instrument. */
export interface RampControlsConfig {
  /** `RAMP_DUAL_CONTROL`: four-eyes on money-moving admin actions (false = execute at once; dev/test only). */
  dualControl: boolean;
  /** `RAMP_APPROVAL_SIGNATURES`: decisions carry the operator wallet's signature (default on; refused off prod-like). */
  approvalSignatures: boolean;
  /** `RAMP_APPROVAL_TTL_BDAYS`: a pending approval expires at the end of this many Belarusian business days. */
  approvalTtlBdays: number;
  /** `ADMIN_OPERATOR_ACCOUNTS=<personId>:<userId>[,…]`: each person's own user accounts (I8: never a subject of theirs). */
  operatorAccounts: Map<string, string[]>;
  /** `RAMP_RECON_EVERY_MIN`: full reconciliation cadence (S1's idle token-sync cadence reads the same variable). */
  reconEveryMin: number;
  /** `RAMP_RECON_MAX_AGE_MIN`: the gates need a full run younger than this. */
  reconMaxAgeMin: number;
  /** `RAMP_RECON_UNKNOWN_MAX_MIN`: a halting check unreadable for longer counts as red for its scopes. */
  reconUnknownMaxMin: number;
  /** `RAMP_AUTO_HALT`: red halting checks set their halt scopes at once. */
  autoHalt: boolean;
  /** `RAMP_RESERVE_GATE`: enforce | warn (alert only) | off (off-prod only). */
  reserveGate: GateMode;
  /** `RAMP_PAYOUT_GATE` (S4 addition): the payout gate's reconciliation conditions; halts always block. */
  payoutGate: GateMode;
  /** `RAMP_RESERVE_MAX_AGE_BDAYS`: the latest confirmed statement's period end may be this many business days old. */
  reserveMaxAgeBdays: number;
  /** `RAMP_RESERVE_TOLERANCE`: allowed shortfall (0; > 0 refused prod-like). */
  reserveTolerance: bigint;
  /** `RAMP_MINT_DAILY_CAP`: rolling 24 h ramp mints (re-mints excluded); null = none (required prod-like with the ramp on). */
  mintDailyCap: bigint | null;
  /** `RAMP_PSP_SETTLE_DAYS`: captures older than this many business days should have settled. */
  pspSettleDays: number;
  /** `RAMP_OPERATOR_MONEY_MAX`: operator money left in the client account above this for over a business day is amber; null = no check. */
  operatorMoneyMax: bigint | null;
  /** `RAMP_TREASURY_SURPLUS_MAX`: treasury holdings above the in-app liabilities by more than this are amber; null = no check. */
  treasurySurplusMax: bigint | null;
  /** `RAMP_BANK_HOLIDAYS` / `RAMP_BANK_WORKDAYS`: ISO dates of the Belarusian calendar (SPEC §6.6). */
  bankHolidays: string[];
  bankWorkdays: string[];
}

// ── compliance: identity, consent, eligibility, monitoring rules, alerts (SPEC §11, §13; stage S7a) ──

/** One `RAMP_BV_TABLE` entry: the base value (BV) in BYN from a Minsk calendar day on (R14, m3). */
export interface BvEntry {
  /** `YYYY-MM-DD` (Minsk). */
  from: string;
  /** BYN per BV, 1e-10 units. */
  byn: bigint;
}

/** Monitoring thresholds of SPEC §11.4 (lowered ПВК p.64 indicators; counsel confirms). BV counts are whole. */
export interface ComplianceRulesConfig {
  /** `RAMP_TM_STRUCT_COUNT` (3) on-ramps in 24 h … */
  structCount: number;
  /** … whose sum reaches `RAMP_TM_STRUCT_PCT` (90) % of the on-ramp daily max. */
  structPct: number;
  /** `RAMP_TM_AGE_BV` (100): Σ(on + off) in 30 days for an account holder under 21 or 60+. */
  ageBv: number;
  /** `RAMP_TM_THIRDPARTY_BV` (20): a third-party bank payer at or above this is a review, below info. */
  thirdPartyBv: number;
  /** `RAMP_TM_UNVERIFIED_PAYER_BV` (100): ERIP without a bank payer name, per 30 days (info below, review from). */
  unverifiedPayerBv: number;
  /** `RAMP_TM_ROUNDTRIP_DAYS` (30) / `_BV` (50) / `_TRADE_PCT` (10): on-ramps then a cash-out with little trading. */
  roundtripDays: number;
  roundtripBv: number;
  roundtripTradePct: number;
  /** `RAMP_TM_NETOUT_BV` (200): 30-day cash-outs beyond on-ramps and deposits. */
  netoutBv: number;
  /** `RAMP_TM_MAX_CARDS_30D` (3): more distinct cards paying in 30 days is a review. */
  maxCards30d: number;
}

/** `RAMP_*` compliance keys of SPEC §13 S7a. */
export interface ComplianceConfig {
  /** `RAMP_COMPLIANCE` (on | off): off leaves the compliance port's allow-all default (off-prod only). */
  enabled: boolean;
  /** `RAMP_BV_TABLE` (`2026-01-01:45`): dated base values, ascending. */
  bvTable: BvEntry[];
  /** `RAMP_MIN_AGE` (18). */
  minAge: number;
  /** `RAMP_ALLOWED_RESIDENCE` (BY): ISO alpha-2 residence countries the ramp serves. */
  allowedResidence: string[];
  /** `RAMP_BLOCKED_CITIZENSHIPS`: ISO alpha-2 citizenships refused. */
  blockedCitizenships: string[];
  /** `RAMP_KYC_REFRESH_DAYS` (30): a stored identity older than this is re-read from the provider. */
  kycRefreshDays: number;
  /** `RAMP_ERIP_ALLOW_CASH` (true): an ERIP cash / unknown-channel payment is a review (false: block). */
  eripAllowCash: boolean;
  /** `RAMP_TM_RULES_VERSION`: the internal-control rules version stamped on every alert (required prod-like). */
  rulesVersion: string;
  /** `RAMP_TM_ALLOW_UNREACHABLE` (false): accept a rule threshold the limits can never reach. */
  allowUnreachable: boolean;
  tm: ComplianceRulesConfig;
}

// ── screening and freezes (SPEC §11.6, §13; stage S7b) ──
export interface ScreeningConfig {
  /** `RAMP_RESCREEN_DAYS` (30, 1..90): every account is re-screened at least this often (ПВК p.57: ≤ 3 months). */
  rescreenDays: number;
  /** `RAMP_SCREENING_LIST_MAX_AGE_DAYS` (30): `screening_stale` is amber when a freezing list was not imported for longer. */
  listMaxAgeDays: number;
}

const MIN_SECRET_LENGTH = 32;
const PARTY_ID_RE = /^[A-Za-z0-9_.-]{1,255}::1220[0-9a-f]{64}$/;

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

  readonly keycloak!: KeycloakConfig;
  /** Per-target overrides; empty fields fall back to `keycloak`. */
  readonly ledgerKeycloak!: Partial<KeycloakConfig>;
  readonly walletKeycloak!: Partial<KeycloakConfig>;
  /** Mainnet ledger — the only ledger credentials read when appNetwork = mainnet. */
  readonly zkpc!: ZkpcConfig;

  // ── KYC ─────────────────────────────────────────────────────────────────────
  @IsIn(KYC_PROVIDERS as readonly string[])
  readonly kycProvider!: KycProviderSetting;

  /** Gate external withdrawal settlement on an approved KYC (§9.4). A plain flag: money leaves only through this backend. */
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

  // ── exchange / orders (docs/MARKETS.md §7–§8) ──────────────────────────────
  /** `GET /exchange/status.ledger.stale`: the index row was not touched for longer than this. */
  @IsInt()
  @Min(10)
  readonly exchangeStaleAfterSec!: number;

  /** How long a prepared order (`POST /markets/:id/orders/prepare`) is advertised as usable. */
  @IsInt()
  @Min(5)
  readonly orderPrepareTtlSec!: number;

  @IsInt()
  @Min(0)
  readonly ledgerCacheMs!: number;

  /** Must cover the worst-case reconcile (confirm pass, ledger reads, the submit); correctness never depends on it (§8.3). */
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

  // ── ledger indexer (docs/INDEXER.md) ────────────────────────────────────────
  /** `INDEXER_ENABLED=false` keeps the read API up on whatever was indexed but runs no loop. */
  @IsBoolean()
  readonly indexerEnabled!: boolean;

  /** How often the loop re-reads the ledger end once it has caught up. */
  @IsInt()
  @Min(250)
  readonly indexerPollMs!: number;

  /** Updates requested per `/v2/updates` call (the participant caps it at its own `http-list-max-elements-limit`). */
  @IsInt()
  @Min(1)
  @Max(1000)
  readonly indexerBatch!: number;

  /** ACS page size for the bootstrap / resync snapshot; a snapshot that fills it is refused as possibly truncated. */
  @IsInt()
  @Min(100)
  readonly indexerAcsLimit!: number;

  /** First offset to index on a never-pruned participant (0 = ledger begin — the full history). */
  @IsInt()
  @Min(0)
  readonly indexerStartOffset!: number;

  /** Cross-instance lock TTL; the holder renews it at a third of this. */
  @IsInt()
  @Min(5_000)
  readonly indexerLockTtlMs!: number;

  /** `packageName` the participant reports for Splice Amulet events (`splice-amulet` on every Splice network so far). */
  @IsString()
  @IsNotEmpty()
  readonly splicePackageName!: string;

  /** The party the indexer reads as; blank = the treasury (signatory / observer on every TruthOracle template). */
  @IsString()
  readonly indexerPartyOverride!: string;

  // ── instruments, treasury transfers, token-app, rewards (docs/TOKENS.md §4.7) ──
  /** `COLLATERAL_INSTRUMENT_*`: upserted at boot as the default collateral; `id` blank = no collateral configured (markets cannot be created). */
  readonly collateralInstrument!: InstrumentConfig;

  /** `REWARDS_INSTRUMENT_*` (TRO): upserted at boot as the rewards instrument; without an `admin` the rewards processor stays idle. */
  readonly rewardsInstrument!: InstrumentConfig;

  /** Regulator parties: observers on every UserWallet / PendingPayout the backend creates and the default for `CreateMarket.auditObservers`. */
  @IsArray()
  readonly auditObserverParties!: string[];

  /** `wallet` = Enterprise Wallet `/api/v1/transfer`; `registry` = `TransferFactory_Transfer` via `/external/submit`. Per-instrument `transfer_mode` overrides it. */
  @IsIn(TREASURY_TRANSFER_MODES as readonly string[])
  readonly treasuryTransferMode!: TreasuryTransferMode;

  /** `executeBefore` horizon of a registry-mode transfer. */
  @IsInt()
  @Min(1)
  readonly treasuryTransferTtlSec!: number;

  /** The reconcile refuses (`503 ledger_stale`) when the index lags the ledger end by more than this many offsets. */
  @IsInt()
  @Min(0)
  readonly ledgerFreshOffsets!: number;

  /** TransferInstruction acceptor cadence; 0 = off. */
  @IsInt()
  @Min(0)
  readonly acceptorScanMs!: number;

  /** Bearer for `registry_auth = keycloak`; empty fields fall back to `keycloak`. */
  readonly registryKeycloak!: Partial<KeycloakConfig>;

  readonly tokenApp!: TokenAppConfig;

  // ── token side and ZKPC (SPEC §7; stage S1) ──
  readonly tokenCommands!: TokenCommandsConfig;

  @IsBoolean()
  readonly rewardsEnabled!: boolean;

  @IsInt()
  @Min(1000)
  readonly rewardsScanMs!: number;

  /** DevNet only: mint the rewards float shortfall through token-app instead of blocking the grant. */
  @IsBoolean()
  readonly rewardsAutoMint!: boolean;

  /** Smallest auto-mint, in 1e-10 units of the rewards instrument. */
  readonly rewardsMintMin!: bigint;

  // ── fiat ramp (docs/RAMP.md §10) ──
  readonly ramp!: RampConfig;

  // ── platform security (SPEC §8; stage S3) ──
  readonly sealing!: SealingConfig;
  /** `RAMP_PROVIDER_MODE` (sandbox | live): `live` makes the deployment prod-like; the mock is always sandbox. */
  readonly rampProviderMode!: RampProviderMode;
  readonly rampWebhooks!: RampWebhookConfig;

  // ── controls: halts, reconciliation, gates, four-eyes approvals (SPEC §6; stage S4) ──
  /** party → its `ADMIN_OPERATORS` entry (person, roles); `adminOperators` keeps party → pinned key. */
  readonly adminOperatorDetails!: Map<string, AdminOperator>;
  readonly rampControls!: RampControlsConfig;

  // ── screening and freezes (SPEC §11.6; stage S7b) ──
  readonly screening!: ScreeningConfig;

  // ── compliance: identity, consent, eligibility, monitoring rules, alerts (SPEC §11; stage S7a) ──
  readonly compliance!: ComplianceConfig;

  // ── bank rail: accounts, batches, statements (SPEC §10; stage S6) ──
  readonly rampBank!: RampBankConfig;

  /**
   * Prod-like (SPEC §8): APP_ENV=prod OR APP_NETWORK=mainnet OR RAMP_PROVIDER_MODE=live. Every
   * "prod" refusal of the ramp is a prod-like refusal.
   */
  get isProdLike(): boolean {
    return (
      this.appEnv === "prod" || this.appNetwork === "mainnet" || this.rampProviderMode === "live"
    );
  }

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

  /** The party whose view of the ledger is indexed (`INDEXER_PARTY`, default the treasury). */
  get indexerParty(): string {
    return this.indexerPartyOverride || this.treasuryPartyId;
  }

  /** A collateral instrument is configured (both `COLLATERAL_INSTRUMENT_ADMIN` and `_ID`). */
  get hasCollateralInstrument(): boolean {
    return Boolean(this.collateralInstrument.admin && this.collateralInstrument.id);
  }

  /** A rewards instrument is configured; without one rewards are computed by nobody and `GET /me/rewards` answers 404. */
  get hasRewardsInstrument(): boolean {
    return Boolean(this.rewardsInstrument.admin && this.rewardsInstrument.id);
  }

  get hasTokenApp(): boolean {
    return Boolean(this.tokenApp.url);
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
  for (const full of parseList(raw)) {
    // `#<personId>@<roles>` (SPEC §6.5) is parsed by parseOperatorEntries; neither # nor @ occurs in a key.
    const entry = full.split("#")[0];
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

// ── controls (SPEC §6.5; stage S4) ──

const PERSON_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * `ADMIN_OPERATORS` entries with their person and roles: `<party>[=<pinnedKey>]#<personId>@<role>[+<role>]`.
 * Without `#…` the person is the party; without `@…` the operator holds every role (dev / test
 * only — prod-like refuses both). Malformed parts are kept verbatim so boot can name them.
 */
export function parseOperatorEntries(raw: string | undefined): {
  operators: Map<string, AdminOperator>;
  issues: string[];
} {
  const operators = new Map<string, AdminOperator>();
  const issues: string[] = [];
  for (const full of parseList(raw)) {
    const hash = full.indexOf("#");
    const head = hash < 0 ? full : full.slice(0, hash);
    const tail = hash < 0 ? null : full.slice(hash + 1);
    const eq = head.indexOf("=");
    const party = (eq < 0 ? head : head.slice(0, eq)).trim();
    if (!party) continue;
    const pinnedKey = eq < 0 ? "" : head.slice(eq + 1).trim();
    let personId = party;
    let roles: AdminRole[] = [...ADMIN_ROLES];
    const declared = { person: false, roles: false };
    if (tail !== null) {
      const at = tail.indexOf("@");
      const person = (at < 0 ? tail : tail.slice(0, at)).trim();
      declared.person = true;
      if (!PERSON_ID_RE.test(person))
        issues.push(
          `ADMIN_OPERATORS person id for ${party.slice(0, 24)}… must match [A-Za-z0-9_.-]{1,64}`,
        );
      personId = person;
      if (at >= 0) {
        declared.roles = true;
        const named = tail
          .slice(at + 1)
          .split("+")
          .map((r) => r.trim().toLowerCase());
        for (const r of named)
          if (!(ADMIN_ROLES as readonly string[]).includes(r))
            issues.push(
              `ADMIN_OPERATORS entry for ${party.slice(0, 24)}… names an unknown role "${r}" (${ADMIN_ROLES.join(", ")})`,
            );
        roles = ADMIN_ROLES.filter((r) => named.includes(r));
      }
    }
    operators.set(party, { party, pinnedKey, personId, roles, declared });
  }
  return { operators, issues };
}

/** `ADMIN_OPERATOR_ACCOUNTS=<personId>:<userId>[,…]` → personId → user ids (malformed entries refused at boot). */
function operatorAccountsFrom(raw: string | undefined): {
  accounts: Map<string, string[]>;
  issues: string[];
} {
  const accounts = new Map<string, string[]>();
  const issues: string[] = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const entry of parseList(raw)) {
    const colon = entry.indexOf(":");
    const person = colon < 0 ? "" : entry.slice(0, colon).trim();
    const userId =
      colon < 0
        ? ""
        : entry
            .slice(colon + 1)
            .trim()
            .toLowerCase();
    if (!PERSON_ID_RE.test(person) || !uuid.test(userId)) {
      issues.push(
        `ADMIN_OPERATOR_ACCOUNTS entries must be <personId>:<user uuid>: ${entry.slice(0, 40)}`,
      );
      continue;
    }
    accounts.set(person, [...(accounts.get(person) ?? []), userId]);
  }
  return { accounts, issues };
}

function optionalAmount(raw: string | undefined): bigint | null {
  return str(raw) ? (tryParseAmount(str(raw)) ?? -1n) : null;
}

function rampControlsFrom(env: NodeJS.ProcessEnv): RampControlsConfig {
  return {
    dualControl: parseBool(env.RAMP_DUAL_CONTROL, true),
    approvalSignatures: parseBool(env.RAMP_APPROVAL_SIGNATURES, true),
    approvalTtlBdays: parseIntOr(env.RAMP_APPROVAL_TTL_BDAYS, 2),
    operatorAccounts: operatorAccountsFrom(env.ADMIN_OPERATOR_ACCOUNTS).accounts,
    // The same variable as S1's tokenCommands.idleSyncMin (validated there): one cadence for both.
    reconEveryMin: parseIntOr(env.RAMP_RECON_EVERY_MIN, 15),
    reconMaxAgeMin: parseIntOr(env.RAMP_RECON_MAX_AGE_MIN, 60),
    reconUnknownMaxMin: parseIntOr(env.RAMP_RECON_UNKNOWN_MAX_MIN, 60),
    autoHalt: parseBool(env.RAMP_AUTO_HALT, true),
    reserveGate: (str(env.RAMP_RESERVE_GATE, "enforce").toLowerCase() || "enforce") as GateMode,
    payoutGate: (str(env.RAMP_PAYOUT_GATE, "enforce").toLowerCase() || "enforce") as GateMode,
    reserveMaxAgeBdays: parseIntOr(env.RAMP_RESERVE_MAX_AGE_BDAYS, 2),
    reserveTolerance: amountOr(env.RAMP_RESERVE_TOLERANCE, "0"),
    mintDailyCap: optionalAmount(env.RAMP_MINT_DAILY_CAP),
    pspSettleDays: parseIntOr(env.RAMP_PSP_SETTLE_DAYS, 3),
    operatorMoneyMax: optionalAmount(env.RAMP_OPERATOR_MONEY_MAX),
    treasurySurplusMax: optionalAmount(env.RAMP_TREASURY_SURPLUS_MAX),
    bankHolidays: parseList(env.RAMP_BANK_HOLIDAYS),
    bankWorkdays: parseList(env.RAMP_BANK_WORKDAYS),
  };
}

function absoluteUrl(raw: string | undefined): string {
  const trimmed = str(raw).replace(/\/$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
}

/**
 * `<PREFIX>_INSTRUMENT_*` → InstrumentConfig. Only `admin` and `id` are identity; the rest defaults
 * to what the token id implies (symbol = name = id, `walletInstrumentId` = id, registry auth
 * `keycloak`, 6 decimals — cBYN's and TRO's; Canton Coin as a stand-in needs an explicit 10).
 */
function instrumentFrom(
  env: NodeJS.ProcessEnv,
  prefix: "COLLATERAL" | "REWARDS",
): InstrumentConfig {
  const id = str(env[`${prefix}_INSTRUMENT_ID`]);
  const registryUrlRaw = str(env[`${prefix}_REGISTRY_URL`]);
  return {
    admin: str(env[`${prefix}_INSTRUMENT_ADMIN`]),
    id,
    symbol: str(env[`${prefix}_INSTRUMENT_SYMBOL`]) || id,
    name: str(env[`${prefix}_INSTRUMENT_NAME`]) || id,
    decimals: parseIntOr(env[`${prefix}_INSTRUMENT_DECIMALS`], 6),
    // Kept verbatim when malformed so the boot refusal below can name it; `absoluteUrl` would turn it into "".
    registryUrl: absoluteUrl(registryUrlRaw) || registryUrlRaw,
    registryAuth: (str(env[`${prefix}_REGISTRY_AUTH`], "keycloak").toLowerCase() ||
      "keycloak") as RegistryAuth,
    walletInstrumentId: str(env[`${prefix}_WALLET_INSTRUMENT_ID`]) || id,
  };
}

/** A decimal amount env var; `-1n` (refused at boot) when malformed. */
function amountOr(raw: string | undefined, fallback: string): bigint {
  return tryParseAmount(str(raw, fallback) || fallback) ?? -1n;
}

function rampDirectionFrom(
  env: NodeJS.ProcessEnv,
  prefix: "RAMP_ONRAMP" | "RAMP_OFFRAMP",
): RampDirectionConfig {
  return {
    min: amountOr(env[`${prefix}_MIN`], "10"),
    max: amountOr(env[`${prefix}_MAX`], "2000"),
    dailyMax: amountOr(env[`${prefix}_DAILY_MAX`], "3000"),
    monthlyMax: amountOr(env[`${prefix}_MONTHLY_MAX`], "20000"),
  };
}

// ── methods, rails, exposure, operator of record (SPEC §9, §13; stage S5) ──

/** Card 1 min, ERIP 5 min (SPEC §9.2): an ERIP invoice is paid later, from a bank app or a kiosk. */
const RAMP_POLL_MS: Record<RampMethod, number> = { card: 60_000, erip: 300_000 };
const RAMP_METHOD_DEFAULTS: Record<RampMethod, { ttlMin: number; pspFeeBps: number }> = {
  card: { ttlMin: 30, pspFeeBps: 240 },
  erip: { ttlMin: 1440, pspFeeBps: 120 },
};

function rampMethodFrom(env: NodeJS.ProcessEnv, method: RampMethod): RampMethodConfig {
  const prefix = `RAMP_${method.toUpperCase()}`;
  const d = RAMP_METHOD_DEFAULTS[method];
  return {
    ttlMin: parseIntOr(env[`${prefix}_TTL_MIN`], d.ttlMin),
    feeBps: parseIntOr(env[`${prefix}_FEE_BPS`], 0),
    feeFixed: amountOr(env[`${prefix}_FEE_FIXED`], "0"),
    pspFeeBps: parseIntOr(env[`${prefix}_PSP_FEE_BPS`], d.pspFeeBps),
    pollMs: RAMP_POLL_MS[method],
  };
}

function rampRailFrom(env: NodeJS.ProcessEnv, rail: RampPayoutRail): RampFeeConfig {
  const prefix = `RAMP_PAYOUT_${rail.toUpperCase()}`;
  return {
    feeBps: parseIntOr(env[`${prefix}_FEE_BPS`], 0),
    feeFixed: amountOr(env[`${prefix}_FEE_FIXED`], "0"),
  };
}

/** A comma list, lower-cased; blank → the default. Unknown entries are kept so boot can name them. */
function lowerListOr(raw: string | undefined, fallback: string[]): string[] {
  const list = parseList(raw).map((v) => v.toLowerCase());
  return list.length ? list : fallback;
}

// ── platform security (SPEC §8; stage S3) ──

/**
 * One keyring from `<keysVar>` / `<idVar>`. Both blank → one key derived from SESSION_SECRET under
 * kid `dev-<8 hex of its hash>` (dev / test only; prod-like refuses it), so a changed secret shows
 * up at boot as a dropped kid instead of as values that silently fail to open.
 */
function keyringFrom(
  env: NodeJS.ProcessEnv,
  keysVar: "DATA_KEYS" | "DATA_INDEX_KEYS",
  idVar: "DATA_KEY_ID" | "DATA_INDEX_KEY_ID",
  label: string,
): { ring: Keyring; derived: boolean; issues: string[] } {
  const raw = str(env[keysVar]);
  const activeKid = str(env[idVar]);
  if (!raw && !activeKid) {
    const key = createHash("sha256")
      .update(`truthoracle-${label}|${str(env.SESSION_SECRET)}`, "utf8")
      .digest();
    const kid = `dev-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
    return { ring: { activeKid: kid, keys: new Map([[kid, key]]) }, derived: true, issues: [] };
  }
  const { keys, issues } = parseKeyring(raw, keysVar);
  if (!raw) issues.push(`${idVar} is set without ${keysVar}`);
  else if (!keys.has(activeKid)) issues.push(`${idVar} must name one of the kids in ${keysVar}`);
  return { ring: { activeKid, keys }, derived: false, issues };
}

/** Both keyrings with their parse problems (re-run by `securityIssues`; parsing is pure). */
function sealingFrom(env: NodeJS.ProcessEnv): { config: SealingConfig; issues: string[] } {
  const data = keyringFrom(env, "DATA_KEYS", "DATA_KEY_ID", "data-key");
  const index = keyringFrom(env, "DATA_INDEX_KEYS", "DATA_INDEX_KEY_ID", "data-index-key");
  return {
    config: {
      data: data.ring,
      index: index.ring,
      derived: { data: data.derived, index: index.derived },
    },
    issues: [...data.issues, ...index.issues],
  };
}

function rampWebhooksFrom(env: NodeJS.ProcessEnv): RampWebhookConfig {
  const sourceCidrs = new Map<string, string[]>();
  for (const entry of parseList(env.RAMP_WEBHOOK_SOURCE_CIDRS)) {
    // Split on the FIRST ":" — IPv6 CIDRs carry more of them.
    const at = entry.indexOf(":");
    const provider = at < 0 ? "" : entry.slice(0, at).trim().toLowerCase();
    sourceCidrs.set(provider, [...(sourceCidrs.get(provider) ?? []), entry.slice(at + 1).trim()]);
  }
  return {
    ipAuthProviders: parseList(env.RAMP_IP_AUTH_PROVIDERS).map((p) => p.toLowerCase()),
    sourceCidrs,
    ipHeader: str(env.RAMP_WEBHOOK_IP_HEADER).toLowerCase(),
    trustedEdgeCidrs: parseList(env.RAMP_TRUSTED_EDGE_CIDRS),
  };
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

    googleClientIds: parseList(env.GOOGLE_CLIENT_IDS),
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
      clientId: str(env.ZKPC_KEYCLOAK_CLIENT_ID),
      clientSecret: str(env.ZKPC_KEYCLOAK_CLIENT_SECRET),
    },

    kycProvider: str(env.KYC_PROVIDER, "mock").toLowerCase() as KycProviderSetting,
    kycEnforceWithdrawals: parseBool(env.KYC_ENFORCE_WITHDRAWALS, false),
    kycRequiredLevel: str(env.KYC_REQUIRED_LEVEL, "basic-kyc-level") || "basic-kyc-level",
    kycFingerprintPepper: str(env.KYC_FINGERPRINT_PEPPER),
    kycPepperRotationAck: str(env.KYC_PEPPER_ROTATION_ACK).toLowerCase(),
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
    exchangeStaleAfterSec: parseIntOr(env.EXCHANGE_STALE_AFTER_SEC, 300),
    orderPrepareTtlSec: parseIntOr(env.ORDER_PREPARE_TTL_SEC, 60),
    ledgerCacheMs: parseIntOr(env.LEDGER_CACHE_MS, 15_000),
    depositLockTtlMs: parseIntOr(env.DEPOSIT_LOCK_TTL_MS, 300_000),
    depositConfirmGraceMs: parseIntOr(env.DEPOSIT_CONFIRM_GRACE_MS, 10 * 60_000),
    sentryDsn: str(env.SENTRY_DSN),
    swaggerEnabled: parseAutoBool(env.SWAGGER_ENABLED, !isProd),

    indexerEnabled: parseBool(env.INDEXER_ENABLED, true),
    indexerPollMs: parseIntOr(env.INDEXER_POLL_MS, 2_000),
    indexerBatch: parseIntOr(env.INDEXER_BATCH, 200),
    indexerAcsLimit: parseIntOr(env.INDEXER_ACS_LIMIT, 10_000),
    indexerStartOffset: parseIntOr(env.INDEXER_START_OFFSET, 0),
    indexerLockTtlMs: parseIntOr(env.INDEXER_LOCK_TTL_MS, 30_000),
    splicePackageName: str(env.SPLICE_AMULET_PACKAGE_NAME, "splice-amulet") || "splice-amulet",
    indexerPartyOverride: str(env.INDEXER_PARTY),

    collateralInstrument: instrumentFrom(env, "COLLATERAL"),
    rewardsInstrument: instrumentFrom(env, "REWARDS"),
    auditObserverParties: parseList(env.AUDIT_OBSERVER_PARTIES),
    treasuryTransferMode: (str(env.TREASURY_TRANSFER_MODE, "wallet").toLowerCase() ||
      "wallet") as TreasuryTransferMode,
    treasuryTransferTtlSec: parseIntOr(env.TREASURY_TRANSFER_TTL_SEC, 600),
    ledgerFreshOffsets: parseIntOr(env.LEDGER_FRESH_OFFSETS, 50),
    acceptorScanMs: parseIntOr(env.ACCEPTOR_SCAN_MS, 10_000),
    registryKeycloak: keycloakFrom(env, "REGISTRY_KEYCLOAK"),
    tokenApp: {
      url: absoluteUrl(env.TOKEN_APP_URL) || str(env.TOKEN_APP_URL),
      appName: str(env.TOKEN_APP_APP_NAME, "truthoracle") || "truthoracle",
      keycloak: keycloakFrom(env, "TOKEN_APP_KEYCLOAK"),
    },
    // ── token side and ZKPC (SPEC §7; stage S1) ──
    tokenCommands: tokenCommandsFrom(env),
    rewardsEnabled: parseBool(env.REWARDS_ENABLED, true),
    rewardsScanMs: parseIntOr(env.REWARDS_SCAN_MS, 30_000),
    rewardsAutoMint: parseBool(env.REWARDS_AUTO_MINT, false),
    rewardsMintMin: tryParseAmount(str(env.REWARDS_MINT_MIN, "1000") || "1000") ?? -1n,

    ramp: {
      enabled: parseBool(env.RAMP_ENABLED, false),
      provider: (str(env.RAMP_PROVIDER, "mock").toLowerCase() || "mock") as RampProviderName,
      instrument: str(env.RAMP_INSTRUMENT) ? parseInstrumentKey(str(env.RAMP_INSTRUMENT)) : null,
      fiatCurrency: str(env.RAMP_FIAT_CURRENCY, "BYN").toUpperCase() || "BYN",
      fiatDecimals: parseIntOr(env.RAMP_FIAT_DECIMALS, 2),
      publicAppUrl: absoluteUrl(env.RAMP_PUBLIC_APP_URL),
      publicApiUrl: absoluteUrl(env.RAMP_PUBLIC_API_URL),
      requireKyc: parseBool(env.RAMP_REQUIRE_KYC, true),
      require3ds: parseBool(env.RAMP_REQUIRE_3DS, true),
      onramp: rampDirectionFrom(env, "RAMP_ONRAMP"),
      offramp: rampDirectionFrom(env, "RAMP_OFFRAMP"),
      maxCards: parseIntOr(env.RAMP_MAX_CARDS, 3),
      offrampSignTtlMin: parseIntOr(env.RAMP_OFFRAMP_SIGN_TTL_MIN, 15),
      scanMs: parseIntOr(env.RAMP_SCAN_MS, 10_000),
      maxAttempts: parseIntOr(env.RAMP_MAX_ATTEMPTS, 5),
      stuckAfterMin: parseIntOr(env.RAMP_STUCK_AFTER_MIN, 30),
      checkoutHosts: parseList(env.RAMP_CHECKOUT_HOSTS).map((h) => h.toLowerCase()),
      withdrawingTimeoutMin: parseIntOr(env.RAMP_WITHDRAWING_TIMEOUT_MIN, 60),
      withdrawalBindGraceMin: parseIntOr(env.RAMP_WITHDRAWAL_BIND_GRACE_MIN, 10),
      creditBackFinalAfterMin: parseIntOr(env.RAMP_CREDIT_BACK_FINAL_AFTER_MIN, 60),
      eventDeadAfterHours: parseIntOr(env.RAMP_EVENT_DEAD_AFTER_HOURS, 72),
      createdStaleMin: parseIntOr(env.RAMP_CREATED_STALE_MIN, 5),
      closedPollHours: parseIntOr(env.RAMP_CLOSED_POLL_HOURS, 48),
      // ── methods, rails, exposure, operator of record (SPEC §9, §13; stage S5) ──
      methods: lowerListOr(env.RAMP_METHODS, ["card"]) as RampMethod[],
      method: { card: rampMethodFrom(env, "card"), erip: rampMethodFrom(env, "erip") },
      payoutRails: lowerListOr(env.RAMP_PAYOUT_RAILS, ["card"]) as RampPayoutRail[],
      rail: { card: rampRailFrom(env, "card"), bank: rampRailFrom(env, "bank") },
      cardRefundMaxDays: parseIntOr(env.RAMP_CARD_REFUND_MAX_DAYS, 180),
      cardExposureDays: parseIntOr(env.RAMP_CARD_EXPOSURE_DAYS, 120),
      cardPayoutCountries: parseList(env.RAMP_CARD_PAYOUT_COUNTRIES || "BY").map((c) =>
        c.toUpperCase(),
      ),
      deeplinkSchemes: parseList(env.RAMP_DEEPLINK_SCHEMES).map((c) => c.toLowerCase()),
      mockEripServiceCode: str(env.RAMP_MOCK_ERIP_SERVICE_CODE, "100001") || "100001",
      operator: {
        name: str(env.RAMP_OPERATOR_NAME),
        unp: str(env.RAMP_OPERATOR_UNP),
        htpRef: str(env.RAMP_OPERATOR_HTP_REF),
      },
      termsVersion: str(env.RAMP_TERMS_VERSION),
      termsUrl: absoluteUrl(env.RAMP_TERMS_URL) || str(env.RAMP_TERMS_URL),
      mockWebhookSecret:
        str(env.RAMP_MOCK_WEBHOOK_SECRET) ||
        createHash("sha256")
          .update(`truthoracle-ramp-mock-webhook|${str(env.SESSION_SECRET)}`, "utf8")
          .digest("hex"),
    },

    // ── platform security (SPEC §8; stage S3) ──
    sealing: sealingFrom(env).config,
    rampProviderMode: (str(env.RAMP_PROVIDER_MODE, "sandbox").toLowerCase() ||
      "sandbox") as RampProviderMode,
    rampWebhooks: rampWebhooksFrom(env),

    // ── controls: halts, reconciliation, gates, four-eyes approvals (SPEC §6; stage S4) ──
    adminOperatorDetails: parseOperatorEntries(env.ADMIN_OPERATORS).operators,
    rampControls: rampControlsFrom(env),

    // ── screening and freezes (SPEC §11.6; stage S7b) ──
    screening: {
      rescreenDays: parseIntOr(env.RAMP_RESCREEN_DAYS, 30),
      listMaxAgeDays: parseIntOr(env.RAMP_SCREENING_LIST_MAX_AGE_DAYS, 30),
    },

    // ── compliance: identity, consent, eligibility, monitoring rules, alerts (SPEC §11; stage S7a) ──
    compliance: complianceFrom(env),

    // ── bank rail: accounts, batches, statements (SPEC §10; stage S6) ──
    rampBank: rampBankFrom(env),
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
  // Prod-like, not just prod (C32): with RAMP_PROVIDER_MODE=live real BYN moves, and the mock
  // lets any user self-assert the identity that KYC, eligibility and list screening rely on.
  if (config.kycProvider === "mock" && config.isProdLike) {
    issues.push(`KYC_PROVIDER=mock is refused when prod-like ${PROD_LIKE_WHY}`);
  }
  if (config.isMainnet && config.sumsub.appToken.startsWith("sbx:")) {
    issues.push("SUMSUB_APP_TOKEN is a sandbox token (sbx:) but APP_NETWORK=mainnet");
  }
  if (config.kycProvider === "sumsub" && config.sumsub.appToken && !config.sumsub.webhookSecret) {
    issues.push(
      "KYC_PROVIDER=sumsub requires SUMSUB_WEBHOOK_SECRET (sessions would start while every webhook is rejected with 401)",
    );
  }
  if (config.isProdLike && !config.dbSslInsecureAck) {
    const local = /(localhost|127\.0\.0\.1|@postgres[:/])/.test(config.databaseUrl);
    if (config.dbSsl === "true" || (config.dbSsl === "auto" && !local)) {
      issues.push(
        `DB_SSL=true/auto does not verify the Postgres server certificate; set DB_SSL=verify (with DB_SSL_CA when needed) or DB_SSL_INSECURE_ACK=true to accept unverified TLS when prod-like ${PROD_LIKE_WHY}`,
      );
    }
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
    if (!PARTY_ID_RE.test(party)) {
      issues.push(`ADMIN_OPERATORS entry is not a Canton party id: ${party.slice(0, 24)}…`);
    }
    if (key && !/^[A-Za-z0-9+/=_-]{40,90}$/.test(key)) {
      issues.push(`ADMIN_OPERATORS pinned key for ${party.slice(0, 24)}… is not hex/base64`);
    }
  }
  if (config.indexerPartyOverride && !PARTY_ID_RE.test(config.indexerPartyOverride)) {
    issues.push("INDEXER_PARTY is not a Canton party id");
  }
  for (const origin of [...config.frontendOrigins, ...config.corsOrigins]) {
    if (!/^https?:\/\/[A-Za-z0-9*.-]+(:\d+)?$/.test(origin)) {
      issues.push(`origin entry is not an origin (scheme://host[:port]): ${origin}`);
    }
  }

  // ── instruments (docs/TOKENS.md §4.1, §4.7) ──
  // A collateral id without its admin party identifies nothing on the ledger; the boot upsert would
  // register a token no market can ever be denominated in, so the process refuses outright. The
  // rewards instrument is softer: TRO may not exist on a network yet, so a missing admin leaves the
  // rewards processor idle instead of blocking trading.
  const collateral = config.collateralInstrument;
  if (collateral.id && !collateral.admin) {
    issues.push(
      "COLLATERAL_INSTRUMENT_ID is set without COLLATERAL_INSTRUMENT_ADMIN (the instrument's registry / transfer-agent party)",
    );
  }
  if (collateral.admin && !collateral.id) {
    issues.push("COLLATERAL_INSTRUMENT_ADMIN is set without COLLATERAL_INSTRUMENT_ID");
  }
  for (const [prefix, instrument] of [
    ["COLLATERAL", config.collateralInstrument],
    ["REWARDS", config.rewardsInstrument],
  ] as const) {
    if (instrument.admin && !PARTY_ID_RE.test(instrument.admin)) {
      issues.push(`${prefix}_INSTRUMENT_ADMIN is not a Canton party id`);
    }
    if (
      !Number.isInteger(instrument.decimals) ||
      instrument.decimals < 0 ||
      instrument.decimals > AMOUNT_DECIMALS
    ) {
      issues.push(`${prefix}_INSTRUMENT_DECIMALS must be an integer in 0..${AMOUNT_DECIMALS}`);
    }
    if (!(REGISTRY_AUTHS as readonly string[]).includes(instrument.registryAuth)) {
      issues.push(`${prefix}_REGISTRY_AUTH must be one of ${REGISTRY_AUTHS.join(", ")}`);
    }
    if (instrument.registryUrl && !/^https?:\/\//i.test(instrument.registryUrl)) {
      issues.push(`${prefix}_REGISTRY_URL is not an absolute http(s) URL`);
    }
  }
  for (const party of config.auditObserverParties) {
    if (!PARTY_ID_RE.test(party))
      issues.push(`AUDIT_OBSERVER_PARTIES entry is not a Canton party id: ${party.slice(0, 24)}…`);
  }
  if (config.tokenApp.url && !/^https?:\/\//i.test(config.tokenApp.url)) {
    issues.push("TOKEN_APP_URL is not an absolute http(s) URL");
  }
  // ── token side and ZKPC (SPEC §7; stage S1) ──
  issues.push(...tokenSideIssues(config, env));
  if (config.acceptorScanMs !== 0 && config.acceptorScanMs < 1000) {
    issues.push("ACCEPTOR_SCAN_MS must be 0 (off) or at least 1000");
  }
  if (config.rewardsMintMin < 0n) {
    issues.push("REWARDS_MINT_MIN must be a non-negative decimal amount of the rewards instrument");
  }

  // ── fiat ramp (docs/RAMP.md §10) ──
  issues.push(
    ...rampIssues(config.ramp, env, {
      isProd,
      isMainnet: config.isMainnet,
      prodLike: config.isProdLike,
    }),
  );

  // ── platform security (SPEC §8; stage S3) ──
  issues.push(...securityIssues(config, env));

  // ── controls: halts, reconciliation, gates, four-eyes approvals (SPEC §6; stage S4) ──
  issues.push(...controlsIssues(config, env));

  // ── screening and freezes (SPEC §11.6; stage S7b) ──
  issues.push(...screeningIssues(config.screening));

  // ── compliance: identity, consent, eligibility, monitoring rules, alerts (SPEC §11; stage S7a) ──
  issues.push(...complianceIssues(config, env));

  // ── bank rail: accounts, batches, statements (SPEC §10; stage S6) ──
  issues.push(...rampBankIssues(config));

  if (issues.length > 0) {
    throw new Error(`Invalid configuration:\n  ${issues.join("\n  ")}`);
  }
  return config;
}

/** Boot refusals for the `RAMP_*` block — unsafe combinations, not just malformed values. */
function rampIssues(
  ramp: RampConfig,
  env: NodeJS.ProcessEnv,
  ctx: { isProd: boolean; isMainnet: boolean; prodLike: boolean },
): string[] {
  const issues: string[] = [];
  if (!RAMP_PROVIDERS.includes(ramp.provider)) {
    issues.push(`RAMP_PROVIDER must be one of ${RAMP_PROVIDERS.join(", ")}`);
  }
  if (ramp.provider === "mock" && ramp.enabled && (ctx.isProd || ctx.isMainnet)) {
    issues.push("RAMP_PROVIDER=mock is refused when APP_ENV=prod or APP_NETWORK=mainnet");
  }
  if (str(env.RAMP_INSTRUMENT) && !ramp.instrument) {
    issues.push("RAMP_INSTRUMENT must be <instrument admin party>:<token id>");
  }
  if (ramp.instrument && !PARTY_ID_RE.test(ramp.instrument.admin)) {
    issues.push("RAMP_INSTRUMENT admin is not a Canton party id");
  }
  if (ramp.enabled && !ramp.publicAppUrl) {
    issues.push("RAMP_ENABLED=true requires RAMP_PUBLIC_APP_URL (the checkout return page)");
  }
  if (!/^[A-Z]{3}$/.test(ramp.fiatCurrency)) {
    issues.push("RAMP_FIAT_CURRENCY must be an ISO 4217 code");
  }
  if (!Number.isInteger(ramp.fiatDecimals) || ramp.fiatDecimals < 0 || ramp.fiatDecimals > 4) {
    issues.push("RAMP_FIAT_DECIMALS must be an integer in 0..4");
  }
  for (const [prefix, d] of [
    ["RAMP_ONRAMP", ramp.onramp],
    ["RAMP_OFFRAMP", ramp.offramp],
  ] as const) {
    if ([d.min, d.max, d.dailyMax, d.monthlyMax].some((v) => v < 0n)) {
      issues.push(`${prefix}_* amounts must be non-negative decimals`);
      continue;
    }
    if (d.min <= 0n || d.min > d.max) issues.push(`${prefix}_MIN must be positive and ≤ _MAX`);
    if (d.max > d.dailyMax) issues.push(`${prefix}_MAX must be ≤ _DAILY_MAX`);
    if (d.dailyMax > d.monthlyMax) issues.push(`${prefix}_DAILY_MAX must be ≤ _MONTHLY_MAX`);
  }
  for (const [name, value, min] of [
    ["RAMP_MAX_CARDS", ramp.maxCards, 1],
    ["RAMP_OFFRAMP_SIGN_TTL_MIN", ramp.offrampSignTtlMin, 1],
    ["RAMP_MAX_ATTEMPTS", ramp.maxAttempts, 1],
    ["RAMP_STUCK_AFTER_MIN", ramp.stuckAfterMin, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < min) issues.push(`${name} must be an integer ≥ ${min}`);
  }
  if (ramp.scanMs !== 0 && (!Number.isInteger(ramp.scanMs) || ramp.scanMs < 1000)) {
    issues.push("RAMP_SCAN_MS must be 0 (off) or at least 1000");
  } else if (ramp.scanMs === 0 && ctx.prodLike) {
    // C33: 0 stops far more than the order scan, and nothing would report it (reconciliation is
    // one of the loops it stops). Whatever RAMP_ENABLED says: in-flight orders, freezes and the
    // AML monitoring outlive new orders. An incident pause is POST /admin/ramp/controls/halt.
    issues.push(
      `RAMP_SCAN_MS=0 (turns off the order scan, full reconciliation, approval expiry, re-screens, TM-FROZEN-ACTIVITY, bank aging and the re-seal job) is refused when prod-like ${PROD_LIKE_WHY}; pause with POST /admin/ramp/controls/halt`,
    );
  }
  issues.push(...rampCoreIssues(ramp, ctx));
  issues.push(...rampMethodIssues(ramp, ctx));
  return issues;
}

// ── fiat ramp core (SPEC §13 S2) ──

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Refusals for S2's keys: timers that must stay meaningful, checkout hosts (E-D7), the PSP fee rate. */
function rampCoreIssues(ramp: RampConfig, ctx: { prodLike: boolean }): string[] {
  const issues: string[] = [];
  for (const [name, value, min] of [
    ["RAMP_WITHDRAWING_TIMEOUT_MIN", ramp.withdrawingTimeoutMin, 1],
    ["RAMP_WITHDRAWAL_BIND_GRACE_MIN", ramp.withdrawalBindGraceMin, 0],
    ["RAMP_CREDIT_BACK_FINAL_AFTER_MIN", ramp.creditBackFinalAfterMin, 1],
    ["RAMP_EVENT_DEAD_AFTER_HOURS", ramp.eventDeadAfterHours, 1],
    ["RAMP_CREATED_STALE_MIN", ramp.createdStaleMin, 1],
    ["RAMP_CLOSED_POLL_HOURS", ramp.closedPollHours, 0],
  ] as const) {
    if (!Number.isInteger(value) || value < min) issues.push(`${name} must be an integer ≥ ${min}`);
  }
  // A stale `created` is looked up at the acquirer; before the adapter's own deadline the create may still be running (H5).
  if (
    Number.isInteger(ramp.createdStaleMin) &&
    ramp.createdStaleMin * 60_000 <= RAMP_PROVIDER_HTTP_TIMEOUT_MS
  ) {
    issues.push(
      `RAMP_CREATED_STALE_MIN must exceed the acquirer adapter's HTTP timeout (${RAMP_PROVIDER_HTTP_TIMEOUT_MS / 1000} s)`,
    );
  }
  for (const host of ramp.checkoutHosts) {
    if (!HOSTNAME_RE.test(host)) issues.push(`RAMP_CHECKOUT_HOSTS has a malformed host: ${host}`);
  }
  // A real acquirer's checkout URL is checked against this list; empty would fail every order closed.
  if (ramp.enabled && ramp.provider !== "mock" && ramp.checkoutHosts.length === 0) {
    issues.push(
      "RAMP_CHECKOUT_HOSTS is required with a real RAMP_PROVIDER (the hosted checkout's hosts)",
    );
  }
  if (ramp.enabled && ctx.prodLike && ramp.closedPollHours === 0) {
    issues.push(
      "RAMP_CLOSED_POLL_HOURS=0 (no post-close poll) is refused with the ramp enabled prod-like",
    );
  }
  return issues;
}

// ── methods, rails, exposure, operator of record (SPEC §9, §13; stage S5) ──

/** Schemes a provider link may never carry, whatever RAMP_DEEPLINK_SCHEMES says (X15). */
const FORBIDDEN_LINK_SCHEMES = ["javascript", "data", "vbscript", "file", "blob", "about", "http"];
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/;

/**
 * Refusals for S5's keys: methods and rails from their closed lists, per-method TTLs and fees, the
 * card windows, link schemes; prod-like with the ramp on: ERIP needs the bank rail (Decree 8
 * p.4.4: every token must be redeemable), and the operator of record and its terms are set.
 * `RAMP_METHODS` ⊆ the provider's methods and "no card cash-out ⇒ bank rail" need the adapter's
 * capabilities: RampPolicyService checks them at bootstrap.
 */
function rampMethodIssues(ramp: RampConfig, ctx: { prodLike: boolean }): string[] {
  const issues: string[] = [];
  const closed = <T extends string>(name: string, list: string[], allowed: readonly T[]): void => {
    if (list.length === 0) issues.push(`${name} must name at least one of ${allowed.join(", ")}`);
    for (const v of list)
      if (!allowed.includes(v as T)) issues.push(`${name} has an unknown entry: ${v}`);
    if (new Set(list).size !== list.length) issues.push(`${name} lists an entry twice`);
  };
  closed("RAMP_METHODS", ramp.methods, RAMP_METHODS);
  closed("RAMP_PAYOUT_RAILS", ramp.payoutRails, RAMP_PAYOUT_RAILS);
  const bps = (name: string, v: number, max: number): void => {
    if (!Number.isInteger(v) || v < 0 || v > max)
      issues.push(`${name} must be an integer in 0..${max}`);
  };
  for (const m of RAMP_METHODS) {
    const c = ramp.method[m];
    const prefix = `RAMP_${m.toUpperCase()}`;
    if (!Number.isInteger(c.ttlMin) || c.ttlMin < 5 || c.ttlMin > 10_080)
      issues.push(`${prefix}_TTL_MIN must be an integer in 5..10080`);
    bps(`${prefix}_FEE_BPS`, c.feeBps, 5000);
    if (c.feeFixed < 0n) issues.push(`${prefix}_FEE_FIXED must be a non-negative decimal`);
    bps(`${prefix}_PSP_FEE_BPS`, c.pspFeeBps, 10_000);
  }
  for (const r of RAMP_PAYOUT_RAILS) {
    const prefix = `RAMP_PAYOUT_${r.toUpperCase()}`;
    bps(`${prefix}_FEE_BPS`, ramp.rail[r].feeBps, 5000);
    if (ramp.rail[r].feeFixed < 0n)
      issues.push(`${prefix}_FEE_FIXED must be a non-negative decimal`);
  }
  if (!Number.isInteger(ramp.cardRefundMaxDays) || ramp.cardRefundMaxDays < 1)
    issues.push("RAMP_CARD_REFUND_MAX_DAYS must be an integer ≥ 1");
  if (!Number.isInteger(ramp.cardExposureDays) || ramp.cardExposureDays < 0)
    issues.push("RAMP_CARD_EXPOSURE_DAYS must be an integer ≥ 0");
  for (const c of ramp.cardPayoutCountries)
    if (!/^[A-Z]{2}$/.test(c))
      issues.push(`RAMP_CARD_PAYOUT_COUNTRIES has a malformed country: ${c}`);
  for (const scheme of ramp.deeplinkSchemes) {
    if (!SCHEME_RE.test(scheme) || FORBIDDEN_LINK_SCHEMES.includes(scheme) || scheme === "https")
      issues.push(
        `RAMP_DEEPLINK_SCHEMES may list bank-app schemes only (https links need RAMP_CHECKOUT_HOSTS): ${scheme}`,
      );
  }
  if (!/^\d{1,16}$/.test(ramp.mockEripServiceCode))
    issues.push("RAMP_MOCK_ERIP_SERVICE_CODE must be 1-16 digits");
  if (!ramp.enabled || !ctx.prodLike) return issues;
  if (ramp.methods.includes("erip") && !ramp.payoutRails.includes("bank"))
    issues.push(
      "RAMP_METHODS with erip requires RAMP_PAYOUT_RAILS to include bank (ERIP value has no card exit)",
    );
  if (ramp.cardExposureDays < 1)
    issues.push(
      "RAMP_CARD_EXPOSURE_DAYS=0 (no card exposure) is refused with the ramp enabled prod-like",
    );
  const op = ramp.operator;
  if (!op.name)
    issues.push(
      "RAMP_OPERATOR_NAME is required with the ramp enabled prod-like (operator of record)",
    );
  if (!/^\d{9}$/.test(op.unp))
    issues.push("RAMP_OPERATOR_UNP must be the 9-digit UNP of the operator of record");
  if (!op.htpRef) issues.push("RAMP_OPERATOR_HTP_REF is required with the ramp enabled prod-like");
  if (!ramp.termsVersion)
    issues.push("RAMP_TERMS_VERSION is required with the ramp enabled prod-like");
  if (!/^https:\/\//i.test(ramp.termsUrl))
    issues.push("RAMP_TERMS_URL must be an https URL with the ramp enabled prod-like");
  return issues;
}

// ── platform security (SPEC §8; stage S3) ──

const PROVIDER_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Boot refusals of SPEC §8 (E-D4, X13, X17): keyrings (always well-formed; set when prod-like, never
 * shared between sealing and indexing), the provider mode, the webhook source settings, and the
 * prod-like floor for an enabled ramp. Each later stage adds its own block for its own keys (§13).
 */
function securityIssues(config: Config, env: NodeJS.ProcessEnv): string[] {
  const issues = [...sealingFrom(env).issues];
  const prodLike = config.isProdLike;
  const { sealing, ramp } = config;
  const prodLikeWhy = "(APP_ENV=prod, APP_NETWORK=mainnet or RAMP_PROVIDER_MODE=live)";
  if (prodLike && sealing.derived.data) {
    issues.push(`DATA_KEYS and DATA_KEY_ID are required when prod-like ${prodLikeWhy}`);
  }
  if (prodLike && sealing.derived.index) {
    issues.push(`DATA_INDEX_KEYS and DATA_INDEX_KEY_ID are required when prod-like ${prodLikeWhy}`);
  }
  const dataKeys = [...sealing.data.keys.values()];
  if ([...sealing.index.keys.values()].some((k) => dataKeys.some((d) => d.equals(k)))) {
    issues.push(
      "DATA_INDEX_KEYS must not reuse a DATA_KEYS key (sealing and indexing keys stay apart)",
    );
  }

  if (!(RAMP_PROVIDER_MODES as readonly string[]).includes(config.rampProviderMode)) {
    issues.push(`RAMP_PROVIDER_MODE must be one of ${RAMP_PROVIDER_MODES.join(", ")}`);
  }
  if (ramp.provider === "mock" && config.rampProviderMode === "live") {
    issues.push(
      "RAMP_PROVIDER_MODE=live is refused with RAMP_PROVIDER=mock (the mock is always sandbox)",
    );
  }

  const hooks = config.rampWebhooks;
  for (const p of hooks.ipAuthProviders) {
    if (!PROVIDER_NAME_RE.test(p)) issues.push(`RAMP_IP_AUTH_PROVIDERS entry is malformed: ${p}`);
    else if (!(hooks.sourceCidrs.get(p) ?? []).length) {
      issues.push(
        `RAMP_IP_AUTH_PROVIDERS lists ${p}, which authenticates by source IP: RAMP_WEBHOOK_SOURCE_CIDRS needs ${p}:<cidr> entries`,
      );
    }
  }
  for (const [provider, cidrs] of hooks.sourceCidrs) {
    if (!PROVIDER_NAME_RE.test(provider)) {
      issues.push("RAMP_WEBHOOK_SOURCE_CIDRS entries must be <provider>:<cidr>");
      continue;
    }
    for (const cidr of cidrs) {
      if (!parseCidr(cidr))
        issues.push(`RAMP_WEBHOOK_SOURCE_CIDRS has a malformed CIDR for ${provider}: ${cidr}`);
    }
  }
  for (const cidr of hooks.trustedEdgeCidrs) {
    const parsed = parseCidr(cidr);
    if (!parsed) issues.push(`RAMP_TRUSTED_EDGE_CIDRS has a malformed CIDR: ${cidr}`);
    else if (parsed.prefix === 0)
      issues.push(`RAMP_TRUSTED_EDGE_CIDRS must not trust every peer (${cidr})`);
  }
  if (hooks.ipHeader && !/^[a-z0-9-]{1,64}$/.test(hooks.ipHeader)) {
    issues.push("RAMP_WEBHOOK_IP_HEADER must be a header name");
  }
  if (hooks.ipHeader && hooks.trustedEdgeCidrs.length === 0 && !config.backendProxySecret) {
    issues.push(
      "RAMP_WEBHOOK_IP_HEADER is honoured only from RAMP_TRUSTED_EDGE_CIDRS or with BACKEND_PROXY_SECRET; set one of them",
    );
  }

  // E-D4: an enabled ramp in a prod-like deployment never runs below this floor.
  if (ramp.enabled && prodLike) {
    if (!ramp.requireKyc)
      issues.push(`RAMP_REQUIRE_KYC=true is required when prod-like ${prodLikeWhy}`);
    if (!ramp.require3ds)
      issues.push(`RAMP_REQUIRE_3DS=true is required when prod-like ${prodLikeWhy}`);
    if (ramp.publicAppUrl && !/^https:\/\//i.test(ramp.publicAppUrl)) {
      issues.push(`RAMP_PUBLIC_APP_URL must be https when prod-like ${prodLikeWhy}`);
    }
    if (ramp.publicApiUrl && !/^https:\/\//i.test(ramp.publicApiUrl)) {
      issues.push(`RAMP_PUBLIC_API_URL must be https when prod-like ${prodLikeWhy}`);
    }
    if (ramp.provider !== "mock" && !ramp.publicApiUrl) {
      issues.push(
        "RAMP_PUBLIC_API_URL is required with a real RAMP_PROVIDER (the acquirer's notification URL)",
      );
    }
  }
  return issues;
}

// ── token side and ZKPC (SPEC §7; stage S1) ──────────────────────────────────────────────────

/** Every Keycloak URL variable; a non-blank malformed one used to fall back silently to KEYCLOAK_URL (T-D2). */
const KEYCLOAK_URL_VARS = [
  "KEYCLOAK_URL",
  "LEDGER_KEYCLOAK_URL",
  "WALLET_KEYCLOAK_URL",
  "REGISTRY_KEYCLOAK_URL",
  "TOKEN_APP_KEYCLOAK_URL",
  "ZKPC_KEYCLOAK_URL",
] as const;

function tokenCommandsFrom(env: NodeJS.ProcessEnv): TokenCommandsConfig {
  // A malformed cap is kept as -1 so the refusal below names it.
  const cap = (raw: string | undefined): bigint | null =>
    str(raw) ? (tryParseAmount(str(raw)) ?? -1n) : null;
  return {
    maxPerCall: cap(env.TOKEN_APP_MAX_PER_CALL),
    maxPerDay: cap(env.TOKEN_APP_MAX_PER_DAY),
    syncSec: parseIntOr(env.TOKEN_APP_SYNC_SEC, 60),
    idleSyncMin: parseIntOr(env.RAMP_RECON_EVERY_MIN, 15),
    resendMaxAgeHours: parseIntOr(env.TOKEN_APP_RESEND_MAX_AGE_HOURS, 144),
    confirmMin: parseIntOr(env.RAMP_TOKEN_CONFIRM_MIN, 15),
    reviewAfterMin: parseIntOr(env.RAMP_TOKEN_REVIEW_AFTER_MIN, 120),
  };
}

function isHttpUrl(raw: string): boolean {
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    return Boolean(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * `"devnet"` / `"mainnet"` when a cantor8.tech host belongs to the OTHER network than
 * `mainnet` says (devnet hosts carry `.dev.` / `digik`, MainNet ones `.main.` / `zkpc`); null for
 * a matching or a non-Cantor8 host. A devnet backend pointed at the MainNet token-app, or the
 * reverse, mints real tokens or leaks a credential across trust domains.
 */
export function crossNetworkHost(url: string, mainnet: boolean): "devnet" | "mainnet" | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host !== "cantor8.tech" && !host.endsWith(".cantor8.tech")) return null;
  const dotted = `.${host}`;
  if (mainnet && (dotted.includes(".dev.") || host.includes("digik"))) return "devnet";
  if (!mainnet && (dotted.includes(".main.") || host.includes("zkpc"))) return "mainnet";
  return null;
}

/** Why a refusal applies: SPEC §8's prod-like (every "prod" refusal of the ramp means prod-like). */
const PROD_LIKE_WHY = "(APP_ENV=prod, APP_NETWORK=mainnet or RAMP_PROVIDER_MODE=live)";

/** Boot refusals of SPEC §7 (T-D2, T-D6, X12) and the S1 knobs of §13. */
function tokenSideIssues(config: Config, env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  const mainnet = config.isMainnet;
  // Prod-like (C32): RAMP_PROVIDER_MODE=live moves real BYN like APP_ENV=prod does.
  const prodLike = config.isProdLike;
  for (const name of KEYCLOAK_URL_VARS) {
    const raw = str(env[name]);
    if (raw && !isHttpUrl(raw)) issues.push(`${name} is not an absolute http(s) URL`);
  }

  const t = config.tokenCommands;
  for (const [name, value] of [
    ["TOKEN_APP_MAX_PER_CALL", t.maxPerCall],
    ["TOKEN_APP_MAX_PER_DAY", t.maxPerDay],
  ] as const) {
    if (value !== null && value <= 0n) issues.push(`${name} must be a positive decimal amount`);
  }
  if (t.maxPerCall !== null && t.maxPerDay !== null && t.maxPerCall > t.maxPerDay) {
    issues.push("TOKEN_APP_MAX_PER_CALL must be ≤ TOKEN_APP_MAX_PER_DAY");
  }
  // R2b-4: the order scan mints and burns in-flight orders whatever RAMP_ENABLED says, so a
  // configured token-app keeps its caps and its sync with the ramp off too.
  if (prodLike && (t.maxPerCall === null || t.maxPerDay === null)) {
    if (config.ramp.enabled)
      issues.push(
        `RAMP_ENABLED=true when prod-like ${PROD_LIKE_WHY} requires TOKEN_APP_MAX_PER_CALL and TOKEN_APP_MAX_PER_DAY`,
      );
    else if (config.hasTokenApp)
      issues.push(
        `TOKEN_APP_URL when prod-like ${PROD_LIKE_WHY} requires TOKEN_APP_MAX_PER_CALL and TOKEN_APP_MAX_PER_DAY, with RAMP_ENABLED=false too (the order scan still mints and burns)`,
      );
  }
  if (!Number.isInteger(t.syncSec) || (t.syncSec !== 0 && (t.syncSec < 5 || t.syncSec > 3600))) {
    issues.push("TOKEN_APP_SYNC_SEC must be 0 (off) or an integer in 5..3600");
  } else if (t.syncSec === 0 && prodLike && (config.ramp.enabled || config.hasTokenApp)) {
    issues.push(
      config.ramp.enabled
        ? `TOKEN_APP_SYNC_SEC=0 (no token sync) is refused with the ramp enabled when prod-like ${PROD_LIKE_WHY}`
        : `TOKEN_APP_SYNC_SEC=0 (no token sync) is refused with a TOKEN_APP_URL when prod-like ${PROD_LIKE_WHY}, with RAMP_ENABLED=false too`,
    );
  }
  // 168 h is the participant's command dedup window: a re-send after it can mint twice.
  if (
    !Number.isInteger(t.resendMaxAgeHours) ||
    t.resendMaxAgeHours < 1 ||
    t.resendMaxAgeHours > 167
  ) {
    issues.push("TOKEN_APP_RESEND_MAX_AGE_HOURS must be an integer in 1..167");
  }
  for (const [name, value] of [
    ["RAMP_RECON_EVERY_MIN", t.idleSyncMin],
    ["RAMP_TOKEN_CONFIRM_MIN", t.confirmMin],
    ["RAMP_TOKEN_REVIEW_AFTER_MIN", t.reviewAfterMin],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) issues.push(`${name} must be an integer ≥ 1`);
  }
  if (t.reviewAfterMin <= t.confirmMin) {
    issues.push("RAMP_TOKEN_REVIEW_AFTER_MIN must be greater than RAMP_TOKEN_CONFIRM_MIN");
  }

  if (mainnet) {
    const kc = config.tokenApp.keycloak;
    if (config.tokenApp.url && (!kc.url || !kc.clientId || !kc.clientSecret)) {
      issues.push(
        "APP_NETWORK=mainnet: TOKEN_APP_URL requires TOKEN_APP_KEYCLOAK_URL, TOKEN_APP_KEYCLOAK_CLIENT_ID and TOKEN_APP_KEYCLOAK_CLIENT_SECRET (token-app's dedicated client; KEYCLOAK_* is never used for it on mainnet)",
      );
    }
    if (
      kc.clientId &&
      [config.keycloak.clientId, config.walletKeycloak.clientId].includes(kc.clientId)
    ) {
      issues.push(
        "APP_NETWORK=mainnet: TOKEN_APP_KEYCLOAK_CLIENT_ID must be token-app's dedicated client, not KEYCLOAK_CLIENT_ID / WALLET_KEYCLOAK_CLIENT_ID",
      );
    }
    const rk = config.registryKeycloak;
    for (const [prefix, instrument] of [
      ["COLLATERAL", config.collateralInstrument],
      ["REWARDS", config.rewardsInstrument],
    ] as const) {
      if (
        instrument.registryUrl &&
        instrument.registryAuth === "keycloak" &&
        (!rk.url || !rk.clientId || !rk.clientSecret)
      ) {
        issues.push(
          `APP_NETWORK=mainnet: ${prefix}_REGISTRY_AUTH=keycloak requires REGISTRY_KEYCLOAK_URL, _CLIENT_ID and _CLIENT_SECRET (no KEYCLOAK_* fallback on mainnet)`,
        );
      }
    }
    for (const [name, url] of [
      ["TOKEN_APP_URL", config.tokenApp.url],
      ["TOKEN_APP_KEYCLOAK_URL", kc.url ?? ""],
      ["REGISTRY_KEYCLOAK_URL", rk.url ?? ""],
      ["COLLATERAL_REGISTRY_URL", config.collateralInstrument.registryUrl],
      ["REWARDS_REGISTRY_URL", config.rewardsInstrument.registryUrl],
    ] as const) {
      if (url && !/^https:\/\//i.test(url))
        issues.push(`APP_NETWORK=mainnet: ${name} must be https`);
    }
    if (config.rewardsAutoMint) {
      issues.push(
        "REWARDS_AUTO_MINT=true is refused on APP_NETWORK=mainnet (it mints through token-app without an approval; DevNet only)",
      );
    }
  }

  const tripwire: [string, string][] = [
    ["TOKEN_APP_URL", config.tokenApp.url],
    ["TOKEN_APP_KEYCLOAK_URL", config.tokenApp.keycloak.url ?? ""],
    ["REGISTRY_KEYCLOAK_URL", config.registryKeycloak.url ?? ""],
    ["COLLATERAL_REGISTRY_URL", config.collateralInstrument.registryUrl],
    ["REWARDS_REGISTRY_URL", config.rewardsInstrument.registryUrl],
    ...((mainnet
      ? [
          ["ZKPC_LEDGER_API_URL", config.zkpc.ledgerApiUrl],
          ["ZKPC_KEYCLOAK_URL", config.zkpc.keycloakUrl],
        ]
      : [
          ["LEDGER_API_URL", config.ledgerApiUrl],
          ["LEDGER_KEYCLOAK_URL", config.ledgerKeycloak.url ?? ""],
          ["KEYCLOAK_URL", config.keycloak.url],
        ]) as [string, string][]),
  ];
  for (const [name, url] of tripwire) {
    const other = url ? crossNetworkHost(url, mainnet) : null;
    if (other) {
      issues.push(
        `${name} is a ${other} Cantor8 host but APP_NETWORK=${config.appNetwork} (cross-network tripwire)`,
      );
    }
  }

  // A rewards grant credits the rewards instrument from nothing: never the ramp's / the collateral (X12).
  const rewards = config.rewardsInstrument;
  if (rewards.admin && rewards.id) {
    const same = (i: { admin: string; id: string } | null): boolean =>
      Boolean(i && i.admin === rewards.admin && i.id === rewards.id);
    if (same(config.ramp.instrument) || same(config.collateralInstrument)) {
      issues.push(
        "REWARDS_INSTRUMENT_* must not be the ramp / collateral instrument (a reward grant would be an unbacked credit of it)",
      );
    }
  }
  return issues;
}

// ── controls: halts, reconciliation, gates, four-eyes approvals (SPEC §6, §13; stage S4) ──────

/**
 * Boot refusals of SPEC §13 S4 (X11, X12): well-formed operator entries and accounts, sane timers
 * and amounts, a calendar without contradictions; prod-like: every operator declares person and
 * roles, dual control with ≥ 2 approver PERSONS, signed decisions, auto-halt, both gates
 * `enforce`, no reserve tolerance, and a mint daily cap whenever the ramp is enabled.
 */
function controlsIssues(config: Config, env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  const c = config.rampControls;
  const prodLike = config.isProdLike;
  const why = "(APP_ENV=prod, APP_NETWORK=mainnet or RAMP_PROVIDER_MODE=live)";

  issues.push(...parseOperatorEntries(env.ADMIN_OPERATORS).issues);
  const accounts = operatorAccountsFrom(env.ADMIN_OPERATOR_ACCOUNTS);
  issues.push(...accounts.issues);
  const persons = new Set([...config.adminOperatorDetails.values()].map((o) => o.personId));
  for (const person of accounts.accounts.keys())
    if (!persons.has(person))
      issues.push(
        `ADMIN_OPERATOR_ACCOUNTS names ${person}, who is not a person in ADMIN_OPERATORS`,
      );

  for (const [name, value, min] of [
    ["RAMP_APPROVAL_TTL_BDAYS", c.approvalTtlBdays, 1],
    ["RAMP_RECON_MAX_AGE_MIN", c.reconMaxAgeMin, 1],
    ["RAMP_RECON_UNKNOWN_MAX_MIN", c.reconUnknownMaxMin, 1],
    ["RAMP_RESERVE_MAX_AGE_BDAYS", c.reserveMaxAgeBdays, 0],
    ["RAMP_PSP_SETTLE_DAYS", c.pspSettleDays, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < min) issues.push(`${name} must be an integer ≥ ${min}`);
  }
  if (c.approvalTtlBdays > 30) issues.push("RAMP_APPROVAL_TTL_BDAYS must be ≤ 30");
  // A gate needs a run younger than the max age; runs come every RAMP_RECON_EVERY_MIN.
  if (Number.isInteger(c.reconEveryMin) && c.reconMaxAgeMin < c.reconEveryMin)
    issues.push("RAMP_RECON_MAX_AGE_MIN must be ≥ RAMP_RECON_EVERY_MIN (else every gate fails)");
  for (const [name, mode] of [
    ["RAMP_RESERVE_GATE", c.reserveGate],
    ["RAMP_PAYOUT_GATE", c.payoutGate],
  ] as const) {
    if (!(GATE_MODES as readonly string[]).includes(mode))
      issues.push(`${name} must be one of ${GATE_MODES.join(", ")}`);
  }
  for (const [name, value] of [
    ["RAMP_RESERVE_TOLERANCE", c.reserveTolerance],
    ["RAMP_OPERATOR_MONEY_MAX", c.operatorMoneyMax],
    ["RAMP_TREASURY_SURPLUS_MAX", c.treasurySurplusMax],
  ] as const) {
    if (value !== null && value < 0n) issues.push(`${name} must be a non-negative decimal amount`);
  }
  if (c.mintDailyCap !== null && c.mintDailyCap <= 0n)
    issues.push("RAMP_MINT_DAILY_CAP must be a positive decimal amount");
  for (const [name, days] of [
    ["RAMP_BANK_HOLIDAYS", c.bankHolidays],
    ["RAMP_BANK_WORKDAYS", c.bankWorkdays],
  ] as const) {
    for (const d of days)
      if (!isIsoDate(d)) issues.push(`${name} entries must be YYYY-MM-DD: ${d}`);
  }
  for (const d of c.bankWorkdays) {
    if (c.bankHolidays.includes(d))
      issues.push(`${d} is in both RAMP_BANK_HOLIDAYS and RAMP_BANK_WORKDAYS`);
    else if (isIsoDate(d) && ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))
      issues.push(`RAMP_BANK_WORKDAYS lists ${d}, which is not a Saturday or Sunday`);
  }

  if (prodLike) {
    for (const op of config.adminOperatorDetails.values())
      if (!op.declared.person || !op.declared.roles)
        issues.push(
          `ADMIN_OPERATORS entry for ${op.party.slice(0, 24)}… must declare #<personId>@<role>[+<role>] when prod-like ${why}`,
        );
    if (!c.dualControl) issues.push(`RAMP_DUAL_CONTROL=false is refused when prod-like ${why}`);
    const approvers = new Set(
      [...config.adminOperatorDetails.values()]
        .filter((o) => o.roles.includes("approver"))
        .map((o) => o.personId),
    );
    // No operators at all = no admin console; with any, four-eyes needs two approving people.
    if (c.dualControl && config.adminOperatorDetails.size > 0 && approvers.size < 2)
      issues.push(
        `dual control needs at least 2 distinct persons with the approver role in ADMIN_OPERATORS when prod-like ${why}`,
      );
    if (!c.approvalSignatures)
      issues.push(`RAMP_APPROVAL_SIGNATURES=false is refused when prod-like ${why}`);
    if (!c.autoHalt) issues.push(`RAMP_AUTO_HALT=false is refused when prod-like ${why}`);
    if (c.reserveGate !== "enforce")
      issues.push(`RAMP_RESERVE_GATE must be enforce when prod-like ${why}`);
    if (c.payoutGate !== "enforce")
      issues.push(`RAMP_PAYOUT_GATE must be enforce when prod-like ${why}`);
    if (c.reserveTolerance > 0n)
      issues.push(
        `RAMP_RESERVE_TOLERANCE > 0 (an allowed shortfall) is refused when prod-like ${why}`,
      );
    if (config.ramp.enabled && c.mintDailyCap === null)
      issues.push(`RAMP_ENABLED=true requires RAMP_MINT_DAILY_CAP when prod-like ${why}`);
    else if (config.hasTokenApp && c.mintDailyCap === null)
      issues.push(
        `TOKEN_APP_URL requires RAMP_MINT_DAILY_CAP when prod-like ${why}, with RAMP_ENABLED=false too (the order scan still mints)`,
      );
  }
  return issues;
}

// ── compliance: identity, consent, eligibility, monitoring rules, alerts (SPEC §11, §13; stage S7a) ──

const BV_ENTRY_RE = /^(\d{4}-\d{2}-\d{2}):(\d+(?:\.\d{1,2})?)$/;
const RULES_VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** The BV table every deployment starts from (2026: 45 BYN, CoM Res. 651/2025; R14). */
const DEFAULT_BV_TABLE = "2026-01-01:45";

/** `RAMP_BV_TABLE` (`<YYYY-MM-DD>:<BYN>[,…]`, dates ascending) → entries plus what is wrong with it. */
export function parseBvTable(raw: string | undefined): { entries: BvEntry[]; issues: string[] } {
  const entries: BvEntry[] = [];
  const issues: string[] = [];
  for (const item of parseList((raw ?? "").trim() || DEFAULT_BV_TABLE)) {
    const m = BV_ENTRY_RE.exec(item);
    const byn = m ? tryParseAmount(m[2]) : null;
    if (!m || !isIsoDate(m[1]) || byn === null || byn <= 0n) {
      issues.push(`RAMP_BV_TABLE entry is not <YYYY-MM-DD>:<BYN above 0>: ${item.slice(0, 40)}`);
      continue;
    }
    const last = entries[entries.length - 1];
    if (last && last.from >= m[1]) {
      issues.push(`RAMP_BV_TABLE dates must ascend: ${m[1]} follows ${last.from}`);
      continue;
    }
    entries.push({ from: m[1], byn });
  }
  return { entries, issues };
}

/** The base value in force on `day` (a Minsk `YYYY-MM-DD`): the latest entry from on or before it; null = none. */
export function bvOn(table: readonly BvEntry[], day: string): bigint | null {
  let found: bigint | null = null;
  for (const e of table) if (e.from <= day) found = e.byn;
  return found;
}

function complianceFrom(env: NodeJS.ProcessEnv): ComplianceConfig {
  const n = (name: string, fallback: number): number => parseIntOr(env[name], fallback);
  const countries = (raw: string | undefined, fallback = ""): string[] =>
    parseList((raw ?? "").trim() || fallback).map((c) => c.toUpperCase());
  return {
    enabled: str(env.RAMP_COMPLIANCE, "on").toLowerCase() !== "off",
    bvTable: parseBvTable(env.RAMP_BV_TABLE).entries,
    minAge: n("RAMP_MIN_AGE", 18),
    allowedResidence: countries(env.RAMP_ALLOWED_RESIDENCE, "BY"),
    blockedCitizenships: countries(env.RAMP_BLOCKED_CITIZENSHIPS),
    kycRefreshDays: n("RAMP_KYC_REFRESH_DAYS", 30),
    eripAllowCash: parseBool(env.RAMP_ERIP_ALLOW_CASH, true),
    rulesVersion: str(env.RAMP_TM_RULES_VERSION),
    allowUnreachable: parseBool(env.RAMP_TM_ALLOW_UNREACHABLE, false),
    tm: {
      structCount: n("RAMP_TM_STRUCT_COUNT", 3),
      structPct: n("RAMP_TM_STRUCT_PCT", 90),
      ageBv: n("RAMP_TM_AGE_BV", 100),
      thirdPartyBv: n("RAMP_TM_THIRDPARTY_BV", 20),
      unverifiedPayerBv: n("RAMP_TM_UNVERIFIED_PAYER_BV", 100),
      roundtripDays: n("RAMP_TM_ROUNDTRIP_DAYS", 30),
      roundtripBv: n("RAMP_TM_ROUNDTRIP_BV", 50),
      roundtripTradePct: n("RAMP_TM_ROUNDTRIP_TRADE_PCT", 10),
      netoutBv: n("RAMP_TM_NETOUT_BV", 200),
      maxCards30d: n("RAMP_TM_MAX_CARDS_30D", 3),
    },
  };
}

/**
 * The §11.4 review thresholds the configured limits can never reach (M4: a rule that cannot fire
 * is no control). `bv` = the base value in force; the daily and 30-day windows are the limits'
 * rolling RAMP_*_DAILY_MAX / RAMP_*_MONTHLY_MAX. TM-CARDS is not limit-bound (a removed card
 * frees its slot).
 */
export function unreachableRules(
  tm: ComplianceRulesConfig,
  bv: bigint,
  ramp: Pick<RampConfig, "onramp" | "offramp" | "methods">,
): string[] {
  const out: string[] = [];
  const bvs = (count: number): bigint => BigInt(count) * bv;
  const on = ramp.onramp;
  const off = ramp.offramp;
  const count = BigInt(tm.structCount);
  if (count * on.min > on.dailyMax || count * on.max * 100n < BigInt(tm.structPct) * on.dailyMax)
    out.push(
      `TM-STRUCT (${tm.structCount} on-ramps in 24 h reaching ${tm.structPct} % of RAMP_ONRAMP_DAILY_MAX)`,
    );
  if (on.monthlyMax + off.monthlyMax < bvs(tm.ageBv))
    out.push(`TM-AGE (${tm.ageBv} BV of on- and off-ramps in 30 days)`);
  if (on.max < bvs(tm.thirdPartyBv))
    out.push(`TM-THIRDPARTY (a ${tm.thirdPartyBv} BV payment above RAMP_ONRAMP_MAX)`);
  if (ramp.methods.includes("erip") && on.monthlyMax < bvs(tm.unverifiedPayerBv))
    out.push(`payer_unverified (${tm.unverifiedPayerBv} BV of ERIP payments in 30 days)`);
  const windows = BigInt(Math.max(1, Math.ceil(tm.roundtripDays / 30)));
  const byDay = on.dailyMax * BigInt(tm.roundtripDays);
  const byMonth = on.monthlyMax * windows;
  if ((byDay < byMonth ? byDay : byMonth) < bvs(tm.roundtripBv))
    out.push(`TM-ROUNDTRIP (${tm.roundtripBv} BV of on-ramps in ${tm.roundtripDays} days)`);
  if (off.monthlyMax <= bvs(tm.netoutBv))
    out.push(`TM-NETOUT (more than ${tm.netoutBv} BV of net cash-out in 30 days)`);
  return out;
}

/**
 * Boot refusals of SPEC §11 / §13 S7a: well-formed keys and the BV table; prod-like with the ramp
 * on: compliance on, a rules version, an adult minimum age, a base value in force, no per-order
 * limit at or above 1 000 BV nor a monthly one at or above 2 000 BV (the verified-tier and
 * source-of-funds regimes are not implemented), and every rule threshold reachable under the
 * limits unless RAMP_TM_ALLOW_UNREACHABLE=true (M4).
 */
function complianceIssues(config: Config, env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  const c = config.compliance;
  const why = "(APP_ENV=prod, APP_NETWORK=mainnet or RAMP_PROVIDER_MODE=live)";
  const mode = str(env.RAMP_COMPLIANCE, "on").toLowerCase();
  if (mode !== "on" && mode !== "off") issues.push("RAMP_COMPLIANCE must be on or off");
  const table = parseBvTable(env.RAMP_BV_TABLE);
  issues.push(...table.issues);
  for (const [name, value, min, max] of [
    ["RAMP_MIN_AGE", c.minAge, 0, 120],
    ["RAMP_KYC_REFRESH_DAYS", c.kycRefreshDays, 1, 365],
    ["RAMP_TM_STRUCT_COUNT", c.tm.structCount, 2, 1000],
    ["RAMP_TM_STRUCT_PCT", c.tm.structPct, 1, 100],
    ["RAMP_TM_AGE_BV", c.tm.ageBv, 0, 1_000_000],
    ["RAMP_TM_THIRDPARTY_BV", c.tm.thirdPartyBv, 0, 1_000_000],
    ["RAMP_TM_UNVERIFIED_PAYER_BV", c.tm.unverifiedPayerBv, 0, 1_000_000],
    ["RAMP_TM_ROUNDTRIP_DAYS", c.tm.roundtripDays, 1, 365],
    ["RAMP_TM_ROUNDTRIP_BV", c.tm.roundtripBv, 0, 1_000_000],
    ["RAMP_TM_ROUNDTRIP_TRADE_PCT", c.tm.roundtripTradePct, 0, 100],
    ["RAMP_TM_NETOUT_BV", c.tm.netoutBv, 0, 1_000_000],
    ["RAMP_TM_MAX_CARDS_30D", c.tm.maxCards30d, 1, 100],
  ] as const)
    if (!Number.isInteger(value) || value < min || value > max)
      issues.push(`${name} must be an integer in ${min}..${max}`);
  for (const [name, list] of [
    ["RAMP_ALLOWED_RESIDENCE", c.allowedResidence],
    ["RAMP_BLOCKED_CITIZENSHIPS", c.blockedCitizenships],
  ] as const)
    for (const code of list)
      if (!isAlpha2(code)) issues.push(`${name} entry is not an ISO 3166-1 alpha-2 code: ${code}`);
  if (c.rulesVersion && !RULES_VERSION_RE.test(c.rulesVersion))
    issues.push("RAMP_TM_RULES_VERSION must be 1-64 characters of [A-Za-z0-9._-]");

  // R2b-4: whatever RAMP_ENABLED says — the order scan resumes held orders and releases payouts
  // with the ramp off too, and off answers every compliance hold "not held".
  if (config.isProdLike && !c.enabled)
    issues.push(
      `RAMP_COMPLIANCE=off is refused when prod-like ${why}, with RAMP_ENABLED=false too`,
    );
  // Prod-like with the ramp on (no new order is screened while the ramp is off).
  if (!config.isProdLike || !config.ramp.enabled) return issues;
  if (!c.rulesVersion)
    issues.push(`RAMP_TM_RULES_VERSION is required when prod-like with RAMP_ENABLED=true ${why}`);
  if (Number.isInteger(c.minAge) && c.minAge < 18)
    issues.push(`RAMP_MIN_AGE below 18 is refused when prod-like ${why}`);
  const bv = bvOn(table.entries, minskDayOf(new Date()));
  if (table.issues.length === 0 && bv === null)
    issues.push(`RAMP_BV_TABLE has no base value in force today (prod-like ${why})`);
  if (bv === null) return issues;
  for (const [prefix, dir] of [
    ["RAMP_ONRAMP", config.ramp.onramp],
    ["RAMP_OFFRAMP", config.ramp.offramp],
  ] as const) {
    if (dir.max >= 1000n * bv)
      issues.push(
        `${prefix}_MAX at or above 1 000 BV is refused when prod-like ${why}: the verified-tier regime is not implemented`,
      );
    if (dir.monthlyMax >= 2000n * bv)
      issues.push(
        `${prefix}_MONTHLY_MAX at or above 2 000 BV is refused when prod-like ${why}: the source-of-funds regime is not implemented`,
      );
  }
  if (!c.allowUnreachable)
    for (const rule of unreachableRules(c.tm, bv, config.ramp))
      issues.push(
        `${rule} can never fire under the configured limits; lower it or set RAMP_TM_ALLOW_UNREACHABLE=true (prod-like ${why})`,
      );
  return issues;
}

// ── bank rail: accounts, batches, statements (SPEC §10, §13; stage S6) ──────────────────────────

/** `RAMP_BANK_*` keys of SPEC §13 S6. Amounts in 1e-10 units of the fiat (whole kopecks). */
export interface RampBankConfig {
  /**
   * `RAMP_BANK_ACCOUNT_IBAN`: the CLIENT-MONEY account — the only account whose statements are
   * imported, the payer of every payout. The operator's own money may sit in it too (operator_money:
   * the opening balance, top-ups, fee revenue); its own payments out of it are classified
   * `operator_sweep` four-eyes, never past the client liabilities (X7).
   */
  accountIban: string;
  /** `RAMP_BANK_BIC`, `RAMP_BANK_NAME`: its bank. */
  bic: string;
  bankName: string;
  /** `RAMP_BANK_HOLDER_NAME`, `RAMP_BANK_HOLDER_UNP`: its holder (= the operator of record, Decree 367). */
  holderName: string;
  holderUnp: string;
  /** `RAMP_PSP_SETTLEMENT_IBANS`: accounts the acquirer settles from / is prefunded to. */
  pspSettlementIbans: string[];
  /** `RAMP_BANK_PAYOUT_PURPOSE_CODE` (КНП, 40109 — to confirm with the bank). */
  payoutPurposeCode: string;
  /** `RAMP_BANK_PAYOUT_PURPOSE_TEXT` / `RAMP_BANK_REFUND_PURPOSE_TEXT`; `{ref}` = `TO-…`. */
  payoutPurposeText: string;
  refundPurposeText: string;
  /** `RAMP_BANK_ACCOUNT_COOLOFF_HOURS` (24): a new account waits this long before it can be proved. */
  accountCooloffHours: number;
  /** `RAMP_MAX_BANK_ACCOUNTS` (2) non-removed accounts per user. */
  maxAccounts: number;
  /** `RAMP_BANK_FIRST_PAYOUT_MAX` (500): what may be in flight to an account before its first payout completed. */
  firstPayoutMax: bigint;
  /** `RAMP_BANK_NAME_CHECKED` (false): the bank confirmed it refuses name mismatches for individuals (proof `bank_name_check`). */
  nameChecked: boolean;
  /** `RAMP_BANK_MANUAL_PROOF` (false): operators prove accounts by hand (`ramp.bank_account.verify`). */
  manualProof: boolean;
  /** `RAMP_BANK_BATCH_MAX` (500) items per batch. */
  batchMax: number;
  /** `RAMP_BANK_SETTLE_DAYS` (3): business days after submission a debit must show by. */
  settleDays: number;
  /** `RAMP_BANK_UNMATCHED_DAYS` (3): an unmatched line older than this many business days is amber. */
  unmatchedDays: number;
  /** `RAMP_BANK_RETURN_FEE_MAX` (0): how much short of P a return may be (the difference books to bank_fees). */
  returnFeeMax: bigint;
  /** `RAMP_BANK_FEE_MAX`: a debit with no counterparty up to this is a bank fee; null = never auto-booked. */
  feeMax: bigint | null;
  /** `RAMP_BLOCKED_BANK_CODES`: IBAN bank codes refused for user accounts. */
  blockedBankCodes: string[];
}

function ibanListFrom(raw: string | undefined): string[] {
  return parseList(raw).map((v) => normalizeIban(v));
}

function rampBankFrom(env: NodeJS.ProcessEnv): RampBankConfig {
  return {
    accountIban: normalizeIban(str(env.RAMP_BANK_ACCOUNT_IBAN)),
    bic: str(env.RAMP_BANK_BIC).toUpperCase(),
    bankName: str(env.RAMP_BANK_NAME),
    holderName: str(env.RAMP_BANK_HOLDER_NAME),
    holderUnp: str(env.RAMP_BANK_HOLDER_UNP),
    pspSettlementIbans: ibanListFrom(env.RAMP_PSP_SETTLEMENT_IBANS),
    payoutPurposeCode: str(env.RAMP_BANK_PAYOUT_PURPOSE_CODE) || "40109",
    payoutPurposeText: str(env.RAMP_BANK_PAYOUT_PURPOSE_TEXT) || "Выплата по заказу {ref}",
    refundPurposeText: str(env.RAMP_BANK_REFUND_PURPOSE_TEXT) || "Возврат средств по заказу {ref}",
    accountCooloffHours: parseIntOr(env.RAMP_BANK_ACCOUNT_COOLOFF_HOURS, 24),
    maxAccounts: parseIntOr(env.RAMP_MAX_BANK_ACCOUNTS, 2),
    firstPayoutMax: amountOr(env.RAMP_BANK_FIRST_PAYOUT_MAX, "500"),
    nameChecked: parseBool(env.RAMP_BANK_NAME_CHECKED, false),
    manualProof: parseBool(env.RAMP_BANK_MANUAL_PROOF, false),
    batchMax: parseIntOr(env.RAMP_BANK_BATCH_MAX, 500),
    settleDays: parseIntOr(env.RAMP_BANK_SETTLE_DAYS, 3),
    unmatchedDays: parseIntOr(env.RAMP_BANK_UNMATCHED_DAYS, 3),
    returnFeeMax: amountOr(env.RAMP_BANK_RETURN_FEE_MAX, "0"),
    feeMax: optionalAmount(env.RAMP_BANK_FEE_MAX),
    blockedBankCodes: parseList(env.RAMP_BLOCKED_BANK_CODES).map((c) => c.toUpperCase()),
  };
}

const UNP_RE = /^\d{9}$/;
const BANK_TEXT_RE = /^[\p{L}\p{N} .,'"№#()/:{}-]{1,200}$/u;

/**
 * Boot refusals of SPEC §10.1 / §13 S6. Always: well-formed IBANs (mod-97), BIC, UNP, purpose code
 * and texts, sane numbers and whole-kopeck amounts, the client account apart from the PSP accounts.
 * Prod-like with the ramp on (the reserve gate needs statements, S4): the client-money account in
 * full, held by the operator of record (RAMP_BANK_HOLDER_UNP = RAMP_OPERATOR_UNP — Decree 367, B4);
 * with the bank rail offered, an IBAN ownership proof the bank or operators provide (X10). One
 * account serves the operator too: fees are paid from the operator money held in it.
 */
function rampBankIssues(config: Config): string[] {
  const b = config.rampBank;
  const issues: string[] = [];
  const kopeck = 10n ** BigInt(AMOUNT_DECIMALS - config.ramp.fiatDecimals);
  const iban = (name: string, value: string): void => {
    const p = parseByIban(value);
    if (!p.ok) issues.push(`${name} is not a valid Belarusian IBAN (${p.problem})`);
  };
  if (b.accountIban) iban("RAMP_BANK_ACCOUNT_IBAN", b.accountIban);
  for (const v of b.pspSettlementIbans) iban("a RAMP_PSP_SETTLEMENT_IBANS entry", v);
  if (b.bic && !normalizeBic(b.bic)) issues.push("RAMP_BANK_BIC is not a BIC");
  if (b.bic && b.accountIban && b.bic.slice(0, 4) !== b.accountIban.slice(4, 8))
    issues.push(
      "RAMP_BANK_BIC is not the bank of RAMP_BANK_ACCOUNT_IBAN (BIC ≠ the IBAN's bank code)",
    );
  if (b.holderUnp && !UNP_RE.test(b.holderUnp))
    issues.push("RAMP_BANK_HOLDER_UNP must be 9 digits");
  if (b.accountIban && b.pspSettlementIbans.includes(b.accountIban))
    issues.push("RAMP_BANK_ACCOUNT_IBAN must not be one of RAMP_PSP_SETTLEMENT_IBANS");
  if (!/^\d{5}$/.test(b.payoutPurposeCode))
    issues.push("RAMP_BANK_PAYOUT_PURPOSE_CODE must be a 5-digit КНП code");
  for (const [name, text] of [
    ["RAMP_BANK_PAYOUT_PURPOSE_TEXT", b.payoutPurposeText],
    ["RAMP_BANK_REFUND_PURPOSE_TEXT", b.refundPurposeText],
  ] as const) {
    if (!text.includes("{ref}") || !BANK_TEXT_RE.test(text))
      issues.push(
        `${name} must contain {ref} and only letters, digits and . , ' " № # ( ) / : - (≤ 200)`,
      );
  }
  for (const [name, n, min, max] of [
    ["RAMP_BANK_ACCOUNT_COOLOFF_HOURS", b.accountCooloffHours, 0, 720],
    ["RAMP_MAX_BANK_ACCOUNTS", b.maxAccounts, 1, 10],
    ["RAMP_BANK_BATCH_MAX", b.batchMax, 1, 10_000],
    ["RAMP_BANK_SETTLE_DAYS", b.settleDays, 1, 30],
    ["RAMP_BANK_UNMATCHED_DAYS", b.unmatchedDays, 1, 30],
  ] as const) {
    if (!Number.isInteger(n) || n < min || n > max)
      issues.push(`${name} must be an integer in ${min}..${max}`);
  }
  for (const [name, v, positive] of [
    ["RAMP_BANK_FIRST_PAYOUT_MAX", b.firstPayoutMax, true],
    ["RAMP_BANK_RETURN_FEE_MAX", b.returnFeeMax, false],
    ["RAMP_BANK_FEE_MAX", b.feeMax, false],
  ] as const) {
    if (v === null) continue;
    if (v < 0n || (positive && v === 0n) || v % kopeck !== 0n)
      issues.push(
        `${name} must be a ${positive ? "positive" : "non-negative"} amount in whole kopecks`,
      );
  }
  for (const code of b.blockedBankCodes)
    if (!/^[A-Z0-9]{4}$/.test(code))
      issues.push(
        `RAMP_BLOCKED_BANK_CODES entry is not a 4-character bank code: ${code.slice(0, 12)}`,
      );

  const bankRail = config.ramp.payoutRails.includes("bank");
  if (!config.isProdLike || !config.ramp.enabled) return issues;
  if (!bankRail && config.rampControls.reserveGate === "off") return issues;
  const why = "(prod-like with RAMP_ENABLED=true: statements feed the reserve gate, SPEC §10.1)";
  if (!b.accountIban) issues.push(`RAMP_BANK_ACCOUNT_IBAN is required ${why}`);
  if (!b.bic) issues.push(`RAMP_BANK_BIC is required ${why}`);
  if (!b.bankName || !b.holderName)
    issues.push(`RAMP_BANK_NAME and RAMP_BANK_HOLDER_NAME are required ${why}`);
  if (!UNP_RE.test(b.holderUnp)) issues.push(`RAMP_BANK_HOLDER_UNP (9 digits) is required ${why}`);
  else if (b.holderUnp !== config.ramp.operator.unp)
    issues.push(
      `RAMP_BANK_HOLDER_UNP must equal RAMP_OPERATOR_UNP: the operator of record holds the client money (Decree 367) ${why}`,
    );
  if (bankRail && !b.nameChecked && !b.manualProof)
    issues.push(
      "the bank rail needs RAMP_BANK_NAME_CHECKED=true (the bank refuses name mismatches) or RAMP_BANK_MANUAL_PROOF=true when prod-like (X10)",
    );
  if (bankRail && b.accountCooloffHours < 1)
    issues.push(
      "RAMP_BANK_ACCOUNT_COOLOFF_HOURS below 1 is refused prod-like with the bank rail on",
    );
  return issues;
}

// ── screening and freezes (SPEC §11.6, §13; stage S7b) ──
function screeningIssues(c: ScreeningConfig): string[] {
  const issues: string[] = [];
  // ПВК p.57: every client is re-screened at least every 3 months.
  if (!Number.isInteger(c.rescreenDays) || c.rescreenDays < 1 || c.rescreenDays > 90)
    issues.push(
      "RAMP_RESCREEN_DAYS must be an integer from 1 to 90 (re-screens at least every 3 months)",
    );
  if (!Number.isInteger(c.listMaxAgeDays) || c.listMaxAgeDays < 1 || c.listMaxAgeDays > 365)
    issues.push("RAMP_SCREENING_LIST_MAX_AGE_DAYS must be an integer from 1 to 365");
  return issues;
}
