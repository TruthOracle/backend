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
  // money
  "deposit_in_progress",
  "deposit_attribution_drift",
  "payout_not_found",
  "payout_blocked",
  // kyc
  "kyc_required",
  "kyc_duplicate_identity",
  "kyc_provider_unavailable",
  "webhook_rejected",
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
// Money
// ---------------------------------------------------------------------------------------------

/** CC in 1e-10 units (10 decimals) — see util/money.ts. */
export type Money = bigint;

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

export interface KycProvider {
  readonly name: KycProviderName;
  /** false → `POST /kyc/sessions` answers 503 kyc_provider_unavailable and `GET /kyc.provider` is null. */
  isConfigured(): boolean;
  createSession(
    user: { id: string; email?: string | null },
    applicantId: string | null,
    level: string,
  ): Promise<KycSessionResult>;
  /** null = signature / algorithm rejected. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): KycEvent | null;
  fetchApplicant(applicantId: string): Promise<ApplicantSummary>;
}

// ---------------------------------------------------------------------------------------------
// Ledger / wallet reads (§10)
// ---------------------------------------------------------------------------------------------

export interface LedgerWallet {
  contractId: string;
  owner: string;
  balanceCC: bigint;
  depositedCC: bigint;
  withdrawnCC: bigint;
  /** `UserWallet.depositRefs : [Text]` — every txRef already credited; the confirm pass keys on it (§8.3). */
  depositRefs: string[];
}

export interface PendingPayoutRecord {
  contractId: string;
  /** Field names mirror truthoracle-contracts (PendingPayout) — the payee is `user`. */
  user: string;
  marketId: string;
  amountCC: bigint;
  reason: string;
  createdAt: Date | null;
}

