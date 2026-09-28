# Internal seams — file, class and method contract for parallel implementation

This is the naming contract every work package codes against. Barrels are pre-populated
with these exports, so a package must create exactly these files and classes. Behaviour is
specified in ARCHITECTURE.md (v2) and the HTTP shapes in API.md; this file only pins the
internal surface that other packages call.

## Ownership map

| Package | Owns (creates/edits) |
|---|---|
| **F — foundation** | `src/config.ts`, `src/types.ts`, `src/main.ts`, `src/app.module.ts`, `src/data-source.ts`, `src/entities/*`, `src/migrations/*`, `src/util/*`, `src/auth/*`, `src/dto/common.dto.ts`, services: `redis`, `nats`, `sentry`, `keycloak-token`, `ledger-client`, `enterprise-wallet`, `rate-limit`, `audit`, `session`, `user`, `identity`, `wallet-challenge`; processors: `session-cleanup`; all three barrels (`controllers/index.ts`, `services/index.ts`, `processors/index.ts`, pre-populated); `test/helpers/*`, `test/jest-e2e.json`, `jest.config.ts`; `README.md`, `docs/RUNBOOK.md` skeleton |
| **P1 — auth + me** | services `google-auth`, `telegram-auth`, `login`; controllers `auth`, `me`; `src/dto/auth.dto.ts`, `src/dto/me.dto.ts`; specs + `test/auth.e2e-spec.ts` |
| **P2 — wallets + deposits** | services `wallet-link`, `deposit`; controllers `wallets`, `in-app-wallet`; processor `deposit-confirm`; `src/dto/wallets.dto.ts`; specs + `test/wallets.e2e-spec.ts` |
| **P3 — payouts** | service `payout`; controller `payouts`; processor `payout-settlement`; `src/dto/payouts.dto.ts`; specs + `test/payouts.e2e-spec.ts` |
| **P4 — KYC** | services `kyc`, `kyc-provider-mock`, `kyc-provider-sumsub`; controllers `kyc`, `kyc-mock` (not in the barrel), `webhooks`; processor `kyc-webhook`; `src/dto/kyc.dto.ts`; `docs/KYC.md`; specs + `test/kyc.e2e-spec.ts` |
| **P5 — admin** | service `admin`; controller `admin`; `src/dto/admin.dto.ts`; specs + `test/admin.e2e-spec.ts` |
| **P6 — ledger index** (docs/INDEXER.md) | `src/indexer/*` (pure: `events`, `splice`, `projection`), `src/util/ledger-values.ts`, `src/util/ledger-offset.interceptor.ts`; services `ledger-stream`, `indexer`, `markets`, `portfolio`; processor `ledger-indexer`; controllers `markets`, `ledger`, `portfolio`, `ledger-wallet`, `admin-ledger`; `src/dto/ledger.dto.ts`; 14 entities + migration `LedgerIndex`; `test/helpers/ledger-fixtures.ts`, `FakeLedgerStream`; specs + `test/ledger.e2e-spec.ts` |

Nobody edits another package's files. Barrels are written once by F and not touched again
(F lists every class below; a package that needs an extra injectable keeps it private to its
own file or asks the integrator).

## Files and classes

