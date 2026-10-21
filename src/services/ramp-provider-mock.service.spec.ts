import { getConfiguration } from "../config";
import { parseAmount } from "../util/money";
import {
  MOCK_SIGNATURE_HEADER,
  mockSignature,
  RampProviderMockService,
} from "./ramp-provider-mock.service";

function mock(): RampProviderMockService {
  return new RampProviderMockService(
    getConfiguration({
      APP_ENV: "dev",
      APP_NETWORK: "devnet",
      DATABASE_URL: "postgresql://localhost:5432/x",
      REDIS_URL: "redis://localhost:6379",
      NATS_URL: "nats://localhost:4222",
      SESSION_SECRET: "s".repeat(32),
      KYC_FINGERPRINT_PEPPER: "p".repeat(32),
      RAMP_PUBLIC_APP_URL: "https://app.test",
      RAMP_MOCK_WEBHOOK_SECRET: "mock-secret",
    }),
  );
}

/** A JSON delivery from a documentation address (verifyWebhook's receive-path context, SPEC §9.1). */
const META = { contentType: "application/json", sourceIp: "203.0.113.9" };

async function openPayment(
  p: RampProviderMockService,
  userId = "user-1",
  method: "card" | "erip" = "card",
): Promise<string> {
  const { paymentId, next } = await p.createPayment({
    orderId: "00000000-0000-4000-8000-000000000001",
    method,
    reference: "TO123456789012",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
    amount: parseAmount("100"),
    currency: "BYN",
    description: "100 cBYN",
    returnUrl: "https://app.test/wallet/ramp/x",
    notificationUrl: "",
    customer: { userId, ip: null },
    expiresAt: new Date(Date.now() + 60_000),
    require3ds: true,
    saveCard: true,
  });
  if (method === "card")
    expect(next).toEqual({
      kind: "redirect",
      url: expect.stringMatching(
        /^https:\/\/app\.test\/wallet\/ramp\/mock-checkout\?payment=mockpay_/,
      ) as string,
    });
  return paymentId;
}

