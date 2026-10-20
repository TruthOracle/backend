/**
 * Ramp controls (SPEC §6.1–§6.4; S4) with the production gates on: RAMP_RESERVE_GATE=enforce,
 * RAMP_PAYOUT_GATE=enforce, RAMP_AUTO_HALT=true (four-eyes is approvals.e2e-spec's; here requests
 * execute at once). Halts by an operator and by a red check (a sync pass's unknown record, X8),
 * the reserve gate failing closed without a fresh statement (X5), the payout gate deferring
 * MarkPaid and card payouts, and a compensation restoring its order (S4's semantics). Every money
 * scenario ends on the journal identities.
 */
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { RampReconRunEntity } from "../src/entities/ramp-recon-run.entity";
import { PayoutService } from "../src/services/payout.service";
import { RampControlsService } from "../src/services/ramp-controls.service";
import { rampCommandId } from "../src/services/ramp-fulfilment.service";
import { RampGatesService } from "../src/services/ramp-gates.service";
import { RampJournalService } from "../src/services/ramp-journal.service";
import { RampReconChecks } from "../src/services/ramp-recon-checks.service";
import {
  RampReconciliationService,
  type ReserveStatement,
} from "../src/services/ramp-reconciliation.service";
import { SentryService } from "../src/services/sentry.service";
import { TokenAppSyncService } from "../src/services/token-app-sync.service";
import { TokenCommandService } from "../src/services/token-command.service";
import { compensationCommandId } from "../src/services/token-commands.logic";
import type { ApiRampOfframpResult, ApiRampOrder, ApiRampOverview } from "../src/types";
import { minskDate } from "../src/util/by-calendar";
import type { ErrorBody } from "../src/util/errors";
import { formatAmount, parseAmount } from "../src/util/money";
import { TEST_COLLATERAL, TEST_REWARDS, TEST_TREASURY, useTestApp } from "./helpers/app";
import { type Buyer, dec, nextKey, rampKit } from "./helpers/ramp";
import { bodyOf } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const ctx = useTestApp({
  env: {
    ADMIN_OPERATORS: operator.partyId,
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
    RAMP_RESERVE_GATE: "enforce",
    RAMP_PAYOUT_GATE: "enforce",
    RAMP_AUTO_HALT: "true",
  },
});
const k = rampKit(ctx, operator);
const recon = (): RampReconciliationService => ctx.get(RampReconciliationService);
const controls = (): RampControlsService => ctx.get(RampControlsService);

/** The bank statement S6 will provide; tests move its period end or drop the source. */
let statement: ReserveStatement | null = null;
let unregisterSource: (() => void) | null = null;
function reserveSource(on: boolean): void {
  if (on && !unregisterSource)
    unregisterSource = recon().registerReserveSource(async () => statement);
  if (!on && unregisterSource) {
    unregisterSource();
    unregisterSource = null;
  }
}

beforeEach(() => {
  k.mock().reset();
  statement = {
    statementId: "st-e2e",
    periodTo: minskDate(new Date()),
    closingBalance: parseAmount("1000"),
  };
  reserveSource(true);
});

/** The operator's money in the client account (RUNBOOK daily top-up): covers the PSP fees customers do not pay. */
async function topUp(amount: string): Promise<void> {
  await ctx.dataSource.transaction((m) =>
    ctx.get(RampJournalService).postEntry(m, {
      kind: "operator.topup",
      currency: "BYN",
      lines: [
        ["safeguard_bank", parseAmount(amount)],
        ["operator_money", -parseAmount(amount)],
      ],
    }),
  );
}

/** The operator's money swept out of the client account (the RUNBOOK sweep, as the bank ledger books it). */
async function sweep(amount: bigint): Promise<void> {
  await ctx.dataSource.transaction((m) =>
    ctx.get(RampJournalService).postEntry(m, {
      kind: "operator.sweep",
      currency: "BYN",
      lines: [
        ["operator_money", amount],
        ["safeguard_bank", -amount],
      ],
    }),
  );
}

/** The reserve headroom (A − L, Δ = 0) as the gate computes it now. */
async function headroom(): Promise<bigint> {
  return parseAmount(String((await ctx.get(RampGatesService).reserveSnapshot()).headroom));
}

/** The ledger index as of one offset: caught up, the treasury holding plenty of the instrument. */
async function seedIndex(holdings = "1000000"): Promise<void> {
  await ctx.dataSource.query(
    `INSERT INTO to_indexer_state (key, "offset", ledger_end) VALUES ('ledger', 10, 10)
     ON CONFLICT (key) DO UPDATE SET "offset" = 10, ledger_end = 10`,
  );
  await ctx.dataSource.query(
    `INSERT INTO to_ledger_holdings (contract_id, owner, instrument_admin, instrument_id, amount, created_offset)
     VALUES ('holding-e2e', $1, $2, $3, $4, 1)
     ON CONFLICT (contract_id) DO UPDATE SET amount = EXCLUDED.amount, archived_offset = NULL`,
    [TEST_TREASURY, TEST_COLLATERAL.admin, TEST_COLLATERAL.id, holdings],
  );
}

