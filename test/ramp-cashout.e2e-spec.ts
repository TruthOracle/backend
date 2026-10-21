/**
 * Ramp v2 core money correctness, cash-out side (SPEC §4.1, §4.2; money-core.md §7): MarkPaid
 * counts only with ledger proof (C1), payout lookups before every createPayout and before a
 * reversal (C3, #3), the card exposure re-checked with the live amount before MarkPaid (H2), no
 * re-mint for a burn that never landed and the credit-back path (H3, #1), account re-checks and
 * chargeback holds on open cash-outs (M2, E-D3), the withdrawing deadline (M8), the payee party
 * on the binding (L2), and `fail` that never strands a user's tokens (#1). Every scenario checks
 * order status, journal and token commands together, then the journal identities.
 */
import { DepositCreditEntity } from "../src/entities/deposit-credit.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { RampPaymentMethodEntity } from "../src/entities/ramp-payment-method.entity";
import { WalletEntity } from "../src/entities/wallet.entity";
import { mintCreditCommandId } from "../src/services/deposit.service";
import { PayoutService } from "../src/services/payout.service";
import { rampCommandId } from "../src/services/ramp-fulfilment.service";
import { SentryService } from "../src/services/sentry.service";
import type { TokenAppPostOutcome } from "../src/services/token-app.service";
import { UserService } from "../src/services/user.service";
import type {
  ApiAdminRampOrder,
  ApiRampAttachResult,
  ApiRampOfframpResult,
  ApiRampOrder,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { parseAmount } from "../src/util/money";
import { TEST_COLLATERAL, useTestApp } from "./helpers/app";
import { dec, nextKey, rampKit, type Buyer } from "./helpers/ramp";
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
  },
});
const k = rampKit(ctx, operator);
const SYSTEM = { type: "system" as const };

beforeEach(() => {
  k.mock().reset();
  // This suite covers the OCT path (createPayout and its lookups, C3 / #3) — a non-refund exit, so
  // the card exposure applies; the refund-mode cash-out is in ramp-methods.e2e-spec.ts.
  k.mock().cardCashoutMode = "oct";
});

/** An order action as an approval (RAMP_DUAL_CONTROL=false in tests: it executes at once → its result). */
async function admin(
  orderId: string,
  action: string,
  status = 200,
): Promise<ApiAdminRampOrder | ErrorBody> {
  const body = bodyOf<{ result?: ApiAdminRampOrder } & ErrorBody>(
    await ctx.agent
      .post(`/api/v1/admin/ramp/orders/${orderId}/${action}`)
      .set(await k.adminHeaders())
      .send({ reason: `e2e ${action}` })
      .expect(status),
  );
  return status === 200 && body.result ? body.result : body;
}

