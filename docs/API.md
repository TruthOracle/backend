# TruthOracle backend — HTTP API contract (v1)

Shared contract between `truthoracle-backend` and the `truthoracle-canton` frontend. Every
route is under `/api/v1` (frontend reaches it as `/__backend/api/v1/...`). Bodies and
responses are JSON. Money is a **string with exactly 10 decimals** (`"12.5000000000"`),
never a number. Timestamps are ISO-8601 strings. Ids are UUIDs unless stated.

Errors: HTTP status + `{ "error": "<code>", "message": "<human text>", "details"?: {...} }`.
Codes are listed in ARCHITECTURE.md §11. Rate-limited responses are `429 rate_limited`
with `Retry-After`.

Auth: browser requests carry the `to_session` cookie (set by the login routes) and, on every
non-GET, `Content-Type: application/json` plus `x-requested-with: truthoracle` and an
`Origin` header. Native clients use `Authorization: Bearer <token>` (returned only when the
login request sets `"client": "native"`).

## Shared shapes

```ts
type Money = string;                       // "0.0000000000"
type KycStatus = "none" | "pending" | "approved" | "rejected" | "blocked_duplicate";
type IdentityProvider = "google" | "telegram" | "canton_wallet";

interface User {
  id: string; displayName: string | null; avatarUrl: string | null; email: string | null;
  status: "active" | "suspended" | "closed"; kycStatus: KycStatus; partyId: string | null;
  createdAt: string; lastLoginAt: string | null;
}
interface Identity {
  id: string; provider: IdentityProvider; subject: string; email: string | null;
  profile: { name?: string; username?: string; picture?: string; hd?: string };
  status: "active" | "unlinked"; verifiedAt: string; lastUsedAt: string | null;
  kycLocked: boolean;                       // cannot be unlinked while the KYC approval stands
}
interface LedgerWallet { contractId: string; owner: string; balanceCC: Money; depositedCC: Money; withdrawnCC: Money }
interface Wallet {
  id: string; chain: "canton"; kind: "cantor8"; partyId: string; label: string | null;
  isPrimary: boolean; status: "active" | "revoked"; verifiedAt: string;
  creditedCC: Money;                        // in-app credits attributed to this wallet (the only attribution — nothing predates the backend)
  receivedCC?: Money;                       // only in GET /in-app-wallet
  ownLedgerWallet: LedgerWallet | null;     // a non-primary party's own on-ledger UserWallet, if any
}
interface KycVerification {
  id: string; provider: "mock" | "sumsub" | "admin"; levelName: string; attemptNo: number;
  status: "initiated" | "pending" | "needs_review" | "approved" | "rejected_retry" | "rejected_final" | "blocked_duplicate" | "expired";
  rejectLabels: string[]; moderationComment: string | null; reviewedAt: string | null; createdAt: string;
}
interface KycSummary {
  provider: "mock" | "sumsub" | null;       // null = not configured
  status: KycStatus; levelName: string; requiredForWithdrawal: boolean;
  attachedIdentityId: string | null; verification: KycVerification | null;
}
interface Capabilities {
  canDeposit: boolean; canWithdraw: boolean; kycRequiredForWithdrawal: boolean;
  primaryPartyId: string | null; isAdmin: boolean;
}
interface Session { id: string; kind: "user" | "admin"; authMethod: IdentityProvider; identityId: string;
  createdAt: string; expiresAt: string; lastSeenAt: string | null; ip: string | null; userAgent: string | null; current: boolean }
interface Payout {
  pendingPayoutCid: string; payeeParty: string; walletId: string | null; amountCC: Money; reason: string;
  status: "queued" | "settling" | "settled_external" | "settled_in_app" | "blocked_kyc" | "blocked_unknown_user" |
          "blocked_unknown_reason" | "blocked_wallet_revoked" | "failed" | "archived";
  retryAfterKyc: boolean; attempts: number; lastError: string | null; firstSeenAt: string; settledAt: string | null;
  onLedger: boolean;                         // still an active PendingPayout contract
}
```

