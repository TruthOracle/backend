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
- `GET /admin/kyc/provider` → `{ provider: "mock" | "sumsub", configured: boolean, levelName, enforceWithdrawals: boolean, webhookPath, health: { ok, message, upstreamStatus: number | null, checkedAt, details } }` — a live credential probe of the KYC provider (docs/KYC.md §6); never applicant data
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
  marketId: number; ticker: string; tickerSource: "ledger" | "catalog" | "synthetic"; eventTicker: string | null; eventTickerSource: "ledger" | "catalog" | null;
  seriesTicker: string | null; yesSubTitle; noSubTitle: string; subTitlesFromLedger: boolean;   // catalog identity (docs/MARKETS.md §2)
  contractId: string; templateId: string | null; admin: string; question; imageUrl; description; resolutionDescription; category: string;
  createdAt; expiresAt; tradingStartsAt: string; gracePeriodSecs; liquidityPeriodSecs: number; isDynamic: boolean;
  reserveYes; reserveNo; liquidityL; lpTokenSupply; currentPrice: Decimal; feeBps; prizeFeeShareBps: number;
  accumulatedFeesCC; prizePoolCC; totalVolumeCC: Decimal; status: MarketStatus; outcome: Outcome | null; resolvedAt: string | null;
  proposal: { proposer; proposedOutcome: Outcome; proposedAt; bondCC; challenger: string | null; challengerOutcome: Outcome | null; challengeEndsAt } | null;
  policy: { operatorResolution: boolean; sources: string[]; sourceKeys: { sourceUri; publicKey }[]; reporters: string[]; quorum; challengeSecs: number; bondCC: Decimal };
  auditObservers: string[]; phase: Phase; archived: boolean; tradeCount: number; lastTradeAt: string | null;
  previousPrice: Decimal | null; priceChange24h: Decimal | null; volume24hCC: Decimal;   // from the hourly candles
  openInterest: { yes; no; total: Decimal }; liquidityCC: Decimal;                        // outstanding shares; pool value V(P)
  book: { yesBid; yesAsk; noBid; noAsk; referenceCC: Decimal } | null;                    // AMM-implied for a 1 CC order, trading only
  updatedOffset; createdOffset: number; synchronizerId: string | null;
  createdEventBlob?: string | null;        // GET /markets/:id only — the disclosed contract a user-signed trade needs
}
interface MarketSummary { marketId; ticker; eventTicker; yesSubTitle; noSubTitle; contractId; question; imageUrl; category; status; outcome; currentPrice; expiresAt; resolvedAt; phase; archived }
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
`:market` is a numeric `marketId` or a ticker (case-insensitive) on every route below (docs/MARKETS.md §2).
- `GET /markets?status=Trading|Proposed|Resolved|Voided|active|settled&category=&event=&series=&tickers=A,B&q=&sort=newest|oldest|volume|expiry|activity&includeArchived=&page=&limit=` → `{ items: Market[], page, limit, total }` (archived markets excluded unless asked; `event` / `series` filter by catalog membership)
- `GET /markets/categories` → `{ category, markets }[]`
- `GET /markets/:market` → `{ market: Market }` (with `createdEventBlob`) | `404 not_found`
- `GET /markets/:market/activity?kind=&page=&limit=` → `{ items: MarketEvent[], … }` newest first
- `GET /markets/:market/trades?kind=&page=&limit=` → the `buy sell swap split merge` subset
- `GET /markets/:market/price-history?from=&to=&resolution=raw|1m|5m|15m|1h|4h|1d&limit=` → `{ marketId, resolution, points: PricePoint[] }` oldest first (one point per market version, or the last per bucket; the latest `limit` win)
- `GET /markets/:market/forecasts` → `{ forecasts: ModelForecast[] }` · `GET /markets/:market/attestations` → `{ attestations: Attestation[] }`

