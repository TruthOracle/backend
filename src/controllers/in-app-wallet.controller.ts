import { Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, actorOf, principalOf } from "../auth/request";
import { DepositService } from "../services/deposit.service";
import { RateLimitService } from "../services/rate-limit.service";
import type { InAppWalletOverview, ReconcileResult } from "../types";

/**
 * In-app wallet overview + deposit reconciliation (docs/API.md "In-app wallet"; ARCHITECTURE
 * §8.3). Amounts never come from the client: the service derives them from the treasury history
 * and the ledger. Payout routes live in PayoutsController (`in-app-wallet/payouts`).
 */
@ApiTags("in-app-wallet")
@Controller("in-app-wallet")
export class InAppWalletController {
  constructor(
    private readonly deposits: DepositService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** May serve the 15 s cached ledger/history view; only reconcile insists on fresh reads. */
  @Get()
  overview(@Req() req: AuthedRequest): Promise<InAppWalletOverview> {
    const { user } = principalOf(req);
    return this.deposits.overview(user.id);
  }

  /**
   * `409 no_primary_wallet | deposit_in_progress | deposit_attribution_drift | kyc_duplicate_identity`.
   * Rate limit: reconcile 30/min/user (§13).
   */
  @Post("deposits/reconcile")
  @HttpCode(200)
  async reconcile(@Req() req: AuthedRequest): Promise<ReconcileResult> {
    const { user } = principalOf(req);
    await this.rateLimit.enforce("reconcile", { userId: user.id });
    return this.deposits.reconcile(user.id, actorOf(req));
  }
}
