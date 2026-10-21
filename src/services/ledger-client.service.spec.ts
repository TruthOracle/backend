import type { Config } from "../config";
import type { InstrumentId } from "../types";
import { ApiError } from "../util/errors";
import type { KeycloakTokenService } from "./keycloak-token.service";
import {
  type ActiveContract,
  LedgerClientService,
  parseCreditRefs,
  parseInstrumentId,
  userWalletCreateCommand,
  walletCreateCommandIdFor,
} from "./ledger-client.service";
import type { RedisService } from "./redis.service";
import type { SentryService } from "./sentry.service";

const TREASURY = "treasury::1220" + "f".repeat(64);
const OWNER = "alice::1220" + "a".repeat(64);
const DSO = "DSO::1220" + "d".repeat(64);
const CC: InstrumentId = { admin: DSO, id: "Amulet" };
const TRO: InstrumentId = { admin: "tro::1220" + "e".repeat(64), id: "TRO" };
const REGULATOR = "regulator::1220" + "9".repeat(64);

function build(rows: ActiveContract[]): {
  service: LedgerClientService;
  sentry: { captureMessage: jest.Mock };
} {
  const config = {
    treasuryPartyId: TREASURY,
    truthoraclePackageId: "pkg",
    truthoraclePackageName: "truthoracle-v17",
    ledgerApiUrl: "http://ledger",
    isMainnet: false,
    ledgerCacheMs: 0,
  } as unknown as Config;
  const sentry = { captureMessage: jest.fn(), captureException: jest.fn() };
  const service = new LedgerClientService(
    config,
    {} as KeycloakTokenService,
    {} as RedisService,
    sentry as unknown as SentryService,
  );
  jest.spyOn(service, "activeContracts").mockResolvedValue(rows);
  return { service, sentry };
}

const walletRow = (
  contractId: string,
  owner: string,
  deposited = "1.0000000000",
  creditRefs: unknown = [],
  instrument: unknown = CC,
): ActiveContract => ({
  contractId,
  payload: {
    admin: TREASURY,
    owner,
    instrument,
    balance: deposited,
    deposited,
    withdrawn: "0.0000000000",
    creditRefs,
    auditObservers: [REGULATOR],
  },
});

