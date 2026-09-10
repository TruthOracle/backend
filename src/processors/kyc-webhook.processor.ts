import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";

import { KycEventProcessingError, KycService } from "../services/kyc.service";
import { type ConsumedMessage, NatsService } from "../services/nats.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";
import type { KycProviderName } from "../types";

/** Durable consumer name (JetStream forbids `.` in it). */
export const KYC_WEBHOOK_CONSUMER = "kyc-webhook-apply";
/** `truthoracle.kyc.webhook.<provider>` — one token, any provider. */
export const KYC_WEBHOOK_FILTER = "truthoracle.kyc.webhook.*";
/**
 * A transient failure (provider API down, DB hiccup) is NAKed with exponential backoff:
 * 5 s, 10 s, 20 s, … capped at 10 min, for up to 20 attempts — a horizon of hours, not the
 * 100 s a fixed 5 s delay would give. Exhausted rows are re-armed by the sweep after a cooldown.
 */
export const KYC_WEBHOOK_NAK_DELAY_MS = 5_000;
export const KYC_WEBHOOK_NAK_DELAY_MAX_MS = 10 * 60_000;
export const KYC_WEBHOOK_MAX_ATTEMPTS = 20;
export const KYC_WEBHOOK_RETRY_COOLDOWN_MS = 60 * 60_000;
/** The sweep re-publishes stored-but-unprocessed events (a publish that failed after the 200). */
export const KYC_WEBHOOK_SWEEP_MS = 5 * 60_000;
export const KYC_WEBHOOK_SWEEP_MIN_AGE_MS = 2 * 60_000;

/** NAK delay for the attempt that just failed (`attempt` ≥ 1). */
export function kycWebhookNakDelayMs(attempt: number): number {
  return Math.min(KYC_WEBHOOK_NAK_DELAY_MAX_MS, KYC_WEBHOOK_NAK_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * Durable consumer of `truthoracle.kyc.webhook.<provider>` (ARCHITECTURE §9.2): the webhook
 * route stores the verified event, answers 200 and publishes `{ eventId }`; this loop re-reads
 * the row and applies the transition (`KycService.applyEvent`), which re-reads the applicant
 * from the provider API before any approval. Expected conditions (stale, sandbox on mainnet,
 * unknown user) are recorded on the row and acked; a retryable failure is NAKed with growing
 * delays until the attempt cap, anything else is terminated and reported. A periodic sweep
 * re-publishes rows whose trigger never made it onto the bus and, after a cooldown, rows the
 * consumer exhausted — so a provider outage delays an approval instead of dropping it. An
 * operator can force one with `POST /admin/kyc/webhooks/:id/replay`.
 */
@Injectable()
export class KycWebhookProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KycWebhookProcessor.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly kyc: KycService,
    private readonly nats: NatsService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.timer = setInterval(() => void this.sweep(), KYC_WEBHOOK_SWEEP_MS);
    this.timer.unref();
    try {
      await this.nats.consume(KYC_WEBHOOK_CONSUMER, KYC_WEBHOOK_FILTER, (msg) => this.onWebhook(msg));
    } catch (err) {
      this.logger.error(`could not start the ${KYC_WEBHOOK_FILTER} consumer: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "kyc-webhook" });
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Payload `{ eventId }` only (ids, never PII). */
  async onWebhook(msg: ConsumedMessage): Promise<void> {
    const data = (typeof msg.data === "object" && msg.data !== null ? msg.data : {}) as Record<string, unknown>;
    const eventId = typeof data.eventId === "string" ? data.eventId : null;
    if (!eventId) {
      this.logger.warn(`ignoring malformed ${msg.subject} event`);
      msg.term();
      return;
    }
    try {
      const outcome = await this.kyc.applyEvent(eventId);
      if (outcome.outcome === "applied" && outcome.changed) {
        this.logger.log(`event ${eventId}: verification ${outcome.verificationId} → ${outcome.status}`);
      }
      msg.ack();
    } catch (err) {
      if (err instanceof KycEventProcessingError) {
        if (err.retryable && err.attempts < KYC_WEBHOOK_MAX_ATTEMPTS) {
          const delay = kycWebhookNakDelayMs(err.attempts);
          this.logger.warn(`event ${eventId}: attempt ${err.attempts} failed (${err.message}); retrying in ${delay} ms`);
          msg.nak(delay);
          return;
        }
        this.logger.error(`event ${eventId}: giving up after ${err.attempts} attempt(s): ${err.message}`);
        this.sentry.captureException(err, { processor: "kyc-webhook", eventId });
        msg.term();
        return;
      }
      // Unknown failure: NatsService NAKs it and JetStream's max_deliver caps the retries.
      throw err;
    }
  }

  /** Re-publish triggers for stored events nobody applied (at most one instance at a time). */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    const lock = await this.redis
      .acquireLock("lock:kyc-webhook-sweep", KYC_WEBHOOK_SWEEP_MS)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) {
      this.sweeping = false;
      return 0;
    }
    let republished = 0;
    try {
      const rows = await this.kyc.unprocessedWebhookEvents(KYC_WEBHOOK_SWEEP_MIN_AGE_MS, KYC_WEBHOOK_MAX_ATTEMPTS, KYC_WEBHOOK_RETRY_COOLDOWN_MS);
      for (const row of rows) {
        const provider: KycProviderName = row.provider === "sumsub" ? "sumsub" : "mock";
        // A distinct msgId per sweep: the original publish used the bare event key and JetStream
        // would otherwise drop the re-publish as a duplicate inside its window.
        await this.kyc.publishWebhookTrigger(provider, row.id, `${row.eventKey}:sweep:${Date.now()}`);
        republished += 1;
      }
      if (republished > 0) this.logger.log(`sweep: re-published ${republished} unprocessed webhook event(s)`);
    } catch (err) {
      this.logger.error(`sweep failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "kyc-webhook" });
    } finally {
      await lock.release();
      this.sweeping = false;
    }
    return republished;
  }
}
