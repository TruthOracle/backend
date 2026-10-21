# Tokens — collateral instruments (cBYN) and the rewards token (TRO)

Design and implementation contract for making TruthOracle trade in a configurable CIP-56
(Canton token standard) collateral instrument — first the Canton Belarusian Ruble **cBYN**,
pegged 1:1 to BYN — and for paying user rewards in the **TruthOracle Token (TRO)**, a
non-pegged CIP-56 token. Written 2026-10-15. Everything is deployed fresh: no backward
compatibility with truthoracle-v16, its database rows, or the `*CC` wire fields.

Repositories touched: `truthoracle-contracts` (package `truthoracle-v17`), `truthoracle-backend`,
`pm-frontend` (branch `beta`), and two new repositories `cbyn-token` and `truthoracle-token`.
`truthoracle-canton-prod` (the live mainnet deploy) is untouched.

## 0. Vocabulary

- **Instrument** — a CIP-56 instrument id `{ admin : Party, id : Text }`. `admin` is the
  registry party (for cBYN the *transfer agent*; for Canton Coin the DSO), `id` the token
  identifier (`cBYN`, `TRO`, `Amulet`).
- **Collateral** — the instrument a market is denominated in: shares cost ≤ 1 unit, a winning
  share pays exactly 1 unit, fees and bonds are in it. Fixed per market at creation.
- **Rewards instrument** — TRO. Rewards are credited to an in-app TRO balance and are
  withdrawable to the user's Cantor8 wallet like any other balance.
- **Treasury** — the Enterprise Wallet party (`TREASURY_PARTY_ID`), signatory on every
  TruthOracle contract and custodian of all collateral and reward tokens.
- **Registry** — the token's off-ledger CIP-56 API (`/registry/metadata/v1/*`,
  `/registry/transfer-instruction/v1/*`). Cantor8 runs one per network
  (DevNet `https://token-registry.dev.digik.cantor8.tech/api/c8`, MainNet
  `https://token-registry.main.zkpc.cantor8.tech/api/c8`). Canton Coin's registry is the
  validator's scan proxy (`https://api.validator.dev.digik.cantor8.tech/api/validator/v0/scan-proxy`).
- **token-app** — Cantor8's mint/burn service (`POST /api/admin/mint|burn|mint-batch|burn-batch|
  multi-*`, `GET /data/admin/mints|burns|holdings`, `GET /status`, `GET /healthz`; bearer =
  Keycloak client-credentials JWT). MainNet instance `https://token-app.main.zkpc.cantor8.tech`;
  the DevNet host `token-app.dev.digik.cantor8.tech` resolves but has no route yet (nginx 404).

## 1. Facts established on 2026-10-15 (DevNet digik)

- The participant runs **Canton 3.6.1**; the latest Daml SDK is **3.6.0** (installed; all packages
  move to it). Canton 3.6 disables the legacy `filter` / top-level `verbose` request fields of
  `/v2/state/active-contracts` (`DEPRECATED_API_DISABLED`); `eventFormat` works. Our backend,
  frontend proxies and scripts already send `eventFormat`; only
  `truthoracle-contracts/scripts/create-market.ts` still sends `filter` and must be fixed.
- The token-standard interface filter works and is the generic way to see any token the treasury
  holds: `InterfaceFilter { interfaceId: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
  includeInterfaceView: true }`. Canton Coin (`Splice.Amulet:Amulet`, admin = DSO party, id `Amulet`)
  implements it, so **Canton Coin is a token-standard instrument** and the only one on DevNet until
  Cantor8 deploys cBYN. It is the stand-in for end-to-end verification of every generic path.
- Vetted on the participant (`POST /v2/interactive-submission/preferred-packages`): splice token
  APIs v1 (ids match the DARs shipped in the cBYN zip), `splice-util 0.1.8`, Cantor8's
  `token-common-v5 0.0.9` (`b6b6536f…ae16`) and `token-business-v2 0.0.11` (`0202099461…134a`),
  `splice-util-token-standard-wallet 1.1.1`. **Not** uploaded yet: `cbyn-holding-stable`,
  `cbyn-rules-v1`.
- `GET /v2/packages/{id}` returns the bare `ArchivePayload`; a `.dalf` usable as a
  `data-dependencies` entry is `0x1a varint(len) payload 0x22 0x40 <64-hex package id>`. With the
  Cantor8 libraries fetched this way (plus the daml-prim/stdlib packages they reference, fetched
  on demand by package id from the compiler errors) and `build-options: --package=token-common-v5-0.0.9
  --package=token-business-v2-0.0.11`, the cBYN rules package compiles unchanged against the
  libraries Cantor8 actually deployed (SDK 3.5.12: `41467d0f…9bf0`; SDK 3.6.0 build see
  `cbyn-token/README.md`). `Cantor8.Token.TokenConfig:TokenConfig = { admin, frozen, frozenParties }`
  with choices `TokenConfig_Freeze/Unfreeze/FreezeParty/UnfreezeParty`; the choice-context key the
  rules read is `tokenConfigCid`; the AutoAccept key is `cBYN/auto-accept`.
- Cantor8's registry answers 403 to our Keycloak client (`sachin`, DevNet): the "quota problem"
  Cantor8 mentioned is this access grant. Its OpenAPI (`/api-docs`) shows admin endpoints
  (`/api/c8/admin/v1/mint|burn|admin-burn|token-config*`) that return *choice contexts* the caller
  must submit; token-app is the service that holds the issuer key and submits.
- Cantor8 wallet-connect SDK 0.5.1: `send({ senderPartyId, instrumentId: string, amount,
  receiverPartyId, memo?, metadata? })` is the user-side transfer (today hard-coded `"Amulet"`),
  `getInstruments()` lists what the connected wallet supports (`{ instrumentId, name, symbol }`),
  `signAndExecute` submits arbitrary commands with disclosed contracts (how orders are signed).
- Enterprise Wallet v0.1.35: `POST /api/v1/transfer { from, to, instrumentId, transferAmount,
  reason, app, metadata, commandId }` is instrument-aware; `GET /api/v1/accounts/{party}/balance`
  returns holdings keyed by instrument id with `instrumentAdminId`; `POST /api/v1/external/submit`
  runs arbitrary treasury-signed commands with disclosed contracts.

