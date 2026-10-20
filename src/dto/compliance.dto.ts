/**
 * Request DTOs of compliance (SPEC §11.2, §11.6, §12; S7a): the user's consent and the AML
 * operator's alert routes. The global ValidationPipe rejects unknown keys, so these classes are
 * the complete allow-list of what a client may send.
 */
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

import {
  COMPLIANCE_ALERT_DECISIONS,
  COMPLIANCE_ALERT_SEVERITIES,
  COMPLIANCE_ALERT_STATUSES,
  type ComplianceAlertDecision,
  type ComplianceAlertSeverity,
  type ComplianceAlertStatus,
} from "../types";
import { AdminReasonDto } from "./admin.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));

/** The free-text cap of a consent answer (F1's CONSENT_TEXT_MAX). */
export const CONSENT_TEXT_MAX = 500;

/** `POST /ramp/consent { termsVersion, actsForSelf, principal?, pepDeclared, pepDetail? }` (B4; ПВК p.31). */
export class RampConsentDto {
  @IsString()
  @Length(0, 64)
  termsVersion!: string;

  @IsBoolean()
  actsForSelf!: boolean;

  /** Required when not acting for oneself: who the user acts for (sealed). */
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(1, CONSENT_TEXT_MAX)
  principal?: string;

  @IsBoolean()
  pepDeclared!: boolean;

  /** Optional with a PEP declaration: the post or relation (sealed). */
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(1, CONSENT_TEXT_MAX)
  pepDetail?: string;
}

/** `GET /admin/compliance/alerts?status&rule&userId&orderId&severity&due&limit` */
export class ComplianceAlertsQueryDto {
  @IsOptional()
  @IsIn(COMPLIANCE_ALERT_STATUSES as readonly string[])
  status?: ComplianceAlertStatus;

  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: "rule must be a rule id (TM-ROUNDTRIP, …)" })
  rule?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsIn(COMPLIANCE_ALERT_SEVERITIES as readonly string[])
  severity?: ComplianceAlertSeverity;

  /** `overdue`: undecided and past the due date; `soon`: undecided and due within 2 h (or past). */
  @IsOptional()
  @IsIn(["overdue", "soon"])
  due?: "overdue" | "soon";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** `POST /admin/compliance/alerts/:id/decide { decision, reason, reportRef?, signature? }` (role `aml`). */
export class ComplianceAlertDecideDto extends AdminReasonDto {
  @IsIn(COMPLIANCE_ALERT_DECISIONS as readonly string[])
  decision!: ComplianceAlertDecision;

  /** `report`: the DFM special-form number. */
  @IsOptional()
  @trimmed()
  @IsString()
  @Length(1, 64)
  reportRef?: string;

  /**
   * C23: the operator wallet's signature over the request — required for a single-control clear or
   * return when RAMP_APPROVAL_SIGNATURES (a block alert's APPROVAL is signed in Approvals).
   */
  @IsOptional()
  @IsString()
  @Length(1, 512)
  signature?: string;
}

/** `POST /admin/compliance/alerts/export { from, to, status? }` (role `aml`, ≤ 31 days, UTC instants). */
export class ComplianceAlertsExportDto {
  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;

  @IsOptional()
  @IsIn(COMPLIANCE_ALERT_STATUSES as readonly string[])
  status?: ComplianceAlertStatus;
}