describe("LedgerClientService.fetchUserWallet", () => {
  it("returns the owner's wallet in the instrument (with its creditRefs and observers), or null when none exists", async () => {
    const { service } = build([
      walletRow("uw-1", OWNER, "1.0000000000", ["reconcile:deposit-1"]),
      walletRow("uw-2", "other::1220" + "b".repeat(64)),
    ]);
    await expect(service.fetchUserWallet(OWNER, CC)).resolves.toMatchObject({
      contractId: "uw-1",
      owner: OWNER,
      instrument: CC,
      deposited: 10_000_000_000n,
      creditRefs: ["reconcile:deposit-1"],
      auditObservers: [REGULATOR],
    });
    await expect(service.fetchUserWallet("nobody::1220" + "c".repeat(64), CC)).resolves.toBeNull();
  });

  it("a party holds one wallet per instrument: the TRO wallet is not the Canton Coin wallet", async () => {
    const { service } = build([
      walletRow("uw-cc", OWNER, "1.0000000000", [], CC),
      walletRow("uw-tro", OWNER, "5.0000000000", ["reward:g1"], TRO),
    ]);
    await expect(service.fetchUserWallet(OWNER, CC)).resolves.toMatchObject({
      contractId: "uw-cc",
      instrument: CC,
    });
    await expect(service.fetchUserWallet(OWNER, TRO)).resolves.toMatchObject({
      contractId: "uw-tro",
      instrument: TRO,
      creditRefs: ["reward:g1"],
    });
    await expect(service.fetchUserWallets(OWNER)).resolves.toHaveLength(2);
  });

  it("refuses to pick 'the first one' when an owner has two active UserWallets in one instrument: 409 deposit_attribution_drift + Sentry", async () => {
    const { service, sentry } = build([
      walletRow("uw-1", OWNER),
      walletRow("uw-2", OWNER, "3.0000000000"),
    ]);
    await expect(service.fetchUserWallet(OWNER, CC)).rejects.toMatchObject({
      status: 409,
      code: "deposit_attribution_drift",
      details: { kind: "duplicate_user_wallet", instrument: CC, contractIds: ["uw-1", "uw-2"] },
    });
    await service
      .fetchUserWallet(OWNER, CC)
      .catch((e: ApiError) => expect(e).toBeInstanceOf(ApiError));
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      "duplicate UserWallet contracts for one owner and instrument",
      "error",
      { owner: OWNER, instrument: "Amulet", count: "2" },
    );
  });

  it("a UserWallet without creditRefs or without an instrument (wrong package deployed) is a 502 upstream_failed, never an empty list", async () => {
    const missingRefs = build([
      {
        contractId: "uw-1",
        payload: {
          admin: TREASURY,
          owner: OWNER,
          instrument: CC,
          balance: "1.0000000000",
          deposited: "1.0000000000",
          withdrawn: "0.0000000000",
        },
      },
    ]);
    await expect(missingRefs.service.fetchUserWallet(OWNER, CC)).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
      details: { contractId: "uw-1" },
    });
    await expect(missingRefs.service.fetchAllUserWallets()).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
    });
    const optional = build([walletRow("uw-1", OWNER, "1.0000000000", null)]);
    await expect(optional.service.fetchUserWallet(OWNER, CC)).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
    });
    const noInstrument = build([
      {
        contractId: "uw-1",
        payload: {
          admin: TREASURY,
          owner: OWNER,
          balance: "1.0000000000",
          deposited: "1.0000000000",
          withdrawn: "0.0000000000",
          creditRefs: [],
        },
      },
    ]);
    await expect(noInstrument.service.fetchUserWallet(OWNER, CC)).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
    });
    const halfInstrument = build([walletRow("uw-1", OWNER, "1.0000000000", [], { id: "Amulet" })]);
    await expect(halfInstrument.service.fetchUserWallet(OWNER, CC)).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
    });
  });
});

describe("LedgerClientService.fetchPendingPayouts", () => {
  it("reads the payout's instrument and amount, and fails closed without the instrument", async () => {
    const payout = {
      contractId: "pp-1",
      payload: {
        admin: TREASURY,
        user: OWNER,
        marketId: "0",
        instrument: CC,
        amount: "2.5000000000",
        reason: "withdraw",
        createdAt: "1700000000",
        auditObservers: [],
      },
    };
    const { service } = build([payout]);
    await expect(service.fetchPendingPayouts()).resolves.toEqual([
      expect.objectContaining({
        contractId: "pp-1",
        user: OWNER,
        instrument: CC,
        amount: 25_000_000_000n,
        reason: "withdraw",
      }),
    ]);
    const legacy = build([
      {
        contractId: "pp-2",
        payload: {
          admin: TREASURY,
          user: OWNER,
          marketId: "0",
          amount: "1.0000000000",
          reason: "withdraw",
        },
      },
    ]);
    await expect(legacy.service.fetchPendingPayouts()).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
    });
  });
});

