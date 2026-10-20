/**
 * Ramp v2 methods, card cash-out, exposure and the compliance scaffold (SPEC §9; stage S5): ERIP
 * on-ramps (validated payment details, payer data to the compliance port, refund-only partial
 * captures, the refund_bank path), the card cash-out by partial REFUNDS of the card's own captures
 * (parts, capacity across cash-outs, a refused part → review → the four-eyes reverse_remainder),
 * the card exposure on every non-refund exit, the bank rail before S6, the operator of record,
 * and the ports' holds (a stub compliance port, a stub freeze port). Every money scenario checks
 * order status, journal and token commands together, then the journal identities.
 */
import { Config } from "../src/config";
import { AdminApprovalEntity } from "../src/entities/admin-approval.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { RampOrderEntity } from "../src/entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../src/entities/ramp-payment-method.entity";
import { ComplianceFreezePort } from "../src/services/compliance-freeze.port";
import { PayoutService } from "../src/services/payout.service";
import { RampActionsService } from "../src/services/ramp-actions.service";
import { RampBankAccountEntity } from "../src/entities/ramp-bank-account.entity";
import { RAMP_IBAN_INDEX_PURPOSE, RampBankRailPort } from "../src/services/ramp-bank-rail.port";
import { rampIbanAad } from "../src/services/ramp-bank-sealing.service";
import { SealedDataService } from "../src/services/sealed-data.service";
import {
  RampCompliancePort,
  type ComplianceContext,
  type ComplianceDecision,
  type CompliancePoint,
} from "../src/services/ramp-compliance.port";
import { RampFulfilmentService, rampCommandId } from "../src/services/ramp-fulfilment.service";
import { rampPayerAad } from "../src/services/ramp-payer-sealing.service";
import type {
  ApiRampOfframpResult,
  ApiRampOrder,
  ApiRampOverview,
  ApiRampQuote,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { formatAmount, parseAmount } from "../src/util/money";
import { payoutReferenceDigits } from "../src/util/payout-reference";
import { unseal } from "../src/util/sealed";
import { UserService } from "../src/services/user.service";
import { TEST_COLLATERAL, useTestApp } from "./helpers/app";
import { dec, nextKey, rampKit, type Buyer } from "./helpers/ramp";
import { bodyOf } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const OPERATOR_ENV = {
  RAMP_OPERATOR_NAME: "TruthOracle LLC",
  RAMP_OPERATOR_UNP: "193456789",
  RAMP_OPERATOR_HTP_REF: "HTP-2026-0042",
  RAMP_TERMS_VERSION: "2026-10-01",
  RAMP_TERMS_URL: "https://truthoracle.example/terms/ramp",
};
const ctx = useTestApp({
  env: {
    ADMIN_OPERATORS: operator.partyId,
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
    RAMP_METHODS: "card,erip",
    RAMP_PAYOUT_RAILS: "card,bank",
    ...OPERATOR_ENV,
  },
});
const k = rampKit(ctx, operator);
const ALLOW: ComplianceDecision = { decision: "allow", rules: [], alertIds: [] };

let unbind: (() => void)[] = [];
beforeEach(() => {
  k.mock().reset();
});
afterEach(() => {
  for (const u of unbind) u();
  unbind = [];
});

async function overview(b: Buyer): Promise<ApiRampOverview> {
  return bodyOf<ApiRampOverview>(await ctx.agent.get("/api/v1/ramp").set(b.headers).expect(200));
}

async function orderApi(b: Buyer, id: string): Promise<ApiRampOrder> {
  return bodyOf<{ order: ApiRampOrder }>(
    await ctx.agent.get(`/api/v1/ramp/orders/${id}`).set(b.headers).expect(200),
  ).order;
}

function offramp(
  b: Buyer,
  amount: string,
  destination: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return ctx.agent
    .post("/api/v1/ramp/offramp")
    .set(b.headers)
    .set("Idempotency-Key", nextKey())
    .send({ amount, destination });
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

/** Open a card cash-out of `amount`, sign it, attach it; the background loops run after. */
async function cashOut(b: Buyer, amount: string, cardId: string): Promise<ApiRampOrder> {
  const res = await offramp(b, amount, { kind: "card", paymentMethodId: cardId });
  expect(res.status).toBe(200);
  const order = (res.body as ApiRampOfframpResult).order;
  await attach(b, order.id, k.signWithdraw(b, amount));
  await k.drive();
  return order;
}

/** A compliance port that answers per point and holds while `held` (S7a's shape). */
function stubCompliance(
  answers: Partial<Record<CompliancePoint, ComplianceDecision>>,
  opts: { eligibility?: string[] } = {},
): { held: boolean; returned: boolean; calls: [CompliancePoint, ComplianceContext][] } {
  const state = {
    held: true,
    // C25: AML decided `return` on an alert of the order (the port's optional returnRequested).
    returned: false,
    calls: [] as [CompliancePoint, ComplianceContext][],
  };
  unbind.push(
    ctx.get(RampCompliancePort).bind({
      eligibility: async () => ({
        allowed: !opts.eligibility?.length,
        reasons: opts.eligibility ?? [],
      }),
      consent: async () => ({ required: false, consentId: null }),
      check: async (point, c) => {
        state.calls.push([point, c]);
        return answers[point] ?? ALLOW;
      },
      isHeld: async () => state.held,
      returnRequested: async () => state.returned,
      raise: async () => null,
    }),
  );
  return state;
}

describe("ERIP on-ramp (SPEC §9.2)", () => {
  it("instructions → the payer's bank pays → paid → mint → completed; the facts are kept (payer name sealed) and nothing counts as card exposure", async () => {
    const b = await k.buyer("erip");
    const res = await k.openOnramp(b, "50", nextKey(), "erip");
    const o = await k.order(res.order.id);
    expect(res.order).toMatchObject({
      method: "erip",
      status: "awaiting_payment",
      payoutReference: `TO-${payoutReferenceDigits(o.payoutReference)}`,
      next: {
        kind: "erip",
        serviceCode: "100001",
        accountNumber: payoutReferenceDigits(o.payoutReference),
        amount: dec("50"),
        qrPng: expect.stringMatching(/^iVBORw0KGgo/) as string,
      },
      operator: { name: "TruthOracle LLC" },
    });
    // RAMP_ERIP_TTL_MIN (1440): an invoice is open for a day.
    expect((o.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(23 * 3_600_000);

    await k.pay(b, res, "succeeded", {
      payerName: "IVANOU SIARHEI",
      channel: "online",
      payerIban: "BY13 NBRB 3600 9000 0000 2Z00 AB00",
      payerBankBic: "NBRBBY2X",
    });
    await k.drive();
    const done = await k.order(res.order.id);
    expect(done).toMatchObject({
      status: "completed",
      method: "erip",
      paymentMethodId: null,
      risk: { "onramp.create": { decision: "allow" }, "onramp.capture": { decision: "allow" } },
      details: {
        payment: {
          method: "erip",
          channel: "online",
          payerNameSource: "bank",
          payerBankBic: "NBRBBY2X",
          eripTxnId: expect.stringMatching(/^erip/) as string,
          agentCode: "MOCK01",
          payerIbanHash: { hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string },
        },
      },
    });
    const sealed = (done.details.payment as { payerNameSealed: string }).payerNameSealed;
    expect(unseal(sealed, ctx.config.sealing.data, rampPayerAad(b.user.id, done.id))).toBe(
      "IVANOU SIARHEI",
    );
    expect(JSON.stringify(done.details)).not.toContain("IVANOU");
    // ERIP accrues its own PSP rate (RAMP_ERIP_PSP_FEE_BPS 120): 0.60 on 50.
    expect(await k.journal(done.id)).toEqual({
      "onramp.captured:provider_clearing": dec("50"),
      "onramp.captured:issuance_pending": dec("-50"),
      "psp.fee_accrued:psp_fees": dec("0.6"),
      "psp.fee_accrued:provider_clearing": dec("-0.6"),
      "onramp.minted:issuance_pending": dec("50"),
      "onramp.minted:customer_liability": dec("-50"),
    });
    expect(await k.commands(done.id)).toMatchObject([
      { commandId: rampCommandId("mint", done.id), status: "recorded" },
    ]);
    // ERIP is not a card: no exposure, all of it may go to a bank account.
    expect((await overview(b)).exposure).toEqual({
      amount: dec("0"),
      withdrawableToBank: dec("50"),
    });
    await k.expectIdentities();
  });

  it("H5 for ERIP: an invoice whose create answer was lost is adopted with its instructions re-derived (service code + reference digits + amount) and pays as usual (S8)", async () => {
    const b = await k.buyer("erip-h5");
    k.mock().createTimeouts = 1;
    await ctx.agent
      .post("/api/v1/ramp/onramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount: "45", method: "erip" })
      .expect(502);
    const [created] = await ctx.dataSource
      .getRepository(RampOrderEntity)
      .find({ where: { userId: b.user.id } });
    expect(created).toMatchObject({ status: "created", method: "erip", paymentInstructions: null });
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET created_at = now() - interval '6 minutes' WHERE id = $1`,
      [created.id],
    );
    await k.fulfilment().scan();
    const digits = payoutReferenceDigits(created.payoutReference);
    expect(await k.order(created.id)).toMatchObject({
      status: "awaiting_payment",
      providerPaymentId: expect.stringMatching(/^mockpay_/) as string,
      paymentInstructions: {
        kind: "erip",
        serviceCode: "100001",
        accountNumber: digits,
        amount: dec("45"),
      },
    });
    const shown = await orderApi(b, created.id);
    expect(shown.next).toMatchObject({
      kind: "erip",
      serviceCode: "100001",
      accountNumber: digits,
      amount: dec("45"),
      instructions: expect.arrayContaining([expect.stringContaining(digits)]) as string[],
    });
    await k.pay(b, { order: shown }, "succeeded", {
      payerName: "IVANOU SIARHEI",
      channel: "online",
    });
    await k.drive();
    expect(await k.order(created.id)).toMatchObject({ status: "completed" });
    expect(await k.journal(created.id)).toMatchObject({
      "onramp.captured:provider_clearing": dec("45"),
      "onramp.minted:customer_liability": dec("-45"),
    });
    expect(await k.commands(created.id)).toMatchObject([{ kind: "mint", status: "recorded" }]);
    await k.expectIdentities();
  });

  it("a partial capture (C ≠ F) is refund-only: review, booked at C, nothing minted — and the acquirer cannot refund ERIP: refund_bank (S6)", async () => {
    const b = await k.buyer("erip-partial");
    const res = await k.openOnramp(b, "80", nextKey(), "erip");
    await k.pay(b, res, "succeeded", { capturedAmount: "30", payerName: "IVANOU SIARHEI" });
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
      lastError: "amount_mismatch",
      capturedAmount: parseAmount("30"),
      mintCommandId: null,
    });
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.captured:provider_clearing": dec("30"),
      "onramp.captured:issuance_pending": dec("-30"),
    });
    expect(await k.commands(res.order.id)).toEqual([]);
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${res.order.id}/refund`)
        .set(await k.adminHeaders())
        .send({ reason: "e2e refund" })
        .expect(409),
    );
    expect(refused).toMatchObject({
      error: "ramp_order_state",
      details: { use: "refund_bank" },
    });
    expect(refused.message).toMatch(/does not refund ERIP payments: refund by bank transfer/);
    // S6's refund_bank needs the client-money account, not configured here (test/ramp-bank.e2e-spec.ts runs it).
    const bank = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${res.order.id}/refund_bank`)
        .set(await k.adminHeaders())
        .send({ reason: "e2e", bankAccountId: "00000000-0000-4000-8000-0000000000ba" })
        .expect(409),
    );
    expect(bank).toMatchObject({ error: "ramp_rail_unavailable", details: { rail: "bank" } });
    await k.expectIdentities();
  });

  it("a cash or unknown-channel ERIP payment reaches the compliance port with its payer data (default port: allowed)", async () => {
    const seen = stubCompliance({});
    seen.held = false;
    const b = await k.buyer("erip-cash");
    const res = await k.openOnramp(b, "40", nextKey(), "erip");
    await k.pay(b, res, "succeeded", { channel: "cash" });
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    const capture = seen.calls.find(([p]) => p === "onramp.capture");
    expect(capture?.[1]).toMatchObject({
      userId: b.user.id,
      orderId: res.order.id,
      method: "erip",
      fiatAmount: parseAmount("40"),
      payer: { name: null, nameSource: null, channel: "cash" },
    });
    expect(seen.calls.map(([p]) => p)).toEqual(["onramp.create", "onramp.capture"]);
    await k.expectIdentities();
  });

  it("X15: ERIP details naming another account number fail the order closed and void the invoice; not_cancellable keeps an invoice open", async () => {
    const b = await k.buyer("erip-x15");
    k.mock().eripNextOverride = { accountNumber: "000000000000" };
    await ctx.agent
      .post("/api/v1/ramp/onramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount: "20", method: "erip" })
      .expect(502);
    const [failed] = await ctx.dataSource
      .getRepository(RampOrderEntity)
      .find({ where: { userId: b.user.id } });
    expect(failed).toMatchObject({
      status: "failed",
      lastError: "erip_account_number",
      paymentInstructions: null,
    });
    expect((await k.mock().getPayment(failed.providerPaymentId ?? "")).status).toBe("cancelled");

    k.mock().eripNextOverride = null;
    const res = await k.openOnramp(b, "20", nextKey(), "erip");
    k.mock().cancelBehaviour = "not_cancellable";
    const stuck = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/ramp/orders/${res.order.id}/cancel`)
        .set(b.headers)
        .send({})
        .expect(409),
    );
    expect(stuck).toMatchObject({ details: { reason: "not_cancellable" } });
    expect((await orderApi(b, res.order.id)).next).toMatchObject({ kind: "erip" });
    // One open order per method: a card purchase may run beside the open invoice.
    expect((await k.openOnramp(b, "15")).order.status).toBe("awaiting_payment");
  });
});

describe("card cash-out by refunds (SPEC §9.3, #13)", () => {
  it("pays back across two captures oldest first: parts, refunded_amount bumped, offramp.paid_card, exposure reduced", async () => {
    const b = await k.buyer("refund2");
    const first = await k.bought(b, "60", "card-r2");
    const second = await k.bought(b, "50", "card-r2");
    const card = await k.payoutCard(b);
    expect(card.cashout).toEqual({ mode: "refund", available: dec("110") });
    expect((await overview(b)).exposure).toEqual({
      amount: dec("110"),
      withdrawableToBank: dec("0"),
    });
    // A refund goes back to the card it came from: not limited by the exposure (I5, closed loop).
    const quote = bodyOf<ApiRampQuote>(
      await ctx.agent
        .post("/api/v1/ramp/quote")
        .set(b.headers)
        .send({
          direction: "offramp",
          amount: "100",
          destination: { kind: "card", paymentMethodId: card.id },
        })
        .expect(200),
    );
    expect(quote).toMatchObject({ withinLimits: true, limit: null, fiatAmount: dec("100") });

    const off = await cashOut(b, "100", card.id);
    const done = await k.order(off.id);
    expect(done).toMatchObject({
      status: "completed",
      payoutRail: "card",
      providerPayoutId: null,
      details: {
        cardPayout: {
          mode: "refund",
          parts: [
            {
              onrampOrderId: first.id,
              amount: dec("60"),
              status: "succeeded",
              key: `cashout-${off.id}-${first.id}`,
            },
            {
              onrampOrderId: second.id,
              amount: dec("40"),
              status: "succeeded",
              key: `cashout-${off.id}-${second.id}`,
            },
          ],
        },
        payout: { mode: "refund", cardLast4: card.last4 },
      },
    });
    expect((await k.order(first.id)).refundedAmount).toBe(parseAmount("60"));
    expect((await k.order(second.id)).refundedAmount).toBe(parseAmount("40"));
    const refunds = k.mock().refundsOf(first.providerPaymentId ?? "");
    expect(refunds).toMatchObject([{ amount: parseAmount("60"), status: "succeeded" }]);
    expect(k.mock().refundDescriptionOf(refunds[0].refundId)).toBe(off.payoutReference);
    expect(k.mock().payoutsFor(off.id)).toEqual([]);
    expect(await k.journal(off.id)).toEqual({
      "offramp.burned:customer_liability": dec("100"),
      "offramp.burned:payout_clearing": dec("-100"),
      "offramp.paid_card:payout_clearing": dec("100"),
      "offramp.paid_card:provider_clearing": dec("-100"),
    });
    expect(await k.commands(off.id)).toMatchObject([
      { commandId: rampCommandId("burn", off.id), status: "recorded" },
    ]);
    // What the card gave back is out of the dispute risk; the poll does not read our refunds as reversals.
    expect((await overview(b)).exposure).toEqual({
      amount: dec("10"),
      withdrawableToBank: dec("0"),
    });
    await k.drive();
    expect((await k.order(first.id)).status).toBe("completed");
    expect((await k.payoutCard(b)).cashout).toEqual({ mode: "refund", available: dec("10") });
    await k.expectIdentities();
  });

  it("a chargeback on a capture a cash-out partly refunded books what the dispute could reach (C − refunded), capped when the acquirer reports more; a won dispute clears exactly that (S8)", async () => {
    const b = await k.buyer("cb-partial");
    const bought = await k.bought(b, "100", "card-cbp");
    const off = await cashOut(b, "60", (await k.payoutCard(b)).id);
    expect(await k.order(off.id)).toMatchObject({ status: "completed" });
    expect((await k.order(bought.id)).refundedAmount).toBe(parseAmount("60"));
    // The issuer disputes the on-ramp: the acquirer can only take back the 40 not refunded.
    await k.deliver(k.mock().chargeback(bought.providerPaymentId ?? "", b.user.id));
    expect(await k.order(bought.id)).toMatchObject({
      status: "chargeback",
      details: { chargeback: { state: "charged_back", kind: "chargeback", amount: dec("40") } },
    });
    expect(await k.journal(bought.id)).toMatchObject({
      "onramp.chargeback_minted:chargeback_receivable": dec("40"),
      "onramp.chargeback_minted:provider_clearing": dec("-40"),
    });
    await k.expectIdentities();
    // Won: exactly the booked 40 comes back to provider_clearing.
    await k.deliver(k.mock().disputeWon(bought.providerPaymentId ?? ""));
    expect(await k.journal(bought.id)).toMatchObject({
      "onramp.chargeback_reversed:provider_clearing": dec("40"),
      "onramp.chargeback_reversed:chargeback_receivable": dec("-40"),
    });
    await k.expectIdentities();

    // An acquirer reporting more than the capture left (the whole 50 after a 20 refund) is capped at 30.
    const c = await k.buyer("cb-capped");
    const paid = await k.bought(c, "50", "card-cbc");
    await cashOut(c, "20", (await k.payoutCard(c)).id);
    await k.deliver(
      k.mock().chargeback(paid.providerPaymentId ?? "", c.user.id, parseAmount("50")),
    );
    expect(await k.order(paid.id)).toMatchObject({
      status: "chargeback",
      details: { chargeback: { amount: dec("30") } },
    });
    expect(await k.journal(paid.id)).toMatchObject({
      "onramp.chargeback_minted:chargeback_receivable": dec("30"),
      "onramp.chargeback_minted:provider_clearing": dec("-30"),
    });
    await k.expectIdentities();
  });

  it("a refund the acquirer charges for accrues its fee once per cash-out (psp.fee_accrued = Σ part fees)", async () => {
    const b = await k.buyer("refund-fee");
    await k.bought(b, "20", "card-fee");
    await k.bought(b, "20", "card-fee");
    k.mock().refundFee = parseAmount("0.1");
    const off = await cashOut(b, "30", (await k.payoutCard(b)).id);
    expect(await k.order(off.id)).toMatchObject({
      status: "completed",
      details: { cardPayout: { parts: [{ fee: dec("0.1") }, { fee: dec("0.1") }] } },
    });
    expect(await k.journal(off.id)).toEqual({
      "offramp.burned:customer_liability": dec("30"),
      "offramp.burned:payout_clearing": dec("-30"),
      "offramp.paid_card:payout_clearing": dec("30"),
      "offramp.paid_card:provider_clearing": dec("-30"),
      "psp.fee_accrued:psp_fees": dec("0.2"),
      "psp.fee_accrued:provider_clearing": dec("-0.2"),
    });
    await k.expectIdentities();
  });

  it("refuses a cash-out above what the card can take back — counting other cash-outs in flight, never the order's own parts (ramp_card_cashout_limit)", async () => {
    const b = await k.buyer("refund-cap");
    await k.bought(b, "50", "card-cap");
    const card = await k.payoutCard(b);
    const over = await offramp(b, "60", { kind: "card", paymentMethodId: card.id });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({
      error: "ramp_card_cashout_limit",
      details: { available: dec("50") },
    });
    // A cash-out of 30 is signed (in flight): it reserves 30 of the card's 50.
    const first = (await offramp(b, "30", { kind: "card", paymentMethodId: card.id }))
      .body as ApiRampOfframpResult;
    // The ledger has not shown its MarkPaid yet: it stays `withdrawing`, its parts planned.
    ctx.wallet.lagLedger = true;
    await attach(b, first.order.id, k.signWithdraw(b, "30"));
    const second = await offramp(b, "25", { kind: "card", paymentMethodId: card.id });
    expect(second.body).toMatchObject({
      error: "ramp_card_cashout_limit",
      details: { available: dec("20") },
    });
    expect((await k.payoutCard(b)).cashout.available).toBe(dec("20"));
    // The full-cap cash-out still passes its own checks before MarkPaid and before every part.
    ctx.wallet.lagLedger = false;
    ctx.wallet.applyPending();
    await k.drive();
    expect((await k.order(first.order.id)).status).toBe("completed");
    await k.expectIdentities();
  });

  it("a refused part → needs_review(payout); the four-eyes reverse_remainder re-mints only the unpaid remainder and credits it back", async () => {
    const b = await k.buyer("refund-fail");
    const first = await k.bought(b, "60", "card-rf");
    const second = await k.bought(b, "50", "card-rf");
    const card = await k.payoutCard(b);
    k.mock().refundBehaviourFor.set(second.providerPaymentId ?? "", "fail");
    const off = await cashOut(b, "100", card.id);
    expect(await k.order(off.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payout",
      details: {
        reviewFrom: "paying_out",
        cardPayout: {
          parts: [
            { onrampOrderId: first.id, status: "succeeded" },
            { onrampOrderId: second.id, status: "failed" },
          ],
        },
      },
    });
    expect((await k.order(first.id)).refundedAmount).toBe(parseAmount("60"));
    expect((await k.order(second.id)).refundedAmount).toBe(0n);
    // reverse (all of it) is refused once a part was paid; retry is refused for a refused part.
    const admin = await k.adminHeaders();
    for (const action of ["reverse", "retry"])
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/orders/${off.id}/${action}`)
            .set(admin)
            .send({ reason: `e2e ${action}` })
            .expect(409),
        ).error,
      ).toBe("ramp_order_state");
    const executed = bodyOf<{ approval: { action: string; status: string } }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${off.id}/reverse_remainder`)
        .set(admin)
        .send({ reason: "the issuer refused the second refund" })
        .expect(200),
    );
    expect(executed.approval).toMatchObject({
      action: "ramp.order.reverse_remainder",
      status: "executed",
    });
    await k.drive(6);
    const remint = rampCommandId("remint", off.id);
    expect(await k.order(off.id)).toMatchObject({
      status: "refunded",
      remintCommandId: remint,
      details: {
        cardPayout: {
          reversal: { remainder: dec("40"), paid: dec("60") },
          parts: [{ status: "succeeded" }, { status: "void" }],
        },
      },
    });
    expect(await k.commands(off.id)).toMatchObject([
      { commandId: rampCommandId("burn", off.id), status: "recorded", amount: parseAmount("100") },
      { commandId: remint, status: "recorded", amount: parseAmount("40") },
    ]);
    expect(await k.journal(off.id)).toEqual({
      "offramp.burned:customer_liability": dec("100"),
      "offramp.burned:payout_clearing": dec("-100"),
      "offramp.paid_card:payout_clearing": dec("60"),
      "offramp.paid_card:provider_clearing": dec("-60"),
      "offramp.reversed_partial:payout_clearing": dec("40"),
      "offramp.reversed_partial:customer_liability": dec("-40"),
    });
    // 110 bought − 100 withdrawn + 40 credited back.
    expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)?.balance).toBe(parseAmount("50"));
    expect(
      await ctx.dataSource
        .getRepository(AdminApprovalEntity)
        .count({ where: { action: "ramp.order.reverse_remainder", subjectId: off.id } }),
    ).toBe(1);
    await k.expectIdentities();
  });
});

