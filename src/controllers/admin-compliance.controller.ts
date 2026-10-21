import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession, RequireRoles } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import {
  ComplianceAlertDecideDto,
  ComplianceAlertsExportDto,
  ComplianceAlertsQueryDto,
} from "../dto/compliance.dto";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import { ComplianceAlertsService } from "../services/compliance-alerts.service";
import { RateLimitService } from "../services/rate-limit.service";
import { type ApiConsentDeclaration, RampConsentService } from "../services/ramp-consent.service";
import type { ApiApproval, ApiComplianceAlert } from "../types";
import { adminActorOf } from "./admin.controller";
import { answerApproval } from "./admin-approvals.controller";

/**
 * Compliance alerts for the AML officer (SPEC §11.6, §12.2; S7a — screening and freezes are S7b's
 * controller under the same prefix): the queue (undecided first by legal due date), one alert with
 * its decision approvals, the decision (`compliance.alert.decide`: a review alert is decided at once
 * by `aml`; a block alert waits for another person with `approver` — 202 pending / 200 executed),
 * and the CSV export (role `aml`, ≤ 31 days, audited, the admin_export limit).
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/compliance/alerts")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminComplianceController {
  constructor(
    private readonly alerts: ComplianceAlertsService,
    private readonly approvals: AdminApprovalService,
    private readonly rateLimit: RateLimitService,
    private readonly consents: RampConsentService,
  ) {}

  @Get()
  list(
    @Query() query: ComplianceAlertsQueryDto,
  ): Promise<{ items: ApiComplianceAlert[]; nextCursor: null }> {
    return this.alerts.list(query);
  }

  /** `{alert, approvals}`: the alert and every decision request on it, newest first. */
  @Get(":id")
  async get(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ alert: ApiComplianceAlert; approvals: ApiApproval[] }> {
    const alert = await this.alerts.get(id);
    const approvals = await this.approvals.list({
      action: "compliance.alert.decide",
      subjectType: "compliance_alert",
      subjectId: id,
    });
    return { alert, approvals };
  }

  /**
   * C13: the declaration a TM-PRINCIPAL / TM-PEP alert was raised on (role `aml`): the principal or
   * the PEP detail unsealed for the officer deciding it — audited, never cached.
   */
  @Get(":id/declaration")
  @RequireRoles("aml")
  async declaration(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ declaration: ApiConsentDeclaration }> {
    res.setHeader("Cache-Control", "no-store");
    const alert = await this.alerts.get(id);
    return { declaration: await this.consents.declarationOf(alert, adminActorOf(req)) };
  }

  /**
   * `clear` releases what the alert holds; `report` needs `reportRef`; `escalate` keeps the hold;
   * `return` (C25) ends it without releasing (the payment goes back). Clear and return carry the
   * operator's signature over the request when RAMP_APPROVAL_SIGNATURES (C23; 400 gives the message).
   */
  @Post(":id/decide")
  @RequireRoles("aml")
  async decide(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ComplianceAlertDecideDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      {
        action: "compliance.alert.decide",
        subjectId: id,
        params: { decision: body.decision, reportRef: body.reportRef ?? null },
        reason: body.reason,
        signature: body.signature ?? null,
      },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  /** The alerts raised in [from, to] (UTC instants, ≤ 31 days) as a human-mode CSV. */
  @Post("export")
  @HttpCode(200)
  @RequireRoles("aml")
  async export(
    @Body() body: ComplianceAlertsExportDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const actor = adminActorOf(req);
    await this.rateLimit.enforce("admin_export", { userId: actor.userId });
    const file = await this.alerts.export(
      { from: new Date(body.from), to: new Date(body.to), status: body.status },
      actor,
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("X-Export-Id", file.exportId);
    res.setHeader("Cache-Control", "no-store");
    return file.csv;
  }
}
