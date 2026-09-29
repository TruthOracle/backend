/**
 * `npm run seed:dev` — a demo catalog in the LOCAL index for UI work (docs/RUNBOOK.md §13): three
 * series, three events, seven markets, thirty days of candles and a trade feed, written straight
 * into Postgres through the app's DataSource. Nothing here exists on the ledger — negative market
 * ids, `demo-` contract ids and `DEMO-` tickers keep the rows apart from what the indexer writes,
 * `--clear` removes exactly them, and an index rebuild drops them (the projection never recreates
 * what it never indexed). Trading on a demo market fails at `orders/prepare` (no contract).
 * Refuses outside `APP_ENV=dev`. Re-running replaces the previous demo rows.
 *
 * The numbers come from a seeded random walk, so every run produces the same chart: each market
 * walks minute by minute for 30 days; a minute with a trade produces a 1-minute candle and a
 * `to_market_events` row, and the hourly / daily candles are the exact fold of those minutes —
 * the same shape the projection produces (docs/MARKETS.md §5), with one creation candle at the
 * market's first period.
 */
import { join } from "node:path";
import { DataSource, type QueryRunner } from "typeorm";

import { getConfiguration } from "../config";
import { buildDataSourceOptions } from "../data-source";
import { periodStartSec } from "../indexer/candles";
import { formatCC, parseCC } from "../util/money";

const HOUR = 3600;
const DAY = 86_400;
const DAYS = 30;
/** Demo ledger offsets sort after every real transaction the DevNet index holds (feed order is by offset). */
const OFFSET_BASE = 900_000_000_000;
const CC = (n: number): bigint => parseCC(n.toFixed(6));

interface DemoSeries {
  ticker: string;
  title: string;
  category: string;
  frequency: string;
  tags: string[];
  description: string;
}
interface DemoEvent {
  ticker: string;
  series: string;
  title: string;
  subTitle: string;
  imageUrl: string;
  description: string;
  mutuallyExclusive: boolean;
  expiresInDays: number;
}
interface DemoMarket {
  event: string;
  suffix: string;
  question: string;
  yes: string;
  no: string;
  rules: string;
  description: string;
  imageUrl: string;
  startPrice: number;
  /** Trades per day over the older 29 days and per hour over the last day (the feed density). */
  tradesPerDay: number;
  tradesLastDayPerHour: number;
}