describe("card cash-out by refunds: the acquirer's view while a part is in flight (S2's open issue)", () => {
  it("the post-close poll counts a pending cash-out part as ours: no acquirer-reversal side effects while the refund settles", async () => {
    const b = await k.buyer("refund-race");
    const bought = await k.bought(b, "50", "card-race");
    const card = await k.payoutCard(b);
    // The acquirer accepts the refund but settles it later.
    k.mock().refundBehaviour = "pending";
    const off = await cashOut(b, "30", card.id);
    expect(await k.order(off.id)).toMatchObject({
      status: "paying_out",
      details: { cardPayout: { parts: [{ status: "pending" }] } },
    });
    // It lands at the acquirer: the payment shows 30 refunded before our part is recorded.
    k.mock().settleRefunds();
    expect((await k.mock().getPayment(bought.providerPaymentId ?? "")).refundedAmount).toBe(
      parseAmount("30"),
    );
    await ctx.get(RampFulfilmentService).refreshPayment(bought.id);
    expect(await k.order(bought.id)).toMatchObject({ status: "completed", refundedAmount: 0n });
    expect(
      (await ctx.dataSource.getRepository(RampOrderEntity).findOneByOrFail({ id: bought.id }))
        .details.chargeback,
    ).toBeUndefined();
    expect((await overview(b)).eligibility.onramp.allowed).toBe(true);
    // The next pass records the part: refunded_amount bumped, the cash-out completes.
    await k.drive();
    expect((await k.order(off.id)).status).toBe("completed");
    expect((await k.order(bought.id)).refundedAmount).toBe(parseAmount("30"));
    await k.expectIdentities();
  });
});

