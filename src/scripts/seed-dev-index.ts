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
import "../util/utc";
import { join } from "node:path";
import { DataSource, type QueryRunner } from "typeorm";

import { getConfiguration } from "../config";
import { buildDataSourceOptions } from "../data-source";
import { periodStartSec } from "../indexer/candles";
import { formatAmount, parseAmount } from "../util/money";

const HOUR = 3600;
const DAY = 86_400;
const DAYS = 30;
/** Demo ledger offsets sort after every real transaction the DevNet index holds (feed order is by offset). */
const OFFSET_BASE = 900_000_000_000;
/** A demo figure → fixed-point amount in whatever instrument the seeded markets carry. */
const units = (n: number): bigint => parseAmount(n.toFixed(6));

interface DemoSeries {
  ticker: string;
  title: string;
  category: string;
  frequency: string;
  tags: string[];
  description: string;
}
export interface DemoEvent {
  ticker: string;
  series: string;
  title: string;
  subTitle: string;
  imageUrl: string;
  description: string;
  mutuallyExclusive: boolean;
  /** Epoch seconds: the event's decisive moment (statement, kick-off, reference fix); trading stops here. */
  closesAtSec: number;
}
export interface DemoMarket {
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
  {
    ticker: "DEMO-FED",
    title: "Fed rate decisions",
    category: "Economics",
    frequency: "monthly",
    tags: ["rates", "macro"],
    description: "Demo: the FOMC's target-range decisions.",
  },
  {
    ticker: "DEMO-EPL",
    title: "Premier League match results",
    category: "Sports",
    frequency: "weekly",
    tags: ["football", "epl"],
    description: "Demo: full-time results of Premier League fixtures.",
  },
  {
    ticker: "DEMO-BTC",
    title: "Bitcoin price levels",
    category: "Crypto",
    frequency: "monthly",
    tags: ["bitcoin", "crypto"],
    description: "Demo: BTC/USD reference price at month end.",
  },
];
/**
 * FOMC policy statements, released at 2:00 pm ET on the second day of each meeting
 * (federalreserve.gov/monetarypolicy/fomccalendars.htm; each date is tentative until the
 * preceding meeting confirms it). UTC shifts with US daylight saving: 18:00 in EDT, 19:00 in EST.
 * Extend the list when the Fed publishes the next year.
 */
const FOMC_MEETINGS: { days: string; statementUtc: string }[] = [
  { days: "27–28 October 2026", statementUtc: "2026-10-28T18:00:00Z" },
  { days: "8–9 December 2026", statementUtc: "2026-12-09T19:00:00Z" },
  { days: "26–27 January 2027", statementUtc: "2027-01-27T19:00:00Z" },
  { days: "16–17 March 2027", statementUtc: "2027-03-17T18:00:00Z" },
  { days: "27–28 April 2027", statementUtc: "2027-04-28T18:00:00Z" },
  { days: "8–9 June 2027", statementUtc: "2027-06-09T18:00:00Z" },
  { days: "27–28 July 2027", statementUtc: "2027-07-28T18:00:00Z" },
  { days: "14–15 September 2027", statementUtc: "2027-09-15T18:00:00Z" },
  { days: "26–27 October 2027", statementUtc: "2027-10-27T18:00:00Z" },
  { days: "7–8 December 2027", statementUtc: "2027-12-08T19:00:00Z" },
];
/** Every demo event is at least this far ahead of the seed run, so its market has a real trading window. */
const MIN_DAYS_AHEAD = 14;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const date = (sec: number) => new Date(sec * 1000);
const two = (n: number) => String(n).padStart(2, "0");
/** `17 October 2026` */
const longDate = (sec: number) =>
  `${date(sec).getUTCDate()} ${MONTHS[date(sec).getUTCMonth()]} ${date(sec).getUTCFullYear()}`;
/** `17 Oct 2026` */
const shortDate = (sec: number) =>
  `${date(sec).getUTCDate()} ${MONTHS[date(sec).getUTCMonth()].slice(0, 3)} ${date(sec).getUTCFullYear()}`;
/** `26OCT` / `26OCT17`: the date code Kalshi-style tickers carry. */
const tickerDate = (sec: number, withDay: boolean) =>
  `${String(date(sec).getUTCFullYear()).slice(2)}${MONTHS[date(sec).getUTCMonth()].slice(0, 3).toUpperCase()}${withDay ? two(date(sec).getUTCDate()) : ""}`;
