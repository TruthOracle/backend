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
import { RewardGrantEntity } from "./reward-grant.entity";
import { RewardRuleEntity } from "./reward-rule.entity";
import { SeriesEntity } from "./series.entity";
import { SessionEntity } from "./session.entity";
import { SettingEntity } from "./setting.entity";
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
