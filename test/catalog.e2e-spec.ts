/**
 * The market catalog (docs/MARKETS.md §2–§4; docs/API.md "Catalog", "Admin — catalog"): series →
 * events → markets, with the ledger fixing a market's identity when the contract carries it and the
 * operator filling what it left open; derived event status; the treasury-signed market factory.
 */
import { IndexerService } from "../src/services/indexer.service";
import type {
  ApiCreateMarketResult,
  ApiEvent,
  ApiMarket,
  ApiPage,
  ApiSeries,
} from "../src/types";
import { formatCC, parseCC } from "../src/util/money";
import { TEST_TREASURY, useTestApp } from "./helpers/app";
import { LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });
const [alice] = parties(1, "trader");
const dec = (v: string): string => formatCC(parseCC(v));

async function adminHeaders(): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, operator, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

async function seedCatalog(headers: Record<string, string>): Promise<void> {
  await ctx.agent
    .post("/api/v1/admin/series")
    .set(headers)
    .send({
      ticker: "fed",
      title: "Fed rate decisions",
      category: "Economics",
      frequency: "monthly",
      tags: ["rates", "macro"],
      settlementSources: [{ name: "FOMC statement", url: "https://www.federalreserve.gov" }],
      reason: "seed",
    })
    .expect(200);
  await ctx.agent
    .post("/api/v1/admin/events")
    .set(headers)
    .send({
      ticker: "FED-26MAR",
      seriesTicker: "FED",
      title: "Fed decision, March 2026",
      subTitle: "March meeting",
      mutuallyExclusive: true,
      strikeDate: "2026-03-18T18:00:00.000Z",
    })
    .expect(200);
}

