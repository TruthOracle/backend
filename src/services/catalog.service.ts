import { Injectable } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";

import { CatalogEventEntity } from "../entities/catalog-event.entity";
import { MarketEntity } from "../entities/market.entity";
import { SeriesEntity } from "../entities/series.entity";
import {
  NatsSubjects,
  TICKER_PATTERN,
  type Actor,
  type ApiEvent,
  type ApiMarket,
  type ApiPage,
  type ApiSeries,
  type ApiSettlementSource,
  type EventStatus,
  type MarketPhase,
  type SeriesFrequency,
  type SeriesStatus,
} from "../types";
import { ApiError } from "../util/errors";
import { formatCC, parseCC } from "../util/money";
import { AuditService } from "./audit.service";
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

export interface SeriesListQuery {
  category?: string;
  status?: SeriesStatus | "all";
  q?: string;
  page: number;
  limit: number;
}

export interface EventListQuery {
  series?: string;
  status?: EventStatus | "all";
  category?: string;
  q?: string;
  withNestedMarkets: boolean;
  includeArchived: boolean;
  page: number;
  limit: number;
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
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  // ───────────────────────────────────────────── series ─────────────────────────────────────────────

  async listSeries(query: SeriesListQuery): Promise<ApiPage<ApiSeries>> {
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
    const counts = await this.seriesCounts(rows.map((r) => r.ticker));
    return {
      items: rows.map((s) => this.toApiSeries(s, counts.get(s.ticker))),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async getSeries(tickerRaw: string): Promise<{ series: ApiSeries; events: ApiEvent[] }> {
    const ticker = tickerRaw.trim().toUpperCase();
    const row = await this.dataSource.getRepository(SeriesEntity).findOneBy({ ticker });
    if (!row) throw new ApiError(404, "not_found", `series ${ticker} does not exist`);
    const counts = await this.seriesCounts([ticker]);
    const events = await this.listEvents({
      series: ticker,
      status: "all",
      withNestedMarkets: false,
      includeArchived: false,
      page: 1,
      limit: 100,
    });
    return { series: this.toApiSeries(row, counts.get(ticker)), events: events.items };
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
      return this.toApiSeries(row, undefined);
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
      const counts = await this.seriesCounts([ticker], manager);
      return this.toApiSeries(row, counts.get(ticker));
    });
  }

  // ───────────────────────────────────────────── events ─────────────────────────────────────────────

  async listEvents(query: EventListQuery): Promise<ApiPage<ApiEvent>> {
    const qb = this.dataSource.getRepository(CatalogEventEntity).createQueryBuilder("e");
    if (!query.includeArchived) qb.andWhere("e.archived = false");
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
    // The status is derived from the markets, so a status filter pages over the filtered set in memory.
    if (status === "all") {
      const [rows, total] = await qb
        .orderBy("e.strike_date", "DESC", "NULLS LAST")
        .addOrderBy("e.created_at", "DESC")
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
    const all = await qb
      .orderBy("e.strike_date", "DESC", "NULLS LAST")
      .addOrderBy("e.created_at", "DESC")
      .getMany();
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
      .where("s.ticker IN (:...tickers)", { tickers: [...new Set(rows.map((r) => r.seriesTicker))] })
      .getMany();
    const series = new Map(seriesRows.map((s) => [s.ticker, s]));
    const marketRows = await manager
      .getRepository(MarketEntity)
      .createQueryBuilder("m")
      .where("m.event_ticker IN (:...tickers) AND m.archived = false", { tickers })
      .orderBy("m.market_id", "ASC")
      .getMany();
    const byEvent = new Map<string, MarketEntity[]>();
    for (const m of marketRows) {
      const list = byEvent.get(m.eventTicker) ?? [];
      list.push(m);
      byEvent.set(m.eventTicker, list);
    }
    const shapedMarkets = withMarkets
      ? await this.markets.toApiMany(marketRows, false, manager)
      : [];
    const shapedByEvent = new Map<string, ApiMarket[]>();
    for (const m of shapedMarkets) {
      const list = shapedByEvent.get(m.eventTicker) ?? [];
      list.push(m);
      shapedByEvent.set(m.eventTicker, list);
    }
    return rows.map((e) => {
      const members = byEvent.get(e.ticker) ?? [];
      const phases = members.map((m) => this.markets.phaseOf(m));
      const s = series.get(e.seriesTicker);
      let volume = 0n;
      let close: number | null = null;
      for (const m of members) {
        volume += m.totalVolumeCC;
        close = close === null ? m.expiresAtSec : Math.max(close, m.expiresAtSec);
      }
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
        marketCount: members.length,
        volumeCC: formatCC(volume),
        closeTime: close === null ? null : new Date(close * 1000).toISOString(),
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      };
      if (withMarkets) api.markets = shapedByEvent.get(e.ticker) ?? [];
      return api;
    });
  }

  private toApiSeries(
    s: SeriesEntity,
    counts: { events: number; markets: number } | undefined,
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
      eventCount: counts?.events ?? 0,
      marketCount: counts?.markets ?? 0,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private async seriesCounts(
    tickers: string[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Map<string, { events: number; markets: number }>> {
    const out = new Map<string, { events: number; markets: number }>();
    if (tickers.length === 0) return out;
    const rows = await manager.query<{ series_ticker: string; events: string; markets: string }[]>(
      `SELECT e.series_ticker,
              COUNT(DISTINCT e.ticker)::text AS events,
              COUNT(m.market_id)::text AS markets
         FROM to_events e
         LEFT JOIN to_markets m ON m.event_ticker = e.ticker AND m.archived = false
        WHERE e.series_ticker = ANY($1::text[]) AND e.archived = false
        GROUP BY e.series_ticker`,
      [tickers],
    );
    for (const r of rows)
      out.set(r.series_ticker, { events: Number(r.events), markets: Number(r.markets) });
    return out;
  }

  private async record(
    manager: EntityManager,
    actor: Actor,
    action:
      | "catalog.series_created"
      | "catalog.series_updated"
      | "catalog.event_created"
      | "catalog.event_updated",
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

  private async announce(kind: "series" | "event", ticker: string): Promise<void> {
    await this.nats.publishSafe(NatsSubjects.catalogChanged, { kind, ticker });
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Shared by the read side: `Σ volume` etc. arrive as numeric strings. */
export const parseNumeric = (v: string | null | undefined): bigint => parseCC(v ?? "0");
