import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  Not,
  Repository,
  type SelectQueryBuilder,
} from "typeorm";

import { Config } from "../config";
import { PayoutEntity } from "../entities/payout.entity";
import { RampEventEntity } from "../entities/ramp-event.entity";
import type { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import { isDefinitiveNo, isUnresolved } from "../entities/token-command.entity";
import {
  NatsSubjects,
  RAMP_METHODS,
  RAMP_PROVIDER,
  type Actor,
  type ApiRampEventRow,
  type RampEventListStatus,
  type RampOrderStatus,
  type PendingPayoutRecord,
  type RampPayment,
  type RampProvider,
  type RampStep,
} from "../types";
import { eripPaymentNext } from "../util/erip";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";
import { displayPayoutReference, payoutReferenceDigits } from "../util/payout-reference";
import { RotatingScan } from "../util/rotating-scan";
import { seal, unseal } from "../util/sealed";
import { HOUR_MS, MINUTE_MS, toIso } from "../util/time";
import { AdminApprovalService } from "./admin-approval.service";
import { AuditService } from "./audit.service";
import { DepositService, type MintCreditStanding } from "./deposit.service";
import { NatsService } from "./nats.service";
import { PayoutService } from "./payout.service";
import { rampCardAad } from "./ramp-card-sealing.service";
import { RampDisputesService } from "./ramp-disputes.service";
import { RampJournalService } from "./ramp-journal.service";
import {
  creditBackOf,
  RAMP_IN_FLIGHT,
  RampOrderStore,
  type RampCreditBack,
  type RampOrderPatch,
} from "./ramp-order-store.service";
import { RampCompensationService } from "./ramp-compensation.service";
import { RampCardCashoutService } from "./ramp-card-cashout.service";
import { cardPayoutOf } from "./ramp-card-cashout.logic";
import {
  ALLOW,
  RampCompliancePort,
  riskEntry,
  storedDecision,
  type ComplianceDecision,
} from "./ramp-compliance.port";
import { KycIdentityPort, latinName } from "./kyc-identity.port";
import { RampControlsService } from "./ramp-controls.service";
import { RampGatesService } from "./ramp-gates.service";
import { rampPayerAad } from "./ramp-payer-sealing.service";
import { complianceContext, RampReleaseGuard } from "./ramp-release-guard.service";
import {
  eripRefundProblem,
  offrampLedgerOutcome,
  RampPolicyService,
  rampNextProblem,
} from "./ramp-policy.service";
import { rampCommandId, remainderOf } from "./ramp-token-sync.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { TokenCommandService } from "./token-command.service";
import { lastPostOf } from "./token-commands.logic";
import { UserService } from "./user.service";

export { rampCommandId };

/**
 * Crash ceiling for the per-order lock; correctness lives in the order row's versioned CAS. An
 * `advance` stops starting moves after ADVANCE_BUDGET_MS so one never outlives the lock (M6).
 */
export const RAMP_ORDER_LOCK_TTL_MS = 5 * MINUTE_MS;
const ADVANCE_BUDGET_MS = 90_000;
export const RAMP_SCAN_LOCK_TTL_MS = 5 * MINUTE_MS;
/** A checkout still pending this long after its deadline is voided (M7). */
const CHECKOUT_EXPIRY_GRACE_MS = 5 * MINUTE_MS;
/** Re-read a closed or completed card on-ramp this often while RAMP_CLOSED_POLL_HOURS lasts (H6). */
const CLOSED_POLL_EVERY_MS = 15 * MINUTE_MS;
/** Stored events nobody applied are re-published by the sweep once this old (and when due). */
const EVENT_SWEEP_MIN_AGE_MS = 2 * MINUTE_MS;
const NAK_DELAY_MS = 5_000;
const NAK_DELAY_MAX_MS = 10 * MINUTE_MS;
const SCAN_BATCH = 100;

const SYSTEM: Actor = { type: "system" };

/** Back-off after the attempt that just failed (`attempt` ≥ 1): 5 s, 10 s, 20 s, … capped at 10 min; no cap on attempts (E-D1). */
export function rampNakDelayMs(attempt: number): number {
  return Math.min(NAK_DELAY_MAX_MS, NAK_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

/** A webhook could not be applied now: NAK it (retryable), or terminate it (dead / not retryable). */
export class RampEventProcessingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly attempts: number,
    /** The order lock was busy: not an attempt; retry soon. */
    readonly contention = false,
  ) {
    super(message);
  }

  get delayMs(): number {
    return this.contention ? NAK_DELAY_MS : rampNakDelayMs(this.attempts);
  }
}

/** On-ramps a late `succeeded` capture can still reach (→ needs_review, never auto-credited). */
const CLOSED_ONRAMP: readonly RampOrderStatus[] = ["failed", "expired", "cancelled"];
/** Card on-ramps re-read after they closed (H6): late captures, chargebacks, refunds, won disputes. */
const POLLED_AFTER_CLOSE: readonly RampOrderStatus[] = [
  ...CLOSED_ONRAMP,
  "completed",
  "refunded",
  "chargeback",
];

/** A blocked payout row as `details.hold.reason` of its cash-out (SPEC §4.1 withdrawing (stays)). */
const HOLD_REASON_OF: Partial<Record<string, string>> = {
  blocked_payout_gate: "payout_gate",
  blocked_ramp_exposure: "exposure",
  blocked_compliance: "compliance",
};
const MARKPAID_HOLDS: ReadonlySet<string> = new Set(Object.values(HOLD_REASON_OF) as string[]);

/** The holds a step sets and lifts itself (a chargeback hold is the disputes service's). */
const STEP_HOLDS: ReadonlySet<string> = new Set(["payout_gate", "compliance", "frozen"]);

/** How a token command of an order stands for its step. */
type CommandVerdict = "recorded" | "waiting" | "failed" | "overdue";

/** What a `ramp.event.close` approval pins (C31). */
interface EventSnapshot {
  id: string;
  type: string;
  kind: string;
  objectId: string;
  orderId: string | null;
  processedAt: string | null;
  deadAt: string | null;
  replayedAt: string | null;
}

export function eventRowToApi(e: RampEventEntity): ApiRampEventRow {
  return {
    id: e.id,
    provider: e.provider,
    type: e.type,
    kind: e.kind,
    objectId: e.objectId,
    orderId: e.orderId,
    sandbox: e.sandbox,
    occurredAt: e.occurredAt.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    processedAt: toIso(e.processedAt),
    attempts: e.attempts,
    lastAttemptAt: toIso(e.lastAttemptAt),
    nextAttemptAt: toIso(e.nextAttemptAt),
    deadAt: toIso(e.deadAt),
    error: e.error,
    replayedAt: toIso(e.replayedAt),
    closedAt: toIso(e.closedAt),
    closeReason: e.closeReason,
  };
}

/** `<received_at ISO>|<id>` as base64url — opaque to clients (the order list's format). */
function encodeEventCursor(e: { receivedAt: Date; id: string }): string {
  return Buffer.from(`${e.receivedAt.toISOString()}|${e.id}`, "utf8").toString("base64url");
}

function decodeEventCursor(raw: string | undefined): { receivedAt: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const receivedAt = new Date(at ?? "");
  if (Number.isNaN(receivedAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? ""))
    throw new ApiError(400, "validation_failed", "cursor is not valid");
  return { receivedAt, id };
}

/**
 * The ramp's step engine (SPEC §4): applies acquirer events (re-reading the payment first, I2),
 * advances every in-flight order one versioned compare-and-set at a time — mint → credit for an
 * on-ramp; MarkPaid (through PayoutService) → burn → card payout → (reversal) for an off-ramp —
 * and runs the scan. Every token-app command is written in the CAS that records its id and sent
 * once after the commit; nothing re-sends on its own (I3): a command refused, mismatched or
 * unresolved past RAMP_TOKEN_REVIEW_AFTER_MIN sends the order to review. Every provider payout /
 * refund call is preceded by a lookup of its merchant reference; an unreadable answer stops the
 * step without counting an attempt (I7).
 */
@Injectable()
export class RampFulfilmentService implements OnModuleInit {
  private readonly logger = new Logger(RampFulfilmentService.name);
  /** Per scan queue, the last order id this instance's previous pass visited (C17, `rotating`). */
  private readonly scanCursors = new RotatingScan();

  constructor(
    private readonly config: Config,
    private readonly store: RampOrderStore,
    private readonly policy: RampPolicyService,
    private readonly journal: RampJournalService,
    private readonly disputes: RampDisputesService,
    @Inject(RAMP_PROVIDER) private readonly provider: RampProvider,
    @InjectRepository(RampEventEntity) private readonly events: Repository<RampEventEntity>,
    @InjectRepository(RampPaymentMethodEntity)
    private readonly methods: Repository<RampPaymentMethodEntity>,
    @InjectRepository(PayoutEntity) private readonly payoutRows: Repository<PayoutEntity>,
    private readonly tokenCommands: TokenCommandService,
    private readonly deposits: DepositService,
    private readonly payouts: PayoutService,
    private readonly users: UserService,
    private readonly redis: RedisService,
    private readonly nats: NatsService,
    private readonly audit: AuditService,
    private readonly sentry: SentryService,
    private readonly gates: RampGatesService,
    private readonly compensation: RampCompensationService,
    // S5 (SPEC §9): card cash-out by refunds, the ports and the release guard.
    private readonly cashout: RampCardCashoutService,
    private readonly compliance: RampCompliancePort,
    private readonly release: RampReleaseGuard,
    private readonly identity: KycIdentityPort,
    // Review group A: the scan skips paid orders under a mints halt (C17); dead events are closed four-eyes (C31).
    private readonly controls: RampControlsService,
    private readonly approvals: AdminApprovalService,
  ) {}

  onModuleInit(): void {
    this.approvals.register<Record<string, never>, EventSnapshot, unknown>({
      action: "ramp.event.close",
      subjectType: "ramp_event",
      requestRoles: ["ops"],
      snapshot: (id) => this.eventSnapshot(id),
      validate: async (_p, _s, id) => {
        await this.closableEvent(id);
      },
      describe: (_p, s) =>
        `close ${s.kind} event ${s.type} (${s.objectId}${s.deadAt ? ", dead" : ""}) without applying it`,
      subjectUser: async (_id, _p, s) =>
        s.orderId ? ((await this.store.find(s.orderId))?.userId ?? null) : null,
      execute: async (_p, _s, ctx) => ({
        event: await this.closeEvent(ctx.subjectId, {
          actor: ctx.actor,
          reason: ctx.reason,
          approvalId: ctx.approvalId,
        }),
      }),
    });
  }

  private get treasury(): string {
    const treasury = this.config.treasuryPartyId;
    if (!treasury)
      throw new ApiError(502, "upstream_failed", "TREASURY_PARTY_ID is not configured");
    return treasury;
  }

  // ───────────────────────────────────────────── events ─────────────────────────────────────

  /**
   * Apply one stored webhook (RampProcessor's durable consumer). The event names the object; the
   * provider API says what happened to it. A busy order is retried soon without counting an
   * attempt; any other retryable failure backs off (`next_attempt_at`) and, after
   * RAMP_EVENT_DEAD_AFTER_HOURS, the event is dead — never silently dropped (H6, E-D1).
   */
  async applyEvent(eventId: string): Promise<void> {
    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event || event.processedAt || event.deadAt) return;
    if (event.sandbox && this.config.isMainnet) {
      await this.finishEvent(event, null, "sandbox event ignored on mainnet");
      return;
    }
    const order = await this.orderForEvent(event);
    if (!order) {
      const attempts = await this.countEventAttempt(event);
      throw await this.eventFailed(event, attempts, `no order for ${event.objectId} yet`);
    }
    const lock = await this.redis.acquireLock(`lock:ramp:${order.id}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired)
      throw new RampEventProcessingError("order is busy", true, event.attempts, true);
    let attempts = event.attempts;
    try {
      attempts = await this.countEventAttempt(event);
      if (event.kind === "payout") {
        if (order.status === "paying_out") await this.stepOnce(order);
      } else if (event.kind !== "unknown") {
        // payment, chargeback, refund (matched by its refund id, L7): the payment says what happened.
        if (!order.providerPaymentId)
          throw new RampEventProcessingError("order has no payment yet", true, attempts);
        await this.applyPayment(
          order,
          await this.provider.getPayment(order.providerPaymentId),
          "event",
        );
      }
      await this.finishEvent(event, order.id, null);
    } catch (err) {
      const retryable =
        err instanceof RampEventProcessingError || !ApiError.is(err) || err.status >= 500;
      if (!retryable) {
        await this.finishEvent(event, order.id, (err as Error).message);
        return;
      }
      throw await this.eventFailed(event, attempts, (err as Error).message);
    } finally {
      await lock.release();
    }
    await this.advance(order.id);
  }

  private async countEventAttempt(event: RampEventEntity): Promise<number> {
    await this.events.update(
      { id: event.id },
      { attempts: () => "attempts + 1", lastAttemptAt: new Date() },
    );
    event.attempts += 1;
    return event.attempts;
  }

  /**
   * Back off, or — past RAMP_EVENT_DEAD_AFTER_HOURS since it arrived, or since an operator last
   * replayed it (C31: a replay gets a whole new window, not one attempt) — mark it dead and page.
   */
  private async eventFailed(
    event: RampEventEntity,
    attempts: number,
    message: string,
  ): Promise<RampEventProcessingError> {
    const now = Date.now();
    const since = Math.max(event.receivedAt.getTime(), event.replayedAt?.getTime() ?? 0);
    const dead = now - since >= this.config.ramp.eventDeadAfterHours * HOUR_MS;
    await this.events.update(
      { id: event.id },
      {
        error: message.slice(0, 800),
        nextAttemptAt: dead ? null : new Date(now + rampNakDelayMs(attempts)),
        ...(dead ? { deadAt: new Date(now) } : {}),
      },
    );
    if (dead) {
      this.logger.error(
        `ramp event ${event.id} (${event.type}) is dead after ${attempts} attempts`,
      );
      // A dead chargeback is a page (SPEC §6.2 events_dead); the rest is business-hours work.
      this.sentry.captureMessage(
        `ramp webhook dead: ${event.type}`,
        event.kind === "chargeback" ? "error" : "warning",
        { eventId: event.id, kind: event.kind, page: String(event.kind === "chargeback") },
      );
      await this.audit.record({
        actorType: "system",
        action: "ramp.event_dead",
        subjectType: "ramp_event",
        subjectId: event.id,
        metadata: { type: event.type, kind: event.kind, attempts, orderId: event.orderId },
      });
    }
    return new RampEventProcessingError(message, !dead, attempts);
  }

  /**
   * Re-publish triggers for due events nobody applied (a publish lost after the 200, a consumer
   * past JetStream's max_deliver): msgId `eventKey:attempts`, so one attempt is one message.
   */
  async sweepEvents(): Promise<number> {
    const now = new Date();
    const rows = await this.events.find({
      where: [
        {
          processedAt: IsNull(),
          deadAt: IsNull(),
          nextAttemptAt: IsNull(),
          receivedAt: LessThan(new Date(now.getTime() - EVENT_SWEEP_MIN_AGE_MS)),
        },
        { processedAt: IsNull(), deadAt: IsNull(), nextAttemptAt: LessThanOrEqual(now) },
      ],
      order: { receivedAt: "ASC" },
      take: SCAN_BATCH,
    });
    for (const row of rows) {
      await this.nats.publish(
        NatsSubjects.rampWebhook(this.provider.name),
        { eventId: row.id },
        { msgId: `${row.eventKey}:${row.attempts}` },
      );
    }
    return rows.length;
  }

  // ───────────────────────────────────────────── the operator's webhook inbox (C31) ─────────

  /**
   * `GET /admin/ramp/events?status=dead|unprocessed&cursor` — `dead`: failed past their window,
   * nothing retries them; `unprocessed`: every event not applied yet, dead or still backing off
   * (the admin console's two filters). Oldest first; `cursor` is the previous answer's `nextCursor`.
   */
  async listEvents(filter: {
    status: RampEventListStatus;
    cursor?: string;
    limit: number;
  }): Promise<{ items: ApiRampEventRow[]; nextCursor: string | null }> {
    const qb = this.events
      .createQueryBuilder("e")
      .where("e.processed_at IS NULL")
      .orderBy("e.received_at", "ASC")
      .addOrderBy("e.id", "ASC");
    if (filter.status === "dead") qb.andWhere("e.dead_at IS NOT NULL");
    const after = decodeEventCursor(filter.cursor);
    if (after)
      qb.andWhere("(e.received_at, e.id) > (:at, :id)", { at: after.receivedAt, id: after.id });
    const rows = await qb.take(filter.limit + 1).getMany();
    const items = rows.slice(0, filter.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(eventRowToApi),
      nextCursor: rows.length > filter.limit && last ? encodeEventCursor(last) : null,
    };
  }

  /**
   * `POST /admin/ramp/events/:id/replay {reason}` (single control, `ops`): a dead or stuck event
   * is applied again — the provider is re-read (I2), so the purged payload is not needed — with a
   * fresh RAMP_EVENT_DEAD_AFTER_HOURS window. Audited `ramp.event_replayed`.
   */
  async replayEvent(id: string, reason: string, actor: Actor): Promise<ApiRampEventRow> {
    if (!reason?.trim()) throw new ApiError(400, "validation_failed", "a reason is required");
    const event = await this.events.findOne({ where: { id } });
    if (!event) throw new ApiError(404, "not_found", "ramp event not found");
    if (event.processedAt)
      throw new ApiError(
        409,
        "ramp_event_state",
        event.closedAt ? "the event was closed" : "the event was already applied",
      );
    const at = new Date();
    const res = await this.events.update(
      { id, processedAt: IsNull() },
      { deadAt: null, nextAttemptAt: null, replayedAt: at },
    );
    if (!res.affected) throw new ApiError(409, "ramp_event_state", "the event changed meanwhile");
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "ramp.event_replayed",
      subjectType: "ramp_event",
      subjectId: id,
      metadata: {
        reason,
        type: event.type,
        kind: event.kind,
        orderId: event.orderId,
        attempts: event.attempts,
        wasDead: event.deadAt !== null,
      },
      ip: actor.ip ?? null,
    });
    await this.nats.publish(
      NatsSubjects.rampWebhook(this.provider.name),
      { eventId: id },
      { msgId: `${event.eventKey}:replay:${at.getTime()}` },
    );
    return eventRowToApi(await this.events.findOneByOrFail({ id }));
  }

  /** What a `ramp.event.close` request saw. */
  private async eventSnapshot(id: string): Promise<EventSnapshot> {
    const e = await this.events.findOne({ where: { id } });
    if (!e) throw new ApiError(404, "not_found", "ramp event not found");
    return {
      id: e.id,
      type: e.type,
      kind: e.kind,
      objectId: e.objectId,
      orderId: e.orderId,
      processedAt: toIso(e.processedAt),
      deadAt: toIso(e.deadAt),
      replayedAt: toIso(e.replayedAt),
    };
  }

  private async closableEvent(id: string): Promise<RampEventEntity> {
    const e = await this.events.findOne({ where: { id } });
    if (!e) throw new ApiError(404, "not_found", "ramp event not found");
    if (e.processedAt)
      throw new ApiError(
        409,
        "ramp_event_state",
        e.closedAt ? "the event is already closed" : "the event was applied",
      );
    return e;
  }

  /**
   * The four-eyes `ramp.event.close` (`ops` asks, `approver` approves): the event is set aside
   * WITHOUT being applied — nothing re-reads it again and `events_dead` stops counting it. For an
   * event whose effect a person applied by hand, or one about no order of ours. Audited
   * `ramp.event_closed`.
   */
  async closeEvent(
    id: string,
    ctx: { actor: Actor; reason: string; approvalId?: string | null },
  ): Promise<ApiRampEventRow> {
    const e = await this.closableEvent(id);
    const at = new Date();
    const res = await this.events.update(
      { id, processedAt: IsNull() },
      {
        processedAt: at,
        closedAt: at,
        closeReason: ctx.reason.slice(0, 800),
        nextAttemptAt: null,
        error: `closed by an operator: ${ctx.reason}`.slice(0, 800),
      },
    );
    if (!res.affected) throw new ApiError(409, "ramp_event_state", "the event changed meanwhile");
    await this.audit.record({
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId ?? null,
      actorSessionId: ctx.actor.sessionId ?? null,
      action: "ramp.event_closed",
      subjectType: "ramp_event",
      subjectId: id,
      metadata: {
        reason: ctx.reason,
        approvalId: ctx.approvalId ?? null,
        type: e.type,
        kind: e.kind,
        orderId: e.orderId,
        wasDead: e.deadAt !== null,
      },
      ip: ctx.actor.ip ?? null,
    });
    return eventRowToApi(await this.events.findOneByOrFail({ id }));
  }

  private async orderForEvent(event: RampEventEntity): Promise<RampOrderEntity | null> {
    if (event.orderId) {
      const byRef = await this.store.find(event.orderId);
      // The reference must agree with the object, or a forged order id could steer a real payment.
      if (
        byRef &&
        byRef.provider === event.provider &&
        (byRef.providerPaymentId === event.objectId ||
          byRef.providerPayoutId === event.objectId ||
          byRef.providerRefundId === event.objectId ||
          (byRef.providerPaymentId === null && byRef.status === "created"))
      )
        return byRef;
    }
    const byObject = await this.store.orders.findOne({
      where: [
        { provider: event.provider, providerPaymentId: event.objectId },
        { provider: event.provider, providerPayoutId: event.objectId },
        // L7: refund events name the refund.
        { provider: event.provider, providerRefundId: event.objectId },
      ],
    });
    return byObject ? this.store.find(byObject.id) : null;
  }

  private async finishEvent(
    event: RampEventEntity,
    orderId: string | null,
    error: string | null,
  ): Promise<void> {
    await this.events.update(
      { id: event.id },
      {
        processedAt: new Date(),
        nextAttemptAt: null,
        orderId,
        ...(error ? { error: error.slice(0, 800) } : {}),
      },
    );
  }

  // ───────────────────────────────────────────── payments ───────────────────────────────────

  /** Re-read an on-ramp's payment (open checkout, closed order, a step) and apply what the acquirer says. */
  async refreshPayment(orderId: string): Promise<void> {
    const lock = await this.redis.acquireLock(`lock:ramp:${orderId}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired) return;
    try {
      const order = await this.store.find(orderId);
      if (!order?.providerPaymentId) return;
      // The poll throttle only: no version bump, so a 15-minute poll never stales a pending
      // four-eyes approval on the order (C39: burn_uncredited on a charged-back one).
      await this.store.markPolled(order, new Date());
      await this.applyPayment(order, await this.provider.getPayment(order.providerPaymentId));
    } finally {
      await lock.release();
    }
    await this.advance(orderId);
  }

  /**
   * The decision for an on-ramp's payment, by the order's status (SPEC §4.1). `trigger = event`
   * when a verified webhook carried it (the dispute side effects then always run).
   */
  async applyPayment(
    order: RampOrderEntity,
    payment: RampPayment,
    trigger: "event" | "read" = "read",
  ): Promise<void> {
    if (order.direction !== "onramp") return;
    if (payment.orderId && payment.orderId !== order.id) {
      this.logger.error(
        `order ${order.id}: payment ${payment.paymentId} names order ${payment.orderId}`,
      );
      this.sentry.captureMessage("ramp payment reference mismatch", "error", { orderId: order.id });
      return;
    }
    if (payment.status === "chargeback") return this.disputes.chargeback(order, payment, trigger);
    if (payment.status === "chargeback_reversed") return this.disputes.disputeWon(order);
    const captured = payment.capturedAmount !== null;
    switch (order.status) {
      case "created":
        return;
      case "awaiting_payment":
        if (captured) return this.captured(order, payment, ["awaiting_payment"]);
        if (payment.status === "failed") {
          await this.store.transition(
            order,
            ["awaiting_payment"],
            "failed",
            {},
            {
              actor: SYSTEM,
              detail: payment.failureCode ?? "payment failed",
              details: { failureCode: payment.failureCode, threeDs: payment.threeDs },
            },
          );
          return;
        }
        if (payment.status === "expired" || payment.status === "cancelled") {
          await this.store.transition(
            order,
            ["awaiting_payment"],
            "expired",
            {},
            { actor: SYSTEM, detail: "the acquirer closed the checkout" },
          );
          return;
        }
        return this.expireCheckout(order);
      case "failed":
      case "expired":
      case "cancelled":
        if (!captured) return;
        // Money in after we closed the order: never silently kept, never auto-credited (H6).
        this.sentry.captureMessage("ramp capture after the order closed", "warning", {
          orderId: order.id,
        });
        return this.captured(order, payment, [order.status], "captured_after_close");
      case "refunding":
        // Our refund: its step follows it.
        await this.stepOnce(order);
        return;
      default:
        break;
    }
    // paid / minting / crediting / completed / needs_review / refunded / chargeback: money the
    // acquirer took back that no refund of ours explains is a reversal (H4).
    if (
      captured &&
      (payment.status === "failed" ||
        payment.refundedAmount > (await this.cashout.explainedRefunds(order.id)))
    )
      return this.disputes.pspReversal(order, payment, trigger);
  }

  /**
   * A checkout past its deadline + grace is voided at the acquirer before the order expires (M7):
   * `already_paid` is a capture (re-read), `not_cancellable` keeps it open (the payment may still
   * arrive), an unreadable answer changes nothing.
   */
  private async expireCheckout(order: RampOrderEntity): Promise<void> {
    if (!order.expiresAt || Date.now() <= order.expiresAt.getTime() + CHECKOUT_EXPIRY_GRACE_MS)
      return;
    if (!order.providerPaymentId) return;
    let outcome;
    try {
      outcome = await this.provider.cancelPayment(order.providerPaymentId);
    } catch (err) {
      this.logger.warn(`order ${order.id}: voiding the checkout failed: ${(err as Error).message}`);
      return;
    }
    if (outcome === "cancelled") {
      await this.store.transition(
        order,
        ["awaiting_payment"],
        "expired",
        {},
        { actor: SYSTEM, detail: "the checkout was not completed in time" },
      );
      return;
    }
    if (outcome === "already_paid") {
      const payment = await this.provider.getPayment(order.providerPaymentId);
      if (payment.capturedAmount !== null)
        await this.captured(order, payment, ["awaiting_payment"]);
    }
  }

  /**
   * A capture (first observation books `onramp.captured`, whatever the target, #12; SPEC §9.2):
   * every method — C = F (else refund-only, M4), the currency, the method, nothing refunded (H4),
   * the account active; card — 3DS (RAMP_REQUIRE_3DS), one card one account and RAMP_MAX_CARDS
   * (E-D8). The facts land in `details.payment` (M11; the payer name sealed). The compliance port
   * decides `onramp.capture` with the payer data (ERIP: name, its source, the channel — a missing
   * name or an unknown channel are facts for its rules, X14). Problems → needs_review(payment); else
   * a review / deny, or a create-point review still held → needs_review(compliance): the money
   * stays, nothing is minted (I10).
   */
  private async captured(
    order: RampOrderEntity,
    payment: RampPayment,
    from: readonly RampOrderStatus[],
    forcedReview?: string,
  ): Promise<void> {
    const captured = payment.capturedAmount ?? payment.amount;
    const problems: string[] = forcedReview ? [forcedReview] : [];
    if (captured !== order.fiatAmount) problems.push("amount_mismatch");
    if (payment.currency !== order.fiatCurrency) problems.push("currency_mismatch");
    if (payment.method !== order.method) problems.push("method_mismatch");
    if (payment.refundedAmount > 0n || payment.status !== "succeeded")
      problems.push("refunded_by_acquirer");
    if (
      order.method === "card" &&
      this.config.ramp.require3ds &&
      payment.threeDs !== "authenticated"
    )
      problems.push("3ds_missing");
    const user = await this.users.findById(order.userId);
    if (user?.status !== "active") problems.push("account_not_active");
    else if (user.kycStatus === "blocked_duplicate") problems.push("kyc_duplicate_identity");
    const card =
      order.method === "card" && payment.card
        ? await this.saveCard(order, payment)
        : { methodId: null, problem: null };
    if (card.problem) problems.push(card.problem);

    // SPEC §11.4: decided once per order; the payer data is handed over in memory only.
    const decision: ComplianceDecision =
      storedDecision(order.risk, "onramp.capture") ??
      (await this.compliance.check(
        "onramp.capture",
        complianceContext(order, "onramp.capture", {
          fiatAmount: captured,
          payer: payment.payer,
          paymentMethodId: card.methodId,
          cardIssuerCountry: payment.card?.issuerCountry ?? null,
        }),
      )) ??
      ALLOW;
    const patch: RampOrderPatch = {
      paymentMethodId: card.methodId,
      ...(order.capturedAmount === null
        ? { capturedAmount: captured, capturedAt: new Date() }
        : {}),
      refundedAmount: payment.refundedAmount,
      risk: { ...(order.risk ?? {}), "onramp.capture": riskEntry(decision) },
    };
    const details = {
      threeDs: payment.threeDs,
      card: payment.card
        ? {
            brand: payment.card.brand,
            last4: payment.card.last4,
            issuerCountry: payment.card.issuerCountry,
          }
        : null,
      payment: this.paymentFacts(order, payment),
    };
    const within = async (
      m: Parameters<RampJournalService["bookCapture"]>[0],
      fresh: RampOrderEntity,
    ): Promise<void> => {
      await this.journal.bookCapture(m, fresh, payment.fee);
    };
    const createHeld = await this.release.isHeld(order);
    if (problems.length > 0) {
      // C9: a payment problem never hides a compliance review behind it — the operator sees both,
      // and a retry is refused (and the mint step holds) until AML decides.
      const flagged =
        decision.decision !== "allow"
          ? `; compliance onramp.capture: ${decision.decision} (${decision.rules.join(", ") || "no rule named"}) holds it too`
          : createHeld
            ? "; a create-point compliance review holds it too"
            : "";
      await this.store.review(
        order,
        from,
        "payment",
        `${problems.join(", ")}${flagged}`,
        SYSTEM,
        patch,
        { details, within },
      );
      return;
    }
    if (decision.decision !== "allow" || createHeld) {
      await this.store.review(
        order,
        from,
        "compliance",
        decision.decision !== "allow"
          ? `onramp.capture: ${decision.decision} (${decision.rules.join(", ") || "no rule named"})`
          : "a create-point compliance review is still open",
        SYSTEM,
        patch,
        {
          details: {
            ...details,
            complianceHold: { point: "onramp.capture", at: new Date().toISOString() },
          },
          within,
        },
      );
      return;
    }
    await this.store.transition(order, from, "paid", patch, { actor: SYSTEM, details, within });
  }

  /** `details.payment` (SPEC §3.1, M11): the capture facts the operations export and AML need. */
  private paymentFacts(order: RampOrderEntity, payment: RampPayment): Record<string, unknown> {
    const payer = payment.payer;
    return {
      providerTxnId: payment.paymentId,
      method: payment.method,
      rrn: payment.rrn,
      eripTxnId: payment.erip?.transactionId ?? null,
      agentCode: payment.erip?.agentCode ?? null,
      agentName: payment.erip?.agentName ?? null,
      channel: payer?.channel ?? null,
      payerNameSource: payer?.nameSource ?? null,
      payerNameSealed: payer?.name
        ? seal(payer.name, this.config.sealing.data, rampPayerAad(order.userId, order.id))
        : null,
      payerBankBic: payer?.bankBic ?? null,
      payerIbanHash: payer?.ibanHash ?? null,
      cardIssuerName: payment.card?.issuerName ?? null,
      issuerCountry: payment.card?.issuerCountry ?? null,
      threeDs: payment.threeDs,
      fee: payment.fee === null ? null : formatAmount(payment.fee),
      settledAt: payment.settledAt?.toISOString() ?? null,
    };
  }

  /**
   * Upsert the card the payment used: one fingerprint, one account; at most RAMP_MAX_CARDS active
   * per account — a removed card coming back counts too (E-D8). The token is sealed v2 with AAD
   * `ramp-pm|<provider>|<userId>|<id>`. A card the rules refuse is not saved and names the problem.
   */
  private async saveCard(
    order: RampOrderEntity,
    payment: RampPayment,
  ): Promise<{ methodId: string | null; problem: string | null }> {
    const card = payment.card;
    if (!card) return { methodId: null, problem: null };
    const existing = await this.methods.findOne({
      where: { provider: this.provider.name, fingerprint: card.fingerprint },
    });
    const active = (): Promise<number> =>
      this.methods.count({
        where: { userId: order.userId, provider: this.provider.name, status: "active" },
      });
    if (existing) {
      if (existing.userId !== order.userId)
        return { methodId: null, problem: "card_bound_to_another_account" };
      if (existing.status === "blocked") return { methodId: existing.id, problem: "card_blocked" };
      if (existing.status === "removed" && (await active()) >= this.config.ramp.maxCards)
        return { methodId: null, problem: "card_limit" };
      await this.methods.update(
        { id: existing.id },
        { lastUsedAt: new Date(), ...(existing.status === "removed" ? { status: "active" } : {}) },
      );
      return { methodId: existing.id, problem: null };
    }
    if ((await active()) >= this.config.ramp.maxCards)
      return { methodId: null, problem: "card_limit" };
    const id = randomUUID();
    await this.methods
      .createQueryBuilder()
      .insert()
      .values({
        id,
        userId: order.userId,
        provider: this.provider.name,
        fingerprint: card.fingerprint,
        tokenSealed: seal(
          card.token,
          this.config.sealing.data,
          rampCardAad(this.provider.name, order.userId, id),
        ),
        brand: card.brand,
        last4: card.last4,
        expMonth: card.expMonth,
        expYear: card.expYear,
        issuerCountry: card.issuerCountry,
        status: "active",
        payoutEligible: false,
        firstOrderId: order.id,
        lastUsedAt: new Date(),
      })
      .orIgnore()
      .execute();
    // An insert race on the fingerprint is decided by whoever's row is there now.
    const winner = await this.methods.findOne({
      where: { provider: this.provider.name, fingerprint: card.fingerprint },
    });
    if (!winner || winner.userId !== order.userId)
      return { methodId: null, problem: "card_bound_to_another_account" };
    if (winner.id !== id) return { methodId: winner.id, problem: null };
    await this.audit.record({
      actorType: "system",
      action: "ramp.card_saved",
      subjectType: "ramp_payment_method",
      subjectId: id,
      metadata: { userId: order.userId, orderId: order.id, brand: card.brand, last4: card.last4 },
    });
    return { methodId: id, problem: null };
  }

  // ───────────────────────────────────────────── the step engine ────────────────────────────

  /**
   * Advance an order until it waits on someone: one move per pass, under `lock:ramp:<id>`, and no
   * new move once ADVANCE_BUDGET_MS is spent — the next scan continues (M6).
   */
  async advance(orderId: string): Promise<void> {
    const lock = await this.redis.acquireLock(`lock:ramp:${orderId}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired) return;
    const started = Date.now();
    try {
      for (let pass = 0; pass < 8 && Date.now() - started < ADVANCE_BUDGET_MS; pass += 1) {
        const order = await this.store.find(orderId);
        if (!order || !(await this.stepOnce(order))) return;
      }
    } finally {
      await lock.release();
    }
  }

  /** One move for the order's status; `true` = it moved (try the next step). */
  private async stepOnce(order: RampOrderEntity): Promise<boolean> {
    switch (order.status) {
      case "paid":
        return this.startMint(order);
      case "minting":
        return this.mintStep(order);
      case "crediting":
        return this.credit(order);
      case "withdrawing":
        return this.checkWithdrawal(order);
      case "burning":
        return this.burnStep(order);
      case "paying_out":
        return this.payoutStep(order);
      case "reversing":
        return this.reverseStep(order);
      case "refunding":
        return this.refundStep(order);
      case "needs_review":
        return this.creditBackStep(order);
      default:
        return false;
    }
  }

  /**
   * paid → minting (SPEC §4.1): the account is active (M2) and not frozen (S7b; the money stays in
   * needs_review(compliance)), the acquirer STILL shows the capture whole and unrefunded (H4), then
   * ONE transaction records `mint_command_id` + its command row; the POST follows the commit (#8).
   * From here the card value counts in the exposure (M1). The reserve gate (SPEC §6.3: the `mints`
   * halt, a fresh reconciliation, caps, the reserve) runs with the CAS under `lock:ramp-mint-gate`;
   * a refusal leaves the order `paid` with `last_error = reserve_gate:<reason>`.
   */
  private async startMint(order: RampOrderEntity): Promise<boolean> {
    const user = await this.users.findById(order.userId);
    if (user?.status !== "active") {
      await this.store.review(order, ["paid"], "mint", "the account is not active", SYSTEM);
      return false;
    }
    if (await this.release.isFrozen(order.userId)) {
      await this.store.review(
        order,
        ["paid"],
        "compliance",
        "the account is frozen",
        SYSTEM,
        {},
        {
          details: { complianceHold: { point: "freeze", at: new Date().toISOString() } },
        },
      );
      return false;
    }
    // I10 (C9): whatever path reached `paid`, an open compliance review holds the mint; the
    // processor resumes it once AML decides (resumeCleared).
    if (await this.release.isHeld(order)) {
      await this.store.review(
        order,
        ["paid"],
        "compliance",
        "a compliance review holds this order",
        SYSTEM,
        {},
        {
          details: { complianceHold: { point: "onramp.capture", at: new Date().toISOString() } },
        },
      );
      return false;
    }
    // C25: AML decided the payment goes back: never minted — refund / refund_bank from review.
    if (await this.compliance.returnRequested(order.id)) {
      await this.store.review(
        order,
        ["paid"],
        "refund",
        "AML decided to return the payment",
        SYSTEM,
        {},
        { details: { complianceReturn: { at: new Date().toISOString() } } },
      );
      return false;
    }
    if (!order.providerPaymentId) return false;
    // C17: the gate's cheap refusals (a mints halt, a cap, a stale run) before the acquirer is
    // asked — a backlog waiting on the gate costs no PSP read per pass. The gate runs again with
    // the CAS below, under lock:ramp-mint-gate.
    const early = await this.gates.reserveGate(order, "mint");
    if (!early.ok) {
      await this.gateRefused(order, early.reason);
      return false;
    }
    let payment: RampPayment;
    try {
      payment = await this.provider.getPayment(order.providerPaymentId);
    } catch (err) {
      await this.note(order, `payment read failed: ${(err as Error).message}`);
      return false;
    }
    if (
      payment.status !== "succeeded" ||
      payment.capturedAmount !== order.fiatAmount ||
      payment.refundedAmount > 0n
    ) {
      await this.applyPayment(order, payment);
      if ((await this.store.find(order.id))?.status === "paid")
        await this.store.review(
          order,
          ["paid"],
          "payment",
          "the acquirer no longer shows the capture",
          SYSTEM,
        );
      return false;
    }
    const commandId = rampCommandId("mint", order.id);
    let won: boolean;
    try {
      // SPEC §6.3: the reserve gate and the CAS that records the mint hold lock:ramp-mint-gate together.
      const gated = await this.gates.withMintGateLock(async () => {
        const verdict = await this.gates.reserveGate(order, "mint");
        if (!verdict.ok) {
          await this.gateRefused(order, verdict.reason);
          return false;
        }
        return this.store.transition(
          order,
          ["paid"],
          "minting",
          { mintCommandId: commandId, attempts: 0, lastError: null },
          {
            actor: SYSTEM,
            within: async (m) => {
              await this.tokenCommands.recordIntent(m, {
                commandId,
                kind: "mint",
                instrument: { admin: order.instrumentAdmin, id: order.instrumentId },
                party: this.treasury,
                amount: order.tokenAmount,
                source: "ramp",
                ref: order.id,
              });
            },
          },
        );
      });
      won = gated.acquired && gated.value;
    } catch (err) {
      // A command the ledger refuses to even record (instrument, decimals, treasury rule) needs a person.
      if (ApiError.is(err) && err.status < 500) {
        await this.store.review(
          order,
          ["paid"],
          "mint",
          `the mint cannot be recorded: ${err.message}`,
          SYSTEM,
        );
        return false;
      }
      throw err;
    }
    if (!won) return false;
    await this.submitCommand(order, commandId);
    return true;
  }

  /** POST a never-sent command (nothing re-sends one that may have landed, I3). */
  private async submitCommand(order: RampOrderEntity, commandId: string): Promise<void> {
    try {
      await this.tokenCommands.submit(commandId);
    } catch (err) {
      // The row stays pending with 0 attempts: the step submits it again (safe: nothing was sent).
      this.logger.warn(
        `order ${order.id}: submitting ${commandId} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Where an order's token command stands (a compensated mismatch reads as what it was meant to be,
   * RampCompensationService): recorded; waiting (in flight, or just submitted now because it was
   * never sent); failed (rejected / abandoned / mismatch — review at once); overdue
   * (unresolved past RAMP_TOKEN_REVIEW_AFTER_MIN since its last POST, M9).
   */
  private async commandVerdict(
    order: RampOrderEntity,
    commandId: string,
  ): Promise<{ verdict: CommandVerdict; detail: string }> {
    let row = await this.compensation.effectiveRow(commandId);
    // C35: a row never sent is POSTed first — before any overdue rule, or a retry after a
    // token-app outage would bounce straight back to review without ever sending it.
    if (row?.status === "pending" && row.attempts === 0) {
      await this.submitCommand(order, commandId);
      row = (await this.compensation.effectiveRow(commandId)) ?? row;
    }
    if (!row) return { verdict: "failed", detail: `${commandId} has no command row` };
    if (row.status === "recorded") return { verdict: "recorded", detail: "" };
    if (isDefinitiveNo(row.status) || row.status === "mismatch")
      return {
        verdict: "failed",
        detail: `token command ${commandId} is ${row.status}${row.lastError ? `: ${row.lastError}` : ""}`,
      };
    // A row still never sent (token-app unreachable) counts from when it was written or the order
    // last moved (a retry gives it a fresh window); a sent one from its last POST.
    const since =
      row.status === "pending" && row.attempts === 0
        ? Math.max(row.createdAt.getTime(), order.statusChangedAt.getTime())
        : lastPostOf(row).getTime();
    const ageMin = (Date.now() - since) / MINUTE_MS;
    if (isUnresolved(row.status) && ageMin >= this.config.tokenCommands.reviewAfterMin)
      return {
        verdict: "overdue",
        detail: `token command ${commandId} unresolved ${Math.floor(ageMin)} min after its last POST`,
      };
    return { verdict: "waiting", detail: "" };
  }

  /** `minting`: the token sync's hook moves it on record; here only the review rules and the first POST. */
  private async mintStep(order: RampOrderEntity): Promise<boolean> {
    if (!order.mintCommandId) return false;
    const { verdict, detail } = await this.commandVerdict(order, order.mintCommandId);
    if (verdict === "recorded")
      // The hook missed the move (the order was elsewhere when it ran): finish it; the posting is idempotent.
      return this.store.transition(
        order,
        ["minting"],
        "crediting",
        { attempts: 0, lastError: null },
        {
          actor: SYSTEM,
          within: async (m, fresh) => {
            await this.journal.post(m, fresh, "onramp.minted");
          },
        },
      );
    if (verdict === "failed") {
      const row = await this.compensation.effectiveRow(order.mintCommandId);
      // A chargeback was waiting for this mint: it never lands, so the capture is simply reversed.
      if (row && isDefinitiveNo(row.status) && (await this.disputes.resolvePending(order, "no")))
        return false;
      await this.store.review(order, ["minting"], "mint", detail, SYSTEM);
      return false;
    }
    if (verdict === "overdue") await this.store.review(order, ["minting"], "mint", detail, SYSTEM);
    return false;
  }

  /**
   * `crediting`: `UserWallet.Deposit { txRef = mint:<id> }` through DepositService.creditMint
   * (write-ahead row, confirm pass) → completed; the 3DS-authenticated card becomes payout-eligible.
   */
  private async credit(order: RampOrderEntity): Promise<boolean> {
    if (!order.mintCommandId) return false;
    // SPEC §11.6 (B3, S7b): a mint that landed before the freeze is not credited into the frozen
    // wallet — the tokens wait in the treasury (`details.hold`), credited once the freeze lifts.
    if (await this.release.isFrozen(order.userId)) {
      await this.holdFor(order, "frozen", "the account is frozen");
      return false;
    }
    const held = order.details?.hold as { reason?: string } | null | undefined;
    if (held?.reason === "frozen" && !(await this.releaseOwnHold(order))) return false;
    const res = await this.creditDeposit(order, order.mintCommandId, "credit");
    if (res !== "confirmed") return false;
    const threeDs = order.details?.threeDs;
    return this.store.transition(
      order,
      ["crediting"],
      "completed",
      { attempts: 0, lastError: null },
      {
        actor: SYSTEM,
        within: async (manager, fresh) => {
          // Closed loop: a card becomes a cash-out destination once it funded a 3DS-authenticated purchase.
          if (fresh.paymentMethodId && threeDs === "authenticated")
            await manager
              .getRepository(RampPaymentMethodEntity)
              .update({ id: fresh.paymentMethodId, status: "active" }, { payoutEligible: true });
        },
      },
    );
  }

  /**
   * A Deposit of the order's tokens keyed by `keyId` (the mint, the re-mint, or a credit-back's
   * own id): "confirmed", "pending" (submitted or busy), or "failed" (the order went to review /
   * counted an attempt).
   */
  private async creditDeposit(
    order: RampOrderEntity,
    keyId: string,
    step: RampStep,
    amount: bigint = order.tokenAmount,
  ): Promise<"confirmed" | "pending" | "failed"> {
    try {
      const res = await this.deposits.creditMint({
        userId: order.userId,
        instrument: { admin: order.instrumentAdmin, id: order.instrumentId },
        amount,
        mintCommandId: keyId,
        actor: SYSTEM,
      });
      if (step === "credit" && order.creditCommandId !== res.commandId)
        await this.store.bump(order, { creditCommandId: res.commandId }, { actor: SYSTEM });
      if (step === "reversal" && order.remintCreditCommandId !== res.commandId)
        await this.store.bump(order, { remintCreditCommandId: res.commandId }, { actor: SYSTEM });
      return res.status === "confirmed" ? "confirmed" : "pending";
    } catch (err) {
      if (ApiError.is(err) && err.code === "deposit_in_progress") return "pending";
      if (ApiError.is(err) && err.status < 500) {
        if (order.status === "needs_review") await this.note(order, err.message);
        else await this.store.review(order, [order.status], step, err.message, SYSTEM);
        return "failed";
      }
      await this.stepFailed(order, step, err);
      return "failed";
    }
  }

  /**
   * `withdrawing` (SPEC §4.1, C1, M8): only the LEDGER says the cash-out's tokens are ours — the
   * indexed PendingPayout archived by MarkPaid with `txHash = ramp:<id>`, and PayoutService's row
   * `settled_external`; then ONE transaction records the burn id + its command row and the POST
   * follows. Archived by the user's CancelPayout → cancelled. Anything else is in flight: a
   * deferred MarkPaid is mirrored into `details.hold` (the user may still cancel); a payout row
   * that FAILED, or no MarkPaid for RAMP_WITHDRAWING_TIMEOUT_MIN after max(bound, last hold end)
   * → needs_review(withdrawal).
   */
  private async checkWithdrawal(order: RampOrderEntity): Promise<boolean> {
    if (!order.pendingPayoutCid) return false;
    const cid = order.pendingPayoutCid;
    const ledger = offrampLedgerOutcome(await this.policy.payoutOnLedger(cid), order.id);
    let row = await this.payoutRows.findOne({ where: { pendingPayoutCid: cid } });
    if (ledger === "mark_paid") {
      if (row?.status !== "settled_external") {
        // PayoutService records the settlement from the same proof.
        await this.nudgePayout(order, cid);
        row = await this.payoutRows.findOne({ where: { pendingPayoutCid: cid } });
      }
      if (row?.status !== "settled_external" || row.details?.offrampOrderId !== order.id)
        return false;
      const commandId = rampCommandId("burn", order.id);
      let won: boolean;
      try {
        won = await this.store.transition(
          order,
          ["withdrawing"],
          "burning",
          { burnCommandId: commandId, attempts: 0, lastError: null },
          {
            actor: SYSTEM,
            // R1-4: a hold that never lifts by itself (a chargeback) stays: the payout step holds.
            details:
              order.details?.hold &&
              STEP_HOLDS.has((order.details.hold as { reason?: string }).reason ?? "")
                ? { hold: null, holdEndedAt: new Date().toISOString() }
                : {},
            within: async (m) => {
              await this.tokenCommands.recordIntent(m, {
                commandId,
                kind: "burn",
                instrument: { admin: order.instrumentAdmin, id: order.instrumentId },
                party: this.treasury,
                amount: order.tokenAmount,
                source: "ramp",
                ref: order.id,
              });
            },
          },
        );
      } catch (err) {
        if (ApiError.is(err) && err.status < 500) {
          await this.store.review(
            order,
            ["withdrawing"],
            "burn",
            `the burn cannot be recorded: ${err.message}`,
            SYSTEM,
          );
          return false;
        }
        throw err;
      }
      if (!won) return false;
      await this.submitCommand(order, commandId);
      return true;
    }
    if (ledger === "cancelled") {
      // PayoutService records the same proof on its row (archived).
      if (row?.status !== "archived") await this.nudgePayout(order, cid);
      return this.store.transition(
        order,
        ["withdrawing"],
        "cancelled",
        {},
        {
          actor: SYSTEM,
          detail: "the user cancelled the signed withdrawal before MarkPaid",
        },
      );
    }
    if (ledger === "other") {
      await this.store.review(
        order,
        ["withdrawing"],
        "withdrawal",
        "the PendingPayout was archived by something other than our MarkPaid",
        SYSTEM,
      );
      return false;
    }
    if (row?.status === "failed") {
      await this.store.review(
        order,
        ["withdrawing"],
        "withdrawal",
        row.lastError ?? "MarkPaid failed",
        SYSTEM,
      );
      return false;
    }
    // C25: AML decided this cash-out is not paid: PayoutService never MarkPaids it; the order
    // waits for a person in the withdrawal review — `fail` (the PendingPayout live or cancelled by
    // the user), or `credit_back` should a MarkPaid sent before the decision still land.
    if (ledger === "live" && (await this.compliance.returnRequested(order.id))) {
      await this.store.review(
        order,
        ["withdrawing"],
        "withdrawal",
        "AML decided not to pay this cash-out; the user may cancel the withdrawal",
        SYSTEM,
        {},
        order.details?.hold
          ? { details: { hold: null, holdEndedAt: new Date().toISOString() } }
          : {},
      );
      return false;
    }
    // Live, or archived but not indexed yet: in flight.
    const blocked = row?.status.startsWith("blocked_") ?? false;
    const hold = order.details?.hold as { reason?: string } | null | undefined;
    // A deferred MarkPaid reads on the order as SPEC §4.1 names it: payout_gate, exposure, compliance.
    const reason = row ? (HOLD_REASON_OF[row.status] ?? row.status) : undefined;
    const ours = (h: { reason?: string }): boolean =>
      Boolean(h.reason?.startsWith("blocked_") || MARKPAID_HOLDS.has(h.reason ?? ""));
    if (blocked && (!hold || (ours(hold) && hold.reason !== reason))) {
      await this.store.bump(
        order,
        {},
        {
          actor: SYSTEM,
          details: {
            hold: {
              reason,
              detail: row?.lastError ?? null,
              at: new Date().toISOString(),
            },
          },
        },
      );
      return false;
    }
    if (!blocked && hold && ours(hold)) {
      await this.store.bump(
        order,
        {},
        {
          actor: SYSTEM,
          details: {
            hold: null,
            holdEndedAt: new Date().toISOString(),
            holdEndedReason: hold.reason,
          },
        },
      );
    }
    if (!blocked) await this.nudgePayout(order, cid);
    return this.withdrawingTimedOut(order);
  }

  /** An operator resumes a withdrawal whose payout row gave up on MarkPaid (retry, PayoutService §9.4). */
  async resumePayout(cid: string, actor: Actor, reason: string): Promise<void> {
    try {
      await this.payouts.settle(cid, {
        type: actor.type === "admin" ? "admin" : "system",
        userId: actor.userId ?? undefined,
        sessionId: actor.sessionId ?? undefined,
        ip: actor.ip ?? null,
        reason,
      });
    } catch (err) {
      // Blocked or in flight: the payout row says why and the withdrawing step follows it.
      if (!ApiError.is(err)) throw err;
    }
  }

  private async nudgePayout(order: RampOrderEntity, cid: string): Promise<void> {
    try {
      await this.payouts.settle(cid, { type: "system" });
    } catch (err) {
      if (!ApiError.is(err))
        this.logger.warn(`order ${order.id}: payout nudge failed: ${(err as Error).message}`);
    }
  }

  /** M8: no deadline while a deferral holds; it counts from max(bound, end of the last non-compliance hold). */
  private async withdrawingTimedOut(order: RampOrderEntity): Promise<false> {
    const fresh = await this.store.find(order.id);
    if (!fresh || fresh.status !== "withdrawing" || fresh.details?.hold) return false;
    const ended =
      fresh.details?.holdEndedReason !== "compliance" &&
      typeof fresh.details?.holdEndedAt === "string"
        ? Date.parse(fresh.details.holdEndedAt)
        : 0;
    const since = Math.max(fresh.statusChangedAt.getTime(), Number.isNaN(ended) ? 0 : ended);
    if (Date.now() - since < this.config.ramp.withdrawingTimeoutMin * MINUTE_MS) return false;
    await this.store.review(
      fresh,
      ["withdrawing"],
      "withdrawal",
      `MarkPaid did not complete within ${this.config.ramp.withdrawingTimeoutMin} min`,
      SYSTEM,
    );
    return false;
  }

  /**
   * `burning`: the token sync's hook moves it on record (card → paying_out, bank → payout_queued);
   * here only the review rules and the first POST.
   */
  private async burnStep(order: RampOrderEntity): Promise<boolean> {
    if (!order.burnCommandId) return false;
    const { verdict, detail } = await this.commandVerdict(order, order.burnCommandId);
    if (verdict === "recorded")
      return this.store.transition(
        order,
        ["burning"],
        order.payoutRail === "bank" ? "payout_queued" : "paying_out",
        { attempts: 0, lastError: null },
        {
          actor: SYSTEM,
          within: async (m, fresh) => {
            await this.journal.post(m, fresh, "offramp.burned");
          },
        },
      );
    if (verdict === "failed" || verdict === "overdue")
      await this.store.review(order, ["burning"], "burn", detail, SYSTEM);
    return false;
  }

  /**
   * `paying_out` (card; a bank cash-out waits in `payout_queued` for S6's batches). Refund mode
   * (the default, SPEC §9.3): RampCardCashoutService pays it back part by part. OCT mode (the
   * fallback): the account must still be active (M2), the card eligible and issued in
   * RAMP_CARD_PAYOUT_COUNTRIES, the user not frozen and no compliance decision holding it (I10);
   * before EVERY createPayout the acquirer is asked for a payout under this order (I3, #3) — found
   * → adopted (`provider_payout_id` set where still null) and followed; an unreadable lookup sends
   * nothing. The recipient is the verified identity's Latin name (an unreadable identity stops the
   * step, I7). succeeded → completed + `offramp.paid_card`; failed → reversing. The payout gate
   * (SPEC §6.4) runs before createPayout: a refusal defers the step (`details.hold`).
   */
  private async payoutStep(order: RampOrderEntity): Promise<boolean> {
    if (order.payoutRail !== "card") return false;
    const mode = cardPayoutOf(order.details)?.mode ?? this.policy.cardCashoutMode();
    if (mode === "refund") return this.cashout.step(order);
    if (mode !== "oct") {
      await this.store.review(
        order,
        ["paying_out"],
        "payout",
        "card cash-out is not available",
        SYSTEM,
      );
      return false;
    }
    if (!order.providerPayoutId) {
      const user = await this.users.findById(order.userId);
      if (user?.status !== "active") {
        await this.store.review(
          order,
          ["paying_out"],
          "payout",
          "the account is not active",
          SYSTEM,
        );
        return false;
      }
      const method = order.paymentMethodId
        ? await this.methods.findOne({ where: { id: order.paymentMethodId } })
        : null;
      if (
        !method ||
        method.status !== "active" ||
        !method.payoutEligible ||
        method.userId !== order.userId
      ) {
        await this.store.review(
          order,
          ["paying_out"],
          "payout",
          "the destination card is no longer eligible",
          SYSTEM,
        );
        return false;
      }
      if (!this.policy.octCountryAllowed(method)) {
        await this.store.review(
          order,
          ["paying_out"],
          "payout",
          "the card's issuer country cannot receive a card payout",
          SYSTEM,
        );
        return false;
      }
      let existing;
      try {
        existing = await this.provider.findPayoutByOrder(order.id);
      } catch (err) {
        await this.note(order, `payout lookup failed: ${(err as Error).message}`);
        return false;
      }
      if (existing) {
        await this.store.setOnce(order, "providerPayoutId", existing.payoutId);
      } else {
        // SPEC §6.4 / I10: no fiat leaves while the payout gate refuses or a hold applies (details.hold).
        const gate = await this.gates.payoutGate();
        if (!gate.ok) {
          await this.holdFor(order, "payout_gate", `${gate.reason}: ${gate.detail}`);
          return false;
        }
        const held = await this.release.hold(order);
        if (held) {
          await this.holdFor(order, held.reason, held.detail);
          return false;
        }
        // C25: AML decided the value goes back — no card payout; `reverse` re-mints it.
        if (await this.compliance.returnRequested(order.id)) {
          await this.store.review(
            order,
            ["paying_out"],
            "compliance",
            "AML decided not to pay this cash-out out",
            SYSTEM,
          );
          return false;
        }
        if (!(await this.releaseOwnHold(order))) return false;
        let recipient;
        try {
          recipient = latinName(await this.identity.get(order.userId));
        } catch (err) {
          await this.note(order, `identity unreadable: ${(err as Error).message}`);
          return false;
        }
        if (!recipient) {
          await this.store.review(
            order,
            ["paying_out"],
            "payout",
            "no verified name for the card payout recipient",
            SYSTEM,
          );
          return false;
        }
        try {
          const res = await this.provider.createPayout({
            orderId: order.id,
            amount: order.fiatAmount,
            currency: order.fiatCurrency,
            // AAD from the ORDER's user (SPEC §8): a card row repointed at this account never opens.
            cardToken: unseal(
              method.tokenSealed,
              this.config.sealing.data,
              rampCardAad(method.provider, order.userId, method.id),
            ),
            recipient: { firstName: recipient.first, lastName: recipient.last },
            depositRef: displayPayoutReference(order.payoutReference),
            idempotencyKey: order.id,
            notificationUrl: this.notificationUrl(),
          });
          await this.store.setOnce(order, "providerPayoutId", res.payoutId);
          return true;
        } catch (err) {
          await this.stepFailed(order, "payout", err);
          return false;
        }
      }
    }
    if (!order.providerPayoutId) return false;
    let payout;
    try {
      payout = await this.provider.getPayout(order.providerPayoutId);
    } catch (err) {
      await this.note(order, `payout read failed: ${(err as Error).message}`);
      return false;
    }
    if (payout.status === "succeeded") {
      if (payout.amount !== order.fiatAmount || payout.currency !== order.fiatCurrency) {
        await this.store.review(
          order,
          ["paying_out"],
          "payout",
          "the acquirer paid a different amount",
          SYSTEM,
        );
        return false;
      }
      return this.store.transition(
        order,
        ["paying_out"],
        "completed",
        { attempts: 0, lastError: null },
        {
          actor: SYSTEM,
          details: {
            payout: {
              mode: "oct",
              cardLast4: order.paymentMethod?.last4 ?? null,
              executedAt: new Date().toISOString(),
            },
          },
          within: async (m, fresh) => {
            await this.journal.post(m, fresh, "offramp.paid_card");
            // SPEC §5: the acquirer's OCT fee, when it reports one (the settlement true-up catches the rest).
            if (payout.fee !== null && payout.fee > 0n)
              await this.journal.post(m, fresh, "psp.fee_accrued", payout.fee);
          },
        },
      );
    }
    if (payout.status === "failed")
      return this.store.transition(
        order,
        ["paying_out"],
        "reversing",
        { attempts: 0, lastError: payout.failureCode },
        {
          actor: SYSTEM,
          detail: payout.failureCode ?? "card payout failed",
          details: { failureCode: payout.failureCode },
        },
      );
    return false;
  }

  /**
   * `reversing`: the burn stood and no fiat left. Re-mint T under `ramp-remint-<h>` (the id set
   * WHERE still null, with its command row, in one transaction — M6), then — once the sync records
   * it (`offramp.reminted`) — Deposit it back → refunded (no posting here). The re-mint passes the
   * reserve gate first (Δ = T − P; a `mints` halt holds it only for a token-integrity failure).
   */
  private async reverseStep(order: RampOrderEntity): Promise<boolean> {
    // A reverse_remainder (S5) re-mints and credits back only R; a reversal the whole T.
    const remainder = remainderOf(order);
    const amount = remainder ?? order.tokenAmount;
    if (!order.remintCommandId) {
      const commandId = rampCommandId("remint", order.id);
      const gated = await this.gates.withMintGateLock(async () => {
        const verdict = await this.gates.reserveGate(order, "remint", {
          remainder: remainder ?? undefined,
        });
        if (!verdict.ok) {
          await this.gateRefused(order, verdict.reason);
          return false;
        }
        return this.store.bump(
          order,
          { remintCommandId: commandId },
          {
            actor: SYSTEM,
            expect: { remintCommandId: null },
            within: async (m) => {
              await this.tokenCommands.recordIntent(m, {
                commandId,
                kind: "mint",
                instrument: { admin: order.instrumentAdmin, id: order.instrumentId },
                party: this.treasury,
                amount,
                source: "ramp",
                ref: order.id,
              });
            },
          },
        );
      });
      if (!gated.acquired || !gated.value) return false;
      await this.submitCommand(order, commandId);
      return true;
    }
    const { verdict, detail } = await this.commandVerdict(order, order.remintCommandId);
    if (verdict === "failed" || verdict === "overdue") {
      await this.store.review(order, ["reversing"], "reversal", detail, SYSTEM);
      return false;
    }
    if (verdict !== "recorded") return false;
    if (
      (await this.creditDeposit(order, order.remintCommandId, "reversal", amount)) !== "confirmed"
    )
      return false;
    return this.store.transition(
      order,
      ["reversing"],
      "refunded",
      { attempts: 0, lastError: null },
      {
        actor: SYSTEM,
        detail:
          remainder !== null
            ? "the unpaid remainder is back in the in-app wallet"
            : "the payout failed; the amount is back in the in-app wallet",
      },
    );
  }

  /**
   * `refunding` (on-ramp, nothing minted): read the payment first (L6); fully refunded →
   * refunded + `onramp.refunded`. Otherwise look the refund key up (I3): found → follow it (a
   * failed one goes to review); none → refund C − what is already refunded (M4).
   */
  private async refundStep(order: RampOrderEntity): Promise<boolean> {
    if (!order.providerPaymentId) {
      await this.store.review(order, ["refunding"], "refund", "the order has no payment", SYSTEM);
      return false;
    }
    let payment: RampPayment;
    try {
      payment = await this.provider.getPayment(order.providerPaymentId);
    } catch (err) {
      await this.note(order, `payment read failed: ${(err as Error).message}`);
      return false;
    }
    const captured = order.capturedAmount ?? payment.capturedAmount;
    if (captured === null) {
      await this.store.review(
        order,
        ["refunding"],
        "refund",
        "the acquirer shows no capture to refund",
        SYSTEM,
      );
      return false;
    }
    if (payment.refundedAmount >= captured)
      return this.store.transition(
        order,
        ["refunding"],
        "refunded",
        {
          attempts: 0,
          lastError: null,
          refundedAmount: captured,
          // A capture first seen here (it arrived after the order was reviewed) is booked first (#12).
          ...(order.capturedAmount === null
            ? { capturedAmount: captured, capturedAt: new Date() }
            : {}),
        },
        {
          actor: SYSTEM,
          within: async (m, fresh) => {
            await this.journal.bookCapture(m, fresh, payment.fee);
            await this.journal.post(m, fresh, "onramp.refunded");
          },
        },
      );
    const key = `refund-${order.id}`;
    let existing;
    try {
      existing = await this.provider.findRefund(order.providerPaymentId, key);
    } catch (err) {
      await this.note(order, `refund lookup failed: ${(err as Error).message}`);
      return false;
    }
    if (existing) {
      if (!order.providerRefundId)
        await this.store.setOnce(order, "providerRefundId", existing.refundId);
      if (existing.status === "failed")
        await this.store.review(
          order,
          ["refunding"],
          "refund",
          "the acquirer refused the refund",
          SYSTEM,
        );
      return false;
    }
    // SPEC §11.6 / I10: no fiat to a frozen user, nor while a compliance review holds the order.
    const held = await this.release.hold(order, null);
    if (held) {
      await this.holdFor(order, held.reason, held.detail);
      return false;
    }
    if (!(await this.releaseOwnHold(order))) return false;
    // SPEC §9.2: ERIP only when the acquirer refunds it (non-cash, settled long enough); else refund_bank (S6).
    const erip = eripRefundProblem(order.method, payment, this.provider.capabilities);
    if (erip) {
      await this.store.review(order, ["refunding"], "refund", erip, SYSTEM);
      return false;
    }
    try {
      const res = await this.provider.refundPayment(
        order.providerPaymentId,
        captured - payment.refundedAmount,
        key,
        displayPayoutReference(order.payoutReference),
      );
      await this.store.setOnce(order, "providerRefundId", res.refundId);
      return true;
    } catch (err) {
      await this.stepFailed(order, "refund", err);
      return false;
    }
  }

  /**
   * An approved `credit_back` (RampActionsService) in flight: its Deposit is re-run (idempotent on
   * the credit-back key) until confirmed → refunded. Posts nothing: the supply did not change (#1).
   * C1: a Deposit PROVEN never to land is never re-armed under its key — the credit-back failed;
   * one the wallet reports failed less than RAMP_CREDIT_BACK_FINAL_AFTER_MIN ago waits, never
   * re-armed meanwhile; without proof (in progress, a duplicate, an unknown status, a stale index)
   * it stays submitted and is re-run — a later generation only while every earlier one is still
   * proven never to land (`settleCreditBack`).
   */
  private async creditBackStep(order: RampOrderEntity): Promise<boolean> {
    const pending = creditBackOf(order);
    // Only the review credit_back was approved in, while its Deposit is still owed (C1).
    if (
      !pending ||
      pending.state !== "submitted" ||
      (order.reviewStep !== "withdrawal" && order.reviewStep !== "burn")
    )
      return false;
    if ((await this.settleCreditBack(order, pending)) !== "open") return false;
    const res = await this.creditDeposit(order, pending.commandId, "withdrawal");
    if (res === "failed") await this.settleCreditBack(order, pending);
    if (res !== "confirmed") return false;
    return this.store.transition(
      order,
      ["needs_review"],
      "refunded",
      { attempts: 0, lastError: null },
      {
        actor: SYSTEM,
        detail: "credited back: the tokens never left the treasury",
        details: { creditBack: { ...pending, state: "confirmed" } },
      },
    );
  }

  /**
   * C1, before the credit-back's Deposit is (re-)run. `failed`: proven never to land
   * (DepositService.mintCreditStanding) → `state: failed` with the proof and the time, paged once;
   * the order stays in its review with the reason, the scan stops re-running it, and retry or a
   * new credit_back generation reopen. `waiting`: the wallet's failure is not final yet, or an
   * earlier generation is no longer proven never to land — nothing is sent (`last_error` says
   * why). `open`: the Deposit path decides as before.
   */
  private async settleCreditBack(
    order: RampOrderEntity,
    pending: RampCreditBack,
  ): Promise<"failed" | "waiting" | "open"> {
    let standing: MintCreditStanding | null = null;
    try {
      standing = await this.deposits.mintCreditStanding(
        pending.commandId,
        this.creditBackFinality(),
      );
    } catch (err) {
      // Unreadable: nothing is proven (I7).
      this.logger.warn(
        `order ${order.id}: credit-back standing unreadable: ${(err as Error).message}`,
      );
    }
    if (standing?.state === "failed" && standing.proven) {
      const reason = `credit_back ${pending.commandId} failed for good: ${standing.detail ?? "the Deposit failed"}; no Deposit with ${standing.txRef} landed`;
      const won = await this.store.bump(
        order,
        { lastError: reason.slice(0, 800) },
        {
          actor: SYSTEM,
          detail: reason,
          details: {
            creditBack: {
              ...pending,
              state: "failed",
              error: standing.detail,
              failedAt: new Date().toISOString(),
            },
          },
        },
      );
      if (won)
        this.sentry.captureMessage("ramp credit-back failed for good", "error", {
          orderId: order.id,
          commandId: pending.commandId,
        });
      return "failed";
    }
    if (standing?.finalAt) {
      await this.noteOnce(order, `credit_back ${pending.commandId} waits: ${standing.detail}`);
      return "waiting";
    }
    // A (re-)send of this generation: every earlier one must still be proven never to land.
    const sends = !standing || standing.state === "none" || standing.state === "failed";
    if (sends && pending.failed?.length) {
      const earlier = await this.creditBackKeysUnproven({ ...pending, state: "submitted" });
      if (earlier) {
        await this.noteOnce(
          order,
          `credit_back ${pending.commandId} waits: the failed credit back ${earlier.commandId} is not proven never to land: ${earlier.why}`,
        );
        return "waiting";
      }
    }
    return "open";
  }

  /** C1: a credit-back key's wallet failure is final RAMP_CREDIT_BACK_FINAL_AFTER_MIN after its last submission. */
  private creditBackFinality(): { finalAfterMs: number } {
    return { finalAfterMs: this.config.ramp.creditBackFinalAfterMin * MINUTE_MS };
  }

  /**
   * C1: why a credit-back key that failed is not (or no longer) proven never to land — null when
   * the proof holds on fresh reads.
   */
  async creditBackUnproven(commandId: string): Promise<string | null> {
    const standing = await this.deposits.mintCreditStanding(commandId, this.creditBackFinality());
    if (standing.state !== "failed") return `its Deposit is ${standing.state}`;
    return standing.proven ? null : standing.detail;
  }

  /**
   * C1: the first key of a credit-back not (or no longer) proven never to land — every earlier
   * generation (`failed[]`), and the current one once it failed — with why; null when every proof
   * holds on fresh reads. One landing late would credit T a second time: the admin actions ask it
   * before another exit moves T, the step before a later generation is sent.
   */
  async creditBackKeysUnproven(
    cb: RampCreditBack,
  ): Promise<{ commandId: string; why: string } | null> {
    const keys = [
      ...(cb.failed ?? []).map((f) => f.commandId),
      ...(cb.state === "failed" ? [cb.commandId] : []),
    ];
    for (const commandId of keys) {
      let why: string | null;
      try {
        why = await this.creditBackUnproven(commandId);
      } catch (err) {
        why = `unreadable: ${(err as Error).message}`;
      }
      if (why) return { commandId, why };
    }
    return null;
  }

  /** A submission failed: count it; at RAMP_MAX_ATTEMPTS the order goes to the operator. */
  private async stepFailed(order: RampOrderEntity, step: RampStep, err: unknown): Promise<void> {
    const attempts = await this.store.recordAttempt(order, err);
    this.logger.warn(
      `order ${order.id}: ${step} attempt ${attempts} failed: ${(err as Error).message}`,
    );
    if (attempts >= this.config.ramp.maxAttempts && order.status !== "needs_review") {
      await this.store.review(
        order,
        [order.status],
        step,
        `${step} failed ${attempts} times: ${(err as Error).message}`,
        SYSTEM,
      );
      this.sentry.captureMessage(`ramp ${step} failed after ${attempts} attempts`, "error", {
        orderId: order.id,
      });
    }
  }

  /** A read that failed: say why on the order, count nothing (fail closed, I7). */
  private async note(order: RampOrderEntity, message: string): Promise<void> {
    await this.store.bump(order, { lastError: message.slice(0, 800) }, { actor: SYSTEM });
  }

  /** `note`, unless the order already says exactly that (a waiting step writes once, not every pass). */
  private async noteOnce(order: RampOrderEntity, message: string): Promise<void> {
    if (order.lastError !== message.slice(0, 800)) await this.note(order, message);
  }

  /** SPEC §6.3: a refused mint / re-mint stays where it is with `reserve_gate:<reason>`; no attempt counted. */
  private async gateRefused(order: RampOrderEntity, reason: string): Promise<void> {
    const message = `reserve_gate:${reason}`;
    if (order.lastError !== message)
      await this.store.bump(order, { lastError: message }, { actor: SYSTEM });
  }

  /**
   * SPEC §6.4 / I10: a gate, a freeze or a compliance decision defers the step (`details.hold`); a
   * hold of another kind (a chargeback) is left alone.
   */
  private async holdFor(order: RampOrderEntity, reason: string, detail: string): Promise<void> {
    const hold = order.details?.hold as { reason?: string } | null | undefined;
    if (hold && (!STEP_HOLDS.has(hold.reason ?? "") || hold.reason === reason)) return;
    await this.store.bump(
      order,
      { lastError: `${reason}:${detail}`.slice(0, 800) },
      { actor: SYSTEM, details: { hold: { reason, detail, at: new Date().toISOString() } } },
    );
  }

  /** The step may go on: lift its own hold (false = the order moved meanwhile, or another hold stays). */
  private async releaseOwnHold(order: RampOrderEntity): Promise<boolean> {
    const hold = order.details?.hold as { reason?: string } | null | undefined;
    if (!hold) return true;
    if (!STEP_HOLDS.has(hold.reason ?? "")) return false;
    return this.store.bump(
      order,
      { lastError: null },
      {
        actor: SYSTEM,
        details: {
          hold: null,
          holdEndedAt: new Date().toISOString(),
          holdEndedReason: hold.reason,
        },
      },
    );
  }

  // ───────────────────────────────────────────── the scan ───────────────────────────────────

  /**
   * RampProcessor's pass: look up stale `created` orders at the acquirer (H5), expire unsigned
   * withdrawals, poll silent checkouts, re-read recently closed and completed card on-ramps (H6),
   * finish approved credit-backs, advance everything in flight.
   */
  async scan(): Promise<void> {
    const now = Date.now();
    const stale = await this.store.orders.find({
      where: {
        status: "created",
        createdAt: LessThan(new Date(now - this.config.ramp.createdStaleMin * MINUTE_MS)),
      },
      take: SCAN_BATCH,
    });
    for (const order of stale) await this.guard(order.id, () => this.adoptOrFail(order.id));

    const unsigned = await this.store.orders.find({
      where: { status: "awaiting_withdrawal", expiresAt: LessThan(new Date(now)) },
      take: SCAN_BATCH,
    });
    await this.expireUnsigned(unsigned, now);

    // Per method (SPEC §9.2): a card checkout every minute, an ERIP invoice every 5 minutes.
    const checkouts = await this.store.orders.find({
      where: RAMP_METHODS.flatMap((method) => {
        const before = new Date(now - this.config.ramp.method[method].pollMs);
        return [
          {
            status: "awaiting_payment" as const,
            method,
            lastPolledAt: IsNull(),
            createdAt: LessThan(before),
          },
          { status: "awaiting_payment" as const, method, lastPolledAt: LessThan(before) },
        ];
      }),
      order: { createdAt: "ASC" },
      take: SCAN_BATCH,
    });
    for (const order of checkouts) await this.guard(order.id, () => this.refreshPayment(order.id));

    if (this.config.ramp.closedPollHours > 0) {
      const closedSince = new Date(now - this.config.ramp.closedPollHours * HOUR_MS);
      const pollBefore = new Date(now - CLOSED_POLL_EVERY_MS);
      const closed = await this.store.orders.find({
        select: { id: true },
        where: [
          {
            direction: "onramp",
            status: In([...POLLED_AFTER_CLOSE]),
            providerPaymentId: Not(IsNull()),
            statusChangedAt: MoreThan(closedSince),
            lastPolledAt: IsNull(),
          },
          {
            direction: "onramp",
            status: In([...POLLED_AFTER_CLOSE]),
            providerPaymentId: Not(IsNull()),
            statusChangedAt: MoreThan(closedSince),
            lastPolledAt: LessThan(pollBefore),
          },
        ],
        order: { statusChangedAt: "ASC" },
        take: SCAN_BATCH,
      });
      for (const order of closed) await this.guard(order.id, () => this.refreshPayment(order.id));
    }

    const creditBacks = await this.rotating("credit_back", (qb) =>
      qb.where("o.status = 'needs_review' AND o.details -> 'creditBack' ->> 'state' = 'submitted'"),
    );
    for (const id of creditBacks) await this.guard(id, () => this.advance(id));

    // SPEC §11.5: a compliance hold the ports put on an order ends with the AML decision — no approval.
    const held = await this.rotating("compliance_hold", (qb) =>
      qb
        .where("o.status = 'needs_review' AND o.review_step = 'compliance'")
        .andWhere("COALESCE(o.details -> 'complianceHold', 'null'::jsonb) <> 'null'::jsonb"),
    );
    for (const id of held) await this.guard(id, () => this.resumeCleared(id));

    // C17, SPEC §6.1 (credits, burns, card payouts and refunds always run): one bounded batch per
    // in-flight status, so a backlog in one — captures waiting on a mints halt or a cap — never
    // starves the rest; under a mints halt `paid` is not even read (its refusal is recorded once
    // by the webhook / attach advance).
    const mintsHalted = await this.controls.mintsHalted("mint");
    for (const status of RAMP_IN_FLIGHT) {
      if (status === "paid" && mintsHalted) continue;
      const batch = await this.rotating(`in_flight:${status}`, (qb) =>
        qb.where("o.status = :status", { status }),
      );
      for (const id of batch) await this.guard(id, () => this.advance(id));
    }
  }

  /**
   * Unsigned cash-outs past their deadline expire — F5: unless a withdrawal signed in time is live
   * (`RampPolicyService.signedInTime`: PayoutService's binding match, created on the ledger by the
   * deadline, bound to nothing). Then PayoutService is nudged to bind it, as the withdrawing step
   * nudges, for at most RAMP_WITHDRAWAL_BIND_GRACE_MIN past the deadline; after that the order
   * expires as before (the withdrawal then settles as a plain one). Inside the grace an unreadable
   * ledger expires nothing (I7; `last_error` says why).
   */
  private async expireUnsigned(orders: RampOrderEntity[], now: number): Promise<void> {
    const graceMs = this.config.ramp.withdrawalBindGraceMin * MINUTE_MS;
    const inGrace = orders.filter((o) => (o.expiresAt?.getTime() ?? 0) + graceMs > now);
    let signed: Map<string, PendingPayoutRecord> | null = new Map();
    let unreadable = "";
    if (inGrace.length)
      try {
        signed = await this.policy.signedInTime(inGrace);
      } catch (err) {
        signed = null;
        unreadable = (err as Error).message;
      }
    for (const order of orders)
      await this.guard(order.id, async () => {
        if (inGrace.includes(order)) {
          if (!signed) {
            const message = `expiry deferred: the ledger could not be read for a withdrawal signed in time: ${unreadable}`;
            if (order.lastError !== message.slice(0, 800)) await this.note(order, message);
            return;
          }
          const payout = signed.get(order.id);
          if (payout) {
            await this.nudgePayout(order, payout.contractId);
            return;
          }
        }
        await this.store.transition(
          order,
          ["awaiting_withdrawal"],
          "expired",
          {},
          {
            actor: SYSTEM,
            detail: "the withdrawal was not signed in time",
          },
        );
      });
  }

  /**
   * Up to SCAN_BATCH order ids of one scan queue, continuing after the id the previous pass of
   * this instance stopped at and wrapping round (C17, `RotatingScan`): orders that wait write
   * nothing, so a queue read oldest first would never reach the rest.
   */
  private rotating(
    queue: string,
    filter: (qb: SelectQueryBuilder<RampOrderEntity>) => SelectQueryBuilder<RampOrderEntity>,
  ): Promise<string[]> {
    return this.scanCursors.next(
      queue,
      () => filter(this.store.orders.createQueryBuilder("o").select("o.id", "id")),
      SCAN_BATCH,
    );
  }

  /**
   * An order the compliance or freeze port put in needs_review(compliance) (`details.complianceHold`)
   * resumes once nothing holds it: the user is not frozen and the port no longer holds the order.
   * An on-ramp held at capture resumes at `paid` (the mint step re-reads the payment, H4); a
   * chargeback's compliance review (no `complianceHold`) is the operator's.
   */
  async resumeCleared(orderId: string): Promise<void> {
    const lock = await this.redis.acquireLock(`lock:ramp:${orderId}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired) return;
    let resumed: boolean;
    try {
      resumed = await this.releaseIfCleared(orderId);
    } finally {
      await lock.release();
    }
    if (resumed) await this.advance(orderId);
  }

  private async releaseIfCleared(orderId: string): Promise<boolean> {
    const order = await this.store.find(orderId);
    if (order?.status !== "needs_review" || order.reviewStep !== "compliance") return false;
    if (!order.details?.complianceHold || order.direction !== "onramp") return false;
    if (await this.release.isFrozen(order.userId)) return false;
    if (await this.compliance.isHeld(order.id)) return false;
    // C25: AML decided the payment goes back — never minted: the hold ends in the refund review,
    // where refund / refund_bank (four-eyes, still refused for a frozen account) give it back.
    if (await this.compliance.returnRequested(order.id)) {
      const at = new Date().toISOString();
      await this.store.bump(
        order,
        { reviewStep: "refund", lastError: "AML decided to return the payment" },
        {
          actor: SYSTEM,
          detail: "AML decided to return the payment",
          expect: { reviewStep: "compliance" },
          details: {
            complianceHold: null,
            complianceReturn: { at },
            reviewReason: "AML decided to return the payment",
          },
          // The review's step changes in place (no new timeline entry): audited like a move into review.
          within: async (m, fresh) => {
            await this.audit.record(
              {
                actorType: "system",
                action: "ramp.review_required",
                subjectType: "ramp_order",
                subjectId: fresh.id,
                metadata: {
                  direction: fresh.direction,
                  from: "needs_review",
                  to: "needs_review",
                  reviewStep: "refund",
                  previousStep: "compliance",
                  detail: "AML decided to return the payment",
                  userId: fresh.userId,
                },
              },
              m,
            );
          },
        },
      );
      return false;
    }
    return this.store.transition(
      order,
      ["needs_review"],
      "paid",
      { attempts: 0, lastError: null },
      {
        actor: SYSTEM,
        detail: "the compliance hold was released",
        expect: { reviewStep: "compliance" },
        details: { complianceHold: null, complianceReleasedAt: new Date().toISOString() },
      },
    );
  }

  /**
   * H5: a `created` order older than RAMP_CREATED_STALE_MIN (> the adapter's HTTP timeout) whose
   * createPayment answer never reached the order: the acquirer is asked for a payment under its
   * merchant reference — found → adopted (awaiting_payment, then whatever it says); none → failed;
   * unreadable → nothing changes.
   */
  private async adoptOrFail(orderId: string): Promise<void> {
    const lock = await this.redis.acquireLock(`lock:ramp:${orderId}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired) return;
    try {
      const order = await this.store.find(orderId);
      if (order?.status !== "created") return;
      let found: RampPayment | null;
      try {
        found = await this.provider.findPaymentByOrder(order.id);
      } catch (err) {
        await this.note(order, `payment lookup failed: ${(err as Error).message}`);
        return;
      }
      if (!found) {
        await this.store.transition(
          order,
          ["created"],
          "failed",
          {},
          {
            actor: SYSTEM,
            detail: "the payment was never created at the acquirer",
          },
        );
        return;
      }
      const adopted = await this.store.transition(
        order,
        ["created"],
        "awaiting_payment",
        { providerPaymentId: found.paymentId, ...this.adoptedInstructions(order) },
        { actor: SYSTEM, detail: "adopted the acquirer's payment for this order" },
      );
      if (adopted) await this.applyPayment(order, found);
    } finally {
      await lock.release();
    }
  }

  /**
   * An adopted ERIP order's instructions (H5, S8): the lookup answers no `next`, but the details
   * are ours — the acquirer's service code, the reference digits as account number, F — so they
   * are re-derived and validated like a create's (X15). Nothing without a service code.
   */
  private adoptedInstructions(order: RampOrderEntity): Pick<RampOrderPatch, "paymentInstructions"> {
    const serviceCode = this.provider.capabilities.eripServiceCode;
    if (order.method !== "erip" || order.paymentInstructions || !serviceCode) return {};
    const next = eripPaymentNext({
      serviceCode,
      reference: order.payoutReference,
      amount: order.fiatAmount,
      currency: order.fiatCurrency,
      fiatDecimals: this.config.ramp.fiatDecimals,
    });
    const problem = rampNextProblem(next, {
      method: "erip",
      provider: this.provider.name,
      publicAppUrl: this.config.ramp.publicAppUrl,
      checkoutHosts: this.config.ramp.checkoutHosts,
      deeplinkSchemes: this.config.ramp.deeplinkSchemes,
      accountNumber: payoutReferenceDigits(order.payoutReference),
      amount: order.fiatAmount,
      fiatDecimals: this.config.ramp.fiatDecimals,
    });
    if (problem) {
      this.logger.warn(`order ${order.id}: re-derived ERIP details refused (${problem})`);
      return {};
    }
    return { paymentInstructions: next };
  }

  /** One order's failure never stops the pass. */
  private async guard(orderId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`order ${orderId}: ${(err as Error).message}`);
      if (!ApiError.is(err)) this.sentry.captureException(err, { processor: "ramp", orderId });
    }
  }

  notificationUrl(): string {
    const base = this.config.ramp.publicApiUrl;
    return base ? `${base}/webhooks/ramp/${this.provider.name}` : "";
  }
}
