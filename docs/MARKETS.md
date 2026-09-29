# Markets — series, events, candles, quotes and orders

How TruthOracle's markets are organised and traded, the way an exchange such as Kalshi organises
its own (`docs.kalshi.com/api-reference`), adapted to what this platform is: binary pm-AMM pools
on the Canton ledger, traded by user-signed Daml choices, indexed by the backend. This document
is the contract for the catalog, the candle pipeline, the quote / order routes and the exchange
status; the wire shapes are in `docs/API.md` ("Catalog", "Candlesticks", "Quotes and orders",
"Exchange"), the tables in `docs/INDEXER.md` §3, the seams in `docs/INTERNALS.md` (P7).

## 1. What lives where

The rule: **on the ledger only what a trader signs for, what a choice reads, or what a
resolution is judged against; everything else is the backend's.** Presentation is mutable and
unsigned — a broken image link must not need a new market, and every successor version of a
contract copies its fields into every trade transaction, so bytes nobody signs for are pure
cost there. truthoracle-v16 applies that rule: `PredictionMarket` carries no `imageUrl`,
`description` or `category` any more (v15 did; no choice ever read them).

| What | Lives | Owner | Why |
|---|---|---|---|
| **Market** (`PredictionMarket`) — the pool, its price, fees, timing, the resolution policy and terms (`resolutionDescription`), and its identity: `question`, `ticker`, `eventTicker`, `yesSubTitle`, `noSubTitle` (mandatory `Text`) | Daml, indexed into `to_markets` | the treasury creates it, the ledger owns it | what a trader signs must name what it is and how it settles; reporters and challengers judge against immutable terms |
| **Market presentation** — `imageUrl`, `description` | Postgres `to_market_metadata`, keyed by ticker | operator (`POST /admin/markets` writes it, `PATCH /admin/markets/:market/metadata` edits it) | mutable, unsigned; a market without a row shows its event's image and no description |
| **Event** — one dated instance of a series that groups N binary markets ("Fed decision, March 2026" → "cut ≥ 25 bps", "cut ≥ 50 bps", "hold"); carries the catalog artwork | Postgres `to_events` | operator (`/admin/events`); the projection writes a placeholder row when a market names an event the operator has not created yet | presentation and grouping; a market's membership is its on-ledger `eventTicker`, nothing else |
| **Series** — the recurring template ("Fed rate decisions", monthly, Economics); carries the **category** | Postgres `to_series` | operator (`/admin/series`) | catalog only; a market's `category` is its series' through the event |
| **Candles**, open interest, 24 h figures | Postgres `to_market_candles`, `to_markets.open_interest_*` | the projection, in the ledger transaction's own DB transaction | derived data: rebuildable from the raw event log |
| **Quotes**, prepared orders | computed on request | backend, from the index | a pm-AMM has no order book; the quote is the AMM formula over the indexed market version |

Nothing off-ledger can change what a market pays or when it resolves. The catalog decides how
markets are *shown together* and *shown*; the ledger decides what they *are*. If tamper-evidence
of a long description ever matters, commit a hash of it on-ledger, not the text.

## 2. Identity: tickers and the event link

Kalshi-style tickers (`^[A-Z0-9][A-Z0-9._-]{1,63}$`, upper case): a series `FED`, its event
`FED-26MAR`, its markets `FED-26MAR-CUT25`, `FED-26MAR-CUT50`, `FED-26MAR-HOLD`. Every
`/markets/:market` route accepts a ticker or the numeric `marketId`.

A market's identity is **the contract's, and only the contract's**. truthoracle-v16 carries
`ticker`, `eventTicker`, `yesSubTitle` and `noSubTitle` as mandatory `Text` on
`PredictionMarket` and on `MarketCounter.CreateMarket` (the contract refuses an empty one); the
indexer writes them on every version, normalised the way every ticker input is (trimmed,
upper-cased), and there is no operator route that edits them — what a trader signs is what the
catalog shows. Nothing is synthesised and nothing is filled in off-ledger: a from-scratch v16
deployment never has a market without its identity.

The index only protects itself, never the data:

