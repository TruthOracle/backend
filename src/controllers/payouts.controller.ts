import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { ClientIp, CurrentSession, CurrentUser } from "../auth/decorators";
import { PayoutCidParamDto } from "../dto/payouts.dto";
import type { SessionEntity } from "../entities/session.entity";
import type { UserEntity } from "../entities/user.entity";
import { PayoutService } from "../services/payout.service";
import { RateLimitService } from "../services/rate-limit.service";
import type { ApiPayout, PayoutStatus } from "../types";

/**
 * User payout routes (docs/API.md "In-app wallet"). Both are session-only (the global
 * SessionGuard); ownership — the payee must be one of the caller's wallets — is enforced inside
 * `PayoutService.settle`, which answers 404 for anything else.
 */
@ApiTags("payouts")
@Controller("in-app-wallet/payouts")
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Ledger PendingPayouts addressed to the user's wallets merged with their `to_payouts` rows. */
  @Get()
  async list(@CurrentUser() user: UserEntity): Promise<{ payouts: ApiPayout[] }> {
    return { payouts: await this.payouts.listMergedForUser(user.id) };
  }

  /**
   * `200 { payout, mode }` | `404 payout_not_found` | `409 kyc_required` | `409 payout_blocked`
   * (`details.status`). The KYC gate is evaluated on the payee's account (= the caller's, after
   * the ownership check). Rate-limited 30/min per user (ARCHITECTURE §13).
   */
  @Post(":cid/settle")
  @HttpCode(200)
  async settle(
    @Param() params: PayoutCidParamDto,
    @CurrentUser() user: UserEntity,
    @CurrentSession() session: SessionEntity,
    @ClientIp() ip: string,
  ): Promise<{ payout: ApiPayout; mode: "external" | "in_app" | "already_settled" }> {
    await this.rateLimit.enforce("settle", { userId: user.id });
    const result = await this.payouts.settle(params.cid, { type: "user", userId: user.id, sessionId: session.id, ip });
    return { payout: this.payouts.toApi(result.payout, result.onLedger), mode: result.mode };
  }
}

export type { PayoutStatus };
