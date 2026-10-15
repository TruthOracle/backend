# TruthOracle backend — HTTP API contract (v1)

All times are UTC: ISO 8601 strings end in `Z`, epoch fields are seconds since the Unix epoch, and daily candles are UTC days.


Shared contract between `truthoracle-backend` and the `pm-frontend` frontend. Every
route is under `/api/v1` (frontend reaches it as `/__backend/api/v1/...`). Bodies and
responses are JSON. Money is a **string with exactly 10 decimals** (`"12.5000000000"`),
never a number, and every money field sits next to the `InstrumentRef` it is denominated in
(`collateral` on a market, `instrument` everywhere else — docs/TOKENS.md §2); the instrument's
`decimals` is for display and withdrawal quantisation only. Timestamps are ISO-8601 strings.
Ids are UUIDs unless stated.

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
/** A CIP-56 instrument: `admin` = the registry party (cBYN: the transfer agent; Canton Coin: the DSO), `id` = the token id. */
interface InstrumentRef { admin: string; id: string; symbol: string; name: string; decimals: number }
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
// one on-ledger UserWallet; a party holds one per instrument (truthoracle-v17)
interface LedgerWallet { contractId: string; owner: string; instrument: InstrumentRef; balance: Money; deposited: Money; withdrawn: Money; creditRefs: string[] }
interface WalletCredit {
  instrument: InstrumentRef;
  credited: Money;                          // in-app credits attributed to this wallet in the instrument (the only attribution — nothing predates the backend)
  received?: Money;                         // only in GET /in-app-wallet: what the party sent the treasury in the instrument
}
interface Wallet {
  id: string; chain: "canton"; kind: "cantor8"; partyId: string; label: string | null;
  isPrimary: boolean; status: "active" | "revoked"; verifiedAt: string;
  credits: WalletCredit[];                  // one entry per instrument the wallet was credited (or sent) in; empty until the first deposit
  ownLedgerWallets: LedgerWallet[];         // a non-primary party's own on-ledger UserWallets (one per instrument), if any
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
  pendingPayoutCid: string; payeeParty: string; walletId: string | null; instrument: InstrumentRef; amount: Money; reason: string;
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
- `GET /in-app-wallet` → `200 { partyId: string | null, wallets: Wallet[] (credits with received), balances: { instrument: InstrumentRef, ledger: LedgerWallet | null, attribution: { creditedTotal: Money, ledgerDeposited: Money, delta: Money } }[], pending: { submitted: number }, payouts: Payout[] }`
  — one `balances` row per instrument the account holds a wallet or a credit in, plus the default collateral and the rewards instrument even before a wallet exists (`delta = ledgerDeposited − creditedTotal` per instrument; anything beyond 1e-9 units makes the next reconcile in that instrument answer `409 deposit_attribution_drift`)
- `POST /in-app-wallet/deposits/reconcile` `{ instrument?: { admin, id } }` (default: the default collateral) → `200 { instrument: InstrumentRef, credited: Money, status: "confirmed" | "submitted" | "nothing_outstanding", commandId?: string, perWallet: { walletId, partyId, amount: Money }[], ledger: LedgerWallet | null }`
  | `409 no_primary_wallet` | `409 deposit_in_progress` | `409 deposit_attribution_drift` (`details: { kind: "over_credit" | "ledger_below_expected" | "ledger_above_expected" | "duplicate_user_wallet", instrument, walletId?, amount? }`) | `409 kyc_duplicate_identity` | `409 instrument_disabled` | `404 instrument_unknown` | `503 ledger_stale` (`details: { offset, ledgerEnd, lag, maxLag }` — the ledger index lags the ledger end by more than `LEDGER_FRESH_OFFSETS`, or no participant is configured to check against; retry shortly) | `502 upstream_failed`
  — the received side is the ledger index (`to_ledger_transfers`, docs/TOKENS.md §2 decision 5): what the linked parties sent the treasury in the instrument, token-standard or Canton Coin, as the treasury's own transaction stream showed it
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
(prices, shares, amounts) are 10-dp strings like Money; Daml `Int` epoch seconds are ISO-8601;
durations are integer seconds; parties are Canton party ids. Every amount-carrying object names
its instrument (`collateral` on a market, `instrument` elsewhere). Every response below carries
`x-ledger-offset: <last applied offset>`.

```ts
type Decimal = string;                     // "0.5500000000"
type MarketStatus = "Trading" | "Proposed" | "Resolved" | "Voided";
type Outcome = "Yes" | "No" | "VoidOutcome";
type Phase = "liquidity" | "trading" | "expired" | "proposed" | "resolved" | "voided";
type MarketEventKind = "market_created" | "buy" | "sell" | "swap" | "split" | "merge" | "provide_liquidity" | "withdraw_liquidity" |
  "resolve_t0" | "resolve" | "propose" | "challenge" | "finalize" | "void" | "redeem" | "commit_forecast" | "score_and_distribute" | "archive";

interface Market {
  marketId: number; ticker: string; eventTicker: string; yesSubTitle; noSubTitle: string;   // the contract's own identity (docs/MARKETS.md §2)
  seriesTicker: string | null;                                                               // through the event's catalog row (null only for a placeholder event without a series)
  contractId: string; templateId: string | null; admin: string; collateral: InstrumentRef;   // the instrument every amount below is in (docs/TOKENS.md §2); fixed at creation
  question; resolutionDescription: string;
  imageUrl; description; category: string;                                                   // backend-owned presentation (docs/MARKETS.md §1): own image else the event's; the series' category
  metadata: { imageUrl; description; updatedAt: string } | null;                             // the operator's own presentation row, null when the market shows its event's image
  createdAt; expiresAt; tradingStartsAt: string; gracePeriodSecs; liquidityPeriodSecs: number; isDynamic: boolean;
  reserveYes; reserveNo; liquidityL; lpTokenSupply; currentPrice: Decimal; feeBps; prizeFeeShareBps: number;
  accumulatedFees; prizePool; totalVolume: Decimal; status: MarketStatus; outcome: Outcome | null; resolvedAt: string | null;
  proposal: { proposer; proposedOutcome: Outcome; proposedAt; bond; challenger: string | null; challengerOutcome: Outcome | null; challengeEndsAt } | null;
  policy: { operatorResolution: boolean; sources: string[]; sourceKeys: { sourceUri; publicKey }[]; reporters: string[]; quorum; challengeSecs: number; bond: Decimal };
  auditObservers: string[]; phase: Phase; archived: boolean; tradeCount: number; lastTradeAt: string | null;
  previousPrice: Decimal | null; priceChange24h: Decimal | null; volume24h: Decimal;   // from the hourly candles
  openInterest: { yes; no; total: Decimal }; liquidity: Decimal;                        // outstanding shares; pool value V(P)
  book: { yesBid; yesAsk; noBid; noAsk; reference: Decimal } | null;                    // AMM-implied for a 1-unit order, trading only
  updatedOffset; createdOffset: number; synchronizerId: string | null;
  createdEventBlob?: string | null;        // GET /markets/:id only — the disclosed contract a user-signed trade needs
}
interface MarketSummary { marketId; ticker; eventTicker; yesSubTitle; noSubTitle; contractId; collateral: InstrumentRef; question; imageUrl; category; status; outcome; currentPrice; expiresAt; resolvedAt; phase; archived }
interface MarketEvent {
  id: string; eventId: string; marketId: number; kind: MarketEventKind; actor: string; side: "Yes" | "No" | null;
  instrument: InstrumentRef;                                                                  // the market's collateral: what amount / net / fee / notional are in
  amount; net; shares; sharesOut; fee; priceBefore; priceAfter; lpTokens: Decimal | null; outcome: Outcome | null;
  details: Record<string, unknown>; offset: number; updateId: string; commandId: string | null; effectiveAt: string;
}
interface PricePoint { t: string; price: Decimal; volume: Decimal; offset: number }
interface Position { contractId; holder; marketId; instrument: InstrumentRef | null /* the market's collateral; null only when the market is not indexed */;
  yesShares; noShares; costBasis; active; createdAt; createdOffset; archivedAt; market: MarketSummary | null; value: Decimal | null; redeemable: Decimal | null }
interface LiquidityPosition { contractId; provider; marketId; instrument: InstrumentRef | null; lpTokens; deposited; active; createdAt; createdOffset; archivedAt; market; poolShare: Decimal | null }
interface WalletEntry { id; eventId; owner; instrument: InstrumentRef; kind: "deposit" | "grant" | "credit" | "debit" | "withdraw"; amount; reason: string | null;
  txRef: string | null /* deposit: the transfer ref; grant: reward:<grantId> */;
  balanceAfter: Decimal | null; marketId: number | null; rootChoice: string | null; walletContractId; offset; updateId; effectiveAt }
interface IndexedWallet { contractId; owner; instrument: InstrumentRef; balance; deposited; withdrawn; creditRefs: string[]; updatedOffset; updatedAt }
interface LedgerPayout { contractId; user; marketId; instrument: InstrumentRef; amount; reason; createdAt; createdOffset; active;
  settledKind: "mark_paid" | "settle_to_wallet" | "cancelled" | "archived" | null; settledAt; settledOffset; txHash: string | null; refunded: boolean | null }
interface LedgerTransfer { updateId; nodeId: number; offset; direction: "in" | "out"; counterparty; instrument: InstrumentRef; amount; kind: "token_standard" | "amulet"; choice; recordTime }
interface LedgerHolding { contractId; owner; instrument: InstrumentRef; amount; locked: boolean; lockExpiresAt: string | null; createdOffset: number; active: boolean }   // the treasury's token-standard holdings (docs/TOKENS.md §4.2)
interface TransferInstruction { contractId; instrument: InstrumentRef; sender; receiver; amount; executeBefore: string | null; status: "pending" | "completed" | "failed"; createdOffset: number }   // two-step offers the treasury sent or received
interface Attestation { contractId; attester; marketId; sourceUri; fetchedAt; outcome; payloadHash; hasSourceSignature; responseExcerpt; active; createdOffset }
interface ModelForecast { contractId; author; marketId; modelId; probabilityYes; committedAt; marketPriceAtCommit; active; createdOffset }
interface LedgerStatus { enabled; running; bootstrapped: boolean; bootstrappedAt; bootstrapOffset; offset: number; ledgerEnd; lag; prunedOffset: number | null;
  lastUpdateId; lastRecordTime; lastError; lastErrorAt: string | null; gaps: { fromOffset; toOffset; reason; at }[]; updatedAt }
```

### Markets (public)
`:market` is a numeric `marketId` or a ticker (case-insensitive) on every route below (docs/MARKETS.md §2).
- `GET /markets?status=Trading|Proposed|Resolved|Voided|active|settled&category=&event=&series=&tickers=A,B&q=&sort=newest|oldest|volume|expiry|activity&includeArchived=&withSparkline=&page=&limit=` → `{ items: Market[], page, limit, total }` (archived markets excluded unless asked; `event` / `series` filter by catalog membership; `withSparkline=true` attaches `sparkline: { periodInterval: 60, startTs, closes: Decimal[] }` — the last 24 hourly closes, dense, carried forward — to every market of the page with one extra query)
- `GET /markets/categories` → `{ category, markets }[]` (series categories through the event; uncategorised series left out)
- `GET /markets/:market` → `{ market: Market }` (with `createdEventBlob`) | `404 not_found`
- `GET /markets/:market/activity?kind=&page=&limit=` → `{ items: MarketEvent[], … }` newest first
- `GET /markets/:market/trades?kind=&page=&limit=&cursor=` → the `buy sell swap split merge` subset; with `cursor=` (empty for the first page, then the previous answer's `nextCursor`) the feed is keyset-paginated (`nextCursor: string | null`, no `total`) — what an activity feed polls

```ts
// every activity row also carries the trade-feed view (Kalshi GET /markets/trades):
interface MarketEvent { …; tradeId: string /* = eventId */; ticker: string; action: "buy" | "sell" | "swap" | "split" | "merge" | null;
  yesPrice: Decimal | null /* priceAfter */; noPrice: Decimal | null /* 1 − yesPrice */; notional: Decimal | null /* amount */;
  takerParty: string /* masked: first 8…last 6 of the party id */; createdAt: string /* effectiveAt */ }
```
- `GET /markets/:market/price-history?from=&to=&resolution=raw|1m|5m|15m|1h|4h|1d&limit=` → `{ marketId, resolution, points: PricePoint[] }` oldest first (one point per market version, or the last per bucket; the latest `limit` win)
- `GET /markets/:market/forecasts` → `{ forecasts: ModelForecast[] }` · `GET /markets/:market/attestations` → `{ attestations: Attestation[] }`

### Candlesticks (public; docs/MARKETS.md §5)
- `GET /markets/:market/candlesticks?startTs=&endTs=&periodInterval=1|60|1440` → `Candlesticks` — epoch seconds; `periodInterval` in minutes (default 60); defaults to the last 200 periods ending now; dense (every period from the market's first candle on, quiet periods carried forward with `empty: true`); at most 5 000 candles (`400 validation_failed`)
- `GET /events/:ticker/candlesticks?startTs=&endTs=&periodInterval=` → `EventCandlesticks` — the same read for every member market of the event at once (every status, busiest by 24 h volume first), one shared window so the series align by construction: the lines of a Kalshi event chart | `404 not_found`

```ts
interface Candle { startTs: number; endTs: number;   // [startTs, endTs) epoch seconds
  price: { open; high; low; close; mean: Decimal; previous: Decimal | null };   // mean = volume-weighted post-trade price
  volume: Decimal; trades: number; openInterest: Decimal; liquidityL: Decimal | null; empty: boolean }
interface Candlesticks { marketId: number; ticker: string; instrument: InstrumentRef /* what volume is in */; periodInterval: 1 | 60 | 1440; startTs; endTs: number; candlesticks: Candle[] }
interface EventCandlesticks { eventTicker: string; periodInterval; startTs; endTs: number;
  markets: { marketId; ticker; instrument: InstrumentRef; yesSubTitle; noSubTitle; status; currentPrice: Decimal; candlesticks: Candle[] }[] }
```

### Quotes and orders (docs/MARKETS.md §6–§7)
- `GET /markets/:market/quote?action=buy|sell|swap|provide_liquidity&side=Yes|No&amount=&shares=&slippageBps=` (public) → `Quote` | `409 market_not_tradable` (`details.phase`) | `409 quote_unavailable` | `400 validation_failed` — `amount` for buy / provide_liquidity, `shares` for sell / swap; slippage 0..2000 bps (default 100)
- `POST /markets/:market/orders/prepare` (user session) `{ action: buy|sell|swap|split|merge|provide_liquidity|withdraw_liquidity|redeem, side?, amount?, shares?, lpTokens?, slippageBps? }` → `PreparedOrder` (the `ExerciseCommand` uses the v17 argument names: `amount`, `minProceeds`, `valueIncrease`, `maxCost`; `walletContractId` is the account's wallet in `market.collateral`) | `409 no_primary_wallet` | `409 no_in_app_wallet` (`details.instrument` — deposit that instrument first) | `409 no_position` | `409 insufficient_balance` (`details.balance`, `details.required`) | `409 insufficient_shares` (`details.heldShares`, `details.requestedShares`) | `409 market_not_tradable` | `409 trading_halted` (`details.estimatedResumeAt`; never for `redeem`) | `409 quote_unavailable`

```ts
interface Quote { marketId; ticker; instrument: InstrumentRef /* the market's collateral */; contractId; updatedOffset; nowSeconds: number; phase: Phase; effectiveL: Decimal;
  quote: QuoteBuy | QuoteSell | QuoteSwap | QuoteLiquidity;
  bounds: { slippageBps: number; minSharesOut?: Decimal; minProceeds?: Decimal; maxCost?: Decimal } }
interface QuoteBuy { action: "buy"; side; amount; fee; net; sharesOut; avgPrice; priceBefore; priceAfter; priceImpact; maxPayout: Decimal }
interface QuoteSell { action: "sell"; side; sharesIn; gross; fee; net; avgPrice; priceBefore; priceAfter; priceImpact: Decimal }
interface QuoteSwap { action: "swap"; fromSide; sharesIn; feeShares; sharesOut; priceBefore; priceAfter; priceImpact: Decimal }
interface QuoteLiquidity { action: "provide_liquidity"; valueIncrease; cost; lpMinted; poolShare; newL: Decimal }
interface PreparedOrder { action; marketId; ticker; actAs: string;                       // the account's primary party signs
  command: { ExerciseCommand: { templateId; contractId; choice; choiceArgument } };      // JSON Ledger API v2, sign as-is
  disclosedContracts: { templateId; contractId; createdEventBlob; synchronizerId }[];   // the market version
  quote: Quote | null; inputs: { marketContractId; walletContractId; positionContractId; lpPositionContractId: string | null };
  ledgerOffset: number; nowSeconds: number; expiresAt: string }
```

### Catalog (public; docs/MARKETS.md §2–§3)
Listings are **per instrument** (docs/TOKENS.md §4.5): `?instrument=<admin>:<id>` names the collateral the events, counts and sums are computed over (default: the default collateral; `400 validation_failed` when malformed). An event is denominated in the instrument its first market fixed; an event without a market yet belongs to no instrument and is listed under every one with zero figures and `instrument: null`.
- `GET /series?category=&status=active|archived|all&q=&instrument=&page=&limit=` → `{ items: Series[], … }` (active only by default; `eventCount`, `marketCount`, `volume` in `instrument`)
- `GET /series/:ticker?instrument=` → `{ series: Series, events: Event[] }` | `404 not_found`
- `GET /events?series=&status=unopened|open|closed|settled|all&category=&q=&sort=trending|newest|closing|volume&instrument=&withNestedMarkets=&includeArchived=&page=&limit=` → `{ items: Event[], … }` (only events in `instrument`, plus the ones without a market; status derived from the member markets; `sort` ranks the whole catalog — `trending` = 24 h hourly-candle volume across the members then lifetime volume, `closing` = soonest still-open close time first, `newest` = created, `volume` = lifetime; default by strike date, newest first; nested markets likeliest outcome first)
- `GET /events/:ticker` → `{ event: Event }` with `markets` nested | `404 not_found`
- `GET /events/:ticker/trades?limit=&cursor=` → `{ items: MarketEvent[], limit, nextCursor }` — the pool trades of every member market, newest first, keyset-paginated (`cursor` = the previous `nextCursor`) | `404 not_found`

```ts
interface Series { ticker; title; category: string; frequency: "one_off" | "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "custom";
  tags: string[]; settlementSources: { name; url }[]; contractUrl: string | null; description: string; status: "active" | "archived";
  productMetadata: Record<string, unknown>;
  instrument: InstrumentRef | null /* what the three figures below are in: the query's, else the default collateral; null when none is configured */;
  eventCount /* events in that instrument, incl. those without a market yet */; marketCount: number /* their member markets in it */; volume: Decimal /* Σ totalVolume of those */;
  createdAt; updatedAt }
interface Event { ticker; seriesTicker; title; subTitle; category; imageUrl; description: string; mutuallyExclusive: boolean;
  strikeDate: string | null; strikePeriod: string | null; settlementSources: { name; url }[]; productMetadata; archived: boolean;
  status: "unopened" | "open" | "closed" | "settled"; instrument: InstrumentRef | null /* fixed by the first market (or its submission); every aggregate below is a sum over the members in it */; marketCount: number; volume: Decimal; closeTime: string | null;
  volume24h: Decimal /* Σ members' last 24 h */; openInterest: Decimal /* Σ outstanding shares */; liquidity: Decimal /* Σ pool value */;
  topMarket: { marketId; ticker; yesSubTitle; currentPrice: Decimal } | null /* the likeliest outcome */;
  markets?: Market[] /* likeliest first */; createdAt; updatedAt }
```

### Exchange (public; docs/MARKETS.md §8)
- `GET /exchange/status` → `{ exchangeActive, tradingActive: boolean, halt: { active, reason, since, estimatedResumeAt }, ledger: { indexEnabled, indexRunning, offset, ledgerEnd, lag, lastRecordTime, lastError, stale }, network, packageName, serverTime }`
- `GET /exchange/instruments` → `{ instruments: (InstrumentRef & { kind: "collateral" | "rewards", enabled: boolean, isDefaultCollateral: boolean, walletInstrumentId: string })[] }` — every enabled instrument (docs/TOKENS.md §4.1); `walletInstrumentId` is what the Cantor8 wallet SDK's `send()` expects

### Ledger (public)
- `GET /ledger/status` → `LedgerStatus`
- `GET /ledger/wait?offset=&timeoutMs=` → `200 { reached: boolean, offset, requested }` — resolves once the index reaches `offset` or after `timeoutMs` (default 10 s, max 30 s)
- `GET /stats?instrument=<admin>:<id>` → `{ instrument: InstrumentRef, markets: { total, trading, proposed, resolved, voided }, totalVolume, volume24h, trades, trades24h, traders, indexedOffset }` — over the markets of one instrument (default: the default collateral)
- `GET /leaderboard?window=24h|7d|30d|all&limit=&instrument=` → `{ window, instrument: InstrumentRef, entries: { party, instrument, volume, trades, markets, realizedPnl }[] }`

### Portfolio (session; user sessions only)
The account's parties = the primary party + every active linked wallet.
- `GET /me/positions?status=open|all` → `{ parties, positions: Position[] }` (`value` = mark-to-market while Trading, the redeemable amount once settled)
- `GET /me/liquidity?status=open|all` → `{ parties, positions: LiquidityPosition[] }`
- `GET /me/trades?marketId=&kind=&page=&limit=` · `GET /me/activity?…` → `{ items: MarketEvent[], … }`

### In-app wallet ledger (session)
- `GET /in-app-wallet/ledger` → `{ partyId, wallet: IndexedWallet | null, payouts: LedgerPayout[] }`
- `GET /in-app-wallet/history?kind=&page=&limit=` → `{ items: WalletEntry[], … }` — the statement of the primary party's UserWallet
- `GET /in-app-wallet/transfers?direction=&instrument=<admin>:<id>&page=&limit=` → `{ items: LedgerTransfer[], … }` — token transfers between the treasury and the account's wallets, every row with its `instrument` and `amount`; omitted `instrument` = every instrument

### Rewards (session; user sessions only; docs/TOKENS.md §4.6)
- `GET /me/rewards` → `{ instrument: InstrumentRef, wallet: LedgerWallet | null, totals: { credited: Money, queued: Money }, grants: RewardGrant[] }` — the account's rewards wallet as the ledger shows it, the grants credited and the ones still in flight (`queued` = queued + submitted + blocked_float), the last 100 grants newest first | `404 not_found` (no rewards instrument configured)

```ts
interface RewardGrant { id: string; userId: string | null; party: string; ruleId: string | null;
  kind: "trade_volume_rebate" | "winning_redeem_bonus" | "first_deposit_bonus" | "manual";
  sourceEventId: string | null /* the wallet entry / market event it was earned on; null for manual */;
  instrument: InstrumentRef; amount: Money; reason: string;
  status: "queued" | "submitted" | "credited" | "failed" | "blocked_float";
  commandId: string | null /* reward-grant-<id>-<attempt> */; ref: string /* reward:<id>, what UserWallet.creditRefs carries once credited */;
  error: string | null; createdAt: string; creditedAt: string | null }
interface RewardRule { id: string; kind: "trade_volume_rebate" | "winning_redeem_bonus" | "first_deposit_bonus"; params: Record<string, string> /* decimal strings */; enabled: boolean; createdAt; updatedAt }
```

### Admin — ledger (admin session)
- `GET /admin/ledger/status` → `LedgerStatus`
- `POST /admin/ledger/resync` `{ reason }` → `{ status }` (re-snapshot the ACS at the ledger end; audited `ledger.resync`)
- `GET /admin/ledger/events?updateId=&contractId=&marketId=&entity=&choice=&fromOffset=&page=` → raw created / exercised events (`{ id, eventId, offset, nodeId, updateId, kind, template, contractId, choice, consuming, actingParties, payload, result, parentNodeId, effectiveAt, commandId }`)
- `GET /admin/ledger/wallets?owner=` · `GET /admin/ledger/payouts?active=&user=` · `GET /admin/ledger/transfers?direction=&counterparty=&instrument=<admin>:<id>` (every row with `instrument` and `amount`)
- `GET /admin/ledger/holdings?instrument=&active=&page=` → `{ items: LedgerHolding[], … }` — the treasury's token-standard holdings as indexed, largest first (docs/TOKENS.md §4.2; what a registry-mode transfer can spend)
- `GET /admin/ledger/transfer-instructions?instrument=&status=pending|completed|failed&party=&page=` → `{ items: TransferInstruction[], … }` — two-step offers the treasury sent or received (`party` matches sender or receiver)
- `GET /admin/ledger/markets/:marketId/positions` · `/liquidity` → holders / providers, largest first

### Admin — catalog and exchange (admin session; docs/MARKETS.md §2–§4, §8)
`reason` is optional on the catalog routes (presentational data) and recorded on the audit row when given.
- `POST /admin/series` `{ ticker, title, category?, frequency?, tags?, settlementSources?, contractUrl?, description?, productMetadata?, reason? }` → `{ series }` | `409 catalog_conflict`
- `PATCH /admin/series/:ticker` `{ …any of the above, status?: active | archived }` → `{ series }`
- `POST /admin/events` `{ ticker, seriesTicker, title, subTitle?, imageUrl?, description?, mutuallyExclusive?, strikeDate?, strikePeriod?, settlementSources?, productMetadata?, reason? }` → `{ event }` | `404 not_found` (series) | `409 catalog_conflict`
- `PATCH /admin/events/:ticker` `{ …, archived? }` → `{ event }`
- `POST /admin/markets` `{ collateral?: { admin, id }, eventTicker, ticker, question, yesSubTitle?, noSubTitle?, imageUrl?, description?, resolutionDescription?, expiresAt, gracePeriodSecs?, isDynamic?, liquidityPeriodSecs?, initialProbability, initialValue, feeBps?, prizeFeeShareBps?, policy? (with `bond`), auditObservers?, reason? }` → `{ commandId, status, ticker, eventTicker, collateral: InstrumentRef, expectedMarketId }` | `400 validation_failed` (`ticker` / `eventTicker` missing or malformed, a side label over 80 chars, a `collateral` that is not an enabled collateral instrument) | `409 catalog_conflict` (incl. a collateral other than the event's) | `503 not_ready` (MarketCounter not indexed, or no default collateral configured) | `502 upstream_failed` (Enterprise Wallet, incl. a duplicate ticker's command id). `yesSubTitle` / `noSubTitle` default to `Yes` / `No`; all four identity fields are mandatory on the contract. `imageUrl` / `description` are backend-owned presentation written to `to_market_metadata` before the submit, never to the ledger (a blank `imageUrl` shows the event's image); the category is the series'.
- `PATCH /admin/markets/:market/metadata` `{ imageUrl?, description?, reason? }` → `{ market }` | `400 validation_failed` (neither field) | `404 not_found`. Audited `catalog.market_metadata_updated`; publishes `truthoracle.catalog.changed { kind: "market" }`.
- `POST /admin/exchange/halt` `{ active: boolean, reason, estimatedResumeAt? }` → `{ halt }`

### Admin — instruments (admin session; docs/TOKENS.md §4.1)
- `GET /admin/instruments` → `{ instruments: AdminInstrument[] }` (disabled rows included)
- `POST /admin/instruments` `{ admin, id, decimals, kind: "collateral" | "rewards", symbol?, name?, enabled?, isDefaultCollateral?, registryUrl?, registryAuth?: "none" | "ledger" | "keycloak", transferMode?: "wallet" | "registry" | null, walletInstrumentId?, setupChoices?, reason? }` → `{ instrument }` | `409 instrument_exists`
- `PATCH /admin/instruments/:admin/:id` `{ symbol?, name?, decimals?, enabled?, isDefaultCollateral?, registryUrl?, registryAuth?, transferMode?, walletInstrumentId?, setupChoices?, reason? }` → `{ instrument }` | `404 not_found` — the `(admin, id)` pair is immutable
- `POST /admin/instruments/:admin/:id/setup` `{ autoAccept?: boolean, mintDelegation?: boolean, reason? }` → `{ instrument: InstrumentRef, factoryId, factoryTemplateId, actions: { kind: "autoAccept" | "mintDelegation", choice, commandId, status }[] }` | `400 validation_failed` (neither action) | `404 not_found` | `503 not_ready` (no `registryUrl`) | `502 upstream_failed` (registry or wallet) — the one-off setup a Cantor8 token needs from the treasury (docs/TOKENS.md §4.4): the registry's transfer-factory lookup for a self-transfer of 0 names and discloses the token's factory, and the instrument's `setupChoices.autoAccept` (default `CreateAutoAccept { receiver: treasury }`) / `setupChoices.mintDelegation` (default `CreateMintDelegation { recipient: treasury }`) are exercised on it as the treasury under `setup-<kind>-<sha256(admin|id|treasury)[:40]>`; audited `token.setup` per action. Not applicable to Canton Coin.

```ts
interface AdminInstrument extends InstrumentRef { kind; enabled; isDefaultCollateral: boolean; walletInstrumentId: string;
  registryUrl: string | null; registryAuth: "none" | "ledger" | "keycloak"; transferMode: "wallet" | "registry" | null;
  setupChoices: Record<string, string>; createdAt; updatedAt }
```

### Admin — rewards (admin session; docs/TOKENS.md §4.6)
Every route answers `503 not_ready` when no rewards instrument is configured (`REWARDS_INSTRUMENT_ADMIN`), except the rules, which exist regardless.
- `GET /admin/rewards/rules` → `{ rules: RewardRule[] }` — the three automatic rules, seeded at boot with the documented defaults (`trade_volume_rebate { perUnit: "0.01", minTrade: "1" }`, `winning_redeem_bonus { fraction: "0.05" }`, `first_deposit_bonus { amount: "10" }`), enabled only on `APP_ENV=dev`
- `PUT /admin/rewards/rules/:id` `{ params?, enabled?, reason }` → `{ rule }` | `400 validation_failed` (a key the kind does not have, a missing key, a non-decimal value, `fraction` above 1) | `404 not_found`. `params` replaces the whole object. Audited `reward.rule_updated` with before / after.
- `POST /admin/rewards/grant` `{ userId | party, amount, reason }` → `{ grant: RewardGrant }` (status `queued`; the processor submits it on its next pass). By `userId` the grant goes to the account's primary party (`404 not_found`, `403 user_suspended`, `409 no_primary_wallet`); by `party` to that party, attributed to its account when one has linked it (`userId: null` otherwise). `amount` must be positive and whole in the instrument's decimals (`400 validation_failed`). Audited `reward.grant_requested`.
- `GET /admin/rewards/grants?status=queued|submitted|credited|failed|blocked_float&userId=&page=&limit=` → `{ items: RewardGrant[], … }` newest first
- `GET /admin/rewards/float` → `{ instrument: InstrumentRef, treasuryHoldings: Money, liabilities: Money, pending: Money, headroom: Money }` — the float rule's figures from the index: Σ of the treasury's active holdings of the rewards instrument, Σ `UserWallet.balance` in it, the grants submitted or credited that the index does not show in a balance yet, and `headroom = treasuryHoldings − liabilities − pending` (a grant is submitted only while it fits)

### Admin — tokens (admin session; docs/TOKENS.md §4.7)
Mint and burn go through Cantor8's token-app; without `TOKEN_APP_URL` both answer `503 token_app_unconfigured` before anything is written. Amounts must be positive and whole in the instrument's decimals (`400 validation_failed`).
- `POST /admin/tokens/mint` `{ instrument: { admin, id }, amount, to?: "treasury" | <party>, creditUserId?, reason }` → `TokenOperation` | `404 instrument_unknown` | `409 instrument_disabled` | `502 upstream_failed` (token-app). Default target: the treasury. With `creditUserId` (mint-and-credit, the on-ramp primitive) the mint must land on the treasury (`400 validation_failed` otherwise) and the account must be active with a primary party (`404 not_found`, `403 user_suspended`, `409 no_primary_wallet`, `409 kyc_duplicate_identity`); its `UserWallet` in the instrument is created BEFORE the mint, then `UserWallet.Deposit { amount, txRef: "mint:<commandId>" }` runs through the deposit write-ahead row and confirm pass (ARCHITECTURE §8.3) — `credit.status` is `confirmed` or `submitted` (the DepositConfirmProcessor finishes it). A credit refused while another credit of the account is in flight answers `409 deposit_in_progress` with `details.mint` naming the mint that already landed. Audited `token.mint`; publishes `truthoracle.token.minted`.
- `POST /admin/tokens/burn` `{ instrument, amount, party, reason }` → `TokenOperation` (`credit: null`) | `404 not_found` (unregistered instrument; disabled ones may be burned). Audited `token.burn`; publishes `truthoracle.token.burned`.
- `GET /admin/tokens/status` → `{ tokenApp: { configured, url, appName, reachable, raw }, instruments: { instrument: InstrumentRef, treasuryHoldings: Money, liabilities: Money }[] }` — token-app's own `/status` snapshot (`reachable: false`, never an error, when it is down or unconfigured) next to the index's float per registered instrument (disabled ones included)

```ts
interface TokenOperation { commandId: string /* mint-<24 hex> | burn-<24 hex> */; status: string /* token-app's */; instrument: InstrumentRef; amount: Money;
  party: string /* minted to / burned from */; credit: { commandId: string /* mint-credit-<sha256(commandId)[:40]> */; txRef: string /* mint:<commandId> */; status: "confirmed" | "submitted" } | null }
```
