/**
 * Request DTOs of the S7b operator routes (SPEC §11.6, §12.2): freezes, screening lists and hits,
 * re-screens, the operations export. The global ValidationPipe rejects unknown keys, so these
 * classes are the complete allow-list (F2's console sends exactly these bodies).
 */
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from "class-validator";

import {
  FREEZE_SOURCES,
  type FreezeSource,
  SCREENING_HIT_STATUSES,
  SCREENING_LISTS,
  type ScreeningHitStatus,
  type ScreeningListName,
} from "../types";
import { TEXT_CHARSETS, type TextCharset } from "../util/charset";
import { AdminReasonDto } from "./admin.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
const toBool = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : value,
  );

/** `POST /admin/compliance/freezes { userId, reason, source }` (role `aml`, at once). */
export class ComplianceFreezeDto extends AdminReasonDto {
  @IsUUID()
  userId!: string;

  @IsIn(FREEZE_SOURCES as readonly string[])
  source!: FreezeSource;
}

/** `GET /admin/compliance/freezes?active&userId` */
export class ComplianceFreezesQueryDto {
  @IsOptional()
  @toBool()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

/**
 * `POST /admin/compliance/screening-lists { list, version, deliveredAt, content, charset? }` (role
 * `aml`): `content` = the normalized CSV (`kind,name_variants,birth_date,ids`) as base64; the
 * route's body limit is 8 MB (app.setup.ts).
 */
export class ScreeningListImportDto {
  @IsIn(SCREENING_LISTS as readonly string[])
  list!: ScreeningListName;

  @trimmed()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,63}$/, {
    message: "version must be 1-64 letters, digits, spaces or . _ : / ( ) -",
  })
  version!: string;

  /** When the list was delivered to the operator (UTC). */
  @IsISO8601({ strict: true })
  deliveredAt!: string;

  @IsString()
  @MaxLength(8 * 1024 * 1024)
  content!: string;

  @IsOptional()
  @IsIn(TEXT_CHARSETS as readonly string[])
  charset?: TextCharset;
}

/** `GET /admin/compliance/screening-hits?status&userId&list` */
export class ScreeningHitsQueryDto {
  @IsOptional()
  @IsIn(SCREENING_HIT_STATUSES as readonly string[])
  status?: ScreeningHitStatus;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsIn(SCREENING_LISTS as readonly string[])
  list?: ScreeningListName;
}

/** `POST /admin/compliance/screening-hits/:id/decide { decision, reason }` (`compliance.hit.decide`). */
export class ScreeningHitDecisionDto extends AdminReasonDto {
  @IsIn(["confirm", "clear"])
  decision!: "confirm" | "clear";

  /** C23: the operator wallet's signature over the request (a clear lifts the provisional freeze). */
  @IsOptional()
  @IsString()
  @Length(1, 512)
  signature?: string;
}

/** `POST /admin/compliance/screening-runs { reason, userId? }` (role `aml`): a full re-screen now, or one account. */
export class ScreeningRunDto extends AdminReasonDto {
  @IsOptional()
  @IsUUID()
  userId?: string;
}

/** `POST /admin/ramp/operations/export { from, to }` (role `export`): UTC instants, at most 31 days apart. */
export class RampOperationsExportDto {
  @IsISO8601({ strict: true })
  @Length(10, 40)
  from!: string;

  @IsISO8601({ strict: true })
  @Length(10, 40)
  to!: string;
}