/** A fresh complete token sync pass and a fresh full reconciliation with no red check. */
async function greenLight(): Promise<void> {
  await seedIndex();
  await ctx.get(TokenAppSyncService).syncOnce("test");
  await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
  const run = await recon().runFull("admin");
  expect(
    run?.checks.filter((c) => c.status === "red").map((c) => `${c.name}: ${c.detail}`),
  ).toEqual([]);
}

async function adminPost(
  path: string,
  body: Record<string, unknown>,
  status: number,
): Promise<unknown> {
  return bodyOf<unknown>(
    await ctx.agent
      .post(`/api/v1/admin${path}`)
      .set(await k.adminHeaders())
      .send(body)
      .expect(status),
  );
}

async function offramp(
  b: Buyer,
  paymentMethodId: string,
  amount: string,
): Promise<ApiRampOfframpResult> {
  return bodyOf<ApiRampOfframpResult>(
    await ctx.agent
      .post("/api/v1/ramp/offramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount, destination: { kind: "card", paymentMethodId } })
      .expect(200),
  );
}

async function attach(b: Buyer, orderId: string, cid: string): Promise<ApiRampOrder> {
  return bodyOf<{ order: ApiRampOrder }>(
    await ctx.agent
      .post(`/api/v1/ramp/orders/${orderId}/attach`)
      .set(b.headers)
      .send({ pendingPayoutCid: cid })
      .expect(200),
  ).order;
}

function markPaids(orderId: string): number {
  return ctx.wallet.submits.filter((s) => {
    const json = JSON.stringify(s.commands);
    return json.includes('"choice":"MarkPaid"') && json.includes(`"txHash":"ramp:${orderId}"`);
  }).length;
}

async function payoutRow(cid: string): Promise<PayoutEntity> {
  return ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid });
}

