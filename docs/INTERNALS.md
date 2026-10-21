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
| **P6 — ledger index** (docs/INDEXER.md) | `src/indexer/*` (pure: `events`, `token-standard`, `splice`, `projection`), `src/util/ledger-values.ts`, `src/util/ledger-offset.interceptor.ts`; services `ledger-stream`, `indexer`, `markets`, `portfolio`; processor `ledger-indexer`; controllers `markets`, `ledger`, `portfolio`, `ledger-wallet`, `admin-ledger`; `src/dto/ledger.dto.ts`; 16 entities (tables in the `Init` migration); `test/helpers/ledger-fixtures.ts`, `FakeLedgerStream`; specs + `test/ledger.e2e-spec.ts`, `test/token-standard.e2e-spec.ts` |
| **P8 — tokens** (docs/TOKENS.md) | services `instruments`, `token-registry`, `token-app`, `treasury-transfer`, `token-operations`, `rewards`; processors `transfer-instruction-acceptor`, `rewards`; controllers `instruments`, `admin-instruments`, `rewards`, `admin-rewards`, `admin-tokens`; `src/dto/{instruments,rewards,tokens}.dto.ts`; entities `InstrumentEntity`, `WalletCreditEntity`, `LedgerHoldingEntity`, `LedgerTransferInstructionEntity`, `RewardRuleEntity`, `RewardGrantEntity`; `FakeTokenRegistry`, `FakeTokenApp`; specs + `test/{token-standard,instruments,rewards,admin-tokens}.e2e-spec.ts` |
| **P7 — market catalog, candles, quotes / orders, exchange** (docs/MARKETS.md) | `src/amm/*` (pure: `pm-amm` port of PmAmmMath, `market-state`), `src/indexer/candles.ts`; services `catalog`, `candles`, `quote`, `exchange`, `market-operator`; controllers `catalog`, `orders`, `exchange`, `admin-catalog` (+ `markets` gains candlesticks / quote and id-or-ticker params); `src/dto/catalog.dto.ts`, `src/dto/orders.dto.ts`; entities `SeriesEntity` (to_series), `CatalogEventEntity` (to_events), `MarketCandleEntity` (to_market_candles) + the catalog / open-interest columns on `MarketEntity` (tables in the `Init` migration); fixtures carry the four identity fields and `at:`; specs + `test/{catalog,candles,orders}.e2e-spec.ts` |
| **P9 — fiat ramp** (docs/RAMP.md) | services `ramp`, `ramp-fulfilment`, `ramp-policy`, `ramp-order-store`, `ramp-journal`, `ramp-provider-mock`; processor `ramp`; controllers `ramp`, `admin-ramp`, `ramp-mock` (not in the barrel), the `webhooks/ramp/:provider` route; `src/dto/ramp.dto.ts`; `src/util/sealed.ts`; entities `RampOrderEntity`, `RampPaymentMethodEntity`, `RampEventEntity`, `RampJournalEntity` (tables in the `Init` migration); the off-ramp binding / `blocked_ramp_hold` hooks in `payout`; specs + `test/ramp.e2e-spec.ts` |

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
src/services/instruments.service.ts         InstrumentsService           (P8)
src/services/token-registry.service.ts      TokenRegistryService         (P8)  CIP-56 registry client per instrument
src/services/token-app.service.ts           TokenAppService              (P8)  Cantor8 token-app (mint / burn)
src/services/treasury-transfer.service.ts   TreasuryTransferService      (P8)  wallet / registry transfers out of the treasury, instrument setup, indexedBalances
src/services/token-operations.service.ts    TokenOperationsService       (P8)  operator mint / burn through token-app, mint-and-credit, GET /admin/tokens/status
src/services/rewards.service.ts             RewardsService               (P8)  rules, grants, the float rule, the scan the RewardsProcessor drives
src/services/ramp.service.ts                RampService                  (P9)  overview, quote, open on-/off-ramp (Idempotency-Key), attach, cancel, cards, webhook inbox
src/services/ramp-fulfilment.service.ts     RampFulfilmentService        (P9)  step engine: acquirer re-reads, mint → credit, MarkPaid → burn → payout → reversal, admin actions, reconciliation
src/services/ramp-policy.service.ts         RampPolicyService            (P9)  instrument, eligibility, limits, card hold, bindWithdrawal (reads only — PayoutService depends on it)
src/services/ramp-order-store.service.ts    RampOrderStore               (P9)  RAMP_TRANSITIONS, compare-and-set transition + audit (+ journal) in one transaction, wire mapping
src/services/ramp-journal.service.ts        RampJournalService           (P9)  double-entry fiat journal (postingFor is pure)
src/services/ramp-provider-mock.service.ts  RampProviderMockService      (P9)  the mock acquirer: hosted checkout, signed webhooks, payouts (dev / test only)

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
src/controllers/rewards.controller.ts       RewardsController            (P8)  @Controller("me/rewards")  GET /
src/controllers/admin-rewards.controller.ts AdminRewardsController       (P8)  @Controller("admin/rewards")  rules, rules/:id, grant, grants, float
src/controllers/admin-tokens.controller.ts  AdminTokensController        (P8)  @Controller("admin/tokens")  mint, burn, status
src/controllers/ramp.controller.ts          RampController               (P9)  @Controller("ramp")  /, quote, onramp, offramp, orders, orders/:id/attach|cancel, payment-methods
src/controllers/admin-ramp.controller.ts    AdminRampController          (P9)  @Controller("admin/ramp")  orders, orders/:id/retry|refund|fail, reconciliation, provider
src/controllers/ramp-mock.controller.ts     RampMockController           (P9)  @Controller("ramp/mock") — NOT exported from the barrel; app.module registers it only when config.ramp.provider === "mock"

