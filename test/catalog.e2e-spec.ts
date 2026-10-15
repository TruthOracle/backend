/**
 * The market catalog (docs/MARKETS.md §2–§4; docs/API.md "Catalog", "Admin — catalog"): series →
 * events → markets, a market's identity being the contract's own (placeholder catalog rows when
 * the operator has not written the event yet); derived event status; the treasury-signed market
 * factory with its identity validation.
 */
import { IndexerService } from "../src/services/indexer.service";
import type { ApiCreateMarketResult, ApiEvent, ApiMarket, ApiPage, ApiSeries } from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { formatAmount, parseAmount } from "../src/util/money";
import { TEST_DSO, TEST_REWARDS, TEST_TREASURY, useTestApp } from "./helpers/app";
import { FIXTURE_TOKEN, LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });
const [alice] = parties(1, "trader");
const dec = (v: string): string => formatAmount(parseAmount(v));

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
      instrument: { admin: TEST_DSO, id: "Amulet", symbol: "CC" },
      eventCount: 1,
      marketCount: 0,
      volume: dec("0"),
    });
    const empty = bodyOf<{ event: ApiEvent }>(
      await ctx.agent.get("/api/v1/events/fed-26mar").expect(200),
    ).event;
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
    expect(empty.settlementSources).toEqual([
      { name: "FOMC statement", url: "https://www.federalreserve.gov" },
    ]);

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

    const event = bodyOf<{ event: ApiEvent }>(
      await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200),
    ).event;
    expect(event).toMatchObject({ status: "open", marketCount: 2 });
    expect(event.closeTime).toBe(new Date((nowSec + 2 * 86_400) * 1000).toISOString());
    expect(
      event.markets?.map((m) => [
        m.ticker,
        m.eventTicker,
        m.yesSubTitle,
        m.noSubTitle,
        m.seriesTicker,
      ]),
    ).toEqual([
      ["FED-26MAR-CUT25", "FED-26MAR", "Cut ≥ 25 bps", "Smaller or none", "FED"],
      ["FED-26MAR-CUT50", "FED-26MAR", "Yes", "No", "FED"],
    ]);
    expect(event.markets?.[0].contractId).toBe(cut25.market.cid);
    expect(Object.keys(event.markets![0])).not.toEqual(expect.arrayContaining(["tickerSource"]));

    const bySeries = bodyOf<ApiPage<ApiMarket>>(
      await ctx.agent.get("/api/v1/markets?series=fed&sort=oldest").expect(200),
    );
    expect(bySeries.items.map((m) => m.marketId)).toEqual([1, 2]);
    const nested = bodyOf<ApiPage<ApiEvent>>(
      await ctx.agent.get("/api/v1/events?withNestedMarkets=true&status=open").expect(200),
    );
    expect(nested.items).toHaveLength(1);
    expect(nested.items[0].markets).toHaveLength(2);
    expect(
      bodyOf<ApiPage<ApiEvent>>(await ctx.agent.get("/api/v1/events?status=settled").expect(200))
        .total,
    ).toBe(0);
    expect(
      bodyOf<ApiPage<ApiEvent>>(
        await ctx.agent.get("/api/v1/events?category=economics").expect(200),
      ).total,
    ).toBe(1);
    const detail = bodyOf<{ series: ApiSeries; events: ApiEvent[] }>(
      await ctx.agent.get("/api/v1/series/FED").expect(200),
    );
    expect(detail.series.marketCount).toBe(2);
    expect(detail.events.map((e) => e.ticker)).toEqual(["FED-26MAR"]);
    expect(detail.events[0].markets).toBeUndefined();

    // Settling both markets settles the event.
    const settled1 = f.resolveT0(cut25.market, "Yes", nowSec + 90_000);
    ctx.stream.push(settled1.tx);
    await ctx.get(IndexerService).runOnce();
    expect(
      bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200)).event
        .status,
    ).toBe("open");
    await ctx.agent.get("/api/v1/series/NOPE").expect(404);
    await ctx.agent.get("/api/v1/events/NOPE").expect(404);
    await ctx.agent.get("/api/v1/events?status=bogus").expect(400);
  });

  it("refuses duplicates and dangling references; validates tickers", async () => {
    const headers = await adminHeaders();
    await seedCatalog(headers);
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/admin/series")
          .set(headers)
          .send({ ticker: "FED", title: "again" })
          .expect(409),
      ).error,
    ).toBe("catalog_conflict");
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/admin/events")
          .set(headers)
          .send({ ticker: "X-1", seriesTicker: "NOPE", title: "x" })
          .expect(404),
      ).error,
    ).toBe("not_found");
    await ctx.agent
      .post("/api/v1/admin/series")
      .set(headers)
      .send({ ticker: "bad ticker!", title: "x" })
      .expect(400);
    await ctx.agent
      .post("/api/v1/admin/series")
      .set(headers)
      .send({ ticker: "OK-1", title: "x", frequency: "hourly" })
      .expect(400);
    await ctx.agent
      .post("/api/v1/admin/series")
      .set(headers)
      .send({ ticker: "OK-1", title: "x", nope: 1 })
      .expect(400);

    const updated = bodyOf<{ series: ApiSeries }>(
      await ctx.agent
        .patch("/api/v1/admin/series/fed")
        .set(headers)
        .send({ status: "archived", tags: ["macro"], reason: "retire" })
        .expect(200),
    ).series;
    expect(updated).toMatchObject({ status: "archived", tags: ["macro"] });
    expect(
      bodyOf<ApiPage<ApiSeries>>(await ctx.agent.get("/api/v1/series").expect(200)).total,
    ).toBe(0);
    expect(
      bodyOf<ApiPage<ApiSeries>>(await ctx.agent.get("/api/v1/series?status=all").expect(200))
        .total,
    ).toBe(1);

    const archived = bodyOf<{ event: ApiEvent }>(
      await ctx.agent
        .patch("/api/v1/admin/events/FED-26MAR")
        .set(headers)
        .send({ archived: true, title: "renamed" })
        .expect(200),
    ).event;
    expect(archived).toMatchObject({ archived: true, title: "renamed" });
    expect(bodyOf<ApiPage<ApiEvent>>(await ctx.agent.get("/api/v1/events").expect(200)).total).toBe(
      0,
    );
    expect(
      bodyOf<ApiPage<ApiEvent>>(
        await ctx.agent.get("/api/v1/events?includeArchived=true").expect(200),
      ).total,
    ).toBe(1);

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
    await ctx.agent
      .post("/api/v1/admin/series")
      .set(ctx.csrf)
      .send({ ticker: "A-1", title: "x" })
      .expect(401);
    const user = await issueSessionDirect(ctx, { ...makeTestWallet("u"), partyId: alice });
    await ctx.agent
      .post("/api/v1/admin/series")
      .set({ Cookie: user.cookie, ...ctx.csrf })
      .send({ ticker: "A-1", title: "x" })
      .expect(403);
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
      createdAt: nowSec - 600,
      expiresAt: nowSec + 86_400,
    });
    f.createMarket({
      marketId: 2,
      ticker: "FED-26MAR-CUT50",
      eventTicker: "FED-26MAR",
      createdAt: nowSec - 600,
      expiresAt: nowSec + 2 * 86_400,
    });
    f.createMarket({ marketId: 3, ticker: "NODASH-1", eventTicker: "NODASH" });
    f.createMarket({ marketId: 4, ticker: "X-9-1", eventTicker: "X-9" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();

    const event = bodyOf<{ event: ApiEvent }>(
      await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200),
    ).event;
    // The contract carries no presentation (v17): the placeholders start without image and category.
    expect(event).toMatchObject({
      ticker: "FED-26MAR",
      seriesTicker: "FED",
      title: "FED-26MAR",
      category: "",
      imageUrl: "",
      strikeDate: new Date((nowSec + 86_400) * 1000).toISOString(),
      status: "open",
      marketCount: 2,
      archived: false,
    });
    expect(event.markets?.map((m) => [m.ticker, m.seriesTicker])).toEqual([
      ["FED-26MAR-CUT25", "FED"],
      ["FED-26MAR-CUT50", "FED"],
    ]);
    const series = bodyOf<{ series: ApiSeries; events: ApiEvent[] }>(
      await ctx.agent.get("/api/v1/series/FED").expect(200),
    );
    expect(series.series).toMatchObject({
      ticker: "FED",
      title: "FED",
      category: "",
      status: "active",
      eventCount: 1,
      marketCount: 2,
    });
    expect(series.events.map((e) => e.ticker)).toEqual(["FED-26MAR"]);
    // No usable first segment: the series is the event ticker itself.
    expect(
      bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/NODASH").expect(200)).event,
    ).toMatchObject({ seriesTicker: "NODASH", category: "" });
    expect(
      bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/X-9").expect(200)).event,
    ).toMatchObject({ seriesTicker: "X-9" });
    expect(
      bodyOf<ApiPage<ApiSeries>>(await ctx.agent.get("/api/v1/series").expect(200)).items.map(
        (s) => s.ticker,
      ),
    ).toEqual(["FED", "NODASH", "X-9"]);
    // Ledger-derived rows are not audited; the operator's edits are.
    expect(
      await ctx.dataSource.query<unknown[]>(
        `SELECT 1 FROM to_audit_events WHERE action LIKE 'catalog.%'`,
      ),
    ).toHaveLength(0);

    // The placeholder is a real row: the operator edits it in place (and cannot create it twice).
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/admin/series")
          .set(headers)
          .send({ ticker: "FED", title: "Fed rate decisions" })
          .expect(409),
      ).error,
    ).toBe("catalog_conflict");
    await ctx.agent
      .patch("/api/v1/admin/series/FED")
      .set(headers)
      .send({ title: "Fed rate decisions", frequency: "monthly", category: "Economics" })
      .expect(200);
    const edited = bodyOf<{ event: ApiEvent }>(
      await ctx.agent
        .patch("/api/v1/admin/events/FED-26MAR")
        .set(headers)
        .send({
          title: "Fed decision, March 2026",
          subTitle: "March meeting",
          mutuallyExclusive: true,
          imageUrl: "https://img.example/fed-26mar.png",
          reason: "fill in",
        })
        .expect(200),
    ).event;
    expect(edited).toMatchObject({
      title: "Fed decision, March 2026",
      subTitle: "March meeting",
      mutuallyExclusive: true,
      marketCount: 2,
      category: "Economics",
    });
    // A ledger-first market has no metadata row: it shows its event's image, no description, and the series' category.
    const ledgerFirst = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/FED-26MAR-CUT50").expect(200),
    ).market;
    expect(ledgerFirst).toMatchObject({
      imageUrl: "https://img.example/fed-26mar.png",
      description: "",
      category: "Economics",
      metadata: null,
    });
    expect(
      bodyOf<{ category: string; markets: number }[]>(
        await ctx.agent.get("/api/v1/markets/categories").expect(200),
      ),
    ).toEqual([{ category: "Economics", markets: 2 }]);

    // A later version of a market keeps its identity (the contract carries it; nothing off-ledger can change it).
    const w = f.createWallet(alice);
    const d = f.deposit(w.wallet, "10", "r");
    const b = f.buy({
      market: cut25.market,
      wallet: d.wallet,
      buyer: alice,
      side: "Yes",
      amount: "1",
      sharesOut: "1.5",
    });
    ctx.stream.push(w.tx, d.tx, b.tx);
    await ctx.get(IndexerService).runOnce();
    const after = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/1").expect(200),
    ).market;
    expect(after).toMatchObject({
      ticker: "FED-26MAR-CUT25",
      eventTicker: "FED-26MAR",
      seriesTicker: "FED",
      yesSubTitle: "Yes",
      contractId: b.market.cid,
    });
    expect(
      bodyOf<{ event: ApiEvent }>(await ctx.agent.get("/api/v1/events/FED-26MAR").expect(200)).event
        .title,
    ).toBe("Fed decision, March 2026");
    // The market's own identity has no operator route.
    await ctx.agent
      .patch("/api/v1/admin/markets/1/catalog")
      .set(headers)
      .send({ ticker: "OTHER-1" })
      .expect(404);
  });

  it("an on-ledger ticker that collides with another market's is indexed disambiguated; a malformed one is kept", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    f.createMarket({ marketId: 1, ticker: "DUP-1" });
    const dup = f.createMarket({ marketId: 2, ticker: "DUP-1" });
    f.createMarket({ marketId: 3, ticker: "bad ticker" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();
    const page = bodyOf<ApiPage<ApiMarket>>(
      await ctx.agent.get("/api/v1/markets?sort=oldest").expect(200),
    );
    expect(page.items.map((m) => [m.marketId, m.ticker])).toEqual([
      [1, "DUP-1"],
      [2, "DUP-1~2"],
      [3, "BAD TICKER"],
    ]);
    expect(
      bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/DUP-1").expect(200)).market
        .marketId,
    ).toBe(1);
    // The disambiguation is deterministic across versions.
    const w = f.createWallet(alice);
    const d = f.deposit(w.wallet, "10", "r");
    const b = f.buy({
      market: dup.market,
      wallet: d.wallet,
      buyer: alice,
      side: "Yes",
      amount: "1",
      sharesOut: "1.5",
    });
    ctx.stream.push(w.tx, d.tx, b.tx);
    await ctx.get(IndexerService).runOnce();
    expect(
      bodyOf<{ market: ApiMarket }>(await ctx.agent.get("/api/v1/markets/2").expect(200)).market,
    ).toMatchObject({ ticker: "DUP-1~2", contractId: b.market.cid });
  });

  it("creates a market on-ledger through the treasury for an event, with a deterministic command id", async () => {
    const headers = await adminHeaders();
    await seedCatalog(headers);
    // The MarketCounter must be indexed first.
    const early = await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({
        eventTicker: "FED-26MAR",
        ticker: "FED-26MAR-CUT25",
        question: "Cut?",
        expiresAt: "2026-12-01T00:00:00.000Z",
        initialProbability: "0.35",
        initialValue: "200",
      })
      .expect(503);
    expect(bodyOf<{ error: string }>(early).error).toBe("not_ready");

    const f = new LedgerFixture(TEST_TREASURY);
    const created = f.createMarket({
      marketId: 1,
      ticker: "FED-26MAR-HOLD",
      eventTicker: "FED-26MAR",
    });
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
          imageUrl: " https://img.example/cut25.png ",
          description: "The March cut market",
          expiresAt,
          initialProbability: "0.35",
          initialValue: "200",
          feeBps: 100,
          reason: "March meeting",
        })
        .expect(200),
    );
    expect(res).toMatchObject({
      ticker: "FED-26MAR-CUT25",
      eventTicker: "FED-26MAR",
      expectedMarketId: 2,
      status: "completed",
    });
    expect(res.commandId).toMatch(/^create-market-[0-9a-f]{40}$/);
    expect(ctx.wallet.submits).toHaveLength(1);
    const submitted = ctx.wallet.submits[0].commands[0] as {
      ExerciseCommand: {
        templateId: string;
        contractId: string;
        choice: string;
        choiceArgument: Record<string, unknown>;
      };
    };
    expect(submitted.ExerciseCommand).toMatchObject({
      templateId: "fakepkg:Truthoracle:MarketCounter",
      contractId: created.counterCid,
      choice: "CreateMarket",
    });
    expect(submitted.ExerciseCommand.choiceArgument).toMatchObject({
      question: "Cut of at least 25 bps?",
      initialProbability: dec("0.35"),
      initialValue: dec("200"),
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
    expect(submitted.ExerciseCommand.choiceArgument.expiresAt).toBe(
      String(Math.floor(Date.parse(expiresAt) / 1000)),
    );
    expect(
      (submitted.ExerciseCommand.choiceArgument.policy as { operatorResolution: boolean })
        .operatorResolution,
    ).toBe(true);
    // Presentation never reaches the ledger: it is the backend's row, written before the submit.
    expect(Object.keys(submitted.ExerciseCommand.choiceArgument)).toEqual(
      expect.not.arrayContaining(["imageUrl", "description", "category"]),
    );
    expect(
      await ctx.dataSource.query<{ image_url: string; description: string }[]>(
        `SELECT image_url, description FROM to_market_metadata WHERE ticker = 'FED-26MAR-CUT25'`,
      ),
    ).toEqual([
      { image_url: "https://img.example/cut25.png", description: "The March cut market" },
    ]);
    // Same ticker again (before the index knows it): the deterministic command id collides on the wallet's command dedup.
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/admin/markets")
          .set(headers)
          .send({
            eventTicker: "FED-26MAR",
            ticker: "FED-26MAR-CUT25",
            question: "Cut?",
            expiresAt,
            initialProbability: "0.35",
            initialValue: "200",
          })
          .expect(502),
      ).error,
    ).toBe("upstream_failed");
    // Once the ledger create is indexed the market shows its own image and description, and the series' category.
    ctx.stream.push(
      f.createMarket({
        marketId: 2,
        ticker: "FED-26MAR-CUT25",
        eventTicker: "FED-26MAR",
        createdAt: Math.floor(Date.now() / 1000) - 60,
        expiresAt: Math.floor(Date.parse(expiresAt) / 1000),
      }).tx,
    );
    await ctx.get(IndexerService).runOnce();
    const indexed = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/FED-26MAR-CUT25").expect(200),
    ).market;
    expect(indexed).toMatchObject({
      marketId: 2,
      imageUrl: "https://img.example/cut25.png",
      description: "The March cut market",
      category: "Economics",
      metadata: { imageUrl: "https://img.example/cut25.png", description: "The March cut market" },
    });
    expect(
      bodyOf<ApiPage<ApiMarket>>(
        await ctx.agent.get("/api/v1/markets?q=march%20cut").expect(200),
      ).items.map((m) => m.marketId),
    ).toEqual([2]);

    // The operator edits the presentation in place; a blank image falls back to the event's.
    await ctx.agent
      .patch("/api/v1/admin/events/FED-26MAR")
      .set(headers)
      .send({ imageUrl: "https://img.example/fed-26mar.png" })
      .expect(200);
    const patched = bodyOf<{ market: ApiMarket }>(
      await ctx.agent
        .patch("/api/v1/admin/markets/2/metadata")
        .set(headers)
        .send({ imageUrl: "", reason: "use the event artwork" })
        .expect(200),
    ).market;
    expect(patched).toMatchObject({
      imageUrl: "https://img.example/fed-26mar.png",
      description: "The March cut market",
      metadata: { imageUrl: "", description: "The March cut market" },
    });
    const described = bodyOf<{ market: ApiMarket }>(
      await ctx.agent
        .patch("/api/v1/admin/markets/fed-26mar-cut25/metadata")
        .set(headers)
        .send({ description: "Edited" })
        .expect(200),
    ).market;
    expect(described.description).toBe("Edited");
    expect(
      await ctx.dataSource.query<unknown[]>(
        `SELECT 1 FROM to_audit_events WHERE action = 'catalog.market_metadata_updated'`,
      ),
    ).toHaveLength(2);
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .patch("/api/v1/admin/markets/2/metadata")
          .set(headers)
          .send({ reason: "nothing" })
          .expect(400),
      ).error,
    ).toBe("validation_failed");
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .patch("/api/v1/admin/markets/NOPE-1/metadata")
          .set(headers)
          .send({ description: "x" })
          .expect(404),
      ).error,
    ).toBe("not_found");

    // The side labels default to the plain side names — the contract refuses an empty one; no
    // presentation sent means no metadata row (the market will show its event's image).
    await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({
        eventTicker: "FED-26MAR",
        ticker: "FED-26MAR-CUT50",
        question: "Cut of at least 50 bps?",
        yesSubTitle: "  ",
        expiresAt,
        initialProbability: "0.1",
        initialValue: "200",
      })
      .expect(200);
    expect(ctx.wallet.submits).toHaveLength(2);
    const second = ctx.wallet.submits[1].commands[0] as {
      ExerciseCommand: { choiceArgument: Record<string, unknown> };
    };
    expect(second.ExerciseCommand.choiceArgument).toMatchObject({
      ticker: "FED-26MAR-CUT50",
      eventTicker: "FED-26MAR",
      yesSubTitle: "Yes",
      noSubTitle: "No",
    });
    expect(
      await ctx.dataSource.query<unknown[]>(
        `SELECT 1 FROM to_market_metadata WHERE ticker = 'FED-26MAR-CUT50'`,
      ),
    ).toHaveLength(0);
    // The identity is required: no ticker, no event, an over-long label — nothing is submitted.
    for (const body of [
      { eventTicker: "FED-26MAR", question: "x" },
      { ticker: "FED-26MAR-HOLD2", question: "x" },
      {
        eventTicker: "FED-26MAR",
        ticker: "FED-26MAR-HOLD2",
        question: "x",
        yesSubTitle: "y".repeat(81),
      },
      { eventTicker: "bad event!", ticker: "FED-26MAR-HOLD2", question: "x" },
    ]) {
      expect(
        bodyOf<{ error: string }>(
          await ctx.agent
            .post("/api/v1/admin/markets")
            .set(headers)
            .send({ ...body, expiresAt, initialProbability: "0.5", initialValue: "100" })
            .expect(400),
        ).error,
      ).toBe("validation_failed");
    }
    expect(ctx.wallet.submits).toHaveLength(2);

    // A ticker the index already knows is refused before anything is submitted.
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/admin/markets")
          .set(headers)
          .send({
            eventTicker: "FED-26MAR",
            ticker: "FED-26MAR-HOLD",
            question: "Hold?",
            expiresAt,
            initialProbability: "0.5",
            initialValue: "100",
          })
          .expect(409),
      ).error,
    ).toBe("catalog_conflict");
    await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({
        eventTicker: "NOPE",
        ticker: "N-1",
        question: "x",
        expiresAt,
        initialProbability: "0.5",
        initialValue: "100",
      })
      .expect(404);
    await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({
        eventTicker: "FED-26MAR",
        ticker: "N-1",
        question: "x",
        expiresAt,
        initialProbability: "0.999",
        initialValue: "100",
      })
      .expect(400);
    await ctx.agent
      .post("/api/v1/admin/markets")
      .set(headers)
      .send({
        eventTicker: "FED-26MAR",
        ticker: "N-1",
        question: "x",
        expiresAt: "2020-01-01T00:00:00.000Z",
        initialProbability: "0.5",
        initialValue: "100",
      })
      .expect(400);
    expect(ctx.wallet.submits).toHaveLength(2);

    const audit = await ctx.dataSource.query<
      { action: string; metadata: { commandId: string; expectedMarketId: number } }[]
    >(
      `SELECT action, metadata FROM to_audit_events WHERE action = 'market.create_submitted' ORDER BY id`,
    );
    expect(audit).toHaveLength(2);
    expect(audit[0].metadata).toMatchObject({ commandId: res.commandId, expectedMarketId: 2 });
  });

  it("markets are created in an enabled collateral instrument only, one instrument per event (docs/TOKENS.md §4.5)", async () => {
    const headers = await adminHeaders();
    await seedCatalog(headers);
    const f = new LedgerFixture(TEST_TREASURY);
    f.createMarket({ marketId: 1, ticker: "FED-26MAR-HOLD", eventTicker: "FED-26MAR" });
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();
    await ctx.agent
      .post("/api/v1/admin/instruments")
      .set(headers)
      .send({
        admin: FIXTURE_TOKEN.admin,
        id: "cBYN",
        symbol: "cBYN",
        decimals: 6,
        kind: "collateral",
        reason: "x",
      })
      .expect(200);
    const base = {
      eventTicker: "FED-26MAR",
      ticker: "FED-26MAR-CUT25",
      question: "Cut?",
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      initialProbability: "0.35",
      initialValue: "200",
    };
    // The rewards instrument, an unknown token and a disabled collateral cannot back a market.
    for (const collateral of [TEST_REWARDS, { admin: FIXTURE_TOKEN.admin, id: "NOPE" }]) {
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post("/api/v1/admin/markets")
            .set(headers)
            .send({ ...base, collateral })
            .expect(400),
        ).error,
      ).toBe("validation_failed");
    }
    // The event already holds a Canton Coin market: a cBYN market is refused.
    const conflict = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/admin/markets")
        .set(headers)
        .send({ ...base, collateral: FIXTURE_TOKEN })
        .expect(409),
    );
    expect(conflict.error).toBe("catalog_conflict");
    expect(conflict.details).toEqual({
      eventCollateral: { admin: TEST_DSO, id: "Amulet" },
      requested: { admin: FIXTURE_TOKEN.admin, id: "cBYN" },
    });
    expect(ctx.wallet.submits).toEqual([]);
    // A fresh event takes cBYN; the CreateMarket argument carries it and the response names it.
    await ctx.agent
      .post("/api/v1/admin/events")
      .set(headers)
      .send({ ticker: "BYN-26", seriesTicker: "FED", title: "A ruble market" })
      .expect(200);
    const res = bodyOf<ApiCreateMarketResult>(
      await ctx.agent
        .post("/api/v1/admin/markets")
        .set(headers)
        .send({ ...base, eventTicker: "BYN-26", ticker: "BYN-26-A", collateral: FIXTURE_TOKEN })
        .expect(200),
    );
    expect(res.collateral).toMatchObject({
      admin: FIXTURE_TOKEN.admin,
      id: "cBYN",
      symbol: "cBYN",
      decimals: 6,
    });
    const arg = (
      ctx.wallet.submits[0].commands[0] as {
        ExerciseCommand: { choiceArgument: Record<string, unknown> };
      }
    ).ExerciseCommand.choiceArgument;
    expect(arg.collateral).toEqual({ admin: FIXTURE_TOKEN.admin, id: "cBYN" });
    // The event's instrument is fixed by the submission: a Canton Coin market on it is now the conflict.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/markets")
          .set(headers)
          .send({ ...base, eventTicker: "BYN-26", ticker: "BYN-26-B" })
          .expect(409),
      ).error,
    ).toBe("catalog_conflict");
    await ctx.agent
      .patch(`/api/v1/admin/instruments/${encodeURIComponent(FIXTURE_TOKEN.admin)}/cBYN`)
      .set(headers)
      .send({ enabled: false, reason: "pause" })
      .expect(200);
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/markets")
          .set(headers)
          .send({ ...base, eventTicker: "BYN-26", ticker: "BYN-26-C", collateral: FIXTURE_TOKEN })
          .expect(400),
      ).error,
    ).toBe("validation_failed");
  });

  it("catalog aggregates are per instrument: events and series are listed and summed for the default collateral unless ?instrument= names another (docs/TOKENS.md §4.5)", async () => {
    const headers = await adminHeaders();
    await seedCatalog(headers);
    await ctx.agent
      .post("/api/v1/admin/events")
      .set(headers)
      .send({ ticker: "FED-26JUN", seriesTicker: "FED", title: "June, no market yet" })
      .expect(200);
    const nowSec = Math.floor(Date.now() / 1000);
    const f = new LedgerFixture(TEST_TREASURY);
    const cc = f.createMarket({
      marketId: 1,
      ticker: "FED-26MAR-CUT25",
      eventTicker: "FED-26MAR",
      createdAt: nowSec - 600,
      expiresAt: nowSec + 86_400,
    });
    const byn = f.createMarket({
      marketId: 2,
      ticker: "FED-26MAY-CUT",
      eventTicker: "FED-26MAY",
      collateral: FIXTURE_TOKEN,
      createdAt: nowSec - 600,
      expiresAt: nowSec + 86_400,
    });
    const [alice] = parties(1, "trader");
    const wcc = f.deposit(f.createWallet(alice).wallet, "100", "r1");
    f.buy({ market: cc.market, wallet: wcc.wallet, buyer: alice, side: "Yes", amount: "10" });
    const wbyn = f.deposit(f.createWallet(alice, FIXTURE_TOKEN).wallet, "100", "r2");
    f.buy({ market: byn.market, wallet: wbyn.wallet, buyer: alice, side: "Yes", amount: "40" });
    ctx.stream.push(...f.txs);
    const indexer = ctx.get(IndexerService);
    await indexer.runOnce();
    await indexer.runOnce();
    // The ledger-first cBYN event got its placeholder row (series FED) with the market's collateral.
    await ctx.agent
      .patch("/api/v1/admin/events/FED-26MAY")
      .set(headers)
      .send({ seriesTicker: "FED", title: "May (cBYN)" })
      .expect(200);

    const bynKey = encodeURIComponent(`${FIXTURE_TOKEN.admin}:cBYN`);
    // Default: Canton Coin. The cBYN event is left out; the event without a market is listed under every instrument with no figures.
    const defaults = bodyOf<ApiPage<ApiEvent>>(
      await ctx.agent.get("/api/v1/events?sort=volume").expect(200),
    );
    expect(
      defaults.items.map((e) => [e.ticker, e.instrument?.id ?? null, e.marketCount, e.volume]),
    ).toEqual([
      ["FED-26MAR", "Amulet", 1, dec("10")],
      ["FED-26JUN", null, 0, dec("0")],
    ]);
    const byn26 = bodyOf<ApiPage<ApiEvent>>(
      await ctx.agent
        .get(`/api/v1/events?sort=volume&instrument=${bynKey}&withNestedMarkets=true`)
        .expect(200),
    );
    expect(
      byn26.items.map((e) => [e.ticker, e.instrument?.id ?? null, e.marketCount, e.volume]),
    ).toEqual([
      ["FED-26MAY", "cBYN", 1, dec("40")],
      ["FED-26JUN", null, 0, dec("0")],
    ]);
    expect(byn26.items[0].markets?.map((m) => m.collateral.id)).toEqual(["cBYN"]);
    expect(byn26.items[0].topMarket?.ticker).toBe("FED-26MAY-CUT");
    await ctx.agent.get("/api/v1/events?instrument=nope").expect(400);

    // Series: counts and volume follow the instrument; the event without a market counts under both.
    const ccSeries = bodyOf<ApiPage<ApiSeries>>(await ctx.agent.get("/api/v1/series").expect(200))
      .items[0];
    expect(ccSeries).toMatchObject({
      ticker: "FED",
      instrument: { admin: TEST_DSO, id: "Amulet" },
      eventCount: 2,
      marketCount: 1,
      volume: dec("10"),
    });
    const bynSeries = bodyOf<{ series: ApiSeries; events: ApiEvent[] }>(
      await ctx.agent.get(`/api/v1/series/fed?instrument=${bynKey}`).expect(200),
    );
    expect(bynSeries.series).toMatchObject({
      instrument: { admin: FIXTURE_TOKEN.admin, id: "cBYN", symbol: "cBYN" },
      eventCount: 2,
      marketCount: 1,
      volume: dec("40"),
    });
    expect(bynSeries.events.map((e) => e.ticker).sort()).toEqual(["FED-26JUN", "FED-26MAY"]);
    await ctx.agent.get("/api/v1/series?instrument=nope").expect(400);
    // An unregistered instrument still works as a filter (its ref renders as its id).
    expect(
      bodyOf<ApiPage<ApiEvent>>(
        await ctx.agent
          .get(`/api/v1/events?instrument=${encodeURIComponent(`${TEST_DSO}:Other`)}`)
          .expect(200),
      ).items.map((e) => e.ticker),
    ).toEqual(["FED-26JUN"]);
  });
});