```
src/services/app.service.ts                 AppService
src/services/redis.service.ts               RedisService
src/services/nats.service.ts                NatsService
src/services/sentry.service.ts              SentryService
src/services/keycloak-token.service.ts      KeycloakTokenService
src/services/ledger-client.service.ts       LedgerClientService
src/services/enterprise-wallet.service.ts   EnterpriseWalletService
src/services/rate-limit.service.ts          RateLimitService
src/services/audit.service.ts               AuditService
src/services/session.service.ts             SessionService
src/services/user.service.ts                UserService
src/services/identity.service.ts            IdentityService
src/services/wallet-challenge.service.ts    WalletChallengeService
src/services/google-auth.service.ts         GoogleAuthService            (P1)
src/services/telegram-auth.service.ts       TelegramAuthService          (P1)
src/services/login.service.ts               LoginService                 (P1)
src/services/wallet-link.service.ts         WalletLinkService            (P2)
src/services/deposit.service.ts             DepositService               (P2)
src/services/payout.service.ts              PayoutService                (P3)
src/services/kyc.service.ts                 KycService                   (P4)
src/services/kyc-provider-mock.service.ts   KycProviderMockService       (P4)
src/services/kyc-provider-sumsub.service.ts KycProviderSumsubService     (P4)
src/services/admin.service.ts               AdminService                 (P5)

src/controllers/app.controller.ts           AppController
src/controllers/auth.controller.ts          AuthController               (P1)  @Controller("auth")
src/controllers/me.controller.ts            MeController                 (P1)  @Controller("me")
src/controllers/wallets.controller.ts       WalletsController            (P2)  @Controller("wallets")
src/controllers/in-app-wallet.controller.ts InAppWalletController        (P2)  @Controller("in-app-wallet")  GET /, POST deposits/reconcile
src/controllers/payouts.controller.ts       PayoutsController            (P3)  @Controller("in-app-wallet/payouts")
src/controllers/kyc.controller.ts           KycController                (P4)  @Controller("kyc")
src/controllers/kyc-mock.controller.ts      KycMockController            (P4)  @Controller("kyc/mock") — NOT exported from the barrel; app.module registers it only when config.kycProvider === "mock"
src/controllers/webhooks.controller.ts      WebhooksController           (P4)  @Controller("webhooks")
src/controllers/admin.controller.ts         AdminController              (P5)  @Controller("admin")

src/processors/session-cleanup.processor.ts    SessionCleanupProcessor   (F)
src/processors/deposit-confirm.processor.ts    DepositConfirmProcessor   (P2)
src/processors/payout-settlement.processor.ts  PayoutSettlementProcessor (P3)
src/processors/kyc-webhook.processor.ts        KycWebhookProcessor       (P4)

src/entities/*.entity.ts  UserEntity (to_users), AuthIdentityEntity (to_auth_identities), WalletEntity (to_wallets),
  SessionEntity (to_sessions), KycVerificationEntity (to_kyc_verifications), KycPersonEntity (to_kyc_persons),
  KycWebhookEventEntity (to_kyc_webhook_events), PayoutEntity (to_payouts), DepositCreditEntity (to_deposit_credits),
  AuditEventEntity (to_audit_events), SettingEntity (to_settings)   — columns exactly as ARCHITECTURE.md §5
src/migrations/<ts>-Init.ts   the ONE migration: creates everything (CREATE EXTENSION IF NOT EXISTS citext / pgcrypto), seeds to_settings.app_network — greenfield, no upgrade path (ARCHITECTURE §18)

src/auth/session.guard.ts   SessionGuard (global): resolves the session from the to_session cookie or Authorization: Bearer;
                            sets req.session (SessionEntity), req.user (UserEntity), req.authIdentityId; routes marked @Public() pass
                            through unauthenticated (req.user may still be set when a valid session is present — "link mode");
                            suspended/closed users → 403 user_suspended; a kind="admin" session reaches only @Public routes and
                            handlers/controllers marked @AllowAdminSession — everything else → 403 forbidden (§6.9, default deny)
src/auth/admin.guard.ts     AdminGuard: session.kind === "admin" AND the session's identity party ∈ config.adminOperators (re-read
                            per request; pinned key check when configured) else 403 forbidden
src/auth/csrf.guard.ts      CsrfGuard (global, ARCHITECTURE §6.7): non-GET → Origin/Referer allowed AND (json content-type OR
                            x-requested-with: truthoracle); exempt: @Public routes under /webhooks, bearer-authenticated requests
src/auth/decorators.ts      @Public(), @CurrentUser(), @CurrentSession(), @ClientIp(), @RequestHost()
src/auth/request.ts         AuthedRequest type; clientIpOf(req, config); requestHostOf(req, config)   (proxy-secret rules §4.1)
src/util/money.ts           parseCC(input: string | number): bigint; formatCC(units: bigint): string /*10 dp*/; DUST; addCC/subCC/cmpCC; round10FromNumber
src/util/canton-crypto.ts   decodeFixedWidth(value, bytes): Buffer | null; partyFingerprintFromPublicKey(raw: Buffer): string;
                            isValidPartyId(id): boolean; partyNamespace(id): string; publicKeyMatchesParty(pubKey, partyId): boolean;
                            verifyPartySignature({ message, signature, publicKey }): { ok: true; form } | { ok: false; reason }; describeAttempt(...)
src/util/telegram.ts        verifyLoginWidget(payload, botToken, { maxAgeSec, now? }): { ok: true; user; replayKey } | { ok: false; reason }
                            verifyMiniAppInitData(initData, botToken, { maxAgeSec, now? }): same shape; parseWidgetPayload(body)
src/util/cookies.ts         sessionCookie(token, maxAgeMs, config), clearedSessionCookie(config), oidcCookie(...), clearedOidcCookie(...), readCookie(req, name)
src/util/errors.ts          ApiError(status, code, message, details?) ; AllExceptionsFilter (JSON envelope; maps ValidationPipe → 400 validation_failed)
src/util/request-id.ts      requestIdMiddleware
src/util/time.ts            nowMs(), isoNow()
src/types.ts                ErrorCode union, KYC_PROVIDER token (Symbol), KycProvider + KycEvent + ApplicantSummary interfaces,
                            LedgerWallet, PendingPayoutRecord, TransferRow, NatsSubjects const, AuditAction union, Money = bigint alias
src/dto/common.dto.ts       PageQueryDto { page?: number }
```

