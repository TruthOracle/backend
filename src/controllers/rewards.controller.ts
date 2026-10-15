import { Controller, Get, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, principalOf } from "../auth/request";
import { RewardsService } from "../services/rewards.service";
import type { ApiRewardsOverview } from "../types";

/**
 * The account's rewards (docs/API.md "Rewards"; docs/TOKENS.md §4.6): its rewards wallet as the
 * ledger shows it, the totals credited and still in flight, and the last grants with their
 * status. Session-only (user sessions; an admin session has no rewards). `404 not_found` on a
 * platform without a rewards instrument.
 */
@ApiTags("rewards")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("me/rewards")
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Get()
  overview(@Req() req: AuthedRequest): Promise<ApiRewardsOverview> {
    const { user } = principalOf(req);
    return this.rewards.overview(user.id);
  }
}
