import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { DepositService } from "../services/deposit.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";

/** How often the confirm pass runs; a reconcile holding a user's deposit lock skips that user. */
export const DEPOSIT_CONFIRM_INTERVAL_MS = 60_000;
/** Crash ceiling for the cross-instance lock; correctness lives in the `WHERE status = 'submitted'` transitions. */
export const DEPOSIT_CONFIRM_LOCK_TTL_MS = 5 * 60_000;

/**
 * Periodic confirm pass over `to_deposit_credits` rows still `submitted` (ARCHITECTURE §8.3 step
 * 1): a reconcile that crashed between submit and confirm — or whose immediate confirm saw the
 * command still in flight — is repaired here instead of crediting twice. Runs once at boot
 * (rows a crashed instance left behind are picked up right away, not 60 s later) and then every
 * DEPOSIT_CONFIRM_INTERVAL_MS. Started in `onApplicationBootstrap` (Redis is connected by then);
 * the timer is unref'd so it never keeps a process alive; a Redis lock keeps multiple instances
 * from sweeping together.
 */
@Injectable()
export class DepositConfirmProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DepositConfirmProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly deposits: DepositService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.timer = setInterval(() => void this.tick(), DEPOSIT_CONFIRM_INTERVAL_MS);
    this.timer.unref();
    await this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; null when another instance (or this one) is already sweeping. */
  async tick(): Promise<{ confirmed: number; failed: number } | null> {
    if (this.running) return null;
    this.running = true;
    const lock = await this.redis
      .acquireLock("lock:deposit-confirm", DEPOSIT_CONFIRM_LOCK_TTL_MS)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) {
      this.running = false;
      return null;
    }
    try {
      const result = await this.deposits.confirmPending();
      if (result.confirmed || result.failed) {
        this.logger.log(
          `confirm pass: ${result.confirmed} credit(s) confirmed, ${result.failed} failed`,
        );
      }
      return result;
    } catch (err) {
      this.logger.error(`confirm pass failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "deposit-confirm" });
      return null;
    } finally {
      await lock.release();
      this.running = false;
    }
  }
}