describe("mock acquirer (docs/RAMP.md §9)", () => {
  it("a completed checkout yields a signed delivery the verifier accepts, and the payment reads succeeded with a card", async () => {
    const p = mock();
    const id = await openPayment(p);
    const delivery = p.complete(id, "user-1", "succeeded");
    const event = p.verifyWebhook(delivery.rawBody, delivery.headers, META);
    expect(event).toMatchObject({
      type: "payment.succeeded",
      kind: "payment",
      objectId: id,
      sandbox: true,
    });
    expect(event?.eventKey).toMatch(/^mock:evt_/);
    const payment = await p.getPayment(id);
    expect(payment).toMatchObject({
      status: "succeeded",
      threeDs: "authenticated",
      amount: parseAmount("100"),
    });
    expect(payment.card?.fingerprint).toMatch(/^mockfp_/);
    // The same account's next card is the same card (fingerprint), as with a real acquirer.
    const again = await openPayment(p);
    p.complete(again, "user-1", "no_3ds");
    expect((await p.getPayment(again)).card?.fingerprint).toBe(payment.card?.fingerprint);
    expect((await p.getPayment(again)).threeDs).toBe("not_authenticated");
  });

  it("rejects a tampered body, a wrong secret, a stale timestamp and a missing header", async () => {
    const p = mock();
    const id = await openPayment(p);
    const { rawBody, headers } = p.complete(id, "user-1", "declined");
    expect(
      p.verifyWebhook(
        Buffer.from(rawBody.toString().replace("payment.failed", "payment.succeeded")),
        headers,
        META,
      ),
    ).toBeNull();
    expect(p.verifyWebhook(rawBody, {}, META)).toBeNull();
    const t = Math.floor(Date.now() / 1000);
    expect(
      p.verifyWebhook(
        rawBody,
        {
          [MOCK_SIGNATURE_HEADER]: `t=${t},v1=${mockSignature("other", t, rawBody)}`,
        },
        META,
      ),
    ).toBeNull();
    const stale = t - 3600;
    expect(
      p.verifyWebhook(
        rawBody,
        {
          [MOCK_SIGNATURE_HEADER]: `t=${stale},v1=${mockSignature("mock-secret", stale, rawBody)}`,
        },
        META,
      ),
    ).toBeNull();
    expect(p.verifyWebhook(rawBody, headers, META)).not.toBeNull();
  });

  it("verifies form-encoded deliveries over the raw bytes too (form-posting acquirers, SPEC §8)", () => {
    const p = mock();
    const t = Math.floor(Date.now() / 1000);
    const form = Buffer.from(
      "id=evt_form1&type=payment.succeeded&object_id=mockpay_1&order_id=o-1",
    );
    const headers = {
      [MOCK_SIGNATURE_HEADER]: `t=${t},v1=${mockSignature("mock-secret", t, form)}`,
    };
    const formMeta = {
      contentType: "application/x-www-form-urlencoded; charset=utf-8",
      sourceIp: "203.0.113.9",
    };
    expect(p.verifyWebhook(form, headers, formMeta)).toMatchObject({
      eventKey: "mock:evt_form1",
      kind: "payment",
      objectId: "mockpay_1",
      orderId: "o-1",
    });
    // The same bytes read as JSON are unreadable; a field changed after signing fails the MAC.
    expect(p.verifyWebhook(form, headers, META)).toBeNull();
    const tampered = Buffer.from(form.toString().replace("o-1", "o-2"));
    expect(p.verifyWebhook(tampered, headers, formMeta)).toBeNull();
    // A JSON body that is not an object is refused instead of throwing.
    const nul = Buffer.from("null");
    const signedNull = {
      [MOCK_SIGNATURE_HEADER]: `t=${t},v1=${mockSignature("mock-secret", t, nul)}`,
    };
    expect(p.verifyWebhook(nul, signedNull, META)).toBeNull();
  });

  it("only the payer completes a checkout, once", async () => {
    const p = mock();
    const id = await openPayment(p);
    expect(() => p.complete(id, "someone-else", "succeeded")).toThrow(/not found/);
    p.complete(id, "user-1", "declined");
    expect(() => p.complete(id, "user-1", "succeeded")).toThrow(/already failed/);
  });

  it("payouts are idempotent on the key and follow payoutBehaviour", async () => {
    const p = mock();
    const input = {
      orderId: "o1",
      amount: parseAmount("49"),
      currency: "BYN",
      cardToken: "mocktok_x",
      recipient: { firstName: "Siarhei", lastName: "Ivanou" },
      idempotencyKey: "o1",
      notificationUrl: "",
    };
    const first = await p.createPayout(input);
    expect(await p.createPayout(input)).toEqual(first);
    expect((await p.getPayout(first.payoutId)).status).toBe("succeeded");
    p.payoutBehaviour = "fail";
    const failed = await p.createPayout({ ...input, idempotencyKey: "o2", orderId: "o2" });
    expect(await p.getPayout(failed.payoutId)).toMatchObject({
      status: "failed",
      failureCode: "card_not_eligible_for_credit",
    });
  });

  it("the lookups by merchant reference outlive the idempotency keys (I3, #3)", async () => {
    const p = mock();
    const input = {
      orderId: "o3",
      amount: parseAmount("49"),
      currency: "BYN",
      cardToken: "mocktok_x",
      recipient: { firstName: "Siarhei", lastName: "Ivanou" },
      idempotencyKey: "o3",
      notificationUrl: "",
    };
    // The acquirer executes the payout, then the answer times out.
    p.payoutTimeouts = 1;
    await expect(p.createPayout(input)).rejects.toThrow(/timeout/);
    const found = await p.findPayoutByOrder("o3");
    expect(found).toMatchObject({ orderId: "o3", status: "pending" });
    // Within the key's memory a retry is the same payout; after it, a blind retry pays twice.
    expect((await p.createPayout(input)).payoutId).toBe(found?.payoutId);
    p.forgetIdempotencyKeys();
    await p.createPayout(input);
    expect(p.payoutsFor("o3")).toHaveLength(2);
    expect(await p.findPayoutByOrder("nope")).toBeNull();
    p.lookupFailure = new Error("acquirer down");
    await expect(p.findPayoutByOrder("o3")).rejects.toThrow("acquirer down");
  });

  it("refunds: partial amounts up to the capture, idempotent per key, found by key after the memory expires", async () => {
    const p = mock();
    const id = await openPayment(p);
    p.complete(id, "user-1", "succeeded", { capturedAmount: parseAmount("60") });
    expect(await p.getPayment(id)).toMatchObject({
      amount: parseAmount("100"),
      capturedAmount: parseAmount("60"),
      refundedAmount: 0n,
    });
    const first = await p.refundPayment(id, parseAmount("20"), "refund-a");
    expect(first.status).toBe("succeeded");
    expect(await p.refundPayment(id, parseAmount("20"), "refund-a")).toEqual(first);
    expect(await p.getPayment(id)).toMatchObject({
      status: "succeeded",
      refundedAmount: parseAmount("20"),
    });
    await expect(p.refundPayment(id, parseAmount("41"), "refund-b")).rejects.toThrow(/exceeds/);
    p.forgetIdempotencyKeys();
    expect(await p.findRefund(id, "refund-a")).toMatchObject({
      refundId: first.refundId,
      amount: parseAmount("20"),
      status: "succeeded",
    });
    await p.refundPayment(id, parseAmount("40"), "refund-b");
    expect((await p.getPayment(id)).status).toBe("refunded");
    expect(await p.findRefund(id, "refund-z")).toBeNull();
  });

  it("cancelPayment voids an unpaid checkout, refuses when told to, and reports a capture", async () => {
    const p = mock();
    const open = await openPayment(p);
    expect(await p.cancelPayment(open)).toBe("cancelled");
    expect((await p.getPayment(open)).status).toBe("cancelled");
    const stuck = await openPayment(p);
    p.cancelBehaviour = "not_cancellable";
    expect(await p.cancelPayment(stuck)).toBe("not_cancellable");
    const paid = await openPayment(p);
    p.complete(paid, "user-1", "succeeded");
    expect(await p.cancelPayment(paid)).toBe("already_paid");
    expect((await p.findPaymentByOrder("00000000-0000-4000-8000-000000000001"))?.paymentId).toBe(
      paid,
    );
  });

  it("chargebacks (also after a refund), won disputes and the acquirer's own refunds", async () => {
    const p = mock();
    const id = await openPayment(p);
    p.complete(id, "user-1", "succeeded");
    p.pspRefund(id);
    expect(await p.getPayment(id)).toMatchObject({
      status: "refunded",
      refundedAmount: parseAmount("100"),
    });
    p.chargeback(id, "user-1");
    // After a full refund the issuer disputes the original amount.
    expect(await p.getPayment(id)).toMatchObject({
      status: "chargeback",
      chargebackAmount: parseAmount("100"),
    });
    p.disputeWon(id);
    expect((await p.getPayment(id)).status).toBe("chargeback_reversed");
  });

  it("a chargeback reports what it took: by default what refunds left of the capture, else the amount given (S8)", async () => {
    const p = mock();
    const id = await openPayment(p);
    p.complete(id, "user-1", "succeeded");
    expect((await p.getPayment(id)).chargebackAmount).toBeNull();
    await p.refundPayment(id, parseAmount("60"), "cashout-part");
    p.chargeback(id, "user-1");
    expect(await p.getPayment(id)).toMatchObject({
      status: "chargeback",
      refundedAmount: parseAmount("60"),
      chargebackAmount: parseAmount("40"),
    });
    const other = await openPayment(p);
    p.complete(other, "user-1", "succeeded");
    p.chargeback(other, "user-1", parseAmount("25"));
    expect((await p.getPayment(other)).chargebackAmount).toBe(parseAmount("25"));
  });
});

