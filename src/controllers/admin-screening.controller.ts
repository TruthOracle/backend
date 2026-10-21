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
import { AdminReasonDto } from "../dto/admin.dto";
import {
  ComplianceFreezeDto,
  ComplianceFreezesQueryDto,
  ScreeningHitDecisionDto,
  ScreeningHitsQueryDto,
  ScreeningListImportDto,
  ScreeningRunDto,
} from "../dto/compliance-screening.dto";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import { ComplianceFreezeService } from "../services/compliance-freeze.service";
import { ComplianceScreeningService } from "../services/compliance-screening.service";
import { RateLimitService } from "../services/rate-limit.service";
import type {
  ApiComplianceFreeze,
  ApiScreeningHit,
  ApiScreeningHitDetail,
  ApiScreeningImport,
  ApiScreeningList,
  ApiScreeningRun,
} from "../types";
import { ApiError } from "../util/errors";
import { adminActorOf } from "./admin.controller";
import { answerApproval } from "./admin-approvals.controller";

/**
 * Screening and freezes for the AML officer (SPEC §11.6, §12.2; B1, B3): freezes (placed at once
 * by `aml`; lifted by the four-eyes `compliance.freeze.lift` — 202 pending / 200 executed), list
 * imports (`aml`, base64 normalized CSV up to the 8 MB body, admin_import limit; every account is
 * re-screened), hits and their decisions (`compliance.hit.decide`, single control, `aml`), and the
 * re-screens. Hits, lists and runs are `aml` reads; the freezes list is open to every operator (an
 * approver deciding a lift needs it).
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/compliance")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminScreeningController {
  constructor(
    private readonly freezes: ComplianceFreezeService,
    private readonly screening: ComplianceScreeningService,
    private readonly approvals: AdminApprovalService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ───────────────────────────────────────────── freezes ────────────────────────────────────

  @Get("freezes")
  async listFreezes(
    @Query() query: ComplianceFreezesQueryDto,
  ): Promise<{ items: ApiComplianceFreeze[] }> {
    return { items: await this.freezes.list(query) };
  }

  @Get("freezes/:id")
  async getFreeze(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ freeze: ApiComplianceFreeze }> {
    return { freeze: await this.freezes.get(id) };
  }

  /** At once (role `aml`): a freeze only reduces risk. `409 freeze_active` when one is active. */
  @Post("freezes")
  @HttpCode(200)
  @RequireRoles("aml")
  async freeze(
    @Body() body: ComplianceFreezeDto,
    @Req() req: AuthedRequest,
  ): Promise<{ freeze: ApiComplianceFreeze }> {
    return { freeze: await this.freezes.freeze(body, adminActorOf(req)) };
  }

  /** Four-eyes `compliance.freeze.lift` (aml requests, an approver approves). */
  @Post("freezes/:id/lift")
  async lift(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      { action: "compliance.freeze.lift", subjectId: id, reason: body.reason },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  // ───────────────────────────────────────────── lists ──────────────────────────────────────

  @Get("screening-lists")
  @RequireRoles("aml")
  async lists(): Promise<{ items: ApiScreeningList[] }> {
    return { items: await this.screening.listLists() };
  }

  @Post("screening-lists")
  @HttpCode(200)
  @RequireRoles("aml")
  async importList(
    @Body() body: ScreeningListImportDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiScreeningImport> {
    const actor = adminActorOf(req);
    await this.rateLimit.enforce("admin_import", { userId: actor.userId });
    return this.screening.importList(
      {
        list: body.list,
        version: body.version,
        deliveredAt: new Date(body.deliveredAt),
        content: body.content,
        charset: body.charset ?? "utf-8",
      },
      actor,
    );
  }

  // ───────────────────────────────────────────── hits ───────────────────────────────────────

  @Get("screening-hits")
  @RequireRoles("aml")
  async hits(@Query() query: ScreeningHitsQueryDto): Promise<{ items: ApiScreeningHit[] }> {
    return { items: await this.screening.listHits(query) };
  }

  /** The hit and the account's verified identity (decrypted for the AML officer; the read is audited). */
  @Get("screening-hits/:id")
  @RequireRoles("aml")
  hit(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<ApiScreeningHitDetail> {
    return this.screening.hitDetail(id, adminActorOf(req));
  }

  /**
   * `compliance.hit.decide` (single control, `aml`): confirm keeps the freeze, clear lifts the
   * provisional one — signed by the operator's wallet when RAMP_APPROVAL_SIGNATURES (C23: an
   * unsigned clear answers 400 with the message to sign).
   */
  @Post("screening-hits/:id/decide")
  async decide(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ScreeningHitDecisionDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      {
        action: "compliance.hit.decide",
        subjectId: id,
        params: { decision: body.decision },
        reason: body.reason,
        signature: body.signature ?? null,
      },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  // ───────────────────────────────────────────── re-screens ─────────────────────────────────

  @Get("screening-runs")
  @RequireRoles("aml")
  async runs(): Promise<{ items: ApiScreeningRun[] }> {
    return { items: await this.screening.listRuns() };
  }

  /** A full re-screen now (`409 rescreen_running` while one runs), or one account (`userId`). */
  @Post("screening-runs")
  @HttpCode(200)
  @RequireRoles("aml")
  async rescreen(
    @Body() body: ScreeningRunDto,
    @Req() req: AuthedRequest,
  ): Promise<{ run: ApiScreeningRun }> {
    const actor = adminActorOf(req);
    if (body.userId)
      return { run: await this.screening.screenUser(body.userId, "admin", actor.userId) };
    const run = await this.screening.rescreen("admin", actor.userId);
    if (!run) throw new ApiError(409, "rescreen_running", "a re-screen is already running");
    return { run };
  }
}
