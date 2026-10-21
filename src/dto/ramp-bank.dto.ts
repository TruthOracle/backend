/**
 * Request DTOs of the bank rail (SPEC §10, §12): the user's bank accounts and the operator routes
 * for batches, statements, lines, accounts and the bank order actions. The global ValidationPipe
 * rejects unknown keys, so these classes are the complete allow-list (F2 codes against them).
 */
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";

import {
  BANK_LINE_STATUSES,
  BANK_MATCH_KINDS,
  BANK_STATEMENT_STATUSES,
  type BankLineStatus,
  type BankMatchKind,
  type BankStatementStatus,
  PAYOUT_BATCH_STATUSES,
  type PayoutBatchStatus,
  RAMP_BANK_ACCOUNT_STATUSES,
  RAMP_NAME_FORMS,
  type RampBankAccountStatus,
  type RampNameForm,
} from "../types";
import { TEXT_CHARSETS, type TextCharset } from "../util/charset";
import { AdminReasonDto } from "./admin.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
/** A bank's own references: printable ASCII. */
const BANK_REF_RE = /^[\x20-\x7e]{1,64}$/;
/** base64 of a ≤ 5 MB file (the route's body limit is 8 MB). */
const CONTENT_MAX = 8 * 1024 * 1024;

/** `POST /ramp/bank-accounts {iban, nameForm}` */
export class RampBankAccountAddDto {
  @trimmed()
  @IsString()
  @Length(1, 64)
  iban!: string;

  @IsIn(RAMP_NAME_FORMS as readonly string[])
  nameForm!: RampNameForm;
}

/** `GET /admin/ramp/bank-accounts?status&userId` */
export class AdminBankAccountsQueryDto {
  @IsOptional()
  @IsIn(RAMP_BANK_ACCOUNT_STATUSES as readonly string[])
  status?: RampBankAccountStatus;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

/** `POST /admin/ramp/bank-accounts/:id/verify {reason, proofRef}` */
export class BankAccountVerifyDto extends AdminReasonDto {
  @trimmed()
  @IsString()
  @Length(1, 200)
  proofRef!: string;
}

/** `GET /admin/ramp/payout-batches?status` */
export class PayoutBatchesQueryDto {
  @IsOptional()
  @IsIn(PAYOUT_BATCH_STATUSES as readonly string[])
  status?: PayoutBatchStatus;
}

/** `POST /admin/ramp/payout-batches/:id/submitted {bankReference}` (F2 sends no reason). */
export class PayoutBatchSubmittedDto {
  @trimmed()
  @IsString()
  @Matches(BANK_REF_RE, { message: "bankReference must be 1–64 printable characters" })
  bankReference!: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** `POST /admin/ramp/payout-batches/:id/void {reason, bankRejectionRef?}` */
export class PayoutBatchVoidDto extends AdminReasonDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(BANK_REF_RE, { message: "bankRejectionRef must be 1–64 printable characters" })
  bankRejectionRef?: string;
}

/** `POST /admin/ramp/bank-statements {format, content, charset?}` — the file decides account, period and balances. */
export class BankStatementUploadDto {
  @IsIn(["camt053", "csv"])
  format!: "camt053" | "csv";

  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTENT_MAX)
  content!: string;

  @IsOptional()
  @IsIn(TEXT_CHARSETS as readonly string[])
  charset?: TextCharset;
}

/** One unmatched line booked at confirm. */
export class BankLineClassificationDto {
  @IsUUID()
  lineId!: string;

  @IsIn(BANK_MATCH_KINDS as readonly string[])
  matchKind!: BankMatchKind;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsUUID()
  batchId?: string;
}

/** `POST /admin/ramp/bank-statements/:id/confirm {reason, classifications?}` */
export class BankStatementConfirmDto extends AdminReasonDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50_000)
  @ValidateNested({ each: true })
  @Type(() => BankLineClassificationDto)
  classifications?: BankLineClassificationDto[];
}

/** `POST /admin/ramp/bank-statements/:id/confirm/approve` — the approver's OWN copy and decision. */
export class BankStatementApproveDto extends AdminReasonDto {
  @IsIn(["camt053", "csv"])
  format!: "camt053" | "csv";

  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTENT_MAX)
  content!: string;

  @IsOptional()
  @IsIn(TEXT_CHARSETS as readonly string[])
  charset?: TextCharset;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  signature?: string;
}

/** `GET /admin/ramp/bank-statements?status` */
export class BankStatementsQueryDto {
  @IsOptional()
  @IsIn(BANK_STATEMENT_STATUSES as readonly string[])
  status?: BankStatementStatus;
}

/** `GET /admin/ramp/bank-lines?status&statementId` */
export class BankLinesQueryDto {
  @IsOptional()
  @IsIn(BANK_LINE_STATUSES as readonly string[])
  status?: BankLineStatus;

  @IsOptional()
  @IsUUID()
  statementId?: string;
}

/** `POST /admin/ramp/bank-lines/:id/classify {reason, matchKind, orderId?, batchId?}` */
export class BankLineClassifyDto extends AdminReasonDto {
  @IsIn(BANK_MATCH_KINDS as readonly string[])
  matchKind!: BankMatchKind;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsUUID()
  batchId?: string;
}

/** `POST /admin/ramp/orders/:id/refund_bank {reason, bankAccountId}` */
export class RampRefundBankDto extends AdminReasonDto {
  @IsUUID()
  bankAccountId!: string;
}

/** `POST /admin/ramp/orders/:id/bank_unpaid {reason, then}` */
export class RampBankUnpaidDto extends AdminReasonDto {
  @IsIn(["requeue", "reverse"])
  then!: "requeue" | "reverse";
}
