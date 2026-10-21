import { Injectable } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";

import { ammStateOf, numberToDecimal } from "../amm/market-state";
import { marketEffectiveL, poolValue } from "../amm/pm-amm";
import { CatalogEventEntity } from "../entities/catalog-event.entity";
import { MarketMetadataEntity } from "../entities/market-metadata.entity";
import { MarketEntity } from "../entities/market.entity";
import { SeriesEntity } from "../entities/series.entity";
import {
  NatsSubjects,
  TICKER_PATTERN,
  TRADE_KINDS,
  sameInstrument,
  type Actor,
  type ApiEvent,
  type ApiMarket,
  type ApiMarketEvent,
  type ApiPage,
  type ApiSeries,
  type ApiSettlementSource,
  type EventSort,
  type EventStatus,
  type InstrumentId,
  type InstrumentRef,
  type MarketPhase,
  type SeriesFrequency,
  type SeriesStatus,
} from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, parseAmount } from "../util/money";
import { AuditService } from "./audit.service";
import { InstrumentsService } from "./instruments.service";
import { MarketsService } from "./markets.service";
import { NatsService } from "./nats.service";

export interface SeriesInput {
  ticker: string;
  title: string;
  category?: string;
  frequency?: SeriesFrequency;
  tags?: string[];
  settlementSources?: ApiSettlementSource[];
  contractUrl?: string | null;
  description?: string;
  productMetadata?: Record<string, unknown>;
}
export type SeriesPatch = Partial<Omit<SeriesInput, "ticker">> & { status?: SeriesStatus };

export interface EventInput {
  ticker: string;
  seriesTicker: string;
  title: string;
  subTitle?: string;
  imageUrl?: string;
  description?: string;
  mutuallyExclusive?: boolean;
  strikeDate?: string | null;
  strikePeriod?: string | null;
  settlementSources?: ApiSettlementSource[];
  productMetadata?: Record<string, unknown>;
}
export type EventPatch = Partial<Omit<EventInput, "ticker">> & { archived?: boolean };

/** A series' per-instrument figures (`seriesCounts`). */
interface SeriesCounts {
  events: number;
  markets: number;
  volume: bigint;
}

/** The backend-owned presentation of a market (`to_market_metadata`); a field left out is untouched. */
export interface MarketMetadataPatch {
  imageUrl?: string;
  description?: string;
}

export interface SeriesListQuery {
  category?: string;
  status?: SeriesStatus | "all";
  q?: string;
  /** The instrument the counts are computed over (`?instrument=`); omitted = the default collateral (docs/TOKENS.md §4.5). */
  instrument?: InstrumentId;
  page: number;
  limit: number;
}

export interface EventListQuery {
  series?: string;
  status?: EventStatus | "all";
  category?: string;
  q?: string;
  /** Card ordering (docs/MARKETS.md §3); without it the list is by strike date, newest first. */
  sort?: EventSort;
  /** Only events denominated in this instrument (plus events without a market yet); omitted = the default collateral. */
  instrument?: InstrumentId;
  withNestedMarkets: boolean;
  includeArchived: boolean;
  page: number;
  limit: number;
}

/**
 * The member markets an event's aggregates are summed over: its unarchived markets in the event's
 * own collateral (docs/TOKENS.md §2 decision 9). A market in another instrument that reached the
 * ledger past the backend's check is left out — a sum across tokens would be meaningless.
 */
const EVENT_MEMBERS =
  "FROM to_markets m WHERE m.event_ticker = e.ticker AND m.archived = false AND m.collateral_admin = e.collateral_admin AND m.collateral_id = e.collateral_id";

/**
 * SQL ordering for `sort=` — computed over the member markets so the whole catalog is ranked,
 * not just the page. `trending` is the last 24 h of hourly-candle volume (ties by lifetime
 * volume); `closing` is the soonest still-open close time (already-closed events last).
 */
