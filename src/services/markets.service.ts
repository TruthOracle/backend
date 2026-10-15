import { Injectable } from "@nestjs/common";
import { DataSource, type EntityManager, type SelectQueryBuilder } from "typeorm";

import { ammStateOf, numberToDecimal } from "../amm/market-state";
import { impliedQuoteBook, marketEffectiveL, poolValue } from "../amm/pm-amm";
import { AttestationEntity } from "../entities/attestation.entity";
import { LiquidityPositionEntity } from "../entities/liquidity-position.entity";
import { MarketEventEntity } from "../entities/market-event.entity";
import { MarketEntity } from "../entities/market.entity";
import { ModelForecastEntity } from "../entities/model-forecast.entity";
import { PositionEntity } from "../entities/position.entity";
import {
  TICKER_PATTERN,
  TRADE_KINDS,
  type ApiAttestation,
  type ApiLeaderboardEntry,
  type ApiLiquidityPosition,
  type ApiMarket,
  type ApiMarketEvent,
  type ApiMarketSummary,
  type ApiModelForecast,
  type ApiPage,
  type ApiPosition,
  type ApiPricePoint,
  type ApiStats,
  type InstrumentId,
  type InstrumentRef,
  type MarketEventKind,
  type MarketPhase,
  type MarketStatus,
  type TradeAction,
  TRADE_ACTIONS,
} from "../types";
import { ApiError } from "../util/errors";
import { divDecimal, mulDecimal, ONE_DECIMAL } from "../util/ledger-values";
import { formatAmount, parseAmount } from "../util/money";
import { maskParty } from "../util/party";
import { InstrumentsService } from "./instruments.service";

export type MarketStatusFilter = MarketStatus | "active" | "settled";
export type MarketSort = "newest" | "oldest" | "volume" | "expiry" | "activity";

export interface MarketListQuery {
  status?: MarketStatusFilter;
  category?: string;
  /** Members of one event (`to_markets.event_ticker`). */
  event?: string;
  /** Members of every event of one series. */
  series?: string;
  /** Explicit tickers (upper-cased). */
  tickers?: string[];
  q?: string;
  sort?: MarketSort;
  includeArchived?: boolean;
  page: number;
  limit: number;
}

/**
 * What the API adds on top of the ledger row (docs/MARKETS.md §1, §3), batch-loaded by
 * `extrasFor`: the catalog side of a market (series through the event, the event's image and
 * the series' category) and its backend-owned presentation (`to_market_metadata`).
 */
export interface MarketExtras {
  seriesTicker: string | null;
  /** The series' category through the event ("" without a series or for a placeholder). */
  category: string;
  /** The event's own image ("" when unset) — the fallback for a market without metadata. */
  eventImageUrl: string;
  /** The operator's presentation row for this ticker, when there is one. */
  metadata: { imageUrl: string; description: string; updatedAt: Date } | null;
  /** The price 24 h ago (the last hourly close before then), else the market's first price; null without candles. */
  previousPrice: bigint | null;
  /** Σ candle volume of the last 24 h. */
  volume24h: bigint;
}

const NO_EXTRAS: MarketExtras = {
  seriesTicker: null,
  category: "",
  eventImageUrl: "",
  metadata: null,
  previousPrice: null,
  volume24h: 0n,
};
/** Collateral of the reference buy behind `ApiMarket.book` (one unit of the market's collateral — a retail-sized order). */
const BOOK_REFERENCE_AMOUNT = 1;

export interface ActivityQuery {
  kind?: MarketEventKind;
  kinds?: readonly MarketEventKind[];
  actors?: string[];
  marketId?: number;
  /** Every market of one event (the event feed). */
  marketIds?: number[];
  page: number;
  limit: number;
  /**
   * Keyset mode (`cursor=`): rows strictly after the cursor in feed order (offset, node id desc),
   * `nextCursor` in the answer, no total. Pass `""` for the first page in keyset mode.
   */
  cursor?: string;
}

/** `offset:nodeId` of the last row served — opaque to clients, validated by the DTO. */
export function parseCursor(cursor: string): { offset: number; nodeId: number } | null {
  const m = /^(\d+):(\d+)$/.exec(cursor);
  return m ? { offset: Number(m[1]), nodeId: Number(m[2]) } : null;
}

/** Bucket widths for `GET /markets/:id/price-history` (seconds); `raw` = every version. */
export const PRICE_RESOLUTIONS = {
  raw: 0,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
} as const;
export type PriceResolution = keyof typeof PRICE_RESOLUTIONS;

export type LeaderboardWindow = "24h" | "7d" | "30d" | "all";
const WINDOW_MS: Record<LeaderboardWindow, number | null> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: null,
};

/** Wallet reasons that are trade cash flows (leaderboard realised PnL = credits − debits over these). */
const PNL_CREDIT_REASONS = ["sell", "merge", "resolve", "void-refund", "liquidity"];
const PNL_DEBIT_REASONS = ["buy", "split", "liquidity-provide"];

/**
 * Market reads over the ledger index (docs/API.md "Markets"; docs/INDEXER.md §7). Every answer
 * comes from Postgres — nothing here touches the ledger, so a participant outage degrades to
 * "stale by the indexer's lag", never to an error. Every amount is served next to the market's
 * collateral (`collateral` on a market, `instrument` on trades, positions and aggregates —
 * docs/TOKENS.md §4.5), resolved through the instruments snapshot.
 */
