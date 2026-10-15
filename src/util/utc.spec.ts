import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Jest sandboxes `process.env`, so assigning TZ inside a test worker never reaches Node's clock.
 * The pin is checked the way the app runs: a real Node process started from a non-UTC host zone
 * that imports the module first, exactly like main.ts, data-source.ts and the scripts do.
 */
function probe(hostZone: string): Record<string, unknown> {
  const script = [
    `require(${JSON.stringify(join(__dirname, "utc"))});`,
    "const d = new Date(Date.UTC(2026, 2, 29, 1, 30));", // just after the EU clocks go forward
    "process.stdout.write(JSON.stringify({ offset: d.getTimezoneOffset(), hours: d.getHours(), utcHours: d.getUTCHours(),",
    "  date: d.getDate(), utcDate: d.getUTCDate(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone }));",
  ].join("\n");
  const out = execFileSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", "-e", script],
    {
      env: { ...process.env, TZ: hostZone },
      encoding: "utf8",
    },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

describe("process time zone", () => {
  it.each(["Asia/Kolkata", "America/Los_Angeles", "Europe/Berlin"])(
    "is pinned to UTC when the host runs in %s",
    (zone) => {
      const r = probe(zone);
      expect(r.offset).toBe(0);
      expect(r.hours).toBe(r.utcHours);
      expect(r.date).toBe(r.utcDate);
      expect(r.zone).toBe("UTC");
    },
  );
});
