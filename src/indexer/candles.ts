/**
 * Candle bookkeeping for the projection (docs/MARKETS.md §5): every `PredictionMarket` version
 * folds into one row per period in `to_market_candles`, in the same transaction as the version
 * itself. Pure helpers here — the SQL is built once and executed by the projection with the
 * EntityManager it was given, so a replayed transaction (skipped as a whole) never double-counts.
 */
import { CANDLE_PERIOD_SECS } from "../types";
import { formatAmount } from "../util/money";

/** What one market version contributes to its candles. */
export interface CandleContribution {
  marketId: number;
  /** Epoch seconds of the version (the contract's ledger time, else the transaction's). */
  atSec: number;
  price: bigint;
  liquidityL: bigint;
  /** Δ `totalVolume` against the consumed predecessor (0 for the first version and non-trade versions). */
  volumeDelta: bigint;
  /** 1 for Buy / Sell / SwapShares versions, else 0. */
  trades: number;
  /** The market's outstanding shares once the whole transaction is applied. */
  openInterest: bigint;
  offset: number;
  nodeId: number;
}

/** Choices whose successor version counts as a pool trade in the candles. */
export const CANDLE_TRADE_CHOICES: ReadonlySet<string> = new Set(["Buy", "Sell", "SwapShares"]);

export const periodStartSec = (atSec: number, periodSecs: number): number =>
  Math.floor(atSec / periodSecs) * periodSecs;

export { CANDLE_PERIOD_SECS };

/**
 * Upsert statement for one (market, period) bucket. `open` is written on insert only; `high` /
 * `low` fold; `close`, `liquidity_l`, `open_interest` and the (offset, node) watermark follow the
 * newest version; volume, notional and trade counts accumulate.
 */
export function candleUpsert(
  c: CandleContribution,
  periodSecs: number,
): { sql: string; params: unknown[] } {
  const price = formatAmount(c.price);
  const notional = formatAmount((c.price * c.volumeDelta) / 10_000_000_000n);
  return {
    sql: `INSERT INTO to_market_candles
            (market_id, period_secs, period_start, open, high, low, close, volume, notional, trades,
             open_interest, liquidity_l, last_offset, last_node_id, updated_at)
          VALUES ($1, $2, to_timestamp($3), $4, $4, $4, $4, $5, $6, $7, $8, $9, $10, $11, now())
          ON CONFLICT (market_id, period_secs, period_start) DO UPDATE SET
            high = GREATEST(to_market_candles.high, EXCLUDED.high),
            low = LEAST(to_market_candles.low, EXCLUDED.low),
            close = CASE WHEN (EXCLUDED.last_offset, EXCLUDED.last_node_id) >= (to_market_candles.last_offset, to_market_candles.last_node_id)
                         THEN EXCLUDED.close ELSE to_market_candles.close END,
            liquidity_l = CASE WHEN (EXCLUDED.last_offset, EXCLUDED.last_node_id) >= (to_market_candles.last_offset, to_market_candles.last_node_id)
                               THEN EXCLUDED.liquidity_l ELSE to_market_candles.liquidity_l END,
            open_interest = CASE WHEN (EXCLUDED.last_offset, EXCLUDED.last_node_id) >= (to_market_candles.last_offset, to_market_candles.last_node_id)
                                 THEN EXCLUDED.open_interest ELSE to_market_candles.open_interest END,
            volume = to_market_candles.volume + EXCLUDED.volume,
            notional = to_market_candles.notional + EXCLUDED.notional,
            trades = to_market_candles.trades + EXCLUDED.trades,
            last_offset = GREATEST(to_market_candles.last_offset, EXCLUDED.last_offset),
            last_node_id = CASE WHEN EXCLUDED.last_offset >= to_market_candles.last_offset THEN EXCLUDED.last_node_id ELSE to_market_candles.last_node_id END,
            updated_at = now()`,
    params: [
      String(c.marketId),
      periodSecs,
      periodStartSec(c.atSec, periodSecs),
      price,
      formatAmount(c.volumeDelta),
      notional,
      c.trades,
      formatAmount(c.openInterest),
      formatAmount(c.liquidityL),
      String(c.offset),
      c.nodeId,
    ],
  };
}

/** Recompute `to_markets.open_interest_*` from the active positions (after an ACS snapshot, where increments cannot be trusted). */
export const OPEN_INTEREST_RECOMPUTE_SQL = `
  UPDATE to_markets m SET
    open_interest_yes = COALESCE((SELECT SUM(p.yes_shares) FROM to_positions p WHERE p.market_id = m.market_id AND p.active), 0),
    open_interest_no  = COALESCE((SELECT SUM(p.no_shares)  FROM to_positions p WHERE p.market_id = m.market_id AND p.active), 0)`;