const clockUtc = (sec: number) =>
  `${two(date(sec).getUTCHours())}:${two(date(sec).getUTCMinutes())} UTC`;
const banner = (bg: string, text: string) =>
  `https://placehold.co/640x360/${bg}/ffffff?text=${encodeURIComponent(text).replace(/%20/g, "+")}`;

/** Last Sunday of a month, 01:00 UTC: when UK clocks change (BST runs last Sunday of March to last Sunday of October). */
function lastSundayOneUtc(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), 1) / 1000;
}
/** The first Saturday at least `fromSec` away, at the traditional 15:00 UK kick-off, in epoch seconds. */
function saturdayKickoff(fromSec: number): number {
  const d = date(fromSec);
  const day = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7)),
  );
  const y = day.getUTCFullYear();
  const noonSec = Date.UTC(y, day.getUTCMonth(), day.getUTCDate(), 12) / 1000;
  const bst = noonSec >= lastSundayOneUtc(y, 2) && noonSec < lastSundayOneUtc(y, 9);
  return Date.UTC(y, day.getUTCMonth(), day.getUTCDate(), bst ? 14 : 15) / 1000;
}
/** 23:59 UTC on the last day of the first month whose end is at least `fromSec` away. */
function monthEndFix(fromSec: number): number {
  const d = date(fromSec);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59) / 1000;
  return end >= fromSec ? end : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0, 23, 59) / 1000;
}

/**
 * The demo catalog, dated from the run: the next FOMC decision, the next Saturday fixture and
 * the next month-end fix, all at least MIN_DAYS_AHEAD out. Titles, tickers, questions, rules,
 * descriptions, banners and close times all follow from those dates, so a fresh seed never shows
 * an event that has already happened. Prices, volumes and the busier-first ordering come from
 * the fixed parameters below (the Premier League fixture trades hardest in the last day, so it
 * leads the trending board).
 */