## Health
- `GET /health` → `200 { status: "ok", service, version, env, network, uptimeSec, ts }`
- `GET /health/ready` → `200 { status: "ok", checks: { postgres: "ok", redis: "ok", nats: "ok" } }` or `503 { status: "degraded", checks, draining?: true }` with the failing check (`draining` only while the process shuts down).

## Auth
- `GET /auth/session` → `200 { authenticated: false }` | `200 { authenticated: true, kind, user: User, expiresAt }`
- `POST /auth/google/nonce` → `200 { nonce, expiresAt }`
- `POST /auth/google` `{ credential, nonce?, client?: "web" | "native" }` → `200 LoginResult`
- `POST /auth/telegram/widget` `{ id, first_name, last_name?, username?, photo_url?, auth_date, hash, client? }` → `200 LoginResult`
- `POST /auth/telegram/miniapp` `{ initData, client? }` → `200 LoginResult`
- `GET /auth/telegram/oidc/start?mode=login|link&returnTo=/path` → `302` to Telegram (sets `to_oidc`)
- `GET /auth/telegram/oidc/callback?code&state` → `302` to `<app origin><returnTo>?auth=ok` or `?auth=error&code=<error code>`
- `POST /auth/admin/challenge` `{ partyId }` → `200 { challengeId, message, expiresAt }` (purpose `admin-sign-in`; `409 challenge_purpose_mismatch` when a session cookie is present)
- `POST /auth/admin` `{ challengeId, partyId, publicKey, signature, kind: "cantor8" }` → `200 LoginResult` with `kind: "admin"` | `403 forbidden` (not an operator, or a session is present)
- `POST /auth/logout` → `200 { ok: true }` (clears cookie, revokes the session; accepts an admin session)

```ts
interface LoginResult {
  mode: "login" | "link";                    // link when a session was present
  user: User; kind: "user" | "admin"; expiresAt: string;
  identity: Identity;                        // the identity that authenticated / was linked
  created: boolean;                          // a new account was created
  token?: string;                            // only for client = "native"
}
```
Google and Telegram are the only ways a USER account is created or opened. With a session
cookie present those routes act in **link mode** (they attach the identity to the current
account and return `mode: "link"`). A Cantor8 wallet never signs a user in: it is linked to a
signed-in account under "Wallets" below. `POST /auth/admin` is operator-only, issues a
`kind = "admin"` session and never runs in link mode.

Signing in with an unlinked identity returns `403 identity_unlinked`; linking an identity owned
by another account returns `409 identity_already_linked`; a wallet owned by another account
`409 wallet_already_linked`.

**Session kind.** A `kind = "admin"` session is accepted only on `/admin/**`, `POST /auth/logout`,
`GET /me` and the `/me/sessions` routes. Every other account route answers `403 forbidden`
("admin sessions cannot use account routes").

## Me
- `GET /me` → `200 { user: User, identities: Identity[], wallets: Wallet[], kyc: KycSummary, capabilities: Capabilities }`
- `PATCH /me` `{ displayName?, avatarUrl? }` → `200 { user }`
- `DELETE /me/identities/:id` → `200 { ok: true }` | `409 last_identity` | `409 identity_locked_by_kyc`
- `POST /me/identities/:id/reattach` → `200 { identity }` (only the original owner; requires a fresh proof for that provider — a Google credential or a Telegram payload; an unlinked WALLET is restored by linking it again, not here)
- `GET /me/sessions` → `200 { sessions: Session[] }`
- `DELETE /me/sessions/:id` → `200 { ok: true }`
- `POST /me/sessions/revoke-others` → `200 { revoked: number }`
- `GET /me/audit?page=` → `200 { items: AuditEvent[], page, limit, total }`

## Wallets
- `GET /wallets` → `200 { wallets: Wallet[] }`
- `POST /wallets/link-challenge` `{ partyId }` → `200 { challengeId, message, expiresAt }`
- `POST /wallets/link` `{ challengeId, partyId, publicKey, signature, kind: "cantor8", label? }` → `200 { wallet: Wallet }` (never reads the ledger; works while it is down; creates no identity)
- `DELETE /wallets/:id` → `200 { ok: true }` | `409 primary_wallet_in_use`
- `POST /wallets/:id/primary` → `200 { wallet }` | `409 primary_wallet_in_use`

