import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { Config } from "../config";
import { KycService } from "../services/kyc.service";
import { RampService } from "../services/ramp.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";
import { SessionService } from "../services/session.service";
import { DAY_MS } from "../util/time";

/** Rows are kept this long after expiry/revocation so `GET /me/sessions` history and audits line up. */
const SESSION_RETENTION_MS = 7 * DAY_MS;

/**
 * Periodic housekeeping (`SESSION_CLEANUP_MS`): deletes stale session rows and runs the 30-day
 * webhook payload purges — KYC (`kyc-cleanup`, ARCHITECTURE §9.7) and the card acquirer
 * (docs/RAMP.md §5); each retention lives in its own service so each package owns its
 * data-minimisation rule. A Redis lock keeps
 * multiple instances from running the sweep concurrently. The timer is unref'd so it never
 * keeps a process alive.
 */
@Injectable()
export class SessionCleanupProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionCleanupProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionService,
    private readonly kyc: KycService,
    private readonly ramp: RampService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.config.sessionCleanupMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const lock = await this.redis
      .acquireLock("lock:session-cleanup", Math.min(this.config.sessionCleanupMs, 10 * 60_000))
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) {
      this.running = false;
      return;
    }
    try {
      const sessions = await this.sessions.purgeStale(SESSION_RETENTION_MS);
      const purged =
        (await this.kyc.purgeWebhookPayloads()) + (await this.ramp.purgeEventPayloads());
      if (sessions || purged) {
        this.logger.log(
          `cleanup: ${sessions} stale session(s) deleted, ${purged} webhook payload(s) purged`,
        );
      }
    } catch (err) {
      this.logger.error(`cleanup failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "session-cleanup" });
    } finally {
      await lock.release();
      this.running = false;
    }
  }
}
