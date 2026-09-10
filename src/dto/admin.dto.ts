/**
 * Request DTOs for the operator API (docs/API.md "Admin"). Every mutation carries a `reason`
 * (trimmed, ≤ 500 chars) that ends up in the audit trail; the global ValidationPipe rejects
 * unknown keys, so these classes are the complete allow-list of what an admin may send.
 */
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";

import { type KycVerificationStatus, PAYOUT_STATUSES, type PayoutStatus } from "../types";
import { PageQueryDto } from "./common.dto";

/** One cap for every operator / KYC reason (audit metadata, `manual_reason`). */
export const REASON_MAX_LENGTH = 500;

/** `POST /admin/users/:id/kyc/override` accepts only these target states (ARCHITECTURE §11). */
export const ADMIN_KYC_OVERRIDE_STATUSES = ["approved", "rejected_final", "expired"] as const;
export type AdminKycOverrideStatus = Extract<
  KycVerificationStatus,
  (typeof ADMIN_KYC_OVERRIDE_STATUSES)[number]
>;

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));

/** Body of every admin mutation: the operator's reason, recorded with actorType `admin`. */
export class AdminReasonDto {
  @trimmed()
  @IsString()
  @IsNotEmpty({ message: "reason is required" })
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}

/** `GET /admin/users?q=&page=&limit=` */
export class AdminUsersQueryDto extends PageQueryDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(320)
  q?: string;
}

/** `POST /admin/users/:id/kyc/override` */
export class AdminKycOverrideDto extends AdminReasonDto {
  @IsIn(ADMIN_KYC_OVERRIDE_STATUSES, {
    message: `status must be one of ${ADMIN_KYC_OVERRIDE_STATUSES.join(", ")}`,
  })
  status!: AdminKycOverrideStatus;
}

/** `POST /admin/kyc/persons/:fingerprint/transfer` */
export class AdminPersonTransferDto extends AdminReasonDto {
  @IsUUID()
  toUserId!: string;
}

/** `:fingerprint` route param — always the sha256-hex HMAC `fingerprintOf` produces (§9.3). */
export class FingerprintParamDto {
  @Matches(/^[0-9a-f]{64}$/, { message: "fingerprint must be a 64-char lowercase hex digest" })
  fingerprint!: string;
}

/** `POST /admin/kyc/webhooks/:id/replay` */
export class WebhookEventParamDto {
  @IsUUID()
  id!: string;
}

/** `GET /admin/payouts?status=` */
export class AdminPayoutsQueryDto {
  @IsOptional()
  @IsIn(PAYOUT_STATUSES, { message: `status must be one of ${PAYOUT_STATUSES.join(", ")}` })
  status?: PayoutStatus;
}

/** `POST /admin/payouts/:cid/settle` — `force` overrides blocked_kyc / blocked_wallet_revoked (§9.4). */
export class AdminPayoutSettleDto extends AdminReasonDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** `GET /admin/audit?subjectType=&subjectId=&actorUserId=&page=&limit=` */
export class AdminAuditQueryDto extends PageQueryDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(64)
  subjectType?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(255)
  subjectId?: string;

  @IsOptional()
  @Type(() => String)
  @IsUUID()
  actorUserId?: string;
}
