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
  creditedCC: Money; legacyCreditedCC: Money; receivedCC?: Money;   // receivedCC only in GET /in-app-wallet
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
- `GET /health` → `200 { status: "ok", env, network, ts }`
- `GET /health/ready` → `200 { status: "ok", checks: { postgres: "ok", redis: "ok", nats: "ok" } }` or `503` with the failing check.

## Auth
- `GET /auth/session` → `200 { authenticated: false }` | `200 { authenticated: true, kind, user: User, expiresAt }`
- `POST /auth/google/nonce` → `200 { nonce, expiresAt }`
- `POST /auth/google` `{ credential, nonce?, client?: "web" | "native" }` → `200 LoginResult`
- `POST /auth/telegram/widget` `{ id, first_name, last_name?, username?, photo_url?, auth_date, hash, client? }` → `200 LoginResult`
- `POST /auth/telegram/miniapp` `{ initData, client? }` → `200 LoginResult`
- `GET /auth/telegram/oidc/start?mode=login|link&returnTo=/path` → `302` to Telegram (sets `to_oidc`)
- `GET /auth/telegram/oidc/callback?code&state` → `302` to `<app origin><returnTo>?auth=ok` or `?auth=error&code=<error code>`
- `POST /auth/wallet/challenge` `{ partyId, purpose: "sign-in" | "link-wallet" | "admin-sign-in" }` → `200 { challengeId, message, expiresAt }`
- `POST /auth/wallet` `{ challengeId, partyId, publicKey, signature, kind: "cantor8", client? }` → `200 LoginResult`
- `POST /auth/logout` → `200 { ok: true }` (clears cookie, revokes the session)

```ts
interface LoginResult {
  mode: "login" | "link";                    // link when a session was present
  user: User; kind: "user" | "admin"; expiresAt: string;
  identity: Identity;                        // the identity that authenticated / was linked
  created: boolean;                          // a new account was created
  token?: string;                            // only for client = "native"
}
```
With a session cookie present, the three login routes act in **link mode** (they attach the
identity to the current account and return `mode: "link"`); `/auth/wallet` in link mode
requires a `link-wallet` challenge issued to that session. Signing in with an unlinked
identity returns `403 identity_unlinked`; linking an identity owned by another account
returns `409 identity_already_linked`; a wallet owned by another account `409 wallet_already_linked`.

## Me
- `GET /me` → `200 { user: User, identities: Identity[], wallets: Wallet[], kyc: KycSummary, capabilities: Capabilities }`
- `PATCH /me` `{ displayName?, avatarUrl? }` → `200 { user }`
- `DELETE /me/identities/:id` → `200 { ok: true }` | `409 last_identity` | `409 identity_locked_by_kyc`
- `POST /me/identities/:id/reattach` → `200 { identity }` (only the original owner; requires a fresh proof for that provider: body is the same as the matching login route)
- `GET /me/sessions` → `200 { sessions: Session[] }`
- `DELETE /me/sessions/:id` → `200 { ok: true }`
- `POST /me/sessions/revoke-others` → `200 { revoked: number }`
- `GET /me/audit?page=` → `200 { items: AuditEvent[], page, limit, total }`

## Wallets
- `GET /wallets` → `200 { wallets: Wallet[] }`
- `POST /wallets/link-challenge` `{ partyId }` → `200 { challengeId, message, expiresAt }`
- `POST /wallets/link` `{ challengeId, partyId, publicKey, signature, kind: "cantor8", label? }` → `200 { wallet: Wallet, identity: Identity, seededLegacyCreditedCC: Money }`
- `DELETE /wallets/:id` → `200 { ok: true }` | `409 primary_wallet_in_use` | `409 last_identity` | `409 identity_locked_by_kyc`
- `POST /wallets/:id/primary` → `200 { wallet }` | `409 primary_wallet_in_use`

## In-app wallet
- `GET /in-app-wallet` → `200 { partyId: string | null, ledger: LedgerWallet | null, wallets: Wallet[] (with receivedCC), attribution: { legacyPrimaryCC: Money, creditedTotalCC: Money, ledgerDepositedCC: Money, delta: Money }, pending: { submitted: number }, payouts: Payout[] }`
- `POST /in-app-wallet/deposits/reconcile` → `200 { credited: Money, status: "confirmed" | "submitted" | "nothing_outstanding", commandId?: string, perWallet: { walletId, partyId, amountCC: Money }[], ledger: LedgerWallet | null }`
  | `409 no_primary_wallet` | `409 deposit_in_progress` | `409 deposit_attribution_drift` | `409 kyc_duplicate_identity`
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
