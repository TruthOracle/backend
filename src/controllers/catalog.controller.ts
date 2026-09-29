import { Controller, Get, Param, Query, UseInterceptors } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import { EventListQueryDto, SeriesListQueryDto } from "../dto/catalog.dto";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import { CatalogService } from "../services/catalog.service";
import type { ApiEvent, ApiPage, ApiSeries } from "../types";
import { LedgerOffsetInterceptor } from "../util/ledger-offset.interceptor";

/**
 * Public catalog reads (docs/API.md "Catalog"; docs/MARKETS.md §2–§3): series and events, with
 * the member markets nested on request. Everything derived (event status, volume, close time)
 * comes from the ledger index, so the responses carry `x-ledger-offset` like the market reads.
 */
@ApiTags("catalog")
@Controller()
@Public()
@UseInterceptors(LedgerOffsetInterceptor)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("series")
  listSeries(@Query() query: SeriesListQueryDto): Promise<ApiPage<ApiSeries>> {
    return this.catalog.listSeries({
      category: query.category,
      status: query.status,
      q: query.q,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  @Get("series/:ticker")
  getSeries(@Param("ticker") ticker: string): Promise<{ series: ApiSeries; events: ApiEvent[] }> {
    return this.catalog.getSeries(ticker);
  }

  @Get("events")
  listEvents(@Query() query: EventListQueryDto): Promise<ApiPage<ApiEvent>> {
    return this.catalog.listEvents({
      series: query.series,
      status: query.status,
      category: query.category,
      q: query.q,
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
}
