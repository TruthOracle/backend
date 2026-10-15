import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { BurnTokensDto, MintTokensDto } from "../dto/tokens.dto";
import { TokenOperationsService } from "../services/token-operations.service";
import type { ApiTokenMintResult, ApiTokenStatus } from "../types";
import { parseAmount } from "../util/money";
import { adminActorOf } from "./admin.controller";

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
  constructor(private readonly tokens: TokenOperationsService) {}

  /**
   * `400 validation_failed` (amount finer than the instrument, `creditUserId` with a non-treasury
   * target) | `404 instrument_unknown` | `409 instrument_disabled` | `503 token_app_unconfigured`
   * | `404 not_found` / `403 user_suspended` / `409 no_primary_wallet` (the credited account) |
   * `502 upstream_failed` (token-app; or the credit after a landed mint — `details.mint`).
   */
  @Post("mint")
  @HttpCode(200)
  mint(@Body() body: MintTokensDto, @Req() req: AuthedRequest): Promise<ApiTokenMintResult> {
    return this.tokens.mint(
      {
        instrument: { admin: body.instrument.admin, id: body.instrument.id },
        amount: parseAmount(body.amount),
        to: body.to,
        creditUserId: body.creditUserId,
        reason: body.reason,
      },
      adminActorOf(req),
    );
  }

  @Post("burn")
  @HttpCode(200)
  burn(@Body() body: BurnTokensDto, @Req() req: AuthedRequest): Promise<ApiTokenMintResult> {
    return this.tokens.burn(
      {
        instrument: { admin: body.instrument.admin, id: body.instrument.id },
        amount: parseAmount(body.amount),
        party: body.party,
        reason: body.reason,
      },
      adminActorOf(req),
    );
  }

  @Get("status")
  status(): Promise<ApiTokenStatus> {
    return this.tokens.status();
  }
}
