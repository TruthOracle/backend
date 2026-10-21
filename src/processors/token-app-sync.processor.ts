import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { Config } from "../config";
import { type RedisLock, RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";
import {
  TokenAppSyncService,
  TokenSyncAbortedError,
  type TokenSyncPassResult,
} from "../services/token-app-sync.service";

/** Crash ceiling of the cross-instance lock; renewed every third of it while a pass runs. */
export const TOKEN_SYNC_LOCK_TTL_MS = 10 * 60_000;

/**
 * Drives `TokenAppSyncService.syncOnce()` (docs/RAMP.md §7): the timer ticks every
 * `TOKEN_APP_SYNC_SEC` and a pass runs while any token command is unresolved — a mint or burn
 * the ramp waits for — and otherwise every `RAMP_RECON_EVERY_MIN`. `TOKEN_APP_SYNC_SEC=0` turns
 * the loop off (tests drive the service; refused prod-like with the ramp on). The timer is
 * unref'd so it never keeps a process alive; a Redis lock keeps instances from paging together —
 * the status CAS of every match guards the rows either way. The lock is renewed (holder-checked)
 * while the pass runs, so a slow token-app never lets a second instance start an overlapping pass;
 * once a renewal fails the pass stops before it is remembered (C42).
 */
@Injectable()
export class TokenAppSyncProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TokenAppSyncProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly sync: TokenAppSyncService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  onApplicationBootstrap(): void {
    const sec = this.config.tokenCommands.syncSec;
    if (sec === 0) {
      this.logger.log("token-app sync off (TOKEN_APP_SYNC_SEC=0)");
      return;
    }
    this.timer = setInterval(() => void this.tick(), sec * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass when due (or `force`); null when not due or another pass holds the lock. */
  async tick(opts: { force?: boolean } = {}): Promise<TokenSyncPassResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      if (!opts.force && !(await this.due())) return null;
      const lock = await this.redis
        .acquireLock("lock:token-app-sync", TOKEN_SYNC_LOCK_TTL_MS)
        .catch((): RedisLock => ({
          acquired: false,
          release: async () => {},
          renew: async () => false,
        }));
      if (!lock.acquired) return null;
      const held = this.keepRenewed(lock);
      try {
        return await this.sync.syncOnce("schedule", { stillHeld: held.stillHeld });
      } finally {
        held.stop();
        await lock.release();
      }
    } catch (err) {
      if (err instanceof TokenSyncAbortedError) {
        this.logger.warn(`token sync pass stopped: ${err.message}`);
        return null;
      }
      this.logger.error(`token sync pass failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "token-app-sync" });
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Renew `lock` every third of its TTL until `stop()`. A renewal that answers "not yours" or
   * fails (Redis down: the holder can no longer be proven) marks the lock lost for good.
   */
  keepRenewed(
    lock: RedisLock,
    everyMs = TOKEN_SYNC_LOCK_TTL_MS / 3,
  ): { stillHeld: () => boolean; stop: () => void } {
    let held = true;
    const timer = setInterval(() => {
      void lock
        .renew(TOKEN_SYNC_LOCK_TTL_MS)
        .then((ok) => {
          if (!ok) held = false;
        })
        .catch(() => {
          held = false;
        })
        .finally(() => {
          if (!held) clearInterval(timer);
        });
    }, everyMs);
    timer.unref();
    return { stillHeld: () => held, stop: () => clearInterval(timer) };
  }

  /** Fast cadence while a command may still land; else once per reconciliation interval. */
  private async due(): Promise<boolean> {
    if (await this.sync.hasUnresolved()) return true;
    const last = await this.sync.lastPassSummary();
    if (!last) return true;
    return (
      Date.now() - Date.parse(last.finishedAt) >= this.config.tokenCommands.idleSyncMin * 60_000
    );
  }
}