src/processors/session-cleanup.processor.ts    SessionCleanupProcessor   (F)
src/processors/deposit-confirm.processor.ts    DepositConfirmProcessor   (P2)
src/processors/payout-settlement.processor.ts  PayoutSettlementProcessor (P3)
src/processors/kyc-webhook.processor.ts        KycWebhookProcessor       (P4)
src/processors/ledger-indexer.processor.ts     LedgerIndexerProcessor    (P6)
src/processors/transfer-instruction-acceptor.processor.ts  TransferInstructionAcceptorProcessor (P8)
src/processors/rewards.processor.ts            RewardsProcessor          (P8)  REWARDS_SCAN_MS, lock:rewards → RewardsService.scan()
src/processors/ramp.processor.ts               RampProcessor             (P9)  consumer ramp-webhook-apply; RAMP_SCAN_MS (0 = off), lock:ramp-scan → RampFulfilmentService.scan() + sweepEvents()

src/entities/*.entity.ts  UserEntity (to_users), AuthIdentityEntity (to_auth_identities), WalletEntity (to_wallets),
  SessionEntity (to_sessions), KycVerificationEntity (to_kyc_verifications), KycPersonEntity (to_kyc_persons),
  KycWebhookEventEntity (to_kyc_webhook_events), PayoutEntity (to_payouts), DepositCreditEntity (to_deposit_credits),
  AuditEventEntity (to_audit_events), SettingEntity (to_settings)   — columns exactly as ARCHITECTURE.md §5
src/migrations/<ts>-Init.ts   the ONE migration: creates everything (CREATE EXTENSION IF NOT EXISTS citext / pgcrypto, every table, CHECK, index and trigger), seeds to_settings.app_network and rewards_cursor — greenfield, no upgrade path (ARCHITECTURE §18)

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
src/util/money.ts           parseAmount(input: string | number): bigint; formatAmount(units: bigint): string /*10 dp*/; DUST; addAmount/subAmount/cmpAmount/absAmount/sumAmount;
                            quantizeDown(amount, decimals): bigint (toward zero, still 1e-10 units); formatAmountWithDecimals(amount, decimals): string (display / token-app form)
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
                            InstrumentId / InstrumentRef (+ instrumentKey, sameInstrument, parseInstrumentKey), LedgerWallet, PendingPayoutRecord,
                            LedgerTransferRecord, LedgerHoldingRecord, LedgerTransferInstructionRecord, registry / token-app / treasury-transfer shapes,
                            reward rule + grant shapes, NatsSubjects const, AuditAction union, Money = bigint alias (docs/TOKENS.md §4)
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
`truthoraclePackageId`, `truthoraclePackageName` (truthoracle-v17 — `UserWallet.instrument` / `creditRefs`, `PredictionMarket.collateral` and the market identity fields are mandatory, no feature flag),
`keycloak: { url, realm, clientId, clientSecret }`, `ledgerKeycloak`, `walletKeycloak` (same shape, optional overrides),
`zkpc: { ledgerApiUrl, keycloakUrl, keycloakRealm, clientId, clientSecret }`,
`kycProvider ('mock'|'sumsub')`, `kycEnforceWithdrawals` (plain flag), `kycRequiredLevel`, `kycFingerprintPepper`, `kycPepperRotationAck`,
`payoutExternalReasons (string[])`, `payoutInappReasons (string[])`, `payoutMaxAttempts`, `payoutScanMs`, `payoutResendGraceMs`,
`sumsub: { baseUrl, appToken, secretKey, webhookSecret, duplicateLabels: string[], allowSha1 }`,
`sessionCleanupMs`, `ledgerCacheMs`, `depositLockTtlMs`, `depositConfirmGraceMs`, `sentryDsn`, `swaggerEnabled (resolved)`,
`collateralInstrument` / `rewardsInstrument: InstrumentConfig { admin, id, symbol, name, decimals, registryUrl, registryAuth, walletInstrumentId }` (+ `hasCollateralInstrument`, `hasRewardsInstrument`),
`auditObserverParties (string[])`, `treasuryTransferMode ('wallet'|'registry')`, `treasuryTransferTtlSec`, `ledgerFreshOffsets`, `acceptorScanMs`, `registryKeycloak`,
`tokenApp: { url, appName, keycloak }` (+ `hasTokenApp`), `rewardsEnabled`, `rewardsScanMs`, `rewardsAutoMint`, `rewardsMintMin (bigint)` — docs/TOKENS.md §4.7.

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
bearerFor(target: "ledger" | "wallet" | "registry" | "tokenApp"): Promise<string>   // throws ApiError(502, "upstream_failed") when unmintable; registry = REGISTRY_KEYCLOAK_*, tokenApp = TOKEN_APP_KEYCLOAK_*, each field falling back to KEYCLOAK_*
isConfigured(target): boolean · credentialsFor(target): KeycloakConfig | null

