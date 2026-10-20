import type { Config } from "../config";
import { parseAmount } from "../util/money";
import type { KeycloakTokenService } from "./keycloak-token.service";
import {
  parseTokenAppAmount,
  TokenAppService,
  tokenAppBatchBody,
  tokenAppCommandBody,
} from "./token-app.service";

const TREASURY = "treasury::1220" + "f".repeat(64);
const BASE = "https://token-app.test";

interface Call {
  url: string;
  method: string;
  body: string | null;
  bearer: string | null;
}

/** Answers each fetch with the next scripted response; records what was sent. */
function scriptFetch(responses: ((call: Call) => Response | Error)[]): Call[] {
  const calls: Call[] = [];
  global.fetch = jest.fn((input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      bearer: headers.Authorization ?? null,
    };
    calls.push(call);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    const res = next ? next(call) : new Response("{}", { status: 200 });
    return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
  }) as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown) => (): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function build(): { svc: TokenAppService; bearerFor: jest.Mock; invalidate: jest.Mock } {
  const config = {
    hasTokenApp: true,
    tokenApp: { url: BASE, appName: "truthoracle", keycloak: {} },
  } as unknown as Config;
  let n = 0;
  const bearerFor = jest.fn(() => Promise.resolve(`bearer-${++n}`));
  const invalidate = jest.fn(() => Promise.resolve());
  const keycloak = {
    isConfigured: () => true,
    bearerFor,
    invalidate,
  } as unknown as KeycloakTokenService;
  return { svc: new TokenAppService(config, keycloak), bearerFor, invalidate };
}

const MINT = {
  commandId: "ramp-mint-1",
  instrumentId: "cBYN",
  partyId: TREASURY,
  amount: parseAmount("12.5"),
  decimals: 6,
};

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe("token-app request shaping (docs/TOKENS.md §4.4)", () => {
  it("sends snake_case keys and the amount in the instrument's own decimals; refuses anything finer instead of truncating it", () => {
    expect(tokenAppCommandBody(MINT, "truthoracle")).toEqual({
      command_id: "ramp-mint-1",
      instrument_id: "cBYN",
      party_id: TREASURY,
      amount: "12.500000",
      app_name: "truthoracle",
    });
    expect(
      tokenAppCommandBody(
        { ...MINT, instrumentId: "Amulet", amount: parseAmount("1"), decimals: 10 },
        "x",
      ).amount,
    ).toBe("1.0000000000");
    expect(() =>
      tokenAppCommandBody({ ...MINT, amount: parseAmount("12.3456789012") }, "truthoracle"),
    ).toThrow(/whole at 6 decimals/);
    expect(() => tokenAppCommandBody({ ...MINT, amount: 0n }, "truthoracle")).toThrow(/positive/);
    expect(
      tokenAppBatchBody(
        {
          commandId: "batch-1",
          instrumentId: "TRO",
          decimals: 6,
          entries: [{ partyId: TREASURY, amount: parseAmount("1000") }],
        },
        "truthoracle",
      ),
    ).toEqual({
      command_id: "batch-1",
      instrument_id: "TRO",
      entries: [{ party_id: TREASURY, amount: "1000.000000" }],
      app_name: "truthoracle",
    });
  });

  it("answers 503 token_app_unconfigured for every call without TOKEN_APP_URL, and status() reports it without throwing", async () => {
    const config = {
      hasTokenApp: false,
      tokenApp: { url: "", appName: "truthoracle", keycloak: {} },
    } as unknown as Config;
    const keycloak = {
      isConfigured: () => true,
      bearerFor: jest.fn(),
    } as unknown as KeycloakTokenService;
    const svc = new TokenAppService(config, keycloak);
    expect(svc.isConfigured()).toBe(false);
    await expect(svc.mint({ ...MINT, amount: 1n * 10n ** 4n })).rejects.toMatchObject({
      status: 503,
      code: "token_app_unconfigured",
    });
    await expect(svc.holdings()).rejects.toMatchObject({ code: "token_app_unconfigured" });
    await expect(svc.postCommand("mint", MINT)).resolves.toMatchObject({
      outcome: "not_sent",
      code: "token_app_unconfigured",
    });
    await expect(svc.status()).resolves.toEqual({
      configured: false,
      url: null,
      appName: "truthoracle",
      reachable: false,
      raw: null,
    });
  });
});

