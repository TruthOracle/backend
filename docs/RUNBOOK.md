# TruthOracle backend — runbook

Operator procedures for the situations the backend refuses to guess about. Each section names
the symptom, the cause and the fix. Feature packages extend this file (KYC operations, payout
queue, deposit drift) as they land.

## 1. Boot refusals

The process exits 1 with `Invalid configuration:` (from `src/config.ts`) or `Refusing to boot:`
(from `AppService.onModuleInit`) and never listens. Sentry receives the exception when a DSN is
configured.

| Message | Cause | Fix |
|---|---|---|
| `DATABASE_URL / REDIS_URL / NATS_URL is required` | a datastore is unset | set it; all three are required (NATS with JetStream, §4) |
| `SESSION_SECRET / KYC_FINGERPRINT_PEPPER must be at least 32 characters` | short secret | `openssl rand -hex 32` |
| `BACKEND_PROXY_SECRET must be at least 32 characters when set` | short proxy secret | same value on both sides (`truthoracle-canton` `BACKEND_PROXY_SECRET`) |
| `KYC_PROVIDER=mock is refused when APP_ENV=prod or APP_NETWORK=mainnet` | mock KYC in a real environment | set `KYC_PROVIDER` to the chosen vendor adapter (not selected yet — see docs/KYC.md §5; `sumsub` is the reference adapter) |
| `SUMSUB_APP_TOKEN is a sandbox token (sbx:) but APP_NETWORK=mainnet` | sandbox credentials on mainnet | use the production app token |
| `APP_NETWORK=mainnet requires ZKPC_*` | mainnet ledger credentials missing | set `ZKPC_LEDGER_API_URL`, `ZKPC_KEYCLOAK_URL`, `ZKPC_KEYCLOAK_CLIENT_ID`, `ZKPC_KEYCLOAK_CLIENT_SECRET` — `LEDGER_API_URL` / `KEYCLOAK_*` are ignored for the ledger on mainnet |
| `COOKIE_DOMAIN must stay empty while BACKEND_PROXY_SECRET is configured` | domain cookie behind the proxy | unset `COOKIE_DOMAIN` (the proxy strips `Domain=` anyway; cookies are host-only) |
| `to_settings.app_network is "X" but APP_NETWORK=Y` | the database was created for another network | point `DATABASE_URL` at the right database. Never edit `to_settings.app_network` to "fix" this: the Redis prefix, NATS stream, fingerprints and ledger credentials all differ per network |
| `KYC_FINGERPRINT_PEPPER does not match to_settings.kyc_pepper_hash` | pepper changed without acknowledgement | §2 |

A **warning** (not a refusal) is logged once at boot when neither `GOOGLE_CLIENT_IDS` nor
`TELEGRAM_BOT_TOKEN` is configured: `no sign-in provider is configured … nobody can create an
account`. The process still starts — local development routinely runs without either — but with
no sign-in method there is no account, and therefore no deposit and no trading (ARCHITECTURE §18).

## 2. KYC pepper rotation

`to_kyc_persons.fingerprint` values are `HMAC-SHA256(KYC_FINGERPRINT_PEPPER, canonical key)`.
Changing the pepper silently orphans every binding (the same person would no longer collide),
so boot compares `sha256(pepper)` with `to_settings.kyc_pepper_hash` and refuses on mismatch.

To rotate:

1. Compute the new hash: `printf '%s' "$NEW_PEPPER" | shasum -a 256`.
2. Deploy with `KYC_FINGERPRINT_PEPPER=<new>` **and** `KYC_PEPPER_ROTATION_ACK=<new hash>`.
   Boot updates `to_settings.kyc_pepper_hash` and logs a warning.
3. Recompute bindings: for every `to_kyc_persons` row that is not released, re-fetch the
   applicant from the provider (`fetchApplicant`), rebuild the doc/person keys with the new
   pepper, insert them with `fingerprint_version + 1`, and release the old rows
   (`release_reason = 'pepper rotation'`). Until this runs, duplicate detection is blind for
   already-bound people. (P4 ships the tooling; until then this is a scripted one-off.)