describe("contracts the treasury only observes (review R3-01)", () => {
  const MALLORY = "mallory::1220" + "b".repeat(64);
  const payoutRow = (contractId: string, admin: string, user: string): ActiveContract => ({
    contractId,
    payload: {
      admin,
      user,
      marketId: "0",
      instrument: CC,
      amount: "50000.0000000000",
      reason: "withdraw",
      createdAt: "1700000000",
      auditObservers: [TREASURY],
    },
  });

  it("a PendingPayout another party signed as admin is never owed by the treasury, and alerts once", async () => {
    const { service, sentry } = build([
      payoutRow("pp-ours", TREASURY, OWNER),
      payoutRow("pp-planted", MALLORY, MALLORY),
    ]);
    await expect(service.fetchPendingPayouts({ uncached: true })).resolves.toEqual([
      expect.objectContaining({ contractId: "pp-ours", user: OWNER }),
    ]);
    await expect(service.fetchPendingPayout("pp-planted", { uncached: true })).resolves.toBeNull();
    await expect(service.fetchPendingPayout("pp-ours")).resolves.toMatchObject({
      contractId: "pp-ours",
    });
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      "contract naming the treasury only as an observer ignored",
      "error",
      { entity: "PendingPayout", contractId: "pp-planted", admin: MALLORY },
    );
  });

  it("a planted UserWallet for the same owner is not a duplicate wallet and not the owner's balance", async () => {
    const planted = walletRow("uw-planted", OWNER, "50000.0000000000");
    planted.payload.admin = MALLORY;
    const { service } = build([walletRow("uw-ours", OWNER), planted]);
    await expect(service.fetchUserWallet(OWNER, CC)).resolves.toMatchObject({
      contractId: "uw-ours",
      balance: 10_000_000_000n,
    });
    await expect(service.fetchAllUserWallets()).resolves.toHaveLength(1);
  });

  it("a PredictionMarket another party signed is not a market to resolve", async () => {
    const { service } = build([
      { contractId: "mk-ours", payload: { admin: TREASURY, marketId: "7" } },
      { contractId: "mk-planted", payload: { admin: MALLORY, marketId: "7" } },
    ]);
    await expect(service.fetchMarketContracts("7")).resolves.toEqual(["mk-ours"]);
  });
});

describe("LedgerClientService.fetchMarketContracts (W9g F0)", () => {
  it("names the active PredictionMarket contracts of one market id, uncached, as the treasury", async () => {
    const { service } = build([
      { contractId: "mk-7a", payload: { admin: TREASURY, marketId: "7", status: "Trading" } },
      { contractId: "mk-70", payload: { admin: TREASURY, marketId: "70", status: "Trading" } },
      { contractId: "mk-8", payload: { admin: TREASURY, marketId: 8, status: "Trading" } },
    ]);
    const reads = jest.spyOn(service, "activeContracts");
    await expect(service.fetchMarketContracts("7", { uncached: true })).resolves.toEqual(["mk-7a"]);
    await expect(service.fetchMarketContracts("8")).resolves.toEqual(["mk-8"]);
    await expect(service.fetchMarketContracts("9")).resolves.toEqual([]);
    expect(reads).toHaveBeenCalledWith(TREASURY, "PredictionMarket", { uncached: true });
  });
});

type RecordedCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

/**
 * A participant that answers the ledger-end and active-contracts calls and records every request
 * (as pm-frontend's test/ledger-client.test.mjs stubs it), so the bodies the real client sends can
 * be pinned. The e2e suites swap this service for FakeLedgerClient and never see a request, which
 * is how a field the participant refuses went unnoticed.
 */
