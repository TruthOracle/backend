# Ledger indexer — design and operations

The indexer keeps a Postgres projection of everything the TruthOracle Daml package does on the
Canton ledger — markets, every trade, liquidity move, resolution step, redemption, in-app wallet
movement, payout, attestation, model forecast — and the read API serves it (docs/API.md
"Markets", "Portfolio", "In-app wallet ledger", "Ledger", "Admin — ledger"), together with every
token the treasury holds, is offered or moves (docs/TOKENS.md §4.2). It lives inside this
monolith: two processors, a handful of services, sixteen tables, no extra process.

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
own.

## 1. Source

`LedgerStreamService` (`src/services/ledger-stream.service.ts`) reads the Canton JSON Ledger
API v2 as `INDEXER_PARTY` (default `TREASURY_PARTY_ID`), with the same Keycloak client and base
URL rules as `LedgerClientService` (`ZKPC_*` only on mainnet):

| Call | Purpose |
|---|---|
| `GET /v2/state/ledger-end` | how far to read |
| `GET /v2/state/latest-pruned-offsets` | the participant's prune point (`participantPrunedUpToInclusive`) |
| `POST /v2/updates?limit=N` with `updateFormat.includeTransactions = { eventFormat: { filtersByParty: { party: filter }, verbose: false }, transactionShape: TRANSACTION_SHAPE_LEDGER_EFFECTS }` | pages of transactions with **created and exercised** events (choice, argument, result, `lastDescendantNodeId`, interface views) |
| `POST /v2/state/active-contracts?limit=N` with `activeAtOffset` and the same `eventFormat` | the ACS snapshot a bootstrap / resync starts from |

`/v2/updates` is the one source: Canton 3.6 removed the deprecated `/v2/updates/trees`, so there
is no fallback to it. The filter is cumulative
(docs/TOKENS.md §4.2): the wildcard with `includeCreatedEventBlob: true` (a user-signed trade must
disclose the market contract, so the active market version's blob is kept —
`to_markets.created_event_blob`, served by `GET /markets/:id`) plus two `InterfaceFilter`s with
`includeInterfaceView: true` for the token standard,
`#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding` and
`#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction`.
A created event that implements one of them arrives with the interface's view (`interfaceViews[]`:
owner, instrument, amount and lock of a holding; sender, receiver, amount, instrument and
`executeBefore` of a two-step offer), which is how any CIP-56 token — cBYN, TRO, Canton Coin — is
read without knowing its templates. The ids are in package-name form, so every vetted version of
the API packages qualifies.

The page normalises to `LedgerTransaction` (`src/indexer/events.ts`): the `events[]` of each
`Transaction`, with or without the `{ value }` one-of wrapper, views attached to the created
events. Parent / child relations are rebuilt from `nodeId` order and `lastDescendantNodeId`
(`buildEventTree`), which is how a child `UserWallet.Debit` is attributed to the `Buy` that caused
it — and how the holdings created under a `TransferFactory_Transfer` are attributed to that
transfer.

### Value encoding

Daml values arrive as the JSON API's compact form: `Decimal` and `Int` as strings, enums as
strings (or `{ tag }`), `Optional` as `null` / the value (or `{ Some }` / `{ None }`), lists as
arrays. `src/util/ledger-values.ts` reads every one of these tolerantly and **never puts a Decimal
through `Number`** — prices, shares and amounts are `bigint` in 1e-10 units end to end
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

## 3. Tables (`src/entities/*`, the `Init` migration)

No foreign keys to the account tables: rows are keyed by Canton party and contract id, and an
account's view is resolved at read time through `to_users.party_id` and `to_wallets.party_id`
(`PortfolioService.partiesOf`).

