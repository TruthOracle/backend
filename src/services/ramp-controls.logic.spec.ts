import { parseAmount } from "../util/money";
import {
  clientLiabilities,
  escalateUnknown,
  haltScopesOf,
  mintsHaltHolds,
  operatorHeadroom,
  PAYOUT_GATE_CHECKS,
  RESERVE_GATE_CHECKS,
  reserveAfter,
  reserveFigures,
  runRefusal,
  worstStatus,
} from "./ramp-controls.logic";

const a = (v: string): bigint => parseAmount(v);

describe("ramp controls logic (SPEC §6)", () => {
  describe("reserve gate (d) — critique #6 numbers", () => {
    it("a shortfall hidden by other orders' pending captures now FAILS (#6 a)", () => {
      // S 10 000 issued, the bank holds 9 500 (two chargebacks), ten captures of 100 sit in PC and IP.
      const figures = reserveFigures({
        safeguard_bank: a("9500"),
        provider_clearing: a("1000"),
        issuance_pending: -a("1000"),
        customer_liability: -a("10000"),
      });
      const r = reserveAfter({
        figures,
        recordedSupply: a("10000"),
        unresolvedNonRampMints: 0n,
        delta: 0n,
        tolerance: 0n,
      });
      expect(r.assets).toBe(a("10500"));
      expect(r.liabilitiesAfter).toBe(a("11000"));
      expect(r.headroom).toBe(-a("500"));
      expect(r.ok).toBe(false);
      // The v1 formula (B + PC ≥ S + N) let five of the ten mints through: 9 500 + 1 000 ≥ 10 000 + 100 … + 500.
      expect(a("9500") + a("1000") >= a("10000") + a("500")).toBe(true);
    });

    it("a re-mint at par passes (#6 b): Δ = T − P = 0, and a re-mint with a fee adds only the fee", () => {
      // Burn T = 100 at par: S 9 900, PO 100, the bank still holds 10 000.
      const atPar = reserveAfter({
        figures: reserveFigures({ safeguard_bank: a("10000"), payout_clearing: -a("100") }),
        recordedSupply: a("9900"),
        unresolvedNonRampMints: 0n,
        delta: a("100") - a("100"),
        tolerance: 0n,
      });
      expect(atPar).toMatchObject({ liabilitiesAfter: a("10000"), headroom: 0n, ok: true });
      // The critique's T 100 / P 99: S 9 900, PO 99, B 10 000 → L_after = 9 900 + 99 + 1 = 10 000 ≤ 10 000.
      const withFee = reserveAfter({
        figures: reserveFigures({ safeguard_bank: a("10000"), payout_clearing: -a("99") }),
        recordedSupply: a("9900"),
        unresolvedNonRampMints: 0n,
        delta: a("100") - a("99"),
        tolerance: 0n,
      });
      expect(withFee).toMatchObject({ liabilitiesAfter: a("10000"), ok: true });
    });

    it("unresolved non-ramp mints and a credit suspense count against the reserve; tolerance is an allowed shortfall", () => {
      const figures = reserveFigures({ safeguard_bank: a("1000"), bank_suspense: -a("30") });
      expect(figures.bankSuspense).toBe(a("30"));
      // A debit suspense is not an asset of the client.
      expect(reserveFigures({ bank_suspense: a("30") }).bankSuspense).toBe(0n);
      const tight = reserveAfter({
        figures,
        recordedSupply: a("950"),
        unresolvedNonRampMints: a("21"),
        delta: 0n,
        tolerance: 0n,
      });
      expect(tight).toMatchObject({ liabilitiesAfter: a("1001"), ok: false });
      expect(
        reserveAfter({
          figures,
          recordedSupply: a("950"),
          unresolvedNonRampMints: a("21"),
          delta: 0n,
          tolerance: a("1"),
        }).ok,
      ).toBe(true);
    });

    it("the §5 identity: client liabilities = IP + CL + PO + max(0, suspense)", () => {
      const f = reserveFigures({
        issuance_pending: -a("10"),
        customer_liability: -a("200"),
        payout_clearing: -a("5"),
        bank_suspense: -a("1"),
        provider_clearing: a("97.6"),
      });
      expect(clientLiabilities(f)).toBe(a("216"));
      expect(f.assets).toBe(a("97.6"));
    });

    it("operator headroom (what a sweep may take, X7): A − L, fee revenue net of fees included", () => {
      // One account: opening 1 000 (operator money), a 100 on-ramp with a fee of 2 (CL 98), a bank fee of 1.
      const f = reserveFigures({
        safeguard_bank: a("1099"),
        operator_money: -a("1000"),
        customer_liability: -a("98"),
        fee_revenue: -a("2"),
        bank_fees: a("1"),
      });
      expect(operatorHeadroom(f)).toBe(a("1001"));
      // Client money is never headroom; a debit suspense (money gone, unknown why) shrinks it.
      expect(
        operatorHeadroom(reserveFigures({ safeguard_bank: a("98"), customer_liability: -a("98") })),
      ).toBe(0n);
      expect(
        operatorHeadroom(
          reserveFigures({
            safeguard_bank: a("990"),
            bank_suspense: a("10"),
            operator_money: -a("1000"),
          }),
        ),
      ).toBe(a("990"));
      // Already short: negative, so no sweep at all.
      expect(
        operatorHeadroom(
          reserveFigures({ safeguard_bank: a("90"), customer_liability: -a("100") }),
        ),
      ).toBe(-a("10"));
    });
  });

  it("a run is as bad as its worst check: red > unknown > amber > green", () => {
    expect(worstStatus([])).toBe("green");
    expect(worstStatus(["green", "amber"])).toBe("amber");
    expect(worstStatus(["amber", "unknown", "green"])).toBe("unknown");
    expect(worstStatus(["unknown", "red", "amber"])).toBe("red");
  });

  it("an unknown halting check turns red after RAMP_RECON_UNKNOWN_MAX_MIN; a report-only one never does", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const halting = { status: "unknown" as const, haltScopes: ["mints" as const] };
    expect(escalateUnknown(halting, null, now, 60)).toEqual({
      status: "unknown",
      unknownSince: now.toISOString(),
      escalated: false,
    });
    expect(escalateUnknown(halting, new Date("2026-10-19T11:30:00Z"), now, 60).status).toBe(
      "unknown",
    );
    expect(escalateUnknown(halting, new Date("2026-10-19T10:59:00Z"), now, 60)).toMatchObject({
      status: "red",
      unknownSince: "2026-10-19T10:59:00.000Z",
      escalated: true,
    });
    expect(
      escalateUnknown(
        { status: "unknown", haltScopes: [] },
        new Date("2026-10-18T00:00:00Z"),
        now,
        60,
      ).status,
    ).toBe("unknown");
    expect(
      escalateUnknown({ status: "green", haltScopes: ["mints"] }, new Date(0), now, 60),
    ).toEqual({
      status: "green",
      unknownSince: null,
      escalated: false,
    });
  });

  it("the halt map: the union of the scopes of every red check", () => {
    expect(
      haltScopesOf([
        { status: "red", haltScopes: ["mints", "payouts"] },
        { status: "amber", haltScopes: ["orders"] },
        { status: "red", haltScopes: ["mints"] },
      ]),
    ).toEqual(["mints", "payouts"]);
    expect(
      haltScopesOf([{ status: "unknown", haltScopes: ["orders", "mints", "payouts"] }]),
    ).toEqual([]);
  });

  it("a mints halt holds re-mints only for a token-integrity failure (#6 d)", () => {
    const reserveOnly = {
      haltedScopes: ["mints" as const],
      failingChecks: [{ name: "reserve_covers_liabilities" }],
    };
    const integrity = {
      haltedScopes: ["mints" as const],
      failingChecks: [{ name: "token_records_known" }],
    };
    const manual = { haltedScopes: ["mints" as const], failingChecks: null };
    expect(mintsHaltHolds("mint", reserveOnly)).toBe(true);
    expect(mintsHaltHolds("remint", reserveOnly)).toBe(false);
    expect(mintsHaltHolds("remint", integrity)).toBe(true);
    expect(mintsHaltHolds("remint", manual)).toBe(false);
    expect(mintsHaltHolds("mint", { haltedScopes: ["payouts"], failingChecks: null })).toBe(false);
  });

  it("the gates read the latest full run: none, stale, red, and (payout gate) unknown refuse", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const run = (
      minutesAgo: number,
      checks: { name: string; status: "green" | "red" | "unknown" }[],
    ) => ({
      trigger: "schedule",
      finishedAt: new Date(now.getTime() - minutesAgo * 60_000),
      checks,
    });
    const opts = { now, maxAgeMin: 60, refuseUnknown: false };
    expect(runRefusal(null, RESERVE_GATE_CHECKS, opts)?.reason).toBe("recon_missing");
    expect(runRefusal(run(61, []), RESERVE_GATE_CHECKS, opts)?.reason).toBe("recon_stale");
    expect(
      runRefusal(run(5, [{ name: "journal_balanced", status: "red" }]), RESERVE_GATE_CHECKS, opts),
    ).toMatchObject({
      reason: "recon_red",
      detail: "red: journal_balanced",
    });
    // A red check outside the gate's set does not refuse it.
    expect(
      runRefusal(
        run(5, [{ name: "reserve_covers_liabilities", status: "red" }]),
        RESERVE_GATE_CHECKS,
        opts,
      ),
    ).toBeNull();
    const unknown = run(5, [{ name: "treasury_covers_in_app", status: "unknown" }]);
    expect(runRefusal(unknown, PAYOUT_GATE_CHECKS, opts)).toBeNull();
    expect(runRefusal(unknown, PAYOUT_GATE_CHECKS, { ...opts, refuseUnknown: true })?.reason).toBe(
      "recon_unknown",
    );
  });
});
