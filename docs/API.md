# TruthOracle backend — HTTP API contract (v1)

Shared contract between `truthoracle-backend` and the `truthoracle-canton` frontend. Every
route is under `/api/v1` (frontend reaches it as `/__backend/api/v1/...`). Bodies and
responses are JSON. Money is a **string with exactly 10 decimals** (`"12.5000000000"`),
never a number. Timestamps are ISO-8601 strings. Ids are UUIDs unless stated.

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
interface LedgerWallet { contractId: string; owner: string; balanceCC: Money; depositedCC: Money; withdrawnCC: Money }
interface Wallet {
  id: string; chain: "canton"; kind: "cantor8"; partyId: string; label: string | null;
  isPrimary: boolean; status: "active" | "revoked"; verifiedAt: string;
  creditedCC: Money;                        // in-app credits attributed to this wallet (the only attribution — nothing predates the backend)
  receivedCC?: Money;                       // only in GET /in-app-wallet
  ownLedgerWallet: LedgerWallet | null;     // a non-primary party's own on-ledger UserWallet, if any
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
  pendingPayoutCid: string; payeeParty: string; walletId: string | null; amountCC: Money; reason: string;
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
- `GET /in-app-wallet` → `200 { partyId: string | null, ledger: LedgerWallet | null, wallets: Wallet[] (with receivedCC), attribution: { creditedTotalCC: Money, ledgerDepositedCC: Money, delta: Money }, pending: { submitted: number }, payouts: Payout[] }`
  (`delta = ledgerDepositedCC − creditedTotalCC`; anything beyond 1e-9 CC makes the next reconcile answer `409 deposit_attribution_drift`)
- `POST /in-app-wallet/deposits/reconcile` → `200 { credited: Money, status: "confirmed" | "submitted" | "nothing_outstanding", commandId?: string, perWallet: { walletId, partyId, amountCC: Money }[], ledger: LedgerWallet | null }`
  | `409 no_primary_wallet` | `409 deposit_in_progress` | `409 deposit_attribution_drift` (`details: { kind: "over_credit" | "ledger_below_expected" | "ledger_above_expected" | "duplicate_user_wallet", walletId?, amountCC? }`) | `409 kyc_duplicate_identity` | `502 upstream_failed`
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
- `GET /admin/payouts?status=` → `{ items: Payout[] }`
- `POST /admin/payouts/:cid/settle` `{ force?: boolean, reason }` → `{ payout, mode }`
- `GET /admin/audit?subjectType=&subjectId=&actorUserId=&page=` → `{ items: AuditEvent[], page, limit, total }`

```ts
interface AuditEvent { id: string; actorType: "user" | "admin" | "system"; actorUserId: string | null; action: string;
  subjectType: string; subjectId: string; metadata: Record<string, unknown>; createdAt: string }
```
