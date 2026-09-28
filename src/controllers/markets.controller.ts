import { Controller, Get, Param, ParseIntPipe, Query, UseInterceptors } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import { ActivityQueryDto, MarketsQueryDto, PriceHistoryQueryDto } from "../dto/ledger.dto";
import { MarketsService } from "../services/markets.service";
import type {
  ApiAttestation,
  ApiMarket,
  ApiMarketEvent,
  ApiModelForecast,
  ApiPage,
  ApiPricePoint,
} from "../types";
import { ApiError } from "../util/errors";
import { LedgerOffsetInterceptor } from "../util/ledger-offset.interceptor";

/**
 * Public market reads over the ledger index (docs/API.md "Markets"). Every market, its state,
 * activity and price history is public information on the ledger (the market is visible to
 * every trader); holders are not (operator route under `/admin/ledger`). No session needed;
 * every response carries `x-ledger-offset`.
 */
@ApiTags("markets")
@Controller("markets")
@Public()
@UseInterceptors(LedgerOffsetInterceptor)
export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  @Get()
  list(@Query() query: MarketsQueryDto): Promise<ApiPage<ApiMarket>> {
    return this.markets.list({
      status: query.status,
      category: query.category,
      q: query.q,
      sort: query.sort,
      includeArchived: query.includeArchived ?? false,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  @Get("categories")
  categories(): Promise<{ category: string; markets: number }[]> {
    return this.markets.categories();
  }

  /** Includes `createdEventBlob` — what a user-signed trade discloses. */
  @Get(":marketId")
  get(@Param("marketId", ParseIntPipe) marketId: number): Promise<{ market: ApiMarket }> {
    return this.markets.get(marketId).then((market) => ({ market }));
  }

  @Get(":marketId/activity")
  activity(
    @Param("marketId", ParseIntPipe) marketId: number,
    @Query() query: ActivityQueryDto,
  ): Promise<ApiPage<ApiMarketEvent>> {
    return this.markets.activity({
      marketId,
      kind: query.kind,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  /** buy · sell · swap · split · merge only. */
  @Get(":marketId/trades")
  trades(
    @Param("marketId", ParseIntPipe) marketId: number,
    @Query() query: ActivityQueryDto,
  ): Promise<ApiPage<ApiMarketEvent>> {
    return this.markets.trades({
      marketId,
      kind: query.kind,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  @Get(":marketId/price-history")
  priceHistory(
    @Param("marketId", ParseIntPipe) marketId: number,
    @Query() query: PriceHistoryQueryDto,
  ): Promise<{ marketId: number; resolution: string; points: ApiPricePoint[] }> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to)
      throw new ApiError(400, "validation_failed", "from must not be after to");
    return this.markets.priceHistory(marketId, {
      from,
      to,
      resolution: query.resolution ?? "raw",
      limit: query.limit ?? 1000,
    });
  }

  @Get(":marketId/forecasts")
  forecasts(
    @Param("marketId", ParseIntPipe) marketId: number,
  ): Promise<{ forecasts: ApiModelForecast[] }> {
    return this.markets.forecasts(marketId).then((forecasts) => ({ forecasts }));
  }

  @Get(":marketId/attestations")
  attestations(
    @Param("marketId", ParseIntPipe) marketId: number,
  ): Promise<{ attestations: ApiAttestation[] }> {
    return this.markets.attestations(marketId).then((attestations) => ({ attestations }));
  }
}
