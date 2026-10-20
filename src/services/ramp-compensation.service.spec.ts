import type { FindOperator, Repository } from "typeorm";

import type { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import type { TokenCommandEntity } from "../entities/token-command.entity";
import { parseAmount } from "../util/money";
import { RampCompensationService } from "./ramp-compensation.service";
import { compensationCommandId } from "./token-commands.logic";

const A = (v: string): bigint => parseAmount(v);
const INSTRUMENT = "cBYN";

function command(over: Partial<TokenCommandEntity>): TokenCommandEntity {
  return {
    instrumentId: INSTRUMENT,
    amount: A("10"),
    status: "recorded",
    lastError: null,
    resolvedBy: null,
    recordedAmount: null,
    ...over,
  } as TokenCommandEntity;
}

function record(kind: "mint" | "burn", commandId: string): TokenAppRecordEntity {
  return { kind, commandId, instrumentId: INSTRUMENT, amount: A("10") } as TokenAppRecordEntity;
}

/** Repositories over fixed rows: `findBy` on a command id, or `In([...])` of them. */
function service(commands: TokenCommandEntity[], records: TokenAppRecordEntity[]) {
  const ids = (v: unknown): string[] =>
    typeof v === "string" ? [v] : ((v as FindOperator<string[]>).value ?? []);
  const commandRepo = {
    findBy: async (where: { commandId: unknown }) =>
      commands.filter((c) => ids(where.commandId).includes(c.commandId)),
    findOneBy: async (where: { commandId: string }) =>
      commands.find((c) => c.commandId === where.commandId) ?? null,
  } as unknown as Repository<TokenCommandEntity>;
  const recordRepo = {
    findBy: async (where: { kind: string; commandId: string }) =>
      records.filter((r) => r.kind === where.kind && r.commandId === where.commandId),
  } as unknown as Repository<TokenAppRecordEntity>;
  return new RampCompensationService(commandRepo, recordRepo);
}

describe("RampCompensationService (R1-5)", () => {
  it("a compensation that itself mismatched counts at its own expected net once its compensation settled it: the original is settled", async () => {
    // X minted 10 and landed twice; comp-1 burns 10 and landed twice too; comp-1's own
    // compensation mints the 10 back. X's net (20) + comp-1 as meant (−10) = X as meant (10).
    const x = "ramp-mint-x";
    const comp1 = compensationCommandId(x);
    const compOfComp1 = compensationCommandId(comp1);
    const rows = [
      command({
        commandId: x,
        kind: "mint",
        status: "mismatch",
        lastError: "mismatch:duplicate: two records",
        resolvedBy: comp1,
      }),
      command({
        commandId: comp1,
        kind: "burn",
        status: "mismatch",
        lastError: "mismatch:duplicate: two records",
        resolvedBy: compOfComp1,
      }),
      command({ commandId: compOfComp1, kind: "mint", recordedAmount: A("10") }),
    ];
    const records = [
      record("mint", x),
      record("mint", x),
      record("burn", comp1),
      record("burn", comp1),
      record("mint", compOfComp1),
    ];
    const svc = service(rows, records);
    expect(await svc.outcome(rows[1])).toEqual({ settled: true, expectedNet: A("-10") });
    expect(await svc.outcome(rows[0])).toEqual({ settled: true, expectedNet: A("10") });
    expect((await svc.effectiveRow(x))?.status).toBe("recorded");
    // While comp-1's own compensation is in flight, X is not settled yet.
    const inFlight = service(
      [rows[0], rows[1], command({ commandId: compOfComp1, kind: "mint", status: "submitted" })],
      records.slice(0, 4),
    );
    expect(await inFlight.outcome(rows[0])).toBeNull();
  });
});
