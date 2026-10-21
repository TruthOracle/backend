import { formatAmount, parseAmount } from "../util/money";
import { DAY_MS } from "../util/time";
import {
  cardAvailable,
  cardPayoutOf,
  cashoutPartKey,
  partsTotal,
  planCardRefunds,
  remainingRefundable,
  reservedByOthers,
  withReservations,
  type CardCashoutPart,
  type RefundableCapture,
} from "./ramp-card-cashout.logic";

const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const u = parseAmount;

function capture(
  id: string,
  days: number,
  captured: string,
  refunded = "0",
): Omit<RefundableCapture, "reserved"> {
  return {
    onrampOrderId: id,
    paymentId: `pay-${id}`,
    capturedAt: ago(days),
    captured: u(captured),
    refunded: u(refunded),
  };
}

function part(onramp: string, amount: string, status: CardCashoutPart["status"]): CardCashoutPart {
  return {
    paymentId: `pay-${onramp}`,
    onrampOrderId: onramp,
    amount: formatAmount(u(amount)),
    key: `k-${onramp}`,
    status,
  };
}

const plan = (offramp: string, amount: string, captures: RefundableCapture[], maxDays = 180) =>
  planCardRefunds({
    offrampOrderId: offramp,
    amount: u(amount),
    captures,
    now: NOW,
    maxDays,
    format: formatAmount,
  });

describe("card cash-out planning (SPEC §9.3, #13)", () => {
  it("splits P over the card's captures oldest first, each part ≤ what its capture can still refund", () => {
    const captures = withReservations(
      [capture("b", 3, "100"), capture("a", 10, "60", "20"), capture("c", 1, "50")],
      new Map(),
    );
    const parts = plan("off-1", "120", captures);
    expect(parts).toEqual([
      {
        paymentId: "pay-a",
        onrampOrderId: "a",
        amount: formatAmount(u("40")),
        key: cashoutPartKey("off-1", "a"),
        status: "planned",
      },
      {
        paymentId: "pay-b",
        onrampOrderId: "b",
        amount: formatAmount(u("80")),
        key: cashoutPartKey("off-1", "b"),
        status: "planned",
      },
    ]);
    expect(cashoutPartKey("off-1", "a")).toBe("cashout-off-1-a");
    // Exactly what is left: every capture used, the newest partly.
    expect(plan("off-1", "190", captures)?.map((p) => p.amount)).toEqual(
      ["40", "100", "50"].map((v) => formatAmount(u(v))),
    );
    expect(plan("off-1", "190.01", captures)).toBeNull();
    expect(plan("off-1", "0", captures)).toBeNull();
  });

  it("available(card) excludes the order's OWN parts but counts every other in-flight cash-out (#13)", () => {
    const base = [capture("a", 5, "100"), capture("b", 2, "100")];
    const inFlight = [
      { offrampOrderId: "mine", parts: [part("a", "100", "planned"), part("b", "30", "pending")] },
      {
        offrampOrderId: "other",
        parts: [part("b", "50", "pending"), part("a", "10", "succeeded")],
      },
      { offrampOrderId: "older", parts: [part("a", "20", "failed"), part("b", "5", "void")] },
    ];
    // For "mine": only "other"'s pending 50 on b reserves; succeeded / failed / void never do.
    const forMine = withReservations(base, reservedByOthers(inFlight, "mine", u));
    expect(cardAvailable(forMine, NOW, 180)).toBe(u("150"));
    // The full-cap cash-out passes its own check before every part (#13 a).
    expect(plan("mine", "130", forMine)).not.toBeNull();
    // A NEW cash-out sees everyone's reservations, "mine" included.
    const forNew = withReservations(base, reservedByOthers(inFlight, null, u));
    expect(cardAvailable(forNew, NOW, 180)).toBe(u("20"));
    expect(plan("new", "20.01", forNew)).toBeNull();
    expect(remainingRefundable({ ...forNew[0], reserved: u("500") })).toBe(0n);
  });

  it("captures older than the refund window are never planned (min of config and acquirer)", () => {
    const captures = withReservations(
      [capture("old", 181, "100"), capture("young", 179, "40")],
      new Map(),
    );
    expect(cardAvailable(captures, NOW, 180)).toBe(u("40"));
    expect(plan("off", "50", captures)).toBeNull();
    expect(plan("off", "40", captures)?.map((p) => p.onrampOrderId)).toEqual(["young"]);
    expect(cardAvailable(captures, NOW, 30)).toBe(0n);
    expect(cardAvailable(captures, NOW, 200)).toBe(u("140"));
  });

  it("sums parts by status and reads details.cardPayout defensively", () => {
    const parts = [
      part("a", "10", "succeeded"),
      part("b", "5", "failed"),
      part("c", "2.5", "succeeded"),
    ];
    expect(partsTotal(parts, ["succeeded"], u)).toBe(u("12.5"));
    expect(partsTotal(parts, ["planned", "pending"], u)).toBe(0n);
    expect(cardPayoutOf({ cardPayout: { mode: "refund", parts } })).toEqual({
      mode: "refund",
      parts,
    });
    expect(cardPayoutOf({ cardPayout: { mode: "wire", parts } })).toBeNull();
    expect(cardPayoutOf({ cardPayout: { mode: "oct" } })).toBeNull();
    expect(cardPayoutOf(null)).toBeNull();
  });
});
