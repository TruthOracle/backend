# TruthOracle backend — architecture and implementation spec (v2)

This document is the contract for `canton/truthoracle-backend` (a sibling repository of
`truthoracle-canton`, `truthoracle-contracts` and `enterprise-wallet`, laid out like
`risk-monitor-backend`). It fixes the layout, the domain model, the auth/wallet/KYC rules,
the API surface and the configuration so that every part can be built and reviewed
independently. v2 folds in a five-lens design review (security, money/ledger, KYC,
frontend rollout, toolchain); §19 lists every decision that changed from v1.

Where the existing Vercel functions in `truthoracle-canton/api/` already solved a problem
(derived deposit amounts, deterministic command ids, payout settlement, signature
verification, the shared store), the backend ports that logic. The comments in those files
record production facts (wallet history paging, status filtering, command-id dedup) — keep
them.

## 1. Purpose and scope

The current app has no user accounts: a connected Canton wallet *is* the user. The backend
introduces a real identity layer and a home for every server-side flow that needs
authority, state or a secret:

1. **Accounts + sessions** — a user is a durable `to_users` row with one or more *sign-in
   identities* (Google, Telegram, Canton wallet) and one or more *linked wallets* (deposit
   sources). Sessions are server-side, revocable, cookie-borne (bearer for native clients).
2. **Wallets** — several Canton wallets (Cantor8 today) link to one account. One is the
   **primary** wallet: it owns the on-ledger `UserWallet` (in-app balance). Deposits from
   *any* linked wallet credit that balance, attributed per wallet.
3. **KYC** — provider-agnostic verification (vendor not yet chosen; a mock adapter for dev and
   a Sumsub adapter kept as the reference implementation of the provider interface — see docs/KYC.md),
   attached to the account and to the sign-in identity that started it, enforced at the
   point real CC leaves the platform (external withdrawal settlement). After an approved
   KYC, the verified natural person is bound to exactly one account, permanently, until an
   audited admin transfer.
4. **Money rails** — deposit reconciliation and payout settlement move here from
   `truthoracle-canton/api/wallet/*.mjs`, behind a user session and the KYC gate. The
   Enterprise Wallet (treasury) remains the signer; the backend is the policy layer. The
   legacy open endpoints are **retired in the same rollout** (§18) — the gate is meaningless
   while they exist.
5. **Admin** — operator API (users, KYC overrides and person transfers, blocked payouts,
   audit). Admin authority is a property of a *wallet-signed admin session*, never of an
   account.

Out of scope for v1 (designed for, not built): custodial per-user parties provisioned by
the backend (social-login-only users trading without a wallet — §17), account-merge
tooling beyond the person-transfer action, market/trade data APIs (the frontend keeps
reading the ledger through `/__proxy/ledger`), topology-based key checks for rotated keys.

## 2. Layout (mirrors `canton/risk-monitor-backend`, additions marked +)

```
truthoracle-backend/
├── src/
│   ├── main.ts                    # dotenv-free .env load, Sentry init BEFORE Nest, NestFactory bootstrap
│   ├── app.module.ts              # AppModule.register(config) DynamicModule, barrel wiring (classes only)
│   ├── config.ts                  # class-validator Config + getConfiguration() (boot refusals in §12)
│   ├── types.ts                   # shared domain types, error codes, injection tokens
│   ├── data-source.ts           + # TypeORM DataSource for the CLI (compiled: dist/data-source.js)
│   ├── controllers/               # one per resource; index.ts exports controller CLASSES only
│   ├── services/                  # index.ts exports service CLASSES only
│   ├── processors/                # scheduled / NATS-driven loops; index.ts exports CLASSES only
│   ├── entities/                  # TypeORM entities; index.ts exports postgresEntities
│   ├── migrations/              + # checked-in migrations; synchronize is hard-coded false
│   ├── auth/                    + # SessionGuard, AdminGuard, CsrfGuard, CurrentUser/CurrentSession decorators
│   ├── dto/                     + # class-validator request DTOs
│   └── util/                      # pure helpers: canton-crypto, telegram, cookies, money (fixed point), errors…
├── test/                        + # e2e specs + fakes for ledger/wallet/KYC provider
├── docs/                          # this file, API.md, KYC.md, RUNBOOK.md
├── .github/workflows/ci.yml     + # own CI (the backend is its own repository)
├── docker-compose.yml           + # postgres:16, redis:7, nats:2.11 (JetStream) for local dev
├── .env.example  .nvmrc (24)  nest-cli.json  tsconfig.json  tsconfig.build.json
├── jest.config.ts  eslint.config.mjs  .prettierrc  .gitignore
└── package.json                   # @truthoracle/backend
```

Conventions carried over from risk-monitor-backend:

- `AppModule.register(config)` builds the module from a validated `Config` instance
  provided globally. Controllers/services/processors are registered via
  `Object.values(barrel).filter(isClass)`. **Barrels under `controllers/`, `services/`,
  `processors/` export `@Injectable`/`@Controller` classes only.** Injection tokens
  (`KYC_PROVIDER`), interfaces, enums and factories live in `types.ts` / the module file and
  are never re-exported from those barrels; the mock-KYC controller is registered
  explicitly by `AppModule.register` only when `KYC_PROVIDER=mock` (it is not in the barrel).
- `config.ts` reads `process.env` once into a `Config` class validated with class-validator;
  the process refuses to boot on invalid or unsafe config (§12).
- HTTP prefix `api/v1`; `app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })`.
- `main.ts` keeps the reference shape: `dns.setDefaultResultOrder("ipv4first")`, `.env`
  loaded with `process.loadEnvFile()` (try/catch, path `<repo>/.env`), `Sentry.init` before
  `NestFactory.create`, `bootstrap().catch → Sentry.captureException + close + exit 1`.
- `@nestjs/config` and `@nestjs/axios` are deliberately not used (own `Config`, native `fetch`).

## 3. Stack (exact pins verified on 2026-09-10 by a scratch build)

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node **`^22.18.0 \|\| >=24.11.0`** (`engines`), `.nvmrc` = 24, CI = 24 | Nest 12 is ESM-only and is consumed from CJS via `require(esm)`; typeorm/eslint floors are 22.13 / 24.11; `jest.config.ts` needs native TS stripping (22.18+) |
| Framework | `@nestjs/{common,core,platform-express,schedule,swagger,typeorm,testing}` **12.0.1**, `@nestjs/cli` **12.0.0**, `@nestjs/schematics` **12.0.0** | Express **5.2.1** (path-to-regexp 8: no bare `*` routes) |
| Language | TypeScript **6.0.3 exactly** (no caret; 7.x is rejected by typescript-eslint/ts-jest/Nest CLI) | tsconfig in §3.1 |
| DB | Postgres 15/16, TypeORM **1.1.1**, `pg` **8.23.0** | migrations only; `DataSource` API; no `findByIds`/`@EntityRepository`/`onConflict` (removed in 1.0) |
| Cache/locks | Redis 7/8, ioredis **5.11.1** | ioredis 6 conflicts with typeorm's optional peer (`npm ERESOLVE`); only `SET NX PX`, `INCR`, `PEXPIRE`, `DEL`, `GET/SET EX`, `SADD/SREM/SMEMBERS` are used |
| Bus | NATS 2.11 + JetStream, `@nats-io/transport-node` **3.4.0**, `@nats-io/jetstream` **3.4.0** | the `nats` v2 package is legacy |
| Validation | class-validator **0.15.1**, class-transformer **0.5.1** | `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` |
| Auth libs | `google-auth-library` **11.0.2**, `jose` **6.2.12** (ESM-only but `require("jose")` works on this Node), `node:crypto` (Ed25519, HMAC) | no passport |
| Observability | `@sentry/node` **10.74.0**, Nest `ConsoleLogger({ json: APP_ENV !== "dev" })`, `/health`, `/health/ready` | |
| Security | `helmet` **8.3.0**, `cookie-parser` **1.4.7**, own CSRF guard, own Redis rate limiter | `@nestjs/throttler` has no Nest 12 peer and is not fleet-wide |
| Tests | Jest **30.5.1** + ts-jest **29.4.12** + the ESM→CJS transformer (§3.1), `supertest` **7.2.2** | plain CJS ts-jest cannot load ESM Nest 12 on Node 22 without it |
| Lint/format | ESLint **10.10.0** + typescript-eslint **8.70.0** + `@eslint/js` **10.0.1** (flat, type-aware), Prettier **3.9.6** | |
| Types | `@types/node` 22.20.2, `@types/express` 5.0.6, `@types/jest` 30.0.0, `@types/supertest` 7.2.1, `@types/cookie-parser` 1.4.10 | |

