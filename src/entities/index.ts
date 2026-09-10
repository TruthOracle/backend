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

import { AuditEventEntity } from "./audit-event.entity";
import { AuthIdentityEntity } from "./auth-identity.entity";
import { DepositCreditEntity } from "./deposit-credit.entity";
import { KycPersonEntity } from "./kyc-person.entity";
import { KycVerificationEntity } from "./kyc-verification.entity";
import { KycWebhookEventEntity } from "./kyc-webhook-event.entity";
import { PayoutEntity } from "./payout.entity";
import { SessionEntity } from "./session.entity";
import { SettingEntity } from "./setting.entity";
import { UserEntity } from "./user.entity";
import { WalletEntity } from "./wallet.entity";

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
];