describe("mock acquirer v2: methods, ERIP, payer data, cash-out modes (SPEC §9.1, §9.2)", () => {
  it("advertises card + ERIP, refunds of cards only, refund-mode card cash-out (switchable for tests)", () => {
    const p = mock();
    expect(p.capabilities).toEqual({
      methods: ["card", "erip"],
      refundMethods: ["card"],
      cardCashout: "refund",
      cardRefundMaxDays: 180,
      payoutDomesticOnly: true,
      cancelPayment: true,
      eripRefundMinHoursAfterSettle: 24,
      // RAMP_MOCK_ERIP_SERVICE_CODE: what an adopted ERIP order's instructions are re-derived with (S8).
      eripServiceCode: "100001",
    });
    p.cardCashoutMode = "oct";
    expect(p.capabilities.cardCashout).toBe("oct");
    p.reset();
    expect(p.capabilities.cardCashout).toBe("refund");
  });

  it("an ERIP invoice answers the service code, the reference digits, the amount, a PNG QR and raw QR text", async () => {
    const p = mock();
    const { next } = await p.createPayment({
      orderId: "00000000-0000-4000-8000-000000000002",
      method: "erip",
      reference: "TO123456789012",
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      amount: parseAmount("75.5"),
      currency: "BYN",
      description: "75.5 cBYN",
      returnUrl: "https://app.test/wallet/ramp/x",
      notificationUrl: "",
      customer: { userId: "user-1", ip: null },
      expiresAt: new Date(Date.now() + 86_400_000),
      require3ds: true,
      saveCard: false,
    });
    expect(next).toMatchObject({
      kind: "erip",
      serviceCode: "100001",
      accountNumber: "123456789012",
      amount: "75.5000000000",
      qrPng: expect.stringMatching(/^iVBORw0KGgo/) as string,
      qrRaw: "ERIP|100001|123456789012|75.50",
    });
    expect(next.kind === "erip" && next.instructions.length).toBe(3);
  });

  it("an ERIP payment reports its channel, the bank-supplied payer, the payer IBAN hash and the ERIP ids", async () => {
    const p = mock();
    const id = await openPayment(p, "user-1", "erip");
    p.complete("00000000-0000-4000-8000-000000000001", "user-1", "succeeded", {
      payerName: "IVANOU SIARHEI",
      channel: "cash",
      payerIban: "BY13 NBRB 3600 9000 0000 2Z00 AB00",
      payerBankBic: "NBRBBY2X",
    });
    const payment = await p.getPayment(id);
    expect(payment).toMatchObject({
      method: "erip",
      status: "succeeded",
      threeDs: "unknown",
      card: null,
      rrn: null,
      payer: {
        name: "IVANOU SIARHEI",
        nameSource: "bank",
        channel: "cash",
        bankBic: "NBRBBY2X",
        ibanHash: {
          kid: expect.any(String) as string,
          hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        },
      },
      erip: { transactionId: expect.stringMatching(/^erip/) as string },
    });
    expect(payment.settledAt).toBeInstanceOf(Date);
    // ERIP is not refunded by this acquirer: the refund_bank path (S6) returns that money.
    await expect(p.refundPayment(id, parseAmount("10"), "refund-x")).rejects.toThrow(
      /not refundable/,
    );
  });

  it("a card payment reports a foreign issuer, the checkout name (never evidence) and its RRN", async () => {
    const p = mock();
    const id = await openPayment(p);
    p.complete(id, "user-1", "succeeded", { cardCountry: "lt", payerName: "J DOE" });
    expect(await p.getPayment(id)).toMatchObject({
      method: "card",
      card: { issuerCountry: "LT", issuerName: "Mock Issuer Bank" },
      payer: { name: "J DOE", nameSource: "checkout", channel: "card" },
      rrn: expect.stringMatching(/^rrn/) as string,
      erip: null,
    });
  });

  it("per-payment refund outcomes, a refund fee and the refund description", async () => {
    const p = mock();
    const id = await openPayment(p);
    p.complete(id, "user-1", "succeeded");
    p.refundBehaviourFor.set(id, "fail");
    p.refundFee = parseAmount("0.1");
    const failed = await p.refundPayment(id, parseAmount("10"), "cashout-a", "TO-123456789012");
    expect(failed.status).toBe("failed");
    expect(await p.findRefund(id, "cashout-a")).toMatchObject({
      status: "failed",
      fee: parseAmount("0.1"),
    });
    expect(p.refundDescriptionOf(failed.refundId)).toBe("TO-123456789012");
    p.refundBehaviourFor.delete(id);
    expect((await p.refundPayment(id, parseAmount("10"), "cashout-b")).status).toBe("succeeded");
    expect(p.refundsOf(id)).toHaveLength(2);
    expect((await p.getPayment(id)).refundedAmount).toBe(parseAmount("10"));
  });
});
