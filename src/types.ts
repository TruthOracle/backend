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
  // token-app commands (docs/RAMP.md §7; S1)
  "token_app_unauthorized",
  "token_app_forbidden",
  "token_app_invalid_request",
  "token_app_cap",
  "token_command_conflict",
  "token_command_state",
  // fiat ramp (docs/RAMP.md §8)
  "ramp_unavailable",
  "ramp_not_eligible",
  "ramp_limit_exceeded",
  "ramp_quote_changed",
  "ramp_order_open",
  "ramp_order_state",
  "idempotency_key_reused",
  // methods, card cash-out, exposure, rails (SPEC §9, §12.1; S5)
  "ramp_exposure",
  "ramp_card_cashout_limit",
  "ramp_rail_unavailable",
  // controls: halts, gates, four-eyes approvals (SPEC §6, §12.2; S4)
  "ramp_paused",
  "reserve_gate",
  "payout_gate",
  "role_required",
  "approval_pending",
  "approval_not_pending",
  "approval_expired",
  "approval_self",
  "approval_same_person",
  "approval_linked_person",
  "approval_role_required",
  "approval_signature_required",
  "approval_signature_invalid",
  "approval_precondition_changed",
  "approval_failed",
  "ramp_card_state",
  // review group A: a webhook already applied or closed (C31)
  "ramp_event_state",
  // bank rail: accounts, batches, statements (SPEC §10, §12; S6)
  "bank_account_invalid",
  "bank_account_exists",
  "bank_account_limit",
  "bank_account_in_use",
  "recent_auth_required",
  "kyc_identity_unavailable",
  "batch_state",
  "batch_held",
  "batch_export_mismatch",
  "statement_invalid",
  "statement_account",
  "statement_duplicate",
  "statement_continuity",
  "statement_mismatch",
  "bank_line_state",
  // compliance: consent, alerts, exports (SPEC §11, §12; S7a)
  "compliance_alert_state",
  "export_range",
  // screening, freezes (SPEC §11.6; S7b)
  "screening_list_invalid",
  "screening_list_exists",
  "screening_hit_state",
  "screening_hits_open",
  "rescreen_running",
  "freeze_active",
  "freeze_state",
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
  // review F0: the market's status, clock window, policy or attestations refuse the resolution
  "market_not_resolvable",
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
/** Bound in AppModule to the RAMP_PROVIDER adapter (docs/RAMP.md §9); only `mock` exists until the bank is chosen. */
export const RAMP_PROVIDER = Symbol("RAMP_PROVIDER");
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
  /**
   * SPEC §11.1 (S7a): the art.8 identity data the provider holds — every name form, birth place,
   * nationality, residence, address, the identity document — plus any AML screening it exposes.
   * Optional: summaries built in memory elsewhere (the mock submit, fakes) may omit it.
   */
  identity?: ApplicantIdentityData;
}

// ── compliance identity (SPEC §11.1; stage S7a) ──

/** One way the provider writes the applicant's name (original script, or its Latin transliteration). */
export interface ApplicantNameForm {
  firstName: string;
  lastName: string;
  middleName: string | null;
}

/** Countries exactly as the provider gives them (Sumsub: ISO alpha-3); dates `YYYY-MM-DD`. */
export interface ApplicantIdentityData {
  /** Every distinct name form: profile and documents, original script and transliterations. */
  names: ApplicantNameForm[];
  birthPlace: string | null;
  birthCountry: string | null;
  nationality: string | null;
  residenceCountry: string | null;
  address: {
    country: string | null;
    region: string | null;
    city: string | null;
    line: string | null;
  } | null;
  /** The primary identity document (ID card, passport, residence permit, …). */
  document: {
    type: string;
    country: string | null;
    number: string | null;
    /** The personal / identification number (Belarus: идентификационный номер). */
    personalNumber: string | null;
    issuedAt: string | null;
    /** null = termless or unknown. */
    expiresAt: string | null;
  } | null;
  /** AML screening the applicant record itself carries (null = none exposed). */
  aml: ApplicantAmlScreening | null;
}

/** A provider's AML screening result. A flag is null when the provider did not screen it (never false then). */
export interface ApplicantAmlScreening {
  pep: boolean | null;
  sanctions: boolean | null;
  adverseMedia: boolean | null;
  /** The provider's risk labels (Sumsub API names: pep, sanctions, terrorism, crime, adverseMedia, …). */
  labels: string[];
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
  /**
   * SPEC §11.1 (S7a): the applicant's AML screening case, when the provider runs one. null = no
   * case (not screened); throws when unreachable (the identity refresh fails closed).
   */
  fetchAmlScreening?(applicantId: string): Promise<ApplicantAmlScreening | null>;
}

// ---------------------------------------------------------------------------------------------
// Fiat ramp (docs/RAMP.md) — orders and the acquirer abstraction (§9)
// ---------------------------------------------------------------------------------------------

/** Add the bank adapter's name here and to the RAMP_PROVIDER factory (docs/RAMP.md §9). */
export type RampProviderName = "mock";

export const RAMP_DIRECTIONS = ["onramp", "offramp"] as const;
export type RampDirection = (typeof RAMP_DIRECTIONS)[number];

/** How an on-ramp is paid (SPEC §9.2; KROK is out of scope). */
export const RAMP_METHODS = ["card", "erip"] as const;
export type RampMethod = (typeof RAMP_METHODS)[number];
/** Where a cash-out's fiat goes (SPEC §9.3): back to the funding card, or a BYN IBAN (S6). */
export const RAMP_PAYOUT_RAILS = ["card", "bank"] as const;
export type RampPayoutRail = (typeof RAMP_PAYOUT_RAILS)[number];
/** Card cash-out (SPEC §9.3): partial refunds of the card's captures, an OCT, or none. */
export type RampCardCashoutMode = "refund" | "oct" | "none";

/**
 * What the payer does next (SPEC §9.1): the acquirer's hosted page, or an ERIP payment by service
 * code + account number. Validated before it is stored (X15, `rampNextProblem`); never fetched.
 */
export type RampPaymentNext =
  | { kind: "redirect"; url: string }
  | {
      kind: "erip";
      serviceCode: string;
      /** The order's payout-reference digits (12). */
      accountNumber: string;
      /** F as a 10-dp decimal string. */
      amount: string;
      instructions: string[];
      /** Base64 PNG of the payment QR (≤ 64 KB decoded). */
      qrPng?: string;
      qrRaw?: string;
      /** Bank-app links (bePaid `banks[].platform_urls`): scheme ∈ RAMP_DEEPLINK_SCHEMES or https on RAMP_CHECKOUT_HOSTS. */
      deeplinks?: { name: string; url: string }[];
    };

