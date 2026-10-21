import type { TokenCommandStatus } from "../entities/token-command.entity";
import { parseAmount } from "../util/money";
import {
  abandonRefusals,
  adoptionSet,
  compensationCommandId,
  compensationIds,
  compensationPlan,
  compensationsSoFar,
  evaluateCaps,
  inGenerations,
  intentConflicts,
  legacyCommandId,
  matchCommands,
  MAX_COMPENSATIONS,
  mayHaveLanded,
  mismatchError,
  mismatchReasonOf,
  netOf,
  resendRefusal,
  statusAfterPost,
  type CommandRowView,
  type MirrorRecordView,
} from "./token-commands.logic";

const TREASURY = "treasury::1220" + "f".repeat(64);
const OTHER = "other::1220" + "a".repeat(64);
const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const H = 3_600_000;
const D = 24 * H;

const cmd = (
  commandId: string,
  status: TokenCommandStatus,
  patch: Partial<CommandRowView> = {},
): CommandRowView => ({
  commandId,
  kind: "mint",
  instrumentId: "cBYN",
  partyId: TREASURY,
  amount: parseAmount("100"),
  source: "ramp",
  status,
  ...patch,
});

const rec = (
  commandId: string | null,
  patch: Partial<MirrorRecordView> = {},
): MirrorRecordView => ({
  kind: "mint",
  commandId,
  updateId: `u-${commandId ?? "x"}`,
  instrumentId: "cBYN",
  partyId: TREASURY,
  amount: parseAmount("100"),
  recordCreatedAt: ago(H),
  ...patch,
});