/** A KYC'd buyer holding `held` bought by card (outside the exposure window), with an open cash-out of `amount` to that card. */
async function cashOut(
  hint: string,
  held: string,
  amount: string,
): Promise<{ b: Buyer; res: ApiRampOfframpResult }> {
  const b = await k.buyer(hint);
  await k.bought(b, held);
  await k.decayExposure();
  const card = await k.payoutCard(b);
  const res = bodyOf<ApiRampOfframpResult>(
    await ctx.agent
      .post("/api/v1/ramp/offramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount, destination: { kind: "card", paymentMethodId: card.id } })
      .expect(200),
  );
  return { b, res };
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

function post(
  outcome: TokenAppPostOutcome["outcome"],
  httpStatus: number,
  code: TokenAppPostOutcome["code"],
  lands: boolean,
): { outcome: TokenAppPostOutcome; lands: boolean } {
  return { outcome: { outcome, httpStatus, status: null, code, message: code ?? "ok" }, lands };
}

/** MarkPaid submissions for cash-out `orderId` (`txHash = ramp:<id>`). */
function markPaids(orderId: string): number {
  return ctx.wallet.submits.filter((s) => {
    const json = JSON.stringify(s.commands);
    return json.includes('"choice":"MarkPaid"') && json.includes(`"txHash":"ramp:${orderId}"`);
  }).length;
}

describe("ramp cash-out: MarkPaid proof, payout lookups, reversals (C1, C3, #3, H3, #1)", () => {
  it("C1: the wallet still says 'submitted' while the user's CancelPayout archived the PendingPayout → cancelled; nothing burned or paid", async () => {
    const { b, res } = await cashOut("c1", "30", "30");
    const cid = k.signWithdraw(b, "30");
    ctx.wallet.lagLedger = true;
    expect((await attach(b, res.order.id, cid)).status).toBe("withdrawing");
    const row = await ctx.dataSource
      .getRepository(PayoutEntity)
      .findOneByOrFail({ pendingPayoutCid: cid });
    expect(
      await ctx.wallet.commandStatus(ctx.config.treasuryPartyId, row.markPaidCommandId ?? ""),
    ).toMatchObject({
      known: true,
      submitted: true,
      status: "submitted",
    });
    // The user's own CancelPayout archives the contract (T back in the wallet); our MarkPaid never runs.
    k.cancelPayout(b, cid);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "cancelled",
      burnCommandId: null,
      providerPayoutId: null,
    });
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({
      status: "archived",
    });
    expect(ctx.tokenApp.burned).toEqual([]);
    expect(k.mock().payoutsFor(res.order.id)).toEqual([]);
    expect(await k.journal(res.order.id)).toEqual({});
    expect(ctx.ledger.walletOf(b.wallet.partyId)?.balance).toBe(parseAmount("30"));
    await k.expectIdentities();
  });

  it("C3 / #3: a payout created while its answer timed out is found by merchant reference — reverse is refused, retry adopts it, the card is paid once", async () => {
    const { b, res } = await cashOut("c3", "50", "50");
    const cid = k.signWithdraw(b, "50");
    await attach(b, res.order.id, cid);
    k.mock().payoutTimeouts = 1;
    await k.drive(2);
    let o = await k.order(res.order.id);
    expect(o).toMatchObject({ status: "paying_out", providerPayoutId: null, attempts: 1 });
    expect(k.mock().payoutsFor(res.order.id)).toHaveLength(1);
    // The card becomes ineligible before the next pass: review with no payout id recorded.
    await ctx.dataSource
      .getRepository(RampPaymentMethodEntity)
      .update({ userId: b.user.id }, { status: "blocked" });
    await k.drive(1);
    o = await k.order(res.order.id);
    expect(o).toMatchObject({
      status: "needs_review",
      reviewStep: "payout",
      providerPayoutId: null,
    });
    // The acquirer holds a payout under this order: no reversal (that would re-mint T AND pay P).
    expect(await admin(res.order.id, "reverse", 409)).toMatchObject({
      error: "ramp_order_state",
      details: { payoutId: k.mock().payoutsFor(res.order.id)[0].payoutId },
    });
    // Its idempotency memory expired: a blind createPayout would pay again; the lookup adopts the first.
    k.mock().forgetIdempotencyKeys();
    await ctx.dataSource
      .getRepository(RampPaymentMethodEntity)
      .update({ userId: b.user.id }, { status: "active" });
    expect(await admin(res.order.id, "retry")).toMatchObject({ status: "completed" });
    expect(k.mock().payoutsFor(res.order.id)).toHaveLength(1);
    expect((await k.order(res.order.id)).providerPayoutId).toBe(
      k.mock().payoutsFor(res.order.id)[0].payoutId,
    );
    expect(await k.journal(res.order.id)).toMatchObject({
      "offramp.paid_card:payout_clearing": dec("50"),
      "offramp.paid_card:provider_clearing": dec("-50"),
    });
    await k.expectIdentities();
  });

  it("a payout lookup the acquirer cannot answer sends nothing (fail closed, I7)", async () => {
    const { b, res } = await cashOut("lookup", "20", "20");
    await attach(b, res.order.id, k.signWithdraw(b, "20"));
    k.mock().lookupFailure = new Error("acquirer down");
    await k.drive(3);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "paying_out",
      providerPayoutId: null,
      attempts: 0,
      lastError: expect.stringContaining("payout lookup failed") as string,
    });
    expect(k.mock().payoutsFor(res.order.id)).toEqual([]);
    k.mock().lookupFailure = null;
    await k.drive(1);
    expect((await k.order(res.order.id)).status).toBe("completed");
    await k.expectIdentities();
  });

  it("H3 / #1: a burn token-app refused never re-mints — reverse is refused; credit_back Deposits T from the treasury, posting nothing", async () => {
    const { b, res } = await cashOut("h3", "40", "40");
    const cid = k.signWithdraw(b, "40");
    await attach(b, res.order.id, cid);
    ctx.tokenApp.nextPost = post("rejected", 403, "token_app_forbidden", false);
    await k.drive();
    const burnId = rampCommandId("burn", res.order.id);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "burn",
      burnCommandId: burnId,
      details: { reviewFrom: "burning" },
    });
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: burnId, kind: "burn", status: "rejected", attempts: 1 },
    ]);
    expect(ctx.tokenApp.burned).toEqual([]);
    expect(await admin(res.order.id, "reverse", 409)).toMatchObject({ error: "ramp_order_state" });
    expect(await admin(res.order.id, "fail", 409)).toMatchObject({ error: "ramp_order_state" });
    expect(await admin(res.order.id, "credit_back")).toMatchObject({ status: "refunded" });
    const creditId = rampCommandId("creditback", res.order.id);
    expect(ctx.ledger.walletOf(b.wallet.partyId)).toMatchObject({
      balance: parseAmount("40"),
      creditRefs: expect.arrayContaining([`mint:${creditId}`]) as string[],
    });
    expect(ctx.tokenApp.minted.map((m) => m.commandId)).not.toContain(
      rampCommandId("remint", res.order.id),
    );
    expect(await k.journal(res.order.id)).toEqual({});
    expect(await admin(res.order.id, "credit_back", 409)).toMatchObject({
      error: "ramp_order_state",
    });
    await k.expectIdentities();
  });

  it("#1: fail is refused once MarkPaid may have run; with the PendingPayout live it fails and PayoutService never MarkPaids it", async () => {
    const { b, res } = await cashOut("fail1", "25", "25");
    const cid = k.signWithdraw(b, "25");
    // The account is suspended before MarkPaid: the scan binds the withdrawal, MarkPaid is deferred.
    await ctx.get(UserService).suspend(b.user.id, "test", SYSTEM);
    await ctx.get(PayoutService).scan();
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "withdrawing",
      pendingPayoutCid: cid,
      details: { hold: { reason: "blocked_kyc" } },
    });
    expect(markPaids(res.order.id)).toBe(0);
    // An operator reinstates the account; the withdrawal is settled again: MarkPaid goes out but the ledger lags.
    await ctx.dataSource.query(`UPDATE to_users SET status = 'active' WHERE id = $1`, [b.user.id]);
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET details = details - 'hold', status_changed_at = now() - interval '61 minutes' WHERE id = $1`,
      [res.order.id],
    );
    ctx.wallet.lagLedger = true;
    await ctx
      .get(PayoutService)
      .settle(cid, { type: "system" })
      .catch(() => undefined);
    expect(markPaids(res.order.id)).toBe(1);
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "withdrawal",
    });
    // M8 / #1: the MarkPaid is submitted (may still run): fail is refused.
    expect(await admin(res.order.id, "fail", 409)).toMatchObject({ error: "ramp_order_state" });
    // The ledger rejects that MarkPaid: the contract is live and nothing is pending any more.
    ctx.wallet.rejectPending();
    ctx.wallet.lagLedger = false;
    expect(await admin(res.order.id, "fail")).toMatchObject({ status: "failed" });
    // PayoutService will not MarkPaid a withdrawal whose cash-out failed: the user may cancel it.
    await ctx.get(PayoutService).scan();
    expect(markPaids(res.order.id)).toBe(1);
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({
      status: "blocked_unknown_reason",
    });
    expect(ctx.ledger.payouts.has(cid)).toBe(true);
    expect(await k.journal(res.order.id)).toEqual({});
    await k.expectIdentities();
  });
});

describe("ramp cash-out: holds, accounts, deadlines, binding (H2, M2, E-D3, M8, L2)", () => {
  it("H2: the card exposure is re-checked with the live amount before MarkPaid — deferred (details.hold), the user may still cancel", async () => {
    const { b, res } = await cashOut("h2", "100", "100");
    // Drain the free balance with a plain withdrawal (it does not bind: another amount)…
    const plain = k.signWithdraw(b, "99.99");
    await ctx.get(PayoutService).scan();
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: plain }),
    ).toMatchObject({
      status: "settled_external",
    });
    // …buy again with another card (inside its dispute window), and sign the cash-out's exact amount.
    await k.bought(b, "100", "h2-other-card");
    const cid = k.signWithdraw(b, "100");
    expect((await attach(b, res.order.id, cid)).status).toBe("withdrawing");
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "withdrawing",
      details: { hold: { reason: "exposure" } },
    });
    expect(markPaids(res.order.id)).toBe(0);
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({
      status: "blocked_ramp_exposure",
    });
    k.cancelPayout(b, cid);
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("cancelled");
    expect(ctx.tokenApp.burned).toEqual([]);
    expect(k.mock().payoutsFor(res.order.id)).toEqual([]);
    await k.expectIdentities();
  });

  it("M2 / E-D3: a chargeback holds every open cash-out of the account — before MarkPaid deferred, after it in review; a burn recorded in review is still booked", async () => {
    const b = await k.buyer("m2cb");
    await k.bought(b, "100", "m2-card-x");
    await k.decayExposure();
    const cardX = await k.payoutCard(b);
    const openOff = async (amount: string): Promise<ApiRampOfframpResult> =>
      bodyOf<ApiRampOfframpResult>(
        await ctx.agent
          .post("/api/v1/ramp/offramp")
          .set(b.headers)
          .set("Idempotency-Key", nextKey())
          .send({ amount, destination: { kind: "card", paymentMethodId: cardX.id } })
          .expect(200),
      );
    // Cash-out B is past MarkPaid with its burn not yet recorded.
    const offB = await openOff("30");
    const burnB = rampCommandId("burn", offB.order.id);
    ctx.tokenApp.unrecorded.add(burnB);
    await attach(b, offB.order.id, k.signWithdraw(b, "30"));
    await k.drive(2);
    expect((await k.order(offB.order.id)).status).toBe("burning");
    // Cash-out A waits for its signature; then card Y's purchase is charged back.
    const offA = await openOff("40");
    const bought = await k.bought(b, "20", "m2-card-y");
    await k.deliver(k.mock().chargeback(bought.providerPaymentId ?? "", b.user.id));
    expect(await k.order(offA.order.id)).toMatchObject({
      status: "awaiting_withdrawal",
      details: { hold: { reason: "chargeback", orderId: bought.id } },
    });
    expect(await k.order(offB.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
    });
    // The burn lands while B is in review: offramp.burned is booked anyway (#9) — no payout.
    ctx.tokenApp.unrecorded.delete(burnB);
    await k.drive();
    expect((await k.order(offB.order.id)).status).toBe("needs_review");
    expect(await k.journal(offB.order.id)).toMatchObject({
      "offramp.burned:customer_liability": dec("30"),
    });
    expect(k.mock().payoutsFor(offB.order.id)).toEqual([]);
    // A's withdrawal binds (the scan; a suspended user has no session) but MarkPaid is refused.
    const cidA = k.signWithdraw(b, "40");
    await ctx.get(PayoutService).scan();
    expect(await k.order(offA.order.id)).toMatchObject({
      status: "withdrawing",
      pendingPayoutCid: cidA,
    });
    expect(markPaids(offA.order.id)).toBe(0);
    await k.expectIdentities();
  });

  it("M2: a burned cash-out of an account suspended meanwhile is not paid (paying_out → needs_review(payout))", async () => {
    const { b, res } = await cashOut("m2pay", "50", "50");
    const burnId = rampCommandId("burn", res.order.id);
    ctx.tokenApp.unrecorded.add(burnId);
    await attach(b, res.order.id, k.signWithdraw(b, "50"));
    await k.drive(2);
    expect((await k.order(res.order.id)).status).toBe("burning");
    await ctx.get(UserService).suspend(b.user.id, "fraud signal", SYSTEM);
    ctx.tokenApp.unrecorded.delete(burnId);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payout",
      details: { reviewFrom: "paying_out", reviewReason: "the account is not active" },
    });
    expect(k.mock().payoutsFor(res.order.id)).toEqual([]);
    await k.expectIdentities();
  });

  it("M8: MarkPaid stuck past RAMP_WITHDRAWING_TIMEOUT_MIN → needs_review(withdrawal); once the ledger shows it, retry resumes and the cash-out completes", async () => {
    const { b, res } = await cashOut("m8", "35", "35");
    const cid = k.signWithdraw(b, "35");
    ctx.wallet.lagLedger = true;
    await attach(b, res.order.id, cid);
    await k.drive(1);
    expect((await k.order(res.order.id)).status).toBe("withdrawing");
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status_changed_at = now() - interval '61 minutes' WHERE id = $1`,
      [res.order.id],
    );
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "withdrawal",
      details: { reviewFrom: "withdrawing" },
      lastError: "MarkPaid did not complete within 60 min",
    });
    ctx.wallet.applyPending();
    ctx.wallet.lagLedger = false;
    await k.indexPayouts();
    expect(await admin(res.order.id, "retry")).toMatchObject({ status: "burning" });
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(await k.journal(res.order.id)).toMatchObject({
      "offramp.burned:customer_liability": dec("35"),
      "offramp.paid_card:payout_clearing": dec("35"),
    });
    await k.expectIdentities();
  });

  it("L2: a withdrawal from another party of the same account never binds to the cash-out", async () => {
    const { b, res } = await cashOut("l2", "30", "30");
    const second = makeTestWallet("l2-second");
    await ctx.dataSource.getRepository(WalletEntity).insert({
      userId: b.user.id,
      kind: "cantor8",
      partyId: second.partyId,
      publicKey: second.publicKeyBase64,
      isPrimary: false,
      status: "active",
      verifiedAt: new Date(),
    });
    ctx.ledger.seedUserWallet(second.partyId, { balance: "30", instrument: TEST_COLLATERAL });
    const cid = ctx.ledger.seedPendingPayout({
      user: second.partyId,
      amount: "30",
      reason: "withdraw",
      instrument: TEST_COLLATERAL,
    }).contractId;
    await ctx
      .get(PayoutService)
      .settle(cid, { type: "system" })
      .catch(() => undefined);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "awaiting_withdrawal",
      pendingPayoutCid: null,
    });
    const row = await ctx.dataSource
      .getRepository(PayoutEntity)
      .findOneByOrFail({ pendingPayoutCid: cid });
    expect(row.details?.offrampOrderId).toBeUndefined();
  });
});

