/**
 * The ledger indexer and its read API (docs/INDEXER.md, docs/API.md "Markets" / "Portfolio" /
 * "In-app wallet ledger" / "Ledger" / "Admin — ledger") against real Postgres + Redis, with the
 * participant replaced by FakeLedgerStream and the transactions built by LedgerFixture from the
 * Daml choices.
 */
import { INDEXER_STATE_KEY, IndexerStateEntity } from "../src/entities/indexer-state.entity";
import { LedgerEventEntity } from "../src/entities/ledger-event.entity";
import { MarketEventEntity } from "../src/entities/market-event.entity";
import { PositionEntity } from "../src/entities/position.entity";
import { IndexerService } from "../src/services/indexer.service";
import {
  NatsSubjects,
  type ApiLedgerStatus,
  type ApiMarket,
  type ApiMarketEvent,
  type ApiPage,
  type ApiPosition,
  type ApiStats,
  type ApiWalletEntry,
} from "../src/types";
import { formatCC, parseCC } from "../src/util/money";
import { TEST_TREASURY, useTestApp } from "./helpers/app";
import { LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });

const [alice, bob] = parties(2, "trader");
const dec = (v: string): string => formatCC(parseCC(v));

/** Boots a fixture ledger with one market, Alice's funded wallet and one Buy, fully indexed. */
async function seedTradedMarket(): Promise<{
  f: LedgerFixture;
  market: ReturnType<LedgerFixture["createMarket"]>["market"];
  wallet: ReturnType<LedgerFixture["deposit"]>["wallet"];
  position: ReturnType<LedgerFixture["buy"]>["position"];
}> {
  const f = new LedgerFixture(TEST_TREASURY);
  const created = f.createMarket({
    marketId: 1,
    question: "Will CC trade above $1 by June?",
    price: "0.5",
  });
  const w0 = f.createWallet(alice);
  const d = f.deposit(w0.wallet, "100", "tx-ref-1");
  const b = f.buy({
    market: created.market,
    wallet: d.wallet,
    buyer: alice,
    side: "Yes",
    collateralCC: "10",
    sharesOut: "18",
  });
  ctx.stream.push(...f.txs);
  const indexer = ctx.get(IndexerService);
  await indexer.runOnce();
  await indexer.runOnce();
  return { f, market: b.market, wallet: b.wallet, position: b.position };
}

