import { parseAmount } from "../util/money";
import {
  awaitingDebit,
  classificationAllowed,
  decideLine,
  type LineView,
  type MatchFacts,
  type OrderFacts,
  pspResidual,
  returnAmountOk,
} from "./ramp-bank-matching.logic";

const A = (v: string): bigint => parseAmount(v);
const ACCOUNT = "k1:aaa";
const OTHER = "k1:bbb";

function order(over: Partial<OrderFacts> = {}): OrderFacts {
  return {
    orderId: "o1",
    direction: "offramp",
    status: "payout_sent",
    reviewStep: null,
    amount: A("50"),
    item: { batchId: "b1", status: "included", batchStatus: "submitted" },
    accountKey: ACCOUNT,
    accountBic: "PJCBBY2X",
    paid: false,
    returned: false,
    ...over,
  };
}

function line(over: Partial<LineView> = {}): LineView {
  return {
    amount: A("-50"),
    reference: "TO000000000000",
    documentNo: null,
    references: ["TO000000000000"],
    documentNos: [],
    counterpartyKeys: new Set([ACCOUNT, "k0:old"]),
    counterpartyBic: "PJCBBY2X",
    returnInfo: false,
    format: "camt053",
    ...over,
  };
}

function facts(over: Partial<MatchFacts> = {}): MatchFacts {
  return {
    referenced: order(),
    candidates: [],
    quotedBatch: null,
    namedItems: null,
    txMismatch: [],
    duplicate: null,
    operatorKeys: new Set(["k1:op"]),
    pspKeys: new Set(["k1:psp"]),
    feeMax: A("5"),
    returnFeeMax: A("0"),
    ...over,
  };
}