describe("card exposure, rails and the operator of record (SPEC §9.3)", () => {
  it("a plain withdrawal may take only the balance above the card exposure (ERIP value is free); the rest waits and settles once the exposure decays", async () => {
    const b = await k.buyer("exposure");
    await k.bought(b, "60", "card-exp");
    const erip = await k.openOnramp(b, "40", nextKey(), "erip");
    await k.pay(b, erip, "succeeded", { payerName: "IVANOU SIARHEI" });
    await k.drive();
    expect((await overview(b)).exposure).toEqual({
      amount: dec("60"),
      withdrawableToBank: dec("40"),
    });
    const payouts = ctx.dataSource.getRepository(PayoutEntity);
    const fits = k.signWithdraw(b, "40");
    await ctx.get(PayoutService).scan();
    expect(await payouts.findOneByOrFail({ pendingPayoutCid: fits })).toMatchObject({
      status: "settled_external",
    });
    const over = k.signWithdraw(b, "30");
    await ctx.get(PayoutService).scan();
    expect(await payouts.findOneByOrFail({ pendingPayoutCid: over })).toMatchObject({
      status: "blocked_ramp_exposure",
      lastError: expect.stringContaining("dispute window") as string,
    });
    await k.decayExposure();
    await ctx.get(PayoutService).scan();
    expect(await payouts.findOneByOrFail({ pendingPayoutCid: over })).toMatchObject({
      status: "settled_external",
    });
    await k.expectIdentities();
  });

  it("a bank destination answers ramp_rail_unavailable until S6 binds the bank rail; GET /ramp lists the rails and methods", async () => {
    const b = await k.buyer("bank");
    await k.bought(b, "30");
    const view = await overview(b);
    expect(view.methods.map((m) => [m.method, m.ttlMinutes])).toEqual([
      ["card", 30],
      ["erip", 1440],
    ]);
    expect(view.rails.map((r) => r.rail)).toEqual(["card", "bank"]);
    const res = await offramp(b, "20", {
      kind: "bank",
      bankAccountId: "00000000-0000-4000-8000-0000000000ba",
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "ramp_rail_unavailable", details: { rail: "bank" } });
    // Malformed destinations never reach the service.
    for (const destination of [
      { kind: "bank" },
      { kind: "card", bankAccountId: "00000000-0000-4000-8000-0000000000ba" },
      { kind: "wire", paymentMethodId: "00000000-0000-4000-8000-0000000000ba" },
    ] as Record<string, string>[])
      expect((await offramp(b, "20", destination)).status).toBe(400);
    expect(
      await ctx.dataSource
        .getRepository(RampOrderEntity)
        .count({ where: { direction: "offramp" } }),
    ).toBe(0);
  });

  it("an acquirer without card cash-out offers the bank rail only (cardCashout = none)", async () => {
    k.mock().cardCashoutMode = "none";
    const b = await k.buyer("none");
    await k.bought(b, "30");
    expect((await overview(b)).rails.map((r) => r.rail)).toEqual(["bank"]);
    const card = await k.payoutCard(b);
    expect(card.cashout).toEqual({ mode: "none", available: dec("0") });
    expect((await offramp(b, "10", { kind: "card", paymentMethodId: card.id })).body).toMatchObject(
      {
        error: "ramp_rail_unavailable",
        details: { rail: "card" },
      },
    );
  });

  it("a bank cash-out (S6's rail bound by a stub) is a non-refund exit: limited by the exposure, re-checked before MarkPaid, and after the burn it waits in payout_queued", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000ba";
    const asked: [string, string, bigint][] = [];
    unbind.push(
      ctx.get(RampBankRailPort).bind({
        validateDestination: async (userId, id, amount) => {
          asked.push([userId, id, amount]);
          return {
            bankAccountId: id,
            bankName: "Belarusbank",
            bic: "AKBBBY2X",
            ibanMasked: "BY•• •••• … 1234",
          };
        },
        describe: async (id) => ({
          bankAccountId: id,
          bankName: "Belarusbank",
          bic: "AKBBBY2X",
          ibanMasked: "BY•• •••• … 1234",
        }),
      }),
    );
    const b = await k.buyer("bank-stub");
    // S6's foreign key: the order's bank account row must exist (the stub rail decides the rest).
    const sealed = ctx.get(SealedDataService);
    const index = sealed.blindIndex(RAMP_IBAN_INDEX_PURPOSE, "BY86AKBB10100000002966000000");
    await ctx.dataSource.getRepository(RampBankAccountEntity).insert({
      id: accountId,
      userId: b.user.id,
      ibanSealed: sealed.seal("BY86AKBB10100000002966000000", rampIbanAad(b.user.id, accountId)),
      ibanHash: index.hash,
      ibanHashKid: index.kid,
      ibanLast4: "0000",
      bankCode: "AKBB",
      bic: "AKBBBY2X",
      bankName: "Belarusbank",
      nameForm: "lat",
      status: "active",
      coolingOffUntil: new Date(),
      proof: "manual",
      verifiedAt: new Date(),
    });
    await k.bought(b, "50", "card-bank");
    const erip = await k.openOnramp(b, "30", nextKey(), "erip");
    await k.pay(b, erip, "succeeded", { payerName: "IVANOU SIARHEI" });
    await k.drive();
    const bank = { kind: "bank", bankAccountId: accountId };
    expect((await offramp(b, "40", bank)).body).toMatchObject({
      error: "ramp_exposure",
      details: { withdrawableToBank: dec("30") },
    });
    const created = await offramp(b, "30", bank);
    expect(created.status).toBe(200);
    const off = (created.body as ApiRampOfframpResult).order;
    expect(off).toMatchObject({
      rail: "bank",
      destination: {
        kind: "bank",
        bankAccountId: accountId,
        bankName: "Belarusbank",
        ibanMasked: "BY•• •••• … 1234",
      },
    });
    // The rail is asked with P before the exposure is (the refused 40 asked too).
    expect(asked.map(([, , amount]) => amount)).toEqual([parseAmount("40"), parseAmount("30")]);
    expect(asked[1]).toEqual([b.user.id, accountId, parseAmount("30")]);
    await attach(b, off.id, k.signWithdraw(b, "30"));
    await k.drive();
    expect(await k.order(off.id)).toMatchObject({
      status: "payout_queued",
      payoutRail: "bank",
      bankAccountId: accountId,
      providerPayoutId: null,
    });
    expect(await k.journal(off.id)).toEqual({
      "offramp.burned:customer_liability": dec("30"),
      "offramp.burned:payout_clearing": dec("-30"),
    });
    expect(k.mock().payoutsFor(off.id)).toEqual([]);
    await k.expectIdentities();
  });

  it("every order carries the operator of record and the terms version; GET /ramp names the operator and its terms", async () => {
    const b = await k.buyer("operator");
    const bought = await k.bought(b, "20");
    expect(bought.operator).toEqual({
      name: "TruthOracle LLC",
      unp: "193456789",
      htpRef: "HTP-2026-0042",
      termsVersion: "2026-10-01",
    });
    expect(bought.payoutReference).toMatch(/^TO\d{12}$/);
    const view = await overview(b);
    expect(view.operator).toEqual({
      name: "TruthOracle LLC",
      termsUrl: "https://truthoracle.example/terms/ramp",
      termsVersion: "2026-10-01",
    });
    expect(view.consent).toEqual({
      required: false,
      termsVersion: "2026-10-01",
      termsUrl: "https://truthoracle.example/terms/ramp",
    });
    expect((await orderApi(b, bought.id)).operator).toEqual({ name: "TruthOracle LLC" });
  });

  it("OCT (the fallback) pays the BY-issued funding card with the verified name as recipient and the order reference", async () => {
    k.mock().cardCashoutMode = "oct";
    const b = await k.buyer("oct");
    await k.bought(b, "40", "card-oct");
    await k.decayExposure();
    const card = await k.payoutCard(b);
    expect(card.cashout).toEqual({ mode: "oct", available: dec("40") });
    const off = await cashOut(b, "40", card.id);
    const done = await k.order(off.id);
    expect(done.status).toBe("completed");
    expect(k.mock().payoutRequestOf(done.providerPayoutId ?? "")).toMatchObject({
      recipient: {
        firstName: expect.stringMatching(/^First\d+$/) as string,
        lastName: expect.stringMatching(/^Last\d+$/) as string,
      },
      depositRef: off.payoutReference,
    });
    // A foreign-issued card takes no OCT (RAMP_CARD_PAYOUT_COUNTRIES = BY).
    const lt = await k.buyer("oct-lt");
    const res = await k.openOnramp(lt, "30");
    await k.pay(lt, res, "succeeded", { cardSeed: "card-lt", cardCountry: "LT" });
    await k.drive();
    await k.decayExposure();
    const ltCard = await k.payoutCard(lt);
    expect(ltCard).toMatchObject({
      issuerCountry: "LT",
      cashout: { mode: "oct", available: dec("0") },
    });
    const refused = await offramp(lt, "30", { kind: "card", paymentMethodId: ltCard.id });
    expect(refused.body).toMatchObject({
      error: "ramp_not_eligible",
      details: { reasons: ["no_payout_card"] },
    });
    await k.expectIdentities();
  });
});

