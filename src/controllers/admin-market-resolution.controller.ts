import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { MarketResolutionDto } from "../dto/market-resolution.dto";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import { MARKET_RESOLVE_ACTION, marketIdParam } from "../services/market-resolution.logic";
import { MarketResolutionService } from "../services/market-resolution.service";
import type { ApiMarketResolution } from "../types";
import { ApiError } from "../util/errors";
import { adminActorOf } from "./admin.controller";
import { answerApproval } from "./admin-approvals.controller";

/**
 * Resolving and voiding markets (review F0; docs/API.md "Admin — catalog"): the only route that
 * resolves or voids any market, whatever its collateral. `:marketId` is the on-ledger market id.
 * The POST is the four-eyes `market.resolve` (`ops` asks, another person with `approver`
 * approves): 202 `{approval}` while it waits, 200 `{approval, result}` once executed.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/markets")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminMarketResolutionController {
  constructor(
    private readonly resolution: MarketResolutionService,
    private readonly approvals: AdminApprovalService,
  ) {}

  /** Role `ops` or `approver`: the decision fields, the windows and the choices open by the backend clock. */
  @Get(":marketId/resolution")
  view(@Param("marketId") raw: string, @Req() req: AuthedRequest): Promise<ApiMarketResolution> {
    const { roles } = adminActorOf(req);
    if (!roles.includes("ops") && !roles.includes("approver"))
      throw new ApiError(403, "role_required", "this needs the ops or approver role", {
        roles: ["ops", "approver"],
      });
    return this.resolution.view(marketIdParam(raw));
  }

  /** `{choice, outcome?, sourceUri?, attestationCids?, reason, signature?}` → `market.resolve`. */
  @Post(":marketId/resolution")
  async request(
    @Param("marketId") raw: string,
    @Body() body: MarketResolutionDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const params: Record<string, unknown> = { choice: body.choice };
    if (body.outcome !== undefined) params.outcome = body.outcome;
    if (body.sourceUri !== undefined) params.sourceUri = body.sourceUri;
    if (body.attestationCids !== undefined) params.attestationCids = body.attestationCids;
    const outcome = await this.approvals.request(
      {
        action: MARKET_RESOLVE_ACTION,
        subjectId: marketIdParam(raw),
        params,
        reason: body.reason,
        signature: body.signature ?? null,
      },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }
}