// LedgerClientService (reads as the treasury party; package-name filters; docs/TOKENS.md §4.3)
fetchUserWallet(ownerParty: string, instrument: InstrumentId): Promise<LedgerWallet | null>   // { contractId, owner, instrument, balance, deposited, withdrawn: bigint, creditRefs: string[], auditObservers }
                                                                      // a payload without creditRefs or instrument (wrong package) → ApiError(502, "upstream_failed"), never [] / a default token
fetchUserWallets(ownerParty): Promise<LedgerWallet[]>                 // every instrument
fetchAllUserWallets(): Promise<LedgerWallet[]>
fetchPendingPayouts(): Promise<PendingPayoutRecord[]>                 // { contractId, user, marketId, instrument, amount: bigint, reason, createdAt, auditObservers }
fetchPendingPayout(cid: string): Promise<PendingPayoutRecord | null>
walletCreateCommandId(owner, instrument): string                      // wallet-create-<sha256(packageName|owner|admin|id)[:40]>
templateId(entity: string): string
// pure: userWalletCreateCommand({ templateId, admin, owner, instrument, auditObservers }), parseCreditRefs(value), parseInstrumentId(value)

// InstrumentsService (docs/TOKENS.md §4.1)
syncFromConfig(): Promise<void>                                       // boot upsert of the env instruments (onApplicationBootstrap, after the migrations)
list({ includeDisabled? }) · get(admin, id) · require(admin, id) /*404*/ · defaultCollateral() · requireDefaultCollateral() /*503 not_ready*/
requireCollateral(ref?) /*400 validation_failed unless an enabled collateral instrument*/ · requireEnabled(ref) /*404 instrument_unknown, 409 instrument_disabled*/ · rewardsInstrument()
refOf(instrument: InstrumentId): InstrumentRef                        // synchronous, from a 10 s snapshot; unknown → { symbol: id, name: id, decimals: 10 }
toRef(row) · toApi(row) · toAdminApi(row) · transferModeOf(row) · create(input, actor, reason?) · update(admin, id, patch, actor, reason?)
ensureKnown(ref, kind = "collateral"): Promise<boolean>               // the indexer's hook: register an unknown instrument as disabled, symbol = id

