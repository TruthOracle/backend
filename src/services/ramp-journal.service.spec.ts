import { parseAmount } from "../util/money";
import {
  accruedPspFee,
  onrampBasis,
  postingFor,
  RAMP_IP_RELEASES,
  RAMP_ORDER_KINDS,
  type RampOrderKind,
} from "./ramp-journal.service";

const a = parseAmount;
/** F = 100 charged, f = 2, N = 98 minted; captured in full. */
const onramp = {
  direction: "onramp" as const,
  fiatAmount: a("100"),
  tokenAmount: a("98"),
  feeAmount: a("2"),
  capturedAmount: a("100"),
};
/** T = 50 withdrawn, f = 1, P = 49 paid. */
const offramp = {
  direction: "offramp" as const,
  fiatAmount: a("49"),
  tokenAmount: a("50"),
  feeAmount: a("1"),
  capturedAmount: null,
};

/** Σ per account over several postings. */
function net(...postings: [string, bigint][][]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const p of postings) for (const [acc, v] of p) out[acc] = (out[acc] ?? 0n) + v;
  for (const k of Object.keys(out)) if (out[k] === 0n) delete out[k];
  return out;
}

describe("ramp journal postings (SPEC §5)", () => {
  it.each(RAMP_ORDER_KINDS)("%s balances to zero", (kind: RampOrderKind) => {
    const order = kind.startsWith("offramp") ? offramp : onramp;
    expect(postingFor(kind, order, a("0.5")).reduce((s, [, v]) => s + v, 0n)).toBe(0n);
  });

  it("a full capture books C = F against issuance_pending and the fee", () => {
    expect(postingFor("onramp.captured", onramp)).toEqual([
      ["provider_clearing", a("100")],
      ["issuance_pending", a("-98")],
      ["fee_revenue", a("-2")],
    ]);
  });

  it("a capture C ≠ F is refund-only: C both sides, no fee; its refund reverses exactly that", () => {
    const partial = { ...onramp, capturedAmount: a("60") };
    expect(onrampBasis(partial)).toEqual({ charged: a("60"), net: a("60"), fee: 0n });
    expect(postingFor("onramp.captured", partial)).toEqual([
      ["provider_clearing", a("60")],
      ["issuance_pending", a("-60")],
      ["fee_revenue", 0n],
    ]);
    expect(
      net(postingFor("onramp.captured", partial), postingFor("onramp.refunded", partial)),
    ).toEqual({});
  });

  it("captured → minted moves N from issuance_pending to customer_liability", () => {
    expect(net(postingFor("onramp.captured", onramp), postingFor("onramp.minted", onramp))).toEqual(
      {
        provider_clearing: a("100"),
        customer_liability: a("-98"),
        fee_revenue: a("-2"),
      },
    );
  });

  it.each(["onramp.refunded", "onramp.voided", "onramp.chargeback"] as const)(
    "%s undoes the capture line for line (nothing minted)",
    (kind) => {
      expect(net(postingFor("onramp.captured", onramp), postingFor(kind, onramp))).toEqual({});
    },
  );

  it("a bank refund queues F in payout_clearing, then the statement debit clears it from the bank", () => {
    expect(
      net(
        postingFor("onramp.captured", onramp),
        postingFor("onramp.refund_queued", onramp),
        postingFor("refund.paid_bank", onramp),
      ),
    ).toEqual({ provider_clearing: a("100"), safeguard_bank: a("-100") });
  });

  it("a chargeback after the mint is a receivable; burning the uncredited N settles it", () => {
    const after = net(
      postingFor("onramp.captured", onramp),
      postingFor("onramp.minted", onramp),
      postingFor("onramp.chargeback_minted", onramp),
      postingFor("onramp.uncredited_burned", onramp),
    );
    expect(after).toEqual({});
  });

  it("a chargeback after a card cash-out refunded 60 of the capture books the disputed 40; a won dispute clears that 40 (S8)", () => {
    const cashedOut = net(
      postingFor("onramp.captured", onramp),
      postingFor("onramp.minted", onramp),
      postingFor("onramp.chargeback_minted", onramp, a("40")),
    );
    expect(cashedOut).toMatchObject({
      chargeback_receivable: a("40"),
      provider_clearing: a("60"),
    });
    expect(
      net(
        postingFor("onramp.chargeback_minted", onramp, a("40")),
        postingFor("onramp.chargeback_reversed", onramp, a("40")),
      ),
    ).toEqual({});
    // No amount given: C, as before.
    expect(postingFor("onramp.chargeback_minted", onramp)).toEqual([
      ["chargeback_receivable", a("100")],
      ["provider_clearing", a("-100")],
    ]);
  });

  it("a bank refund the bank returned is owed again (minus a return fee to bank_fees); the second payment clears it (S8)", () => {
    expect(postingFor("refund.returned_bank", onramp, a("99.50"))).toEqual([
      ["safeguard_bank", a("99.50")],
      ["bank_fees", a("0.50")],
      ["payout_clearing", a("-100")],
    ]);
    expect(
      net(
        postingFor("onramp.captured", onramp),
        postingFor("onramp.refund_queued", onramp),
        postingFor("refund.paid_bank", onramp),
        postingFor("refund.returned_bank", onramp, a("100")),
        postingFor("refund.paid_bank", onramp),
      ),
    ).toEqual({ provider_clearing: a("100"), safeguard_bank: a("-100") });
  });

  it("W9f C19: a bank refund a chargeback stopped is cancelled against the receivable — the order nets to a chargeback with nothing minted", () => {
    const books = [
      postingFor("onramp.captured", onramp),
      postingFor("onramp.refund_queued", onramp),
      postingFor("onramp.chargeback_after_refund", onramp, a("100")),
    ];
    expect(postingFor("onramp.refund_cancelled", onramp, a("100"))).toEqual([
      ["payout_clearing", a("100")],
      ["chargeback_receivable", a("-100")],
    ]);
    // Nothing owed by bank, nothing receivable: as if the issuer took the capture back at once.
    expect(net(...books, postingFor("onramp.refund_cancelled", onramp, a("100")))).toEqual(
      net(postingFor("onramp.captured", onramp), postingFor("onramp.chargeback", onramp)),
    );
    expect(net(...books, postingFor("onramp.refund_cancelled", onramp))).toEqual({});
  });

  it("W9g C19: a dispute won after refund_cancel owes the refund again — paid by bank, the books are those of a capture refunded by bank transfer", () => {
    const books = [
      postingFor("onramp.captured", onramp),
      postingFor("onramp.refund_queued", onramp),
      postingFor("onramp.chargeback_after_refund", onramp, a("100")),
      postingFor("onramp.refund_cancelled", onramp, a("100")),
    ];
    expect(postingFor("onramp.refund_reinstated", onramp, a("100"))).toEqual([
      ["provider_clearing", a("100")],
      ["payout_clearing", a("-100")],
    ]);
    // Owed by bank again, nothing receivable: the acquirer holds the capture once more.
    expect(net(...books, postingFor("onramp.refund_reinstated", onramp, a("100")))).toEqual({
      provider_clearing: a("100"),
      payout_clearing: a("-100"),
    });
    expect(
      net(
        ...books,
        postingFor("onramp.refund_reinstated", onramp, a("100")),
        postingFor("refund.paid_bank", onramp),
      ),
    ).toEqual(
      net(
        postingFor("onramp.captured", onramp),
        postingFor("onramp.refund_queued", onramp),
        postingFor("refund.paid_bank", onramp),
      ),
    );
  });

  it("a chargeback on a refunded order and a won dispute cancel out", () => {
    expect(
      net(
        postingFor("onramp.chargeback_after_refund", onramp),
        postingFor("onramp.chargeback_reversed", onramp),
      ),
    ).toEqual({});
  });

  it("an off-ramp burns T into P owed + fee, then the card payout clears P", () => {
    expect(postingFor("offramp.burned", offramp)).toEqual([
      ["customer_liability", a("50")],
      ["payout_clearing", a("-49")],
      ["fee_revenue", a("-1")],
    ]);
    expect(
      net(postingFor("offramp.burned", offramp), postingFor("offramp.paid_card", offramp)),
    ).toEqual({ customer_liability: a("50"), provider_clearing: a("-49"), fee_revenue: a("-1") });
  });

  it("a re-mint undoes the burn exactly", () => {
    expect(
      net(postingFor("offramp.burned", offramp), postingFor("offramp.reminted", offramp)),
    ).toEqual({});
  });

  it("a partial card cash-out (reverse_remainder) clears P as the paid parts + the re-minted remainder R", () => {
    // P = 49: 30 refunded to the card, R = 19 re-minted back (S5, SPEC §4.2).
    expect(postingFor("offramp.paid_card", offramp, a("30"))).toEqual([
      ["payout_clearing", a("30")],
      ["provider_clearing", a("-30")],
    ]);
    expect(
      net(
        postingFor("offramp.burned", offramp),
        postingFor("offramp.paid_card", offramp, a("30")),
        postingFor("offramp.reversed_partial", offramp, a("19")),
      ),
    ).toEqual({ customer_liability: a("31"), provider_clearing: a("-30"), fee_revenue: a("-1") });
  });

  it("a bank return of R < P books the difference as a bank fee", () => {
    expect(postingFor("offramp.returned_bank", offramp, a("48.5"))).toEqual([
      ["safeguard_bank", a("48.5")],
      ["bank_fees", a("0.5")],
      ["payout_clearing", a("-49")],
    ]);
  });

  it("the issuance_pending releases are exactly the four mutually exclusive kinds", () => {
    expect([...RAMP_IP_RELEASES].sort()).toEqual([
      "onramp.chargeback",
      "onramp.refund_queued",
      "onramp.refunded",
      "onramp.voided",
    ]);
    for (const kind of RAMP_IP_RELEASES)
      expect(postingFor(kind, onramp).find(([acc]) => acc === "issuance_pending")?.[1]).toBe(
        a("98"),
      );
  });
});

describe("accrued PSP fee (SPEC §5 psp.fee_accrued)", () => {
  it("ceils C × bps to whole kopecks", () => {
    expect(accruedPspFee(a("100"), null, 240, 2)).toBe(a("2.4"));
    expect(accruedPspFee(a("10.01"), null, 240, 2)).toBe(a("0.25"));
    expect(accruedPspFee(a("0.01"), null, 1, 2)).toBe(a("0.01"));
  });

  it("the acquirer's own figure wins, zero included", () => {
    expect(accruedPspFee(a("100"), a("1.8"), 240, 2)).toBe(a("1.8"));
    expect(accruedPspFee(a("100"), 0n, 240, 2)).toBe(0n);
  });
});