- an on-ledger ticker another market already holds is stored as `<ticker>~<marketId>` (the
  column is unique and the projection must not stall on an operator's mistake) and logged at
  error level — void or archive the duplicate on-ledger;
- a malformed ticker (outside the pattern) is kept as-is and logged; the market stays
  addressable by id.

`eventTicker` may name an event the operator has not written to the catalog yet (the market was
created first, or straight from a script). The projection then creates a **placeholder event**
in the same transaction — `title` = the ticker, `strikeDate` from the market, no image — filed
under a **placeholder series** named after the event ticker's first segment (`FED-26MAR` →
`FED`, the whole ticker when there is no usable segment; no category). The catalog therefore
never dangles: `GET /events/:ticker` answers at once, and the operator fills the rows in with
`PATCH /admin/events/:ticker` (title, series, image, strike, …) and `PATCH /admin/series/:ticker`
(category, …). Placeholders are not audited (they are ledger-derived); the operator's edits
are. Creating a series or event the placeholder already exists for answers `409 catalog_conflict`
— patch it instead.

## 3. Events and series

An event's derived fields come from its member markets at read time, so they can never disagree
with the ledger:

| Field | Derivation |
|---|---|
| `status` | `settled` when every market is resolved / voided; else `open` when any market's phase is `trading`; else `unopened` when any is still in its liquidity period (or there are no markets); else `closed` (expired / proposed, awaiting resolution) — Kalshi's `unopened / open / closed / settled` |
| `marketCount`, `volumeCC` | count and Σ `totalVolumeCC` of the members |
| `closeTime` | the latest `expiresAt` among the members |
| `category` | the series' |
| `settlementSources` | the event's own sources when set, else the series' |