| Table | One row per | Notes |
|---|---|---|
| `to_indexer_state` | the index (`key = 'ledger'`) | `offset` (last applied), `ledger_end`, `pruned_offset`, `bootstrapped_at`, `bootstrap_offset`, `last_update_id`, `last_record_time`, `last_error(_at)`, `market_counter_cid/value`, `gaps` |
| `to_ledger_events` | created / exercised event of the TruthOracle package | verbatim payloads, `event_id = <updateId>:<nodeId>` (`acs:<cid>` for snapshot rows), parent / root node ids; the projections can be rebuilt from it |
| `to_markets` | `marketId` (current version) | every `PredictionMarket` field incl. `collateral_admin / collateral_id` (the market's instrument — every amount column is in it), `contract_id` = the ACTIVE contract, `created_event_blob`, `synchronizer_id`, `archived`, `trade_count`, `last_trade_at` |
| `to_market_snapshots` | `PredictionMarket` version | price / reserves / L / supply / volume / fee pots / status + `cause` (the choice) — the chart |
| `to_market_events` | market / counter choice | §5 |
| `to_positions` | `Position` version | `active` = current holding; archived rows = history |
| `to_liquidity_positions` | `LiquidityPosition` version | |
| `to_ledger_wallets` | `UserWallet` version | `instrument_admin / instrument_id` (one wallet per owner and instrument), `credit_refs`, `audit_observers`; `active` per (owner, instrument) = the balance the ledger holds now |
| `to_wallet_entries` | `UserWallet` choice | the in-app statement: deposit / grant / credit / debit / withdraw with the wallet's instrument, amount, reason, `tx_ref` (a deposit's transfer ref or a grant's `reward:<id>`), `balance_after`, the market and root choice it belonged to |
| `to_ledger_payouts` | `PendingPayout` | its instrument and amount, and how it ended: `mark_paid` (+ `tx_hash`), `settle_to_wallet`, `cancelled` (+ `refunded`), `archived`; joins `to_payouts.pending_payout_cid` |
| `to_attestations` · `to_model_forecasts` · `to_prediction_models` | contract | |
| `to_ledger_transfers` | token transfer involving the treasury, any instrument | §6; unique `(update_id, node_id)` |
| `to_ledger_holdings` | token-standard `Holding` the treasury OWNS (from the `Holding` interface view; other parties' holdings the stream shows are not kept) | instrument, `amount`, `locked` / `lock_expires_at`, `created_offset`, `archived_offset` (set when the holding is consumed, or by a resync when the snapshot no longer lists it) — the treasury's float per instrument and the inputs of a registry-mode transfer (docs/TOKENS.md §4.4) |
| `to_ledger_transfer_instructions` | two-step `TransferInstruction` the treasury sends or receives (interface view) | instrument, `sender`, `receiver`, `amount`, `execute_before`, `status pending \| completed (TransferInstruction_Accept) \| failed (reject, withdraw, update, any other archive)`, `archived_offset`; a resync that finds the offer gone sets `archived_offset` and leaves `status` (the outcome is unknown) — the acceptor completes the pending ones addressed to the treasury |
| `to_market_candles` | (market, period ∈ 1 min / 1 h / 1 d, period start) | OHLC of the pool price, Σ Δvolume, Σ price × Δvolume, trade count, open interest and L after the period's last version — folded per market version in the same transaction (docs/MARKETS.md §5) |
| `to_series` · `to_events` | operator catalog rows (not ledger data; the projection writes placeholder rows when a market names an event that has none) | the series → event hierarchy markets are grouped into; membership is `to_markets.event_ticker` (docs/MARKETS.md §2); `to_events.collateral_admin / collateral_id` is the event's one instrument, fixed by the first market (the projection, or the operator's accepted submission) |
| `to_reward_rules` · `to_reward_grants` | not index tables — the rewards processor's input and output (docs/TOKENS.md §4.6) | the processor READS the index: `to_wallet_entries` / `to_market_events` past `to_settings.rewards_cursor` (`<offset>:<wallet entry id>:<market event id>`), the treasury's `to_ledger_holdings` and every active `to_ledger_wallets.balance` in the rewards instrument for the float rule |
| `to_market_metadata` | operator row per market ticker (not ledger data; the projection never writes it) | the market's image and description — v17 contracts carry no presentation (docs/MARKETS.md §1) |

`to_markets` also carries the market's identity (`ticker`, `event_ticker`, `yes_sub_title`,
`no_sub_title` — the contract's own, mandatory on truthoracle-v17, NOT NULL in the index), the
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
| `MarketCounter.CreateMarket` | `market_created` | the created market (initial price, L, reserves, `collateral`); the event row takes the market's collateral when it has none yet |
| `Buy` | `buy` | `amount` = collateral in (arg `amount`); `shares` = successor Position − consumed Position; `fee` = Δ(`accumulatedFees` + `prizePool`); `net` = collateral − fee; prices = consumed vs successor market |
| `Sell` | `sell` | `shares` = `sharesIn`; `amount` (gross) = Δ`totalVolume`; `net` = the child `UserWallet.Credit` amount; fee, prices as above |
| `SwapShares` | `swap` | `shares` in, `sharesOut` from the Position delta, `details.feeShares` |
| `Split` / `Merge` | `split` / `merge` | amount (arg), the child Debit / Credit |
| `ProvideLiquidity` | `provide_liquidity` | `amount` = value increase, `net` = the Debit (cost), `lpTokens` = Δ`lpTokenSupply` |
| `WithdrawLiquidity` | `withdraw_liquidity` | `lpTokens` burned, `net` = the Credit, early static exit shares from the Position delta |
| `ResolveT0` / `Resolve` / `FinalizeOutcome` / `VoidMarket` | `resolve_t0` / `resolve` / `finalize` / `void` | `outcome` from the successor market, attestation cids, bond `PendingPayout`s created |
| `ProposeOutcome` / `ChallengeOutcome` | `propose` / `challenge` | outcome (arg), bond = the Debit |
| `RedeemPosition` | `redeem` | `amount` = the Credit (payout), the burned position's shares / cost basis, `details.reason` (`resolve` / `void-refund`) |
| `CommitForecast` | `commit_forecast` | the created `ModelForecast` |
| `ScoreAndDistribute` | `score_and_distribute` | `amount` = Δ`prizePool`, the `PendingPayout`s created |
| `ArchiveMarket` / `Archive` | `archive` | |
| `UserWallet.Deposit` / `Grant` / `Credit` / `Debit` / `Withdraw` | `to_wallet_entries` | the wallet's instrument, amount + reason / `txRef` (a grant's `ref`), `balance_after` from the successor wallet, the root exercise's market |
| `PendingPayout.MarkPaid` / `SettleToWallet` / `CancelPayout` | `to_ledger_payouts.settled_kind` | `tx_hash`, `settle_wallet_cid`, `refunded` |

