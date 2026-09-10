# truthoracle-backend

Accounts, sessions, wallet linking, KYC and money rails for TruthOracle on Canton. NestJS 12 /
TypeScript 6 / TypeORM 1 / Postgres / Redis / NATS JetStream. A sibling of `truthoracle-canton`
(frontend + Vercel functions), `truthoracle-contracts` (Daml) and `enterprise-wallet`; laid out
like `risk-monitor-backend`.

The behavioural contract is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (v2), the HTTP
shapes are [`docs/API.md`](docs/API.md), the internal file/class/method seams are
[`docs/INTERNALS.md`](docs/INTERNALS.md) and operator procedures live in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

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
├── processors/            # scheduled / NATS-driven loops
├── entities/              # 11 `to_*` tables (ARCHITECTURE §5); index.ts exports postgresEntities
├── migrations/            # checked-in migrations; synchronize is hard-coded false
├── dto/                   # class-validator request DTOs
└── util/                  # money (bigint fixed point), canton-crypto, telegram, cookies, errors, …
test/
├── helpers/               # createTestApp / useTestApp, fakes (NATS, ledger, wallet, KYC), makeTestWallet, sessions
└── *.e2e-spec.ts          # against real Postgres + Redis
docs/                      # ARCHITECTURE.md, API.md, INTERNALS.md, RUNBOOK.md
```

Conventions: `Object.values(barrel)` auto-registers every exported class, so barrels export
classes only (tokens and interfaces live in `types.ts`). Money is `bigint` in 1e-10 CC units end
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
| `npm run migration:generate -- src/migrations/<Name>` | diff entities vs the database into a new migration |
| `npm run migration:run` · `migration:revert` | apply / roll back |

Jest runs in CommonJS with `test/esm-to-cjs.transformer.cjs` converting the ESM-only packages
(`@nestjs/*`, `jose`) — it passes on Node 22 and 24+.

## Environment

See [`.env.example`](.env.example) — every key is documented there, grouped by concern, with
its default and the boot refusal it participates in. Highlights: `APP_NETWORK` selects the Redis
key prefix, the NATS stream (`TRUTHORACLE_<NETWORK>`) and, on mainnet, the `ZKPC_*` ledger
credentials; `BACKEND_PROXY_SECRET` is what lets the Vercel proxy's `x-real-ip` /
`x-forwarded-host` be trusted; `KYC_PROVIDER=mock` is refused in prod and on mainnet;
`KYC_ENFORCE_WITHDRAWALS=true` requires `LEGACY_WALLET_ENDPOINTS_RETIRED=true`.

## Status

Every package has landed and been reconciled: F (foundation) plus P1–P5 (auth + me, wallets +
deposits, payouts, KYC with the mock provider and the Sumsub reference adapter, admin). No route
answers `501 not_implemented` any more; every route in `docs/API.md` is implemented and covered
by an e2e spec (`test/{session,app,auth,wallets,payouts,kyc,admin}.e2e-spec.ts`).

Verified on 2026-09-10: `npm run typecheck`, `npm run lint`, `npm run build` exit 0;
`npm test` 12 suites / 104 tests; `npm run test:e2e` 7 suites / 136 tests against real
Postgres + Redis (no `test.failing` markers remain). A live boot against Postgres + Redis + a
JetStream `nats-server`, driven **through the `truthoracle-canton` vite relay**
(`/__backend/api/v1`), passes the sequence in `docs/RUNBOOK.md` §8 — health, wallet sign-in
with the relayed `to_session` cookie, mock KYC approval, linking a second wallet, deposit
reconcile answering `502 upstream_failed` against an unreachable treasury, sessions, logout,
CSRF/404 envelopes — and the boot refusals in §1 exit 1 within a second.

Known behaviour worth knowing before deploying (details in `docs/RUNBOOK.md` §9): the first
sign-in or link of a **never-seen** wallet reads that party's on-ledger `UserWallet` to seed
`legacy_credited_cc`, so it answers `502 upstream_failed` while the ledger or its Keycloak is
unreachable (deliberately fail-closed — a wrong seed would double-credit later). Sign-ins with an
already-linked wallet, Google and Telegram do not touch the ledger.
