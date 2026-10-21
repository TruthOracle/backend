/**
 * Request DTOs for the rewards API (docs/TOKENS.md §4.6; docs/API.md "Rewards", "Admin — rewards").
 * The global ValidationPipe (`whitelist`, `forbidNonWhitelisted`) rejects unknown keys, so these
 * are the complete allow-list. Rule parameters are validated per rule kind by RewardsService
 * (`validateRuleParams`): the DTO only requires an object of strings.
 */
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateIf,
} from "class-validator";

import { REWARD_GRANT_STATUSES, type RewardGrantStatus } from "../types";
import { PARTY_ID_RE } from "../util/canton-crypto";
import { AdminReasonDto } from "./admin.dto";
import { PageQueryDto } from "./common.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
const DECIMAL_INPUT = /^\d{1,28}(\.\d{1,10})?$/;

/** `:id` of `/admin/rewards/rules/:id`. */
export class RewardRuleParamDto {
  @IsUUID()
  id!: string;
}

/** `PUT /admin/rewards/rules/:id { params?, enabled?, reason }` — a rule's parameters (decimal strings per kind) and switch. */
export class UpdateRewardRuleDto extends AdminReasonDto {
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** `POST /admin/rewards/grant { userId | party, amount, reason }` — an operator grant in the rewards instrument. */
export class ManualGrantDto extends AdminReasonDto {
  @ValidateIf((o: ManualGrantDto) => o.party === undefined)
  @IsUUID()
  userId?: string;

  @ValidateIf((o: ManualGrantDto) => o.userId === undefined)
  @trimmed()
  @IsString()
  @Matches(PARTY_ID_RE, { message: "party must be a Canton party id (<hint>::1220<64 hex>)" })
  party?: string;

  @trimmed()
  @Matches(DECIMAL_INPUT, { message: "amount must be a decimal string with at most 10 decimals" })
  amount!: string;
}

/** `GET /admin/rewards/grants?status=&userId=&page=&limit=` */
export class RewardGrantsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(REWARD_GRANT_STATUSES, {
    message: `status must be one of ${REWARD_GRANT_STATUSES.join(", ")}`,
  })
  status?: RewardGrantStatus;

  @IsOptional()
  @IsUUID()
  userId?: string;
}
