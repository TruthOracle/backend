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
| `AuthorizationError: Authorization Violation` (NATS) | the NATS server requires auth and `NATS_URL` carries none, or the wrong one | put it in the URL: `nats://<token>@host:4222` for a token (Railway's NATS), `nats://<user>:<pass>@host:4222` for a user; percent-encode reserved characters |
| `SESSION_SECRET / KYC_FINGERPRINT_PEPPER must be at least 32 characters` | short secret | `openssl rand -hex 32` |
| `BACKEND_PROXY_SECRET must be at least 32 characters when set` | short proxy secret | same value on both sides (`pm-frontend` `BACKEND_PROXY_SECRET`) |
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

## 3. Daml package (truthoracle-v17) and deposit drift

The backend is built against **truthoracle-v17 1.0.0**
(`TRUTHORACLE_PACKAGE_ID=<package id printed by npm run dars:upload in truthoracle-contracts>`,
`TRUTHORACLE_PACKAGE_NAME=truthoracle-v17`), a fresh lineage deployed from scratch (docs/TOKENS.md):
every `UserWallet` carries its `instrument : InstrumentId` (one wallet per party and token) and
`creditRefs : [Text]` (mandatory; the deposit and grant confirm passes' only confirmation rule),
every `PredictionMarket` its `collateral` and its identity (`ticker`, `eventTicker`, the side
labels). There is no Daml feature flag and no upgrade path from an older package (ARCHITECTURE
§18); a v17 deployment starts with an empty index and a fresh database.

- `502 upstream_failed "ledger returned a UserWallet without creditRefs / instrument"` on any
  money route, with `UserWallet <cid> (owner …): … is missing; is TRUTHORACLE_PACKAGE_ID the
  deployed truthoracle-v17?` in the log: the configured package id / name does not match what is
  deployed. Fix the env; nothing was written. The indexer stops on the same mismatch
  (`to_indexer_state.last_error` names the contract that carried no instrument).
- `409 deposit_attribution_drift` (audit `deposit.attribution_drift`, Sentry, NATS
  `truthoracle.deposit.drift`): the primary's on-ledger `deposited` in the instrument differs from
  `Σ to_wallet_credits.credited` for that instrument by more than 1e-9 units in **either** direction
  (`details.kind = ledger_below_expected | ledger_above_expected`), a wallet is attributed more
  than it ever sent (`over_credit`), or the owner has two active `UserWallet`s
  (`duplicate_user_wallet`). Nothing is credited and the backend never repairs this on its
  own — every credit the wallet ever received went through this backend, so a surplus is as
  suspicious as a shortfall. Compare the instrument's `GET /in-app-wallet.balances[].attribution`
  with the ledger contract, find the command that moved `deposited` (its `txRef` is in
  `creditRefs`), and correct `to_wallet_credits.credited` deliberately (audited SQL) once the
  cause is understood.
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
`pm-frontend/api/proxy/backend.mjs` (ARCHITECTURE §4.1). Locally: start the backend with
`FRONTEND_ORIGINS=http://127.0.0.1:5199` and a `BACKEND_PROXY_SECRET`, then in
`pm-frontend` run `BACKEND_URL=http://127.0.0.1:8091 BACKEND_PROXY_SECRET=<same>
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
| `POST R/api/v1/in-app-wallet/deposits/reconcile` | 200 when the ledger is reachable and the index is at its end; `503 ledger_stale` while the index lags (§15); `502 upstream_failed` when the ledger is down — never a 500 |
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
| `GET /me`, `GET /wallets`, `GET /in-app-wallet` | 200 with `ownLedgerWallets: []` / `balances[].ledger: null` (degraded reads are logged, not surfaced) |
| `POST /in-app-wallet/deposits/reconcile` | `503 ledger_stale` when the ledger end cannot be read (nothing can vouch for the index), `502 upstream_failed` when the UserWallet read fails; nothing is written (both precede the write-ahead row) |
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
`http-list-max-elements-limit`. `ledger updates failed (400)` naming an `InterfaceFilter` or an
interface id: the participant does not have the splice token-standard API packages vetted
(docs/TOKENS.md §1 lists them) — upload / vet them, the filter names them by package name. A
growing lag also turns every deposit reconcile into `503 ledger_stale` once it exceeds
`LEDGER_FRESH_OFFSETS` (§15).

**A gap appeared** (`gaps` in `GET /ledger/status`, `truthoracle.indexer.gap`, Sentry warning):
the index was down longer than the participant's retention and resynced from the ACS. State is
correct; activity inside the range is missing for good. Note the range in the incident log; if
the outage was a deploy, size the retention or the deploy window accordingly.

**Rebuild.** `INDEXER_ENABLED=false` on every replica, then
`TRUNCATE to_indexer_state, to_ledger_events, to_markets, to_market_snapshots, to_market_events,
to_positions, to_liquidity_positions, to_ledger_wallets, to_wallet_entries, to_ledger_payouts,
to_attestations, to_model_forecasts, to_prediction_models, to_ledger_transfers,
to_ledger_holdings, to_ledger_transfer_instructions`, then `INDEXER_ENABLED=true`. Required
after switching participants (offsets are participant-local) or after a projection fix. The
account tables are never touched; deposits answer `503 ledger_stale` until the rebuilt index is
back at the ledger end, and registry-mode payouts `409 insufficient_treasury_holdings` until the
treasury's holdings are indexed again.

**Operator resync.** `POST /admin/ledger/resync { reason }` re-snapshots the ACS at the ledger end
and reconciles activeness (audited as `ledger.resync`). Use it after a manual ledger repair; it is
not a rebuild.

## 13. Markets: catalog, candles, trading halt (docs/MARKETS.md)

- **Demo data for local UI work**: `npm run seed:dev` writes a demo catalog straight into the
  index of `DATABASE_URL` — series `DEMO-FED` / `DEMO-EPL` / `DEMO-BTC`, three events, seven
  markets (negative `market_id`s, `demo-` contract ids, `DEMO-` tickers), thirty days of candles
  from a seeded random walk and a matching trade feed — so charts, cards and feeds have something
  to draw. It refuses outside `APP_ENV=dev`, never touches the test database, replaces its own
  rows when re-run, and `npm run seed:dev -- --clear` removes exactly them. The rows are local
  only: nothing is on the ledger, so trading on a demo market fails at `orders/prepare`, and a
  rebuild of the index does not bring them back. Run it while the dev server is up (it uses
  ts-node, so `dist/` is left alone).

- **Halt trading** (participant maintenance, a market under investigation): `POST /admin/exchange/halt
  { active: true, reason, estimatedResumeAt? }` with an operator session. The UI shows the reason,
  disables the trade controls and `orders/prepare` answers `409 trading_halted` (redemptions stay
  available). Resume with `{ active: false, reason }`. Audited as `exchange.halt_changed`; the
  state lives in `to_settings.exchange_halt` only while active.
- **Create a market inside an event**: create the series (`POST /admin/series`) and the event
  (`POST /admin/events`) once, then `POST /admin/markets { eventTicker, ticker, question, … }`.
  The route needs the `MarketCounter` indexed (`503 not_ready` otherwise); `ticker` and
  `eventTicker` are required, `yesSubTitle` / `noSubTitle` default to `Yes` / `No`. The market
  is readable once the indexer applies the transaction.
- **An event you never created shows up** (title = its ticker, series = the ticker's first
  segment): a market named it on-ledger before the catalog had it (created from the frontend's
  admin console, or the event row was never written) and the projection created a placeholder.
  Fill it in with `PATCH /admin/events/:ticker` (title, `seriesTicker`, strike, …) and the
  series with `PATCH /admin/series/:ticker`; `POST` answers `409 catalog_conflict` for a ticker
  that already exists. A market's own identity has no operator route — it is the contract's.
- **Two markets with the same ticker** (`… on-ledger ticker X is already used by market N` at
  error level): the later one is indexed as `X~<marketId>`. Void or archive the duplicate
  on-ledger; the index never edits identity.
- **Candles look wrong after a projection fix**: candles and open interest are derived in the
  indexer's transaction; rebuild the index from scratch (§ "Rebuild from scratch" in
  docs/INDEXER.md §9). A market's identity is re-read from the ledger, and placeholder catalog
  rows are re-created where the operator never wrote the event; operator-written series and
  events are not ledger data and survive the rebuild.
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

## 15. Tokens: `ledger_stale`, treasury transfers, two-step offers, instrument setup (docs/TOKENS.md §4.2–§4.4)

**`503 ledger_stale` on the deposit reconcile.** The reconcile credits what the ledger INDEX shows
the user's parties sent the treasury, so it refuses while `to_indexer_state.offset` is more than
`LEDGER_FRESH_OFFSETS` (default 50) behind the ledger end read live from the participant
(`details: { offset, ledgerEnd, lag, maxLag }`). The frontend retries inside its window; a lag that
does not close is an indexer problem (§12: `GET /ledger/status`, `lastError`, the lock holder's
log). The same answer without a lag means no participant is configured to check against
(`LEDGER_API_URL` / Keycloak, §1) or the ledger-end read failed (§9). Never raise
`LEDGER_FRESH_OFFSETS` to make the error go away: a deposit that landed inside the gap would be
credited late, not lost, but a deposit the index has not seen can also not be refunded if the
reconcile credits something else meanwhile.

**Treasury holdings vs. the Enterprise Wallet.** `GET /admin/ledger/holdings?active=true` lists
the treasury's token-standard holdings as the index saw them (any instrument whose `Holding`
implements the standard — Canton Coin included). On the first run against a participant compare
the per-instrument sum with `GET /api/v1/accounts/{treasury}/balance` on the Enterprise Wallet;
a difference means a token whose holdings do not carry the interface view (not a CIP-56 token,
cannot be paid out in registry mode) or an index gap (§12).

**`409 insufficient_treasury_holdings` on a payout.** A registry-mode settlement
(`to_instruments.transfer_mode = registry`, else `TREASURY_TRANSFER_MODE`) spends the treasury's
unlocked indexed holdings of the instrument, largest first; when they do not cover the amount the
row stays `settling` with the error and the scan retries. Causes, in order: the index lags (§12),
the holdings are locked by open two-step transfers (`locked`, `lockExpiresAt` on the holding), or
the treasury really is short — top it up (token-app mint, docs/TOKENS.md §4.7, or a transfer from
the issuer). Switching the instrument to `transfer_mode = wallet` (`PATCH /admin/instruments`)
makes the Enterprise Wallet pick the inputs instead; the mode a transfer was sent with is recorded
on the row (`details.transferMode`) and decides which status index a retry consults.

**Two-step offers (`TransferInstruction`).** `GET /admin/ledger/transfer-instructions?status=pending`
lists the offers the treasury has not accepted. The acceptor (`ACCEPTOR_SCAN_MS`, 0 = off) accepts
those in known, enabled instruments through the instrument's registry (`registry_url`,
`registry_auth`); an offer in an unknown or disabled instrument is logged once
(`TransferInstruction … left pending`) and waits for an operator to register / enable the token
(`POST` / `PATCH /admin/instruments`) — never accept a token nobody vetted. An expired offer
(`executeBefore` passed) is skipped; the sender withdraws it. A registry that answers 403 (Cantor8
has not granted the client, docs/TOKENS.md §9) fails the accept with `registry … failed (403)` in the
log and leaves the offer pending for the next scan. Rejections are never automatic: an operator
who wants an offer refused does it in the Cantor8 wallet.

**Instrument setup (`POST /admin/instruments/:admin/:id/setup`).** Once per Cantor8 token: the
`AutoAccept` (incoming transfers land without the two-step accept) and the `MintDelegation`
(token-app may mint to the treasury) are created on the token's factory, which the registry names
and discloses for a self-transfer of 0. `503 not_ready` = no `registryUrl` on the instrument;
`502 upstream_failed` naming the registry = it refused the client or does not serve the
transfer-factory lookup; `502 upstream_failed` naming the wallet on a repeat = the deterministic
command id (`setup-<kind>-…`) collided on dedup because the action already landed. The choice
names are per token package (`setupChoices` on the instrument, defaults `CreateAutoAccept` /
`CreateMintDelegation`); audited `token.setup`. Not applicable to Canton Coin.

## 16. Rewards (TRO) and token operations (docs/TOKENS.md §4.6–§4.7)

**Nothing is granted.** `RewardsProcessor` runs only with `REWARDS_ENABLED=true` AND a rewards
instrument (`REWARDS_INSTRUMENT_ADMIN`); the boot log says `rewards processor off` / `idle`
otherwise. The three rules are seeded at the first boot **disabled** everywhere but `APP_ENV=dev`:
`GET /admin/rewards/rules`, then `PUT /admin/rewards/rules/:id { enabled: true, reason }` — and
check the `params` before switching one on (`perUnit` is TRO per unit of the default collateral,
`fraction` a share of the redeemed payout, `amount` a flat TRO figure; decimal strings). Rules
apply to activity indexed AFTER they are enabled: the cursor (`to_settings.rewards_cursor`)
advances whether or not a rule is on, so enabling one is never retroactive. Only markets in the
default collateral earn (a rebate priced in one token cannot apply to trades in another), and an
acting party nobody linked earns nothing — the account is resolved through `to_wallets`.

**`blocked_float` grants (`GET /admin/rewards/grants?status=blocked_float`).** The float rule
refused to submit: the treasury's indexed TRO holdings do not cover Σ indexed in-app TRO balances
+ the grants in flight + this one (`GET /admin/rewards/float` shows the four figures; `error` on
the row carries the shortfall). The first block of a grant is audited `reward.blocked_float`,
raises a Sentry warning and publishes `truthoracle.reward.blocked_float`; the pass retries every
`REWARDS_SCAN_MS`. Fix the float, not the rule: mint TRO to the treasury (`POST /admin/tokens/mint
{ instrument: TRO, amount, reason }`, or let `REWARDS_AUTO_MINT=true` — DevNet only — mint
`max(shortfall, REWARDS_MINT_MIN)` once per grant under `reward-float-<grantId>`; the row's
`error` records the mint it sent). A grant stays blocked after the mint until the indexer has seen
the new holding; a lag that does not close is §12. Grants are also held while the index is stale
(`skipped: ledger_stale` in the pass log) — no grant is submitted on figures that may be missing a
balance.

**`failed` grants.** The ledger refused the `Grant` five times (a stale wallet contract id is the
usual transient cause and is retried automatically with a fresh `reward-grant-<id>-<attempt>`;
five refusals in a row mean something structural — the wallet gone, the package wrong). The row
keeps the last error; audited `reward.failed`. There is no automatic retry past this point: fix
the cause and grant manually (`POST /admin/rewards/grant`), or leave it. Never edit the row's
status by hand to `queued` while a command of it may still be in flight — the ref is the only
thing stopping a double credit, and the confirm pass needs the row to be `submitted` to see it.

**Manual grants** (`POST /admin/rewards/grant { userId | party, amount, reason }`) are written
`queued` and submitted on the next pass (`GET /admin/rewards/grants` follows them); a grant by
`party` to someone who has not linked that party is allowed and credits their on-ledger TRO wallet
(created on demand) — they see it under `GET /me/rewards` once they link. Amounts must be whole in
the token's decimals (`400 validation_failed`).

**Mint / burn (`POST /admin/tokens/mint|burn`).** `503 token_app_unconfigured` = `TOKEN_APP_URL`
(or its Keycloak client) is blank — nothing was written; `502 upstream_failed` = token-app refused
or is down (its status in `details.upstreamStatus`) — nothing was minted. Every accepted mint /
burn is audited (`token.mint` / `token.burn` with the token-app command id) and announced; a repeat
of the request IS a second mint (`mint-<24 hex>` is fresh per request). `GET /admin/tokens/status`
puts token-app's own `/status` (`reachable: false` when it is down, never an error) next to the
index's `treasuryHoldings` / `liabilities` per instrument; a mint that landed shows up in
`treasuryHoldings` once indexed (§12 if it does not).

**Mint-and-credit (`creditUserId`).** The account's wallet in the instrument is created BEFORE the
mint, so the only step that can fail after tokens were minted is the `Deposit` credit itself, and
that runs through the deposit write-ahead row (`to_deposit_credits`, `tx_ref = mint:<commandId>`,
ARCHITECTURE §8.3): `credit.status = submitted` in the answer means the ledger has not shown it
yet and the DepositConfirmProcessor finishes it (or marks it `failed` after
`DEPOSIT_CONFIRM_GRACE_MS` when the wallet reports the command failed); `409 deposit_in_progress`
with `details.mint` means another credit of that account was in flight — the tokens ARE on the
treasury, retry the credit once that credit confirmed (a request with the same `mintCommandId`
through `DepositService.creditMint` lands on the same row; there is no route for it yet, see
docs/TOKENS.md §10). A confirmed mint credit counts as "received" for the account's next
reconcile in that instrument, so it never reads as an over-credit.

**Schema note.** `to_reward_grants.submitted_at` and the removal of the rules seed landed in the
`Instruments` migration (fresh deploy, no upgrade path): a database migrated from an earlier
working copy of that migration must run `npm run migration:revert` and `npm run migration:run`
(the e2e harness runs against a database created from scratch; CI does run / revert / run).

## 17. Fiat ramp — card on-ramp and cash-out (docs/RAMP.md)

**Turning it on.** `RAMP_ENABLED=false` until the acquirer adapter exists, token-app answers for
the ramp instrument and the treasury holds its MintDelegation (docs/TOKENS.md §9). The boot
refuses the mock acquirer with `RAMP_ENABLED` in prod or on mainnet. The kill switch stops new
orders only; in-flight orders keep advancing, because they already hold someone's money.

**The queue.** `GET /admin/ramp/orders?status=needs_review`: `reviewStep` and `lastError` say why
the order stopped. `retry` resumes the step under the same idempotency keys (at the payment step
it approves the capture, and only for the exact amount); `refund` returns the card money (on-ramp,
nothing minted) or re-mints and credits back (cash-out after the burn, payout failed); `fail`
closes an on-ramp whose payment was never captured. Each needs a `reason`.

**token-app down.** On-ramps wait in `paid` / `minting`, cash-outs in `burning`; nothing is lost
and the processor resumes. A mint token-app has not recorded after 10 minutes is re-sent under the
SAME command id (`ramp-mint-<h>`); `RAMP_MAX_ATTEMPTS` failures send the order to review. A
chargeback that lands while an order is `minting` / `crediting` can leave its mint on the treasury
(or its credit in-app): the reconciliation's float shows the surplus; burn it with
`POST /admin/tokens/burn` once the case is reviewed.

**Chargeback.** The account is suspended (sessions revoked, withdrawals blocked), the card blocked,
`chargeback_receivable` booked, Sentry warned. Recovering the value from the in-app balance needs
the user's signature today (UserWallet has no operator debit).

**Daily.** `GET /admin/ramp/reconciliation` must be all-green. A red `journal_balanced`,
`token_app_matches_orders` or `treasury_covers_in_app_balances` is an incident: set
`RAMP_ENABLED=false` until it is explained.