### 3.1 Compiler / test / lint configuration (verbatim)

`tsconfig.json`: `module: nodenext, moduleResolution: nodenext, target: es2023, lib: [es2023],
types: [node, jest], strict: true, strictPropertyInitialization: false, isolatedModules: true,
experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
resolveJsonModule: true, declaration: true, sourceMap: true, skipLibCheck: true,
outDir: ./dist, rootDir: ., include: [src/**/*.ts, test/**/*.ts]`.

`tsconfig.build.json`: `extends ./tsconfig.json, compilerOptions.rootDir: ./src,
include: [src/**/*.ts], exclude: [node_modules, test, dist, **/*.spec.ts]` (TS 6 fails with
TS5011 without the explicit `rootDir`). `nest-cli.json`: `compilerOptions.tsConfigPath:
tsconfig.build.json, deleteOutDir: true`.

`jest.config.ts`: Nest 12 packages are ESM-only and Jest's own loader only does native
`require(esm)` on Node ≥ 24.9 with `--experimental-vm-modules`. The scaffold therefore ships
`test/esm-to-cjs.transformer.cjs` (wired through `transform` + `transformIgnorePatterns` in
both Jest configs): it rewrites `import.meta` and transpiles the ESM packages to CommonJS
with `ts.transpileModule`, and passes sources through untouched when Jest reports
`supportsStaticESM`. Verified green on Node 22.23 and 25.5; unit + e2e run with plain
`jest`, no flag. (`ts-jest` `useESM` + `NODE_OPTIONS=--experimental-vm-modules` also works
and remains an acceptable alternative.) `testRegex: .*\.spec\.ts$` for unit specs,
`test/jest-e2e.json` with `.e2e-spec.ts$` for e2e.

`eslint.config.mjs`: `tseslint.config({ ignores: ['dist/**', 'eslint.config.mjs', 'jest.config.ts'] },
eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked, { languageOptions:
{ parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } }, prettier)`.

Migrations: `data-source.ts` uses `entities: postgresEntities`, `migrations:
[join(__dirname, "migrations/*.js")]`, `synchronize: false`. Scripts: `"typeorm": "npm run build
&& typeorm -d dist/data-source.js"`, `migration:generate` (`-- migration:generate
src/migrations/<Name>`), `migration:run`, `migration:revert`. Boot runs
`dataSource.runMigrations()` when `DB_MIGRATE_ON_BOOT=true`. Every column declares an
explicit `type` (`numeric` with `precision: 38, scale: 10`, `citext`, `timestamptz`, `jsonb`).

## 4. Runtime topology

```
Browser (Vite/React, app host)                     Native iOS (later)
   │  same-origin  /__backend/api/v1/...               │ Authorization: Bearer <session token> + CORS
   ▼                                                   ▼
Vercel rewrite → truthoracle-canton/api/proxy/backend.mjs ──►  backend (Nest, :8091, Railway)
   (dev: the same handler via _devProxy.mjs proxyMiddleware)     │
                                                                 ├── Postgres  (accounts, wallets, sessions, kyc, payouts, credits, audit)
                                                                 ├── Redis     (session cache + per-user index, challenges, nonces, rate limits, locks, oauth state, ledger cache, keycloak tokens)
                                                                 ├── NATS/JS   (domain events, webhook processing queue)
                                                                 ├── Keycloak  (client_credentials → bearer for ledger + wallet)
                                                                 ├── Canton JSON Ledger API (active-contracts reads as the treasury party)
                                                                 ├── Enterprise Wallet REST (history, transfer, external/submit)
                                                                 └── Google / Telegram / Sumsub
```

### 4.1 The `/__backend` proxy contract (`truthoracle-canton/api/proxy/backend.mjs`)

- Route: `vercel.json` rewrite `{ "source": "/__backend/:path*", "destination": "/api/proxy/backend?path=:path*" }`
  placed **above** the SPA catch-all, and `__backend/` added to the catch-all's negative
  lookahead. Same `proxyPath`/`proxyQuery` helpers as `ledger.mjs`. Only `api/v1/**`,
  `health` and `health/ready` are forwarded; anything else 404s (never `/api/docs`).
- Under `npm run dev` the *same handler* runs through `proxyMiddleware("/__backend",
  backendHandler)` from `_devProxy.mjs` (no `server.proxy` shortcut) so dev and prod share
  one code path.
- Target `BACKEND_URL` (server-only env). When unset the proxy answers `503 { error:
  "backend_unconfigured" }` — the frontend treats that as "accounts unavailable" (no Sign-in
  button), and every legacy money endpoint keeps working (§18).
