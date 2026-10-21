export * from "./setting.entity";
export * from "./user.entity";
export * from "./auth-identity.entity";
export * from "./wallet.entity";
export * from "./session.entity";
export * from "./kyc-verification.entity";
export * from "./kyc-person.entity";
export * from "./kyc-webhook-event.entity";
export * from "./payout.entity";
export * from "./deposit-credit.entity";
export * from "./audit-event.entity";
export * from "./indexer-state.entity";
export * from "./ledger-event.entity";
export * from "./market.entity";
export * from "./market-snapshot.entity";
export * from "./market-event.entity";
export * from "./position.entity";
export * from "./liquidity-position.entity";
export * from "./ledger-wallet.entity";
export * from "./wallet-entry.entity";
export * from "./ledger-payout.entity";
export * from "./attestation.entity";
export * from "./model-forecast.entity";
export * from "./prediction-model.entity";
export * from "./ledger-transfer.entity";
export * from "./series.entity";
export * from "./catalog-event.entity";
export * from "./market-metadata.entity";
export * from "./market-candle.entity";
export * from "./instrument.entity";
export * from "./wallet-credit.entity";
export * from "./ledger-holding.entity";
export * from "./ledger-transfer-instruction.entity";
export * from "./reward-rule.entity";
export * from "./reward-grant.entity";
export * from "./ramp-payment-method.entity";
export * from "./ramp-order.entity";
export * from "./ramp-event.entity";
export * from "./ramp-journal.entity";
export * from "./token-command.entity";
export * from "./token-app-record.entity";
// ramp controls: halts, reconciliation runs, four-eyes approvals (SPEC §3.4 S4)
export * from "./ramp-control.entity";
export * from "./ramp-recon-run.entity";
export * from "./admin-approval.entity";
// compliance: identities, consents, alerts (SPEC §3.4 S7a)
export * from "./kyc-identity.entity";
export * from "./ramp-consent.entity";
export * from "./compliance-alert.entity";
// bank rail: user accounts, payout batches, statements (SPEC §3.4 S6)
export * from "./ramp-bank-account.entity";
export * from "./ramp-payout-batch.entity";
export * from "./ramp-payout-batch-item.entity";
export * from "./ramp-bank-statement.entity";
export * from "./ramp-bank-line.entity";
// screening and freezes (SPEC §3.4 S7b)
export * from "./compliance-freeze.entity";
export * from "./screening-list.entity";
export * from "./screening-entry.entity";
export * from "./screening-run.entity";
export * from "./screening-subject.entity";
export * from "./screening-hit.entity";

import { AttestationEntity } from "./attestation.entity";
import { AuditEventEntity } from "./audit-event.entity";
import { AuthIdentityEntity } from "./auth-identity.entity";
import { CatalogEventEntity } from "./catalog-event.entity";
import { DepositCreditEntity } from "./deposit-credit.entity";
import { IndexerStateEntity } from "./indexer-state.entity";
import { InstrumentEntity } from "./instrument.entity";
import { KycPersonEntity } from "./kyc-person.entity";
import { KycVerificationEntity } from "./kyc-verification.entity";
import { KycWebhookEventEntity } from "./kyc-webhook-event.entity";
import { LedgerEventEntity } from "./ledger-event.entity";
import { LedgerHoldingEntity } from "./ledger-holding.entity";
import { LedgerPayoutEntity } from "./ledger-payout.entity";
import { LedgerTransferInstructionEntity } from "./ledger-transfer-instruction.entity";
import { LedgerTransferEntity } from "./ledger-transfer.entity";
import { LedgerWalletEntity } from "./ledger-wallet.entity";
import { LiquidityPositionEntity } from "./liquidity-position.entity";
import { MarketCandleEntity } from "./market-candle.entity";
import { MarketEventEntity } from "./market-event.entity";
import { MarketMetadataEntity } from "./market-metadata.entity";
import { MarketSnapshotEntity } from "./market-snapshot.entity";
import { MarketEntity } from "./market.entity";
import { ModelForecastEntity } from "./model-forecast.entity";
import { PayoutEntity } from "./payout.entity";
import { PositionEntity } from "./position.entity";
import { PredictionModelEntity } from "./prediction-model.entity";
import { RampEventEntity } from "./ramp-event.entity";
import { RampJournalEntity } from "./ramp-journal.entity";
import { RampOrderEntity } from "./ramp-order.entity";
import { RampPaymentMethodEntity } from "./ramp-payment-method.entity";
import { RewardGrantEntity } from "./reward-grant.entity";
import { RewardRuleEntity } from "./reward-rule.entity";
import { SeriesEntity } from "./series.entity";
import { SessionEntity } from "./session.entity";
import { SettingEntity } from "./setting.entity";
import { TokenAppRecordEntity } from "./token-app-record.entity";
import { TokenCommandEntity } from "./token-command.entity";
import { AdminApprovalEntity } from "./admin-approval.entity";
import { RampControlEntity } from "./ramp-control.entity";
import { RampReconRunEntity } from "./ramp-recon-run.entity";
// compliance (SPEC §3.4 S7a)
import { ComplianceAlertEntity } from "./compliance-alert.entity";
import { KycIdentityEntity } from "./kyc-identity.entity";
import { RampConsentEntity } from "./ramp-consent.entity";
// bank rail (SPEC §3.4 S6)
import { RampBankAccountEntity } from "./ramp-bank-account.entity";
import { RampBankLineEntity } from "./ramp-bank-line.entity";
import { RampBankStatementEntity } from "./ramp-bank-statement.entity";
import { RampPayoutBatchItemEntity } from "./ramp-payout-batch-item.entity";
import { RampPayoutBatchEntity } from "./ramp-payout-batch.entity";
// screening and freezes (SPEC §3.4 S7b)
import { ComplianceFreezeEntity } from "./compliance-freeze.entity";
import { ScreeningEntryEntity } from "./screening-entry.entity";
import { ScreeningHitEntity } from "./screening-hit.entity";
import { ScreeningListEntity } from "./screening-list.entity";
import { ScreeningRunEntity } from "./screening-run.entity";
import { ScreeningSubjectEntity } from "./screening-subject.entity";
import { UserEntity } from "./user.entity";
import { WalletCreditEntity } from "./wallet-credit.entity";
import { WalletEntity } from "./wallet.entity";
import { WalletEntryEntity } from "./wallet-entry.entity";