describe("token-app 401 / 403 / 422 (T-D3)", () => {
  it("401: invalidates the bearer, mints a fresh one and sends the identical body once more", async () => {
    const { svc, invalidate } = build();
    const calls = scriptFetch([
      json(401, { detail: "expired" }),
      json(200, { command_id: "ramp-mint-1", status: "accepted" }),
    ]);
    await expect(svc.postCommand("mint", MINT)).resolves.toEqual({
      outcome: "accepted",
      httpStatus: 200,
      status: "accepted",
      code: null,
      message: null,
    });
    expect(invalidate).toHaveBeenCalledWith("tokenApp");
    expect(calls.map((c) => [c.url, c.method, c.bearer])).toEqual([
      [`${BASE}/api/admin/mint`, "POST", "Bearer bearer-1"],
      [`${BASE}/api/admin/mint`, "POST", "Bearer bearer-2"],
    ]);
    expect(calls[1].body).toBe(calls[0].body);
    expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({ amount: "12.500000" });
  });

  it("a second 401 is token_app_unauthorized — definitive, no third attempt", async () => {
    const { svc } = build();
    const calls = scriptFetch([json(401, {})]);
    await expect(svc.postCommand("burn", MINT)).resolves.toMatchObject({
      outcome: "rejected",
      httpStatus: 401,
      code: "token_app_unauthorized",
    });
    expect(calls).toHaveLength(2);
    // GETs share the rule and throw the same code.
    scriptFetch([json(401, {})]);
    await expect(svc.mints({ instrumentId: "cBYN" })).rejects.toMatchObject({
      status: 502,
      code: "token_app_unauthorized",
    });
  });

  it("403 and 422 are definitive and never retried; 5xx, other statuses and network errors are unknown", async () => {
    const { svc, invalidate } = build();
    for (const [status, code] of [
      [403, "token_app_forbidden"],
      [422, "token_app_invalid_request"],
    ] as const) {
      const calls = scriptFetch([json(status, { detail: [] })]);
      await expect(svc.postCommand("mint", MINT)).resolves.toMatchObject({
        outcome: "rejected",
        httpStatus: status,
        code,
      });
      expect(calls).toHaveLength(1);
    }
    for (const status of [500, 502, 409, 400, 429]) {
      scriptFetch([json(status, {})]);
      await expect(svc.postCommand("mint", MINT)).resolves.toMatchObject({
        outcome: "unknown",
        httpStatus: status,
        code: "upstream_failed",
      });
    }
    scriptFetch([() => new TypeError("fetch failed")]);
    await expect(svc.postCommand("mint", MINT)).resolves.toMatchObject({
      outcome: "unknown",
      httpStatus: 0,
    });
    expect(invalidate).not.toHaveBeenCalled();
    scriptFetch([json(403, {})]);
    await expect(svc.burns({ instrumentId: "cBYN" })).rejects.toMatchObject({
      code: "token_app_forbidden",
    });
  });

  it("an amount finer than the instrument never leaves the process", async () => {
    const { svc } = build();
    const calls = scriptFetch([json(200, {})]);
    await expect(
      svc.postCommand("mint", { ...MINT, amount: parseAmount("1.0000001") }),
    ).resolves.toMatchObject({ outcome: "not_sent", code: "validation_failed" });
    expect(calls).toHaveLength(0);
  });
});