export function eventSortOrder(sort: EventSort | undefined): {
  select: string;
  direction: "ASC" | "DESC";
  nulls?: "NULLS FIRST" | "NULLS LAST";
  then?: string;
}[] {
  const members = EVENT_MEMBERS;
  const volume = `(SELECT COALESCE(SUM(m.total_volume), 0) ${members})`;
  switch (sort) {
    case "trending":
      return [
        {
          select: `(SELECT COALESCE(SUM(c.volume), 0) FROM to_market_candles c JOIN to_markets m ON m.market_id = c.market_id WHERE m.event_ticker = e.ticker AND m.archived = false AND m.collateral_admin = e.collateral_admin AND m.collateral_id = e.collateral_id AND c.period_secs = 3600 AND c.period_start >= now() - interval '24 hours')`,
          direction: "DESC",
        },
        { select: volume, direction: "DESC" },
      ];
    case "volume":
      return [{ select: volume, direction: "DESC" }];
    case "closing":
      return [
        {
          select: `(SELECT MAX(m.expires_at_sec) ${members} AND m.expires_at_sec > extract(epoch FROM now()) AND m.status = 'Trading')`,
          direction: "ASC",
          nulls: "NULLS LAST",
        },
      ];
    case "newest":
      return [{ select: "e.created_at", direction: "DESC" }];
    default:
      return [];
  }
}

/**
 * Kalshi's event status from the member markets' phases (docs/MARKETS.md §3): settled once every
 * market is, open while any market trades, unopened while the rest are still collecting liquidity
 * (or there are no markets yet), closed otherwise (expired / proposed, awaiting resolution).
 */
export function deriveEventStatus(phases: readonly MarketPhase[]): EventStatus {
  if (phases.length === 0) return "unopened";
  if (phases.every((p) => p === "resolved" || p === "voided")) return "settled";
  if (phases.some((p) => p === "trading")) return "open";
  if (phases.some((p) => p === "liquidity")) return "unopened";
  return "closed";
}

export function normalizeTicker(raw: string): string {
  const ticker = raw.trim().toUpperCase();
  if (!TICKER_PATTERN.test(ticker))
    throw new ApiError(400, "validation_failed", `"${raw}" is not a valid ticker`);
  return ticker;
}