/** Every entity, in FK-safe order (referenced tables first). */
export const postgresEntities = [
  SettingEntity,
  InstrumentEntity,
  UserEntity,
  AuthIdentityEntity,
  WalletEntity,
  WalletCreditEntity,
  SessionEntity,
  KycVerificationEntity,
  KycPersonEntity,
  KycWebhookEventEntity,
  PayoutEntity,
  DepositCreditEntity,
  AuditEventEntity,
  // rewards (docs/TOKENS.md §4.6) — grants reference accounts, rules are operator data
  RewardRuleEntity,
  RewardGrantEntity,
  // fiat ramp (docs/RAMP.md §5) — orders and cards reference accounts; events and journal lines reference orders by id only
  RampPaymentMethodEntity,
  RampOrderEntity,
  RampEventEntity,
  RampJournalEntity,
  // token-app command ledger + record mirror (docs/RAMP.md §7) — no FKs: orders reference commands by id
  TokenCommandEntity,
  TokenAppRecordEntity,
  // ramp controls: halts, reconciliation runs, four-eyes approvals (SPEC §3.4 S4) — subjects by id, no FKs
  RampControlEntity,
  RampReconRunEntity,
  AdminApprovalEntity,
  // compliance (SPEC §3.4 S7a) — identities and consents reference accounts (orders reference a
  // consent); alerts reference accounts, orders by id only
  KycIdentityEntity,
  RampConsentEntity,
  ComplianceAlertEntity,
  // bank rail (SPEC §3.4 S6) — accounts reference users; orders, items and journal lines reference
  // accounts, batches and statement lines (FKs in …300-RampBank)
  RampBankAccountEntity,
  RampPayoutBatchEntity,
  RampPayoutBatchItemEntity,
  RampBankStatementEntity,
  RampBankLineEntity,
  // screening and freezes (SPEC §3.4 S7b) — freezes, hits and subjects reference accounts; hits
  // reference list versions, entries, runs and freezes
  ComplianceFreezeEntity,
  ScreeningListEntity,
  ScreeningEntryEntity,
  ScreeningRunEntity,
  ScreeningSubjectEntity,
  ScreeningHitEntity,
  // ledger index (docs/INDEXER.md) — no FKs to the account tables: parties, not users
  IndexerStateEntity,
  LedgerEventEntity,
  MarketEntity,
  MarketSnapshotEntity,
  MarketEventEntity,
  PositionEntity,
  LiquidityPositionEntity,
  LedgerWalletEntity,
  WalletEntryEntity,
  LedgerPayoutEntity,
  AttestationEntity,
  ModelForecastEntity,
  PredictionModelEntity,
  LedgerTransferEntity,
  LedgerHoldingEntity,
  LedgerTransferInstructionEntity,
  // market catalog + candles (docs/MARKETS.md) — catalog rows reference markets by ticker, never by FK
  SeriesEntity,
  CatalogEventEntity,
  MarketMetadataEntity,
  MarketCandleEntity,
];
