/**
 * Request DTOs of the S4 operator routes (SPEC §6, §12.2): halts, approvals, token command actions,
 * the operator MarkPaid. The global ValidationPipe rejects unknown keys, so these classes are the
 * complete allow-list. Decisions carry the wallet signature only as a string; the service verifies it.
 */
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from "class-validator";

import { TOKEN_COMMAND_SOURCES, TOKEN_COMMAND_STATUSES } from "../entities/token-command.entity";
import { APPROVAL_STATUSES, type ApprovalStatus, HALT_SCOPES, type HaltScope } from "../types";
import { AdminReasonDto } from "./admin.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
const DECIMAL_INPUT = /^\d{1,28}(\.\d{1,10})?$/;

/** `POST /admin/ramp/controls/halt { scopes, reason }` (role `ops`, immediate). */
export class RampHaltDto extends AdminReasonDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsIn(HALT_SCOPES as readonly string[], { each: true })
  scopes!: HaltScope[];
}

/** `GET /admin/approvals?status&action&subjectType&subjectId` */
export class ApprovalsQueryDto {
  @IsOptional()
  @IsIn(APPROVAL_STATUSES as readonly string[])
  status?: ApprovalStatus;

  @IsOptional()
  @Matches(/^[a-z_.]{1,64}$/, { message: "action must be an approval action name" })
  action?: string;

  @IsOptional()
  @Matches(/^[a-z_]{1,64}$/, { message: "subjectType must be a subject type" })
  subjectType?: string;

  @IsOptional()
  @IsString()
  @Length(1, 1024)
  subjectId?: string;
}

/** `POST /admin/approvals/:id/approve|reject { reason, signature? }` */
export class ApprovalDecisionDto extends AdminReasonDto {
  /** The wallet's signature over `truthoracle-approval:<id>:<paramsHash>:<approve|reject>`. */
  @IsOptional()
  @IsString()
  @Length(1, 512)
  signature?: string;
}

/** `POST /admin/approvals/approve-many { ids, reason, signatures? }` — one action type per call. */
export class ApproveManyDto extends AdminReasonDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  ids!: string[];

  /** `{ [approvalId]: signature }`, each over that approval's own message. */
  @IsOptional()
  @IsObject()
  signatures?: Record<string, string>;
}

/** `POST /admin/payouts/:cid/mark-paid { txHash, reason }` → `payout.mark_paid`. */
export class PayoutMarkPaidDto extends AdminReasonDto {
  @trimmed()
  @IsString()
  @Length(1, 256)
  txHash!: string;
}

/** `:id` of a token command (`ramp-mint-…`, `mint-…`, `comp-…`, `legacy-…`). */
export class TokenCommandIdParamDto {
  @Matches(/^[A-Za-z0-9_.:-]{1,128}$/, { message: "id must be a token command id" })
  id!: string;
}

/** `GET /admin/tokens/commands?status&source` */
export class TokenCommandsQueryDto {
  @IsOptional()
  @IsIn(TOKEN_COMMAND_STATUSES as readonly string[])
  status?: string;

  @IsOptional()
  @IsIn(TOKEN_COMMAND_SOURCES as readonly string[])
  source?: string;
}

/** `POST /admin/tokens/commands/:id/resend|abandon|compensate { reason, expectedTreasuryHoldings? }` */
export class TokenCommandActionDto extends AdminReasonDto {
  /** abandon only: the treasury holdings expected without the command (default: the indexed figure now). */
  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT, { message: "expectedTreasuryHoldings must be a decimal string" })
  expectedTreasuryHoldings?: string;
}

/** `POST /admin/tokens/records/adopt { before, reason, instrumentId? }` */
export class TokenRecordsAdoptDto extends AdminReasonDto {
  @IsISO8601({ strict: true })
  before!: string;

  @IsOptional()
  @Matches(/^[A-Za-z0-9_.:-]{1,128}$/, { message: "instrumentId must be a token id" })
  instrumentId?: string;
}