describe("the compliance and freeze ports hold value (SPEC §9.4, §11.5, I10)", () => {
  const REVIEW: ComplianceDecision = {
    decision: "review",
    rules: ["TM-CASH"],
    alertIds: ["alert-1"],
  };
  const markPaids = (orderId: string): number =>
    ctx.wallet.submits.filter((s) => {
      const json = JSON.stringify(s.commands);
      return json.includes('"choice":"MarkPaid"') && json.includes(`"txHash":"ramp:${orderId}"`);
    }).length;

  it("a review at onramp.capture keeps the money in needs_review(compliance) — the user sees 'processing', nothing is minted; the AML decision releases it without an approval", async () => {
    const port = stubCompliance({ "onramp.capture": REVIEW });
    const b = await k.buyer("held-on");
    const res = await k.openOnramp(b, "25", nextKey(), "erip");
    await k.pay(b, res, "succeeded", { channel: "cash" });
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      mintCommandId: null,
      risk: { "onramp.capture": { decision: "review", rules: ["TM-CASH"], alertIds: ["alert-1"] } },
      details: { complianceHold: { point: "onramp.capture" }, reviewFrom: "awaiting_payment" },
    });
    const seen = await orderApi(b, res.order.id);
    expect(seen).toMatchObject({
      status: "needs_review",
      reviewStep: null,
      statusText: "processing",
    });
    expect(seen.timeline.map((t) => t.status)).toEqual(["created", "awaiting_payment"]);
    expect(await k.commands(res.order.id)).toEqual([]);
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.captured:provider_clearing": dec("25"),
    });
    // An operator cannot retry past the hold: the AML decision is the control.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${res.order.id}/retry`)
          .set(await k.adminHeaders())
          .send({ reason: "e2e retry" })
          .expect(409),
      ).message,
    ).toMatch(/compliance review holds/);
    port.held = false;
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "completed",
      details: { complianceHold: null },
    });
    await k.expectIdentities();
  });

  it("a review at offramp.create creates the order; MarkPaid waits (blocked_compliance, details.hold compliance) until the decision clears, then the cash-out completes", async () => {
    const port = stubCompliance({ "offramp.create": REVIEW });
    const b = await k.buyer("held-off");
    await k.bought(b, "40", "card-held");
    const card = await k.payoutCard(b);
    const created = await offramp(b, "40", { kind: "card", paymentMethodId: card.id });
    expect(created.status).toBe(200);
    const off = (created.body as ApiRampOfframpResult).order;
    expect((await k.order(off.id)).risk).toMatchObject({
      "offramp.create": { decision: "review" },
    });
    const cid = k.signWithdraw(b, "40");
    await attach(b, off.id, cid);
    await k.drive();
    expect(await k.order(off.id)).toMatchObject({
      status: "withdrawing",
      burnCommandId: null,
      details: { hold: { reason: "compliance" } },
    });
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({ status: "blocked_compliance" });
    expect(markPaids(off.id)).toBe(0);
    expect(await orderApi(b, off.id)).toMatchObject({
      status: "withdrawing",
      statusText: "processing",
    });
    port.held = false;
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(markPaids(off.id)).toBe(1);
    expect(await k.order(off.id)).toMatchObject({
      status: "completed",
      risk: { "offramp.payout": { decision: "allow" } },
    });
    await k.expectIdentities();
  });

  it("a deny at a create point refuses neutrally and writes nothing; compliance eligibility reasons reach the user as neutral codes", async () => {
    stubCompliance(
      { "onramp.create": { decision: "deny", rules: ["TM-SANCTIONS"], alertIds: [] } },
      { eligibility: ["consent_required", "screening_pending", "kyc_refresh_required"] },
    );
    const b = await k.buyer("deny");
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["consent_required", "compliance", "additional_info_required"],
    });
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/ramp/onramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "10" })
        .expect(403),
    );
    expect(refused).toMatchObject({
      error: "ramp_not_eligible",
      details: { reasons: ["consent_required", "compliance", "additional_info_required"] },
    });
    expect(JSON.stringify(refused)).not.toMatch(/screening|TM-SANCTIONS/);
    expect(await ctx.dataSource.getRepository(RampOrderEntity).count()).toBe(0);
  });

  it("a deny at onramp.create is the neutral 403 even for an eligible account", async () => {
    stubCompliance({
      "onramp.create": { decision: "deny", rules: ["TM-SANCTIONS"], alertIds: [] },
    });
    const b = await k.buyer("deny2");
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/ramp/onramp")
          .set(b.headers)
          .set("Idempotency-Key", nextKey())
          .send({ amount: "10" })
          .expect(403),
      ),
    ).toMatchObject({ error: "ramp_not_eligible", details: { reasons: ["compliance"] } });
    expect(await ctx.dataSource.getRepository(RampOrderEntity).count()).toBe(0);
  });

  it("a frozen account: no new orders, captured money waits in needs_review(compliance), plain withdrawals blocked_compliance — all resume when the freeze lifts", async () => {
    const frozen = new Set<string>();
    unbind.push(ctx.get(ComplianceFreezePort).bind({ isFrozen: async (id) => frozen.has(id) }));
    const b = await k.buyer("frozen");
    await k.bought(b, "30", "card-frozen");
    await k.decayExposure();
    const open = await k.openOnramp(b, "20");
    frozen.add(b.user.id);
    expect((await overview(b)).eligibility).toEqual({
      onramp: { allowed: false, reasons: ["compliance"] },
      offramp: { allowed: false, reasons: ["compliance"] },
    });
    await ctx.agent
      .post("/api/v1/ramp/onramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount: "10" })
      .expect(403);
    // The open checkout is paid: captured and booked, never minted while frozen.
    await k.pay(b, open);
    await k.drive();
    expect(await k.order(open.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      mintCommandId: null,
      details: { complianceHold: { point: "freeze" } },
    });
    const cid = k.signWithdraw(b, "30");
    await ctx.get(PayoutService).scan();
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({ status: "blocked_compliance" });
    expect(ctx.wallet.transfers).toEqual([]);
    frozen.delete(b.user.id);
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({ status: "settled_external" });
    expect((await k.order(open.order.id)).status).toBe("completed");
    await k.expectIdentities();
  });
});

