import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from "class-validator";

import type { PayoutStatus } from "../types";

/** Every `to_payouts.status` (ARCHITECTURE §5) — the allow-list for `?status=` filters. */
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

/**
 * `:cid` route param. A Canton contract id is hex with a `00` prefix; the character class is
 * deliberately a little wider (test fakes use `pp-0001`) but never wide enough to smuggle a
 * path or a query into an upstream URL.
 */
export class PayoutCidParamDto {
  @IsString()
  @Length(1, 1024)
  @Matches(/^[A-Za-z0-9._:-]+$/, { message: "cid must be a contract id" })
  cid!: string;
}

/** `?status=` filter for payout listings (`GET /admin/payouts?status=`, P5 may reuse it). */
export class PayoutListQueryDto {
  @IsOptional()
  @IsIn(PAYOUT_STATUSES as readonly string[])
  status?: PayoutStatus;
}

/**
 * `POST /admin/payouts/:cid/settle { force?, reason }` (API.md "Admin"). `reason` is required for
 * every operator settlement so the audit trail explains it; `force` additionally overrides
 * `blocked_kyc` / `blocked_wallet_revoked` (ARCHITECTURE §9.4) and is audited as
 * `payout.admin_override`.
 */
export class AdminSettlePayoutDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @IsString()
  @Length(1, 500)
  reason!: string;
}
