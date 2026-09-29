# Ledger indexer — design and operations

The indexer keeps a Postgres projection of everything the TruthOracle Daml package does on the
Canton ledger — markets, every trade, liquidity move, resolution step, redemption, in-app wallet
movement, payout, attestation, model forecast — and the read API serves it (docs/API.md
"Markets", "Portfolio", "In-app wallet ledger", "Ledger", "Admin — ledger"). It lives inside this
monolith: one processor, a handful of services, fourteen tables, no extra process.

Why it exists (what the frontend does today, verified 2026-09-28 in `pm-frontend`):

- every read is a `POST /v2/state/active-contracts` snapshot polled every 15 s — there is no
  history anywhere: no trades, no deposits / withdrawals, no leaderboard;
- the probability chart is fabricated in the browser from the points a tab happened to see;
- per-user reads (`Position`, `UserWallet`, `PendingPayout` filtered by the user's party) come
  back **empty on mainnet**, because the participant proxy can read as the treasury party but not
  as an external Cantor8 party. Prod works around it with the wallet SDK's Scanner reads
  (`getActiveContracts`, `getLedgerUpdates`), which are browser-only and need a connected wallet.

The treasury party is signatory on `PredictionMarket`, `MarketCounter`, `UserWallet` and
`PendingPayout` and observer on `Position`, `LiquidityPosition`, `OutcomeAttestation`,
`ModelForecast` and `PredictionModel`, so **its transaction stream is the whole application**.
Indexing it once, as the treasury, gives every user their data without a ledger read of their
own. (`Incentives.UserRewardsSummary` / `ClaimedReward` are user-signed with no admin observer:
invisible to the treasury and not indexed.)

## 1. Source

`LedgerStreamService` (`src/services/ledger-stream.service.ts`) reads the Canton JSON Ledger
API v2 as `INDEXER_PARTY` (default `TREASURY_PARTY_ID`), with the same Keycloak client and base
URL rules as `LedgerClientService` (`ZKPC_*` only on mainnet):

| Call | Purpose |
|---|---|
| `GET /v2/state/ledger-end` | how far to read |
| `GET /v2/state/latest-pruned-offsets` | the participant's prune point (`participantPrunedUpToInclusive`) |
| `POST /v2/updates?limit=N` with `updateFormat.includeTransactions = { eventFormat: { filtersByParty: { party: wildcard }, verbose: false }, transactionShape: TRANSACTION_SHAPE_LEDGER_EFFECTS }` | pages of transactions with **created and exercised** events (choice, argument, result, `lastDescendantNodeId`) |
| `POST /v2/updates/trees?limit=N` | the deprecated (removed in 3.5) equivalent; `INDEXER_UPDATES_ENDPOINT=auto` falls back to it when `/v2/updates` answers 404 |
| `POST /v2/state/active-contracts?limit=N` with `activeAtOffset` | the ACS snapshot a bootstrap / resync starts from |

The wildcard filter has `includeCreatedEventBlob: true`: a user-signed trade must disclose the
market contract, so the active market version's blob is kept (`to_markets.created_event_blob`,
served by `GET /markets/:id`).

Both update shapes normalise to one `LedgerTransaction` (`src/indexer/events.ts`): the flat
`events[]` of `/v2/updates` and the `eventsById` map of `/v2/updates/trees`, with or without the
`{ value }` one-of wrapper. Parent / child relations are rebuilt from `nodeId` order and
`lastDescendantNodeId` (`buildEventTree`), which is how a child `UserWallet.Debit` is attributed to
the `Buy` that caused it.

### Value encoding

Daml values arrive as the JSON API's compact form: `Decimal` and `Int` as strings, enums as
strings (or `{ tag }`), `Optional` as `null` / the value (or `{ Some }` / `{ None }`), lists as
arrays. `src/util/ledger-values.ts` reads every one of these tolerantly and **never puts a Decimal
through `Number`** — prices, shares and CC are `bigint` in 1e-10 units end to end
(`util/money.ts`), `numeric(38,10)` in Postgres, 10-dp strings on the wire.

