import { Controller, Get, Query, Req, UseInterceptors } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, principalOf } from "../auth/request";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import { ActivityQueryDto, PositionsQueryDto } from "../dto/ledger.dto";
import { PortfolioService } from "../services/portfolio.service";
import type { ApiLiquidityPosition, ApiMarketEvent, ApiPage, ApiPosition } from "../types";
import { LedgerOffsetInterceptor } from "../util/ledger-offset.interceptor";

/**
 * The signed-in account's ledger activity (docs/API.md "Portfolio"): positions, LP claims and
 * trades for the primary party and every active linked wallet, read from the index as the
 * treasury. Session-only (user sessions; an admin session has no portfolio).
 */
@ApiTags("portfolio")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("me")
@UseInterceptors(LedgerOffsetInterceptor)
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get("positions")
  async positions(
    @Query() query: PositionsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<{ parties: string[]; positions: ApiPosition[] }> {
    const { user } = principalOf(req);
    return this.portfolio.positions(await this.portfolio.partiesOf(user), query.status ?? "open");
  }

  @Get("liquidity")
  async liquidity(
    @Query() query: PositionsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<{ parties: string[]; positions: ApiLiquidityPosition[] }> {
    const { user } = principalOf(req);
    return this.portfolio.liquidity(await this.portfolio.partiesOf(user), query.status ?? "open");
  }

  @Get("trades")
  async trades(
    @Query() query: ActivityQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiPage<ApiMarketEvent>> {
    const { user } = principalOf(req);
    return this.portfolio.trades(await this.portfolio.partiesOf(user), {
      marketId: query.marketId,
      kind: query.kind,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  /** Every market choice the account's parties exercised (trades, liquidity, proposals, redemptions, forecasts). */
  @Get("activity")
  async activity(
    @Query() query: ActivityQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiPage<ApiMarketEvent>> {
    const { user } = principalOf(req);
    return this.portfolio.activity(await this.portfolio.partiesOf(user), {
      marketId: query.marketId,
      kind: query.kind,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }
}