describe("review group A: an approved credit-back in flight (C1)", () => {
  it("C1: while an approved credit_back's Deposit is unconfirmed every other exit waits — retry is refused; the Deposit confirms → refunded, nothing burned or paid", async () => {
    const { b, res } = await cashOut("c1-cb", "35", "35");
    const cid = k.signWithdraw(b, "35");
    ctx.wallet.lagLedger = true;
    await attach(b, res.order.id, cid);
    await k.drive(1);
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status_changed_at = now() - interval '61 minutes' WHERE id = $1`,
      [res.order.id],
    );
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "withdrawal",
      burnCommandId: null,
    });
    // The late MarkPaid lands: the tokens are in the treasury, nothing burned. The credit-back is
    // approved and its Deposit submitted, but the wallet has not confirmed it yet.
    ctx.wallet.applyPending();
    await k.indexPayouts();
    expect(await admin(res.order.id, "credit_back")).toMatchObject({
      status: "needs_review",
      details: { creditBack: { state: "submitted" } },
    });
    // A retry now would MarkPaid → burn → pay the same 35 the Deposit gives back.
    expect(await admin(res.order.id, "retry", 409)).toMatchObject({
      error: "ramp_order_state",
      message: expect.stringMatching(/credit back is under way/) as string,
    });
    expect(await admin(res.order.id, "fail", 409)).toMatchObject({ error: "ramp_order_state" });
    expect(await admin(res.order.id, "credit_back", 409)).toMatchObject({
      error: "ramp_order_state",
    });
    // The Deposit confirms: refunded, the 35 back in the wallet, no burn and no payout.
    ctx.wallet.applyPending();
    ctx.wallet.lagLedger = false;
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "refunded",
      burnCommandId: null,
      details: { creditBack: { state: "confirmed" } },
    });
    expect(await k.commands(res.order.id)).toEqual([]);
    expect(ctx.tokenApp.burned).toEqual([]);
    expect(k.mock().payoutsFor(res.order.id)).toEqual([]);
    expect(ctx.ledger.walletOf(b.wallet.partyId)?.balance).toBe(parseAmount("35"));
    expect(await k.journal(res.order.id)).toEqual({});
    await k.expectIdentities();
  });
});

describe("review group A: a credited-back burn is never re-sent; a burn never sent resumes (C2, C35)", () => {
  it("C2: a burn that never landed is not re-sent once the order was credited back; one landing anyway books nothing — issuance goes red and pages", async () => {
    const { b, res } = await cashOut("c2-off", "40", "40");
    await attach(b, res.order.id, k.signWithdraw(b, "40"));
    ctx.tokenApp.nextPost = post("rejected", 403, "token_app_forbidden", false);
    await k.drive();
    const burnId = rampCommandId("burn", res.order.id);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "burn",
    });
    expect(await admin(res.order.id, "credit_back")).toMatchObject({ status: "refunded" });
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/tokens/commands/${burnId}/resend`)
        .set(await k.adminHeaders())
        .send({ reason: "e2e resend after credit back" })
        .expect(409),
    );
    expect(refused).toMatchObject({
      error: "token_command_state",
      details: { orderId: res.order.id, orderStatus: "refunded" },
    });
    expect(ctx.tokenApp.burned).toEqual([]);
    // Defence in depth: it lands all the same — the treasury gave T back AND burned it; never booked.
    const [burn] = await k.commands(res.order.id);
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET status = 'submitted' WHERE command_id = $1`,
      [burnId],
    );
    ctx.tokenApp.extraRecords.push({
      kind: "burn",
      commandId: burnId,
      updateId: "update-c2-burn-late",
      partyId: burn.partyId,
      instrumentId: TEST_COLLATERAL.id,
      amount: burn.amount,
      createdAt: new Date(),
    });
    const paged = jest.spyOn(ctx.get(SentryService), "captureMessage");
    await k.drive(1);
    const pages = paged.mock.calls.map((c) => [c[0], c[2]]);
    paged.mockRestore();
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: burnId, status: "recorded" },
    ]);
    expect(await k.order(res.order.id)).toMatchObject({ status: "refunded" });
    expect(await k.journal(res.order.id)).toEqual({});
    expect(pages).toContainEqual([
      "ramp command recorded after its order settled",
      expect.objectContaining({ orderId: res.order.id, commandId: burnId, page: "true" }),
    ]);
    expect(k.checkOf(await k.reconciliation(), "issuance_matches_liability").status).toBe("red");
  });

  it("C35: a burn never sent (token-app unreachable) past RAMP_TOKEN_REVIEW_AFTER_MIN goes to review; a single-control retry POSTs it and the cash-out is paid", async () => {
    const { b, res } = await cashOut("c35-off", "30", "30");
    ctx.tokenApp.configured = false;
    await attach(b, res.order.id, k.signWithdraw(b, "30"));
    await k.drive(2);
    const burnId = rampCommandId("burn", res.order.id);
    expect(await k.order(res.order.id)).toMatchObject({ status: "burning", burnCommandId: burnId });
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: burnId, status: "pending", attempts: 0 },
    ]);
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET created_at = now() - interval '121 minutes' WHERE command_id = $1`,
      [burnId],
    );
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status_changed_at = now() - interval '121 minutes' WHERE id = $1`,
      [res.order.id],
    );
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "burn",
      details: { reviewFrom: "burning" },
    });
    ctx.tokenApp.configured = true;
    expect(await admin(res.order.id, "retry")).toMatchObject({ status: "burning" });
    expect(ctx.tokenApp.burned.map((x) => x.commandId)).toEqual([burnId]);
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(k.mock().payoutsFor(res.order.id)).toHaveLength(1);
    expect(await k.commands(res.order.id)).toMatchObject([{ status: "recorded", attempts: 1 }]);
    await k.expectIdentities();
  });
});

describe("W9f: a credit-back whose Deposit fails for good (C1)", () => {
  /** A cash-out whose MarkPaid landed late — the tokens are in the treasury — in the withdrawal review. */
  async function markPaidInReview(hint: string, amount: string): Promise<{ b: Buyer; id: string }> {
    const { b, res } = await cashOut(hint, amount, amount);
    ctx.wallet.lagLedger = true;
    await attach(b, res.order.id, k.signWithdraw(b, amount));
    await k.drive(1);
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status_changed_at = now() - interval '61 minutes' WHERE id = $1`,
      [res.order.id],
    );
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "withdrawal",
      burnCommandId: null,
    });
    ctx.wallet.applyPending();
    await k.indexPayouts();
    return { b, id: res.order.id };
  }

  /** The credit-back key's write-ahead row, submitted past the confirm grace period. */
  async function pastGrace(key: string, ms = ctx.config.depositConfirmGraceMs): Promise<void> {
    const res = await ctx.dataSource
      .getRepository(DepositCreditEntity)
      .update(
        { commandId: mintCreditCommandId(key) },
        { submittedAt: new Date(Date.now() - ms - 1000) },
      );
    expect(res.affected).toBe(1);
  }

  /** …and past RAMP_CREDIT_BACK_FINAL_AFTER_MIN: the wallet's FAILED is final (W9g C1). */
  const pastFinal = (key: string): Promise<void> =>
    pastGrace(key, Math.max(ctx.config.depositConfirmGraceMs, 60 * 60_000));

  const creditBackOf = async (id: string): Promise<Record<string, unknown>> =>
    (await k.order(id)).details.creditBack as Record<string, unknown>;

  it("without proof (an unknown status, a stale index) it stays submitted; proven (the wallet's FAILED, no Deposit with its txRef) it fails — paged once, never re-run; credit_back again lands as generation 2 under a new key → refunded, credited once", async () => {
    const { b, id } = await markPaidInReview("c1-gen", "35");
    // The ledger still lags: the credit-back's Deposit is accepted, not applied.
    expect(await admin(id, "credit_back")).toMatchObject({
      status: "needs_review",
      details: { creditBack: { state: "submitted" } },
    });
    const gen1 = rampCommandId("creditback", id);
    // The ledger rejects it for good (a stale contract id, an assertion): the wallet reports FAILED.
    ctx.wallet.rejectPending();
    ctx.wallet.lagLedger = false;
    // No proof: the wallet's command index does not know the command (re-armed, a duplicate: nothing lands).
    ctx.wallet.unknownCommandIds = true;
    await pastGrace(gen1);
    await k.drive(1);
    expect(await creditBackOf(id)).toMatchObject({ commandId: gen1, state: "submitted" });
    expect(await admin(id, "retry", 409)).toMatchObject({
      message: expect.stringMatching(/credit back is under way/) as string,
    });
    // No proof: the wallet reports FAILED (final), but the ledger index lags the ledger end.
    ctx.wallet.unknownCommandIds = false;
    ctx.stream.end = 10_000;
    await pastFinal(gen1);
    await k.drive(1);
    expect(await creditBackOf(id)).toMatchObject({ commandId: gen1, state: "submitted" });
    ctx.stream.end = null;
    // Proven: FAILED, a fresh index and the wallet without its txRef → failed, paged once.
    await pastFinal(gen1);
    const paged = jest.spyOn(ctx.get(SentryService), "captureMessage");
    const submits = jest.spyOn(ctx.wallet, "externalSubmit");
    await k.drive(3);
    const pages = paged.mock.calls.filter((c) => c[0] === "ramp credit-back failed for good");
    const resubmits = submits.mock.calls.filter(
      (c) => c[0].commandId === mintCreditCommandId(gen1),
    );
    paged.mockRestore();
    submits.mockRestore();
    expect(pages).toEqual([
      ["ramp credit-back failed for good", "error", { orderId: id, commandId: gen1 }],
    ]);
    expect(resubmits).toEqual([]);
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      reviewStep: "withdrawal",
      lastError: expect.stringMatching(/failed for good/) as string,
      details: {
        creditBack: {
          commandId: gen1,
          state: "failed",
          error: expect.stringMatching(/failed/) as string,
          failedAt: expect.any(String) as string,
        },
      },
    });
    // The exits reopen: credit_back again is a NEW generation under a new key (four-eyes as before).
    const gen2 = rampCommandId("creditback", id, 2);
    expect(await admin(id, "credit_back")).toMatchObject({
      status: "refunded",
      details: {
        creditBack: {
          commandId: gen2,
          generation: 2,
          state: "confirmed",
          failed: [{ commandId: gen1 }],
        },
      },
    });
    // Credited exactly once: generation 2's txRef only, T back in the wallet; nothing burned or paid.
    const w = ctx.ledger.walletOf(b.wallet.partyId);
    expect(w?.balance).toBe(parseAmount("35"));
    expect(w?.creditRefs).toContain(`mint:${gen2}`);
    expect(w?.creditRefs).not.toContain(`mint:${gen1}`);
    expect(ctx.tokenApp.burned).toEqual([]);
    expect(k.mock().payoutsFor(id)).toEqual([]);
    expect(await k.journal(id)).toEqual({});
    expect(await admin(id, "credit_back", 409)).toMatchObject({ error: "ramp_order_state" });
    await k.expectIdentities();
  });

  it("proven failed, retry reopens too: MarkPaid already took T, so it is burned and paid — never also credited back", async () => {
    const { b, id } = await markPaidInReview("c1-retry", "30");
    expect(await admin(id, "credit_back")).toMatchObject({
      details: { creditBack: { state: "submitted" } },
    });
    const gen1 = rampCommandId("creditback", id);
    ctx.wallet.rejectPending();
    ctx.wallet.lagLedger = false;
    await pastFinal(gen1);
    await k.drive(1);
    expect(await creditBackOf(id)).toMatchObject({ state: "failed" });
    expect(await admin(id, "retry")).toMatchObject({
      details: { creditBack: { state: "failed" } },
    });
    await k.drive();
    expect(await k.order(id)).toMatchObject({
      status: "completed",
      details: { creditBack: { state: "failed" } },
    });
    expect(k.mock().payoutsFor(id)).toHaveLength(1);
    expect(ctx.ledger.walletOf(b.wallet.partyId)?.balance).toBe(0n);
    expect(ctx.ledger.walletOf(b.wallet.partyId)?.creditRefs).not.toContain(`mint:${gen1}`);
    expect(await k.journal(id)).toMatchObject({
      "offramp.burned:customer_liability": dec("30"),
      "offramp.paid_card:payout_clearing": dec("30"),
    });
    await k.expectIdentities();
  });

  /** The wallet's Deposit of `key`, sent but not applied by the lagging ledger, read as `status`. */
  function walletSays(key: string, status: string): void {
    ctx.wallet.commandStatuses.set(mintCreditCommandId(key), status);
  }

  it("W9g C1: a wallet timeout younger than RAMP_CREDIT_BACK_FINAL_AFTER_MIN proves nothing — the key waits, never re-sent; it lands late → refunded, credited once", async () => {
    const { b, id } = await markPaidInReview("c1-timeout", "25");
    expect(await admin(id, "credit_back")).toMatchObject({
      details: { creditBack: { state: "submitted" } },
    });
    const gen1 = rampCommandId("creditback", id);
    // The wallet times the command out; the ledger may still apply it (it is only lagging).
    walletSays(gen1, "timeout");
    await pastGrace(gen1);
    const paged = jest.spyOn(ctx.get(SentryService), "captureMessage");
    const submits = jest.spyOn(ctx.wallet, "externalSubmit");
    try {
      await k.drive(2);
      expect(paged.mock.calls.filter((c) => c[0] === "ramp credit-back failed for good")).toEqual(
        [],
      );
      expect(
        submits.mock.calls.filter((c) => c[0].commandId === mintCreditCommandId(gen1)),
      ).toEqual([]);
    } finally {
      paged.mockRestore();
      submits.mockRestore();
    }
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      lastError: expect.stringMatching(/timeout, final only after/) as string,
      details: { creditBack: { commandId: gen1, state: "submitted" } },
    });
    // No exit moves T meanwhile: no second generation, no burn and payout.
    expect(await admin(id, "credit_back", 409)).toMatchObject({ error: "ramp_order_state" });
    expect(await admin(id, "retry", 409)).toMatchObject({ error: "ramp_order_state" });
    // The timed-out command lands after all: it confirms on the next pass, once.
    ctx.wallet.applyPending();
    await k.drive(1);
    expect(await k.order(id)).toMatchObject({
      status: "refunded",
      details: { creditBack: { commandId: gen1, state: "confirmed" } },
    });
    const w = ctx.ledger.walletOf(b.wallet.partyId);
    expect(w?.balance).toBe(parseAmount("25"));
    expect(w?.creditRefs.filter((r) => r.startsWith("mint:ramp-creditback-"))).toEqual([
      `mint:${gen1}`,
    ]);
    await k.expectIdentities();
  });

  it("W9g C1: an earlier generation landing late blocks generation n+1 and retry; the reconciliation flags it (amber; red once T would be credited twice); T is credited once", async () => {
    const { b, id } = await markPaidInReview("c1-late", "30");
    const gen1 = rampCommandId("creditback", id);
    const gen2 = rampCommandId("creditback", id, 2);
    // Generation 1: the ledger rejects it; proven failed past the bound.
    expect(await admin(id, "credit_back")).toMatchObject({
      details: { creditBack: { commandId: gen1, state: "submitted" } },
    });
    ctx.wallet.rejectPending();
    await pastFinal(gen1);
    await k.drive(1);
    expect(await creditBackOf(id)).toMatchObject({ commandId: gen1, state: "failed" });
    // Generation 2: the same.
    expect(await admin(id, "credit_back")).toMatchObject({
      details: {
        creditBack: { commandId: gen2, state: "submitted", failed: [{ commandId: gen1 }] },
      },
    });
    ctx.wallet.rejectPending();
    await pastFinal(gen2);
    await k.drive(1);
    expect(await creditBackOf(id)).toMatchObject({ commandId: gen2, state: "failed" });
    // Generation 1 lands after all (its proof was wrong): T is back in the wallet.
    const w = ctx.ledger.walletOf(b.wallet.partyId);
    if (!w) throw new Error("no wallet");
    ctx.ledger.setWallet({
      ...w,
      contractId: ctx.ledger.nextCid("uw"),
      balance: w.balance + parseAmount("30"),
      deposited: w.deposited + parseAmount("30"),
      creditRefs: [...w.creditRefs, `mint:${gen1}`],
    });
    ctx.wallet.lagLedger = false;
    // Generation 3 and retry are refused: the earlier key is no longer proven never to land.
    for (const action of ["credit_back", "retry"])
      expect(await admin(id, action, 409)).toMatchObject({
        error: "ramp_order_state",
        message: `the failed credit back ${gen1} is not proven never to land: the ledger does not show the wallet without mint:${gen1}`,
      });
    expect(ctx.ledger.walletOf(b.wallet.partyId)?.balance).toBe(parseAmount("30"));
    expect(ctx.tokenApp.burned).toEqual([]);
    expect(k.mock().payoutsFor(id)).toEqual([]);
    // The reconciliation re-proves every earlier key on an uncached ledger read: red, named.
    await ctx.dataSource.query(
      `INSERT INTO to_indexer_state (key, "offset", ledger_end) VALUES ('ledger', 10, 10)
       ON CONFLICT (key) DO UPDATE SET "offset" = 10, ledger_end = 10`,
    );
    await ctx.dataSource.query(
      `INSERT INTO to_ledger_holdings (contract_id, owner, instrument_admin, instrument_id, amount, created_offset)
       VALUES ('holding-c1', $1, $2, $3, '1000000', 1)`,
      [ctx.config.treasuryPartyId, TEST_COLLATERAL.admin, TEST_COLLATERAL.id],
    );
    expect(k.checkOf(await k.reconciliation(), "treasury_covers_in_app")).toMatchObject({
      status: "amber",
      detail: `credit-back ${gen1} of order ${id} was proven never to land but landed (ledger): the order is credited back once; settle its review by hand`,
    });
    // Had generation 2 landed as well, T would be credited twice: red.
    const now = ctx.ledger.walletOf(b.wallet.partyId);
    if (!now) throw new Error("no wallet");
    ctx.ledger.setWallet({ ...now, creditRefs: [...now.creditRefs, `mint:${gen2}`] });
    expect(k.checkOf(await k.reconciliation(), "treasury_covers_in_app")).toMatchObject({
      status: "red",
      detail: `order ${id} was credited back twice: credit-back ${gen1}, proven never to land, landed (ledger) besides another generation (and 1 more)`,
    });
    await k.expectIdentities();
  });
});

