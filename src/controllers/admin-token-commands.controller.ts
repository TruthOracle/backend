import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { InjectRepository } from "@nestjs/typeorm";
import type { Response } from "express";
import { Repository } from "typeorm";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import {
  TokenCommandActionDto,
  TokenCommandIdParamDto,
  TokenCommandsQueryDto,
  TokenRecordsAdoptDto,
} from "../dto/admin-controls.dto";
import {
  TokenCommandEntity,
  type TokenCommandSource,
  type TokenCommandStatus,
} from "../entities/token-command.entity";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import type { ApiAdminTokenCommand } from "../types";
import { formatAmount } from "../util/money";
import { adminActorOf } from "./admin.controller";
import { answerApproval } from "./admin-approvals.controller";

const LIST_LIMIT = 200;

/**
 * The token command ledger for operators (SPEC §7, §12.2): the commands by status / source and
 * the four-eyes resolutions — `token.command.resend|abandon|compensate` and `token.records.adopt`
 * (202 `{approval}` pending, 200 `{approval, result}` executed). Abandon states the treasury
 * holdings expected without the command (`expectedTreasuryHoldings`; default: the indexed figure
 * at request time, which the approval then binds).
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/tokens")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminTokenCommandsController {
  constructor(
    private readonly approvals: AdminApprovalService,
    @InjectRepository(TokenCommandEntity) private readonly commands: Repository<TokenCommandEntity>,
  ) {}

  @Get("commands")
  async list(@Query() query: TokenCommandsQueryDto): Promise<{ items: ApiAdminTokenCommand[] }> {
    const rows = await this.commands.find({
      where: {
        ...(query.status ? { status: query.status as TokenCommandStatus } : {}),
        ...(query.source ? { source: query.source as TokenCommandSource } : {}),
      },
      order: { createdAt: "DESC" },
      take: LIST_LIMIT,
    });
    return { items: rows.map(commandToApi) };
  }

  @Post("commands/:id/resend")
  resend(
    @Param() params: TokenCommandIdParamDto,
    @Body() body: TokenCommandActionDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("token.command.resend", params.id, {}, body, req, res);
  }

  @Post("commands/:id/abandon")
  abandon(
    @Param() params: TokenCommandIdParamDto,
    @Body() body: TokenCommandActionDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const expected = body.expectedTreasuryHoldings;
    return this.act(
      "token.command.abandon",
      params.id,
      expected ? { expectedTreasuryHoldings: expected } : {},
      body,
      req,
      res,
    );
  }

  @Post("commands/:id/compensate")
  compensate(
    @Param() params: TokenCommandIdParamDto,
    @Body() body: TokenCommandActionDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("token.command.compensate", params.id, {}, body, req, res);
  }

  /** `token.records.adopt {before}`: legacy rows for mirror records created before the cutoff (#14). */
  @Post("records/adopt")
  async adopt(
    @Body() body: TokenRecordsAdoptDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      {
        action: "token.records.adopt",
        subjectId: body.instrumentId ?? "*",
        params: { before: body.before },
        reason: body.reason,
      },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  private async act(
    action: string,
    id: string,
    params: Record<string, unknown>,
    body: TokenCommandActionDto,
    req: AuthedRequest,
    res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      { action, subjectId: id, params, reason: body.reason },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }
}

export function commandToApi(c: TokenCommandEntity): ApiAdminTokenCommand {
  return {
    commandId: c.commandId,
    kind: c.kind,
    instrumentAdmin: c.instrumentAdmin,
    instrumentId: c.instrumentId,
    partyId: c.partyId,
    amount: formatAmount(c.amount),
    source: c.source,
    ref: c.ref,
    status: c.status,
    attempts: c.attempts,
    lastPostAt: c.lastPostAt?.toISOString() ?? null,
    lastError: c.lastError,
    lastHttpStatus: c.lastHttpStatus,
    updateId: c.updateId,
    recordedAmount: c.recordedAmount === null ? null : formatAmount(c.recordedAmount),
    recordedAt: c.recordedAt?.toISOString() ?? null,
    resolvedBy: c.resolvedBy,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
