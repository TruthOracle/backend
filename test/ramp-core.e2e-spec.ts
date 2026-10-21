/**
 * Ramp v2 core money correctness, on-ramp side (SPEC §4.1, §4.2, §5; money-core.md §7): the
 * acquirer re-read before the mint (H4), PSP reversals and every chargeback variant (#10), partial
 * captures (M4), cancel / expiry voids (M7), lost createPayment answers (H5), webhook events that
 * never die silently and the post-close poll (H6, E-D1), the card hold from minting (M1), account
 * re-checks (M2), checkout-link validation (E-D7), card re-activation (E-D8), token commands
 * refused / mismatched / unresolved → review with no re-send (C2, #8), stale admin actions (H1).
 * Every money scenario checks order status, journal and token commands together, then the
 * journal identities.
 */
import { RampEventEntity } from "../src/entities/ramp-event.entity";
import { RampOrderEntity } from "../src/entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../src/entities/ramp-payment-method.entity";
import { UserEntity } from "../src/entities/user.entity";
import { RampActionsService } from "../src/services/ramp-actions.service";
import { RampReconChecks } from "../src/services/ramp-recon-checks.service";
import { rampCommandId } from "../src/services/ramp-fulfilment.service";
import { RampOrderStore } from "../src/services/ramp-order-store.service";
import { SentryService } from "../src/services/sentry.service";
import { TokenAppSyncService } from "../src/services/token-app-sync.service";
import type { TokenAppPostOutcome } from "../src/services/token-app.service";
import { UserService } from "../src/services/user.service";
import type {
  ApiAdminRampOrder,
  ApiRampOnrampResult,
  ApiRampOrder,
  ApiRampOverview,
} from "../src/types";
import { ApiError, type ErrorBody } from "../src/util/errors";
import { parseAmount } from "../src/util/money";
import { TEST_COLLATERAL, TEST_TREASURY, useTestApp } from "./helpers/app";
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

/** What FakeTokenApp answers the next POST with; `lands` = whether token-app records it anyway. */
function post(
  outcome: TokenAppPostOutcome["outcome"],
  httpStatus: number,
  code: TokenAppPostOutcome["code"],
  lands: boolean,
): { outcome: TokenAppPostOutcome; lands: boolean } {
  return { outcome: { outcome, httpStatus, status: null, code, message: code ?? "ok" }, lands };
}
const REJECTED = post("rejected", 403, "token_app_forbidden", false);
const LOST = post("unknown", 0, "upstream_failed", false);

