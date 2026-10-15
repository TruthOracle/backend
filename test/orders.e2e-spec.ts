/**
 * AMM quotes, prepared orders and the exchange status (docs/MARKETS.md §6–§8; docs/API.md "Quotes
 * and orders", "Exchange"). Quotes are public and run the PmAmmMath port over the indexed market;
 * `orders/prepare` assembles the ExerciseCommand a user's wallet signs from the index, refusing
 * with a reason wherever the Daml choice would abort.
 */
import { IndexerService } from "../src/services/indexer.service";
import type {
  ApiExchangeStatus,
  ApiMarket,
  ApiPreparedOrder,
  ApiQuote,
  ApiQuoteBuy,
  ApiQuoteSell,
} from "../src/types";
import { AMOUNT_SCALE, formatAmount, parseAmount } from "../src/util/money";
import { TEST_TREASURY, useTestApp } from "./helpers/app";
import { LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });
const [alice, bob] = parties(2, "trader");
const dec = (v: string): string => formatAmount(parseAmount(v));

/** A market that is trading right now (created an hour ago, expires in a week), Alice funded and holding 18 YES. */
async function seedLiveMarket(): Promise<{
  f: LedgerFixture;
  market: ReturnType<LedgerFixture["createMarket"]>["market"];
  wallet: ReturnType<LedgerFixture["deposit"]>["wallet"];
  position: ReturnType<LedgerFixture["buy"]>["position"];
}> {
  const nowSec = Math.floor(Date.now() / 1000);
  const f = new LedgerFixture(TEST_TREASURY);
  const created = f.createMarket({
    marketId: 1,
    question: "Live?",
    price: "0.5",
    createdAt: nowSec - 3600,
    expiresAt: nowSec + 7 * 86_400,
    ticker: "LIVE-1",
    eventTicker: "LIVE",
    yesSubTitle: "Above",
    noSubTitle: "Below",
  });
  const w = f.createWallet(alice);
  const d = f.deposit(w.wallet, "100", "ref-1");
  const b = f.buy({
    market: created.market,
    wallet: d.wallet,
    buyer: alice,
    side: "Yes",
    amount: "10",
    sharesOut: "18",
  });
  ctx.stream.push(...f.txs);
  await ctx.get(IndexerService).runOnce();
  return { f, market: b.market, wallet: b.wallet, position: b.position };
}