4. Remove `KYC_PEPPER_ROTATION_ACK` from the environment.

The pepper itself is never stored; only its hash is.

## 3. Daml package (truthoracle-v14) and deposit drift

The backend is built against **truthoracle-v14 1.0.0**
(`TRUTHORACLE_PACKAGE_ID=64653d3a4b63abcff3a0f016cdf08b0c46aa827f0b971b8990a7fdf5ede6446a`,
`TRUTHORACLE_PACKAGE_NAME=truthoracle-v14`), whose `UserWallet.depositRefs : [Text]` is
mandatory and is the deposit confirm pass's only confirmation rule. There is no Daml feature
flag and no upgrade path from an older package (ARCHITECTURE §18).

- `502 upstream_failed "ledger returned a UserWallet without depositRefs"` on any money route,
  with `UserWallet <cid> (owner …): UserWallet.depositRefs is missing; is TRUTHORACLE_PACKAGE_ID
  the deployed truthoracle-v14?` in the log: the configured package id / name does not match
  what is deployed. Fix the env; nothing was written.
- `409 deposit_attribution_drift` (audit `deposit.attribution_drift`, Sentry, NATS
  `truthoracle.deposit.drift`): the primary's on-ledger `depositedCC` differs from
  `Σ to_wallets.credited_cc` by more than 1e-9 CC in **either** direction
  (`details.kind = ledger_below_expected | ledger_above_expected`), a wallet is attributed more
  than it ever sent (`over_credit`), or the owner has two active `UserWallet`s
  (`duplicate_user_wallet`). Nothing is credited and the backend never repairs this on its
  own — every credit the wallet ever received went through this backend, so a surplus is as
  suspicious as a shortfall. Compare `GET /in-app-wallet.attribution` with the ledger
  contract, find the command that moved `depositedCC` (its `txRef` is in `depositRefs`), and
  correct `credited_cc` deliberately (audited SQL) once the cause is understood.
- `KYC_ENFORCE_WITHDRAWALS=true` is a plain flag: money leaves only through this backend, so
  it can be switched on whenever the KYC vendor is live (docs/KYC.md §5).

## 4. NATS JetStream requirement

Domain events and the webhook queue live on the JetStream stream `TRUTHORACLE_<APP_NETWORK>`
(subjects `truthoracle.>`, file storage, 7-day retention, 2-minute duplicate window). Boot
creates the stream if missing and extends its subjects if they drifted; durable explicit-ack
consumers are created per processor.

- The server must run with JetStream enabled: `nats-server -js` (docker-compose does this).
  Against a server without JetStream, boot fails at `jetstreamManager()` with a
  "JetStream not enabled" error.
- `/health/ready` reports `nats: fail` when the connection is closed; the client reconnects
  forever (`maxReconnectAttempts: -1`).
- To inspect: `nats stream info TRUTHORACLE_DEVNET`, `nats consumer ls TRUTHORACLE_DEVNET`.
- Deleting a stream loses undelivered webhook triggers: webhooks are stored in
  `to_kyc_webhook_events` first, so re-publishing `{ eventId }` for unprocessed rows recovers
  them.
