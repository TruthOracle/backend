import { Injectable } from "@nestjs/common";
import * as Sentry from "@sentry/node";

import { Config } from "../config";

/**
 * Thin wrapper so services can report without importing the SDK. `Sentry.init` runs in
 * main.ts BEFORE Nest boots (ARCHITECTURE §2); with no DSN every call is a no-op. Tags only —
 * never request bodies, applicant data, tokens or other PII (§9.7, §14).
 */
@Injectable()
export class SentryService {
  readonly enabled: boolean;

  constructor(config: Config) {
    this.enabled = Boolean(config.sentryDsn);
  }

  captureException(err: unknown, tags?: Record<string, string>): void {
    if (!this.enabled) return;
    Sentry.captureException(err, tags ? { tags } : undefined);
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error" = "warning",
    tags?: Record<string, string>,
  ): void {
    if (!this.enabled) return;
    Sentry.captureMessage(message, { level, ...(tags ? { tags } : {}) });
  }
}