// EnterpriseWalletService (no history read: deposits come from to_ledger_transfers, docs/TOKENS.md decision 5)
transferStatus(partyId, commandId): Promise<{ known: boolean; submitted: boolean; status: string | null }>   // the TRANSFER index; known=false means the read failed → callers fail closed
commandStatus(partyId, commandId): Promise<{ known; submitted; status }>                                   // the COMMAND index (external submits); a 404 is UNKNOWN, not "never happened"
externalSubmit(args: { commandId; commands: unknown[]; disclosedContracts?: unknown[] }): Promise<{ commandId; status }>   // partyId = treasury, appName from config
transfer(args: { to; instrumentId; amount: bigint; reason; commandId; metadata?: Record<string,string> }): Promise<{ commandId; status }>   // from = treasury; instrumentId = to_instruments.wallet_instrument_id; amount already quantised

// TokenRegistryService (docs/TOKENS.md §4.4; per instrument's registry_url / registry_auth)
isConfigured(instrument): boolean · info(instrument) · instrument(instrument)
transferFactory(instrument, choiceArguments): Promise<{ factoryId; transferKind; choiceContext: { choiceContextData; disclosedContracts } }>   // 503 not_ready without a registry URL, 502 upstream_failed
acceptContext(instrument, cid) · rejectContext(instrument, cid) · withdrawContext(instrument, cid): Promise<RegistryChoiceContext>
// pure: parseChoiceContext(value, symbol)

// TokenAppService (docs/TOKENS.md §4.4; TOKEN_APP_URL blank → every call 503 token_app_unconfigured, status() reports it)
mint(req) · burn(req): Promise<{ commandId; status; raw }>          // req = { commandId; instrumentId; partyId; amount: bigint; decimals } — the amount leaves in the instrument's decimals
mintBatch(req) · burnBatch(req): Promise<{ …; entryCount }> · status(): Promise<TokenAppStatus> · holdings({ partyId?, instrumentId? }) · mints() · burns()
// pure: tokenAppCommandBody(req, appName), tokenAppBatchBody(req, appName)

// TreasuryTransferService (docs/TOKENS.md §2 decision 6, §4.4)
transfer({ instrument, to, amount, commandId, reason, metadata? }): Promise<{ commandId; mode: "wallet" | "registry"; status }>   // 404 instrument_unknown / 409 instrument_disabled / 409 insufficient_treasury_holdings
status(mode, commandId): Promise<TransferStatusResult>             // transferStatus for wallet, commandStatus for registry
modeFor(instrument) · treasuryHoldings(instrument): Promise<LedgerHoldingEntity[]>
indexedBalances(instrument): Promise<{ treasuryHoldings: bigint; liabilities: bigint }>   // Σ active treasury holdings vs Σ active UserWallet.balance in the instrument, from the index (float rule, /admin/tokens/status)
setup(instrument, { autoAccept?, mintDelegation? }, actor, reason?): Promise<ApiInstrumentSetupResult>   // the token's factory choices for the treasury, audited token.setup
// pure: selectHoldings(holdings, amount, now) (largest unlocked first; null when short), isSpendable, transferFactoryArgument(input), transferFactoryCommand(factoryId, arg), transferMeta, damlTime, setupCommandId