## Config (class `Config`, camelCase; all parsed + validated in `getConfiguration()`)

`appEnv ('dev'|'staging'|'prod')`, `appNetwork ('devnet'|'mainnet')`, `port`, `logJson`,
`databaseUrl`, `dbMigrateOnBoot`, `dbSsl ('auto'|'true'|'false')`, `redisUrl`, `natsUrl`,
`sessionSecret`, `sessionTtlHours`, `adminSessionTtlHours`, `cookieSecure (boolean, resolved)`,
`cookieDomain`, `frontendOrigins (string[] — exact origins or `https://*.vercel.app` patterns)`,
`backendProxySecret`, `corsOrigins (string[])`, `googleClientIds (string[])`, `googleNonceRequired (boolean, resolved)`,
`telegramBotToken`, `telegramBotUsername`, `telegramAuthMaxAgeSec`, `telegramInitDataMaxAgeSec`,
`telegramOidcClientId`, `telegramOidcClientSecret`, `telegramOidcIssuer`,
`adminOperators (Map<partyId, pinnedPublicKey | "">)`,
`ledgerApiUrl`, `enterpriseWalletUrl`, `treasuryPartyId`, `enterpriseWalletAppName`,
`truthoraclePackageId`, `truthoraclePackageName` (truthoracle-v14 — `UserWallet.depositRefs` is mandatory, no feature flag),
`keycloak: { url, realm, clientId, clientSecret }`, `ledgerKeycloak`, `walletKeycloak` (same shape, optional overrides),
`zkpc: { ledgerApiUrl, keycloakUrl, keycloakRealm, clientId, clientSecret }`,
`kycProvider ('mock'|'sumsub')`, `kycEnforceWithdrawals` (plain flag), `kycRequiredLevel`, `kycFingerprintPepper`, `kycPepperRotationAck`,
`payoutExternalReasons (string[])`, `payoutInappReasons (string[])`, `payoutMaxAttempts`, `payoutScanMs`, `payoutResendGraceMs`,
`sumsub: { baseUrl, appToken, secretKey, webhookSecret, duplicateLabels: string[], allowSha1 }`,
`sessionCleanupMs`, `ledgerCacheMs`, `depositLockTtlMs`, `depositConfirmGraceMs`, `sentryDsn`, `swaggerEnabled (resolved)`.

## Service signatures other packages rely on