const SERIES: DemoSeries[] = [
  { ticker: "DEMO-FED", title: "Fed rate decisions", category: "Economics", frequency: "monthly", tags: ["rates", "macro"], description: "Demo: the FOMC's target-range decisions." },
  { ticker: "DEMO-EPL", title: "Premier League match results", category: "Sports", frequency: "weekly", tags: ["football", "epl"], description: "Demo: full-time results of Premier League fixtures." },
  { ticker: "DEMO-BTC", title: "Bitcoin price levels", category: "Crypto", frequency: "monthly", tags: ["bitcoin", "crypto"], description: "Demo: BTC/USD reference price at month end." },
];
const EVENTS: DemoEvent[] = [
  { ticker: "DEMO-FED-26MAR", series: "DEMO-FED", title: "Fed decision, March 2026", subTitle: "March FOMC meeting", imageUrl: "https://placehold.co/640x360/0f172a/ffffff?text=FOMC+March+2026", description: "Demo event: what the FOMC does to the target range at its March 2026 meeting.", mutuallyExclusive: true, expiresInDays: 45 },
  { ticker: "DEMO-EPL-26MAY13", series: "DEMO-EPL", title: "Liverpool vs Brighton, 13 May 2026", subTitle: "Anfield, matchday 37", imageUrl: "https://placehold.co/640x360/14532d/ffffff?text=LIV+v+BHA", description: "Demo event: the full-time result at Anfield.", mutuallyExclusive: true, expiresInDays: 60 },
  { ticker: "DEMO-BTC-26JUN", series: "DEMO-BTC", title: "Bitcoin above $150k by 30 June 2026?", subTitle: "Month-end reference price", imageUrl: "https://placehold.co/640x360/78350f/ffffff?text=BTC+%24150k", description: "Demo event: one binary market on the June month-end reference price.", mutuallyExclusive: false, expiresInDays: 90 },
];
const MARKETS: DemoMarket[] = [
  { event: "DEMO-FED-26MAR", suffix: "CUT25", question: "Will the Fed cut by at least 25 bps in March 2026?", yes: "Cut ≥ 25 bps", no: "Smaller or none", rules: "Resolves Yes if the FOMC statement of the March 2026 meeting lowers the upper bound of the federal funds target range by 25 bps or more.", description: "The market on a March cut of a quarter point or more.", imageUrl: "", startPrice: 0.42, tradesPerDay: 4, tradesLastDayPerHour: 1.4 },
  { event: "DEMO-FED-26MAR", suffix: "HOLD", question: "Will the Fed hold rates in March 2026?", yes: "Hold", no: "Cut or hike", rules: "Resolves Yes if the FOMC statement of the March 2026 meeting leaves the target range unchanged.", description: "The market on the range staying where it is.", imageUrl: "", startPrice: 0.46, tradesPerDay: 3, tradesLastDayPerHour: 1.1 },
  { event: "DEMO-FED-26MAR", suffix: "HIKE", question: "Will the Fed hike rates in March 2026?", yes: "Hike", no: "Hold or cut", rules: "Resolves Yes if the FOMC statement of the March 2026 meeting raises the upper bound of the target range.", description: "The tail: a March hike.", imageUrl: "", startPrice: 0.08, tradesPerDay: 1.5, tradesLastDayPerHour: 0.5 },
  { event: "DEMO-EPL-26MAY13", suffix: "LIV", question: "Will Liverpool beat Brighton on 13 May 2026?", yes: "Liverpool win", no: "Draw or Brighton", rules: "Resolves Yes on a Liverpool win at full time (90 minutes plus stoppage time) per the Premier League's official result.", description: "Home win at Anfield.", imageUrl: "", startPrice: 0.55, tradesPerDay: 5, tradesLastDayPerHour: 1.6 },
  { event: "DEMO-EPL-26MAY13", suffix: "DRAW", question: "Will Liverpool and Brighton draw on 13 May 2026?", yes: "Draw", no: "Either side wins", rules: "Resolves Yes on a draw at full time per the Premier League's official result.", description: "The draw.", imageUrl: "", startPrice: 0.24, tradesPerDay: 2, tradesLastDayPerHour: 0.8 },
  { event: "DEMO-EPL-26MAY13", suffix: "BHA", question: "Will Brighton beat Liverpool on 13 May 2026?", yes: "Brighton win", no: "Draw or Liverpool", rules: "Resolves Yes on a Brighton win at full time per the Premier League's official result.", description: "The away win.", imageUrl: "", startPrice: 0.21, tradesPerDay: 2, tradesLastDayPerHour: 0.7 },
  { event: "DEMO-BTC-26JUN", suffix: "150K", question: "Will Bitcoin trade above $150,000 on 30 June 2026?", yes: "Above $150k", no: "At or below $150k", rules: "Resolves Yes if the CoinGecko BTC/USD reference price at 23:59 UTC on 30 June 2026 is above 150,000.", description: "The binary demo market: one event, one market.", imageUrl: "https://placehold.co/640x360/78350f/ffffff?text=BTC", startPrice: 0.31, tradesPerDay: 6, tradesLastDayPerHour: 2.2 },
];