## 2. Decisions

1. **One UserWallet per (owner, instrument).** `UserWallet.instrument : InstrumentId` is immutable.
   Markets carry `collateral : InstrumentId`; every market choice that debits or credits a wallet
   asserts `wallet.instrument == collateral` ("wallet holds a different instrument than the
   market's collateral"). A party can hold a cBYN wallet and a TRO wallet; neither can pay for a
   market in the other instrument.
2. **The `CC` suffix goes away everywhere.** Daml fields, database columns, wire fields, TypeScript
   identifiers: `balanceCC → balance`, `amountCC → amount`, `totalVolumeCC → totalVolume`, … Every
   money value is read next to the instrument it is in (`market.collateral`, `wallet.instrument`,
   `payout.instrument`). Fixed-point stays 10 dp (`bigint`, Daml `Decimal`); display and
   withdrawal quantisation use the instrument's `decimals`.
3. **One share pays one unit of collateral**, unchanged (Dani/Sachin 2026-10: "1 ruble or half a
   ruble" is open with Philip; a change is a new package, cheap because nothing is migrated).
4. **Compliance observers.** `auditObservers : [Party]` (already on Market / Position /
   LiquidityPosition / ModelForecast) is added to `UserWallet` and `PendingPayout`. The backend
   passes `AUDIT_OBSERVER_PARTIES` (the regulator) on every create it signs and as the default
   for `CreateMarket`. Positions, balances and payouts are visible to holder, operator and regulator.
5. **Deposits are read from the ledger index, not the wallet's history.** The indexer decodes
   token-standard transfers for *any* instrument (interface views) into `to_ledger_transfers`;
   the deposit reconciliation attributes inbound rows per (linked wallet, instrument). The
   Enterprise Wallet history endpoint is no longer used.
6. **Treasury outbound transfers are generic**: a `TreasuryTransferService` sends `amount` of an
   instrument to a party either through the Enterprise Wallet's `/api/v1/transfer`
   (`transferMode = wallet`) or by building `TransferFactory_Transfer` from the instrument's
   registry (`transferMode = registry`: factory + choice context + disclosed contracts, inputs =
   the treasury's unlocked holdings from the index, submitted via `/external/submit`). Default
   from `TREASURY_TRANSFER_MODE`, overridable per instrument.
7. **Minting and burning go through Cantor8's token-app** (`TokenAppService`), never through the
   Daml factory directly: `POST /api/admin/mint { command_id, instrument_id, party_id, amount,
   app_name }` and the batch variants. The backend uses it for (a) the DevNet faucet
   "mint-and-credit" (mint to the treasury, then `UserWallet.Deposit` for the user — the same
   primitive the future card on-ramp will call once a payment is confirmed), (b) topping up the
   treasury's TRO float. cBYN mints require the recipient's `MintDelegation`; the treasury creates
   one once (admin setup action), users never need one because mints land on the treasury.
8. **Rewards** are computed off-ledger from the index by a `RewardsProcessor` driven by
   `to_reward_rules`, recorded in `to_reward_grants` (unique source event ⇒ idempotent), and
   credited on-ledger with `UserWallet.Grant { amount, ref = "reward:<grantId>", reason }` on the
   user's TRO wallet (created on demand). A grant is only submitted while the treasury's TRO
   holdings cover Σ in-app TRO balances + the grant (`REWARDS_AUTO_MINT=true` mints the shortfall
   via token-app, DevNet only). Rule kinds shipped: `trade_volume_rebate`, `winning_redeem_bonus`,
   `first_deposit_bonus`, `manual` (operator grant). The Aptos-era `Incentives.daml`,
   `blockend/cantonService.js` and the claim-rewards UI are deleted.
9. **An event has one collateral**: the first market of an event fixes the event's instrument
   (`to_catalog_events.collateral_*`); a second market in another instrument is `409
   catalog_conflict`. Series/event/trending aggregates are sums over markets of one instrument and
   carry it on the wire (`instrument`).
10. **DevNet now, cBYN when Cantor8 delivers.** Everything is configured by instrument; the local
    and beta DevNet environments run with Canton Coin as collateral until the cBYN instrument
    admin party, registry access and a DevNet token-app exist (handoff list in §9). Switching is
    an environment change plus new markets.
11. **Token repositories mirror Cantor8's layout** so Cantor8 can deploy them with its
    token-factory / token-app: `cbyn-token` vendors the cBYN Daml as received (source unchanged,
    build wiring ours); `truthoracle-token` is TRO, the same four-party pattern with
    `TruthOracle.TRO.*` modules, token id `TRO`, name "TruthOracle Token", 6 decimals, no peg.
    SDK pinned to the latest stable (3.6.0), `--target=2.1` kept.

## 3. Daml — `truthoracle-v17` 1.0.0 (truthoracle-contracts)

`daml/daml.yaml`: `name: truthoracle-v17`, `sdk-version: "3.6.0"`; the test package follows.
No data-dependencies: `InstrumentId` is declared in `Truthoracle`:

```daml
data InstrumentId = InstrumentId with admin : Party; id : Text   deriving (Eq, Show)
```
(same JSON shape as `Splice.Api.Token.HoldingV1.InstrumentId`, so backend code compares the two
field by field).

Templates (changes only):

```daml
template UserWallet with
    admin : Party; owner : Party
    instrument : InstrumentId
    balance : Decimal; deposited : Decimal; withdrawn : Decimal
    creditRefs : [Text]          -- refs already applied (deposits AND grants), newest first
    auditObservers : [Party]
  signatory admin; observer owner, auditObservers
  choice Deposit : ContractId UserWallet with amount : Decimal; txRef : Text   -- controller admin
      -- refuses a repeated ref; bumps balance + deposited
  choice Grant   : ContractId UserWallet with amount : Decimal; ref : Text; reason : Text  -- controller admin
      -- refuses a repeated ref; bumps balance only (rewards, bonuses, operator credits)
  choice Credit  : ContractId UserWallet with amount : Decimal; reason : Text   -- controller admin (market proceeds; unchanged)
  choice Debit   : ContractId UserWallet with amount : Decimal; reason : Text   -- controller owner, admin
  choice Withdraw : (ContractId UserWallet, ContractId PendingPayout) with amount : Decimal; nowSeconds : Int  -- controller owner
      -- PendingPayout gets instrument = this.instrument, auditObservers

template PendingPayout with admin; user; marketId : Int; instrument : InstrumentId; amount : Decimal;
    reason : Text; createdAt : Int; auditObservers : [Party]
  observer user, auditObservers        -- MarkPaid / SettleToWallet / CancelPayout unchanged in meaning;
                                       -- SettleToWallet and CancelPayout assert wallet.instrument == instrument

template Position        -- costBasisCC → costBasis
template LiquidityPosition -- depositedCC → deposited

data ResolutionPolicy  -- bondCC → bond
data ProposalInfo      -- bondCC → bond

template PredictionMarket with … collateral : InstrumentId … accumulatedFees, prizePool, totalVolume …
  choice Buy  with buyer; side; amount : Decimal; minSharesOut; nowSeconds; existingPosition; walletCid
  choice Sell with seller; side; sharesIn; minProceeds : Decimal; nowSeconds; positionCid; walletCid
  choice ProvideLiquidity with provider; valueIncrease : Decimal; maxCost : Decimal; …
  -- every PendingPayout a market creates (bonds, model prizes) carries instrument = collateral

MarketCounter.CreateMarket with … collateral : InstrumentId; initialValue : Decimal …
```

`debitUserWallet` / `creditUserWallet` take the market's `collateral` and assert the wallet's
instrument. `Incentives.daml` is deleted (and dropped from `scripts/active-contracts.ts`,
`scripts/ledger-query.ts`). `Marketplace.daml` stays.

Tests (`daml/test/daml/Test/Truthoracle.daml`): every scenario updated to the new names and a
collateral; new scenarios: `walletInstrumentMustMatchCollateral` (TRO wallet refused on a cBYN
market, both for Buy and ProvideLiquidity), `twoInstrumentWalletsCoexist`, `grantIsIdempotent`
(same ref twice aborts; Grant does not bump `deposited`), `withdrawCarriesInstrument`,
`regulatorSeesWalletAndPayout` (auditObservers can fetch).

Scripts: `create-market.ts` gains `--collateral-admin` / `--collateral-id` (defaults from
`COLLATERAL_INSTRUMENT_ADMIN` / `COLLATERAL_INSTRUMENT_ID` in `.env`) and `initialValue`; its ACS
read moves to `eventFormat`. `.env.example` documents the two variables (Canton Coin values for
DevNet: `DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a` / `Amulet`).
`DEPLOYMENT.md` / `README.md`: v17 section, SDK 3.6.0, the recorded package id after the build.

## 4. Backend

### 4.1 Instruments

Table `to_instruments` (PK `admin, id`): `symbol`, `name`, `decimals int`, `kind enum
collateral|rewards`, `enabled bool`, `is_default_collateral bool`, `registry_url text null`,
`registry_auth enum none|ledger|keycloak`, `transfer_mode enum wallet|registry null` (null = env
default), `wallet_instrument_id text` (what the Cantor8 SDK's `send` expects; default = `id`),
`created_at`, `updated_at`. Boot upserts the two env-configured instruments (§4.7) and refuses
to boot if `COLLATERAL_INSTRUMENT_ID` is set without `COLLATERAL_INSTRUMENT_ADMIN`. The indexer
upserts any instrument it meets on a market as `enabled = false, symbol = id` so ledger-first
markets still render.

Wire shape `InstrumentRef = { admin, id, symbol, name, decimals }`.
`GET /exchange/instruments` (public) → `{ instruments: (InstrumentRef & { kind, enabled,
isDefaultCollateral, walletInstrumentId })[] }`. Admin: `GET/POST /admin/instruments`,
`PATCH /admin/instruments/:admin/:id` (symbol, name, decimals, enabled, transferMode,
registryUrl, registryAuth, walletInstrumentId; the admin/id pair is immutable),
`POST /admin/instruments/:admin/:id/setup { autoAccept?: bool, mintDelegation?: bool }` (§4.5).

### 4.2 Ledger index (docs/INDEXER.md §6 rewritten)

Stream and ACS requests add two cumulative filters next to the wildcard:
`InterfaceFilter(HoldingV1.Holding, includeInterfaceView)` and
`InterfaceFilter(TransferInstructionV1.TransferInstruction, includeInterfaceView)` — package-name
form `#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding`,
`#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction`.

New tables: `to_ledger_holdings` (treasury's token-standard holdings: `contract_id` PK,
`instrument_admin`, `instrument_id`, `amount numeric(38,10)`, `locked bool`, `lock_expires_at`,
`created_offset`, `archived_offset null`) and `to_ledger_transfer_instructions` (two-step offers the
treasury is sender or receiver of: `contract_id` PK, instrument, `sender`, `receiver`, `amount`,
`execute_before`, `status pending|completed|failed`, offsets).

`to_ledger_transfers` becomes instrument-aware: `instrument_admin`, `instrument_id`, `amount`
(was `amount_cc`), `kind token_standard|amulet`, unique `(update_id, node_id)`. Derivation per
transaction, in order:

1. token-standard: for each exercised node whose choice is `TransferFactory_Transfer`
   (argument `transfer.sender/receiver/amount/instrumentId`), `TransferInstruction_Accept`
   (sender/receiver/amount from `to_ledger_transfer_instructions` by contract id, else from the
   archived event's interface view if present) — if the treasury is the receiver, a row
   `direction = in`, counterparty = sender, amount = Σ Holding views created for the treasury in
   that subtree minus treasury-owned holdings consumed in it (change); if the treasury is the
   sender, `direction = out`, counterparty = receiver, amount = `transfer.amount`.
2. Amulet (`src/indexer/splice.ts`, existing): only for exercised nodes not already claimed in
   step 1; instrument = `{ admin = DSO party of the created Amulet (createArgument.dso), id = Amulet }`.

`NatsSubjects.transferSeen` payload carries the instrument. `GET /in-app-wallet/transfers` and the
admin ledger routes expose `instrument` and `amount`.

### 4.3 In-app wallets, deposits, payouts

- `LedgerClientService.fetchUserWallet(owner, instrument)`; `fetchAllUserWallets()` returns one
  row per contract with its instrument; wallet create command id
  `wallet-create-<sha256(packageName|owner|admin|id)[:40]>`.
- `to_wallets.credited_cc` → table `to_wallet_credits (wallet_id, instrument_admin, instrument_id,
  credited numeric(38,10), PK (wallet_id, instrument_admin, instrument_id))`.
  `to_deposit_credits`: `instrument_admin`, `instrument_id`, `amount` (was `amount_cc`),
  `deposited_before` (was `deposited_cc_before`), unique `command_id` kept.
- `POST /in-app-wallet/deposits/reconcile { instrument?: { admin, id } }` (default: the default
  collateral). Source of `received_w` = `SUM(amount)` of `to_ledger_transfers` rows with
  `direction = in`, this instrument and `counterparty = w.party_id`. Before deriving, the route
  requires the index to be fresh: `to_indexer_state.last_offset ≥ ledgerEnd − LEDGER_FRESH_OFFSETS`
  else `503 ledger_stale` (frontend retries inside its existing window). Everything else in
  ARCHITECTURE §8.3 (write-ahead row, deterministic command id, `creditRefs` confirmation, drift
  refusal) is unchanged; `depositRefs` is now `creditRefs` on the ledger.
- `GET /in-app-wallet` → `{ partyId, wallets, balances: [{ instrument: InstrumentRef, ledger:
  LedgerWallet | null, attribution: { creditedTotal, ledgerDeposited, delta } }], pending, payouts }`.
  `LedgerWallet = { contractId, owner, instrument: InstrumentRef, balance, deposited, withdrawn, creditRefs }`.
- `to_payouts`: `instrument_admin`, `instrument_id`, `amount`. Settlement calls
  `TreasuryTransferService.transfer({ instrument, to, amount, commandId, reason, metadata })`;
  amounts are quantised down to the instrument's decimals before leaving (dust stays in-app and
  is reported in the payout row's `details.dust`). KYC gating unchanged.
- `Payout` on the wire: `+ instrument: InstrumentRef`, `amount`.

### 4.4 Registry, token-app and treasury transfers

- `TokenRegistryService` (per instrument's `registry_url` / `registry_auth`): `info()`,
  `instrument(id)`, `transferFactory(choiceArguments)` → `{ factoryId, transferKind,
  choiceContext: { choiceContextData, disclosedContracts } }`, `acceptContext(instructionCid)`,
  `rejectContext`, `withdrawContext`. Auth `ledger` = the ledger Keycloak bearer (scan proxy),
  `keycloak` = `REGISTRY_KEYCLOAK_*` (falls back to `KEYCLOAK_*`), `none`.
- `TokenAppService` (`TOKEN_APP_URL`, bearer from `TOKEN_APP_KEYCLOAK_*` → `KEYCLOAK_*`):
  `mint({ commandId, instrumentId, partyId, amount })`, `burn(...)`, `mintBatch`, `burnBatch`,
  `status()`, `holdings({ partyId?, instrumentId? })`, `mints()`, `burns()`. Amounts are sent as
  decimal strings. Unconfigured → every caller answers `503 token_app_unconfigured`.
- `TreasuryTransferService.transfer(...)`: mode `wallet` → EW `/api/v1/transfer` with
  `instrumentId = instrument.walletInstrumentId`; mode `registry` → inputs = the treasury's
  unlocked `to_ledger_holdings` of the instrument (largest first until ≥ amount; refuse with
  `409 insufficient_treasury_holdings` otherwise), `TransferFactory_Transfer` choice argument
  `{ expectedAdmin, transfer: { sender: treasury, receiver, amount, instrumentId, requestedAt:
  now, executeBefore: now + TREASURY_TRANSFER_TTL_SEC, inputHoldingCids, meta }, extraArgs:
  { context: choiceContextData, meta: { values: { "truthoracle/reason": reason, … } } } }`
  exercised on the interface id `#splice-api-token-transfer-instruction-v1:…:TransferFactory`,
  disclosed contracts from the registry, submitted with `EnterpriseWalletService.externalSubmit`.
  Status checks go through `commandStatus` (mode registry) / `transferStatus` (mode wallet).
- `TransferInstructionAcceptorProcessor` (every `ACCEPTOR_SCAN_MS`, default 10 s): pending
  `to_ledger_transfer_instructions` with `receiver = treasury` and a known, enabled instrument →
  registry accept context → `TransferInstruction_Accept` via `externalSubmit`; unknown instruments
  are left pending and logged once. Rejections are never automatic.
- Setup action (`POST /admin/instruments/:admin/:id/setup`): registry `transferFactory` lookup
  for a self-transfer of 0 → the factory contract id and its disclosed contract (whose `templateId`
  is the concrete factory template); exercise `setupChoices.autoAccept` (default
  `CreateAutoAccept { receiver: treasury }`) and/or `setupChoices.mintDelegation` (default
  `CreateMintDelegation { recipient: treasury }`) on it. Not applicable to Canton Coin (the EW
  account was created with `preApproveAmuletTransfers`). Choice names are per-instrument config
  (`to_instruments.setup_choices jsonb`).

### 4.5 Markets, quotes, orders, catalog

- `to_markets`: `collateral_admin`, `collateral_id`; `to_catalog_events`: `collateral_admin`,
  `collateral_id` (null until the first market). Renamed numeric columns lose `_cc`.
- `POST /admin/markets` accepts `collateral?: { admin, id }` (default: the default collateral;
  must be an enabled `collateral` instrument → `400 validation_failed`; must equal the event's
  instrument when the event already has one → `409 catalog_conflict`), `initialValue` (was
  `initialValueCC`), `policy.bond`. The `CreateMarket` argument carries `collateral` and
  `auditObservers = input.auditObservers ?? AUDIT_OBSERVER_PARTIES`.
- `Market` on the wire: `+ collateral: InstrumentRef`; `accumulatedFees`, `prizePool`,
  `totalVolume`, `volume24h`, `liquidity`, `openInterest`, `policy.bond`. Trades / candles /
  positions / portfolio / leaderboard: `amount`, `net`, `fee`, `notional`, `volume`, `costBasis`,
  `value`, `redeemable`, `realizedPnl`, `reference`; every such object also exposes
  `instrument: InstrumentRef` (markets: `collateral`).
- Orders: `POST /markets/:market/orders/prepare { action, side?, amount?, shares?, lpTokens?,
  slippageBps? }`; the prepared `ExerciseCommand` uses the v17 argument names; the user's wallet
  contract id is the one for `market.collateral` (`409 no_in_app_wallet` names the instrument).
- Aggregates (`GET /events`, `GET /series`, trending): per instrument; the response objects carry
  `instrument` and the query accepts `?instrument=<admin>:<id>` (default: the default collateral).

### 4.6 Rewards

Tables: `to_reward_rules (id uuid, kind enum trade_volume_rebate|winning_redeem_bonus|
first_deposit_bonus|manual, params jsonb, enabled bool, created_at, updated_at)`;
`to_reward_grants (id uuid, user_id, party, rule_id null, kind, source_event_id text unique null,
amount numeric(38,10), reason text, status enum queued|submitted|credited|failed|blocked_float,
command_id text unique null, ref text unique, error text null, created_at, credited_at)`.

`RewardsProcessor` (every `REWARDS_SCAN_MS`, default 30 s; `REWARDS_ENABLED`): reads new
`to_wallet_entries` / `to_market_events` past `to_settings.rewards_cursor`, applies enabled rules:
- `trade_volume_rebate { perUnit: "0.01", minTrade: "1" }` — on `buy` and `sell` entries of a
  market whose collateral is the default collateral: `amount = notional × perUnit`.
- `winning_redeem_bonus { fraction: "0.05" }` — on `resolve` (redeem) entries: `amount =
  payout × fraction`.
- `first_deposit_bonus { amount: "10" }` — on a user's first confirmed deposit credit.
- `manual` — `POST /admin/rewards/grant { userId | party, amount, reason }`.
Each grant is written `queued`, then credited with `UserWallet.Grant { amount, ref =
"reward:<grantId>", reason = "<kind>" }` on the user's TRO wallet (created on demand under the
deterministic id) through `externalSubmit`, confirmed when `creditRefs` contains the ref (same
pattern and processor cadence as deposit credits). Float rule: before submitting, treasury TRO
holdings (index) ≥ Σ TRO `UserWallet.balance` (index) + grant amount; otherwise the grant is
`blocked_float`, a Sentry message is raised, and with `REWARDS_AUTO_MINT=true` the processor mints
`max(shortfall, REWARDS_MINT_MIN)` TRO to the treasury through token-app and retries next scan.

API: `GET /me/rewards` → `{ instrument: InstrumentRef, wallet: LedgerWallet | null, totals:
{ credited, queued }, grants: Grant[] }`; admin `GET /admin/rewards/rules`,
`PUT /admin/rewards/rules/:id { params?, enabled?, reason }`, `POST /admin/rewards/grant`,
`GET /admin/rewards/grants?status=`, `GET /admin/rewards/float` → `{ treasuryHoldings,
liabilities, headroom }`.

### 4.7 Admin token operations and configuration

`POST /admin/tokens/mint { instrument: { admin, id }, amount, to?: "treasury" | party,
creditUserId?: string, reason }` → token-app mint (default to the treasury); with `creditUserId`
the backend then runs `UserWallet.Deposit { amount, txRef = "mint:<commandId>" }` for that user's
primary party (the on-ramp primitive). `POST /admin/tokens/burn { instrument, amount, party,
reason }`.
`GET /admin/tokens/status` → token-app `/status` plus per-instrument `{ treasuryHoldings,
liabilities }` from the index. All audited (`token.mint`, `token.burn`, `token.setup`).

`.env.example` additions (every variable the code reads; optional ones stay as active entries):

```
# ── Instruments (CIP-56). The two below are upserted into to_instruments at boot. ──
COLLATERAL_INSTRUMENT_ADMIN=            # cBYN: the transfer-agent party (from Cantor8). DevNet stand-in: the DSO party
COLLATERAL_INSTRUMENT_ID=cBYN           # DevNet stand-in: Amulet
COLLATERAL_INSTRUMENT_SYMBOL=cBYN       # display symbol (stand-in: CC)
COLLATERAL_INSTRUMENT_NAME=Canton Belarusian Ruble
COLLATERAL_INSTRUMENT_DECIMALS=6        # cBYN 6; Canton Coin 10
COLLATERAL_REGISTRY_URL=https://token-registry.dev.digik.cantor8.tech/api/c8   # stand-in: https://api.validator.dev.digik.cantor8.tech/api/validator/v0/scan-proxy
COLLATERAL_REGISTRY_AUTH=keycloak       # none | ledger (scan proxy) | keycloak (REGISTRY_KEYCLOAK_*)
COLLATERAL_WALLET_INSTRUMENT_ID=        # what the Cantor8 wallet SDK's send() expects; blank = the instrument id
REWARDS_INSTRUMENT_ADMIN=
REWARDS_INSTRUMENT_ID=TRO
REWARDS_INSTRUMENT_SYMBOL=TRO
REWARDS_INSTRUMENT_NAME=TruthOracle Token
REWARDS_INSTRUMENT_DECIMALS=6
REWARDS_REGISTRY_URL=
REWARDS_REGISTRY_AUTH=keycloak
REWARDS_WALLET_INSTRUMENT_ID=
AUDIT_OBSERVER_PARTIES=                 # regulator parties, comma separated: observers on wallets, payouts and new markets
TREASURY_TRANSFER_MODE=wallet           # wallet (Enterprise Wallet /api/v1/transfer) | registry (TransferFactory_Transfer via /external/submit)
TREASURY_TRANSFER_TTL_SEC=600           # executeBefore for registry-mode transfers
LEDGER_FRESH_OFFSETS=50                 # reconcile refuses (503 ledger_stale) when the index lags the ledger end by more than this
ACCEPTOR_SCAN_MS=10000                  # TransferInstruction acceptor cadence (0 = off)
REGISTRY_KEYCLOAK_URL=                  # bearer for registry_auth=keycloak; each falls back to KEYCLOAK_*
REGISTRY_KEYCLOAK_REALM=
REGISTRY_KEYCLOAK_CLIENT_ID=
REGISTRY_KEYCLOAK_CLIENT_SECRET=
# ── token-app (Cantor8 mint/burn) ──
TOKEN_APP_URL=                          # DevNet instance pending from Cantor8; MainNet https://token-app.main.zkpc.cantor8.tech
TOKEN_APP_APP_NAME=truthoracle
TOKEN_APP_KEYCLOAK_URL=                 # falls back to KEYCLOAK_*
TOKEN_APP_KEYCLOAK_REALM=
TOKEN_APP_KEYCLOAK_CLIENT_ID=
TOKEN_APP_KEYCLOAK_CLIENT_SECRET=
# ── Rewards (TRO) ──
REWARDS_ENABLED=true
REWARDS_SCAN_MS=30000
REWARDS_AUTO_MINT=false                 # DevNet: mint the float shortfall through token-app
REWARDS_MINT_MIN=1000                   # smallest auto-mint
```
Removed: `INDEXER_TRACK_TRANSFERS` (always on), `SPLICE_AMULET_PACKAGE_NAME` stays.

Migration `1792000000000-Instruments.ts`: renames, new tables, data-free (fresh deploy), with a
`down()` that reverses it (CI runs run/revert/run).

Docs to update: `ARCHITECTURE.md` §8 (wallets per instrument, index-sourced deposits), §11 (routes),
§12 (config); `INDEXER.md` §3 (tables) and §6 (token-standard transfers); `MARKETS.md` §4 (collateral),
§7 (argument names); `API.md` (every renamed field, new routes); `RUNBOOK.md` (token-app, instrument
setup, `ledger_stale`, rewards float); `README.md`; this file is the design record.

## 5. Frontend (pm-frontend, branch `beta`)

- `lib/marketsTypes.ts`, `auth/types.ts`, `lib/inAppWallet.ts`, `lib/backendAdmin.ts`,
  `lib/marketsApi.ts`: the renamed wire fields and `InstrumentRef`; a `lib/instruments.ts` with
  `useInstruments()` (`GET /exchange/instruments`, cached), `formatAmount(value, instrument)`
  (instrument decimals, trailing zeros trimmed), `instrumentLabel`.
- Every hard-coded "CC" / "Canton Coin" in market, order, position, settlement, portfolio, payout,
  chart and FAQ copy becomes the relevant instrument's symbol (`market.collateral.symbol`,
  `wallet.instrument.symbol`, `payout.instrument.symbol`).
- `utils/cantonCommands.ts`: v17 argument names (`amount`, `minProceeds`, `valueIncrease`,
  `maxCost`, `initialValue`, `collateral`); the Incentives builders are deleted.
- In-app wallet card: one balance row per instrument the account has a wallet for, plus the
  default collateral and TRO even when no wallet exists yet. Deposit: pick the instrument, then
  `wallet.send({ instrumentId: instrument.walletInstrumentId, … })`; before offering it, call
  `getInstruments()` once per session and disable the button with "Your Cantor8 wallet does not
  list <symbol> yet" when the id is missing. Reconcile is called with the instrument. Withdraw:
  the `Withdraw` choice on that instrument's wallet; amount quantised to the instrument's
  decimals in the input.
- `Cantor8WalletContext` / `wallets/types.ts`: `transferCC` → `transfer({ instrumentId, … })`,
  `listInstruments()`.
- Rewards page: TRO balance (`GET /me/rewards`), grants list with kind/amount/status, "Withdraw TRO
  to your Cantor8 wallet" (the common withdraw flow). `blockend/` and `utils/cantonClient.ts` are
  removed with their imports.
- Admin: `CreateMarketForm` gets a collateral selector (enabled collateral instruments; locked to
  the event's instrument when set) and `initialValue` labelled in the symbol; new panels
  `InstrumentsPanel` (list, add, enable/disable, setup actions), `TokensPanel` (status, mint-and-credit
  faucet, mint to treasury, burn), `RewardsPanel` (rules toggle/params, manual grant, float).
- Tests under `test/*.test.mjs` updated for the renamed shapes; `docs/INTEGRATION.md` and `README.md`
  updated; `.env.example` unchanged in names (the instruments come from the backend).

## 6. Token repositories

Both repositories: `README.md`, `daml/multi-package.yaml`, `daml/<token>-holding`,
`daml/<token>-rules`, `daml/test` (daml-script against the real Cantor8 libraries),
`lib/splice/*.dar` (the six DARs from the cBYN zip), `lib/cantor8/*.dalf` (fetched: token-common-v5
0.0.9, token-business-v2 0.0.11, splice-util 0.1.8 and the prim/stdlib packages they reference),
`scripts/fetch-packages.ts` (by package name through `preferred-packages` → `GET /v2/packages/{id}`
→ DALF wrapping as in §1), `scripts/package-id.ts`, `scripts/upload-dar.ts` (DevNet only, refuses
without `--yes`), `.github/workflows/ci.yml` (build + test, package id in the summary),
`package.json` (`libs:fetch`, `dars:build`, `dars:test`, `typecheck`), `.env.example`
(`LEDGER_API_URL`, `KEYCLOAK_*`, `TREASURY_PARTY_ID` for the fetch script), `LICENSE`.

`cbyn-token`: the cBYN sources exactly as received from Cantor8 (`TruthOracle.CBYN.*`); only the
`daml.yaml` files change (SDK 3.6.0, `lib/` paths, `--package` flags). The README records the
roles (issuer = mint/burn, transferAgent = instrument admin / freeze / seize, validator,
appProvider), the context keys, the DevNet setup the treasury needs (AutoAccept, MintDelegation),
the token-app calls, and the dependency provenance.

`truthoracle-token`: TRO — `TruthOracle.TRO.{Holding,AutoAccept,Allocation,Factory,Ops,Transfer}`,
templates `TroFactory`, `TroFactoryProposal`, `TroFactoryDelegate`, `MintDelegation`, `AutoAccept`,
`Holding`, `LockedHolding`, `TokenAllocation`, `TransferInstruction`, …; `troTokenId = "TRO"`,
`troDecimals = 6`, `autoAcceptContextKey = "TRO/auto-accept"`. Documentation states it is the
platform rewards token: minted by the issuer as rewards, not pegged, not redeemable for fiat,
transferable under the same compliance controls as cBYN.

Daml-script tests in both: factory bootstrap (delegate → proposal → accept), TokenConfig creation,
mint via MintDelegation, direct transfer with AutoAccept, two-step transfer accept and reject,
burn with change, frozen party refused, admin burn with reason.

## 7. Verification plan

1. Contracts: `npm run dars:test` (all scenarios), `dpm build --all`, record the v17 package id,
   `npm run dars:upload -- daml/.daml/dist/truthoracle-v17-1.0.0.dar -- --network devnet`,
   `npm run create:contract` (v17 MarketCounter for the local treasury), `npm run create:market`
   with Canton Coin as collateral.
2. Backend: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e` (Postgres + Redis
   from docker-compose), then boot against DevNet with Canton Coin as the collateral instrument:
   indexer bootstrap, `GET /markets` shows `collateral`, `GET /exchange/instruments`, a
   registry-mode treasury transfer of a small Canton Coin amount to the beta treasury party is
   indexed as an `out` row and arrives.
3. Frontend: `npm run lint`, `npm test`, `npm run build`; `vite` against the local backend, market
   pages show "CC" from the instrument, the wallet card shows per-instrument rows.
4. Tokens: `dars:build` and `dars:test` in both repositories.

## 8. Open decisions (need Sachin / Philip)

- Payout per share (1 unit) — Philip to confirm for BYN.
- TRO symbol/name (`TRO`, "TruthOracle Token"), 6 decimals; reward rule defaults
  (`trade_volume_rebate 0.01/unit`, `winning_redeem_bonus 5 %`, `first_deposit_bonus 10 TRO`).
- Whether users may withdraw TRO at launch or only hold it in-app (shipped: withdrawable).
- Whether reward accrual counts markets in every collateral or only the default (shipped: default).

## 9. Cantor8 handoff — what DevNet needs from them

Status on 2026-10-16 (Niko, Cantor8; each point re-checked against the participant and the registry):

- **Done — cBYN is deployed on DevNet.** `cbyn-rules-v1 0.0.1` =
  `1fae194ce057b1ebde19c41cf7d800d2984503e89410d7f0c1a1f607af0fff7b` and `cbyn-holding-stable 0.0.1` =
  `d0f3377f23451abbaa0b0ddefd51e33ffc06ee51b041e08e92c6d3e3102ad91a` resolve through
  `preferred-packages` for the treasury — the same ids as on zkpc, and not the ids our own build
  produces: same source, compiled by Cantor8 with SDK 3.4.9 against token-common-v5 0.0.8 /
  token-business-v2 0.0.10 (cbyn-token README, "Package ids"), so nothing is uploaded from our side.
  The factory and the `TokenConfig` exist. Parties: transfer agent = instrument admin =
  `COLLATERAL_INSTRUMENT_ADMIN`
  `truthoracle-cbyn-transfer-agent::12204e94c0e449c0efcd270dd1e68259c36471cebef132e5c7dfc2750fe8c9eed77f`;
  issuer (what mint and burn act as)
  `truthoracle-cbyn-issuer::1220a0a378f5cbd3384225c52d3b50398e13c7f9b07f9220beac1941cc38a7fa7c50`.
  The treasury sees no cBYN contract yet: no `AutoAccept`, no `MintDelegation`, no `Holding`.
- **Open — no registry serves cBYN.** The shared DevNet registry answers `404 Unknown instrument
  'cBYN'. Known: c8ETH, c8BTC, c8TEST, rCC` on `transfer-factory` and on `instruments/cBYN`; cBYN
  gets its own registry org "like on zkpc", URL pending from Niko this week. Until it arrives nothing
  that needs a choice context works — `POST /admin/instruments/…/setup` (AutoAccept,
  MintDelegation), registry-mode payouts, the TransferInstruction acceptor — and the Cantor8 wallet
  cannot `send` cBYN either. `COLLATERAL_REGISTRY_URL` stays unset for cBYN until then; Canton Coin
  remains the DevNet collateral.
- **Open — mint and burn.** The DevNet token-app route and the issuer key in the DevNet Enterprise
  Wallet are with Alex (Cantor8), plus authorising our Keycloak client `sachin` on
  `/api/admin/mint|burn`. Order once both land: registry URL → `setup { autoAccept,
  mintDelegation }` for the treasury → token-app mint to the treasury → cBYN markets (§4.7, §7).
- **Open — TRO.** Cantor8 builds and deploys TRO from three parameters baked in at build time:
  ticker, decimals, and transferable between users or issuer-only (§8 decides; the shipped design is
  `TRO`, 6 decimals, transferable). The backend reads TRO through the token-standard interfaces, so
  their package names need not match `truthoracle-token`.

The original list, annotated:

1. ~~Grant our DevNet Keycloak client access to the registry (403)~~ — the CIP-56 read paths were
   public all along; only `/api/c8/admin/v1/*` is restricted, and the backend never calls it.
2. Deploy `cbyn-holding-stable` / `cbyn-rules-v1` on DevNet, create the factory and TokenConfig,
   and tell us the instrument admin (transfer agent) party, the issuer party — done — and the
   registry URL — pending.
3. A DevNet token-app (`token-app.dev.digik.cantor8.tech` has no route yet) with a client that may
   call `/api/admin/mint|burn` for `cBYN` and `TRO` — pending (Alex).
4. Register `cBYN` and `TRO` in the DevNet Cantor8 wallet (popup) and Enterprise Wallet
   instrument lists so `send(instrumentId)` and `/api/v1/transfer` work — pending; to confirm
   whether the registry org settlement covers it.
5. ~~Deploy `truthoracle-token` (TRO) the same way, or confirm they want us to upload it~~ — Cantor8
   builds it from the parameters above once we send them.
6. Later (MainNet): the same on zkpc, plus the card on-ramp design (CIP-56 exchange).

## 10. Implementation notes (backend, 2026-10-15)

Where the implementation of §4.4–§4.7 deviates from, or refines, the text above. The sections
above stay the design record; this list is what shipped.

- **Rule seeding.** The `Instruments` migration is data-free apart from `to_settings.rewards_cursor =
  '0'`; `RewardsService.seedRules` creates the three automatic rules at every boot (`ON CONFLICT
  (kind) DO NOTHING`), `enabled` iff `APP_ENV=dev` — a dev stack hands out rewards without a
  click, everywhere else an operator enables them (`PUT /admin/rewards/rules/:id`). The dev
  default is a property of the environment, not of the first migration run.
- **`to_reward_grants.submitted_at`** was added: the confirm pass's grace period
  (`DEPOSIT_CONFIRM_GRACE_MS`, shared with deposit credits) counts from the last submission, not
  from the row's creation.
- **Command ids per attempt.** A grant's `Grant` is submitted as `reward-grant-<grantId>-<attempt>`;
  a submission the ledger refused (the wallet's command index reports it failed or unknown after
  the grace period, the wallet still without the ref) re-queues the grant for a fresh attempt, up
  to five, then `failed` for an operator. The ref (`reward:<grantId>`) stays the on-ledger
  idempotency key, so a late-landing earlier attempt cannot double credit.
- **The float rule counts in-flight grants.** `headroom = treasuryHoldings − liabilities −
  pending`, where `pending` = Σ grants `submitted` plus Σ grants `credited` whose ref the index
  does not show in a `grant` wallet entry yet (counting a grant on both sides for a moment only
  makes the rule stricter). `GET /admin/rewards/float` exposes `pending`. Grants are not submitted
  on a stale index (`IndexerService.requireFresh`); they wait.
- **Auto-mint once per grant and per pass**: `reward-float-<grantId>`, recorded in the row's
  `error`, audited `token.mint` as `system`; a blocked grant that already triggered a mint is not
  minted for again while the holding is still unindexed. `REWARDS_MINT_MIN` is read in 1e-10 units
  of the rewards instrument; a shortfall below one unit of the token mints one unit.
- **Amounts** are quantised down to the rewards instrument's decimals (a reward finer than the token
  can leave the platform would be dust forever); a rule-derived reward that rounds to 0 creates no
  grant; a manual grant finer than the decimals is `400 validation_failed`.
- **Rule scope.** Both the trade rebate and the redeem bonus apply to markets in the default
  collateral only (a `perUnit` / `fraction` priced in one token cannot apply to another; §8 lists
  it as an open decision). The redeem bonus needs a `redeem` event with outcome `Yes` / `No` and a
  positive payout (a voided market refunds, it does not win). The deposit bonus is paid on the
  owner's first `deposit` wallet entry in the default collateral whose `txRef` is not a `mint:`
  credit (an operator on-ramp is not the user's deposit), once per account. An acting party nobody
  linked, or linked to a suspended account or one without a primary party, earns nothing — the
  source row is consumed, rules are never retroactive. Grants go to the account's PRIMARY party,
  whichever linked wallet acted.
- **`GET /me/rewards`** answers `404 not_found` without a rewards instrument; the admin rewards
  routes `503 not_ready` (the rules routes work regardless). The wallet in the overview is the
  cached ledger read; the grants list says what is in flight.
- **Catalog per instrument.** Besides `GET /events` and `GET /series`, `GET /series/:ticker` takes
  `?instrument=`. An event without a market yet belongs to no instrument and is listed under every
  one (`instrument: null`, zero figures); `Series` carries `instrument` and `volume` next to the
  counts. An event's members are its unarchived markets in the event's instrument — a market in
  another token that reached the ledger past the backend's check is neither summed nor nested. The
  operator's `POST /admin/markets` pins `to_events.collateral_*` the moment the submission is
  accepted, so the `409 catalog_conflict` holds before the first market is indexed. A platform with
  no configured collateral lists the catalog unfiltered.
- **Mint-and-credit.** The account's wallet in the instrument is created BEFORE the token-app
  mint (so the only step left after minting is the Deposit itself); the credit's write-ahead row
  is `mint-credit-<sha256(mint command id)[:40]>` with `tx_ref = mint:<mint command id>`,
  attributed to the primary wallet row, and `DepositService.creditMint` is idempotent per mint
  (existing confirmed row → `confirmed`; in flight → `409 deposit_in_progress`; `failed` → re-armed).
  Confirmed `mint:` credits count as `received_w` in the reconcile derivation (ARCHITECTURE §8.3
  step 3), or the next reconcile would read the attribution as an over-credit. The response names
  `party` (minted to / burned from) and `credit: { commandId, txRef, status: confirmed | submitted }`.
  There is no route to re-run the credit for a mint whose credit step failed before the row was
  written (RUNBOOK §16); `creditMint` is retry-safe for one.
- **Admin token ops.** Minting requires a known, enabled instrument (`404 instrument_unknown`,
  `409 instrument_disabled`); burning only a registered one (disabled included). `503
  token_app_unconfigured` is answered before any write. `GET /admin/tokens/status` lists every
  registered instrument (disabled included) with `treasuryHoldings` / `liabilities` from the index.
- **Ownership.** `InstrumentsService.update` also serves the e2e specs that disable an instrument;
  the rewards processor's lock is `lock:rewards` (the `REWARDS_SCAN_LOCK_TTL_MS` constant, 5 min); the test
  harness turns the loop off (`REWARDS_ENABLED=false`) and resets `rewards_cursor` with the
  truncated index tables.
- **Transfer metadata rides on `transfer.meta`.** §4.4 writes `truthoracle/reason` and the payout
  metadata into `extraArgs.meta`; `transferFactoryArgument` puts them in `transfer.meta.values`
  and sends `extraArgs.meta = { values: {} }`. The standard's `Transfer.meta` is part of the
  `transfer` record that every `TransferInstructionView` exposes to sender and receiver, so the
  receiver's wallet (and a two-step instruction in our own index) shows the reason and the payout
  reference; `ExtraArgs.meta` is input from the caller to the registry's choice implementation,
  whose meaning the standard leaves to be agreed case by case between the two, and no registry has
  agreed on ours. Keys keep the `<app>/<key>` convention (`truthoracle/reason`,
  `truthoracle/<metadata key>`).
- **Every admin mutation body carries a mandatory `reason`** (`AdminReasonDto`: trimmed, non-empty,
  at most 500 characters, recorded on the audit row), the §4.6 and §4.7 bodies included:
  `PUT /admin/rewards/rules/:id`, `POST /admin/rewards/grant`, `POST /admin/tokens/mint` and
  `POST /admin/tokens/burn` answer `400 validation_failed` without one, as API.md documents. The
  instrument routes of §4.1 (`POST /admin/instruments`, `PATCH /admin/instruments/:admin/:id`,
  `POST /admin/instruments/:admin/:id/setup`) take an optional `reason`: registering or toggling a
  token is configuration, not money movement, and their audit row is written either way.
