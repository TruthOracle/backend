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

import { AttestationEntity } from "./attestation.entity";
import { AuditEventEntity } from "./audit-event.entity";
import { AuthIdentityEntity } from "./auth-identity.entity";
import { DepositCreditEntity } from "./deposit-credit.entity";
import { IndexerStateEntity } from "./indexer-state.entity";
import { KycPersonEntity } from "./kyc-person.entity";
import { KycVerificationEntity } from "./kyc-verification.entity";
import { KycWebhookEventEntity } from "./kyc-webhook-event.entity";
import { LedgerEventEntity } from "./ledger-event.entity";
import { LedgerPayoutEntity } from "./ledger-payout.entity";
import { LedgerTransferEntity } from "./ledger-transfer.entity";
import { LedgerWalletEntity } from "./ledger-wallet.entity";
import { LiquidityPositionEntity } from "./liquidity-position.entity";
import { MarketEventEntity } from "./market-event.entity";
import { MarketSnapshotEntity } from "./market-snapshot.entity";
import { MarketEntity } from "./market.entity";
import { ModelForecastEntity } from "./model-forecast.entity";
import { PayoutEntity } from "./payout.entity";
import { PositionEntity } from "./position.entity";
import { PredictionModelEntity } from "./prediction-model.entity";
import { SessionEntity } from "./session.entity";
import { SettingEntity } from "./setting.entity";
import { UserEntity } from "./user.entity";
import { WalletEntity } from "./wallet.entity";
import { WalletEntryEntity } from "./wallet-entry.entity";

/** Every entity, in FK-safe order (referenced tables first). */
export const postgresEntities = [
  SettingEntity,
  UserEntity,
  AuthIdentityEntity,
  WalletEntity,
  SessionEntity,
  KycVerificationEntity,
  KycPersonEntity,
  KycWebhookEventEntity,
  PayoutEntity,
  DepositCreditEntity,
  AuditEventEntity,
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
];