describe("paging /data/admin/mints|burns (T-D1)", () => {
  const row = (i: number): Record<string, unknown> => ({
    command_id: `c-${i}`,
    created_at: "2026-10-19T10:00:00Z",
    party_id: TREASURY,
    instrument_id: "cBYN",
    update_id: `u-${i}`,
    amount: "1.000000",
  });

  it("pages limit=1000 with growing offsets until a short page, without a party filter", async () => {
    const { svc } = build();
    const calls = scriptFetch([
      (c) => {
        const offset = Number(new URL(c.url).searchParams.get("offset"));
        const n = offset < 2000 ? 1000 : 500;
        return json(
          200,
          Array.from({ length: n }, (_v, i) => row(offset + i)),
        )();
      },
    ]);
    const records = await svc.listRecords("mint", { instrumentId: "cBYN" }, 6);
    expect(records).toHaveLength(2500);
    expect(calls.map((c) => new URL(c.url).search)).toEqual([
      "?instrument_id=cBYN&limit=1000&offset=0",
      "?instrument_id=cBYN&limit=1000&offset=1000",
      "?instrument_id=cBYN&limit=1000&offset=2000",
    ]);
    expect(records[2499]).toEqual({
      kind: "mint",
      commandId: "c-2499",
      updateId: "u-2499",
      partyId: TREASURY,
      instrumentId: "cBYN",
      amount: parseAmount("1"),
      createdAt: new Date("2026-10-19T10:00:00Z"),
    });
  });

  it("exactly one full page asks once more and stops on the empty page; the v1 mints()/burns() page too", async () => {
    const { svc } = build();
    const calls = scriptFetch([
      (c) =>
        json(
          200,
          new URL(c.url).searchParams.get("offset") === "0"
            ? Array.from({ length: 1000 }, (_v, i) => row(i))
            : [],
        )(),
    ]);
    expect(await svc.burns({ instrumentId: "cBYN", partyId: TREASURY })).toHaveLength(1000);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).searchParams.get("party_id")).toBe(TREASURY);
  });

  it("refuses a token-app that ignores offset (the same full page again) or answers no list", async () => {
    const { svc } = build();
    scriptFetch([
      json(
        200,
        Array.from({ length: 1000 }, (_v, i) => row(i)),
      ),
    ]);
    await expect(svc.listRecords("burn", { instrumentId: "cBYN" }, 6)).rejects.toThrow(
      /repeats a page/,
    );
    scriptFetch([json(200, { items: [] })]);
    await expect(svc.listRecords("burn", { instrumentId: "cBYN" }, 6)).rejects.toThrow(
      /did not answer a list/,
    );
  });

  it("a record with an unreadable amount fails the whole read (fail closed, T-D8)", async () => {
    const { svc } = build();
    scriptFetch([json(200, [row(1), { ...row(2), amount: "1.0000001" }])]);
    await expect(svc.listRecords("mint", { instrumentId: "cBYN" }, 6)).rejects.toThrow(
      /finer than 6 decimals/,
    );
  });
});

describe("parseTokenAppAmount (docs/RAMP.md §7, T-D8)", () => {
  it("reads decimal strings exactly, trailing zeros beyond the instrument included", () => {
    expect(parseTokenAppAmount("1000.000001", 6)).toBe(10_000_000_010_000n);
    expect(parseTokenAppAmount("12.5000000000", 6)).toBe(parseAmount("12.5"));
    expect(parseTokenAppAmount("7", 0)).toBe(parseAmount("7"));
    expect(parseTokenAppAmount(".5", 6)).toBe(parseAmount("0.5"));
  });

  it("accepts a JSON number only below 1e9 and only when it round-trips at the instrument's decimals", () => {
    expect(parseTokenAppAmount(12.5, 6)).toBe(parseAmount("12.5"));
    expect(parseTokenAppAmount(0.1, 6)).toBe(parseAmount("0.1"));
    expect(parseTokenAppAmount(999_999_999.999999, 6)).toBe(parseAmount("999999999.999999"));
    expect(() => parseTokenAppAmount(1e9, 6)).toThrow(/out of range/);
    expect(() => parseTokenAppAmount(1.0000001, 6)).toThrow(/finer than 6/);
    expect(() => parseTokenAppAmount(0.1 + 0.2, 10)).toThrow(/finer than 10/);
  });

  it("refuses anything else: finer digits, negatives, exponents, blanks, null", () => {
    for (const bad of ["1.0000001", "-1", "1e5", "", " ", "abc", "1.2.3", "0x10"])
      expect(() => parseTokenAppAmount(bad, 6)).toThrow(/unreadable amount/);
    expect(() => parseTokenAppAmount("1.00000000001", 10)).toThrow(/more than 10 decimals/);
    for (const bad of [null, undefined, true, {}, Number.NaN, -1])
      expect(() => parseTokenAppAmount(bad, 6)).toThrow(/unreadable amount/);
  });
});

