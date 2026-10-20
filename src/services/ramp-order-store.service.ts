import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, Repository } from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";

import { RampOrderEntity } from "../entities/ramp-order.entity";
import type { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import {
  NatsSubjects,
  type Actor,
  type ApiAdminRampOrder,
  type ApiRampDestination,
  type ApiRampOrder,
  type ApiRampPaymentMethod,
  type ApiRampTimelineEntry,
  type InstrumentRef,
  type RampCardCashoutMode,
  type RampDirection,
  type RampOrderStatus,
  type RampPaymentNext,
  type RampStep,
} from "../types";
import { formatAmount } from "../util/money";
import { displayPayoutReference, PAYOUT_REFERENCE_RE } from "../util/payout-reference";
import { toIso } from "../util/time";
import { AuditService } from "./audit.service";
import { InstrumentsService } from "./instruments.service";
import { NatsService } from "./nats.service";

/**
 * The legal moves of SPEC §4. Every write is checked against it before the compare-and-set, so a
 * caller can only lose a race, never make an illegal move. Closed on-ramps (failed / expired /
 * cancelled) may still go to `needs_review` (a late capture) or `chargeback`; `completed` only to
 * `chargeback` (on) or `reversing` (an off-ramp's bank return, S6). `payout_queued` /
 * `payout_sent` serve off-ramp bank payouts AND on-ramp bank refunds (S5 / S6 drive them).
 */
export const RAMP_TRANSITIONS: Readonly<Record<RampOrderStatus, readonly RampOrderStatus[]>> = {
  created: ["awaiting_payment", "failed"],
  awaiting_payment: ["paid", "needs_review", "failed", "expired", "cancelled", "chargeback"],
  paid: ["minting", "needs_review", "chargeback"],
  minting: ["crediting", "needs_review", "chargeback"],
  crediting: ["completed", "needs_review", "chargeback"],
  awaiting_withdrawal: ["withdrawing", "expired", "cancelled"],
  withdrawing: ["burning", "cancelled", "needs_review"],
  burning: ["paying_out", "payout_queued", "needs_review"],
  paying_out: ["completed", "reversing", "needs_review"],
  payout_queued: ["payout_sent", "needs_review"],
  payout_sent: ["completed", "refunded", "reversing", "needs_review"],
  reversing: ["refunded", "needs_review"],
  refunding: ["refunded", "needs_review"],
  needs_review: [
    "paid",
    "minting",
    "crediting",
    "withdrawing",
    "burning",
    "paying_out",
    "payout_queued",
    "payout_sent",
    "reversing",
    "refunding",
    "refunded",
    "completed",
    "failed",
    "chargeback",
  ],
  completed: ["chargeback", "reversing"],
  failed: ["needs_review", "chargeback"],
  expired: ["needs_review", "chargeback"],
  cancelled: ["needs_review", "chargeback"],
  // Only the bank returning an on-ramp's bank refund (S8: refund.returned_bank, review step refund).
  refunded: ["needs_review"],
  // Only a dispute won after refund_cancel (C19): the bank refund is owed again
  // (onramp.refund_reinstated, review step refund).
  chargeback: ["needs_review"],
};

/** Statuses the step engine never advances (a late capture, chargeback or bank return aside). */
export const RAMP_TERMINAL: ReadonlySet<RampOrderStatus> = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "chargeback",
]);

/** Statuses the processor advances on every scan (the bank statuses move by batches and statements, S6). */
export const RAMP_IN_FLIGHT: readonly RampOrderStatus[] = [
  "paid",
  "minting",
  "crediting",
  "withdrawing",
  "burning",
  "paying_out",
  "reversing",
  "refunding",
];

/** Statuses that do not count toward the velocity limits: no money moved, or it went back. */
export const RAMP_UNCOUNTED: readonly RampOrderStatus[] = [
  "failed",
  "expired",
  "cancelled",
  "refunded",
];

