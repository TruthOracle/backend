import { RAMP_ORDER_STATUSES, RAMP_STEPS } from "../types";
import { parseAmount } from "../util/money";
import {
  creditBackInFlight,
  isLegalTransition,
  orderNext,
  RAMP_IN_FLIGHT,
  RAMP_TERMINAL,
  RAMP_TRANSITIONS,
  RampOrderStore,
  rampRequestHash,
  userStatusText,
  userTimeline,
} from "./ramp-order-store.service";
import { remainderOf, remintPosting } from "./ramp-token-sync.service";

describe("ramp order state machine (SPEC §4)", () => {
  it("covers every status of SPEC §3.2, and every target is a status", () => {
    expect([...RAMP_ORDER_STATUSES].sort()).toEqual(
      [
        "created",
        "awaiting_payment",
        "paid",
        "minting",
        "crediting",
        "completed",
        "refunding",
        "refunded",
        "chargeback",
        "failed",
        "expired",
        "cancelled",
        "needs_review",
        "awaiting_withdrawal",
        "withdrawing",
        "burning",
        "paying_out",
        "payout_queued",
        "payout_sent",
        "reversing",
      ].sort(),
    );
    expect([...RAMP_STEPS].sort()).toEqual(
      [
        "payment",
        "mint",
        "credit",
        "withdrawal",
        "burn",
        "payout",
        "refund",
        "reversal",
        "compliance",
      ].sort(),
    );
    expect(Object.keys(RAMP_TRANSITIONS).sort()).toEqual([...RAMP_ORDER_STATUSES].sort());
    for (const targets of Object.values(RAMP_TRANSITIONS))
      for (const t of targets) expect(RAMP_ORDER_STATUSES).toContain(t);
  });

  it("refunded re-opens only into review (a returned bank refund, S8), chargeback too (a reinstated bank refund, W9g C19); completed only charges back (on) or reverses on a bank return (off)", () => {
    expect(RAMP_TRANSITIONS.refunded).toEqual(["needs_review"]);
    expect(RAMP_TRANSITIONS.chargeback).toEqual(["needs_review"]);
    expect([...RAMP_TRANSITIONS.completed].sort()).toEqual(["chargeback", "reversing"]);
  });

  it("a refunded order re-opens only for the refund review; any other step throws before the write (S8)", async () => {
    // The guard runs before any database access: a store without one is enough.
    const store = new RampOrderStore(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    const order = { id: "o", status: "refunded", version: 1 } as never;
    await expect(
      store.review(order, ["refunded"], "payout", "a bank return", { type: "system" }),
    ).rejects.toThrow(/re-opens only for its returned bank refund/);
    await expect(
      store.transition(order, ["refunded"], "completed", {}, { actor: { type: "system" } }),
    ).rejects.toThrow(/illegal ramp transition refunded → completed/);
  });

  it("W9g C19: a charged-back order re-opens only for the refund review (its reinstated bank refund); any other step throws before the write", async () => {
    const store = new RampOrderStore(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    const order = { id: "o", status: "chargeback", version: 1 } as never;
    for (const step of ["payment", "payout", "compliance"] as const)
      await expect(
        store.review(order, ["chargeback"], step, "a won dispute", { type: "system" }),
      ).rejects.toThrow(/re-opens only for its reinstated bank refund/);
    await expect(
      store.transition(order, ["chargeback"], "refunded", {}, { actor: { type: "system" } }),
    ).rejects.toThrow(/illegal ramp transition chargeback → refunded/);
  });

  it("a closed on-ramp may only reopen into review (a late capture) or a chargeback", () => {
    for (const s of ["failed", "expired", "cancelled"] as const)
      expect([...RAMP_TRANSITIONS[s]].sort()).toEqual(["chargeback", "needs_review"]);
  });

  it("money paths go forward: no mint before payment, no burn before MarkPaid, no fiat before the burn", () => {
    expect(isLegalTransition("awaiting_payment", "minting")).toBe(false);
    expect(isLegalTransition("paid", "crediting")).toBe(false);
    expect(isLegalTransition("paid", "refunding")).toBe(false);
    expect(isLegalTransition("awaiting_withdrawal", "burning")).toBe(false);
    expect(isLegalTransition("withdrawing", "paying_out")).toBe(false);
    expect(isLegalTransition("withdrawing", "payout_queued")).toBe(false);
    expect(isLegalTransition("paying_out", "refunded")).toBe(false);
    expect(isLegalTransition("burning", "cancelled")).toBe(false);
    // a refund in flight is never turned into a chargeback (SPEC §4.1: it stays, with an alert)
    expect(isLegalTransition("refunding", "chargeback")).toBe(false);
  });

  it("the bank rail: burning → payout_queued → payout_sent → completed | refunded (on-ramp bank refund) | reversing", () => {
    expect(isLegalTransition("burning", "payout_queued")).toBe(true);
    expect(isLegalTransition("payout_queued", "payout_sent")).toBe(true);
    for (const to of ["completed", "refunded", "reversing", "needs_review"] as const)
      expect(isLegalTransition("payout_sent", to)).toBe(true);
    expect(isLegalTransition("payout_queued", "completed")).toBe(false);
    expect(isLegalTransition("needs_review", "payout_queued")).toBe(true);
  });

  it("needs_review exits are the §4.2 actions' targets; never back to a waiting-on-the-user status", () => {
    for (const to of [
      "created",
      "awaiting_payment",
      "awaiting_withdrawal",
      "expired",
      "cancelled",
    ] as const)
      expect(isLegalTransition("needs_review", to)).toBe(false);
    for (const to of ["paid", "minting", "refunding", "reversing", "refunded", "failed"] as const)
      expect(isLegalTransition("needs_review", to)).toBe(true);
  });

  it("in-flight statuses are exactly the ones the processor advances, none terminal", () => {
    for (const s of RAMP_IN_FLIGHT) expect(RAMP_TERMINAL.has(s)).toBe(false);
    for (const s of RAMP_TERMINAL) expect(RAMP_IN_FLIGHT).not.toContain(s);
    expect(RAMP_IN_FLIGHT).not.toContain("needs_review");
  });
});

describe("rampRequestHash (E-D9, L1)", () => {
  const base = {
    direction: "offramp" as const,
    amount: parseAmount("40"),
    method: null,
    destination: { kind: "card", paymentMethodId: "pm-1" },
  };

  it("is stable over key order and amount spelling, and changes with every field", () => {
    const h = rampRequestHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      rampRequestHash({ ...base, destination: { paymentMethodId: "pm-1", kind: "card" } }),
    ).toBe(h);
    expect(rampRequestHash({ ...base, amount: parseAmount("40.0000000000") })).toBe(h);
    expect(rampRequestHash({ ...base, amount: parseAmount("40.01") })).not.toBe(h);
    expect(
      rampRequestHash({ ...base, destination: { kind: "card", paymentMethodId: "pm-2" } }),
    ).not.toBe(h);
    expect(rampRequestHash({ ...base, direction: "onramp" })).not.toBe(h);
    expect(rampRequestHash({ ...base, method: "card" })).not.toBe(h);
  });
});

describe("the user's view of review and timeline (SPEC §11.5, §12.1; C11)", () => {
  // toApi reads only the instrument registry (a miss falls back to the order's own ids).
  const store = new RampOrderStore(
    null as never,
    null as never,
    { get: () => Promise.resolve(null) } as never,
    null as never,
    null as never,
  );
  const at = (m: number): string => new Date(Date.UTC(2026, 9, 19, 10, m)).toISOString();
  const order = (status: string, reviewStep: string | null, details: Record<string, unknown>) =>
    ({
      id: "o-1",
      direction: "onramp",
      status,
      reviewStep,
      details,
      method: "card",
      payoutRail: null,
      instrumentAdmin: "admin::1",
      instrumentId: "cBYN",
      fiatCurrency: "BYN",
      fiatAmount: parseAmount("50"),
      tokenAmount: parseAmount("50"),
      feeAmount: 0n,
      checkoutUrl: null,
      paymentInstructions: null,
      payoutReference: "TO000000000001",
      expiresAt: null,
      operator: null,
      paymentMethodId: null,
      paymentMethod: null,
      bankAccountId: null,
      createdAt: new Date(at(0)),
      updatedAt: new Date(at(9)),
      completedAt: null,
    }) as never;

  it("one rule for every review: reviewStep null and 'processing', whatever the step — compliance is never singled out", async () => {
    for (const step of ["compliance", "payment", "mint", "payout", "refund"]) {
      const seen = await store.toApi(order("needs_review", step, { reviewFrom: "paid" }));
      expect([step, seen.status, seen.reviewStep, seen.statusText]).toEqual([
        step,
        "needs_review",
        null,
        "processing",
      ]);
    }
    // A hold reads the same, whatever its reason.
    for (const reason of ["compliance", "chargeback", "payout_gate", "frozen"]) {
      const held = await store.toApi(order("withdrawing", null, { hold: { reason } }));
      expect([reason, held.reviewStep, held.statusText]).toEqual([reason, null, "processing"]);
    }
  });

  it("the timeline drops every review entry and malformed rows — a compliance review leaves the same trace as any other", async () => {
    const trail = (step: string) => ({
      timeline: [
        { status: "created", at: at(0) },
        { status: "awaiting_payment", at: at(1) },
        { status: "needs_review", at: at(2), step },
        { status: "paid", at: at(5) },
        { nonsense: true },
      ],
    });
    const shown = [
      { status: "created", at: at(0) },
      { status: "awaiting_payment", at: at(1) },
      { status: "paid", at: at(5) },
    ];
    expect(userTimeline(trail("compliance"))).toEqual(shown);
    expect(userTimeline(trail("payment"))).toEqual(shown);
    expect((await store.toApi(order("paid", null, trail("compliance")))).timeline).toEqual(shown);
    expect((await store.toApi(order("paid", null, trail("payment")))).timeline).toEqual(shown);
    expect(userTimeline({})).toEqual([]);
  });
});

describe("the user's view of S5's columns (SPEC §11.5, §12.1)", () => {
  it("every review and every hold reads 'processing' — one word, whatever the reason (no tipping-off)", () => {
    expect(userStatusText({ status: "needs_review", details: {} })).toBe("processing");
    expect(
      userStatusText({ status: "withdrawing", details: { hold: { reason: "compliance" } } }),
    ).toBe("processing");
    expect(
      userStatusText({ status: "paying_out", details: { hold: { reason: "payout_gate" } } }),
    ).toBe("processing");
    expect(userStatusText({ status: "withdrawing", details: { hold: null } })).toBeNull();
    expect(userStatusText({ status: "completed", details: {} })).toBeNull();
  });

  it("next: the hosted page or the ERIP details, only while awaiting_payment", () => {
    const erip = {
      kind: "erip" as const,
      serviceCode: "1",
      accountNumber: "123456789012",
      amount: "1.0000000000",
      instructions: [],
    };
    expect(
      orderNext({
        status: "awaiting_payment",
        method: "card",
        checkoutUrl: "https://x/p",
        paymentInstructions: null,
      }),
    ).toEqual({ kind: "redirect", url: "https://x/p" });
    expect(
      orderNext({
        status: "awaiting_payment",
        method: "erip",
        checkoutUrl: null,
        paymentInstructions: erip,
      }),
    ).toEqual(erip);
    expect(
      orderNext({ status: "paid", method: "erip", checkoutUrl: null, paymentInstructions: erip }),
    ).toBeNull();
    expect(
      orderNext({
        status: "awaiting_payment",
        method: "card",
        checkoutUrl: null,
        paymentInstructions: null,
      }),
    ).toBeNull();
  });

  it("a recorded re-mint posts offramp.reversed_partial (R) after reverse_remainder, else offramp.reminted", () => {
    expect(remintPosting({ details: {} })).toEqual(["offramp.reminted", undefined]);
    const partial = {
      details: {
        cardPayout: { mode: "refund", parts: [], reversal: { remainder: "40.0000000000" } },
      },
    };
    expect(remainderOf(partial)).toBe(parseAmount("40"));
    expect(remintPosting(partial)).toEqual(["offramp.reversed_partial", parseAmount("40")]);
  });
});

describe("W9f: a credit-back in flight (C1)", () => {
  it("only a submitted credit-back holds the order's other exits; a confirmed one or one proven failed for good does not", () => {
    const of = (creditBack: unknown): { details: Record<string, unknown> } => ({
      details: { creditBack },
    });
    expect(creditBackInFlight({ details: {} })).toBe(false);
    expect(creditBackInFlight(of(null))).toBe(false);
    expect(creditBackInFlight(of({ commandId: "ramp-creditback-x", state: "submitted" }))).toBe(
      true,
    );
    // A shape without a state is in flight (fail closed).
    expect(creditBackInFlight(of({ commandId: "ramp-creditback-x" }))).toBe(true);
    expect(creditBackInFlight(of({ commandId: "ramp-creditback-x", state: "confirmed" }))).toBe(
      false,
    );
    expect(creditBackInFlight(of({ commandId: "ramp-creditback-x", state: "failed" }))).toBe(false);
  });
});