`mutuallyExclusive` is **informational**: each market is its own pm-AMM pool with independent
collateral, so nothing on-ledger nets positions across the legs (Kalshi's `MECNET`). The resolver
is expected to resolve exactly one leg `Yes` when the flag is set; the UI shows the flag and the
sum of the legs' Yes prices.

Series carry `frequency`, `category`, `tags`, `settlementSources`, `contractUrl`, `status`
(`active | archived`). Archiving a series or an event hides it from the public lists
(`includeArchived=true` shows it); nothing happens to the markets.

## 4. Creating markets (operator)

`POST /admin/markets` (admin session) builds `MarketCounter.CreateMarket` for an event of the
catalog and submits it treasury-signed through the Enterprise Wallet (`/api/v1/external/submit`):

- the event must exist and not be archived; `ticker` and `eventTicker` are required and must be
  valid tickers (`400 validation_failed`), the ticker unused by any indexed market
  (`409 catalog_conflict`); `yesSubTitle` / `noSubTitle` are trimmed, at most 80 characters and
  default to `Yes` / `No` — the contract refuses an empty label;
- the `MarketCounter` contract id comes from the index (`to_indexer_state.market_counter_cid`;
  `503 not_ready` before the indexer has seen it);
- the command id is `create-market-<sha256(ticker)[:40]>`, so a retried request collides on
  ledger command-dedup instead of minting a second market (the Enterprise Wallet answers a
  duplicate as `502 upstream_failed`);
- `imageUrl` / `description` never reach the ledger: they are written to `to_market_metadata`
  (keyed by the ticker) before the submit, so the market shows them the moment the indexer
  sees it; a blank `imageUrl` means "the event's image". If the submit fails the row stays
  behind, harmless — the next attempt for the ticker overwrites it;
- `gracePeriodSecs` defaults to a day, `feeBps` to 30, the policy to operator resolution with no
  sources; every bound the Daml choice asserts is pre-checked;
- the answer carries `expectedMarketId` (= counter value + 1); the market is readable once the
  indexer applies the transaction — clients poll `GET /markets/<ticker>` or wait on
  `GET /ledger/wait?offset=`.

Presentation after the fact: `PATCH /admin/markets/:market/metadata { imageUrl?, description?,
reason? }` (id or ticker; `400 validation_failed` when neither field is sent, `404 not_found` for
an unknown market) upserts the row, audits `catalog.market_metadata_updated` and publishes
`truthoracle.catalog.changed { kind: "market", ticker }`. `Market.metadata` on the wire is the
row (or null), so a UI can tell an operator's image from the event fallback.

A `CreateMarket` submitted by any other client (a script, another wallet) must send the four
identity fields itself — the contract requires them — and gets no presentation until an operator
writes some.

## 5. Candles and open interest

Kalshi serves `GET /series/{series}/markets/{ticker}/candlesticks?start_ts&end_ts&period_interval`
with `period_interval ∈ {1, 60, 1440}` minutes and OHLC of bid, ask and trade price plus volume
and open interest. A pm-AMM has one price, so ours is:

```
GET /markets/:market/candlesticks?startTs=&endTs=&periodInterval=1|60|1440
→ { marketId, ticker, periodInterval, startTs, endTs,
    candlesticks: [{ startTs, endTs, price: { open, high, low, close, mean, previous },
                     volumeCC, trades, openInterest, liquidityL, empty }] }
```

**How the rows are produced — no separate aggregation worker.** Every `PredictionMarket` version
the indexer applies (`src/indexer/projection.ts`) is folded into one row per period of
`to_market_candles` **inside the same Postgres transaction** as the version, the raw event and
the cursor (`src/indexer/candles.ts`):

- `open` is written on insert only; `high` / `low` fold; `close`, `liquidity_l` and
  `open_interest` follow the newest version by (offset, node id);
- `volume_cc` accumulates Δ `totalVolumeCC` against the consumed predecessor (Buy = collateral,
  Sell = gross proceeds, SwapShares = shares × side price — the market's own volume measure);
- `notional_cc` accumulates `price_after × Δvolume`, so `mean = notional / volume` is the
  volume-weighted post-trade price (`close` when nothing traded);
- `trades` counts Buy / Sell / SwapShares versions (Split / Merge / Redeem create no market
  version and move no price).

A replayed ledger transaction is skipped as a whole (`to_ledger_events.event_id`), so nothing is
double-counted; a crash rolls the whole transaction back. This is exactly-once by construction,
which a cron that re-aggregates trades could only approximate — and it costs three upserts per
market version.

**Open interest** (`to_markets.open_interest_yes / _no` = outstanding shares across the active
positions) is maintained per `Position` create / archive in the same transaction; after an ACS
snapshot (bootstrap, resync) it is recomputed from `to_positions` because increments cannot be
trusted across a gap. Each candle stores the market's open interest after the last version of
its period.

**Reads** return a dense series: every period between `startTs` and `endTs` from the market's
first candle on, quiet periods carried forward from the previous close (`empty: true`, volume 0)
— what a chart draws. Windows are capped at 5 000 candles (`400 validation_failed`). Defaults:
the last 200 hourly buckets. A market that entered the index through a snapshot starts its chart
at the snapshot (one candle at the snapshot price, volume 0); the raw
`GET /markets/:market/price-history` (one point per version) is unchanged.

**Rebuild.** Candles and open interest are projections of the raw event log: `TRUNCATE
to_market_candles`, reset `open_interest_*`, and re-run the indexer from scratch
(`docs/INDEXER.md` §9 "Rebuild from scratch"). A partial rebuild tool is not part of this change.

**24 h figures on every market** (`previousPrice`, `priceChange24h`, `volume24hCC`) are read from
the hourly candles in two set queries per list page: `volume24hCC` = Σ hourly volume since
now − 24 h; `previousPrice` = the last hourly close before now − 24 h, else the market's first
price (a market younger than a day shows its change since open). If list pages ever get slow,
the scaling step is a `to_market_stats` row refreshed by a processor — not a change of the data.

## 6. Quotes (pm-AMM, not an order book)

Kalshi quotes come from an order book (`yes_bid / yes_ask`, market and limit orders). Here every
market is a Paradigm dynamic pm-AMM pool (`truthoracle-contracts/daml/daml/PmAmmMath.daml`): the
price is `Φ((y − x) / L_eff)` over the virtual reserves of the cached price, and a trade's fill is
the solution of the pool invariant. So:

- `GET /markets/:market/quote?action=buy|sell|swap|provide_liquidity&side=&amountCC=&shares=&slippageBps=`
  runs the same formulas (`src/amm/pm-amm.ts`, a port of PmAmmMath with the market-level
  wrappers of `Buy` / `Sell` / `SwapShares` / `ProvideLiquidity`) over the **indexed market
  version** at server time, and answers the fill, the fee, the average price, the price after,
  the price impact and the pool's effective liquidity — plus the **bounds** the choice argument
  must carry for the requested slippage: `minSharesOut` (buy, swap), `minProceedsCC` (sell),
  `maxCostCC` (provide). Default slippage 100 bps, max 2 000.
- The quote names the `contractId` and `updatedOffset` it was computed against; a trade must
  exercise that contract (every trade consumes the market version, so a quote against a stale
  version means a `CONTRACT_NOT_ACTIVE` at submission — the client re-quotes).
- Daml runs in `Decimal` (10 dp fixed point) and the port in doubles, so a fill can differ in
  the last decimals; the slippage bound absorbs it. Quotes are advisory; the ledger executes.
- `ApiMarket.book` (`yesBid / yesAsk / noBid / noAsk`) is the implied one-share price of a
  reference 1 CC buy / mirrored sell — Kalshi's bid / ask fields for a pool that has none.
  `liquidityCC` is the pool value `V(P) = L·φ(Φ⁻¹(P))` at the current effective liquidity.
- Quotes refuse with `409 market_not_tradable` (`details.phase`, `details.reason`) whenever the
  Daml choice would abort: not `Trading`, before the liquidity period ends, after expiry.

## 7. Orders: prepare server-side, sign in the wallet

Trades stay **user-signed** (ARCHITECTURE §18): the backend never holds a user key and never
submits a user's trade. What it does is assemble the exact command, because the inputs a browser
would need to read itself — the active market version and its disclosed-contract blob, the
account's `UserWallet` and `Position` contract ids — come back empty when read as an external
Cantor8 party on mainnet (`docs/INDEXER.md` §1), and the index has them:

```
POST /markets/:market/orders/prepare   (user session; the account's primary wallet signs)
{ action: buy|sell|swap|split|merge|provide_liquidity|withdraw_liquidity|redeem,
  side?, amountCC?, shares?, lpTokens?, slippageBps? }
→ { action, marketId, ticker, actAs, command: { ExerciseCommand }, disclosedContracts: [market],
    quote | null, inputs: { marketContractId, walletContractId, positionContractId, lpPositionContractId },
    ledgerOffset, nowSeconds, expiresAt }
```

The frontend passes `command` and `disclosedContracts` to the Cantor8 SDK's `signAndExecute`
(the party is the account's primary wallet, ARCHITECTURE §8.2), then waits on
`GET /ledger/wait?offset=` above `ledgerOffset` and reloads. Before answering, the route
pre-checks every rule the Daml choice asserts and answers a stable reason instead of a rejected
transaction: `409 no_primary_wallet`, `409 no_in_app_wallet` (deposit first), `409 no_position`,
`409 insufficient_balance` / `insufficient_shares` (with the held and requested amounts),
`409 market_not_tradable`, `409 trading_halted` (§8; `redeem` is never halted),
`409 quote_unavailable` (the pool cannot fill it, or the market's blob is not indexed).
`nowSeconds` is the server's clock; the Daml contracts trust the caller's `nowSeconds`
(they never call `getTime`), which is a known contract-level risk documented in
`truthoracle-contracts` — the prepared command is the honest timestamp, a hostile client can
still craft its own.

Not implemented on purpose: server-side order books, limit orders resting at the backend, and a
`to_orders` table. A user's submission is not visible as a command id to the treasury's view of
the ledger, so the backend cannot reliably match "the order I prepared" to "the trade that
landed"; the index's `GET /me/trades` is the fill record, and the client correlates by offset.
When custodial per-user parties arrive (ARCHITECTURE §17 phase 3) the backend will submit as the
user and an orders table becomes exact — that is the moment to add it.

## 8. Exchange status and the trading halt

Kalshi's `GET /exchange/status` answers `exchange_active` / `trading_active`. Ours:

```
GET /exchange/status → { exchangeActive, tradingActive, halt: { active, reason, since, estimatedResumeAt },
                          ledger: { indexEnabled, indexRunning, offset, ledgerEnd, lag, lastRecordTime, lastError, stale },
                          network, packageName, serverTime }
```

- `exchangeActive` = the ledger index is enabled (state changes are being recorded);
- `tradingActive` = no operator halt. `POST /admin/exchange/halt { active, reason,
  estimatedResumeAt? }` stores it in `to_settings` (`exchange_halt`), audits
  `exchange.halt_changed` and publishes `truthoracle.exchange.halt_changed`;
- `ledger.stale` = the index row was not touched for `EXCHANGE_STALE_AFTER_SEC` (300).

Because trades are user-signed on-ledger, the halt is honoured by the UI (banner, disabled
trade controls) and by `orders/prepare` (`409 trading_halted`, redemptions excepted); it cannot
stop a party that crafts its own command. The ledger-level lever remains the market's own status
(resolve / void / archive by the treasury).

## 9. Kalshi mapping (for readers coming from its API)

| Kalshi | Here | Note |
|---|---|---|
| `GET /exchange/status` | `GET /exchange/status` | same two flags plus the index health |
| `GET /series`, `GET /series/{ticker}` | `GET /series`, `GET /series/:ticker` | series are operator catalog rows |
| `GET /events?series_ticker&status&with_nested_markets` | `GET /events?series&status&withNestedMarkets` | status derived from the markets (§3) |
| `GET /events/{ticker}` | `GET /events/:ticker` | markets always nested |
| `GET /markets?event_ticker&series_ticker&tickers&status` | `GET /markets?event&series&tickers&status` | plus this platform's `category`, `q`, `sort` |
| `GET /markets/{ticker}` | `GET /markets/:market` | id or ticker; `phase` is Kalshi's status: `initialized`≈`liquidity`, `active`≈`trading`, `closed`≈`expired`/`proposed`, `settled`≈`resolved`/`voided` |
| market `yes_bid/ask`, `last_price`, `previous_price`, `volume_24h`, `open_interest`, `liquidity`, `result` | `book`, `currentPrice`, `previousPrice`, `volume24hCC`, `openInterest`, `liquidityCC`, `outcome` | AMM-implied book; CC not dollars |
| `GET /series/{s}/markets/{t}/candlesticks?period_interval` | `GET /markets/:market/candlesticks?periodInterval` | one price series (the pool's), volume in CC, dense |
| `GET /markets/trades` | `GET /markets/:market/trades`, `GET /me/trades` | fills are derived from ledger effects |
| `POST /portfolio/orders`, order book, `GET /portfolio/orders` | `GET /markets/:market/quote` + `POST /markets/:market/orders/prepare`, user-signed submission | no book, no resting orders (§7) |
| `GET /portfolio/positions`, `/balance`, `/settlements` | `GET /me/positions`, `GET /in-app-wallet`, `GET /in-app-wallet/{ledger,history}` | unchanged |

## 10. Verified

2026-09-29: `npm run typecheck`, `lint`, `build` exit 0; unit specs for the pm-AMM port
(`src/amm/pm-amm.spec.ts`, the Daml suite's invariants) and the candle helpers;
`test/catalog.e2e-spec.ts`, `test/candles.e2e-spec.ts`, `test/orders.e2e-spec.ts` and the
existing `test/ledger.e2e-spec.ts` against real Postgres + Redis with the fixture ledger
(catalog CRUD and derived status, placeholder catalog rows for an event the ledger names first,
the ticker collision rule, the treasury-signed CreateMarket with its identity validation and
deterministic command id, hourly / minute / daily
candles with volume, mean and open interest, snapshot seeding, quotes and their bounds,
prepared orders for every action and every refusal, the halt). `migration:generate` against the
migrated database proposes only the cosmetic jsonb-default rewrites Init.ts documents. Not yet
run against a live participant.