describe("review finding C37 (card part): a freeze or a compliance hold that arrives after MarkPaid stops the fiat", () => {
  /** A card cash-out past MarkPaid with its burn not yet recorded (`burning`); `release` lets the burn land. */
  async function pastMarkPaid(
    hint: string,
    mode: "refund" | "oct",
  ): Promise<{ b: Buyer; orderId: string; paymentId: string; release: () => void }> {
    k.mock().cardCashoutMode = mode;
    const b = await k.buyer(hint);
    const bought = await k.bought(b, "40", `card-${hint}`);
    if (mode === "oct") await k.decayExposure();
    const card = await k.payoutCard(b);
    const res = await offramp(b, "30", { kind: "card", paymentMethodId: card.id });
    expect(res.status).toBe(200);
    const orderId = (res.body as ApiRampOfframpResult).order.id;
    const burnId = rampCommandId("burn", orderId);
    ctx.tokenApp.unrecorded.add(burnId);
    await attach(b, orderId, k.signWithdraw(b, "30"));
    await k.drive(2);
    expect((await k.order(orderId)).status).toBe("burning");
    return {
      b,
      orderId,
      paymentId: bought.providerPaymentId ?? "",
      release: () => ctx.tokenApp.unrecorded.delete(burnId),
    };
  }

  for (const mode of ["refund", "oct"] as const)
    it(`C37: ${mode === "refund" ? "card refund parts" : "the OCT"}: frozen after MarkPaid → paying_out holds (details.hold frozen), no acquirer call; the lift pays exactly once`, async () => {
      const frozen = new Set<string>();
      unbind.push(ctx.get(ComplianceFreezePort).bind({ isFrozen: async (id) => frozen.has(id) }));
      const { b, orderId, paymentId, release } = await pastMarkPaid(`c37-frz-${mode}`, mode);
      frozen.add(b.user.id);
      release();
      await k.drive();
      expect(await k.order(orderId)).toMatchObject({
        status: "paying_out",
        details: { hold: { reason: "frozen" } },
      });
      expect(k.mock().refundsOf(paymentId)).toEqual([]);
      expect(k.mock().payoutsFor(orderId)).toEqual([]);
      frozen.delete(b.user.id);
      await k.drive();
      expect((await k.order(orderId)).status).toBe("completed");
      if (mode === "refund") expect(k.mock().refundsOf(paymentId)).toHaveLength(1);
      else expect(k.mock().payoutsFor(orderId)).toHaveLength(1);
      await k.expectIdentities();
    });

  for (const mode of ["refund", "oct"] as const)
    it(`C37: ${mode === "refund" ? "card refund parts" : "the OCT"}: a compliance hold that starts after MarkPaid → paying_out holds (details.hold compliance), no acquirer call; the decision pays exactly once`, async () => {
      const port = stubCompliance({
        "offramp.create": { decision: "review", rules: ["TM-NETOUT"], alertIds: ["alert-9"] },
      });
      port.held = false;
      const { orderId, paymentId, release } = await pastMarkPaid(`c37-hold-${mode}`, mode);
      port.held = true;
      release();
      await k.drive();
      expect(await k.order(orderId)).toMatchObject({
        status: "paying_out",
        details: { hold: { reason: "compliance" } },
      });
      expect(k.mock().refundsOf(paymentId)).toEqual([]);
      expect(k.mock().payoutsFor(orderId)).toEqual([]);
      port.held = false;
      await k.drive();
      expect((await k.order(orderId)).status).toBe("completed");
      if (mode === "refund") expect(k.mock().refundsOf(paymentId)).toHaveLength(1);
      else expect(k.mock().payoutsFor(orderId)).toHaveLength(1);
      await k.expectIdentities();
    });
});