export function demoCatalog(nowSec: number): { events: DemoEvent[]; markets: DemoMarket[] } {
  const earliest = nowSec + MIN_DAYS_AHEAD * DAY;

  const fomc = FOMC_MEETINGS.find((m) => Date.parse(m.statementUtc) / 1000 >= earliest);
  if (!fomc)
    throw new Error(
      "FOMC_MEETINGS has no meeting far enough ahead: add the next year's dates from federalreserve.gov",
    );
  const fedClose = Date.parse(fomc.statementUtc) / 1000;
  const fedMonth = `${MONTHS[date(fedClose).getUTCMonth()]} ${date(fedClose).getUTCFullYear()}`;
  const fed = `DEMO-FED-${tickerDate(fedClose, false)}`;
  const statement = `the FOMC statement released at 2:00 pm ET (${clockUtc(fedClose)}) on ${longDate(fedClose)}`;

  const kickoff = saturdayKickoff(earliest);
  const epl = `DEMO-EPL-${tickerDate(kickoff, true)}`;
  const matchDay = shortDate(kickoff);
  const ftRule =
    "at full time (90 minutes plus stoppage time; extra time and penalties do not count) per the Premier League's official result. A match postponed or abandoned and not completed within 48 hours voids the market.";

  const fix = monthEndFix(earliest);
  const btc = `DEMO-BTC-${tickerDate(fix, false)}`;
  const fixMonth = MONTHS[date(fix).getUTCMonth()];

  const events: DemoEvent[] = [
    {
      ticker: fed,
      series: "DEMO-FED",
      title: `Fed decision, ${fedMonth}`,
      subTitle: `FOMC meeting, ${fomc.days}`,
      imageUrl: banner("0f172a", `FOMC ${fedMonth}`),
      description: `Demo event. The Federal Open Market Committee meets on ${fomc.days} and publishes its decision at 2:00 pm ET (${clockUtc(fedClose)}) on ${longDate(fedClose)}. Three markets cover the move in the federal funds target range: a cut of 25 bps or more, a hold, or a hike. Exactly one resolves Yes, from the Federal Reserve's policy statement; trading stops when it is released.`,
      mutuallyExclusive: true,
      closesAtSec: fedClose,
    },
    {
      ticker: epl,
      series: "DEMO-EPL",
      title: `Liverpool vs Brighton, ${matchDay}`,
      subTitle: `Anfield · kick-off ${clockUtc(kickoff)}`,
      imageUrl: banner("14532d", `LIV v BHA ${matchDay}`),
      description: `Demo event. Liverpool host Brighton & Hove Albion at Anfield on ${longDate(kickoff)}, kick-off ${clockUtc(kickoff)}. Three markets cover the full-time result: a Liverpool win, a draw or a Brighton win, and exactly one resolves Yes. Only the 90 minutes plus stoppage time count, per the Premier League's official result. Trading stops at kick-off; a match postponed or abandoned and not completed within 48 hours voids all three markets and refunds the cost basis.`,
      mutuallyExclusive: true,
      closesAtSec: kickoff,
    },
    {
      ticker: btc,
      series: "DEMO-BTC",
      title: `Bitcoin above $150k on ${shortDate(fix)}?`,
      subTitle: "Month-end reference price",
      imageUrl: banner("78350f", `BTC ${fixMonth} ${date(fix).getUTCFullYear()}`),
      description: `Demo event. One binary market on where Bitcoin ends ${fixMonth}: it resolves Yes if the CoinGecko BTC/USD reference price at ${clockUtc(fix)} on ${longDate(fix)} is above $150,000, and No otherwise. Trading stops at that moment.`,
      mutuallyExclusive: false,
      closesAtSec: fix,
    },
  ];

  const markets: DemoMarket[] = [
    {
      event: fed,
      suffix: "CUT25",
      question: `Will the Fed cut rates by at least 25 bps in ${fedMonth}?`,
      yes: "Cut ≥ 25 bps",
      no: "Smaller cut, hold or hike",
      rules: `Resolves Yes if ${statement} lowers the upper bound of the federal funds target range by 25 bps or more versus the range in force before the meeting.`,
      description: `A cut of at least 25 bps at the ${MONTHS[date(fedClose).getUTCMonth()]} meeting.`,
      imageUrl: "https://placehold.co/96x96/2563eb/ffffff?text=CUT",
      startPrice: 0.42,
      tradesPerDay: 4,
      tradesLastDayPerHour: 1.4,
    },
    {
      event: fed,
      suffix: "HOLD",
      question: `Will the Fed hold rates in ${fedMonth}?`,
      yes: "Hold",
      no: "Cut or hike",
      rules: `Resolves Yes if ${statement} leaves the federal funds target range unchanged.`,
      description: `The target range staying where it is at the ${MONTHS[date(fedClose).getUTCMonth()]} meeting.`,
      imageUrl: "https://placehold.co/96x96/16a34a/ffffff?text=HOLD",
      startPrice: 0.46,
      tradesPerDay: 3,
      tradesLastDayPerHour: 1.1,
    },
    {
      event: fed,
      suffix: "HIKE",
      question: `Will the Fed hike rates in ${fedMonth}?`,
      yes: "Hike",
      no: "Hold or cut",
      rules: `Resolves Yes if ${statement} raises the upper bound of the federal funds target range.`,
      description: `Any increase in the target range at the ${MONTHS[date(fedClose).getUTCMonth()]} meeting.`,
      imageUrl: "https://placehold.co/96x96/d97706/ffffff?text=HIKE",
      startPrice: 0.08,
      tradesPerDay: 1.5,
      tradesLastDayPerHour: 0.5,
    },
    {
      event: epl,
      suffix: "LIV",
      question: `Will Liverpool beat Brighton on ${matchDay}?`,
      yes: "Liverpool win",
      no: "Draw or Brighton",
      rules: `Resolves Yes on a Liverpool win ${ftRule}`,
      description: "Liverpool win at Anfield.",
      imageUrl: "https://placehold.co/96x96/c8102e/ffffff?text=LFC",
      startPrice: 0.55,
      tradesPerDay: 5,
      tradesLastDayPerHour: 3.2,
    },
    {
      event: epl,
      suffix: "DRAW",
      question: `Will Liverpool and Brighton draw on ${matchDay}?`,
      yes: "Draw",
      no: "Either side wins",
      rules: `Resolves Yes on a draw ${ftRule}`,
      description: "The draw.",
      imageUrl: "https://placehold.co/96x96/475569/ffffff?text=DRAW",
      startPrice: 0.24,
      tradesPerDay: 2,
      tradesLastDayPerHour: 1.5,
    },
    {
      event: epl,
      suffix: "BHA",
      question: `Will Brighton beat Liverpool on ${matchDay}?`,
      yes: "Brighton win",
      no: "Draw or Liverpool",
      rules: `Resolves Yes on a Brighton win ${ftRule}`,
      description: "Brighton win away at Anfield.",
      imageUrl: "https://placehold.co/96x96/0057b8/ffffff?text=BHA",
      startPrice: 0.21,
      tradesPerDay: 2,
      tradesLastDayPerHour: 1.4,
    },
    {
      event: btc,
      suffix: "150K",
      question: `Will Bitcoin trade above $150,000 on ${longDate(fix)}?`,
      yes: "Above $150k",
      no: "At or below $150k",
      rules: `Resolves Yes if the CoinGecko BTC/USD reference price at ${clockUtc(fix)} on ${longDate(fix)} is above 150,000 USD; No otherwise.`,
      description: `Bitcoin above $150,000 at the end of ${fixMonth}.`,
      imageUrl: "https://placehold.co/96x96/f7931a/ffffff?text=150K",
      startPrice: 0.31,
      tradesPerDay: 6,
      tradesLastDayPerHour: 2.2,
    },
  ];
  return { events, markets };
}

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
  return Array.from(
    { length: 12 },
    (_, i) => `demo-trader-${i + 1}::1220${(i + 1).toString(16).padStart(64, "0")}`,
  );
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
    const fill =
      kind === "buy" ? (side === "Yes" ? price : 1 - price) : side === "Yes" ? next : 1 - next;
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
function fold(
  trades: Trade[],
  periodSecs: number,
  creation: { atSec: number; price: number; openInterest: number; offset: number },
  offsetOf: (i: number) => number,
): Candle[] {
  const out = new Map<number, Candle>();
  const touch = (
    atSec: number,
    price: number,
    volume: number,
    tradeCount: number,
    openInterest: number,
    offset: number,
  ): void => {
    const start = periodStartSec(atSec, periodSecs);
    const c = out.get(start);
    if (!c) {
      out.set(start, {
        periodSecs,
        periodStart: start,
        open: price,
        high: price,
        low: price,
        close: price,
        volume,
        notional: price * volume,
        trades: tradeCount,
        openInterest,
        lastOffset: offset,
      });
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
  trades.forEach((t, i) =>
    touch(t.atSec, t.priceAfter, t.amount, 1, t.openInterestYes + t.openInterestNo, offsetOf(i)),
  );
  return [...out.values()].sort((a, b) => a.periodStart - b.periodStart);
}

async function insertRows(
  q: QueryRunner,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  const chunk = Math.max(1, Math.floor(60_000 / columns.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = slice
      .map(
        (row) =>
          `(${row
            .map((v) => {
              params.push(v);
              return `$${params.length}`;
            })
            .join(", ")})`,
      )
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

async function seed(
  q: QueryRunner,
  config: ReturnType<typeof getConfiguration>,
): Promise<Record<string, number>> {
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = periodStartSec(nowSec - DAYS * DAY, HOUR);
  const { events: EVENTS, markets: MARKETS } = demoCatalog(nowSec);
  const admin = `demo-operator::1220${"0".repeat(64)}`;
  // Demo markets are denominated in the configured collateral; without one, a disabled DEMO
  // instrument is registered so the rows still render (the same fallback the indexer uses).
  const collateral = config.hasCollateralInstrument
    ? { admin: config.collateralInstrument.admin, id: config.collateralInstrument.id }
    : { admin: `demo-admin::1220${"0".repeat(64)}`, id: "DEMO" };
  if (!config.hasCollateralInstrument)
    await q.query(
      `INSERT INTO to_instruments (admin, id, symbol, name, decimals, kind, enabled, is_default_collateral, registry_auth, wallet_instrument_id)
         VALUES ($1, $2, $2, 'Demo token', 10, 'collateral', false, false, 'keycloak', $2) ON CONFLICT (admin, id) DO NOTHING`,
      [collateral.admin, collateral.id],
    );
  await insertRows(
    q,
    "to_series",
    [
      "ticker",
      "title",
      "category",
      "frequency",
      "tags",
      "settlement_sources",
      "contract_url",
      "description",
      "status",
      "product_metadata",
    ],
    SERIES.map((s) => [
      s.ticker,
      s.title,
      s.category,
      s.frequency,
      JSON.stringify(s.tags),
      JSON.stringify([{ name: "Demo source", url: "https://example.com/demo" }]),
      null,
      s.description,
      "active",
      JSON.stringify({ demo: true }),
    ]),
  );
  await insertRows(
    q,
    "to_events",
    [
      "ticker",
      "series_ticker",
      "title",
      "sub_title",
      "image_url",
      "description",
      "mutually_exclusive",
      "strike_date",
      "strike_period",
      "settlement_sources",
      "product_metadata",
      "archived",
      "collateral_admin",
      "collateral_id",
    ],
    EVENTS.map((e) => [
      e.ticker,
      e.series,
      e.title,
      e.subTitle,
      e.imageUrl,
      e.description,
      e.mutuallyExclusive,
      new Date(e.closesAtSec * 1000).toISOString(),
      null,
      JSON.stringify([]),
      JSON.stringify({ demo: true }),
      false,
      collateral.admin,
      collateral.id,
    ]),
  );

  let offsetSeq = 0;
  const marketRows: unknown[][] = [];
  const metadataRows: unknown[][] = [];
  const candleRows: unknown[][] = [];
  const tradeRows: unknown[][] = [];
  MARKETS.forEach((spec, index) => {
    const marketId = -(index + 1);
    const ticker = `${spec.event}-${spec.suffix}`;
    const event = EVENTS.find((e) => e.ticker === spec.event)!;
    const expiresAt = event.closesAtSec;
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
    const creation = {
      atSec: startSec,
      price: spec.startPrice,
      openInterest: 160,
      offset: createdOffset,
    };
    for (const periodSecs of [60, HOUR, DAY]) {
      for (const c of fold(trades, periodSecs, creation, (i) => tradeOffsets[i])) {
        // Minute rows only for the last day (a chart never asks for older minutes; the projection would hold them all).
        if (periodSecs === 60 && c.periodStart < nowSec - DAY) continue;
        candleRows.push([
          String(marketId),
          periodSecs,
          new Date(c.periodStart * 1000).toISOString(),
          formatAmount(units(c.open)),
          formatAmount(units(c.high)),
          formatAmount(units(c.low)),
          formatAmount(units(c.close)),
          formatAmount(units(c.volume)),
          formatAmount(units(c.notional)),
          c.trades,
          formatAmount(units(c.openInterest)),
          formatAmount(units(liquidityL)),
          String(c.lastOffset),
          0,
        ]);
      }
    }
    trades.forEach((t, i) => {
      tradeRows.push([
        `demo-${marketId}-${i + 1}`,
        String(marketId),
        t.kind,
        t.actor,
        t.side,
        formatAmount(units(t.amount)),
        formatAmount(units(t.kind === "buy" ? t.amount - t.fee : t.amount - t.fee)),
        formatAmount(units(t.shares)),
        null,
        formatAmount(units(t.fee)),
        formatAmount(units(t.priceBefore)),
        formatAmount(units(t.priceAfter)),
        null,
        null,
        JSON.stringify({ demo: true }),
        String(tradeOffsets[i]),
        0,
        `demo-update-${marketId}-${i + 1}`,
        null,
        new Date(t.atSec * 1000).toISOString(),
        new Date(t.atSec * 1000).toISOString(),
      ]);
    });
    marketRows.push([
      String(marketId),
      `demo-mk-${index + 1}`,
      admin,
      collateral.admin,
      collateral.id,
      spec.question,
      spec.rules,
      ticker,
      spec.event,
      spec.yes,
      spec.no,
      "demo:Truthoracle:PredictionMarket",
      formatAmount(units(oiYes)),
      formatAmount(units(oiNo)),
      String(startSec),
      String(expiresAt),
      86_400,
      true,
      0,
      formatAmount(units(300 * (1 - price) + 120)),
      formatAmount(units(300 * price + 120)),
      formatAmount(units(liquidityL)),
      formatAmount(units(liquidityL)),
      formatAmount(units(price)),
      30,
      2000,
      formatAmount(units(fees * 0.8)),
      formatAmount(units(fees * 0.2)),
      formatAmount(units(volume)),
      "Trading",
      null,
      null,
      null,
      JSON.stringify({
        operatorResolution: true,
        sources: ["https://example.com/demo"],
        sourceKeys: [],
        reporters: [],
        quorum: 0,
        challengeSecs: 0,
        bond: "0.0000000000",
      }),
      JSON.stringify([]),
      null,
      null,
      String(createdOffset),
      String(last ? tradeOffsets[trades.length - 1] : createdOffset),
      new Date(startSec * 1000).toISOString(),
      new Date((last ? last.atSec : startSec) * 1000).toISOString(),
      false,
      null,
      trades.length,
      last ? new Date(last.atSec * 1000).toISOString() : null,
    ]);
    metadataRows.push([ticker, spec.imageUrl, spec.description, null]);
  });
  await insertRows(
    q,
    "to_markets",
    [
      "market_id",
      "contract_id",
      "admin",
      "collateral_admin",
      "collateral_id",
      "question",
      "resolution_description",
      "ticker",
      "event_ticker",
      "yes_sub_title",
      "no_sub_title",
      "template_id",
      "open_interest_yes",
      "open_interest_no",
      "created_at_sec",
      "expires_at_sec",
      "grace_period_secs",
      "is_dynamic",
      "liquidity_period_secs",
      "reserve_yes",
      "reserve_no",
      "liquidity_l",
      "lp_token_supply",
      "current_price",
      "fee_bps",
      "prize_fee_share_bps",
      "accumulated_fees",
      "prize_pool",
      "total_volume",
      "status",
      "outcome",
      "resolved_at_sec",
      "proposal",
      "policy",
      "audit_observers",
      "created_event_blob",
      "synchronizer_id",
      "created_offset",
      "updated_offset",
      "created_at_ledger",
      "updated_at_ledger",
      "archived",
      "archived_offset",
      "trade_count",
      "last_trade_at",
    ],
    marketRows,
  );
  await insertRows(
    q,
    "to_market_metadata",
    ["ticker", "image_url", "description", "updated_by_user_id"],
    metadataRows,
  );
  await insertRows(
    q,
    "to_market_candles",
    [
      "market_id",
      "period_secs",
      "period_start",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "notional",
      "trades",
      "open_interest",
      "liquidity_l",
      "last_offset",
      "last_node_id",
    ],
    candleRows,
  );
  await insertRows(
    q,
    "to_market_events",
    [
      "event_id",
      "market_id",
      "kind",
      "actor",
      "side",
      "amount",
      "net",
      "shares",
      "shares_out",
      "fee",
      "price_before",
      "price_after",
      "lp_tokens",
      "outcome",
      "details",
      '"offset"',
      "node_id",
      "update_id",
      "command_id",
      "effective_at",
      "record_time",
    ],
    tradeRows,
  );
  return {
    series: SERIES.length,
    events: EVENTS.length,
    markets: marketRows.length,
    candles: candleRows.length,
    trades: tradeRows.length,
  };
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(__dirname, "..", "..", ".env"));
  } catch {
    // no .env: the environment must carry the configuration
  }
  const config = getConfiguration();
  if (config.appEnv !== "dev") {
    console.error(
      `seed:dev refuses to run with APP_ENV=${config.appEnv}: demo rows are for a developer's index only`,
    );
    return 2;
  }
  const clearOnly = process.argv.includes("--clear");
  const ds = new DataSource(
    buildDataSourceOptions({
      databaseUrl: config.databaseUrl,
      dbSsl: config.dbSsl,
      dbSslCa: config.dbSslCa,
    }),
  );
  await ds.initialize();
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const removed = await clearDemo(runner);
    console.log(`removed previous demo rows: ${JSON.stringify(removed)}`);
    if (!clearOnly) {
      const inserted = await seed(runner, config);
      console.log(`seeded: ${JSON.stringify(inserted)}`);
      const catalog = demoCatalog(Math.floor(Date.now() / 1000));
      console.log(
        "demo events: " +
          catalog.events
            .map(
              (e) =>
                `${e.ticker} (${e.title}, closes ${new Date(e.closesAtSec * 1000).toISOString()})`,
            )
            .join("; "),
      );
      console.log(
        "demo markets: " + catalog.markets.map((m) => `${m.event}-${m.suffix}`).join(", "),
      );
      console.log(
        `read them at GET /api/v1/events?withNestedMarkets=true&sort=trending and GET /api/v1/events/${catalog.events[1].ticker}/candlesticks`,
      );
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

// Runs only when executed (`npm run seed:dev`), never on import: the spec imports demoCatalog.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