describe("command ledger states (docs/RAMP.md §7)", () => {
  it("a definitive refusal is `rejected` only when no earlier POST may have landed", () => {
    expect(mayHaveLanded("pending", 0)).toBe(false);
    expect(mayHaveLanded("rejected", 1)).toBe(false);
    expect(mayHaveLanded("pending", 1)).toBe(true); // died during a POST
    expect(mayHaveLanded("unknown", 1)).toBe(true);
    expect(mayHaveLanded("submitted", 1)).toBe(true);

    expect(statusAfterPost("pending", 0, "accepted")).toBe("submitted");
    expect(statusAfterPost("pending", 0, "unknown")).toBe("unknown");
    expect(statusAfterPost("pending", 0, "rejected")).toBe("rejected");
    expect(statusAfterPost("pending", 0, "not_sent")).toBe("pending");
    // re-sends
    expect(statusAfterPost("rejected", 1, "accepted")).toBe("submitted");
    expect(statusAfterPost("rejected", 1, "rejected")).toBe("rejected");
    expect(statusAfterPost("unknown", 1, "rejected")).toBe("unknown"); // a 403 now says nothing of the first send
    expect(statusAfterPost("submitted", 1, "rejected")).toBe("submitted");
    expect(statusAfterPost("submitted", 1, "unknown")).toBe("submitted");
    expect(statusAfterPost("pending", 1, "rejected")).toBe("unknown");
  });

  it("the same id is reused only for the identical intent; every differing field is named", () => {
    const base = {
      kind: "mint" as const,
      instrumentAdmin: "a",
      instrumentId: "cBYN",
      partyId: TREASURY,
      amount: parseAmount("10"),
      source: "ramp" as const,
      ref: "order-1",
    };
    expect(intentConflicts(base, { ...base })).toEqual([]);
    expect(
      intentConflicts(base, { ...base, amount: parseAmount("10.000001"), ref: null, kind: "burn" }),
    ).toEqual(["kind", "amount", "ref"]);
  });

  it("caps: per call on mints and burns, rolling 24 h on mints only", () => {
    const caps = { maxPerCall: parseAmount("2000"), maxPerDay: parseAmount("5000") };
    expect(
      evaluateCaps({ kind: "mint", amount: parseAmount("2000"), usedToday: 0n, ...caps }),
    ).toEqual({ ok: true });
    expect(
      evaluateCaps({ kind: "burn", amount: parseAmount("2000.000001"), usedToday: 0n, ...caps }),
    ).toEqual({
      ok: false,
      reason: "per_call",
      limit: parseAmount("2000"),
      used: 0n,
    });
    expect(
      evaluateCaps({
        kind: "mint",
        amount: parseAmount("1000"),
        usedToday: parseAmount("4000.5"),
        ...caps,
      }),
    ).toMatchObject({ ok: false, reason: "per_day", used: parseAmount("4000.5") });
    expect(
      evaluateCaps({
        kind: "burn",
        amount: parseAmount("1000"),
        usedToday: parseAmount("4500"),
        ...caps,
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateCaps({
        kind: "mint",
        amount: parseAmount("999999"),
        usedToday: 0n,
        maxPerCall: null,
        maxPerDay: null,
      }),
    ).toEqual({ ok: true });
  });
});

describe("operator action preconditions (#8)", () => {
  const row = (status: TokenCommandStatus, lastPostAt: Date | null, createdAt = ago(10 * D)) => ({
    status,
    lastPostAt,
    createdAt,
  });

  it("resend: unresolved or rejected, no record, inside the dedup window (from the last POST, else creation)", () => {
    const ev = { now: NOW, mirrorHasRecord: false, maxAgeHours: 144 };
    for (const s of ["pending", "submitted", "unknown", "rejected"] as const)
      expect(resendRefusal(row(s, ago(H)), ev)).toBeNull();
    for (const s of ["recorded", "mismatch", "abandoned"] as const)
      expect(resendRefusal(row(s, ago(H)), ev)).toMatch(/only an unresolved or rejected/);
    expect(resendRefusal(row("unknown", ago(H)), { ...ev, mirrorHasRecord: true })).toMatch(
      /already recorded/,
    );
    expect(resendRefusal(row("unknown", ago(144 * H)), ev)).toMatch(/dedup window/);
    expect(resendRefusal(row("pending", null, ago(143 * H)), ev)).toBeNull();
    expect(resendRefusal(row("pending", null, ago(145 * H)), ev)).toMatch(/dedup window/);
  });

  it("abandon: every precondition is checked and every unmet one named", () => {
    const holdings = parseAmount("500");
    const ok = {
      now: NOW,
      mirrorHasRecord: false,
      repages: [ago(2 * 60_000), ago(4 * 60_000)],
      monitorLastSuccessAt: ago(60_000),
      indexedTreasuryHoldings: holdings,
      expectedTreasuryHoldings: holdings,
    };
    const old = row("unknown", ago(9 * D));
    expect(abandonRefusals(old, ok)).toEqual([]);
    expect(abandonRefusals(row("recorded", ago(9 * D)), ok)).toEqual([
      "the command is recorded, not unresolved",
    ]);
    expect(abandonRefusals(row("unknown", ago(7 * D)), ok)).toEqual([
      "the last POST is less than 8 days old",
    ]);
    expect(abandonRefusals(old, { ...ok, mirrorHasRecord: true })).toEqual([
      "token-app recorded this command id",
    ]);
    // re-pages: only one, two too close, or none recent enough
    for (const repages of [
      [ago(60_000)],
      [ago(60_000), ago(90_000)],
      [ago(20 * 60_000), ago(30 * 60_000)],
      [],
    ])
      expect(abandonRefusals(old, { ...ok, repages })).toEqual([
        expect.stringMatching(/no two full re-pages/) as string,
      ]);
    expect(abandonRefusals(old, { ...ok, monitorLastSuccessAt: null })).toEqual([
      expect.stringMatching(/monitor/) as string,
    ]);
    expect(
      abandonRefusals(row("unknown", ago(9 * D)), {
        ...ok,
        monitorLastSuccessAt: ago(9 * D - 30 * 60_000),
      }),
    ).toEqual([expect.stringMatching(/monitor/) as string]);
    expect(abandonRefusals(old, { ...ok, indexedTreasuryHoldings: null })).toEqual([
      "the treasury's indexed holdings are unreadable",
    ]);
    expect(abandonRefusals(old, { ...ok, indexedTreasuryHoldings: parseAmount("600") })).toEqual([
      expect.stringMatching(/holds 600\.0000000000, not the 500\.0000000000 expected/) as string,
    ]);
    expect(abandonRefusals(row("pending", null, ago(9 * D)), ok)).toEqual([]);
  });

  it("compensate restores the expected net; a definitive-no that landed expects zero; a party-only mismatch needs nothing", () => {
    const hundred = parseAmount("100");
    const m = (reason: Parameters<typeof mismatchError>[0]) => mismatchError(reason, "x");
    expect(mismatchReasonOf(m("duplicate"))).toBe("duplicate");
    expect(mismatchReasonOf("token_app_forbidden: x")).toBeNull();
    // duplicate mint: 200 landed, 100 expected → burn 100
    expect(
      compensationPlan({ kind: "mint", amount: hundred, lastError: m("duplicate") }, [
        { kind: "mint", amount: hundred },
        { kind: "mint", amount: hundred },
      ]),
    ).toEqual({
      expectedNet: hundred,
      actualNet: 2n * hundred,
      compensatedNet: 0n,
      kind: "burn",
      amount: hundred,
    });
    // amount mismatch on a burn: 60 burned, 100 expected → burn 40 more
    expect(
      compensationPlan({ kind: "burn", amount: hundred, lastError: m("amount_mismatch") }, [
        { kind: "burn", amount: parseAmount("60") },
      ]),
    ).toEqual({
      expectedNet: -hundred,
      actualNet: parseAmount("-60"),
      compensatedNet: 0n,
      kind: "burn",
      amount: parseAmount("40"),
    });
    // over-mint 150 of 100 → burn 50
    expect(
      compensationPlan({ kind: "mint", amount: hundred, lastError: m("amount_mismatch") }, [
        { kind: "mint", amount: parseAmount("150") },
      ]),
    ).toMatchObject({ kind: "burn", amount: parseAmount("50") });
    // rejected, refunded downstream, then recorded → expected 0 → burn all of it
    expect(
      compensationPlan(
        { kind: "mint", amount: hundred, lastError: m("recorded_after_definitive_no") },
        [{ kind: "mint", amount: hundred }],
      ),
    ).toEqual({
      expectedNet: 0n,
      actualNet: hundred,
      compensatedNet: 0n,
      kind: "burn",
      amount: hundred,
    });
    // right amount, wrong party: the net is right
    expect(
      compensationPlan({ kind: "mint", amount: hundred, lastError: m("party_mismatch") }, [
        { kind: "mint", amount: hundred },
      ]),
    ).toEqual({
      expectedNet: hundred,
      actualNet: hundred,
      compensatedNet: 0n,
      kind: null,
      amount: 0n,
    });
    // an approver's explicit expectation wins (the order was credited after all)
    expect(
      compensationPlan(
        { kind: "mint", amount: hundred, lastError: m("recorded_after_definitive_no") },
        [{ kind: "mint", amount: hundred }],
        hundred,
      ).kind,
    ).toBeNull();
    expect(compensationCommandId("ramp-mint-abc")).toMatch(/^comp-[0-9a-f]{40}$/);
    expect(compensationCommandId("ramp-mint-abc")).toBe(compensationCommandId("ramp-mint-abc"));
  });

  it("C21: a re-opened mismatch is compensated on top of what earlier generations recorded, each generation under its own id", () => {
    const m = (reason: Parameters<typeof mismatchError>[0]) => mismatchError(reason, "x");
    const [hundred, ninety, ten] = ["100", "90", "10"].map(parseAmount);
    // X (mint 100) landed at 90, comp gen 1 minted 10; X then landed again at 90: 180 + 10 vs 100 → burn 90.
    expect(
      compensationPlan(
        { kind: "mint", amount: hundred, lastError: m("amount_mismatch") },
        [
          { kind: "mint", amount: ninety },
          { kind: "mint", amount: ninety },
        ],
        undefined,
        ten,
      ),
    ).toEqual({
      expectedNet: hundred,
      actualNet: 2n * ninety,
      compensatedNet: ten,
      kind: "burn",
      amount: ninety,
    });
    // Generation 1 keeps the historical id; every later one is new (never the id already recorded).
    const ids = compensationIds("ramp-mint-x");
    expect(ids).toHaveLength(MAX_COMPENSATIONS);
    expect(ids[0]).toBe(compensationCommandId("ramp-mint-x"));
    expect(compensationCommandId("ramp-mint-x", 2)).toBe(ids[1]);
    expect(new Set(ids).size).toBe(MAX_COMPENSATIONS);
    const row = (
      commandId: string,
      kind: "mint" | "burn",
      status: TokenCommandStatus,
      recordedAmount: bigint | null,
    ) => ({ commandId, kind, status, recordedAmount });
    // Rows are generations 1, 2, … up to the first gap.
    expect(
      inGenerations("ramp-mint-x", [
        row(ids[2], "mint", "recorded", ten),
        row(ids[0], "mint", "recorded", ten),
      ]).map((r) => r.commandId),
    ).toEqual([ids[0]]);
    // What earlier generations recorded counts; a definitive no moved nothing.
    expect(
      compensationsSoFar([
        row(ids[0], "mint", "recorded", ten),
        row(ids[1], "burn", "recorded", ninety),
        row(ids[2], "mint", "rejected", null),
      ]),
    ).toEqual({ net: ten - ninety, unsettled: [] });
    // One still in flight, or itself mismatched, is not settled: the next generation waits for it.
    expect(
      compensationsSoFar([
        row(ids[0], "burn", "submitted", null),
        row(ids[1], "mint", "mismatch", ten),
      ]),
    ).toEqual({ net: 0n, unsettled: [ids[0], ids[1]] });
  });
});

describe("matching token-app records to command rows (docs/RAMP.md §7, I9)", () => {
  it("an unresolved row with exactly one record of its party and amount is recorded; no record leaves it alone", () => {
    const rows = [
      cmd("m1", "submitted"),
      cmd("m2", "unknown"),
      cmd("m3", "pending"),
      cmd("b1", "submitted", { kind: "burn" }),
    ];
    const records = [rec("m1"), rec("m2"), rec("b1", { kind: "burn" })];
    const r = matchCommands(rows, records);
    expect(r.toRecord.map((x) => x.command.commandId)).toEqual(["m1", "m2", "b1"]);
    expect(r.toRecord[0].record).toBe(records[0]);
    expect(r.toMismatch).toEqual([]);
    expect(r.unknownRecords).toEqual([]);
    expect(r.duplicates).toEqual([]);
  });

  it("two records of one id are a duplicate mismatch — also for a row already recorded", () => {
    const r = matchCommands(
      [cmd("m1", "recorded"), cmd("m2", "submitted")],
      [rec("m1"), rec("m1", { updateId: "u-again" }), rec("m2"), rec("m2", { updateId: "u-2b" })],
    );
    expect(r.duplicates.map((c) => c.commandId)).toEqual(["m1", "m2"]);
    expect(r.toMismatch.map((m) => [m.command.commandId, m.reason, m.records.length])).toEqual([
      ["m1", "duplicate", 2],
      ["m2", "duplicate", 2],
    ]);
    expect(r.toRecord).toEqual([]);
    // an existing mismatch whose records did not change is not re-flagged, but still listed as a duplicate
    const again = matchCommands(
      [{ ...cmd("m1", "mismatch"), recordedAmount: parseAmount("200") }],
      [rec("m1"), rec("m1", { updateId: "u-again" })],
    );
    expect(again.toMismatch).toEqual([]);
    expect(again.duplicates).toHaveLength(1);
  });

  it("C21: a resolved mismatch that gains a record is re-opened under its own reason (the extra mint is never silent)", () => {
    // X was recorded at 90 of 100 (amount_mismatch, compensated); token-app records X again.
    const resolved = {
      ...cmd("x", "mismatch"),
      recordedAmount: parseAmount("90"),
      lastError: "mismatch:amount_mismatch: record u-x: 90 to treasury",
    } as CommandRowView;
    const first = rec("x", { amount: parseAmount("90") });
    const r = matchCommands(
      [resolved],
      [first, rec("x", { updateId: "u-x2", amount: parseAmount("90") })],
    );
    expect(r.duplicates.map((c) => c.commandId)).toEqual(["x"]);
    expect(r.toMismatch.map((m) => [m.command.commandId, m.reason, m.records.length])).toEqual([
      ["x", "amount_mismatch", 2],
    ]);
    expect(r.toMismatch[0].detail).toMatch(/records changed after the mismatch.*2 records/);
    // A late landing declared never-landing keeps that reason (its expected net stays 0).
    const never = {
      ...cmd("rj", "mismatch"),
      recordedAmount: parseAmount("100"),
      lastError: "mismatch:recorded_after_definitive_no: rejected, then record u-rj",
    } as CommandRowView;
    expect(
      matchCommands([never], [rec("rj"), rec("rj", { updateId: "u-rj2" })]).toMismatch.map(
        (m) => m.reason,
      ),
    ).toEqual(["recorded_after_definitive_no"]);
    // Unchanged records (the sync already wrote their Σ) leave a mismatch alone.
    expect(matchCommands([resolved], [first]).toMismatch).toEqual([]);
  });

  it("another party, another amount, or a record after a definitive no are mismatches", () => {
    const r = matchCommands(
      [cmd("p", "submitted"), cmd("a", "unknown"), cmd("rj", "rejected"), cmd("ab", "abandoned")],
      [
        rec("p", { partyId: OTHER }),
        rec("a", { amount: parseAmount("100.000001") }),
        rec("rj"),
        rec("ab"),
      ],
    );
    expect(r.toMismatch.map((m) => [m.command.commandId, m.reason])).toEqual([
      ["p", "party_mismatch"],
      ["a", "amount_mismatch"],
      ["rj", "recorded_after_definitive_no"],
      ["ab", "recorded_after_definitive_no"],
    ]);
    expect(r.unknownRecords).toEqual([]);
  });

  it("records no row accounts for are unknown: another id, another kind, no command id; a legacy row accounts for exactly its record", () => {
    const stray = rec("attacker-mint", { partyId: OTHER, amount: parseAmount("5000") });
    const wrongKind = rec("m1", { kind: "burn" });
    const noId = rec(null);
    const adopted = rec("old-check-1", { recordCreatedAt: ago(30 * D) });
    const rows = [
      cmd("m1", "recorded"),
      cmd(legacyCommandId(adopted), "recorded", { source: "legacy" }),
    ];
    const r = matchCommands(rows, [rec("m1"), stray, wrongKind, noId, adopted]);
    expect(r.unknownRecords).toEqual([stray, wrongKind, noId]);
    expect(legacyCommandId(adopted)).toMatch(/^legacy-[0-9a-f]{40}$/);
    // a legacy id is per record identity, never the record's own command id
    expect(legacyCommandId(rec("x"))).not.toBe(legacyCommandId(rec("x", { amount: 1n })));
  });

  it("the adoption set is the unknown records created before the cutoff, never an undated one", () => {
    const old1 = rec("check-1", { recordCreatedAt: ago(30 * D) });
    const old2 = rec(null, { recordCreatedAt: ago(20 * D) });
    const recent = rec("after-cutoff", { recordCreatedAt: ago(H) });
    const undated = rec("undated", { recordCreatedAt: null });
    const ours = rec("m1", { recordCreatedAt: ago(40 * D) });
    expect(
      adoptionSet([cmd("m1", "recorded")], [old1, old2, recent, undated, ours], ago(10 * D)),
    ).toEqual([old1, old2]);
    expect(netOf([rec("a"), rec("b", { kind: "burn", amount: parseAmount("40") })])).toBe(
      parseAmount("60"),
    );
  });
});