beforeEach(() => {
  k.mock().reset();
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

/** Captured and `paid`, with nothing advanced yet (the mint step has not run). */
async function paidOnly(b: Buyer, amount: string): Promise<ApiRampOnrampResult> {
  const res = await k.openOnramp(b, amount);
  k.mock().complete(k.paymentIdOf(res), b.user.id, "succeeded");
  await k
    .fulfilment()
    .applyPayment(await k.order(res.order.id), await k.mock().getPayment(k.paymentIdOf(res)));
  expect((await k.order(res.order.id)).status).toBe("paid");
  return res;
}

/** A charge-back delivered through the webhook route. */
async function chargeback(b: Buyer, res: ApiRampOnrampResult): Promise<void> {
  await k.deliver(k.mock().chargeback(k.paymentIdOf(res), b.user.id));
}

describe("ramp core: the acquirer re-read, reversals and chargebacks (H4, #10)", () => {
  it("H4: the acquirer refunds a paid capture itself → no mint, needs_review(payment); fail books onramp.voided (M3)", async () => {
    const b = await k.buyer("h4");
    const res = await paidOnly(b, "30");
    k.mock().pspRefund(k.paymentIdOf(res));
    await k.fulfilment().advance(res.order.id);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
      mintCommandId: null,
      details: { reviewFrom: "paid", reviewReason: "the acquirer refunded the payment itself" },
    });
    expect(await k.commands(res.order.id)).toEqual([]);
    expect(ctx.tokenApp.minted).toEqual([]);
    // A reversal's side effects run whatever the status (#10).
    expect(
      (await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: b.user.id })).status,
    ).toBe("suspended");
    // Money the acquirer itself returned: `fail` closes it and reverses the booked capture.
    expect(await admin(res.order.id, "retry", 409)).toMatchObject({ error: "ramp_order_state" });
    expect(await admin(res.order.id, "fail")).toMatchObject({ status: "failed" });
    expect(await k.journal(res.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("30"),
      "onramp.captured:issuance_pending": dec("-30"),
      "psp.fee_accrued:psp_fees": dec("0.72"),
      "psp.fee_accrued:provider_clearing": dec("-0.72"),
      "onramp.voided:issuance_pending": dec("30"),
      "onramp.voided:provider_clearing": dec("-30"),
    });
    await k.expectIdentities();
  });

  it("#10 paid: a chargeback with nothing minted releases issuance_pending (onramp.chargeback), suspends and blocks", async () => {
    const b = await k.buyer("cbpaid");
    const res = await paidOnly(b, "25");
    await chargeback(b, res);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "chargeback",
      mintCommandId: null,
    });
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.chargeback:issuance_pending": dec("25"),
      "onramp.chargeback:provider_clearing": dec("-25"),
    });
    expect(
      (await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: b.user.id })).status,
    ).toBe("suspended");
    expect(
      (
        await ctx.dataSource
          .getRepository(RampPaymentMethodEntity)
          .findOneByOrFail({ userId: b.user.id })
      ).status,
    ).toBe("blocked");
    await k.expectIdentities();
  });

  it("#10 minting: a chargeback waits for the mint (pending, never credited); recorded → chargeback_minted; burn_uncredited burns N", async () => {
    const b = await k.buyer("cbmint");
    const res = await paidOnly(b, "50");
    const mintId = rampCommandId("mint", res.order.id);
    ctx.tokenApp.unrecorded.add(mintId);
    await k.fulfilment().advance(res.order.id);
    expect((await k.order(res.order.id)).status).toBe("minting");
    await chargeback(b, res);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "minting",
      details: { chargeback: { state: "pending", kind: "chargeback", amount: dec("50") } },
    });
    expect(await k.journal(res.order.id)).not.toHaveProperty([
      "onramp.chargeback:issuance_pending",
    ]);

    ctx.tokenApp.unrecorded.delete(mintId);
    await k.drive();
    // The sync recorded N, booked it and moved the order to chargeback in one transaction: nothing credited.
    expect(await k.order(res.order.id)).toMatchObject({
      status: "chargeback",
      details: { chargeback: { state: "charged_back" } },
      creditCommandId: null,
    });
    expect(ctx.ledger.walletOf(b.wallet.partyId)).toBeUndefined();
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.minted:customer_liability": dec("-50"),
      "onramp.chargeback_minted:chargeback_receivable": dec("50"),
    });
    await k.expectIdentities();

    expect(await admin(res.order.id, "burn_uncredited")).toMatchObject({ status: "chargeback" });
    expect(await admin(res.order.id, "burn_uncredited", 409)).toMatchObject({
      error: "ramp_order_state",
    });
    await k.drive(2);
    expect((await k.commands(res.order.id)).map((c) => [c.commandId, c.kind, c.status])).toEqual([
      [mintId, "mint", "recorded"],
      [rampCommandId("cbburn", res.order.id), "burn", "recorded"],
    ]);
    // N burned: the client liability and the receivable are both settled.
    const j = await k.journal(res.order.id);
    expect(j).toMatchObject({
      "onramp.uncredited_burned:customer_liability": dec("50"),
      "onramp.uncredited_burned:chargeback_receivable": dec("-50"),
    });
    await k.expectIdentities();
  });

  /** N recorded while a chargeback waited on the mint: chargeback, never credited. */
  async function chargedBackUncredited(hint: string, amount: string): Promise<ApiRampOnrampResult> {
    const b = await k.buyer(hint);
    const res = await paidOnly(b, amount);
    const mintId = rampCommandId("mint", res.order.id);
    ctx.tokenApp.unrecorded.add(mintId);
    await k.fulfilment().advance(res.order.id);
    await chargeback(b, res);
    ctx.tokenApp.unrecorded.delete(mintId);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "chargeback",
      creditCommandId: null,
      details: { chargeback: { state: "charged_back" } },
    });
    return res;
  }

  it("R1-2: a dispute won on an uncredited mint pages and refuses burn_uncredited; a burn already in flight books nothing when it lands, and pages", async () => {
    const sentry = jest.spyOn(ctx.get(SentryService), "captureMessage");
    const pages = (): string[] => sentry.mock.calls.map((c) => String(c[0]));
    try {
      const won = await chargedBackUncredited("r12-won", "50");
      await k.deliver(k.mock().disputeWon(k.paymentIdOf(won)));
      expect(await k.journal(won.order.id)).toMatchObject({
        "onramp.chargeback_reversed:chargeback_receivable": dec("-50"),
      });
      expect(pages()).toContain("ramp dispute won on an uncredited mint");
      expect(await admin(won.order.id, "burn_uncredited", 409)).toMatchObject({
        error: "ramp_order_state",
        message: expect.stringMatching(/dispute was won/) as string,
      });
      expect((await k.commands(won.order.id)).map((c) => c.kind)).toEqual(["mint"]);
      await k.expectIdentities();

      const inFlight = await chargedBackUncredited("r12-flight", "30");
      const cbburn = rampCommandId("cbburn", inFlight.order.id);
      ctx.tokenApp.unrecorded.add(cbburn);
      expect(await admin(inFlight.order.id, "burn_uncredited")).toMatchObject({
        status: "chargeback",
      });
      await k.deliver(k.mock().disputeWon(k.paymentIdOf(inFlight)));
      ctx.tokenApp.unrecorded.delete(cbburn);
      await k.drive(2);
      expect(
        (await k.commands(inFlight.order.id)).find((c) => c.commandId === cbburn)?.status,
      ).toBe("recorded");
      expect(await k.journal(inFlight.order.id)).not.toHaveProperty([
        "onramp.uncredited_burned:chargeback_receivable",
      ]);
      expect(pages()).toContain("ramp command recorded after its order settled");
      // Nothing books the burn of tokens the user is owed: the liability check turns red.
      expect(k.checkOf(await k.reconciliation(), "issuance_matches_liability").status).toBe("red");
    } finally {
      sentry.mockRestore();
    }
  });

  it("R1-3: a chargeback burn token-app refused, past the re-send window, is requested again under the next generation and burns N once", async () => {
    const res = await chargedBackUncredited("r13-cbburn", "40");
    const mintId = rampCommandId("mint", res.order.id);
    const first = rampCommandId("cbburn", res.order.id);
    ctx.tokenApp.nextPost = REJECTED;
    expect(await admin(res.order.id, "burn_uncredited")).toMatchObject({ status: "chargeback" });
    expect((await k.commands(res.order.id)).find((c) => c.commandId === first)?.status).toBe(
      "rejected",
    );
    // Inside the window the refused burn is re-sent under its id (token.command.resend).
    expect(await admin(res.order.id, "burn_uncredited", 409)).toMatchObject({
      message: expect.stringMatching(/already requested/) as string,
    });
    const hours = ctx.config.tokenCommands.resendMaxAgeHours + 1;
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET last_post_at = now() - make_interval(hours => $2) WHERE command_id = $1`,
      [first, hours],
    );
    const second = rampCommandId("cbburn", res.order.id, 2);
    expect(await admin(res.order.id, "burn_uncredited")).toMatchObject({
      status: "chargeback",
      details: { cbburnCommandId: second },
    });
    await k.drive(2);
    expect((await k.commands(res.order.id)).map((c) => [c.commandId, c.status])).toEqual([
      [mintId, "recorded"],
      [first, "rejected"],
      [second, "recorded"],
    ]);
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.uncredited_burned:customer_liability": dec("40"),
      "onramp.uncredited_burned:chargeback_receivable": dec("-40"),
    });
    await k.expectIdentities();
  });

  it("R1-1: a mint recorded for an order already refunding books nothing and pages (never an unbacked onramp.minted)", async () => {
    const sentry = jest.spyOn(ctx.get(SentryService), "captureMessage");
    try {
      const b = await k.buyer("r11-refunding");
      const res = await paidOnly(b, "20");
      const mintId = rampCommandId("mint", res.order.id);
      ctx.tokenApp.unrecorded.add(mintId);
      await k.fulfilment().advance(res.order.id);
      expect((await k.order(res.order.id)).status).toBe("minting");
      // As if a refund had settled the order on the mint never landing while a re-send went out.
      await ctx.dataSource.query(
        `UPDATE to_ramp_orders SET status = 'refunding', version = version + 1 WHERE id = $1`,
        [res.order.id],
      );
      ctx.tokenApp.unrecorded.delete(mintId);
      await ctx.get(TokenAppSyncService).syncOnce("test");
      expect((await k.commands(res.order.id)).map((c) => [c.kind, c.status])).toEqual([
        ["mint", "recorded"],
      ]);
      expect(Object.keys(await k.journal(res.order.id))).not.toContain(
        "onramp.minted:customer_liability",
      );
      expect(sentry.mock.calls.map((c) => String(c[0]))).toContain(
        "ramp command recorded after its order settled",
      );
    } finally {
      sentry.mockRestore();
    }
  });

  it("#10 minting: a PARTIAL chargeback pending on the mint books what the acquirer took; burn_uncredited (which clears F) is refused — settled by hand (S8)", async () => {
    const b = await k.buyer("cbpartial");
    const res = await paidOnly(b, "50");
    const mintId = rampCommandId("mint", res.order.id);
    ctx.tokenApp.unrecorded.add(mintId);
    await k.fulfilment().advance(res.order.id);
    await k.deliver(k.mock().chargeback(k.paymentIdOf(res), b.user.id, parseAmount("30")));
    expect(await k.order(res.order.id)).toMatchObject({
      status: "minting",
      details: { chargeback: { state: "pending", amount: dec("30") } },
    });
    ctx.tokenApp.unrecorded.delete(mintId);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({ status: "chargeback" });
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.chargeback_minted:chargeback_receivable": dec("30"),
      "onramp.chargeback_minted:provider_clearing": dec("-30"),
    });
    await k.expectIdentities();
    const refused = await admin(res.order.id, "burn_uncredited", 409);
    expect(refused).toMatchObject({ error: "ramp_order_state" });
    expect(JSON.stringify(refused)).toMatch(/partial chargeback/);
  });

  it("#10 minting: a chargeback pending on a mint that never lands ends as chargeback + onramp.chargeback", async () => {
    const b = await k.buyer("cbno");
    const res = await paidOnly(b, "20");
    // token-app unreachable: the command is written with the CAS but nothing is sent (pending, 0 attempts).
    ctx.tokenApp.configured = false;
    await k.fulfilment().advance(res.order.id);
    expect((await k.commands(res.order.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
    await chargeback(b, res);
    expect((await k.order(res.order.id)).details).toMatchObject({
      chargeback: { state: "pending" },
    });
    // The never-sent command goes out now and token-app refuses it for good (403).
    ctx.tokenApp.configured = true;
    ctx.tokenApp.nextPost = REJECTED;
    await k.drive(2);
    expect(await k.order(res.order.id)).toMatchObject({ status: "chargeback" });
    expect((await k.commands(res.order.id))[0]).toMatchObject({ status: "rejected" });
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.chargeback:issuance_pending": dec("20"),
      "onramp.chargeback:provider_clearing": dec("-20"),
    });
    expect(await k.journal(res.order.id)).not.toHaveProperty(["onramp.minted:customer_liability"]);
    await k.expectIdentities();
  });

  it("#10 refunding stays; refunded + chargeback → chargeback_after_refund (post-close poll); a won dispute clears the receivable", async () => {
    const b = await k.buyer("cbref");
    const res = await k.openOnramp(b, "40");
    await k.pay(b, res, "no_3ds");
    k.mock().refundBehaviour = "pending";
    expect(await admin(res.order.id, "refund")).toMatchObject({ status: "refunding" });
    await chargeback(b, res);
    expect((await k.order(res.order.id)).status).toBe("refunding");
    k.mock().settleRefunds();
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "refunded",
      refundedAmount: parseAmount("40"),
    });
    // The poll of the closed order sees the charge-back the refund did not stop.
    await ctx.dataSource.query(`UPDATE to_ramp_orders SET last_polled_at = NULL WHERE id = $1`, [
      res.order.id,
    ]);
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "refunded",
      details: { chargeback: { state: "charged_back" } },
    });
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.refunded:issuance_pending": dec("40"),
      "onramp.chargeback_after_refund:chargeback_receivable": dec("40"),
      "onramp.chargeback_after_refund:provider_clearing": dec("-40"),
    });
    await k.deliver(k.mock().disputeWon(k.paymentIdOf(res)));
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.chargeback_reversed:provider_clearing": dec("40"),
      "onramp.chargeback_reversed:chargeback_receivable": dec("-40"),
    });
    const totals = await ctx.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ramp_journal WHERE order_id = $1 AND account = 'chargeback_receivable'`,
      [res.order.id],
    );
    expect(parseAmount(totals[0].total)).toBe(0n);
    await k.expectIdentities();
  });
});

