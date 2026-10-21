import { parseAmount } from "../util/money";
import {
  checkCommandId,
  claimLines,
  decodeJwtClaims,
  formatLine,
  MAINNET_ACK_PHRASE,
  parseCheckArgs,
  roundtripRefusal,
  secretInfo,
} from "./tokenapp-check.lib";

const TREASURY = "treasury::1220" + "0".repeat(56) + "deadbeef";

const jwt = (payload: Record<string, unknown>): string =>
  [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "c2lnbmF0dXJl",
  ].join(".");

describe("tokenapp:check arguments and the round-trip refusal (docs/RAMP.md §7)", () => {
  it("parses the flags; read-only by default with a 0.01 round-trip amount", () => {
    expect(parseCheckArgs([])).toEqual({
      json: false,
      roundtrip: false,
      amount: parseAmount("0.01"),
      ackMainnet: null,
      instrumentId: null,
    });
    expect(
      parseCheckArgs([
        "--json",
        "--roundtrip",
        "--amount",
        "0.05",
        "--ack-mainnet=deadbeef",
        "--instrument=cBYN",
      ]),
    ).toEqual({
      json: true,
      roundtrip: true,
      amount: parseAmount("0.05"),
      ackMainnet: "deadbeef",
      instrumentId: "cBYN",
    });
    expect(() => parseCheckArgs(["--amount", "-1"])).toThrow(/positive decimal/);
    expect(() => parseCheckArgs(["--amount"])).toThrow(/needs a value/);
    expect(() => parseCheckArgs(["--mint"])).toThrow(/unknown argument/);
  });

  it("caps the amount at 0.10 and the instrument's decimals; needs the read-only checks first", () => {
    const base = {
      mainnet: false,
      envAck: undefined,
      treasury: TREASURY,
      decimals: 6,
      failedPrerequisites: [] as string[],
    };
    const args = (a: string[] = []) => parseCheckArgs(["--roundtrip", ...a]);
    expect(roundtripRefusal({ ...base, args: args() })).toBeNull();
    expect(roundtripRefusal({ ...base, args: args(["--amount", "0.10"]) })).toBeNull();
    expect(roundtripRefusal({ ...base, args: args(["--amount", "0.11"]) })).toMatch(
      /capped at 0\.10/,
    );
    expect(roundtripRefusal({ ...base, args: args(["--amount", "0"]) })).toMatch(/positive/);
    expect(roundtripRefusal({ ...base, args: args(["--amount", "0.0000001"]) })).toMatch(/finer/);
    expect(
      roundtripRefusal({
        ...base,
        args: args(),
        failedPrerequisites: ["bearer.grant", "ledger.mint_delegation"],
      }),
    ).toBe("read-only checks failed first: bearer.grant, ledger.mint_delegation");
  });

  it("mainnet needs BOTH --ack-mainnet=<last 8 hex of the treasury> and TOKENAPP_CHECK_MAINNET", () => {
    const base = {
      mainnet: true,
      treasury: TREASURY,
      decimals: 6,
      failedPrerequisites: [] as string[],
    };
    const acked = parseCheckArgs(["--roundtrip", "--ack-mainnet=deadbeef"]);
    expect(
      roundtripRefusal({
        ...base,
        args: parseCheckArgs(["--roundtrip"]),
        envAck: MAINNET_ACK_PHRASE,
      }),
    ).toMatch(/--ack-mainnet/);
    expect(
      roundtripRefusal({
        ...base,
        args: parseCheckArgs(["--roundtrip", "--ack-mainnet=deadbeee"]),
        envAck: MAINNET_ACK_PHRASE,
      }),
    ).toMatch(/--ack-mainnet/);
    expect(roundtripRefusal({ ...base, args: acked, envAck: undefined })).toMatch(
      /TOKENAPP_CHECK_MAINNET=I_UNDERSTAND_REAL_CBYN/,
    );
    expect(roundtripRefusal({ ...base, args: acked, envAck: "yes" })).toMatch(
      /TOKENAPP_CHECK_MAINNET/,
    );
    expect(roundtripRefusal({ ...base, args: acked, envAck: MAINNET_ACK_PHRASE })).toBeNull();
    expect(
      roundtripRefusal({ ...base, treasury: "", args: acked, envAck: MAINNET_ACK_PHRASE }),
    ).toMatch(/ack-mainnet/);
  });

  it("names round-trip commands tokenapp-check-<kind>-<utc stamp>-<6 hex>", () => {
    expect(checkCommandId("mint", new Date("2026-10-19T08:07:06.123Z"), "a1b2c3")).toBe(
      "tokenapp-check-mint-20261019080706-a1b2c3",
    );
    expect(checkCommandId("burn", new Date())).toMatch(/^tokenapp-check-burn-\d{14}-[0-9a-f]{6}$/);
  });
});

describe("tokenapp:check bearer diagnostics (T-D7) print claims, never the token", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  const iat = Math.floor(now.getTime() / 1000) - 10;

  it("decodes the payload without verifying; summarises roles, scope and lifetime", () => {
    const token = jwt({
      iss: "https://auth.main.zkpc.cantor8.tech/realms/master",
      azp: "truthoracle-token-app",
      aud: "token-app",
      scope: "profile",
      realm_access: { roles: ["token-admin"] },
      resource_access: { "token-app": { roles: ["mint", "burn"] } },
      iat,
      exp: iat + 300,
    });
    const lines = claimLines(
      decodeJwtClaims(token),
      { keycloakUrl: "https://auth.main.zkpc.cantor8.tech", clientId: "truthoracle-token-app" },
      now,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "OK", check: "bearer.claims" });
    expect(lines[0].data).toEqual({
      iss: "https://auth.main.zkpc.cantor8.tech/realms/master",
      azp: "truthoracle-token-app",
      aud: "token-app",
      scope: "profile",
      realmRoles: ["token-admin"],
      resourceRoles: { "token-app": ["mint", "burn"] },
      iat: new Date(iat * 1000).toISOString(),
      exp: new Date((iat + 300) * 1000).toISOString(),
      secondsLeft: 290,
      lifespanSec: 300,
    });
    for (const line of lines) expect(formatLine(line)).not.toContain(token.split(".")[1]);
  });

  it("warns on another issuer host, a foreign azp and a ≤ 60 s lifetime; a non-JWT shows no claims", () => {
    const lines = claimLines(
      decodeJwtClaims(
        jwt({
          iss: "https://auth.dev.digik.cantor8.tech/realms/master",
          azp: "wallet",
          iat,
          exp: iat + 60,
        }),
      ),
      { keycloakUrl: "https://auth.main.zkpc.cantor8.tech", clientId: "truthoracle-token-app" },
      now,
    );
    expect(lines.map((l) => [l.status, l.check])).toEqual([
      ["OK", "bearer.claims"],
      ["WARN", "bearer.issuer"],
      ["WARN", "bearer.azp"],
      ["WARN", "bearer.lifespan"],
    ]);
    expect(decodeJwtClaims("opaque-token")).toBeNull();
    expect(claimLines(null, { keycloakUrl: "x", clientId: "y" }, now)[0]).toMatchObject({
      status: "WARN",
    });
  });

  it("prints a secret as its length only", () => {
    expect(secretInfo("s3cr3t-value")).toBe("set (12 chars)");
    expect(secretInfo(undefined)).toBe("unset");
    expect(secretInfo("")).toBe("unset");
    expect(formatLine({ status: "FAIL", check: "bearer.grant", detail: "HTTP 401" })).toBe(
      "FAIL bearer.grant — HTTP 401",
    );
  });
});
