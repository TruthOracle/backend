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
export type IdentityProvider = "google" | "telegram" | "canton_wallet";
export type IdentityStatus = "active" | "unlinked";
export type SessionKind = "user" | "admin";
export type ChallengePurpose = "sign-in" | "link-wallet" | "admin-sign-in";
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
  | "kyc.webhook_replayed";

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
  profile: { name?: string; username?: string; picture?: string; hd?: string };
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

export const CHALLENGE_PURPOSES: readonly ChallengePurpose[] = ["sign-in", "link-wallet", "admin-sign-in"];

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