### The wallet SDK's `getLedgerUpdates` / `getActiveContracts`

`@cantor8/wallet-connect-sdk` 0.6 exposes both, but they are `postMessage` calls to the Cantor8
Scanner made with the **connected wallet's** token for the **connected party only**. They cannot
run in a server and cannot read as the treasury, so the backend reads the participant directly.
The shapes are deliberately compatible: a `LedgerNode` from the SDK and a `to_ledger_events` row
carry the same facts (offset, nodeId, updateId, eventType, templateId, contractId, actingParties,
payload), so a frontend that consumed Scanner nodes can consume `GET /admin/ledger/events` or the
typed routes with a trivial adapter.

## 2. The loop

`LedgerIndexerProcessor` → `IndexerService.runOnce()`:

```
lock:ledger-indexer (Redis, INDEXER_LOCK_TTL_MS, renewed every TTL/3)   one replica streams; others retry every 15 s
state = to_indexer_state['ledger']
if not bootstrapped → bootstrap()                                        §4
end = ledgerEnd()
if end ≤ state.offset → caught up; sleep INDEXER_POLL_MS
page = fetchUpdates(beginExclusive = state.offset, endInclusive = end, limit = INDEXER_BATCH)
   PARTICIPANT_PRUNED_DATA_ACCESSED → resync()                            §4
for tx in page:   ONE Postgres transaction:
   raw rows (to_ledger_events, ON CONFLICT DO NOTHING) — 0 inserted = replay → skip
   typed rows (§5)
   UPDATE to_indexer_state SET offset = tx.offset WHERE offset < tx.offset
   commit → NATS fan-out (§7), best-effort
page empty → offset = end (nothing for our party in between)
error → to_indexer_state.last_error, exponential backoff 1 s … 60 s, Sentry on the first and every 10th failure
```

The cursor moves only forward and only together with the rows it accounts for; a crash between
two transactions loses nothing, a crash inside one rolls back. `INDEXER_ENABLED=false` keeps the
read API on whatever was indexed and runs no loop (what the e2e suite does; specs drive
`IndexerService` against `FakeLedgerStream`).

## 3. Tables (`src/entities/*`, migration `LedgerIndex`)

No foreign keys to the account tables: rows are keyed by Canton party and contract id, and an
account's view is resolved at read time through `to_users.party_id` and `to_wallets.party_id`
(`PortfolioService.partiesOf`).

| Table | One row per | Notes |
|---|---|---|
| `to_indexer_state` | the index (`key = 'ledger'`) | `offset` (last applied), `ledger_end`, `pruned_offset`, `bootstrapped_at`, `bootstrap_offset`, `last_update_id`, `last_record_time`, `last_error(_at)`, `market_counter_cid/value`, `gaps` |
| `to_ledger_events` | created / exercised event of the TruthOracle package | verbatim payloads, `event_id = <updateId>:<nodeId>` (`acs:<cid>` for snapshot rows), parent / root node ids; the projections can be rebuilt from it |
| `to_markets` | `marketId` (current version) | every `PredictionMarket` field, `contract_id` = the ACTIVE contract, `created_event_blob`, `synchronizer_id`, `archived`, `trade_count`, `last_trade_at` |
| `to_market_snapshots` | `PredictionMarket` version | price / reserves / L / supply / volume / fee pots / status + `cause` (the choice) — the chart |
| `to_market_events` | market / counter choice | §5 |
| `to_positions` | `Position` version | `active` = current holding; archived rows = history |
| `to_liquidity_positions` | `LiquidityPosition` version | |
| `to_ledger_wallets` | `UserWallet` version | `active` per owner = the balance the ledger holds now |
| `to_wallet_entries` | `UserWallet` choice | the in-app statement: deposit / credit / debit / withdraw with amount, reason, `tx_ref`, `balance_after`, the market and root choice it belonged to |
| `to_ledger_payouts` | `PendingPayout` | and how it ended: `mark_paid` (+ `tx_hash`), `settle_to_wallet`, `cancelled` (+ `refunded`), `archived`; joins `to_payouts.pending_payout_cid` |
| `to_attestations` · `to_model_forecasts` · `to_prediction_models` | contract | |
| `to_ledger_transfers` | Canton Coin transfer involving the treasury | §6 |
| `to_market_candles` | (market, period ∈ 1 min / 1 h / 1 d, period start) | OHLC of the pool price, Σ Δvolume, Σ price × Δvolume, trade count, open interest and L after the period's last version — folded per market version in the same transaction (docs/MARKETS.md §5) |
| `to_series` · `to_events` | operator catalog rows (not ledger data; the projection writes placeholder rows when a market names an event that has none) | the series → event hierarchy markets are grouped into; membership is `to_markets.event_ticker` (docs/MARKETS.md §2) |