Trade kinds (`buy sell swap split merge`) bump `to_markets.trade_count` / `last_trade_at`. A
transaction that batches several choices on one market is handled: a contract created earlier
in the same transaction is the "before" state of a later consuming exercise.

Two more derivations run inside the same transaction (docs/MARKETS.md §5): every
`PredictionMarket` version is folded into the three period rows of `to_market_candles` (`open`
on insert only; `high` / `low` fold; `close` / `liquidity_l` / `open_interest` follow the newest
version; `volume` += Δ `totalVolume` against the consumed predecessor; `trades` += 1 for
Buy / Sell / SwapShares), after every Position of the transaction has moved
`to_markets.open_interest_*`. A snapshot entry (bootstrap / resync) seeds one candle at its
snapshot price with volume 0 and never counts as a trade; open interest is then recomputed from
`to_positions`. The market's on-ledger `ticker` / `eventTicker` / sub titles are written on every
version (trimmed, upper-cased); a ticker another market already holds is stored as
`<ticker>~<marketId>` and logged, a malformed one is kept and logged, and an event ticker with
no catalog row gets a placeholder event and series in the same transaction (docs/MARKETS.md §2).

## 6. Tokens: holdings, offers and treasury transfers (`src/indexer/token-standard.ts`, `src/indexer/splice.ts`; docs/TOKENS.md §4.2)

Transfers are always indexed, in any instrument: every `to_ledger_transfers` row carries
`instrument_admin / instrument_id`, `amount`, `kind` and the transfer exercise's `node_id`
(unique with `update_id`). Per transaction, in this order:

1. **token standard** (`kind = token_standard`, pure in `token-standard.ts`). State first: a
   created event with a `Holding` view whose owner is the treasury becomes a `to_ledger_holdings`
   row, one with a `TransferInstruction` view that names the treasury as sender or receiver a
   pending `to_ledger_transfer_instructions` row; a consuming exercise on a contract either table
   knows sets `archived_offset` (an offer's status becomes `completed` on
   `TransferInstruction_Accept`, `failed` on anything else). Then activity: an exercised
   `TransferFactory_Transfer` (argument `transfer.sender / receiver / amount / instrumentId`) or
   `TransferInstruction_Accept` (sender, receiver, amount and instrument from the offer's row —
   the create seen earlier, or in the same transaction) becomes a row when it involves the
   treasury: receiver = treasury → `in`, counterparty = sender, amount = Σ holdings created for
   the treasury in that subtree minus the treasury's own holdings consumed in it (change), so the
   figure is what actually arrived; sender = treasury → `out`, counterparty = receiver, amount =
   the transfer's amount. A `TransferFactory_Transfer` whose result is pending (it created an
   offer) yields no row — the accept does. Every node of a claimed subtree is handed to step 2 as
   claimed. An accept of an offer the index never saw completes the row-less instruction and is
   logged as unattributed: under-crediting is recoverable, inventing an amount is not.