// TransferInstructionAcceptorProcessor (ACCEPTOR_SCAN_MS; lock:transfer-acceptor)
tick(): Promise<{ accepted; skipped; failed } | null> · scan() · reset() /* tests */
// pure: acceptorDecision(row, instrument | null, treasury, now), acceptCommandId(cid), acceptCommand(cid, context)

// DepositService additions (docs/TOKENS.md §4.7)
ensureUserWallet(owner, instrument): Promise<LedgerWallet>            // public: the one wallet-creation primitive (deterministic id), shared with the rewards grant and the mint credit
creditMint({ userId, instrument, amount, mintCommandId, actor }): Promise<{ commandId; txRef; status: "confirmed" | "submitted" }>   // UserWallet.Deposit { txRef: mint:<mintCommandId> } through the write-ahead row; idempotent per mint; 409 deposit_in_progress
// pure: mintCreditCommandId(mintCommandId) = mint-credit-<sha256[:40]>, mintCreditTxRef(mintCommandId) = mint:<mintCommandId>

// TokenOperationsService (docs/TOKENS.md §4.7)
mint({ instrument, amount, to?, creditUserId?, reason }, actor): Promise<ApiTokenMintResult>   // 404 instrument_unknown / 409 instrument_disabled / 503 token_app_unconfigured / 400 validation_failed (finer than decimals, creditUserId with a party target); audited token.mint
burn({ instrument, amount, party, reason }, actor): Promise<ApiTokenMintResult>               // 404 not_found; disabled instruments allowed; audited token.burn
status(): Promise<ApiTokenStatus>                                                             // token-app status + indexedBalances per registered instrument
// pure: tokenCommandId("mint" | "burn")

// RewardsService (docs/TOKENS.md §4.6; onApplicationBootstrap → seedRules)
seedRules(): Promise<void>                                            // the three automatic rules with REWARD_RULE_DEFAULTS, enabled iff appEnv === "dev"; ON CONFLICT (kind) DO NOTHING
listRules() · updateRule(id, { params?, enabled? }, actor, reason) /*404; validateRuleParams per kind; audited reward.rule_updated*/ · toApiRule(row)
requireInstrument() /*503 not_ready*/ · grantManual({ userId? | party?, amount, reason }, actor) /*queued; audited reward.grant_requested*/
listGrants({ status?, userId?, page, limit }) · toApiGrant(row) · overview(userId): Promise<ApiRewardsOverview> /*404 without a rewards instrument*/ · float(): Promise<ApiRewardsFloat>
scan(): Promise<RewardsScanResult>                                    // derive (cursor over to_wallet_entries / to_market_events) → submit queued + blocked_float under the float rule (requireFresh) → confirm submitted on creditRefs
// pure: validateRuleParams(kind, params), parseRewardsCursor / formatRewardsCursor, grantRef(id), grantCommandId(id, attempt), grantAttemptOf(commandId), autoMintCommandId(id),
//       scaledReward(amount, rate, decimals), floatHeadroom / floatShortfall(state, amount), autoMintAmount(shortfall, min, decimals),
//       evaluateMarketEvent(event, market, rules, collateral, decimals), evaluateWalletEntry(entry, rules, collateral, decimals), grantCommand(templateId, wallet, grant)

// RewardsProcessor (REWARDS_SCAN_MS while REWARDS_ENABLED and a rewards instrument is configured; lock:rewards)
tick(): Promise<RewardsScanResult | null>

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
toApi(wallet, extras?: { credits?: WalletCreditEntity[]; ownLedgerWallets?: LedgerWallet[]; received?: Map<instrumentKey, bigint> }): ApiWallet
toApiMany(rows, primaryPartyId): Promise<ApiWallet[]>   // credits + own ledger wallets in two batch reads
toApiWithCredits(wallet): Promise<ApiWallet>            // link / primary responses: credits only, no ledger read
creditsFor(walletIds): Promise<Map<walletId, WalletCreditEntity[]>> · creditOf(walletId, instrument): Promise<bigint>