- `Refusing to boot: JetStream would not create stream TRUTHORACLE_<NETWORK> because another
  stream already owns truthoracle.>` (JetStream error 10065, "subjects overlap with an existing
  stream"): JetStream allows exactly one stream per subject, and a stream created under another
  name — an older deployment that used `TRUTHORACLE` without the network suffix, or another app
  on a shared server — holds `truthoracle.>`. Run `nats stream ls`, then either `nats stream rm
  <old>` (after confirming it carries nothing undelivered) or `nats stream edit <old>` to remove
  the subject, and restart. Store directories (`-sd`) keep streams across server restarts, so a
  dev/CI server reused between runs can hit this too.
- Two backends on the same server and network must share the stream: never point `APP_NETWORK`
  variants at one server with conflicting subjects.

## 5. Migrations

- Schema changes ship as checked-in TypeORM migrations under `src/migrations/`;
  `synchronize` is hard-coded off. Boot runs pending migrations when `DB_MIGRATE_ON_BOOT=true`
  (the default) — run several replicas only after one has migrated, or set it to `false` and
  apply migrations explicitly first.
- CLI (compiled, `dist/data-source.js`): `npm run migration:run`, `npm run migration:revert`,
  `npm run migration:generate -- src/migrations/<Name>` (diffs the entities against
  `DATABASE_URL`; regenerating against a migrated database must print "No changes in database
  schema"). `.env` is read by the CLI the same way the app reads it.
- There is exactly one migration (`src/migrations/<ts>-Init.ts`): it creates the `citext` /
  `pgcrypto` extensions and every `to_*` table of the final layout and seeds
  `to_settings.app_network` from the `APP_NETWORK` the migration ran under; `kyc_pepper_hash`
  is written on first boot (§1, §2). Greenfield (ARCHITECTURE §18): a database created by an
  earlier layout is not upgraded — drop and recreate it (`dropdb truthoracle_backend && createdb
  truthoracle_backend`) and let `DB_MIGRATE_ON_BOOT` apply the migration.

## 6. Sessions and suspension

- Suspend (`POST /admin/users/:id/suspend`) revokes every live session through the Redis
  per-user index `user_sessions:<userId>` and the 30 s user cache is invalidated; the next
  request from that user is `403 user_suspended`.
- Removing a party from `ADMIN_OPERATORS` revokes its admin sessions on the next request.
- `SessionCleanupProcessor` deletes session rows 7 days after expiry/revocation and nulls
  `to_kyc_webhook_events.payload` after 30 days.

## 7. Proxy contract checks

If rate limits look wrong or every user shares one IP: confirm `BACKEND_PROXY_SECRET` matches on
both sides. Without a match the backend deliberately ignores `x-real-ip` / `x-forwarded-host`
and uses the socket address (the proxy's) and `Host` (the backend's own). CSRF failures with
`request origin is not allowed` usually mean the app host is missing from `FRONTEND_ORIGINS`
or the proxy is not forwarding `x-forwarded-host`.

## 8. Post-deploy smoke test

Against a freshly booted instance (replace the host; through the Vercel proxy prefix the paths
with `/__backend`):

```bash
curl -s localhost:8091/health                  # 200 { status: "ok", env, network, ts }
curl -s localhost:8091/health/ready            # 200 { checks: { postgres, redis, nats } } — 503 names the failing one
curl -s localhost:8091/api/v1/me               # 401 { error: "unauthenticated" }
curl -s -X POST -H 'Origin: http://localhost:8091' -H 'Content-Type: application/json' \
  -d '{"partyId":"<operator party>"}' localhost:8091/api/v1/auth/admin/challenge   # 200 { challengeId, message, expiresAt }
curl -s -X POST -H 'Content-Type: application/json' -d '{}' localhost:8091/api/v1/auth/admin/challenge   # 403 csrf_rejected (no Origin)
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8091/api/v1/auth/wallet   # 404 — wallet sign-in no longer exists
curl -s localhost:8091/api/v1/nope             # 404 { error: "not_found" } — never Express's HTML page
```

Every response is the JSON envelope and carries `x-request-id`; `Cache-Control: no-store` is
set on errors. A boot that never reaches `listening on` exits 1 with the refusal in the log (§1).

### 8.1 Through the relay (end-to-end)

The full account flow, as the browser exercises it, goes through
`truthoracle-canton/api/proxy/backend.mjs` (ARCHITECTURE §4.1). Locally: start the backend with
`FRONTEND_ORIGINS=http://127.0.0.1:5199` and a `BACKEND_PROXY_SECRET`, then in
`truthoracle-canton` run `BACKEND_URL=http://127.0.0.1:8091 BACKEND_PROXY_SECRET=<same>
BROWSER=none npx vite --host 127.0.0.1 --port 5199 --strictPort` (without `--host` Vite 5 binds
`[::1]` only on current Node, so `127.0.0.1:5199` refuses connections while the log says
"ready"). Every non-GET carries `Origin: http://127.0.0.1:5199`, `Content-Type:
application/json` and `x-requested-with: truthoracle`; the client keeps a cookie jar. Expected
answers, in order (`R` = `http://127.0.0.1:5199/__backend`):

| Step | Expect |
|---|---|
| `GET R/health`, `GET R/health/ready` | 200, `checks` all `ok` |
| Sign in with Google or Telegram in the browser (the only user sign-ins, §6.1) | 200 `mode: login, created: true, kind: user`; `Set-Cookie: to_session=…; Path=/; HttpOnly; SameSite=Lax` relayed (no `Domain=`; `Secure` outside dev) |
| `POST R/api/v1/wallets/link-challenge { partyId }` | 200; message starts `TruthOracle link-wallet` and has `Domain: 127.0.0.1:5199` (the app host, not the backend's) |
| `POST R/api/v1/wallets/link { challengeId, partyId, publicKey, signature, kind }` | 200 `{ wallet }` — the first wallet is primary and sets `users.party_id`; no identity is created |
| `GET R/api/v1/auth/session` · `GET R/api/v1/me` | `authenticated: true`; one primary wallet, `kyc.status: none` |
| `GET R/api/v1/kyc` → `POST R/api/v1/kyc/sessions` → `POST R/api/v1/kyc/mock/submit` (approved, one PASSPORT) → `GET R/api/v1/kyc` | `none` → `{ provider: mock, verificationId }` → `approved` → `approved`, `attachedIdentityId` set |
| `POST R/api/v1/wallets/link-challenge` + `POST R/api/v1/wallets/link` (second key) → `GET R/api/v1/me` | 200 `isPrimary: false`; two wallets, still ONE identity (the sign-in method), which is `kycLocked: true` |
| `POST R/api/v1/in-app-wallet/deposits/reconcile` | 200 when the treasury is reachable; `502 upstream_failed` ("wallet history read failed") when it is not — never a 500 |
| `GET R/api/v1/me/sessions` → `POST R/api/v1/auth/logout` → `GET R/api/v1/me` | one session `current: true` → `{ ok: true }` with the cleared cookie relayed → 401 |
| `POST` without `Origin` | `403 csrf_rejected` |
| `GET R/api/docs` | `404 { error: "path not proxied" }` — answered by the relay, Swagger never crosses it |
| `GET http://127.0.0.1:8091/api/v1/nope` (direct) | `404 not_found` envelope with `x-request-id` |

Boot-refusal spot checks (each exits 1 in under a second, nothing listens): `KYC_PROVIDER=mock
APP_NETWORK=mainnet` (also lists the missing `ZKPC_*`), `SESSION_SECRET=short`,
`COOKIE_DOMAIN=example.com` with a `BACKEND_PROXY_SECRET`.

## 9. Upstream outages (ledger, Enterprise Wallet, Keycloak)

The backend never contacts the ledger, the Enterprise Wallet or Keycloak at boot, and
`/health/ready` does not include them: an outage there degrades specific routes, never the
process. What each route does when `fetch` fails or Keycloak refuses the client credentials:

| Route | Behaviour |
|---|---|
| `POST /wallets/link` (first-time or relink), Google/Telegram sign-ins, `POST /auth/admin` | unaffected — linking never reads the ledger (ARCHITECTURE §8.1), so a first-time link succeeds while the ledger is down |
| `GET /me`, `GET /wallets`, `GET /in-app-wallet` | 200 with `ownLedgerWallet: null` / `ledger: null` (degraded reads are logged, not surfaced) |
| `POST /in-app-wallet/deposits/reconcile` | `502 upstream_failed`; nothing is written (the history walk precedes the write-ahead row) |
| `POST /in-app-wallet/payouts/:cid/settle`, admin settle, processor scan | `502 upstream_failed` (user/admin) or a logged warning (scan); a row that already recorded a submission stays `settling` — fail closed, never re-transferred (ARCHITECTURE §9.4) |
| `GET /kyc`, `POST /kyc/sessions`, `POST /kyc/mock/submit`, webhooks | unaffected (no ledger involvement) |

## 10. Payout rows in `failed`

After `PAYOUT_MAX_ATTEMPTS` (default 5) settling attempts a `to_payouts` row becomes `failed`
(audit `payout.failed`, NATS `truthoracle.payout.failed`). From then on the user's retry answers
`409 payout_blocked { details.status: "failed" }` without touching the row or its `attempts`,
and the scan skips it. Only `POST /admin/payouts/:cid/settle` resumes it: the recorded
`transfer_command_id` / `settle_command_id` is checked against the wallet before anything is
re-sent (a submission the wallet already knows resumes at `MarkPaid`; an unknown one is retried;
an unreadable status keeps the row `settling`). `GET /admin/payouts?status=failed` lists the
queue.

## 11. Unlink refusals, in order

Identities and wallets are unlinked by different routes with different rules, because a wallet
is not a sign-in method (ARCHITECTURE §8.1).

- `DELETE /me/identities/:id` and the admin unlink go through `IdentityService.unlink`, which
  refuses `409 identity_locked_by_kyc` first (users only — the identity that started the standing
  KYC approval, §6.5; operators skip this), then `409 last_identity` (§6.3). An account whose
  only sign-in method started an approved verification therefore sees `identity_locked_by_kyc`.
- `DELETE /wallets/:id` refuses only `409 primary_wallet_in_use` (the wallet `users.party_id`
  points at, §8.2; make another wallet primary first, possible only while no on-ledger
  `UserWallet` or queued payout exists). Unlinking any other wallet always succeeds: it revokes
  the row, keeps its attribution, and never touches how the person signs in.

## 12. Ledger indexer (docs/INDEXER.md)

**First run on a participant.** Watch the log of the replica that logs `holding the indexer lock`:
`bootstrap: replaying the full ledger history from offset 0` (never-pruned) or `bootstrap: ACS
snapshot at offset N` (pruned), then `applied K transaction(s)` lines until `GET /ledger/status`
reports `lag: 0`. Compare `to_markets` with `npm run contracts:active PredictionMarket` in
`truthoracle-contracts` — the contract ids and `currentPrice` must match exactly. The JSON shapes
were taken from the Canton 3.4 OpenAPI spec and the production tree reader, not from a recorded
response: an unexpected shape shows up as markets with zero fields or missing trades, never as a
crash (`src/util/ledger-values.ts` fails soft) — `GET /admin/ledger/events?updateId=` shows the
raw payloads to compare against.

**`lastError` set / `lag` growing.** The processor retries with backoff (1 s … 60 s) and reports
the first and every tenth failure to Sentry. `ledger updates failed (401)`: the ledger Keycloak
client (RUNBOOK §1). `filled INDEXER_ACS_LIMIT`: raise the limit and the participant's
`http-list-max-elements-limit`. `/v2/updates answered 404`: the participant predates the
endpoint; `INDEXER_UPDATES_ENDPOINT=auto` already fell back to `/v2/updates/trees`.

**A gap appeared** (`gaps` in `GET /ledger/status`, `truthoracle.indexer.gap`, Sentry warning):
the index was down longer than the participant's retention and resynced from the ACS. State is
correct; activity inside the range is missing for good. Note the range in the incident log; if
the outage was a deploy, size the retention or the deploy window accordingly.

**Rebuild.** `INDEXER_ENABLED=false` on every replica, then
`TRUNCATE to_indexer_state, to_ledger_events, to_markets, to_market_snapshots, to_market_events,
to_positions, to_liquidity_positions, to_ledger_wallets, to_wallet_entries, to_ledger_payouts,
to_attestations, to_model_forecasts, to_prediction_models, to_ledger_transfers`, then
`INDEXER_ENABLED=true`. Required after switching participants (offsets are participant-local) or
after a projection fix. The account tables are never touched.

**Operator resync.** `POST /admin/ledger/resync { reason }` re-snapshots the ACS at the ledger end
and reconciles activeness (audited as `ledger.resync`). Use it after a manual ledger repair; it is
not a rebuild.

## 13. Markets: catalog, candles, trading halt (docs/MARKETS.md)

- **Halt trading** (participant maintenance, a market under investigation): `POST /admin/exchange/halt
  { active: true, reason, estimatedResumeAt? }` with an operator session. The UI shows the reason,
  disables the trade controls and `orders/prepare` answers `409 trading_halted` (redemptions stay
  available). Resume with `{ active: false, reason }`. Audited as `exchange.halt_changed`; the
  state lives in `to_settings.exchange_halt` only while active.
- **Create a market inside an event**: create the series (`POST /admin/series`) and the event
  (`POST /admin/events`) once, then `POST /admin/markets { eventTicker, ticker, question, … }`.
  The route needs the `MarketCounter` indexed (`503 not_ready` otherwise) and a participant
  running truthoracle-v14 ≥ 1.1.0 (a 1.0.0 package rejects the identity fields as
  `502 upstream_failed`). The market is readable once the indexer applies the transaction.
- **Markets created before 1.1.0** carry the synthetic ticker `MKT-<id>`: assign their event,
  ticker and side labels with `PATCH /admin/markets/:id/catalog`. A field the ledger fixed answers
  `409 ledger_value_fixed`.
- **Candles look wrong after a projection fix**: candles and open interest are derived in the
  indexer's transaction; rebuild the index from scratch (§ "Rebuild from scratch" in
  docs/INDEXER.md §9) — export the catalog assignments on `to_markets` first if any exist
  (`SELECT market_id, ticker, event_ticker, yes_sub_title, no_sub_title FROM to_markets WHERE
  ticker_source = 'catalog' OR event_ticker_source = 'catalog'`) and re-apply them afterwards.
- **`GET /exchange/status.ledger.stale = true`**: the indexer has not touched its state row for
  `EXCHANGE_STALE_AFTER_SEC`; check `GET /ledger/status.lastError` and the replica that holds
  the lock (`running`).

## 14. Sumsub (docs/KYC.md §5–§6)

- **Is the wiring right?** `npm run kyc:check` on the host, or `GET /admin/kyc/provider` with an
  operator session. `probe OK (HTTP 404)` = app token + signature accepted. `401`: wrong
  `SUMSUB_APP_TOKEN` / `SUMSUB_SECRET_KEY`, or the host clock is more than a minute off UTC.
  `403`: the token lacks *View applicants*. `webhookSecretConfigured: false`: every webhook is
  being answered 401 — set `SUMSUB_WEBHOOK_SECRET` and restart.
- **Webhooks answer 401 `webhook_rejected`.** Almost always the digest algorithm: the dashboard
  webhook must use `HMAC_SHA256_HEX` (or `_SHA512_HEX`); Sumsub's default `HMAC_SHA1_HEX` is
  refused unless `SUMSUB_ALLOW_SHA1=true`. Then the secret, then the URL (the relay forwards
  `x-payload-digest` / `x-payload-digest-alg` and `api/v1/**` only).
- **A review landed on Sumsub but the user still shows `pending`.** `SELECT id, type,
  processed_at, attempts, error FROM to_kyc_webhook_events ORDER BY received_at DESC LIMIT 20`.
  Unprocessed rows are re-published by the sweep; a row the consumer gave up on can be
  replayed with `POST /admin/kyc/webhooks/:id/replay { reason }`. No row at all: resend the
  webhook from the dashboard's webhook manager (idempotent on the body hash).
- **Approved on Sumsub, `needs_review` here.** The applicant re-read had no identity document
  the fingerprints accept (`PASSPORT`, `ID_CARD`, `DRIVERS`, `RESIDENCE_PERMIT`), the review is
  not `completed`, the level differs from `KYC_REQUIRED_LEVEL`, or a sandbox event arrived on
  mainnet. `GET /admin/kyc/needs-review` lists them; an operator override
  (`POST /admin/users/:id/kyc/override`) settles it.
- **Rotating the app token or the webhook secret.** Create the new one in the dashboard, set
  the env, restart, run `npm run kyc:check`, then delete the old one. Webhooks signed with the
  old secret during the switch are rejected and can be resent.
