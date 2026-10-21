/**
 * What a Kalshi-style UI reads for its charts and feeds (docs/MARKETS.md §5 "Charts"; docs/API.md
 * "Candlesticks", "Catalog"): one aligned candle series per member market of an event, the trade
 * feed with its masked takers and keyset pages, event cards ranked and aggregated over their
 * markets, and sparklines for a page of markets — all read from the index, nothing aggregated
 * by a worker.
 */
import { IndexerService } from "../src/services/indexer.service";
import type {
  ApiEvent,
  ApiEventCandlesticks,
  ApiMarket,
  ApiMarketEvent,
  ApiPage,
} from "../src/types";
import { formatAmount, parseAmount } from "../src/util/money";
import { TEST_TREASURY, useTestApp } from "./helpers/app";
import { LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf } from "./helpers/session";

const ctx = useTestApp();
const [alice, bob] = parties(2, "trader");
const dec = (v: string): string => formatAmount(parseAmount(v));
const HOUR = 3600;
const DAY = 86_400;
const bucket = (sec: number, period = HOUR): number => Math.floor(sec / period) * period;

/**
 * Two events. FED-26MAR has three legs: CUT25 traded twice in the last hours, HOLD traded once
 * two days ago, HIKE never traded. BTC-26JUN has one leg traded once, an hour ago, for more CC
 * than anything in FED today. Everything is created three days ago so both charts have history.
 */
async function seedTwoEvents(): Promise<{ nowSec: number; createdAt: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const createdAt = bucket(nowSec - 3 * DAY);
  const at = (sec: number): Date => new Date(sec * 1000);
  const f = new LedgerFixture(TEST_TREASURY);
  const cut = f.createMarket({
    marketId: 1,
    ticker: "FED-26MAR-CUT25",
    eventTicker: "FED-26MAR",
    yesSubTitle: "Cut ≥ 25 bps",
    price: "0.4",
    createdAt,
    expiresAt: createdAt + 20 * DAY,
    at: at(createdAt + 10),
  });
  const hold = f.createMarket({
    marketId: 2,
    ticker: "FED-26MAR-HOLD",
    eventTicker: "FED-26MAR",
    yesSubTitle: "Hold",
    price: "0.5",
    createdAt,
    expiresAt: createdAt + 20 * DAY,
    at: at(createdAt + 20),
  });
  f.createMarket({
    marketId: 3,
    ticker: "FED-26MAR-HIKE",
    eventTicker: "FED-26MAR",
    yesSubTitle: "Hike",
    price: "0.1",
    createdAt,
    expiresAt: createdAt + 20 * DAY,
    at: at(createdAt + 30),
  });
  const btc = f.createMarket({
    marketId: 4,
    ticker: "BTC-26JUN-150K",
    eventTicker: "BTC-26JUN",
    yesSubTitle: "Above $150k",
    price: "0.3",
    createdAt,
    expiresAt: createdAt + 40 * DAY,
    at: at(createdAt + 40),
  });
  const wa = f.deposit(f.createWallet(alice).wallet, "500", "a-ref");
  const wb = f.deposit(f.createWallet(bob).wallet, "500", "b-ref");
  // HOLD: one buy two days ago (lifetime volume, nothing in the last 24 h).
  f.buy({
    market: hold.market,
    wallet: wa.wallet,
    buyer: alice,
    side: "Yes",
    amount: "30",
    sharesOut: "50",
    newPrice: "0.55",
    at: at(nowSec - 2 * DAY),
  });
  // CUT25: two buys in the last hours.
  const c1 = f.buy({
    market: cut.market,
    wallet: wb.wallet,
    buyer: bob,
    side: "Yes",
    amount: "10",
    sharesOut: "20",
    newPrice: "0.45",
    at: at(nowSec - 5 * HOUR),
  });
  f.buy({
    market: c1.market,
    wallet: c1.wallet,
    position: c1.position,
    buyer: bob,
    side: "Yes",
    amount: "8",
    sharesOut: "15",
    newPrice: "0.5",
    at: at(nowSec - 2 * HOUR),
  });
  // BTC: one big buy an hour ago.
  f.buy({
    market: btc.market,
    wallet: wb.wallet,
    buyer: bob,
    side: "No",
    amount: "40",
    sharesOut: "55",
    newPrice: "0.25",
    at: at(nowSec - HOUR),
  });
  ctx.stream.push(...f.txs);
  await ctx.get(IndexerService).runOnce();
  return { nowSec, createdAt };
}