2. **Canton Coin** (`kind = amulet`, `splice.ts`), for exercises step 1 did not claim: a Splice
   `TransferPreapproval_Send(V2)` / `AmuletRules_Transfer` exercise names the sender, and the
   `Splice.Amulet:Amulet` contracts created for the receiver hold the amount that arrived; the
   instrument is `{ admin: the Amulet's dso party, id: "Amulet" }`. This is the reading
   `truthoracle-canton-prod/api/_lib/ledgerClient.mjs` uses for mainnet deposits. Canton Coin
   also implements the standard: its Amulets carry `Holding` views (so they are holdings in step
   1) and a Canton Coin transfer made through `TransferFactory_Transfer` is a token-standard row
   whose inner `AmuletRules_Transfer` is claimed — counted once. Only
   `packageName === SPLICE_AMULET_PACKAGE_NAME` events are read here; nothing of the Splice or
   token packages lands in `to_ledger_events`.

A bootstrap / resync snapshot loads the treasury's holdings and the offers it is party to the same
way (their interface views come with the ACS entries); a resync archives the ones the snapshot no
longer lists.

`truthoracle.transfer.seen` carries `{ updateId, nodeId, direction, counterparty, instrument,
kind, offset }`; `truthoracle.transfer.instruction_accepted` `{ contractId, instrument, offset }`
when an offer addressed to the treasury completed. The deposit reconcile (`DepositService`) reads
`SUM(amount)` of the `in` rows per (instrument, counterparty = linked party) from
`to_ledger_transfers` — plus the confirmed `mint:` credits an operator's mint-and-credit left in
`to_deposit_credits` (docs/TOKENS.md §4.7), which are deposits nothing was sent for — behind the
freshness gate `IndexerService.requireFresh()`:
`to_indexer_state.offset ≥ ledgerEnd − LEDGER_FRESH_OFFSETS` (the ledger end read live, never
the cached one) else `503 ledger_stale`, which the frontend retries. The
`TransferInstructionAcceptorProcessor` (`ACCEPTOR_SCAN_MS`, docs/TOKENS.md §4.4) completes the
pending offers addressed to the treasury in known, enabled instruments with the registry's accept
context; unknown or disabled instruments stay pending and are logged once.

## 7. Reads and events

Read services (`MarketsService`, `PortfolioService`) query Postgres only; a participant outage
degrades reads to "stale by the lag", never to a 502. Every index-backed response carries
`x-ledger-offset` (the last applied offset) and `GET /ledger/wait?offset=` long-polls until the
index reaches an offset — the replacement for the frontend's 1–1.5 s confirmation polls. Positions
are valued fixed point: mark-to-market `yes·p + no·(1−p)` while Trading, the redeemable amount once
Resolved / Voided (same rule as `RedeemPosition`).

Subjects published after each commit (ids, offsets and parties only — see `NatsSubjects`):
`truthoracle.ledger.tx`, `truthoracle.market.updated`, `truthoracle.market.event.<kind>`,
`truthoracle.wallet.entry`, `truthoracle.payout.ledger_changed`, `truthoracle.transfer.seen`
(with the instrument), `truthoracle.transfer.instruction_accepted`, `truthoracle.indexer.gap`.
An instrument the index meets on a market or
wallet that the platform does not know is registered as disabled (`InstrumentsService.ensureKnown`,
docs/TOKENS.md §4.1). Consumers that would benefit: the deposit confirm pass (a
`wallet.entry` of kind `deposit` confirms a credit at once), the payout settlement scan
(`payout.ledger_changed` created rows), and any push channel to the frontend. The rewards
processor (docs/TOKENS.md §4.6) is a poller of the index rather than a consumer: every
`REWARDS_SCAN_MS` it reads the `to_wallet_entries` / `to_market_events` rows past
`to_settings.rewards_cursor` (by their serial ids, so a row the projection wrote is never skipped
whatever offset it carries) and derives grants; the float rule it applies before submitting reads
`to_ledger_holdings` (the treasury's rewards float) and `to_ledger_wallets` (what the in-app
wallets hold), and refuses to run on a stale index (`requireFresh`) — grants then simply wait.

