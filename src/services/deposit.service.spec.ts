import { parseCC } from "../util/money";
import { depositCommandId, depositTxRef, planCredit } from "./deposit.service";

const PRIMARY = "alice::1220" + "a".repeat(64);
const SECOND = "bob::1220" + "b".repeat(64);

function wallet(id: string, partyId: string, receivedCC: string, creditedCC = "0") {
  return { id, partyId, receivedCC: parseCC(receivedCC), creditedCC: parseCC(creditedCC) };
}

describe("DepositService pure derivation (ARCHITECTURE §8.3 steps 3–5, §8.4)", () => {
  it("owes each wallet what it sent minus what was attributed, in exact fixed point, and sums only positive owed", () => {
    const plan = planCredit({
      wallets: [wallet("a", PRIMARY, "10.0000000001", "4"), wallet("b", SECOND, "2.5", "2.5")],
      primaryPartyId: PRIMARY,
      ledgerDepositedCC: parseCC("6.5"),
    });
    expect(plan.drift).toBeNull();
    expect(plan.expected).toBe(parseCC("6.5"));
    expect(plan.delta).toBe(0n);
    expect(plan.amount).toBe(parseCC("6.0000000001"));
    expect(plan.attribution).toEqual([{ walletId: "a", partyId: PRIMARY, amountCC: "6.0000000001" }]);
    expect(plan.owed.get("b")).toBe(0n);
  });

  it("a never-deposited account: nothing attributed, nothing on the ledger, everything received is owed", () => {
    const plan = planCredit({ wallets: [wallet("a", PRIMARY, "10"), wallet("b", SECOND, "2")], primaryPartyId: PRIMARY, ledgerDepositedCC: 0n });
    expect(plan).toMatchObject({ drift: null, expected: 0n, delta: 0n, amount: parseCC("12") });
    expect(plan.attribution).toEqual([
      { walletId: "a", partyId: PRIMARY, amountCC: "10.0000000000" },
      { walletId: "b", partyId: SECOND, amountCC: "2.0000000000" },
    ]);
  });

  it("step 3: a wallet attributed more than it ever sent is over_credit drift", () => {
    const plan = planCredit({ wallets: [wallet("a", PRIMARY, "1"), wallet("b", SECOND, "0", "5")], primaryPartyId: PRIMARY, ledgerDepositedCC: parseCC("5") });
    expect(plan.drift).toEqual({ kind: "over_credit", walletId: "b", amountCC: parseCC("-5") });
    expect(plan.amount).toBe(0n);
  });

  it("step 4: a ledger below the attributed total is ledger_below_expected drift", () => {
    const below = planCredit({ wallets: [wallet("a", PRIMARY, "10", "10")], primaryPartyId: PRIMARY, ledgerDepositedCC: parseCC("9") });
    expect(below.drift).toEqual({ kind: "ledger_below_expected", walletId: "a", amountCC: parseCC("-1") });
    expect(below.amount).toBe(0n);
  });

  it("step 4: a ledger ABOVE the attributed total is ledger_above_expected drift — never silently attributed, even when the history could explain it", () => {
    const above = planCredit({ wallets: [wallet("a", PRIMARY, "12", "10"), wallet("b", SECOND, "1")], primaryPartyId: PRIMARY, ledgerDepositedCC: parseCC("12") });
    expect(above.drift).toEqual({ kind: "ledger_above_expected", walletId: "a", amountCC: parseCC("2") });
    expect(above.amount).toBe(0n);
    expect(above.attribution).toEqual([]);
    // The unattributed owed amounts are still reported for the operator.
    expect(above.owed.get("a")).toBe(parseCC("2"));
    expect(above.owed.get("b")).toBe(parseCC("1"));
    expect(above).toMatchObject({ expected: parseCC("10"), ledgerDepositedCC: parseCC("12"), delta: parseCC("2") });
  });

  it("dust (≤ 1e-9 CC) in either direction is neither drift nor a credit", () => {
    const under = planCredit({ wallets: [wallet("a", PRIMARY, "10.0000000005", "10")], primaryPartyId: PRIMARY, ledgerDepositedCC: parseCC("9.9999999995") });
    expect(under.drift).toBeNull();
    expect(under.amount).toBeLessThanOrEqual(10n);
    const over = planCredit({ wallets: [wallet("a", PRIMARY, "10", "10")], primaryPartyId: PRIMARY, ledgerDepositedCC: parseCC("10.0000000009") });
    expect(over.drift).toBeNull();
    expect(over.amount).toBe(0n);
    // One unit past DUST refuses.
    expect(planCredit({ wallets: [wallet("a", PRIMARY, "10", "10")], primaryPartyId: PRIMARY, ledgerDepositedCC: parseCC("10.0000000011") }).drift?.kind).toBe("ledger_above_expected");
    expect(planCredit({ wallets: [wallet("a", PRIMARY, "10", "10")], primaryPartyId: PRIMARY, ledgerDepositedCC: parseCC("9.9999999989") }).drift?.kind).toBe("ledger_below_expected");
  });

  it("refuses a primary without a wallet row", () => {
    expect(() => planCredit({ wallets: [wallet("b", SECOND, "1")], primaryPartyId: PRIMARY, ledgerDepositedCC: 0n })).toThrow(/primary party has no wallet row/);
  });

  it("derives one command id per exact pre-state, so racing duplicates collide and a later deposit gets a new id", () => {
    const a = depositCommandId(PRIMARY, "uw-1", parseCC("5"), parseCC("10"));
    expect(a).toMatch(/^deposit-[0-9a-f]{40}$/);
    expect(depositCommandId(PRIMARY, "uw-1", parseCC("5"), parseCC("10"))).toBe(a);
    expect(depositCommandId(PRIMARY, "uw-2", parseCC("5"), parseCC("10"))).not.toBe(a);
    expect(depositCommandId(PRIMARY, "uw-1", parseCC("5.0000000001"), parseCC("10"))).not.toBe(a);
    expect(depositCommandId(PRIMARY, "uw-1", parseCC("5"), parseCC("15"))).not.toBe(a);
    expect(depositCommandId(PRIMARY, null, parseCC("5"), 0n)).not.toBe(a);
    expect(depositTxRef(a)).toBe(`reconcile:${a}`);
  });
});
