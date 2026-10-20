import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { Config } from "../config";
import { ComplianceFreezeService } from "../services/compliance-freeze.service";
import { ComplianceScreeningService } from "../services/compliance-screening.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";
import type { ApiScreeningRun } from "../types";
import { MINUTE_MS } from "../util/time";

/** How often the processor looks for due work (a due re-screen, new ledger activity of frozen accounts). */
export const SCREENING_TICK_MS = MINUTE_MS;
const ACTIVITY_LOCK_TTL_MS = 5 * MINUTE_MS;

/**
 * Screening loop (SPEC §11.6; B1, X6): a full re-screen of every account when one is due — a list
 * version newer than the last complete run, RAMP_RESCREEN_DAYS since it, or an hour after a
 * partial / failed attempt (`lock:compliance-rescreen` inside the service) — and the
 * TM-FROZEN-ACTIVITY scan of what the indexer committed since each freeze was last checked
 * (`lock:compliance-frozen-activity`). Runs with the ramp's loops (`RAMP_SCAN_MS > 0`); the timer
 * is unref'd. Tests call `tick()`.
 */
@Injectable()
export class ComplianceScreeningProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ComplianceScreeningProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly screening: ComplianceScreeningService,
    private readonly freezes: ComplianceFreezeService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.ramp.scanMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), SCREENING_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; null fields when that part did not run (busy, nothing due, or it failed — logged). */
  async tick(): Promise<{ rescreen: ApiScreeningRun | null; frozenActivity: number | null }> {
    if (this.running) return { rescreen: null, frozenActivity: null };
    this.running = true;
    let rescreen: ApiScreeningRun | null = null;
    let frozenActivity: number | null = null;
    try {
      try {
        rescreen = await this.screening.rescreenIfDue();
      } catch (err) {
        this.logger.error(`re-screen failed: ${(err as Error).message}`);
        this.sentry.captureException(err, { processor: "compliance-screening", part: "rescreen" });
      }
      const lock = await this.redis
        .acquireLock("lock:compliance-frozen-activity", ACTIVITY_LOCK_TTL_MS)
        .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
      if (lock.acquired) {
        try {
          frozenActivity = await this.freezes.scanFrozenActivity();
        } catch (err) {
          this.logger.error(`frozen-activity scan failed: ${(err as Error).message}`);
          this.sentry.captureException(err, {
            processor: "compliance-screening",
            part: "activity",
          });
        } finally {
          await lock.release();
        }
      }
    } finally {
      this.running = false;
    }
    return { rescreen, frozenActivity };
  }
}