/**
 * The market catalog (docs/MARKETS.md §2–§3; docs/API.md "Catalog"): series and events are
 * operator-managed Postgres rows, markets are the ledger's. Membership is the market's on-ledger
 * `eventTicker`, nothing else (the projection creates a placeholder event row when the operator
 * has not written it yet); every derived event figure (status, volume, close time) is computed
 * from the indexed markets at read time, so nothing here can disagree with the ledger.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly markets: MarketsService,
    private readonly instruments: InstrumentsService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  /**
   * The instrument a catalog listing is computed over (docs/TOKENS.md §4.5): the query's
   * `?instrument=<admin>:<id>`, else the default collateral, else — on a platform with no
   * collateral configured — nothing: the catalog is then listed unfiltered rather than refused,
   * because the catalog rows are operator data that exist before any market does.
   */
  async listingInstrument(requested?: InstrumentId): Promise<InstrumentRef | null> {
    if (requested) return this.instruments.refOf(requested);
    const fallback = await this.instruments.defaultCollateral();
    return fallback ? this.instruments.toRef(fallback) : null;
  }

  // ───────────────────────────────────────────── series ─────────────────────────────────────────────

  async listSeries(query: SeriesListQuery): Promise<ApiPage<ApiSeries>> {
    const instrument = await this.listingInstrument(query.instrument);
    const qb = this.dataSource.getRepository(SeriesEntity).createQueryBuilder("s");
    if ((query.status ?? "active") !== "all")
      qb.andWhere("s.status = :status", { status: query.status ?? "active" });
    if (query.category) qb.andWhere("s.category ILIKE :category", { category: query.category });
    if (query.q)
      qb.andWhere("(s.title ILIKE :q OR s.ticker ILIKE :q OR s.description ILIKE :q)", {
        q: `%${escapeLike(query.q)}%`,
      });
    const [rows, total] = await qb
      .orderBy("s.title", "ASC")
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    const counts = await this.seriesCounts(
      rows.map((r) => r.ticker),
      instrument,
    );
    return {
      items: rows.map((s) => this.toApiSeries(s, counts.get(s.ticker), instrument)),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async getSeries(
    tickerRaw: string,
    requested?: InstrumentId,
  ): Promise<{ series: ApiSeries; events: ApiEvent[] }> {
    const ticker = tickerRaw.trim().toUpperCase();
    const row = await this.dataSource.getRepository(SeriesEntity).findOneBy({ ticker });
    if (!row) throw new ApiError(404, "not_found", `series ${ticker} does not exist`);
    const instrument = await this.listingInstrument(requested);
    const counts = await this.seriesCounts([ticker], instrument);
    const events = await this.listEvents({
      series: ticker,
      status: "all",
      instrument: requested,
      withNestedMarkets: false,
      includeArchived: false,
      page: 1,
      limit: 100,
    });
    return {
      series: this.toApiSeries(row, counts.get(ticker), instrument),
      events: events.items,
    };
  }

  async createSeries(input: SeriesInput, actor: Actor, reason?: string): Promise<ApiSeries> {
    const ticker = normalizeTicker(input.ticker);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SeriesEntity);
      if (await repo.findOneBy({ ticker }))
        throw new ApiError(409, "catalog_conflict", `series ${ticker} already exists`);
      const row = repo.create({
        ticker,
        title: input.title.trim(),
        category: (input.category ?? "").trim(),
        frequency: input.frequency ?? "one_off",
        tags: input.tags ?? [],
        settlementSources: input.settlementSources ?? [],
        contractUrl: input.contractUrl ?? null,
        description: input.description ?? "",
        status: "active",
        productMetadata: input.productMetadata ?? {},
        createdByUserId: actor.userId ?? null,
      });
      await repo.save(row);
      await this.record(manager, actor, "catalog.series_created", "series", ticker, { reason });
      await this.announce("series", ticker);
      return this.toApiSeries(row, undefined, await this.listingInstrument());
    });
  }

  async updateSeries(
    tickerRaw: string,
    patch: SeriesPatch,
    actor: Actor,
    reason?: string,
  ): Promise<ApiSeries> {
    const ticker = tickerRaw.trim().toUpperCase();
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SeriesEntity);
      const row = await repo.findOneBy({ ticker });
      if (!row) throw new ApiError(404, "not_found", `series ${ticker} does not exist`);
      if (patch.title !== undefined) row.title = patch.title.trim();
      if (patch.category !== undefined) row.category = patch.category.trim();
      if (patch.frequency !== undefined) row.frequency = patch.frequency;
      if (patch.tags !== undefined) row.tags = patch.tags;
      if (patch.settlementSources !== undefined) row.settlementSources = patch.settlementSources;
      if (patch.contractUrl !== undefined) row.contractUrl = patch.contractUrl;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.productMetadata !== undefined) row.productMetadata = patch.productMetadata;
      if (patch.status !== undefined) row.status = patch.status;
      await repo.save(row);
      await this.record(manager, actor, "catalog.series_updated", "series", ticker, {
        reason,
        fields: Object.keys(patch),
      });
      await this.announce("series", ticker);
      const instrument = await this.listingInstrument();
      const counts = await this.seriesCounts([ticker], instrument, manager);
      return this.toApiSeries(row, counts.get(ticker), instrument);
    });
  }

  // ───────────────────────────────────────────── events ─────────────────────────────────────────────

  async listEvents(query: EventListQuery): Promise<ApiPage<ApiEvent>> {
    const instrument = await this.listingInstrument(query.instrument);
    const qb = this.dataSource.getRepository(CatalogEventEntity).createQueryBuilder("e");
    if (!query.includeArchived) qb.andWhere("e.archived = false");
    // Per instrument (docs/TOKENS.md §4.5): the events denominated in it, plus the events no market
    // has fixed yet — they belong to no instrument and carry zero aggregates under every one.
    if (instrument)
      qb.andWhere(
        "(e.collateral_admin IS NULL OR (e.collateral_admin = :admin AND e.collateral_id = :id))",
        { admin: instrument.admin, id: instrument.id },
      );
    if (query.series)
      qb.andWhere("e.series_ticker = :series", { series: query.series.trim().toUpperCase() });
    if (query.category)
      qb.andWhere(
        "e.series_ticker IN (SELECT s.ticker FROM to_series s WHERE s.category ILIKE :category)",
        { category: query.category },
      );
    if (query.q)
      qb.andWhere("(e.title ILIKE :q OR e.ticker ILIKE :q OR e.sub_title ILIKE :q)", {
        q: `%${escapeLike(query.q)}%`,
      });
    const status = query.status ?? "all";
    const order = eventSortOrder(query.sort);
    order.forEach((o, i) => {
      qb.addSelect(o.select, `sort_${i}`);
      if (i === 0) qb.orderBy(`sort_${i}`, o.direction, o.nulls);
      else qb.addOrderBy(`sort_${i}`, o.direction, o.nulls);
    });
    if (order.length === 0) qb.orderBy("e.strike_date", "DESC", "NULLS LAST");
    qb.addOrderBy("e.created_at", "DESC").addOrderBy("e.ticker", "ASC");
    // The status is derived from the markets, so a status filter pages over the filtered set in memory.
    if (status === "all") {
      const [rows, total] = await qb
        .skip((query.page - 1) * query.limit)
        .take(query.limit)
        .getManyAndCount();
      return {
        items: await this.toApiEvents(rows, query.withNestedMarkets),
        page: query.page,
        limit: query.limit,
        total,
      };
    }
    const all = await qb.getMany();
    const shaped = (await this.toApiEvents(all, query.withNestedMarkets)).filter(
      (e) => e.status === status,
    );
    const start = (query.page - 1) * query.limit;
    return {
      items: shaped.slice(start, start + query.limit),
      page: query.page,
      limit: query.limit,
      total: shaped.length,
    };
  }

  async getEvent(tickerRaw: string): Promise<ApiEvent> {
    const ticker = tickerRaw.trim().toUpperCase();
    const row = await this.dataSource.getRepository(CatalogEventEntity).findOneBy({ ticker });
    if (!row) throw new ApiError(404, "not_found", `event ${ticker} does not exist`);
    const [event] = await this.toApiEvents([row], true);
    return event;
  }

  async createEvent(input: EventInput, actor: Actor, reason?: string): Promise<ApiEvent> {
    const ticker = normalizeTicker(input.ticker);
    const seriesTicker = input.seriesTicker.trim().toUpperCase();
    return this.dataSource.transaction(async (manager) => {
      const series = await manager.getRepository(SeriesEntity).findOneBy({ ticker: seriesTicker });
      if (!series) throw new ApiError(404, "not_found", `series ${seriesTicker} does not exist`);
      const repo = manager.getRepository(CatalogEventEntity);
      if (await repo.findOneBy({ ticker }))
        throw new ApiError(409, "catalog_conflict", `event ${ticker} already exists`);
      const row = repo.create({
        ticker,
        seriesTicker,
        title: input.title.trim(),
        subTitle: input.subTitle ?? "",
        imageUrl: input.imageUrl ?? "",
        description: input.description ?? "",
        mutuallyExclusive: input.mutuallyExclusive ?? false,
        strikeDate: input.strikeDate ? new Date(input.strikeDate) : null,
        strikePeriod: input.strikePeriod ?? null,
        settlementSources: input.settlementSources ?? [],
        productMetadata: input.productMetadata ?? {},
        archived: false,
        createdByUserId: actor.userId ?? null,
      });
      await repo.save(row);
      await this.record(manager, actor, "catalog.event_created", "event", ticker, {
        reason,
        seriesTicker,
      });
      await this.announce("event", ticker);
      const [event] = await this.toApiEvents([row], true, manager);
      return event;
    });
  }

  async updateEvent(
    tickerRaw: string,
    patch: EventPatch,
    actor: Actor,
    reason?: string,
  ): Promise<ApiEvent> {
    const ticker = tickerRaw.trim().toUpperCase();
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CatalogEventEntity);
      const row = await repo.findOneBy({ ticker });
      if (!row) throw new ApiError(404, "not_found", `event ${ticker} does not exist`);
      if (patch.seriesTicker !== undefined) {
        const seriesTicker = patch.seriesTicker.trim().toUpperCase();
        if (!(await manager.getRepository(SeriesEntity).findOneBy({ ticker: seriesTicker })))
          throw new ApiError(404, "not_found", `series ${seriesTicker} does not exist`);
        row.seriesTicker = seriesTicker;
      }
      if (patch.title !== undefined) row.title = patch.title.trim();
      if (patch.subTitle !== undefined) row.subTitle = patch.subTitle;
      if (patch.imageUrl !== undefined) row.imageUrl = patch.imageUrl;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.mutuallyExclusive !== undefined) row.mutuallyExclusive = patch.mutuallyExclusive;
      if (patch.strikeDate !== undefined)
        row.strikeDate = patch.strikeDate ? new Date(patch.strikeDate) : null;
      if (patch.strikePeriod !== undefined) row.strikePeriod = patch.strikePeriod;
      if (patch.settlementSources !== undefined) row.settlementSources = patch.settlementSources;
      if (patch.productMetadata !== undefined) row.productMetadata = patch.productMetadata;
      if (patch.archived !== undefined) row.archived = patch.archived;
      await repo.save(row);
      await this.record(manager, actor, "catalog.event_updated", "event", ticker, {
        reason,
        fields: Object.keys(patch),
      });
      await this.announce("event", ticker);
      const [event] = await this.toApiEvents([row], true, manager);
      return event;
    });
  }

  // ───────────────────────────────────────────── market metadata ─────────────────────────────────────────────

  /**
   * `PATCH /admin/markets/:market/metadata`: the market's image and description live here, not on
   * the contract (docs/MARKETS.md §1), so an operator fixes them in place. `ref` is an id or a
   * ticker; the row is keyed by the ticker the index holds for the market.
   */
  async updateMarketMetadata(
    ref: string,
    patch: MarketMetadataPatch,
    actor: Actor,
    reason?: string,
  ): Promise<ApiMarket> {
    if (patch.imageUrl === undefined && patch.description === undefined)
      throw new ApiError(
        400,
        "validation_failed",
        "nothing to update: send imageUrl and/or description",
      );
    const market = await this.markets.resolve(ref);
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(MarketMetadataEntity);
      const row =
        (await repo.findOneBy({ ticker: market.ticker })) ??
        repo.create({ ticker: market.ticker, imageUrl: "", description: "" });
      if (patch.imageUrl !== undefined) row.imageUrl = patch.imageUrl;
      if (patch.description !== undefined) row.description = patch.description;
      row.updatedByUserId = actor.userId ?? null;
      await repo.save(row);
      await this.record(
        manager,
        actor,
        "catalog.market_metadata_updated",
        "market",
        market.ticker,
        {
          reason,
          marketId: market.marketId,
          fields: Object.keys(patch).filter(
            (k) => patch[k as keyof MarketMetadataPatch] !== undefined,
          ),
        },
      );
    });
    await this.announce("market", market.ticker);
    return this.markets.get(market.marketId);
  }

  // ───────────────────────────────────────────── feed ─────────────────────────────────────────────

  /** `GET /events/:ticker/trades`: the pool trades of every member market, newest first, keyset-paginated. */
  async eventTrades(
    tickerRaw: string,
    opts: { limit: number; cursor: string },
  ): Promise<ApiPage<ApiMarketEvent>> {
    const ticker = tickerRaw.trim().toUpperCase();
    const row = await this.dataSource.getRepository(CatalogEventEntity).findOneBy({ ticker });
    if (!row) throw new ApiError(404, "not_found", `event ${ticker} does not exist`);
    const members = await this.dataSource
      .getRepository(MarketEntity)
      .createQueryBuilder("m")
      .select(["m.marketId"])
      .where("m.event_ticker = :ticker", { ticker })
      .getMany();
    return this.markets.activity({
      marketIds: members.map((m) => m.marketId),
      kinds: TRADE_KINDS,
      page: 1,
      limit: opts.limit,
      cursor: opts.cursor,
    });
  }

  // ───────────────────────────────────────────── shaping ─────────────────────────────────────────────

  private async toApiEvents(
    rows: CatalogEventEntity[],
    withMarkets: boolean,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ApiEvent[]> {
    if (rows.length === 0) return [];
    const tickers = rows.map((r) => r.ticker);
    const seriesRows = await manager
      .getRepository(SeriesEntity)
      .createQueryBuilder("s")
      .where("s.ticker IN (:...tickers)", {
        tickers: [...new Set(rows.map((r) => r.seriesTicker))],
      })
      .getMany();
    const series = new Map(seriesRows.map((s) => [s.ticker, s]));
    // Likeliest outcome first — what an event page and a card list (Kalshi orders by price).
    const marketRows = await manager
      .getRepository(MarketEntity)
      .createQueryBuilder("m")
      .where("m.event_ticker IN (:...tickers) AND m.archived = false", { tickers })
      .orderBy("m.current_price", "DESC")
      .addOrderBy("m.market_id", "ASC")
      .getMany();
    const byEvent = new Map<string, MarketEntity[]>();
    for (const m of marketRows) {
      const list = byEvent.get(m.eventTicker) ?? [];
      list.push(m);
      byEvent.set(m.eventTicker, list);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    // The event's one collateral (docs/TOKENS.md §2 decision 9): the catalog column once a market
    // fixed it, else the members'. Only the members in that instrument are the event's legs here —
    // a stray market in another token (one that bypassed the backend's check) is neither summed
    // nor nested; it stays addressable through `GET /markets?event=`.
    const collateralOf = (e: CatalogEventEntity, all: MarketEntity[]): InstrumentId | null =>
      e.collateralAdmin && e.collateralId
        ? { admin: e.collateralAdmin, id: e.collateralId }
        : all[0]
          ? { admin: all[0].collateralAdmin, id: all[0].collateralId }
          : null;
    const membersOf = new Map<string, MarketEntity[]>();
    for (const e of rows) {
      const all = byEvent.get(e.ticker) ?? [];
      const collateral = collateralOf(e, all);
      membersOf.set(
        e.ticker,
        collateral
          ? all.filter((m) =>
              sameInstrument({ admin: m.collateralAdmin, id: m.collateralId }, collateral),
            )
          : [],
      );
    }
    const memberRows = [...membersOf.values()].flat();
    // One batch of extras for every member: the 24 h volume feeds the event aggregate whether or
    // not the markets are nested, and shaping reuses it.
    const extras = await this.markets.extrasFor(memberRows, manager);
    const shapedByEvent = new Map<string, ApiMarket[]>();
    if (withMarkets)
      for (const m of memberRows) {
        const list = shapedByEvent.get(m.eventTicker) ?? [];
        list.push(this.markets.toApi(m, false, extras.get(m.marketId)));
        shapedByEvent.set(m.eventTicker, list);
      }
    return rows.map((e) => {
      const members = membersOf.get(e.ticker) ?? [];
      const phases = members.map((m) => this.markets.phaseOf(m, nowSec));
      const s = series.get(e.seriesTicker);
      let volume = 0n;
      let volume24h = 0n;
      let openInterest = 0n;
      let liquidity = 0;
      let close: number | null = null;
      for (const m of members) {
        volume += m.totalVolume;
        volume24h += extras.get(m.marketId)?.volume24h ?? 0n;
        openInterest += m.openInterestYes + m.openInterestNo;
        const amm = ammStateOf(m);
        const effectiveL = marketEffectiveL(amm, nowSec);
        liquidity += effectiveL > 0 ? poolValue(amm.currentPrice, effectiveL) : 0;
        close = close === null ? m.expiresAtSec : Math.max(close, m.expiresAtSec);
      }
      const top = members[0];
      const collateralId = collateralOf(e, byEvent.get(e.ticker) ?? []);
      const collateral = collateralId
        ? this.markets.instrumentRef(collateralId.admin, collateralId.id)
        : null;
      const api: ApiEvent = {
        ticker: e.ticker,
        seriesTicker: e.seriesTicker,
        title: e.title,
        subTitle: e.subTitle,
        category: s?.category ?? "",
        imageUrl: e.imageUrl,
        description: e.description,
        mutuallyExclusive: e.mutuallyExclusive,
        strikeDate: e.strikeDate ? e.strikeDate.toISOString() : null,
        strikePeriod: e.strikePeriod,
        settlementSources:
          e.settlementSources.length > 0 ? e.settlementSources : (s?.settlementSources ?? []),
        productMetadata: e.productMetadata ?? {},
        archived: e.archived,
        status: deriveEventStatus(phases),
        instrument: collateral,
        marketCount: members.length,
        volume: formatAmount(volume),
        closeTime: close === null ? null : new Date(close * 1000).toISOString(),
        volume24h: formatAmount(volume24h),
        openInterest: formatAmount(openInterest),
        liquidity: formatAmount(numberToDecimal(liquidity)),
        topMarket: top
          ? {
              marketId: top.marketId,
              ticker: top.ticker,
              yesSubTitle: top.yesSubTitle,
              currentPrice: formatAmount(top.currentPrice),
            }
          : null,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      };
      if (withMarkets) api.markets = shapedByEvent.get(e.ticker) ?? [];
      return api;
    });
  }

  private toApiSeries(
    s: SeriesEntity,
    counts: SeriesCounts | undefined,
    instrument: InstrumentRef | null,
  ): ApiSeries {
    return {
      ticker: s.ticker,
      title: s.title,
      category: s.category,
      frequency: s.frequency,
      tags: s.tags ?? [],
      settlementSources: s.settlementSources ?? [],
      contractUrl: s.contractUrl,
      description: s.description,
      status: s.status,
      productMetadata: s.productMetadata ?? {},
      instrument,
      eventCount: counts?.events ?? 0,
      marketCount: counts?.markets ?? 0,
      volume: formatAmount(counts?.volume ?? 0n),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  /**
   * A series' figures in ONE instrument (docs/TOKENS.md §4.5): its unarchived events denominated
   * in it (an event without a market yet belongs to no instrument and counts under every one),
   * the member markets of those events in that instrument, and their lifetime volume. Without an
   * instrument (no collateral configured) every event and market counts.
   */
  private async seriesCounts(
    tickers: string[],
    instrument: InstrumentRef | null,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Map<string, SeriesCounts>> {
    const out = new Map<string, SeriesCounts>();
    if (tickers.length === 0) return out;
    const rows = await manager.query<
      { series_ticker: string; events: string; markets: string; volume: string }[]
    >(
      `SELECT e.series_ticker,
              COUNT(DISTINCT e.ticker)::text AS events,
              COUNT(m.market_id)::text AS markets,
              COALESCE(SUM(m.total_volume), 0)::text AS volume
         FROM to_events e
         LEFT JOIN to_markets m ON m.event_ticker = e.ticker AND m.archived = false
              AND m.collateral_admin = e.collateral_admin AND m.collateral_id = e.collateral_id
        WHERE e.series_ticker = ANY($1::text[]) AND e.archived = false
          AND ($2::text IS NULL OR e.collateral_admin IS NULL OR (e.collateral_admin = $2 AND e.collateral_id = $3))
        GROUP BY e.series_ticker`,
      [tickers, instrument?.admin ?? null, instrument?.id ?? null],
    );
    for (const r of rows)
      out.set(r.series_ticker, {
        events: Number(r.events),
        markets: Number(r.markets),
        volume: parseAmount(r.volume),
      });
    return out;
  }

  private async record(
    manager: EntityManager,
    actor: Actor,
    action:
      | "catalog.series_created"
      | "catalog.series_updated"
      | "catalog.event_created"
      | "catalog.event_updated"
      | "catalog.market_metadata_updated",
    subjectType: string,
    subjectId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      {
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        actorSessionId: actor.sessionId ?? null,
        action,
        subjectType,
        subjectId,
        metadata: Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined)),
        ip: actor.ip ?? null,
      },
      manager,
    );
  }

  private async announce(kind: "series" | "event" | "market", ticker: string): Promise<void> {
    await this.nats.publishSafe(NatsSubjects.catalogChanged, { kind, ticker });
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Shared by the read side: `Σ volume` etc. arrive as numeric strings. */
export const parseNumeric = (v: string | null | undefined): bigint => parseAmount(v ?? "0");