## 8. Configuration (`.env.example`)

```
INDEXER_ENABLED=true             INDEXER_POLL_MS=2000          INDEXER_BATCH=200
INDEXER_ACS_LIMIT=10000          INDEXER_START_OFFSET=0        INDEXER_LOCK_TTL_MS=30000
SPLICE_AMULET_PACKAGE_NAME=splice-amulet                       (transfers are always indexed)
INDEXER_PARTY=                   (blank = TREASURY_PARTY_ID)
LEDGER_FRESH_OFFSETS=50          (the reconcile's freshness gate, §6)   ACCEPTOR_SCAN_MS=10000 (0 = off)
REWARDS_ENABLED=true             REWARDS_SCAN_MS=30000         (the rewards pass over the index, docs/TOKENS.md §4.6)
```

Boot refuses an `INDEXER_PARTY` that is not a Canton party id. Without a configured ledger
(`LEDGER_API_URL` / `ZKPC_LEDGER_API_URL`, `TREASURY_PARTY_ID`, `TRUTHORACLE_PACKAGE_NAME`,
Keycloak) the processor logs once and stays idle; the read API still answers.

## 9. Operations

- **Health**: `GET /ledger/status` — `offset`, `ledgerEnd`, `lag` (offsets), `lastRecordTime`,
  `lastError`, `gaps`, `running` (this replica holds the lock). Alert on a growing `lag`, on
  `lastError` set for more than a few minutes, and on any new gap.
- **Rebuild from scratch**: stop the indexer (`INDEXER_ENABLED=false`), `TRUNCATE` the sixteen
  `to_*` ledger tables (`to_indexer_state`, `to_ledger_holdings` and
  `to_ledger_transfer_instructions` included), start it again — it re-bootstraps. The account
  tables are untouched; the deposit reconcile answers `503 ledger_stale` until the rebuilt index
  reaches the ledger end again. Reset the rewards cursor in the same breath (`UPDATE to_settings
  SET value = '0' WHERE key = 'rewards_cursor'`): it points into the serial ids of
  `to_wallet_entries` / `to_market_events`, which a `TRUNCATE … RESTART IDENTITY` renumbers —
  re-reading costs nothing, the grants already written are unique per source event
  (docs/TOKENS.md §4.6).
- **Rebuild the projections only** (after a projection fix): the raw `to_ledger_events` rows
  are the source; a replay tool is not part of this change — a full rebuild is. The full rebuild
  also rebuilds `to_market_candles` and `open_interest_*`; the catalog rows (`to_series`,
  `to_events`) and the catalog assignments on `to_markets` (`ticker_source = 'catalog'`) are
  operator data and must be exported / re-applied around a `TRUNCATE` of `to_markets`.
- **Switching participants** (offsets are participant-local): a full rebuild is required.
- **Package upgrade**: `packageName` is matched against `TRUTHORACLE_PACKAGE_NAME`; contracts of
  an older package name are ignored (greenfield, ARCHITECTURE §18).

## 10. Verified

2026-10-15 (token standard, docs/TOKENS.md §4.2): unit specs for the interface-view parsing, the
token-standard derivation (direct in / out, two-step offer + accept / reject, claimed Amulet
subtrees) and the holding selection; `test/token-standard.e2e-spec.ts` against real Postgres +
Redis with the fake stream, registry and wallet: holdings and instructions through the views,
bootstrap / resync of holdings, the acceptor processor, registry-mode payouts, the setup action
and the admin reads; `test/wallets.e2e-spec.ts` now deposits through the index (incl. the
`503 ledger_stale` gate and a second instrument). The interface filters and the view shapes come
from the Canton 3.6 OpenAPI and the splice token-standard DARs, not from a recorded response:
the first DevNet run should compare `GET /admin/ledger/holdings` with the Enterprise Wallet's
balance (RUNBOOK §15).

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
