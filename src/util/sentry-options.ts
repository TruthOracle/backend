import * as Sentry from "@sentry/node";

import type { Config } from "../config";
import { SERVICE_NAME, SERVICE_VERSION } from "./version";

/**
 * `Sentry.init` options (main.ts, before Nest boots). Tags only — never bodies or PII
 * (ARCHITECTURE §14). @sentry/node 10 attaches incoming request bodies (up to 10 KB, "medium")
 * whatever `sendDefaultPii` says, which would ship IBANs, statement lines and payer data (SPEC §8,
 * X17); the Http integration is replaced by one that captures none.
 */
export function sentryInitOptions(
  config: Pick<Config, "sentryDsn" | "appEnv">,
): Sentry.NodeOptions {
  return {
    dsn: config.sentryDsn,
    environment: config.appEnv,
    release: `${SERVICE_NAME}@${SERVICE_VERSION}`,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" })],
  };
}