### Candlesticks (public; docs/MARKETS.md §5)
- `GET /markets/:market/candlesticks?startTs=&endTs=&periodInterval=1|60|1440` → `Candlesticks` — epoch seconds; `periodInterval` in minutes (default 60); defaults to the last 200 periods ending now; dense (every period from the market's first candle on, quiet periods carried forward with `empty: true`); at most 5 000 candles (`400 validation_failed`)

```ts
interface Candle { startTs: number; endTs: number;   // [startTs, endTs) epoch seconds
  price: { open; high; low; close; mean: Decimal; previous: Decimal | null };   // mean = volume-weighted post-trade price
  volumeCC: Decimal; trades: number; openInterest: Decimal; liquidityL: Decimal | null; empty: boolean }
interface Candlesticks { marketId: number; ticker: string; periodInterval: 1 | 60 | 1440; startTs; endTs: number; candlesticks: Candle[] }
```

### Quotes and orders (docs/MARKETS.md §6–§7)
- `GET /markets/:market/quote?action=buy|sell|swap|provide_liquidity&side=Yes|No&amountCC=&shares=&slippageBps=` (public) → `Quote` | `409 market_not_tradable` (`details.phase`) | `409 quote_unavailable` | `400 validation_failed` — `amountCC` for buy / provide_liquidity, `shares` for sell / swap; slippage 0..2000 bps (default 100)
- `POST /markets/:market/orders/prepare` (user session) `{ action: buy|sell|swap|split|merge|provide_liquidity|withdraw_liquidity|redeem, side?, amountCC?, shares?, lpTokens?, slippageBps? }` → `PreparedOrder` | `409 no_primary_wallet` | `409 no_in_app_wallet` | `409 no_position` | `409 insufficient_balance` (`details.balanceCC`, `details.requiredCC`) | `409 insufficient_shares` (`details.heldShares`, `details.requestedShares`) | `409 market_not_tradable` | `409 trading_halted` (`details.estimatedResumeAt`; never for `redeem`) | `409 quote_unavailable`

```ts
interface Quote { marketId; ticker; contractId; updatedOffset; nowSeconds: number; phase: Phase; effectiveL: Decimal;
  quote: QuoteBuy | QuoteSell | QuoteSwap | QuoteLiquidity;
  bounds: { slippageBps: number; minSharesOut?: Decimal; minProceedsCC?: Decimal; maxCostCC?: Decimal } }
interface QuoteBuy { action: "buy"; side; collateralCC; feeCC; netCC; sharesOut; avgPrice; priceBefore; priceAfter; priceImpact; maxPayoutCC: Decimal }
interface QuoteSell { action: "sell"; side; sharesIn; grossCC; feeCC; netCC; avgPrice; priceBefore; priceAfter; priceImpact: Decimal }
interface QuoteSwap { action: "swap"; fromSide; sharesIn; feeShares; sharesOut; priceBefore; priceAfter; priceImpact: Decimal }
interface QuoteLiquidity { action: "provide_liquidity"; valueIncreaseCC; costCC; lpMinted; poolShare; newL: Decimal }
interface PreparedOrder { action; marketId; ticker; actAs: string;                       // the account's primary party signs
  command: { ExerciseCommand: { templateId; contractId; choice; choiceArgument } };      // JSON Ledger API v2, sign as-is
  disclosedContracts: { templateId; contractId; createdEventBlob; synchronizerId }[];   // the market version
  quote: Quote | null; inputs: { marketContractId; walletContractId; positionContractId; lpPositionContractId: string | null };
  ledgerOffset: number; nowSeconds: number; expiresAt: string }
```

### Catalog (public; docs/MARKETS.md §2–§3)
- `GET /series?category=&status=active|archived|all&q=&page=&limit=` → `{ items: Series[], … }` (active only by default)
- `GET /series/:ticker` → `{ series: Series, events: Event[] }` | `404 not_found`
- `GET /events?series=&status=unopened|open|closed|settled|all&category=&q=&withNestedMarkets=&includeArchived=&page=&limit=` → `{ items: Event[], … }` (status derived from the member markets)
- `GET /events/:ticker` → `{ event: Event }` with `markets` nested | `404 not_found`

```ts
interface Series { ticker; title; category: string; frequency: "one_off" | "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "custom";
  tags: string[]; settlementSources: { name; url }[]; contractUrl: string | null; description: string; status: "active" | "archived";
  productMetadata: Record<string, unknown>; eventCount; marketCount: number; createdAt; updatedAt }
interface Event { ticker; seriesTicker; title; subTitle; category; imageUrl; description: string; mutuallyExclusive: boolean;
  strikeDate: string | null; strikePeriod: string | null; settlementSources: { name; url }[]; productMetadata; archived: boolean;
  status: "unopened" | "open" | "closed" | "settled"; marketCount: number; volumeCC: Decimal; closeTime: string | null;
  markets?: Market[]; createdAt; updatedAt }
```

### Exchange (public; docs/MARKETS.md §8)
- `GET /exchange/status` → `{ exchangeActive, tradingActive: boolean, halt: { active, reason, since, estimatedResumeAt }, ledger: { indexEnabled, indexRunning, offset, ledgerEnd, lag, lastRecordTime, lastError, stale }, network, packageName, serverTime }`

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

### Admin — catalog and exchange (admin session; docs/MARKETS.md §2–§4, §8)
`reason` is optional on the catalog routes (presentational data) and recorded on the audit row when given.
- `POST /admin/series` `{ ticker, title, category?, frequency?, tags?, settlementSources?, contractUrl?, description?, productMetadata?, reason? }` → `{ series }` | `409 catalog_conflict`
- `PATCH /admin/series/:ticker` `{ …any of the above, status?: active | archived }` → `{ series }`
- `POST /admin/events` `{ ticker, seriesTicker, title, subTitle?, imageUrl?, description?, mutuallyExclusive?, strikeDate?, strikePeriod?, settlementSources?, productMetadata?, reason? }` → `{ event }` | `404 not_found` (series) | `409 catalog_conflict`
- `PATCH /admin/events/:ticker` `{ …, archived? }` → `{ event }`
- `PATCH /admin/markets/:marketId/catalog` `{ ticker?, eventTicker?: string | null, yesSubTitle?, noSubTitle?, reason? }` → `{ market }` | `409 ledger_value_fixed` (`details.field`) | `409 catalog_conflict` | `404 not_found`
- `POST /admin/markets` `{ eventTicker, ticker, question, yesSubTitle?, noSubTitle?, imageUrl?, description?, resolutionDescription?, category?, expiresAt, gracePeriodSecs?, isDynamic?, liquidityPeriodSecs?, initialProbability, initialValueCC, feeBps?, prizeFeeShareBps?, policy?, auditObservers?, reason? }` → `{ commandId, status, ticker, eventTicker, expectedMarketId }` | `409 catalog_conflict` | `503 not_ready` (MarketCounter not indexed) | `502 upstream_failed` (Enterprise Wallet, incl. a duplicate ticker's command id)
- `POST /admin/exchange/halt` `{ active: boolean, reason, estimatedResumeAt? }` → `{ halt }`