describe("W9f: a withdrawal signed in time is never expired away (F5)", () => {
  /** The cash-out's deadline `ago` in the past, its withdrawal signed `signedAgo` before now. */
  async function lapsed(orderId: string, cid: string, ago: string, signedAgoMs: number) {
    const payout = ctx.ledger.payouts.get(cid);
    if (!payout) throw new Error("no PendingPayout");
    payout.createdAt = new Date(Date.now() - signedAgoMs);
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET expires_at = now() - $2::interval WHERE id = $1`,
      [orderId, ago],
    );
  }

  it("F5: past the deadline, a withdraw PendingPayout signed in time binds the cash-out instead of expiring it — an unreadable ledger expires nothing meanwhile", async () => {
    const { b, res } = await cashOut("f5-bind", "30", "30");
    // Signed a minute before the deadline, which has just passed; the attach never arrived.
    const cid = k.signWithdraw(b, "30");
    await lapsed(res.order.id, cid, "30 seconds", 60_000);
    ctx.ledger.failReads = new Error("participant unreachable");
    await k.fulfilment().scan();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "awaiting_withdrawal",
      lastError: expect.stringMatching(/expiry deferred: the ledger could not be read/) as string,
    });
    ctx.ledger.failReads = null;
    await k.fulfilment().scan();
    const bound = await k.order(res.order.id);
    expect(bound.status).not.toBe("expired");
    expect(bound.pendingPayoutCid).toBe(cid);
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(markPaids(res.order.id)).toBe(1);
    expect(k.mock().payoutsFor(res.order.id)).toHaveLength(1);
    expect(
      (await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }))
        .details?.offrampOrderId,
    ).toBe(res.order.id);
    await k.expectIdentities();
  });

  it("F5: one signed after the deadline, or still unbound RAMP_WITHDRAWAL_BIND_GRACE_MIN past it, does not keep the cash-out open — it expires as before", async () => {
    const late = await cashOut("f5-late", "20", "20");
    const lateCid = k.signWithdraw(late.b, "20");
    await lapsed(late.res.order.id, lateCid, "30 seconds", 0);
    const graceOver = await cashOut("f5-grace", "25", "25");
    const graceCid = k.signWithdraw(graceOver.b, "25");
    await lapsed(graceOver.res.order.id, graceCid, "11 minutes", 15 * 60_000);
    await k.fulfilment().scan();
    for (const o of [late.res.order, graceOver.res.order])
      expect(await k.order(o.id)).toMatchObject({ status: "expired", pendingPayoutCid: null });
    await k.expectIdentities();
  });
});

describe("W9f: attach says when the withdrawal is not bound yet (F6)", () => {
  async function attachRaw(b: Buyer, orderId: string, cid: string): Promise<ApiRampAttachResult> {
    return bodyOf<ApiRampAttachResult>(
      await ctx.agent
        .post(`/api/v1/ramp/orders/${orderId}/attach`)
        .set(b.headers)
        .send({ pendingPayoutCid: cid })
        .expect(200),
    );
  }

  it("F6: a settlement in progress leaves the order waiting — still 200, now with bindPending and why; attached again it binds", async () => {
    const { b, res } = await cashOut("f6", "30", "30");
    const cid = k.signWithdraw(b, "30");
    const lock = await ctx.redis.acquireLock(`lock:payout:${cid}`, 60_000);
    expect(lock.acquired).toBe(true);
    expect(await attachRaw(b, res.order.id, cid)).toMatchObject({
      order: { id: res.order.id, status: "awaiting_withdrawal" },
      bindPending: true,
      bindReason: "settlement_in_progress",
    });
    await lock.release();
    const again = await attachRaw(b, res.order.id, cid);
    expect(again).toMatchObject({ bindPending: false, bindReason: null });
    expect(again.order.status).not.toBe("awaiting_withdrawal");
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    await k.expectIdentities();
  });
});