describe("indexer loop", () => {
  it("replays a never-pruned ledger from offset 0 and advances the cursor atomically with the rows", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    f.createMarket({ marketId: 1 });
    f.createWallet(alice);
    ctx.stream.push(...f.txs);
    const indexer = ctx.get(IndexerService);

    const first = await indexer.runOnce();
    expect(first.bootstrapped).toBe(true);
    expect(first.applied).toBe(2);
    expect(first.caughtUp).toBe(false);
    const second = await indexer.runOnce();
    expect(second.applied).toBe(0);
    expect(second.caughtUp).toBe(true);

    const status = bodyOf<ApiLedgerStatus>(
      await ctx.agent.get("/api/v1/ledger/status").expect(200),
    );
    expect(status).toMatchObject({
      enabled: false,
      bootstrapped: true,
      bootstrapOffset: 0,
      offset: 2,
      ledgerEnd: 2,
      lag: 0,
      lastUpdateId: "update-0002",
      gaps: [],
    });
    expect(ctx.stream.calls.filter((c) => c.startsWith("fetchActiveContracts"))).toEqual([]);
    expect(ctx.nats.publishedOn(NatsSubjects.marketUpdated)).toHaveLength(1);
    expect(ctx.nats.publishedOn(NatsSubjects.marketEvent("market_created"))).toHaveLength(1);
  });

  it("a replayed transaction is a no-op", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    const { tx } = f.createMarket({ marketId: 1 });
    const indexer = ctx.get(IndexerService);
    ctx.stream.push(tx);
    await indexer.runOnce();
    expect(await indexer.applyTransaction(tx)).toBe(false);
    expect(await ctx.dataSource.getRepository(LedgerEventEntity).count()).toBe(4);
    expect(await ctx.dataSource.getRepository(MarketEventEntity).count()).toBe(1);
  });

  it("bootstraps from an ACS snapshot at the prune point when the participant has pruned", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    const created = f.createMarket({ marketId: 7, price: "0.4" });
    const w = f.createWallet(bob);
    // The participant pruned everything so far; only the ACS survives.
    ctx.stream.pruned = f.offset;
    ctx.stream.acs = [
      f.acsEntry("PredictionMarket", created.market.cid, created.market.payload, { offset: 1 }),
      f.acsEntry("UserWallet", w.wallet.cid, w.wallet.payload, { offset: 2, observers: [bob] }),
    ];
    const later = f.deposit(w.wallet, "5", "ref-after-prune");
    ctx.stream.push(later.tx);
    const indexer = ctx.get(IndexerService);
    const run = await indexer.runOnce();
    expect(run.bootstrapped).toBe(true);
    expect(run.applied).toBe(1);
    expect(ctx.stream.calls).toContain(`fetchActiveContracts:${later.tx.offset - 1}`);

    const status = await indexer.status();
    expect(status.bootstrapOffset).toBe(later.tx.offset - 1);
    expect(status.offset).toBe(later.tx.offset);
    const market = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/7").expect(200),
    ).market;
    expect(market.currentPrice).toBe(dec("0.4"));
    expect(market.createdOffset).toBe(1);
    const history = bodyOf<ApiPage<ApiWalletEntry>>(
      await ctx.agent
        .get("/api/v1/in-app-wallet/history")
        .set(
          "Cookie",
          (await issueSessionDirect(ctx, { ...makeTestWallet("b"), partyId: bob })).cookie,
        )
        .expect(200),
    );
    expect(history.items.map((e) => e.kind)).toEqual(["deposit"]);
    expect(history.items[0].balanceAfter).toBe(dec("5"));
  });

  it("resyncs from the ACS and records a gap when the cursor falls behind the prune point", async () => {
    const { f, market, wallet, position } = await seedTradedMarket();
    const indexer = ctx.get(IndexerService);
    // Alice sells everything while the indexer is down, then the participant prunes past that.
    const sold = f.sell({
      market,
      wallet,
      position,
      seller: alice,
      side: "Yes",
      sharesIn: "18",
      grossCC: "9",
    });
    ctx.stream.push(sold.tx);
    ctx.stream.pruned = sold.tx.offset;
    ctx.stream.acs = [
      f.acsEntry("PredictionMarket", sold.market.cid, sold.market.payload, {
        offset: sold.tx.offset,
      }),
      f.acsEntry("UserWallet", sold.wallet.cid, sold.wallet.payload, {
        offset: sold.tx.offset,
        observers: [alice],
      }),
      f.acsEntry("Position", sold.position.cid, sold.position.payload, {
        offset: sold.tx.offset,
        observers: [TEST_TREASURY],
      }),
    ];
    const run = await indexer.runOnce();
    expect(run.resynced).toBe(true);
    const status = await indexer.status();
    expect(status.offset).toBe(sold.tx.offset);
    expect(status.gaps).toHaveLength(1);
    expect(status.gaps[0]).toMatchObject({
      fromOffset: sold.tx.offset - 1,
      toOffset: sold.tx.offset,
    });
    expect(ctx.nats.publishedOn(NatsSubjects.indexerGap)).toHaveLength(1);

    // The old position / wallet / market versions are gone, the snapshot ones are active.
    const positions = await ctx.dataSource
      .getRepository(PositionEntity)
      .find({ order: { createdOffset: "ASC" } });
    expect(
      positions.map((p) => [p.contractId === sold.position.cid, p.active, p.archivedChoice]),
    ).toEqual([
      [false, false, "resync"],
      [true, true, null],
    ]);
    const m = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/1").expect(200),
    ).market;
    expect(m.contractId).toBe(sold.market.cid);
    expect(m.totalVolumeCC).toBe(dec("19"));
    // The Sell itself was never seen: no trade row for it, the gap says so.
    const trades = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent.get("/api/v1/markets/1/trades").expect(200),
    );
    expect(trades.items.map((t) => t.kind)).toEqual(["buy"]);
  });

  it("records the error and rethrows when the stream fails, then recovers", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    f.createMarket({ marketId: 1 });
    ctx.stream.push(...f.txs);
    ctx.stream.failNext = new Error("participant unreachable");
    const indexer = ctx.get(IndexerService);
    await expect(indexer.runOnce()).rejects.toThrow("participant unreachable");
    expect((await indexer.status()).lastError).toContain("participant unreachable");
    await indexer.runOnce();
    expect((await indexer.status()).lastError).toBeNull();
    expect((await indexer.status()).offset).toBe(1);
  });

  it("GET /ledger/wait resolves when the offset is reached and times out otherwise", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    f.createMarket({ marketId: 1 });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();
    expect(
      bodyOf<{ reached: boolean; offset: number }>(
        await ctx.agent.get("/api/v1/ledger/wait?offset=1&timeoutMs=100").expect(200),
      ),
    ).toMatchObject({ reached: true, offset: 1 });
    expect(
      bodyOf<{ reached: boolean; offset: number }>(
        await ctx.agent.get("/api/v1/ledger/wait?offset=50&timeoutMs=100").expect(200),
      ),
    ).toMatchObject({ reached: false, offset: 1, requested: 50 });
    await ctx.agent.get("/api/v1/ledger/wait").expect(400);
    await ctx.agent.get("/api/v1/ledger/wait?offset=1&timeoutMs=999999").expect(400);
  });
});