/** Deterministic PRNG (mulberry32) — the same seed draws the same chart on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Trade {
  atSec: number;
  kind: "buy" | "sell";
  side: "Yes" | "No";
  actor: string;
  amount: number;
  shares: number;
  fee: number;
  priceBefore: number;
  priceAfter: number;
  openInterestYes: number;
  openInterestNo: number;
}

function traders(): string[] {
  return Array.from({ length: 12 }, (_, i) => `demo-trader-${i + 1}::1220${(i + 1).toString(16).padStart(64, "0")}`);
}

/** Walk one market for 30 days: sparse trades that move the price, clamped to (0.05, 0.95). */
function walk(spec: DemoMarket, seed: number, startSec: number, nowSec: number): Trade[] {
  const rand = rng(seed);
  const parties = traders();
  const trades: Trade[] = [];
  let price = spec.startPrice;
  let oiYes = 40 + rand() * 60;
  let oiNo = 40 + rand() * 60;
  const lastDayStart = nowSec - DAY;
  for (let t = startSec + 60; t <= nowSec; t += 60) {
    const p = t >= lastDayStart ? spec.tradesLastDayPerHour / 60 : spec.tradesPerDay / (24 * 60);
    if (rand() >= p) continue;
    // Mild mean reversion towards the start price keeps the walk inside the band and readable.
    const pull = (spec.startPrice - price) * 0.02;
    const side: "Yes" | "No" = rand() + pull * 4 < 0.5 ? "No" : "Yes";
    const kind: "buy" | "sell" = rand() < 0.72 ? "buy" : "sell";
    const amount = Math.round((1 + rand() * rand() * 60) * 100) / 100;
    const impact = amount / 900 + rand() * 0.006;
    const direction = (side === "Yes") === (kind === "buy") ? 1 : -1;
    const next = Math.min(0.95, Math.max(0.05, price + direction * impact));
    const fill = kind === "buy" ? (side === "Yes" ? price : 1 - price) : (side === "Yes" ? next : 1 - next);
    const shares = Math.round((amount / Math.max(fill, 0.02)) * 100) / 100;
    if (kind === "buy") {
      if (side === "Yes") oiYes += shares;
      else oiNo += shares;
    } else if (side === "Yes") oiYes = Math.max(0, oiYes - shares);
    else oiNo = Math.max(0, oiNo - shares);
    trades.push({
      atSec: t,
      kind,
      side,
      actor: parties[Math.floor(rand() * parties.length)],
      amount,
      shares,
      fee: Math.round(amount * 0.003 * 10_000) / 10_000,
      priceBefore: price,
      priceAfter: next,
      openInterestYes: oiYes,
      openInterestNo: oiNo,
    });
    price = next;
  }
  return trades;
}

interface Candle {
  periodSecs: number;
  periodStart: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  notional: number;
  trades: number;
  openInterest: number;
  lastOffset: number;
}

/** Fold trades into candles the way the projection does: one row per period that saw a version. */
function fold(trades: Trade[], periodSecs: number, creation: { atSec: number; price: number; openInterest: number; offset: number }, offsetOf: (i: number) => number): Candle[] {
  const out = new Map<number, Candle>();
  const touch = (atSec: number, price: number, volume: number, tradeCount: number, openInterest: number, offset: number): void => {
    const start = periodStartSec(atSec, periodSecs);
    const c = out.get(start);
    if (!c) {
      out.set(start, { periodSecs, periodStart: start, open: price, high: price, low: price, close: price, volume, notional: price * volume, trades: tradeCount, openInterest, lastOffset: offset });
      return;
    }
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume += volume;
    c.notional += price * volume;
    c.trades += tradeCount;
    c.openInterest = openInterest;
    c.lastOffset = offset;
  };
  touch(creation.atSec, creation.price, 0, 0, creation.openInterest, creation.offset);
  trades.forEach((t, i) => touch(t.atSec, t.priceAfter, t.amount, 1, t.openInterestYes + t.openInterestNo, offsetOf(i)));
  return [...out.values()].sort((a, b) => a.periodStart - b.periodStart);
}

async function insertRows(q: QueryRunner, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const chunk = Math.max(1, Math.floor(60_000 / columns.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = slice
      .map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(", ")})`)
      .join(", ");
    await q.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`, params);
  }
}

async function clearDemo(q: QueryRunner): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const del = async (table: string, where: string): Promise<void> => {
    const res = await q.query(`DELETE FROM ${table} WHERE ${where}`, [], true);
    counts[table] = res.affected ?? 0;
  };
  await del("to_market_events", "event_id LIKE 'demo-%'");
  await del("to_market_candles", "market_id < 0");
  await del("to_market_metadata", "ticker LIKE 'DEMO-%'");
  await del("to_markets", "market_id < 0 AND contract_id LIKE 'demo-%'");
  await del("to_events", "ticker LIKE 'DEMO-%'");
  await del("to_series", "ticker LIKE 'DEMO-%'");
  return counts;
}

