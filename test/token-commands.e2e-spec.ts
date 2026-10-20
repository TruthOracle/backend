/**
 * The token-app command ledger and sync end to end (docs/RAMP.md §3.4, §7): write-ahead rows in
 * the caller's transaction, one POST per command, the paged mirror and its matching (recorded /
 * mismatch / duplicate / unknown records), the hooks, caps and the four operator actions with
 * their preconditions. Real Postgres + Redis; token-app is FakeTokenApp. The ramp instrument is
 * the test env's default collateral (Canton Coin, 10 decimals).
 */
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { TokenCommandEntity } from "../src/entities/token-command.entity";
import { AuditService } from "../src/services/audit.service";
import { RampCompensationService } from "../src/services/ramp-compensation.service";
import { SentryService } from "../src/services/sentry.service";
import { compensationCommandId } from "../src/services/token-commands.logic";
import {
  TokenAppSyncService,
  type TokenSyncPassResult,
} from "../src/services/token-app-sync.service";
import type { TokenAppParsedRecord, TokenAppPostOutcome } from "../src/services/token-app.service";
import {
  TokenCommandService,
  type TokenCommandIntent,
} from "../src/services/token-command.service";
import type { Actor } from "../src/types";
import { parseAmount } from "../src/util/money";
import {
  TEST_COLLATERAL,
  TEST_REWARDS,
  TEST_TREASURY,
  useTestApp,
  type TestApp,
} from "./helpers/app";

const MALLORY = "mallory::1220" + "9".repeat(64);
const ADMIN: Actor = { type: "admin", userId: null };
const HUNDRED = parseAmount("100");

const LOST: TokenAppPostOutcome = {
  outcome: "unknown",
  httpStatus: 504,
  status: null,
  code: "upstream_failed",
  message: "gateway timeout",
};
const FORBIDDEN: TokenAppPostOutcome = {
  outcome: "rejected",
  httpStatus: 403,
  status: null,
  code: "token_app_forbidden",
  message: "missing role",
};

function harness(ctx: TestApp) {
  const commands = (): TokenCommandService => ctx.get(TokenCommandService);
  const sync = (): TokenAppSyncService => ctx.get(TokenAppSyncService);
  const intent = (
    commandId: string,
    patch: Partial<TokenCommandIntent> = {},
  ): Promise<TokenCommandEntity> =>
    ctx.dataSource.transaction((m) =>
      commands().recordIntent(m, {
        commandId,
        kind: "mint",
        instrument: TEST_COLLATERAL,
        party: TEST_TREASURY,
        amount: HUNDRED,
        source: "ramp",
        ref: `order-${commandId}`,
        ...patch,
      }),
    );
  const row = (commandId: string): Promise<TokenCommandEntity> =>
    ctx.dataSource.getRepository(TokenCommandEntity).findOneByOrFail({ commandId });
  const record = (patch: Partial<TokenAppParsedRecord>): TokenAppParsedRecord => ({
    kind: "mint",
    commandId: null,
    updateId: null,
    partyId: TEST_TREASURY,
    instrumentId: TEST_COLLATERAL.id,
    amount: HUNDRED,
    createdAt: new Date(),
    ...patch,
  });
  return { commands, sync, intent, row, record };
}

