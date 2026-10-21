import type { DataSource, EntityManager, Repository } from "typeorm";

import type { Config } from "../config";
import type { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import type { TokenCommandEntity } from "../entities/token-command.entity";
import { parseAmount } from "../util/money";
import type { RedisService } from "./redis.service";
import type { SentryService } from "./sentry.service";
import {
  TokenAppSyncService,
  TokenSyncAbortedError,
  type TokenSyncPassResult,
} from "./token-app-sync.service";
import type { TokenAppService } from "./token-app.service";

const AGENT = "agent::1220" + "c".repeat(64);
const TREASURY = "treasury::1220" + "f".repeat(64);
const HUNDRED = parseAmount("100");

/** A chainable query-builder double whose `execute` reports `affected`. */
function updateBuilder(affected: () => number, sets: unknown[]) {
  const qb = {
    update: () => qb,
    set: (v: unknown) => {
      sets.push(v);
      return qb;
    },
    where: () => qb,
    execute: () => Promise.resolve({ affected: affected() }),
  };
  return qb;
}

function build(opts: {
  rows: Partial<TokenCommandEntity>[];
  records: Partial<TokenAppRecordEntity>[];
  /** Other instruments a command row names (targets beyond the ramp's cBYN). */
  others?: string[];
  /** listRecords of these instruments rejects with the error. */
  failing?: Record<string, Error>;
}) {
  const sets: unknown[] = [];
  const row = (r: Partial<TokenCommandEntity>) =>
    ({
      kind: "mint",
      instrumentAdmin: AGENT,
      instrumentId: "cBYN",
      partyId: TREASURY,
      amount: HUNDRED,
      source: "ramp",
      ref: null,
      attempts: 1,
      lastPostAt: new Date(),
      recordedAmount: null,
      lastError: null,
      resolvedBy: null,
      ...r,
    }) as TokenCommandEntity;
  const rows = opts.rows.map(row);
  const records = opts.records.map(
    (r) =>
      ({
        kind: "mint",
        commandId: null,
        updateId: null,
        instrumentId: "cBYN",
        partyId: TREASURY,
        amount: HUNDRED,
        recordCreatedAt: new Date("2026-10-19T10:00:00Z"),
        ...r,
      }) as TokenAppRecordEntity,
  );
  const manager = {
    createQueryBuilder: () => updateBuilder(() => 1, sets),
    getRepository: () => ({
      findOneByOrFail: ({ commandId }: { commandId: string }) =>
        Promise.resolve({ ...rows.find((r) => r.commandId === commandId), status: "recorded" }),
    }),
  } as unknown as EntityManager;
  const dataSource = {
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes("SELECT DISTINCT instrument_admin")
          ? (opts.others ?? []).map((id) => ({ instrument_admin: AGENT, instrument_id: id }))
          : [],
      ),
    ),
    getRepository: () => ({ findOneBy: () => Promise.resolve({ decimals: 6 }) }),
    transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    manager,
  } as unknown as DataSource;
  const findCommands = jest.fn(({ instrumentId }: { instrumentId: string }) =>
    Promise.resolve(rows.filter((r) => r.instrumentId === instrumentId)),
  );
  const commands = {
    findBy: findCommands,
    countBy: () => Promise.resolve(0),
    createQueryBuilder: () => updateBuilder(() => 1, sets),
  } as unknown as Repository<TokenCommandEntity>;
  const mirror = {
    findBy: ({ instrumentId }: { instrumentId: string }) =>
      Promise.resolve(records.filter((r) => r.instrumentId === instrumentId)),
  } as unknown as Repository<TokenAppRecordEntity>;
  const monitor = jest.fn((_id: string) =>
    Promise.resolve({
      updatedAt: new Date(),
      token: {
        totalSupply: HUNDRED,
        totalLockedSupply: null,
        uniqueHolders: null,
        updatedAt: null,
      },
      monitor: {
        lastSuccessAt: new Date(),
        ageSeconds: 3,
        pollIntervalSeconds: 60,
        monitoringEnabled: true,
      },
    }),
  );
  const tokenApp = {
    isConfigured: () => true,
    listRecords: (kind: string, filter: { instrumentId: string }) => {
      const failure = opts.failing?.[filter.instrumentId];
      if (failure) return Promise.reject(failure);
      return Promise.resolve(
        records
          .filter((r) => r.kind === kind && r.instrumentId === filter.instrumentId)
          .map((r) => ({ ...r, createdAt: r.recordCreatedAt })),
      );
    },
    monitor,
  } as unknown as TokenAppService;
  const setJsonUnlessNewer = jest.fn(() => Promise.resolve(true));
  const redis = {
    getJson: () => Promise.resolve(null),
    setJson: () => Promise.resolve(),
    setJsonUnlessNewer,
    claimOnce: () => Promise.resolve(true),
  } as unknown as RedisService;
  const captureMessage = jest.fn();
  const captureException = jest.fn();
  const sentry = { captureMessage, captureException } as unknown as SentryService;
  const config = {
    ramp: { instrument: { admin: AGENT, id: "cBYN" } },
    collateralInstrument: { admin: "", id: "" },
  } as unknown as Config;
  const svc = new TokenAppSyncService(
    config,
    dataSource,
    commands,
    mirror,
    tokenApp,
    redis,
    sentry,
  );
  return {
    svc,
    manager,
    sets,
    captureMessage,
    captureException,
    monitor,
    setJsonUnlessNewer,
    findCommands,
  };
}