function stubParticipant(contracts: ActiveContract[]): {
  service: LedgerClientService;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith("/v2/state/ledger-end")) return json({ offset: 4242 });
    if (url.endsWith("/v2/state/active-contracts")) {
      return json(
        contracts.map(({ contractId, payload }) => ({
          contractEntry: {
            JsActiveContract: { createdEvent: { contractId, createArgument: payload } },
          },
        })),
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const config = {
    treasuryPartyId: TREASURY,
    truthoraclePackageId: "pkg",
    truthoraclePackageName: "truthoracle-v17",
    ledgerApiUrl: "http://ledger",
    isMainnet: false,
    ledgerCacheMs: 0,
  } as unknown as Config;
  const keycloak = {
    bearerFor: jest.fn().mockResolvedValue("tok"),
  } as unknown as KeycloakTokenService;
  const service = new LedgerClientService(
    config,
    keycloak,
    {} as RedisService,
    { captureMessage: jest.fn(), captureException: jest.fn() } as unknown as SentryService,
  );
  return { service, calls };
}

describe("LedgerClientService.activeContracts (GetActiveContractsRequest body)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const acsBody = (calls: RecordedCall[]): Record<string, unknown> => {
    const acs = calls.find((c) => c.url === "http://ledger/v2/state/active-contracts");
    expect(acs?.method).toBe("POST");
    expect(acs?.headers.Authorization).toBe("Bearer tok");
    return acs?.body as Record<string, unknown>;
  };

  it("sends only activeAtOffset next to eventFormat — Canton 3.6 refuses the legacy top-level verbose / filter (DEPRECATED_API_DISABLED)", async () => {
    const { service, calls } = stubParticipant([walletRow("uw-1", OWNER)]);
    const rows = await service.activeContracts(TREASURY, "UserWallet");
    expect(rows).toHaveLength(1);
    expect(rows[0].contractId).toBe("uw-1");
    expect(rows[0].payload.owner).toBe(OWNER);
    const ledgerEnd = calls.find((c) => c.url === "http://ledger/v2/state/ledger-end");
    expect(ledgerEnd?.method).toBe("GET");
    const body = acsBody(calls);
    expect(Object.keys(body).sort()).toEqual(["activeAtOffset", "eventFormat"]);
    expect(body.activeAtOffset).toBe("4242");
    expect(body.eventFormat).toEqual({
      filtersByParty: {
        [TREASURY]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: "#truthoracle-v17:Truthoracle:UserWallet",
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
      verbose: false,
    });
  });

  it("the wallet readers go through that same body, and the module override lands in the package-name filter", async () => {
    const { service, calls } = stubParticipant([walletRow("uw-1", OWNER)]);
    await expect(service.fetchUserWallet(OWNER, CC)).resolves.toMatchObject({
      contractId: "uw-1",
    });
    expect(Object.keys(acsBody(calls)).sort()).toEqual(["activeAtOffset", "eventFormat"]);
    calls.length = 0;
    await service.activeContracts(OWNER, "PredictionModel", {}, "Marketplace");
    const body = acsBody(calls) as {
      eventFormat: { filtersByParty: Record<string, { cumulative: unknown[] }> };
    };
    expect(Object.keys(body).sort()).toEqual(["activeAtOffset", "eventFormat"]);
    expect(body.eventFormat.filtersByParty[OWNER].cumulative).toEqual([
      {
        identifierFilter: {
          TemplateFilter: {
            value: {
              templateId: "#truthoracle-v17:Marketplace:PredictionModel",
              includeCreatedEventBlob: false,
            },
          },
        },
      },
    ]);
  });
});

describe("UserWallet Create command (shared by deposits, in-app payouts and reward grants)", () => {
  it("is always the empty wallet in one instrument with creditRefs: [] and the audit observers (mandatory on truthoracle-v17)", () => {
    const create = userWalletCreateCommand({
      templateId: "pkg:Truthoracle:UserWallet",
      admin: TREASURY,
      owner: OWNER,
      instrument: CC,
      auditObservers: [REGULATOR],
    }) as {
      CreateCommand: { templateId: string; createArguments: Record<string, unknown> };
    };
    expect(create.CreateCommand.templateId).toBe("pkg:Truthoracle:UserWallet");
    expect(create.CreateCommand.createArguments).toEqual({
      admin: TREASURY,
      owner: OWNER,
      instrument: { admin: DSO, id: "Amulet" },
      balance: "0.0000000000",
      deposited: "0.0000000000",
      withdrawn: "0.0000000000",
      creditRefs: [],
      auditObservers: [REGULATOR],
    });
  });
});

