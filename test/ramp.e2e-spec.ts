/**
 * The fiat ramp end to end (SPEC §4, §5): card on-ramp through the mock acquirer's signed
 * webhooks → provider re-read → paid (capture booked) → mint command written with the CAS → token
 * sync records it (posting + move in its transaction) → Deposit { txRef: mint:<id> } →
 * completed; the closed-loop cash-out — signed Withdraw → binding → MarkPaid { txHash } → ledger
 * proof → burn → card payout (OCT mode here; refund mode in ramp-methods.e2e-spec.ts) — with its
 * reversal and the user's CancelPayout race; reviews, refunds, chargebacks, the card exposure on
 * plain withdrawals (SPEC §9.3), and the reconciliation. Every money
 * scenario checks the journal identities. Real Postgres + Redis; the acquirer is the real mock
 * provider, token-app / ledger / wallet / NATS the usual fakes; the indexer's PendingPayout view
 * is projected by `indexPayouts`.
 */
import { randomUUID } from "node:crypto";

import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { DepositCreditEntity } from "../src/entities/deposit-credit.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { RampEventEntity } from "../src/entities/ramp-event.entity";
import { RampOrderEntity } from "../src/entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../src/entities/ramp-payment-method.entity";
import { UserEntity } from "../src/entities/user.entity";
import { mintCreditCommandId } from "../src/services/deposit.service";
import { PayoutService } from "../src/services/payout.service";
import { rampCardAad } from "../src/services/ramp-card-sealing.service";
import { rampCommandId, RampFulfilmentService } from "../src/services/ramp-fulfilment.service";
import { TokenAppSyncService } from "../src/services/token-app-sync.service";
import type {
  ApiAdminRampOrder,
  ApiAdminRampOrderDetail,
  ApiRampOfframpResult,
  ApiRampOrder,
  ApiRampOrderList,
  ApiRampOverview,
  ApiRampQuote,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { parseAmount } from "../src/util/money";
import { unseal } from "../src/util/sealed";
import { TEST_COLLATERAL, TEST_TREASURY, useTestApp } from "./helpers/app";
import { dec, nextKey, rampKit } from "./helpers/ramp";
import { bodyOf, issueSessionDirect } from "./helpers/session";
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

beforeEach(() => {
  k.mock().reset();
});

describe("fiat ramp (SPEC §4, §5)", () => {
  it("GET /ramp names what blocks an account; KYC is required for card payments whatever KYC_ENFORCE_WITHDRAWALS says", async () => {
    const wallet = makeTestWallet("nokyc");
    const { cookie } = await issueSessionDirect(ctx, wallet);
    const headers = { Cookie: cookie, ...ctx.csrf };
    const overview = bodyOf<ApiRampOverview>(
      await ctx.agent.get("/api/v1/ramp").set(headers).expect(200),
    );
    expect(overview).toMatchObject({
      enabled: true,
      provider: "mock",
      instrument: { admin: TEST_COLLATERAL.admin, id: "Amulet" },
      fiat: { currency: "BYN", decimals: 2 },
      eligibility: {
        onramp: { allowed: false, reasons: ["kyc_required"] },
        offramp: { allowed: false, reasons: ["kyc_required", "no_payout_card"] },
      },
    });
    expect(overview.limits.onramp).toMatchObject({
      min: dec("10"),
      max: dec("2000"),
      dailyRemaining: dec("3000"),
    });
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/ramp/onramp")
        .set(headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "100" })
        .expect(409),
    );
    expect(refused.error).toBe("kyc_required");
    expect(await ctx.dataSource.getRepository(RampOrderEntity).count()).toBe(0);

    // The Idempotency-Key header is mandatory; the amount is validated before anything is written.
    const b = await k.buyer("validated");
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/ramp/onramp")
          .set(b.headers)
          .send({ amount: "100" })
          .expect(400),
      ).error,
    ).toBe("validation_failed");
    for (const body of [
      { amount: "5" },
      { amount: "100.001" },
      { amount: "2500" },
      { amount: "100", method: "krok" },
    ]) {
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post("/api/v1/ramp/onramp")
            .set(b.headers)
            .set("Idempotency-Key", nextKey())
            .send(body)
            .expect(400),
        ).error,
      ).toBe("validation_failed");
    }
    expect(
      bodyOf<ApiRampQuote>(
        await ctx.agent
          .post("/api/v1/ramp/quote")
          .set(b.headers)
          .send({ direction: "onramp", amount: "100" })
          .expect(200),
      ),
    ).toMatchObject({ fiatAmount: dec("100"), tokenAmount: dec("100"), fee: dec("0") });
    // ERIP is a method of the acquirer but not of this deployment (RAMP_METHODS=card).
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/ramp/onramp")
          .set(b.headers)
          .set("Idempotency-Key", nextKey())
          .send({ amount: "100", method: "erip" })
          .expect(503),
      ),
    ).toMatchObject({ error: "ramp_unavailable", details: { reason: "method_unavailable" } });
  });

  it("on-ramp: checkout → signed webhook → re-read → paid → mint command (CAS) → sync records it → Deposit → completed; replays are idempotent", async () => {
    const b = await k.buyer("alice");
    const key = nextKey();
    const res = await k.openOnramp(b, "100", key);
    expect(res.order).toMatchObject({
      direction: "onramp",
      status: "awaiting_payment",
      fiatAmount: dec("100"),
      feeAmount: dec("0"),
      timeline: [
        { status: "created", at: expect.any(String) as string },
        { status: "awaiting_payment", at: expect.any(String) as string },
      ],
    });
    expect(res.order).toMatchObject({
      method: "card",
      rail: null,
      payoutReference: expect.stringMatching(/^TO-\d{12}$/) as string,
      next: {
        kind: "redirect",
        url: expect.stringMatching(
          /^http:\/\/app\.test\/wallet\/ramp\/mock-checkout\?payment=mockpay_/,
        ) as string,
      },
    });
    expect(res.order).not.toHaveProperty("version");
    // A retried POST answers the same order; the key with another request (E-D9) or a second open order is refused.
    expect((await k.openOnramp(b, "100", key)).order.id).toBe(res.order.id);
    for (const [kk, amount, code] of [
      [key, "200", "idempotency_key_reused"],
      [nextKey(), "50", "ramp_order_open"],
    ] as const) {
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post("/api/v1/ramp/onramp")
            .set(b.headers)
            .set("Idempotency-Key", kk)
            .send({ amount })
            .expect(409),
        ).error,
      ).toBe(code);
    }

    const from = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).length;
    const delivery = k.mock().complete(k.paymentIdOf(res), b.user.id, "succeeded");
    // The acquirer posts the signed body to the public route; a redelivery is stored once, a tampered or foreign one refused.
    for (let i = 0; i < 2; i += 1)
      await ctx.agent
        .post("/api/v1/webhooks/ramp/mock")
        .set(delivery.headers)
        .send(delivery.rawBody.toString("utf8"))
        .expect(200);
    await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set(delivery.headers)
      .send(delivery.rawBody.toString("utf8").replace("succeeded", "failed"))
      .expect(401);
    await ctx.agent
      .post("/api/v1/webhooks/ramp/acme")
      .set(delivery.headers)
      .send(delivery.rawBody.toString("utf8"))
      .expect(404);
    expect(await ctx.dataSource.getRepository(RampEventEntity).count()).toBe(1);
    await k.flushWebhooks(from);

    // paid → minting in ONE transaction with the command row; the POST went out; nothing is credited before the sync records it.
    const mintId = rampCommandId("mint", res.order.id);
    expect(await k.order(res.order.id)).toMatchObject({ status: "minting", mintCommandId: mintId });
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: mintId, kind: "mint", source: "ramp", status: "submitted", attempts: 1 },
    ]);
    expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)).toBeUndefined();
    await k.drive();

    const done = await k.order(res.order.id);
    expect(done).toMatchObject({
      status: "completed",
      mintCommandId: mintId,
      creditCommandId: mintCreditCommandId(mintId),
      reviewStep: null,
      capturedAmount: parseAmount("100"),
    });
    // M1 / I5: the card value counts in the exposure from the mint on — nothing may go to a bank account.
    expect(
      bodyOf<ApiRampOverview>(await ctx.agent.get("/api/v1/ramp").set(b.headers).expect(200))
        .exposure,
    ).toEqual({ amount: dec("100"), withdrawableToBank: dec("0") });
    expect(ctx.tokenApp.minted).toEqual([
      {
        commandId: mintId,
        instrumentId: "Amulet",
        partyId: TEST_TREASURY,
        amount: parseAmount("100"),
        decimals: 10,
      },
    ]);
    expect((await k.commands(res.order.id))[0]).toMatchObject({
      status: "recorded",
      recordedAmount: parseAmount("100"),
    });
    expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)).toMatchObject({
      balance: parseAmount("100"),
      deposited: parseAmount("100"),
      creditRefs: [`mint:${mintId}`],
    });
    expect(
      await ctx.dataSource
        .getRepository(DepositCreditEntity)
        .findOneByOrFail({ commandId: mintCreditCommandId(mintId) }),
    ).toMatchObject({ status: "confirmed", txRef: `mint:${mintId}` });
    // The card is saved, sealed v2, bound to this account and — after a 3DS-authenticated purchase — a cash-out destination.
    const card = await ctx.dataSource
      .getRepository(RampPaymentMethodEntity)
      .findOneByOrFail({ userId: b.user.id });
    expect(card).toMatchObject({
      status: "active",
      payoutEligible: true,
      firstOrderId: res.order.id,
    });
    expect(card.tokenSealed).toMatch(new RegExp(`^v2\\.${ctx.config.sealing.data.activeKid}\\.`));
    expect(card.tokenSealed).not.toContain("mocktok_");
    const keyring = ctx.config.sealing.data;
    expect(unseal(card.tokenSealed, keyring, rampCardAad("mock", b.user.id, card.id))).toMatch(
      /^mocktok_/,
    );
    expect(() =>
      unseal(card.tokenSealed, keyring, rampCardAad("mock", randomUUID(), card.id)),
    ).toThrow();
    // The capture booked C against issuance_pending (+ the accrued 2.40 % PSP fee); the sync moved N to customer_liability.
    expect(await k.journal(res.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("100"),
      "onramp.captured:issuance_pending": dec("-100"),
      "psp.fee_accrued:psp_fees": dec("2.4"),
      "psp.fee_accrued:provider_clearing": dec("-2.4"),
      "onramp.minted:issuance_pending": dec("100"),
      "onramp.minted:customer_liability": dec("-100"),
    });
    await k.expectIdentities();

    // Re-applying the processed event (a JetStream redelivery) changes nothing.
    const [event] = await ctx.dataSource.getRepository(RampEventEntity).find();
    await ctx.get(RampFulfilmentService).applyEvent(event.id);
    expect(ctx.tokenApp.minted).toHaveLength(1);
    expect(event).toMatchObject({ provider: "mock", kind: "payment", type: "payment.succeeded" });
    expect(Object.keys(event.payload ?? {}).sort()).toEqual([
      "created",
      "data",
      "id",
      "livemode",
      "type",
    ]);

    const seen = bodyOf<{ order: ApiRampOrder }>(
      await ctx.agent.get(`/api/v1/ramp/orders/${res.order.id}`).set(b.headers).expect(200),
    ).order;
    expect(seen).toMatchObject({
      status: "completed",
      tokenAmount: dec("100"),
      next: null,
      card: { brand: "VISA" },
    });
    expect(seen.timeline.map((t) => t.status)).toEqual([
      "created",
      "awaiting_payment",
      "paid",
      "minting",
      "crediting",
      "completed",
    ]);
    // The replay of a finished order answers it without a checkout (M7).
    expect(await k.openOnramp(b, "100", key)).toMatchObject({
      order: { status: "completed", next: null },
    });
    const list = bodyOf<ApiRampOrderList>(
      await ctx.agent.get("/api/v1/ramp/orders?limit=1").set(b.headers).expect(200),
    );
    expect(list).toMatchObject({ orders: [{ id: res.order.id }], nextCursor: null });
    const other = await k.buyer("mallory");
    await ctx.agent.get(`/api/v1/ramp/orders/${res.order.id}`).set(other.headers).expect(404);

    const rec = await k.reconciliation();
    expect(k.identityRed(rec)).toEqual([]);
    expect(k.checkOf(rec, "issuance_matches_liability").figures).toMatchObject({
      customerLiability: dec("100"),
    });
    expect(rec.journal).toMatchObject({
      customer_liability: dec("-100"),
      issuance_pending: dec("0"),
    });
  });

  it("a declined card fails the order; an abandoned checkout is voided at the acquirer, then expires; a user cancel voids it too (M7)", async () => {
    const b = await k.buyer("bob");
    const declined = await k.openOnramp(b, "20");
    await k.pay(b, declined, "declined");
    expect(await k.order(declined.order.id)).toMatchObject({
      status: "failed",
      details: { failureCode: "card_declined" },
    });

    const abandoned = await k.openOnramp(b, "20");
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET expires_at = now() - interval '10 minutes', created_at = now() - interval '40 minutes' WHERE id = $1`,
      [abandoned.order.id],
    );
    await k.fulfilment().scan();
    expect((await k.order(abandoned.order.id)).status).toBe("expired");
    expect((await k.mock().getPayment(k.paymentIdOf(abandoned))).status).toBe("cancelled");

    const cancelled = await k.openOnramp(b, "20");
    expect(
      bodyOf<{ order: ApiRampOrder }>(
        await ctx.agent
          .post(`/api/v1/ramp/orders/${cancelled.order.id}/cancel`)
          .set(b.headers)
          .send({})
          .expect(200),
      ).order.status,
    ).toBe("cancelled");
    expect((await k.mock().getPayment(k.paymentIdOf(cancelled))).status).toBe("cancelled");
    expect(ctx.tokenApp.minted).toEqual([]);
    // Nothing that moved no money counts toward the limits.
    const overview = bodyOf<ApiRampOverview>(
      await ctx.agent.get("/api/v1/ramp").set(b.headers).expect(200),
    );
    expect(overview.limits.onramp.dailyRemaining).toBe(dec("3000"));
    await k.expectIdentities();
  });

  it("a capture without 3-D Secure waits for an operator: retry re-reads and approves it (mint follows), refund returns the card money", async () => {
    const admin = await k.adminHeaders();
    const b = await k.buyer("carol");
    const first = await k.openOnramp(b, "30");
    await k.pay(b, first, "no_3ds");
    expect(await k.order(first.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
      lastError: "3ds_missing",
      details: { reviewFrom: "awaiting_payment", reviewReason: "3ds_missing" },
    });
    expect(ctx.tokenApp.minted).toEqual([]);
    // The capture is booked either way (#12): the money is ours to account for.
    expect(await k.journal(first.order.id)).toMatchObject({
      "onramp.captured:provider_clearing": dec("30"),
    });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${first.order.id}/retry`)
          .set(admin)
          .send({})
          .expect(400),
      ).error,
    ).toBe("validation_failed");
    // A retry that only re-reads the capture is single-control: it executes at once (SPEC §4.2, §6.5).
    const approved = bodyOf<{
      approval: { status: string; singleControl: boolean };
      result: ApiAdminRampOrder;
    }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${first.order.id}/retry`)
        .set(admin)
        .send({ reason: "customer verified by phone" })
        .expect(200),
    );
    expect(approved.approval).toMatchObject({ status: "executed", singleControl: true });
    expect(approved.result.status).toBe("minting");
    await k.drive();
    expect((await k.order(first.order.id)).status).toBe("completed");
    expect(ctx.tokenApp.minted.map((m) => m.commandId)).toEqual([
      rampCommandId("mint", first.order.id),
    ]);
    // An unauthenticated card never becomes a cash-out destination.
    expect(
      await ctx.dataSource
        .getRepository(RampPaymentMethodEntity)
        .findOneByOrFail({ userId: b.user.id }),
    ).toMatchObject({ payoutEligible: false });

    const second = await k.openOnramp(b, "40");
    await k.pay(b, second, "no_3ds");
    const refunded = bodyOf<{ result: ApiAdminRampOrder }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${second.order.id}/refund`)
        .set(admin)
        .send({ reason: "customer asked" })
        .expect(200),
    ).result;
    expect(refunded).toMatchObject({
      status: "refunded",
      providerRefundId: expect.stringMatching(/^mockrf_/) as string,
      refundedAmount: dec("40"),
    });
    expect(ctx.tokenApp.minted).toHaveLength(1);
    expect(await k.journal(second.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("40"),
      "onramp.captured:issuance_pending": dec("-40"),
      "psp.fee_accrued:psp_fees": dec("0.96"),
      "psp.fee_accrued:provider_clearing": dec("-0.96"),
      "onramp.refunded:issuance_pending": dec("40"),
      "onramp.refunded:provider_clearing": dec("-40"),
    });
    // A refunded order is no longer refundable / failable.
    for (const action of ["refund", "fail"])
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${second.order.id}/${action}`)
        .set(admin)
        .send({ reason: "x" })
        .expect(409);
    const detail = bodyOf<ApiAdminRampOrderDetail>(
      await ctx.agent.get(`/api/v1/admin/ramp/orders/${second.order.id}`).set(admin).expect(200),
    );
    expect(detail.events.map((e) => e.type)).toEqual(["payment.succeeded"]);
    expect(detail.order).toMatchObject({ version: expect.any(Number) as number, reviewStep: null });
    expect(detail.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["ramp.order_created", "ramp.review_required", "ramp.admin_action"]),
    );
    expect(k.identityRed(await k.reconciliation())).toEqual([]);
    await k.expectIdentities();
  });

  it("one card, one account: a card another account already uses sends the order to review", async () => {
    const a = await k.buyer("dave");
    await k.bought(a, "25", "shared-card");
    const b = await k.buyer("erin");
    const res = await k.openOnramp(b, "25");
    await k.pay(b, res, "succeeded", { cardSeed: "shared-card" });
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
      lastError: "card_bound_to_another_account",
      paymentMethodId: null,
    });
    expect(await ctx.dataSource.getRepository(RampPaymentMethodEntity).count()).toBe(1);
    await k.expectIdentities();
  });

  it("OCT cash-out: refused inside the card exposure; then Withdraw → attach → MarkPaid { txHash: ramp:<order> } → ledger proof → burn → card payout → completed", async () => {
    // OCT is a non-refund exit (SPEC §9.3): only the balance above the card exposure may leave by it.
    k.mock().cardCashoutMode = "oct";
    const b = await k.buyer("frank");
    await k.bought(b, "100");
    const card = await k.payoutCard(b);
    const open = (
      key: string,
      paymentMethodId = card.id,
    ): Promise<{ status: number; body: unknown }> =>
      ctx.agent
        .post("/api/v1/ramp/offramp")
        .set(b.headers)
        .set("Idempotency-Key", key)
        .send({ amount: "40", destination: { kind: "card", paymentMethodId } });
    const held = await open(nextKey());
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({
      error: "ramp_exposure",
      details: { withdrawableToBank: dec("0") },
    });

    await k.decayExposure();
    const key = nextKey();
    const res = (await open(key)).body as ApiRampOfframpResult;
    expect(res.order).toMatchObject({
      direction: "offramp",
      status: "awaiting_withdrawal",
      tokenAmount: dec("40"),
      fiatAmount: dec("40"),
    });
    expect(res.order).toMatchObject({
      rail: "card",
      destination: { kind: "card", paymentMethodId: card.id },
      withdraw: { walletContractId: expect.any(String) as string, amount: dec("40") },
    });
    expect(((await open(key)).body as ApiRampOfframpResult).order.id).toBe(res.order.id);
    // L1 / E-D9: the same key naming another card is another request.
    const reused = await open(key, randomUUID());
    expect(reused.body).toMatchObject({ error: "idempotency_key_reused" });

    // A PendingPayout that is not the one the order waits for is refused before anything settles.
    const wrong = k.signWithdraw(b, "10");
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/ramp/orders/${res.order.id}/attach`)
          .set(b.headers)
          .send({ pendingPayoutCid: wrong })
          .expect(409),
      ).error,
    ).toBe("ramp_order_state");
    k.cancelPayout(b, wrong);

    const cid = k.signWithdraw(b, "40");
    const attached = bodyOf<{ order: ApiRampOrder }>(
      await ctx.agent
        .post(`/api/v1/ramp/orders/${res.order.id}/attach`)
        .set(b.headers)
        .send({ pendingPayoutCid: cid })
        .expect(200),
    ).order;
    // MarkPaid ran; until the indexer shows it archived the contract, nothing is burned (C1).
    expect(attached).toMatchObject({ status: "withdrawing", statusText: null });
    expect((await k.order(res.order.id)).pendingPayoutCid).toBe(cid);
    expect(ctx.tokenApp.burned).toEqual([]);
    const markPaid = ctx.wallet.submits.find((s) =>
      JSON.stringify(s.commands).includes('"choice":"MarkPaid"'),
    );
    expect(JSON.stringify(markPaid?.commands)).toContain(`"txHash":"ramp:${res.order.id}"`);
    await k.drive();

    expect(await k.order(res.order.id)).toMatchObject({
      status: "completed",
      burnCommandId: rampCommandId("burn", res.order.id),
      providerPayoutId: expect.stringMatching(/^mockpo_/) as string,
    });
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({
      status: "settled_external",
      details: { offrampOrderId: res.order.id },
      transferCommandId: null,
    });
    expect(ctx.wallet.transfers).toEqual([]);
    expect(ctx.tokenApp.burned).toEqual([
      {
        commandId: rampCommandId("burn", res.order.id),
        instrumentId: "Amulet",
        partyId: TEST_TREASURY,
        amount: parseAmount("40"),
        decimals: 10,
      },
    ]);
    expect(await k.journal(res.order.id)).toEqual({
      "offramp.burned:customer_liability": dec("40"),
      "offramp.burned:payout_clearing": dec("-40"),
      "offramp.paid_card:payout_clearing": dec("40"),
      "offramp.paid_card:provider_clearing": dec("-40"),
    });
    const rec = await k.reconciliation();
    expect(k.identityRed(rec)).toEqual([]);
    expect(k.checkOf(rec, "issuance_matches_liability").figures).toMatchObject({
      customerLiability: dec("60"),
    });
    await k.expectIdentities();
  });

  it("an OCT card payout that fails for good is reversed: the burn stands, ramp-remint-<h> is minted, recorded and Deposited back → refunded", async () => {
    k.mock().cardCashoutMode = "oct";
    const b = await k.buyer("grace");
    const bought = await k.bought(b, "50");
    await k.decayExposure();
    k.mock().payoutBehaviour = "fail";
    const card = await k.payoutCard(b);
    const res = bodyOf<ApiRampOfframpResult>(
      await ctx.agent
        .post("/api/v1/ramp/offramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "50", destination: { kind: "card", paymentMethodId: card.id } })
        .expect(200),
    );
    const cid = k.signWithdraw(b, "50");
    expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)?.balance).toBe(0n);
    await ctx.agent
      .post(`/api/v1/ramp/orders/${res.order.id}/attach`)
      .set(b.headers)
      .send({ pendingPayoutCid: cid })
      .expect(200);
    await k.drive(6);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "refunded",
      details: { failureCode: "card_not_eligible_for_credit" },
    });
    const remint = rampCommandId("remint", res.order.id);
    expect(ctx.tokenApp.burned.map((x) => x.commandId)).toEqual([
      rampCommandId("burn", res.order.id),
    ]);
    expect(ctx.tokenApp.minted.map((x) => x.commandId)).toEqual([
      rampCommandId("mint", bought.id),
      remint,
    ]);
    expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)).toMatchObject({
      balance: parseAmount("50"),
      creditRefs: expect.arrayContaining([`mint:${remint}`]) as string[],
    });
    expect(await k.journal(res.order.id)).toEqual({
      "offramp.burned:customer_liability": dec("50"),
      "offramp.burned:payout_clearing": dec("-50"),
      "offramp.reminted:payout_clearing": dec("50"),
      "offramp.reminted:customer_liability": dec("-50"),
    });
    const rec = await k.reconciliation();
    expect(k.identityRed(rec)).toEqual([]);
    expect(rec.journal.customer_liability).toBe(dec("-50"));
    await k.expectIdentities();
  });

  it("the user's CancelPayout beats MarkPaid: the ledger shows CancelPayout, the cash-out is cancelled and nothing is burned or paid", async () => {
    const b = await k.buyer("heidi");
    await k.bought(b, "30");
    await k.decayExposure();
    const card = await k.payoutCard(b);
    const res = bodyOf<ApiRampOfframpResult>(
      await ctx.agent
        .post("/api/v1/ramp/offramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "30", destination: { kind: "card", paymentMethodId: card.id } })
        .expect(200),
    );
    const cid = k.signWithdraw(b, "30");
    ctx.wallet.lagLedger = true;
    const pending = bodyOf<{ order: ApiRampOrder }>(
      await ctx.agent
        .post(`/api/v1/ramp/orders/${res.order.id}/attach`)
        .set(b.headers)
        .send({ pendingPayoutCid: cid })
        .expect(200),
    ).order;
    expect(pending.status).toBe("withdrawing");
    // The user's own CancelPayout lands first; our MarkPaid is then rejected by the ledger.
    k.cancelPayout(b, cid);
    ctx.wallet.rejectPending();
    ctx.wallet.lagLedger = false;
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("cancelled");
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({ status: "archived" });
    expect(ctx.tokenApp.burned).toEqual([]);
    expect(await k.journal(res.order.id)).toEqual({});
    await k.expectIdentities();
  });

  it("a plain withdrawal of card-bought value waits inside the card exposure (blocked_ramp_exposure) and settles by itself once it decays", async () => {
    const b = await k.buyer("ivan");
    await k.bought(b, "60");
    const cid = k.signWithdraw(b, "60");
    await ctx.get(PayoutService).scan();
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({ status: "blocked_ramp_exposure" });
    expect(ctx.wallet.transfers).toEqual([]);
    await k.decayExposure();
    await ctx.get(PayoutService).scan();
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({ status: "settled_external" });
    expect(ctx.wallet.transfers).toEqual([
      expect.objectContaining({ to: b.wallet.partyId, amount: parseAmount("60") }),
    ]);
  });

  it("a chargeback after the credit suspends the account, blocks the card and books the receivable (chargeback_minted)", async () => {
    const b = await k.buyer("judy");
    const done = await k.bought(b, "80");
    const from = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).length;
    await ctx.agent
      .post(`/api/v1/ramp/mock/payments/${done.providerPaymentId ?? ""}/chargeback`)
      .set(b.headers)
      .send({})
      .expect(200);
    await k.flushWebhooks(from);
    expect(await k.order(done.id)).toMatchObject({
      status: "chargeback",
      details: { chargeback: { state: "charged_back", kind: "chargeback" } },
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
    expect(await k.journal(done.id)).toMatchObject({
      "onramp.chargeback_minted:chargeback_receivable": dec("80"),
      "onramp.chargeback_minted:provider_clearing": dec("-80"),
    });
    expect(
      await ctx.dataSource
        .getRepository(AuditEventEntity)
        .count({ where: { action: "ramp.chargeback", subjectId: done.id } }),
    ).toBe(1);
    await k.expectIdentities();
  });

  it("the reconciliation flags a token-app record of the ramp instrument no command accounts for (I9)", async () => {
    const b = await k.buyer("ken");
    await k.bought(b, "15");
    expect(k.identityRed(await k.reconciliation())).toEqual([]);
    ctx.tokenApp.extraRecords.push({
      kind: "mint",
      commandId: "outsider-mint",
      updateId: "update-outsider",
      partyId: TEST_TREASURY,
      instrumentId: TEST_COLLATERAL.id,
      amount: parseAmount("5"),
      createdAt: new Date(),
    });
    await ctx.get(TokenAppSyncService).syncOnce("test");
    const rec = await k.reconciliation();
    expect(rec.run.status).toBe("red");
    expect(k.checkOf(rec, "token_records_known")).toMatchObject({
      status: "red",
      figures: { unknownRecords: 1, unknownNet: dec("5") },
    });
  });

  it("BYN only, at the database too: a ramp row in another currency is refused (RAMP_FIAT_CURRENCIES)", async () => {
    expect(ctx.config.ramp.fiatCurrency).toBe("BYN");
    await expect(
      ctx.dataSource.query(
        `INSERT INTO to_ramp_journal (entry_id, kind, account, currency, amount)
         VALUES (gen_random_uuid(), 'test.currency', 'fee_revenue', 'EUR', 1)`,
      ),
    ).rejects.toThrow(/CHK_to_ramp_journal_currency/);
    // The same (balanced) entry in BYN is accepted.
    await expect(
      ctx.dataSource.query(
        `INSERT INTO to_ramp_journal (entry_id, kind, account, currency, amount)
         SELECT e.id, 'test.currency', t.account, 'BYN', t.amount
           FROM (SELECT gen_random_uuid() AS id) e,
                (VALUES ('fee_revenue', 1), ('bank_fees', -1)) AS t(account, amount)`,
      ),
    ).resolves.toBeDefined();
  });
});
