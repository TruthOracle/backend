import type { DataSource, EntityManager, Repository } from "typeorm";

import type { Config } from "../config";
import { InstrumentEntity } from "../entities/instrument.entity";
import type { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import type { TokenCommandEntity } from "../entities/token-command.entity";
import { parseAmount } from "../util/money";
import type { AuditService } from "./audit.service";
import type { RedisService } from "./redis.service";
import type { SentryService } from "./sentry.service";
import type { TokenAppSyncService } from "./token-app-sync.service";
import type { TokenAppService } from "./token-app.service";
import { capError, TokenCommandService, type TokenCommandIntent } from "./token-command.service";

const TREASURY = "treasury::1220" + "f".repeat(64);
const OTHER = "other::1220" + "a".repeat(64);
const AGENT = "agent::1220" + "c".repeat(64);
const TRO_ADMIN = "tro::1220" + "e".repeat(64);

/** A transaction manager double: instruments by id, the inserted row read back as written. */
function managerOf(): { manager: EntityManager; query: jest.Mock } {
  let inserted: unknown[] = [];
  const query = jest.fn((_sql: string, params: unknown[]) => {
    inserted = params;
    return Promise.resolve([]);
  });
  const manager = {
    query,
    getRepository: (entity: unknown) =>
      entity === InstrumentEntity
        ? {
            findOneBy: ({ id }: { id: string }) =>
              Promise.resolve(
                id === "NOPE"
                  ? null
                  : { admin: id === "cBYN" ? AGENT : TRO_ADMIN, id, symbol: id, decimals: 6 },
              ),
          }
        : {
            findOneByOrFail: () =>
              Promise.resolve({
                commandId: inserted[0],
                kind: inserted[1],
                instrumentAdmin: inserted[2],
                instrumentId: inserted[3],
                partyId: inserted[4],
                amount: parseAmount(String(inserted[5])),
                source: inserted[6],
                ref: inserted[7],
                status: "pending",
              }),
          },
  } as unknown as EntityManager;
  return { manager, query };
}

function service(isMainnet: boolean): TokenCommandService {
  return new TokenCommandService(
    { isMainnet, treasuryPartyId: TREASURY } as unknown as Config,
    {} as DataSource,
    {} as Repository<TokenCommandEntity>,
    {} as Repository<TokenAppRecordEntity>,
    {} as TokenAppService,
    {
      rampInstrument: () => Promise.resolve({ admin: AGENT, id: "cBYN" }),
    } as unknown as TokenAppSyncService,
    {} as RedisService,
    {} as AuditService,
    {} as SentryService,
  );
}

const intent = (patch: Partial<TokenCommandIntent> = {}): TokenCommandIntent => ({
  commandId: "ramp-mint-1",
  kind: "mint",
  instrument: { admin: AGENT, id: "cBYN" },
  party: TREASURY,
  amount: parseAmount("10"),
  source: "ramp",
  ref: "order-1",
  ...patch,
});

describe("TokenCommandService.recordIntent (docs/RAMP.md §7)", () => {
  it("mainnet: the ramp instrument is minted only to and burned only from the treasury — refused before any row", async () => {
    const svc = service(true);
    for (const kind of ["mint", "burn"] as const) {
      const { manager, query } = managerOf();
      await expect(svc.recordIntent(manager, intent({ kind, party: OTHER }))).rejects.toMatchObject(
        {
          status: 403,
          code: "forbidden",
          message: `on mainnet cBYN is ${kind === "mint" ? "minted only to" : "burned only from"} the treasury`,
        },
      );
      expect(query).not.toHaveBeenCalled();
    }
    const { manager, query } = managerOf();
    await expect(svc.recordIntent(manager, intent())).resolves.toMatchObject({
      status: "pending",
      partyId: TREASURY,
    });
    expect(query).toHaveBeenCalledTimes(1);
    // Another instrument is not the ramp's: any party.
    await expect(
      svc.recordIntent(
        managerOf().manager,
        intent({ instrument: { admin: TRO_ADMIN, id: "TRO" }, party: OTHER }),
      ),
    ).resolves.toMatchObject({ partyId: OTHER });
  });

  it("devnet allows any party; amounts must be positive and whole at the instrument's decimals", async () => {
    const svc = service(false);
    await expect(
      svc.recordIntent(managerOf().manager, intent({ party: OTHER })),
    ).resolves.toMatchObject({
      partyId: OTHER,
    });
    for (const amount of [0n, -parseAmount("1"), parseAmount("1.0000001")])
      await expect(svc.recordIntent(managerOf().manager, intent({ amount }))).rejects.toMatchObject(
        {
          status: 400,
          code: "validation_failed",
        },
      );
    await expect(
      svc.recordIntent(managerOf().manager, intent({ instrument: { admin: AGENT, id: "NOPE" } })),
    ).rejects.toMatchObject({ status: 404, code: "instrument_unknown" });
  });

  it("capError names the cap and the rolling figure", () => {
    expect(
      capError({
        ok: false,
        reason: "per_day",
        limit: parseAmount("5000"),
        used: parseAmount("4990"),
      }),
    ).toMatchObject({
      status: 409,
      code: "token_app_cap",
      message:
        "token-app cap TOKEN_APP_MAX_PER_DAY (5000.0000000000) would be exceeded (rolling 24 h: 4990.0000000000)",
      details: { cap: "TOKEN_APP_MAX_PER_DAY" },
    });
  });
});
