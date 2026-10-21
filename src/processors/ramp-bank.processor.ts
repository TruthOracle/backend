import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { Config } from "../config";
import { RampBankAccountsService } from "../services/ramp-bank-accounts.service";
import { RampBankBatchesService } from "../services/ramp-bank-batches.service";
import { RampBankRail } from "../services/ramp-bank-rail.service";
import { SentryService } from "../services/sentry.service";
import { MINUTE_MS } from "../util/time";

/** How often accounts are promoted and submitted payouts aged. */
const BANK_TICK_MS = 5 * MINUTE_MS;

/**
 * The bank rail's housekeeping (SPEC §10.2, §4.1): accounts whose cooling-off ended move on to
 * `pending_proof` / `active` (a payer match may have arrived since), `payout_sent` orders with
 * no debit after RAMP_BANK_SETTLE_DAYS business days go to needs_review(payout), and (C25) bank
 * cash-outs whose alert AML returned are stopped where they still can be, else flagged. Runs with
 * the ramp's loops (`RAMP_SCAN_MS > 0`); the timer is unref'd. Tests call `tick()`.
 */
@Injectable()
export class RampBankProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RampBankProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly accounts: RampBankAccountsService,
    private readonly rail: RampBankRail,
    private readonly sentry: SentryService,
    private readonly batches: RampBankBatchesService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.ramp.scanMs <= 0 || !this.accounts.configured) return;
    this.timer = setInterval(() => void this.tick(), BANK_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<{ promoted: number; aged: number; returned: number }> {
    if (this.running) return { promoted: 0, aged: 0, returned: 0 };
    this.running = true;
    try {
      const promoted = await this.accounts.promoteDue();
      const aged = await this.rail.ageSent(now);
      if (aged > 0) this.logger.warn(`${aged} bank payout(s) without a debit went to review`);
      const returned = await this.batches.amlReturns();
      if (returned > 0) this.logger.warn(`${returned} bank cash-out(s) AML returned were stopped`);
      return { promoted, aged, returned };
    } catch (err) {
      this.logger.error(`bank rail pass failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "ramp-bank" });
      return { promoted: 0, aged: 0, returned: 0 };
    } finally {
      this.running = false;
    }
  }
}