## In-app wallet
Deposits and withdrawals **require a signed-in account** (ARCHITECTURE §18): there is no
account-less money path. Trading and reads stay wallet-signed, but a choice that debits or
credits a `UserWallet` presupposes one exists — i.e. an account that deposited through this API.
- `GET /in-app-wallet` → `200 { partyId: string | null, ledger: LedgerWallet | null, wallets: Wallet[] (with receivedCC), attribution: { creditedTotalCC: Money, ledgerDepositedCC: Money, delta: Money }, pending: { submitted: number }, payouts: Payout[] }`
  (`delta = ledgerDepositedCC − creditedTotalCC`; anything beyond 1e-9 CC makes the next reconcile answer `409 deposit_attribution_drift`)
- `POST /in-app-wallet/deposits/reconcile` → `200 { credited: Money, status: "confirmed" | "submitted" | "nothing_outstanding", commandId?: string, perWallet: { walletId, partyId, amountCC: Money }[], ledger: LedgerWallet | null }`
  | `409 no_primary_wallet` | `409 deposit_in_progress` | `409 deposit_attribution_drift` (`details: { kind: "over_credit" | "ledger_below_expected" | "ledger_above_expected" | "duplicate_user_wallet", walletId?, amountCC? }`) | `409 kyc_duplicate_identity` | `502 upstream_failed`
- `GET /in-app-wallet/payouts` → `200 { payouts: Payout[] }`
- `POST /in-app-wallet/payouts/:cid/settle` → `200 { payout: Payout, mode: "external" | "in_app" | "already_settled" }` | `404 payout_not_found` | `409 kyc_required` | `409 payout_blocked` (`details.status`)

## KYC
- `GET /kyc` → `200 KycSummary & { history: KycVerification[] }`
- `POST /kyc/sessions` → `200 { provider: "sumsub", accessToken, expiresAt, levelName, verificationId }` | `200 { provider: "mock", verificationId, levelName }` | `409 kyc_duplicate_identity` | `503 kyc_provider_unavailable`
- `POST /kyc/mock/submit` `{ verificationId, outcome: "approved" | "rejected_retry" | "rejected_final", person: { firstName, lastName, dob: "YYYY-MM-DD", country: "ISO3" }, documents: { docType: "PASSPORT" | "ID_CARD" | "DRIVERS" | "RESIDENCE_PERMIT", country, number }[] }` → `200 { verification, userKycStatus }` (mock provider only)

## Webhooks
- `POST /webhooks/kyc/sumsub` (raw body, `x-payload-digest`, `x-payload-digest-alg`) → `200 { received: true }` | `401`

## Admin (admin session only)
- `GET /admin/users?q=&page=` → `{ items: User[], page, limit, total }`
- `GET /admin/users/:id` → `{ user, identities, wallets, kyc: KycSummary & { history }, sessions: Session[], payouts: Payout[], persons: { fingerprint, kind, boundAt }[] }`
- `POST /admin/users/:id/suspend` `{ reason }` · `/reinstate` `{ reason }` · `/sessions/revoke` → `{ ok: true }`
- `POST /admin/users/:id/identities/:identityId/reattach` `{ reason }` · `/unlink` `{ reason }` → `{ identity }`
- `POST /admin/users/:id/kyc/override` `{ status: "approved" | "rejected_final" | "expired", reason }` → `{ verification }` | `409 kyc_duplicate_identity`
- `GET /admin/kyc/duplicates` · `GET /admin/kyc/needs-review` → `{ items: (KycVerification & { userId })[] }`
- `POST /admin/kyc/persons/:fingerprint/transfer` `{ toUserId, reason }` → `{ ok: true }`
- `GET /admin/payouts?status=` → `{ items: Payout[] }`
- `POST /admin/payouts/:cid/settle` `{ force?: boolean, reason }` → `{ payout, mode }`
- `GET /admin/audit?subjectType=&subjectId=&actorUserId=&page=` → `{ items: AuditEvent[], page, limit, total }`

```ts
interface AuditEvent { id: string; actorType: "user" | "admin" | "system"; actorUserId: string | null; action: string;
  subjectType: string; subjectId: string; metadata: Record<string, unknown>; createdAt: string }
```