- Forwarded request headers: `content-type`, `accept`, `origin`, `referer`,
  `x-requested-with`, `x-forwarded-host` (= the app host), `x-forwarded-proto`, `x-real-ip`
  (Vercel's platform header), and `x-truthoracle-proxy: <BACKEND_PROXY_SECRET>`. Only the
  `to_session` and `to_oidc` cookies are forwarded (never `to_admin`, `authorization`,
  `x-admin-instance` or client-supplied `x-forwarded-*`). Body is forwarded as raw bytes.
- Response: `redirect: "manual"` (OIDC 302s are relayed, not followed); status and body
  relayed; `Set-Cookie` relayed as an array via `upstream.headers.getSetCookie()` with any
  `Domain=` attribute stripped; `content-encoding/length`, `transfer-encoding` dropped;
  `cache-control: no-store` default. `export const config = { maxDuration: 60 }` (history
  walks).
- Backend side: when `x-truthoracle-proxy` matches `BACKEND_PROXY_SECRET` (timing-safe) the
  request's client IP is `x-real-ip` and its "request host" is `x-forwarded-host`; otherwise
  the socket address and `Host` are used and all `x-forwarded-*` are ignored. Express
  `trust proxy` stays off.

## 5. Domain model (Postgres, tables prefixed `to_`)

Ids `uuid` (`gen_random_uuid()`), timestamps `timestamptz`, money `numeric(38,10)` (CC has
10 decimals; the service layer uses fixed point — §8.4). All tables have `created_at`;
mutable ones `updated_at`.

### `to_settings` (single row, written by the first migration)
`key text pk, value text` — holds `app_network` (§12 boot check) and `kyc_pepper_hash`
(§9.6).

### `to_users`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| display_name, avatar_url | text null | user-editable |
| email | citext null (**not** unique) | informational, from a verified Google identity; uniqueness lives on identities |
| status | text | `active` \| `suspended` \| `closed` |
| kyc_status | text | `none` \| `pending` \| `approved` \| `rejected` \| `blocked_duplicate` (denormalised, precedence in §9.2) |
| kyc_verification_id | uuid null | the verification that set `kyc_status` |
| kyc_provider, kyc_applicant_id | text null | the provider applicant bound to this user (**unique (kyc_provider, kyc_applicant_id)**) — Sumsub keeps one applicant per externalUserId |
| party_id | text null unique | **in-app wallet owner party** = primary wallet's party (§8.2) |
| last_login_at | timestamptz null | |

There is **no `role` column**: admin authority is derived per request from the session's
identity (§6.8).

### `to_auth_identities`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk | index |
| provider | text | `google` \| `telegram` \| `canton_wallet` |
| subject | text | Google `sub`, Telegram numeric user id, Canton party id |
| email | citext null | Google only |
| profile | jsonb | name, username, picture, hd (no tokens) |
| status | text | `active` \| `unlinked` — rows are **never deleted** |
| verified_at, last_used_at, unlinked_at | timestamptz | |
| **unique (provider, subject)** | | one identity ↔ one account, forever |

### `to_wallets`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk | index |
| chain, kind | text | `canton`; `cantor8` (v1 allowlist; `loop`/`other` reserved) |
| party_id | text unique | a party is bound to its first account forever (active or revoked) |
| public_key | text | base64 raw Ed25519, verified against the party fingerprint |
| label | text null | |
| is_primary | bool | partial unique `(user_id) where is_primary and status='active'` |
| status | text | `active` \| `revoked` |
| legacy_credited_cc | numeric | **immutable seed** at link time = the party's own on-ledger `UserWallet.depositedCC` (0 if none) — deposits credited before the account existed |
| credited_cc | numeric | in-app credits attributed to this wallet by the backend since link |
| verified_at, revoked_at | timestamptz | |

### `to_sessions`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk | index |
| auth_identity_id | uuid fk → to_auth_identities | the identity that authenticated this session (link-mode logins never change it) |
| token_hash | text unique | sha256(token) base64url |
| kind | text | `user` \| `admin` (admin sessions: §6.8) |
| created_at, expires_at, last_seen_at | timestamptz | absolute expiry; `last_seen_at` bumped ≤ every 5 min |
| revoked_at | timestamptz null | |
| ip, user_agent | text | |

### `to_kyc_verifications`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk | index |
| provider | text | `mock` \| `sumsub` \| `admin` |
| provider_applicant_id | text null | reference only (non-unique) |
| level_name | text | |
| attempt_no | int | **unique (user_id, provider, level_name, attempt_no)** |
| status | text | `initiated` \| `pending` \| `needs_review` \| `approved` \| `rejected_retry` \| `rejected_final` \| `blocked_duplicate` \| `expired` |
| initiated_identity_id | uuid fk | = `session.auth_identity_id` of the session that started it |
| provider_event_at | timestamptz null | last applied provider event time (stale events are dropped) |
| reject_labels | jsonb null | |
| moderation_comment | text null | user-facing text only, truncated to 500 chars; `clientComment` is never stored |
| manual, manual_reason | bool, text null | admin overrides |
| reviewed_at | timestamptz null | |

### `to_kyc_persons` — the one-person-one-account binding
`fingerprint text pk, kind text (doc | person), user_id uuid fk, verification_id uuid fk,
fingerprint_version smallint, bound_at, released_at null, released_by uuid null,
release_reason text null`. A binding survives expiry, closure and re-verification; only an
audited admin transfer releases it (§9.3).

### `to_kyc_webhook_events`
`id, provider, event_key unique (sha256 of raw body), type, payload jsonb (purged after 30
days), sandbox bool, occurred_at, received_at, processed_at null, attempts int, error null`.

### `to_payouts` — durable arbiter for settlement (§9.4)
`id, pending_payout_cid text unique, user_id null, payee_party, payee_wallet_id null,
amount_cc, reason, status (queued | settling | settled_external | settled_in_app |
blocked_kyc | blocked_unknown_user | blocked_unknown_reason | blocked_wallet_revoked |
failed | archived), transfer_command_id null, wallet_create_command_id null,
settle_command_id null, mark_paid_command_id null, attempts int, last_error, first_seen_at,
settled_at, created_at, updated_at`.

### `to_deposit_credits` — write-ahead record of every treasury-signed credit (§8.3)
`id, user_id, owner_party, command_id unique, tx_ref, amount_cc, attribution jsonb
([{walletId, partyId, amountCC}]), deposited_cc_before, wallet_cid_before null,
status (submitted | confirmed | failed), error, created_at, confirmed_at`.

### `to_audit_events`
`id bigserial, actor_type (user | admin | system), actor_user_id null, actor_session_id null,
action, subject_type, subject_id, metadata jsonb (allow-listed keys per action), ip null,
created_at`; indexes `(subject_type, subject_id)`, `(actor_user_id)`. Written synchronously
by services in the same transaction as the change.

## 6. Identity and session rules

1. **Sign-in resolves an identity, then a user.** `(provider, subject)` is unique. Known
   active identity → its user. Unknown identity with no session → new user + identity.
   Unknown identity with a session (link mode) → attached to the current user.
2. **An identity attached to another user cannot be linked** → `409 identity_already_linked`.
   This applies to `unlinked` rows too: a party or subject is bound to its first account.
3. **Unlink** requires another active identity (`409 last_identity`).
4. **Identities are never deleted; unlink is revocation.** Sign-in with an `unlinked`
   identity fails closed: `403 identity_unlinked`, no session, audited. Re-attachment is only
   (a) a link-mode action by a session of the *original* `user_id`, or (b) an admin action.
   Because the row persists, the same Google/Telegram/wallet can never create a second
   account.
5. **KYC lock**: while `users.kyc_verification_id` points at an approved verification, the
   identity referenced by that verification's `initiated_identity_id` cannot be unlinked —
   neither through `DELETE /me/identities/:id` nor through `DELETE /wallets/:id` (both go
   through one `IdentityService.unlink`) → `409 identity_locked_by_kyc`. Admins can.
6. **Sessions** are opaque 32-byte tokens; browsers get them in `to_session` (`HttpOnly;
   Secure; SameSite=Lax; Path=/`, host-only — `COOKIE_DOMAIN` stays empty for proxied
   traffic), native clients may present them as `Authorization: Bearer`. Only the sha256 is
   stored. Verification: Redis `sess:<hash>` (caches `{id, userId, identityId, kind,
   expiresAt}` only) → Postgres fallback and re-warm. `users.status` and admin eligibility
   are read per request (≤ 30 s cache that suspension invalidates). A per-user index
   `user_sessions:<userId>` (Redis SET) makes suspend / revoke-others / admin removal
   revoke every live session immediately. Absolute lifetime `SESSION_TTL_HOURS` (default
   168); admin sessions `ADMIN_SESSION_TTL_HOURS` (default 1).
7. **CSRF**: **every** non-GET request (with or without cookies) must carry an `Origin` (or
   `Referer`) whose origin is allowed — the request host (from the proxy contract) or an
   entry/pattern in `FRONTEND_ORIGINS` — **and** either `Content-Type: application/json` or
   `x-requested-with: truthoracle`. Missing `Origin` on a non-GET is rejected. Exemptions:
   `/webhooks/**` (signature-verified, no cookies) and requests authenticated by a bearer
   token (no cookie involved). The urlencoded body parser is disabled; JSON only.
8. **Admin authority** (`AdminGuard`): the session must be `kind = admin`, which is issued only
   by `POST /auth/wallet` with a `purpose = admin-sign-in` challenge signed by a
   `canton_wallet` identity whose party is in `ADMIN_OPERATORS` (and matches the pinned key
   when one is configured). Admin sessions are short-lived (§6.6) and never issued through
   Google/Telegram. Removing a party from `ADMIN_OPERATORS` revokes its admin sessions on the
   next request (list re-read; sessions revoked via the per-user index). `ADMIN_EMAILS`
   is dropped from v1.

## 7. Sign-in methods

### 7.1 Google (Google Identity Services, ID-token flow)
Frontend renders the GIS button (`VITE_GOOGLE_CLIENT_ID`) and posts the `credential`.
Backend: `OAuth2Client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_IDS })` (comma list),
require `email_verified === true`; identity subject = `sub`; profile = `{ name, picture, hd }`.
**Nonce**: `POST /auth/google/nonce` issues a single-use nonce (Redis, 10 min) that the
frontend passes to `google.accounts.id.initialize({ nonce })`; the token's `nonce` claim
must match. Required when `GOOGLE_NONCE_REQUIRED=true` (default `true` outside `dev`).

### 7.2 Telegram — three verified entry points, one identity (`subject = numeric user id`)
- **Login Widget**: verify `hash` = hex(HMAC-SHA256(key = SHA256(bot token), data-check-string
  of the other fields sorted `key=value` joined by `\n`)); `now - auth_date ≤
  TELEGRAM_AUTH_MAX_AGE_SEC` (default 300) and `auth_date ≤ now + 60`; the payload hash is
  claimed once (`tg:<hash>`) so a leaked redirect URL cannot be replayed; compare decoded
  bytes with `timingSafeEqual`.
- **Mini App `initData`**: `secret = HMAC_SHA256(key = "WebAppData", data = BOT_TOKEN)`; same
  data-check algorithm over the query params minus `hash`; `user` is JSON; separate
  `TELEGRAM_INITDATA_MAX_AGE_SEC` (default 3600); same replay claim.
- **OIDC** (Telegram's current recommendation): endpoints from
  `https://oauth.telegram.org/.well-known/openid-configuration` (cached 1 h); client id/secret
  from BotFather → Login Widget; Authorization Code + PKCE (S256) + `nonce`. `GET
  /auth/telegram/oidc/start?mode=login|link&returnTo=/path` sets a `to_oidc` cookie (random
  32 bytes, HttpOnly, Secure, Lax, 10 min) and stores `{ verifier, nonce, mode, returnTo,
  cookieHash, userId?, sessionId?, host }` in Redis under `state` (single use). The callback
  requires the cookie hash to match, consumes state and cookie once, exchanges the code,
  verifies `id_token` with `jose` (`createRemoteJWKSet`, issuer, audience, `nonce`, `exp`), and
  requires a numeric Telegram user id claim (`sub`, else `id`) — it fails closed otherwise. In
  link mode the current session's user must equal the stored `userId` (`409` otherwise).
  `returnTo` must match `^/(?!/)` (same-origin path) else `/`. The redirect URI registered
  with Telegram is the **app-origin** proxied path
  `https://<app-host>/__backend/api/v1/auth/telegram/oidc/callback`; the post-login redirect
  goes to the stored `host` (validated against `FRONTEND_ORIGINS`), never a single
  `FRONTEND_URL`. OIDC is enabled only on hosts registered with Telegram
  (`VITE_TELEGRAM_OIDC_ENABLED`); widget/mini-app work everywhere the domain is set.
- A unit test asserts widget, mini-app and OIDC yield the same `subject` for one fixture user.

### 7.3 Canton wallet (challenge / signature)
1. `POST /auth/wallet/challenge { partyId, purpose }` (purpose ∈ `sign-in` |
   `link-wallet` | `admin-sign-in`). `partyId` must match
   `^[A-Za-z0-9_\-.]{1,255}::1220[0-9a-f]{64}$` (exactly one `::`). Link challenges require a
   session and record its `sessionId`. Response `{ challengeId, message, expiresAt }`. The
   message is regenerated server-side from the stored record and signed verbatim (UTF-8):
   ```
   TruthOracle <purpose>
   Domain: <app host>
   URI: https://<app host>
   Network: <APP_NETWORK>
   Party: <partyId>
   Nonce: <nonce>
   Issued: <ISO-8601>
   Expires: <ISO-8601>
   ```
2. Wallet `signMessage(message, partyId)` (Cantor8 signs raw UTF-8 — confirmed 2026-09-01).
3. `POST /auth/wallet { challengeId, partyId, publicKey, signature, kind }` (`kind` allowlist:
   `cantor8`; informational). The challenge claim is consumed **before** verification (a bad
   signature burns it). Verification (`util/canton-crypto.ts`):
   - `publicKey` decodes to 32 bytes (hex / base64 / base64url; short prefixes tolerated);
   - **key ↔ party binding**: `fingerprint(publicKey) === partyId.split("::")[1]` where
     `fingerprint = hex(0x12 0x20 ‖ sha256(uint32be(12) ‖ rawKey))` — exactly
     `TopologyWriteService.createFingerprintFromKey` in `@canton-network/wallet-sdk`
     (HashPurpose 12 = PublicKeyFingerprint, multihash sha2-256). Verified against the real
     operator party in `truthoracle-canton/.env`. Nothing is pinned or trusted from the
     client. Limitation (documented, error `wallet_key_mismatch` = "this wallet's signing key
     is not its namespace key"): parties whose signing key was rotated or that were allocated
     under a participant namespace cannot sign in until a topology-based check exists;
   - Ed25519 verify over the raw UTF-8 message, falling back to the `sha256(utf8)` preimage
     (port of `verifyPartySignature.mjs`, same shape-only diagnostics);
   - operators listed in `ADMIN_OPERATORS` as `party=publicKey` are additionally checked
     against the pinned key.
   - **Purpose isolation**: with a session present the endpoint accepts only
     `purpose = link-wallet` challenges issued to that session; `sign-in` / `admin-sign-in`
     challenges are rejected when a session cookie is present (and vice versa).
   On success: identity `(canton_wallet, partyId)` + wallet row seeded per §8.1; the first
   wallet becomes primary and sets `users.party_id`.

### 7.4 Admin sign-in
`purpose = admin-sign-in` → a `kind = admin` session (§6.8), only for parties in
`ADMIN_OPERATORS`. The `/admin` UI in `truthoracle-canton` keeps its own `to_admin`
flow until it is ported; the two do not interact (the proxy never forwards `to_admin`).
`ADMIN_AUTH.md` and the `adminSession.mjs` header comment ("the key cannot be derived from
the party id") are corrected in the same change (§18).

## 8. Wallets and the in-app balance

### 8.1 Linking
- `POST /wallets/link-challenge` + `POST /wallets/link` (same crypto as §7.3, purpose
  `link-wallet`, session-bound). Also reachable through `POST /auth/wallet` in link mode.
- A party with **any** `to_wallets` row (active or revoked) under another user →
  `409 wallet_already_linked`. Re-linking a party that already has a row under this user
  reactivates that row (`status → active`, `credited_cc` and `legacy_credited_cc` untouched);
  it never inserts.
- **Seed on first link** (audited): `legacy_credited_cc = fetchUserWallet(treasury,
  party)?.depositedCC ?? 0`. A non-primary party that owns its own on-ledger `UserWallet`
  keeps it: its balance is shown as `ownLedgerWallet` in `GET /in-app-wallet` and remains
  withdrawable only with that wallet's key; the backend never folds it into the primary.
- Linking creates/reactivates the `canton_wallet` identity; the KYC lock and last-identity
  rules apply through `IdentityService.unlink` on unlink.

### 8.2 Primary wallet
`users.party_id` = owner of the on-ledger `UserWallet`; the Daml `Withdraw` controller is the
owner, and payouts are addressed to it. `POST /wallets/:id/primary` takes
`lock:deposit:<userId>`, re-reads the ledger, and succeeds only while the user has **no**
`UserWallet` on-ledger and no queued payouts. The primary is therefore permanent once a
deposit exists — stated in `GET /me.capabilities.primaryPartyId` and in the UI copy at first
deposit. The primary wallet cannot be unlinked while `users.party_id` points at it.

### 8.3 Deposit reconciliation — `POST /in-app-wallet/deposits/reconcile` (session)
Preconditions: `users.party_id` set (`409 no_primary_wallet`), user `active`, KYC not
`blocked_duplicate` (`409 kyc_duplicate_identity`), `lock:deposit:<userId>` acquired (TTL
**300 s**, above the worst-case history walk; `409 deposit_in_progress`).

```
1. confirm pass: for each to_deposit_credits row of this user with status = submitted:
     read UserWallet(owner = primary) ; if DAML_USER_WALLET_HAS_DEPOSIT_REFS: confirmed iff
     depositRefs contains tx_ref ; else confirmed iff depositedCC ≥ deposited_cc_before + amount
     → on confirm: apply attribution bumps (credited_cc += amountCC per wallet) + status confirmed
     → if the ledger shows the pre-state AND the wallet reports the command as never-happened
       (transferAlreadySubmitted-style status read, fail closed on errors): status failed
     → otherwise leave submitted (still in flight); reconcile stops here with 409 deposit_in_progress
2. history = transferHistory(treasury)  (UNCACHED on this route; paged as walletClient.mjs)
3. for every wallet row w of the user (active AND revoked):
     received_w = totalReceivedFrom(history, treasury, w.party)          # settled Amulet inbound only
     owed_w     = round10(received_w) − legacy_credited_cc_w − credited_cc_w
     if owed_w < −DUST → over-credit drift: audit + Sentry, 409 deposit_attribution_drift
4. ledger = UserWallet(owner = primary)
   expected = legacy_credited_cc[primary] + Σ_w credited_cc_w
   delta    = ledger.depositedCC − expected
     delta < −DUST → 409 deposit_attribution_drift (hard)
     delta > DUST  → self-heal: attribute delta to the primary wallet (credited_cc += delta),
                     audit `deposit.attribution_healed` (legacy-path credit), continue
5. amount = Σ_w max(owed_w, 0)  (each owed_w rounded to 10 dp BEFORE summing; exact fixed point)
   if amount ≤ DUST → 200 { credited: 0 }
6. commandId = "deposit-" + sha256(primary | ledger.cid ?? "create" | amount | ledger.depositedCC)[:40]
   INSERT to_deposit_credits { command_id, owner_party, amount_cc, attribution, deposited_cc_before,
     wallet_cid_before, status: submitted } ON CONFLICT (command_id) DO NOTHING
     → no row inserted: 409 deposit_in_progress
7. submit as treasury: Exercise Deposit { amountCC, txRef: "reconcile:<commandId>" } on ledger.cid,
   or Create UserWallet { owner: primary, balanceCC = depositedCC = amount, withdrawnCC = 0,
   depositRefs: Some ["reconcile:<commandId>"] when DAML_USER_WALLET_HAS_DEPOSIT_REFS }
8. run the confirm pass again immediately (best effort); respond with per-wallet attribution
   and status (confirmed | submitted)
```
Invariant by construction: `ledger.depositedCC == legacy_credited_cc[primary] + Σ credited_cc`
with zero tolerance after confirmation (all arithmetic in fixed point). Identical derivation
principle to `api/wallet/deposit.mjs` (amounts never come from the client; deterministic
command ids make concurrent duplicates collide) extended to N wallets, crash-safe through
the write-ahead row, and self-healing for legacy credits. `GET /in-app-wallet` may serve a
15 s cached history view; the reconcile route never does.

### 8.4 Money arithmetic
`util/money.ts`: CC amounts are `bigint` in 1e-10 units end to end (parse wallet/ledger
strings with a decimal parser, never `Number`); `DUST = 10n` (1e-9 CC); formatting emits
exactly 10 decimals for Daml.

### 8.5 Withdrawals
User-signed (`UserWallet.Withdraw` → `PendingPayout reason=withdraw`), unchanged on-ledger.
The frontend refuses to build the `Withdraw` command when `capabilities.canWithdraw` is
false or the connected party is not `primaryPartyId`. Settlement is the gated step (§9.4).
Users can return a queued or blocked withdrawal to their balance with `CancelPayout
{ refundWalletCid = Some(currentWalletCid) }` — a user-signed action the frontend now
exposes (§16); the UI never offers the forfeiting `None` variant.

## 9. KYC

### 9.1 Provider abstraction (`services/kyc-provider.*.service.ts`, token `KYC_PROVIDER`)
```ts
interface KycProvider {
  readonly name: "mock" | "sumsub";
  createSession(user, applicantId | null, level): Promise<{ accessToken; expiresAt; applicantId? }>;  // reuses the user's applicant
  verifyWebhook(rawBody: Buffer, headers): KycEvent | null;      // null = signature/algorithm rejected
  fetchApplicant(applicantId): Promise<ApplicantSummary>;         // { answer, rejectType, labels, levelName, sandbox, documents: [{ docType, country, number, dob }], person: { firstName, lastName, dob, country } } — in memory only
}
type KycEvent = { applicantId; externalUserId; levelName; kind: created|pending|reviewed|onHold|reset|unknown;
                  answer?: GREEN|RED; rejectType?: RETRY|FINAL; labels: string[]; occurredAt: Date; sandbox: boolean; eventKey: string }
```
- **Sumsub**: signing `X-App-Token`, `X-App-Access-Ts`, `X-App-Access-Sig = hex(HMAC-SHA256(
  secret, ts + METHOD + path(+query) + body))`; SDK token `POST /resources/accessTokens/sdk
  { userId, levelName, ttlInSecs }` → `{ token }` (token refresh handler served by the same
  session endpoint, idempotent); webhook digest `x-payload-digest` + `x-payload-digest-alg`
  (`HMAC_SHA256_HEX` default, `HMAC_SHA512_HEX` accepted, `HMAC_SHA1_HEX` rejected unless
  `SUMSUB_ALLOW_SHA1=true`), both headers required, `timingSafeEqual`; applicant data `GET
  /resources/applicants/{id}/one`. `sandboxMode`/`testMode` events are stored but never
  applied when `APP_NETWORK=mainnet`. Sumsub's own duplicate-applicant rejection label
  (`SUMSUB_DUPLICATE_LABELS`, default `DUPLICATE`) maps to `blocked_duplicate`.
- **Mock** (never in prod/mainnet): `POST /kyc/mock/submit { outcome, person: { firstName,
  lastName, dob, country }, documents: [...] }` drives the same state machine through the
  same `KycEvent` shape; inputs are fingerprinted immediately and never persisted or logged.

### 9.2 Lifecycle and precedence
`none → initiated → pending → approved | rejected_retry | rejected_final | needs_review |
blocked_duplicate`; `approved → expired` only by admin/provider expiry. Webhooks are stored
first (`to_kyc_webhook_events`, idempotent on `event_key`), acked 200, then `{ eventId }` is
published to NATS `truthoracle.kyc.webhook.<provider>`; the durable consumer re-reads the row
and applies transitions ordered by `occurredAt` (events older than `provider_event_at` are
dropped). **The webhook is only a trigger**: the `approved` transition requires
`fetchApplicant` to return `GREEN` at `level_name = KYC_REQUIRED_LEVEL`. `users.kyc_status`
precedence: an in-flight renewal never downgrades `approved` until the old approval expires
or is revoked; `blocked_duplicate` beats everything.

### 9.3 One person, one account
On GREEN, build peppered keys (`HMAC-SHA256(KYC_FINGERPRINT_PEPPER, canonical)`; raw values
never stored):
- one `doc` key per identity document with docType ∈ {PASSPORT, ID_CARD, DRIVERS,
  RESIDENCE_PERMIT}: `upper(country)|upper(docType)|NFKC-upper-alnum(number)`;
- one `person` key: `upper(country)|dob(YYYY-MM-DD)|NFKC-upper(lastName)|NFKC-upper(firstName)`.
If no `doc` key can be built → `needs_review` (admin queue), not approved. Binding: for each
key `INSERT INTO to_kyc_persons … ON CONFLICT (fingerprint) DO NOTHING`, then read the row:
same `user_id` (or released) → proceed; different user → the verification becomes
`blocked_duplicate`, `users.kyc_status = blocked_duplicate`, audit, NATS
`truthoracle.kyc.duplicate_detected`. Consequences of `blocked_duplicate`: no new KYC
sessions (`409 kyc_duplicate_identity`), `capabilities.canDeposit = false`, reconcile refused,
user text never identifies the other account. Bindings survive expiry/closure; the v1 admin
action `POST /admin/kyc/persons/:fingerprint/transfer { toUserId, reason }` releases and
re-binds (audited) — enough to operate without merge tooling.

### 9.4 Enforcement (KYC when money leaves) — `PayoutService.settle(cid, actor)`
All three entry points (processor, user route, admin route) call one service under
`lock:payout:<cid>`; `to_payouts` is the durable arbiter:
```
resolve payout from the ledger (as treasury); upsert to_payouts on first sight:
  user_id / payee_wallet_id from to_wallets by payee_party (active or revoked)
policy by reason (closed map, no default-external):
  withdraw            → external:  requires user active AND kyc gate (below) AND payee wallet active
                        else status blocked_kyc | blocked_unknown_user | blocked_wallet_revoked
  bond, model-prize   → in-app:    if UserWallet(owner = payee) missing → treasury Create UserWallet{0,0,0}
                        (commandId "wallet-create-<sha256(payee)[:40]>", separate submission), then
                        SettleToWallet { walletCid: freshly read } (commandId "settle-<cidHash>")
  anything else       → blocked_unknown_reason (admin queue)
external path: set status settling + transfer_command_id ("payout-<cidHash>") BEFORE calling transfer();
  if the row already records a submitted transfer: NEVER call transfer() again — check
  transferAlreadySubmitted (fail CLOSED on read errors: stop, keep settling) then MarkPaid
  ("markpaid-<cidHash>"); attempts capped at PAYOUT_MAX_ATTEMPTS (5) → failed (admin queue)
archived contract: if a submit was recorded → settled_external / settled_in_app; else archived (user cancel)
kyc gate: users.status = active AND to_kyc_persons binding for the user AND an approved, unexpired
  verification with level_name = KYC_REQUIRED_LEVEL; applies only when KYC_ENFORCE_WITHDRAWALS=true
```
- `POST /in-app-wallet/payouts/:cid/settle` returns `404 payout_not_found` unless the payee
  party is one of the caller's wallets, and `409 kyc_required` when blocked by the gate. The
  gate is always evaluated on the **payee's** account, never the caller's.
- `POST /admin/payouts/:cid/settle { force?: boolean, reason }`: `force` overrides
  `blocked_kyc`/`blocked_wallet_revoked` only with a reason and is audited as
  `payout.admin_override`.
- `payout-settlement.processor` scans PendingPayouts every `PAYOUT_SCAN_MS` (30 s) and
  consumes `truthoracle.kyc.status_changed` (→ `approved` re-queues that user's `blocked_kyc`
  rows). Product change (deliberate): `bond` and `model-prize` payouts now settle **into the
  in-app wallet** instead of external CC; `liquidity` is never produced by the Daml and is not
  in the policy.
- `GET /me.capabilities`: `canWithdraw`, `kycRequiredForWithdrawal`, `primaryPartyId`,
  `canDeposit`.

### 9.5 Attachment to the login method
`initiated_identity_id = session.auth_identity_id` at `POST /kyc/sessions`; the session's
kind/identity is recorded on the audit event; that identity is locked (§6.5) while the
approval stands. `GET /kyc` reports which identity the verification is attached to.

### 9.6 Pepper versioning
`to_settings.kyc_pepper_hash = sha256(KYC_FINGERPRINT_PEPPER)` is written on first boot and
checked on every boot; a mismatch refuses to boot unless `KYC_PEPPER_ROTATION_ACK=<new hash>`
is set. `fingerprint_version` on bindings; RUNBOOK documents that rotation requires
re-fetching applicant data for every bound person and recomputing keys.

### 9.7 Data minimisation
Applicant data lives in memory for the duration of one call — never logged, never sent to
Sentry, never in audit metadata or NATS. KYC audit metadata allow-list: `verificationId,
provider, level, status, rejectType, labels, attemptNo`. `to_kyc_webhook_events.payload` is
purged after 30 days (`kyc-cleanup` in `session-cleanup.processor`).

## 10. Infrastructure services

- **RedisService** (ioredis 5): `claimOnce`, `hitRateLimit`, `acquireLock → { acquired,
  release }`, `getJson/setJson`, `sadd/srem/smembers`. Required at boot; keys prefixed
  `truthoracle:<APP_NETWORK>:`.
- **NatsService**: connects at boot, ensures stream `TRUTHORACLE_<APP_NETWORK>`
  (`subjects: ["truthoracle.>"]`, file storage, 7-day retention), `publish(subject, payload,
  { msgID })`, `consume(durable, filterSubject, handler)` with explicit ack. Subjects:
  `truthoracle.user.created`, `truthoracle.auth.login|admin_login`,
  `truthoracle.identity.linked|unlinked|reattached`,
  `truthoracle.wallet.linked|unlinked|primary_changed`, `truthoracle.deposit.credited|healed|drift`,
  `truthoracle.payout.settled|blocked|failed`, `truthoracle.kyc.session_started|status_changed|duplicate_detected`,
  `truthoracle.kyc.webhook.<provider>` (payload `{ eventId }` only).
- **KeycloakTokenService**: port of `_keycloakToken.mjs`; Redis cache keyed by
  `issuerUrl|realm|clientId`, 60 s margin.
- **LedgerClientService**: port of `ledgerClient.mjs` (package-name filters, `fetchUserWallet`,
  `fetchPendingPayouts`, `fetchPendingPayout`); on mainnet the ledger client reads `ZKPC_*`
  only (`LEDGER_API_URL`/`KEYCLOAK_*` are ignored for it, exactly as `upstream.mjs`).
- **EnterpriseWalletService**: port of `walletClient.mjs` (`transferHistory` paging,
  `totalReceivedFrom` in fixed point, `transferAlreadySubmitted` with an explicit
  `{ known: boolean }` result so callers can fail closed, `externalSubmit`, `transfer`).
- **SentryService**: wrapper (`Sentry.init` happens in `main.ts`).
- **AuditService**, **RateLimitService** (`key`, window, max; `subject` and `ip` dimensions).

## 11. API surface (prefix `/api/v1`; auth = session unless marked)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` · `/health/ready` | public | liveness · readiness (pg, redis, nats) |
| GET | `/auth/session` | public | `{ authenticated, kind?, user?, expiresAt? }` |
| POST | `/auth/google/nonce` | public | `{ nonce }` |
| POST | `/auth/google` | public / link | `{ credential, nonce? }` |
| POST | `/auth/telegram/widget` · `/auth/telegram/miniapp` | public / link | |
| GET | `/auth/telegram/oidc/start` · `/auth/telegram/oidc/callback` | public | §7.2 |
| POST | `/auth/wallet/challenge` | public (link: session) | `{ partyId, purpose }` |
| POST | `/auth/wallet` | public / link | `{ challengeId, partyId, publicKey, signature, kind }` |
| POST | `/auth/logout` | session | revoke current session, clear cookie |
| GET | `/me` | session | user, identities, wallets (+ ownLedgerWallet), kyc summary, capabilities |
| PATCH | `/me` | session | `{ displayName?, avatarUrl? }` |
| DELETE | `/me/identities/:id` | session | unlink (rules §6) |
| POST | `/me/identities/:id/reattach` | session | link-mode re-attachment by the original user (§6.4) |
| GET · DELETE | `/me/sessions` · `/me/sessions/:id` · POST `/me/sessions/revoke-others` | session | |
| GET | `/me/audit?page=` | session | own trail |
| GET | `/wallets` · POST `/wallets/link-challenge` · POST `/wallets/link` | session | |
| DELETE | `/wallets/:id` · POST `/wallets/:id/primary` | session | |
| GET | `/in-app-wallet` | session | primary UserWallet, attribution per wallet, ownLedgerWallet per wallet, payouts |
| POST | `/in-app-wallet/deposits/reconcile` | session | §8.3 |
| GET | `/in-app-wallet/payouts` · POST `/in-app-wallet/payouts/:cid/settle` | session | §9.4 (`retryAfterKyc` on blocked rows) |
| GET | `/kyc` · POST `/kyc/sessions` | session | |
| POST | `/kyc/mock/submit` | session; mock provider only (route absent otherwise) | |
| POST | `/webhooks/kyc/sumsub` | signature | raw body |
| GET | `/admin/users?q=&page=` · GET `/admin/users/:id` | admin | |
| POST | `/admin/users/:id/suspend` · `/reinstate` · `/sessions/revoke` | admin | |
| POST | `/admin/users/:id/identities/:identityId/reattach` · `/unlink` | admin | |
| POST | `/admin/users/:id/kyc/override` | admin | `{ status, reason }` → `provider = admin` verification; refused (409) if the person is bound elsewhere |
| GET | `/admin/kyc/duplicates` · `/admin/kyc/needs-review` | admin | |
| POST | `/admin/kyc/persons/:fingerprint/transfer` | admin | `{ toUserId, reason }` |
| GET | `/admin/payouts?status=` · POST `/admin/payouts/:cid/settle` | admin | |
| GET | `/admin/audit?subjectType=&subjectId=&page=` | admin | |

Errors: `{ error: <stable code>, message, details? }` from one global exception filter.
Codes: `unauthenticated`, `forbidden`, `csrf_rejected`, `rate_limited`, `identity_already_linked`,
`identity_unlinked`, `last_identity`, `identity_locked_by_kyc`, `wallet_already_linked`,
`wallet_key_mismatch`, `signature_invalid`, `challenge_rejected`, `challenge_purpose_mismatch`,
`no_primary_wallet`, `primary_wallet_in_use`, `deposit_in_progress`,
`deposit_attribution_drift`, `payout_not_found`, `payout_blocked` (`details.status` names the
blocking payout status), `kyc_required`, `kyc_duplicate_identity`, `kyc_provider_unavailable`,
`webhook_rejected`, `invalid_credential`, `oidc_failed`, `user_suspended`, `validation_failed`,
`bad_request`, `not_found`, `payload_too_large`, `unsupported_media_type`, `upstream_failed`,
`not_ready`, `internal_error`, `backend_unconfigured` and `backend_unreachable` (proxy only).
The authoritative list is `ERROR_CODES` in `src/types.ts`; the frontend mirrors it in
`frontend/auth/types.ts`. `challenge_purpose_mismatch` is 401 when raised at verification and
409 when a link challenge is requested without a session.

Swagger UI at `/api/docs` when `SWAGGER_ENABLED=true` (never reachable through the proxy).

## 12. Configuration (`.env.example` is the full annotated list)

```
APP_ENV=dev|staging|prod        APP_NETWORK=devnet|mainnet     PORT=8091      LOG_JSON=auto
DATABASE_URL  REDIS_URL  NATS_URL (all required)   DB_MIGRATE_ON_BOOT=true   DB_SSL=auto
SESSION_SECRET (≥32)  SESSION_TTL_HOURS=168  ADMIN_SESSION_TTL_HOURS=1
COOKIE_SECURE=auto (= APP_ENV !== dev)  COOKIE_DOMAIN= (empty)  FRONTEND_ORIGINS (list; patterns like https://*.vercel.app allowed)
BACKEND_PROXY_SECRET (≥32)  CORS_ORIGINS= (native/direct clients only)
GOOGLE_CLIENT_IDS  GOOGLE_NONCE_REQUIRED=auto
TELEGRAM_BOT_TOKEN  TELEGRAM_BOT_USERNAME  TELEGRAM_AUTH_MAX_AGE_SEC=300  TELEGRAM_INITDATA_MAX_AGE_SEC=3600
TELEGRAM_OIDC_CLIENT_ID  TELEGRAM_OIDC_CLIENT_SECRET  TELEGRAM_OIDC_ISSUER=https://oauth.telegram.org
ADMIN_OPERATORS (party[=publicKey], comma)
LEDGER_API_URL  ENTERPRISE_WALLET_URL  TREASURY_PARTY_ID  ENTERPRISE_WALLET_APP_NAME=truthoracle
TRUTHORACLE_PACKAGE_ID  TRUTHORACLE_PACKAGE_NAME  DAML_USER_WALLET_HAS_DEPOSIT_REFS=false
KEYCLOAK_URL KEYCLOAK_REALM KEYCLOAK_CLIENT_ID KEYCLOAK_CLIENT_SECRET  LEDGER_KEYCLOAK_* WALLET_KEYCLOAK_*  ZKPC_*
KYC_PROVIDER=mock|sumsub  KYC_ENFORCE_WITHDRAWALS=false  KYC_REQUIRED_LEVEL=basic-kyc-level
KYC_FINGERPRINT_PEPPER (≥32)  KYC_PEPPER_ROTATION_ACK=  LEGACY_WALLET_ENDPOINTS_RETIRED=false
PAYOUT_EXTERNAL_REASONS=withdraw  PAYOUT_INAPP_REASONS=bond,model-prize  PAYOUT_MAX_ATTEMPTS=5  PAYOUT_SCAN_MS=30000
SUMSUB_BASE_URL=https://api.sumsub.com SUMSUB_APP_TOKEN SUMSUB_SECRET_KEY SUMSUB_WEBHOOK_SECRET SUMSUB_DUPLICATE_LABELS=DUPLICATE SUMSUB_ALLOW_SHA1=false
SESSION_CLEANUP_MS=3600000  LEDGER_CACHE_MS=15000  DEPOSIT_LOCK_TTL_MS=300000  SENTRY_DSN  SWAGGER_ENABLED=auto
```
Boot refuses: missing DATABASE_URL/REDIS_URL/NATS_URL; short SESSION_SECRET /
BACKEND_PROXY_SECRET / KYC_FINGERPRINT_PEPPER; `KYC_PROVIDER=mock` when `APP_ENV=prod` **or**
`APP_NETWORK=mainnet`; `SUMSUB_APP_TOKEN` starting with `sbx:` on mainnet;
`KYC_ENFORCE_WITHDRAWALS=true` without `LEGACY_WALLET_ENDPOINTS_RETIRED=true`; mainnet without
`ZKPC_*`; `to_settings.app_network` ≠ `APP_NETWORK`; pepper hash mismatch without ack;
`COOKIE_DOMAIN` set while `BACKEND_PROXY_SECRET` is configured (proxied cookies must be host-only).

## 13. Security controls (checklist)

- Money never trusts the client; deterministic command ids; write-ahead rows; fixed point.
- Timing-safe comparisons for every MAC / hash / token / proxy secret.
- Key ↔ party binding by Canton's own fingerprint; purpose-isolated challenges; SIWE-style
  message with domain/network/expiry.
- Cookies HttpOnly/Secure/Lax/host-only; CSRF on all non-GET; JSON-only bodies; sessions
  revocable with a per-user index; suspension revokes; admin = short wallet-signed session.
- Rate limits (Redis, fixed window, keyed by client IP from the proxy contract **and** by
  subject): login 10/min/IP + 5/min/subject, nonce 30/min/IP, challenge 30/min/IP + 10/min/party,
  telegram 10/min/IP, link 10/min/user, reconcile 30/min/user, settle 30/min/user, kyc session
  5/min/user, webhook 600/min/IP.
- Webhooks: raw-body signature, both digest headers required, idempotent, async, sandbox flags
  honoured; approval always re-read from the provider API.
- Secrets never logged; audit metadata allow-listed; KYC PII never persisted beyond peppered
  fingerprints and provider ids.
- Fail closed everywhere: unknown status reads stop settlement; unconfigured provider → 503.

## 14. Observability

`ConsoleLogger` (JSON outside dev), request id middleware (`x-request-id` echoed), Sentry for
processor exceptions and 5xx (tags: route, userId; never bodies or PII), `/health/ready`
checks pg/redis/nats, structured audit trail.

## 15. Testing

- Unit (`*.spec.ts`, Jest ESM mode): canton fingerprint (fresh keypair fixture + the real
  operator pair pattern), Ed25519 verification matrix, Telegram widget/mini-app/OIDC subject
  consistency + replay, Google verifier (mocked), session issue/verify/revoke/index, identity
  link/unlink/reattach rules incl. `identity_unlinked`, wallet primary rules, deposit
  attribution (fixed point; seed; unlink/relink; drift both directions; confirm pass; crash
  between submit and commit), payout matrix (reason × kyc × enforce × has-wallet × known-user
  × recorded-submit × status-read-error), KYC state machine + persons binding + duplicate +
  transfer, Sumsub signing/digest, rate limiter/lock against real Redis.
- e2e (`test/*.e2e-spec.ts`): auth round trips, link flows, reconcile/settle with fakes for
  ledger/wallet/KYC provider, against the docker-compose services.
- Backend CI (`.github/workflows/ci.yml` in this repo): Node 24, `npm ci`, `typecheck`,
  `lint`, `test`, `test:e2e` (service containers), `build`.

## 16. Frontend integration (in `../truthoracle-canton/frontend`, branch `feat/accounts-auth-kyc`)

Prerequisite: remove the duplicate `WalletProvider` (`main.tsx` wraps App in one, `App.tsx`
mounts a second; each spins up its own Cantor8 SDK instance). Keep one in `App.tsx`.

New files:
- `lib/backend.ts` — fetch wrapper: base `BACKEND_BASE_URL` (`VITE_BACKEND_PROXY_URL`, default
  `/__backend`), `credentials: "include"`, `x-requested-with: truthoracle`, JSON, typed
  `BackendError { code, status }`; a `503 backend_unconfigured` resolves to `available: false`.
- `auth/AuthContext.tsx` + `useAuth()` — mounted `<WalletProvider><Router><AuthProvider>` so it
  can use the wallet context and router. Renders children immediately; state
  `unavailable | anonymous | authenticated`; any error → `anonymous`; loads `/me` only after
  `/auth/session` says authenticated; deduped in-flight probe (pattern of `lib/adminSession.ts`).
  Owns the single "connected wallet is not linked" prompt (one effect keyed on
  `account.address`).
- `auth/google.ts`, `auth/telegram.ts`, `auth/wallet.ts` — promise-cached script loaders
  (StrictMode-safe: GIS button rendered into a ref container cleared on cleanup; Telegram
  widget registers `window.onTelegramAuth` before appending the script and removes script +
  iframe on cleanup; widget hidden when `VITE_TELEGRAM_BOT_USERNAME` is empty).
- `components/auth/LoginDialog.tsx` — Google, Telegram (widget; OIDC button when
  `VITE_TELEGRAM_OIDC_ENABLED`), Canton wallet (only when `WALLET_TYPE === "cantor8"`).
- `components/auth/AccountMenu.tsx` — header avatar/name, link to `/account`, sign-out **button**.
- `components/Account/AccountPage.tsx` (route `/account`, gated AdminGate-style: sign-in prompt,
  no redirect) — profile; sign-in methods (link/unlink/reattach); wallets (link via signature,
  primary badge + permanence note, unlink, attribution, ownLedgerWallet); identity
  verification (`KycPanel`: status, start → Sumsub WebSDK container or mock form); sessions.
- `components/kyc/KycPanel.tsx` — loads
  `https://static.sumsub.com/idensic/static/sns-websdk-builder.js` on demand.
Changed files:
- `App.tsx` route `/account`; provider order as above; `Header.tsx` Sign-in / AccountMenu
  (hidden when `unavailable`).
- **Wallet ↔ account UI states** (keyed on `account.address` vs `/me`):
  (A) equals `user.party_id` → full (deposit, trade, withdraw);
  (B) an active linked non-primary wallet → deposit-only; trade/withdraw disabled with
  "connect <primary> to trade";
  (C) unlinked while authenticated → today's anonymous behaviour for that party (its own
  UserWallet, legacy paths) plus a link CTA; the backend reconcile is never called for it.
  In authenticated mode `InAppWalletCard` self-fetch and `MarketView` managed mode key wallet
  lookups by `user.party_id`.
- `InAppWalletCard.tsx` — authenticated: deposit → `POST /in-app-wallet/deposits/reconcile`;
  withdraw gated by `capabilities.canWithdraw` and `primaryPartyId` (never builds the command
  otherwise) with a "Verify identity" CTA; settlement → `POST /in-app-wallet/payouts/:cid/settle`.
- `Portfolio/PendingPayouts.tsx` — shows backend status (`blocked_kyc`, `retryAfterKyc`) and a
  "Cancel and refund to in-app wallet" action for `withdraw` rows (`CancelPayout` with
  `refundWalletCid = Some(walletCid)`, user-signed).
- `lib/inAppWallet.ts` — when authenticated and available, use the backend for reconcile and
  settle; anonymous flows unchanged only where the backend is unconfigured (§18).
- `config.ts` — `BACKEND_BASE_URL`, `GOOGLE_CLIENT_ID`, `TELEGRAM_BOT_USERNAME`,
  `TELEGRAM_OIDC_ENABLED` (all optional).
- `../api/proxy/backend.mjs` (§4.1), `vercel.json`, `vite.config.ts`, root `.env.example`
  (`BACKEND_URL`, `BACKEND_PROXY_SECRET`, `VITE_*` above), `ADMIN_AUTH.md` + `adminSession.mjs`
  comment corrections. No CSP exists in the app today; none is added.
- Native iOS is a separate SwiftUI app and is untouched; the backend supports it via bearer
  sessions + explicit CORS (`credentials: true`, methods GET/POST/PATCH/DELETE, headers
  Content-Type/x-requested-with/Authorization).

## 17. Rollout

- Phase 1 (this change): backend (accounts, sign-in, wallet linking, session-gated deposit
  reconciliation, KYC with mock provider, gated payout settlement, admin API), frontend
  integration, **and the legacy endpoint retirement in §18**.
- Phase 2: Sumsub credentials + `KYC_ENFORCE_WITHDRAWALS=true` (only after
  `LEGACY_WALLET_ENDPOINTS_RETIRED=true`); port the `/admin` UI to backend admin sessions.
- Phase 3: custodial per-user parties (`POST /api/v1/accounts` on the Enterprise Wallet) so
  social-login users can hold an in-app balance without an external wallet; trades submitted
  by the backend on the user's behalf; topology-based key checks; merge tooling.

## 18. Legacy endpoint retirement (same rollout as Phase 1)

In `truthoracle-canton`, when `BACKEND_URL` is configured:
- `api/wallet/deposit.mjs` and `api/wallet/settle-payout.mjs` answer `410 { error:
  "moved_to_backend" }` — both derivations conflict with multi-wallet attribution and the
  KYC gate (double-credit and bypass otherwise).
- The frontend's deposit reconcile and withdrawal settlement require an account ("Sign in to
  deposit / withdraw"); trading and reads stay wallet-signed and anonymous-capable.
- `settle-payout.mjs` answers 410 to **every** caller (operators included) once
  `BACKEND_URL` is set: the backend's `payout-settlement.processor` settles `bond` /
  `model-prize` payouts in-app automatically and gates `withdraw`, and operators use
  `POST /admin/payouts/:cid/settle` (with reason / force) for anything stuck. The legacy
  `Admin/PayoutQueue` hides its Settle button unless the backend is unavailable.
When `BACKEND_URL` is unset (no backend deployed), everything behaves exactly as today.
The backend refuses `KYC_ENFORCE_WITHDRAWALS=true` until `LEGACY_WALLET_ENDPOINTS_RETIRED=true`
attests the above is deployed.

## 19. Decisions changed by the v1 review

| Area | v1 | v2 |
|---|---|---|
| Legacy money endpoints | kept "unchanged" through Phase 1 | retired (410) when `BACKEND_URL` set; boot attestation before enforcement |
| Deposit seeding | `credited_cc` starts at 0 | immutable `legacy_credited_cc` seed from the party's own `depositedCC`; positive drift self-heals to primary, negative drift hard error |
| Deposit crash safety | DB bump after submit | write-ahead `to_deposit_credits` + confirm pass; lock TTL 300 s |
| Attribution scope | active wallets | all wallet rows; party bound to first account forever; relink reactivates |
| Arithmetic | JS numbers, dust tolerance | fixed point bigint, exact invariant |
| Payout policy | in-app allowlist, default external | closed map: `withdraw` external (gated), `bond`/`model-prize` in-app (create wallet first), else blocked |
| Payout retries | ledger dedup only | `to_payouts` write-ahead arbiter, never re-transfer, fail closed on status errors, attempts cap |
| KYC gate subject | implicit | always the payee's account; user route ownership check; admin force with reason |
| Blocked withdrawals | "existing CancelPayout UI" (did not exist) | CancelPayout UI added; re-queue on approval |
| Fingerprint | one key, partial unique index | doc + person keys in `to_kyc_persons`, bindings survive expiry, admin transfer |
| Sumsub applicant id | unique per verification | bound to the user; verifications unique per attempt |
| Approval source | webhook body | provider API re-read; ordered by `occurredAt` |
| Mock provider | blocked in prod only | blocked in prod **or** mainnet; route registered conditionally; `sbx:` tokens refused on mainnet |
| Unlinked identity sign-in | auto re-attach | `403 identity_unlinked`; explicit reattach by original user/admin |
| OIDC | state only | `to_oidc` cookie binding, nonce, link-mode user check, validated `returnTo`, app-origin redirect URI |
| CSRF | cookie-bearing non-GET only | all non-GET, JSON-only, missing Origin rejected, bearer/webhook exempt |
| Admin | `role` on user via any identity, 7-day cookie | session kind from wallet-signed admin challenge, 1 h, no `ADMIN_EMAILS` |
| Wallet link purpose | any challenge in link mode | purpose isolation, session-bound link challenges |
| Rate limits / IP | undefined behind proxy | proxy secret + `x-real-ip`; subject dimension; explicit limits |
| Proxy | one sentence | full contract (§4.1) |
| Sessions | hash cache only | per-user index, status read per request |
| Stack | ioredis 6, CJS jest, TS 6.0.x, Node ≥22.12 | ioredis 5.11.1, Jest ESM mode, TS 6.0.3 exact, Node ^22.18 ‖ ≥24.11, explicit rootDir, migrations via dist |
| CI | "root workflow" | own workflow in this repo |
| Frontend providers | AuthProvider in main.tsx | duplicate WalletProvider removed; AuthProvider inside Wallet + Router; three wallet/account UI states |