describe("ramp controls (SPEC §6)", () => {
  it("an ops halt is immediate: no new orders, mints or payouts — cancels and burns still run; GET /ramp says paused without the reason; resume lifts it", async () => {
    await topUp("1000");
    await greenLight();
    const b = await k.buyer("halt");
    await k.bought(b, "100");
    await k.decayExposure();
    const card = await k.payoutCard(b);
    const checkout = await k.openOnramp(b, "20");
    // A cash-out whose burn token-app has not recorded yet (it stays `burning` until we let it land).
    const burning = await offramp(b, card.id, "30");
    const burnId = rampCommandId("burn", burning.order.id);
    ctx.tokenApp.unrecorded.add(burnId);
    await attach(b, burning.order.id, k.signWithdraw(b, "30"));
    await k.drive();
    expect((await k.order(burning.order.id)).status).toBe("burning");
    const waiting = await offramp(b, card.id, "10");

    const halted = (await adminPost(
      "/ramp/controls/halt",
      { scopes: ["orders", "mints", "payouts"], reason: "incident 7" },
      200,
    )) as { controls: Record<string, unknown> };
    expect(halted.controls).toMatchObject({
      haltedScopes: ["orders", "mints", "payouts"],
      source: "admin",
      reason: "incident 7",
    });
    const overview = bodyOf<ApiRampOverview>(
      await ctx.agent.get("/api/v1/ramp").set(b.headers).expect(200),
    );
    expect(overview.paused).toEqual({ orders: true, reason: null });
    for (const [path, body] of [
      ["/api/v1/ramp/onramp", { amount: "10" }],
      [
        "/api/v1/ramp/offramp",
        { amount: "10", destination: { kind: "card", paymentMethodId: card.id } },
      ],
    ] as const) {
      const refused = await ctx.agent
        .post(path)
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send(body)
        .expect(503);
      expect(bodyOf<ErrorBody>(refused).error).toBe("ramp_paused");
    }

    // mints: the open checkout is paid now — and waits in `paid`, no command written.
    await k.pay(b, checkout);
    await k.drive();
    expect(await k.order(checkout.order.id)).toMatchObject({
      status: "paid",
      mintCommandId: null,
      attempts: 0,
      lastError: "reserve_gate:mints_halted",
    });
    // burns always run (they reduce risk); the card payout after it waits (payouts halted).
    ctx.tokenApp.unrecorded.delete(burnId);
    await k.drive();
    expect(await k.order(burning.order.id)).toMatchObject({
      status: "paying_out",
      providerPayoutId: null,
      details: { hold: { reason: "payout_gate" } },
    });
    expect(k.mock().payoutsFor(burning.order.id)).toEqual([]);
    // payouts: MarkPaid of a newly signed withdrawal is deferred; the user may still cancel.
    const cidWait = k.signWithdraw(b, "10");
    await attach(b, waiting.order.id, cidWait);
    await k.drive();
    expect(await k.order(waiting.order.id)).toMatchObject({
      status: "withdrawing",
      details: { hold: { reason: "payout_gate" } },
    });
    expect(await payoutRow(cidWait)).toMatchObject({ status: "blocked_payout_gate" });
    expect(markPaids(waiting.order.id)).toBe(0);
    k.cancelPayout(b, cidWait);
    await k.drive();
    expect((await k.order(waiting.order.id)).status).toBe("cancelled");

    // Lifting is ramp.controls.resume (single control in this file: dual control off).
    const resumed = (await adminPost(
      "/ramp/controls/resume",
      { reason: "incident closed" },
      200,
    )) as {
      approval: { action: string; status: string };
    };
    expect(resumed.approval).toMatchObject({ action: "ramp.controls.resume", status: "executed" });
    expect((await controls().controls()).haltedScopes).toEqual([]);
    await greenLight();
    await k.drive();
    expect((await k.order(checkout.order.id)).status).toBe("completed");
    expect(await k.order(burning.order.id)).toMatchObject({
      status: "completed",
      details: { hold: null, holdEndedReason: "payout_gate" },
    });
    expect(
      await ctx.dataSource
        .getRepository(AuditEventEntity)
        .count({ where: { action: "ramp.controls.halted" } }),
    ).toBe(1);
    await k.expectIdentities();
  });

  it("an unknown token-app record found by a sync pass halts everything at once (I9, X8)", async () => {
    await topUp("1000");
    await greenLight();
    ctx.tokenApp.extraRecords.push({
      kind: "mint",
      commandId: "intruder-mint",
      updateId: "update-intruder",
      partyId: "attacker::1220" + "9".repeat(64),
      instrumentId: TEST_COLLATERAL.id,
      amount: parseAmount("5000"),
      createdAt: new Date(),
    });
    await ctx.get(TokenAppSyncService).syncOnce("test");
    expect(await controls().controls()).toMatchObject({
      haltedScopes: ["orders", "mints", "payouts"],
      source: "auto",
      failingChecks: expect.arrayContaining([
        expect.objectContaining({ name: "token_records_known" }),
      ]) as unknown,
    });
    const syncRun = await ctx.dataSource
      .getRepository(RampReconRunEntity)
      .findOneOrFail({ where: { trigger: "sync" }, order: { startedAt: "DESC" } });
    expect(syncRun).toMatchObject({ status: "red", halted: true });
    expect(syncRun.checks.find((c) => c.name === "token_records_known")).toMatchObject({
      status: "red",
      figures: { unknownRecords: 1, unknownNet: dec("5000") },
    });
    expect(await ctx.get(RampGatesService).payoutGate()).toMatchObject({
      ok: false,
      reason: "payouts_halted",
    });
    const b = await k.buyer("blocked");
    const refused = await ctx.agent
      .post("/api/v1/ramp/onramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount: "10" })
      .expect(503);
    expect(bodyOf<ErrorBody>(refused).error).toBe("ramp_paused");
    expect(
      await ctx.dataSource
        .getRepository(AuditEventEntity)
        .count({ where: { action: "ramp.recon.red", subjectId: "token_records_known" } }),
    ).toBe(1);
  });

  it("enforce without a reserve source: the mint fails reserve_gate:statement_stale and waits in paid; the reconciliation is red, never skipped; a stale statement is refused too", async () => {
    await topUp("1000");
    await greenLight();
    reserveSource(false);
    const b = await k.buyer("stale");
    const res = await k.openOnramp(b, "25");
    await k.pay(b, res);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "paid",
      mintCommandId: null,
      attempts: 0,
      lastError: "reserve_gate:statement_stale",
    });
    expect(await k.commands(res.order.id)).toEqual([]);
    expect(ctx.tokenApp.minted).toEqual([]);
    expect(
      Object.keys(await k.journal(res.order.id)).some((x) => x.startsWith("onramp.minted")),
    ).toBe(false);

    // The check is red under enforce (X5) and halts mints — a reserve-only halt: re-mints still pass.
    await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
    const run = await recon().runFull("admin");
    expect(run?.checks.find((c) => c.name === "reserve_covers_liabilities")).toMatchObject({
      status: "red",
      detail: expect.stringContaining("statement_stale") as string,
    });
    expect((await controls().controls()).haltedScopes).toEqual(["mints"]);
    expect(await controls().mintsHalted("mint")).toBe(true);
    expect(await controls().mintsHalted("remint")).toBe(false);

    // A statement whose period ended more than RAMP_RESERVE_MAX_AGE_BDAYS business days ago is stale as well.
    reserveSource(true);
    const gates = ctx.get(RampGatesService);
    statement = {
      statementId: "st-old",
      periodTo: gates.calendar.subtractBusinessDays(minskDate(new Date()), 3),
      closingBalance: parseAmount("1000"),
    };
    expect(await gates.statementStatus()).toMatchObject({ ok: false, reason: "statement_stale" });
    statement = {
      ...statement,
      periodTo: gates.calendar.subtractBusinessDays(minskDate(new Date()), 2),
    };
    expect(await gates.statementStatus()).toMatchObject({ ok: true, ageBdays: 2 });
    await k.expectIdentities();
  });

  it("the payout gate defers MarkPaid while no fresh full reconciliation exists; once fresh, MarkPaid runs and the cash-out completes", async () => {
    await topUp("1000");
    await greenLight();
    const b = await k.buyer("gate");
    await k.bought(b, "60");
    await k.decayExposure();
    const card = await k.payoutCard(b);
    const off = await offramp(b, card.id, "40");
    const cid = k.signWithdraw(b, "40");
    await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
    await attach(b, off.order.id, cid);
    await k.drive();
    expect(await k.order(off.order.id)).toMatchObject({
      status: "withdrawing",
      burnCommandId: null,
      details: { hold: { reason: "payout_gate" } },
    });
    expect(await payoutRow(cid)).toMatchObject({
      status: "blocked_payout_gate",
      lastError: expect.stringContaining("recon_missing") as string,
    });
    expect(markPaids(off.order.id)).toBe(0);

    await greenLight();
    // The payout scan retries a blocked_payout_gate row by itself (like a card hold).
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(markPaids(off.order.id)).toBe(1);
    expect(await k.order(off.order.id)).toMatchObject({
      status: "completed",
      details: { hold: null },
    });
    expect(await k.journal(off.order.id)).toMatchObject({
      "offramp.burned:customer_liability": dec("40"),
      "offramp.paid_card:payout_clearing": dec("40"),
    });
    await k.expectIdentities();
  });

  it("a red treasury check (holdings below the in-app liabilities) halts everything", async () => {
    await topUp("1000");
    await greenLight();
    ctx.ledger.seedPendingPayout({
      user: "someone::1220" + "8".repeat(64),
      amount: "50",
      reason: "withdraw",
      instrument: TEST_COLLATERAL,
      marketId: "0",
    });
    await k.indexPayouts();
    await seedIndex("10");
    await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
    const run = await recon().runFull("admin");
    expect(run?.checks.find((c) => c.name === "treasury_covers_in_app")).toMatchObject({
      status: "red",
      figures: { holdings: dec("10"), livePayouts: dec("50"), offset: 10 },
    });
    expect(await controls().controls()).toMatchObject({
      haltedScopes: ["orders", "mints", "payouts"],
      source: "auto",
    });
  });

  it("compensation restores its order: a mint recorded with the wrong amount → mismatch → review; the compensating burn lands → onramp.minted with N once, crediting, completed", async () => {
    await topUp("1000");
    await greenLight();
    const b = await k.buyer("comp");
    const res = await k.openOnramp(b, "30");
    const mintId = rampCommandId("mint", res.order.id);
    // The POST's answer is lost and token-app records 31 instead of 30.
    ctx.tokenApp.nextPost = {
      outcome: {
        outcome: "unknown",
        httpStatus: 0,
        status: null,
        code: "upstream_failed",
        message: "timeout",
      },
      lands: false,
    };
    ctx.tokenApp.extraRecords.push({
      kind: "mint",
      commandId: mintId,
      updateId: "update-wrong-amount",
      partyId: TEST_TREASURY,
      instrumentId: TEST_COLLATERAL.id,
      amount: parseAmount("31"),
      createdAt: new Date(),
    });
    await k.pay(b, res);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "mint",
    });
    expect(await k.commands(res.order.id)).toMatchObject([
      {
        commandId: mintId,
        status: "mismatch",
        lastError: expect.stringMatching(/^mismatch:amount_mismatch/) as string,
      },
    ]);
    // The sync pass saw the mismatch: everything halted at once.
    expect((await controls().controls()).haltedScopes).toEqual(["orders", "mints", "payouts"]);

    const out = (await adminPost(
      `/tokens/commands/${mintId}/compensate`,
      { reason: "token-app minted 31" },
      200,
    )) as {
      approval: { action: string; status: string };
      result: { compensation: { commandId: string; kind: string; status: string } };
    };
    const compId = compensationCommandId(mintId);
    expect(out.approval).toMatchObject({ action: "token.command.compensate", status: "executed" });
    expect(out.result.compensation).toMatchObject({
      commandId: compId,
      kind: "burn",
      status: "submitted",
    });
    expect(ctx.tokenApp.burned).toEqual([
      expect.objectContaining({ commandId: compId, amount: parseAmount("1") }),
    ]);
    await ctx.get(TokenAppSyncService).syncOnce("test");
    expect((await k.order(res.order.id)).status).toBe("crediting");
    // Credits of a recorded mint always run, even halted.
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.minted:issuance_pending": dec("30"),
      "onramp.minted:customer_liability": dec("-30"),
    });
    expect(ctx.ledger.walletOf(b.wallet.partyId)?.balance).toBe(parseAmount("30"));
    await k.expectIdentities();
    await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
    const run = await recon().runFull("admin");
    expect(run?.checks.find((c) => c.name === "token_commands_consistent")?.status).toBe("green");
    expect(run?.checks.find((c) => c.name === "issuance_matches_liability")?.status).toBe("green");
  });
  it("an on-demand run answers the run that finished under a minute ago instead of starting another", async () => {
    await topUp("1000");
    await greenLight();
    const headers = await k.adminHeaders();
    const first = bodyOf<{ run: { id: string; trigger: string } }>(
      await ctx.agent
        .post("/api/v1/admin/ramp/reconciliation/run")
        .set(headers)
        .send({})
        .expect(200),
    );
    const second = bodyOf<{ run: { id: string } }>(
      await ctx.agent
        .post("/api/v1/admin/ramp/reconciliation/run")
        .set(headers)
        .send({})
        .expect(200),
    );
    expect(second.run.id).toBe(first.run.id);
    const view = bodyOf<{
      run: { id: string };
      running: boolean;
      reserve: Record<string, unknown>;
    }>(await ctx.agent.get("/api/v1/admin/ramp/reconciliation").set(headers).expect(200));
    expect(view).toMatchObject({
      run: { id: first.run.id },
      running: false,
      reserve: { assets: dec("1000"), gate: "enforce", statementFresh: true },
    });
  });
});

