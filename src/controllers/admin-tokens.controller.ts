import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { BurnTokensDto, MintTokensDto } from "../dto/tokens.dto";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import { TokenOperationsService } from "../services/token-operations.service";
import type { ApiTokenMintResult, ApiTokenStatus } from "../types";
import { ApiError } from "../util/errors";
import { parseAmount } from "../util/money";
import { adminActorOf } from "./admin.controller";
import { answerApproval } from "./admin-approvals.controller";

/**
 * The operator's token operations (docs/API.md "Admin — tokens"; docs/TOKENS.md §4.7): mint and
 * burn through Cantor8's token-app — with the mint-and-credit on-ramp — and the status view.
 * Same guard chain as AdminController; every mutation requires a `reason` and is audited.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/tokens")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminTokensController {
  constructor(
    private readonly tokens: TokenOperationsService,
    private readonly approvals: AdminApprovalService,
  ) {}

  /**
   * Mainnet, another instrument than the ramp's (SPEC §7, X12 d): S1's `403 details.approvalAction`
   * becomes the four-eyes request it names — 202 `{approval}` (200 `{approval, result}` executed).
   */
  private async orApproval(
    run: () => Promise<ApiTokenMintResult>,
    request: { action: string; subjectId: string; params: Record<string, unknown>; reason: string },
    req: AuthedRequest,
    res: Response,
  ): Promise<ApiTokenMintResult | ApprovalOutcome> {
    try {
      return await run();
    } catch (err) {
      if (!(
        ApiError.is(err) &&
        err.status === 403 &&
        err.details?.approvalAction === request.action
      ))
        throw err;
      return answerApproval(res, await this.approvals.request(request, adminActorOf(req)));
    }
  }

  /**
   * `400 validation_failed` (amount finer than the instrument, `creditUserId` with a non-treasury
   * target) | `404 instrument_unknown` | `409 instrument_disabled` | `503 token_app_unconfigured`
   * | `404 not_found` / `403 user_suspended` / `409 no_primary_wallet` (the credited account) |
   * `409 token_app_cap` | `403 forbidden` (mainnet: the ramp instrument, mint-and-credit, or no
   * four-eyes approval) | `502 token_app_unauthorized|forbidden|invalid_request|upstream_failed`
   * (token-app refused or did not confirm the command — `details.mint`; the command row stays).
   * With `creditUserId` the answer's `credit.status` is `pending`: the Deposit is submitted by the
   * token sync once token-app records the mint (docs/RAMP.md §7).
   */
  @Post("mint")
  @HttpCode(200)
  mint(
    @Body() body: MintTokensDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiTokenMintResult | ApprovalOutcome> {
    return this.orApproval(
      () =>
        this.tokens.mint(
          {
            instrument: { admin: body.instrument.admin, id: body.instrument.id },
            amount: parseAmount(body.amount),
            to: body.to,
            creditUserId: body.creditUserId,
            reason: body.reason,
          },
          adminActorOf(req),
        ),
      {
        action: "token.admin_mint",
        subjectId: `${body.instrument.admin}:${body.instrument.id}`,
        params: { amount: body.amount, party: body.to ?? "treasury" },
        reason: body.reason,
      },
      req,
      res,
    );
  }

  @Post("burn")
  @HttpCode(200)
  burn(
    @Body() body: BurnTokensDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiTokenMintResult | ApprovalOutcome> {
    return this.orApproval(
      () =>
        this.tokens.burn(
          {
            instrument: { admin: body.instrument.admin, id: body.instrument.id },
            amount: parseAmount(body.amount),
            party: body.party,
            reason: body.reason,
          },
          adminActorOf(req),
        ),
      {
        action: "token.admin_burn",
        subjectId: `${body.instrument.admin}:${body.instrument.id}`,
        params: { amount: body.amount, party: body.party },
        reason: body.reason,
      },
      req,
      res,
    );
  }

  @Get("status")
  status(): Promise<ApiTokenStatus> {
    return this.tokens.status();
  }
}
