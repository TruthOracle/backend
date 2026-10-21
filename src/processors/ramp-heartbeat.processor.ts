import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { Config } from "../config";
import { RampReconciliationService } from "../services/ramp-reconciliation.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";
import { MINUTE_MS } from "../util/time";

/** How often the heartbeat looks at the newest full reconciliation run. */
export const RAMP_HEARTBEAT_EVERY_MS = 5 * MINUTE_MS;
const PAGE_EVERY_MS = 60 * MINUTE_MS;

/**
 * Watches the ramp's loops from outside them (C33): pages when no FULL reconciliation run has
 * finished within RAMP_RECON_MAX_AGE_MIN — the reconciliation loop stopped, hung or keeps failing.
 * The gates then refuse every mint and payout (recon_stale), and none of the paged checks (§6.2)
 * can fire any more, so the stall itself pages (at most hourly, one instance). Runs whenever the
 * ramp's loops do (RAMP_SCAN_MS > 0, refused at 0 when prod-like), on its own unref'd timer; with
 * the loops off it says so at boot. Nothing within RAMP_RECON_MAX_AGE_MIN of boot pages (the
 * first scheduled run needs RAMP_RECON_EVERY_MIN). Tests call `check()`.
 */
@Injectable()
export class RampHeartbeatProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RampHeartbeatProcessor.name);
  private timer?: NodeJS.Timeout;
  private readonly bootedAt = Date.now();

  constructor(
    private readonly config: Config,
    private readonly reconciliation: RampReconciliationService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.ramp.scanMs <= 0) {
      this.logger.warn(
        "RAMP_SCAN_MS=0: the order scan, full reconciliation, approval expiry, re-screens, TM-FROZEN-ACTIVITY, bank aging and the re-seal job do not run on this instance",
      );
      return;
    }
    this.timer = setInterval(() => void this.check(), RAMP_HEARTBEAT_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Whether the newest full run is too old (paged at most hourly); its age in minutes, null without one. */
  async check(now = new Date()): Promise<{ stale: boolean; ageMin: number | null }> {
    const maxAgeMin = this.config.rampControls.reconMaxAgeMin;
    try {
      const run = await this.reconciliation.latestFullRun();
      const finishedAt = run?.finishedAt ? new Date(run.finishedAt).getTime() : null;
      const ageMin =
        finishedAt === null ? null : Math.floor((now.getTime() - finishedAt) / MINUTE_MS);
      const booting = now.getTime() - this.bootedAt <= maxAgeMin * MINUTE_MS;
      const stale = !booting && (ageMin === null || ageMin > maxAgeMin);
      if (!stale) return { stale, ageMin };
      const first = await this.redis
        .claimOnce("page:ramp-recon-stale", PAGE_EVERY_MS)
        .catch(() => true);
      if (first) {
        const why =
          ageMin === null
            ? "no full reconciliation run on record"
            : `the newest finished ${ageMin} min ago`;
        this.logger.error(
          `ramp reconciliation is stale (${why}; RAMP_RECON_MAX_AGE_MIN ${maxAgeMin}): the gates refuse mints and payouts`,
        );
        this.sentry.captureMessage("ramp reconciliation is stale", "error", {
          component: "ramp-recon",
          page: "true",
        });
      }
      return { stale, ageMin };
    } catch (err) {
      this.logger.error(`ramp heartbeat failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "ramp-heartbeat" });
      return { stale: true, ageMin: null };
    }
  }
}
