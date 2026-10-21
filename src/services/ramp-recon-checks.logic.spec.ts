import { BusinessCalendar } from "../util/by-calendar";
import { parseAmount } from "../util/money";
import {
  evalCommandsConfirmed,
  evalCommandsConsistent,
  evalRecordsKnown,
  evalSupply,
  evalTreasury,
  mismatchResolution,
  stuckReason,
} from "./ramp-recon-checks.logic";

const a = (v: string): bigint => parseAmount(v);
const NOW = new Date("2026-10-22T09:00:00Z"); // Thursday, 12:00 Minsk

describe("S4 reconciliation checks (SPEC §6.2)", () => {
  it("token_records_known: any unknown record is red; an incomplete view is unknown; else green", () => {
    expect(
      evalRecordsKnown({
        unknownRecords: [
          { kind: "mint", commandId: "x", amount: a("7") },
          { kind: "burn", commandId: null, amount: a("2") },
        ],
        complete: false,
        why: "token-app down",
      }),
    ).toMatchObject({ status: "red", figures: { unknownRecords: 2, unknownNet: "5.0000000000" } });
    expect(
      evalRecordsKnown({ unknownRecords: [], complete: false, why: "token-app down" }),
    ).toMatchObject({
      status: "unknown",
      detail: "token-app down",
    });
    expect(evalRecordsKnown({ unknownRecords: [], complete: true, why: null }).status).toBe(
      "green",
    );
  });

  it("token_commands_consistent: an open mismatch or an unflagged duplicate is red; a compensation in flight is amber", () => {
    expect(mismatchResolution({ commandId: "m", resolvedBy: null, lastError: null }, null)).toBe(
      "unresolved",
    );
    expect(
      mismatchResolution({ commandId: "m", resolvedBy: "comp-1", lastError: null }, "recorded"),
    ).toBe("resolved");
    expect(
      mismatchResolution({ commandId: "m", resolvedBy: "comp-1", lastError: null }, "submitted"),
    ).toBe("in_flight");
    expect(
      mismatchResolution({ commandId: "m", resolvedBy: "comp-1", lastError: null }, "rejected"),
    ).toBe("unresolved");
    // Resolved by an approval: the net was already right.
    expect(mismatchResolution({ commandId: "m", resolvedBy: "4f0c…", lastError: null }, null)).toBe(
      "resolved",
    );

    const base = { complete: true, why: null };
    expect(
      evalCommandsConsistent({
        ...base,
        mismatches: [{ commandId: "m1", resolution: "unresolved" }],
        duplicates: [],
      }),
    ).toMatchObject({
      status: "red",
      figures: { unresolved: 1 },
    });
    expect(evalCommandsConsistent({ ...base, mismatches: [], duplicates: ["d1"] }).status).toBe(
      "red",
    );
    expect(
      evalCommandsConsistent({
        ...base,
        mismatches: [{ commandId: "m1", resolution: "in_flight" }],
        duplicates: [],
      }).status,
    ).toBe("amber");
    expect(
      evalCommandsConsistent({
        ...base,
        mismatches: [{ commandId: "m1", resolution: "resolved" }],
        duplicates: [],
      }).status,
    ).toBe("green");
    expect(
      evalCommandsConsistent({ complete: false, why: "x", mismatches: [], duplicates: [] }).status,
    ).toBe("unknown");
  });

  it("token_commands_confirmed: amber past RAMP_TOKEN_CONFIRM_MIN since the last POST (else since creation)", () => {
    const at = (min: number): Date => new Date(NOW.getTime() - min * 60_000);
    expect(
      evalCommandsConfirmed({
        unresolved: [
          { commandId: "fresh", lastPostAt: at(5), createdAt: at(50) },
          { commandId: "late", lastPostAt: at(16), createdAt: at(50) },
          { commandId: "never-sent", lastPostAt: null, createdAt: at(20) },
        ],
        confirmMin: 15,
        now: NOW,
      }),
    ).toMatchObject({ status: "amber", figures: { unresolved: 3, overdue: 2 } });
    expect(evalCommandsConfirmed({ unresolved: [], confirmMin: 15, now: NOW }).status).toBe(
      "green",
    );
  });

  it("supply_matches_issuance: above the mirror is red (unknown while the page is older than the monitor); below or stale is amber", () => {
    const updatedAt = new Date("2026-10-22T08:59:00Z");
    const paged = new Date("2026-10-22T08:59:30Z");
    const base = { updatedAt, monitorAgeSec: 5, mirrorAsOf: paged, error: null };
    expect(evalSupply({ ...base, totalSupply: a("105"), mirrorNet: a("100") })).toMatchObject({
      status: "red",
      figures: { totalSupply: "105.0000000000", mirrorNet: "100.0000000000" },
    });
    expect(
      evalSupply({
        ...base,
        mirrorAsOf: new Date("2026-10-22T08:58:00Z"),
        totalSupply: a("105"),
        mirrorNet: a("100"),
      }).status,
    ).toBe("unknown");
    expect(evalSupply({ ...base, totalSupply: a("95"), mirrorNet: a("100") }).status).toBe("amber");
    expect(
      evalSupply({ ...base, monitorAgeSec: 3600, totalSupply: a("100"), mirrorNet: a("100") })
        .status,
    ).toBe("amber");
    expect(evalSupply({ ...base, totalSupply: a("100"), mirrorNet: a("100") }).status).toBe(
      "green",
    );
    expect(
      evalSupply({ ...base, totalSupply: null, mirrorNet: 0n, error: "token-app /status: 503" }),
    ).toMatchObject({
      status: "unknown",
      detail: "token-app /status: 503",
    });
  });

  it("treasury_covers_in_app: market collateral and MarkPaid'd cash-outs count; burns in flight make it unknown, not red (#9 b)", () => {
    const base = {
      walletBalances: a("800"),
      livePayouts: a("50"),
      marketCollateral: a("100"),
      pendingBurns: a("20"),
      inFlightBurns: a("30"),
      surplusMax: a("10"),
      offset: 42,
    };
    expect(evalTreasury({ ...base, holdings: a("969") })).toMatchObject({
      status: "red",
      figures: { offset: 42 },
    });
    // 970 covers everything except the burns in flight: they may already have left the holdings.
    expect(evalTreasury({ ...base, holdings: a("970") }).status).toBe("unknown");
    expect(evalTreasury({ ...base, holdings: a("1000") }).status).toBe("green");
    expect(evalTreasury({ ...base, holdings: a("1011") })).toMatchObject({
      status: "amber",
      figures: { surplus: "11.0000000000" },
    });
    expect(evalTreasury({ ...base, surplusMax: null, holdings: a("5000") }).status).toBe("green");
  });

  it("W9g C1: a credit-back key proven never to land that landed after all is flagged — amber when T is credited once, red when another generation landed too, whatever the figures", () => {
    const base = {
      walletBalances: a("800"),
      livePayouts: a("50"),
      marketCollateral: a("100"),
      pendingBurns: 0n,
      inFlightBurns: 0n,
      surplusMax: null,
      offset: 42,
      holdings: a("5000"),
    };
    expect(evalTreasury({ ...base, lateCreditBacks: [] }).status).toBe("green");
    const once = { orderId: "o-1", commandId: "ramp-creditback-a", where: "ledger" as const };
    expect(evalTreasury({ ...base, lateCreditBacks: [{ ...once, twice: false }] })).toMatchObject({
      status: "amber",
      detail:
        "credit-back ramp-creditback-a of order o-1 was proven never to land but landed (ledger): the order is credited back once; settle its review by hand",
      figures: { offset: 42, lateCreditBacks: [{ ...once, twice: false }] },
    });
    // A short treasury stays red, naming the figures (the late key rides along).
    expect(
      evalTreasury({ ...base, holdings: a("100"), lateCreditBacks: [{ ...once, twice: false }] }),
    ).toMatchObject({ status: "red", detail: expect.stringMatching(/^treasury holds/) as string });
    const twice = [
      { ...once, twice: false },
      { orderId: "o-2", commandId: "ramp-creditback-b-2", where: "index" as const, twice: true },
    ];
    expect(evalTreasury({ ...base, lateCreditBacks: twice })).toMatchObject({
      status: "red",
      detail:
        "order o-2 was credited back twice: credit-back ramp-creditback-b-2, proven never to land, landed (index) besides another generation (and 1 more)",
      figures: { lateCreditBacks: twice },
    });
  });

  it("no_stuck_orders: per-status thresholds on the Belarusian calendar; deferred orders are never stuck (M8)", () => {
    const cal = new BusinessCalendar();
    const ctx = { now: NOW, calendar: cal, confirmMin: 15, stuckAfterMin: 30, bankSettleDays: 3 };
    const ago = (min: number): Date => new Date(NOW.getTime() - min * 60_000);
    const order = (
      status: string,
      changed: Date,
      extra: { expiresAt?: Date | null; held?: boolean } = {},
    ) => ({
      status: status as never,
      statusChangedAt: changed,
      expiresAt: extra.expiresAt ?? null,
      held: extra.held ?? false,
    });
    expect(stuckReason(order("awaiting_payment", ago(600), { expiresAt: ago(4) }), ctx)).toBeNull();
    expect(stuckReason(order("awaiting_payment", ago(600), { expiresAt: ago(6) }), ctx)).toMatch(
      /past its expiry/,
    );
    expect(stuckReason(order("minting", ago(14)), ctx)).toBeNull();
    expect(stuckReason(order("minting", ago(16)), ctx)).toMatch(/minting for over 15 min/);
    expect(stuckReason(order("paid", ago(31)), ctx)).toMatch(/paid for over 30 min/);
    expect(stuckReason(order("paid", ago(31), { held: true }), ctx)).toBeNull();
    // payout_queued: Wednesday is 1 business day before Thursday; Tuesday is 2.
    expect(stuckReason(order("payout_queued", new Date("2026-10-21T10:00:00Z")), ctx)).toBeNull();
    expect(stuckReason(order("payout_queued", new Date("2026-10-20T10:00:00Z")), ctx)).toMatch(
      /1 business day/,
    );
    // payout_sent: 3 business days back from Thursday is Monday; the Friday before is past it.
    expect(stuckReason(order("payout_sent", new Date("2026-10-19T10:00:00Z")), ctx)).toBeNull();
    expect(stuckReason(order("payout_sent", new Date("2026-10-16T10:00:00Z")), ctx)).toMatch(
      /3 business days/,
    );
    expect(stuckReason(order("refunding", ago(23 * 60)), ctx)).toBeNull();
    expect(stuckReason(order("refunding", ago(25 * 60)), ctx)).toMatch(/refunding/);
    // An ERIP refund may stay pending at the acquirer up to 11 days (S5).
    const erip = (minutes: number) => ({
      ...order("refunding", ago(minutes)),
      method: "erip" as const,
    });
    expect(stuckReason(erip(11 * 24 * 60), ctx)).toBeNull();
    expect(stuckReason(erip(13 * 24 * 60), ctx)).toMatch(/refunding \(ERIP\)/);
    expect(stuckReason(order("needs_review", ago(10_000)), ctx)).toBeNull();
    expect(stuckReason(order("completed", ago(10_000)), ctx)).toBeNull();
  });
});
