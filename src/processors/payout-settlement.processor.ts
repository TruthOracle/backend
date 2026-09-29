import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";

import { Config } from "../config";
import { type ConsumedMessage, NatsService } from "../services/nats.service";
import { PAYOUT_SCAN_LOCK_TTL_MS, PayoutService } from "../services/payout.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";
import { NatsSubjects } from "../types";

/** Durable consumer name (JetStream forbids `.` in it). */
export const KYC_STATUS_CONSUMER = "payout-settlement-kyc-status";

/**
 * Drives `PayoutService` (ARCHITECTURE §9.4): scans PendingPayouts every `PAYOUT_SCAN_MS`
 * (`bond` / `model-prize` settle in-app automatically, `withdraw` settles once the gate allows)
 * and consumes `truthoracle.kyc.status_changed` — an `approved` transition re-queues that user's
 * `blocked_kyc` rows and settles them right away instead of waiting for the next scan.
 *
 * The consumer is started in `onApplicationBootstrap`: Nest runs every provider's `onModuleInit`
 * concurrently, so NatsService may not be connected yet in ours. The timer is unref'd so it
 * never keeps a process alive; a Redis lock keeps multiple instances from scanning together.
 */
@Injectable()
export class PayoutSettlementProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PayoutSettlementProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly payouts: PayoutService,
    private readonly redis: RedisService,
    private readonly nats: NatsService,
    private readonly sentry: SentryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.timer = setInterval(() => void this.tick(), this.config.payoutScanMs);
    this.timer.unref();
    try {
      await this.nats.consume(KYC_STATUS_CONSUMER, NatsSubjects.kycStatusChanged, (msg) => this.onKycStatusChanged(msg));
    } catch (err) {
      // Scanning still works without the consumer; approvals then take effect on the next user retry.
      this.logger.error(`could not start the ${NatsSubjects.kycStatusChanged} consumer: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "payout-settlement" });
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scan, at most one per instance at a time and one across instances (lock). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const lock = await this.redis
      .acquireLock("lock:payout-scan", PAYOUT_SCAN_LOCK_TTL_MS)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) {
      this.running = false;
      return;
    }
    try {
      await this.payouts.scan();
    } catch (err) {
      this.logger.error(`scan failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "payout-settlement" });
    } finally {
      await lock.release();
      this.running = false;
    }
  }

  /**
   * Payload `{ userId, status }` (ids only, never PII). Anything else is terminated — a
   * malformed event will not become correct on redelivery — while a DB failure throws so the
   * message is NAKed and retried.
   */
  async onKycStatusChanged(msg: ConsumedMessage): Promise<void> {
    const data = (typeof msg.data === "object" && msg.data !== null ? msg.data : {}) as Record<string, unknown>;
    const userId = typeof data.userId === "string" ? data.userId : null;
    const status = typeof data.status === "string" ? data.status : typeof data.kycStatus === "string" ? data.kycStatus : null;
    if (!userId || !status) {
      this.logger.warn(`ignoring malformed ${msg.subject} event`);
      msg.term();
      return;
    }
    if (status !== "approved") {
      msg.ack();
      return;
    }
    const requeued = await this.payouts.requeueBlockedKyc(userId);
    msg.ack();
    if (requeued > 0) await this.tick();
  }
}