`to_markets` also carries the market's identity (`ticker`, `event_ticker`, `yes_sub_title`,
`no_sub_title` — the contract's own, mandatory on truthoracle-v15, NOT NULL in the index), the
active version's `template_id`, and `open_interest_yes / _no` (outstanding shares across the
active positions, ± per Position create / archive, recomputed after a snapshot).

## 4. Bootstrap, pruning, gaps

- **Never-pruned participant** (devnet): start at `INDEXER_START_OFFSET` (default 0) and replay
  the whole history — every trade ever made is indexed.
- **Pruned participant** (mainnet prunes): take an ACS snapshot at the prune point, load every
  active contract as a typed row (+ an `acs:<cid>` raw row), set the cursor there and stream on.
  Everything the participant still retains is indexed; what it pruned is gone for everyone.
- **Fell behind the prune point** (the index was down longer than the retention): the next page
  fails with `PARTICIPANT_PRUNED_DATA_ACCESSED`; the indexer re-snapshots the ACS at the new prune
  point, inserts contracts it never saw, marks as archived (`archived_choice = 'resync'`) the
  active rows the snapshot no longer lists, moves the cursor, and records the range it never saw
  in `to_indexer_state.gaps` (+ `truthoracle.indexer.gap`, Sentry warning). Trades inside the gap
  are not derivable — the state is right, the activity has a hole, and `GET /ledger/status`
  says so.
- **Operator resync** (`POST /admin/ledger/resync { reason }`): the same reconciliation at the
  ledger end, audited (`ledger.resync`). Use it after a manual repair or a suspected divergence.
