/**
 * The ramp on a 6-decimal instrument (cBYN's real precision; the other ramp specs run on Amulet at
 * 10 dp) with non-zero customer fees: every token command amount is whole at 6 dp, token-app is
 * asked with `decimals: 6`, and on- and off-ramp postings keep F = N + f, T = P + f and the journal
 * identities. The cash-out goes back to the card as a partial refund of its capture (refund mode).
 */
import { InstrumentEntity } from "../src/entities/instrument.entity";
import { rampCommandId } from "../src/services/ramp-fulfilment.service";
import type { ApiRampOfframpResult, ApiRampOrder } from "../src/types";
import { parseAmount } from "../src/util/money";
import { TEST_DSO, TEST_TREASURY, useTestApp } from "./helpers/app";
import { dec, nextKey, rampKit } from "./helpers/ramp";
import { bodyOf } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const CBYN = { admin: TEST_DSO, id: "cBYN" } as const;
const operator = makeTestWallet("op");
const ctx = useTestApp({
  env: {
    ADMIN_OPERATORS: operator.partyId,
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
    COLLATERAL_INSTRUMENT_ID: CBYN.id,
    COLLATERAL_INSTRUMENT_SYMBOL: "cBYN",
    COLLATERAL_INSTRUMENT_NAME: "cBYN",
    COLLATERAL_INSTRUMENT_DECIMALS: "6",
    // SPEC §9.2 / §9.3: the customer fee is the method's (on) and the rail's (off).
    RAMP_CARD_FEE_BPS: "150",
    RAMP_PAYOUT_CARD_FEE_BPS: "100",
  },
});
const k = rampKit(ctx, operator, CBYN);

beforeEach(() => {
  k.mock().reset();
});

describe("fiat ramp on a 6-dp instrument (cBYN)", () => {
  it("buy 20.01 BYN (fee 0.31 → 19.70 cBYN) and cash out all of it (fee 0.20 → 19.50 BYN): exact at 6 dp, books balanced", async () => {
    expect(
      await ctx.dataSource.getRepository(InstrumentEntity).findOneByOrFail(CBYN),
    ).toMatchObject({
      decimals: 6,
    });
    const b = await k.buyer("cbyn");
    const res = await k.openOnramp(b, "20.01");
    expect(res.order).toMatchObject({
      fiatAmount: dec("20.01"),
      tokenAmount: dec("19.7"),
      feeAmount: dec("0.31"),
    });
    await k.pay(b, res);
    await k.drive();
    const mintId = rampCommandId("mint", res.order.id);
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(ctx.tokenApp.minted).toEqual([
      {
        commandId: mintId,
        instrumentId: "cBYN",
        partyId: TEST_TREASURY,
        amount: parseAmount("19.7"),
        decimals: 6,
      },
    ]);
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: mintId, amount: parseAmount("19.7"), status: "recorded", instrumentId: "cBYN" },
    ]);
    expect(await k.journal(res.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("20.01"),
      "onramp.captured:issuance_pending": dec("-19.7"),
      "onramp.captured:fee_revenue": dec("-0.31"),
      "psp.fee_accrued:psp_fees": dec("0.49"),
      "psp.fee_accrued:provider_clearing": dec("-0.49"),
      "onramp.minted:issuance_pending": dec("19.7"),
      "onramp.minted:customer_liability": dec("-19.7"),
    });
    expect(ctx.ledger.walletOf(b.wallet.partyId, CBYN)?.balance).toBe(parseAmount("19.7"));
    await k.expectIdentities();

    await k.decayExposure();
    const card = await k.payoutCard(b);
    const off = bodyOf<ApiRampOfframpResult>(
      await ctx.agent
        .post("/api/v1/ramp/offramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "19.7", destination: { kind: "card", paymentMethodId: card.id } })
        .expect(200),
    );
    expect(off.order).toMatchObject({
      tokenAmount: dec("19.7"),
      fiatAmount: dec("19.5"),
      feeAmount: dec("0.2"),
    });
    const cid = k.signWithdraw(b, "19.7");
    const attached = bodyOf<{ order: ApiRampOrder }>(
      await ctx.agent
        .post(`/api/v1/ramp/orders/${off.order.id}/attach`)
        .set(b.headers)
        .send({ pendingPayoutCid: cid })
        .expect(200),
    ).order;
    expect(attached.status).toBe("withdrawing");
    await k.drive();
    expect((await k.order(off.order.id)).status).toBe("completed");
    expect(ctx.tokenApp.burned).toEqual([
      {
        commandId: rampCommandId("burn", off.order.id),
        instrumentId: "cBYN",
        partyId: TEST_TREASURY,
        amount: parseAmount("19.7"),
        decimals: 6,
      },
    ]);
    // Refund mode (SPEC §9.3): P = 19.50 goes back as a partial refund of the 20.01 capture.
    expect(k.mock().payoutsFor(off.order.id)).toEqual([]);
    const onramp = await k.order(res.order.id);
    expect(k.mock().refundsOf(onramp.providerPaymentId ?? "")).toMatchObject([
      {
        amount: parseAmount("19.5"),
        status: "succeeded",
        key: `cashout-${off.order.id}-${res.order.id}`,
      },
    ]);
    expect(onramp.refundedAmount).toBe(parseAmount("19.5"));
    expect(await k.journal(off.order.id)).toEqual({
      "offramp.burned:customer_liability": dec("19.7"),
      "offramp.burned:payout_clearing": dec("-19.5"),
      "offramp.burned:fee_revenue": dec("-0.2"),
      "offramp.paid_card:payout_clearing": dec("19.5"),
      "offramp.paid_card:provider_clearing": dec("-19.5"),
    });
    await k.expectIdentities();
    const rec = await k.reconciliation();
    expect(k.identityRed(rec)).toEqual([]);
    expect(k.checkOf(rec, "issuance_matches_liability").figures).toMatchObject({
      customerLiability: dec("0"),
    });
  });
});