```ts
// RedisService
claimOnce(key, ttlMs): Promise<boolean>                        // SET NX PX
hitRateLimit(key, windowMs, max): Promise<{ limited: boolean; count: number; retryAfterMs: number }>
acquireLock(key, ttlMs): Promise<{ acquired: boolean; release(): Promise<void> }>
getJson<T>(key): Promise<T | null>; setJson(key, value, ttlMs?): Promise<void>; del(key): Promise<void>
sadd(key, member): Promise<void>; srem(key, member): Promise<void>; smembers(key): Promise<string[]>
// keys are prefixed `truthoracle:<appNetwork>:` inside the service — callers pass bare keys

// NatsService
publish(subject: NatsSubject, payload: object, opts?: { msgId?: string }): Promise<void>
consume(durable: string, filterSubject: string, handler: (msg: { subject; data: unknown; ack(); nak(delayMs?); term() }) => Promise<void>): Promise<void>  // starts a background loop; idempotent per durable

// KeycloakTokenService
bearerFor(target: "ledger" | "wallet"): Promise<string>       // throws ApiError(502, "upstream_failed") when unmintable

// LedgerClientService (reads as the treasury party; package-name filters)
fetchUserWallet(ownerParty: string): Promise<LedgerWallet | null>     // { contractId, owner, balanceCC: bigint, depositedCC: bigint, withdrawnCC: bigint, depositRefs: string[] }
                                                                      // a payload without depositRefs (wrong package) → ApiError(502, "upstream_failed"), never []
fetchAllUserWallets(): Promise<LedgerWallet[]>
fetchPendingPayouts(): Promise<PendingPayoutRecord[]>                 // { contractId, user, marketId, amountCC: bigint, reason, createdAt }
fetchPendingPayout(cid: string): Promise<PendingPayoutRecord | null>
templateId(entity: string): string

// EnterpriseWalletService
transferHistory(partyId: string, opts?: { uncached?: boolean }): Promise<TransferRow[]>   // paged GET /api/v1/history/{party} (wallet v0.1.35+; a 404 is upstream_failed); Redis cache config.ledgerCacheMs unless uncached
totalReceivedFrom(rows: TransferRow[], partyId: string, counterparty: string): bigint      // fixed point; settled Amulet inbound only
transferStatus(partyId, commandId): Promise<{ known: boolean; submitted: boolean; status: string | null }>   // known=false means the read failed → callers fail closed
externalSubmit(args: { commandId; commands: unknown[]; disclosedContracts?: unknown[] }): Promise<{ commandId; status }>   // partyId = treasury, appName from config
transfer(args: { to; amountCC: bigint; reason; commandId; metadata?: Record<string,string> }): Promise<{ commandId; status }>   // from = treasury

// AuditService
record(input: { actorType: 'user'|'admin'|'system'; actorUserId?: string|null; actorSessionId?: string|null; action: AuditAction;
                subjectType: string; subjectId: string; metadata?: Record<string, unknown>; ip?: string|null }, manager?: EntityManager): Promise<void>
list(filter: { subjectType?; subjectId?; actorUserId?; page; limit }): Promise<{ items; total }>

// RateLimitService
hit(scope: string, key: string, windowMs: number, max: number): Promise<void>   // throws ApiError(429, 'rate_limited') with retryAfter
enforce(scope: 'login'|'nonce'|'challenge'|'telegram'|'link'|'reconcile'|'settle'|'kyc_session'|'webhook', dims: { ip?: string; subject?: string; userId?: string }): Promise<void>  // limits from ARCHITECTURE §13

// SessionService
issue(input: { userId; authIdentityId; kind: 'user'|'admin'; ip?; userAgent? }): Promise<{ token: string; session: SessionEntity }>
verify(token: string): Promise<{ session: SessionEntity; user: UserEntity } | null>           // Redis first, Postgres fallback; expiry, revocation, user status checked by the guard
revoke(sessionId: string, actor?): Promise<void>; revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number>
listForUser(userId: string): Promise<SessionEntity[]>; touch(session): Promise<void>
cookieFor(token, kind): string; clearedCookie(): string

// UserService
findById(id): Promise<UserEntity | null>; create(input: { displayName?; avatarUrl?; email? }, manager?): Promise<UserEntity>
update(id, patch): Promise<UserEntity>; setPrimaryParty(userId, partyId | null, manager?): Promise<void>
suspend(userId, reason, actor): Promise<void>; reinstate(userId, reason, actor): Promise<void>   // suspend also revokes sessions
toApi(user: UserEntity): ApiUser

// IdentityService  (rules ARCHITECTURE §6)
resolveForLogin(claim: IdentityClaim, ctx: { currentUser: UserEntity | null; ip?; userAgent? }):
   Promise<{ user: UserEntity; identity: AuthIdentityEntity; mode: 'login' | 'link'; created: boolean }>
   // IdentityClaim = { provider; subject; email?: string|null; profile?: Record<string, unknown> }
   // throws ApiError 403 identity_unlinked, 409 identity_already_linked, 403 user_suspended
unlink(userId, identityId, actor): Promise<void>                        // 409 identity_locked_by_kyc (users only) → primary_wallet_in_use (every actor) → last_identity, checked in that order
reattach(userId, identityId, claim: IdentityClaim, actor): Promise<AuthIdentityEntity>   // original owner or admin
listForUser(userId): Promise<AuthIdentityEntity[]>; toApi(identity, kycLockedIdentityId?: string|null): ApiIdentity
findByProviderSubject(provider, subject): Promise<AuthIdentityEntity | null>

// WalletChallengeService  (ARCHITECTURE §7.3) — a wallet proof links a wallet or signs an OPERATOR in; it never signs a user in
issue(input: { partyId; purpose: 'link-wallet'|'admin-sign-in'; sessionId?: string|null; host: string }): Promise<{ challengeId; message; expiresAt }>
   // link-wallet requires a sessionId (401 unauthenticated); admin-sign-in refuses one (409 challenge_purpose_mismatch)
verify(input: { challengeId; partyId; publicKey; signature; expectedPurpose: ChallengePurpose | ChallengePurpose[]; sessionId?: string|null }):
   Promise<{ partyId; publicKeyBase64: string; purpose; form: string }>   // consumes the claim BEFORE verifying; throws 401 challenge_rejected / challenge_purpose_mismatch / wallet_key_mismatch / signature_invalid

// --- feature seams (implemented by the packages named) ---
// LoginService (P1)
completeLogin(res, claim, ctx: { req; kind: 'user'|'admin'; client: 'web'|'native' }): Promise<LoginResult>   // resolveForLogin → SessionService.issue → cookie/bearer → audit + NATS
   // seeds no wallet row for anyone; kind="admin" demands a canton_wallet claim whose party is an operator, and a
   // canton_wallet claim with kind!=="admin" is refused outright (403) — wallets do not sign users in (§6.1, §7.4)

// WalletLinkService (P2)
link(userId, verified: { partyId; publicKeyBase64; kind }, opts: { label?; actor }): Promise<{ wallet: WalletEntity }>   // no ledger I/O and no identity (§8.1);
   // the party → first-account binding is the unique to_wallets.party_id alone → 409 wallet_already_linked
findByParty(partyId): Promise<WalletEntity | null>            // active OR revoked
listForUser(userId): Promise<WalletEntity[]>; unlink(userId, walletId, actor): Promise<void>; setPrimary(userId, walletId, actor): Promise<WalletEntity>
toApi(wallet, extras?: { ownLedgerWallet?: LedgerWallet|null; receivedCC?: bigint }): ApiWallet

// DepositService (P2)
reconcile(userId, actor): Promise<ReconcileResult>; confirmPending(userId?): Promise<{ confirmed: number; failed: number }>; overview(userId): Promise<InAppWalletOverview>
planCredit({ wallets: { id; partyId; creditedCC; receivedCC }[]; primaryPartyId; ledgerDepositedCC }): CreditPlan   // pure: owed = received − credited; expected = Σ credited; |delta| > DUST → drift (over_credit | ledger_below_expected | ledger_above_expected)
// confirm rule: UserWallet.depositRefs contains row.txRef (the only rule; depositedCC is never consulted)

// PayoutService (P3)
settle(cid: string, actor: { type: 'user'|'admin'|'system'; userId?: string; sessionId?: string; force?: boolean; reason?: string }): Promise<{ payout: PayoutEntity; mode: 'external'|'in_app'|'already_settled' }>
listForUser(userId): Promise<PayoutEntity[]>; listAll(filter): Promise<PayoutEntity[]>; scan(): Promise<void>; requeueBlockedKyc(userId): Promise<number>; toApi(payout, onLedger: boolean): ApiPayout

// KycService (P4)
withdrawalGate(userId): Promise<{ allowed: boolean; reason?: 'kyc_required'|'kyc_duplicate_identity'|'user_suspended' }>   // ARCHITECTURE §9.4 gate incl. KYC_ENFORCE_WITHDRAWALS=false → allowed
summaryForUser(userId): Promise<ApiKycSummary & { history }>; startSession(user, session): Promise<...>; applyEvent(eventRowId): Promise<void>
adminOverride(userId, status, reason, actor): Promise<KycVerificationEntity>; transferPerson(fingerprint, toUserId, reason, actor): Promise<void>
lockedIdentityId(userId): Promise<string | null>   // used by IdentityService via a lazy lookup to avoid a DI cycle (F provides KycLockLookup token; P4 binds it)

// AdminService (P5) — composes the above; no other package depends on it
```