describe("event candlesticks", () => {
  it("returns one aligned dense series per member market, busiest first, every status included", async () => {
    const { nowSec, createdAt } = await seedTwoEvents();
    const res = bodyOf<ApiEventCandlesticks>(
      await ctx.agent
        .get(
          `/api/v1/events/fed-26mar/candlesticks?periodInterval=60&startTs=${createdAt}&endTs=${nowSec}`,
        )
        .expect(200),
    );
    expect(res).toMatchObject({
      eventTicker: "FED-26MAR",
      periodInterval: 60,
      startTs: bucket(createdAt),
    });
    expect(res.endTs).toBe(bucket(nowSec) + HOUR);
    // 24 h volume: CUT25 (18) > HOLD (0, traded two days ago) = HIKE (0) → ties by market id.
    expect(res.markets.map((m) => m.ticker)).toEqual([
      "FED-26MAR-CUT25",
      "FED-26MAR-HOLD",
      "FED-26MAR-HIKE",
    ]);
    const [cut, hold, hike] = res.markets;
    expect(cut).toMatchObject({
      marketId: 1,
      yesSubTitle: "Cut ≥ 25 bps",
      noSubTitle: "No",
      status: "Trading",
      currentPrice: dec("0.5"),
    });
    // Every series covers the same buckets: the window is shared, so the x axes line up.
    const expected = Array.from(
      { length: (bucket(nowSec) - bucket(createdAt)) / HOUR + 1 },
      (_, i) => bucket(createdAt) + i * HOUR,
    );
    for (const m of res.markets) expect(m.candlesticks.map((c) => c.startTs)).toEqual(expected);
    // A never-traded leg is flat at its creation price all the way through.
    expect(new Set(hike.candlesticks.map((c) => c.price.close))).toEqual(new Set([dec("0.1")]));
    expect(hike.candlesticks.filter((c) => !c.empty)).toHaveLength(1);
    // The leg traded two days ago carries that close forward to now.
    expect(hold.candlesticks[hold.candlesticks.length - 1].price.close).toBe(dec("0.55"));
    expect(hold.candlesticks.filter((c) => !c.empty)).toHaveLength(2);
    // The busy leg ends at its last trade and its candles carry the trades.
    expect(cut.candlesticks[cut.candlesticks.length - 1].price.close).toBe(dec("0.5"));
    expect(cut.candlesticks.reduce((n, c) => n + c.trades, 0)).toBe(2);
    expect(formatAmount(cut.candlesticks.reduce((n, c) => n + parseAmount(c.volume), 0n))).toBe(
      dec("18"),
    );
  });

  it("a window that starts after the trades still draws every leg from the carried-forward close", async () => {
    const { nowSec } = await seedTwoEvents();
    const res = bodyOf<ApiEventCandlesticks>(
      await ctx.agent
        .get(
          `/api/v1/events/FED-26MAR/candlesticks?periodInterval=1&startTs=${nowSec - 30 * 60}&endTs=${nowSec}`,
        )
        .expect(200),
    );
    for (const m of res.markets) {
      expect(m.candlesticks.length).toBe(31);
      expect(m.candlesticks.every((c) => c.empty)).toBe(true);
    }
    expect(res.markets.map((m) => m.candlesticks[0].price.close)).toEqual([
      dec("0.5"),
      dec("0.55"),
      dec("0.1"),
    ]);
  });

  it("validates like the market read and answers 404 for an unknown event", async () => {
    await seedTwoEvents();
    await ctx.agent.get("/api/v1/events/NOPE/candlesticks").expect(404);
    await ctx.agent.get("/api/v1/events/FED-26MAR/candlesticks?periodInterval=5").expect(400);
    await ctx.agent.get("/api/v1/events/FED-26MAR/candlesticks?startTs=10&endTs=5").expect(400);
    await ctx.agent
      .get(`/api/v1/events/FED-26MAR/candlesticks?periodInterval=1&startTs=0&endTs=${5_001 * 60}`)
      .expect(400);
    const defaults = bodyOf<ApiEventCandlesticks>(
      await ctx.agent.get("/api/v1/events/FED-26MAR/candlesticks").expect(200),
    );
    expect(defaults.periodInterval).toBe(60);
    expect(defaults.markets).toHaveLength(3);
  });
});

describe("trade feed", () => {
  it("carries the feed fields with a masked taker, and pages the event feed by cursor", async () => {
    await seedTwoEvents();
    const first = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent.get("/api/v1/events/fed-26mar/trades?limit=2").expect(200),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^\d+:\d+$/);
    const [latest, older] = first.items;
    expect(latest).toMatchObject({
      ticker: "FED-26MAR-CUT25",
      action: "buy",
      side: "Yes",
      yesPrice: dec("0.5"),
      noPrice: dec("0.5"),
      notional: dec("8"),
      priceBefore: dec("0.45"),
      priceAfter: dec("0.5"),
      kind: "buy",
    });
    expect(latest.tradeId).toBe(latest.eventId);
    expect(latest.createdAt).toBe(latest.effectiveAt);
    expect(latest.takerParty).toBe(`${bob.slice(0, 8)}…${bob.slice(-6)}`);
    expect(latest.takerParty).not.toBe(bob);
    expect(older.ticker).toBe("FED-26MAR-CUT25");
    const second = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent
        .get(`/api/v1/events/FED-26MAR/trades?limit=2&cursor=${first.nextCursor}`)
        .expect(200),
    );
    expect(second.items.map((t) => t.ticker)).toEqual(["FED-26MAR-HOLD"]);
    expect(second.items[0].takerParty).toBe(`${alice.slice(0, 8)}…${alice.slice(-6)}`);
    expect(second.nextCursor).toBeNull();
    await ctx.agent.get("/api/v1/events/FED-26MAR/trades?cursor=junk").expect(400);
    await ctx.agent.get("/api/v1/events/NOPE/trades").expect(404);
    // The market feed keeps its pages and gains the same fields; `cursor=` switches it to keyset mode.
    const market = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent.get("/api/v1/markets/FED-26MAR-CUT25/trades").expect(200),
    );
    expect(market.total).toBe(2);
    expect(market.nextCursor).toBeUndefined();
    expect(market.items[0].ticker).toBe("FED-26MAR-CUT25");
    const keyset = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent.get("/api/v1/markets/1/trades?cursor=&limit=1").expect(200),
    );
    expect(keyset.items).toHaveLength(1);
    expect(keyset.nextCursor).toMatch(/^\d+:\d+$/);
  });
});

