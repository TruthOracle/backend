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
  MaxLength,
} from "class-validator";

import type { KycVerificationStatus, PayoutStatus } from "../types";
import { PageQueryDto } from "./common.dto";

export const ADMIN_REASON_MAX_LENGTH = 500;

/** `POST /admin/users/:id/kyc/override` accepts only these target states (ARCHITECTURE §11). */
export const ADMIN_KYC_OVERRIDE_STATUSES = ["approved", "rejected_final", "expired"] as const;
export type AdminKycOverrideStatus = Extract<
  KycVerificationStatus,
  (typeof ADMIN_KYC_OVERRIDE_STATUSES)[number]
>;

/** Closed list of `to_payouts.status` values accepted by `GET /admin/payouts?status=`. */
export const PAYOUT_STATUSES: readonly PayoutStatus[] = [
  "queued",
  "settling",
  "settled_external",
  "settled_in_app",
  "blocked_kyc",
  "blocked_unknown_user",
  "blocked_unknown_reason",
  "blocked_wallet_revoked",
  "failed",
  "archived",
];

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));

/** Body of every admin mutation: the operator's reason, recorded with actorType `admin`. */
export class AdminReasonDto {
  @trimmed()
  @IsString()
  @IsNotEmpty({ message: "reason is required" })
  @MaxLength(ADMIN_REASON_MAX_LENGTH)
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
