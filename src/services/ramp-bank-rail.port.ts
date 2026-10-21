import { Injectable, Logger } from "@nestjs/common";

import type { RampOrderEntity } from "../entities/ramp-order.entity";
import { ApiError } from "../util/errors";
import { blindIndex, type BlindIndexValue, type Keyring } from "../util/sealed";

/**
 * The bank rail (SPEC §9.4, §10; owned by S6). `POST /ramp/offramp` with `destination {kind:
 * bank, bankAccountId}` asks `validateDestination` (an active, proved BYN IBAN of the same user,
 * the first-payout cap, a bank not blocked) BEFORE the order exists, and RampPolicyService asks
 * again before MarkPaid with the order's id; the order API asks `describe`. S4's admin actions ask
 * `reverseProblem` / `retryProblem` for bank cash-outs (only the bank rail's records can prove that
 * no fiat left). After the burn a bank cash-out waits in `payout_queued` for S6's batches.
 * RampBankAccountsService binds the implementation when the client-money account is configured.
 * Unbound: the rail is unavailable (409 `ramp_rail_unavailable`), nothing is described, and no
 * bank order can be reversed or re-queued.
 */

/** A bank destination as the order API shows it. */
export interface RampBankDestination {
  bankAccountId: string;
  bankName: string | null;
  bic: string | null;
  /** `BY•• •••• … 1234`. */
  ibanMasked: string;
}

export interface RampBankRailImpl {
  /**
   * The account may receive `amount` (P, fiat 1e-10 units) for `userId` now; throws the refusal
   * otherwise. `orderId`: the order being re-checked (it does not count against its own cap).
   */
  validateDestination(
    userId: string,
    bankAccountId: string,
    amount: bigint,
    opts?: { orderId?: string | null },
  ): Promise<RampBankDestination>;
  describe(bankAccountId: string): Promise<RampBankDestination | null>;
  /** `reverse` of a bank cash-out in review: why fiat may have left (null = proven unpaid). */
  reverseProblem?(order: RampOrderEntity): Promise<string | null>;
  /** `retry` into `payout_queued` / `payout_sent`: why not now (null = it may). */
  retryProblem?(
    order: RampOrderEntity,
    target: "payout_queued" | "payout_sent",
  ): Promise<string | null>;
}

/**
 * The blind-index purpose every IBAN hash shares — the user's accounts (S6) and the payer IBAN an
 * acquirer reports (`RampPayer.ibanHash`, S6's `payer_match` proof) — so the two compare.
 */
export const RAMP_IBAN_INDEX_PURPOSE = "ramp-iban";

/** Upper-case, separators dropped: the one form an IBAN is indexed in. */
export function normalizeIbanForIndex(iban: string): string {
  return iban.toUpperCase().replace(/[\s-]/g, "");
}

export function rampIbanIndex(ring: Keyring, iban: string): BlindIndexValue {
  return blindIndex(ring, RAMP_IBAN_INDEX_PURPOSE, normalizeIbanForIndex(iban));
}

const UNBOUND = "the bank rail is not available: no bank record can prove this payout unpaid";

@Injectable()
export class RampBankRailPort implements RampBankRailImpl {
  private readonly logger = new Logger(RampBankRailPort.name);
  private impl: RampBankRailImpl | null = null;

  /** Install the implementation (S6, from its `onModuleInit`); returns the unbind. */
  bind(impl: RampBankRailImpl): () => void {
    if (this.impl && this.impl !== impl) throw new Error("RampBankRailPort is already bound");
    this.impl = impl;
    this.logger.log("bank rail implementation bound");
    return () => {
      if (this.impl === impl) this.impl = null;
    };
  }

  get bound(): boolean {
    return this.impl !== null;
  }

  async validateDestination(
    userId: string,
    bankAccountId: string,
    amount: bigint,
    opts: { orderId?: string | null } = {},
  ): Promise<RampBankDestination> {
    if (!this.impl)
      throw new ApiError(409, "ramp_rail_unavailable", "bank payouts are not available yet", {
        rail: "bank",
      });
    return this.impl.validateDestination(userId, bankAccountId, amount, opts);
  }

  describe(bankAccountId: string): Promise<RampBankDestination | null> {
    return this.impl ? this.impl.describe(bankAccountId) : Promise.resolve(null);
  }

  async reverseProblem(order: RampOrderEntity): Promise<string | null> {
    return this.impl?.reverseProblem ? this.impl.reverseProblem(order) : UNBOUND;
  }

  async retryProblem(
    order: RampOrderEntity,
    target: "payout_queued" | "payout_sent",
  ): Promise<string | null> {
    return this.impl?.retryProblem ? this.impl.retryProblem(order, target) : UNBOUND;
  }
}