describe("markets", () => {
  it("lists and details markets from the index, with the offset header and the blob only on detail", async () => {
    const { market } = await seedTradedMarket();
    const res = await ctx.agent.get("/api/v1/markets").expect(200);
    expect(res.headers["x-ledger-offset"]).toBe("4");
    const page = bodyOf<ApiPage<ApiMarket>>(res);
    expect(page.total).toBe(1);
    const m = page.items[0];
    expect(m).toMatchObject({
      marketId: 1,
      contractId: market.cid,
      question: "Will CC trade above $1 by June?",
      category: "crypto",
      status: "Trading",
      phase: "expired",
      feeBps: 100,
      tradeCount: 1,
      archived: false,
      createdOffset: 1,
      updatedOffset: 4,
      synchronizerId: "sync::test",
    });
    expect(m.currentPrice).toBe(dec("0.55"));
    expect(m.totalVolumeCC).toBe(dec("10"));
    expect(m.accumulatedFeesCC).toBe(dec("0.09"));
    expect(m.prizePoolCC).toBe(dec("0.01"));
    expect(m.policy).toMatchObject({
      operatorResolution: true,
      sources: ["https://source.test/price"],
      quorum: 0,
    });
    expect(m.createdEventBlob).toBeUndefined();
    expect(m.lastTradeAt).not.toBeNull();

    const detail = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/1").expect(200),
    ).market;
    expect(detail.createdEventBlob).toBe(`blob-${market.cid}`);
    expect(
      bodyOf<{ category: string; markets: number }[]>(
        await ctx.agent.get("/api/v1/markets/categories").expect(200),
      ),
    ).toEqual([{ category: "crypto", markets: 1 }]);
  });

  it("filters, searches, sorts and validates the list query", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    const a = f.createMarket({ marketId: 1, question: "Rain tomorrow?", category: "weather" });
    f.createMarket({ marketId: 2, question: "ETH above 5k?", category: "crypto" });
    f.resolveT0(a.market, "Yes");
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();

    expect(
      bodyOf<ApiPage<ApiMarket>>(
        await ctx.agent.get("/api/v1/markets?status=settled").expect(200),
      ).items.map((m) => m.marketId),
    ).toEqual([1]);
    expect(
      bodyOf<ApiPage<ApiMarket>>(
        await ctx.agent.get("/api/v1/markets?status=active").expect(200),
      ).items.map((m) => m.marketId),
    ).toEqual([2]);
    expect(
      bodyOf<ApiPage<ApiMarket>>(
        await ctx.agent.get("/api/v1/markets?q=eth").expect(200),
      ).items.map((m) => m.marketId),
    ).toEqual([2]);
    expect(
      bodyOf<ApiPage<ApiMarket>>(
        await ctx.agent.get("/api/v1/markets?category=weather").expect(200),
      ).items.map((m) => m.marketId),
    ).toEqual([1]);
    expect(
      bodyOf<ApiPage<ApiMarket>>(
        await ctx.agent.get("/api/v1/markets?sort=oldest").expect(200),
      ).items.map((m) => m.marketId),
    ).toEqual([1, 2]);
    expect(
      bodyOf<ApiPage<ApiMarket>>(
        await ctx.agent.get("/api/v1/markets?page=2&limit=1&sort=oldest").expect(200),
      ).items.map((m) => m.marketId),
    ).toEqual([2]);
    const resolved = bodyOf<ApiPage<ApiMarket>>(
      await ctx.agent.get("/api/v1/markets?status=Resolved").expect(200),
    ).items[0];
    expect(resolved).toMatchObject({ status: "Resolved", outcome: "Yes", phase: "resolved" });
    expect(resolved.resolvedAt).toBe(new Date(1_760_700_000 * 1000).toISOString());

    expect(
      bodyOf<{ error: string }>(await ctx.agent.get("/api/v1/markets?status=bogus").expect(400))
        .error,
    ).toBe("validation_failed");
    expect(
      bodyOf<{ error: string }>(await ctx.agent.get("/api/v1/markets?nope=1").expect(400)).error,
    ).toBe("validation_failed");
    expect(
      bodyOf<{ error: string }>(await ctx.agent.get("/api/v1/markets/999").expect(404)).error,
    ).toBe("not_found");
    await ctx.agent.get("/api/v1/markets/abc").expect(400);
  });

  it("derives trades, activity and price history from the ledger effects", async () => {
    const { f, market, wallet, position } = await seedTradedMarket();
    const sold = f.sell({
      market,
      wallet,
      position,
      seller: alice,
      side: "Yes",
      sharesIn: "8",
      grossCC: "5",
    });
    ctx.stream.push(sold.tx);
    await ctx.get(IndexerService).runOnce();

    const trades = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent.get("/api/v1/markets/1/trades").expect(200),
    );
    expect(trades.total).toBe(2);
    const [sell, buy] = trades.items;
    expect(buy).toMatchObject({
      kind: "buy",
      actor: alice,
      side: "Yes",
      offset: 4,
      updateId: "update-0004",
    });
    expect(buy.amountCC).toBe(dec("10"));
    expect(buy.shares).toBe(dec("18"));
    expect(buy.feeCC).toBe(dec("0.1"));
    expect(buy.netCC).toBe(dec("9.9"));
    expect(buy.priceBefore).toBe(dec("0.5"));
    expect(buy.priceAfter).toBe(dec("0.55"));
    expect(buy.commandId).toMatch(/^buy-/);
    expect(sell).toMatchObject({ kind: "sell", actor: alice, side: "Yes", offset: 5 });
    expect(sell.shares).toBe(dec("8"));
    expect(sell.amountCC).toBe(dec("5"));
    expect(sell.feeCC).toBe(dec("0.05"));
    expect(sell.netCC).toBe(dec("4.95"));
    expect(sell.priceAfter).toBe(dec("0.52"));

    const activity = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent.get("/api/v1/markets/1/activity").expect(200),
    );
    expect(activity.items.map((e) => e.kind)).toEqual(["sell", "buy", "market_created"]);
    expect(activity.items[2].details).toMatchObject({
      initialProbability: dec("0.5"),
      initialValueCC: dec("200"),
    });
    expect(
      bodyOf<ApiPage<ApiMarketEvent>>(
        await ctx.agent.get("/api/v1/markets/1/activity?kind=buy").expect(200),
      ).total,
    ).toBe(1);

    const history = bodyOf<{ points: { price: string; volumeCC: string; offset: number }[] }>(
      await ctx.agent.get("/api/v1/markets/1/price-history").expect(200),
    );
    expect(history.points.map((p) => [p.offset, p.price, p.volumeCC])).toEqual([
      [1, dec("0.5"), dec("0")],
      [4, dec("0.55"), dec("10")],
      [5, dec("0.52"), dec("15")],
    ]);
    const bucketed = bodyOf<{ points: { offset: number }[] }>(
      await ctx.agent.get("/api/v1/markets/1/price-history?resolution=1d").expect(200),
    );
    expect(bucketed.points.map((p) => p.offset)).toEqual([5]);
    const windowed = bodyOf<{ points: { offset: number }[] }>(
      await ctx.agent
        .get(
          `/api/v1/markets/1/price-history?from=${encodeURIComponent(sold.tx.effectiveAt.toISOString())}`,
        )
        .expect(200),
    );
    expect(windowed.points.map((p) => p.offset)).toEqual([5]);
    await ctx.agent.get("/api/v1/markets/1/price-history?resolution=2s").expect(400);

    const m = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/1").expect(200),
    ).market;
    expect(m.tradeCount).toBe(2);
    expect(m.contractId).toBe(sold.market.cid);
  });

  it("resolution, redemption and payouts flow through", async () => {
    const { f, market, wallet, position } = await seedTradedMarket();
    const resolved = f.resolveT0(market, "Yes");
    const redeemed = f.redeem({ market: resolved.market, wallet, position, holder: alice });
    const withdrawn = f.withdraw(redeemed.wallet, "20");
    const paid = f.markPaid(withdrawn.payoutCid, "0xabc");
    ctx.stream.push(resolved.tx, redeemed.tx, withdrawn.tx, paid);
    await ctx.get(IndexerService).runOnce();

    const activity = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent.get("/api/v1/markets/1/activity").expect(200),
    );
    expect(activity.items.map((e) => e.kind)).toEqual([
      "redeem",
      "resolve_t0",
      "buy",
      "market_created",
    ]);
    expect(activity.items[1]).toMatchObject({ outcome: "Yes", actor: TEST_TREASURY });
    expect(activity.items[1].details).toMatchObject({ sourceUri: "https://source.test/price" });
    expect(activity.items[0]).toMatchObject({ kind: "redeem", actor: alice, outcome: "Yes" });
    expect(activity.items[0].amountCC).toBe(dec("18"));
    expect(activity.items[0].details).toMatchObject({ reason: "resolve", yesShares: dec("18") });

    const { cookie } = await issueSessionDirect(ctx, { ...makeTestWallet("a"), partyId: alice });
    const positions = bodyOf<{ positions: ApiPosition[] }>(
      await ctx.agent.get("/api/v1/me/positions?status=all").set("Cookie", cookie).expect(200),
    ).positions;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ active: false, holder: alice, marketId: 1 });
    expect(positions[0].market).toMatchObject({ status: "Resolved", outcome: "Yes" });
    expect(
      bodyOf<{ positions: ApiPosition[] }>(
        await ctx.agent.get("/api/v1/me/positions").set("Cookie", cookie).expect(200),
      ).positions,
    ).toEqual([]);

    const ledger = bodyOf<{
      wallet: { balanceCC: string; withdrawnCC: string } | null;
      payouts: {
        contractId: string;
        active: boolean;
        settledKind: string | null;
        txHash: string | null;
        reason: string;
      }[];
    }>(await ctx.agent.get("/api/v1/in-app-wallet/ledger").set("Cookie", cookie).expect(200));
    expect(ledger.wallet?.balanceCC).toBe(dec("88"));
    expect(ledger.wallet?.withdrawnCC).toBe(dec("20"));
    expect(ledger.payouts).toHaveLength(1);
    expect(ledger.payouts[0]).toMatchObject({
      contractId: withdrawn.payoutCid,
      active: false,
      settledKind: "mark_paid",
      txHash: "0xabc",
      reason: "withdraw",
    });
    expect(ledger.payouts[0]).toHaveProperty("amountCC", dec("20"));

    const history = bodyOf<ApiPage<ApiWalletEntry>>(
      await ctx.agent.get("/api/v1/in-app-wallet/history").set("Cookie", cookie).expect(200),
    );
    expect(
      history.items.map((e) => [e.kind, e.amountCC, e.reason, e.marketId, e.rootChoice]),
    ).toEqual([
      ["withdraw", dec("20"), "withdraw", null, null],
      ["credit", dec("18"), "resolve", 1, "RedeemPosition"],
      ["debit", dec("10"), "buy", 1, "Buy"],
      ["deposit", dec("100"), null, null, null],
    ]);
    expect(history.items[3].txRef).toBe("tx-ref-1");
    expect(history.items[3].balanceAfter).toBe(dec("100"));
    expect(
      bodyOf<ApiPage<ApiWalletEntry>>(
        await ctx.agent
          .get("/api/v1/in-app-wallet/history?kind=debit")
          .set("Cookie", cookie)
          .expect(200),
      ).total,
    ).toBe(1);
    expect(
      ctx.nats
        .publishedOn(NatsSubjects.ledgerPayoutChanged)
        .map((p) => (p.payload as { change: string }).change),
    ).toEqual(["created", "settled"]);
  });
});