## Ledger index seams (P6)

```ts
// LedgerStreamService (reads as config.indexerParty; nothing cached)
ledgerEnd(): Promise<number>; prunedOffset(): Promise<number>
fetchUpdates({ beginExclusive, endInclusive, limit }): Promise<LedgerTransaction[]>   // throws with PARTICIPANT_PRUNED_DATA_ACCESSED in the message when pruned
fetchActiveContracts(activeAtOffset): Promise<ActiveContractEntry[]>                   // throws when the page fills INDEXER_ACS_LIMIT

// IndexerService
runOnce(): Promise<{ applied; seen; caughtUp; bootstrapped; resynced }>   // bootstrap if needed, one page, each tx atomically with the cursor
applyTransaction(tx): Promise<boolean>                                     // false = replay; publishes the NATS fan-out after commit
resync(fromOffset, reason) · resyncNow(reason) · status(): Promise<ApiLedgerStatus> · currentOffset() · waitForOffset(offset, timeoutMs)

// LedgerProjection (src/indexer/projection.ts, pure over an EntityManager)
applyTransaction(manager, tx): Promise<{ applied; summary }>; applyActiveContracts(manager, entries, atOffset, "bootstrap" | "resync")

// MarketsService — list/get/activity/trades/priceHistory/forecasts/attestations/holders/liquidityProviders/stats/leaderboard + toApi/toSummary/toApiEvent/toApiPosition/positionValue
// PortfolioService — partiesOf(user) (primary + active linked wallets), positions/liquidity/trades/activity/walletHistory/indexedWallet/transfers/ledgerPayouts
```

