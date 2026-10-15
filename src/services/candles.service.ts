import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { CatalogEventEntity } from "../entities/catalog-event.entity";
import { MarketEntity } from "../entities/market.entity";
import { periodStartSec } from "../indexer/candles";
import {
  type ApiCandle,
  type ApiCandlesticks,
  type ApiEventCandlesticks,
  type ApiSparkline,
  type CandlePeriodMinutes,
} from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, parseAmount } from "../util/money";
import { MarketsService } from "./markets.service";

/** Most candles one series may carry (a day of minutes is 1 440; a year of hours 8 760). */
export const MAX_CANDLES = 5_000;
/** Hourly closes a card's sparkline shows. */
export const SPARKLINE_HOURS = 24;

interface CandleRow {
  market_id: string;
  period_start: string | Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  notional: string;
  trades: string | number;
  open_interest: string;
  liquidity_l: string | null;
}

interface Carry {
  close: bigint;
  openInterest: bigint;
  liquidityL: bigint | null;
}

interface Window {
  period: number;
  firstBucket: number;
  lastBucket: number;
}

/**
 * Kalshi-style candlesticks over the projection's `to_market_candles` (docs/MARKETS.md §5;
 * docs/API.md "Candlesticks"). The table holds one row per period that saw a market version;
 * this service returns a dense series — every period in the window, carrying the previous
 * close forward through quiet periods (`empty: true`) — because that is what a chart draws.
 * Nothing is aggregated on read: the rows are folded by the indexer as the ledger moves. An
 * event's chart is the same read for every member market at once (one query, one window), so
 * the series line up by construction (docs/MARKETS.md §5 "Charts").
 */
@Injectable()
export class CandlesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly markets: MarketsService,
  ) {}

  async candlesticks(
    marketRef: string,
    opts: { startTs?: number; endTs?: number; periodMinutes: CandlePeriodMinutes },
  ): Promise<ApiCandlesticks> {
    const market = await this.markets.find(marketRef);
    if (!market) throw new ApiError(404, "not_found", `market ${marketRef} is not indexed`);
    const window = this.window(opts);
    const series = await this.seriesFor([market.marketId], window);
    return {
      marketId: market.marketId,
      ticker: market.ticker,
      instrument: this.markets.collateralOf(market),
      periodInterval: opts.periodMinutes,
      startTs: window.firstBucket,
      endTs: window.lastBucket + window.period,
      candlesticks: series.get(market.marketId) ?? [],
    };
  }

  /**
   * Every member market of an event over one window: what a Kalshi event page draws (one line
   * per outcome). Markets of every status are included — a settled leg still belongs on the
   * chart — busiest (24 h volume) first.
   */
  async eventCandlesticks(
    eventTickerRaw: string,
    opts: { startTs?: number; endTs?: number; periodMinutes: CandlePeriodMinutes },
  ): Promise<ApiEventCandlesticks> {
    const eventTicker = eventTickerRaw.trim().toUpperCase();
    const event = await this.dataSource
      .getRepository(CatalogEventEntity)
      .findOneBy({ ticker: eventTicker });
    if (!event) throw new ApiError(404, "not_found", `event ${eventTicker} does not exist`);
    const window = this.window(opts);
    const members = await this.dataSource
      .getRepository(MarketEntity)
      .createQueryBuilder("m")
      .where("m.event_ticker = :eventTicker AND m.archived = false", { eventTicker })
      .orderBy("m.market_id", "ASC")
      .getMany();
    const extras = await this.markets.extrasFor(members);
    const ordered = [...members].sort((a, b) => {
      const va = extras.get(a.marketId)?.volume24h ?? 0n;
      const vb = extras.get(b.marketId)?.volume24h ?? 0n;
      return va === vb ? a.marketId - b.marketId : va > vb ? -1 : 1;
    });
    const series = await this.seriesFor(
      ordered.map((m) => m.marketId),
      window,
    );
    return {
      eventTicker,
      periodInterval: opts.periodMinutes,
      startTs: window.firstBucket,
      endTs: window.lastBucket + window.period,
      markets: ordered.map((m) => ({
        marketId: m.marketId,
        ticker: m.ticker,
        instrument: this.markets.collateralOf(m),
        yesSubTitle: m.yesSubTitle,
        noSubTitle: m.noSubTitle,
        status: m.status,
        currentPrice: formatAmount(m.currentPrice),
        candlesticks: series.get(m.marketId) ?? [],
      })),
    };
  }

  /**
   * The last 24 hourly closes of many markets in one query (`GET /markets?withSparkline=true`):
   * dense and carried forward like the candles, starting at the market's first known close
   * inside the window (a market younger than a day shows fewer points).
   */
  async sparklines(marketIds: number[]): Promise<Map<number, ApiSparkline>> {
    const out = new Map<number, ApiSparkline>();
    if (marketIds.length === 0) return out;
    const period = 3600;
    const nowSec = Math.floor(Date.now() / 1000);
    const lastBucket = periodStartSec(nowSec, period);
    const firstBucket = lastBucket - (SPARKLINE_HOURS - 1) * period;
    const series = await this.seriesFor(marketIds, { period, firstBucket, lastBucket });
    for (const id of marketIds) {
      const candles = series.get(id);
      if (!candles || candles.length === 0) continue;
      out.set(id, {
        periodInterval: 60,
        startTs: candles[0].startTs,
        closes: candles.map((c) => c.price.close),
      });
    }
    return out;
  }

  private window(opts: {
    startTs?: number;
    endTs?: number;
    periodMinutes: CandlePeriodMinutes;
  }): Window {
    const period = opts.periodMinutes * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const endTs = opts.endTs ?? nowSec;
    const startTs = opts.startTs ?? endTs - period * 200;
    if (endTs <= startTs)
      throw new ApiError(400, "validation_failed", "endTs must be after startTs");
    const firstBucket = periodStartSec(startTs, period);
    const lastBucket = periodStartSec(endTs, period);
    if ((lastBucket - firstBucket) / period + 1 > MAX_CANDLES)
      throw new ApiError(
        400,
        "validation_failed",
        `the window holds more than ${MAX_CANDLES} candles`,
        {
          maxCandles: MAX_CANDLES,
        },
      );
    return { period, firstBucket, lastBucket };
  }

  /** Dense series for many markets over one window: two set queries however many markets. */
  private async seriesFor(marketIds: number[], window: Window): Promise<Map<number, ApiCandle[]>> {
    const out = new Map<number, ApiCandle[]>();
    if (marketIds.length === 0) return out;
    const ids = marketIds.map(String);
    const { period, firstBucket, lastBucket } = window;
    const rows = await this.dataSource.query<CandleRow[]>(
      `SELECT market_id::text, period_start, open::text, high::text, low::text, close::text, volume::text, notional::text,
              trades, open_interest::text, liquidity_l::text
         FROM to_market_candles
        WHERE market_id = ANY($1::bigint[]) AND period_secs = $2 AND period_start >= to_timestamp($3) AND period_start <= to_timestamp($4)
        ORDER BY market_id, period_start ASC`,
      [ids, period, firstBucket, lastBucket],
    );
    const prior = await this.dataSource.query<CandleRow[]>(
      `SELECT DISTINCT ON (market_id) market_id::text, period_start, open::text, high::text, low::text, close::text, volume::text, notional::text,
              trades, open_interest::text, liquidity_l::text
         FROM to_market_candles
        WHERE market_id = ANY($1::bigint[]) AND period_secs = $2 AND period_start < to_timestamp($3)
        ORDER BY market_id, period_start DESC`,
      [ids, period, firstBucket],
    );
    const rowsById = new Map<number, Map<number, CandleRow>>();
    for (const r of rows) {
      const id = Number(r.market_id);
      const byStart = rowsById.get(id) ?? new Map<number, CandleRow>();
      byStart.set(Math.floor(new Date(r.period_start).getTime() / 1000), r);
      rowsById.set(id, byStart);
    }
    const priorById = new Map<number, Carry>();
    for (const r of prior) priorById.set(Number(r.market_id), carryOf(r));
    for (const id of marketIds)
      out.set(
        id,
        dense(rowsById.get(id) ?? new Map<number, CandleRow>(), priorById.get(id) ?? null, window),
      );
    return out;
  }
}

