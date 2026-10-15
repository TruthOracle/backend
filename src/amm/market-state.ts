/**
 * Bridges an indexed `PredictionMarket` row (fixed-point bigints) and the pm-AMM port (doubles).
 * Quotes are advisory — the ledger executes in Daml `Decimal` — so the conversion through
 * `formatAmount` / `parseAmount` is exact to 10 dp and the residual is absorbed by the slippage bounds.
 */
import type { MarketEntity } from "../entities/market.entity";
import { formatAmount, parseAmount } from "../util/money";
import type { AmmMarketState } from "./pm-amm";

export type AmmMarketRow = Pick<
  MarketEntity,
  | "currentPrice"
  | "liquidityL"
  | "lpTokenSupply"
  | "isDynamic"
  | "createdAtSec"
  | "expiresAtSec"
  | "liquidityPeriodSecs"
  | "feeBps"
>;

export const decimalToNumber = (units: bigint): number => Number(formatAmount(units));
/** Doubles → 1e-10 units, rounded half away from zero at the 10th decimal (never truncated). */
export const numberToDecimal = (n: number): bigint => parseAmount(Number.isFinite(n) ? n : 0);

export function ammStateOf(m: AmmMarketRow): AmmMarketState {
  return {
    currentPrice: decimalToNumber(m.currentPrice),
    liquidityL: decimalToNumber(m.liquidityL),
    lpTokenSupply: decimalToNumber(m.lpTokenSupply),
    isDynamic: m.isDynamic,
    createdAt: m.createdAtSec,
    expiresAt: m.expiresAtSec,
    liquidityPeriodSecs: m.liquidityPeriodSecs,
    feeBps: m.feeBps,
  };
}
