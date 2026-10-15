/**
 * Shared domain types, error codes and injection tokens (docs/ARCHITECTURE.md §5, §9.1, §11;
 * docs/API.md shapes). Nothing in here is a Nest provider — barrels under controllers/,
 * services/ and processors/ export classes only, so tokens and interfaces live here.
 */
import type { AppEnv, AppNetwork } from "./config";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Stable machine-readable error codes returned in `{ error, message, details? }` envelopes. */
export const ERROR_CODES = [
  // auth / access
  "unauthenticated",
  "forbidden",
  "csrf_rejected",
  "rate_limited",
  "user_suspended",
  // identities
  "identity_already_linked",
  "identity_unlinked",
  "last_identity",
  "identity_locked_by_kyc",
  "invalid_credential",
  "oidc_failed",
  // wallets / challenges
  "wallet_already_linked",
  "wallet_key_mismatch",
  "signature_invalid",
  "challenge_rejected",
  "challenge_purpose_mismatch",
  "no_primary_wallet",
  "primary_wallet_in_use",
  // money (docs/TOKENS.md §4.3–§4.6)
  "deposit_in_progress",
  "deposit_attribution_drift",
  "payout_not_found",
  "payout_blocked",
  "ledger_stale",
  "insufficient_treasury_holdings",
  "token_app_unconfigured",
  "instrument_unknown",
  "instrument_disabled",
  "instrument_exists",
  // kyc
  "kyc_required",
  "kyc_duplicate_identity",
  "kyc_provider_unavailable",
  "webhook_rejected",
  // markets / orders (docs/MARKETS.md)
  "trading_halted",
  "market_not_tradable",
  "no_in_app_wallet",
  "no_position",
  "insufficient_balance",
  "insufficient_shares",
  "quote_unavailable",
  "catalog_conflict",
  // generic
  "validation_failed",
  "bad_request",
  "not_found",
  "payload_too_large",
  "unsupported_media_type",
  "upstream_failed",
  "not_ready",
  "internal_error",
  // emitted by the Vercel proxy only (never by this process); listed so clients see one union
  "backend_unconfigured",
  "backend_unreachable",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------------------------
// Injection tokens
// ---------------------------------------------------------------------------------------------

/** Bound in AppModule to KycProviderMockService (KYC_PROVIDER=mock) or KycProviderSumsubService. */
export const KYC_PROVIDER = Symbol("KYC_PROVIDER");
/**
 * Lazy lookup used by IdentityService to honour the KYC lock (§6.5) without a constructor-time
 * dependency on KycService. AppModule binds it with `useExisting: KycService`.
 */
export const KYC_LOCK_LOOKUP = Symbol("KYC_LOCK_LOOKUP");

export interface KycLockLookup {
  /** The identity id locked by the user's standing KYC approval, or null. */
  lockedIdentityId(userId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------------------------
// Money and instruments (docs/TOKENS.md §0, §2, §4.1)
// ---------------------------------------------------------------------------------------------

/**
 * An amount of SOME instrument in 1e-10 units (the Daml `Decimal` scale) — see util/money.ts.
 * Never meaningful on its own: every Money value travels next to the `InstrumentId` /
 * `InstrumentRef` it is denominated in (`market.collateral`, `wallet.instrument`,
 * `payout.instrument`).
 */
export type Money = bigint;

/**
 * A CIP-56 instrument id, the same JSON shape as `Splice.Api.Token.HoldingV1.InstrumentId` and
 * truthoracle-v17's `Truthoracle.InstrumentId`: `admin` is the registry party (cBYN: the transfer
 * agent; Canton Coin: the DSO), `id` the token identifier (`cBYN`, `TRO`, `Amulet`). Compared field
 * by field (`sameInstrument`), keyed as `<admin>:<id>` (`instrumentKey`).
 */
export interface InstrumentId {
  admin: string;
  id: string;
}

export const INSTRUMENT_KINDS = ["collateral", "rewards"] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

/** How the backend authenticates to an instrument's CIP-56 registry (docs/TOKENS.md §4.4). */
export const REGISTRY_AUTHS = ["none", "ledger", "keycloak"] as const;
export type RegistryAuth = (typeof REGISTRY_AUTHS)[number];

/** How treasury outbound transfers of an instrument are sent (docs/TOKENS.md §2 decision 6). */
export const TREASURY_TRANSFER_MODES = ["wallet", "registry"] as const;
export type TreasuryTransferMode = (typeof TREASURY_TRANSFER_MODES)[number];

/** The wire form every money-carrying object exposes next to its amounts. */
export interface InstrumentRef extends InstrumentId {
  symbol: string;
  name: string;
  /** Display and withdrawal quantisation only; storage and the wire stay at 10 dp. */
  decimals: number;
}

/** `<admin>:<id>` — the lookup key of an instrument, also the `?instrument=` query form. */
export function instrumentKey(ref: InstrumentId): string {
  return `${ref.admin}:${ref.id}`;
}

export function sameInstrument(a: InstrumentId, b: InstrumentId): boolean {
  return a.admin === b.admin && a.id === b.id;
}

/**
 * `?instrument=<admin>:<id>` → `InstrumentId`, or null when malformed. A Canton party id carries
 * exactly one `::`, so the LAST `:` separates the token id (`DSO::1220…:Amulet`).
 */
export function parseInstrumentKey(raw: string): InstrumentId | null {
  const at = raw.lastIndexOf(":");
  if (at <= 0 || at === raw.length - 1) return null;
  const admin = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!admin || !id || admin.endsWith(":")) return null;
  return { admin, id };
}

// ---------------------------------------------------------------------------------------------
// Users / identities / sessions
// ---------------------------------------------------------------------------------------------

export type UserStatus = "active" | "suspended" | "closed";
export type UserKycStatus = "none" | "pending" | "approved" | "rejected" | "blocked_duplicate";
/**
 * Sign-in providers. Only `google` and `telegram` open or resolve USER accounts (§6.1). A
 * `canton_wallet` identity exists only for operators: `POST /auth/admin` (purpose
 * `admin-sign-in`) creates it and AdminGuard checks it against ADMIN_OPERATORS (§6.8). A user's
 * Cantor8 wallet is a `to_wallets` row linked to the account — never an identity (§8.1).
 */
export type IdentityProvider = "google" | "telegram" | "canton_wallet";
export type IdentityStatus = "active" | "unlinked";
export type SessionKind = "user" | "admin";
export type ChallengePurpose = "link-wallet" | "admin-sign-in";
export type WalletKind = "cantor8" | "loop" | "other";
export type WalletStatus = "active" | "revoked";
export const WALLET_KIND_ALLOWLIST: readonly WalletKind[] = ["cantor8"];

/** What a sign-in method proves; resolved to a user by IdentityService (§6). */
export interface IdentityClaim {
  provider: IdentityProvider;
  subject: string;
  email?: string | null;
  profile?: Record<string, unknown>;
}

export type ActorType = "user" | "admin" | "system";

/** Who performed a state change — recorded on audit rows; never carries PII. */
export interface Actor {
  type: ActorType;
  userId?: string | null;
  sessionId?: string | null;
  ip?: string | null;
}

// ---------------------------------------------------------------------------------------------
// KYC provider abstraction (§9.1)
// ---------------------------------------------------------------------------------------------

export type KycProviderName = "mock" | "sumsub";
export type KycVerificationStatus =
  | "initiated"
  | "pending"
  | "needs_review"
  | "approved"
  | "rejected_retry"
  | "rejected_final"
  | "blocked_duplicate"
  | "expired";
export type KycEventKind = "created" | "pending" | "reviewed" | "onHold" | "reset" | "unknown";
export type KycDocType = "PASSPORT" | "ID_CARD" | "DRIVERS" | "RESIDENCE_PERMIT";

export interface KycEvent {
  applicantId: string;
  externalUserId: string;
  levelName: string;
  kind: KycEventKind;
  answer?: "GREEN" | "RED";
  rejectType?: "RETRY" | "FINAL";
  labels: string[];
  occurredAt: Date;
  sandbox: boolean;
  /** sha256 of the raw body — idempotency key for to_kyc_webhook_events. */
  eventKey: string;
}

/** Applicant data lives in memory for one call only — never logged, stored or sent to Sentry. */
export interface ApplicantSummary {
  answer: "GREEN" | "RED" | null;
  rejectType: "RETRY" | "FINAL" | null;
  labels: string[];
  levelName: string | null;
  sandbox: boolean;
  documents: { docType: string; country: string; number: string; dob?: string | null }[];
  person: {
    firstName: string | null;
    lastName: string | null;
    dob: string | null;
    country: string | null;
  };
}

export interface KycSessionResult {
  accessToken: string;
  expiresAt: Date;
  applicantId?: string;
}

/** `GET /admin/kyc/provider` — the provider's wiring plus a live credential probe; never applicant data. */
export interface KycProviderHealth {
  ok: boolean;
  message: string;
  /** HTTP status the probe got from the provider (null when unreachable or not probed). */
  upstreamStatus: number | null;
  checkedAt: string;
  details: Record<string, unknown>;
}

export interface ApiKycProviderStatus {
  provider: KycProviderName;
  configured: boolean;
  levelName: string;
  enforceWithdrawals: boolean;
  /** Where the vendor must deliver webhooks (behind the app host's `/__backend` relay). */
  webhookPath: string;
  health: KycProviderHealth;
}

export interface KycProvider {
  readonly name: KycProviderName;
  /** false → `POST /kyc/sessions` answers 503 kyc_provider_unavailable and `GET /kyc.provider` is null. */
  isConfigured(): boolean;
  /** Live probe of the credentials / reachability for operators (docs/KYC.md §6); must never return applicant data. */
  healthCheck(): Promise<KycProviderHealth>;
  createSession(
    user: { id: string; email?: string | null },
    applicantId: string | null,
    level: string,
  ): Promise<KycSessionResult>;
  /** null = signature / algorithm rejected. */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): KycEvent | null;
  fetchApplicant(applicantId: string): Promise<ApplicantSummary>;
}

// ---------------------------------------------------------------------------------------------
// Ledger / wallet reads (§10; docs/TOKENS.md §4.3)
// ---------------------------------------------------------------------------------------------

/** One `UserWallet` contract: a party holds one per instrument (truthoracle-v17). */
export interface LedgerWallet {
  contractId: string;
  owner: string;
  instrument: InstrumentId;
  balance: bigint;
  deposited: bigint;
  withdrawn: bigint;
  /** `UserWallet.creditRefs : [Text]` — every deposit txRef AND grant ref already applied, newest first; the confirm passes key on it (§8.3). */
  creditRefs: string[];
  auditObservers: string[];
}

export interface PendingPayoutRecord {
  contractId: string;
  /** Field names mirror truthoracle-contracts (PendingPayout) — the payee is `user`. */
  user: string;
  marketId: string;
  instrument: InstrumentId;
  amount: bigint;
  reason: string;
  createdAt: Date | null;
  auditObservers: string[];
}

/** How a `to_ledger_transfers` row was derived (docs/INDEXER.md §6). */
export const TRANSFER_KINDS = ["token_standard", "amulet"] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

/**
 * One transfer involving the treasury as the ledger index holds it (`to_ledger_transfers`) — the
 * source of every deposit attribution and payout confirmation (docs/TOKENS.md §2 decision 5).
 */
export interface LedgerTransferRecord {
  updateId: string;
  nodeId: number;
  offset: number;
  direction: "in" | "out";
  /** The other party: the sender for `in`, the receiver for `out`. */
  counterparty: string;
  instrument: InstrumentId;
  amount: bigint;
  kind: TransferKind;
  choice: string;
  recordTime: Date | null;
  effectiveAt: Date;
  details: Record<string, unknown>;
}

/** A token-standard `Holding` the treasury can see (`to_ledger_holdings`). */
export interface LedgerHoldingRecord {
  contractId: string;
  owner: string;
  instrument: InstrumentId;
  amount: bigint;
  locked: boolean;
  lockExpiresAt: Date | null;
  createdOffset: number;
  archivedOffset: number | null;
}

export const TRANSFER_INSTRUCTION_STATUSES = ["pending", "completed", "failed"] as const;
export type TransferInstructionStatus = (typeof TRANSFER_INSTRUCTION_STATUSES)[number];

/** A two-step `TransferInstruction` offer the treasury sends or receives (`to_ledger_transfer_instructions`). */
export interface LedgerTransferInstructionRecord {
  contractId: string;
  instrument: InstrumentId;
  sender: string;
  receiver: string;
  amount: bigint;
  executeBefore: Date | null;
  status: TransferInstructionStatus;
  createdOffset: number;
  archivedOffset: number | null;
}

// ---------------------------------------------------------------------------------------------
// Registry, token-app and treasury transfers (docs/TOKENS.md §4.4) — domain shapes the services share
// ---------------------------------------------------------------------------------------------

/** What a CIP-56 registry returns for `transferFactory` / `acceptContext` / `rejectContext` / `withdrawContext`. */
export interface RegistryChoiceContext {
  choiceContextData: Record<string, unknown>;
  disclosedContracts: ApiDisclosedContract[];
}

export interface RegistryTransferFactory {
  factoryId: string;
  /** `self` (direct, lands at once) or `offer` (two-step `TransferInstruction`). */
  transferKind: string;
  choiceContext: RegistryChoiceContext;
}

/** `TreasuryTransferService.transfer` — the one way an instrument leaves the treasury. */
export interface TreasuryTransferRequest {
  instrument: InstrumentId;
  to: string;
  /** 1e-10 units, already quantised to the instrument's decimals by the caller. */
  amount: bigint;
  commandId: string;
  reason: string;
  metadata?: Record<string, string>;
}

export interface TreasuryTransferResult {
  commandId: string;
  mode: TreasuryTransferMode;
  status: string;
}

/**
 * Cantor8 token-app `POST /api/admin/mint|burn`: `amount` is in 1e-10 units and leaves as a
 * decimal string in the instrument's own `decimals` (token-app validates the precision).
 * `instrumentId` is the token id token-app knows (`to_instruments.id`).
 */
export interface TokenAppMintRequest {
  commandId: string;
  instrumentId: string;
  partyId: string;
  amount: bigint;
  decimals: number;
}
export type TokenAppBurnRequest = TokenAppMintRequest;

/** `POST /api/admin/mint-batch|burn-batch`: one instrument, several parties. */
export interface TokenAppBatchRequest {
  commandId: string;
  instrumentId: string;
  decimals: number;
  entries: { partyId: string; amount: bigint }[];
}

export interface TokenAppCommandResult {
  commandId: string;
  status: string;
  raw: Record<string, unknown>;
}

export interface TokenAppBatchResult extends TokenAppCommandResult {
  entryCount: number;
}

/** `GET /data/admin/holdings` item (token-app's own monitor scan, not the ledger index). */
export interface TokenAppHolding {
  contractId: string;
  partyId: string;
  instrumentId: string;
  /** Decimal string as token-app serves it. */
  amount: string;
  locked: boolean;
}

/** `GET /data/admin/mints|burns` item. */
export interface TokenAppRecord {
  commandId: string;
  partyId: string;
  instrumentId: string;
  amount: string;
  updateId: string;
  createdAt: string;
}

export interface TokenAppStatus {
  configured: boolean;
  url: string | null;
  appName: string;
  reachable: boolean;
  raw: Record<string, unknown> | null;
}

/** `POST /admin/instruments/:admin/:id/setup` (docs/TOKENS.md §4.4): what was exercised on the token's factory. */
export interface ApiInstrumentSetupResult {
  instrument: InstrumentRef;
  /** The factory contract the registry named for a self-transfer, and its concrete template. */
  factoryId: string;
  factoryTemplateId: string;
  actions: {
    kind: "autoAccept" | "mintDelegation";
    choice: string;
    commandId: string;
    status: string;
  }[];
}

// ---------------------------------------------------------------------------------------------
// NATS subjects (§10)
// ---------------------------------------------------------------------------------------------

export const NatsSubjects = {
  userCreated: "truthoracle.user.created",
  authLogin: "truthoracle.auth.login",
  authAdminLogin: "truthoracle.auth.admin_login",
  identityLinked: "truthoracle.identity.linked",
  identityUnlinked: "truthoracle.identity.unlinked",
  identityReattached: "truthoracle.identity.reattached",
  walletLinked: "truthoracle.wallet.linked",
  walletUnlinked: "truthoracle.wallet.unlinked",
  walletPrimaryChanged: "truthoracle.wallet.primary_changed",
  depositCredited: "truthoracle.deposit.credited",
  depositDrift: "truthoracle.deposit.drift",
  payoutSettled: "truthoracle.payout.settled",
  payoutBlocked: "truthoracle.payout.blocked",
  payoutFailed: "truthoracle.payout.failed",
  kycSessionStarted: "truthoracle.kyc.session_started",
  kycStatusChanged: "truthoracle.kyc.status_changed",
  kycDuplicateDetected: "truthoracle.kyc.duplicate_detected",
  /** `truthoracle.kyc.webhook.<provider>`, payload `{ eventId }` only. */
  kycWebhook: (provider: KycProviderName): `truthoracle.kyc.webhook.${KycProviderName}` =>
    `truthoracle.kyc.webhook.${provider}`,
  // ── ledger indexer (docs/INDEXER.md) — payloads carry offsets, contract / event ids and party ids only ──
  /** One committed ledger transaction was indexed: `{ updateId, offset, events }`. */
  ledgerTx: "truthoracle.ledger.tx",
  /** A market's current state changed: `{ marketId, offset, cause }`. */
  marketUpdated: "truthoracle.market.updated",
  /** `truthoracle.market.event.<kind>` (buy, sell, swap, …): `{ marketId, eventId, actor, offset }`. */
  marketEvent: (kind: string): `truthoracle.market.event.${string}` =>
    `truthoracle.market.event.${kind}`,
  /** A UserWallet moved: `{ owner, kind, eventId, offset }`. */
  walletEntry: "truthoracle.wallet.entry",
  /** A PendingPayout was created or settled on-ledger: `{ contractId, change, offset }`. */
  ledgerPayoutChanged: "truthoracle.payout.ledger_changed",
  /** A token transfer involving the treasury landed: `{ updateId, nodeId, direction, counterparty, instrument: { admin, id }, kind, offset }`. */
  transferSeen: "truthoracle.transfer.seen",
  /** A `TransferInstruction` addressed to the treasury was accepted: `{ contractId, instrument, offset }`. */
  transferInstructionAccepted: "truthoracle.transfer.instruction_accepted",
  /** The indexer resynced from an ACS snapshot and lost the updates in between: `{ fromOffset, toOffset, reason }`. */
  indexerGap: "truthoracle.indexer.gap",
  // ── market catalog / exchange (docs/MARKETS.md) ──
  /** A series, event or market-metadata row changed: `{ kind: "series" | "event" | "market", ticker }`. */
  catalogChanged: "truthoracle.catalog.changed",
  /** The operator halted or resumed trading: `{ active, reason }`. */
  exchangeHaltChanged: "truthoracle.exchange.halt_changed",
  /** An operator submitted a CreateMarket through the treasury: `{ commandId, ticker, eventTicker, collateral: { admin, id } }`. */
  marketCreateSubmitted: "truthoracle.market.create_submitted",
  // ── instruments, tokens, rewards (docs/TOKENS.md §4.1, §4.6, §4.7) — ids and instrument ids only ──
  /** An instrument row was created or changed: `{ admin, id, enabled }`. */
  instrumentChanged: "truthoracle.instrument.changed",
  /** A reward grant was credited on-ledger: `{ grantId, userId, party, kind, instrument, offset? }`. */
  rewardGranted: "truthoracle.reward.granted",
  /** A grant could not be submitted because the treasury's rewards float is short: `{ grantId, shortfall }`. */
  rewardBlockedFloat: "truthoracle.reward.blocked_float",
  /** Tokens were minted / burned through token-app: `{ commandId, instrument, partyId }`. */
  tokenMinted: "truthoracle.token.minted",
  tokenBurned: "truthoracle.token.burned",
} as const;
export type NatsSubject = `truthoracle.${string}`;

// ---------------------------------------------------------------------------------------------
// Audit actions (§5 to_audit_events)
// ---------------------------------------------------------------------------------------------

export type AuditAction =
  | "user.created"
  | "user.updated"
  | "user.suspended"
  | "user.reinstated"
  | "auth.login"
  | "auth.admin_login"
  | "auth.logout"
  | "auth.login_refused"
  | "session.revoked"
  | "session.revoked_all"
  | "identity.linked"
  | "identity.unlinked"
  | "identity.reattached"
  | "identity.unlinked_signin_refused"
  | "wallet.linked"
  | "wallet.relinked"
  | "wallet.unlinked"
  | "wallet.primary_changed"
  | "deposit.submitted"
  | "deposit.credited"
  | "deposit.failed"
  | "deposit.attribution_drift"
  | "payout.seen"
  | "payout.settled"
  | "payout.blocked"
  | "payout.failed"
  | "payout.admin_override"
  | "payout.requeued"
  | "kyc.session_started"
  | "kyc.status_changed"
  | "kyc.duplicate_detected"
  | "kyc.needs_review"
  | "kyc.admin_override"
  | "kyc.person_transferred"
  | "kyc.webhook_received"
  | "kyc.webhook_replayed"
  | "ledger.resync"
  | "catalog.series_created"
  | "catalog.series_updated"
  | "catalog.event_created"
  | "catalog.event_updated"
  | "catalog.market_metadata_updated"
  | "market.create_submitted"
  | "exchange.halt_changed"
  // instruments, tokens, rewards (docs/TOKENS.md §4.1, §4.6, §4.7)
  | "instrument.created"
  | "instrument.updated"
  | "token.mint"
  | "token.burn"
  | "token.setup"
  | "reward.rule_updated"
  | "reward.grant_requested"
  | "reward.granted"
  | "reward.failed"
  | "reward.blocked_float";

// ---------------------------------------------------------------------------------------------
// Wire shapes (docs/API.md) — money is a 10-dp string next to its InstrumentRef, timestamps ISO-8601
// ---------------------------------------------------------------------------------------------

export type ApiMoney = string;

/** `GET /exchange/instruments` item and the admin listing (docs/TOKENS.md §4.1). */
export interface ApiInstrument extends InstrumentRef {
  kind: InstrumentKind;
  enabled: boolean;
  isDefaultCollateral: boolean;
  /** What the Cantor8 wallet SDK's `send({ instrumentId })` expects for this token (defaults to `id`). */
  walletInstrumentId: string;
}

/** The operator's view adds the registry / transfer wiring (`GET|POST|PATCH /admin/instruments`). */
export interface ApiAdminInstrument extends ApiInstrument {
  registryUrl: string | null;
  registryAuth: RegistryAuth;
  /** null = the process default (`TREASURY_TRANSFER_MODE`). */
  transferMode: TreasuryTransferMode | null;
  /** Choice names the setup action exercises on the factory (`autoAccept`, `mintDelegation`). */
  setupChoices: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ApiUser {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  status: UserStatus;
  kycStatus: UserKycStatus;
  partyId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ApiIdentity {
  id: string;
  provider: IdentityProvider;
  subject: string;
  email: string | null;
  /** `publicKey` (base64 raw Ed25519) only on an operator's `canton_wallet` identity — the key AdminGuard re-checks against the pin (§6.8). */
  profile: { name?: string; username?: string; picture?: string; hd?: string; publicKey?: string };
  status: IdentityStatus;
  verifiedAt: string;
  lastUsedAt: string | null;
  kycLocked: boolean;
}

/** One on-ledger `UserWallet` (a party holds one per instrument). */
export interface ApiLedgerWallet {
  contractId: string;
  owner: string;
  instrument: InstrumentRef;
  balance: ApiMoney;
  deposited: ApiMoney;
  withdrawn: ApiMoney;
  creditRefs: string[];
}

/** What the backend attributed to a linked wallet in one instrument (`to_wallet_credits`). */
export interface ApiWalletCredit {
  instrument: InstrumentRef;
  /** In-app credits attributed to this wallet (the only attribution there is — §8.3). */
  credited: ApiMoney;
  /** Only in `GET /in-app-wallet`: what the index says this party sent the treasury in the instrument. */
  received?: ApiMoney;
}

export interface ApiWallet {
  id: string;
  chain: "canton";
  kind: WalletKind;
  partyId: string;
  label: string | null;
  isPrimary: boolean;
  status: WalletStatus;
  verifiedAt: string;
  /** One entry per instrument the wallet was ever credited in (empty until the first deposit). */
  credits: ApiWalletCredit[];
  /** A non-primary party's own on-ledger UserWallets (one per instrument), if any. */
  ownLedgerWallets: ApiLedgerWallet[];
}

export interface ApiKycVerification {
  id: string;
  provider: KycProviderName | "admin";
  levelName: string;
  attemptNo: number;
  status: KycVerificationStatus;
  rejectLabels: string[];
  moderationComment: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface ApiKycSummary {
  provider: KycProviderName | null;
  status: UserKycStatus;
  levelName: string;
  requiredForWithdrawal: boolean;
  attachedIdentityId: string | null;
  verification: ApiKycVerification | null;
}

export interface ApiCapabilities {
  canDeposit: boolean;
  canWithdraw: boolean;
  kycRequiredForWithdrawal: boolean;
  primaryPartyId: string | null;
  isAdmin: boolean;
}

export interface ApiSession {
  id: string;
  kind: SessionKind;
  authMethod: IdentityProvider;
  identityId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Every `to_payouts.status` (ARCHITECTURE §5) — the one closed list DTOs and services share. */
export const PAYOUT_STATUSES = [
  "queued",
  "settling",
  "settled_external",
  "settled_in_app",
  "blocked_kyc",
  "blocked_unknown_user",
  "blocked_unknown_reason",
  "blocked_wallet_revoked",
  "failed",
  "archived",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const CHALLENGE_PURPOSES: readonly ChallengePurpose[] = ["link-wallet", "admin-sign-in"];

export interface ApiPayout {
  pendingPayoutCid: string;
  payeeParty: string;
  walletId: string | null;
  instrument: InstrumentRef;
  amount: ApiMoney;
  reason: string;
  status: PayoutStatus;
  retryAfterKyc: boolean;
  attempts: number;
  lastError: string | null;
  firstSeenAt: string;
  settledAt: string | null;
  onLedger: boolean;
}

export interface ApiAuditEvent {
  id: string;
  actorType: ActorType;
  actorUserId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ApiLoginResult {
  mode: "login" | "link";
  user: ApiUser;
  kind: SessionKind;
  expiresAt: string;
  identity: ApiIdentity;
  created: boolean;
  token?: string;
}

export interface ApiSessionState {
  authenticated: boolean;
  kind?: SessionKind;
  user?: ApiUser;
  expiresAt?: string;
}

export interface ApiMe {
  user: ApiUser;
  identities: ApiIdentity[];
  wallets: ApiWallet[];
  kyc: ApiKycSummary;
  capabilities: ApiCapabilities;
}

export interface ApiPage<T> {
  /** Keyset continuation for feeds that accept `cursor=` (`GET …/trades`): pass it back for the next page; null at the end. Absent on page-numbered lists. */
  nextCursor?: string | null;
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export interface ApiChallenge {
  challengeId: string;
  message: string;
  expiresAt: string;
}

/** `POST /in-app-wallet/deposits/reconcile` — one instrument per call (default: the default collateral). */
export interface ReconcileResult {
  instrument: InstrumentRef;
  credited: ApiMoney;
  status: "confirmed" | "submitted" | "nothing_outstanding";
  commandId?: string;
  perWallet: { walletId: string; partyId: string; amount: ApiMoney }[];
  ledger: ApiLedgerWallet | null;
}

/** `delta = ledgerDeposited − creditedTotal`; anything beyond DUST refuses the next reconcile in that instrument (§8.3). */
export interface ApiDepositAttribution {
  creditedTotal: ApiMoney;
  ledgerDeposited: ApiMoney;
  delta: ApiMoney;
}

/** The account's in-app position in one instrument: its UserWallet (null until the first credit) and the attribution behind it. */
export interface ApiInAppBalance {
  instrument: InstrumentRef;
  ledger: ApiLedgerWallet | null;
  attribution: ApiDepositAttribution;
}

/** `GET /in-app-wallet` (docs/TOKENS.md §4.3): one balance row per instrument the account holds a wallet in, plus the default collateral and the rewards instrument even before a wallet exists. */
export interface InAppWalletOverview {
  partyId: string | null;
  wallets: ApiWallet[];
  balances: ApiInAppBalance[];
  pending: { submitted: number };
  payouts: ApiPayout[];
}

// ---------------------------------------------------------------------------------------------
// Ledger index — wire shapes (docs/API.md "Markets", "Portfolio", "Ledger"; docs/INDEXER.md)
// Daml `Decimal`s (prices, shares, amounts) are 10-dp strings like Money; Daml `Int` epoch seconds
// are ISO-8601 strings; durations stay integer seconds; parties are Canton party ids. Every object
// that carries an amount also carries the `InstrumentRef` it is in (`collateral` on a market,
// `instrument` everywhere else).
// ---------------------------------------------------------------------------------------------

/** Daml `Decimal` on the wire — same 10-dp string as Money. */
export type ApiDecimal = string;

export type MarketStatus = "Trading" | "Proposed" | "Resolved" | "Voided";
export type MarketOutcome = "Yes" | "No" | "VoidOutcome";
export type TradeSide = "Yes" | "No";
/** Where a market is in its life, derived from status + clock (mirrors the frontend's `getMarketPhase`). */
export type MarketPhase = "liquidity" | "trading" | "expired" | "proposed" | "resolved" | "voided";

/** Every kind of on-ledger market activity the indexer derives (one per PredictionMarket / MarketCounter choice). */
export const MARKET_EVENT_KINDS = [
  "market_created",
  "buy",
  "sell",
  "swap",
  "split",
  "merge",
  "provide_liquidity",
  "withdraw_liquidity",
  "resolve_t0",
  "resolve",
  "propose",
  "challenge",
  "finalize",
  "void",
  "redeem",
  "commit_forecast",
  "score_and_distribute",
  "archive",
] as const;
export type MarketEventKind = (typeof MARKET_EVENT_KINDS)[number];
/** The kinds that move shares — `GET /markets/:id/trades` and `GET /me/trades` filter on these. */
export const TRADE_KINDS: readonly MarketEventKind[] = ["buy", "sell", "swap", "split", "merge"];

/** One per `UserWallet` choice: Deposit, Grant (rewards / bonuses, docs/TOKENS.md §4.6), Credit, Debit, Withdraw. */
export const WALLET_ENTRY_KINDS = ["deposit", "grant", "credit", "debit", "withdraw"] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

export type LedgerPayoutSettledKind = "mark_paid" | "settle_to_wallet" | "cancelled" | "archived";

export interface ApiResolutionPolicy {
  operatorResolution: boolean;
  sources: string[];
  sourceKeys: { sourceUri: string; publicKey: string }[];
  reporters: string[];
  quorum: number;
  challengeSecs: number;
  /** In the market's collateral. */
  bond: ApiDecimal;
}

export interface ApiProposal {
  proposer: string;
  proposedOutcome: MarketOutcome;
  proposedAt: string;
  bond: ApiDecimal;
  challenger: string | null;
  challengerOutcome: MarketOutcome | null;
  /** `proposedAt + policy.challengeSecs` */
  challengeEndsAt: string;
}

export interface ApiMarket {
  marketId: number;
  /** Kalshi-style identifier, the contract's own (docs/MARKETS.md §2). */
  ticker: string;
  /** The event this market is one leg of, the contract's own; the catalog row always exists (a placeholder when the operator has not written it yet). */
  eventTicker: string;
  /** Through the event's catalog row; null only while that row is a placeholder without a series. */
  seriesTicker: string | null;
  /** The two sides a trader signs for, the contract's own. */
  yesSubTitle: string;
  noSubTitle: string;
  contractId: string;
  /** Package-id template of the active version (what a disclosed contract names); null for rows indexed before MarketCatalog. */
  templateId: string | null;
  admin: string;
  /** The instrument every amount below is denominated in: shares cost ≤ 1 unit and pay 1 unit (docs/TOKENS.md §2). Fixed at creation. */
  collateral: InstrumentRef;
  question: string;
  /** The market's own image when the operator set one (`metadata`), else its event's, else "". Backend-owned, never on the contract (docs/MARKETS.md §1). */
  imageUrl: string;
  /** Backend-owned presentation (`to_market_metadata`); "" without a row. */
  description: string;
  /** The resolution terms — the contract's own. */
  resolutionDescription: string;
  /** The series' category through the event (the contract carries none); "" for a placeholder series. */
  category: string;
  /** The operator's own presentation row, or null when the market shows its event's image — lets a UI tell an override from the fallback. */
  metadata: ApiMarketMetadata | null;
  createdAt: string;
  expiresAt: string;
  /** `createdAt + liquidityPeriodSecs` — trading opens here. */
  tradingStartsAt: string;
  gracePeriodSecs: number;
  isDynamic: boolean;
  liquidityPeriodSecs: number;
  reserveYes: ApiDecimal;
  reserveNo: ApiDecimal;
  liquidityL: ApiDecimal;
  lpTokenSupply: ApiDecimal;
  currentPrice: ApiDecimal;
  feeBps: number;
  prizeFeeShareBps: number;
  accumulatedFees: ApiDecimal;
  prizePool: ApiDecimal;
  totalVolume: ApiDecimal;
  status: MarketStatus;
  outcome: MarketOutcome | null;
  resolvedAt: string | null;
  proposal: ApiProposal | null;
  policy: ApiResolutionPolicy;
  auditObservers: string[];
  phase: MarketPhase;
  /** `ArchiveMarket` (or a plain Archive) consumed the market without a successor version. */
  archived: boolean;
  tradeCount: number;
  lastTradeAt: string | null;
  /** Price 24 h ago (else the first price); null without candles. */
  previousPrice: ApiDecimal | null;
  priceChange24h: ApiDecimal | null;
  volume24h: ApiDecimal;
  openInterest: ApiOpenInterest;
  /** Pool value V(P) at the current effective liquidity — the AMM's "liquidity" figure. */
  liquidity: ApiDecimal;
  /** Implied one-share bid / ask for a reference-sized order; null unless trading. */
  book: ApiImpliedBook | null;
  /** Offset of the ledger transaction that produced this version. */
  updatedOffset: number;
  createdOffset: number;
  synchronizerId: string | null;
  /** Only on `GET /markets/:id` — the disclosed-contract blob a user-signed trade needs. */
  createdEventBlob?: string | null;
  /** Only with `GET /markets?withSparkline=true`: the last 24 hourly closes for a card's mini chart. */
  sparkline?: ApiSparkline;
}
export interface ApiSparkline {
  periodInterval: 60;
  /** Epoch seconds of the first close's period; each later close is one period on. Fewer than 24 for a market younger than a day. */
  startTs: number;
  closes: ApiDecimal[];
}

/** The market fields a portfolio row is enriched with. */
/** `to_market_metadata` on the wire: the operator's presentation for one market (docs/MARKETS.md §1). */
export interface ApiMarketMetadata {
  imageUrl: string;
  description: string;
  updatedAt: string;
}
export interface ApiMarketSummary {
  marketId: number;
  ticker: string;
  eventTicker: string;
  yesSubTitle: string;
  noSubTitle: string;
  contractId: string;
  collateral: InstrumentRef;
  question: string;
  /** Same fallback as `Market.imageUrl` (own, else the event's). */
  imageUrl: string;
  /** The series' category through the event. */
  category: string;
  status: MarketStatus;
  outcome: MarketOutcome | null;
  currentPrice: ApiDecimal;
  expiresAt: string;
  resolvedAt: string | null;
  phase: MarketPhase;
  archived: boolean;
}

export interface ApiMarketEvent {
  id: string;
  eventId: string;
  marketId: number;
  kind: MarketEventKind;
  actor: string;
  side: TradeSide | null;
  /** The market's collateral — what `amount`, `net`, `fee` and `notional` are in. */
  instrument: InstrumentRef;
  /** buy: collateral in · sell / swap: gross value · split / merge: pairs minted / burned · provide: value increase · redeem: payout · propose / challenge: bond */
  amount: ApiDecimal | null;
  /** buy: collateral after fees · sell: proceeds credited · provide: collateral debited · withdraw_liquidity: collateral credited */
  net: ApiDecimal | null;
  /** buy: shares received · sell / swap: shares given · split / merge: pairs · redeem: shares burned · withdraw_liquidity (early static exit): YES shares out */
  shares: ApiDecimal | null;
  /** swap: shares received · withdraw_liquidity (early static exit): NO shares out */
  sharesOut: ApiDecimal | null;
  fee: ApiDecimal | null;
  priceBefore: ApiDecimal | null;
  priceAfter: ApiDecimal | null;
  lpTokens: ApiDecimal | null;
  outcome: MarketOutcome | null;
  details: Record<string, unknown>;
  offset: number;
  updateId: string;
  commandId: string | null;
  effectiveAt: string;
  // ── trade-feed view (Kalshi `GET /markets/trades`), additive on every activity row ──
  /** Stable id of the row (`eventId`). */
  tradeId: string;
  /** The market's ticker (batch-loaded; "" only for a market the index no longer holds). */
  ticker: string;
  /** `buy` / `sell` / `swap` / `split` / `merge` for the pool trades, null for the other kinds. */
  action: TradeAction | null;
  /** The YES price after the trade (`priceAfter`) and its complement; null when the kind moved no price. */
  yesPrice: ApiDecimal | null;
  noPrice: ApiDecimal | null;
  /** Collateral the trade turned over (`amount`). */
  notional: ApiDecimal | null;
  /** The taker, masked (`first 8…last 6` of the party id) — a feed never shows a whole party id. */
  takerParty: string;
  /** `effectiveAt`, the ledger time of the trade. */
  createdAt: string;
}
export const TRADE_ACTIONS = ["buy", "sell", "swap", "split", "merge"] as const;
export type TradeAction = (typeof TRADE_ACTIONS)[number];

export interface ApiPricePoint {
  t: string;
  price: ApiDecimal;
  /** Cumulative `totalVolume` of the market at that point, in its collateral. */
  volume: ApiDecimal;
  offset: number;
}

export interface ApiPosition {
  contractId: string;
  holder: string;
  marketId: number;
  /** The market's collateral; null only when the market is not indexed (then `market` is null too). */
  instrument: InstrumentRef | null;
  yesShares: ApiDecimal;
  noShares: ApiDecimal;
  costBasis: ApiDecimal;
  active: boolean;
  createdAt: string;
  createdOffset: number;
  archivedAt: string | null;
  market: ApiMarketSummary | null;
  /** Mark-to-market while Trading (`yes·p + no·(1−p)`), the redeemable amount once settled, null when the market is unknown. */
  value: ApiDecimal | null;
  /** Resolved: winning shares · Voided: `min(costBasis, max(yes, no))` · otherwise null. */
  redeemable: ApiDecimal | null;
}

export interface ApiLiquidityPosition {
  contractId: string;
  provider: string;
  marketId: number;
  /** The market's collateral; null only when the market is not indexed. */
  instrument: InstrumentRef | null;
  lpTokens: ApiDecimal;
  deposited: ApiDecimal;
  active: boolean;
  createdAt: string;
  createdOffset: number;
  archivedAt: string | null;
  market: ApiMarketSummary | null;
  /** `lpTokens / market.lpTokenSupply`, 10-dp fraction; null without a market. */
  poolShare: ApiDecimal | null;
}

export interface ApiWalletEntry {
  id: string;
  eventId: string;
  owner: string;
  /** The wallet's instrument. */
  instrument: InstrumentRef;
  kind: WalletEntryKind;
  amount: ApiDecimal;
  /** Credit / Debit `reason` (buy, sell, split, merge, liquidity, liquidity-provide, bond, resolve, void-refund, cancel:…, a payout reason); grant: the grant's reason (`<rule kind>`); `withdraw`; null for deposits. */
  reason: string | null;
  /** Deposit: the transfer reference credited · grant: `reward:<grantId>`. */
  txRef: string | null;
  balanceAfter: ApiDecimal | null;
  marketId: number | null;
  /** The market / payout choice this entry was part of (Buy, Sell, SettleToWallet, …); null for a standalone Deposit / Withdraw. */
  rootChoice: string | null;
  walletContractId: string;
  offset: number;
  updateId: string;
  effectiveAt: string;
}

export interface ApiIndexedWallet {
  contractId: string;
  owner: string;
  instrument: InstrumentRef;
  balance: ApiDecimal;
  deposited: ApiDecimal;
  withdrawn: ApiDecimal;
  creditRefs: string[];
  updatedOffset: number;
  updatedAt: string;
}

export interface ApiLedgerPayout {
  contractId: string;
  user: string;
  marketId: number;
  instrument: InstrumentRef;
  amount: ApiDecimal;
  reason: string;
  createdAt: string;
  createdOffset: number;
  active: boolean;
  settledKind: LedgerPayoutSettledKind | null;
  settledAt: string | null;
  settledOffset: number | null;
  txHash: string | null;
  /** CancelPayout only: the amount was re-credited to the in-app wallet. */
  refunded: boolean | null;
}

export interface ApiLedgerTransfer {
  updateId: string;
  nodeId: number;
  offset: number;
  direction: "in" | "out";
  counterparty: string;
  instrument: InstrumentRef;
  amount: ApiDecimal;
  kind: TransferKind;
  choice: string;
  recordTime: string;
}

/** `GET /admin/ledger/holdings` — the treasury's token-standard holdings as indexed. */
export interface ApiLedgerHolding {
  contractId: string;
  owner: string;
  instrument: InstrumentRef;
  amount: ApiDecimal;
  locked: boolean;
  lockExpiresAt: string | null;
  createdOffset: number;
  active: boolean;
}

/** `GET /admin/ledger/transfer-instructions` — two-step offers the treasury sent or received. */
export interface ApiTransferInstruction {
  contractId: string;
  instrument: InstrumentRef;
  sender: string;
  receiver: string;
  amount: ApiDecimal;
  executeBefore: string | null;
  status: TransferInstructionStatus;
  createdOffset: number;
}

export interface ApiAttestation {
  contractId: string;
  attester: string;
  marketId: number;
  sourceUri: string;
  fetchedAt: string;
  outcome: MarketOutcome;
  payloadHash: string;
  hasSourceSignature: boolean;
  responseExcerpt: string | null;
  active: boolean;
  createdOffset: number;
}

export interface ApiModelForecast {
  contractId: string;
  author: string;
  marketId: number;
  modelId: string;
  probabilityYes: ApiDecimal;
  committedAt: string;
  marketPriceAtCommit: ApiDecimal;
  active: boolean;
  createdOffset: number;
}

export interface ApiPredictionModel {
  contractId: string;
  author: string;
  modelId: string;
  name: string;
  description: string;
  payoutParty: string;
  active: boolean;
  createdOffset: number;
}

export interface ApiIndexerGap {
  fromOffset: number;
  toOffset: number;
  reason: string;
  at: string;
}

export interface ApiLedgerStatus {
  enabled: boolean;
  /** This process currently holds the indexer lock and is streaming. */
  running: boolean;
  bootstrapped: boolean;
  bootstrappedAt: string | null;
  bootstrapOffset: number | null;
  /** Last offset applied to the index (every update ≤ this is reflected in the read API). */
  offset: number;
  ledgerEnd: number | null;
  /** `ledgerEnd − offset` (offsets, not seconds); 0 when caught up. */
  lag: number | null;
  prunedOffset: number | null;
  lastUpdateId: string | null;
  lastRecordTime: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  gaps: ApiIndexerGap[];
  updatedAt: string | null;
}

/** `GET /stats` — one instrument per answer (`?instrument=<admin>:<id>`, default the default collateral). */
export interface ApiStats {
  instrument: InstrumentRef;
  markets: { total: number; trading: number; proposed: number; resolved: number; voided: number };
  totalVolume: ApiDecimal;
  volume24h: ApiDecimal;
  trades: number;
  trades24h: number;
  traders: number;
  indexedOffset: number;
}

export interface ApiLeaderboardEntry {
  party: string;
  /** What `volume` and `realizedPnl` are in (the board's instrument). */
  instrument: InstrumentRef;
  volume: ApiDecimal;
  trades: number;
  markets: number;
  /** Collateral credited back (sell, merge, resolve, void-refund, liquidity) minus collateral debited (buy, split, liquidity-provide) over the window. */
  realizedPnl: ApiDecimal;
}

// ---------------------------------------------------------------------------------------------
// Rewards (docs/TOKENS.md §4.6) — TRO grants computed off-ledger from the index
// ---------------------------------------------------------------------------------------------

export const REWARD_RULE_KINDS = [
  "trade_volume_rebate",
  "winning_redeem_bonus",
  "first_deposit_bonus",
  "manual",
] as const;
export type RewardRuleKind = (typeof REWARD_RULE_KINDS)[number];

/**
 * `queued` (written, not yet submitted) → `submitted` (`UserWallet.Grant` sent) → `credited`
 * (`creditRefs` carries `reward:<grantId>`); `failed` (the ledger refused it) or `blocked_float`
 * (the treasury's rewards holdings do not cover Σ in-app balances + the grant) wait for an operator
 * or an auto-mint.
 */
export const REWARD_GRANT_STATUSES = [
  "queued",
  "submitted",
  "credited",
  "failed",
  "blocked_float",
] as const;
export type RewardGrantStatus = (typeof REWARD_GRANT_STATUSES)[number];

/** `to_reward_rules` on the wire (`GET /admin/rewards/rules`, `PUT /admin/rewards/rules/:id`). */
export interface ApiRewardRule {
  id: string;
  kind: RewardRuleKind;
  /** Decimal strings, never numbers: `{ perUnit, minTrade }`, `{ fraction }`, `{ amount }`. */
  params: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `to_reward_grants` on the wire (`GET /me/rewards`, `GET /admin/rewards/grants`). */
export interface ApiRewardGrant {
  id: string;
  userId: string | null;
  party: string;
  ruleId: string | null;
  kind: RewardRuleKind;
  /** The wallet entry / market event the grant was earned on; null for a manual grant. */
  sourceEventId: string | null;
  instrument: InstrumentRef;
  amount: ApiMoney;
  reason: string;
  status: RewardGrantStatus;
  commandId: string | null;
  /** `reward:<grantId>` — what `UserWallet.creditRefs` carries once credited. */
  ref: string;
  error: string | null;
  createdAt: string;
  creditedAt: string | null;
}

/** `GET /me/rewards`. */
export interface ApiRewardsOverview {
  instrument: InstrumentRef;
  wallet: ApiLedgerWallet | null;
  totals: { credited: ApiMoney; queued: ApiMoney };
  grants: ApiRewardGrant[];
}

/** `GET /admin/rewards/float` — the treasury's rewards holdings against what the in-app wallets owe. */
export interface ApiRewardsFloat {
  instrument: InstrumentRef;
  /** Σ of the treasury's active `Holding`s in the rewards instrument (index). */
  treasuryHoldings: ApiMoney;
  /** Σ `UserWallet.balance` in the rewards instrument (index). */
  liabilities: ApiMoney;
  /** Σ amount of grants `submitted` but not yet seen on the ledger — balances the index does not show yet. */
  pending: ApiMoney;
  /** `treasuryHoldings − liabilities − pending`; a grant is only submitted while it covers the grant. */
  headroom: ApiMoney;
}

/** `GET /admin/tokens/status` (docs/TOKENS.md §4.7). */
export interface ApiTokenStatus {
  tokenApp: TokenAppStatus;
  instruments: {
    instrument: InstrumentRef;
    treasuryHoldings: ApiMoney;
    liabilities: ApiMoney;
  }[];
}

/** `POST /admin/tokens/mint` (and `burn`): the token-app command plus the optional in-app credit it funded. */
export interface ApiTokenMintResult {
  commandId: string;
  status: string;
  instrument: InstrumentRef;
  amount: ApiMoney;
  /** The party the tokens were minted to (the treasury unless `to` named another) or burned from. */
  party: string;
  /** Set when `creditUserId` was given: the `UserWallet.Deposit { txRef: "mint:<commandId>" }` that followed the mint. */
  credit: { commandId: string; txRef: string; status: "confirmed" | "submitted" } | null;
}

// ---------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  env: AppEnv;
  network: AppNetwork;
  uptimeSec: number;
  ts: string;
}

export type CheckState = "ok" | "fail";

export interface ReadinessResponse {
  status: "ok" | "degraded";
  checks: { postgres: CheckState; redis: CheckState; nats: CheckState };
  /** Present (true) only while the process is shutting down: the load balancer must stop routing here. */
  draining?: true;
}

// ---------------------------------------------------------------------------------------------
// Market catalog, candles, quotes, orders, exchange status (docs/MARKETS.md; docs/API.md
// "Catalog", "Candlesticks", "Quotes and orders", "Exchange")
// ---------------------------------------------------------------------------------------------

/** Tickers are Kalshi-style: upper-case letters, digits, `.`, `_` and `-`, 2–64 chars, starting alphanumeric. */
export const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;

export type SeriesStatus = "active" | "archived";
export const SERIES_FREQUENCIES = [
  "one_off",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "annual",
  "custom",
] as const;
export type SeriesFrequency = (typeof SERIES_FREQUENCIES)[number];

/** Kalshi-style event lifecycle derived from the member markets (docs/MARKETS.md §3). */
export type EventStatus = "unopened" | "open" | "closed" | "settled";
export const EVENT_STATUS_FILTERS = ["unopened", "open", "closed", "settled", "all"] as const;

export interface ApiSettlementSource {
  name: string;
  url: string;
}

export interface ApiSeries {
  ticker: string;
  title: string;
  category: string;
  frequency: SeriesFrequency;
  tags: string[];
  settlementSources: ApiSettlementSource[];
  contractUrl: string | null;
  description: string;
  status: SeriesStatus;
  productMetadata: Record<string, unknown>;
  /** The instrument the counts and `volume` below are computed over (`?instrument=`, default the default collateral); null when the platform has no collateral configured. */
  instrument: InstrumentRef | null;
  /** Events of the series denominated in `instrument` (events without a market yet count too). */
  eventCount: number;
  /** Member markets in `instrument` across those events. */
  marketCount: number;
  /** Σ `totalVolume` of those markets. */
  volume: ApiDecimal;
  createdAt: string;
  updatedAt: string;
}

export interface ApiEvent {
  ticker: string;
  seriesTicker: string;
  title: string;
  subTitle: string;
  category: string;
  imageUrl: string;
  description: string;
  /** At most one member market resolves Yes — informational for pm-AMM pools, enforced by the resolver (docs/MARKETS.md §2). */
  mutuallyExclusive: boolean;
  strikeDate: string | null;
  strikePeriod: string | null;
  settlementSources: ApiSettlementSource[];
  productMetadata: Record<string, unknown>;
  archived: boolean;
  /** Derived from the member markets' phases. */
  status: EventStatus;
  /** The event's one collateral (fixed by its first market, docs/TOKENS.md §2 decision 9); null until then. Every aggregate below is in it. */
  instrument: InstrumentRef | null;
  marketCount: number;
  /** Σ `totalVolume` of the member markets. */
  volume: ApiDecimal;
  /** Latest `expiresAt` among the member markets; null without markets. */
  closeTime: string | null;
  /** Σ hourly-candle volume of the member markets over the last 24 h (what `sort=trending` ranks by). */
  volume24h: ApiDecimal;
  /** Σ outstanding YES + NO shares across the member markets. */
  openInterest: ApiDecimal;
  /** Σ pool value V(P) at the current effective liquidity across the member markets. */
  liquidity: ApiDecimal;
  /** The likeliest outcome (highest YES price) — what a binary-event card shows; null without markets. */
  topMarket: ApiEventTopMarket | null;
  /** Only with `withNestedMarkets=true` (and always on `GET /events/:ticker`), likeliest outcome first. */
  markets?: ApiMarket[];
  createdAt: string;
  updatedAt: string;
}
export interface ApiEventTopMarket {
  marketId: number;
  ticker: string;
  yesSubTitle: string;
  currentPrice: ApiDecimal;
}
export const EVENT_SORTS = ["trending", "newest", "closing", "volume"] as const;
export type EventSort = (typeof EVENT_SORTS)[number];

/** The implied one-share bid / ask of an AMM pool for a reference-sized order (docs/MARKETS.md §6). */
export interface ApiImpliedBook {
  yesBid: ApiDecimal;
  yesAsk: ApiDecimal;
  noBid: ApiDecimal;
  noAsk: ApiDecimal;
  /** Collateral of the reference buy the book was quoted for. */
  reference: ApiDecimal;
}

export interface ApiOpenInterest {
  yes: ApiDecimal;
  no: ApiDecimal;
  total: ApiDecimal;
}

/** Candle periods, in minutes, as Kalshi names them (`period_interval`): 1, 60, 1440. */
export const CANDLE_PERIOD_MINUTES = [1, 60, 1440] as const;
export type CandlePeriodMinutes = (typeof CANDLE_PERIOD_MINUTES)[number];
export const CANDLE_PERIOD_SECS: readonly number[] = CANDLE_PERIOD_MINUTES.map((m) => m * 60);

export interface ApiCandlePrice {
  open: ApiDecimal;
  high: ApiDecimal;
  low: ApiDecimal;
  close: ApiDecimal;
  /** Volume-weighted mean of the post-trade prices in the period; equals `close` without volume. */
  mean: ApiDecimal;
  /** Close of the previous period (carried forward), null for the first candle. */
  previous: ApiDecimal | null;
}

export interface ApiCandle {
  /** Epoch seconds; `[startTs, endTs)`. */
  startTs: number;
  endTs: number;
  price: ApiCandlePrice;
  /** Collateral traded in the period (Δ `totalVolume`). */
  volume: ApiDecimal;
  /** Pool trades (Buy / Sell / SwapShares) in the period. */
  trades: number;
  /** Outstanding YES + NO shares at the end of the period. */
  openInterest: ApiDecimal;
  liquidityL: ApiDecimal | null;
  /** No market version landed in this period: the candle is carried forward from the previous close. */
  empty: boolean;
}

export interface ApiCandlesticks {
  marketId: number;
  ticker: string;
  /** What every candle's `volume` is in. */
  instrument: InstrumentRef;
  periodInterval: CandlePeriodMinutes;
  startTs: number;
  endTs: number;
  candlesticks: ApiCandle[];
}
/** One market's series on an event chart — the same window and period as every sibling, so the series align by construction. */
export interface ApiEventCandlestickSeries {
  marketId: number;
  ticker: string;
  instrument: InstrumentRef;
  yesSubTitle: string;
  noSubTitle: string;
  status: MarketStatus;
  currentPrice: ApiDecimal;
  candlesticks: ApiCandle[];
}
export interface ApiEventCandlesticks {
  eventTicker: string;
  periodInterval: CandlePeriodMinutes;
  startTs: number;
  endTs: number;
  /** Busiest market (24 h volume) first. */
  markets: ApiEventCandlestickSeries[];
}

export const ORDER_ACTIONS = [
  "buy",
  "sell",
  "swap",
  "split",
  "merge",
  "provide_liquidity",
  "withdraw_liquidity",
  "redeem",
] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];
/** Actions a quote can be produced for (the others are exact: 1 unit of collateral ↔ 1 YES + 1 NO, or a settlement). */
export const QUOTABLE_ACTIONS: readonly OrderAction[] = [
  "buy",
  "sell",
  "swap",
  "provide_liquidity",
];

export interface ApiQuoteBuy {
  action: "buy";
  side: TradeSide;
  /** Collateral in (the `Buy.amount` argument). */
  amount: ApiDecimal;
  fee: ApiDecimal;
  net: ApiDecimal;
  sharesOut: ApiDecimal;
  avgPrice: ApiDecimal;
  priceBefore: ApiDecimal;
  priceAfter: ApiDecimal;
  priceImpact: ApiDecimal;
  /** Payout if the side wins: one unit of collateral per share. */
  maxPayout: ApiDecimal;
}
export interface ApiQuoteSell {
  action: "sell";
  side: TradeSide;
  sharesIn: ApiDecimal;
  gross: ApiDecimal;
  fee: ApiDecimal;
  net: ApiDecimal;
  avgPrice: ApiDecimal;
  priceBefore: ApiDecimal;
  priceAfter: ApiDecimal;
  priceImpact: ApiDecimal;
}
export interface ApiQuoteSwap {
  action: "swap";
  fromSide: TradeSide;
  sharesIn: ApiDecimal;
  feeShares: ApiDecimal;
  sharesOut: ApiDecimal;
  priceBefore: ApiDecimal;
  priceAfter: ApiDecimal;
  priceImpact: ApiDecimal;
}
export interface ApiQuoteLiquidity {
  action: "provide_liquidity";
  valueIncrease: ApiDecimal;
  cost: ApiDecimal;
  lpMinted: ApiDecimal;
  poolShare: ApiDecimal;
  newL: ApiDecimal;
}
export type ApiQuoteBody = ApiQuoteBuy | ApiQuoteSell | ApiQuoteSwap | ApiQuoteLiquidity;

/** The slippage-protected bounds the choice argument must carry (docs/MARKETS.md §6). */
export interface ApiQuoteBounds {
  slippageBps: number;
  minSharesOut?: ApiDecimal;
  minProceeds?: ApiDecimal;
  maxCost?: ApiDecimal;
}

export interface ApiQuote {
  marketId: number;
  ticker: string;
  /** The market's collateral — every amount in `quote` and `bounds` is in it. */
  instrument: InstrumentRef;
  /** The market version the quote was computed against — a trade must exercise this contract. */
  contractId: string;
  updatedOffset: number;
  /** Epoch seconds the quote assumes (`nowSeconds` of the choice). */
  nowSeconds: number;
  phase: MarketPhase;
  effectiveL: ApiDecimal;
  quote: ApiQuoteBody;
  bounds: ApiQuoteBounds;
}

/** A JSON Ledger API v2 ExerciseCommand the user's wallet signs as-is. */
export interface ApiExerciseCommand {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
}

export interface ApiDisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string | null;
}

/** `POST /markets/:id/orders/prepare` — everything a Cantor8 `signAndExecute` needs (docs/MARKETS.md §7). */
export interface ApiPreparedOrder {
  action: OrderAction;
  marketId: number;
  ticker: string;
  /** The party that must sign (the account's primary wallet). */
  actAs: string;
  command: ApiExerciseCommand;
  disclosedContracts: ApiDisclosedContract[];
  quote: ApiQuote | null;
  /** Contracts the command consumes / reads, so the client can show what it signs. */
  inputs: {
    marketContractId: string;
    walletContractId: string | null;
    positionContractId: string | null;
    lpPositionContractId: string | null;
  };
  /** The index offset the inputs were read at; wait on `GET /ledger/wait?offset=` above it after submitting. */
  ledgerOffset: number;
  nowSeconds: number;
  /** The prepared command is only meaningful until then (the choice itself re-checks every rule). */
  expiresAt: string;
}

export interface ApiExchangeHalt {
  active: boolean;
  reason: string | null;
  since: string | null;
  estimatedResumeAt: string | null;
}

/** `GET /exchange/status` (Kalshi's `exchange_active` / `trading_active`, docs/MARKETS.md §8). */
export interface ApiExchangeStatus {
  /** The backend is up and its ledger index is enabled — state changes are being recorded. */
  exchangeActive: boolean;
  /** Trading is permitted: no operator halt. Trades are user-signed on-ledger, so this is what the UI and `orders/prepare` honour. */
  tradingActive: boolean;
  halt: ApiExchangeHalt;
  ledger: {
    indexEnabled: boolean;
    indexRunning: boolean;
    offset: number;
    ledgerEnd: number | null;
    lag: number | null;
    lastRecordTime: string | null;
    lastError: string | null;
    /** The index has not applied anything for longer than `staleAfterSec`. */
    stale: boolean;
  };
  network: AppNetwork;
  packageName: string;
  serverTime: string;
}

/** `POST /admin/markets` — the operator's request to create an on-ledger market inside an event. */
export interface ApiCreateMarketResult {
  commandId: string;
  status: string;
  ticker: string;
  eventTicker: string;
  /** The collateral the market was created in (the request's, else the default collateral). */
  collateral: InstrumentRef;
  /** `MarketCounter.value + 1` at submission — the id the market will carry once indexed. */
  expectedMarketId: number | null;
}
