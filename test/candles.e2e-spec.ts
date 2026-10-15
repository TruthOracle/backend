/**
 * Candlesticks and open interest (docs/MARKETS.md §5; docs/API.md "Candlesticks"): the projection
 * folds every market version into 1 min / 1 h / 1 d candles in the same transaction, the read side
 * returns a dense series, and the market list carries the 24 h figures derived from them.
 */
import { IndexerService } from "../src/services/indexer.service";
import type { ApiCandlesticks, ApiMarket, ApiPage } from "../src/types";
import { formatAmount, parseAmount } from "../src/util/money";
import { TEST_TREASURY, useTestApp } from "./helpers/app";
import { LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf } from "./helpers/session";

const ctx = useTestApp();
const [alice, bob] = parties(2, "trader");
const dec = (v: string): string => formatAmount(parseAmount(v));
const HOUR = 3600;

/** Three hourly buckets of activity ending just before now: buys at −2 h, a buy at −1 h, a sell at −10 min. */
async function seedHourlyActivity(): Promise<{
  f: LedgerFixture;
  base: number;
  nowSec: number;
  market: ReturnType<LedgerFixture["createMarket"]>["market"];
}> {
  const nowSec = Math.floor(Date.now() / 1000);
  // Buckets are wall-clock aligned, so the activity is laid out from an hour boundary ≥ 3 h ago
  // (the sell at now − 10 min then lands in the current or the previous hour, never in hour 2).
  const base = Math.floor((nowSec - 3 * HOUR) / HOUR) * HOUR - HOUR;
  const at = (sec: number): Date => new Date(sec * 1000);
  const f = new LedgerFixture(TEST_TREASURY);
  const created = f.createMarket({
    marketId: 1,
    question: "Hourly?",
    price: "0.5",
    createdAt: base,
    expiresAt: base + 30 * 86_400,
    ticker: "TEST-HOURLY",
    eventTicker: "TEST-EV",
    at: at(base + 60),
  });
  const wa = f.createWallet(alice);
  const da = f.deposit(wa.wallet, "100", "a-ref");
  const wb = f.createWallet(bob);
  const db = f.deposit(wb.wallet, "50", "b-ref");
  const b1 = f.buy({
    market: created.market,
    wallet: da.wallet,
    buyer: alice,
    side: "Yes",
    amount: "10",
    sharesOut: "18",
    newPrice: "0.55",
    at: at(base + HOUR + 120),
  });
  const b2 = f.buy({
    market: b1.market,
    wallet: db.wallet,
    buyer: bob,
    side: "No",
    amount: "4",
    sharesOut: "7",
    newPrice: "0.52",
    at: at(base + HOUR + 900),
  });
  const b3 = f.buy({
    market: b2.market,
    wallet: b1.wallet,
    position: b1.position,
    buyer: alice,
    side: "Yes",
    amount: "6",
    sharesOut: "10",
    newPrice: "0.6",
    at: at(base + 2 * HOUR + 30),
  });
  const s1 = f.sell({
    market: b3.market,
    wallet: b3.wallet,
    position: b3.position,
    seller: alice,
    side: "Yes",
    sharesIn: "8",
    gross: "4.5",
    newPrice: "0.57",
    at: at(nowSec - 600),
  });
  ctx.stream.push(...f.txs);
  await ctx.get(IndexerService).runOnce();
  return { f, base, nowSec, market: s1.market };
}