describe("holdings scan and /status (T-D8)", () => {
  it("checks total and scanned_at, parses amounts strictly", async () => {
    const { svc } = build();
    const holding = {
      holding_cid: "00h",
      party_id: TREASURY,
      instrument_id: "cBYN",
      amount: "5.25",
      locked: false,
    };
    scriptFetch([
      json(200, { scan: { scanned_at: "2026-10-19T10:00:00Z" }, total: 1, holdings: [holding] }),
    ]);
    await expect(svc.holdingsScan({ instrumentId: "cBYN", partyId: TREASURY }, 6)).resolves.toEqual(
      {
        scannedAt: new Date("2026-10-19T10:00:00Z"),
        total: 1,
        holdings: [
          {
            contractId: "00h",
            partyId: TREASURY,
            instrumentId: "cBYN",
            amount: "5.25",
            locked: false,
            units: parseAmount("5.25"),
          },
        ],
      },
    );
    scriptFetch([
      json(200, { scan: { scanned_at: "2026-10-19T10:00:00Z" }, total: 2, holdings: [holding] }),
    ]);
    await expect(svc.holdingsScan({ instrumentId: "cBYN" }, 6)).rejects.toThrow(
      /truncated \(1 of 2\)/,
    );
    scriptFetch([json(200, { scan: {}, total: 1, holdings: [holding] })]);
    await expect(svc.holdings()).rejects.toThrow(/scanned_at/);
  });

  it("parses the monitor snapshot of one instrument; an absent token reads as null", async () => {
    const { svc } = build();
    const status = {
      updated_at: "2026-10-19T10:00:00Z",
      tokens: {
        cBYN: {
          total_supply: "150.000000",
          total_locked_supply: 0,
          unique_holders: 3,
          updated_at: "2026-10-19T09:59:00Z",
        },
      },
      operational: {
        monitor: {
          last_success_at: "2026-10-19T09:59:30Z",
          age_seconds: 30,
          poll_interval_seconds: 60,
          monitoring_enabled: true,
        },
      },
    };
    scriptFetch([json(200, status)]);
    await expect(svc.monitor("cBYN", 6)).resolves.toEqual({
      updatedAt: new Date("2026-10-19T10:00:00Z"),
      token: {
        totalSupply: parseAmount("150"),
        totalLockedSupply: 0n,
        uniqueHolders: 3,
        updatedAt: new Date("2026-10-19T09:59:00Z"),
      },
      monitor: {
        lastSuccessAt: new Date("2026-10-19T09:59:30Z"),
        ageSeconds: 30,
        pollIntervalSeconds: 60,
        monitoringEnabled: true,
      },
    });
    scriptFetch([json(200, status)]);
    expect((await svc.monitor("TRO", 6)).token).toBeNull();
    scriptFetch([json(200, { ...status, tokens: { cBYN: { total_supply: "1e3" } } })]);
    await expect(svc.monitor("cBYN", 6)).rejects.toThrow(/unreadable amount/);
  });
});