/** What the acquirer can do (SPEC §9.1); RAMP_METHODS must be a subset of `methods`. */
export interface RampProviderCapabilities {
  methods: RampMethod[];
  /** Methods the acquirer refunds itself (ERIP: only after settlement + eripRefundMinHoursAfterSettle). */
  refundMethods: RampMethod[];
  cardCashout: RampCardCashoutMode;
  /** How old a capture may be for a refund (card cash-out uses min(this, RAMP_CARD_REFUND_MAX_DAYS)). */
  cardRefundMaxDays: number;
  /** OCT only to cards issued in RAMP_CARD_PAYOUT_COUNTRIES. */
  payoutDomesticOnly: boolean;
  /** Unpaid checkouts can be voided (`cancelPayment`). */
  cancelPayment: boolean;
  eripRefundMinHoursAfterSettle: number;
  /**
   * The merchant's ERIP service code (null without ERIP): with our reference digits as the account
   * number it re-derives the instructions of an order adopted after a lost create answer (H5, S8).
   */
  eripServiceCode: string | null;
}

/** How an ERIP payment reached the acquirer; `unknown` counts as cash for TM-CASH (X14). */
export type RampPayerChannel = "online" | "cash" | "card" | "unknown";

/**
 * Who paid, as the acquirer reports it (SPEC §9.1). `name` lives in memory for one call: it is
 * sealed before it is stored and handed to the compliance port. Only `nameSource = bank` (the
 * payer's bank) is evidence; a checkout cardholder name never is (§11.4).
 */
export interface RampPayer {
  name?: string | null;
  nameSource: "bank" | "checkout" | null;
  channel: RampPayerChannel;
  bankBic?: string | null;
  /** Keyed blind index of the payer IBAN (purpose `ramp-iban`, `rampIbanIndex`): S6's payer_match proof. */
  ibanHash?: { kid: string; hash: string } | null;
}

/** Every `to_ramp_orders.status` (SPEC §3.2; the migration's CHECK repeats it). */
export const RAMP_ORDER_STATUSES = [
  // on-ramp
  "created",
  "awaiting_payment",
  "paid",
  "minting",
  "crediting",
  // off-ramp
  "awaiting_withdrawal",
  "withdrawing",
  "burning",
  "paying_out",
  "reversing",
  // bank rail: off-ramp payouts AND on-ramp bank refunds (the direction tells them apart)
  "payout_queued",
  "payout_sent",
  // either
  "needs_review",
  "refunding",
  "completed",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "chargeback",
] as const;
export type RampOrderStatus = (typeof RAMP_ORDER_STATUSES)[number];

/** Why an order is in `needs_review` (`review_step`, SPEC §3.2); `details.reviewFrom` says where it was. */
export const RAMP_STEPS = [
  "payment",
  "mint",
  "credit",
  "withdrawal",
  "burn",
  "payout",
  "refund",
  "reversal",
  "compliance",
] as const;
export type RampStep = (typeof RAMP_STEPS)[number];

/**
 * What the acquirer says about a payment. `chargeback` = the issuer took the money back;
 * `chargeback_reversed` = the dispute was won and it came back. Adapters map anything they do not
 * know to `pending`, never `succeeded` (SPEC §9.1).
 */
export type RampPaymentStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled"
  | "refunded"
  | "chargeback"
  | "chargeback_reversed";
export type RampPayoutStatus = "pending" | "succeeded" | "failed";
/** 3-D Secure outcome as the acquirer reports it; only `authenticated` satisfies RAMP_REQUIRE_3DS. */
export type RampThreeDs = "authenticated" | "attempted" | "not_authenticated" | "unknown";
/** `cancelPayment`: voided / too late to void (the user may still pay; ERIP) / already captured (M7). */
export type RampCancelOutcome = "cancelled" | "not_cancellable" | "already_paid";

/** A card as the acquirer describes it after a payment — never a PAN. `token` is sealed before it is stored. */
export interface RampCard {
  token: string;
  fingerprint: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  issuerCountry: string | null;
  issuerName?: string | null;
}

/** `getPayment` — what every transition reads (the webhook only triggers the read). Amounts in 1e-10 units. */
export interface RampPayment {
  paymentId: string;
  /** The merchant reference the acquirer echoes (our order id). */
  orderId: string | null;
  status: RampPaymentStatus;
  method: RampMethod;
  /** F: what the checkout asked for. */
  amount: bigint;
  /** C: what the acquirer captured; null before a capture (C ≠ F is refund-only, SPEC §4.1). */
  capturedAmount: bigint | null;
  /** Σ refunds the acquirer executed on this payment — ours and its own. */
  refundedAmount: bigint;
  /**
   * What a chargeback took back (status `chargeback` / `chargeback_reversed`), when the acquirer
   * reports it; a dispute can only reach what was not refunded (C − refunded), so the books use
   * min(reported, C − refunded) — S8.
   */
  chargebackAmount: bigint | null;
  /** The acquirer's fee for this payment when it reports one (else the accrual rate applies, SPEC §5). */
  fee: bigint | null;
  currency: string;
  threeDs: RampThreeDs;
  card: RampCard | null;
  failureCode: string | null;
  sandbox: boolean;
  /** When the acquirer settled the capture to us (ERIP refunds open `eripRefundMinHoursAfterSettle` later). */
  settledAt: Date | null;
  payer: RampPayer | null;
  /** Card: the retrieval reference number (SPEC §3.1 details.payment, M11). */
  rrn: string | null;
  /** ERIP: the operation number and the accepting agent. */
  erip: { transactionId: string | null; agentCode: string | null; agentName: string | null } | null;
}

export interface RampPayout {
  payoutId: string;
  orderId: string | null;
  status: RampPayoutStatus;
  amount: bigint;
  currency: string;
  failureCode: string | null;
  sandbox: boolean;
  /** The acquirer's fee for this payout when it reports one. */
  fee: bigint | null;
}

/** A refund as the acquirer keeps it, found by the merchant key it was created under (`findRefund`). */
export interface RampRefund {
  refundId: string;
  paymentId: string;
  key: string;
  status: RampPayoutStatus;
  amount: bigint;
  currency: string;
  /** The acquirer's fee for this refund when it charges one (else nothing is accrued). */
  fee: bigint | null;
}

export interface RampCreatePaymentInput {
  orderId: string;
  method: RampMethod;
  /** The order's payout reference (`TO` + 12 digits): ERIP's account number, the card payment's description. */
  reference: string;
  amount: bigint;
  currency: string;
  description: string;
  /** The frontend page the hosted checkout returns to (it only polls; it decides nothing). */
  returnUrl: string;
  notificationUrl: string;
  customer: { userId: string; ip: string | null };
  expiresAt: Date;
  require3ds: boolean;
  /** Ask for a card-on-file token (the closed-loop payout destination). */
  saveCard: boolean;
  /** The merchant reference (bePaid `tracking_id`): the order id. */
  idempotencyKey: string;
}

export interface RampCreatePayoutInput {
  orderId: string;
  amount: bigint;
  currency: string;
  /** The unsealed card token of the destination, held in memory for this call only. */
  cardToken: string;
  /** OCT recipient (bePaid `recipient_billing_address`): the verified identity's Latin name. */
  recipient: { firstName: string; lastName: string };
  /** What the cardholder's statement shows: the order's `TO-…` reference. */
  depositRef?: string;
  /** The order id: the acquirer must refuse a second payout under it. */
  idempotencyKey: string;
  notificationUrl: string;
}