@Injectable()
export class MarketsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly instruments: InstrumentsService,
  ) {}

  /** The wire ref of a market's collateral. */
  collateralOf(m: Pick<MarketEntity, "collateralAdmin" | "collateralId">): InstrumentRef {
    return this.instruments.refFor(m.collateralAdmin, m.collateralId);
  }

  /** The wire ref of any `(admin, id)` pair an index row carries. */
  instrumentRef(admin: string, id: string): InstrumentRef {
    return this.instruments.refFor(admin, id);
  }

  /**
   * The instrument an aggregate (`GET /stats`, `GET /leaderboard`) is computed over: the query's
   * `?instrument=<admin>:<id>`, else the default collateral; `503 not_ready` without either.
   */
  async aggregateInstrument(requested?: InstrumentId): Promise<InstrumentRef> {
    if (requested) return this.instruments.refOf(requested);
    return this.instruments.toRef(await this.instruments.requireDefaultCollateral());
  }

  // ───────────────────────────────────────────── markets ─────────────────────────────────────────────

  async list(query: MarketListQuery): Promise<ApiPage<ApiMarket>> {
    const qb = this.dataSource.getRepository(MarketEntity).createQueryBuilder("m");
    if (!query.includeArchived) qb.andWhere("m.archived = false");
    switch (query.status) {
      case "active":
        qb.andWhere("m.status IN ('Trading', 'Proposed')");
        break;
      case "settled":
        qb.andWhere("m.status IN ('Resolved', 'Voided')");
        break;
      case undefined:
        break;
      default:
        qb.andWhere("m.status = :status", { status: query.status });
    }
    // A market's category is its series' (through the event) — the contract carries none.
    if (query.category)
      qb.andWhere(
        "m.event_ticker IN (SELECT e.ticker FROM to_events e JOIN to_series s ON s.ticker = e.series_ticker WHERE s.category ILIKE :category)",
        { category: query.category },
      );
    if (query.event)
      qb.andWhere("m.event_ticker = :event", { event: query.event.trim().toUpperCase() });
    if (query.series)
      qb.andWhere(
        "m.event_ticker IN (SELECT e.ticker FROM to_events e WHERE e.series_ticker = :series)",
        { series: query.series.trim().toUpperCase() },
      );
    if (query.tickers && query.tickers.length > 0)
      qb.andWhere("m.ticker IN (:...tickers)", {
        tickers: query.tickers.map((t) => t.trim().toUpperCase()),
      });
    if (query.q)
      qb.andWhere(
        "(m.question ILIKE :q OR m.ticker ILIKE :q OR m.event_ticker ILIKE :q OR m.ticker IN (SELECT md.ticker FROM to_market_metadata md WHERE md.description ILIKE :q))",
        { q: `%${escapeLike(query.q)}%` },
      );
    switch (query.sort ?? "newest") {
      case "oldest":
        qb.orderBy("m.market_id", "ASC");
        break;
      case "volume":
        qb.orderBy("m.total_volume", "DESC").addOrderBy("m.market_id", "DESC");
        break;
      case "expiry":
        qb.orderBy("m.expires_at_sec", "ASC").addOrderBy("m.market_id", "DESC");
        break;
      case "activity":
        qb.orderBy("m.updated_offset", "DESC");
        break;
      default:
        qb.orderBy("m.market_id", "DESC");
    }
    const [rows, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: await this.toApiMany(rows, false),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  /** Series categories with their live market counts (through the event); uncategorised series are left out. */
  async categories(): Promise<{ category: string; markets: number }[]> {
    const rows = await this.dataSource.query<{ category: string; markets: string }[]>(
      `SELECT s.category, COUNT(m.market_id)::text AS markets
         FROM to_markets m
         JOIN to_events e ON e.ticker = m.event_ticker
         JOIN to_series s ON s.ticker = e.series_ticker
        WHERE m.archived = false AND s.category <> ''
        GROUP BY s.category ORDER BY COUNT(m.market_id) DESC, s.category ASC`,
    );
    return rows.map((r) => ({ category: r.category, markets: Number(r.markets) }));
  }

  /** By numeric `marketId` or by ticker (case-insensitive) — every `/markets/:market` route accepts both. */
  async find(ref: number | string): Promise<MarketEntity | null> {
    const repo = this.dataSource.getRepository(MarketEntity);
    if (typeof ref === "number") return repo.findOneBy({ marketId: ref });
    const raw = ref.trim();
    if (/^\d+$/.test(raw)) return repo.findOneBy({ marketId: Number(raw) });
    const ticker = raw.toUpperCase();
    if (!TICKER_PATTERN.test(ticker)) return null;
    return repo.findOneBy({ ticker });
  }

  /** `find` or `404 not_found`. */
  async resolve(ref: number | string): Promise<MarketEntity> {
    const market = await this.find(ref);
    if (!market) throw new ApiError(404, "not_found", `market ${String(ref)} is not indexed`);
    return market;
  }

  async get(ref: number | string): Promise<ApiMarket> {
    const market = await this.resolve(ref);
    return this.toApi(market, true, await this.extrasOf(market));
  }

  /** Shape many rows with one batch of extras (list, event members). */
  async toApiMany(
    rows: MarketEntity[],
    withBlob: boolean,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ApiMarket[]> {
    const extras = await this.extrasFor(rows, manager);
    return rows.map((m) => this.toApi(m, withBlob, extras.get(m.marketId) ?? NO_EXTRAS));
  }

  async extrasOf(
    market: MarketEntity,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<MarketExtras> {
    return (await this.extrasFor([market], manager)).get(market.marketId) ?? NO_EXTRAS;
  }

  /**
   * The catalog side (series and category through the event, the event's image), the
   * backend-owned presentation (`to_market_metadata`, keyed by ticker) and the 24 h figures from
   * the hourly candles the projection maintains (docs/MARKETS.md §5) — a fixed number of set
   * queries however long the list is.
   */
  async extrasFor(
    rows: MarketEntity[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Map<number, MarketExtras>> {
    const out = new Map<number, MarketExtras>();
    if (rows.length === 0) return out;
    const ids = rows.map((m) => String(m.marketId));
    const eventTickers = [...new Set(rows.map((m) => m.eventTicker))];
    const catalogByEvent = new Map<
      string,
      { seriesTicker: string; category: string; imageUrl: string }
    >();
    const metadataByTicker = new Map<
      string,
      { imageUrl: string; description: string; updatedAt: Date }
    >();
    if (eventTickers.length > 0) {
      const events = await manager.query<
        { ticker: string; series_ticker: string; image_url: string; category: string | null }[]
      >(
        `SELECT e.ticker, e.series_ticker, e.image_url, s.category
           FROM to_events e LEFT JOIN to_series s ON s.ticker = e.series_ticker
          WHERE e.ticker = ANY($1::text[])`,
        [eventTickers],
      );
      for (const e of events)
        catalogByEvent.set(e.ticker, {
          seriesTicker: e.series_ticker,
          category: e.category ?? "",
          imageUrl: e.image_url,
        });
      const metadata = await manager.query<
        { ticker: string; image_url: string; description: string; updated_at: Date }[]
      >(
        `SELECT ticker, image_url, description, updated_at FROM to_market_metadata WHERE ticker = ANY($1::text[])`,
        [rows.map((m) => m.ticker)],
      );
      for (const md of metadata)
        metadataByTicker.set(md.ticker, {
          imageUrl: md.image_url,
          description: md.description,
          updatedAt: new Date(md.updated_at),
        });
    }
    const since = new Date(Date.now() - 86_400_000).toISOString();
    // One query at a time, never a Promise.all over `manager`: an admin write passes its
    // transaction's manager, and a transaction owns a single pg client, which refuses overlapping
    // queries (a deprecation warning today, an error from pg 9). Three small indexed set queries
    // are not worth a second code path that is only safe outside a transaction.
    const volumes = await manager.query<{ market_id: string; v: string }[]>(
      `SELECT market_id, COALESCE(SUM(volume), 0)::text AS v FROM to_market_candles
          WHERE period_secs = 3600 AND market_id = ANY($1::bigint[]) AND period_start >= $2
          GROUP BY market_id`,
      [ids, since],
    );
    const previous = await manager.query<{ market_id: string; close: string }[]>(
      `SELECT DISTINCT ON (market_id) market_id, close::text FROM to_market_candles
          WHERE period_secs = 3600 AND market_id = ANY($1::bigint[]) AND period_start < $2
          ORDER BY market_id, period_start DESC`,
      [ids, since],
    );
    const firsts = await manager.query<{ market_id: string; open: string }[]>(
      `SELECT DISTINCT ON (market_id) market_id, open::text FROM to_market_candles
          WHERE period_secs = 3600 AND market_id = ANY($1::bigint[])
          ORDER BY market_id, period_start ASC`,
      [ids],
    );
    const volumeById = new Map(volumes.map((r) => [Number(r.market_id), parseAmount(r.v)]));
    const prevById = new Map(previous.map((r) => [Number(r.market_id), parseAmount(r.close)]));
    const firstById = new Map(firsts.map((r) => [Number(r.market_id), parseAmount(r.open)]));
    for (const m of rows) {
      const catalog = catalogByEvent.get(m.eventTicker);
      out.set(m.marketId, {
        seriesTicker: catalog?.seriesTicker ?? null,
        category: catalog?.category ?? "",
        eventImageUrl: catalog?.imageUrl ?? "",
        metadata: metadataByTicker.get(m.ticker) ?? null,
        previousPrice: prevById.get(m.marketId) ?? firstById.get(m.marketId) ?? null,
        volume24h: volumeById.get(m.marketId) ?? 0n,
      });
    }
    return out;
  }

  async summaries(marketIds: number[]): Promise<Map<number, ApiMarketSummary>> {
    if (marketIds.length === 0) return new Map();
    const rows = await this.dataSource
      .getRepository(MarketEntity)
      .createQueryBuilder("m")
      .where("m.market_id IN (:...ids)", { ids: [...new Set(marketIds)] })
      .getMany();
    return this.summariesOf(rows);
  }

  /** Summaries for rows already in hand (portfolio) — one batch of extras for the image and category. */
  async summariesOf(rows: MarketEntity[]): Promise<Map<number, ApiMarketSummary>> {
    const out = new Map<number, ApiMarketSummary>();
    if (rows.length === 0) return out;
    const extras = await this.extrasFor(rows);
    for (const m of rows)
      out.set(m.marketId, this.toSummary(m, extras.get(m.marketId) ?? NO_EXTRAS));
    return out;
  }

  // ───────────────────────────────────────────── activity ─────────────────────────────────────────────

  async activity(query: ActivityQuery): Promise<ApiPage<ApiMarketEvent>> {
    const qb = this.dataSource.getRepository(MarketEventEntity).createQueryBuilder("e");
    if (query.marketId !== undefined)
      qb.andWhere("e.market_id = :marketId", { marketId: query.marketId });
    if (query.marketIds) {
      if (query.marketIds.length === 0)
        return {
          items: [],
          page: query.page,
          limit: query.limit,
          total: 0,
          ...(query.cursor !== undefined ? { nextCursor: null } : {}),
        };
      qb.andWhere("e.market_id IN (:...marketIds)", { marketIds: query.marketIds });
    }
    if (query.kind) qb.andWhere("e.kind = :kind", { kind: query.kind });
    else if (query.kinds) qb.andWhere("e.kind IN (:...kinds)", { kinds: [...query.kinds] });
    if (query.actors) {
      if (query.actors.length === 0)
        return { items: [], page: query.page, limit: query.limit, total: 0 };
      qb.andWhere("e.actor IN (:...actors)", { actors: query.actors });
    }
    qb.orderBy("e.offset", "DESC").addOrderBy("e.node_id", "DESC");
    if (query.cursor !== undefined) {
      // Keyset: no count, one row over the limit tells whether there is a next page.
      const after = query.cursor === "" ? null : parseCursor(query.cursor);
      if (query.cursor !== "" && !after)
        throw new ApiError(400, "validation_failed", "cursor is not one this feed issued");
      if (after)
        qb.andWhere("(e.offset < :cOffset OR (e.offset = :cOffset AND e.node_id < :cNode))", {
          cOffset: after.offset,
          cNode: after.nodeId,
        });
      const rows = await qb.take(query.limit + 1).getMany();
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const items = await this.toApiEvents(page);
      return {
        items,
        page: 1,
        limit: query.limit,
        total: items.length,
        nextCursor: rows.length > query.limit && last ? `${last.offset}:${last.nodeId}` : null,
      };
    }
    const [rows, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: await this.toApiEvents(rows),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  /** Shape activity rows with their markets' tickers and collateral looked up in one query. */
  async toApiEvents(rows: MarketEventEntity[]): Promise<ApiMarketEvent[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((e) => e.marketId))];
    const markets = await this.dataSource.query<
      { market_id: string; ticker: string; collateral_admin: string; collateral_id: string }[]
    >(
      `SELECT market_id::text, ticker, collateral_admin, collateral_id FROM to_markets WHERE market_id = ANY($1::bigint[])`,
      [ids.map(String)],
    );
    const byId = new Map(markets.map((r) => [Number(r.market_id), r]));
    return rows.map((e) => {
      const m = byId.get(e.marketId);
      return this.toApiEvent(
        e,
        m?.ticker ?? "",
        m ? this.instrumentRef(m.collateral_admin, m.collateral_id) : null,
      );
    });
  }

  trades(query: Omit<ActivityQuery, "kinds">): Promise<ApiPage<ApiMarketEvent>> {
    const kind = query.kind && TRADE_KINDS.includes(query.kind) ? query.kind : undefined;
    return this.activity({ ...query, kind, kinds: kind ? undefined : TRADE_KINDS });
  }

  /**
   * Price points for a chart: every market version (`raw`) or the last version per time bucket,
   * oldest first, within `[from, to]`, at most `limit` (the latest ones win when capped).
   */
  async priceHistory(
    marketId: number,
    opts: { from?: Date; to?: Date; resolution: PriceResolution; limit: number },
  ): Promise<{ marketId: number; resolution: PriceResolution; points: ApiPricePoint[] }> {
    const market = await this.find(marketId);
    if (!market) throw new ApiError(404, "not_found", `market ${marketId} is not indexed`);
    const width = PRICE_RESOLUTIONS[opts.resolution];
    const params: unknown[] = [marketId];
    const where: string[] = ["market_id = $1"];
    if (opts.from) {
      params.push(opts.from.toISOString());
      where.push(`effective_at >= $${params.length}`);
    }
    if (opts.to) {
      params.push(opts.to.toISOString());
      where.push(`effective_at <= $${params.length}`);
    }
    params.push(opts.limit);
    const limitParam = `$${params.length}`;
    const sql =
      width === 0
        ? `SELECT effective_at, price, total_volume, "offset" FROM (
             SELECT effective_at, price, total_volume, "offset" FROM to_market_snapshots
             WHERE ${where.join(" AND ")} ORDER BY "offset" DESC, node_id DESC LIMIT ${limitParam}
           ) latest ORDER BY "offset" ASC`
        : `SELECT effective_at, price, total_volume, "offset" FROM (
             SELECT DISTINCT ON (bucket) to_timestamp(bucket) AS effective_at, price, total_volume, "offset"
             FROM (
               SELECT floor(extract(epoch FROM effective_at) / ${width}) * ${width} AS bucket, price, total_volume, "offset", node_id
               FROM to_market_snapshots WHERE ${where.join(" AND ")}
             ) b ORDER BY bucket DESC, "offset" DESC, node_id DESC LIMIT ${limitParam}
           ) latest ORDER BY "offset" ASC`;
    const rows = await this.dataSource.query<
      { effective_at: Date | string; price: string; total_volume: string; offset: string }[]
    >(sql, params);
    return {
      marketId,
      resolution: opts.resolution,
      points: rows.map((r) => ({
        t: new Date(r.effective_at).toISOString(),
        price: formatAmount(parseAmount(r.price)),
        volume: formatAmount(parseAmount(r.total_volume)),
        offset: Number(r.offset),
      })),
    };
  }

  async forecasts(marketId: number, includeArchived = false): Promise<ApiModelForecast[]> {
    const qb = this.dataSource
      .getRepository(ModelForecastEntity)
      .createQueryBuilder("f")
      .where("f.market_id = :marketId", { marketId });
    if (!includeArchived) qb.andWhere("f.active = true");
    const rows = await qb
      .orderBy("f.committed_at_sec", "ASC")
      .addOrderBy("f.created_offset", "ASC")
      .getMany();
    return rows.map((f) => ({
      contractId: f.contractId,
      author: f.author,
      marketId: f.marketId,
      modelId: f.modelId,
      probabilityYes: formatAmount(f.probabilityYes),
      committedAt: secToIso(f.committedAtSec),
      marketPriceAtCommit: formatAmount(f.marketPriceAtCommit),
      active: f.active,
      createdOffset: f.createdOffset,
    }));
  }

  async attestations(marketId: number, includeArchived = false): Promise<ApiAttestation[]> {
    const qb = this.dataSource
      .getRepository(AttestationEntity)
      .createQueryBuilder("a")
      .where("a.market_id = :marketId", { marketId });
    if (!includeArchived) qb.andWhere("a.active = true");
    const rows = await qb
      .orderBy("a.fetched_at_sec", "ASC")
      .addOrderBy("a.created_offset", "ASC")
      .getMany();
    return rows.map((a) => ({
      contractId: a.contractId,
      attester: a.attester,
      marketId: a.marketId,
      sourceUri: a.sourceUri,
      fetchedAt: secToIso(a.fetchedAtSec),
      outcome: a.outcome,
      payloadHash: a.payloadHash,
      hasSourceSignature: a.sourceSignature !== null,
      responseExcerpt: a.responseExcerpt,
      active: a.active,
      createdOffset: a.createdOffset,
    }));
  }

  /** Active positions in one market, largest first (operator view — holders are not public). */
  async holders(marketId: number, page: number, limit: number): Promise<ApiPage<ApiPosition>> {
    const market = await this.find(marketId);
    const [rows, total] = await this.dataSource
      .getRepository(PositionEntity)
      .createQueryBuilder("p")
      .where("p.market_id = :marketId AND p.active = true", { marketId })
      .orderBy("(p.yes_shares + p.no_shares)", "DESC")
      .addOrderBy("p.created_offset", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const summary = market ? this.toSummary(market) : null;
    return { items: rows.map((p) => this.toApiPosition(p, market, summary)), page, limit, total };
  }

  async liquidityProviders(
    marketId: number,
    page: number,
    limit: number,
  ): Promise<ApiPage<ApiLiquidityPosition>> {
    const market = await this.find(marketId);
    const [rows, total] = await this.dataSource
      .getRepository(LiquidityPositionEntity)
      .createQueryBuilder("l")
      .where("l.market_id = :marketId AND l.active = true", { marketId })
      .orderBy("l.lp_tokens", "DESC")
      .addOrderBy("l.created_offset", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const summary = market ? this.toSummary(market) : null;
    return { items: rows.map((l) => this.toApiLiquidity(l, market, summary)), page, limit, total };
  }

  // ───────────────────────────────────────────── aggregates ─────────────────────────────────────────────

  /** Platform aggregates over the markets of ONE instrument (sums across tokens would be meaningless). */
  async stats(indexedOffset: number, requested?: InstrumentId): Promise<ApiStats> {
    const instrument = await this.aggregateInstrument(requested);
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const kinds = [...TRADE_KINDS];
    const collateral = [instrument.admin, instrument.id];
    const [byStatus, volume, trades, traders] = await Promise.all([
      this.dataSource.query<{ status: string; n: string }[]>(
        `SELECT status, COUNT(*)::text AS n FROM to_markets
          WHERE archived = false AND collateral_admin = $1 AND collateral_id = $2 GROUP BY status`,
        collateral,
      ),
      this.dataSource.query<{ total: string | null }[]>(
        `SELECT COALESCE(SUM(total_volume), 0)::text AS total FROM to_markets
          WHERE archived = false AND collateral_admin = $1 AND collateral_id = $2`,
        collateral,
      ),
      this.dataSource.query<{ n: string; n24: string; v24: string | null }[]>(
        `SELECT COUNT(*)::text AS n,
                COUNT(*) FILTER (WHERE e.effective_at >= $2)::text AS n24,
                COALESCE(SUM(e.amount) FILTER (WHERE e.effective_at >= $2), 0)::text AS v24
         FROM to_market_events e JOIN to_markets m ON m.market_id = e.market_id
         WHERE e.kind = ANY($1::text[]) AND m.collateral_admin = $3 AND m.collateral_id = $4`,
        [kinds, since, ...collateral],
      ),
      this.dataSource.query<{ n: string }[]>(
        `SELECT COUNT(DISTINCT e.actor)::text AS n
           FROM to_market_events e JOIN to_markets m ON m.market_id = e.market_id
          WHERE e.kind = ANY($1::text[]) AND m.collateral_admin = $2 AND m.collateral_id = $3`,
        [kinds, ...collateral],
      ),
    ]);
    const count = (status: string): number =>
      Number(byStatus.find((r) => r.status === status)?.n ?? 0);
    const trading = count("Trading");
    const proposed = count("Proposed");
    const resolved = count("Resolved");
    const voided = count("Voided");
    return {
      instrument,
      markets: {
        total: trading + proposed + resolved + voided,
        trading,
        proposed,
        resolved,
        voided,
      },
      totalVolume: formatAmount(parseAmount(volume[0]?.total ?? "0")),
      volume24h: formatAmount(parseAmount(trades[0]?.v24 ?? "0")),
      trades: Number(trades[0]?.n ?? 0),
      trades24h: Number(trades[0]?.n24 ?? 0),
      traders: Number(traders[0]?.n ?? 0),
      indexedOffset,
    };
  }

  /** Traders ranked by collateral traded in the window, in ONE instrument; realised PnL from their wallet cash flows in it over the same window. */
  async leaderboard(
    window: LeaderboardWindow,
    limit: number,
    requested?: InstrumentId,
  ): Promise<{
    window: LeaderboardWindow;
    instrument: InstrumentRef;
    entries: ApiLeaderboardEntry[];
  }> {
    const instrument = await this.aggregateInstrument(requested);
    const ms = WINDOW_MS[window];
    const since = ms === null ? null : new Date(Date.now() - ms).toISOString();
    const kinds = [...TRADE_KINDS];
    const volumeRows = await this.dataSource.query<
      { actor: string; volume: string; trades: string; markets: string }[]
    >(
      `SELECT e.actor, COALESCE(SUM(e.amount), 0)::text AS volume, COUNT(*)::text AS trades, COUNT(DISTINCT e.market_id)::text AS markets
       FROM to_market_events e JOIN to_markets m ON m.market_id = e.market_id
       WHERE e.kind = ANY($1::text[]) AND m.collateral_admin = $3 AND m.collateral_id = $4 ${since ? "AND e.effective_at >= $5" : ""}
       GROUP BY e.actor ORDER BY SUM(e.amount) DESC NULLS LAST, COUNT(*) DESC LIMIT $2`,
      since
        ? [kinds, limit, instrument.admin, instrument.id, since]
        : [kinds, limit, instrument.admin, instrument.id],
    );
    if (volumeRows.length === 0) return { window, instrument, entries: [] };
    const owners = volumeRows.map((r) => r.actor);
    const pnlRows = await this.dataSource.query<
      { owner: string; credits: string; debits: string }[]
    >(
      `SELECT owner,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'credit' AND reason = ANY($2::text[])), 0)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'debit' AND reason = ANY($3::text[])), 0)::text AS debits
       FROM to_wallet_entries
       WHERE owner = ANY($1::text[]) AND instrument_admin = $4 AND instrument_id = $5 ${since ? "AND effective_at >= $6" : ""}
       GROUP BY owner`,
      since
        ? [owners, PNL_CREDIT_REASONS, PNL_DEBIT_REASONS, instrument.admin, instrument.id, since]
        : [owners, PNL_CREDIT_REASONS, PNL_DEBIT_REASONS, instrument.admin, instrument.id],
    );
    const pnl = new Map(
      pnlRows.map((r) => [r.owner, parseAmount(r.credits) - parseAmount(r.debits)]),
    );
    return {
      window,
      instrument,
      entries: volumeRows.map((r) => ({
        party: r.actor,
        instrument,
        volume: formatAmount(parseAmount(r.volume)),
        trades: Number(r.trades),
        markets: Number(r.markets),
        realizedPnl: formatAmount(pnl.get(r.actor) ?? 0n),
      })),
    };
  }

  // ───────────────────────────────────────────── shaping ─────────────────────────────────────────────

  phaseOf(
    m: Pick<MarketEntity, "status" | "createdAtSec" | "expiresAtSec" | "liquidityPeriodSecs">,
    nowSec = Math.floor(Date.now() / 1000),
  ): MarketPhase {
    if (m.status === "Resolved") return "resolved";
    if (m.status === "Voided") return "voided";
    if (m.status === "Proposed") return "proposed";
    if (nowSec < m.createdAtSec + m.liquidityPeriodSecs) return "liquidity";
    if (nowSec >= m.expiresAtSec) return "expired";
    return "trading";
  }

  toApi(m: MarketEntity, withBlob: boolean, extras: MarketExtras = NO_EXTRAS): ApiMarket {
    const nowSec = Math.floor(Date.now() / 1000);
    const phase = this.phaseOf(m, nowSec);
    const amm = ammStateOf(m);
    const effectiveL = marketEffectiveL(amm, nowSec);
    const liquidity = effectiveL > 0 ? poolValue(amm.currentPrice, effectiveL) : 0;
    const book = phase === "trading" ? impliedQuoteBook(amm, nowSec, BOOK_REFERENCE_AMOUNT) : null;
    const proposal = m.proposal
      ? {
          proposer: m.proposal.proposer,
          proposedOutcome: m.proposal.proposedOutcome,
          proposedAt: secToIso(m.proposal.proposedAtSec),
          bond: m.proposal.bond,
          challenger: m.proposal.challenger,
          challengerOutcome: m.proposal.challengerOutcome,
          challengeEndsAt: secToIso(m.proposal.proposedAtSec + (m.policy?.challengeSecs ?? 0)),
        }
      : null;
    const api: ApiMarket = {
      marketId: m.marketId,
      ticker: m.ticker,
      eventTicker: m.eventTicker,
      seriesTicker: extras.seriesTicker,
      yesSubTitle: m.yesSubTitle,
      noSubTitle: m.noSubTitle,
      contractId: m.contractId,
      templateId: m.templateId,
      admin: m.admin,
      collateral: this.collateralOf(m),
      question: m.question,
      imageUrl: imageUrlOf(extras),
      description: extras.metadata?.description ?? "",
      resolutionDescription: m.resolutionDescription,
      category: extras.category,
      metadata: extras.metadata
        ? {
            imageUrl: extras.metadata.imageUrl,
            description: extras.metadata.description,
            updatedAt: extras.metadata.updatedAt.toISOString(),
          }
        : null,
      createdAt: secToIso(m.createdAtSec),
      expiresAt: secToIso(m.expiresAtSec),
      tradingStartsAt: secToIso(m.createdAtSec + m.liquidityPeriodSecs),
      gracePeriodSecs: m.gracePeriodSecs,
      isDynamic: m.isDynamic,
      liquidityPeriodSecs: m.liquidityPeriodSecs,
      reserveYes: formatAmount(m.reserveYes),
      reserveNo: formatAmount(m.reserveNo),
      liquidityL: formatAmount(m.liquidityL),
      lpTokenSupply: formatAmount(m.lpTokenSupply),
      currentPrice: formatAmount(m.currentPrice),
      feeBps: m.feeBps,
      prizeFeeShareBps: m.prizeFeeShareBps,
      accumulatedFees: formatAmount(m.accumulatedFees),
      prizePool: formatAmount(m.prizePool),
      totalVolume: formatAmount(m.totalVolume),
      status: m.status,
      outcome: m.outcome,
      resolvedAt: m.resolvedAtSec === null ? null : secToIso(m.resolvedAtSec),
      proposal,
      policy: {
        operatorResolution: m.policy?.operatorResolution ?? false,
        sources: m.policy?.sources ?? [],
        sourceKeys: m.policy?.sourceKeys ?? [],
        reporters: m.policy?.reporters ?? [],
        quorum: m.policy?.quorum ?? 0,
        challengeSecs: m.policy?.challengeSecs ?? 0,
        bond: m.policy?.bond ?? formatAmount(0n),
      },
      auditObservers: m.auditObservers ?? [],
      phase,
      archived: m.archived,
      tradeCount: m.tradeCount,
      lastTradeAt: m.lastTradeAt ? m.lastTradeAt.toISOString() : null,
      previousPrice: extras.previousPrice === null ? null : formatAmount(extras.previousPrice),
      priceChange24h:
        extras.previousPrice === null ? null : formatAmount(m.currentPrice - extras.previousPrice),
      volume24h: formatAmount(extras.volume24h),
      openInterest: {
        yes: formatAmount(m.openInterestYes),
        no: formatAmount(m.openInterestNo),
        total: formatAmount(m.openInterestYes + m.openInterestNo),
      },
      liquidity: formatAmount(numberToDecimal(liquidity)),
      book: book
        ? {
            yesBid: formatAmount(numberToDecimal(book.yesBid)),
            yesAsk: formatAmount(numberToDecimal(book.yesAsk)),
            noBid: formatAmount(numberToDecimal(book.noBid)),
            noAsk: formatAmount(numberToDecimal(book.noAsk)),
            reference: formatAmount(numberToDecimal(BOOK_REFERENCE_AMOUNT)),
          }
        : null,
      updatedOffset: m.updatedOffset,
      createdOffset: m.createdOffset,
      synchronizerId: m.synchronizerId,
    };
    if (withBlob) api.createdEventBlob = m.createdEventBlob;
    return api;
  }

  toSummary(m: MarketEntity, extras: MarketExtras = NO_EXTRAS): ApiMarketSummary {
    return {
      marketId: m.marketId,
      ticker: m.ticker,
      eventTicker: m.eventTicker,
      yesSubTitle: m.yesSubTitle,
      noSubTitle: m.noSubTitle,
      contractId: m.contractId,
      collateral: this.collateralOf(m),
      question: m.question,
      imageUrl: imageUrlOf(extras),
      category: extras.category,
      status: m.status,
      outcome: m.outcome,
      currentPrice: formatAmount(m.currentPrice),
      expiresAt: secToIso(m.expiresAtSec),
      resolvedAt: m.resolvedAtSec === null ? null : secToIso(m.resolvedAtSec),
      phase: this.phaseOf(m),
      archived: m.archived,
    };
  }

  /**
   * One activity row; `collateral` is the market's (batch-loaded by `toApiEvents`). A row whose
   * market the index no longer holds falls back to an empty ref (blank admin and id at the 10-dp
   * scale) so the shape stays total — such a row cannot exist in a consistent index.
   */
  toApiEvent(
    e: MarketEventEntity,
    ticker = "",
    collateral: InstrumentRef | null = null,
  ): ApiMarketEvent {
    const dec = (v: bigint | null): string | null => (v === null ? null : formatAmount(v));
    const action = (TRADE_ACTIONS as readonly string[]).includes(e.kind)
      ? (e.kind as TradeAction)
      : null;
    return {
      id: String(e.id),
      eventId: e.eventId,
      marketId: e.marketId,
      kind: e.kind,
      actor: e.actor,
      side: e.side,
      instrument: collateral ?? this.instruments.refOf({ admin: "", id: "" }),
      amount: dec(e.amount),
      net: dec(e.net),
      shares: dec(e.shares),
      sharesOut: dec(e.sharesOut),
      fee: dec(e.fee),
      priceBefore: dec(e.priceBefore),
      priceAfter: dec(e.priceAfter),
      lpTokens: dec(e.lpTokens),
      outcome: e.outcome,
      details: e.details ?? {},
      offset: e.offset,
      updateId: e.updateId,
      commandId: e.commandId,
      effectiveAt: e.effectiveAt.toISOString(),
      tradeId: e.eventId,
      ticker,
      action,
      yesPrice: dec(e.priceAfter),
      noPrice: e.priceAfter === null ? null : formatAmount(ONE_DECIMAL - e.priceAfter),
      notional: dec(e.amount),
      takerParty: maskParty(e.actor),
      createdAt: e.effectiveAt.toISOString(),
    };
  }

  /** Mark-to-market / redeemable value of a position against the market it belongs to (fixed point). */
  positionValue(
    p: Pick<PositionEntity, "yesShares" | "noShares" | "costBasis">,
    market: Pick<MarketEntity, "status" | "outcome" | "currentPrice"> | null,
  ): { value: bigint | null; redeemable: bigint | null } {
    if (!market) return { value: null, redeemable: null };
    if (market.status === "Resolved") {
      const winning =
        market.outcome === "Yes" ? p.yesShares : market.outcome === "No" ? p.noShares : 0n;
      return { value: winning, redeemable: winning };
    }
    if (market.status === "Voided") {
      const held = p.yesShares > p.noShares ? p.yesShares : p.noShares;
      const refund = p.costBasis < held ? p.costBasis : held;
      return { value: refund, redeemable: refund };
    }
    const value =
      mulDecimal(p.yesShares, market.currentPrice) +
      mulDecimal(p.noShares, ONE_DECIMAL - market.currentPrice);
    return { value: value, redeemable: null };
  }

  toApiPosition(
    p: PositionEntity,
    market: MarketEntity | null,
    summary: ApiMarketSummary | null,
  ): ApiPosition {
    const { value, redeemable } = this.positionValue(p, market);
    return {
      contractId: p.contractId,
      holder: p.holder,
      marketId: p.marketId,
      instrument: summary?.collateral ?? (market ? this.collateralOf(market) : null),
      yesShares: formatAmount(p.yesShares),
      noShares: formatAmount(p.noShares),
      costBasis: formatAmount(p.costBasis),
      active: p.active,
      createdAt: (p.createdAtLedger ?? p.createdAt).toISOString(),
      createdOffset: p.createdOffset,
      archivedAt: p.archivedAtLedger ? p.archivedAtLedger.toISOString() : null,
      market: summary,
      value: value === null ? null : formatAmount(value),
      redeemable: redeemable === null ? null : formatAmount(redeemable),
    };
  }

  toApiLiquidity(
    l: LiquidityPositionEntity,
    market: MarketEntity | null,
    summary: ApiMarketSummary | null,
  ): ApiLiquidityPosition {
    return {
      contractId: l.contractId,
      provider: l.provider,
      marketId: l.marketId,
      instrument: summary?.collateral ?? (market ? this.collateralOf(market) : null),
      lpTokens: formatAmount(l.lpTokens),
      deposited: formatAmount(l.deposited),
      active: l.active,
      createdAt: (l.createdAtLedger ?? l.createdAt).toISOString(),
      createdOffset: l.createdOffset,
      archivedAt: l.archivedAtLedger ? l.archivedAtLedger.toISOString() : null,
      market: summary,
      poolShare:
        market && market.lpTokenSupply > 0n
          ? formatAmount(divDecimal(l.lpTokens, market.lpTokenSupply))
          : null,
    };
  }
}

export function secToIso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Shared by the portfolio service: apply `marketIds` filtering to a positions / LP query. */
export function whereParties<T extends object>(
  qb: SelectQueryBuilder<T>,
  column: string,
  parties: string[],
): SelectQueryBuilder<T> {
  return qb.andWhere(`${column} IN (:...parties)`, { parties });
}

/** The market's own image when the operator set one, else its event's, else "" (docs/MARKETS.md §1). */
function imageUrlOf(extras: MarketExtras): string {
  return extras.metadata?.imageUrl || extras.eventImageUrl || "";
}