describe("token command ledger (docs/RAMP.md §7)", () => {
  const ctx = useTestApp();
  const { commands, sync, intent, row } = harness(ctx);

  it("recordIntent writes the row pending inside the caller's transaction: a rollback leaves nothing, the identical intent is reused, another is a conflict", async () => {
    await expect(
      ctx.dataSource.transaction(async (m) => {
        await commands().recordIntent(m, {
          commandId: "rolled-back",
          kind: "mint",
          instrument: TEST_COLLATERAL,
          party: TEST_TREASURY,
          amount: HUNDRED,
          source: "ramp",
        });
        throw new Error("order CAS lost");
      }),
    ).rejects.toThrow("order CAS lost");
    expect(
      await ctx.dataSource.getRepository(TokenCommandEntity).countBy({ commandId: "rolled-back" }),
    ).toBe(0);

    const first = await intent("ramp-mint-1");
    expect(first).toMatchObject({
      status: "pending",
      attempts: 0,
      lastPostAt: null,
      kind: "mint",
      instrumentAdmin: TEST_COLLATERAL.admin,
      instrumentId: TEST_COLLATERAL.id,
      partyId: TEST_TREASURY,
      amount: HUNDRED,
      source: "ramp",
      ref: "order-ramp-mint-1",
    });
    expect((await intent("ramp-mint-1")).createdAt).toEqual(first.createdAt);
    await expect(intent("ramp-mint-1", { amount: parseAmount("101") })).rejects.toMatchObject({
      status: 409,
      code: "token_command_conflict",
      details: { fields: ["amount"] },
    });
    await expect(intent("ramp-mint-1", { kind: "burn", ref: null })).rejects.toMatchObject({
      details: { fields: ["kind", "ref"] },
    });
    // TRO carries 6 decimals: 1e-10 is finer; an unregistered instrument is refused.
    await expect(intent("fine", { instrument: TEST_REWARDS, amount: 1n })).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
    });
    await expect(
      intent("nope", { instrument: { admin: TEST_COLLATERAL.admin, id: "NOPE" } }),
    ).rejects.toMatchObject({ status: 404, code: "instrument_unknown" });
    expect(ctx.tokenApp.minted).toEqual([]);
  });

  it("submit POSTs once; the sync records the command and runs the onRecorded hooks in its transaction — a failing hook rolls the record back until a later pass", async () => {
    await intent("m-ok");
    const sent = await commands().submit("m-ok");
    expect(sent).toMatchObject({
      status: "submitted",
      attempts: 1,
      lastHttpStatus: 200,
      lastError: null,
    });
    expect(sent.lastPostAt).toBeInstanceOf(Date);
    expect(ctx.tokenApp.minted).toEqual([
      {
        commandId: "m-ok",
        instrumentId: "Amulet",
        partyId: TEST_TREASURY,
        amount: HUNDRED,
        decimals: 10,
      },
    ]);
    // Nothing re-sends on its own: a second submit is a no-op.
    expect((await commands().submit("m-ok")).attempts).toBe(1);
    expect(ctx.tokenApp.minted).toHaveLength(1);

    let fail = true;
    const seen: string[] = [];
    const off = sync().onRecorded(async (manager, command, rec) => {
      const inTx = await manager
        .getRepository(TokenCommandEntity)
        .findOneByOrFail({ commandId: command.commandId });
      seen.push(`${command.commandId}:${inTx.status}:${rec.updateId}`);
      await ctx.get(AuditService).record(
        {
          actorType: "system",
          action: "token.mint",
          subjectType: "hook-test",
          subjectId: command.commandId,
        },
        manager,
      );
      if (fail) throw new Error("journal unavailable");
    }, "test");
    const hookRows = (): Promise<number> =>
      ctx.dataSource.getRepository(AuditEventEntity).countBy({ subjectType: "hook-test" });
    try {
      const first = await sync().syncOnce("test");
      expect(first.complete).toBe(false);
      expect(first.instruments[0]).toMatchObject({ instrumentId: "Amulet", newlyRecorded: [] });
      expect((await row("m-ok")).status).toBe("submitted");
      expect(await hookRows()).toBe(0);

      fail = false;
      const second = await sync().syncOnce("test");
      expect(second).toMatchObject({
        complete: true,
        error: null,
        rampInstrument: TEST_COLLATERAL,
        unknownRecords: [],
        mismatches: [],
        duplicates: [],
        unresolved: [],
        ourNet: HUNDRED,
        tokenAppNet: HUNDRED,
        statusTotalSupply: HUNDRED,
      });
      expect(second.instruments[0].newlyRecorded).toEqual(["m-ok"]);
      expect(await row("m-ok")).toMatchObject({
        status: "recorded",
        updateId: "update-m-ok",
        recordedAmount: HUNDRED,
      });
      expect(seen).toEqual(["m-ok:recorded:update-m-ok", "m-ok:recorded:update-m-ok"]);
      expect(await hookRows()).toBe(1);
      await sync().syncOnce("test");
      expect(seen).toHaveLength(2);
    } finally {
      off();
    }
  });

  it("outcomes: a lost answer is unknown (recorded later if it landed), a 403 is rejected, nothing-sent stays a safe first send", async () => {
    await intent("m-lost");
    ctx.tokenApp.nextPost = { outcome: LOST, lands: true };
    expect(await commands().submit("m-lost")).toMatchObject({
      status: "unknown",
      attempts: 1,
      lastHttpStatus: 504,
      lastError: expect.stringMatching(/^upstream_failed: gateway timeout/) as string,
    });
    await intent("m-403");
    ctx.tokenApp.nextPost = { outcome: FORBIDDEN, lands: false };
    expect(await commands().submit("m-403")).toMatchObject({
      status: "rejected",
      lastHttpStatus: 403,
      lastError: expect.stringMatching(/^token_app_forbidden/) as string,
    });
    await intent("m-later");
    ctx.tokenApp.configured = false;
    expect(await commands().submit("m-later")).toMatchObject({
      status: "pending",
      attempts: 0,
      lastPostAt: null,
      lastError: expect.stringMatching(/^token_app_unconfigured/) as string,
    });
    ctx.tokenApp.configured = true;
    expect(await commands().submit("m-later")).toMatchObject({ status: "submitted", attempts: 1 });

    const pass = await sync().syncOnce("test");
    expect(pass.complete).toBe(true);
    expect((await row("m-lost")).status).toBe("recorded");
    expect((await row("m-403")).status).toBe("rejected");
    expect((await row("m-later")).status).toBe("recorded");
    expect(pass.unresolved).toEqual([]);
    expect(await commands().status("nope")).toBeNull();
  });
});