describe("the reserve gate refuses for lack of reserve, the daily cap and the re-mint Δ (SPEC §6.3, C18)", () => {
  it("reserve_short: a capture the reserve does not cover waits in paid with no command; a top-up to headroom exactly 0 lets it mint", async () => {
    // No operator top-up: the 2.40 PSP fee on a 100 capture (240 bps, customer fee 0) is unfunded.
    await greenLight();
    const b = await k.buyer("short");
    const res = await k.openOnramp(b, "100");
    await k.pay(b, res);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "paid",
      mintCommandId: null,
      attempts: 0,
      lastError: "reserve_gate:reserve_short",
    });
    expect(await k.commands(res.order.id)).toEqual([]);
    expect(ctx.tokenApp.minted).toEqual([]);
    expect(await headroom()).toBe(parseAmount("-2.4"));

    // L_after = A exactly passes (≤, not <).
    await topUp("2.4");
    expect(await headroom()).toBe(0n);
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(ctx.tokenApp.minted.map((m) => m.commandId)).toEqual([
      rampCommandId("mint", res.order.id),
    ]);
    await k.expectIdentities();
  });

  it("S counts every source and U the unresolved non-ramp mints: an admin mint of the ramp instrument eats the headroom", async () => {
    await topUp("2.4");
    await greenLight();
    const b = await k.buyer("supply");
    const tokens = ctx.get(TokenCommandService);
    // 1 cBYN minted outside the ramp, not sent yet: U = 1.
    await ctx.dataSource.transaction((m) =>
      tokens.recordIntent(m, {
        commandId: "admin-mint-c18",
        kind: "mint",
        instrument: TEST_COLLATERAL,
        party: TEST_TREASURY,
        amount: parseAmount("1"),
        source: "admin",
        ref: null,
      }),
    );
    const res = await k.openOnramp(b, "100");
    await k.pay(b, res);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "paid",
      lastError: "reserve_gate:reserve_short",
    });
    // Sent and recorded: it now counts in S (recorded net of every source), still short.
    await tokens.submit("admin-mint-c18");
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "paid",
      mintCommandId: null,
      lastError: "reserve_gate:reserve_short",
    });
    expect((await ctx.get(RampGatesService).reserveSnapshot()).recordedSupply).toBe(dec("1"));
    await topUp("1");
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
  });

  it("daily_cap: rolling-24 h ramp mints + N above RAMP_MINT_DAILY_CAP wait in paid with no command; at exactly the cap they mint", async () => {
    await topUp("1000");
    await greenLight();
    const cfg = ctx.config.rampControls as { mintDailyCap: bigint | null };
    cfg.mintDailyCap = parseAmount("50");
    try {
      const b = await k.buyer("cap");
      await k.bought(b, "30");
      const res = await k.openOnramp(b, "30");
      await k.pay(b, res);
      await k.drive();
      expect(await k.order(res.order.id)).toMatchObject({
        status: "paid",
        mintCommandId: null,
        attempts: 0,
        lastError: "reserve_gate:daily_cap",
      });
      expect(await k.commands(res.order.id)).toEqual([]);
      // 30 + 30 = 60: refused at 59.99, minted at 60 (the cap is inclusive).
      cfg.mintDailyCap = parseAmount("59.99");
      await k.drive();
      expect((await k.order(res.order.id)).lastError).toBe("reserve_gate:daily_cap");
      cfg.mintDailyCap = parseAmount("60");
      await k.drive();
      expect((await k.order(res.order.id)).status).toBe("completed");
    } finally {
      cfg.mintDailyCap = null;
    }
  });

  it("re-mint Δ = T − P: a failed card payout with a fee re-mints T only when the reserve covers it (headroom −0.01 → reserve_short; +0.01 → ramp-remint-<h>)", async () => {
    await topUp("1000");
    await greenLight();
    const rail = ctx.config.ramp.rail.card as { feeBps: number };
    rail.feeBps = 100;
    try {
      k.mock().cardCashoutMode = "oct";
      const b = await k.buyer("remint");
      await k.bought(b, "50");
      await k.decayExposure();
      k.mock().payoutBehaviour = "fail";
      const card = await k.payoutCard(b);
      const off = await offramp(b, card.id, "50");
      const order = await k.order(off.order.id);
      expect([formatAmount(order.tokenAmount), formatAmount(order.fiatAmount)]).toEqual([
        dec("50"),
        dec("49.5"),
      ]);
      // The burn takes T = 50 out of S and puts P = 49.50 into PO (L − 0.50); the re-mint puts T
      // back (Δ = 0.50). Leave the reserve 0.01 short of that.
      await sweep((await headroom()) + parseAmount("0.01"));
      expect(await headroom()).toBe(parseAmount("-0.01"));
      await attach(b, off.order.id, k.signWithdraw(b, "50"));
      await k.drive(6);
      expect(await k.order(off.order.id)).toMatchObject({
        status: "reversing",
        remintCommandId: null,
        lastError: "reserve_gate:reserve_short",
      });
      expect(ctx.tokenApp.minted.map((m) => m.commandId)).not.toContain(
        rampCommandId("remint", off.order.id),
      );
      // Without Δ the gate would have seen 0.49 of headroom and re-minted.
      expect(await headroom()).toBe(parseAmount("0.49"));

      await topUp("0.01");
      await k.drive(6);
      expect(await k.order(off.order.id)).toMatchObject({
        status: "refunded",
        remintCommandId: rampCommandId("remint", off.order.id),
      });
      expect(ctx.tokenApp.minted.map((m) => m.commandId)).toContain(
        rampCommandId("remint", off.order.id),
      );
      await k.expectIdentities();
    } finally {
      rail.feeBps = 0;
    }
  });
});