## Ledger index (docs/INDEXER.md)

Read-only routes over the backend's index of the treasury's ledger view. Daml `Decimal`s
(prices, shares, CC) are 10-dp strings like Money; Daml `Int` epoch seconds are ISO-8601; durations
are integer seconds; parties are Canton party ids. Every response below carries
`x-ledger-offset: <last applied offset>`.

```ts
type Decimal = string;                     // "0.5500000000"
type MarketStatus = "Trading" | "Proposed" | "Resolved" | "Voided";
type Outcome = "Yes" | "No" | "VoidOutcome";
type Phase = "liquidity" | "trading" | "expired" | "proposed" | "resolved" | "voided";
type MarketEventKind = "market_created" | "buy" | "sell" | "swap" | "split" | "merge" | "provide_liquidity" | "withdraw_liquidity" |
  "resolve_t0" | "resolve" | "propose" | "challenge" | "finalize" | "void" | "redeem" | "commit_forecast" | "score_and_distribute" | "archive";

interface Market {
  marketId: number; contractId: string; admin: string; question; imageUrl; description; resolutionDescription; category: string;
  createdAt; expiresAt; tradingStartsAt: string; gracePeriodSecs; liquidityPeriodSecs: number; isDynamic: boolean;
  reserveYes; reserveNo; liquidityL; lpTokenSupply; currentPrice: Decimal; feeBps; prizeFeeShareBps: number;
  accumulatedFeesCC; prizePoolCC; totalVolumeCC: Decimal; status: MarketStatus; outcome: Outcome | null; resolvedAt: string | null;
  proposal: { proposer; proposedOutcome: Outcome; proposedAt; bondCC; challenger: string | null; challengerOutcome: Outcome | null; challengeEndsAt } | null;
  policy: { operatorResolution: boolean; sources: string[]; sourceKeys: { sourceUri; publicKey }[]; reporters: string[]; quorum; challengeSecs: number; bondCC: Decimal };
  auditObservers: string[]; phase: Phase; archived: boolean; tradeCount: number; lastTradeAt: string | null;
  updatedOffset; createdOffset: number; synchronizerId: string | null;
  createdEventBlob?: string | null;        // GET /markets/:id only — the disclosed contract a user-signed trade needs
}
interface MarketSummary { marketId; contractId; question; imageUrl; category; status; outcome; currentPrice; expiresAt; resolvedAt; phase; archived }
interface MarketEvent {
  id: string; eventId: string; marketId: number; kind: MarketEventKind; actor: string; side: "Yes" | "No" | null;
  amountCC; netCC; shares; sharesOut; feeCC; priceBefore; priceAfter; lpTokens: Decimal | null; outcome: Outcome | null;
  details: Record<string, unknown>; offset: number; updateId: string; commandId: string | null; effectiveAt: string;
}
interface PricePoint { t: string; price: Decimal; volumeCC: Decimal; offset: number }
interface Position { contractId; holder; marketId; yesShares; noShares; costBasisCC; active; createdAt; createdOffset; archivedAt;
  market: MarketSummary | null; valueCC: Decimal | null; redeemableCC: Decimal | null }
interface LiquidityPosition { contractId; provider; marketId; lpTokens; depositedCC; active; createdAt; createdOffset; archivedAt; market; poolShare: Decimal | null }
interface WalletEntry { id; eventId; owner; kind: "deposit" | "credit" | "debit" | "withdraw"; amountCC; reason: string | null; txRef: string | null;
  balanceAfter: Decimal | null; marketId: number | null; rootChoice: string | null; walletContractId; offset; updateId; effectiveAt }
interface IndexedWallet { contractId; owner; balanceCC; depositedCC; withdrawnCC; depositRefs: string[]; updatedOffset; updatedAt }
interface LedgerPayout { contractId; user; marketId; amountCC; reason; createdAt; createdOffset; active;
  settledKind: "mark_paid" | "settle_to_wallet" | "cancelled" | "archived" | null; settledAt; settledOffset; txHash: string | null; refunded: boolean | null }
interface LedgerTransfer { updateId; offset; direction: "in" | "out"; counterparty; amountCC; choice; recordTime }
interface Attestation { contractId; attester; marketId; sourceUri; fetchedAt; outcome; payloadHash; hasSourceSignature; responseExcerpt; active; createdOffset }
interface ModelForecast { contractId; author; marketId; modelId; probabilityYes; committedAt; marketPriceAtCommit; active; createdOffset }
interface LedgerStatus { enabled; running; bootstrapped: boolean; bootstrappedAt; bootstrapOffset; offset: number; ledgerEnd; lag; prunedOffset: number | null;
  lastUpdateId; lastRecordTime; lastError; lastErrorAt: string | null; gaps: { fromOffset; toOffset; reason; at }[]; updatedAt }
```