Fixtures: `test/helpers/ledger-fixtures.ts` builds internally consistent transactions from the Daml
choices (`createMarket`, `createWallet`, `deposit`, `withdraw`, `markPaid`, `buy`, `sell`,
`resolveT0`, `redeem`, `spliceTransferIn/Out`, `acsEntry`); `FakeLedgerStream` (`test/helpers/fakes.ts`)
replaces the participant (`push()`, `pruned`, `acs`, `failNext`, `calls`). `INDEXER_ENABLED=false`
under test — specs call `IndexerService.runOnce()` themselves.

## Test helpers (F)

```
test/helpers/app.ts       createTestApp(overrides?): Promise<{ app: INestApplication; config: Config; agent: supertest.Agent; close() }>
                          // real Postgres (TEST_DATABASE_URL, default postgresql://localhost:5432/truthoracle_backend_test — created on demand
                          // with `createdb` if missing) with migrations run once per Jest worker and tables truncated in beforeEach;
                          // real Redis (TEST_REDIS_URL, default redis://localhost:6379/1, FLUSHDB in beforeEach); FakeNatsService (records
                          // publishes; `dispatch(subject, payload)` invokes registered consumers); FakeLedgerClient (in-memory UserWallets /
                          // PendingPayouts; records every read in `reads` / `fetchUserWalletCalls()`; `failReads` makes every read throw) +
                          // FakeEnterpriseWallet (transfer rows, applies treasury commands to the fake ledger, requires depositRefs on Create);
                          // KYC provider = mock unless overridden
test/helpers/wallet.ts    makeTestWallet(hint = "test"): { partyId; publicKeyBase64; publicKeyHex; sign(message: string): string /*base64*/ }  // Ed25519 keypair whose party id is hint::<fingerprint>
test/helpers/fakes.ts     FakeNatsService, FakeLedgerClient, FakeEnterpriseWallet, FakeKycProvider (optional)
test/helpers/session.ts   signInWithWallet(agent, wallet, purpose?): Promise<{ user; cookie: string }>   // runs the real challenge/verify flow
```

## Conventions

- Every write that must be atomic uses `dataSource.transaction(async (manager) => …)`; services accept an
  optional `EntityManager` where another package needs to compose.
- Money is `bigint` internally (`util/money.ts`), `numeric(38,10)` in Postgres (TypeORM `transformer`
  `{ to: formatCC, from: parseCC }` on the column), strings with 10 decimals on the wire.
- Errors: `throw new ApiError(status, code, message, details?)`; codes only from `types.ts`.
- Audit + NATS event on every state change; NATS payloads carry ids, never PII.
- Logging: Nest `Logger` per class; never log tokens, signatures, secrets, applicant data.
- Tests: unit specs colocated (`*.spec.ts`), e2e under `test/` using the helpers above.
