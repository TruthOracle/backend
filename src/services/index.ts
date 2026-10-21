// Every export here is auto-registered as a provider by AppModule — export injectable classes only.
// Written once by package F (docs/INTERNALS.md); feature packages replace file bodies, never this list.
export { AppService } from "./app.service";
export { RedisService } from "./redis.service";
export { NatsService } from "./nats.service";
export { SentryService } from "./sentry.service";
export { KeycloakTokenService } from "./keycloak-token.service";
export { LedgerClientService } from "./ledger-client.service";
export { EnterpriseWalletService } from "./enterprise-wallet.service";
export { RateLimitService } from "./rate-limit.service";
export { AuditService } from "./audit.service";
export { SessionService } from "./session.service";
export { UserService } from "./user.service";
export { IdentityService } from "./identity.service";
export { WalletChallengeService } from "./wallet-challenge.service";
export { GoogleAuthService } from "./google-auth.service";
export { TelegramAuthService } from "./telegram-auth.service";
export { LoginService } from "./login.service";
export { WalletLinkService } from "./wallet-link.service";
export { DepositService } from "./deposit.service";
export { PayoutService } from "./payout.service";
export { KycService } from "./kyc.service";
export { KycProviderMockService } from "./kyc-provider-mock.service";
export { KycProviderSumsubService } from "./kyc-provider-sumsub.service";
export { AdminService } from "./admin.service";
// instruments, registries, token-app, treasury transfers (docs/TOKENS.md)
export { InstrumentsService } from "./instruments.service";
export { TokenRegistryService } from "./token-registry.service";
export { TokenAppService } from "./token-app.service";
// token-app command ledger + sync (docs/RAMP.md §7; S1)
export { TokenAppSyncService } from "./token-app-sync.service";
export { TokenCommandService } from "./token-command.service";
export { TreasuryTransferService } from "./treasury-transfer.service";
export { TokenOperationsService } from "./token-operations.service";
export { RewardsService } from "./rewards.service";
// ledger indexer + index-backed reads (docs/INDEXER.md)
export { LedgerStreamService } from "./ledger-stream.service";
export { IndexerService } from "./indexer.service";
export { MarketsService } from "./markets.service";
export { PortfolioService } from "./portfolio.service";
// market catalog, candles, quotes / orders, exchange status (docs/MARKETS.md)
export { CatalogService } from "./catalog.service";
export { CandlesService } from "./candles.service";
export { ExchangeService } from "./exchange.service";
export { QuoteService } from "./quote.service";
export { MarketOperatorService } from "./market-operator.service";
// fiat ramp — BYN card on-ramp / off-ramp (docs/RAMP.md)
export { RampProviderMockService } from "./ramp-provider-mock.service";
export { RampOrderStore } from "./ramp-order-store.service";
export { RampPolicyService } from "./ramp-policy.service";
export { RampJournalService } from "./ramp-journal.service";
export { RampFulfilmentService } from "./ramp-fulfilment.service";
export { RampService } from "./ramp.service";
// fiat ramp core v2 — disputes, the token sync hook, the operator actions (SPEC §4, §5; S2)
export { RampDisputesService } from "./ramp-disputes.service";
export { RampTokenSyncHook } from "./ramp-token-sync.service";
export { RampActionsService } from "./ramp-actions.service";
// ramp controls — halts, reconciliation + its checks, the reserve / payout gates (SPEC §6; S4)
export { RampControlsService } from "./ramp-controls.service";
export { RampReconciliationService } from "./ramp-reconciliation.service";
export { RampTokenChecks } from "./ramp-recon-token-checks.service";
export { RampReconChecks } from "./ramp-recon-checks.service";
export { RampGatesService } from "./ramp-gates.service";
export { RampCompensationService } from "./ramp-compensation.service";
// four-eyes approvals and the S4 catalogue (SPEC §6.5; S4)
export { AdminApprovalService } from "./admin-approval.service";
export { RampApprovalActions } from "./ramp-approval-actions.service";
export { TokenApprovalActions } from "./token-approval-actions.service";
// review group C: a manual KYC approval is the four-eyes kyc.override (C22)
export { KycApprovalActions } from "./kyc-approval-actions.service";
// platform security — sealing v2 keyrings and their re-sealers (SPEC §8)
export { SealedDataService } from "./sealed-data.service";
export { RampCardResealer } from "./ramp-card-sealing.service";
// methods, card cash-out, exposure — and the ports S6 / S7a / S7b implement (SPEC §9; S5)
export { RampCompliancePort } from "./ramp-compliance.port";
export { ComplianceFreezePort } from "./compliance-freeze.port";
export { KycIdentityPort } from "./kyc-identity.port";
export { RampBankRailPort } from "./ramp-bank-rail.port";
export { RampReleaseGuard } from "./ramp-release-guard.service";
export { RampCardCashoutService } from "./ramp-card-cashout.service";
export { RampPayerResealer } from "./ramp-payer-sealing.service";
// compliance: identity, consent, eligibility, monitoring rules, alerts (SPEC §11; S7a)
export { ComplianceAlertsService } from "./compliance-alerts.service";
export { KycIdentityService } from "./kyc-identity.service";
export { RampConsentService } from "./ramp-consent.service";
export { ComplianceRulesService } from "./compliance-rules.service";
// screening, freezes, value-movement guards, the operations register (SPEC §11.6; S7b)
export { ComplianceFreezeService } from "./compliance-freeze.service";
export { ComplianceScreeningService } from "./compliance-screening.service";
export { RampOperationsExportService } from "./ramp-operations-export.service";
// bank rail: user accounts, payout batches, statements and their ledger (SPEC §10; S6)
export { RampBankAccountsService } from "./ramp-bank-accounts.service";
export { RampBankSealing } from "./ramp-bank-sealing.service";
export { RampBankLedger } from "./ramp-bank-ledger.service";
export { RampBankStatementsService } from "./ramp-bank-statements.service";
export { RampBankBatchesService } from "./ramp-bank-batches.service";
export { RampBankRail } from "./ramp-bank-rail.service";
// review F0: resolving / voiding a market is the four-eyes market.resolve, submitted treasury-signed
export { MarketResolutionService } from "./market-resolution.service";