### Markets (public)
- `GET /markets?status=Trading|Proposed|Resolved|Voided|active|settled&category=&q=&sort=newest|oldest|volume|expiry|activity&includeArchived=&page=&limit=` → `{ items: Market[], page, limit, total }` (archived markets excluded unless asked)
- `GET /markets/categories` → `{ category, markets }[]`
- `GET /markets/:marketId` → `{ market: Market }` (with `createdEventBlob`) | `404 not_found`
- `GET /markets/:marketId/activity?kind=&page=&limit=` → `{ items: MarketEvent[], … }` newest first
- `GET /markets/:marketId/trades?kind=&page=&limit=` → the `buy sell swap split merge` subset
- `GET /markets/:marketId/price-history?from=&to=&resolution=raw|1m|5m|15m|1h|4h|1d&limit=` → `{ marketId, resolution, points: PricePoint[] }` oldest first (one point per market version, or the last per bucket; the latest `limit` win)
- `GET /markets/:marketId/forecasts` → `{ forecasts: ModelForecast[] }` · `GET /markets/:marketId/attestations` → `{ attestations: Attestation[] }`

### Ledger (public)
- `GET /ledger/status` → `LedgerStatus`
- `GET /ledger/wait?offset=&timeoutMs=` → `200 { reached: boolean, offset, requested }` — resolves once the index reaches `offset` or after `timeoutMs` (default 10 s, max 30 s)
- `GET /stats` → `{ markets: { total, trading, proposed, resolved, voided }, totalVolumeCC, volume24hCC, trades, trades24h, traders, indexedOffset }`
- `GET /leaderboard?window=24h|7d|30d|all&limit=` → `{ window, entries: { party, volumeCC, trades, markets, realizedPnlCC }[] }`

### Portfolio (session; user sessions only)
The account's parties = the primary party + every active linked wallet.
- `GET /me/positions?status=open|all` → `{ parties, positions: Position[] }` (`valueCC` = mark-to-market while Trading, the redeemable amount once settled)
- `GET /me/liquidity?status=open|all` → `{ parties, positions: LiquidityPosition[] }`
- `GET /me/trades?marketId=&kind=&page=&limit=` · `GET /me/activity?…` → `{ items: MarketEvent[], … }`

### In-app wallet ledger (session)
- `GET /in-app-wallet/ledger` → `{ partyId, wallet: IndexedWallet | null, payouts: LedgerPayout[] }`
- `GET /in-app-wallet/history?kind=&page=&limit=` → `{ items: WalletEntry[], … }` — the statement of the primary party's UserWallet
- `GET /in-app-wallet/transfers?direction=&page=&limit=` → `{ items: LedgerTransfer[], … }` — Canton Coin between the treasury and the account's wallets

### Admin — ledger (admin session)
- `GET /admin/ledger/status` → `LedgerStatus`
- `POST /admin/ledger/resync` `{ reason }` → `{ status }` (re-snapshot the ACS at the ledger end; audited `ledger.resync`)
- `GET /admin/ledger/events?updateId=&contractId=&marketId=&entity=&choice=&fromOffset=&page=` → raw created / exercised events (`{ id, eventId, offset, nodeId, updateId, kind, template, contractId, choice, consuming, actingParties, payload, result, parentNodeId, effectiveAt, commandId }`)
- `GET /admin/ledger/wallets?owner=` · `GET /admin/ledger/payouts?active=&user=` · `GET /admin/ledger/transfers?direction=&counterparty=`
- `GET /admin/ledger/markets/:marketId/positions` · `/liquidity` → holders / providers, largest first