describe("catalog", () => {
  it("creates series and events, normalises tickers, and derives the event status from its markets", async () => {
    const headers = await adminHeaders();
    await seedCatalog(headers);

    const series = bodyOf<ApiPage<ApiSeries>>(await ctx.agent.get("/api/v1/series").expect(200));
    expect(series.total).toBe(1);
    expect(series.items[0]).toMatchObject({
      ticker: "FED",
      title: "Fed rate decisions",
      category: "Economics",
      frequency: "monthly",
      tags: ["rates", "macro"],
      status: "active",
      eventCount: 1,
      marketCount: 0,
    });
    const empty = bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/fed-26mar").expect(200)).event;
    expect(empty).toMatchObject({
      ticker: "FED-26MAR",
      seriesTicker: "FED",
      category: "Economics",
      mutuallyExclusive: true,
      status: "unopened",
      marketCount: 0,
      closeTime: null,
      markets: [],
    });
    expect(empty.settlementSources).toEqual([{ name: "FOMC statement", url: "https://www.federalreserve.gov" }]);

    // Two on-ledger markets name the event; one older contract carries no catalog fields at all.
    const nowSec = Math.floor(Date.now() / 1000);
    const f = new LedgerFixture(TEST_TREASURY);
    const cut25 = f.createMarket({
      marketId: 1,
      question: "Cut of at least 25 bps?",
      ticker: "FED-26MAR-CUT25",
      eventTicker: "FED-26MAR",
      yesSubTitle: "Cut ≥ 25 bps",
      noSubTitle: "Smaller or none",
      createdAt: nowSec - 600,
      expiresAt: nowSec + 86_400,
    });
    f.createMarket({
      marketId: 2,
      question: "Cut of at least 50 bps?",
      ticker: "FED-26MAR-CUT50",
      eventTicker: "FED-26MAR",
      createdAt: nowSec - 600,
      expiresAt: nowSec + 2 * 86_400,
    });
    f.createMarket({ marketId: 3, question: "Legacy market?" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();

    const event = bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200)).event;
    expect(event).toMatchObject({ status: "open", marketCount: 2 });
    expect(event.closeTime).toBe(new Date((nowSec + 2 * 86_400) * 1000).toISOString());
    expect(event.markets?.map((m) => [m.ticker, m.tickerSource, m.eventTickerSource, m.yesSubTitle, m.seriesTicker])).toEqual([
      ["FED-26MAR-CUT25", "ledger", "ledger", "Cut ≥ 25 bps", "FED"],
      ["FED-26MAR-CUT50", "ledger", "ledger", "", "FED"],
    ]);
    expect(event.markets?.[0].contractId).toBe(cut25.market.cid);

    const legacy = bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/3").expect(200)).market;
    expect(legacy).toMatchObject({ ticker: "MKT-3", tickerSource: "synthetic", eventTicker: null, seriesTicker: null });

    const bySeries = bodyOf<ApiPage<ApiMarket>>(await ctx.agent.get("/api/v1/markets?series=fed&sort=oldest").expect(200));
    expect(bySeries.items.map((m) => m.marketId)).toEqual([1, 2]);
    const nested = bodyOf<ApiPage<ApiEvent>>(await ctx.agent.get("/api/v1/events?withNestedMarkets=true&status=open").expect(200));
    expect(nested.items).toHaveLength(1);
    expect(nested.items[0].markets).toHaveLength(2);
    expect(bodyOf<ApiPage<ApiEvent>>(await ctx.agent.get("/api/v1/events?status=settled").expect(200)).total).toBe(0);
    expect(bodyOf<ApiPage<ApiEvent>>(await ctx.agent.get("/api/v1/events?category=economics").expect(200)).total).toBe(1);
    const detail = bodyOf<{ series: ApiSeries; events: ApiEvent[] }>(await ctx.agent.get("/api/v1/series/FED").expect(200));
    expect(detail.series.marketCount).toBe(2);
    expect(detail.events.map((e) => e.ticker)).toEqual(["FED-26MAR"]);
    expect(detail.events[0].markets).toBeUndefined();

    // Settling both markets settles the event.
    const settled1 = f.resolveT0(cut25.market, "Yes", nowSec + 90_000);
    ctx.stream.push(settled1.tx);
    await ctx.get(IndexerService).runOnce();
    expect(bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200)).event.status).toBe("open");
    await ctx.agent.get("/api/v1/series/NOPE").expect(404);
    await ctx.agent.get("/api/v1/events/NOPE").expect(404);
    await ctx.agent.get("/api/v1/events?status=bogus").expect(400);
  });

  it("refuses duplicates and dangling references; validates tickers", async () => {
    const headers = await adminHeaders();
    await seedCatalog(headers);
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent.post("/api/v1/admin/series").set(headers).send({ ticker: "FED", title: "again" }).expect(409),
      ).error,
    ).toBe("catalog_conflict");
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent.post("/api/v1/admin/events").set(headers).send({ ticker: "X-1", seriesTicker: "NOPE", title: "x" }).expect(404),
      ).error,
    ).toBe("not_found");
    await ctx.agent.post("/api/v1/admin/series").set(headers).send({ ticker: "bad ticker!", title: "x" }).expect(400);
    await ctx.agent.post("/api/v1/admin/series").set(headers).send({ ticker: "MKT-7", title: "reserved" }).expect(400);
    await ctx.agent.post("/api/v1/admin/series").set(headers).send({ ticker: "OK-1", title: "x", frequency: "hourly" }).expect(400);
    await ctx.agent.post("/api/v1/admin/series").set(headers).send({ ticker: "OK-1", title: "x", nope: 1 }).expect(400);

    const updated = bodyOf<{ series: ApiSeries }>(
      await ctx.agent.patch("/api/v1/admin/series/fed").set(headers).send({ status: "archived", tags: ["macro"], reason: "retire" }).expect(200),
    ).series;
    expect(updated).toMatchObject({ status: "archived", tags: ["macro"] });
    expect(bodyOf<ApiPage<ApiSeries>>(await ctx.agent.get("/api/v1/series").expect(200)).total).toBe(0);
    expect(bodyOf<ApiPage<ApiSeries>>(await ctx.agent.get("/api/v1/series?status=all").expect(200)).total).toBe(1);

    const archived = bodyOf<{ event: ApiEvent }>(
      await ctx.agent.patch("/api/v1/admin/events/FED-26MAR").set(headers).send({ archived: true, title: "renamed" }).expect(200),
    ).event;
    expect(archived).toMatchObject({ archived: true, title: "renamed" });
    expect(bodyOf<ApiPage<ApiEvent>>(await ctx.agent.get("/api/v1/events").expect(200)).total).toBe(0);
    expect(bodyOf<ApiPage<ApiEvent>>(await ctx.agent.get("/api/v1/events?includeArchived=true").expect(200)).total).toBe(1);

    const audit = await ctx.dataSource.query<{ action: string; subject_id: string }[]>(
      `SELECT action, subject_id FROM to_audit_events WHERE action LIKE 'catalog.%' ORDER BY id`,
    );
    expect(audit.map((a) => `${a.action}:${a.subject_id}`)).toEqual([
      "catalog.series_created:FED",
      "catalog.event_created:FED-26MAR",
      "catalog.series_updated:FED",
      "catalog.event_updated:FED-26MAR",
    ]);

    // Sessions: anonymous and user sessions are refused on the admin routes.
    await ctx.agent.post("/api/v1/admin/series").set(ctx.csrf).send({ ticker: "A-1", title: "x" }).expect(401);
    const user = await issueSessionDirect(ctx, { ...makeTestWallet("u"), partyId: alice });
    await ctx.agent.post("/api/v1/admin/series").set({ Cookie: user.cookie, ...ctx.csrf }).send({ ticker: "A-1", title: "x" }).expect(403);
  });

  it("an operator fills what the ledger left open on a market, never what it fixed", async () => {
    const headers = await adminHeaders();
    await seedCatalog(headers);
    const f = new LedgerFixture(TEST_TREASURY);
    f.createMarket({ marketId: 1, question: "Legacy?" });
    f.createMarket({ marketId: 2, question: "Fixed?", ticker: "FED-26MAR-HOLD", eventTicker: "FED-26MAR", yesSubTitle: "Hold", noSubTitle: "Move" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();

    const assigned = bodyOf<{ market: ApiMarket }>(
      await ctx.agent
        .patch("/api/v1/admin/markets/1/catalog")
        .set(headers)
        .send({ eventTicker: "fed-26mar", ticker: "fed-26mar-legacy", yesSubTitle: "Yes!", noSubTitle: "No!", reason: "backfill" })
        .expect(200),
    ).market;
    expect(assigned).toMatchObject({
      ticker: "FED-26MAR-LEGACY",
      tickerSource: "catalog",
      eventTicker: "FED-26MAR",
      eventTickerSource: "catalog",
      seriesTicker: "FED",
      yesSubTitle: "Yes!",
      noSubTitle: "No!",
    });
    expect(bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200)).event.marketCount).toBe(2);
    expect(bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/FED-26MAR-LEGACY").expect(200)).market.marketId).toBe(1);

    // The ledger-fixed market refuses every field it carries.
    for (const body of [{ ticker: "OTHER-1" }, { eventTicker: null }, { yesSubTitle: "x" }]) {
      expect(
        bodyOf<{ error: string }>(await ctx.agent.patch("/api/v1/admin/markets/2/catalog").set(headers).send(body).expect(409)).error,
      ).toBe("ledger_value_fixed");
    }
    // A catalog ticker cannot collide with another market's, nor point at an unknown event.
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent.patch("/api/v1/admin/markets/1/catalog").set(headers).send({ ticker: "FED-26MAR-HOLD" }).expect(409),
      ).error,
    ).toBe("catalog_conflict");
    await ctx.agent.patch("/api/v1/admin/markets/1/catalog").set(headers).send({ eventTicker: "NOPE-1" }).expect(404);
    await ctx.agent.patch("/api/v1/admin/markets/1/catalog").set(headers).send({ ticker: "MKT-9" }).expect(400);
    await ctx.agent.patch("/api/v1/admin/markets/99/catalog").set(headers).send({ ticker: "A-1" }).expect(404);

    // A later ledger version of the legacy market keeps the catalog assignment (nothing on-ledger overrides it) …
    const w = f.createWallet(alice);
    const d = f.deposit(w.wallet, "10", "r");
    const legacyState = { cid: f.txs[0].events.find((e) => e.kind === "created" && e.entity === "PredictionMarket")!.contractId, payload: f.marketPayload({ marketId: 1, question: "Legacy?" }) };
    const b = f.buy({ market: legacyState, wallet: d.wallet, buyer: alice, side: "Yes", collateralCC: "1", sharesOut: "1.5" });
    ctx.stream.push(w.tx, d.tx, b.tx);
    await ctx.get(IndexerService).runOnce();
    const after = bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/1").expect(200)).market;
    expect(after).toMatchObject({ ticker: "FED-26MAR-LEGACY", eventTicker: "FED-26MAR", yesSubTitle: "Yes!", contractId: b.market.cid });
    // … while detaching is allowed for a catalog-assigned event.
    const detached = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.patch("/api/v1/admin/markets/1/catalog").set(headers).send({ eventTicker: null }).expect(200),
    ).market;
    expect(detached).toMatchObject({ eventTicker: null, eventTickerSource: null, seriesTicker: null });
  });

  it("an on-ledger ticker that collides with another market is logged and the synthetic one kept", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    f.createMarket({ marketId: 1, ticker: "DUP-1" });
    f.createMarket({ marketId: 2, ticker: "DUP-1" });
    f.createMarket({ marketId: 3, ticker: "bad ticker" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();
    const page = bodyOf<ApiPage<ApiMarket>>(await ctx.agent.get("/api/v1/markets?sort=oldest").expect(200));
    expect(page.items.map((m) => [m.marketId, m.ticker, m.tickerSource])).toEqual([
      [1, "DUP-1", "ledger"],
      [2, "MKT-2", "synthetic"],
      [3, "MKT-3", "synthetic"],
    ]);
  });

  it("creates a market on-ledger through the treasury for an event, with a deterministic command id", async () => {
    const headers = await adminHeaders();
    await seedCatalog(headers);
    // The MarketCounter must be indexed first.
    const early = await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({ eventTicker: "FED-26MAR", ticker: "FED-26MAR-CUT25", question: "Cut?", expiresAt: "2026-12-01T00:00:00.000Z", initialProbability: "0.35", initialValueCC: "200" })
      .expect(503);
    expect(bodyOf<{ error: string }>(early).error).toBe("not_ready");

    const f = new LedgerFixture(TEST_TREASURY);
    const created = f.createMarket({ marketId: 1, ticker: "FED-26MAR-HOLD", eventTicker: "FED-26MAR" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();

    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = bodyOf<ApiCreateMarketResult>(
      await ctx.agent
        .post("/api/v1/admin/markets")
        .set(headers)
        .send({
          eventTicker: "fed-26mar",
          ticker: "fed-26mar-cut25",
          question: "Cut of at least 25 bps?",
          yesSubTitle: "Cut ≥ 25 bps",
          noSubTitle: "Smaller or none",
          expiresAt,
          initialProbability: "0.35",
          initialValueCC: "200",
          feeBps: 100,
          reason: "March meeting",
        })
        .expect(200),
    );
    expect(res).toMatchObject({ ticker: "FED-26MAR-CUT25", eventTicker: "FED-26MAR", expectedMarketId: 2, status: "completed" });
    expect(res.commandId).toMatch(/^create-market-[0-9a-f]{40}$/);
    expect(ctx.wallet.submits).toHaveLength(1);
    const submitted = ctx.wallet.submits[0].commands[0] as {
      ExerciseCommand: { templateId: string; contractId: string; choice: string; choiceArgument: Record<string, unknown> };
    };
    expect(submitted.ExerciseCommand).toMatchObject({
      templateId: "fakepkg:Truthoracle:MarketCounter",
      contractId: created.counterCid,
      choice: "CreateMarket",
    });
    expect(submitted.ExerciseCommand.choiceArgument).toMatchObject({
      question: "Cut of at least 25 bps?",
      category: "Economics",
      initialProbability: dec("0.35"),
      initialValueCC: dec("200"),
      feeBps: "100",
      prizeFeeShareBps: "0",
      isDynamic: false,
      liquidityPeriodSecs: "0",
      gracePeriodSecs: "86400",
      ticker: "FED-26MAR-CUT25",
      eventTicker: "FED-26MAR",
      yesSubTitle: "Cut ≥ 25 bps",
      noSubTitle: "Smaller or none",
    });
    expect(submitted.ExerciseCommand.choiceArgument.expiresAt).toBe(String(Math.floor(Date.parse(expiresAt) / 1000)));
    expect((submitted.ExerciseCommand.choiceArgument.policy as { operatorResolution: boolean }).operatorResolution).toBe(true);

    // Same ticker again: the deterministic command id collides on the wallet's command dedup.
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/admin/markets")
          .set(headers)
          .send({ eventTicker: "FED-26MAR", ticker: "FED-26MAR-CUT25", question: "Cut?", expiresAt, initialProbability: "0.35", initialValueCC: "200" })
          .expect(502),
      ).error,
    ).toBe("upstream_failed");
    // A ticker the index already knows is refused before anything is submitted.
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/admin/markets")
          .set(headers)
          .send({ eventTicker: "FED-26MAR", ticker: "FED-26MAR-HOLD", question: "Hold?", expiresAt, initialProbability: "0.5", initialValueCC: "100" })
          .expect(409),
      ).error,
    ).toBe("catalog_conflict");
    await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({ eventTicker: "NOPE", ticker: "N-1", question: "x", expiresAt, initialProbability: "0.5", initialValueCC: "100" })
      .expect(404);
    await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({ eventTicker: "FED-26MAR", ticker: "N-1", question: "x", expiresAt, initialProbability: "0.999", initialValueCC: "100" })
      .expect(400);
    await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({ eventTicker: "FED-26MAR", ticker: "N-1", question: "x", expiresAt: "2020-01-01T00:00:00.000Z", initialProbability: "0.5", initialValueCC: "100" })
      .expect(400);
    expect(ctx.wallet.submits).toHaveLength(1);

    const audit = await ctx.dataSource.query<{ action: string; metadata: { commandId: string; expectedMarketId: number } }[]>(
      `SELECT action, metadata FROM to_audit_events WHERE action = 'market.create_submitted'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ commandId: res.commandId, expectedMarketId: 2 });
  });
});
