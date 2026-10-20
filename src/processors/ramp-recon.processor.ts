import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { Config } from "../config";
import { AdminApprovalService } from "../services/admin-approval.service";
import { RampReconciliationService } from "../services/ramp-reconciliation.service";
import { SentryService } from "../services/sentry.service";
import { MINUTE_MS } from "../util/time";

/**
 * The scheduled reconciliation (SPEC §6.2): a FULL run every RAMP_RECON_EVERY_MIN under
 * `lock:ramp-recon` (one instance runs it; the others skip), and the sweep that marks pending
 * four-eyes approvals past their business-day TTL as expired. Runs with the ramp's loops
 * (`RAMP_SCAN_MS > 0`); the timer is unref'd. Tests call `tick()`.
 */
@Injectable()
export class RampReconProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RampReconProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly reconciliation: RampReconciliationService,
    private readonly approvals: AdminApprovalService,
    private readonly sentry: SentryService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.ramp.scanMs <= 0) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.config.rampControls.reconEveryMin * MINUTE_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const run = await this.reconciliation.runFull("schedule");
      if (run && run.status !== "green")
        this.logger.warn(
          `reconciliation ${run.status}: ${run.checks
            .filter((c) => c.status !== "green")
            .map((c) => `${c.name}=${c.status}`)
            .join(", ")}`,
        );
      const expired = await this.approvals.expireStale();
      if (expired > 0) this.logger.log(`expired ${expired} pending approval(s)`);
    } catch (err) {
      this.logger.error(`reconciliation pass failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "ramp-recon" });
    } finally {
      this.running = false;
    }
  }
}
