import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";

import { Config } from "../config";
import { IndexerService } from "../services/indexer.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";

/** Consecutive failures back off exponentially between these bounds. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** How often a replica that does not hold the lock tries to take it. */
const LOCK_RETRY_MS = 15_000;

/**
 * Drives `IndexerService.runOnce` (docs/INDEXER.md §3): one replica at a time (Redis lock
 * `lock:ledger-indexer`, renewed every third of its TTL — a holder that dies loses it after the
 * TTL and another replica takes over), as fast as pages arrive while behind, every
 * `INDEXER_POLL_MS` once caught up, with exponential backoff on errors. Started in
 * `onApplicationBootstrap` (Redis and NATS are connected by then); stopped in
 * `beforeApplicationShutdown` so an in-flight transaction commits before Postgres goes away.
 */
@Injectable()
export class LedgerIndexerProcessor implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(LedgerIndexerProcessor.name);
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private inFlight: Promise<void> | null = null;
  private lock: { release(): Promise<void> } | null = null;
  private lockRenewer?: NodeJS.Timeout;
  private failures = 0;

  constructor(
    private readonly config: Config,
    private readonly indexer: IndexerService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.indexer.isEnabled()) {
      this.logger.warn(
        this.config.indexerEnabled
          ? "ledger indexer idle: the ledger is not configured (LEDGER_API_URL / ZKPC_LEDGER_API_URL, TREASURY_PARTY_ID, TRUTHORACLE_PACKAGE_NAME, Keycloak)"
          : "ledger indexer disabled (INDEXER_ENABLED=false); the read API serves whatever was indexed before",
      );
      return;
    }
    this.schedule(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    await this.releaseLock();
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, delayMs);
    this.timer.unref();
  }

  /** One scheduling step: take / keep the lock, run one pass, decide when to run the next. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    if (!(await this.ensureLock())) {
      this.schedule(LOCK_RETRY_MS);
      return;
    }
    try {
      const result = await this.indexer.runOnce();
      this.failures = 0;
      if (result.bootstrapped) this.logger.log("bootstrap complete");
      if (result.applied > 0)
        this.logger.log(
          `applied ${result.applied} transaction(s)${result.seen > result.applied ? ` (${result.seen - result.applied} replayed)` : ""}`,
        );
      this.schedule(result.caughtUp ? this.config.indexerPollMs : 0);
    } catch (err) {
      this.failures += 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(this.failures - 1, 6));
      this.logger.error(
        `pass failed (#${this.failures}): ${(err as Error).message}; retrying in ${delay} ms`,
      );
      if (this.failures === 1 || this.failures % 10 === 0)
        this.sentry.captureException(err, { processor: "ledger-indexer" });
      this.schedule(delay);
    }
  }

  private async ensureLock(): Promise<boolean> {
    if (this.lock) return true;
    const ttl = this.config.indexerLockTtlMs;
    const lock = await this.redis
      .acquireLock("lock:ledger-indexer", ttl)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) return false;
    this.lock = lock;
    this.indexer.running = true;
    this.logger.log("holding the indexer lock — streaming");
    this.lockRenewer = setInterval(
      () => {
        this.redis.pexpire("lock:ledger-indexer", ttl).catch((err: Error) => {
          this.logger.warn(`lock renewal failed: ${err.message}`);
        });
      },
      Math.max(1_000, Math.floor(ttl / 3)),
    );
    this.lockRenewer.unref();
    return true;
  }

  private async releaseLock(): Promise<void> {
    if (this.lockRenewer) clearInterval(this.lockRenewer);
    this.lockRenewer = undefined;
    this.indexer.running = false;
    const lock = this.lock;
    this.lock = null;
    if (lock) await lock.release();
  }
}