describe("TokenAppSyncService hooks (docs/RAMP.md §7, #9)", () => {
  it("calls every onRecorded hook with the pass's transaction manager, the recorded row and its record, then onPass with the result", async () => {
    const { svc, manager, sets } = build({
      rows: [{ commandId: "m1", status: "submitted" }],
      records: [{ commandId: "m1", updateId: "u1" }],
    });
    const calls: string[] = [];
    svc.onRecorded(async (m, command, record) => {
      expect(m).toBe(manager);
      calls.push(`a:${command.commandId}:${command.status}:${record.updateId}`);
      await Promise.resolve();
    }, "a");
    svc.onRecorded(async (_m, command) => {
      calls.push(`b:${command.commandId}`);
      await Promise.resolve();
    }, "b");
    const passes: TokenSyncPassResult[] = [];
    svc.onPass((r) => {
      passes.push(r);
    }, "s4");
    const result = await svc.syncOnce("test");
    expect(calls).toEqual(["a:m1:recorded:u1", "b:m1"]);
    expect(sets).toContainEqual(
      expect.objectContaining({ status: "recorded", updateId: "u1", recordedAmount: HUNDRED }),
    );
    expect(result.instruments[0]).toMatchObject({
      instrumentId: "cBYN",
      newlyRecorded: ["m1"],
      complete: true,
    });
    expect(result).toMatchObject({ complete: true, rampInstrument: { admin: AGENT, id: "cBYN" } });
    expect(passes).toEqual([result]);
  });

  it("a throwing hook rolls the record back: not newly recorded, the pass incomplete, Sentry told; a throwing pass hook never breaks the pass", async () => {
    const { svc, captureException } = build({
      rows: [{ commandId: "m1", status: "unknown" }],
      records: [{ commandId: "m1", updateId: "u1" }],
    });
    const off = svc.onRecorded(() => Promise.reject(new Error("journal down")), "s2");
    svc.onPass(() => {
      throw new Error("halt store down");
    }, "s4");
    const result = await svc.syncOnce("test");
    expect(result.instruments[0]).toMatchObject({
      newlyRecorded: [],
      complete: false,
      error: expect.stringMatching(/hook failed/) as string,
    });
    expect(result.complete).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(2);
    off();
    expect((await svc.syncOnce("test")).instruments[0].newlyRecorded).toEqual(["m1"]);
  });

  it("an unknown record and a duplicate are reported; the duplicate row becomes a mismatch and Sentry is paged", async () => {
    const { svc, sets, captureMessage } = build({
      rows: [{ commandId: "d1", status: "recorded", recordedAmount: HUNDRED }],
      records: [
        { commandId: "d1", updateId: "u1" },
        { commandId: "d1", updateId: "u2" },
        { commandId: "stray", updateId: "u3", partyId: "mallory::1220" + "9".repeat(64) },
      ],
    });
    const result = await svc.syncOnce("test");
    expect(result.unknownRecords.map((r) => r.commandId)).toEqual(["stray"]);
    expect(result.duplicates.map((c) => c.commandId)).toEqual(["d1"]);
    expect(result.instruments[0].newlyMismatched).toEqual(["d1"]);
    expect(sets).toContainEqual(
      expect.objectContaining({
        status: "mismatch",
        recordedAmount: 2n * HUNDRED,
        resolvedBy: null,
      }),
    );
    expect(captureMessage).toHaveBeenCalledWith(
      "token command mismatch: duplicate",
      "error",
      expect.objectContaining({ page: "true" }),
    );
    expect(result.tokenAppNet).toBe(3n * HUNDRED);
  });
});

