/**
 * The market catalog (docs/MARKETS.md §2–§4; docs/API.md "Catalog", "Admin — catalog"): series →
 * events → markets, a market's identity being the contract's own (placeholder catalog rows when
 * the operator has not written the event yet); derived event status; the treasury-signed market
 * factory with its identity validation.
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

    // Two on-ledger markets name the event.
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
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();

    const event = bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200)).event;
    expect(event).toMatchObject({ status: "open", marketCount: 2 });
    expect(event.closeTime).toBe(new Date((nowSec + 2 * 86_400) * 1000).toISOString());
    expect(event.markets?.map((m) => [m.ticker, m.eventTicker, m.yesSubTitle, m.noSubTitle, m.seriesTicker])).toEqual([
      ["FED-26MAR-CUT25", "FED-26MAR", "Cut ≥ 25 bps", "Smaller or none", "FED"],
      ["FED-26MAR-CUT50", "FED-26MAR", "Yes", "No", "FED"],
    ]);
    expect(event.markets?.[0].contractId).toBe(cut25.market.cid);
    expect(Object.keys(event.markets![0])).not.toEqual(expect.arrayContaining(["tickerSource"]));

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

  it("creates placeholder catalog rows for an event the operator has not written, which the operator then edits", async () => {
    const headers = await adminHeaders();
    const nowSec = Math.floor(Date.now() / 1000);
    const f = new LedgerFixture(TEST_TREASURY);
    // The contract's eventTicker is normalised like every ticker input; the series is the first segment.
    const cut25 = f.createMarket({
      marketId: 1,
      question: "Cut of at least 25 bps?",
      ticker: "fed-26mar-cut25",
      eventTicker: "fed-26mar",
      category: "Economics",
      createdAt: nowSec - 600,
      expiresAt: nowSec + 86_400,
    });
    f.createMarket({ marketId: 2, ticker: "FED-26MAR-CUT50", eventTicker: "FED-26MAR", createdAt: nowSec - 600, expiresAt: nowSec + 2 * 86_400 });
    f.createMarket({ marketId: 3, ticker: "NODASH-1", eventTicker: "NODASH", category: "Misc" });
    f.createMarket({ marketId: 4, ticker: "X-9-1", eventTicker: "X-9" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();

    const event = bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200)).event;
    expect(event).toMatchObject({
      ticker: "FED-26MAR",
      seriesTicker: "FED",
      title: "FED-26MAR",
      category: "Economics",
      imageUrl: "https://img.test/m.png",
      strikeDate: new Date((nowSec + 86_400) * 1000).toISOString(),
      status: "open",
      marketCount: 2,
      archived: false,
    });
    expect(event.markets?.map((m) => [m.ticker, m.seriesTicker])).toEqual([
      ["FED-26MAR-CUT25", "FED"],
      ["FED-26MAR-CUT50", "FED"],
    ]);
    const series = bodyOf<{ series: ApiSeries; events: ApiEvent[] }>(await ctx.agent.get("/api/v1/series/FED").expect(200));
    expect(series.series).toMatchObject({ ticker: "FED", title: "FED", category: "Economics", status: "active", eventCount: 1, marketCount: 2 });
    expect(series.events.map((e) => e.ticker)).toEqual(["FED-26MAR"]);
    // No usable first segment: the series is the event ticker itself.
    expect(bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/NODASH").expect(200)).event).toMatchObject({ seriesTicker: "NODASH", category: "Misc" });
    expect(bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/X-9").expect(200)).event).toMatchObject({ seriesTicker: "X-9" });
    expect(bodyOf<ApiPage<ApiSeries>>(await ctx.agent.get("/api/v1/series").expect(200)).items.map((s) => s.ticker)).toEqual(["FED", "NODASH", "X-9"]);
    // Ledger-derived rows are not audited; the operator's edits are.
    expect(await ctx.dataSource.query<unknown[]>(`SELECT 1 FROM to_audit_events WHERE action LIKE 'catalog.%'`)).toHaveLength(0);

    // The placeholder is a real row: the operator edits it in place (and cannot create it twice).
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent.post("/api/v1/admin/series").set(headers).send({ ticker: "FED", title: "Fed rate decisions" }).expect(409),
      ).error,
    ).toBe("catalog_conflict");
    await ctx.agent.patch("/api/v1/admin/series/FED").set(headers).send({ title: "Fed rate decisions", frequency: "monthly" }).expect(200);
    const edited = bodyOf<{ event: ApiEvent }>(
      await ctx.agent
        .patch("/api/v1/admin/events/FED-26MAR")
        .set(headers)
        .send({ title: "Fed decision, March 2026", subTitle: "March meeting", mutuallyExclusive: true, reason: "fill in" })
        .expect(200),
    ).event;
    expect(edited).toMatchObject({ title: "Fed decision, March 2026", subTitle: "March meeting", mutuallyExclusive: true, marketCount: 2 });

    // A later version of a market keeps its identity (the contract carries it; nothing off-ledger can change it).
    const w = f.createWallet(alice);
    const d = f.deposit(w.wallet, "10", "r");
    const b = f.buy({ market: cut25.market, wallet: d.wallet, buyer: alice, side: "Yes", collateralCC: "1", sharesOut: "1.5" });
    ctx.stream.push(w.tx, d.tx, b.tx);
    await ctx.get(IndexerService).runOnce();
    const after = bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/1").expect(200)).market;
    expect(after).toMatchObject({ ticker: "FED-26MAR-CUT25", eventTicker: "FED-26MAR", seriesTicker: "FED", yesSubTitle: "Yes", contractId: b.market.cid });
    expect(bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200)).event.title).toBe("Fed decision, March 2026");
    // The market's own identity has no operator route.
    await ctx.agent.patch("/api/v1/admin/markets/1/catalog").set(headers).send({ ticker: "OTHER-1" }).expect(404);
  });

  it("an on-ledger ticker that collides with another market's is indexed disambiguated; a malformed one is kept", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    f.createMarket({ marketId: 1, ticker: "DUP-1" });
    const dup = f.createMarket({ marketId: 2, ticker: "DUP-1" });
    f.createMarket({ marketId: 3, ticker: "bad ticker" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();
    const page = bodyOf<ApiPage<ApiMarket>>(await ctx.agent.get("/api/v1/markets?sort=oldest").expect(200));
    expect(page.items.map((m) => [m.marketId, m.ticker])).toEqual([
      [1, "DUP-1"],
      [2, "DUP-1~2"],
      [3, "BAD TICKER"],
    ]);
    expect(bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/DUP-1").expect(200)).market.marketId).toBe(1);
    // The disambiguation is deterministic across versions.
    const w = f.createWallet(alice);
    const d = f.deposit(w.wallet, "10", "r");
    const b = f.buy({ market: dup.market, wallet: d.wallet, buyer: alice, side: "Yes", collateralCC: "1", sharesOut: "1.5" });
    ctx.stream.push(w.tx, d.tx, b.tx);
    await ctx.get(IndexerService).runOnce();
    expect(bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/2").expect(200)).market).toMatchObject({ ticker: "DUP-1~2", contractId: b.market.cid });
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

    // The side labels default to the plain side names — the contract refuses an empty one.
    await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({ eventTicker: "FED-26MAR", ticker: "FED-26MAR-CUT50", question: "Cut of at least 50 bps?", yesSubTitle: "  ", expiresAt, initialProbability: "0.1", initialValueCC: "200" })
      .expect(200);
    expect(ctx.wallet.submits).toHaveLength(2);
    const second = ctx.wallet.submits[1].commands[0] as { ExerciseCommand: { choiceArgument: Record<string, unknown> } };
    expect(second.ExerciseCommand.choiceArgument).toMatchObject({ ticker: "FED-26MAR-CUT50", eventTicker: "FED-26MAR", yesSubTitle: "Yes", noSubTitle: "No" });
    // The identity is required: no ticker, no event, an over-long label — nothing is submitted.
    for (const body of [
      { eventTicker: "FED-26MAR", question: "x" },
      { ticker: "FED-26MAR-HOLD2", question: "x" },
      { eventTicker: "FED-26MAR", ticker: "FED-26MAR-HOLD2", question: "x", yesSubTitle: "y".repeat(81) },
      { eventTicker: "bad event!", ticker: "FED-26MAR-HOLD2", question: "x" },
    ]) {
      expect(
        bodyOf<{ error: string }>(
          await ctx.agent.post("/api/v1/admin/markets").set(headers).send({ ...body, expiresAt, initialProbability: "0.5", initialValueCC: "100" }).expect(400),
        ).error,
      ).toBe("validation_failed");
    }
    expect(ctx.wallet.submits).toHaveLength(2);

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
    expect(ctx.wallet.submits).toHaveLength(2);

    const audit = await ctx.dataSource.query<{ action: string; metadata: { commandId: string; expectedMarketId: number } }[]>(
      `SELECT action, metadata FROM to_audit_events WHERE action = 'market.create_submitted' ORDER BY id`,
    );
    expect(audit).toHaveLength(2);
    expect(audit[0].metadata).toMatchObject({ commandId: res.commandId, expectedMarketId: 2 });
  });
});
