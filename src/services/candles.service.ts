import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { periodStartSec } from "../indexer/candles";
import { type ApiCandle, type ApiCandlesticks, type CandlePeriodMinutes } from "../types";
import { ApiError } from "../util/errors";
import { formatCC, parseCC } from "../util/money";
import { MarketsService } from "./markets.service";

/** Most candles one answer may carry (a day of minutes is 1 440; a year of hours 8 760). */
export const MAX_CANDLES = 5_000;

interface CandleRow {
  period_start: string | Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume_cc: string;
  notional_cc: string;
  trades: string | number;
  open_interest: string;
  liquidity_l: string | null;
}

/**
 * Kalshi-style candlesticks over the projection's `to_market_candles` (docs/MARKETS.md §5;
 * docs/API.md "Candlesticks"). The table holds one row per period that saw a market version;
 * this service returns a dense series — every period in the window, carrying the previous
 * close forward through quiet periods (`empty: true`) — because that is what a chart draws.
 * Nothing is aggregated on read: the rows are folded by the indexer as the ledger moves.
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
    const period = opts.periodMinutes * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const endTs = opts.endTs ?? nowSec;
    const startTs = opts.startTs ?? endTs - period * 200;
    if (endTs <= startTs)
      throw new ApiError(400, "validation_failed", "endTs must be after startTs");
    const firstBucket = periodStartSec(startTs, period);
    const lastBucket = periodStartSec(endTs, period);
    if ((lastBucket - firstBucket) / period + 1 > MAX_CANDLES)
      throw new ApiError(400, "validation_failed", `the window holds more than ${MAX_CANDLES} candles`, {
        maxCandles: MAX_CANDLES,
      });

    const rows = await this.dataSource.query<CandleRow[]>(
      `SELECT period_start, open::text, high::text, low::text, close::text, volume_cc::text, notional_cc::text,
              trades, open_interest::text, liquidity_l::text
         FROM to_market_candles
        WHERE market_id = $1 AND period_secs = $2 AND period_start >= to_timestamp($3) AND period_start <= to_timestamp($4)
        ORDER BY period_start ASC`,
      [String(market.marketId), period, firstBucket, lastBucket],
    );
    const prior = await this.dataSource.query<CandleRow[]>(
      `SELECT period_start, open::text, high::text, low::text, close::text, volume_cc::text, notional_cc::text,
              trades, open_interest::text, liquidity_l::text
         FROM to_market_candles
        WHERE market_id = $1 AND period_secs = $2 AND period_start < to_timestamp($3)
        ORDER BY period_start DESC LIMIT 1`,
      [String(market.marketId), period, firstBucket],
    );

    const byStart = new Map<number, CandleRow>();
    for (const r of rows) byStart.set(Math.floor(new Date(r.period_start).getTime() / 1000), r);
    let carry: { close: bigint; openInterest: bigint; liquidityL: bigint | null } | null = prior[0]
      ? {
          close: parseCC(prior[0].close),
          openInterest: parseCC(prior[0].open_interest),
          liquidityL: prior[0].liquidity_l === null ? null : parseCC(prior[0].liquidity_l),
        }
      : null;
    const out: ApiCandle[] = [];
    for (let start = firstBucket; start <= lastBucket; start += period) {
      const row = byStart.get(start);
      if (row) {
        const volume = parseCC(row.volume_cc);
        const close = parseCC(row.close);
        const mean = volume > 0n ? (parseCC(row.notional_cc) * 10_000_000_000n) / volume : close;
        out.push({
          startTs: start,
          endTs: start + period,
          price: {
            open: formatCC(parseCC(row.open)),
            high: formatCC(parseCC(row.high)),
            low: formatCC(parseCC(row.low)),
            close: formatCC(close),
            mean: formatCC(mean),
            previous: carry ? formatCC(carry.close) : null,
          },
          volumeCC: formatCC(volume),
          trades: Number(row.trades),
          openInterest: formatCC(parseCC(row.open_interest)),
          liquidityL: row.liquidity_l === null ? null : formatCC(parseCC(row.liquidity_l)),
          empty: false,
        });
        carry = {
          close,
          openInterest: parseCC(row.open_interest),
          liquidityL: row.liquidity_l === null ? null : parseCC(row.liquidity_l),
        };
      } else if (carry) {
        // Nothing landed in this period: the chart still needs a point, flat at the last close.
        const p = formatCC(carry.close);
        out.push({
          startTs: start,
          endTs: start + period,
          price: { open: p, high: p, low: p, close: p, mean: p, previous: p },
          volumeCC: formatCC(0n),
          trades: 0,
          openInterest: formatCC(carry.openInterest),
          liquidityL: carry.liquidityL === null ? null : formatCC(carry.liquidityL),
          empty: true,
        });
      }
      // Before the market's first candle there is nothing to draw — no leading fillers.
    }
    return {
      marketId: market.marketId,
      ticker: market.ticker,
      periodInterval: opts.periodMinutes,
      startTs: firstBucket,
      endTs: lastBucket + period,
      candlesticks: out,
    };
  }
}