describe("event cards", () => {
  it("sorts by trending, volume, closing and newest, and aggregates over the member markets", async () => {
    await seedTwoEvents();
    const list = async (q: string): Promise<ApiEvent[]> =>
      bodyOf<ApiPage<ApiEvent>>(await ctx.agent.get(`/api/v1/events?${q}`).expect(200)).items;
    // Last 24 h: BTC 40 > FED 18. Lifetime: FED 48 > BTC 40.
    expect((await list("sort=trending")).map((e) => e.ticker)).toEqual(["BTC-26JUN", "FED-26MAR"]);
    expect((await list("sort=volume")).map((e) => e.ticker)).toEqual(["FED-26MAR", "BTC-26JUN"]);
    // FED closes in 20 days, BTC in 40.
    expect((await list("sort=closing")).map((e) => e.ticker)).toEqual(["FED-26MAR", "BTC-26JUN"]);
    expect((await list("sort=newest")).map((e) => e.ticker).sort()).toEqual([
      "BTC-26JUN",
      "FED-26MAR",
    ]);
    await ctx.agent.get("/api/v1/events?sort=random").expect(400);

    const [btc, fed] = await list("sort=trending&withNestedMarkets=true");
    expect(fed).toMatchObject({ volume: dec("48"), volume24h: dec("18"), marketCount: 3 });
    expect(fed.openInterest).toBe(dec("85")); // 50 HOLD + 35 CUT25
    expect(parseAmount(fed.liquidity)).toBeGreaterThan(0n);
    expect(fed.topMarket).toMatchObject({
      marketId: 2,
      ticker: "FED-26MAR-HOLD",
      yesSubTitle: "Hold",
      currentPrice: dec("0.55"),
    });
    // Nested markets: likeliest outcome first.
    expect(fed.markets?.map((m) => m.ticker)).toEqual([
      "FED-26MAR-HOLD",
      "FED-26MAR-CUT25",
      "FED-26MAR-HIKE",
    ]);
    expect(fed.markets?.[0]).toMatchObject({
      currentPrice: dec("0.55"),
      volume24h: dec("0"),
      imageUrl: "",
    });
    expect(btc).toMatchObject({ volume: dec("40"), volume24h: dec("40"), marketCount: 1 });
    expect(btc.topMarket?.ticker).toBe("BTC-26JUN-150K");
    // The detail read carries the same aggregates.
    const detail = bodyOf<{ event: ApiEvent }>(
      await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200),
    ).event;
    expect(detail.volume24h).toBe(dec("18"));
    expect(detail.markets?.map((m) => m.marketId)).toEqual([2, 1, 3]);
  });
});

describe("sparklines", () => {
  it("attaches the last 24 hourly closes to a page of markets, carried forward, on request only", async () => {
    const { nowSec } = await seedTwoEvents();
    const plain = bodyOf<ApiPage<ApiMarket>>(await ctx.agent.get("/api/v1/markets").expect(200));
    expect(plain.items.every((m) => m.sparkline === undefined)).toBe(true);
    const page = bodyOf<ApiPage<ApiMarket>>(
      await ctx.agent
        .get("/api/v1/markets?withSparkline=true&tickers=FED-26MAR-CUT25,FED-26MAR-HIKE")
        .expect(200),
    );
    const byTicker = new Map(page.items.map((m) => [m.ticker, m]));
    const cut = byTicker.get("FED-26MAR-CUT25")!.sparkline!;
    expect(cut.periodInterval).toBe(60);
    expect(cut.closes).toHaveLength(24);
    expect(cut.startTs).toBe(bucket(nowSec) - 23 * HOUR);
    expect(cut.closes[0]).toBe(dec("0.4")); // created three days ago at 0.4, first trade 5 h ago
    expect(cut.closes[cut.closes.length - 1]).toBe(dec("0.5"));
    expect(cut.closes).toContain(dec("0.45"));
    const hike = byTicker.get("FED-26MAR-HIKE")!.sparkline!;
    expect(new Set(hike.closes)).toEqual(new Set([dec("0.1")]));
    expect(hike.closes).toHaveLength(24);
  });
});