/** One Enterprise Wallet history row (transfer payload; swaps carry no instrumentId). */
export interface TransferRow {
  instrumentId?: string;
  status?: string;
  direction?: string;
  partyId?: string;
  partyId2?: string;
  amount?: string | number;
  timestamp?: string;
  commandId?: string;
  [key: string]: unknown;
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
  /** A Canton Coin transfer involving the treasury landed: `{ updateId, direction, counterparty, offset }`. */
  transferSeen: "truthoracle.transfer.seen",
  /** The indexer resynced from an ACS snapshot and lost the updates in between: `{ fromOffset, toOffset, reason }`. */
  indexerGap: "truthoracle.indexer.gap",
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
  | "ledger.resync";

// ---------------------------------------------------------------------------------------------
// Wire shapes (docs/API.md) — money is a 10-dp string, timestamps ISO-8601
// ---------------------------------------------------------------------------------------------

export type ApiMoney = string;

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

export interface ApiLedgerWallet {
  contractId: string;
  owner: string;
  balanceCC: ApiMoney;
  depositedCC: ApiMoney;
  withdrawnCC: ApiMoney;
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
  creditedCC: ApiMoney;
  receivedCC?: ApiMoney;
  ownLedgerWallet: ApiLedgerWallet | null;
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
  amountCC: ApiMoney;
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

export interface ReconcileResult {
  credited: ApiMoney;
  status: "confirmed" | "submitted" | "nothing_outstanding";
  commandId?: string;
  perWallet: { walletId: string; partyId: string; amountCC: ApiMoney }[];
  ledger: ApiLedgerWallet | null;
}

export interface InAppWalletOverview {
  partyId: string | null;
  ledger: ApiLedgerWallet | null;
  wallets: ApiWallet[];
  /** `delta = ledgerDepositedCC − creditedTotalCC`; anything beyond DUST refuses the next reconcile (§8.3). */
  attribution: {
    creditedTotalCC: ApiMoney;
    ledgerDepositedCC: ApiMoney;
    delta: ApiMoney;
  };
  pending: { submitted: number };
  payouts: ApiPayout[];
}

// ---------------------------------------------------------------------------------------------
// Ledger index — wire shapes (docs/API.md "Markets", "Portfolio", "Ledger"; docs/INDEXER.md)
// Daml `Decimal`s (prices, shares, CC) are 10-dp strings like Money; Daml `Int` epoch seconds are
// ISO-8601 strings; durations stay integer seconds; parties are Canton party ids.
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

export const WALLET_ENTRY_KINDS = ["deposit", "credit", "debit", "withdraw"] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

export type LedgerPayoutSettledKind = "mark_paid" | "settle_to_wallet" | "cancelled" | "archived";

export interface ApiResolutionPolicy {
  operatorResolution: boolean;
  sources: string[];
  sourceKeys: { sourceUri: string; publicKey: string }[];
  reporters: string[];
  quorum: number;
  challengeSecs: number;
  bondCC: ApiDecimal;
}

export interface ApiProposal {
  proposer: string;
  proposedOutcome: MarketOutcome;
  proposedAt: string;
  bondCC: ApiDecimal;
  challenger: string | null;
  challengerOutcome: MarketOutcome | null;
  /** `proposedAt + policy.challengeSecs` */
  challengeEndsAt: string;
}

export interface ApiMarket {
  marketId: number;
  contractId: string;
  admin: string;
  question: string;
  imageUrl: string;
  description: string;
  resolutionDescription: string;
  category: string;
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
  accumulatedFeesCC: ApiDecimal;
  prizePoolCC: ApiDecimal;
  totalVolumeCC: ApiDecimal;
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
  /** Offset of the ledger transaction that produced this version. */
  updatedOffset: number;
  createdOffset: number;
  synchronizerId: string | null;
  /** Only on `GET /markets/:id` — the disclosed-contract blob a user-signed trade needs. */
  createdEventBlob?: string | null;
}

/** The market fields a portfolio row is enriched with. */
export interface ApiMarketSummary {
  marketId: number;
  contractId: string;
  question: string;
  imageUrl: string;
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
  /** buy: collateral in · sell / swap: gross CC value · split / merge: CC minted / burned · provide: value increase · redeem: payout · propose / challenge: bond */
  amountCC: ApiDecimal | null;
  /** buy: collateral after fees · sell: proceeds credited · provide: CC debited · withdraw_liquidity: CC credited */
  netCC: ApiDecimal | null;
  /** buy: shares received · sell / swap: shares given · split / merge: pairs · redeem: shares burned · withdraw_liquidity (early static exit): YES shares out */
  shares: ApiDecimal | null;
  /** swap: shares received · withdraw_liquidity (early static exit): NO shares out */
  sharesOut: ApiDecimal | null;
  feeCC: ApiDecimal | null;
  priceBefore: ApiDecimal | null;
  priceAfter: ApiDecimal | null;
  lpTokens: ApiDecimal | null;
  outcome: MarketOutcome | null;
  details: Record<string, unknown>;
  offset: number;
  updateId: string;
  commandId: string | null;
  effectiveAt: string;
}

export interface ApiPricePoint {
  t: string;
  price: ApiDecimal;
  /** Cumulative `totalVolumeCC` of the market at that point. */
  volumeCC: ApiDecimal;
  offset: number;
}

export interface ApiPosition {
  contractId: string;
  holder: string;
  marketId: number;
  yesShares: ApiDecimal;
  noShares: ApiDecimal;
  costBasisCC: ApiDecimal;
  active: boolean;
  createdAt: string;
  createdOffset: number;
  archivedAt: string | null;
  market: ApiMarketSummary | null;
  /** Mark-to-market while Trading (`yes·p + no·(1−p)`), the redeemable amount once settled, null when the market is unknown. */
  valueCC: ApiDecimal | null;
  /** Resolved: winning shares · Voided: `min(costBasis, max(yes, no))` · otherwise null. */
  redeemableCC: ApiDecimal | null;
}

export interface ApiLiquidityPosition {
  contractId: string;
  provider: string;
  marketId: number;
  lpTokens: ApiDecimal;
  depositedCC: ApiDecimal;
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
  kind: WalletEntryKind;
  amountCC: ApiDecimal;
  /** Credit / Debit `reason` (buy, sell, split, merge, liquidity, liquidity-provide, bond, resolve, void-refund, cancel:…, a payout reason); `withdraw`; null for deposits. */
  reason: string | null;
  /** Deposit only: the transfer reference credited. */
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
  balanceCC: ApiDecimal;
  depositedCC: ApiDecimal;
  withdrawnCC: ApiDecimal;
  depositRefs: string[];
  updatedOffset: number;
  updatedAt: string;
}

export interface ApiLedgerPayout {
  contractId: string;
  user: string;
  marketId: number;
  amountCC: ApiDecimal;
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
  offset: number;
  direction: "in" | "out";
  counterparty: string;
  amountCC: ApiDecimal;
  choice: string;
  recordTime: string;
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

export interface ApiStats {
  markets: { total: number; trading: number; proposed: number; resolved: number; voided: number };
  totalVolumeCC: ApiDecimal;
  volume24hCC: ApiDecimal;
  trades: number;
  trades24h: number;
  traders: number;
  indexedOffset: number;
}

export interface ApiLeaderboardEntry {
  party: string;
  volumeCC: ApiDecimal;
  trades: number;
  markets: number;
  /** CC credited back (sell, merge, resolve, void-refund, liquidity) minus CC debited (buy, split, liquidity-provide) over the window. */
  realizedPnlCC: ApiDecimal;
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
