import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { Config } from "../config";
import { RedisService } from "../services/redis.service";
import { RewardsService, type RewardsScanResult } from "../services/rewards.service";
import { SentryService } from "../services/sentry.service";

/** Crash ceiling for the cross-instance lock; correctness lives in the grant rows' status transitions. */
export const REWARDS_SCAN_LOCK_TTL_MS = 5 * 60_000;

/**
 * Drives `RewardsService.scan()` every `REWARDS_SCAN_MS` (docs/TOKENS.md §4.6): new index rows
 * become queued grants, queued grants are submitted under the float rule, submitted grants are
 * confirmed against the ledger. `REWARDS_ENABLED=false` turns the loop off without touching the
 * rules (an operator can still grant manually; the grants then wait for a process with the loop
 * on). The timer is unref'd so it never keeps a process alive; a Redis lock keeps several
 * instances from scanning together — the deterministic refs and the row transitions guard the
 * ledger either way.
 */
@Injectable()
export class RewardsProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RewardsProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly rewards: RewardsService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.rewardsEnabled) {
      this.logger.log("rewards processor off (REWARDS_ENABLED=false)");
      return;
    }
    if (!this.config.hasRewardsInstrument) {
      this.logger.log("rewards processor idle: no rewards instrument (REWARDS_INSTRUMENT_ADMIN)");
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.config.rewardsScanMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; null when another instance (or this one) is already scanning. */
  async tick(): Promise<RewardsScanResult | null> {
    if (this.running) return null;
    this.running = true;
    const lock = await this.redis
      .acquireLock("lock:rewards", REWARDS_SCAN_LOCK_TTL_MS)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) {
      this.running = false;
      return null;
    }
    try {
      return await this.rewards.scan();
    } catch (err) {
      this.logger.error(`rewards pass failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "rewards" });
      return null;
    } finally {
      await lock.release();
      this.running = false;
    }
  }
}
