import type { RampOrderEntity } from "../entities/ramp-order.entity";
import { parseAmount } from "../util/money";
import {
  describeOrderAction,
  destinationText,
  moneyOf,
  orderFigures,
  RAMP_ACTIONS,
  type RampOrderSnapshot,
} from "./ramp-actions.service";

/** A card cash-out of 40 cBYN for 39.50 BYN, in the withdrawal review. */
const offramp = {
  id: "11111111-1111-4111-8111-111111111111",
  direction: "offramp",
  userId: "22222222-2222-4222-8222-222222222222",
  partyId: "user::1220aa",
  fiatAmount: parseAmount("39.5"),
  fiatCurrency: "BYN",
  tokenAmount: parseAmount("40"),
  instrumentAdmin: "admin::1220bb",
  instrumentId: "cBYN",
  payoutRail: "card",
  paymentMethodId: "33333333-3333-4333-8333-333333333333",
  paymentMethod: { brand: "visa", last4: "4242" },
  bankAccountId: null,
} as unknown as RampOrderEntity;

function snapshotOf(
  order: RampOrderEntity,
  extra: Partial<RampOrderSnapshot> = {},
): RampOrderSnapshot {
  return {
    ...orderFigures(order),
    id: order.id,
    version: 7,
    status: "needs_review",
    reviewStep: "withdrawal",
    reviewFrom: "withdrawing",
    mintCommandId: null,
    burnCommandId: null,
    remintCommandId: null,
    providerPaymentId: null,
    providerPayoutId: null,
    providerRefundId: null,
    pendingPayoutCid: "pp-1",
    capturedAmount: null,
    refundedAmount: "0.0000000000",
    ...extra,
  };
}

describe("W9f: what a ramp order approval moves, and for whom (F2/F8)", () => {
  it("an order's figures: amounts, currency, instrument, user, wallet party and the fiat destination", () => {
    expect(orderFigures(offramp)).toEqual({
      direction: "offramp",
      userId: offramp.userId,
      partyId: "user::1220aa",
      fiatAmount: "39.5000000000",
      fiatCurrency: "BYN",
      tokenAmount: "40.0000000000",
      instrument: { admin: "admin::1220bb", id: "cBYN" },
      destination: {
        kind: "card",
        paymentMethodId: offramp.paymentMethodId,
        brand: "visa",
        last4: "4242",
      },
    });
    const bank = { ...offramp, payoutRail: "bank", bankAccountId: "acc-1" } as RampOrderEntity;
    expect(orderFigures(bank).destination).toEqual({ kind: "bank", bankAccountId: "acc-1" });
    // An on-ramp's money goes back to its bank refund's account, else to the card that paid.
    const onramp = { ...offramp, direction: "onramp", payoutRail: null } as RampOrderEntity;
    expect(orderFigures(onramp).destination).toMatchObject({ kind: "card" });
    expect(orderFigures({ ...onramp, bankAccountId: "acc-2" }).destination).toEqual({
      kind: "bank",
      bankAccountId: "acc-2",
    });
  });

  it("amounts read with their unit; the destination names the card or the account", () => {
    expect(moneyOf("39.5000000000", "BYN")).toBe("39.50 BYN");
    expect(moneyOf("0.1234000000", "cBYN")).toBe("0.1234 cBYN");
    expect(moneyOf("-1.5000000000", "BYN")).toBe("-1.50 BYN");
    expect(destinationText(snapshotOf(offramp))).toBe(
      `card visa ••4242 (${offramp.paymentMethodId})`,
    );
    expect(destinationText({ destination: null })).toBe("no card or bank account");
  });

  it.each(RAMP_ACTIONS)("ramp.order.%s says the amount, the unit and the user", (action) => {
    const text = describeOrderAction(action, snapshotOf(offramp));
    expect(text).toContain(offramp.userId);
    expect(text).toContain(offramp.id);
    expect(text).toMatch(/39\.50 BYN|40\.00 cBYN/);
  });

  it("a refund moves what the acquirer captured less what it refunded already", () => {
    const onramp = { ...offramp, direction: "onramp", payoutRail: null } as RampOrderEntity;
    const s = snapshotOf(onramp, {
      reviewStep: "payment",
      capturedAmount: "39.5000000000",
      refundedAmount: "10.0000000000",
    });
    expect(describeOrderAction("refund", s)).toMatch(/^refund 29\.50 BYN to card visa ••4242/);
    expect(describeOrderAction("credit_back", snapshotOf(offramp))).toMatch(
      /^credit 40\.00 cBYN back to the in-app wallet of user 2222/,
    );
  });
});