// DepositService (P2)
reconcile(userId, actor, instrument?: InstrumentId): Promise<ReconcileResult>   // one instrument per call (default the default collateral)
confirmPending(userId?): Promise<{ confirmed: number; failed: number }>; overview(userId): Promise<InAppWalletOverview>   // one `balances` row per instrument
planCredit({ wallets: { id; partyId; credited; received }[]; primaryPartyId; ledgerDeposited }): CreditPlan   // pure, per instrument: owed = received − credited; expected = Σ credited; |delta| > DUST → drift (over_credit | ledger_below_expected | ledger_above_expected)
// confirm rule: UserWallet.creditRefs contains row.txRef (the only rule; deposited is never consulted)

// PayoutService (P3)
settle(cid: string, actor: { type: 'user'|'admin'|'system'; userId?: string; sessionId?: string; force?: boolean; reason?: string }): Promise<{ payout: PayoutEntity; mode: 'external'|'in_app'|'already_settled' }>
   // external: amount quantised down to the instrument's decimals (dust → to_payouts.details.dust), EW transfer with the instrument's wallet id; in-app: the payee's wallet in the payout's instrument
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
// LedgerStreamService (reads as config.indexerParty; nothing cached; /v2/updates only — the trees endpoint is gone from Canton 3.6)
ledgerEnd(): Promise<number>; prunedOffset(): Promise<number>
fetchUpdates({ beginExclusive, endInclusive, limit }): Promise<LedgerTransaction[]>   // wildcard + HoldingV1.Holding + TransferInstructionV1.TransferInstruction interface filters (views included); throws with PARTICIPANT_PRUNED_DATA_ACCESSED in the message when pruned
fetchActiveContracts(activeAtOffset): Promise<ActiveContractEntry[]>                   // same filter; throws when the page fills INDEXER_ACS_LIMIT

// IndexerService
runOnce(): Promise<{ applied; seen; caughtUp; bootstrapped; resynced }>   // bootstrap if needed, one page, each tx atomically with the cursor
applyTransaction(tx): Promise<boolean>                                     // false = replay; publishes the NATS fan-out after commit (incl. transfer.seen, transfer.instruction_accepted)
resync(fromOffset, reason) · resyncNow(reason) · status(): Promise<ApiLedgerStatus> · currentOffset() · waitForOffset(offset, timeoutMs)
freshness(): Promise<{ offset; ledgerEnd; lag; maxLag; fresh }> · requireFresh()   // 503 ledger_stale unless offset ≥ ledgerEnd − LEDGER_FRESH_OFFSETS (ledger end read live); pure: freshnessOf(offset, end, maxLag)

// LedgerProjection (src/indexer/projection.ts, pure over an EntityManager)
applyTransaction(manager, tx): Promise<{ applied; summary }>; applyActiveContracts(manager, entries, atOffset, "bootstrap" | "resync")
//   summary.transfers (any instrument), summary.instructionsAccepted, summary.instrumentsSeen (→ InstrumentsService.ensureKnown)

// src/indexer/token-standard.ts (pure; docs/TOKENS.md §4.2)
HOLDING_INTERFACE · TRANSFER_INSTRUCTION_INTERFACE · TRANSFER_FACTORY_INTERFACE · interfaceFilterId(iface) · isInterface(id, iface)
holdingViewOf(created) · transferInstructionViewOf(created) · transferRecordOf(value)
extractTokenStandard(tx, treasury, { holdings, instructions }): { transfers; holdingsCreated; holdingsConsumed; instructionsCreated; instructionOutcomes; claimedNodeIds; unattributed }
// src/indexer/splice.ts — extractTreasuryTransfers(tx, treasury, splicePackage, claimed?) skips the claimed node ids

