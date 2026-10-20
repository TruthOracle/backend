import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { Config } from "../config";
import { type ConsumedMessage, NatsService } from "../services/nats.service";
import {
  RAMP_SCAN_LOCK_TTL_MS,
  RampEventProcessingError,
  RampFulfilmentService,
} from "../services/ramp-fulfilment.service";
import { RedisService } from "../services/redis.service";
import { type ResealPassResult, SealedDataService } from "../services/sealed-data.service";
import { SentryService } from "../services/sentry.service";
import { HOUR_MS, MINUTE_MS } from "../util/time";

/** Re-seal job cadence (SPEC §8); after a pass that found nothing it waits an hour (rolling deploys may still write old kids). */
export const RESEAL_EVERY_MS = MINUTE_MS;
const RESEAL_IDLE_MS = HOUR_MS;
const RESEAL_LOCK_TTL_MS = 5 * MINUTE_MS;

/** Durable consumer name (JetStream forbids `.` in it). */
export const RAMP_WEBHOOK_CONSUMER = "ramp-webhook-apply";
/** `truthoracle.ramp.webhook.<provider>` — one token, any provider. */
export const RAMP_WEBHOOK_FILTER = "truthoracle.ramp.webhook.*";

/**
 * The fiat ramp's loops (SPEC §3.3, §4): the durable consumer of
 * `truthoracle.ramp.webhook.<provider>` (the webhook route stores the verified event, answers 200
 * and publishes `{ eventId }`; this applies it — which re-reads the acquirer first — NAKing a
 * retryable failure with growing delays and no attempt cap: only a dead event (failing for
 * RAMP_EVENT_DEAD_AFTER_HOURS) or a non-retryable one is terminated), and the scan every
 * RAMP_SCAN_MS (0 = off): stale orders looked up, silent checkouts and recently closed on-ramps
 * polled, in-flight orders advanced, due events re-published. It runs whatever RAMP_ENABLED says — the kill switch stops new
 * orders, never the ones already holding someone's money. A Redis lock keeps instances from
 * scanning together; per-order locks and compare-and-set transitions guard the money either way.
 * With the scan on, the re-seal job (SPEC §8) runs every RESEAL_EVERY_MS under its own lock.
 */
@Injectable()
export class RampProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RampProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private resealTimer?: NodeJS.Timeout;
  private resealing = false;
  private resealIdleUntil = 0;

  constructor(
    private readonly config: Config,
    private readonly fulfilment: RampFulfilmentService,
    private readonly nats: NatsService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
    private readonly sealed: SealedDataService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.ramp.scanMs > 0) {
      this.timer = setInterval(() => void this.tick(), this.config.ramp.scanMs);
      this.timer.unref();
      this.resealTimer = setInterval(() => void this.resealTick(), RESEAL_EVERY_MS);
      this.resealTimer.unref();
    }
    try {
      await this.nats.consume(RAMP_WEBHOOK_CONSUMER, RAMP_WEBHOOK_FILTER, (msg) =>
        this.onWebhook(msg),
      );
    } catch (err) {
      this.logger.error(
        `could not start the ${RAMP_WEBHOOK_FILTER} consumer: ${(err as Error).message}`,
      );
      this.sentry.captureException(err, { processor: "ramp" });
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.resealTimer) clearInterval(this.resealTimer);
  }

  /**
   * The re-seal job (SPEC §8): moves sealed values and blind indexes onto the active kids through
   * every registered re-sealer / re-indexer, one instance at a time. Retiring a key = this pass
   * reports nothing left (boot refuses to drop a kid rows still use). Returns null when skipped.
   */
  async resealTick(force = false): Promise<ResealPassResult | null> {
    if (this.resealing || (!force && Date.now() < this.resealIdleUntil)) return null;
    this.resealing = true;
    const lock = await this.redis
      .acquireLock("lock:reseal", RESEAL_LOCK_TTL_MS)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) {
      this.resealing = false;
      return null;
    }
    try {
      const result = await this.sealed.resealPass();
      if (result.resealed + result.reindexed > 0 || result.failed > 0) {
        this.logger.log(
          `re-seal pass: ${result.resealed} re-sealed, ${result.reindexed} re-indexed, ${result.failed} failed`,
        );
      }
      // Nothing left: idle an hour (rolling deploys). Work done (a rotation under way, or a forced
      // pass while idle): the scheduled passes run again at once until nothing is left (S8).
      this.resealIdleUntil =
        result.resealed + result.reindexed === 0 ? Date.now() + RESEAL_IDLE_MS : 0;
      return result;
    } catch (err) {
      this.logger.error(`re-seal pass failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "ramp-reseal" });
      return null;
    } finally {
      await lock.release();
      this.resealing = false;
    }
  }

  /** Payload `{ eventId }` only. */
  async onWebhook(msg: ConsumedMessage): Promise<void> {
    const data = (typeof msg.data === "object" && msg.data !== null ? msg.data : {}) as Record<
      string,
      unknown
    >;
    const eventId = typeof data.eventId === "string" ? data.eventId : null;
    if (!eventId) {
      this.logger.warn(`ignoring malformed ${msg.subject} event`);
      msg.term();
      return;
    }
    try {
      await this.fulfilment.applyEvent(eventId);
      msg.ack();
    } catch (err) {
      if (err instanceof RampEventProcessingError) {
        if (err.retryable) {
          // The row's next_attempt_at drives the sweep too: a message JetStream drops is re-published.
          this.logger.warn(
            `ramp event ${eventId}: ${err.contention ? "order busy" : `attempt ${err.attempts} failed`} (${err.message}); retrying in ${err.delayMs} ms`,
          );
          msg.nak(err.delayMs);
          return;
        }
        this.logger.error(
          `ramp event ${eventId}: dead after ${err.attempts} attempt(s): ${err.message}`,
        );
        this.sentry.captureException(err, { processor: "ramp", eventId });
        msg.term();
        return;
      }
      // Unknown failure: NatsService NAKs it and JetStream's max_deliver caps the retries.
      throw err;
    }
  }

  /** One pass (at most one instance at a time). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const lock = await this.redis
      .acquireLock("lock:ramp-scan", RAMP_SCAN_LOCK_TTL_MS)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) {
      this.running = false;
      return;
    }
    try {
      await this.fulfilment.scan();
      const republished = await this.fulfilment.sweepEvents();
      if (republished > 0)
        this.logger.log(`sweep: re-published ${republished} unapplied ramp event(s)`);
    } catch (err) {
      this.logger.error(`ramp pass failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "ramp" });
    } finally {
      await lock.release();
      this.running = false;
    }
  }
}