/** A verified webhook, normalised. `eventKey` is stable per delivery so redeliveries are idempotent. */
export interface RampWebhookEvent {
  eventKey: string;
  type: string;
  kind: "payment" | "payout" | "refund" | "chargeback" | "unknown";
  /** The provider's payment or payout id the event is about. */
  objectId: string;
  orderId: string | null;
  occurredAt: Date;
  sandbox: boolean;
}

/**
 * What the receive path knows about a delivery besides its bytes (SPEC §8, §9.1): the media type
 * (JSON or `application/x-www-form-urlencoded`, both captured raw) and the resolved source address
 * (already checked against the allow-list for IP-authenticated providers).
 */
export interface RampWebhookMeta {
  contentType: string;
  sourceIp: string;
}

export type RampProviderHealth = KycProviderHealth;

export interface RampProvider {
  readonly name: RampProviderName;
  readonly capabilities: RampProviderCapabilities;
  /** false → every ramp route answers 503 ramp_unavailable. */
  isConfigured(): boolean;
  healthCheck(): Promise<RampProviderHealth>;
  createPayment(
    input: RampCreatePaymentInput,
  ): Promise<{ paymentId: string; expiresAt: Date; next: RampPaymentNext }>;
  getPayment(paymentId: string): Promise<RampPayment>;
  /**
   * The payment created under `orderId` (the merchant reference), or null when the acquirer has
   * none: how a `created` order whose createPayment answer was lost is adopted (H5). Throws when
   * the acquirer cannot be read — the caller then decides nothing (I7).
   */
  findPaymentByOrder(orderId: string): Promise<RampPayment | null>;
  /** Void an unpaid checkout on cancel and expiry (M7). */
  cancelPayment(paymentId: string): Promise<RampCancelOutcome>;
  /**
   * `amount` = what to refund now (C − already refunded, M4; or one card cash-out part);
   * `idempotencyKey` = the merchant key; `description` = what the cardholder sees (the reference).
   */
  refundPayment(
    paymentId: string,
    amount: bigint,
    idempotencyKey: string,
    description?: string,
  ): Promise<{ refundId: string; status: RampPayoutStatus }>;
  /** The refund created under `key`, or null — asked before EVERY refundPayment (I3: the PSP's key memory is finite). */
  findRefund(paymentId: string, key: string): Promise<RampRefund | null>;
  createPayout(
    input: RampCreatePayoutInput,
  ): Promise<{ payoutId: string; status: RampPayoutStatus }>;
  getPayout(payoutId: string): Promise<RampPayout>;
  /** The payout created under `orderId` (merchant reference), or null — asked before EVERY createPayout (I3, C3). */
  findPayoutByOrder(orderId: string): Promise<RampPayout | null>;
  /** null = signature, timestamp or format rejected. Verifies over the RAW body, JSON or form. */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    meta: RampWebhookMeta,
  ): RampWebhookEvent | null;
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
  // ── fiat ramp (docs/RAMP.md) — order ids, user ids, statuses only ──
  /** `truthoracle.ramp.webhook.<provider>`, payload `{ eventId }` only. */
  rampWebhook: (provider: RampProviderName): `truthoracle.ramp.webhook.${RampProviderName}` =>
    `truthoracle.ramp.webhook.${provider}`,
  /** An order changed status: `{ orderId, userId, direction, from, to }`. */
  rampOrderChanged: "truthoracle.ramp.order_changed",
  /** An order needs an operator: `{ orderId, userId, step, detail }`. */
  rampReviewRequired: "truthoracle.ramp.review_required",
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
  // review F0: an approved ResolveT0 / Resolve / VoidMarket submitted treasury-signed
  | "market.resolution_submitted"
  // … and the ledger rejected it (the wallet reports it FAILED; W9g)
  | "market.resolution_failed"
  | "exchange.halt_changed"
  // instruments, tokens, rewards (docs/TOKENS.md §4.1, §4.6, §4.7)
  | "instrument.created"
  | "instrument.updated"
  | "token.mint"
  | "token.burn"
  | "token.setup"
  // token-app command ledger (docs/RAMP.md §7; S1)
  | "token.command.resent"
  | "token.command.abandoned"
  | "token.command.compensated"
  | "token.records.adopted"
  | "reward.rule_updated"
  | "reward.grant_requested"
  | "reward.granted"
  | "reward.failed"
  | "reward.blocked_float"
  // fiat ramp (docs/RAMP.md)
  | "ramp.order_created"
  | "ramp.order_transition"
  | "ramp.review_required"
  | "ramp.admin_action"
  | "ramp.card_saved"
  | "ramp.card_removed"
  | "ramp.chargeback"
  | "ramp.chargeback_reversed"
  // C19: a dispute won after refund_cancel owes the cancelled bank refund again
  | "ramp.refund_reinstated"
  | "ramp.event_dead"
  | "ramp.webhook_received"
  // controls: halts, reconciliation, four-eyes approvals (SPEC §6; S4)
  | "ramp.controls.halted"
  | "ramp.controls.resumed"
  | "ramp.recon.red"
  | "ramp.payment_method.unblocked"
  | "payout.marked_paid"
  | "admin.approval.requested"
  | "admin.approval.executed"
  | "admin.approval.failed"
  | "admin.approval.rejected"
  | "admin.approval.cancelled"
  | "admin.approval.expired"
  // compliance: identity, consent, alerts (SPEC §11; S7a)
  | "kyc.identity_refreshed"
  | "compliance.consent_given"
  | "compliance.alert_raised"
  | "compliance.alert_decided"
  | "compliance.alerts_exported"
  // review group C: the AML officer opens a consent declaration (C13)
  | "compliance.consent_unsealed"
  // bank rail: accounts, batches, statements (SPEC §10; S6)
  | "ramp.bank_account.added"
  | "ramp.bank_account.removed"
  | "ramp.bank_account.activated"
  | "ramp.bank_account.verified"
  | "ramp.bank_account.blocked"
  | "ramp.bank_account.unblocked"
  | "ramp.bank_account.shared_iban"
  | "ramp.batch.created"
  | "ramp.batch.approved"
  | "ramp.batch.exported"
  | "ramp.batch.submitted"
  | "ramp.batch.cancelled"
  | "ramp.batch.voided"
  // an order left a draft batch (C25: AML returned it; C19: its bank refund was cancelled)
  | "ramp.batch.item_removed"
  | "ramp.statement.imported"
  | "ramp.statement.copy_verified"
  | "ramp.statement.copy_mismatch"
  | "ramp.statement.confirmed"
  | "ramp.bank_line.classified"
  | "ramp.bank.flagged"
  | "ramp.bank.unbooked_debit"
  // screening, freezes, operations export (SPEC §11.6; S7b)
  | "compliance.freeze.created"
  | "compliance.freeze.confirmed"
  | "compliance.freeze.lifted"
  | "compliance.screening.imported"
  | "compliance.screening.rescreened"
  | "compliance.screening.hit"
  | "compliance.screening.decided"
  | "compliance.screening.identity_viewed"
  | "compliance.frozen_activity"
  | "ramp.operations.exported"
  // review group A: an operator replays or closes a dead / unprocessed acquirer webhook (C31)
  | "ramp.event_replayed"
  | "ramp.event_closed";

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
  // a withdrawal of the ramp instrument past max(0, balance − card exposure) (SPEC §9.3, I5; S5) — retried as exposure decays
  "blocked_ramp_exposure",
  // the payee is frozen, or a compliance review holds the cash-out (SPEC §11.5, §11.6; S5) — neutral to the user
  "blocked_compliance",
  // a cash-out's MarkPaid deferred by the payout gate (SPEC §6.4; S4) — retried until the gate passes
  "blocked_payout_gate",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const CHALLENGE_PURPOSES: readonly ChallengePurpose[] = ["link-wallet", "admin-sign-in"];