async function seed(q: QueryRunner): Promise<Record<string, number>> {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = periodStartSec(nowSec - DAYS * DAY, HOUR);
  const admin = `demo-operator::1220${"0".repeat(64)}`;
  await insertRows(q, "to_series", ["ticker", "title", "category", "frequency", "tags", "settlement_sources", "contract_url", "description", "status", "product_metadata"],
    SERIES.map((s) => [s.ticker, s.title, s.category, s.frequency, JSON.stringify(s.tags), JSON.stringify([{ name: "Demo source", url: "https://example.com/demo" }]), null, s.description, "active", JSON.stringify({ demo: true })]));
  await insertRows(q, "to_events", ["ticker", "series_ticker", "title", "sub_title", "image_url", "description", "mutually_exclusive", "strike_date", "strike_period", "settlement_sources", "product_metadata", "archived"],
    EVENTS.map((e) => [e.ticker, e.series, e.title, e.subTitle, e.imageUrl, e.description, e.mutuallyExclusive, new Date((nowSec + e.expiresInDays * DAY) * 1000).toISOString(), null, JSON.stringify([]), JSON.stringify({ demo: true }), false]));

  let offsetSeq = 0;
  const marketRows: unknown[][] = [];
  const metadataRows: unknown[][] = [];
  const candleRows: unknown[][] = [];
  const tradeRows: unknown[][] = [];
  MARKETS.forEach((spec, index) => {
    const marketId = -(index + 1);
    const ticker = `${spec.event}-${spec.suffix}`;
    const event = EVENTS.find((e) => e.ticker === spec.event)!;
    const expiresAt = nowSec + event.expiresInDays * DAY;
    const trades = walk(spec, 1000 + index * 7919, startSec, nowSec);
    const createdOffset = OFFSET_BASE + ++offsetSeq;
    const tradeOffsets = trades.map(() => OFFSET_BASE + ++offsetSeq);
    const last = trades[trades.length - 1];
    const price = last ? last.priceAfter : spec.startPrice;
    const oiYes = last ? last.openInterestYes : 80;
    const oiNo = last ? last.openInterestNo : 80;
    const volume = trades.reduce((n, t) => n + t.amount, 0);
    const fees = trades.reduce((n, t) => n + t.fee, 0);
    const liquidityL = 250;
    const creation = { atSec: startSec, price: spec.startPrice, openInterest: 160, offset: createdOffset };
    for (const periodSecs of [60, HOUR, DAY]) {
      for (const c of fold(trades, periodSecs, creation, (i) => tradeOffsets[i])) {
        // Minute rows only for the last day (a chart never asks for older minutes; the projection would hold them all).
        if (periodSecs === 60 && c.periodStart < nowSec - DAY) continue;
        candleRows.push([String(marketId), periodSecs, new Date(c.periodStart * 1000).toISOString(), formatCC(CC(c.open)), formatCC(CC(c.high)), formatCC(CC(c.low)), formatCC(CC(c.close)), formatCC(CC(c.volume)), formatCC(CC(c.notional)), c.trades, formatCC(CC(c.openInterest)), formatCC(CC(liquidityL)), String(c.lastOffset), 0]);
      }
    }
    trades.forEach((t, i) => {
      tradeRows.push([`demo-${marketId}-${i + 1}`, String(marketId), t.kind, t.actor, t.side, formatCC(CC(t.amount)), formatCC(CC(t.kind === "buy" ? t.amount - t.fee : t.amount - t.fee)), formatCC(CC(t.shares)), null, formatCC(CC(t.fee)), formatCC(CC(t.priceBefore)), formatCC(CC(t.priceAfter)), null, null, JSON.stringify({ demo: true }), String(tradeOffsets[i]), 0, `demo-update-${marketId}-${i + 1}`, null, new Date(t.atSec * 1000).toISOString(), new Date(t.atSec * 1000).toISOString()]);
    });
    marketRows.push([
      String(marketId), `demo-mk-${index + 1}`, admin, spec.question, spec.rules, ticker, spec.event, spec.yes, spec.no, "demo:Truthoracle:PredictionMarket",
      formatCC(CC(oiYes)), formatCC(CC(oiNo)), String(startSec), String(expiresAt), 86_400, true, 0,
      formatCC(CC(300 * (1 - price) + 120)), formatCC(CC(300 * price + 120)), formatCC(CC(liquidityL)), formatCC(CC(liquidityL)), formatCC(CC(price)),
      30, 2000, formatCC(CC(fees * 0.8)), formatCC(CC(fees * 0.2)), formatCC(CC(volume)), "Trading", null, null, null,
      JSON.stringify({ operatorResolution: true, sources: ["https://example.com/demo"], sourceKeys: [], reporters: [], quorum: 0, challengeSecs: 0, bondCC: "0.0000000000" }),
      JSON.stringify([]), null, null, String(createdOffset), String(last ? tradeOffsets[trades.length - 1] : createdOffset),
      new Date(startSec * 1000).toISOString(), new Date((last ? last.atSec : startSec) * 1000).toISOString(), false, null, trades.length, last ? new Date(last.atSec * 1000).toISOString() : null,
    ]);
    metadataRows.push([ticker, spec.imageUrl, spec.description, null]);
  });
  await insertRows(q, "to_markets", [
    "market_id", "contract_id", "admin", "question", "resolution_description", "ticker", "event_ticker", "yes_sub_title", "no_sub_title", "template_id",
    "open_interest_yes", "open_interest_no", "created_at_sec", "expires_at_sec", "grace_period_secs", "is_dynamic", "liquidity_period_secs",
    "reserve_yes", "reserve_no", "liquidity_l", "lp_token_supply", "current_price",
    "fee_bps", "prize_fee_share_bps", "accumulated_fees_cc", "prize_pool_cc", "total_volume_cc", "status", "outcome", "resolved_at_sec", "proposal",
    "policy", "audit_observers", "created_event_blob", "synchronizer_id", "created_offset", "updated_offset",
    "created_at_ledger", "updated_at_ledger", "archived", "archived_offset", "trade_count", "last_trade_at",
  ], marketRows);
  await insertRows(q, "to_market_metadata", ["ticker", "image_url", "description", "updated_by_user_id"], metadataRows);
  await insertRows(q, "to_market_candles", ["market_id", "period_secs", "period_start", "open", "high", "low", "close", "volume_cc", "notional_cc", "trades", "open_interest", "liquidity_l", "last_offset", "last_node_id"], candleRows);
  await insertRows(q, "to_market_events", ["event_id", "market_id", "kind", "actor", "side", "amount_cc", "net_cc", "shares", "shares_out", "fee_cc", "price_before", "price_after", "lp_tokens", "outcome", "details", "\"offset\"", "node_id", "update_id", "command_id", "effective_at", "record_time"], tradeRows);
  return { series: SERIES.length, events: EVENTS.length, markets: marketRows.length, candles: candleRows.length, trades: tradeRows.length };
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(__dirname, "..", "..", ".env"));
  } catch {
    // no .env: the environment must carry the configuration
  }
  const config = getConfiguration();
  if (config.appEnv !== "dev") {
    console.error(`seed:dev refuses to run with APP_ENV=${config.appEnv}: demo rows are for a developer's index only`);
    return 2;
  }
  const clearOnly = process.argv.includes("--clear");
  const ds = new DataSource(buildDataSourceOptions({ databaseUrl: config.databaseUrl, dbSsl: config.dbSsl, dbSslCa: config.dbSslCa }));
  await ds.initialize();
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const removed = await clearDemo(runner);
    console.log(`removed previous demo rows: ${JSON.stringify(removed)}`);
    if (!clearOnly) {
      const inserted = await seed(runner);
      console.log(`seeded: ${JSON.stringify(inserted)}`);
      console.log("demo markets: " + MARKETS.map((m) => `${m.event}-${m.suffix}`).join(", "));
      console.log("read them at GET /api/v1/events?withNestedMarkets=true&sort=trending and GET /api/v1/events/DEMO-FED-26MAR/candlesticks");
    }
    await runner.commitTransaction();
    return 0;
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
    await ds.destroy();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
