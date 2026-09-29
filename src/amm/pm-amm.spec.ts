/**
 * The pm-AMM port against the invariants the Daml test suite asserts
 * (truthoracle-contracts/daml/daml/TruthoracleTest.daml `pmAmmMathInvariants`) plus the market-level
 * quote properties the on-ledger choices guarantee (a buy moves the price toward the side bought,
 * a round trip never mints value, NO mirrors YES).
 */
import {
  effectiveLiquidity,
  impliedQuoteBook,
  invariantValue,
  liquidityFromValue,
  normCdf,
  normInvCdf,
  normPdf,
  optimalReserves,
  poolValue,
  priceFromReserves,
  quoteBuy,
  quoteProvideLiquidity,
  quoteSell,
  quoteSwap,
  solveBuyShares,
  solveSellProceeds,
  type AmmMarketState,
} from "./pm-amm";

const approx = (actual: number, expected: number, tol: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
};

const T0 = 1_000_000;
const T_EXPIRY = 1_086_400;
const NOW = 1_010_000;

function market(overrides: Partial<AmmMarketState> = {}): AmmMarketState {
  const l0 = liquidityFromValue(100, 0.5);
  return {
    currentPrice: 0.5,
    liquidityL: l0,
    lpTokenSupply: l0,
    isDynamic: true,
    createdAt: T0,
    expiresAt: T_EXPIRY,
    liquidityPeriodSecs: 0,
    feeBps: 30,
    ...overrides,
  };
}

describe("normal distribution", () => {
  it("matches the Daml sanity values", () => {
    approx(normCdf(0), 0.5, 0.0001);
    approx(normCdf(1), 0.8413447461, 0.0005);
    approx(normInvCdf(0.95), 1.644853627, 0.001);
    approx(normPdf(0), 0.3989422804, 0.0001);
  });

  it("cdf(icdf(p)) round-trips across the simplex", () => {
    for (const p of [0.05, 0.2, 0.5, 0.7, 0.95]) approx(normCdf(normInvCdf(p)), p, 0.001);
  });
});

describe("closed forms", () => {
  it("optimal reserves satisfy the invariant and reproduce the price", () => {
    const l = 100;
    for (const p of [0.05, 0.2, 0.5, 0.7, 0.95]) {
      const { x, y } = optimalReserves(p, l);
      approx(invariantValue(x, y, l), 0, 0.01);
      approx(priceFromReserves(x, y, l), p, 0.005);
      approx(poolValue(p, l), l * normPdf(normInvCdf(p)), 0.01);
    }
  });

  it("time decay halves the liquidity at the square root of the remaining fraction", () => {
    approx(effectiveLiquidity(true, 100, 0, 100, 50), 70.7106781, 0.01);
    expect(effectiveLiquidity(false, 100, 0, 100, 50)).toBe(100);
    expect(effectiveLiquidity(true, 100, 0, 100, 100)).toBe(0);
    expect(effectiveLiquidity(true, 100, 0, 100, -5)).toBe(100);
  });

  it("a buy / sell round trip loses only fees and spread, never mints value", () => {
    const l = 100;
    const { x, y } = optimalReserves(0.5, l);
    const n = solveBuyShares(x, y, l, 10);
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(20);
    const c = solveSellProceeds(x + 10 - n, y + 10, l, n);
    expect(c).toBeLessThanOrEqual(10.01);
    expect(c).toBeGreaterThan(8);
  });
});

