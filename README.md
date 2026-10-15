# truthoracle-backend

Accounts, sessions, wallet linking, KYC, money rails and the **ledger index** (markets, trades,
positions, wallet statements, payouts, transfers — docs/INDEXER.md) for TruthOracle on Canton. NestJS 12 /
TypeScript 6 / TypeORM 1 / Postgres / Redis / NATS JetStream. A sibling of `pm-frontend`
(frontend + Vercel functions), `truthoracle-contracts` (Daml) and `enterprise-wallet`; laid out
like `risk-monitor-backend`.

The behavioural contract is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (v2), the HTTP
shapes are [`docs/API.md`](docs/API.md), the internal file/class/method seams are
[`docs/INTERNALS.md`](docs/INTERNALS.md), the ledger indexer is [`docs/INDEXER.md`](docs/INDEXER.md),
the market catalog (series → events → markets), candles, quotes and orders are
[`docs/MARKETS.md`](docs/MARKETS.md), and operator procedures live in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Quick start

```bash
nvm use                       # .nvmrc = 24 (Node ^22.18 also works)
npm install
docker compose up -d          # postgres:16, redis:7, nats:2.11 with JetStream
cp .env.example .env          # every key is annotated; the defaults boot against docker-compose
npm run start:dev             # nest --watch on :8091, migrations run on boot (DB_MIGRATE_ON_BOOT=true)

curl localhost:8091/health
curl localhost:8091/health/ready
```

`.env` is loaded by Node's own `process.loadEnvFile` (no dotenv). The process refuses to boot on
unsafe configuration — the list is at the top of `.env.example` and each refusal has a procedure
in the runbook.

Browser traffic reaches the backend through the Vercel proxy at `/__backend/api/v1/...`
(ARCHITECTURE §4.1); native clients call it directly with a bearer session and CORS.

## Layout

```
src/
├── main.ts                # .env load, Sentry init BEFORE Nest, bootstrap
├── app.module.ts          # AppModule.register(config): barrels, KYC_PROVIDER factory, global guards/pipe/filter
├── app.setup.ts           # HTTP pipeline shared by main.ts and the e2e helper (request id, helmet, cookies, JSON-only body + rawBody, prefix, JSON 404 fallback)
├── config.ts              # class-validator Config + getConfiguration() with the §12 boot refusals
├── types.ts               # error codes, injection tokens, domain + wire types
├── data-source.ts         # TypeORM DataSource for the CLI (compiled: dist/data-source.js)
├── auth/                  # SessionGuard, AdminGuard, CsrfGuard, decorators, proxy-contract request helpers
├── controllers/           # one per resource; index.ts exports controller classes only
├── services/              # index.ts exports service classes only
├── processors/            # scheduled / NATS-driven loops (incl. the ledger indexer, the TransferInstruction acceptor and the rewards pass)
├── indexer/               # ledger event normalisation, tree building, the projection, candles, token-standard + Splice transfer extraction (pure)
├── amm/                   # the pm-AMM math port (quotes) — mirrors truthoracle-contracts PmAmmMath.daml
├── entities/              # 11 account `to_*` tables (ARCHITECTURE §5) + 16 ledger-index tables (INDEXER.md §3) + catalog / candles (MARKETS.md) + instruments / rewards (TOKENS.md)
├── migrations/            # checked-in migrations (Init, LedgerIndex, MarketCatalog, …, Instruments); synchronize is hard-coded false
├── dto/                   # class-validator request DTOs
└── util/                  # money (bigint fixed point), canton-crypto, telegram, cookies, errors, …
test/
├── helpers/               # createTestApp / useTestApp, fakes (NATS, ledger, wallet, participant stream, registry, token-app, KYC), makeTestWallet, sessions, ledger fixtures
└── *.e2e-spec.ts          # against real Postgres + Redis
docs/                      # ARCHITECTURE.md, API.md, INTERNALS.md, RUNBOOK.md, INDEXER.md, MARKETS.md, TOKENS.md, KYC.md
```