describe("statement matching rules (SPEC §10.4)", () => {
  it("a payout debit needs the reference, the exact amount and the order's own account (X3)", () => {
    expect(decideLine(line(), facts())).toEqual({ kind: "payout", orderId: "o1" });
    expect(decideLine(line(), facts({ referenced: order({ direction: "onramp" }) }))).toEqual({
      kind: "refund",
      orderId: "o1",
    });
    // another IBAN (or none at all): never completes, the order goes to review, payouts halt
    for (const keys of [new Set([OTHER]), new Set<string>()])
      expect(decideLine(line({ counterpartyKeys: keys }), facts())).toMatchObject({
        kind: null,
        flags: ["iban_mismatch"],
        reviewOrderId: "o1",
      });
    // the same IBAN at another bank (BIC) is a mismatch too
    expect(decideLine(line({ counterpartyBic: "ALFABY2X" }), facts())).toMatchObject({
      flags: ["iban_mismatch"],
    });
    expect(decideLine(line({ amount: A("-49.99") }), facts())).toMatchObject({
      kind: null,
      flags: [],
    });
  });

  it("R2a-5 / R2a-6: an entry naming a paid payout or a closed file is payout_duplicate; a transaction paid elsewhere is iban_mismatch; a named payout is never a fee", () => {
    const bulk = line({ reference: null, references: ["TO000000000000", "TO000000000001"] });
    const batch = {
      batchId: "b1",
      status: "submitted" as const,
      includedTotal: A("50"),
      includedCount: 2,
      itemCount: 2,
    };
    const named = { batchId: "b1", orderIds: ["o1", "o2"], total: A("50") };
    expect(
      decideLine(bulk, facts({ referenced: null, quotedBatch: batch, namedItems: named })),
    ).toEqual({ kind: "payout_batch", batchId: "b1" });
    expect(
      decideLine(
        bulk,
        facts({ referenced: null, quotedBatch: batch, duplicate: "order o1 was paid" }),
      ),
    ).toMatchObject({ kind: null, flags: ["payout_duplicate"] });
    expect(
      decideLine(
        bulk,
        facts({ referenced: null, quotedBatch: batch, namedItems: named, txMismatch: ["o2"] }),
      ),
    ).toMatchObject({ kind: null, flags: ["iban_mismatch"], reviewOrderId: "o2" });
    const small = line({
      reference: null,
      references: ["TO000000000000"],
      amount: A("-5"),
      counterpartyKeys: new Set(),
    });
    expect(decideLine(small, facts({ referenced: null }))).toMatchObject({ kind: null });
  });

  it("R2a-4: another IBAN is iban_mismatch whatever the amount (a kopeck more never hides the swap)", () => {
    for (const amount of [A("-50.01"), A("-49.99"), A("-500")])
      expect(decideLine(line({ amount, counterpartyKeys: new Set([OTHER]) }), facts())).toEqual({
        kind: null,
        flags: ["iban_mismatch"],
        reviewOrderId: "o1",
        why: "the payout debit went to another account than the order's",
      });
  });

  it("a second debit, or a debit for an order not in a submitted batch, is payout_duplicate (#4)", () => {
    expect(decideLine(line(), facts({ referenced: order({ paid: true }) }))).toMatchObject({
      flags: ["payout_duplicate"],
    });
    for (const o of [
      order({ status: "payout_queued", item: null }),
      order({ item: { batchId: "b1", status: "voided", batchStatus: "voided" } }),
      order({ item: { batchId: "b1", status: "included", batchStatus: "exported" } }),
    ])
      expect(decideLine(line(), facts({ referenced: o }))).toMatchObject({
        flags: ["payout_duplicate"],
      });
    // a payout parked in review after aging still matches its debit (#5)
    const parked = order({ status: "needs_review", reviewStep: "payout" });
    expect(awaitingDebit(parked)).toBe(true);
    expect(decideLine(line(), facts({ referenced: parked }))).toEqual({
      kind: "payout",
      orderId: "o1",
    });
  });

  it("without a reference: a quoted batch total, else exactly one IBAN + amount candidate, else a small bank fee", () => {
    const noRef = line({ reference: null, references: [] });
    const batch = {
      batchId: "b1",
      status: "submitted" as const,
      includedTotal: A("50"),
      includedCount: 2,
      itemCount: 2,
    };
    expect(decideLine(noRef, facts({ referenced: null, quotedBatch: batch }))).toEqual({
      kind: "payout_batch",
      batchId: "b1",
    });
    expect(decideLine(noRef, facts({ referenced: null, candidates: [order()] }))).toEqual({
      kind: "payout",
      orderId: "o1",
    });
    expect(
      decideLine(
        noRef,
        facts({ referenced: null, candidates: [order(), order({ orderId: "o2" })] }),
      ),
    ).toMatchObject({ kind: null });
    const fee = line({
      reference: null,
      references: [],
      amount: A("-2.50"),
      counterpartyKeys: new Set(),
    });
    expect(decideLine(fee, facts({ referenced: null }))).toEqual({ kind: "bank_fee" });
    expect(decideLine(fee, facts({ referenced: null, feeMax: null }))).toMatchObject({
      kind: null,
    });
    expect(decideLine({ ...fee, amount: A("-5.01") }, facts({ referenced: null }))).toMatchObject({
      kind: null,
    });
  });

  it("a batch-booked entry the bank executed in part pays exactly the items its transactions name (C6)", () => {
    // The bank booked 3 of 4 items (O4 rejected) as one entry: 750 of a 1000 batch.
    const bulk = line({
      amount: A("-750"),
      reference: null,
      references: ["TO000000000001", "TO000000000002", "TO000000000003"],
      counterpartyKeys: new Set(),
    });
    const batch = {
      batchId: "b1",
      status: "submitted" as const,
      includedTotal: A("1000"),
      includedCount: 4,
      itemCount: 4,
    };
    const named = { batchId: "b1", orderIds: ["o1", "o2", "o3"], total: A("750") };
    expect(
      decideLine(bulk, facts({ referenced: null, quotedBatch: batch, namedItems: named })),
    ).toEqual({ kind: "payout_batch", batchId: "b1", orderIds: ["o1", "o2", "o3"] });
    // The named items must add up to the debit; a transaction naming nothing leaves it unmatched.
    expect(
      decideLine(bulk, facts({ referenced: null, namedItems: { ...named, total: A("700") } })),
    ).toMatchObject({ kind: null });
    expect(decideLine(bulk, facts({ referenced: null, namedItems: null }))).toMatchObject({
      kind: null,
    });
    // A small entry naming payouts is never booked as a bank fee.
    expect(
      decideLine({ ...bulk, amount: A("-2.50") }, facts({ referenced: null, namedItems: null })),
    ).toMatchObject({ kind: null });
  });

  it("returns are strict: amount P (fee-short at most), debit matched, camt with return info or the account's IBAN (#2, X2)", () => {
    const paid = order({
      status: "completed",
      paid: true,
      item: { batchId: "b1", status: "paid", batchStatus: "settled" },
    });
    const credit = line({ amount: A("50"), returnInfo: true, counterpartyKeys: new Set() });
    expect(decideLine(credit, facts({ referenced: paid }))).toEqual({
      kind: "payout_return",
      orderId: "o1",
    });
    // the user's 0.01 BYN with the reference: never a return
    expect(decideLine(line({ amount: A("0.01") }), facts({ referenced: paid }))).toMatchObject({
      flags: ["reference_credit"],
    });
    // not yet paid, already returned, a CSV statement, or no return evidence: no
    for (const [l, o] of [
      [credit, order({ paid: false })],
      [credit, { ...paid, returned: true }],
      [{ ...credit, format: "csv" as const }, paid],
      [{ ...credit, returnInfo: false }, paid],
    ] as const)
      expect(decideLine(l, facts({ referenced: o }))).toMatchObject({
        flags: ["reference_credit"],
      });
    // from the account's own IBAN without return info: a return (the user sent P back)
    expect(decideLine(line({ amount: A("50") }), facts({ referenced: paid }))).toMatchObject({
      kind: "payout_return",
    });
    expect(returnAmountOk(A("49.50"), A("50"), A("0.50"))).toBe(true);
    expect(returnAmountOk(A("49.49"), A("50"), A("0.50"))).toBe(false);
    expect(returnAmountOk(A("50.01"), A("50"), A("0.50"))).toBe(false);
  });

  it("a bounced on-ramp bank refund matches under the same strict rule while the order reads refunded; a re-sent refund pays again (S8)", () => {
    const refunded = order({
      direction: "onramp",
      status: "refunded",
      paid: true,
      item: { batchId: "b1", status: "paid", batchStatus: "settled" },
    });
    const credit = line({ amount: A("50"), returnInfo: true, counterpartyKeys: new Set() });
    expect(decideLine(credit, facts({ referenced: refunded }))).toEqual({
      kind: "refund_return",
      orderId: "o1",
    });
    // Already returned, not refunded by it any more, or a CSV statement: never automatic.
    for (const o of [
      { ...refunded, returned: true },
      { ...refunded, status: "needs_review", reviewStep: "refund" },
      { ...refunded, paid: false },
    ])
      expect(decideLine(credit, facts({ referenced: o }))).toMatchObject({
        flags: ["reference_credit"],
      });
    expect(decideLine({ ...credit, format: "csv" }, facts({ referenced: refunded }))).toMatchObject(
      { flags: ["reference_credit"] },
    );
    // Re-sent after the return (a new item in a submitted batch, the last payment returned): a refund debit again.
    const resent = order({ direction: "onramp", paid: false });
    expect(decideLine(line(), facts({ referenced: resent }))).toEqual({
      kind: "refund",
      orderId: "o1",
    });
  });

  it("our own operator and PSP accounts come first, whatever the text says", () => {
    expect(
      decideLine(line({ counterpartyKeys: new Set(["k1:psp"]), amount: A("98.50") }), facts()),
    ).toEqual({
      kind: "psp_settlement",
    });
    expect(decideLine(line({ counterpartyKeys: new Set(["k1:psp"]) }), facts())).toEqual({
      kind: "psp_funding",
    });
    expect(
      decideLine(line({ counterpartyKeys: new Set(["k1:op"]), amount: A("10") }), facts()),
    ).toEqual({
      kind: "operator_topup",
    });
    expect(decideLine(line({ counterpartyKeys: new Set(["k1:op"]) }), facts())).toEqual({
      kind: "operator_sweep",
    });
  });

  it("trues PSP fees up only within the fees accrued since the last settlement", () => {
    expect(pspResidual(A("98.80"), A("98.50"), A("1.20"))).toBe(A("0.30"));
    expect(pspResidual(A("98.80"), A("99.00"), A("1.20"))).toBe(A("-0.20"));
    expect(pspResidual(A("150"), A("98.50"), A("1.20"))).toBeNull();
    expect(pspResidual(A("98.50"), A("98.50"), A("1.20"))).toBeNull();
    expect(pspResidual(A("98.80"), A("98.50"), 0n)).toBeNull();
  });

  it("classification books a kind only in its direction (suspense either way)", () => {
    expect(classificationAllowed("suspense", true)).toBe(true);
    expect(classificationAllowed("suspense", false)).toBe(true);
    expect(classificationAllowed("payout", false)).toBe(false);
    expect(classificationAllowed("payout_return", false)).toBe(true);
    expect(classificationAllowed("operator_topup", true)).toBe(false);
    expect(classificationAllowed("refund_return", false)).toBe(true);
    expect(classificationAllowed("refund_return", true)).toBe(false);
  });
});