/**
 * C8 / C11 (I10, no tipping-off): what the PAYEE sees for every internal hold — a freeze, a
 * compliance review, the payout gate. Operators see the real status.
 */
export const USER_PAYOUT_PROCESSING = "processing" as const;
export type ApiPayoutStatus = PayoutStatus | typeof USER_PAYOUT_PROCESSING;

export interface ApiPayout {
  pendingPayoutCid: string;
  payeeParty: string;
  walletId: string | null;
  instrument: InstrumentRef;
  amount: ApiMoney;
  reason: string;
  /** Operators: the `to_payouts.status`; the payee: the same, every internal hold as `processing`. */
  status: ApiPayoutStatus;
  retryAfterKyc: boolean;
  attempts: number;
  lastError: string | null;
  firstSeenAt: string;
  settledAt: string | null;
  onLedger: boolean;
  /** The cash-out order this withdrawal is bound to (only that order may consume it; S4, F2 D11). */
  offrampOrderId?: string | null;
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
    /** Σ in-app wallet balances + Σ live PendingPayouts (owed, still held by the treasury — T-D9). */
    liabilities: ApiMoney;
    /** The PendingPayout part of `liabilities`. */
    pendingPayouts: ApiMoney;
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
  /** `pending` = the Deposit waits for token-app's record of the mint; the token sync submits it (docs/RAMP.md §7). */
  credit: {
    commandId: string;
    txRef: string;
    status: "pending" | "confirmed" | "submitted";
  } | null;
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

// ── review F0: approval-backed market resolution (`/admin/markets/:marketId/resolution`) ──

/** The PredictionMarket choices the four-eyes `market.resolve` submits treasury-signed. */
export const MARKET_RESOLUTION_CHOICES = ["ResolveT0", "Resolve", "VoidMarket"] as const;
export type MarketResolutionChoice = (typeof MARKET_RESOLUTION_CHOICES)[number];
/** The outcome a ResolveT0 request names; `Void` is the contract's `VoidOutcome`. */
export const MARKET_RESOLUTION_OUTCOMES = ["Yes", "No", "Void"] as const;
export type MarketResolutionOutcome = (typeof MARKET_RESOLUTION_OUTCOMES)[number];
/** Request limits: attestations per Resolve, characters of a ResolveT0 `sourceUri`. */
export const MARKET_RESOLUTION_MAX_ATTESTATIONS = 50;
export const MARKET_RESOLUTION_MAX_SOURCE_URI = 2048;

/**
 * `market.resolve`'s precondition: the decision fields only. Never the contract id or the pool
 * figures — a trade re-creates the contract, the market id is the stable subject.
 */
export interface ApiMarketResolutionSnapshot {
  /** Decimal string, the approval's subject. */
  marketId: string;
  ticker: string;
  question: string;
  status: MarketStatus;
  expiresAt: string;
  gracePeriodSecs: number;
  collateral: InstrumentId;
  operatorResolution: boolean;
  sources: string[];
  outcome: MarketOutcome | null;
  /** Resolve only, in request order; null fields = not in the ledger index. */
  attestations?: {
    cid: string;
    outcome: MarketOutcome | null;
    sourceUri: string | null;
    fetchedAt: string | null;
  }[];
}

/** `GET /admin/markets/:marketId/resolution` — every time is ISO-8601 UTC, judged by the backend clock (`asOf`). */
export interface ApiMarketResolution {
  market: Omit<ApiMarketResolutionSnapshot, "attestations" | "collateral"> & {
    collateral: InstrumentRef;
  };
  /** Inclusive bounds: ResolveT0 [resolveT0From, resolveT0To]; Resolve from resolveFrom; VoidMarket from voidFrom. */
  windows: { resolveT0From: string; resolveT0To: string; resolveFrom: string; voidFrom: string };
  /** The choices whose status, window and policy checks pass at `asOf` (Resolve still needs valid attestations). */
  choicesAvailable: MarketResolutionChoice[];
  /** The pending `market.resolve` approval of this market. */
  pending: ApiApproval | null;
  /**
   * The market's latest submitted resolution (its `market.resolution_submitted` /
   * `market.resolution_failed` audit row) and what the wallet says of it now (a ~2 s read;
   * `unknown` when it cannot say); null before any.
   */
  lastSubmission: ApiMarketResolutionSubmission | null;
  /** Every indexed active attestation of the market, judged alone as Resolve's validate judges it. */
  attestations: ApiMarketResolutionAttestation[];
  asOf: string;
}

export interface ApiMarketResolutionSubmission {
  commandId: string;
  choice: MarketResolutionChoice;
  /** ISO-8601 UTC, when it was submitted (or found failed). */
  at: string;
  status: "submitted" | "succeeded" | "failed" | "unknown";
  /** `failed`: the wallet's reason. */
  error: string | null;
}

export interface ApiMarketResolutionAttestation {
  cid: string;
  /** As the index names it. */
  outcome: MarketOutcome;
  sourceUri: string;
  /** ISO-8601 UTC. */
  fetchedAt: string;
  /** Passes Resolve's asserts on the attestation itself (the tiers judge the set). */
  usable: boolean;
  /** The `market_not_resolvable` reason it fails, else null. */
  reason: string | null;
}

/** `market.resolve`'s result once executed (the indexer projects the ledger outcome as usual). */
export interface ApiMarketResolutionResult {
  marketId: string;
  choice: MarketResolutionChoice;
  commandId: string;
  /** What the wallet said within ~15 s: committed (`succeeded`), or no outcome yet (`submitted`). */
  status: "submitted" | "succeeded";
}

// ---------------------------------------------------------------------------------------------
// Fiat ramp wire shapes (docs/RAMP.md §8) — fiat and token amounts are 10-dp strings; 1 BYN = 1 cBYN
// ---------------------------------------------------------------------------------------------

/** A saved card: never the token, never a name. */
export interface ApiRampPaymentMethod {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  issuerCountry: string | null;
  status: "active" | "removed" | "blocked";
  /** Funded a completed, 3DS-authenticated on-ramp of this account: a valid cash-out destination. */
  payoutEligible: boolean;
  /**
   * How a cash-out to this card works and how much it can take now (SPEC §9.3): `refund` = up to
   * what this card's captures can still refund (other cash-outs in flight excluded); `oct` = the
   * balance above the card exposure; `none` = no card cash-out.
   */
  cashout: { mode: RampCardCashoutMode; available: ApiMoney };
  createdAt: string;
  lastUsedAt: string | null;
}

/** `GET /ramp/payment-methods`. */
export interface ApiRampCards {
  cards: ApiRampPaymentMethod[];
}

/** Where a cash-out goes (SPEC §12.1). */
export type ApiRampDestination =
  | { kind: "card"; paymentMethodId: string; brand: string | null; last4: string | null }
  | { kind: "bank"; bankAccountId: string; bankName: string | null; ibanMasked: string };

/** The operator of record stamped on an order (SPEC §9.3, R1). */
export interface RampOperatorSnapshot {
  name: string;
  unp: string;
  htpRef: string;
  termsVersion: string;
}

/** One status change of an order, as the user sees it (compliance review entries are left out). */
export interface ApiRampTimelineEntry {
  status: RampOrderStatus;
  at: string;
}

export interface ApiRampOrder {
  id: string;
  direction: RampDirection;
  status: RampOrderStatus;
  /** `processing` while an operator, a review or a hold has it (one word for every reason: no tipping-off); else null. */
  statusText: string | null;
  /** Why it waits for an operator; null outside `needs_review` and for compliance reviews (SPEC §12.1). */
  reviewStep: RampStep | null;
  /** On-ramp only. */
  method: RampMethod | null;
  /** Off-ramp only. */
  rail: RampPayoutRail | null;
  instrument: InstrumentRef;
  fiatCurrency: string;
  /** On-ramp: what is paid. Off-ramp: what the card or bank account receives. */
  fiatAmount: ApiMoney;
  /** On-ramp: what the in-app wallet is credited. Off-ramp: what the user withdraws. */
  tokenAmount: ApiMoney;
  feeAmount: ApiMoney;
  /** Only while `awaiting_payment`: the hosted page or the ERIP payment details. */
  next: RampPaymentNext | null;
  /** Only while `awaiting_withdrawal`: sign `UserWallet.Withdraw { amount }` on this wallet. */
  withdraw: { walletContractId: string; amount: ApiMoney } | null;
  /** Off-ramp: the card or bank account the fiat goes to. */
  destination: ApiRampDestination | null;
  /** The card that paid an on-ramp. */
  card: { brand: string | null; last4: string | null } | null;
  /** `TO-` + 12 digits: the ERIP account number, the bank transfer's purpose, the refund description. */
  payoutReference: string | null;
  expiresAt: string | null;
  timeline: ApiRampTimelineEntry[];
  operator: { name: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ApiAdminRampOrder extends ApiRampOrder {
  /** The full snapshot (name, UNP, HTP reference, terms version). */
  operator: RampOperatorSnapshot | null;
  userId: string;
  partyId: string;
  provider: string;
  idempotencyKey: string;
  paymentMethodId: string | null;
  pendingPayoutCid: string | null;
  bankAccountId: string | null;
  payoutBatchId: string | null;
  consentId: string | null;
  /** Compliance decisions by point (SPEC §3.1, §11.5). */
  risk: Record<string, unknown>;
  /** The CAS version an approval snapshots (I6); never on the user API. */
  version: number;
  providerPaymentId: string | null;
  providerPayoutId: string | null;
  providerRefundId: string | null;
  capturedAmount: ApiMoney | null;
  capturedAt: string | null;
  refundedAmount: ApiMoney;
  mintCommandId: string | null;
  creditCommandId: string | null;
  burnCommandId: string | null;
  remintCommandId: string | null;
  remintCreditCommandId: string | null;
  attempts: number;
  lastError: string | null;
  details: Record<string, unknown>;
}

export interface ApiRampQuote {
  direction: RampDirection;
  instrument: InstrumentRef;
  fiatCurrency: string;
  fiatAmount: ApiMoney;
  tokenAmount: ApiMoney;
  fee: ApiMoney;
  /** false = an order with these inputs would be refused now; `limit` says which one (F-D7). */
  withinLimits: boolean;
  /** `min | max | daily | monthly | card_cashout | exposure` with its figure. */
  limit: { name: RampLimitName; min?: ApiMoney; max?: ApiMoney; available?: ApiMoney } | null;
}

/** The limit a quote or a create ran into (F1's wire names). */
export type RampLimitName = "min" | "max" | "daily" | "monthly" | "card_cashout" | "exposure";

export interface ApiRampLimits {
  min: ApiMoney;
  max: ApiMoney;
  dailyMax: ApiMoney;
  monthlyMax: ApiMoney;
  dailyRemaining: ApiMoney;
  monthlyRemaining: ApiMoney;
}

/** A fee as basis points of the amount plus a fixed part. */
export interface ApiRampFee {
  bps: number;
  fixed: ApiMoney;
}

/** `GET /ramp` — everything the buy / cash-out panels render (SPEC §12.1). */
export interface ApiRampOverview {
  enabled: boolean;
  /** SPEC §6.1: new orders are halted (an operator's or an automatic halt); never the internal reason. */
  paused: { orders: boolean; reason: null };
  provider: RampProviderName | null;
  /** The operator of record and its terms (R1); null while unconfigured (dev only — refused prod-like). */
  operator: { name: string; termsUrl: string; termsVersion: string } | null;
  /** Whether the user must accept the current terms first (the compliance port answers; S7a). */
  consent: { required: boolean; termsVersion: string; termsUrl: string };
  instrument: InstrumentRef | null;
  fiat: { currency: string; decimals: number };
  methods: { method: RampMethod; ttlMinutes: number; fee: ApiRampFee }[];
  rails: { rail: RampPayoutRail; fee: ApiRampFee; eta: { businessDays: number } }[];
  limits: Record<RampDirection, ApiRampLimits>;
  /** Card value still inside the dispute window, and what may leave other than back to the card now (I5). */
  exposure: { amount: ApiMoney; withdrawableToBank: ApiMoney };
  /** `reasons`: user-facing codes; every compliance reason is the neutral `compliance` (X6, M3). */
  eligibility: Record<RampDirection, { allowed: boolean; reasons: string[] }>;
  openOrders: ApiRampOrder[];
}

export interface ApiRampOnrampResult {
  order: ApiRampOrder;
}

/** `GET /ramp/orders?cursor&limit` (SPEC §12.1). */
export interface ApiRampOrderList {
  orders: ApiRampOrder[];
  nextCursor: string | null;
}

/** The frontend signs `UserWallet.Withdraw { amount }` on `order.withdraw.walletContractId`, then calls attach. */
export interface ApiRampOfframpResult {
  order: ApiRampOrder;
}

/**
 * `POST /ramp/orders/:id/attach` (F6). `bindPending`: the signed withdrawal matched this cash-out
 * but is not bound to it yet — the order still waits for it (`awaiting_withdrawal`): keep it as
 * signed, attach again later, never sign twice. Only a 409 `ramp_order_state` means it is not
 * this order's. `bindReason` (bindPending only): why — `settlement_in_progress`, `in_flight`, a
 * payout hold as the payee sees it (`blocked_kyc`, `blocked_ramp_exposure`, `processing`, …), or
 * `not_bound` when the settlement answered without binding.
 */
export interface ApiRampAttachResult {
  order: ApiRampOrder;
  bindPending: boolean;
  bindReason: string | null;
}

export interface ApiRampJournalLine {
  entryId: string;
  /** The posting's kind (SPEC §5): `onramp.captured`, `offramp.burned`, … */
  kind: string;
  orderId: string | null;
  statementLineId: string | null;
  /** Set on client-liability lines (issuance_pending, customer_liability, payout_clearing). */
  userId: string | null;
  account: string;
  currency: string;
  /** + debit, − credit. */
  amount: ApiMoney;
  createdAt: string;
}

export interface ApiRampEvent {
  id: string;
  type: string;
  kind: string;
  objectId: string;
  sandbox: boolean;
  receivedAt: string;
  processedAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  /** Set after RAMP_EVENT_DEAD_AFTER_HOURS of failure: an operator must look (S4 `events_dead`). */
  deadAt: string | null;
  error: string | null;
}

// ── review group A: the operator's webhook inbox (C31) ──

/** `GET /admin/ramp/events?status=dead|unprocessed` rows: one stored acquirer webhook. */
export interface ApiRampEventRow extends ApiRampEvent {
  provider: string;
  orderId: string | null;
  occurredAt: string;
  lastAttemptAt: string | null;
  /** The last operator replay (its RAMP_EVENT_DEAD_AFTER_HOURS window starts here). */
  replayedAt: string | null;
  /** Closed by a four-eyes `ramp.event.close`: never applied (`processedAt` is set with it). */
  closedAt: string | null;
  closeReason: string | null;
}

export type RampEventListStatus = "dead" | "unprocessed";

/** A token-app command of the order (`to_token_commands`, SPEC §3.4). */
export interface ApiRampTokenCommand {
  commandId: string;
  kind: "mint" | "burn";
  amount: ApiMoney;
  status: string;
  attempts: number;
  lastPostAt: string | null;
  lastError: string | null;
  recordedAt: string | null;
  resolvedBy: string | null;
}

export interface ApiAdminRampOrderDetail {
  order: ApiAdminRampOrder;
  events: ApiRampEvent[];
  journal: ApiRampJournalLine[];
  tokenCommands: ApiRampTokenCommand[];
  audit: ApiAuditEvent[];
  /** Four-eyes approvals of this order, newest first (S4). */
  approvals: ApiApproval[];
}

// ── controls: halts, reconciliation, four-eyes approvals (SPEC §6, §12.2; S4) ──

/** Operator roles (SPEC §6.5): `ops` runs the ramp, `approver` decides four-eyes requests, `aml` alerts, `export` files. */
export const ADMIN_ROLES = ["ops", "approver", "aml", "export"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** `to_ramp_controls.halted_scopes` (SPEC §6.1). */
export const HALT_SCOPES = ["orders", "mints", "payouts"] as const;
export type HaltScope = (typeof HALT_SCOPES)[number];

export const RECON_STATUSES = ["green", "amber", "red", "unknown"] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];
export const RECON_TRIGGERS = ["schedule", "admin", "pre_batch", "sync"] as const;
export type ReconTrigger = (typeof RECON_TRIGGERS)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
  "expired",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** `GET /admin/session` (SPEC §12.2): who the operator is and what they may do. */
export interface ApiAdminSession {
  party: string;
  personId: string;
  roles: AdminRole[];
  /** RAMP_APPROVAL_SIGNATURES: decisions must carry the wallet signature. */
  approvalSignatures: boolean;
  /** RAMP_DUAL_CONTROL: false = requests execute at once (dev / test). */
  dualControl: boolean;
}

/** One reconciliation check's outcome (SPEC §6.2). `figures` are 10-dp strings, counts and ISO times. */
export interface ApiReconCheck {
  name: string;
  status: ReconStatus;
  detail: string | null;
  figures: Record<string, unknown> | null;
  /** What a red (or a long unknown) halts. */
  haltScopes: HaltScope[];
}

export interface ApiReconRun {
  id: string;
  trigger: ReconTrigger;
  startedAt: string;
  finishedAt: string | null;
  status: ReconStatus;
  checks: ApiReconCheck[];
  /** This run set a halt. */
  halted: boolean;
}

/** `GET /admin/ramp/controls` → `{controls}`. */
export interface ApiRampControls {
  haltedScopes: HaltScope[];
  reason: string | null;
  source: "admin" | "auto" | null;
  /** The red checks behind an automatic halt (name, detail). */
  failingChecks: { name: string; detail: string | null }[] | null;
  since: string | null;
  setByUserId: string | null;
  updatedAt: string | null;
}

/**
 * `GET /admin/ramp/reconciliation` (SPEC §6.2): the latest FULL run, whether one is running, the
 * reserve figures the gate uses now (SPEC §6.3) and the journal's balances per account.
 */
export interface ApiRampReconciliation {
  run: ApiReconRun | null;
  running: boolean;
  reserve: Record<string, string | number | boolean | null> | null;
  journal: Record<string, ApiMoney>;
}

/** A four-eyes approval (SPEC §6.5, `to_admin_approvals`). */
export interface ApiApproval {
  id: string;
  action: string;
  subjectType: string;
  subjectId: string;
  params: Record<string, unknown>;
  /** What a signed decision commits to: `truthoracle-approval:<id>:<paramsHash>:<approve|reject>`. */
  paramsHash: string;
  precondition: Record<string, unknown> | null;
  /** The registry's one line on what executing it does. */
  description: string | null;
  reason: string;
  status: ApprovalStatus;
  singleControl: boolean;
  requestedByUserId: string;
  requestedByParty: string;
  requestedByPerson: string;
  requestedAt: string;
  decidedByUserId: string | null;
  decidedByParty: string | null;
  decidedByPerson: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  executedAt: string | null;
  result: unknown;
  error: string | null;
  expiresAt: string;
}

/** An approval-backed route's answer: 202 `{approval}` while pending, 200 `{approval, result}` once executed. */
export interface ApiApprovalOutcome<R = unknown> {
  approval: ApiApproval;
  result?: R;
}

export interface ApiApproveManyResult {
  results: {
    id: string;
    approval?: ApiApproval;
    result?: unknown;
    error?: { error: string; message?: string } | null;
  }[];
}

/** `GET /admin/tokens/commands` item: a `to_token_commands` row (SPEC §3.4). */
export interface ApiAdminTokenCommand {
  commandId: string;
  kind: "mint" | "burn";
  instrumentAdmin: string;
  instrumentId: string;
  partyId: string;
  amount: ApiMoney;
  source: string;
  ref: string | null;
  status: string;
  attempts: number;
  lastPostAt: string | null;
  lastError: string | null;
  lastHttpStatus: number | null;
  updateId: string | null;
  recordedAmount: ApiMoney | null;
  recordedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Screening, freezes, operations export (SPEC §3.4 S7b, §11.6; stage S7b)
// ---------------------------------------------------------------------------------------------

/** Who a freeze answers to (SPEC §3.4): a list hit, a sanctions finding, an AML decision, an operator, a court. */
export const FREEZE_SOURCES = ["screening", "sanctions", "aml", "manual", "court"] as const;
export type FreezeSource = (typeof FREEZE_SOURCES)[number];

/**
 * The lists (B1): the Belarusian list of persons involved in terrorist activity, the UN Security
 * Council list, the Decree No. 48 register of addresses — a hit on these freezes provisionally — and
 * any foreign list (a hit denies new orders, never freezes).
 */
export const SCREENING_LISTS = ["by_terror", "un", "decree48", "foreign"] as const;
export type ScreeningListName = (typeof SCREENING_LISTS)[number];
/** The lists whose hits freeze (Belarusian law: its own list and the UN's, plus the Decree No. 48 register). */
export const FREEZING_LISTS: readonly ScreeningListName[] = ["by_terror", "un", "decree48"];

export const SCREENING_ENTRY_KINDS = ["person", "org", "address"] as const;
export type ScreeningEntryKind = (typeof SCREENING_ENTRY_KINDS)[number];

export const SCREENING_HIT_STATUSES = ["open", "confirmed", "cleared"] as const;
export type ScreeningHitStatus = (typeof SCREENING_HIT_STATUSES)[number];

export type ScreeningRunTrigger = "import" | "schedule" | "admin" | "user";
export type ScreeningRunScope = "full" | "user";
export type ScreeningRunStatus = "running" | "done" | "partial" | "failed";

/**
 * What a hit matched. The list side verbatim (public data); the account side only as the matched
 * name form and how far the birth dates agree — never the account's name (it stays sealed, I4).
 */
export type ScreeningHitMatch =
  | {
      basis: "name";
      entryName: string;
      entryBirthDate: string | null;
      entryIds: string[];
      script: "be" | "ru" | "lat";
      birthDate: "exact" | "partial" | "unknown";
      /**
       * How the forms met (C12): `fold` the exact name keys; `bridge` the be / ru / Latin forms
       * bridged (consonant skeletons, given-name table); `surname_dob` the surname and the exact
       * birth date only (a candidate for the AML officer).
       */
      via?: "fold" | "bridge" | "surname_dob";
    }
  | { basis: "party"; party: string; listed: string }
  /** The principal a consent declares the account acts for (C13; free text, no birth date). */
  | {
      basis: "principal";
      consentId: string;
      entryName: string;
      entryBirthDate: string | null;
      entryIds: string[];
    };

/** `GET /admin/compliance/freezes` item / `POST …` answer (F2's ApiComplianceFreeze, plus the lift facts). */
export interface ApiComplianceFreeze {
  id: string;
  userId: string;
  reason: string;
  source: FreezeSource;
  provisional: boolean;
  active: boolean;
  createdByUserId: string | null;
  createdByPerson: string | null;
  liftApprovalId: string | null;
  liftedByUserId: string | null;
  liftReason: string | null;
  liftedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /admin/compliance/screening-lists` item. */
export interface ApiScreeningList {
  id: string;
  list: ScreeningListName;
  version: string;
  deliveredAt: string;
  importedAt: string;
  importedByPerson: string | null;
  charset: string;
  sha256: string;
  entryCount: number;
}

/** `GET /admin/compliance/screening-hits` item. */
export interface ApiScreeningHit {
  id: string;
  listId: string;
  list: ScreeningListName;
  listVersion: string;
  entryId: string;
  entryKind: ScreeningEntryKind;
  userId: string;
  match: ScreeningHitMatch;
  status: ScreeningHitStatus;
  alertId: string | null;
  freezeId: string | null;
  decidedByPerson: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
}

/** A re-screen as the console shows it. */
export interface ApiScreeningRun {
  id: string;
  trigger: ScreeningRunTrigger;
  scope: ScreeningRunScope;
  userId: string | null;
  status: ScreeningRunStatus;
  listIds: string[];
  startedAt: string;
  finishedAt: string | null;
  subjects: number;
  identities: number;
  parties: number;
  hits: number;
  failures: number;
  /** C44: accounts whose identity could not be read (their parties screened; refused until read). */
  unreadable: number;
  error: string | null;
}

/** `POST /admin/compliance/screening-lists` answer: the stored list and the import's re-screen (null when another re-screen was running — the processor follows up). */
export interface ApiScreeningImport {
  list: ApiScreeningList;
  hits: number | null;
  run: ApiScreeningRun | null;
}

/**
 * `GET /admin/compliance/screening-hits/:id` (role `aml`): the hit and the account's VERIFIED identity — what the
 * AML officer compares with the entry before deciding. `identity` null: no verified identity, or (with
 * `identityError`) it could not be read now.
 */
export interface ApiScreeningHitDetail {
  hit: ApiScreeningHit;
  identity: {
    names: { script: "be" | "ru" | "lat"; last: string; first: string; middle?: string | null }[];
    birthDate: string | null;
    citizenship: string | null;
    residenceCountry: string | null;
  } | null;
  identityError?: string;
}

// ── bank rail: user accounts, payout batches, statements (SPEC §10, §12; S6) ──

export const RAMP_BANK_ACCOUNT_STATUSES = [
  "cooling_off",
  "pending_proof",
  "active",
  "removed",
  "blocked",
] as const;
export type RampBankAccountStatus = (typeof RAMP_BANK_ACCOUNT_STATUSES)[number];
/** How an IBAN was proved to be held in the user's verified name (X10). */
export const RAMP_BANK_PROOFS = ["bank_name_check", "payer_match", "manual"] as const;
export type RampBankProof = (typeof RAMP_BANK_PROOFS)[number];
/** Which verified name form is the beneficiary name (M2). */
export const RAMP_NAME_FORMS = ["be", "ru", "lat"] as const;
export type RampNameForm = (typeof RAMP_NAME_FORMS)[number];

/** `GET /ramp/bank-accounts` → `{accounts}`, `POST` → `{account}` (SPEC §10.2). */
export interface ApiRampBankAccount {
  id: string;
  /** `BY•• •••• … 1234`. */
  ibanMasked: string;
  bankName: string | null;
  bic: string | null;
  /** The verified name in the account's form — every payout's beneficiary name; null when unreadable. */
  holderName: string | null;
  status: RampBankAccountStatus;
  /** When a `cooling_off` account becomes provable (UTC); null otherwise. */
  usableFrom: string | null;
  proof: RampBankProof | null;
}

/** `GET /admin/ramp/bank-accounts` item. */
export interface ApiAdminBankAccount {
  id: string;
  userId: string;
  ibanMasked: string;
  bankCode: string;
  bankName: string | null;
  bic: string | null;
  nameForm: RampNameForm;
  status: RampBankAccountStatus;
  coolingOffUntil: string;
  proof: RampBankProof | null;
  proofRef: string | null;
  verifiedAt: string | null;
  firstPayoutOrderId: string | null;
  lastUsedAt: string | null;
  /** The bank directory's sanctions flags (informational, belarus-legal.md §4). */
  sanctions: { eu: readonly string[]; us: readonly string[]; uk: readonly string[] };
  createdAt: string;
}

export const PAYOUT_BATCH_STATUSES = [
  "draft",
  "approved",
  "exported",
  "submitted",
  "settled",
  "cancelled",
  "voided",
] as const;
export type PayoutBatchStatus = (typeof PAYOUT_BATCH_STATUSES)[number];
export const PAYOUT_ITEM_STATUSES = ["included", "paid", "returned", "voided", "unpaid"] as const;
export type PayoutItemStatus = (typeof PAYOUT_ITEM_STATUSES)[number];

export interface ApiPayoutBatch {
  id: string;
  status: PayoutBatchStatus;
  currency: string;
  itemCount: number;
  totalAmount: ApiMoney;
  createdByUserId: string;
  approvalId: string | null;
  fileFormat: string | null;
  fileSha256: string | null;
  exportedAt: string | null;
  exportedByUserId: string | null;
  exportCount: number;
  submittedAt: string | null;
  submittedByUserId: string | null;
  bankReference: string | null;
  settledAt: string | null;
  voidApprovalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiPayoutBatchItem {
  batchId: string;
  orderId: string;
  /** `payout` = an off-ramp, `refund` = an on-ramp's bank refund. */
  kind: "payout" | "refund";
  documentNo: string;
  amount: ApiMoney;
  status: PayoutItemStatus;
  /** `TO-…`. */
  payoutReference: string;
  userId: string;
  bankAccountId: string;
  ibanMasked: string | null;
  bankName: string | null;
  paidLineId: string | null;
  returnedLineId: string | null;
}

/** `POST /admin/ramp/payout-batches` → the draft and what was left out (and why). */
export interface ApiPayoutBatchDraft {
  batch: ApiPayoutBatch;
  items: ApiPayoutBatchItem[];
  skipped: { orderId: string; reason: string }[];
}

export const BANK_STATEMENT_STATUSES = ["draft", "confirmed", "rejected"] as const;
export type BankStatementStatus = (typeof BANK_STATEMENT_STATUSES)[number];
export const BANK_LINE_STATUSES = ["unmatched", "proposed", "matched"] as const;
export type BankLineStatus = (typeof BANK_LINE_STATUSES)[number];
/**
 * What a statement line was matched as (SPEC §10.4). `refund_return`: an on-ramp bank refund the
 * bank sent back (S8). PSP fee true-ups are a journal kind (`psp.fee`) booked with a settlement.
 */
export const BANK_MATCH_KINDS = [
  "payout",
  "payout_batch",
  "payout_return",
  "refund",
  "refund_return",
  "psp_settlement",
  "psp_funding",
  "bank_fee",
  "operator_topup",
  "operator_sweep",
  "suspense",
] as const;
export type BankMatchKind = (typeof BANK_MATCH_KINDS)[number];
/** `reference_credit`: a credit quoting an order that is not a return; the other two halt payouts. */
export const BANK_LINE_FLAGS = ["reference_credit", "iban_mismatch", "payout_duplicate"] as const;
export type BankLineFlag = (typeof BANK_LINE_FLAGS)[number];

export interface ApiBankStatement {
  id: string;
  accountIban: string;
  format: "csv" | "camt053";
  fileSha256: string;
  periodFrom: string;
  periodTo: string;
  openingBalance: ApiMoney;
  closingBalance: ApiMoney;
  currency: string;
  status: BankStatementStatus;
  prevStatementId: string | null;
  importedByUserId: string;
  approvalId: string | null;
  confirmedAt: string | null;
  lineCount: number;
  createdAt: string;
}

export interface ApiBankLine {
  id: string;
  statementId: string;
  lineRef: string;
  bookingDate: string;
  valueDate: string | null;
  /** Signed: + credit to the client-money account, − debit. */
  amount: ApiMoney;
  currency: string;
  counterpartyName: string | null;
  counterpartyIbanLast4: string | null;
  counterpartyBic: string | null;
  bankTxCode: string | null;
  returnInfo: boolean;
  returnCode: string | null;
  /** `TO-…` when the line quotes one. */
  reference: string | null;
  documentNo: string | null;
  matchKind: BankMatchKind | null;
  matchedOrderId: string | null;
  matchedBatchId: string | null;
  status: BankLineStatus;
  flags: BankLineFlag[];
}

/** An upload's answer and `GET /admin/ramp/bank-statements/:id`: the file's figures and its lines. */
export interface ApiStatementPreview {
  statement: ApiBankStatement;
  lines: ApiBankLine[];
}

// ---------------------------------------------------------------------------------------------
// Compliance: identity, consent, eligibility, monitoring rules, alerts (SPEC §11, §12; stage S7a)
// ---------------------------------------------------------------------------------------------

/** `info` never holds; `review` holds the value point (single AML decision); `block` holds it (four-eyes). */
export const COMPLIANCE_ALERT_SEVERITIES = ["info", "review", "block"] as const;
export type ComplianceAlertSeverity = (typeof COMPLIANCE_ALERT_SEVERITIES)[number];
/**
 * `open` and `escalated` wait for a decision; `reported` (DFM special form filed) still holds;
 * `cleared` releases; `returned` (C25, final) ends the hold WITHOUT releasing: the payment goes back.
 */
export const COMPLIANCE_ALERT_STATUSES = [
  "open",
  "cleared",
  "escalated",
  "reported",
  "returned",
] as const;
export type ComplianceAlertStatus = (typeof COMPLIANCE_ALERT_STATUSES)[number];
/** `return` (C25): refuse the held payment — the ramp gives it back (refund / refund_bank), never mints it. */
export const COMPLIANCE_ALERT_DECISIONS = ["clear", "escalate", "report", "return"] as const;
export type ComplianceAlertDecision = (typeof COMPLIANCE_ALERT_DECISIONS)[number];

/** `GET /admin/compliance/alerts[/:id]` (SPEC §11.6). Figures never carry PII. */
export interface ApiComplianceAlert {
  id: string;
  userId: string;
  rule: string;
  /** The value point (`onramp.create` …) or what raised it (`consent`, `identity`, `bank_account`, …). */
  point: string | null;
  severity: ComplianceAlertSeverity;
  orderId: string | null;
  figures: Record<string, unknown>;
  windowKey: string;
  status: ComplianceAlertStatus;
  /** The legal deadline (Belarusian business days, UTC); null for info. */
  dueAt: string | null;
  rulesVersion: string;
  /** The base value (BYN) the thresholds were computed with. */
  bvByn: ApiMoney | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  reportRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `POST /ramp/consent` (SPEC §12.1). */
export interface ApiRampConsentResult {
  consent: { required: boolean; termsVersion: string };
}
