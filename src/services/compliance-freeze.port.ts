import { Injectable, Logger } from "@nestjs/common";

import { ApiError } from "../util/errors";

/**
 * Freezes (SPEC §9.4, §11.6; owner: S7b). A frozen user receives no fiat and the backend prepares
 * no value movement for them (B3, X6). S5 placed every ramp call site: eligibility (GET /ramp and
 * both creates — `ordersDenied`), the mint (paid → minting), MarkPaid, every card refund part /
 * OCT, the on-ramp refund step, the admin actions that send fiat (`refund`, `retry` into a payout
 * or refund step) and plain withdrawals in PayoutService (`blocked_compliance`). S7b's guards
 * outside the ramp call `assertNotFrozen` (market order prepare, deposit reconcile) or `isFrozen`
 * (reward grants, in-app payout settlement, admin mint credits, the on-ramp credit).
 * Implementation: ComplianceScreeningService binds `isFrozen` (an active `to_compliance_freezes`
 * row) and `ordersDenied` (frozen, an open list hit, a confirmed foreign-list hit, or not screenable
 * before a first order). Default (unbound): nobody is frozen. An unreadable source throws (I7).
 */
export interface ComplianceFreezeImpl {
  isFrozen(userId: string): Promise<boolean>;
  /** New orders refused for compliance (default: `isFrozen`). A foreign-list hit denies without freezing (B1). */
  ordersDenied?(userId: string): Promise<boolean>;
  /**
   * C27: screen the account's parties linked since its last screening (a listed one is a hit; a
   * freezing list freezes) — asked by `assertNotFrozen` before a server-prepared value movement.
   */
  screenNewParties?(userId: string): Promise<void>;
}

@Injectable()
export class ComplianceFreezePort implements ComplianceFreezeImpl {
  private readonly logger = new Logger(ComplianceFreezePort.name);
  /** Bound implementations, last one answering: the service at boot, a test stub layered over it. */
  private impls: ComplianceFreezeImpl[] = [];

  /** Install an implementation (from its `onModuleInit`); returns the unbind, which restores the one below. */
  bind(impl: ComplianceFreezeImpl): () => void {
    if (this.impls.includes(impl)) throw new Error("this freeze implementation is already bound");
    if (this.impls.length > 0) this.logger.warn("freeze implementation layered over the bound one");
    this.impls.push(impl);
    this.logger.log("freeze implementation bound");
    return () => {
      this.impls = this.impls.filter((i) => i !== impl);
    };
  }

  private get impl(): ComplianceFreezeImpl | null {
    return this.impls[this.impls.length - 1] ?? null;
  }

  isFrozen(userId: string): Promise<boolean> {
    const impl = this.impl;
    return impl ? impl.isFrozen(userId) : Promise.resolve(false);
  }

  ordersDenied(userId: string): Promise<boolean> {
    const impl = this.impl;
    if (!impl) return Promise.resolve(false);
    return impl.ordersDenied ? impl.ordersDenied(userId) : impl.isFrozen(userId);
  }

  /** C27 / R2b-5: screen the account's parties not screened yet (a failure throws, I7). */
  async screenNewParties(userId: string): Promise<void> {
    const impl = this.impl;
    if (impl?.screenNewParties) await impl.screenNewParties(userId);
  }

  /**
   * The neutral refusal (no tipping-off): the same 403 whatever the reason. A party linked since
   * the account's last screening is screened first (C27; a failure to screen throws, I7).
   */
  async assertNotFrozen(userId: string): Promise<void> {
    await this.screenNewParties(userId);
    if (await this.isFrozen(userId))
      throw new ApiError(403, "forbidden", "this operation is not available for this account");
  }
}