describe("ops review fixes: other instruments, a stalled index, the stuck-order scan (C16, C30, C45)", () => {
  it("C16: a 403 on another instrument's records neither closes the payout gate nor turns the ramp's token checks unknown, and pages no credential alarm; an amber report-only check names it", async () => {
    await topUp("1000");
    await greenLight();
    // A rewards-instrument admin mint token-app refused (403): the client is scoped to cBYN only,
    // and every page of that instrument answers 403 from now on.
    const tokens = ctx.get(TokenCommandService);
    await ctx.dataSource.transaction((m) =>
      tokens.recordIntent(m, {
        commandId: "tro-admin-c16",
        kind: "mint",
        instrument: TEST_REWARDS,
        party: TEST_TREASURY,
        amount: parseAmount("10"),
        source: "admin",
        ref: null,
      }),
    );
    ctx.tokenApp.nextPost = {
      outcome: {
        outcome: "rejected",
        httpStatus: 403,
        status: null,
        code: "token_app_forbidden",
        message: "not scoped",
      },
      lands: false,
    };
    expect((await tokens.submit("tro-admin-c16")).status).toBe("rejected");
    const list = ctx.tokenApp.listRecords.bind(ctx.tokenApp);
    const scoped = jest
      .spyOn(ctx.tokenApp, "listRecords")
      .mockImplementation((kind, filter) =>
        filter.instrumentId === TEST_REWARDS.id
          ? Promise.reject(new Error("token-app failed (403)"))
          : list(kind, filter),
      );
    const sentry = jest.spyOn(ctx.get(SentryService), "captureMessage");
    try {
      const pass = await ctx.get(TokenAppSyncService).syncOnce("test");
      expect(pass).toMatchObject({ complete: true, error: null, allComplete: false });
      expect(pass.instruments.find((i) => i.instrumentId === TEST_REWARDS.id)).toMatchObject({
        complete: false,
        error: "token-app failed (403)",
      });
      expect(await ctx.get(TokenAppSyncService).lastPassSummary()).toMatchObject({
        complete: true,
        error: null,
        instruments: expect.arrayContaining([
          { instrumentId: TEST_REWARDS.id, complete: false, error: "token-app failed (403)" },
        ]) as unknown,
      });
      expect(await ctx.get(RampGatesService).payoutGate()).toEqual({ ok: true, warnings: [] });
      const syncRun = await ctx.dataSource
        .getRepository(RampReconRunEntity)
        .findOneOrFail({ where: { trigger: "sync" }, order: { startedAt: "DESC" } });
      for (const name of ["token_records_known", "token_commands_consistent"])
        expect(syncRun.checks.find((c) => c.name === name)?.status).toBe("green");
      expect(sentry.mock.calls.filter(([message]) => /credential/.test(String(message)))).toEqual(
        [],
      );

      await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
      const run = await recon().runFull("admin");
      expect(run?.checks.find((c) => c.name === "token_sync_other_instruments")).toMatchObject({
        status: "amber",
        detail: expect.stringContaining(`${TEST_REWARDS.id}: token-app failed (403)`) as string,
      });
      for (const name of ["token_records_known", "token_commands_consistent"])
        expect(run?.checks.find((c) => c.name === name)?.status).toBe("green");
      expect((await controls().controls()).haltedScopes).toEqual([]);
    } finally {
      scoped.mockRestore();
      sentry.mockRestore();
    }
    // Readable again: the report-only check clears with the next pass.
    await ctx.get(TokenAppSyncService).syncOnce("test");
    await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
    const after = await recon().runFull("admin");
    expect(after?.checks.find((c) => c.name === "token_sync_other_instruments")?.status).toBe(
      "green",
    );
  });

  it("C30: treasury_covers_in_app reads the live ledger end — a stalled index (cached end = offset) or an unreadable participant is unknown and closes the payout gate", async () => {
    await topUp("1000");
    await greenLight();
    const treasury = async () => {
      await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
      const run = await recon().runFull("admin");
      return run?.checks.find((c) => c.name === "treasury_covers_in_app");
    };
    expect((await treasury())?.status).toBe("green");
    // The indexer stopped at offset 10 (to_indexer_state still says ledger_end = 10); the
    // participant is at 500.
    ctx.stream.end = 500;
    expect(await treasury()).toMatchObject({
      status: "unknown",
      detail: "the ledger index is 490 offsets behind the ledger end",
      figures: { offset: 10, ledgerEnd: 500, lag: 490 },
    });
    expect(await ctx.get(RampGatesService).payoutGate()).toMatchObject({
      ok: false,
      reason: "recon_unknown",
    });
    ctx.stream.end = null;
    const down = jest
      .spyOn(ctx.stream, "ledgerEnd")
      .mockRejectedValue(new Error("ledger token refused (401)"));
    try {
      expect(await treasury()).toMatchObject({
        status: "unknown",
        detail: "the ledger end could not be read: ledger token refused (401)",
      });
    } finally {
      down.mockRestore();
    }
    ctx.stream.configured = false;
    expect(await treasury()).toMatchObject({
      status: "unknown",
      detail: "no participant to check the ledger index against",
    });
  });

  it("C45: no_stuck_orders filters before its LIMIT — 520 in-window payout_sent and 100 held withdrawals cannot hide a paying_out order stuck for 3 h", async () => {
    await topUp("1000");
    await greenLight();
    const b = await k.buyer("stuckscan");
    await k.bought(b, "60");
    await k.decayExposure();
    const card = await k.payoutCard(b);
    const template = await offramp(b, card.id, "10");
    const clone = (status: string, n: number, age: string, details: string, from: number) =>
      ctx.dataSource.query(
        `INSERT INTO to_ramp_orders (user_id, direction, status, provider, instrument_admin, instrument_id,
           party_id, fiat_currency, fiat_amount, token_amount, fee_amount, idempotency_key, request_hash,
           payout_rail, payout_reference, operator, details, status_changed_at)
         SELECT user_id, direction, $2, provider, instrument_admin, instrument_id, party_id, fiat_currency,
                fiat_amount, token_amount, fee_amount, 'c45-' || g, lpad(to_hex(g), 64, '0'), payout_rail,
                'TO9' || lpad(g::text, 11, '0'), operator, $5::jsonb, now() - $4::interval
           FROM to_ramp_orders o, generate_series($6::int, $6::int + $3::int - 1) g WHERE o.id = $1`,
        [template.order.id, status, n, age, details, from],
      );
    // Waiting on purpose, all older than the stuck order: bank payouts inside the settle window
    // and withdrawals held by a compliance hold (no time limit).
    await clone("payout_sent", 520, "20 hours", "{}", 1);
    await clone("withdrawing", 100, "2 days", `{"hold": {"reason": "compliance"}}`, 1000);
    await clone("paying_out", 1, "3 hours", "{}", 2000);
    await ctx.dataSource.query(`UPDATE to_ramp_orders SET status = 'cancelled' WHERE id = $1`, [
      template.order.id,
    ]);
    const check = await ctx.get(RampReconChecks).stuckOrders();
    expect(check).toMatchObject({
      status: "amber",
      figures: { stuck: 1, byStatus: { paying_out: 1 }, truncated: false },
    });
    expect(check.detail).toMatch(
      /^1 order\(s\) past their expected time: paying_out for over 30 min/,
    );
  });
});

