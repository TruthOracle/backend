/**
 * Pure parts of `npm run tokenapp:check` (docs/RAMP.md §7; design token-zkpc.md §6): argument
 * parsing, the mainnet round-trip refusal, JWT claim decoding, check lines. Unit-tested in
 * tokenapp-check.lib.spec.ts; the I/O lives in tokenapp-check.ts. Nothing here ever returns a
 * token, a signature or a secret's value.
 */
import { randomBytes } from "node:crypto";

import { parseAmount } from "../util/money";

/** The round trip's default and hard cap: 1 and 10 kopecks of cBYN (supply stays kopeck-whole). */
export const ROUNDTRIP_DEFAULT = "0.01";
export const ROUNDTRIP_CAP = parseAmount("0.10");
/** What `TOKENAPP_CHECK_MAINNET` must say before a mainnet round trip mints real cBYN. */
export const MAINNET_ACK_PHRASE = "I_UNDERSTAND_REAL_CBYN";

export interface CheckArgs {
  json: boolean;
  roundtrip: boolean;
  /** 1e-10 units. */
  amount: bigint;
  ackMainnet: string | null;
  /** Token id to check; default the ramp instrument's. */
  instrumentId: string | null;
}

/** `--json`, `--roundtrip`, `--amount 0.01` / `--amount=0.01`, `--ack-mainnet=<8 hex>`, `--instrument cBYN`; unknown flags throw. */
export function parseCheckArgs(argv: string[]): CheckArgs {
  const out: CheckArgs = {
    json: false,
    roundtrip: false,
    amount: parseAmount(ROUNDTRIP_DEFAULT),
    ackMainnet: null,
    instrumentId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "") throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--json":
        out.json = true;
        break;
      case "--roundtrip":
        out.roundtrip = true;
        break;
      case "--amount": {
        const raw = value();
        if (!/^\d+(\.\d+)?$/.test(raw))
          throw new Error(`--amount must be a positive decimal, got ${raw}`);
        out.amount = parseAmount(raw);
        break;
      }
      case "--ack-mainnet":
        out.ackMainnet = value();
        break;
      case "--instrument":
        out.instrumentId = value();
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return out;
}

/**
 * Why a round trip is refused (null = allowed): the amount (positive, ≤ 0.10, whole at the
 * instrument's decimals), failed read-only prerequisites, and on mainnet BOTH the
 * `--ack-mainnet=<last 8 hex of TREASURY_PARTY_ID>` flag and `TOKENAPP_CHECK_MAINNET`.
 */
export function roundtripRefusal(input: {
  mainnet: boolean;
  args: CheckArgs;
  envAck: string | undefined;
  treasury: string;
  decimals: number;
  failedPrerequisites: string[];
}): string | null {
  const { args } = input;
  if (args.amount <= 0n) return "--amount must be positive";
  if (args.amount > ROUNDTRIP_CAP) return "--amount is capped at 0.10";
  const unit = 10n ** BigInt(10 - input.decimals);
  if (args.amount % unit !== 0n)
    return `--amount is finer than the instrument's ${input.decimals} decimals`;
  if (input.failedPrerequisites.length > 0)
    return `read-only checks failed first: ${input.failedPrerequisites.join(", ")}`;
  if (input.mainnet) {
    const tail = input.treasury.slice(-8);
    if (!tail || args.ackMainnet !== tail)
      return "APP_NETWORK=mainnet: pass --ack-mainnet=<last 8 hex of TREASURY_PARTY_ID>";
    if (input.envAck !== MAINNET_ACK_PHRASE)
      return `APP_NETWORK=mainnet: set TOKENAPP_CHECK_MAINNET=${MAINNET_ACK_PHRASE}`;
  }
  return null;
}

/** `tokenapp-check-{mint|burn}-<yyyymmddhhmmss>-<6 hex>` (UTC). */
export function checkCommandId(
  kind: "mint" | "burn",
  now: Date,
  hex = randomBytes(3).toString("hex"),
): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `tokenapp-check-${kind}-${stamp}-${hex}`;
}

/** The JWT payload, decoded WITHOUT verification (diagnostics only); null when it is not a JWT. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type CheckStatus = "OK" | "WARN" | "FAIL";

export interface CheckLine {
  status: CheckStatus;
  check: string;
  detail: string;
  data?: Record<string, unknown>;
}

/**
 * The bearer's claim summary (names and times only) and its warnings: an issuer on another host
 * than the configured Keycloak, an `azp` that is not our client, a lifetime ≤ 60 s (T-D7).
 */
export function claimLines(
  claims: Record<string, unknown> | null,
  expected: { keycloakUrl: string; clientId: string },
  now: Date,
): CheckLine[] {
  if (!claims)
    return [
      {
        status: "WARN",
        check: "bearer.claims",
        detail: "the bearer is not a JWT; claims not shown",
      },
    ];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const iat = num(claims.iat);
  const exp = num(claims.exp);
  const iss = typeof claims.iss === "string" ? claims.iss : "";
  const realmRoles = rolesOf(claims.realm_access);
  const resourceRoles: Record<string, string[]> = {};
  const resources = claims.resource_access;
  if (resources && typeof resources === "object")
    for (const [client, access] of Object.entries(resources as Record<string, unknown>))
      resourceRoles[client] = rolesOf(access);
  const lifespan = iat !== null && exp !== null ? exp - iat : null;
  const summary = {
    iss,
    azp: claims.azp ?? null,
    aud: claims.aud ?? null,
    scope: claims.scope ?? null,
    realmRoles,
    resourceRoles,
    iat: iat === null ? null : new Date(iat * 1000).toISOString(),
    exp: exp === null ? null : new Date(exp * 1000).toISOString(),
    secondsLeft: exp === null ? null : Math.round(exp - now.getTime() / 1000),
    lifespanSec: lifespan,
  };
  const lines: CheckLine[] = [
    { status: "OK", check: "bearer.claims", detail: JSON.stringify(summary), data: summary },
  ];
  if (iss && hostOf(iss) !== hostOf(expected.keycloakUrl))
    lines.push({
      status: "WARN",
      check: "bearer.issuer",
      detail: `iss host ${hostOf(iss)} ≠ configured Keycloak host ${hostOf(expected.keycloakUrl)}`,
    });
  if (claims.azp !== undefined && claims.azp !== expected.clientId)
    lines.push({
      status: "WARN",
      check: "bearer.azp",
      detail: `azp ${JSON.stringify(claims.azp)} ≠ client id ${expected.clientId}`,
    });
  if (lifespan !== null && lifespan <= 60)
    lines.push({
      status: "WARN",
      check: "bearer.lifespan",
      detail: `tokens live ${lifespan} s: cached for half of that (T-D7)`,
    });
  return lines;
}

function rolesOf(access: unknown): string[] {
  const roles = access && typeof access === "object" ? (access as { roles?: unknown }).roles : null;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

/** A secret as the script may print it. */
export function secretInfo(value: string | undefined): string {
  return value ? `set (${value.length} chars)` : "unset";
}

/** `OK check — detail` per line. */
export function formatLine(line: CheckLine): string {
  return `${line.status.padEnd(4)} ${line.check} — ${line.detail}`;
}