function carryOf(row: CandleRow): Carry {
  return {
    close: parseAmount(row.close),
    openInterest: parseAmount(row.open_interest),
    liquidityL: row.liquidity_l === null ? null : parseAmount(row.liquidity_l),
  };
}

/** Every period of the window from the market's first candle on; quiet periods flat at the last close. */
function dense(
  byStart: Map<number, CandleRow>,
  initial: Carry | null,
  window: Window,
): ApiCandle[] {
  const { period, firstBucket, lastBucket } = window;
  let carry = initial;
  const out: ApiCandle[] = [];
  for (let start = firstBucket; start <= lastBucket; start += period) {
    const row = byStart.get(start);
    if (row) {
      const volume = parseAmount(row.volume);
      const close = parseAmount(row.close);
      const mean = volume > 0n ? (parseAmount(row.notional) * 10_000_000_000n) / volume : close;
      out.push({
        startTs: start,
        endTs: start + period,
        price: {
          open: formatAmount(parseAmount(row.open)),
          high: formatAmount(parseAmount(row.high)),
          low: formatAmount(parseAmount(row.low)),
          close: formatAmount(close),
          mean: formatAmount(mean),
          previous: carry ? formatAmount(carry.close) : null,
        },
        volume: formatAmount(volume),
        trades: Number(row.trades),
        openInterest: formatAmount(parseAmount(row.open_interest)),
        liquidityL: row.liquidity_l === null ? null : formatAmount(parseAmount(row.liquidity_l)),
        empty: false,
      });
      carry = carryOf(row);
    } else if (carry) {
      // Nothing landed in this period: the chart still needs a point, flat at the last close.
      const p = formatAmount(carry.close);
      out.push({
        startTs: start,
        endTs: start + period,
        price: { open: p, high: p, low: p, close: p, mean: p, previous: p },
        volume: formatAmount(0n),
        trades: 0,
        openInterest: formatAmount(carry.openInterest),
        liquidityL: carry.liquidityL === null ? null : formatAmount(carry.liquidityL),
        empty: true,
      });
    }
    // Before the market's first candle there is nothing to draw — no leading fillers.
  }
  return out;
}