Conventions: `Object.values(barrel)` auto-registers every exported class, so barrels export
classes only (tokens and interfaces live in `types.ts`). Money is `bigint` in 1e-10 token units end
to end (`util/money.ts`), `numeric(38,10)` in Postgres, 10-decimal strings on the wire. Every error
is an `ApiError(status, code, message, details?)` rendered as `{ error, message, details? }` by
one global filter — including body-parser failures (`400 validation_failed`) and unknown routes
(`404 not_found`, appended after every controller by `NotFoundFallback` in `app.setup.ts` because
Nest 12's own not-found layer never fires under Express 5). Every `POST`/`PATCH`/`DELETE` handler
carries `@HttpCode(200)`: `docs/API.md` never answers 201 and Nest would default POST to it.

## Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` / `start:prod` | watch mode / `node dist/main` |
| `npm run build` | `nest build` → `dist/` |
| `npm run typecheck` · `npm run lint` · `npm run format` | tsc, eslint (type-aware), prettier |
| `npm test` | unit specs (`src/**/*.spec.ts`) |
| `npm run test:e2e [-- test/session.e2e-spec.ts]` | e2e specs against `TEST_DATABASE_URL` (default `postgresql://localhost:5432/truthoracle_backend_test`, created on demand with `createdb`) and `TEST_REDIS_URL` (default `redis://localhost:6379/1`, flushed before every test) |
| `npm run typeorm -- <cmd>` | TypeORM CLI against `dist/data-source.js` |
| `npm run migration:generate -- src/migrations/<Name>` | diff entities vs the database into a new migration (against a migrated database it must print "No changes in database schema") |
| `npm run migration:run` · `migration:revert` | apply / roll back |
| `npm run seed:dev [-- --clear]` | write (or remove) a demo catalog with 30 days of candles and a trade feed into the local index for UI work — `APP_ENV=dev` only, never on the ledger (docs/RUNBOOK.md §13) |

Five migrations: `Init` (the account schema — greenfield, ARCHITECTURE §18: a database created by
an earlier layout is dropped and recreated, never upgraded), `LedgerIndex` (the fourteen
ledger-index tables, additive), `MarketCatalog` (series / events / candles tables plus the
identity and open-interest columns on `to_markets`, additive; the identity columns are NOT NULL —
the index never writes a market without them, and a from-scratch deployment starts with an
empty index), `MarketMetadata` (`to_market_metadata`, the backend-owned image / description
per market; drops the presentation columns v16 contracts no longer carry, carrying any values
over first) and `Instruments` (docs/TOKENS.md: `to_instruments`, `to_wallet_credits`,
`to_ledger_holdings`, `to_ledger_transfer_instructions`, `to_reward_rules`, `to_reward_grants`,
instrument / collateral columns on every amount-carrying table and the `_cc` suffix dropped from
every column; a real `down()`; data-free — the reward rules are seeded at boot by
`RewardsService.seedRules`, not by the migration). Regenerating against a migrated database
proposes only the cosmetic `'{}'` vs `'{}'::jsonb` default rewrites, which are not drift.

Jest runs in CommonJS with `test/esm-to-cjs.transformer.cjs` converting the ESM-only packages
(`@nestjs/*`, `jose`) — it passes on Node 22 and 24+.

## Environment

See [`.env.example`](.env.example) — every key is documented there, grouped by concern, with
its default and the boot refusal it participates in. Highlights: `APP_NETWORK` selects the Redis
key prefix, the NATS stream (`TRUTHORACLE_<NETWORK>`) and, on mainnet, the `ZKPC_*` ledger
credentials; `BACKEND_PROXY_SECRET` is what lets the Vercel proxy's `x-real-ip` /
`x-forwarded-host` be trusted; `KYC_PROVIDER=mock` is refused in prod and on mainnet;
`KYC_ENFORCE_WITHDRAWALS` is a plain flag. The Daml package is **truthoracle-v17 1.0.0**
(`TRUTHORACLE_PACKAGE_ID=<package id printed by npm run dars:upload in truthoracle-contracts>`,
`TRUTHORACLE_PACKAGE_NAME=truthoracle-v17`), a fresh lineage deployed from scratch;
`UserWallet.instrument` and `UserWallet.creditRefs` are mandatory there (one wallet per party and
token; the refs are what the deposit and grant confirm passes key on), every `PredictionMarket`
carries its `collateral` and its identity (ticker, event, side labels) and nothing presentational
— image, description and category are the backend's (docs/MARKETS.md §1). The collateral and
rewards instruments come from `COLLATERAL_INSTRUMENT_*` / `REWARDS_INSTRUMENT_*` (docs/TOKENS.md §4.7;
Canton Coin is the DevNet stand-in until cBYN is deployed).

## Ledger index

`LedgerIndexerProcessor` streams the treasury party's transactions from the Canton JSON Ledger
API v2 (`/v2/updates`, LEDGER_EFFECTS shape — created **and exercised** events, plus the token
standard's `Holding` / `TransferInstruction` interface views) into Postgres, one ledger
transaction per database transaction, cursor included; on a pruned participant it starts from an
ACS snapshot at the prune point. Every CIP-56 token the treasury holds, is offered or moves lands
in `to_ledger_holdings`, `to_ledger_transfer_instructions` and `to_ledger_transfers`, which is
where deposits are read from (the index is the only deposit source; `503 ledger_stale`
guards a lagging index). `GET /markets`, `/markets/:id/{trades,activity,price-history,forecasts,
attestations}`, `/me/{positions,liquidity,trades,activity}`,
`/in-app-wallet/{ledger,history,transfers}`, `/stats`, `/leaderboard`, `/ledger/{status,wait}`
and `/admin/ledger/*` (incl. `holdings`, `transfer-instructions`) read it. Design, tables,
derivations and operations: `docs/INDEXER.md`; the tokens: `docs/TOKENS.md`.

## CI

`.github/workflows/ci.yml` runs on every push to a pull request and on `main`, with Postgres 16
and Redis 7 as service containers: typecheck, lint, the unit suite, `nest build`, a migration
round trip (apply everything, roll everything back, fail if any `to_*` table survives, apply
again), then the e2e suite. The ledger, the wallet and NATS are faked by the test helpers, so
the run needs no credentials.

## Status

Every package has landed and been reconciled: F (foundation) plus P1–P5 (auth + me, wallets +
deposits, payouts, KYC with the mock provider and the Sumsub adapter, admin). No route
answers `501 not_implemented`; every route in `docs/API.md` is implemented and covered by an
e2e spec (`test/{session,app,auth,wallets,payouts,kyc,admin}.e2e-spec.ts`).

**Greenfield (ARCHITECTURE §18, decided 2026-09-10):** no backward compatibility with the earlier
account-less app. The primary wallet's on-ledger `UserWallet` is created only by this backend;
deposits and withdrawals require a signed-in account; linking never reads the ledger (a first-time
link succeeds while the ledger is down); deposit confirmation keys on
`UserWallet.creditRefs`; attribution drift in either direction is a hard
`409 deposit_attribution_drift`; one `Init` migration creates the final schema; package
truthoracle-v17.

**Accounts and wallets (decided 2026-09-11, ARCHITECTURE §6.1 / §7.3 / §8.1):** Google and Telegram
are the only user sign-in methods. A Cantor8 wallet is linked to an already signed-in account and
creates no identity, so one person maps to one account that KYC can bind; operators sign into the
admin API with their wallet on `POST /auth/admin`. Admin sessions are refused on account routes.

**Ledger index (2026-09-28, docs/INDEXER.md):** indexer + read API landed; `test/ledger.e2e-spec.ts`
covers replay, bootstrap from an ACS snapshot, resync with a recorded gap, the derivations and every
new route. Not yet exercised against a live participant (RUNBOOK §12).

**Tokens — ledger plumbing (2026-10-15, docs/TOKENS.md §4.2–§4.4):** the index reads the token
standard's interface views (holdings, two-step offers, `TransferFactory_Transfer` /
`TransferInstruction_Accept` transfers in any instrument, Canton Coin counted once), the deposit
reconcile credits from `to_ledger_transfers` behind the `503 ledger_stale` gate, payouts settle
through `TreasuryTransferService` (Enterprise Wallet or a registry-built `TransferFactory_Transfer`
over the indexed holdings), `TokenRegistryService` / `TokenAppService` talk to Cantor8's CIP-56
registries and token-app, the acceptor processor completes offers addressed to the treasury, and
`POST /admin/instruments/:admin/:id/setup` runs a token's AutoAccept / MintDelegation.
`test/token-standard.e2e-spec.ts`, `test/instruments.e2e-spec.ts`.

**Tokens — rewards, token operations, per-instrument catalog (2026-10-15, docs/TOKENS.md
§4.5–§4.7):** the catalog is listed and summed per instrument (`?instrument=` on `GET /events`,
`GET /series`, `GET /series/:ticker`; an event's collateral is fixed by its first market or its
accepted submission, a second instrument on it is `409 catalog_conflict`); `RewardsService` /
`RewardsProcessor` derive TRO grants from the index (trade rebate, winning-redeem bonus, first
deposit bonus, manual), credit them with `UserWallet.Grant` under the float rule (blocked grants
wait, DevNet may auto-mint the shortfall through token-app) and confirm them on `creditRefs`;
`GET /me/rewards` and `/admin/rewards/{rules,grant,grants,float}`; `TokenOperationsService` behind
`POST /admin/tokens/mint|burn` and `GET /admin/tokens/status`, with the mint-and-credit on-ramp
running through the deposit write-ahead machinery. `test/{rewards,admin-tokens}.e2e-spec.ts`,
`src/services/rewards.service.spec.ts`. Still untested against a live token-app and participant
(docs/RUNBOOK.md §16).

**Sumsub is the KYC provider (2026-09-29, docs/KYC.md §5–§6):** the adapter matches Sumsub's
current API (SDK tokens with `applicantIdentifiers`, signed requests, SHA-256/512 webhook
digests over the raw body, every documented `applicant*` webhook type, applicant re-reads);
`GET /admin/kyc/provider` and `npm run kyc:check` probe the credentials and print what the
dashboard must be set to. Verified with locally computed vectors and a stubbed HTTP layer only —
the first Sumsub sandbox session is still to be watched.

**Markets like an exchange (2026-09-29, docs/MARKETS.md):** Kalshi-style series → event → market
catalog (events group N binary pm-AMM markets; a market's `ticker` / `eventTicker` / side labels are
the contract's own — mandatory on truthoracle-v17 — and the projection creates placeholder catalog
rows for an event the ledger names first), candlesticks folded by the projection in the ledger transaction's own DB transaction
(1 min / 1 h / 1 d, dense reads), open interest, 24 h figures and an AMM-implied book on every
market, `GET /markets/:market/quote` (the PmAmmMath port) and `POST /markets/:market/orders/prepare`
(the exact ExerciseCommand + disclosed contract the Cantor8 wallet signs, assembled from the index),
`GET /exchange/status` with an operator trading halt, and `POST /admin/markets` (treasury-signed
`CreateMarket` for an event). `test/{catalog,candles,orders}.e2e-spec.ts`.

Verified on 2026-09-10: `npm run typecheck`, `npm run lint`, `npm run build` exit 0;
`npm test` 21 suites / 150 tests; `npm run test:e2e` 7 suites / 161 tests against real
Postgres + Redis. A live boot against Postgres + Redis + a JetStream `nats-server`, driven
**through the `pm-frontend` vite relay** (`/__backend/api/v1`), passes the sequence in
`docs/RUNBOOK.md` §8 — health, social sign-in with the relayed `to_session` cookie, mock KYC
approval, linking wallets, deposit reconcile answering `502 upstream_failed` against an
unreachable treasury, sessions, logout, CSRF/404 envelopes — and the boot refusals in §1 exit 1
within a second.
