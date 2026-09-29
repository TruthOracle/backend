/**
 * pm-AMM pricing (Paradigm dynamic pm-AMM, Gaussian score dynamics) — a port of
 * `truthoracle-contracts/daml/daml/PmAmmMath.daml` and of the market choices that call it
 * (`PredictionMarket.Buy` / `Sell` / `SwapShares` / `ProvideLiquidity`), so the backend can quote a
 * trade the way the ledger will execute it (docs/MARKETS.md §6).
 *
 *   Invariant:  (y − x)·Φ(z) + L·φ(z) − y = 0,   z = (y − x) / L
 *   Price:      P(YES) = Φ((y − x) / L_eff)
 *   Dynamic:    L_eff  = L0 · √((T − t) / (T − t0))
 *   Reserves:   y*(P) = L·(z·P + φ(z)),  x*(P) = y*(P) − L·z,   z = Φ⁻¹(P)
 *   Value:      V(P)  = L · φ(Φ⁻¹(P))
 *
 * The Daml runs the same formulas in `Decimal` (10 dp, fixed point); this port runs them in IEEE
 * doubles, so a quote can differ from the on-ledger fill in the last decimals. That is why every
 * quote also carries the slippage-protected bound (`minSharesOut` / `minProceedsCC`) the choice
 * argument must be built with — the ledger, not this file, is the execution engine.
 */

const ONE_OVER_SQRT_TWO_PI = 0.3989422804;

const clamp = (lo: number, hi: number, v: number): number => Math.max(lo, Math.min(hi, v));

/** Probabilities kept away from 0 / 1 so `Φ⁻¹` and divisions stay finite (Daml `clampProb`). */
export const clampProb = (p: number): number => clamp(0.0001, 0.9999, p);

/** Standard normal PDF; argument clamped to [−8, 8] like the Daml. */
export function normPdf(zRaw: number): number {
  const z = clamp(-8, 8, zRaw);
  return ONE_OVER_SQRT_TWO_PI * Math.exp(-(z * z) / 2);
}

/** Standard normal CDF, Abramowitz–Stegun 26.2.17 (|error| < 7.5e-8). */
export function normCdf(z: number): number {
  if (z < 0) return 1 - normCdf(-z);
  if (z > 8) return 1;
  const t = 1 / (1 + 0.2316419 * z);
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - normPdf(z) * poly;
}

/** Inverse standard normal CDF: Acklam's rational approximation + two Newton refinements. */
export function normInvCdf(pRaw: number): number {
  const p = clampProb(pRaw);
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      -(
        ((((-0.007784894 * q - 0.322396458) * q - 2.400758277) * q - 2.549732539) * q +
          4.374664141) *
          q +
        2.938163983
      ) /
      ((((0.007784696 * q + 0.322467129) * q + 2.445134137) * q + 3.754408662) * q + 1);
  } else if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      (((((-0.007784894 * q - 0.322396458) * q - 2.400758277) * q - 2.549732539) * q +
        4.374664141) *
        q +
        2.938163983) /
      ((((0.007784696 * q + 0.322467129) * q + 2.445134137) * q + 3.754408662) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((-39.6968302866 * r + 220.9460984245) * r - 275.928510447) * r + 138.3577518673) * r -
        30.6647980661) *
        r +
        2.5066282775) *
        q) /
      (((((-54.4760987982 * r + 161.585836858) * r - 155.6989798599) * r + 66.8013118877) * r -
        13.2806815529) *
        r +
        1);
  }
  for (let i = 0; i < 2; i++) x -= (normCdf(x) - p) / Math.max(1e-10, normPdf(x));
  return x;
}