describe("quotes", () => {
  it("quotes a buy and a sell against the active market version with slippage bounds", async () => {
    const { market } = await seedLiveMarket();
    const q = bodyOf<ApiQuote>(
      await ctx.agent.get("/api/v1/markets/LIVE-1/quote?action=buy&side=Yes&amount=10").expect(200),
    );
    expect(q).toMatchObject({
      marketId: 1,
      ticker: "LIVE-1",
      contractId: market.cid,
      phase: "trading",
    });
    expect(q.bounds.slippageBps).toBe(100);
    const buy = q.quote as ApiQuoteBuy;
    expect(buy.action).toBe("buy");
    expect(buy.amount).toBe(dec("10"));
    expect(buy.fee).toBe(dec("0.1")); // feeBps 100
    expect(buy.net).toBe(dec("9.9"));
    const shares = parseAmount(buy.sharesOut);
    expect(shares).toBeGreaterThan(parseAmount("10"));
    expect(shares).toBeLessThan(parseAmount("20"));
    expect(parseAmount(q.bounds.minSharesOut!)).toBeLessThan(shares);
    expect(parseAmount(q.bounds.minSharesOut!)).toBeGreaterThan((shares * 98n) / 100n);
    expect(parseAmount(buy.priceAfter)).toBeGreaterThan(parseAmount(buy.priceBefore));
    expect(buy.maxPayout).toBe(buy.sharesOut);

    const s = bodyOf<ApiQuote>(
      await ctx.agent
        .get("/api/v1/markets/1/quote?action=sell&side=Yes&shares=5&slippageBps=50")
        .expect(200),
    );
    const sell = s.quote as ApiQuoteSell;
    expect(sell.action).toBe("sell");
    expect(parseAmount(sell.net)).toBeGreaterThan(0n);
    expect(parseAmount(sell.net)).toBeLessThan(parseAmount("5"));
    expect(parseAmount(s.bounds.minProceeds!)).toBeLessThan(parseAmount(sell.net));
    expect(parseAmount(sell.priceAfter)).toBeLessThan(parseAmount(sell.priceBefore));

    expect(
      bodyOf<ApiQuote>(
        await ctx.agent.get("/api/v1/markets/1/quote?action=swap&side=Yes&shares=4").expect(200),
      ).quote.action,
    ).toBe("swap");
    expect(
      bodyOf<ApiQuote>(
        await ctx.agent
          .get("/api/v1/markets/1/quote?action=provide_liquidity&amount=10")
          .expect(200),
      ).bounds.maxCost,
    ).toBeDefined();
  });

  it("validates the request and refuses markets that are not trading", async () => {
    const seeded = await seedLiveMarket();
    const seedLiveMarketState = (): Promise<typeof seeded> => Promise.resolve(seeded);
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent.get("/api/v1/markets/1/quote?action=buy&amount=10").expect(400),
      ).error,
    ).toBe("validation_failed");
    await ctx.agent.get("/api/v1/markets/1/quote?action=split&amount=1").expect(400);
    await ctx.agent.get("/api/v1/markets/1/quote?action=buy&side=Yes&amount=abc").expect(400);
    await ctx.agent
      .get("/api/v1/markets/1/quote?action=buy&side=Yes&amount=10&slippageBps=5000")
      .expect(400);
    await ctx.agent.get("/api/v1/markets/1/quote?action=buy&side=Yes&amount=0").expect(400);

    // An expired market (fixture default dates are in the past), on the same fixture ledger.
    const { f } = await seedLiveMarketState();
    const old = f.createMarket({ marketId: 2, ticker: "OLD-1" });
    ctx.stream.push(old.tx);
    await ctx.get(IndexerService).runOnce();
    const res = bodyOf<{ error: string; details: { phase: string } }>(
      await ctx.agent.get("/api/v1/markets/OLD-1/quote?action=buy&side=Yes&amount=1").expect(409),
    );
    expect(res.error).toBe("market_not_tradable");
    expect(res.details.phase).toBe("expired");
  });
});