// MarketsService — find(idOrTicker) · resolve(idOrTicker) (404) · list (+ event / series / tickers filters) · get · toApiMany(rows, withBlob, manager?) · extrasFor(rows) / extrasOf(market)
//   (seriesTicker through the event, previousPrice / volume24h from the hourly candles) · toApi(m, withBlob, extras?) (+ openInterest, liquidity, book) · toSummary · …
// PortfolioService — partiesOf(user) (primary + active linked wallets), positions/liquidity/trades/activity/walletHistory/indexedWallet/transfers/ledgerPayouts
```

## Market catalog, candles, quotes / orders, exchange seams (P7 — docs/MARKETS.md)

```ts
// src/amm/pm-amm.ts (pure, doubles — the PmAmmMath port)
quoteBuy(state, side, amount, nowSec) · quoteSell(state, side, sharesIn, nowSec) · quoteSwap(state, fromSide, sharesIn, nowSec)
quoteProvideLiquidity(state, valueIncrease, nowSec) · impliedQuoteBook(state, nowSec, size) · marketEffectiveL · poolValue · optimalReserves · …
// src/amm/market-state.ts
ammStateOf(marketRow): AmmMarketState · decimalToNumber(bigint) · numberToDecimal(number)

// src/indexer/candles.ts (pure)
candleUpsert(contribution, periodSecs): { sql, params } · periodStartSec(sec, period) · CANDLE_TRADE_CHOICES · OPEN_INTEREST_RECOMPUTE_SQL

// CatalogService (listings per instrument, docs/TOKENS.md §4.5: `instrument?` = the query's pair, else the default collateral)
listingInstrument(requested?): Promise<InstrumentRef | null> · listSeries(q { …, instrument? }) · getSeries(ticker, instrument?) → { series, events } · createSeries(input, actor, reason?) · updateSeries(ticker, patch, actor, reason?)
listEvents(q { series?, status?, category?, q?, sort?, instrument?, withNestedMarkets, includeArchived, page, limit }) · getEvent(ticker) (markets nested)
createEvent(input, actor, reason?) · updateEvent(ticker, patch, actor, reason?)
deriveEventStatus(phases): EventStatus · normalizeTicker(raw)   // exported pure helpers

// CandlesService
candlesticks(idOrTicker, { startTs?, endTs?, periodMinutes: 1 | 60 | 1440 }): Promise<ApiCandlesticks>   // dense; 400 over 5 000 candles

// QuoteService
quote(market, { action, side?, amount?, shares?, slippageBps? }, nowSec?): ApiQuote           // 409 market_not_tradable / quote_unavailable
prepare(user, market, { action, side?, amount?, shares?, lpTokens?, slippageBps? }): Promise<ApiPreparedOrder>   // reads wallet / position / LP cids from the index; 409 reasons per docs/MARKETS.md §7
assertTradable(market, action, phase, nowSec)                                                    // mirrors the Daml asserts

// ExchangeService
status(): Promise<ApiExchangeStatus> · halt(): Promise<ApiExchangeHalt> · setHalt({ active, reason, estimatedResumeAt? }, actor)   // to_settings 'exchange_halt'

// MarketOperatorService
createMarket(input, actor, reason?): Promise<ApiCreateMarketResult>   // MarketCounter.CreateMarket via EnterpriseWalletService.externalSubmit, commandId create-market-<sha256(ticker)[:40]>; sideLabel(raw, "Yes" | "No") defaults the labels
   // input.collateral? → InstrumentsService.requireCollateral (default collateral); 409 catalog_conflict when the event already has another; an accepted submission pins to_events.collateral_*; auditObservers = AUDIT_OBSERVER_PARTIES ∪ input