describe("token sync integrity and operator actions (docs/RAMP.md §7, I9, #8, #14)", () => {
  const ctx = useTestApp();
  const { commands, sync, intent, row, record } = harness(ctx);

  it("unknown records, duplicates and mismatches reach the onPass hooks; an unreadable token-app is an incomplete pass", async () => {
    const passes: TokenSyncPassResult[] = [];
    const off = sync().onPass((r) => {
      passes.push(r);
    }, "test");
    try {
      await intent("d1");
      await commands().submit("d1");
      ctx.tokenApp.extraRecords.push(record({ commandId: "d1", updateId: "update-d1-again" }));
      await intent("a1");
      ctx.tokenApp.nextPost = {
        outcome: {
          outcome: "accepted",
          httpStatus: 200,
          status: "submitted",
          code: null,
          message: null,
        },
        lands: false,
      };
      await commands().submit("a1");
      ctx.tokenApp.extraRecords.push(
        record({ commandId: "a1", updateId: "u-a1", amount: parseAmount("99") }),
      );
      ctx.tokenApp.extraRecords.push(
        record({
          commandId: "attacker",
          updateId: "u-x",
          partyId: MALLORY,
          amount: parseAmount("5000"),
        }),
      );
      // A record with neither id is stored once, however often it is re-read (#14).
      ctx.tokenApp.extraRecords.push(record({ amount: parseAmount("1") }));

      const res = await sync().syncOnce("test");
      await sync().syncOnce("test");
      expect(res.complete).toBe(true);
      expect(res.unknownRecords.map((r) => [r.commandId, r.partyId, r.amount])).toEqual(
        expect.arrayContaining([
          ["attacker", MALLORY, parseAmount("5000")],
          [null, TEST_TREASURY, parseAmount("1")],
        ]),
      );
      expect(res.unknownRecords).toHaveLength(2);
      expect(res.duplicates.map((c) => c.commandId)).toEqual(["d1"]);
      expect(res.mismatches.map((c) => c.commandId).sort()).toEqual(["a1", "d1"]);
      expect((await row("d1")).lastError).toMatch(
        /^mismatch:duplicate: token-app recorded it 2 times/,
      );
      expect(await row("a1")).toMatchObject({
        status: "mismatch",
        recordedAmount: parseAmount("99"),
        lastError: expect.stringMatching(/^mismatch:amount_mismatch/) as string,
      });
      // ours = what landed under our ids (200 + 99); token-app's = everything it recorded
      expect(res.ourNet).toBe(parseAmount("299"));
      expect(res.tokenAppNet).toBe(parseAmount("5300"));
      expect(passes[0]).toBe(res);
      expect(await sync().lastPassSummary()).toMatchObject({
        complete: true,
        unknownRecords: 2,
        mismatches: 2,
        unresolvedMismatches: 2,
        duplicates: 1,
        ourNet: "299.0000000000",
      });
      expect(
        await ctx.dataSource.query(
          `SELECT count(*)::int AS n FROM to_token_app_records WHERE command_id IS NULL`,
        ),
      ).toEqual([{ n: 1 }]);

      ctx.tokenApp.failNext = new Error("token-app down");
      const down = await sync().syncOnce("test");
      expect(down.complete).toBe(false);
      expect(down.error).toMatch(/token-app down/);
      expect(down.unknownRecords).toHaveLength(2);
      expect(passes).toHaveLength(3);
    } finally {
      off();
    }
  });

  it("compensate: a new command restores the expected net, the mismatch keeps its status with resolved_by", async () => {
    await intent("dup");
    await commands().submit("dup");
    ctx.tokenApp.extraRecords.push(record({ commandId: "dup", updateId: "update-dup-again" }));
    await sync().syncOnce("test");
    await expect(commands().compensate("nope", { actor: ADMIN })).rejects.toMatchObject({
      status: 404,
    });
    const { original, compensation } = await commands().compensate("dup", {
      actor: ADMIN,
      approvalId: "appr-comp",
    });
    expect(compensation).toMatchObject({
      kind: "burn",
      partyId: TEST_TREASURY,
      amount: HUNDRED,
      source: "ramp",
      ref: "order-dup",
      status: "submitted",
    });
    expect(compensation?.commandId).toMatch(/^comp-[0-9a-f]{40}$/);
    expect(original).toMatchObject({ status: "mismatch", resolvedBy: compensation?.commandId });
    await expect(commands().compensate("dup", { actor: ADMIN })).rejects.toMatchObject({
      code: "token_command_state",
    });
    const after = await sync().syncOnce("test");
    expect((await row(compensation?.commandId ?? "")).status).toBe("recorded");
    expect(after.ourNet).toBe(HUNDRED);
    expect(after.tokenAppNet).toBe(HUNDRED);
    expect(after.mismatches.map((m) => [m.commandId, m.resolvedBy])).toEqual([
      ["dup", compensation?.commandId],
    ]);
    expect(
      await ctx.dataSource
        .getRepository(AuditEventEntity)
        .countBy({ action: "token.command.compensated" }),
    ).toBe(1);
    // A command that was never a mismatch has nothing to compensate.
    await expect(
      commands().compensate(compensation?.commandId ?? "", { actor: ADMIN }),
    ).rejects.toMatchObject({
      code: "token_command_state",
    });
  });

  it("C21: a record landing under an already-compensated mismatch re-opens it (paged, S counts it); the next compensation is a new generation on top of the first", async () => {
    await intent("x21");
    await commands().submit("x21");
    ctx.tokenApp.extraRecords.push(record({ commandId: "x21", updateId: "update-x21-2" }));
    await sync().syncOnce("test");
    const first = await commands().compensate("x21", { actor: ADMIN });
    expect(first.compensation).toMatchObject({
      commandId: compensationCommandId("x21"),
      kind: "burn",
      amount: HUNDRED,
    });
    await sync().syncOnce("test");
    expect(await row("x21")).toMatchObject({
      status: "mismatch",
      resolvedBy: first.compensation?.commandId,
    });
    // token-app records X a third time: never silent — re-opened, its Σ refreshed, paged.
    const paged = jest.spyOn(ctx.get(SentryService), "captureMessage");
    ctx.tokenApp.extraRecords.push(record({ commandId: "x21", updateId: "update-x21-3" }));
    const pass = await sync().syncOnce("test");
    expect(
      pass.instruments.find((i) => i.instrumentId === TEST_COLLATERAL.id)?.newlyMismatched,
    ).toEqual(["x21"]);
    expect(await row("x21")).toMatchObject({
      status: "mismatch",
      resolvedBy: null,
      recordedAmount: 3n * HUNDRED,
      lastError: expect.stringMatching(/^mismatch:duplicate: records changed/) as string,
    });
    expect(paged).toHaveBeenCalledWith("token command mismatch: duplicate", "error", {
      component: "token-sync",
      commandId: "x21",
      page: "true",
    });
    paged.mockRestore();
    // The reserve's S is the ledger's net (300 − 100), not the Σ frozen when it was first flagged.
    expect(await commands().recordedNet(TEST_COLLATERAL, { sources: ["ramp"] })).toBe(2n * HUNDRED);
    expect(pass.ourNet).toBe(pass.tokenAppNet);
    // Generation 2 burns only what generation 1 did not: 300 − 100 − 100 = the expected 100.
    const second = await commands().compensate("x21", { actor: ADMIN });
    expect(second.compensation).toMatchObject({
      commandId: compensationCommandId("x21", 2),
      kind: "burn",
      amount: HUNDRED,
      status: "submitted",
    });
    expect(second.compensation?.commandId).not.toBe(first.compensation?.commandId);
    const settled = await sync().syncOnce("test");
    expect(await row(second.compensation?.commandId ?? "")).toMatchObject({ status: "recorded" });
    expect([settled.ourNet, settled.tokenAppNet]).toEqual([HUNDRED, HUNDRED]);
    expect(await ctx.get(RampCompensationService).outcome(await row("x21"))).toEqual({
      settled: true,
      expectedNet: HUNDRED,
    });
  });

  it("resend re-POSTs the same id inside the dedup window; abandon needs every precondition; a landing after abandon is a mismatch", async () => {
    await intent("r1");
    ctx.tokenApp.nextPost = { outcome: LOST, lands: false };
    expect((await commands().submit("r1")).status).toBe("unknown");
    const resent = await commands().resend("r1", {
      actor: ADMIN,
      approvalId: "appr-1",
      reason: "lost answer",
    });
    expect(resent).toMatchObject({ status: "submitted", attempts: 2, lastError: null });
    expect(ctx.tokenApp.minted.map((m) => m.commandId)).toEqual(["r1"]);
    await sync().syncOnce("test");
    await expect(commands().resend("r1", { actor: ADMIN })).rejects.toMatchObject({
      code: "token_command_state",
    });

    await intent("r2");
    ctx.tokenApp.nextPost = { outcome: LOST, lands: false };
    await commands().submit("r2");
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET last_post_at = now() - interval '145 hours' WHERE command_id = 'r2'`,
    );
    await expect(commands().resend("r2", { actor: ADMIN })).rejects.toThrow(/dedup window/);
    await expect(
      commands().abandon("r2", { expectedTreasuryHoldings: 0n }, { actor: ADMIN }),
    ).rejects.toThrow(/less than 8 days old/);
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET last_post_at = now() - interval '9 days' WHERE command_id = 'r2'`,
    );
    ctx.tokenApp.monitorLastSuccessAt = new Date();
    // One fresh re-page is not enough: two, ≥ 60 s apart.
    await sync().recordRepage("Amulet", new Date(Date.now() - 30_000));
    await expect(
      commands().abandon("r2", { expectedTreasuryHoldings: 0n }, { actor: ADMIN }),
    ).rejects.toThrow(/no two full re-pages/);
    await sync().recordRepage("Amulet", new Date(Date.now() - 3 * 60_000));
    await expect(
      commands().abandon("r2", { expectedTreasuryHoldings: HUNDRED }, { actor: ADMIN }),
    ).rejects.toThrow(/the treasury holds 0\.0000000000, not the 100\.0000000000 expected/);
    const abandoned = await commands().abandon(
      "r2",
      { expectedTreasuryHoldings: 0n },
      { actor: ADMIN, approvalId: "appr-2" },
    );
    expect(abandoned).toMatchObject({
      status: "abandoned",
      resolvedBy: null,
      lastError: "abandoned (approval appr-2) after 1 POST(s); never recorded",
    });
    expect(
      (
        await ctx.dataSource
          .getRepository(AuditEventEntity)
          .find({ where: { subjectType: "token_command" } })
      )
        .map((a) => [a.action, a.subjectId])
        .sort(),
    ).toEqual([
      ["token.command.abandoned", "r2"],
      ["token.command.resent", "r1"],
    ]);

    ctx.tokenApp.extraRecords.push(record({ commandId: "r2", updateId: "u-r2-late" }));
    await sync().syncOnce("test");
    expect(await row("r2")).toMatchObject({
      status: "mismatch",
      lastError: expect.stringMatching(/^mismatch:recorded_after_definitive_no/) as string,
    });
    // ...whose compensation burns all of it: downstream treated it as never landed.
    const { compensation } = await commands().compensate("r2", {
      actor: ADMIN,
      approvalId: "appr-3",
    });
    expect(compensation).toMatchObject({ kind: "burn", amount: HUNDRED });
  });

  it("adopt writes legacy rows for records older than this database's first own command; the unknown set empties", async () => {
    const cutoff = new Date("2026-10-02T00:00:00Z");
    ctx.tokenApp.extraRecords.push(
      record({
        commandId: "tokenapp-check-mint-1",
        updateId: "u-old-1",
        amount: parseAmount("0.01"),
        createdAt: new Date("2026-10-01T10:00:00Z"),
      }),
      record({
        kind: "burn",
        commandId: "tokenapp-check-burn-1",
        updateId: "u-old-2",
        amount: parseAmount("0.01"),
        createdAt: new Date("2026-10-01T10:05:00Z"),
      }),
    );
    await intent("first-own");
    await commands().submit("first-own");
    expect((await sync().syncOnce("test")).unknownRecords).toHaveLength(2);

    await expect(commands().planAdoption(new Date(Date.now() + 60_000))).rejects.toMatchObject({
      code: "validation_failed",
    });
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET created_at = now() - interval '1 hour' WHERE command_id = 'first-own'`,
    );
    const firstAt = (await row("first-own")).createdAt;
    await expect(commands().planAdoption(new Date(firstAt.getTime() + 60_000))).rejects.toThrow(
      /first own command/,
    );
    const plan = await commands().planAdoption(cutoff);
    expect(plan.records.map((r) => r.commandId)).toEqual([
      "tokenapp-check-mint-1",
      "tokenapp-check-burn-1",
    ]);
    expect(plan.net).toBe(0n);
    await expect(
      commands().adoptLegacy({ before: cutoff, digest: "0".repeat(64) }, { actor: ADMIN }),
    ).rejects.toMatchObject({ code: "token_command_state" });
    const { adopted } = await commands().adoptLegacy(
      { before: cutoff, digest: plan.digest },
      { actor: ADMIN, approvalId: "appr-9" },
    );
    expect(adopted.map((a) => [a.source, a.status, a.ref, a.instrumentAdmin]).sort()).toEqual([
      ["legacy", "recorded", "adopted:appr-9", TEST_COLLATERAL.admin],
      ["legacy", "recorded", "adopted:appr-9", TEST_COLLATERAL.admin],
    ]);
    const after = await sync().syncOnce("test");
    expect(after.unknownRecords).toEqual([]);
    expect(after.ourNet).toBe(HUNDRED);
    expect(after.tokenAppNet).toBe(HUNDRED);
    expect((await commands().planAdoption(cutoff)).records).toEqual([]);
  });
});

describe("token-app caps (TOKEN_APP_MAX_PER_CALL / _PER_DAY)", () => {
  const ctx = useTestApp({
    env: { TOKEN_APP_MAX_PER_CALL: "1000", TOKEN_APP_MAX_PER_DAY: "1500" },
  });
  const { commands, intent } = harness(ctx);

  it("per call on mints and burns, rolling 24 h on mints; a cap that trips at submit rejects a first send", async () => {
    expect(await commands().checkCaps("mint", TEST_COLLATERAL, parseAmount("1000"))).toEqual({
      ok: true,
    });
    expect(
      await commands().checkCaps("burn", TEST_COLLATERAL, parseAmount("1000.5")),
    ).toMatchObject({
      ok: false,
      reason: "per_call",
    });
    await intent("c1", { amount: parseAmount("900") });
    expect((await commands().submit("c1")).status).toBe("submitted");
    expect(await commands().checkCaps("mint", TEST_COLLATERAL, parseAmount("700"))).toMatchObject({
      ok: false,
      reason: "per_day",
      used: parseAmount("900"),
    });
    // the command itself is never counted twice; burns are not in the daily sum
    expect(
      await commands().checkCaps("mint", TEST_COLLATERAL, parseAmount("900"), {
        excludeCommandId: "c1",
      }),
    ).toEqual({ ok: true });
    await intent("c2", { amount: parseAmount("700") });
    expect(await commands().submit("c2")).toMatchObject({
      status: "rejected",
      attempts: 0,
      lastError: expect.stringMatching(
        /^token_app_cap: token-app cap TOKEN_APP_MAX_PER_DAY/,
      ) as string,
    });
    await intent("c3", { kind: "burn", amount: parseAmount("1000") });
    expect((await commands().submit("c3")).status).toBe("submitted");
    // a rejected command no longer counts
    expect(await commands().checkCaps("mint", TEST_COLLATERAL, parseAmount("600"))).toEqual({
      ok: true,
    });
    await expect(
      commands().requireCaps("mint", TEST_COLLATERAL, parseAmount("601")),
    ).rejects.toMatchObject({
      status: 409,
      code: "token_app_cap",
    });
    expect(ctx.tokenApp.minted.map((m) => m.commandId)).toEqual(["c1"]);
    expect(ctx.tokenApp.burned.map((m) => m.commandId)).toEqual(["c3"]);
  });
});

describe("token sync lock and summary on Redis (C42)", () => {
  const ctx = useTestApp();

  it("a lock renews only while its holder owns it; a pass never overwrites a newer pass's summary", async () => {
    const redis = ctx.redis;
    const pttl = (): Promise<number> => redis.client.pttl(redis.key("lock:c42"));
    const a = await redis.acquireLock("lock:c42", 1000);
    expect(a.acquired).toBe(true);
    expect(await a.renew(60_000)).toBe(true);
    expect(await pttl()).toBeGreaterThan(30_000);
    // The TTL handed the key to another holder: the old one's renewal must not extend it.
    await redis.del("lock:c42");
    const b = await redis.acquireLock("lock:c42", 1000);
    expect(b.acquired).toBe(true);
    expect(await a.renew(60_000)).toBe(false);
    expect(await pttl()).toBeLessThanOrEqual(1000);
    const loser = await redis.acquireLock("lock:c42", 1000);
    expect(loser.acquired).toBe(false);
    expect(await loser.renew(60_000)).toBe(false);
    await b.release();

    const sync = ctx.get(TokenAppSyncService);
    const pass = await sync.syncOnce("test");
    const stored = await sync.lastPassSummary();
    expect(stored).toMatchObject({ startedAt: pass.startedAt.toISOString(), allComplete: true });
    // A slower pass that started a second earlier finishes now: it must not replace the newer one.
    const older = new Date(pass.startedAt.getTime() - 1000).toISOString();
    expect(
      await redis.setJsonUnlessNewer(
        "token-sync:last-pass",
        { ...stored, startedAt: older, complete: true, unknownRecords: 0 },
        "startedAt",
        60_000,
      ),
    ).toBe(false);
    expect((await sync.lastPassSummary())?.startedAt).toBe(pass.startedAt.toISOString());
    const later = await sync.syncOnce("test");
    expect((await sync.lastPassSummary())?.startedAt).toBe(later.startedAt.toISOString());
  });
});
