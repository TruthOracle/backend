import { Body, Controller, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import {
  CreateEventDto,
  CreateMarketDto,
  CreateSeriesDto,
  ExchangeHaltDto,
  UpdateEventDto,
  UpdateSeriesDto,
} from "../dto/catalog.dto";
import { CatalogService } from "../services/catalog.service";
import { ExchangeService } from "../services/exchange.service";
import { MarketOperatorService } from "../services/market-operator.service";
import type { ApiCreateMarketResult, ApiEvent, ApiExchangeHalt, ApiSeries } from "../types";
import { adminActorOf } from "./admin.controller";

/**
 * Operator side of the catalog and the exchange (docs/API.md "Admin — catalog"; docs/MARKETS.md
 * §4, §8): series and events CRUD, on-ledger market creation through the treasury, and the
 * trading halt. A market's own identity (ticker, event, side labels) is the contract's and has no
 * operator route. Same guard chain as AdminController; every mutation is audited with actorType
 * `admin`.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminCatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly operator: MarketOperatorService,
    private readonly exchange: ExchangeService,
  ) {}

  @Post("series")
  @HttpCode(200)
  createSeries(@Body() body: CreateSeriesDto, @Req() req: AuthedRequest): Promise<{ series: ApiSeries }> {
    const { reason, ...input } = body;
    return this.catalog.createSeries(input, adminActorOf(req), reason).then((series) => ({ series }));
  }

  @Patch("series/:ticker")
  @HttpCode(200)
  updateSeries(
    @Param("ticker") ticker: string,
    @Body() body: UpdateSeriesDto,
    @Req() req: AuthedRequest,
  ): Promise<{ series: ApiSeries }> {
    const { reason, ...patch } = body;
    return this.catalog.updateSeries(ticker, patch, adminActorOf(req), reason).then((series) => ({ series }));
  }

  @Post("events")
  @HttpCode(200)
  createEvent(@Body() body: CreateEventDto, @Req() req: AuthedRequest): Promise<{ event: ApiEvent }> {
    const { reason, ...input } = body;
    return this.catalog.createEvent(input, adminActorOf(req), reason).then((event) => ({ event }));
  }

  @Patch("events/:ticker")
  @HttpCode(200)
  updateEvent(
    @Param("ticker") ticker: string,
    @Body() body: UpdateEventDto,
    @Req() req: AuthedRequest,
  ): Promise<{ event: ApiEvent }> {
    const { reason, ...patch } = body;
    return this.catalog.updateEvent(ticker, patch, adminActorOf(req), reason).then((event) => ({ event }));
  }

  /** Submits `MarketCounter.CreateMarket` treasury-signed; the market appears once indexed (docs/MARKETS.md §4). */
  @Post("markets")
  @HttpCode(200)
  createMarket(@Body() body: CreateMarketDto, @Req() req: AuthedRequest): Promise<ApiCreateMarketResult> {
    const { reason, ...input } = body;
    return this.operator.createMarket(input, adminActorOf(req), reason);
  }

  @Post("exchange/halt")
  @HttpCode(200)
  halt(@Body() body: ExchangeHaltDto, @Req() req: AuthedRequest): Promise<{ halt: ApiExchangeHalt }> {
    return this.exchange
      .setHalt(
        { active: body.active, reason: body.reason, estimatedResumeAt: body.estimatedResumeAt ?? null },
        adminActorOf(req),
      )
      .then((halt) => ({ halt }));
  }
}
