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
  type MarketEventKind,
  type MarketPhase,
  type MarketStatus,
} from "../types";
import { ApiError } from "../util/errors";
import { divDecimal, mulDecimal, ONE_DECIMAL } from "../util/ledger-values";
import { formatCC, parseCC } from "../util/money";

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

/** Per-market figures the API adds on top of the row (docs/MARKETS.md §3): batch-loaded by `extrasFor`. */
export interface MarketExtras {
  seriesTicker: string | null;
  /** The price 24 h ago (the last hourly close before then), else the market's first price; null without candles. */
  previousPrice: bigint | null;
  /** Σ candle volume of the last 24 h. */
  volume24h: bigint;
}

const NO_EXTRAS: MarketExtras = { seriesTicker: null, previousPrice: null, volume24h: 0n };
/** Collateral of the reference buy behind `ApiMarket.book` (one CC — a retail-sized order). */
const BOOK_REFERENCE_CC = 1;

export interface ActivityQuery {
  kind?: MarketEventKind;
  kinds?: readonly MarketEventKind[];
  actors?: string[];
  marketId?: number;
  page: number;
  limit: number;
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
 * "stale by the indexer's lag", never to an error.
 */
@Injectable()
export class MarketsService {
  constructor(private readonly dataSource: DataSource) {}

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
    if (query.category) qb.andWhere("m.category = :category", { category: query.category });
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
        "(m.question ILIKE :q OR m.description ILIKE :q OR m.category ILIKE :q OR m.ticker ILIKE :q OR m.event_ticker ILIKE :q)",
        { q: `%${escapeLike(query.q)}%` },
      );
    switch (query.sort ?? "newest") {
      case "oldest":
        qb.orderBy("m.market_id", "ASC");
        break;
      case "volume":
        qb.orderBy("m.total_volume_cc", "DESC").addOrderBy("m.market_id", "DESC");
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

  async categories(): Promise<{ category: string; markets: number }[]> {
    const rows = await this.dataSource.query<{ category: string; markets: string }[]>(
      `SELECT category, COUNT(*)::text AS markets FROM to_markets WHERE archived = false GROUP BY category ORDER BY COUNT(*) DESC, category ASC`,
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
   * Series membership (through the event) and the 24 h figures, from the hourly candles the
   * projection maintains (docs/MARKETS.md §5) — two set queries however long the list is.
   */
  async extrasFor(
    rows: MarketEntity[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Map<number, MarketExtras>> {
    const out = new Map<number, MarketExtras>();
    if (rows.length === 0) return out;
    const ids = rows.map((m) => String(m.marketId));
    const eventTickers = [...new Set(rows.map((m) => m.eventTicker).filter((t): t is string => !!t))];
    const seriesByEvent = new Map<string, string>();
    if (eventTickers.length > 0) {
      const events = await manager.query<{ ticker: string; series_ticker: string }[]>(
        `SELECT ticker, series_ticker FROM to_events WHERE ticker = ANY($1::text[])`,
        [eventTickers],
      );
      for (const e of events) seriesByEvent.set(e.ticker, e.series_ticker);
    }
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const [volumes, previous, firsts] = await Promise.all([
      manager.query<{ market_id: string; v: string }[]>(
        `SELECT market_id, COALESCE(SUM(volume_cc), 0)::text AS v FROM to_market_candles
          WHERE period_secs = 3600 AND market_id = ANY($1::bigint[]) AND period_start >= $2
          GROUP BY market_id`,
        [ids, since],
      ),
      manager.query<{ market_id: string; close: string }[]>(
        `SELECT DISTINCT ON (market_id) market_id, close::text FROM to_market_candles
          WHERE period_secs = 3600 AND market_id = ANY($1::bigint[]) AND period_start < $2
          ORDER BY market_id, period_start DESC`,
        [ids, since],
      ),
      manager.query<{ market_id: string; open: string }[]>(
        `SELECT DISTINCT ON (market_id) market_id, open::text FROM to_market_candles
          WHERE period_secs = 3600 AND market_id = ANY($1::bigint[])
          ORDER BY market_id, period_start ASC`,
        [ids],
      ),
    ]);
    const volumeById = new Map(volumes.map((r) => [Number(r.market_id), parseCC(r.v)]));
    const prevById = new Map(previous.map((r) => [Number(r.market_id), parseCC(r.close)]));
    const firstById = new Map(firsts.map((r) => [Number(r.market_id), parseCC(r.open)]));
    for (const m of rows) {
      out.set(m.marketId, {
        seriesTicker: m.eventTicker ? (seriesByEvent.get(m.eventTicker) ?? null) : null,
        previousPrice: prevById.get(m.marketId) ?? firstById.get(m.marketId) ?? null,
        volume24h: volumeById.get(m.marketId) ?? 0n,
      });
    }
    return out;
  }

  async summaries(marketIds: number[]): Promise<Map<number, ApiMarketSummary>> {
    const out = new Map<number, ApiMarketSummary>();
    if (marketIds.length === 0) return out;
    const rows = await this.dataSource
      .getRepository(MarketEntity)
      .createQueryBuilder("m")
      .where("m.market_id IN (:...ids)", { ids: [...new Set(marketIds)] })
      .getMany();
    for (const m of rows) out.set(m.marketId, this.toSummary(m));
    return out;
  }

  // ───────────────────────────────────────────── activity ─────────────────────────────────────────────

  async activity(query: ActivityQuery): Promise<ApiPage<ApiMarketEvent>> {
    const qb = this.dataSource.getRepository(MarketEventEntity).createQueryBuilder("e");
    if (query.marketId !== undefined)
      qb.andWhere("e.market_id = :marketId", { marketId: query.marketId });
    if (query.kind) qb.andWhere("e.kind = :kind", { kind: query.kind });
    else if (query.kinds) qb.andWhere("e.kind IN (:...kinds)", { kinds: [...query.kinds] });
    if (query.actors) {
      if (query.actors.length === 0)
        return { items: [], page: query.page, limit: query.limit, total: 0 };
      qb.andWhere("e.actor IN (:...actors)", { actors: query.actors });
    }
    const [rows, total] = await qb
      .orderBy("e.offset", "DESC")
      .addOrderBy("e.node_id", "DESC")
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: rows.map((e) => this.toApiEvent(e)),
      page: query.page,
      limit: query.limit,
      total,
    };
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
        ? `SELECT effective_at, price, total_volume_cc, "offset" FROM (
             SELECT effective_at, price, total_volume_cc, "offset" FROM to_market_snapshots
             WHERE ${where.join(" AND ")} ORDER BY "offset" DESC, node_id DESC LIMIT ${limitParam}
           ) latest ORDER BY "offset" ASC`
        : `SELECT effective_at, price, total_volume_cc, "offset" FROM (
             SELECT DISTINCT ON (bucket) to_timestamp(bucket) AS effective_at, price, total_volume_cc, "offset"
             FROM (
               SELECT floor(extract(epoch FROM effective_at) / ${width}) * ${width} AS bucket, price, total_volume_cc, "offset", node_id
               FROM to_market_snapshots WHERE ${where.join(" AND ")}
             ) b ORDER BY bucket DESC, "offset" DESC, node_id DESC LIMIT ${limitParam}
           ) latest ORDER BY "offset" ASC`;
    const rows = await this.dataSource.query<
      { effective_at: Date | string; price: string; total_volume_cc: string; offset: string }[]
    >(sql, params);
    return {
      marketId,
      resolution: opts.resolution,
      points: rows.map((r) => ({
        t: new Date(r.effective_at).toISOString(),
        price: formatCC(parseCC(r.price)),
        volumeCC: formatCC(parseCC(r.total_volume_cc)),
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
      probabilityYes: formatCC(f.probabilityYes),
      committedAt: secToIso(f.committedAtSec),
      marketPriceAtCommit: formatCC(f.marketPriceAtCommit),
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

  async stats(indexedOffset: number): Promise<ApiStats> {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const kinds = [...TRADE_KINDS];
    const [byStatus, volume, trades, traders] = await Promise.all([
      this.dataSource.query<{ status: string; n: string }[]>(
        `SELECT status, COUNT(*)::text AS n FROM to_markets WHERE archived = false GROUP BY status`,
      ),
      this.dataSource.query<{ total: string | null }[]>(
        `SELECT COALESCE(SUM(total_volume_cc), 0)::text AS total FROM to_markets WHERE archived = false`,
      ),
      this.dataSource.query<{ n: string; n24: string; v24: string | null }[]>(
        `SELECT COUNT(*)::text AS n,
                COUNT(*) FILTER (WHERE effective_at >= $2)::text AS n24,
                COALESCE(SUM(amount_cc) FILTER (WHERE effective_at >= $2), 0)::text AS v24
         FROM to_market_events WHERE kind = ANY($1::text[])`,
        [kinds, since],
      ),
      this.dataSource.query<{ n: string }[]>(
        `SELECT COUNT(DISTINCT actor)::text AS n FROM to_market_events WHERE kind = ANY($1::text[])`,
        [kinds],
      ),
    ]);
    const count = (status: string): number =>
      Number(byStatus.find((r) => r.status === status)?.n ?? 0);
    const trading = count("Trading");
    const proposed = count("Proposed");
    const resolved = count("Resolved");
    const voided = count("Voided");
    return {
      markets: {
        total: trading + proposed + resolved + voided,
        trading,
        proposed,
        resolved,
        voided,
      },
      totalVolumeCC: formatCC(parseCC(volume[0]?.total ?? "0")),
      volume24hCC: formatCC(parseCC(trades[0]?.v24 ?? "0")),
      trades: Number(trades[0]?.n ?? 0),
      trades24h: Number(trades[0]?.n24 ?? 0),
      traders: Number(traders[0]?.n ?? 0),
      indexedOffset,
    };
  }

  /** Traders ranked by CC traded in the window; realised PnL from their wallet cash flows over the same window. */
  async leaderboard(
    window: LeaderboardWindow,
    limit: number,
  ): Promise<{ window: LeaderboardWindow; entries: ApiLeaderboardEntry[] }> {
    const ms = WINDOW_MS[window];
    const since = ms === null ? null : new Date(Date.now() - ms).toISOString();
    const kinds = [...TRADE_KINDS];
    const volumeRows = await this.dataSource.query<
      { actor: string; volume: string; trades: string; markets: string }[]
    >(
      `SELECT actor, COALESCE(SUM(amount_cc), 0)::text AS volume, COUNT(*)::text AS trades, COUNT(DISTINCT market_id)::text AS markets
       FROM to_market_events WHERE kind = ANY($1::text[]) ${since ? "AND effective_at >= $3" : ""}
       GROUP BY actor ORDER BY SUM(amount_cc) DESC NULLS LAST, COUNT(*) DESC LIMIT $2`,
      since ? [kinds, limit, since] : [kinds, limit],
    );
    if (volumeRows.length === 0) return { window, entries: [] };
    const owners = volumeRows.map((r) => r.actor);
    const pnlRows = await this.dataSource.query<
      { owner: string; credits: string; debits: string }[]
    >(
      `SELECT owner,
              COALESCE(SUM(amount_cc) FILTER (WHERE kind = 'credit' AND reason = ANY($2::text[])), 0)::text AS credits,
              COALESCE(SUM(amount_cc) FILTER (WHERE kind = 'debit' AND reason = ANY($3::text[])), 0)::text AS debits
       FROM to_wallet_entries WHERE owner = ANY($1::text[]) ${since ? "AND effective_at >= $4" : ""}
       GROUP BY owner`,
      since
        ? [owners, PNL_CREDIT_REASONS, PNL_DEBIT_REASONS, since]
        : [owners, PNL_CREDIT_REASONS, PNL_DEBIT_REASONS],
    );
    const pnl = new Map(pnlRows.map((r) => [r.owner, parseCC(r.credits) - parseCC(r.debits)]));
    return {
      window,
      entries: volumeRows.map((r) => ({
        party: r.actor,
        volumeCC: formatCC(parseCC(r.volume)),
        trades: Number(r.trades),
        markets: Number(r.markets),
        realizedPnlCC: formatCC(pnl.get(r.actor) ?? 0n),
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
    const liquidityCC = effectiveL > 0 ? poolValue(amm.currentPrice, effectiveL) : 0;
    const book = phase === "trading" ? impliedQuoteBook(amm, nowSec, BOOK_REFERENCE_CC) : null;
    const proposal = m.proposal
      ? {
          proposer: m.proposal.proposer,
          proposedOutcome: m.proposal.proposedOutcome,
          proposedAt: secToIso(m.proposal.proposedAtSec),
          bondCC: m.proposal.bondCC,
          challenger: m.proposal.challenger,
          challengerOutcome: m.proposal.challengerOutcome,
          challengeEndsAt: secToIso(m.proposal.proposedAtSec + (m.policy?.challengeSecs ?? 0)),
        }
      : null;
    const api: ApiMarket = {
      marketId: m.marketId,
      ticker: m.ticker,
      tickerSource: m.tickerSource,
      eventTicker: m.eventTicker,
      eventTickerSource: m.eventTickerSource,
      seriesTicker: extras.seriesTicker,
      yesSubTitle: m.yesSubTitle,
      noSubTitle: m.noSubTitle,
      subTitlesFromLedger: m.subTitlesFromLedger,
      contractId: m.contractId,
      templateId: m.templateId,
      admin: m.admin,
      question: m.question,
      imageUrl: m.imageUrl,
      description: m.description,
      resolutionDescription: m.resolutionDescription,
      category: m.category,
      createdAt: secToIso(m.createdAtSec),
      expiresAt: secToIso(m.expiresAtSec),
      tradingStartsAt: secToIso(m.createdAtSec + m.liquidityPeriodSecs),
      gracePeriodSecs: m.gracePeriodSecs,
      isDynamic: m.isDynamic,
      liquidityPeriodSecs: m.liquidityPeriodSecs,
      reserveYes: formatCC(m.reserveYes),
      reserveNo: formatCC(m.reserveNo),
      liquidityL: formatCC(m.liquidityL),
      lpTokenSupply: formatCC(m.lpTokenSupply),
      currentPrice: formatCC(m.currentPrice),
      feeBps: m.feeBps,
      prizeFeeShareBps: m.prizeFeeShareBps,
      accumulatedFeesCC: formatCC(m.accumulatedFeesCC),
      prizePoolCC: formatCC(m.prizePoolCC),
      totalVolumeCC: formatCC(m.totalVolumeCC),
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
        bondCC: m.policy?.bondCC ?? formatCC(0n),
      },
      auditObservers: m.auditObservers ?? [],
      phase,
      archived: m.archived,
      tradeCount: m.tradeCount,
      lastTradeAt: m.lastTradeAt ? m.lastTradeAt.toISOString() : null,
      previousPrice: extras.previousPrice === null ? null : formatCC(extras.previousPrice),
      priceChange24h:
        extras.previousPrice === null ? null : formatCC(m.currentPrice - extras.previousPrice),
      volume24hCC: formatCC(extras.volume24h),
      openInterest: {
        yes: formatCC(m.openInterestYes),
        no: formatCC(m.openInterestNo),
        total: formatCC(m.openInterestYes + m.openInterestNo),
      },
      liquidityCC: formatCC(numberToDecimal(liquidityCC)),
      book: book
        ? {
            yesBid: formatCC(numberToDecimal(book.yesBid)),
            yesAsk: formatCC(numberToDecimal(book.yesAsk)),
            noBid: formatCC(numberToDecimal(book.noBid)),
            noAsk: formatCC(numberToDecimal(book.noAsk)),
            referenceCC: formatCC(numberToDecimal(BOOK_REFERENCE_CC)),
          }
        : null,
      updatedOffset: m.updatedOffset,
      createdOffset: m.createdOffset,
      synchronizerId: m.synchronizerId,
    };
    if (withBlob) api.createdEventBlob = m.createdEventBlob;
    return api;
  }

  toSummary(m: MarketEntity): ApiMarketSummary {
    return {
      marketId: m.marketId,
      ticker: m.ticker,
      eventTicker: m.eventTicker,
      yesSubTitle: m.yesSubTitle,
      noSubTitle: m.noSubTitle,
      contractId: m.contractId,
      question: m.question,
      imageUrl: m.imageUrl,
      category: m.category,
      status: m.status,
      outcome: m.outcome,
      currentPrice: formatCC(m.currentPrice),
      expiresAt: secToIso(m.expiresAtSec),
      resolvedAt: m.resolvedAtSec === null ? null : secToIso(m.resolvedAtSec),
      phase: this.phaseOf(m),
      archived: m.archived,
    };
  }

  toApiEvent(e: MarketEventEntity): ApiMarketEvent {
    const dec = (v: bigint | null): string | null => (v === null ? null : formatCC(v));
    return {
      id: String(e.id),
      eventId: e.eventId,
      marketId: e.marketId,
      kind: e.kind,
      actor: e.actor,
      side: e.side,
      amountCC: dec(e.amountCC),
      netCC: dec(e.netCC),
      shares: dec(e.shares),
      sharesOut: dec(e.sharesOut),
      feeCC: dec(e.feeCC),
      priceBefore: dec(e.priceBefore),
      priceAfter: dec(e.priceAfter),
      lpTokens: dec(e.lpTokens),
      outcome: e.outcome,
      details: e.details ?? {},
      offset: e.offset,
      updateId: e.updateId,
      commandId: e.commandId,
      effectiveAt: e.effectiveAt.toISOString(),
    };
  }

  /** Mark-to-market / redeemable value of a position against the market it belongs to (fixed point). */
  positionValue(
    p: Pick<PositionEntity, "yesShares" | "noShares" | "costBasisCC">,
    market: Pick<MarketEntity, "status" | "outcome" | "currentPrice"> | null,
  ): { valueCC: bigint | null; redeemableCC: bigint | null } {
    if (!market) return { valueCC: null, redeemableCC: null };
    if (market.status === "Resolved") {
      const winning =
        market.outcome === "Yes" ? p.yesShares : market.outcome === "No" ? p.noShares : 0n;
      return { valueCC: winning, redeemableCC: winning };
    }
    if (market.status === "Voided") {
      const held = p.yesShares > p.noShares ? p.yesShares : p.noShares;
      const refund = p.costBasisCC < held ? p.costBasisCC : held;
      return { valueCC: refund, redeemableCC: refund };
    }
    const value =
      mulDecimal(p.yesShares, market.currentPrice) +
      mulDecimal(p.noShares, ONE_DECIMAL - market.currentPrice);
    return { valueCC: value, redeemableCC: null };
  }

  toApiPosition(
    p: PositionEntity,
    market: MarketEntity | null,
    summary: ApiMarketSummary | null,
  ): ApiPosition {
    const { valueCC, redeemableCC } = this.positionValue(p, market);
    return {
      contractId: p.contractId,
      holder: p.holder,
      marketId: p.marketId,
      yesShares: formatCC(p.yesShares),
      noShares: formatCC(p.noShares),
      costBasisCC: formatCC(p.costBasisCC),
      active: p.active,
      createdAt: (p.createdAtLedger ?? p.createdAt).toISOString(),
      createdOffset: p.createdOffset,
      archivedAt: p.archivedAtLedger ? p.archivedAtLedger.toISOString() : null,
      market: summary,
      valueCC: valueCC === null ? null : formatCC(valueCC),
      redeemableCC: redeemableCC === null ? null : formatCC(redeemableCC),
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
      lpTokens: formatCC(l.lpTokens),
      depositedCC: formatCC(l.depositedCC),
      active: l.active,
      createdAt: (l.createdAtLedger ?? l.createdAt).toISOString(),
      createdOffset: l.createdOffset,
      archivedAt: l.archivedAtLedger ? l.archivedAtLedger.toISOString() : null,
      market: summary,
      poolShare:
        market && market.lpTokenSupply > 0n
          ? formatCC(divDecimal(l.lpTokens, market.lpTokenSupply))
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