describe("orders/prepare", () => {
  it("builds the Buy command from the index for the account's primary wallet", async () => {
    const { market, wallet, position } = await seedLiveMarket();
    const { cookie } = await issueSessionDirect(ctx, { ...makeTestWallet("a"), partyId: alice });
    const headers = { Cookie: cookie, ...ctx.csrf };
    const before = Number(
      (await ctx.agent.get("/api/v1/markets").expect(200)).headers["x-ledger-offset"],
    );

    const prepared = bodyOf<ApiPreparedOrder>(
      await ctx.agent
        .post("/api/v1/markets/LIVE-1/orders/prepare")
        .set(headers)
        .send({ action: "buy", side: "No", amount: "12.5", slippageBps: 200 })
        .expect(200),
    );
    expect(prepared).toMatchObject({
      action: "buy",
      marketId: 1,
      ticker: "LIVE-1",
      actAs: alice,
      ledgerOffset: before,
    });
    expect(prepared.command.ExerciseCommand).toMatchObject({
      templateId: `fakepkg:Truthoracle:PredictionMarket`,
      contractId: market.cid,
      choice: "Buy",
    });
    const arg = prepared.command.ExerciseCommand.choiceArgument;
    expect(arg).toMatchObject({
      buyer: alice,
      side: "No",
      amount: dec("12.5"),
      existingPosition: position.cid,
      walletCid: wallet.cid,
    });
    expect(arg.minSharesOut).toBe(prepared.quote?.bounds.minSharesOut);
    expect(Number(arg.nowSeconds)).toBe(prepared.nowSeconds);
    expect(prepared.disclosedContracts).toEqual([
      {
        templateId: `fakepkg:Truthoracle:PredictionMarket`,
        contractId: market.cid,
        createdEventBlob: `blob-${market.cid}`,
        synchronizerId: "sync::test",
      },
    ]);
    expect(prepared.inputs).toEqual({
      marketContractId: market.cid,
      walletContractId: wallet.cid,
      positionContractId: position.cid,
      lpPositionContractId: null,
    });
    expect(prepared.quote?.bounds.slippageBps).toBe(200);
    expect(Date.parse(prepared.expiresAt)).toBeGreaterThan(Date.now());

    // Sell, swap, split, merge and redeem follow the same shape; each mirrors a Daml assert.
    const sell = bodyOf<ApiPreparedOrder>(
      await ctx.agent
        .post("/api/v1/markets/1/orders/prepare")
        .set(headers)
        .send({ action: "sell", side: "Yes", shares: "8" })
        .expect(200),
    );
    expect(sell.command.ExerciseCommand.choice).toBe("Sell");
    expect(sell.command.ExerciseCommand.choiceArgument).toMatchObject({
      seller: alice,
      sharesIn: dec("8"),
      positionCid: position.cid,
    });
    const split = bodyOf<ApiPreparedOrder>(
      await ctx.agent
        .post("/api/v1/markets/1/orders/prepare")
        .set(headers)
        .send({ action: "split", amount: "3" })
        .expect(200),
    );
    expect(split.command.ExerciseCommand.choice).toBe("Split");
    expect(split.quote).toBeNull();
  });

  it("checks the liquidity cost against the quoted maxCost itself, not the next whole unit", async () => {
    // The Daml choice debits at most `maxCost`, so a balance that covers it must be accepted — a
    // pre-check that rounded the cost up to whole units (or went through a double) refused trades
    // the ledger would have taken. Bob's balance is placed between the quoted cost and the next
    // whole unit; the quote drifts with ledger time, so the midpoint keeps the test honest.
    const { f } = await seedLiveMarket();
    const quoted = parseAmount(
      bodyOf<ApiQuote>(
        await ctx.agent
          .get("/api/v1/markets/1/quote?action=provide_liquidity&amount=10")
          .expect(200),
      ).bounds.maxCost!,
    );
    expect(quoted % AMOUNT_SCALE).not.toBe(0n); // the premise: a cost that is not a whole unit
    const floor = quoted - (quoted % AMOUNT_SCALE);
    const ceil = floor + AMOUNT_SCALE;
    const between = (quoted + ceil) / 2n;
    const { cookie } = await issueSessionDirect(ctx, { ...makeTestWallet("b"), partyId: bob });
    const headers = { Cookie: cookie, ...ctx.csrf };
    const created = f.createWallet(bob);
    const low = f.deposit(created.wallet, formatAmount(floor), "bob-1");
    ctx.stream.push(created.tx, low.tx);
    await ctx.get(IndexerService).runOnce();
    const refused = bodyOf<{ error: string; details: { balance: string; required: string } }>(
      await ctx.agent
        .post("/api/v1/markets/1/orders/prepare")
        .set(headers)
        .send({ action: "provide_liquidity", amount: "10" })
        .expect(409),
    );
    expect(refused.error).toBe("insufficient_balance");
    expect(refused.details.balance).toBe(formatAmount(floor));
    // Refused for the quoted cost, not for the whole unit above it.
    expect(parseAmount(refused.details.required)).toBeGreaterThan(floor);
    expect(parseAmount(refused.details.required)).toBeLessThan(ceil);
    const enough = f.deposit(low.wallet, formatAmount(between - floor), "bob-2");
    ctx.stream.push(enough.tx);
    await ctx.get(IndexerService).runOnce();
    const prepared = bodyOf<ApiPreparedOrder>(
      await ctx.agent
        .post("/api/v1/markets/1/orders/prepare")
        .set(headers)
        .send({ action: "provide_liquidity", amount: "10" })
        .expect(200),
    );
    expect(prepared.command.ExerciseCommand.choice).toBe("ProvideLiquidity");
    expect(
      parseAmount(prepared.command.ExerciseCommand.choiceArgument.maxCost as string),
    ).toBeLessThanOrEqual(between);
  });

  it("refuses what the ledger would refuse, with a reason", async () => {
    const { market } = await seedLiveMarket();
    const { cookie } = await issueSessionDirect(ctx, { ...makeTestWallet("a"), partyId: alice });
    const headers = { Cookie: cookie, ...ctx.csrf };
    const expectCode = async (body: object, status: number, code: string): Promise<void> => {
      const res = await ctx.agent
        .post("/api/v1/markets/1/orders/prepare")
        .set(headers)
        .send(body)
        .expect(status);
      expect(bodyOf<{ error: string }>(res).error).toBe(code);
    };
    await expectCode({ action: "buy", side: "Yes", amount: "1000" }, 409, "insufficient_balance");
    await expectCode({ action: "sell", side: "Yes", shares: "50" }, 409, "insufficient_shares");
    await expectCode({ action: "sell", side: "No", shares: "1" }, 409, "insufficient_shares");
    await expectCode({ action: "merge", amount: "1" }, 409, "insufficient_shares");
    await expectCode({ action: "withdraw_liquidity", lpTokens: "1" }, 409, "no_position");
    await expectCode({ action: "redeem" }, 409, "market_not_tradable");
    await expectCode({ action: "buy", side: "Maybe", amount: "1" }, 400, "validation_failed");
    await expectCode({ action: "buy", side: "Yes" }, 400, "validation_failed");
    await expectCode(
      { action: "buy", side: "Yes", amount: "1", extra: true },
      400,
      "validation_failed",
    );

    // Bob has an account but no in-app wallet on the ledger; Carol has no wallet linked at all.
    const bobCookie = (await issueSessionDirect(ctx, { ...makeTestWallet("b"), partyId: bob }))
      .cookie;
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/markets/1/orders/prepare")
          .set({ Cookie: bobCookie, ...ctx.csrf })
          .send({ action: "buy", side: "Yes", amount: "1" })
          .expect(409),
      ).error,
    ).toBe("no_in_app_wallet");
    const carolCookie = (
      await issueSessionDirect(ctx, makeTestWallet("c"), { withWalletRow: false })
    ).cookie;
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/markets/1/orders/prepare")
          .set({ Cookie: carolCookie, ...ctx.csrf })
          .send({ action: "buy", side: "Yes", amount: "1" })
          .expect(409),
      ).error,
    ).toBe("no_primary_wallet");
    // Bob may still be quoted (public) and told why he cannot sell.
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post("/api/v1/markets/1/orders/prepare")
          .set({ Cookie: bobCookie, ...ctx.csrf })
          .send({ action: "sell", side: "Yes", shares: "1" })
          .expect(409),
      ).error,
    ).toBe("no_in_app_wallet");

    // Sessions: anonymous and admin sessions are refused.
    await ctx.agent
      .post("/api/v1/markets/1/orders/prepare")
      .set(ctx.csrf)
      .send({ action: "buy", side: "Yes", amount: "1" })
      .expect(401);
    const admin = await issueSessionDirect(ctx, operator, { kind: "admin" });
    await ctx.agent
      .post("/api/v1/markets/1/orders/prepare")
      .set({ Cookie: admin.cookie, ...ctx.csrf })
      .send({ action: "buy", side: "Yes", amount: "1" })
      .expect(403);
    expect(market.cid).toBeDefined();
  });

  it("honours the operator's trading halt and reports it on the exchange status", async () => {
    await seedLiveMarket();
    const user = await issueSessionDirect(ctx, { ...makeTestWallet("a"), partyId: alice });
    const admin = await issueSessionDirect(ctx, operator, { kind: "admin" });
    const adminHeaders = { Cookie: admin.cookie, ...ctx.csrf };

    const open = bodyOf<ApiExchangeStatus>(
      await ctx.agent.get("/api/v1/exchange/status").expect(200),
    );
    expect(open).toMatchObject({
      tradingActive: true,
      exchangeActive: false,
      network: "devnet",
      packageName: "truthoracle-test",
    });
    expect(open.halt).toEqual({
      active: false,
      reason: null,
      since: null,
      estimatedResumeAt: null,
    });
    expect(open.ledger.indexEnabled).toBe(false);

    await ctx.agent
      .post("/api/v1/admin/exchange/halt")
      .set(adminHeaders)
      .send({ active: true })
      .expect(400);
    const halted = bodyOf<{ halt: { active: boolean; reason: string; since: string } }>(
      await ctx.agent
        .post("/api/v1/admin/exchange/halt")
        .set(adminHeaders)
        .send({
          active: true,
          reason: "participant maintenance",
          estimatedResumeAt: "2026-10-01T10:00:00.000Z",
        })
        .expect(200),
    ).halt;
    expect(halted).toMatchObject({
      active: true,
      reason: "participant maintenance",
      estimatedResumeAt: "2026-10-01T10:00:00.000Z",
    });
    const status = bodyOf<ApiExchangeStatus>(
      await ctx.agent.get("/api/v1/exchange/status").expect(200),
    );
    expect(status.tradingActive).toBe(false);
    expect(status.halt.since).toBe(halted.since);

    const refused = bodyOf<{ error: string; details: { estimatedResumeAt: string } }>(
      await ctx.agent
        .post("/api/v1/markets/1/orders/prepare")
        .set({ Cookie: user.cookie, ...ctx.csrf })
        .send({ action: "buy", side: "Yes", amount: "1" })
        .expect(409),
    );
    expect(refused.error).toBe("trading_halted");
    expect(refused.details.estimatedResumeAt).toBe("2026-10-01T10:00:00.000Z");
    // Quotes stay available while halted (they are reads), redemptions are never blocked by a halt.
    await ctx.agent.get("/api/v1/markets/1/quote?action=buy&side=Yes&amount=1").expect(200);

    await ctx.agent
      .post("/api/v1/admin/exchange/halt")
      .set(adminHeaders)
      .send({ active: false, reason: "resumed" })
      .expect(200);
    expect(
      bodyOf<ApiExchangeStatus>(await ctx.agent.get("/api/v1/exchange/status").expect(200))
        .tradingActive,
    ).toBe(true);
    await ctx.agent
      .post("/api/v1/markets/1/orders/prepare")
      .set({ Cookie: user.cookie, ...ctx.csrf })
      .send({ action: "buy", side: "Yes", amount: "1" })
      .expect(200);

    const audit = await ctx.dataSource.query<{ action: string; metadata: { active: boolean } }[]>(
      `SELECT action, metadata FROM to_audit_events WHERE action = 'exchange.halt_changed' ORDER BY id`,
    );
    expect(audit.map((a) => a.metadata.active)).toEqual([true, false]);
    // A user session cannot halt.
    await ctx.agent
      .post("/api/v1/admin/exchange/halt")
      .set({ Cookie: user.cookie, ...ctx.csrf })
      .send({ active: true, reason: "x" })
      .expect(403);
    const m = bodyOf<{ market: ApiMarket }>(
      await ctx.agent.get("/api/v1/markets/1").expect(200),
    ).market;
    expect(m).toMatchObject({
      ticker: "LIVE-1",
      eventTicker: "LIVE",
      yesSubTitle: "Above",
      noSubTitle: "Below",
    });
  });
});