describe("review group A: the scan under a backlog (C17)", () => {
  /**
   * `n` copies of on-ramp `templateId` waiting in `paid` (no acquirer payment: they cannot mint),
   * last written a day ago — older than anything else, so an oldest-first read meets them first.
   */
  async function waitingCaptures(templateId: string, n: number): Promise<string[]> {
    const rows = await ctx.dataSource.query<{ id: string }[]>(
      `INSERT INTO to_ramp_orders (user_id, direction, status, provider, instrument_admin, instrument_id,
         party_id, fiat_currency, fiat_amount, token_amount, fee_amount, idempotency_key, request_hash,
         method, payout_reference, operator, details, last_error, status_changed_at, created_at, updated_at)
       SELECT user_id, direction, 'paid', provider, instrument_admin, instrument_id, party_id, fiat_currency,
              fiat_amount, token_amount, fee_amount, 'c17-' || g, lpad(to_hex(g), 64, '0'), method,
              'TO8' || lpad(g::text, 11, '0'), operator, '{}'::jsonb, 'reserve_gate:mints_halted',
              now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'
         FROM to_ramp_orders o, generate_series(1, $2::int) g WHERE o.id = $1
       RETURNING id`,
      [templateId, n],
    );
    return rows.map((r) => r.id);
  }

  /** A card on-ramp whose mint token-app recorded: `crediting`, which only the scan moves on. */
  async function toCredit(hint: string): Promise<string> {
    const b = await k.buyer(hint);
    const res = await k.openOnramp(b, "25");
    await k.pay(b, res);
    await ctx.get(TokenAppSyncService).syncOnce("test");
    expect((await k.order(res.order.id)).status).toBe("crediting");
    return res.order.id;
  }

  it("C17: a mints halt with more captures waiting in paid than one scan batch holds starves no other queue — the recorded mint is credited in the same pass — and no waiting capture is read from the acquirer", async () => {
    await topUp("1000");
    await greenLight();
    const crediting = await toCredit("c17-halt");
    const stuck = await waitingCaptures(crediting, 120);
    await controls().halt(["mints"], "e2e backlog", { type: "system" });
    // One real capture caught by the halt, as old as the backlog: the acquirer is not asked about it.
    const b = await k.buyer("c17-real");
    const blocked = await k.openOnramp(b, "10");
    await k.pay(b, blocked);
    expect(await k.order(blocked.order.id)).toMatchObject({
      status: "paid",
      lastError: "reserve_gate:mints_halted",
    });
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET updated_at = now() - interval '2 days' WHERE id = $1`,
      [blocked.order.id],
    );
    const reads = jest.spyOn(k.mock(), "getPayment");
    const advance = jest.spyOn(k.fulfilment(), "advance");
    try {
      await k.fulfilment().scan();
      expect(reads).not.toHaveBeenCalled();
      // Under the halt `paid` is not even visited (its refusal was recorded once, by the webhook).
      expect(
        advance.mock.calls
          .map(([id]) => id)
          .filter((id) => id === blocked.order.id || stuck.includes(id)),
      ).toEqual([]);
    } finally {
      reads.mockRestore();
      advance.mockRestore();
    }
    expect((await k.order(crediting)).status).toBe("completed");
    expect(
      await ctx.dataSource.query(
        `SELECT count(*)::int AS n FROM to_ramp_orders WHERE id = ANY($1) AND status = 'paid' AND version = 0`,
        [stuck],
      ),
    ).toEqual([{ n: 120 }]);
  });

  it("C17: without a halt, a backlog in paid is read one bounded batch per status per pass, each pass going on where the last stopped — every waiting order is visited, and the other queues still run", async () => {
    await topUp("1000");
    await greenLight();
    const crediting = await toCredit("c17-rot");
    const stuck = await waitingCaptures(crediting, 130);
    const advance = jest.spyOn(k.fulfilment(), "advance");
    const visited = new Set<string>();
    try {
      await k.fulfilment().scan();
      expect((await k.order(crediting)).status).toBe("completed");
      for (const [id] of advance.mock.calls) visited.add(id);
      expect(stuck.filter((id) => visited.has(id))).toHaveLength(100);
      await k.fulfilment().scan();
      for (const [id] of advance.mock.calls) visited.add(id);
    } finally {
      advance.mockRestore();
    }
    expect(stuck.filter((id) => !visited.has(id))).toEqual([]);
  });

  it("C17: a capture the reserve gate refuses (the daily cap) is refused before the acquirer is read — a waiting capture costs no acquirer call per pass", async () => {
    await topUp("1000");
    await greenLight();
    const cfg = ctx.config.rampControls as { mintDailyCap: bigint | null };
    cfg.mintDailyCap = parseAmount("50");
    try {
      const b = await k.buyer("c17-gate");
      await k.bought(b, "30");
      const res = await k.openOnramp(b, "30");
      await k.pay(b, res);
      expect(await k.order(res.order.id)).toMatchObject({
        status: "paid",
        lastError: "reserve_gate:daily_cap",
      });
      const paymentId = k.paymentIdOf(res);
      const reads = jest.spyOn(k.mock(), "getPayment");
      try {
        await k.drive(3);
        expect(reads.mock.calls.filter(([id]) => id === paymentId)).toEqual([]);
      } finally {
        reads.mockRestore();
      }
      cfg.mintDailyCap = null;
      await k.drive();
      expect((await k.order(res.order.id)).status).toBe("completed");
    } finally {
      cfg.mintDailyCap = null;
    }
  });
});