describe("review group A: partial reversals resume from review with R; disputes on parts in flight; AML's return after MarkPaid (C34, C4, C35, C20, C25)", () => {
  const REJECTED = {
    outcome: {
      outcome: "rejected" as const,
      httpStatus: 403,
      status: null,
      code: "token_app_forbidden" as const,
      message: "forbidden",
    },
    lands: false,
  };

  /** An order action (RAMP_DUAL_CONTROL=false here: executed at once → its result). */
  async function admin(
    orderId: string,
    action: string,
    status = 200,
  ): Promise<Record<string, unknown>> {
    const body = bodyOf<{ result?: Record<string, unknown> } & Record<string, unknown>>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${orderId}/${action}`)
        .set(await k.adminHeaders())
        .send({ reason: `e2e ${action}` })
        .expect(status),
    );
    return status === 200 && body.result ? body.result : body;
  }

  /** A refund-mode cash-out of 100 over captures of 60 and 50 whose 40 part the issuer refused. */
  async function partlyPaid(hint: string): Promise<{ b: Buyer; off: string }> {
    const b = await k.buyer(hint);
    await k.bought(b, "60", `card-${hint}`);
    const second = await k.bought(b, "50", `card-${hint}`);
    const card = await k.payoutCard(b);
    k.mock().refundBehaviourFor.set(second.providerPaymentId ?? "", "fail");
    const off = await cashOut(b, "100", card.id);
    expect(await k.order(off.id)).toMatchObject({ status: "needs_review", reviewStep: "payout" });
    return { b, off: off.id };
  }

  const shown = async (orderId: string): Promise<string[][]> =>
    (await k.commands(orderId)).map((c) => [c.commandId, c.status, formatAmount(c.amount)]);

  /** One step under TOKEN_APP_MAX_PER_CALL = 50: a re-mint of R (40) passes the caps, T (100) would not. */
  async function capped<T>(fn: () => Promise<T>): Promise<T> {
    const caps = ctx.get(Config).tokenCommands;
    const was = caps.maxPerCall;
    caps.maxPerCall = parseAmount("50");
    try {
      return await fn();
    } finally {
      caps.maxPerCall = was;
    }
  }

  /** The end state of every partial reversal: refunded, R = 40 credited, the journal and token checks whole. */
  async function creditedR(b: Buyer, off: string): Promise<void> {
    expect(await k.order(off)).toMatchObject({
      status: "refunded",
      details: { cardPayout: { reversal: { remainder: dec("40"), paid: dec("60") } } },
    });
    expect(await k.journal(off)).toMatchObject({
      "offramp.paid_card:payout_clearing": dec("60"),
      "offramp.reversed_partial:customer_liability": dec("-40"),
    });
    // 110 bought − 100 withdrawn + 40 credited back.
    expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)?.balance).toBe(parseAmount("50"));
    expect(k.identityRed(await k.reconciliation())).toEqual([]);
    await k.expectIdentities();
  }

  it("C34 / C4: a re-mint token-app refused after reverse_remainder parks the order in review(reversal); retry re-sends R under its id (the parts stay as reverse_remainder left them)", async () => {
    const { b, off } = await partlyPaid("c34rej");
    ctx.tokenApp.nextPost = REJECTED;
    await admin(off, "reverse_remainder");
    await k.drive(2);
    const remint = rampCommandId("remint", off);
    expect(await k.order(off)).toMatchObject({
      status: "needs_review",
      reviewStep: "reversal",
      details: { reviewFrom: "reversing" },
    });
    expect((await shown(off))[1]).toEqual([remint, "rejected", dec("40")]);
    expect(await ctx.get(RampActionsService).validateRetry(off)).toMatchObject({
      target: "reversing",
      resendCommandId: remint,
    });
    expect(await capped(() => admin(off, "retry"))).toMatchObject({ status: "reversing" });
    await k.drive(4);
    expect(await shown(off)).toEqual([
      [rampCommandId("burn", off), "recorded", dec("100")],
      [remint, "recorded", dec("40")],
    ]);
    await creditedR(b, off);
  });

  it("C34 / C4: an abandoned re-mint after reverse_remainder → retry records the next generation at R (never T) and the order is refunded", async () => {
    const { b, off } = await partlyPaid("c34abn");
    ctx.tokenApp.nextPost = REJECTED;
    await admin(off, "reverse_remainder");
    await k.drive(2);
    const remint = rampCommandId("remint", off);
    // An approved token.command.abandon (its own preconditions are token-commands.e2e-spec's).
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET status = 'abandoned' WHERE command_id = $1`,
      [remint],
    );
    const next = rampCommandId("remint", off, 2);
    expect(await ctx.get(RampActionsService).validateRetry(off)).toMatchObject({
      target: "reversing",
      newRemintCommandId: next,
    });
    expect(await capped(() => admin(off, "retry"))).toMatchObject({ remintCommandId: next });
    await k.drive(4);
    expect(await shown(off)).toEqual([
      [rampCommandId("burn", off), "recorded", dec("100")],
      [remint, "abandoned", dec("40")],
      [next, "recorded", dec("40")],
    ]);
    expect(ctx.tokenApp.minted.filter((m) => m.commandId === next).map((m) => m.amount)).toEqual([
      parseAmount("40"),
    ]);
    await creditedR(b, off);
  });

  it("R1-3: a re-mint token-app refused, past the re-send window, is retried as the next generation at R (no SQL abandon) and the order is refunded", async () => {
    const { b, off } = await partlyPaid("r13");
    ctx.tokenApp.nextPost = REJECTED;
    await admin(off, "reverse_remainder");
    await k.drive(2);
    const remint = rampCommandId("remint", off);
    expect((await shown(off))[1]).toEqual([remint, "rejected", dec("40")]);
    // The credentials took longer than TOKEN_APP_RESEND_MAX_AGE_HOURS to sort out.
    const hours = ctx.get(Config).tokenCommands.resendMaxAgeHours + 1;
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET last_post_at = now() - make_interval(hours => $2) WHERE command_id = $1`,
      [remint, hours],
    );
    const next = rampCommandId("remint", off, 2);
    expect(await ctx.get(RampActionsService).validateRetry(off)).toMatchObject({
      target: "reversing",
      resendCommandId: null,
      newRemintCommandId: next,
      singleControl: false,
    });
    expect(await capped(() => admin(off, "retry"))).toMatchObject({ remintCommandId: next });
    await k.drive(4);
    expect(await shown(off)).toEqual([
      [rampCommandId("burn", off), "recorded", dec("100")],
      [remint, "rejected", dec("40")],
      [next, "recorded", dec("40")],
    ]);
    await creditedR(b, off);
  });

  it("C34: a four-eyes token.command.resend of a partial reversal's re-mint passes the reserve gate at R; the order then resumes by retry", async () => {
    const { b, off } = await partlyPaid("c34rs");
    ctx.tokenApp.nextPost = REJECTED;
    await admin(off, "reverse_remainder");
    await k.drive(2);
    const remint = rampCommandId("remint", off);
    const resent = await capped(async () =>
      bodyOf<{ result: { status: string; amount: string } }>(
        await ctx.agent
          .post(`/api/v1/admin/tokens/commands/${remint}/resend`)
          .set(await k.adminHeaders())
          .send({ reason: "token-app accepts again" })
          .expect(200),
      ),
    );
    expect(resent.result).toMatchObject({ status: "submitted" });
    await k.drive(2);
    // Recorded while the order waits in review: R is booked, the order still waits for a person.
    expect(await k.order(off)).toMatchObject({ status: "needs_review", reviewStep: "reversal" });
    expect(await admin(off, "retry")).toMatchObject({ status: "refunded" });
    expect(await shown(off)).toEqual([
      [rampCommandId("burn", off), "recorded", dec("100")],
      [remint, "recorded", dec("40")],
    ]);
    await creditedR(b, off);
  });

  it("C35: a re-mint never sent (token-app unreachable) after reverse_remainder → review(reversal) past RAMP_TOKEN_REVIEW_AFTER_MIN; a single-control retry POSTs R and the order is refunded", async () => {
    const { b, off } = await partlyPaid("c35rem");
    ctx.tokenApp.configured = false;
    await admin(off, "reverse_remainder");
    await k.drive(1);
    const remint = rampCommandId("remint", off);
    expect((await shown(off))[1]).toEqual([remint, "pending", dec("40")]);
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET created_at = now() - interval '121 minutes' WHERE command_id = $1`,
      [remint],
    );
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status_changed_at = now() - interval '121 minutes' WHERE id = $1`,
      [off],
    );
    await k.drive(1);
    expect(await k.order(off)).toMatchObject({ status: "needs_review", reviewStep: "reversal" });
    ctx.tokenApp.configured = true;
    expect(await ctx.get(RampActionsService).validateRetry(off)).toMatchObject({
      target: "reversing",
      resendCommandId: null,
      singleControl: true,
    });
    expect(await admin(off, "retry")).toMatchObject({ status: "reversing" });
    expect(ctx.tokenApp.minted.filter((m) => m.commandId === remint)).toHaveLength(1);
    await k.drive(4);
    await creditedR(b, off);
  });

  it("C20: a chargeback on a capture whose cash-out part the acquirer executed but the cash-out has not recorded never counts that part as the acquirer's; the cash-out records it on retry and completes", async () => {
    const b = await k.buyer("c20cb");
    const a = await k.bought(b, "50", "card-c20cb");
    await k.bought(b, "50", "card-c20cb");
    const card = await k.payoutCard(b);
    k.mock().refundBehaviour = "pending";
    const off = await cashOut(b, "30", card.id);
    expect((await k.order(off.id)).status).toBe("paying_out");
    // The acquirer executes the part on A before the cash-out records it; then A is charged back.
    k.mock().settleRefunds();
    expect((await k.mock().getPayment(a.providerPaymentId ?? "")).refundedAmount).toBe(
      parseAmount("30"),
    );
    await k.deliver(k.mock().chargeback(a.providerPaymentId ?? "", b.user.id));
    expect(await k.order(a.id)).toMatchObject({ status: "chargeback", refundedAmount: 0n });
    expect(await k.order(off.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
    });
    // The account is reinstated and the card unblocked (it funded another 3-D Secure capture).
    await ctx.get(UserService).reinstate(b.user.id, "dispute settled", { type: "system" });
    await ctx.dataSource
      .getRepository(RampPaymentMethodEntity)
      .update({ id: card.id }, { status: "active", payoutEligible: true });
    await admin(off.id, "retry");
    await k.drive(2);
    expect((await k.order(off.id)).status).toBe("completed");
    expect((await k.order(a.id)).refundedAmount).toBe(parseAmount("30"));
    expect(await k.journal(off.id)).toMatchObject({
      "offramp.paid_card:payout_clearing": dec("30"),
    });
    await k.expectIdentities();
  });

  it("C20: a part the acquirer paid that its capture cannot take goes to review(payout) — never a silent loop in paying_out", async () => {
    const b = await k.buyer("c20nr");
    const a = await k.bought(b, "50", "card-c20nr");
    const card = await k.payoutCard(b);
    k.mock().refundBehaviour = "pending";
    const off = await cashOut(b, "30", card.id);
    k.mock().settleRefunds();
    // Something else recorded 40 of A's 50 meanwhile (a hand repair, a lost race): 40 + 30 > 50.
    await ctx.dataSource.query(`UPDATE to_ramp_orders SET refunded_amount = 40 WHERE id = $1`, [
      a.id,
    ]);
    await k.drive(1);
    expect(await k.order(off.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payout",
      lastError: expect.stringMatching(
        /card refund part 1 was paid but cannot be recorded on .*: the refunds would exceed the capture/,
      ) as string,
    });
  });

  it("C20: reverse_remainder also runs from the compliance review a chargeback stops a paying cash-out in (the account stays suspended): R is re-minted and credited", async () => {
    const { b, off } = await partlyPaid("c20rr");
    // A chargeback on the account stopped it while it was paying out: compliance review, suspended.
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET review_step = 'compliance' WHERE id = $1`,
      [off],
    );
    await ctx.get(UserService).suspend(b.user.id, "chargeback", { type: "system" });
    await admin(off, "reverse_remainder");
    await k.drive(4);
    await creditedR(b, off);
  });

  /** A card cash-out past MarkPaid with its burn not yet recorded (`burning`); `release` lets the burn land. */
  async function burning(
    hint: string,
    mode: "refund" | "oct",
  ): Promise<{ b: Buyer; orderId: string; paymentId: string; release: () => void }> {
    k.mock().cardCashoutMode = mode;
    const b = await k.buyer(hint);
    const bought = await k.bought(b, "40", `card-${hint}`);
    if (mode === "oct") await k.decayExposure();
    const card = await k.payoutCard(b);
    const res = await offramp(b, "30", { kind: "card", paymentMethodId: card.id });
    expect(res.status).toBe(200);
    const orderId = (res.body as ApiRampOfframpResult).order.id;
    const burnId = rampCommandId("burn", orderId);
    ctx.tokenApp.unrecorded.add(burnId);
    await attach(b, orderId, k.signWithdraw(b, "30"));
    await k.drive(2);
    expect((await k.order(orderId)).status).toBe("burning");
    return {
      b,
      orderId,
      paymentId: bought.providerPaymentId ?? "",
      release: () => ctx.tokenApp.unrecorded.delete(burnId),
    };
  }

  for (const mode of ["refund", "oct"] as const)
    it(`C25: AML's return after MarkPaid stops the ${mode === "refund" ? "card refund parts" : "OCT"} in review(compliance) with no acquirer call; reverse credits T back`, async () => {
      const port = stubCompliance({
        "offramp.create": { decision: "review", rules: ["TM-NETOUT"], alertIds: ["alert-25"] },
      });
      port.held = false;
      const { b, orderId, paymentId, release } = await burning(`c25-${mode}`, mode);
      port.returned = true;
      release();
      await k.drive();
      expect(await k.order(orderId)).toMatchObject({
        status: "needs_review",
        reviewStep: "compliance",
        lastError: "AML decided not to pay this cash-out out",
      });
      expect(k.mock().refundsOf(paymentId)).toEqual([]);
      expect(k.mock().payoutsFor(orderId)).toEqual([]);
      await admin(orderId, "reverse");
      await k.drive();
      expect(await k.order(orderId)).toMatchObject({ status: "refunded" });
      expect(k.mock().refundsOf(paymentId)).toEqual([]);
      expect(k.mock().payoutsFor(orderId)).toEqual([]);
      expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)?.balance).toBe(
        parseAmount("40"),
      );
      await k.expectIdentities();
    });
});