export function isLegalTransition(from: RampOrderStatus, to: RampOrderStatus): boolean {
  return RAMP_TRANSITIONS[from].includes(to);
}

/**
 * `request_hash` (E-D9, L1): sha256 hex of the canonical request — keys sorted, the amount as
 * its 10-dp string — so one Idempotency-Key answers one request only.
 */
export function rampRequestHash(input: {
  direction: RampDirection;
  amount: bigint;
  method: string | null;
  destination: Record<string, string> | null;
}): string {
  const destination = input.destination
    ? Object.fromEntries(Object.entries(input.destination).sort(([a], [b]) => a.localeCompare(b)))
    : null;
  const canonical = JSON.stringify({
    amount: formatAmount(input.amount),
    destination,
    direction: input.direction,
    method: input.method,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Columns a write may require to still hold a value (null = IS NULL): snapshots and write-once ids. */
const GUARD_COLUMNS = {
  reviewStep: "review_step",
  providerPaymentId: "provider_payment_id",
  providerPayoutId: "provider_payout_id",
  providerRefundId: "provider_refund_id",
  mintCommandId: "mint_command_id",
  creditCommandId: "credit_command_id",
  pendingPayoutCid: "pending_payout_cid",
  burnCommandId: "burn_command_id",
  remintCommandId: "remint_command_id",
  // S5's bank columns: S6's batch writes guard on them (an order leaves its batch only through it).
  bankAccountId: "bank_account_id",
  payoutBatchId: "payout_batch_id",
} as const;
export type RampGuardColumn = keyof typeof GUARD_COLUMNS;

/** What a write may set directly; `details` is merged through `RampWriteOptions.details` (never clobbered). */
export type RampOrderPatch = Omit<
  Partial<RampOrderEntity>,
  "id" | "status" | "version" | "details" | "user" | "paymentMethod" | "createdAt" | "updatedAt"
>;

export interface RampWriteOptions {
  actor: Actor;
  /** Why — on the audit row (and `last_error` / `details.reviewReason` for `needs_review`). */
  detail?: string;
  /** Runs inside the transaction after the compare-and-set won (journal postings, command rows). */
  within?: (manager: EntityManager, order: RampOrderEntity) => Promise<void>;
  /** Run inside the caller's transaction (the token sync's) instead of a new one. */
  manager?: EntityManager;
  /** The columns must still hold these values (null = IS NULL), e.g. an admin snapshot (H1). */
  expect?: Partial<Record<RampGuardColumn, string | null>>;
  /** Compare `version` with the caller's read (default true: I6). */
  checkVersion?: boolean;
  /** Top-level keys merged into `details` in the same UPDATE. */
  details?: Record<string, unknown>;
  /** Top-level `details` keys that must still be absent (or null), e.g. an in-flight credit-back (C1). */
  absent?: readonly string[];
  /**
   * Top-level `details` objects that must be absent (or null) or settled — `state` confirmed or
   * failed: a credit-back whose Deposit failed for good no longer blocks the other exits (C1).
   */
  settled?: readonly string[];
}

/** The `state`s of a `details` object that no longer hold the order (C1: a credit-back's). */
const SETTLED_STATES = ["confirmed", "failed"] as const;

/** `details.creditBack` (#1, C1): the approved credit-back's Deposit key and how it stands. */
export interface RampCreditBack {
  commandId: string;
  /** 1 = `ramp-creditback-<h>`; n > 1 = `…-<n>`, a new key after a failure (a failed key is never reused). */
  generation?: number;
  state: "submitted" | "confirmed" | "failed";
  at?: string;
  approvalId?: string | null;
  /** `failed`: the proof (the wallet's FAILED, no Deposit with its txRef) and when it was found. */
  error?: string | null;
  failedAt?: string;
  /** Earlier generations that failed for good, oldest first. */
  failed?: { commandId: string; error: string | null; failedAt: string | null }[];
}

export function creditBackOf(order: Pick<RampOrderEntity, "details">): RampCreditBack | null {
  const cb = order.details?.creditBack as Partial<RampCreditBack> | null | undefined;
  return cb && typeof cb === "object" && typeof cb.commandId === "string"
    ? (cb as RampCreditBack)
    : null;
}

/**
 * An approved credit-back whose Deposit has not confirmed yet (C1): no other exit may run
 * meanwhile. One that failed for good (proven: the wallet reports its command FAILED and the
 * ledger shows no Deposit with its txRef) is settled — the exits reopen.
 */
export function creditBackInFlight(order: Pick<RampOrderEntity, "details">): boolean {
  const cb = order.details?.creditBack as { state?: unknown } | null | undefined;
  return Boolean(
    cb && typeof cb === "object" && !(SETTLED_STATES as readonly unknown[]).includes(cb.state),
  );
}

/**
 * The user's status sentence key (SPEC §11.5): an order an operator, a review or a hold has —
 * whatever the reason (compliance, exposure, a gate) — reads `processing`; else null.
 */
export function userStatusText(
  order: Pick<RampOrderEntity, "status" | "details">,
): "processing" | null {
  if (order.status === "needs_review") return "processing";
  return order.details?.hold ? "processing" : null;
}

/** What the user does next to pay (only while `awaiting_payment`). */
export function orderNext(
  order: Pick<RampOrderEntity, "status" | "method" | "checkoutUrl" | "paymentInstructions">,
): RampPaymentNext | null {
  if (order.status !== "awaiting_payment") return null;
  if (order.method === "erip") return order.paymentInstructions ?? null;
  return order.checkoutUrl ? { kind: "redirect", url: order.checkoutUrl } : null;
}

/** Async parts of the user view that RampService reads (the ledger, the bank rail port). */
export interface RampOrderViewExtras {
  withdraw?: { walletContractId: string; amount: string } | null;
  bankDestination?: Extract<ApiRampDestination, { kind: "bank" }> | null;
}

interface TimelineRow {
  status?: unknown;
  at?: unknown;
  step?: unknown;
}

/**
 * `details.timeline` for the user (SPEC §11.5, §12.1; I10, C11). One rule for every review: no
 * `needs_review` entry is shown, whatever its step — dropping only the compliance ones would make
 * their absence the tell. The order's `status` and `statusText` (processing) say it is in review.
 */
export function userTimeline(details: Record<string, unknown> | null): ApiRampTimelineEntry[] {
  const rows = Array.isArray(details?.timeline) ? (details.timeline as TimelineRow[]) : [];
  return rows
    .filter((r) => typeof r.status === "string" && typeof r.at === "string")
    .filter((r) => r.status !== "needs_review")
    .map((r) => ({ status: r.status as RampOrderStatus, at: r.at as string }));
}

/**
 * Persistence of `to_ramp_orders` (SPEC §3.1, §4): every write is one UPDATE `WHERE id AND status
 * IN (…) AND version = v` that bumps `version` (I6), appends `details.timeline` on a status change
 * and stores `details.reviewFrom` + `reviewReason` on every move to `needs_review` — with its audit
 * row and any `within` work (postings, token command rows) in the same transaction. A loser
 * returns false and must not call upstream. Shared by RampService, the step engine, the admin
 * actions, the token sync hook and RampPolicyService (binding a signed withdrawal).
 */
@Injectable()
export class RampOrderStore {
  private readonly logger = new Logger(RampOrderStore.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RampOrderEntity) readonly orders: Repository<RampOrderEntity>,
    private readonly instruments: InstrumentsService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  async find(id: string, manager?: EntityManager): Promise<RampOrderEntity | null> {
    const repo = manager ? manager.getRepository(RampOrderEntity) : this.orders;
    return repo.findOne({ where: { id }, relations: { paymentMethod: true } });
  }

  /** The row locked FOR UPDATE inside the caller's transaction (the token sync's hook). */
  async lockForUpdate(manager: EntityManager, id: string): Promise<RampOrderEntity | null> {
    return manager
      .getRepository(RampOrderEntity)
      .createQueryBuilder("o")
      .setLock("pessimistic_write")
      .where("o.id = :id", { id })
      .getOne();
  }

  async findOwned(id: string, userId: string): Promise<RampOrderEntity | null> {
    const order = await this.find(id);
    return order && order.userId === userId ? order : null;
  }

  /**
   * Move `order` from one of `from` to `to` (checked against RAMP_TRANSITIONS before the CAS). On a
   * win the entity is refreshed and `truthoracle.ramp.order_changed` published; on a loss it is
   * re-read and false returned. `to = needs_review` requires `patch.reviewStep`.
   */
  async transition(
    order: RampOrderEntity,
    from: readonly RampOrderStatus[],
    to: RampOrderStatus,
    patch: RampOrderPatch,
    opts: RampWriteOptions,
  ): Promise<boolean> {
    for (const f of from) {
      if (!isLegalTransition(f, to)) throw new Error(`illegal ramp transition ${f} → ${to}`);
    }
    const step = to === "needs_review" ? (patch.reviewStep ?? null) : null;
    if (to === "needs_review" && !step) throw new Error("needs_review without a review step");
    if (from.includes("refunded") && step !== "refund")
      throw new Error(
        "a refunded order re-opens only for its returned bank refund (refund review)",
      );
    if (from.includes("chargeback") && step !== "refund")
      throw new Error(
        "a charged-back order re-opens only for its reinstated bank refund (refund review)",
      );
    const at = new Date();
    return this.write(
      order,
      from,
      to,
      {
        ...patch,
        reviewStep: step,
        statusChangedAt: at,
        ...(RAMP_TERMINAL.has(to) && to !== "chargeback" ? { completedAt: at } : {}),
      },
      opts,
      { status: to, at: at.toISOString(), ...(step ? { step } : {}) },
    );
  }

  /** `needs_review` with the step and the reason (`details.reviewFrom` = the status it left). */
  review(
    order: RampOrderEntity,
    from: readonly RampOrderStatus[],
    step: RampStep,
    reason: string,
    actor: Actor,
    patch: RampOrderPatch = {},
    opts: Partial<RampWriteOptions> = {},
  ): Promise<boolean> {
    return this.transition(
      order,
      from,
      "needs_review",
      { ...patch, reviewStep: step, lastError: reason.slice(0, 800) },
      { ...opts, actor, detail: reason },
    );
  }

  /** A write without a status change (a posting, a flag, an id): `status IN (s) → s`, version + 1. */
  bump(order: RampOrderEntity, patch: RampOrderPatch, opts: RampWriteOptions): Promise<boolean> {
    return this.write(order, [order.status], null, patch, opts, null);
  }

  /**
   * Record a write-once value (a provider id the acquirer handed us, the re-mint id): `SET col = v
   * WHERE col IS NULL` whatever the status (M6, #3) — losing it would mean a second upstream call.
   * True when the column now holds `value`.
   */
  async setOnce(order: RampOrderEntity, column: RampGuardColumn, value: string): Promise<boolean> {
    const res = await this.orders
      .createQueryBuilder()
      .update(RampOrderEntity)
      .set({ [column]: value, version: () => "version + 1" })
      .where(`id = :id AND "${GUARD_COLUMNS[column]}" IS NULL`, { id: order.id })
      .execute();
    const fresh = await this.orders.findOneByOrFail({ id: order.id });
    Object.assign(order, fresh);
    if (!res.affected && fresh[column] !== value)
      this.logger.warn(`order ${order.id}: ${column} already holds ${String(fresh[column])}`);
    return fresh[column] === value;
  }

  /**
   * The poll throttle, the one write outside the versioned CAS (I6): `last_polled_at` is a hint
   * no step decision, no approval snapshot and no view reads, so it moves neither `version` nor
   * `updated_at`. A 15-minute post-close poll then never stales a pending four-eyes approval on
   * the order (C39: burn_uncredited on a charged-back one).
   */
  async markPolled(order: Pick<RampOrderEntity, "id" | "lastPolledAt">, at: Date): Promise<void> {
    await this.orders.query(`UPDATE "to_ramp_orders" SET "last_polled_at" = $2 WHERE "id" = $1`, [
      order.id,
      at,
    ]);
    order.lastPolledAt = at;
  }

  /**
   * A step did upstream work and failed: count it while the order is still in `status`. Returns
   * the new attempt count (0 when the order moved meanwhile — nothing to count).
   */
  async recordAttempt(order: RampOrderEntity, err: unknown): Promise<number> {
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 800);
    const res = await this.orders
      .createQueryBuilder()
      .update(RampOrderEntity)
      .set({ attempts: () => "attempts + 1", lastError: detail, version: () => "version + 1" })
      .where("id = :id AND status = :status", { id: order.id, status: order.status })
      .execute();
    if (!res.affected) return 0;
    const fresh = await this.orders.findOneByOrFail({ id: order.id });
    Object.assign(order, fresh);
    return order.attempts;
  }

  private async write(
    order: RampOrderEntity,
    from: readonly RampOrderStatus[],
    to: RampOrderStatus | null,
    patch: RampOrderPatch,
    opts: RampWriteOptions,
    timeline: Record<string, string> | null,
  ): Promise<boolean> {
    const previous = order.status;
    const params: Record<string, unknown> = {
      id: order.id,
      from: [...from],
      version: order.version,
      detailsMerge: JSON.stringify(opts.details ?? {}),
    };
    // SET expressions read the OLD row: `"status"` below is the status the order leaves.
    let details = `"details" || CAST(:detailsMerge AS jsonb)`;
    if (to === "needs_review") {
      details += ` || jsonb_build_object('reviewFrom', "status", 'reviewReason', CAST(:reviewReason AS text))`;
      params.reviewReason = (opts.detail ?? "").slice(0, 800);
    }
    if (timeline) {
      details = `(${details}) || jsonb_build_object('timeline', COALESCE("details" -> 'timeline', '[]'::jsonb) || jsonb_build_array(CAST(:timelineEntry AS jsonb)))`;
      params.timelineEntry = JSON.stringify(timeline);
    }
    const run = async (manager: EntityManager): Promise<boolean> => {
      const qb = manager
        .createQueryBuilder()
        .update(RampOrderEntity)
        .set({
          ...asUpdate(patch),
          ...(to ? { status: to } : {}),
          version: () => "version + 1",
          details: () => details,
        })
        .where("id = :id AND status IN (:...from)")
        .setParameters(params);
      if (opts.checkVersion !== false) qb.andWhere("version = :version");
      for (const [key, value] of Object.entries(opts.expect ?? {})) {
        const column = GUARD_COLUMNS[key as RampGuardColumn];
        if (value === null) qb.andWhere(`"${column}" IS NULL`);
        else qb.andWhere(`"${column}" = :expect_${key}`, { [`expect_${key}`]: value });
      }
      (opts.absent ?? []).forEach((key, i) => {
        qb.andWhere(
          `COALESCE("details" -> CAST(:absent_${i} AS text), 'null'::jsonb) = 'null'::jsonb`,
          { [`absent_${i}`]: key },
        );
      });
      (opts.settled ?? []).forEach((key, i) => {
        qb.andWhere(
          `(COALESCE("details" -> CAST(:settled_${i} AS text), 'null'::jsonb) = 'null'::jsonb OR "details" -> CAST(:settled_${i} AS text) ->> 'state' IN (:...settledStates))`,
          { [`settled_${i}`]: key, settledStates: [...SETTLED_STATES] },
        );
      });
      const res = await qb.execute();
      if (!res.affected) return false;
      const fresh = await manager.getRepository(RampOrderEntity).findOneByOrFail({ id: order.id });
      if (to) {
        await this.audit.record(
          {
            actorType: opts.actor.type,
            actorUserId: opts.actor.userId ?? null,
            actorSessionId: opts.actor.sessionId ?? null,
            action: to === "needs_review" ? "ramp.review_required" : "ramp.order_transition",
            subjectType: "ramp_order",
            subjectId: order.id,
            metadata: {
              direction: order.direction,
              from: previous,
              to,
              reviewStep: fresh.reviewStep,
              detail: opts.detail,
              userId: order.userId,
            },
            ip: opts.actor.ip ?? null,
          },
          manager,
        );
      }
      if (opts.within) await opts.within(manager, fresh);
      Object.assign(order, fresh);
      return true;
    };
    const won = opts.manager ? await run(opts.manager) : await this.dataSource.transaction(run);
    if (!won) {
      const fresh = await (opts.manager?.getRepository(RampOrderEntity) ?? this.orders).findOne({
        where: { id: order.id },
      });
      if (fresh) Object.assign(order, fresh);
      return false;
    }
    if (!to) return true;
    // Inside a caller's transaction this may announce a move that is later rolled back: consumers re-read.
    void this.nats.publishSafe(
      NatsSubjects.rampOrderChanged,
      { orderId: order.id, userId: order.userId, direction: order.direction, from: previous, to },
      { msgId: `ramp.order_changed:${order.id}:${order.version}` },
    );
    if (to === "needs_review") {
      void this.nats.publishSafe(NatsSubjects.rampReviewRequired, {
        orderId: order.id,
        userId: order.userId,
        step: order.reviewStep,
        detail: opts.detail,
      });
      this.logger.warn(`order ${order.id}: needs review at ${order.reviewStep} (${opts.detail})`);
    } else {
      this.logger.log(`order ${order.id}: ${previous} → ${to}`);
    }
    return true;
  }

  async toApi(order: RampOrderEntity, extras: RampOrderViewExtras = {}): Promise<ApiRampOrder> {
    return orderToApi(order, await this.instrumentRef(order), extras);
  }

  async toAdminApi(order: RampOrderEntity): Promise<ApiAdminRampOrder> {
    return {
      ...orderToApi(order, await this.instrumentRef(order), {}),
      // The operator sees every step (compliance included), every transition, the full operator record.
      reviewStep: order.reviewStep,
      timeline: adminTimeline(order.details),
      operator: order.operator ?? null,
      userId: order.userId,
      partyId: order.partyId,
      provider: order.provider,
      idempotencyKey: order.idempotencyKey,
      paymentMethodId: order.paymentMethodId,
      pendingPayoutCid: order.pendingPayoutCid,
      bankAccountId: order.bankAccountId,
      payoutBatchId: order.payoutBatchId,
      consentId: order.consentId,
      risk: order.risk ?? {},
      version: order.version,
      providerPaymentId: order.providerPaymentId,
      providerPayoutId: order.providerPayoutId,
      providerRefundId: order.providerRefundId,
      capturedAmount: order.capturedAmount === null ? null : formatAmount(order.capturedAmount),
      capturedAt: toIso(order.capturedAt),
      refundedAmount: formatAmount(order.refundedAmount),
      mintCommandId: order.mintCommandId,
      creditCommandId: order.creditCommandId,
      burnCommandId: order.burnCommandId,
      remintCommandId: order.remintCommandId,
      remintCreditCommandId: order.remintCreditCommandId,
      attempts: order.attempts,
      lastError: order.lastError,
      details: order.details ?? {},
    };
  }

  private async instrumentRef(order: RampOrderEntity): Promise<InstrumentRef> {
    const row = await this.instruments.get(order.instrumentAdmin, order.instrumentId);
    return row
      ? this.instruments.toRef(row)
      : {
          admin: order.instrumentAdmin,
          id: order.instrumentId,
          symbol: order.instrumentId,
          name: order.instrumentId,
          decimals: 10,
        };
  }
}

/**
 * `details` is merged in SQL; money columns go through their transformer. TypeORM's deep-partial
 * type cannot see through the jsonb columns (`risk`, `operator`, `payment_instructions`): they are
 * written whole.
 */
function asUpdate(patch: RampOrderPatch): QueryDeepPartialEntity<RampOrderEntity> {
  return patch as QueryDeepPartialEntity<RampOrderEntity>;
}

function adminTimeline(details: Record<string, unknown> | null): ApiRampTimelineEntry[] {
  const rows = Array.isArray(details?.timeline) ? (details.timeline as TimelineRow[]) : [];
  return rows
    .filter((r) => typeof r.status === "string" && typeof r.at === "string")
    .map((r) => ({ status: r.status as RampOrderStatus, at: r.at as string }));
}

export function paymentMethodToApi(
  m: RampPaymentMethodEntity,
  cashout: { mode: RampCardCashoutMode; available: bigint } = { mode: "none", available: 0n },
): ApiRampPaymentMethod {
  return {
    id: m.id,
    brand: m.brand,
    last4: m.last4,
    expMonth: m.expMonth,
    expYear: m.expYear,
    issuerCountry: m.issuerCountry,
    status: m.status,
    payoutEligible: m.payoutEligible,
    cashout: { mode: cashout.mode, available: formatAmount(cashout.available) },
    createdAt: m.createdAt.toISOString(),
    lastUsedAt: toIso(m.lastUsedAt),
  };
}

function cardOf(details: Record<string, unknown> | null): ApiRampOrder["card"] {
  const card = details?.card as { brand?: unknown; last4?: unknown } | null | undefined;
  if (!card || typeof card !== "object") return null;
  return {
    brand: typeof card.brand === "string" ? card.brand : null,
    last4: typeof card.last4 === "string" ? card.last4 : null,
  };
}

/** Where an off-ramp's fiat goes, as the user sees it. */
function destinationOf(
  order: RampOrderEntity,
  extras: RampOrderViewExtras,
): ApiRampDestination | null {
  if (order.direction !== "offramp") return null;
  if (order.payoutRail === "bank")
    return (
      extras.bankDestination ?? {
        kind: "bank",
        bankAccountId: order.bankAccountId ?? "",
        bankName: null,
        ibanMasked: "",
      }
    );
  if (!order.paymentMethodId) return null;
  return {
    kind: "card",
    paymentMethodId: order.paymentMethodId,
    brand: order.paymentMethod?.brand ?? null,
    last4: order.paymentMethod?.last4 ?? null,
  };
}

/**
 * The user's view (SPEC §12.1); `version`, review steps and hold reasons are never on it. Every
 * review and every hold reads the same (C11): `statusText` processing, `reviewStep` null — a
 * compliance review is indistinguishable from a payment or payout one (I10, no tipping-off).
 */
function orderToApi(
  order: RampOrderEntity,
  instrument: InstrumentRef,
  extras: RampOrderViewExtras,
): ApiRampOrder {
  return {
    id: order.id,
    direction: order.direction,
    status: order.status,
    statusText: userStatusText(order),
    reviewStep: null,
    method: order.method,
    rail: order.payoutRail,
    instrument,
    fiatCurrency: order.fiatCurrency,
    fiatAmount: formatAmount(order.fiatAmount),
    tokenAmount: formatAmount(order.tokenAmount),
    feeAmount: formatAmount(order.feeAmount),
    next: orderNext(order),
    withdraw: order.status === "awaiting_withdrawal" ? (extras.withdraw ?? null) : null,
    destination: destinationOf(order, extras),
    card: cardOf(order.details),
    payoutReference: PAYOUT_REFERENCE_RE.test(order.payoutReference ?? "")
      ? displayPayoutReference(order.payoutReference)
      : null,
    expiresAt: toIso(order.expiresAt),
    timeline: userTimeline(order.details),
    operator: order.operator?.name ? { name: order.operator.name } : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    completedAt: toIso(order.completedAt),
  };
}
