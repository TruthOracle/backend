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
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { ApprovalDecisionDto, ApprovalsQueryDto, ApproveManyDto } from "../dto/admin-controls.dto";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import type { ApiApproval, ApiApproveManyResult } from "../types";
import { adminActorOf } from "./admin.controller";

/**
 * An approval-backed route's answer (SPEC §6.5, §12.2): 202 `{approval}` while it waits for a
 * second person, 200 `{approval, result}` once executed (single control, or dual control off).
 */
export function answerApproval(res: Response, outcome: ApprovalOutcome): ApprovalOutcome {
  res.status(outcome.approval.status === "pending" ? 202 : 200);
  return outcome;
}

/**
 * Four-eyes approvals (SPEC §6.5): the queue, one approval, and the decisions. Approve needs
 * another PERSON with the action's approve roles (and, with RAMP_APPROVAL_SIGNATURES, the wallet
 * signature over `truthoracle-approval:<id>:<paramsHash>:approve`); reject by the requester
 * cancels, by another approver rejects; approve-many decides one action type, each id on its own.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/approvals")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminApprovalsController {
  constructor(private readonly approvals: AdminApprovalService) {}

  @Get()
  async list(@Query() query: ApprovalsQueryDto): Promise<{ items: ApiApproval[] }> {
    return { items: await this.approvals.list(query) };
  }

  @Get(":id")
  async get(@Param("id", ParseUUIDPipe) id: string): Promise<{ approval: ApiApproval }> {
    return { approval: await this.approvals.get(id) };
  }

  @Post("approve-many")
  @HttpCode(200)
  approveMany(
    @Body() body: ApproveManyDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiApproveManyResult> {
    return this.approvals.approveMany(
      { ids: body.ids, reason: body.reason, signatures: body.signatures ?? null },
      adminActorOf(req),
    );
  }

  /** `409 approval_precondition_changed` / `approval_failed` (`details.approval`) once decided. */
  @Post(":id/approve")
  @HttpCode(200)
  approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ApprovalDecisionDto,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalOutcome> {
    return this.approvals.approve(
      id,
      { reason: body.reason, signature: body.signature ?? null },
      adminActorOf(req),
    );
  }

  @Post(":id/reject")
  @HttpCode(200)
  reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ApprovalDecisionDto,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalOutcome> {
    return this.approvals.reject(
      id,
      { reason: body.reason, signature: body.signature ?? null },
      adminActorOf(req),
    );
  }
}