describe("portfolio and aggregates", () => {
  it("positions carry mark-to-market value; trades and activity are per party", async () => {
    const { f, market, wallet, position } = await seedTradedMarket();
    const w0 = f.createWallet(bob);
    const bobDeposit = f.deposit(w0.wallet, "50", "bob-ref");
    const bobBuy = f.buy({
      market,
      wallet: bobDeposit.wallet,
      buyer: bob,
      side: "No",
      collateralCC: "4",
      sharesOut: "7",
      newPrice: "0.5",
    });
    // Alice adds to her position (existing position archived, successor created).
    const aliceBuy = f.buy({
      market: bobBuy.market,
      wallet,
      position,
      buyer: alice,
      side: "Yes",
      collateralCC: "2",
      sharesOut: "3",
      newPrice: "0.6",
    });
    ctx.stream.push(bobDeposit.tx, w0.tx, bobBuy.tx, aliceBuy.tx);
    await ctx.get(IndexerService).runOnce();

    const { cookie } = await issueSessionDirect(ctx, { ...makeTestWallet("a"), partyId: alice });
    const mine = bodyOf<{ parties: string[]; positions: ApiPosition[] }>(
      await ctx.agent.get("/api/v1/me/positions").set("Cookie", cookie).expect(200),
    );
    expect(mine.parties).toEqual([alice]);
    expect(mine.positions).toHaveLength(1);
    expect(mine.positions[0].yesShares).toBe(dec("21"));
    expect(mine.positions[0].costBasisCC).toBe(dec("12"));
    expect(mine.positions[0].valueCC).toBe(dec("12.6")); // 21 × 0.6
    expect(mine.positions[0].redeemableCC).toBeNull();
    expect(mine.positions[0].market?.currentPrice).toBe(dec("0.6"));
    const all = bodyOf<{ positions: ApiPosition[] }>(
      await ctx.agent.get("/api/v1/me/positions?status=all").set("Cookie", cookie).expect(200),
    ).positions;
    expect(all.map((p) => p.active)).toEqual([true, false]);

    const trades = bodyOf<ApiPage<ApiMarketEvent>>(
      await ctx.agent.get("/api/v1/me/trades").set("Cookie", cookie).expect(200),
    );
    expect(trades.items.map((t) => [t.actor, t.amountCC])).toEqual([
      [alice, dec("2")],
      [alice, dec("10")],
    ]);
    expect(trades.items[0].shares).toBe(dec("3"));
    expect(
      bodyOf<ApiPage<ApiMarketEvent>>(
        await ctx.agent.get("/api/v1/me/trades?marketId=2").set("Cookie", cookie).expect(200),
      ).total,
    ).toBe(0);
    const bobCookie = (await issueSessionDirect(ctx, { ...makeTestWallet("b"), partyId: bob }))
      .cookie;
    expect(
      bodyOf<ApiPage<ApiMarketEvent>>(
        await ctx.agent.get("/api/v1/me/activity").set("Cookie", bobCookie).expect(200),
      ).items.map((t) => t.side),
    ).toEqual(["No"]);

    const stats = bodyOf<ApiStats>(await ctx.agent.get("/api/v1/stats").expect(200));
    expect(stats).toMatchObject({
      markets: { total: 1, trading: 1, proposed: 0, resolved: 0, voided: 0 },
      trades: 3,
      traders: 2,
      indexedOffset: 8,
    });
    expect(stats.totalVolumeCC).toBe(dec("16"));

    const board = bodyOf<{
      window: string;
      entries: { party: string; volumeCC: string; trades: number; realizedPnlCC: string }[];
    }>(await ctx.agent.get("/api/v1/leaderboard?window=all").expect(200));
    expect(board.entries.map((e) => [e.party, e.volumeCC, e.trades, e.realizedPnlCC])).toEqual([
      [alice, dec("12"), 2, dec("-12")],
      [bob, dec("4"), 1, dec("-4")],
    ]);
    await ctx.agent.get("/api/v1/leaderboard?window=1y").expect(400);
  });

  it("portfolio routes need a user session; an admin session is refused", async () => {
    await ctx.agent.get("/api/v1/me/positions").expect(401);
    const { cookie } = await issueSessionDirect(ctx, operator, { kind: "admin" });
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent.get("/api/v1/me/positions").set("Cookie", cookie).expect(403),
      ).error,
    ).toBe("forbidden");
  });

  it("transfers between the treasury and the account's wallets are listed", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    f.spliceTransferIn(alice, "25");
    f.spliceTransferOut(alice, "3");
    f.spliceTransferIn(bob, "1");
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();
    const { cookie } = await issueSessionDirect(ctx, { ...makeTestWallet("a"), partyId: alice });
    const page = bodyOf<
      ApiPage<{ direction: string; counterparty: string; amountCC: string; choice: string }>
    >(await ctx.agent.get("/api/v1/in-app-wallet/transfers").set("Cookie", cookie).expect(200));
    expect(page.items.map((t) => [t.direction, t.amountCC, t.choice])).toEqual([
      ["out", dec("3"), "AmuletRules_Transfer"],
      ["in", dec("25"), "TransferPreapproval_SendV2"],
    ]);
    expect(
      bodyOf<ApiPage<unknown>>(
        await ctx.agent
          .get("/api/v1/in-app-wallet/transfers?direction=in")
          .set("Cookie", cookie)
          .expect(200),
      ).total,
    ).toBe(1);
    expect(ctx.nats.publishedOn(NatsSubjects.transferSeen)).toHaveLength(3);
    // Nothing of the Splice package lands in the raw TruthOracle event log.
    expect(await ctx.dataSource.getRepository(LedgerEventEntity).count()).toBe(0);
  });
});

