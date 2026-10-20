import { parseAmount } from "../util/money";
import { acquirerRefunded, disputedAmount } from "./ramp-disputes.service";

const a = parseAmount;

describe("disputedAmount (S8): what a chargeback takes back, for the books", () => {
  it("a dispute reaches only what the capture left unrefunded (a card cash-out's parts went back to the card)", () => {
    const base = { captured: a("100"), refunded: a("60"), afterRefund: false };
    expect(disputedAmount({ ...base, reported: null })).toEqual({ amount: a("40"), capped: false });
    expect(disputedAmount({ ...base, reported: a("25") })).toEqual({
      amount: a("25"),
      capped: false,
    });
    // The acquirer reporting more than that is capped (and alerted by the caller).
    expect(disputedAmount({ ...base, reported: a("100") })).toEqual({
      amount: a("40"),
      capped: true,
    });
    expect(disputedAmount({ ...base, refunded: a("100"), reported: null })).toEqual({
      amount: 0n,
      capped: false,
    });
  });

  it("after the order's own refund the issuer disputes the original: up to C", () => {
    const base = { captured: a("100"), refunded: a("100"), afterRefund: true };
    expect(disputedAmount({ ...base, reported: null })).toEqual({
      amount: a("100"),
      capped: false,
    });
    expect(disputedAmount({ ...base, reported: a("100") })).toEqual({
      amount: a("100"),
      capped: false,
    });
    expect(disputedAmount({ ...base, reported: a("120") })).toEqual({
      amount: a("100"),
      capped: true,
    });
  });
});

describe("acquirerRefunded (C20): what a dispute may record as the acquirer's refunds", () => {
  const base = { recorded: 0n, captured: a("100") };

  it("our own cash-out parts the acquirer executed but we did not record yet are not its refunds", () => {
    // A card cash-out's 60 part on this capture is executed, still pending on its cash-out.
    expect(acquirerRefunded({ ...base, acquirerTotal: a("60"), pendingParts: a("60") })).toBeNull();
    // The acquirer refunded 25 of its own on top: that much is recorded, not the 60.
    expect(acquirerRefunded({ ...base, acquirerTotal: a("85"), pendingParts: a("60") })).toBe(
      a("25"),
    );
  });

  it("only ever moves the figure up, and never past the capture", () => {
    expect(
      acquirerRefunded({ ...base, recorded: a("30"), acquirerTotal: a("30"), pendingParts: 0n }),
    ).toBeNull();
    expect(acquirerRefunded({ ...base, acquirerTotal: a("40"), pendingParts: 0n })).toBe(a("40"));
    expect(acquirerRefunded({ ...base, acquirerTotal: a("140"), pendingParts: 0n })).toBeNull();
  });
});