/** Closed-form optimal reserves (x = YES inventory, y = NO inventory) for price `p` at liquidity `l`. */
export function optimalReserves(p: number, l: number): { x: number; y: number } {
  const z = normInvCdf(p);
  const y = l * (z * p + normPdf(z));
  const x = y - l * z;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

/** Pool value V(P) = L·φ(Φ⁻¹(P)), in collateral units. */
export const poolValue = (p: number, l: number): number => l * normPdf(normInvCdf(p));

/** Liquidity from a target pool value: L = V / φ(Φ⁻¹(P)) (what `CreateMarket` seeds). */
export const liquidityFromValue = (v: number, p: number): number =>
  v / Math.max(1e-10, normPdf(normInvCdf(p)));

/** Marginal YES price from reserves. */
export const priceFromReserves = (x: number, y: number, l: number): number =>
  normCdf((y - x) / Math.max(1e-10, l));

/** Invariant residual I(x, y, L) — zero (up to rounding) for valid reserves. */
export function invariantValue(x: number, y: number, l: number): number {
  const z = (y - x) / Math.max(1e-10, l);
  return (y - x) * normCdf(z) + l * normPdf(z) - y;
}

/** Effective (time-decayed) liquidity: L_eff = L0·√((T − now) / (T − t0)); static pools return L0. */
export function effectiveLiquidity(
  isDynamic: boolean,
  l0: number,
  createdAt: number,
  expiresAt: number,
  nowSecs: number,
): number {
  if (!isDynamic) return l0;
  if (nowSecs <= createdAt) return l0;
  const total = expiresAt - createdAt;
  const left = expiresAt - nowSecs;
  if (left <= 0 || total <= 0) return 0;
  return l0 * Math.sqrt(left / total);
}

/** YES shares received for net collateral `c` against virtual reserves (Newton on the invariant). */
export function solveBuyShares(x: number, y: number, l: number, c: number): number {
  const target = invariantValue(x, y, l);
  const p0 = Math.max(0.01, priceFromReserves(x, y, l));
  let n = c / p0;
  for (let i = 0; i < 30; i++) {
    const z = (y - x + n) / Math.max(1e-10, l);
    const f = (y - x + n) * normCdf(z) + l * normPdf(z) - (y + c) - target;
    const deriv = Math.max(0.0001, normCdf(z));
    const next = Math.max(0, n - f / deriv);
    if (Math.abs(next - n) < 1e-7) return next;
    n = next;
  }
  return n;
}

/** Direct outcome-token swap: deposit `sIn` into the x side, receive shares from the y side. */
export function solveSwapOut(x: number, y: number, l: number, sIn: number): number {
  const target = invariantValue(x, y, l);
  const pIn = Math.max(0.01, priceFromReserves(x, y, l));
  const pOut = Math.max(0.01, 1 - pIn);
  let m = (sIn * pIn) / pOut;
  for (let i = 0; i < 30; i++) {
    const z = (y - m - (x + sIn)) / Math.max(1e-10, l);
    const f = (y - m - x - sIn) * normCdf(z) + l * normPdf(z) - (y - m) - target;
    const deriv = Math.max(0.0001, 1 - normCdf(z));
    const next = Math.max(0, m - f / deriv);
    if (Math.abs(next - m) < 1e-7) return next;
    m = next;
  }
  return m;
}

/** Collateral received for selling `s` YES shares (closed form; mirror the reserves for NO). */
export function solveSellProceeds(x: number, y: number, l: number, s: number): number {
  const i0 = invariantValue(x, y, l);
  const zBar = (y - x - s) / Math.max(1e-10, l);
  const a = (y - x - s) * normCdf(zBar) + l * normPdf(zBar) - y;
  return clamp(0, s, i0 - a);
}

// ---------------------------------------------------------------------------------------------
// Market-level quoting (virtual-reserve model — mirrors the on-ledger choices)
// ---------------------------------------------------------------------------------------------

export type AmmSide = "Yes" | "No";

/** The slice of a `PredictionMarket` the pricing needs, as plain numbers (see `ammStateOf`). */
export interface AmmMarketState {
  /** Cached YES price from the contract (`currentPrice`). */
  currentPrice: number;
  /** L0 (`liquidityL`). */
  liquidityL: number;
  lpTokenSupply: number;
  isDynamic: boolean;
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
  liquidityPeriodSecs: number;
  feeBps: number;
}

const feeFraction = (bps: number): number => bps / 10_000;

/** Trading opens (and L starts decaying) after the liquidity-collection window. */
export const tradingStartsAt = (m: AmmMarketState): number => m.createdAt + m.liquidityPeriodSecs;

export function marketEffectiveL(m: AmmMarketState, nowSecs: number): number {
  return effectiveLiquidity(m.isDynamic, m.liquidityL, tradingStartsAt(m), m.expiresAt, nowSecs);
}

export interface BuyQuote {
  kind: "buy";
  side: AmmSide;
  collateralCC: number;
  feeCC: number;
  netCC: number;
  sharesOut: number;
  /** collateral / shares — what one share cost all-in. */
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  /** |P'side − Pside| / Pside for the side traded. */
  priceImpact: number;
  effectiveL: number;
}

/** Quote a `Buy`: collateral in → shares out. Null when the pool cannot fill it. */
export function quoteBuy(
  m: AmmMarketState,
  side: AmmSide,
  collateralCC: number,
  nowSecs: number,
): BuyQuote | null {
  const l = marketEffectiveL(m, nowSecs);
  if (l <= 0 || collateralCC <= 0) return null;
  const { x, y } = optimalReserves(m.currentPrice, l);
  const feeCC = collateralCC * feeFraction(m.feeBps);
  const netCC = collateralCC - feeCC;
  const sharesOut =
    side === "Yes" ? solveBuyShares(x, y, l, netCC) : solveBuyShares(y, x, l, netCC);
  if (sharesOut <= 0) return null;
  const diff = y - x;
  const newDiff = side === "Yes" ? diff + sharesOut : diff - sharesOut;
  const priceAfter = clampProb(normCdf(newDiff / l));
  const sidePrice = side === "Yes" ? m.currentPrice : 1 - m.currentPrice;
  const newSidePrice = side === "Yes" ? priceAfter : 1 - priceAfter;
  return {
    kind: "buy",
    side,
    collateralCC,
    feeCC,
    netCC,
    sharesOut,
    avgPrice: collateralCC / sharesOut,
    priceBefore: m.currentPrice,
    priceAfter,
    priceImpact: Math.abs(newSidePrice - sidePrice) / Math.max(1e-9, sidePrice),
    effectiveL: l,
  };
}

export interface SellQuote {
  kind: "sell";
  side: AmmSide;
  sharesIn: number;
  grossCC: number;
  feeCC: number;
  netCC: number;
  /** gross / shares — what the pool paid per share before the fee. */
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  priceImpact: number;
  effectiveL: number;
}

/** Quote a `Sell`: shares in → net CC out. Null when the pool cannot fill it. */
export function quoteSell(
  m: AmmMarketState,
  side: AmmSide,
  sharesIn: number,
  nowSecs: number,
): SellQuote | null {
  const l = marketEffectiveL(m, nowSecs);
  if (l <= 0 || sharesIn <= 0) return null;
  const { x, y } = optimalReserves(m.currentPrice, l);
  const grossCC =
    side === "Yes" ? solveSellProceeds(x, y, l, sharesIn) : solveSellProceeds(y, x, l, sharesIn);
  if (grossCC <= 0) return null;
  const feeCC = grossCC * feeFraction(m.feeBps);
  const diff = y - x;
  const newDiff = side === "Yes" ? diff - sharesIn : diff + sharesIn;
  const priceAfter = clampProb(normCdf(newDiff / l));
  const sidePrice = side === "Yes" ? m.currentPrice : 1 - m.currentPrice;
  const newSidePrice = side === "Yes" ? priceAfter : 1 - priceAfter;
  return {
    kind: "sell",
    side,
    sharesIn,
    grossCC,
    feeCC,
    netCC: grossCC - feeCC,
    avgPrice: grossCC / sharesIn,
    priceBefore: m.currentPrice,
    priceAfter,
    priceImpact: Math.abs(newSidePrice - sidePrice) / Math.max(1e-9, sidePrice),
    effectiveL: l,
  };
}

export interface SwapQuote {
  kind: "swap";
  fromSide: AmmSide;
  sharesIn: number;
  /** Fee taken in input shares. */
  feeShares: number;
  sharesOut: number;
  priceBefore: number;
  priceAfter: number;
  priceImpact: number;
  effectiveL: number;
}

/** Quote a `SwapShares`: shares of one side in → shares of the other side out. */
export function quoteSwap(
  m: AmmMarketState,
  fromSide: AmmSide,
  sharesIn: number,
  nowSecs: number,
): SwapQuote | null {
  const l = marketEffectiveL(m, nowSecs);
  if (l <= 0 || sharesIn <= 0) return null;
  const { x, y } = optimalReserves(m.currentPrice, l);
  const feeShares = sharesIn * feeFraction(m.feeBps);
  const net = sharesIn - feeShares;
  const sharesOut = fromSide === "Yes" ? solveSwapOut(x, y, l, net) : solveSwapOut(y, x, l, net);
  if (sharesOut <= 0) return null;
  const diff = y - x;
  const newDiff = fromSide === "Yes" ? diff - sharesOut - net : diff + sharesOut + net;
  const priceAfter = clampProb(normCdf(newDiff / l));
  const toPrice = fromSide === "Yes" ? 1 - m.currentPrice : m.currentPrice;
  const newToPrice = fromSide === "Yes" ? 1 - priceAfter : priceAfter;
  return {
    kind: "swap",
    fromSide,
    sharesIn,
    feeShares,
    sharesOut,
    priceBefore: m.currentPrice,
    priceAfter,
    priceImpact: Math.abs(newToPrice - toPrice) / Math.max(1e-9, toPrice),
    effectiveL: l,
  };
}

export interface LiquidityQuote {
  kind: "provide_liquidity";
  valueIncreaseCC: number;
  /** CC debited: max(dx, dy). */
  costCC: number;
  lpMinted: number;
  /** Share of the pool after the deposit. */
  poolShare: number;
  newL: number;
  effectiveL: number;
}

/** Quote a `ProvideLiquidity`: desired pool-value increase → CC cost + LP tokens minted. */
export function quoteProvideLiquidity(
  m: AmmMarketState,
  valueIncreaseCC: number,
  nowSecs: number,
): LiquidityQuote | null {
  const l = marketEffectiveL(m, nowSecs);
  if (l <= 0 || valueIncreaseCC <= 0) return null;
  const v = poolValue(m.currentPrice, l);
  if (v <= 0) return null;
  const ratio = valueIncreaseCC / v;
  const { x, y } = optimalReserves(m.currentPrice, l);
  const costCC = Math.max(x * ratio, y * ratio);
  const lpMinted = m.lpTokenSupply * ratio;
  return {
    kind: "provide_liquidity",
    valueIncreaseCC,
    costCC,
    lpMinted,
    poolShare: lpMinted / (m.lpTokenSupply + lpMinted),
    newL: m.liquidityL * (1 + ratio),
    effectiveL: l,
  };
}

/**
 * The best bid / ask an AMM implies for one share of a side: the marginal price moved by a
 * reference-sized order in each direction (Kalshi-style `yesBid` / `yesAsk` for a pool that has
 * no order book). `sizeCC` is the collateral of the reference buy; the sell mirrors it in shares.
 */
export function impliedQuoteBook(
  m: AmmMarketState,
  nowSecs: number,
  sizeCC = 1,
): { yesBid: number; yesAsk: number; noBid: number; noAsk: number } | null {
  const buyYes = quoteBuy(m, "Yes", sizeCC, nowSecs);
  const buyNo = quoteBuy(m, "No", sizeCC, nowSecs);
  if (!buyYes || !buyNo) return null;
  const sellYes = quoteSell(m, "Yes", buyYes.sharesOut, nowSecs);
  const sellNo = quoteSell(m, "No", buyNo.sharesOut, nowSecs);
  if (!sellYes || !sellNo) return null;
  return {
    yesAsk: clampProb(buyYes.avgPrice),
    yesBid: clampProb(sellYes.netCC / sellYes.sharesIn),
    noAsk: clampProb(buyNo.avgPrice),
    noBid: clampProb(sellNo.netCC / sellNo.sharesIn),
  };
}