describe("admin ledger", () => {
  it("status, raw events, wallets, payouts, transfers, holders and an audited resync", async () => {
    const { f, market, wallet, position } = await seedTradedMarket();
    const withdrawn = f.withdraw(wallet, "1");
    ctx.stream.push(withdrawn.tx);
    await ctx.get(IndexerService).runOnce();
    const { cookie, user } = await issueSessionDirect(ctx, operator, { kind: "admin" });
    const headers = { Cookie: cookie, ...ctx.csrf };

    expect(
      bodyOf<ApiLedgerStatus>(
        await ctx.agent.get("/api/v1/admin/ledger/status").set(headers).expect(200),
      ).offset,
    ).toBe(5);

    const events = bodyOf<
      ApiPage<{
        template: string;
        choice: string | null;
        kind: string;
        parentNodeId: number | null;
      }>
    >(
      await ctx.agent
        .get("/api/v1/admin/ledger/events?updateId=update-0004")
        .set(headers)
        .expect(200),
    );
    expect(
      events.items.map((e) => `${e.kind}:${e.template}${e.choice ? `.${e.choice}` : ""}`),
    ).toEqual([
      "exercised:Truthoracle:PredictionMarket.Buy",
      "exercised:Truthoracle:UserWallet.Debit",
      "created:Truthoracle:UserWallet",
      "created:Truthoracle:Position",
      "created:Truthoracle:PredictionMarket",
    ]);
    expect(events.items[1].parentNodeId).toBe(0);
    expect(
      bodyOf<ApiPage<unknown>>(
        await ctx.agent
          .get("/api/v1/admin/ledger/events?entity=PredictionMarket&choice=Buy")
          .set(headers)
          .expect(200),
      ).total,
    ).toBe(1);
    expect(
      bodyOf<ApiPage<unknown>>(
        await ctx.agent
          .get("/api/v1/admin/ledger/events?marketId=1&entity=PredictionMarket")
          .set(headers)
          .expect(200),
      ).total,
    ).toBe(2);

    const wallets = bodyOf<ApiPage<{ owner: string; balanceCC: string }>>(
      await ctx.agent.get("/api/v1/admin/ledger/wallets").set(headers).expect(200),
    );
    expect(wallets.items).toEqual([
      expect.objectContaining({ owner: alice, balanceCC: dec("89") }),
    ]);
    const payouts = bodyOf<ApiPage<{ contractId: string; active: boolean }>>(
      await ctx.agent.get("/api/v1/admin/ledger/payouts?active=true").set(headers).expect(200),
    );
    expect(payouts.items).toEqual([
      expect.objectContaining({ contractId: withdrawn.payoutCid, active: true }),
    ]);
    expect(
      bodyOf<ApiPage<unknown>>(
        await ctx.agent.get("/api/v1/admin/ledger/transfers").set(headers).expect(200),
      ).total,
    ).toBe(0);
    const holders = bodyOf<ApiPage<ApiPosition>>(
      await ctx.agent.get("/api/v1/admin/ledger/markets/1/positions").set(headers).expect(200),
    );
    expect(holders.items.map((h) => [h.holder, h.contractId])).toEqual([[alice, position.cid]]);
    expect(
      bodyOf<ApiPage<{ provider: string; poolShare: string | null }>>(
        await ctx.agent.get("/api/v1/admin/ledger/markets/1/liquidity").set(headers).expect(200),
      ).items[0],
    ).toMatchObject({ provider: TEST_TREASURY, poolShare: dec("1") });

    // Resync at the ledger end: the snapshot only lists the current versions → nothing changes, no gap (cursor was at the end).
    ctx.stream.acs = [
      f.acsEntry("PredictionMarket", market.cid, market.payload),
      f.acsEntry("UserWallet", withdrawn.wallet.cid, withdrawn.wallet.payload, {
        observers: [alice],
      }),
      f.acsEntry("Position", position.cid, position.payload),
      f.acsEntry("PendingPayout", withdrawn.payoutCid, {
        admin: TEST_TREASURY,
        user: alice,
        marketId: "0",
        amountCC: dec("1"),
        reason: "withdraw",
        createdAt: "1760000500",
      }),
    ];
    const resynced = bodyOf<{ status: ApiLedgerStatus }>(
      await ctx.agent
        .post("/api/v1/admin/ledger/resync")
        .set(headers)
        .send({ reason: "operator check" })
        .expect(200),
    ).status;
    expect(resynced.gaps).toEqual([]);
    expect(resynced.offset).toBe(5);
    const audit = await ctx.dataSource.query<
      { action: string; actor_user_id: string; metadata: { reason: string } }[]
    >(`SELECT action, actor_user_id, metadata FROM to_audit_events WHERE action = 'ledger.resync'`);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(user.id);
    expect(audit[0].metadata.reason).toBe("operator check");
    await ctx.agent.post("/api/v1/admin/ledger/resync").set(headers).send({}).expect(400);
    expect(
      await ctx.dataSource.getRepository(PositionEntity).count({ where: { active: true } }),
    ).toBe(1);

    // A user session is refused everywhere under /admin.
    const userCookie = (await issueSessionDirect(ctx, { ...makeTestWallet("u"), partyId: bob }))
      .cookie;
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent.get("/api/v1/admin/ledger/status").set("Cookie", userCookie).expect(403),
      ).error,
    ).toBe("forbidden");
    await ctx.agent.get("/api/v1/admin/ledger/status").expect(401);
  });

  it("the indexer state row survives resets of the other tables only through re-creation", async () => {
    const indexer = ctx.get(IndexerService);
    const state = await indexer.state();
    expect(state.key).toBe(INDEXER_STATE_KEY);
    expect(state.offset).toBe(0);
    expect(await ctx.dataSource.getRepository(IndexerStateEntity).count()).toBe(1);
  });
});