describe("UserWallet Create command id", () => {
  it("is one fixed id per owner, instrument and package name, in a pinned format", () => {
    expect(walletCreateCommandIdFor("truthoracle-v17", OWNER, CC)).toMatch(
      /^wallet-create-[0-9a-f]{40}$/,
    );
    expect(walletCreateCommandIdFor("truthoracle-v17", OWNER, CC)).toBe(
      walletCreateCommandIdFor("truthoracle-v17", OWNER, CC),
    );
    expect(
      walletCreateCommandIdFor("truthoracle-v17", "other::1220" + "b".repeat(64), CC),
    ).not.toBe(walletCreateCommandIdFor("truthoracle-v17", OWNER, CC));
  });

  it("changes with the instrument: a party's Canton Coin and TRO wallets are two Creates that must not collide", () => {
    expect(walletCreateCommandIdFor("truthoracle-v17", OWNER, CC)).not.toBe(
      walletCreateCommandIdFor("truthoracle-v17", OWNER, TRO),
    );
    expect(walletCreateCommandIdFor("truthoracle-v17", OWNER, CC)).not.toBe(
      walletCreateCommandIdFor("truthoracle-v17", OWNER, { admin: TRO.admin, id: "Amulet" }),
    );
  });

  it("changes with the package name, so a Create spent under an older package cannot block the current one", () => {
    expect(walletCreateCommandIdFor("truthoracle-v17", OWNER, CC)).not.toBe(
      walletCreateCommandIdFor("truthoracle-v16", OWNER, CC),
    );
  });

  it("refuses to build an id without a package name, an owner or a complete instrument", () => {
    expect(() => walletCreateCommandIdFor("", OWNER, CC)).toThrow();
    expect(() => walletCreateCommandIdFor("truthoracle-v17", "", CC)).toThrow();
    expect(() =>
      walletCreateCommandIdFor("truthoracle-v17", OWNER, { admin: "", id: "Amulet" }),
    ).toThrow();
    expect(() =>
      walletCreateCommandIdFor("truthoracle-v17", OWNER, { admin: DSO, id: "" }),
    ).toThrow();
  });

  it("the service applies the configured package name, and fails closed without one", () => {
    const { service } = build([]);
    expect(service.walletCreateCommandId(OWNER, CC)).toBe(
      walletCreateCommandIdFor("truthoracle-v17", OWNER, CC),
    );
    const unnamed = new LedgerClientService(
      { truthoraclePackageName: "" } as unknown as Config,
      {} as KeycloakTokenService,
      {} as RedisService,
      {} as SentryService,
    );
    expect(() => unnamed.walletCreateCommandId(OWNER, CC)).toThrow(ApiError);
  });
});

describe("parseCreditRefs", () => {
  it("accepts a JSON list and nothing else — a missing or Optional-shaped field is a hard parse error", () => {
    expect(parseCreditRefs([])).toEqual([]);
    expect(parseCreditRefs(["a", "b"])).toEqual(["a", "b"]);
    expect(() => parseCreditRefs(undefined)).toThrow(/missing/);
    expect(() => parseCreditRefs(null)).toThrow(/not a list/);
    expect(() => parseCreditRefs("None")).toThrow(/not a list/);
    expect(() => parseCreditRefs({ Some: ["a"] })).toThrow(/not a list/);
    expect(() => parseCreditRefs(42)).toThrow(/not a list/);
  });
});

describe("parseInstrumentId", () => {
  it("accepts the Daml record and refuses anything partial", () => {
    expect(parseInstrumentId({ admin: DSO, id: "Amulet" })).toEqual(CC);
    expect(parseInstrumentId({ admin: ` ${DSO} `, id: " TRO " })).toEqual({
      admin: DSO,
      id: "TRO",
    });
    expect(() => parseInstrumentId(undefined)).toThrow(/missing/);
    expect(() => parseInstrumentId(null)).toThrow(/not a record/);
    expect(() => parseInstrumentId("Amulet")).toThrow(/not a record/);
    expect(() => parseInstrumentId({ admin: DSO })).toThrow(/needs admin and id/);
    expect(() => parseInstrumentId({ admin: "", id: "Amulet" })).toThrow(/needs admin and id/);
    expect(() => parseInstrumentId([DSO, "Amulet"])).toThrow(/not a record/);
  });
});
