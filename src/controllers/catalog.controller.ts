import { Controller, Get, Param, Query, UseInterceptors } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import {
  CatalogInstrumentQueryDto,
  EventListQueryDto,
  EventTradesQueryDto,
  SeriesListQueryDto,
} from "../dto/catalog.dto";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import { CandlesQueryDto } from "../dto/ledger.dto";
import { CandlesService } from "../services/candles.service";
import { CatalogService } from "../services/catalog.service";
import {
  parseInstrumentKey,
  type ApiEvent,
  type ApiEventCandlesticks,
  type ApiMarketEvent,
  type ApiPage,
  type ApiSeries,
  type InstrumentId,
} from "../types";
import { LedgerOffsetInterceptor } from "../util/ledger-offset.interceptor";

/** `?instrument=<admin>:<id>` → the pair, or undefined when absent (the DTO validated the form). */
function instrumentOf(raw: string | undefined): InstrumentId | undefined {
  return raw ? (parseInstrumentKey(raw) ?? undefined) : undefined;
}

/**
 * Public catalog reads (docs/API.md "Catalog"; docs/MARKETS.md §2–§3): series and events, with
 * the member markets nested on request. Everything derived (event status, volume, close time)
 * comes from the ledger index, so the responses carry `x-ledger-offset` like the market reads.
 * Listings are per instrument (`?instrument=`, default the default collateral — docs/TOKENS.md §4.5).
 */
@ApiTags("catalog")
@Controller()
@Public()
@UseInterceptors(LedgerOffsetInterceptor)
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly candles: CandlesService,
  ) {}

  @Get("series")
  listSeries(@Query() query: SeriesListQueryDto): Promise<ApiPage<ApiSeries>> {
    return this.catalog.listSeries({
      category: query.category,
      status: query.status,
      q: query.q,
      instrument: instrumentOf(query.instrument),
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  @Get("series/:ticker")
  getSeries(
    @Param("ticker") ticker: string,
    @Query() query: CatalogInstrumentQueryDto,
  ): Promise<{ series: ApiSeries; events: ApiEvent[] }> {
    return this.catalog.getSeries(ticker, instrumentOf(query.instrument));
  }

  @Get("events")
  listEvents(@Query() query: EventListQueryDto): Promise<ApiPage<ApiEvent>> {
    return this.catalog.listEvents({
      series: query.series,
      status: query.status,
      category: query.category,
      q: query.q,
      sort: query.sort,
      instrument: instrumentOf(query.instrument),
      withNestedMarkets: query.withNestedMarkets ?? false,
      includeArchived: query.includeArchived ?? false,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  /** Always nests the member markets. */
  @Get("events/:ticker")
  getEvent(@Param("ticker") ticker: string): Promise<{ event: ApiEvent }> {
    return this.catalog.getEvent(ticker).then((event) => ({ event }));
  }

  /** Every member market's candles over one window — the lines of an event chart (docs/MARKETS.md §5 "Charts"). */
  @Get("events/:ticker/candlesticks")
  eventCandlesticks(
    @Param("ticker") ticker: string,
    @Query() query: CandlesQueryDto,
  ): Promise<ApiEventCandlesticks> {
    return this.candles.eventCandlesticks(ticker, {
      startTs: query.startTs,
      endTs: query.endTs,
      periodMinutes: query.periodInterval ?? 60,
    });
  }

  /** The pool trades of every member market, newest first, keyset-paginated (`nextCursor`). */
  @Get("events/:ticker/trades")
  eventTrades(
    @Param("ticker") ticker: string,
    @Query() query: EventTradesQueryDto,
  ): Promise<ApiPage<ApiMarketEvent>> {
    return this.catalog.eventTrades(ticker, {
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
      cursor: query.cursor ?? "",
    });
  }
}