describe("ramp core: captures, checkouts and events (M4, M7, H5, H6, E-D7)", () => {
  it("M4: a partial capture C ≠ F is refund-only — booked at C without fee, never approved, refunded C", async () => {
    const b = await k.buyer("m4");
    const res = await k.openOnramp(b, "100");
    await k.pay(b, res, "succeeded", { capturedAmount: "60" });
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
      lastError: "amount_mismatch",
      capturedAmount: parseAmount("60"),
    });
    expect(await admin(res.order.id, "retry", 409)).toMatchObject({ error: "ramp_order_state" });
    expect(await admin(res.order.id, "refund")).toMatchObject({
      status: "refunded",
      refundedAmount: dec("60"),
    });
    expect(await k.mock().getPayment(k.paymentIdOf(res))).toMatchObject({
      status: "refunded",
      refundedAmount: parseAmount("60"),
    });
    expect(await k.journal(res.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("60"),
      "onramp.captured:issuance_pending": dec("-60"),
      "psp.fee_accrued:psp_fees": dec("1.44"),
      "psp.fee_accrued:provider_clearing": dec("-1.44"),
      "onramp.refunded:issuance_pending": dec("60"),
      "onramp.refunded:provider_clearing": dec("-60"),
    });
    await k.expectIdentities();
  });

  it("M7: cancel asks the acquirer — not_cancellable → 409 and the order stays; already_paid → the capture is applied", async () => {
    const b = await k.buyer("m7");
    const res = await k.openOnramp(b, "20");
    k.mock().cancelBehaviour = "not_cancellable";
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/ramp/orders/${res.order.id}/cancel`)
        .set(b.headers)
        .send({})
        .expect(409),
    );
    expect(refused).toMatchObject({
      error: "ramp_order_state",
      details: { reason: "not_cancellable" },
    });
    expect((await k.order(res.order.id)).status).toBe("awaiting_payment");
    // The cardholder paid; the webhook has not arrived yet when the user cancels.
    k.mock().complete(k.paymentIdOf(res), b.user.id, "succeeded");
    await ctx.agent
      .post(`/api/v1/ramp/orders/${res.order.id}/cancel`)
      .set(b.headers)
      .send({})
      .expect(409);
    expect((await k.order(res.order.id)).status).toBe("paid");
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    await k.expectIdentities();
  });

  it("H5: a createPayment whose answer was lost leaves the order created; the stale scan finds the payment by merchant reference and adopts it", async () => {
    const b = await k.buyer("h5");
    k.mock().createTimeouts = 1;
    const key = nextKey();
    await ctx.agent
      .post("/api/v1/ramp/onramp")
      .set(b.headers)
      .set("Idempotency-Key", key)
      .send({ amount: "30" })
      .expect(502);
    const [created] = await ctx.dataSource
      .getRepository(RampOrderEntity)
      .find({ where: { userId: b.user.id } });
    expect(created).toMatchObject({ status: "created", providerPaymentId: null });
    // Younger than RAMP_CREATED_STALE_MIN: left alone (the create may still be running).
    await k.fulfilment().scan();
    expect((await k.order(created.id)).status).toBe("created");
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET created_at = now() - interval '6 minutes' WHERE id = $1`,
      [created.id],
    );
    await k.fulfilment().scan();
    const adopted = await k.order(created.id);
    expect(adopted).toMatchObject({
      status: "awaiting_payment",
      providerPaymentId: expect.stringMatching(/^mockpay_/) as string,
    });
    await k.deliver(k.mock().complete(adopted.providerPaymentId ?? "", b.user.id, "succeeded"));
    await k.drive();
    expect((await k.order(created.id)).status).toBe("completed");
    await k.expectIdentities();
  });

  it("H5: a payment created after the order was closed keeps its id and goes to review; the user gets 409, not a checkout", async () => {
    const b = await k.buyer("h5lost");
    k.mock().onCreatePayment = async (orderId) => {
      // The stale scan decided "no payment" a moment before the acquirer created it.
      const order = await k.order(orderId);
      await ctx.get(RampOrderStore).transition(order, ["created"], "failed", {}, { actor: SYSTEM });
    };
    const body = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/ramp/onramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "30" })
        .expect(409),
    );
    expect(body.error).toBe("ramp_order_state");
    const [o] = await ctx.dataSource
      .getRepository(RampOrderEntity)
      .find({ where: { userId: b.user.id } });
    expect(o).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
      providerPaymentId: expect.stringMatching(/^mockpay_/) as string,
      details: { reviewFrom: "failed" },
    });
    expect((await k.mock().getPayment(o.providerPaymentId ?? "")).status).toBe("cancelled");
  });

  it("E-D7: a checkout link outside RAMP_PUBLIC_APP_URL's origin (mock) fails the order closed and voids the payment", async () => {
    const b = await k.buyer("ed7");
    for (const url of [
      "javascript:alert(1)",
      "https://evil.example/pay",
      "http://user:pw@app.test/x",
    ]) {
      k.mock().checkoutUrlOverride = url;
      await ctx.agent
        .post("/api/v1/ramp/onramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "10" })
        .expect(502);
    }
    const orders = await ctx.dataSource
      .getRepository(RampOrderEntity)
      .find({ where: { userId: b.user.id } });
    expect(orders.map((o) => [o.status, o.checkoutUrl, o.lastError]).sort()).toEqual([
      ["failed", null, "checkout_url_credentials"],
      ["failed", null, "checkout_url_unexpected_origin"],
      ["failed", null, "checkout_url_unexpected_origin"],
    ]);
    for (const o of orders)
      expect((await k.mock().getPayment(o.providerPaymentId ?? "")).status).toBe("cancelled");
  });

  it("H6 / E-D1: an event the acquirer cannot answer backs off with no attempt cap; a busy order is not an attempt; it dies only after RAMP_EVENT_DEAD_AFTER_HOURS — and the poll still finds the money", async () => {
    const b = await k.buyer("h6");
    const res = await k.openOnramp(b, "20");
    const delivery = k.mock().complete(k.paymentIdOf(res), b.user.id, "succeeded");
    k.mock().readFailure = new ApiError(502, "upstream_failed", "acquirer down");
    const from = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).length;
    await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set(delivery.headers)
      .send(delivery.rawBody.toString("utf8"))
      .expect(200);
    const [trigger] = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).slice(from);
    const events = ctx.dataSource.getRepository(RampEventEntity);
    for (let i = 1; i <= 25; i += 1)
      expect(await ctx.nats.dispatch(trigger.subject, trigger.payload)).toEqual(["nak"]);
    let event = await events.findOneByOrFail({});
    expect(event).toMatchObject({ attempts: 25, processedAt: null, deadAt: null });
    expect(event.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Contention: the order lock is held — retried, not counted.
    const lock = await ctx.redis.acquireLock(`lock:ramp:${res.order.id}`, 60_000);
    expect(await ctx.nats.dispatch(trigger.subject, trigger.payload)).toEqual(["nak"]);
    expect((await events.findOneByOrFail({})).attempts).toBe(25);
    await lock.release();

    // The sweep re-publishes a due event, one message per attempt.
    await events.update({ id: event.id }, { nextAttemptAt: new Date(Date.now() - 1000) });
    const before = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).length;
    expect(await k.fulfilment().sweepEvents()).toBe(1);
    expect(ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).slice(before)).toEqual([
      expect.objectContaining({ msgId: `${event.eventKey}:25` }),
    ]);

    // 73 h of failure: dead (terminated, audited) — never silently dropped.
    await events.update({ id: event.id }, { receivedAt: new Date(Date.now() - 73 * 3_600_000) });
    expect(await ctx.nats.dispatch(trigger.subject, trigger.payload)).toEqual(["term"]);
    event = await events.findOneByOrFail({});
    expect(event.deadAt).not.toBeNull();
    expect(
      await ctx.dataSource.query(`SELECT 1 FROM to_audit_events WHERE action = 'ramp.event_dead'`),
    ).toHaveLength(1);
    expect(await k.fulfilment().sweepEvents()).toBe(0);

    // The acquirer is back: the checkout poll applies the capture the dead event was about.
    k.mock().readFailure = null;
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET created_at = now() - interval '2 minutes' WHERE id = $1`,
      [res.order.id],
    );
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    await k.expectIdentities();
  });

  it("H6: a capture after the user cancelled is found by the post-close poll → needs_review(payment), booked", async () => {
    const b = await k.buyer("late");
    const res = await k.openOnramp(b, "15");
    await ctx.agent
      .post(`/api/v1/ramp/orders/${res.order.id}/cancel`)
      .set(b.headers)
      .send({})
      .expect(200);
    k.mock().complete(k.paymentIdOf(res), b.user.id, "succeeded"); // no webhook ever arrives
    await k.fulfilment().scan();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
      details: { reviewFrom: "cancelled" },
      lastError: expect.stringContaining("captured_after_close") as string,
    });
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.captured:provider_clearing": dec("15"),
    });
    await k.expectIdentities();
  });
});

describe("ramp core: token commands, holds, accounts and admin actions (C2, #8, M1, M2, E-D8, H1)", () => {
  it("a mint token-app refuses goes to review at once and is never re-sent; the capture can then be refunded", async () => {
    const b = await k.buyer("rej");
    const res = await k.openOnramp(b, "30");
    ctx.tokenApp.nextPost = REJECTED;
    await k.pay(b, res);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "mint",
      details: { reviewFrom: "minting" },
    });
    expect(await k.commands(res.order.id)).toMatchObject([{ status: "rejected", attempts: 1 }]);
    expect(ctx.tokenApp.minted).toEqual([]);
    expect(await admin(res.order.id, "refund")).toMatchObject({ status: "refunded" });
    expect((await k.commands(res.order.id))[0]).toMatchObject({ status: "rejected", attempts: 1 });
    await k.expectIdentities();
  });

  it("an unresolved mint waits (no re-send), goes to review after RAMP_TOKEN_REVIEW_AFTER_MIN since its last POST, and retry re-sends the SAME id (four-eyes plan)", async () => {
    const b = await k.buyer("unk");
    const res = await k.openOnramp(b, "35");
    ctx.tokenApp.nextPost = LOST;
    await k.pay(b, res);
    await k.drive();
    const mintId = rampCommandId("mint", res.order.id);
    expect((await k.order(res.order.id)).status).toBe("minting");
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: mintId, status: "unknown", attempts: 1 },
    ]);
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET last_post_at = now() - interval '121 minutes' WHERE command_id = $1`,
      [mintId],
    );
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "mint",
      details: { reviewFrom: "minting" },
    });
    expect((await k.commands(res.order.id))[0]).toMatchObject({ status: "unknown", attempts: 1 });
    expect(ctx.tokenApp.minted).toEqual([]);

    const plan = await ctx.get(RampActionsService).validateRetry(res.order.id);
    expect(plan).toMatchObject({
      target: "minting",
      resendCommandId: mintId,
      singleControl: false,
    });
    expect(await admin(res.order.id, "retry")).toMatchObject({ status: "minting" });
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(ctx.tokenApp.minted.map((m) => m.commandId)).toEqual([mintId]);
    expect((await k.commands(res.order.id))[0]).toMatchObject({ status: "recorded", attempts: 2 });
    await k.expectIdentities();
  });

  it("a mint recorded with another amount (mismatch) goes to review at once; retry is refused until it is compensated", async () => {
    const b = await k.buyer("mis");
    const res = await k.openOnramp(b, "45");
    const mintId = rampCommandId("mint", res.order.id);
    ctx.tokenApp.nextPost = post("accepted", 200, null, false);
    ctx.tokenApp.extraRecords.push({
      kind: "mint",
      commandId: mintId,
      updateId: "u-mis",
      partyId: ctx.config.treasuryPartyId,
      instrumentId: "Amulet",
      amount: parseAmount("54"),
      createdAt: new Date(),
    });
    await k.pay(b, res);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "mint",
    });
    expect((await k.commands(res.order.id))[0]).toMatchObject({ status: "mismatch" });
    expect(await admin(res.order.id, "retry", 409)).toMatchObject({ error: "ramp_order_state" });
    expect(await admin(res.order.id, "refund", 409)).toMatchObject({ error: "ramp_order_state" });
  });

  it("M1: card value still minting counts in the exposure — a non-refund exit (OCT) cannot take it", async () => {
    k.mock().cardCashoutMode = "oct";
    const b = await k.buyer("m1");
    await k.bought(b, "100");
    await k.decayExposure();
    const res = await k.openOnramp(b, "50");
    ctx.tokenApp.nextPost = LOST;
    await k.pay(b, res);
    expect((await k.order(res.order.id)).status).toBe("minting");
    expect(
      bodyOf<ApiRampOverview>(await ctx.agent.get("/api/v1/ramp").set(b.headers).expect(200))
        .exposure,
    ).toEqual({ amount: dec("50"), withdrawableToBank: dec("50") });
    const card = await k.payoutCard(b);
    const open = (amount: string): Promise<{ status: number; body: unknown }> =>
      ctx.agent
        .post("/api/v1/ramp/offramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount, destination: { kind: "card", paymentMethodId: card.id } });
    expect((await open("60")).body).toMatchObject({
      error: "ramp_exposure",
      details: { withdrawableToBank: dec("50") },
    });
    expect((await open("50")).status).toBe(200);
  });

  it("M2: a suspended account mints nothing (paid → needs_review(mint))", async () => {
    const b = await k.buyer("m2a");
    const res = await paidOnly(b, "20");
    await ctx.get(UserService).suspend(b.user.id, "test", SYSTEM);
    await k.fulfilment().advance(res.order.id);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "mint",
      mintCommandId: null,
    });
    expect(await k.commands(res.order.id)).toEqual([]);
  });

  it("E-D8: re-activating a removed card counts against RAMP_MAX_CARDS", async () => {
    const b = await k.buyer("ed8");
    const first = await k.bought(b, "10", "ed8-a");
    await k.bought(b, "10", "ed8-b");
    await k.bought(b, "10", "ed8-c");
    await ctx.agent
      .delete(`/api/v1/ramp/payment-methods/${first.paymentMethodId ?? ""}`)
      .set(b.headers)
      .expect(204);
    await k.bought(b, "10", "ed8-d");
    // Card "a" comes back while three cards are active: refused, not silently re-activated.
    const again = await k.openOnramp(b, "10");
    await k.pay(b, again, "succeeded", { cardSeed: "ed8-a" });
    expect(await k.order(again.order.id)).toMatchObject({
      status: "needs_review",
      lastError: "card_limit",
    });
    const methods = ctx.dataSource.getRepository(RampPaymentMethodEntity);
    expect(await methods.count({ where: { userId: b.user.id, status: "active" } })).toBe(3);
    expect((await methods.findOneByOrFail({ id: first.paymentMethodId ?? "" })).status).toBe(
      "removed",
    );
  });

  it("H1: an action decided on a stale snapshot loses; a busy order refuses; the order's own user is refused", async () => {
    const b = await k.buyer("h1");
    const res = await k.openOnramp(b, "30");
    await k.pay(b, res, "no_3ds");
    const actions = ctx.get(RampActionsService);
    const stale = await actions.snapshot(res.order.id);
    // Operator A approves the capture; operator B's refund decided before it must not run.
    expect(await admin(res.order.id, "retry")).toMatchObject({ status: "minting" });
    const ctxB = {
      actor: { type: "admin" as const, userId: "00000000-0000-4000-8000-0000000000bb" },
      reason: "stale",
    };
    await expect(actions.executeRefund(res.order.id, stale, ctxB)).rejects.toMatchObject({
      code: "ramp_order_state",
    });
    await expect(actions.executeRefund(res.order.id, null, ctxB)).rejects.toMatchObject({
      code: "ramp_order_state",
    });
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");

    const other = await k.openOnramp(b, "30");
    await k.pay(b, other, "no_3ds");
    const lock = await ctx.redis.acquireLock(`lock:ramp:${other.order.id}`, 60_000);
    await expect(actions.executeRetry(other.order.id, null, ctxB)).rejects.toMatchObject({
      code: "ramp_order_state",
    });
    await lock.release();
    await expect(
      actions.executeRetry(other.order.id, null, {
        actor: { type: "admin", userId: b.user.id },
        reason: "self",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await k.expectIdentities();
  });
});

describe("review group A: settled orders, never-sent commands, the webhook inbox, the user view, scan indexes (C2, C35, C31, C11, C43)", () => {
  /** A dead acquirer webhook: delivered, failed, and past RAMP_EVENT_DEAD_AFTER_HOURS (73 h). */
  async function deadEvent(delivery: {
    headers: Record<string, string>;
    rawBody: Buffer;
  }): Promise<{ id: string; trigger: { subject: string; payload: unknown } }> {
    const from = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).length;
    await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set(delivery.headers)
      .send(delivery.rawBody.toString("utf8"))
      .expect(200);
    const [trigger] = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).slice(from);
    const { eventId } = trigger.payload as { eventId: string };
    expect(await ctx.nats.dispatch(trigger.subject, trigger.payload)).toEqual(["nak"]);
    await ctx.dataSource
      .getRepository(RampEventEntity)
      .update({ id: eventId }, { receivedAt: new Date(Date.now() - 73 * 3_600_000) });
    expect(await ctx.nats.dispatch(trigger.subject, trigger.payload)).toEqual(["term"]);
    return { id: eventId, trigger };
  }

  async function events(
    status: "dead" | "unprocessed",
    query = "",
  ): Promise<{ items: { id: string; [k: string]: unknown }[]; nextCursor: string | null }> {
    return bodyOf(
      await ctx.agent
        .get(`/api/v1/admin/ramp/events?status=${status}${query}`)
        .set(await k.adminHeaders())
        .expect(200),
    );
  }

  it("C2: a mint that never landed is not re-sent once the order settled on that (refunded); one landing anyway books nothing — issuance goes red and pages", async () => {
    const b = await k.buyer("c2-on");
    const res = await k.openOnramp(b, "30");
    ctx.tokenApp.nextPost = REJECTED;
    await k.pay(b, res);
    await k.drive();
    const mintId = rampCommandId("mint", res.order.id);
    expect(await admin(res.order.id, "refund")).toMatchObject({ status: "refunded" });
    // The row alone would allow it (rejected, no record, inside the dedup window): the order does not.
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/tokens/commands/${mintId}/resend`)
        .set(await k.adminHeaders())
        .send({ reason: "e2e resend after refund" })
        .expect(409),
    );
    expect(refused).toMatchObject({
      error: "token_command_state",
      message: expect.stringMatching(/no longer waits for it/) as string,
      details: { orderId: res.order.id, orderStatus: "refunded" },
    });
    expect(ctx.tokenApp.minted).toEqual([]);
    // Defence in depth: it lands all the same (a re-send that slipped through) — booked nowhere.
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET status = 'submitted' WHERE command_id = $1`,
      [mintId],
    );
    ctx.tokenApp.extraRecords.push({
      kind: "mint",
      commandId: mintId,
      updateId: "update-c2-late",
      partyId: TEST_TREASURY,
      instrumentId: TEST_COLLATERAL.id,
      amount: parseAmount("30"),
      createdAt: new Date(),
    });
    const paged = jest.spyOn(ctx.get(SentryService), "captureMessage");
    await k.drive(1);
    const pages = paged.mock.calls.map((c) => [c[0], c[2]]);
    paged.mockRestore();
    expect(await k.commands(res.order.id)).toMatchObject([{ status: "recorded" }]);
    expect(await k.order(res.order.id)).toMatchObject({ status: "refunded" });
    expect(Object.keys(await k.journal(res.order.id)).filter((x) => x.includes("minted"))).toEqual(
      [],
    );
    expect(pages).toContainEqual([
      "ramp command recorded after its order settled",
      expect.objectContaining({ orderId: res.order.id, commandId: mintId, page: "true" }),
    ]);
    expect(k.checkOf(await k.reconciliation(), "issuance_matches_liability").status).toBe("red");
  });

  it("C35: a mint never sent (token-app unreachable) past RAMP_TOKEN_REVIEW_AFTER_MIN goes to review; a single-control retry POSTs it at last and the order completes", async () => {
    const b = await k.buyer("c35-on");
    const res = await k.openOnramp(b, "26");
    ctx.tokenApp.configured = false;
    await k.pay(b, res);
    await k.drive(2);
    const mintId = rampCommandId("mint", res.order.id);
    expect(await k.order(res.order.id)).toMatchObject({ status: "minting" });
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: mintId, status: "pending", attempts: 0, lastPostAt: null },
    ]);
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET created_at = now() - interval '121 minutes' WHERE command_id = $1`,
      [mintId],
    );
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status_changed_at = now() - interval '121 minutes' WHERE id = $1`,
      [res.order.id],
    );
    await k.drive(1);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "mint",
      details: { reviewFrom: "minting" },
    });
    ctx.tokenApp.configured = true;
    expect(await ctx.get(RampActionsService).validateRetry(res.order.id)).toMatchObject({
      target: "minting",
      resendCommandId: null,
      singleControl: true,
    });
    // The retry's own advance POSTs the row (it never counted as sent) instead of bouncing back.
    expect(await admin(res.order.id, "retry")).toMatchObject({ status: "minting" });
    expect(ctx.tokenApp.minted.map((m) => m.commandId)).toEqual([mintId]);
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(await k.commands(res.order.id)).toMatchObject([{ status: "recorded", attempts: 1 }]);
    await k.expectIdentities();
  });

  it("C31: dead webhooks are listed; a replay applies one with a fresh dead-after window (audited); a dead chargeback about no order of ours is closed with a reason — events_dead turns green", async () => {
    const recon = ctx.get(RampReconChecks);
    // 1. A capture whose acquirer re-read failed for 73 h.
    const b = await k.buyer("c31");
    const res = await k.openOnramp(b, "20");
    k.mock().readFailure = new ApiError(502, "upstream_failed", "acquirer down");
    const capture = await deadEvent(k.mock().complete(k.paymentIdOf(res), b.user.id, "succeeded"));
    // 2. A chargeback for an object no order of ours has.
    const stray = await deadEvent(k.mock().delivery("chargeback.created", "mockpay_stray", null));
    expect((await recon.eventsDead()).status).toBe("red");
    const dead = await events("dead");
    expect(dead.items.map((e) => e.id)).toEqual([capture.id, stray.id]);
    expect(dead.items[1]).toMatchObject({ kind: "chargeback", orderId: null, closedAt: null });
    // The status is required and the cursor only ever a previous page's nextCursor.
    for (const q of [
      "",
      "?status=open",
      "?status=dead&cursor=not%20a%20cursor",
      "?status=dead&cursor=abc",
    ])
      await ctx.agent
        .get(`/api/v1/admin/ramp/events${q}`)
        .set(await k.adminHeaders())
        .expect(400);
    const first = await events("unprocessed", "&limit=1");
    expect(first.items.map((e) => e.id)).toEqual([capture.id]);
    expect(
      (await events("unprocessed", `&limit=1&cursor=${first.nextCursor}`)).items,
    ).toMatchObject([{ id: stray.id }]);

    // Replay while the acquirer is still down: re-armed for a whole new window, not dead at once.
    const headers = await k.adminHeaders();
    const replay = async (id: string, status = 200): Promise<Record<string, unknown>> =>
      bodyOf(
        await ctx.agent
          .post(`/api/v1/admin/ramp/events/${id}/replay`)
          .set(headers)
          .send({ reason: "acquirer API back" })
          .expect(status),
      );
    const from = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).length;
    expect(await replay(capture.id)).toMatchObject({
      event: { id: capture.id, deadAt: null, replayedAt: expect.any(String) as string },
    });
    const [again] = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).slice(from);
    expect(again.msgId).toMatch(/:replay:\d+$/);
    expect(await ctx.nats.dispatch(again.subject, again.payload)).toEqual(["nak"]);
    expect(
      await ctx.dataSource.getRepository(RampEventEntity).findOneByOrFail({ id: capture.id }),
    ).toMatchObject({ deadAt: null, processedAt: null });
    // The acquirer answers: the event is applied and the order completes.
    k.mock().readFailure = null;
    expect(await ctx.nats.dispatch(again.subject, again.payload)).toEqual(["ack"]);
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(
      await ctx.dataSource.query(
        `SELECT 1 FROM to_audit_events WHERE action = 'ramp.event_replayed' AND subject_id = $1`,
        [capture.id],
      ),
    ).toHaveLength(1);
    expect((await replay(capture.id, 409)).error).toBe("ramp_event_state");

    // The stray chargeback cannot be applied: closed with a reason (RAMP_DUAL_CONTROL=false here).
    const closed = bodyOf<{ result: { event: Record<string, unknown> } }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/events/${stray.id}/close`)
        .set(headers)
        .send({ reason: "not a payment of ours; the acquirer confirmed" })
        .expect(200),
    );
    expect(closed.result.event).toMatchObject({
      id: stray.id,
      processedAt: expect.any(String) as string,
      closedAt: expect.any(String) as string,
      closeReason: "not a payment of ours; the acquirer confirmed",
    });
    expect((await events("dead")).items).toEqual([]);
    expect((await recon.eventsDead()).status).toBe("green");
    expect((await replay(stray.id, 409)).message).toBe("the event was closed");
    await k.expectIdentities();
  });

  it("C11: the user's order reads the same in every review — reviewStep null, 'processing', no review entry in the timeline — so a compliance review is never told apart", async () => {
    const b = await k.buyer("c11");
    const res = await k.openOnramp(b, "15");
    await k.pay(b, res, "no_3ds");
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
    });
    const seen = bodyOf<{ order: ApiRampOrder }>(
      await ctx.agent.get(`/api/v1/ramp/orders/${res.order.id}`).set(b.headers).expect(200),
    ).order;
    expect(seen).toMatchObject({
      status: "needs_review",
      statusText: "processing",
      reviewStep: null,
    });
    expect(seen.timeline.map((t) => t.status)).not.toContain("needs_review");
    expect(seen.timeline.length).toBeGreaterThan(0);
  });

  it("C43: the closed-order poll and no_stuck_orders read through their partial indexes, not the whole order history", async () => {
    // What is checked: each query CAN read through its partial index and takes its order from it.
    // Which usable index the planner prefers depends on the table's statistics (CI, after other
    // suites' orders were analysed, took ix_to_ramp_orders_status + Sort), so plans that need a
    // bitmap or a sort are switched off and only an index that serves the ORDER BY remains.
    const plan = async (sql: string, params: unknown[]): Promise<string> =>
      ctx.dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL enable_seqscan = off`);
        await m.query(`SET LOCAL enable_bitmapscan = off`);
        await m.query(`SET LOCAL enable_sort = off`);
        const rows = await m.query<{ "QUERY PLAN": string }[]>(`EXPLAIN ${sql}`, params);
        return rows.map((r) => r["QUERY PLAN"]).join("\n");
      });
    const closedStatuses = `('failed', 'expired', 'cancelled', 'completed', 'refunded', 'chargeback')`;
    const arm = (polled: string): string =>
      `("direction" = 'onramp' AND "status" IN ${closedStatuses} AND "provider_payment_id" IS NOT NULL AND "status_changed_at" > $1 AND ${polled})`;
    expect(
      await plan(
        `SELECT "id" FROM "to_ramp_orders" WHERE ${arm(`"last_polled_at" IS NULL`)} OR ${arm(`"last_polled_at" < $2`)} ORDER BY "status_changed_at" ASC LIMIT 100`,
        [new Date(Date.now() - 48 * 3_600_000), new Date(Date.now() - 15 * 60_000)],
      ),
    ).toContain("ix_to_ramp_orders_closed_poll");
    expect(
      await plan(
        `SELECT id FROM to_ramp_orders WHERE status NOT IN ('completed', 'failed', 'expired', 'cancelled', 'refunded', 'chargeback', 'needs_review') AND status_changed_at < $1 ORDER BY status_changed_at ASC LIMIT 501`,
        [new Date()],
      ),
    ).toContain("ix_to_ramp_orders_open");
  });
});