// src/indexer/projection.ts (identity, docs/MARKETS.md §2)
marketIdentityOf(manager, marketId, payload) · ensureCatalogEvent(manager, marketId, eventTicker, market) · placeholderSeriesTickerOf(eventTicker)   // exported pure helper
```

Fixtures: `LedgerFixture.createMarket` / `marketPayload` accept `ticker`, `eventTicker`,
`yesSubTitle`, `noSubTitle` (defaults `TEST-<marketId>`, `TEST`, `Yes`, `No` — every fixture market carries them), `isDynamic`,
`liquidityL` and `at:` (the transaction's ledger time — what the candle buckets are drawn from);
`buy` / `sell` accept `at:` too. `FakeEnterpriseWallet.externalSubmit` records a `CreateMarket`
exercise without applying it (the market reaches the index through `FakeLedgerStream`).

Fixtures: `test/helpers/ledger-fixtures.ts` builds internally consistent transactions from the Daml
choices (`createMarket`, `createWallet`, `deposit`, `grant`, `withdraw`, `markPaid`, `buy`, `sell`,
`resolveT0`, `redeem`, `spliceTransferIn/Out`, `acsEntry`) and from the token standard
(`holding`, `tokenTransferIn/Out`, `tokenOfferIn`, `acceptInstruction`, `endInstruction`,
`amuletTokenStandardTransferIn`, `holdingAcsEntry`; `created()` takes `interfaceViews`,
`exercised()` an `interfaceId`; Amulets carry their `Holding` view). `FakeLedgerStream`
(`test/helpers/fakes.ts`) replaces the participant (`push()`, `pruned`, `acs`, `end`, `failNext`,
`calls`). `INDEXER_ENABLED=false` under test — specs call `IndexerService.runOnce()` themselves;
a deposit is seeded by pushing a transfer's transaction and indexing it (the index is the only
deposit source).

## Test helpers (F)

```
test/helpers/app.ts       createTestApp(overrides?): Promise<{ app: INestApplication; config: Config; agent: supertest.Agent; close() }>
                          // real Postgres (TEST_DATABASE_URL, default postgresql://localhost:5432/truthoracle_backend_test — created on demand
                          // with `createdb` if missing) with migrations run once per Jest worker and tables truncated in beforeEach;
                          // real Redis (TEST_REDIS_URL, default redis://localhost:6379/1, FLUSHDB in beforeEach); FakeNatsService (records
                          // publishes; `dispatch(subject, payload)` invokes registered consumers); FakeLedgerClient (in-memory UserWallets /
                          // PendingPayouts; records every read in `reads` / `fetchUserWalletCalls()`; `failReads` makes every read throw) +
                          // FakeEnterpriseWallet (records transfers and submits, applies TruthOracle commands to the fake ledger — other packages' exercises are recorded only —,
                          // requires instrument / creditRefs / auditObservers on Create); FakeTokenRegistry (canned factory / choice contexts, `calls`, `failNext`);
                          // FakeTokenApp (`ctx.tokenApp`: mints / burns recorded in `minted` / `burned`, `configured`, `reachable`, `failNext`; nothing reaches the index);
                          // KYC provider = mock unless overridden. reset() re-seeds the env instruments and the reward rules and resets to_settings.rewards_cursor to '0';
                          // REWARDS_ENABLED=false and INDEXER_ENABLED=false under test — specs drive RewardsService.scan() / RewardsProcessor.tick() and IndexerService.runOnce()
test/helpers/wallet.ts    makeTestWallet(hint = "test"): { partyId; publicKeyBase64; publicKeyHex; sign(message: string): string /*base64*/ }  // Ed25519 keypair whose party id is hint::<fingerprint>
test/helpers/fakes.ts     FakeNatsService, FakeLedgerClient, FakeEnterpriseWallet, FakeLedgerStream, FakeTokenRegistry, FakeTokenApp, FakeKycProvider (optional)
test/helpers/session.ts   signInWithWallet(agent, wallet, purpose?): Promise<{ user; cookie: string }>   // runs the real challenge/verify flow
```

## Conventions

- Every write that must be atomic uses `dataSource.transaction(async (manager) => …)`; services accept an
  optional `EntityManager` where another package needs to compose.
- Money is `bigint` internally (`util/money.ts`), `numeric(38,10)` in Postgres (TypeORM `transformer`
  `{ to: formatAmount, from: parseAmount }` on the column), strings with 10 decimals on the wire.
- Errors: `throw new ApiError(status, code, message, details?)`; codes only from `types.ts`.
- Audit + NATS event on every state change; NATS payloads carry ids, never PII.
- Logging: Nest `Logger` per class; never log tokens, signatures, secrets, applicant data.
- Tests: unit specs colocated (`*.spec.ts`), e2e under `test/` using the helpers above.
