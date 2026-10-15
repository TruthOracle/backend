import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import {
  ManualGrantDto,
  RewardGrantsQueryDto,
  RewardRuleParamDto,
  UpdateRewardRuleDto,
} from "../dto/rewards.dto";
import { RewardsService } from "../services/rewards.service";
import type { ApiPage, ApiRewardGrant, ApiRewardRule, ApiRewardsFloat } from "../types";
import { parseAmount } from "../util/money";
import { adminActorOf } from "./admin.controller";

/**
 * Operator side of the rewards (docs/API.md "Admin — rewards"; docs/TOKENS.md §4.6): the rules
 * and their switches, manual grants, the grants queue with its statuses and the float the rule
 * guards. Same guard chain as AdminController; every mutation requires a `reason` and is audited.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/rewards")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminRewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Get("rules")
  async rules(): Promise<{ rules: ApiRewardRule[] }> {
    const rows = await this.rewards.listRules();
    return { rules: rows.map((r) => this.rewards.toApiRule(r)) };
  }

  /** `400 validation_failed` names the offending parameter; `404 not_found` for an unknown rule id. */
  @Put("rules/:id")
  @HttpCode(200)
  async updateRule(
    @Param() params: RewardRuleParamDto,
    @Body() body: UpdateRewardRuleDto,
    @Req() req: AuthedRequest,
  ): Promise<{ rule: ApiRewardRule }> {
    const row = await this.rewards.updateRule(
      params.id,
      { params: body.params, enabled: body.enabled },
      adminActorOf(req),
      body.reason,
    );
    return { rule: this.rewards.toApiRule(row) };
  }

  /** The grant is written `queued`; the processor submits it on its next pass (`GET /admin/rewards/grants` follows it). */
  @Post("grant")
  @HttpCode(200)
  async grant(
    @Body() body: ManualGrantDto,
    @Req() req: AuthedRequest,
  ): Promise<{ grant: ApiRewardGrant }> {
    const row = await this.rewards.grantManual(
      {
        userId: body.userId,
        party: body.party,
        amount: parseAmount(body.amount),
        reason: body.reason,
      },
      adminActorOf(req),
    );
    return { grant: this.rewards.toApiGrant(row) };
  }

  @Get("grants")
  grants(@Query() query: RewardGrantsQueryDto): Promise<ApiPage<ApiRewardGrant>> {
    return this.rewards.listGrants({
      status: query.status,
      userId: query.userId,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  @Get("float")
  float(): Promise<ApiRewardsFloat> {
    return this.rewards.float();
  }
}
