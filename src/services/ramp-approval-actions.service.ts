import { Injectable, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

import { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import { ApiError } from "../util/errors";
import { AdminApprovalService } from "./admin-approval.service";
import { AdminService } from "./admin.service";
import { AuditService } from "./audit.service";
import { PayoutService } from "./payout.service";
import {
  describeOrderAction,
  RAMP_ACTIONS,
  RampActionsService,
  type RampOrderSnapshot,
} from "./ramp-actions.service";
import { RampControlsService } from "./ramp-controls.service";
import { RampOrderStore } from "./ramp-order-store.service";
import { UserService } from "./user.service";

/** `txHash` of an operator MarkPaid: a reference, never the ramp's own `ramp:<order>` proof (C1). */
const TX_HASH_RE = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,255}$/;

/** What makes a reinstatement four-eyes (X12 c): money questions are open on the account. */
export interface ReinstateFlags {
  chargebacks: number;
  blockedCards: number;
  ordersInReview: number;
}

/**
 * S4's four-eyes catalogue (SPEC §6.5) for the ramp, payouts and accounts: `ramp.order.<action>`
 * over S2's RampActionsService (a plain `retry` that only re-reads or re-submits under deduped
 * keys is single-control, §4.2), `ramp.controls.resume`, `ramp.payment_method.unblock`,
 * `payout.force_settle`, `payout.mark_paid` (X1) and `user.reinstate` (X12 c, only when the
 * account has a chargeback, a blocked card or a ramp order in review).
 */
@Injectable()
export class RampApprovalActions implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly approvals: AdminApprovalService,
    private readonly actions: RampActionsService,
    private readonly store: RampOrderStore,
    private readonly controls: RampControlsService,
    private readonly payouts: PayoutService,
    private readonly admin: AdminService,
    private readonly users: UserService,
    private readonly audit: AuditService,
    @InjectRepository(RampPaymentMethodEntity)
    private readonly methods: Repository<RampPaymentMethodEntity>,
  ) {}

  onModuleInit(): void {
    for (const action of RAMP_ACTIONS) {
      this.approvals.register<Record<string, never>, RampOrderSnapshot, unknown>({
        action: `ramp.order.${action}`,
        subjectType: "ramp_order",
        requestRoles: ["ops"],
        snapshot: (id) => this.actions.snapshot(id),
        validate: (_p, _s, id) => this.actions.validate(action, id),
        singleControl: async (_p, s) =>
          action === "retry" && (await this.actions.validate("retry", s.id)).singleControl,
        // F2/F8: what it moves (amount and unit) and for whom.
        describe: (_p, s) => describeOrderAction(action, s),
        subjectUser: async (id) => (await this.store.find(id))?.userId ?? null,
        // RampActionsService holds lock:ramp:<id>, re-validates fresh and CASes on the version.
        lockKey: () => null,
        execute: async (_p, s, ctx) =>
          this.store.toAdminApi(
            await this.actions.execute(action, ctx.subjectId, s, {
              actor: ctx.actor,
              reason: ctx.reason,
              approvalId: ctx.approvalId,
            }),
          ),
      });
    }

    this.approvals.register({
      action: "ramp.controls.resume",
      subjectType: "ramp_controls",
      requestRoles: ["ops"],
      snapshot: () => this.controls.snapshot(),
      validate: async () => undefined,
      describe: (_p, s) => `lift the ${s.haltedScopes.join(", ")} halt (since ${s.since ?? "?"})`,
      execute: (_p, _s, ctx) =>
        this.controls.resume(ctx.actor, { approvalId: ctx.approvalId, reason: ctx.reason }),
    });

    this.approvals.register({
      action: "ramp.payment_method.unblock",
      subjectType: "ramp_payment_method",
      requestRoles: ["ops"],
      snapshot: (id) => this.cardSnapshot(id),
      validate: async (_p, s) => {
        if (s.status !== "blocked")
          throw new ApiError(409, "ramp_card_state", `the card is ${s.status}, not blocked`);
      },
      describe: (_p, s) => `unblock card ${s.brand ?? ""} …${s.last4 ?? "????"}`.replace("  ", " "),
      subjectUser: async (_id, _p, s) => s.userId,
      execute: (_p, s, ctx) => this.unblockCard(s.id, ctx),
    });

    this.approvals.register({
      action: "user.reinstate",
      subjectType: "user",
      requestRoles: ["ops"],
      snapshot: (id) => this.userSnapshot(id),
      validate: async (_p, s) => {
        if (s.status === "active")
          throw new ApiError(409, "bad_request", "the account is already active");
        if (s.status === "closed")
          throw new ApiError(409, "user_suspended", "the account is closed");
      },
      describe: (_p, s) =>
        `reinstate an account with ${s.flags.chargebacks} chargeback(s), ${s.flags.blockedCards} blocked card(s), ${s.flags.ordersInReview} order(s) in review`,
      subjectUser: async (id) => id,
      execute: async (_p, _s, ctx) => {
        await this.users.reinstate(ctx.subjectId, ctx.reason, ctx.actor);
        return { ok: true as const };
      },
    });

    this.approvals.register({
      action: "payout.force_settle",
      subjectType: "payout",
      requestRoles: ["ops"],
      snapshot: (cid) => this.payouts.markPaidSnapshot(cid),
      validate: async (_p, s) => {
        if (s.status && ["settled_external", "settled_in_app", "archived"].includes(s.status))
          throw new ApiError(409, "payout_blocked", `the payout is already ${s.status}`, {
            status: s.status,
          });
      },
      describe: (_p, s) =>
        `force-settle ${s.amount ?? "?"} (${s.reason ?? "?"}) held as ${s.status ?? "unseen"}`,
      subjectUser: async (_cid, _p, s) => s.userId,
      // PayoutService serialises on lock:payout:<cid>.
      lockKey: () => null,
      execute: (_p, _s, ctx) =>
        this.admin.settlePayout(ctx.subjectId, { force: true, reason: ctx.reason }, ctx.actor),
    });

    this.approvals.register<
      { txHash: string },
      Awaited<ReturnType<PayoutService["markPaidSnapshot"]>>,
      unknown
    >({
      action: "payout.mark_paid",
      subjectType: "payout",
      requestRoles: ["ops"],
      params: (raw) => {
        const txHash = typeof raw.txHash === "string" ? raw.txHash.trim() : "";
        if (!TX_HASH_RE.test(txHash) || txHash.toLowerCase().startsWith("ramp:"))
          throw new ApiError(
            400,
            "validation_failed",
            "txHash must be the external payment's reference (not ramp:…)",
          );
        return { txHash };
      },
      snapshot: (cid) => this.payouts.markPaidSnapshot(cid),
      validate: async (_p, _s, cid) => {
        await this.payouts.validateMarkPaid(cid);
      },
      describe: (p, s) =>
        `mark ${s.amount ?? "?"} (${s.reason ?? "?"}) paid out of band: ${p.txHash}`,
      subjectUser: async (_cid, _p, s) => s.userId,
      lockKey: () => null,
      execute: async (p, _s, ctx) => {
        const res = await this.payouts.markPaidExternally(
          ctx.subjectId,
          { txHash: p.txHash, reason: ctx.reason, approvalId: ctx.approvalId },
          {
            type: "admin",
            userId: ctx.actor.userId,
            sessionId: ctx.actor.sessionId,
            ip: ctx.actor.ip,
            reason: ctx.reason,
          },
        );
        return { payout: this.payouts.toApi(res.payout, res.onLedger), mode: res.mode };
      },
    });
  }

  /** `POST /admin/users/:id/reinstate` asks this first: any flag makes it four-eyes (X12 c). */
  async reinstateFlags(userId: string): Promise<ReinstateFlags> {
    const [row] = await this.dataSource.query<
      { chargebacks: string; blocked: string; review: string }[]
    >(
      `SELECT (SELECT COUNT(*) FROM to_ramp_orders WHERE user_id = $1 AND (status = 'chargeback' OR details ? 'chargeback'))::text AS chargebacks,
              (SELECT COUNT(*) FROM to_ramp_payment_methods WHERE user_id = $1 AND status = 'blocked')::text AS blocked,
              (SELECT COUNT(*) FROM to_ramp_orders WHERE user_id = $1 AND status = 'needs_review')::text AS review`,
      [userId],
    );
    return {
      chargebacks: Number(row?.chargebacks ?? 0),
      blockedCards: Number(row?.blocked ?? 0),
      ordersInReview: Number(row?.review ?? 0),
    };
  }

  private async userSnapshot(
    userId: string,
  ): Promise<{ userId: string; status: string; flags: ReinstateFlags }> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    return { userId, status: user.status, flags: await this.reinstateFlags(userId) };
  }

  private async cardSnapshot(id: string): Promise<{
    id: string;
    userId: string;
    status: string;
    payoutEligible: boolean;
    brand: string | null;
    last4: string | null;
  }> {
    const m = await this.methods.findOneBy({ id });
    if (!m) throw new ApiError(404, "not_found", "payment method not found");
    return {
      id: m.id,
      userId: m.userId,
      status: m.status,
      payoutEligible: m.payoutEligible,
      brand: m.brand,
      last4: m.last4,
    };
  }

  /**
   * Back to `active`; payout eligibility returns only if the card funded a completed, 3DS-
   * authenticated on-ramp of the account (the closed-loop rule, recomputed — never just restored).
   */
  private async unblockCard(
    id: string,
    ctx: {
      actor: { userId: string; sessionId: string; ip: string | null; type: "admin" };
      approvalId: string;
      reason: string;
    },
  ): Promise<{ id: string; status: string; payoutEligible: boolean }> {
    const [funded] = await this.dataSource.query<{ n: string }[]>(
      `SELECT COUNT(*)::text AS n FROM to_ramp_orders
        WHERE payment_method_id = $1 AND direction = 'onramp' AND status = 'completed' AND details ->> 'threeDs' = 'authenticated'`,
      [id],
    );
    const payoutEligible = Number(funded?.n ?? 0) > 0;
    const res = await this.methods.update(
      { id, status: "blocked" },
      { status: "active", payoutEligible },
    );
    if (!res.affected) throw new ApiError(409, "ramp_card_state", "the card is no longer blocked");
    const m = await this.methods.findOneByOrFail({ id });
    await this.audit.record({
      actorType: "admin",
      actorUserId: ctx.actor.userId,
      actorSessionId: ctx.actor.sessionId,
      action: "ramp.payment_method.unblocked",
      subjectType: "ramp_payment_method",
      subjectId: id,
      metadata: {
        approvalId: ctx.approvalId,
        reason: ctx.reason,
        userId: m.userId,
        payoutEligible,
      },
      ip: ctx.actor.ip,
    });
    return { id: m.id, status: m.status, payoutEligible: m.payoutEligible };
  }
}
