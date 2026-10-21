import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getConfiguration } from "./config";

/**
 * `.env.example` is the configuration reference (SPEC §13, S8): every variable getConfiguration()
 * reads is an ACTIVE entry with its default and a one-line comment, and nothing else is listed.
 */
const ROOT = join(__dirname, "..");
const EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8").split("\n");
const CONFIG_SOURCE = readFileSync(join(__dirname, "config.ts"), "utf8");

interface Entry {
  name: string;
  value: string;
  active: boolean;
  commented: boolean;
}

/** `NAME=value  # comment` lines (and `# NAME=` ones, inactive), values unquoted as dotenv does. */
const ENTRIES: Entry[] = EXAMPLE.flatMap((line, i): Entry[] => {
  const m = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m) return [];
  const hash = m[3].search(/(^|\s)#/);
  let value = (hash >= 0 ? m[3].slice(0, hash) : m[3]).trim();
  if (/^".*"$/.test(value)) value = value.slice(1, -1);
  const above = i > 0 && EXAMPLE[i - 1].trim().startsWith("#");
  return [{ name: m[2], value, active: !m[1], commented: hash >= 0 || above }];
});
const ACTIVE = ENTRIES.filter((e) => e.active);

/** Example values that are not the default on purpose: required values and deployment examples. */
const NOT_DEFAULT: Record<string, string> = {
  DATABASE_URL: "required (docker-compose credentials)",
  REDIS_URL: "required",
  NATS_URL: "required",
  SESSION_SECRET: "required placeholder",
  KYC_FINGERPRINT_PEPPER: "required placeholder",
  FRONTEND_ORIGINS: "the local frontend",
  TRUTHORACLE_PACKAGE_NAME: "the deployed package lineage",
  COLLATERAL_INSTRUMENT_ID: "cBYN (needs its admin party)",
  COLLATERAL_INSTRUMENT_NAME: "cBYN's name",
  COLLATERAL_REGISTRY_URL: "Cantor8's DevNet registry",
  REWARDS_INSTRUMENT_ID: "TRO",
  REWARDS_INSTRUMENT_NAME: "TRO's name",
  RAMP_BANK_HOLIDAYS: "the 2026 Belarusian holidays (blank = weekends only)",
};
/** Read by a script, not by getConfiguration() (commented on purpose). */
const SCRIPT_ONLY = ["TOKENAPP_CHECK_MAINNET"];

/** Every variable getConfiguration() reads: `env.X` in its source, plus every key a run touches (composed names). */
function configReads(): Set<string> {
  const names = new Set([...CONFIG_SOURCE.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
  const base = Object.fromEntries(ACTIVE.map((e) => [e.name, e.value]));
  const runs: Record<string, string>[] = [
    { ...base, COLLATERAL_INSTRUMENT_ADMIN: "DSO::1220" + "d".repeat(64) },
    { ...base, COLLATERAL_INSTRUMENT_ID: "", APP_NETWORK: "mainnet" },
  ];
  for (const env of runs) {
    const spy = new Proxy(env, {
      get: (t, k) => {
        if (typeof k === "string") names.add(k);
        return t[k as string];
      },
      has: (t, k) => {
        if (typeof k === "string") names.add(k);
        return k in t;
      },
    });
    try {
      getConfiguration(spy);
    } catch {
      // A refused combination still read what it read.
    }
  }
  return new Set([...names].filter((n) => /^[A-Z][A-Z0-9_]+$/.test(n)));
}

const ser = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === "bigint") return `${x}n`;
    if (x instanceof Map) return { map: [...x.entries()] };
    if (x instanceof Set) return { set: [...x.values()] };
    return x;
  });

describe(".env.example (SPEC §13; S8)", () => {
  const reads = configReads();

  it("lists every variable getConfiguration() reads as an active entry, and nothing it does not read", () => {
    expect(reads.size).toBeGreaterThan(200);
    const active = new Set(ACTIVE.map((e) => e.name));
    expect([...reads].filter((n) => !active.has(n)).sort()).toEqual([]);
    expect(
      ENTRIES.filter((e) => !reads.has(e.name) && !SCRIPT_ONLY.includes(e.name)).map((e) => e.name),
    ).toEqual([]);
    expect(new Set(ENTRIES.map((e) => e.name)).size).toBe(ENTRIES.length);
  });

  it("gives every entry a one-line comment", () => {
    expect(ACTIVE.filter((e) => !e.commented).map((e) => e.name)).toEqual([]);
  });

  it("shows each default: dropping an entry changes nothing, unless it is a required value or a deployment example", () => {
    const env = {
      ...Object.fromEntries(ACTIVE.map((e) => [e.name, e.value])),
      // Left blank for the deployment, needed for a boot.
      COLLATERAL_INSTRUMENT_ADMIN: "DSO::1220" + "d".repeat(64),
    };
    const base = ser(getConfiguration(env));
    const differs: string[] = [];
    for (const { name } of ACTIVE) {
      if (name === "COLLATERAL_INSTRUMENT_ADMIN") continue;
      const without: Record<string, string> = { ...env };
      delete without[name];
      let changed = true;
      try {
        changed = ser(getConfiguration(without)) !== base;
      } catch {
        // Required: the boot refuses without it.
      }
      if (changed) differs.push(name);
    }
    expect(differs.sort()).toEqual(Object.keys(NOT_DEFAULT).sort());
  });

  it("names none of v1's removed variables (SPEC §13), here or in the configuration", () => {
    const removed =
      /\b(RAMP_DATA_KEY|RAMP_HOLD_HOURS|RAMP_CHECKOUT_TTL_MIN|RAMP_ONRAMP_FEE_\w+|RAMP_OFFRAMP_FEE_\w+)\b/;
    expect(EXAMPLE.join("\n")).not.toMatch(removed);
    expect(CONFIG_SOURCE).not.toMatch(removed);
  });
});