describe("candlesticks", () => {
  it("folds market versions into hourly OHLC candles with volume, trade counts and open interest, filling quiet hours", async () => {
    const { base, nowSec } = await seedHourlyActivity();
    const res = bodyOf<ApiCandlesticks>(
      await ctx.agent
        .get(
          `/api/v1/markets/TEST-HOURLY/candlesticks?periodInterval=60&startTs=${base}&endTs=${nowSec}`,
        )
        .expect(200),
    );
    expect(res).toMatchObject({ marketId: 1, ticker: "TEST-HOURLY", periodInterval: 60 });
    const bucket = (sec: number): number => Math.floor(sec / HOUR) * HOUR;
    const byStart = new Map(res.candlesticks.map((c) => [c.startTs, c]));
    // Every hour from the first bucket to the current one is present, in order.
    expect(res.candlesticks.map((c) => c.startTs)).toEqual(
      Array.from(
        { length: (bucket(nowSec) - bucket(base)) / HOUR + 1 },
        (_, i) => bucket(base) + i * HOUR,
      ),
    );

    const creation = byStart.get(bucket(base + 60));
    expect(creation).toMatchObject({ empty: false, trades: 0 });
    expect(creation?.price).toMatchObject({ open: dec("0.5"), close: dec("0.5"), previous: null });
    expect(creation?.volume).toBe(dec("0"));

    const hour1 = byStart.get(bucket(base + HOUR + 120));
    expect(hour1).toMatchObject({ empty: false, trades: 2 });
    expect(hour1?.price).toMatchObject({
      open: dec("0.55"),
      high: dec("0.55"),
      low: dec("0.52"),
      close: dec("0.52"),
      previous: dec("0.5"),
    });
    expect(hour1?.volume).toBe(dec("14"));
    // mean = (0.55 × 10 + 0.52 × 4) / 14
    expect(hour1?.price.mean).toBe(
      formatAmount((parseAmount("0.55") * 10n + parseAmount("0.52") * 4n) / 14n),
    );
    expect(hour1?.openInterest).toBe(dec("25")); // 18 YES + 7 NO outstanding after the two buys

    const hour2 = byStart.get(bucket(base + 2 * HOUR + 30));
    expect(hour2).toMatchObject({ empty: false, trades: 1 });
    expect(hour2?.price).toMatchObject({
      open: dec("0.6"),
      close: dec("0.6"),
      previous: dec("0.52"),
    });
    expect(hour2?.openInterest).toBe(dec("35"));

    const sellBucket = byStart.get(bucket(nowSec - 600));
    expect(sellBucket?.price.close).toBe(dec("0.57"));
    expect(sellBucket?.openInterest).toBe(dec("27")); // alice sold 8 YES
    expect(res.candlesticks[res.candlesticks.length - 1].price.close).toBe(dec("0.57"));
    expect(res.candlesticks.reduce((n, c) => n + c.trades, 0)).toBe(4);
    expect(formatAmount(res.candlesticks.reduce((n, c) => n + parseAmount(c.volume), 0n))).toBe(
      dec("24.5"),
    );

    // A quiet hour (if the window has one) is carried forward from the previous close.
    const quiet = res.candlesticks.filter((c) => c.empty);
    for (const c of quiet) {
      expect(c.price.open).toBe(c.price.close);
      expect(c.volume).toBe(dec("0"));
      expect(c.trades).toBe(0);
    }
  });

  it("serves the same versions at minute and day granularity", async () => {
    const { base, nowSec } = await seedHourlyActivity();
    const day = bodyOf<ApiCandlesticks>(
      await ctx.agent
        .get(`/api/v1/markets/1/candlesticks?periodInterval=1440&startTs=${base}&endTs=${nowSec}`)
        .expect(200),
    );
    const total = day.candlesticks.reduce((acc, c) => acc + parseAmount(c.volume), 0n);
    expect(formatAmount(total)).toBe(dec("24.5"));
    expect(day.candlesticks.reduce((acc, c) => acc + c.trades, 0)).toBe(4);
    const first = day.candlesticks[0];
    expect(first.price.open).toBe(dec("0.5"));
    expect(day.candlesticks[day.candlesticks.length - 1].price.close).toBe(dec("0.57"));

    const minutes = bodyOf<ApiCandlesticks>(
      await ctx.agent
        .get(
          `/api/v1/markets/1/candlesticks?periodInterval=1&startTs=${base + HOUR}&endTs=${base + HOUR + 1000}`,
        )
        .expect(200),
    );
    const withTrades = minutes.candlesticks.filter((c) => !c.empty);
    expect(withTrades.map((c) => [c.trades, c.volume])).toEqual([
      [1, dec("10")],
      [1, dec("4")],
    ]);
    // The minute before the first trade carries the creation price forward (the market existed).
    expect(minutes.candlesticks[0]).toMatchObject({ empty: true });
    expect(minutes.candlesticks[0].price.close).toBe(dec("0.5"));
  });

  it("validates the window and period", async () => {
    await seedHourlyActivity();
    await ctx.agent.get("/api/v1/markets/1/candlesticks?periodInterval=5").expect(400);
    await ctx.agent.get("/api/v1/markets/1/candlesticks?startTs=10&endTs=5").expect(400);
    // 5 001 minutes of minute candles is over the cap.
    await ctx.agent
      .get(`/api/v1/markets/1/candlesticks?periodInterval=1&startTs=0&endTs=${5_001 * 60}`)
      .expect(400);
    await ctx.agent.get("/api/v1/markets/999/candlesticks").expect(404);
    await ctx.agent.get("/api/v1/markets/NOPE-1/candlesticks").expect(404);
    // Defaults: the last 200 hourly buckets.
    const res = bodyOf<ApiCandlesticks>(
      await ctx.agent.get("/api/v1/markets/1/candlesticks").expect(200),
    );
    expect(res.periodInterval).toBe(60);
    expect(res.candlesticks.length).toBeGreaterThan(0);
  });

  it("the market list carries 24 h volume, the price change and open interest from the same candles", async () => {
    await seedHourlyActivity();
    const m = bodyOf<ApiPage<ApiMarket>>(await ctx.agent.get("/api/v1/markets").expect(200))
      .items[0];
    expect(m.ticker).toBe("TEST-HOURLY");
    expect(m.eventTicker).toBe("TEST-EV");
    expect(m.volume24h).toBe(dec("24.5"));
    // No candle is older than 24 h, so the reference is the market's first price.
    expect(m.previousPrice).toBe(dec("0.5"));
    expect(m.priceChange24h).toBe(dec("0.07"));
    expect(m.openInterest).toEqual({ yes: dec("20"), no: dec("7"), total: dec("27") });
    expect(parseAmount(m.liquidity)).toBeGreaterThan(0n);
    expect(m.book).not.toBeNull();
    expect(parseAmount(m.book!.yesAsk)).toBeGreaterThan(parseAmount(m.currentPrice));
    expect(parseAmount(m.book!.yesBid)).toBeLessThan(parseAmount(m.currentPrice));
    // Markets can be addressed by ticker everywhere.
    expect(
      bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/test-hourly").expect(200))
        .market.marketId,
    ).toBe(1);
    expect(
      bodyOf<ApiPage<ApiMarket>>(
        await ctx.agent.get("/api/v1/markets?tickers=TEST-HOURLY,OTHER-1").expect(200),
      ).total,
    ).toBe(1);
    expect(
      bodyOf<ApiPage<ApiMarket>>(await ctx.agent.get("/api/v1/markets?event=test-ev").expect(200))
        .total,
    ).toBe(1);
  });

  it("a market indexed from an ACS snapshot starts its chart at the snapshot and recomputes open interest", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    const created = f.createMarket({ marketId: 3, price: "0.4", ticker: "SNAP-1" });
    const wa = f.createWallet(alice);
    const da = f.deposit(wa.wallet, "20", "ref");
    const b = f.buy({
      market: created.market,
      wallet: da.wallet,
      buyer: alice,
      side: "Yes",
      amount: "5",
      sharesOut: "9",
    });
    ctx.stream.pruned = f.offset;
    ctx.stream.acs = [
      f.acsEntry("PredictionMarket", b.market.cid, b.market.payload, { offset: f.offset }),
      f.acsEntry("Position", b.position.cid, b.position.payload, {
        offset: f.offset,
        observers: [TEST_TREASURY],
      }),
      f.acsEntry("UserWallet", b.wallet.cid, b.wallet.payload, {
        offset: f.offset,
        observers: [alice],
      }),
    ];
    const later = f.deposit(b.wallet, "1", "later");
    ctx.stream.push(later.tx);
    await ctx.get(IndexerService).runOnce();
    const m = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/SNAP-1").expect(200),
    ).market;
    expect(m.openInterest).toEqual({ yes: dec("9"), no: dec("0"), total: dec("9") });
    // Fixture snapshot entries carry no ledger time, so the seed is dated at the snapshot (now).
    const nowSec = Math.floor(Date.now() / 1000);
    const candles = bodyOf<ApiCandlesticks>(
      await ctx.agent
        .get(
          `/api/v1/markets/3/candlesticks?periodInterval=1440&startTs=${nowSec - 3 * 86_400}&endTs=${nowSec}`,
        )
        .expect(200),
    );
    const real = candles.candlesticks.filter((c) => !c.empty);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ trades: 0, volume: dec("0") });
    expect(real[0].openInterest).toBe(dec("9"));
    expect(real[0].price.close).toBe(m.currentPrice);
    expect(candles.candlesticks[candles.candlesticks.length - 1].startTs).toBe(real[0].startTs);
  });
});