- **ACS size**: the JSON API has no ACS cursor; a snapshot that fills `INDEXER_ACS_LIMIT` is
  refused as possibly truncated (raise it, and the participant's `http-list-max-elements-limit`).

Reassignments across synchronizers and topology events are not consumed (single synchronizer
today); an `OffsetCheckpoint` item is ignored.

## 5. Derivations (`src/indexer/projection.ts`)

Per transaction, in `nodeId` order: creates upsert the typed row for their template and archive
nothing; a consuming exercise marks its target archived (markets: only when the transaction
creates no successor version for that `marketId` — `ArchiveMarket` / a bare `Archive`). Then
every exercised event yields activity:

| Choice | `to_market_events.kind` | Where the numbers come from |
|---|---|---|
| `MarketCounter.CreateMarket` | `market_created` | the created market (initial price, L, reserves) |
| `Buy` | `buy` | `amountCC` = collateral (arg); `shares` = successor Position − consumed Position; `feeCC` = Δ(`accumulatedFeesCC` + `prizePoolCC`); `netCC` = collateral − fee; prices = consumed vs successor market |
| `Sell` | `sell` | `shares` = `sharesIn`; `amountCC` (gross) = Δ`totalVolumeCC`; `netCC` = the child `UserWallet.Credit` amount; fee, prices as above |
| `SwapShares` | `swap` | `shares` in, `sharesOut` from the Position delta, `details.feeShares` |
| `Split` / `Merge` | `split` / `merge` | amount (arg), the child Debit / Credit |
| `ProvideLiquidity` | `provide_liquidity` | `amountCC` = value increase, `netCC` = the Debit (cost), `lpTokens` = Δ`lpTokenSupply` |
| `WithdrawLiquidity` | `withdraw_liquidity` | `lpTokens` burned, `netCC` = the Credit, early static exit shares from the Position delta |
| `ResolveT0` / `Resolve` / `FinalizeOutcome` / `VoidMarket` | `resolve_t0` / `resolve` / `finalize` / `void` | `outcome` from the successor market, attestation cids, bond `PendingPayout`s created |
| `ProposeOutcome` / `ChallengeOutcome` | `propose` / `challenge` | outcome (arg), bond = the Debit |
| `RedeemPosition` | `redeem` | `amountCC` = the Credit (payout), the burned position's shares / cost basis, `details.reason` (`resolve` / `void-refund`) |
| `CommitForecast` | `commit_forecast` | the created `ModelForecast` |
| `ScoreAndDistribute` | `score_and_distribute` | `amountCC` = Δ`prizePoolCC`, the `PendingPayout`s created |
| `ArchiveMarket` / `Archive` | `archive` | |
| `UserWallet.Deposit` / `Credit` / `Debit` / `Withdraw` | `to_wallet_entries` | amount + reason / `txRef` (arg), `balance_after` from the successor wallet, the root exercise's market |
| `PendingPayout.MarkPaid` / `SettleToWallet` / `CancelPayout` | `to_ledger_payouts.settled_kind` | `tx_hash`, `settle_wallet_cid`, `refunded` |

Trade kinds (`buy sell swap split merge`) bump `to_markets.trade_count` / `last_trade_at`. A
transaction that batches several choices on one market is handled: a contract created earlier
in the same transaction is the "before" state of a later consuming exercise.

Two more derivations run inside the same transaction (docs/MARKETS.md §5): every
`PredictionMarket` version is folded into the three period rows of `to_market_candles` (`open`
on insert only; `high` / `low` fold; `close` / `liquidity_l` / `open_interest` follow the newest
version; `volume_cc` += Δ `totalVolumeCC` against the consumed predecessor; `trades` += 1 for
Buy / Sell / SwapShares), after every Position of the transaction has moved
`to_markets.open_interest_*`. A snapshot entry (bootstrap / resync) seeds one candle at its
snapshot price with volume 0 and never counts as a trade; open interest is then recomputed from
`to_positions`. The market's on-ledger `ticker` / `eventTicker` / sub titles are written on every
version (trimmed, upper-cased); a ticker another market already holds is stored as
`<ticker>~<marketId>` and logged, a malformed one is kept and logged, and an event ticker with
no catalog row gets a placeholder event and series in the same transaction (docs/MARKETS.md §2).

## 6. Treasury transfers (`src/indexer/splice.ts`)

With `INDEXER_TRACK_TRANSFERS=true` (default) the same stream yields the Canton Coin transfers
the treasury took part in: a Splice `TransferPreapproval_Send(V2)` / `AmuletRules_Transfer`
exercise names the sender, and the `Splice.Amulet:Amulet` contracts created for the receiver hold
the amount that arrived. This is the reading `truthoracle-canton-prod/api/_lib/ledgerClient.mjs`
uses for mainnet deposits, where the Enterprise Wallet's history endpoint returns nothing.
`in` = a deposit source paid the treasury; `out` = the treasury paid a party (a payout /
withdrawal); the treasury's own change is not counted. Only `packageName === SPLICE_AMULET_PACKAGE_NAME`
events are read; nothing of the Splice package lands in `to_ledger_events`.

The deposit reconcile (`DepositService`) still reads the Enterprise Wallet history; switching it
to `to_ledger_transfers` on mainnet is the obvious next step and a separate change.

## 7. Reads and events

Read services (`MarketsService`, `PortfolioService`) query Postgres only; a participant outage
degrades reads to "stale by the lag", never to a 502. Every index-backed response carries
`x-ledger-offset` (the last applied offset) and `GET /ledger/wait?offset=` long-polls until the
index reaches an offset — the replacement for the frontend's 1–1.5 s confirmation polls. Positions
are valued fixed point: mark-to-market `yes·p + no·(1−p)` while Trading, the redeemable amount once
Resolved / Voided (same rule as `RedeemPosition`).

Subjects published after each commit (ids, offsets and parties only — see `NatsSubjects`):
`truthoracle.ledger.tx`, `truthoracle.market.updated`, `truthoracle.market.event.<kind>`,
`truthoracle.wallet.entry`, `truthoracle.payout.ledger_changed`, `truthoracle.transfer.seen`,
`truthoracle.indexer.gap`. Consumers that would benefit: the deposit confirm pass (a
`wallet.entry` of kind `deposit` confirms a credit at once), the payout settlement scan
(`payout.ledger_changed` created rows), and any push channel to the frontend.

## 8. Configuration (`.env.example`)

```
INDEXER_ENABLED=true             INDEXER_POLL_MS=2000          INDEXER_BATCH=200
INDEXER_ACS_LIMIT=10000          INDEXER_START_OFFSET=0        INDEXER_LOCK_TTL_MS=30000
INDEXER_TRACK_TRANSFERS=true     SPLICE_AMULET_PACKAGE_NAME=splice-amulet
INDEXER_UPDATES_ENDPOINT=auto    INDEXER_PARTY=                (blank = TREASURY_PARTY_ID)
```

Boot refuses an `INDEXER_PARTY` that is not a Canton party id. Without a configured ledger
(`LEDGER_API_URL` / `ZKPC_LEDGER_API_URL`, `TREASURY_PARTY_ID`, `TRUTHORACLE_PACKAGE_NAME`,
Keycloak) the processor logs once and stays idle; the read API still answers.

## 9. Operations

- **Health**: `GET /ledger/status` — `offset`, `ledgerEnd`, `lag` (offsets), `lastRecordTime`,
  `lastError`, `gaps`, `running` (this replica holds the lock). Alert on a growing `lag`, on
  `lastError` set for more than a few minutes, and on any new gap.
- **Rebuild from scratch**: stop the indexer (`INDEXER_ENABLED=false`), `TRUNCATE` the fourteen
  `to_*` ledger tables (`to_indexer_state` included), start it again — it re-bootstraps. The
  account tables are untouched.
- **Rebuild the projections only** (after a projection fix): the raw `to_ledger_events` rows
  are the source; a replay tool is not part of this change — a full rebuild is. The full rebuild
  also rebuilds `to_market_candles` and `open_interest_*`; the catalog rows (`to_series`,
  `to_events`) and the catalog assignments on `to_markets` (`ticker_source = 'catalog'`) are
  operator data and must be exported / re-applied around a `TRUNCATE` of `to_markets`.
- **Switching participants** (offsets are participant-local): a full rebuild is required.
- **Package upgrade**: `packageName` is matched against `TRUTHORACLE_PACKAGE_NAME`; contracts of
  an older package name are ignored (greenfield, ARCHITECTURE §18).

## 10. Verified

2026-09-28: `npm run typecheck`, `lint`, `build` exit 0; the LedgerIndex migration applied to a
fresh database and `migration:generate` afterwards proposes only the cosmetic jsonb-default
rewrites Init.ts documents; unit specs for the parsers, tree builder, value decoding and transfer
extraction; `test/ledger.e2e-spec.ts` (15 tests) against real Postgres + Redis with a fake stream:
full replay, replay idempotency, ACS bootstrap on a pruned participant, resync with a recorded
gap, error recovery, wait-for-offset, market list / detail / filters / validation, trade and
activity derivation, raw and bucketed price history, resolution → redemption → withdrawal →
MarkPaid, portfolio valuation, leaderboard and stats, transfers, the admin routes and the
session rules. Not yet run against a live participant: the JSON shapes come from the Canton 3.4
OpenAPI spec and the production tree reader, not from a recorded response — the first devnet run
should be watched (RUNBOOK §12).
