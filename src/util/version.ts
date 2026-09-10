import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SERVICE_NAME = "truthoracle-backend";

/**
 * The package version, read from package.json at load time so `node dist/main` (no `npm run`,
 * hence no `npm_package_version`) still reports the real release to Sentry and `/health`. Both
 * `dist/util/version.js` and `src/util/version.ts` sit two levels below the repository root.
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, "..", "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version) return parsed.version;
  } catch {
    // fall through
  }
  return process.env.npm_package_version ?? "0.0.0";
}

export const SERVICE_VERSION = readPackageVersion();
