/**
 * `npm run kyc:check` — prove the KYC provider wiring from the shell before the first user tries
 * (docs/KYC.md §6): loads `.env` the way main.ts does, builds the validated Config (so every
 * boot refusal applies here too), runs the provider's credential probe and prints what the
 * vendor dashboard must be configured with. Exit code 0 only when the probe passes. No
 * applicant data is read.
 */
import { join } from "node:path";

import { getConfiguration } from "../config";
import { KycProviderMockService } from "../services/kyc-provider-mock.service";
import { KycProviderSumsubService } from "../services/kyc-provider-sumsub.service";
import type { KycProvider } from "../types";

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(__dirname, "..", "..", ".env"));
  } catch {
    // no .env: the environment must carry the configuration (Railway, CI)
  }
  const config = getConfiguration();
  const provider: KycProvider =
    config.kycProvider === "sumsub"
      ? new KycProviderSumsubService(config)
      : new KycProviderMockService(config);
  const health = await provider.healthCheck();
  const lines = [
    `provider            ${provider.name}`,
    `configured          ${provider.isConfigured()}`,
    `required level      ${config.kycRequiredLevel}`,
    `enforce withdrawals ${config.kycEnforceWithdrawals}`,
    `webhook path        /api/v1/webhooks/kyc/${provider.name}   (register https://<app-host>/__backend + this path in the vendor dashboard)`,
    `probe               ${health.ok ? "OK" : "FAILED"}${health.upstreamStatus !== null ? ` (HTTP ${health.upstreamStatus})` : ""} — ${health.message}`,
  ];
  for (const [k, v] of Object.entries(health.details))
    lines.push(`  ${k.padEnd(26)} ${JSON.stringify(v)}`);
  console.log(lines.join("\n"));
  return health.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(2);
  });
