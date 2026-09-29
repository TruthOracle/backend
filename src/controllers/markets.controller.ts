import { Controller, Get, Param, Query, UseInterceptors } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import {
  ActivityQueryDto,
  CandlesQueryDto,
  MarketsQueryDto,
  PriceHistoryQueryDto,
} from "../dto/ledger.dto";
import { QuoteQueryDto } from "../dto/orders.dto";
import { CandlesService } from "../services/candles.service";
import { MarketsService } from "../services/markets.service";
import { QuoteService } from "../services/quote.service";
import type {
  ApiAttestation,
  ApiCandlesticks,
  ApiMarket,
  ApiMarketEvent,
  ApiModelForecast,
  ApiPage,
  ApiPricePoint,
  ApiQuote,
} from "../types";
import { ApiError } from "../util/errors";
import { LedgerOffsetInterceptor } from "../util/ledger-offset.interceptor";
import { parseCC } from "../util/money";

/**
 * Public market reads over the ledger index (docs/API.md "Markets", "Candlesticks", "Quotes and
 * orders"). Every market, its state, activity, price history, candles and an AMM quote are public
 * information (the market is visible to every trader); holders are not (operator route under
 * `/admin/ledger`). `:market` is a numeric `marketId` or a ticker. No session needed; every
 * response carries `x-ledger-offset`.
 */
@ApiTags("markets")
@Controller("markets")
@Public()
@UseInterceptors(LedgerOffsetInterceptor)
export class MarketsController {
  constructor(
    private readonly markets: MarketsService,
    private readonly candles: CandlesService,
    private readonly quotes: QuoteService,
  ) {}

  @Get()
  async list(@Query() query: MarketsQueryDto): Promise<ApiPage<ApiMarket>> {
    const page = await this.markets.list({
      status: query.status,
      category: query.category,
      event: query.event,
      series: query.series,
      tickers: query.tickers ? query.tickers.split(",") : undefined,
      q: query.q,
      sort: query.sort,
      includeArchived: query.includeArchived ?? false,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
    if (query.withSparkline) {
      const sparklines = await this.candles.sparklines(page.items.map((m) => m.marketId));
      for (const m of page.items) {
        const s = sparklines.get(m.marketId);
        if (s) m.sparkline = s;
      }
    }
    return page;
  }

  @Get("categories")
  categories(): Promise<{ category: string; markets: number }[]> {
    return this.markets.categories();
  }

  /** Includes `createdEventBlob` — what a user-signed trade discloses. */
  @Get(":market")
  get(@Param("market") ref: string): Promise<{ market: ApiMarket }> {
    return this.markets.get(ref).then((market) => ({ market }));
  }

  @Get(":market/activity")
  async activity(
    @Param("market") ref: string,
    @Query() query: ActivityQueryDto,
  ): Promise<ApiPage<ApiMarketEvent>> {
    const market = await this.markets.resolve(ref);
    return this.markets.activity({
      marketId: market.marketId,
      kind: query.kind,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  /** buy · sell · swap · split · merge only; `cursor=` switches to the keyset feed (`nextCursor`). */
  @Get(":market/trades")
  async trades(
    @Param("market") ref: string,
    @Query() query: ActivityQueryDto,
  ): Promise<ApiPage<ApiMarketEvent>> {
    const market = await this.markets.resolve(ref);
    return this.markets.trades({
      marketId: market.marketId,
      kind: query.kind,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
      cursor: query.cursor,
    });
  }

  @Get(":market/price-history")
  async priceHistory(
    @Param("market") ref: string,
    @Query() query: PriceHistoryQueryDto,
  ): Promise<{ marketId: number; resolution: string; points: ApiPricePoint[] }> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to)
      throw new ApiError(400, "validation_failed", "from must not be after to");
    const market = await this.markets.resolve(ref);
    return this.markets.priceHistory(market.marketId, {
      from,
      to,
      resolution: query.resolution ?? "raw",
      limit: query.limit ?? 1000,
    });
  }

  /** Kalshi-style candles: dense, one per period, carried forward through quiet periods (docs/MARKETS.md §5). */
  @Get(":market/candlesticks")
  candlesticks(
    @Param("market") ref: string,
    @Query() query: CandlesQueryDto,
  ): Promise<ApiCandlesticks> {
    return this.candles.candlesticks(ref, {
      startTs: query.startTs,
      endTs: query.endTs,
      periodMinutes: query.periodInterval ?? 60,
    });
  }

  /** An AMM quote against the indexed market version — advisory; the bounds are what a trade must carry (docs/MARKETS.md §6). */
  @Get(":market/quote")
  async quote(@Param("market") ref: string, @Query() query: QuoteQueryDto): Promise<ApiQuote> {
    const market = await this.markets.resolve(ref);
    return this.quotes.quote(market, {
      action: query.action,
      side: query.side,
      amountCC: query.amountCC === undefined ? undefined : parseCC(query.amountCC),
      shares: query.shares === undefined ? undefined : parseCC(query.shares),
      slippageBps: query.slippageBps,
    });
  }

  @Get(":market/forecasts")
  async forecasts(@Param("market") ref: string): Promise<{ forecasts: ApiModelForecast[] }> {
    const market = await this.markets.resolve(ref);
    return this.markets.forecasts(market.marketId).then((forecasts) => ({ forecasts }));
  }

  @Get(":market/attestations")
  async attestations(
    @Param("market") ref: string,
  ): Promise<{ attestations: ApiAttestation[] }> {
    const market = await this.markets.resolve(ref);
    return this.markets.attestations(market.marketId).then((attestations) => ({ attestations }));
  }
}