describe("TokenAppSyncService: the ramp's view, the lock, the summary (C16, C42)", () => {
  it("C16: another instrument's 403 leaves the ramp's pass complete; allComplete and that line say why; only the ramp's /status is read", async () => {
    const { svc, monitor, setJsonUnlessNewer } = build({
      rows: [
        { commandId: "m1", status: "recorded", recordedAmount: HUNDRED },
        { commandId: "tro-1", instrumentId: "TRO", status: "rejected" },
      ],
      records: [{ commandId: "m1", updateId: "u1" }],
      others: ["TRO"],
      failing: { TRO: new Error("token-app failed (403)") },
    });
    const result = await svc.syncOnce("test");
    expect(result).toMatchObject({ complete: true, error: null, allComplete: false });
    expect(result.instruments.map((i) => [i.instrumentId, i.complete, i.error])).toEqual([
      ["cBYN", true, null],
      ["TRO", false, "token-app failed (403)"],
    ]);
    expect(monitor.mock.calls.map(([id]) => id)).toEqual(["cBYN"]);
    expect(setJsonUnlessNewer).toHaveBeenCalledWith(
      "token-sync:last-pass",
      expect.objectContaining({
        complete: true,
        error: null,
        allComplete: false,
        instruments: [
          { instrumentId: "cBYN", complete: true, error: null },
          { instrumentId: "TRO", complete: false, error: "token-app failed (403)" },
        ],
      }),
      "startedAt",
      expect.any(Number),
    );
  });

  it("C16: the ramp instrument's own failure is the pass's", async () => {
    const { svc } = build({
      rows: [],
      records: [],
      others: ["TRO"],
      failing: { cBYN: new Error("token-app failed (403)") },
    });
    expect(await svc.syncOnce("test")).toMatchObject({
      complete: false,
      error: "token-app failed (403)",
      allComplete: false,
    });
  });

  it("C42: a pass whose lock is lost throws before it is remembered or any pass hook runs", async () => {
    const { svc, setJsonUnlessNewer } = build({ rows: [], records: [], others: ["TRO"] });
    const passes: TokenSyncPassResult[] = [];
    svc.onPass((r) => {
      passes.push(r);
    }, "s4");
    let checks = 0;
    // Held for the first instrument, lost before the second.
    const stillHeld = () => (checks += 1) <= 1;
    await expect(svc.syncOnce("schedule", { stillHeld })).rejects.toBeInstanceOf(
      TokenSyncAbortedError,
    );
    expect(setJsonUnlessNewer).not.toHaveBeenCalled();
    expect(passes).toEqual([]);
    // Held throughout: remembered, hooks run.
    await svc.syncOnce("schedule", { stillHeld: () => true });
    expect(setJsonUnlessNewer).toHaveBeenCalledTimes(1);
    expect(passes).toHaveLength(1);
  });

  it("C42: with nothing to apply the matching's read is the views' (one load per pass); a change re-reads", async () => {
    const quiet = build({
      rows: [{ commandId: "m1", status: "recorded", recordedAmount: HUNDRED }],
      records: [{ commandId: "m1", updateId: "u1" }],
    });
    await quiet.svc.syncOnce("test");
    expect(quiet.findCommands).toHaveBeenCalledTimes(1);
    const busy = build({
      rows: [{ commandId: "m1", status: "submitted" }],
      records: [{ commandId: "m1", updateId: "u1" }],
    });
    await busy.svc.syncOnce("test");
    expect(busy.findCommands).toHaveBeenCalledTimes(2);
  });
});