describe("market quotes", () => {
  it("a YES buy raises the price, a NO buy lowers it, and the fee is feeBps of the collateral", () => {
    const m = market();
    const yes = quoteBuy(m, "Yes", 10, NOW);
    const no = quoteBuy(m, "No", 10, NOW);
    expect(yes).not.toBeNull();
    expect(no).not.toBeNull();
    if (!yes || !no) return;
    expect(yes.priceAfter).toBeGreaterThan(0.5);
    expect(no.priceAfter).toBeLessThan(0.5);
    approx(yes.feeCC, 0.03, 1e-12);
    approx(yes.netCC, 9.97, 1e-12);
    expect(yes.sharesOut).toBeGreaterThan(10);
    expect(yes.sharesOut).toBeLessThan(20);
    // At p = 0.5 the two sides are symmetric.
    approx(yes.sharesOut, no.sharesOut, 1e-6);
    approx(yes.priceAfter - 0.5, 0.5 - no.priceAfter, 1e-6);
    expect(yes.avgPrice).toBeGreaterThan(0.5);
    expect(yes.priceImpact).toBeGreaterThan(0);
  });

  it("selling what was just bought returns less than was paid", () => {
    const m = market();
    const buy = quoteBuy(m, "Yes", 10, NOW);
    if (!buy) throw new Error("no buy quote");
    const after: AmmMarketState = { ...m, currentPrice: buy.priceAfter };
    const sell = quoteSell(after, "Yes", buy.sharesOut, NOW);
    if (!sell) throw new Error("no sell quote");
    expect(sell.netCC).toBeLessThan(10);
    expect(sell.netCC).toBeGreaterThan(8);
    approx(sell.feeCC, sell.grossCC * 0.003, 1e-12);
    expect(sell.priceAfter).toBeLessThan(buy.priceAfter);
  });

  it("a swap converts YES into NO at roughly the price ratio", () => {
    const m = market({ currentPrice: 0.7 });
    const swap = quoteSwap(m, "Yes", 10, NOW);
    if (!swap) throw new Error("no swap quote");
    approx(swap.feeShares, 0.03, 1e-12);
    // 10 YES at 0.7 ≈ 7 CC of value ≈ 23 NO at 0.3, less impact.
    expect(swap.sharesOut).toBeGreaterThan(15);
    expect(swap.sharesOut).toBeLessThan(24);
    expect(swap.priceAfter).toBeLessThan(0.7);
  });

  it("provide-liquidity keeps the price and charges max(dx, dy)", () => {
    const m = market();
    const q = quoteProvideLiquidity(m, 10, NOW);
    if (!q) throw new Error("no liquidity quote");
    expect(q.costCC).toBeGreaterThan(0);
    expect(q.lpMinted).toBeGreaterThan(0);
    approx(q.poolShare, q.lpMinted / (m.lpTokenSupply + q.lpMinted), 1e-12);
    expect(q.newL).toBeGreaterThan(m.liquidityL);
  });

  it("refuses trades the pool cannot serve", () => {
    const m = market();
    expect(quoteBuy(m, "Yes", 0, NOW)).toBeNull();
    expect(quoteSell(m, "Yes", -1, NOW)).toBeNull();
    // A dynamic pool at expiry has no effective liquidity.
    expect(quoteBuy(m, "Yes", 5, T_EXPIRY)).toBeNull();
    // A static pool keeps L0 to the end.
    expect(quoteBuy(market({ isDynamic: false }), "Yes", 5, T_EXPIRY)).not.toBeNull();
  });

  it("the liquidity period anchors the decay: before trading starts L_eff = L0", () => {
    const m = market({ liquidityPeriodSecs: 3600 });
    const early = quoteBuy(m, "Yes", 5, T0 + 60);
    const atStart = quoteBuy(m, "Yes", 5, T0 + 3600);
    if (!early || !atStart) throw new Error("no quote");
    approx(early.effectiveL, m.liquidityL, 1e-9);
    approx(atStart.effectiveL, m.liquidityL, 1e-9);
  });

  it("the implied book straddles the marginal price", () => {
    const m = market({ currentPrice: 0.62 });
    const book = impliedQuoteBook(m, NOW, 1);
    if (!book) throw new Error("no book");
    expect(book.yesAsk).toBeGreaterThan(0.62);
    expect(book.yesBid).toBeLessThan(0.62);
    expect(book.noAsk).toBeGreaterThan(0.38);
    expect(book.noBid).toBeLessThan(0.38);
  });
});
