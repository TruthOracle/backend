import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, LessThan, Not, Repository } from "typeorm";

import { Config } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import { RampEventEntity } from "../entities/ramp-event.entity";
import { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import { TokenCommandEntity } from "../entities/token-command.entity";
import type { UserEntity } from "../entities/user.entity";
import {
  NatsSubjects,
  RAMP_DIRECTIONS,
  RAMP_PROVIDER,
  type Actor,
  type ApiAdminRampOrderDetail,
  type ApiPage,
  type ApiRampAttachResult,
  type ApiRampCards,
  type ApiRampOfframpResult,
  type ApiRampOnrampResult,
  type ApiRampOrder,
  type ApiRampOrderList,
  type ApiRampOverview,
  type ApiRampQuote,
  type InstrumentId,
  type RampDirection,
  type RampLimitName,
  type RampMethod,
  type RampOperatorSnapshot,
  type RampOrderStatus,
  type RampPaymentNext,
  type RampPayoutRail,
  type RampProvider,
  type RampProviderName,
  type RampWebhookEvent,
  type RampWebhookMeta,
} from "../types";
import { CidrList } from "../util/cidr";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";
import { payoutReferenceDigits, payoutReferenceFor } from "../util/payout-reference";
import { DAY_MS, MINUTE_MS } from "../util/time";
import { AdminApprovalService } from "./admin-approval.service";
import { AuditService } from "./audit.service";
import { InstrumentsService } from "./instruments.service";
import { LedgerClientService } from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { PayoutService } from "./payout.service";
import { RampBankRailPort } from "./ramp-bank-rail.port";
import { RampCardCashoutService } from "./ramp-card-cashout.service";
import type { CardCashoutPart } from "./ramp-card-cashout.logic";
import {
  ALLOW,
  RampCompliancePort,
  riskEntry,
  type ComplianceContext,
  type CompliancePoint,
  type PendingAlert,
} from "./ramp-compliance.port";
import { RampControlsService } from "./ramp-controls.service";
import { RAMP_ORDER_LOCK_TTL_MS, RampFulfilmentService } from "./ramp-fulfilment.service";
import { RampJournalService } from "./ramp-journal.service";
import { paymentMethodToApi, RampOrderStore, rampRequestHash } from "./ramp-order-store.service";
import {
  quoteRamp,
  RAMP_RAIL_ETA_BDAYS,
  RampPolicyService,
  rampNextProblem,
  type RampQuoteFigures,
} from "./ramp-policy.service";
import { RedisService } from "./redis.service";

/** The statuses `GET /ramp.openOrders` lists: waiting on the user or on the platform. */
const OPEN: readonly RampOrderStatus[] = [
  "created",
  "awaiting_payment",
  "awaiting_withdrawal",
  "paid",
  "minting",
  "crediting",
  "withdrawing",
  "burning",
  "paying_out",
  "reversing",
  "payout_queued",
  "payout_sent",
  "refunding",
  "needs_review",
];

/** Webhook payload keys worth keeping (ids, types, timestamps); everything else is dropped before storage. */
const PAYLOAD_KEYS = new Set(["id", "type", "created", "livemode", "data"]);
const PAYLOAD_DATA_KEYS = new Set(["object_id", "order_id", "status"]);
/** A payout-reference collision re-derives this many times before the insert gives up (1e11 values). */
const REFERENCE_ATTEMPTS = 5;

/**
 * F6: why an attach left the order waiting, from PayoutService's refusal — its reason
 * (`settlement_in_progress`, `in_flight`), else the payout status the payee may see (C11: a
 * compliance or gate hold reads `processing`), else its code.
 */
export function attachBindReason(err: ApiError): string {
  const d = err.details ?? {};
  if (typeof d.reason === "string" && d.reason) return d.reason;
  if (typeof d.status === "string" && d.status) return d.status;
  return err.code;
}

/** A cash-out destination as `POST /ramp/offramp` names it (SPEC §12.1). */
export type RampDestinationInput =
  { kind: "card"; paymentMethodId: string } | { kind: "bank"; bankAccountId: string };

/** A webhook delivery as the controller hands it over (SPEC §8): raw bytes + where they came from. */
export interface RampWebhookDelivery extends RampWebhookMeta {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** The parsed body (JSON value or form fields); only `redactRampPayload` keys are stored. */
  body: unknown;
}

export function redactRampPayload(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!PAYLOAD_KEYS.has(k)) continue;
    if (k === "data" && typeof v === "object" && v !== null) {
      out.data = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([dk]) => PAYLOAD_DATA_KEYS.has(dk)),
      );
    } else out[k] = v;
  }
  return out;
}

/** What a create stores besides the quote: method or rail, destination, references, compliance. */
interface OrderSeed {
  id: string;
  status: RampOrderStatus;
  method: RampMethod | null;
  payoutRail: RampPayoutRail | null;
  paymentMethodId: string | null;
  bankAccountId: string | null;
  expiresAt: Date;
  risk: Record<string, unknown>;
  consentId: string | null;
  details: Record<string, unknown>;
}

/**
 * The fiat ramp's account-facing side (SPEC §9, §12.1): the overview, quotes, opening an on-ramp
 * (card hosted page or ERIP payment) or an off-ramp (the `Withdraw` to sign; back to the funding
 * card or — S6 — to a bank account), binding the signed withdrawal, cancelling, saved cards, and
 * the webhook inbox. Money never trusts the client: amounts are re-quoted here, the card is
 * whatever the acquirer reports, the acquirer's `next` is validated before it is stored, and the
 * order only moves on the acquirer's API (RampFulfilmentService). `Idempotency-Key` makes a
 * retried POST answer the order it already created. Every order carries its payout reference,
 * the operator of record, the consent it was made under and the compliance decisions of its
 * create point (the ports answer; S7a / S7b implement them).
 */
@Injectable()
export class RampService {
  private readonly logger = new Logger(RampService.name);

  constructor(
    private readonly config: Config,
    private readonly store: RampOrderStore,
    private readonly policy: RampPolicyService,
    private readonly fulfilment: RampFulfilmentService,
    @Inject(RAMP_PROVIDER) private readonly provider: RampProvider,
    @InjectRepository(RampEventEntity) private readonly events: Repository<RampEventEntity>,
    @InjectRepository(RampPaymentMethodEntity)
    private readonly methods: Repository<RampPaymentMethodEntity>,
    @InjectRepository(TokenCommandEntity) private readonly commands: Repository<TokenCommandEntity>,
    private readonly instruments: InstrumentsService,
    private readonly ledger: LedgerClientService,
    private readonly payouts: PayoutService,
    private readonly journal: RampJournalService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
    private readonly redis: RedisService,
    private readonly controls: RampControlsService,
    private readonly approvals: AdminApprovalService,
    private readonly compliance: RampCompliancePort,
    private readonly bankRail: RampBankRailPort,
    private readonly cashout: RampCardCashoutService,
  ) {}

  get providerName(): RampProviderName {
    return this.provider.name;
  }

  // ───────────────────────────────────────────── reads ──────────────────────────────────────

  /** `GET /ramp` (SPEC §12.1). */
  async overview(user: UserEntity): Promise<ApiRampOverview> {
    const instrument = await this.policy.instrument();
    const ref = instrument ? { admin: instrument.admin, id: instrument.id } : null;
    const limits = {} as ApiRampOverview["limits"];
    const eligibility = {} as ApiRampOverview["eligibility"];
    for (const direction of RAMP_DIRECTIONS) {
      const cfg = this.policy.directionConfig(direction);
      const left = await this.policy.remaining(user.id, direction);
      limits[direction] = {
        min: formatAmount(cfg.min),
        max: formatAmount(cfg.max),
        dailyMax: formatAmount(cfg.dailyMax),
        monthlyMax: formatAmount(cfg.monthlyMax),
        dailyRemaining: formatAmount(left.daily),
        monthlyRemaining: formatAmount(left.monthly),
      };
      const reasons = await this.policy.eligibility(user, direction);
      eligibility[direction] = { allowed: reasons.length === 0, reasons };
    }
    const exposure = ref
      ? await this.exposureOrClosed(user, ref)
      : { exposure: 0n, withdrawable: 0n };
    const consent = await this.compliance.consent(user.id);
    const open = await this.store.orders.find({
      where: { userId: user.id, status: In([...OPEN]) },
      relations: { paymentMethod: true },
      order: { createdAt: "DESC" },
      take: 10,
    });
    const { operator, termsUrl, termsVersion } = this.config.ramp;
    return {
      enabled: this.config.ramp.enabled,
      // SPEC §6.1: halted new orders show as paused; the operator's reason stays internal.
      paused: { orders: await this.controls.isHalted("orders"), reason: null },
      provider: this.provider.isConfigured() ? this.provider.name : null,
      operator: operator.name ? { name: operator.name, termsUrl, termsVersion } : null,
      consent: { required: consent.required, termsVersion, termsUrl },
      instrument: instrument ? this.instruments.toRef(instrument) : null,
      fiat: { currency: this.config.ramp.fiatCurrency, decimals: this.config.ramp.fiatDecimals },
      methods: this.policy.offeredMethods().map((method) => {
        const fee = this.policy.feeConfig({ method });
        return {
          method,
          ttlMinutes: this.config.ramp.method[method].ttlMin,
          fee: { bps: fee.feeBps, fixed: formatAmount(fee.feeFixed) },
        };
      }),
      rails: this.policy.offeredRails().map((rail) => {
        const fee = this.policy.feeConfig({ rail });
        return {
          rail,
          fee: { bps: fee.feeBps, fixed: formatAmount(fee.feeFixed) },
          eta: { businessDays: RAMP_RAIL_ETA_BDAYS[rail] },
        };
      }),
      limits,
      exposure: {
        amount: formatAmount(exposure.exposure),
        withdrawableToBank: formatAmount(exposure.withdrawable),
      },
      eligibility,
      openOrders: await Promise.all(open.map((o) => this.apiOrder(o))),
    };
  }

  /** The exposure view; an unreadable wallet shows nothing withdrawable (fail closed, I7). */
  private async exposureOrClosed(
    user: UserEntity,
    ref: InstrumentId,
  ): Promise<{ exposure: bigint; withdrawable: bigint }> {
    try {
      return await this.policy.exposureView(user, ref);
    } catch (err) {
      this.logger.warn(`exposure of ${user.id}: wallet unreadable: ${(err as Error).message}`);
      return { exposure: await this.policy.exposure(user.id, ref), withdrawable: 0n };
    }
  }

  /**
   * `POST /ramp/quote` — the arithmetic and the checks order creation uses: the method's (on) or
   * the rail's (off) fee, the per-order and rolling limits, and for a cash-out the destination's
   * capacity (`card_cashout`) or the card exposure (`exposure`) — F1's limit names.
   */
  async quote(
    user: UserEntity,
    input: {
      direction: RampDirection;
      amount: bigint;
      method?: RampMethod;
      destination?: RampDestinationInput;
    },
  ): Promise<ApiRampQuote> {
    const instrument = await this.policy.requireInstrument();
    const q = this.figures(
      input.direction,
      input.amount,
      instrument,
      input.method,
      input.destination,
    );
    const counted = input.direction === "onramp" ? q.fiatAmount : q.tokenAmount;
    const limit =
      (await this.policy.limitBreach(user.id, input.direction, counted)) ??
      (input.direction === "offramp" && input.destination
        ? await this.destinationLimit(user, instrument, q, input.destination)
        : null);
    return {
      direction: input.direction,
      instrument: this.instruments.toRef(instrument),
      fiatCurrency: this.config.ramp.fiatCurrency,
      fiatAmount: formatAmount(q.fiatAmount),
      tokenAmount: formatAmount(q.tokenAmount),
      fee: formatAmount(q.fee),
      withinLimits: limit === null,
      limit: limit
        ? {
            name: limit.name,
            ...(limit.min !== undefined ? { min: formatAmount(limit.min) } : {}),
            ...(limit.max !== undefined ? { max: formatAmount(limit.max) } : {}),
            ...(limit.available !== undefined ? { available: formatAmount(limit.available) } : {}),
          }
        : null,
    };
  }

  /** What the destination can take for a quote: the card's capacity, or the exposure headroom. */
  private async destinationLimit(
    user: UserEntity,
    instrument: InstrumentEntity,
    q: RampQuoteFigures,
    destination: RampDestinationInput,
  ): Promise<{ name: RampLimitName; min?: bigint; max?: bigint; available?: bigint } | null> {
    const ref = { admin: instrument.admin, id: instrument.id };
    if (destination.kind === "card" && this.policy.cardCashoutMode() === "refund") {
      const card = await this.methods.findOne({
        where: { id: destination.paymentMethodId, userId: user.id },
      });
      if (!card) return null;
      const available = await this.cashout.available(user.id, card.id, null);
      return q.fiatAmount > available ? { name: "card_cashout", available } : null;
    }
    const { withdrawable } = await this.policy.exposureView(user, ref);
    return q.tokenAmount > withdrawable ? { name: "exposure", available: withdrawable } : null;
  }

  /**
   * `GET /ramp/orders?cursor&limit` → `{orders, nextCursor}` (SPEC §12.1): newest first, keyset
   * paged on (created_at, id); the cursor is opaque base64url.
   */
  async listOrders(
    userId: string,
    filter: { direction?: RampDirection; cursor?: string; limit?: number },
  ): Promise<ApiRampOrderList> {
    const limit = filter.limit ?? 25;
    const qb = this.store.orders
      .createQueryBuilder("o")
      .leftJoinAndSelect("o.paymentMethod", "pm")
      .where("o.user_id = :userId", { userId })
      .orderBy("o.created_at", "DESC")
      .addOrderBy("o.id", "DESC")
      .take(limit + 1);
    if (filter.direction) qb.andWhere("o.direction = :direction", { direction: filter.direction });
    const after = decodeOrderCursor(filter.cursor);
    if (after)
      qb.andWhere("(o.created_at, o.id) < (:at, :id)", { at: after.createdAt, id: after.id });
    const rows = await qb.getMany();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      orders: await Promise.all(page.map((o) => this.apiOrder(o))),
      nextCursor: rows.length > limit && last ? encodeOrderCursor(last) : null,
    };
  }

  async getOrder(userId: string, orderId: string): Promise<ApiRampOrder> {
    return this.apiOrder(await this.requireOwned(userId, orderId));
  }

  /** `GET /ramp/payment-methods` → `{cards}`, each with how a cash-out to it works and can take now. */
  async paymentMethods(user: UserEntity): Promise<ApiRampCards> {
    const rows = await this.methods.find({
      where: { userId: user.id, provider: this.provider.name, status: Not("removed") },
      order: { createdAt: "ASC" },
    });
    const instrument = await this.policy.instrument();
    const ref = instrument ? { admin: instrument.admin, id: instrument.id } : null;
    const cards = [];
    for (const m of rows)
      cards.push(
        paymentMethodToApi(
          m,
          await this.policy.cardCashout(user, m, ref).catch(() => ({
            mode: this.policy.cardCashoutMode(),
            available: 0n,
          })),
        ),
      );
    return { cards };
  }
  /** `DELETE /ramp/payment-methods/:id` — not while a cash-out to it is in flight. A blocked card stays blocked. */
  async removePaymentMethod(userId: string, id: string, actor: Actor): Promise<void> {
    const method = await this.methods.findOne({ where: { id, userId } });
    if (!method || method.status === "removed")
      throw new ApiError(404, "not_found", "card not found");
    const inFlight = await this.store.orders.count({
      where: { paymentMethodId: id, direction: "offramp", status: In([...OPEN]) },
    });
    if (inFlight > 0)
      throw new ApiError(409, "ramp_order_state", "a cash-out to this card is in progress");
    if (method.status === "active")
      await this.methods.update({ id }, { status: "removed", payoutEligible: false });
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "ramp.card_removed",
      subjectType: "ramp_payment_method",
      subjectId: id,
      metadata: { userId, brand: method.brand, last4: method.last4 },
      ip: actor.ip ?? null,
    });
  }

  // ───────────────────────────────────────────── on-ramp ────────────────────────────────────

  /**
   * `POST /ramp/onramp` — write the order ahead (its payout reference, operator of record, consent
   * and the `onramp.create` decision; a deny refuses neutrally), then ask the acquirer for the
   * payment under the order id: a hosted card page or ERIP details. The acquirer's `next` must be
   * one we may show (X15, E-D7), else the order fails closed. A replayed Idempotency-Key answers
   * the same order — with its `next` only while `awaiting_payment` (M7) — and another request
   * under it is a 409 (E-D9).
   */
  async createOnramp(
    user: UserEntity,
    input: { amount: bigint; method: RampMethod; expectedTokenAmount?: bigint },
    idempotencyKey: string,
    actor: Actor,
  ): Promise<ApiRampOnrampResult> {
    const { method } = input;
    const requestHash = rampRequestHash({
      direction: "onramp",
      amount: input.amount,
      method,
      destination: null,
    });
    const replay = await this.replay(user.id, idempotencyKey, requestHash);
    if (replay) return { order: await this.apiOrder(replay) };
    await this.policy.requireEligible(user, "onramp");
    await this.controls.requireOrdersOpen();
    if (!this.policy.offeredMethods().includes(method))
      throw new ApiError(
        503,
        "ramp_unavailable",
        `${method} payments are not available right now`,
        {
          reason: "method_unavailable",
          method,
        },
      );
    const instrument = await this.policy.requireInstrument();
    const q = this.figures("onramp", input.amount, instrument, method);
    if (input.expectedTokenAmount !== undefined && input.expectedTokenAmount !== q.tokenAmount)
      throw new ApiError(409, "ramp_quote_changed", "the price changed; review the new quote", {
        tokenAmount: formatAmount(q.tokenAmount),
        fee: formatAmount(q.fee),
      });
    await this.policy.requireWithinLimits(user.id, "onramp", q.fiatAmount);
    const id = randomUUID();
    const decision = await this.decideCreate("onramp.create", user, id, "onramp", q, { method });
    const { order, raced } = await this.insert(
      user,
      instrument,
      "onramp",
      q,
      idempotencyKey,
      requestHash,
      actor,
      {
        id,
        status: "created",
        method,
        payoutRail: null,
        paymentMethodId: null,
        bankAccountId: null,
        expiresAt: new Date(Date.now() + this.config.ramp.method[method].ttlMin * MINUTE_MS),
        risk: { "onramp.create": riskEntry(decision) },
        consentId: await this.policy.consentId(user.id),
        details: {},
      },
      { point: "onramp.create", alerts: decision.pending },
    );
    // A concurrent retry with the same key won the insert: it owns the acquirer call, never us.
    if (raced) {
      if (order.status === "created")
        throw new ApiError(409, "ramp_order_state", "this order is still being opened; retry", {
          orderId: order.id,
          status: order.status,
        });
      return { order: await this.apiOrder(order) };
    }
    let created: { paymentId: string; expiresAt: Date; next: RampPaymentNext };
    try {
      created = await this.provider.createPayment({
        orderId: order.id,
        method,
        reference: order.payoutReference,
        idempotencyKey: order.id,
        amount: order.fiatAmount,
        currency: order.fiatCurrency,
        description: `${formatAmount(order.tokenAmount)} ${instrument.symbol}`,
        returnUrl: `${this.config.ramp.publicAppUrl}/wallet/ramp/${order.id}`,
        notificationUrl: this.fulfilment.notificationUrl(),
        customer: { userId: user.id, ip: actor.ip ?? null },
        expiresAt: order.expiresAt ?? new Date(),
        require3ds: this.config.ramp.require3ds,
        // Closed loop: the card a purchase used becomes its cash-out destination.
        saveCard: method === "card",
      });
    } catch (err) {
      // A definitive refusal closes the order. An unknown outcome (timeout, 5xx) leaves it
      // `created`: the stale-created scan asks the acquirer by merchant reference (H5).
      if (ApiError.is(err) && err.status < 500)
        await this.store.transition(
          order,
          ["created"],
          "failed",
          { lastError: err.message.slice(0, 800) },
          { actor, detail: "the acquirer refused to create the payment" },
        );
      else
        await this.store.bump(
          order,
          { lastError: (err as Error).message.slice(0, 800) },
          { actor },
        );
      throw ApiError.is(err)
        ? err
        : new ApiError(502, "upstream_failed", "the acquirer could not open the payment");
    }
    const problem = rampNextProblem(created.next, {
      method,
      provider: this.provider.name,
      publicAppUrl: this.config.ramp.publicAppUrl,
      checkoutHosts: this.config.ramp.checkoutHosts,
      deeplinkSchemes: this.config.ramp.deeplinkSchemes,
      accountNumber: payoutReferenceDigits(order.payoutReference),
      amount: order.fiatAmount,
      fiatDecimals: this.config.ramp.fiatDecimals,
    });
    if (problem) {
      // X15: never store or show a link, QR or account we would not send the user to; void it.
      await this.voidQuietly(created.paymentId);
      await this.store.transition(
        order,
        ["created"],
        "failed",
        { providerPaymentId: created.paymentId, lastError: problem },
        { actor, detail: `the acquirer's payment details were refused (${problem})` },
      );
      this.logger.error(`order ${order.id}: payment details refused: ${problem}`);
      throw new ApiError(502, "upstream_failed", "the acquirer returned unusable payment details");
    }
    const opened = await this.store.transition(
      order,
      ["created"],
      "awaiting_payment",
      {
        providerPaymentId: created.paymentId,
        expiresAt: created.expiresAt,
        ...nextColumns(created.next),
      },
      { actor },
    );
    if (!opened) return this.lostOpening(order, created, actor);
    return { order: await this.apiOrder(order) };
  }

  /**
   * H5: the order moved while the acquirer was creating its payment (the stale-created scan). The
   * payment id is kept whatever happened; a closed order goes to review with it (the money may
   * still come) and the user gets no `next`.
   */
  private async lostOpening(
    order: RampOrderEntity,
    created: { paymentId: string; next: RampPaymentNext },
    actor: Actor,
  ): Promise<ApiRampOnrampResult> {
    const kept = await this.store.setOnce(order, "providerPaymentId", created.paymentId);
    if (order.status === "awaiting_payment" && order.providerPaymentId === created.paymentId) {
      // The scan adopted this very payment: show its `next`.
      if (!order.checkoutUrl && !order.paymentInstructions)
        await this.store.bump(order, nextColumns(created.next), { actor });
      return { order: await this.apiOrder(order) };
    }
    if (kept && ["failed", "expired", "cancelled"].includes(order.status)) {
      await this.voidQuietly(created.paymentId);
      await this.store.review(
        order,
        [order.status],
        "payment",
        "the acquirer created the payment after the order was closed",
        actor,
      );
    }
    throw new ApiError(409, "ramp_order_state", "this order could not be opened; start a new one", {
      orderId: order.id,
      status: order.status,
    });
  }

  private async voidQuietly(paymentId: string): Promise<void> {
    try {
      await this.provider.cancelPayment(paymentId);
    } catch (err) {
      this.logger.warn(`voiding payment ${paymentId} failed: ${(err as Error).message}`);
    }
  }

  // ───────────────────────────────────────────── off-ramp ───────────────────────────────────

  /**
   * `POST /ramp/offramp` — the rail offered, the destination (card: an eligible funding card that
   * can take P back now — refund mode — or a BY-issued one for an OCT; bank: S6's account checks),
   * the limits, the in-app balance, the card exposure for a non-refund exit (bank, OCT: I5), the
   * `offramp.create` decision; then the order the user's signed `Withdraw { amount }` binds to. A
   * refund-mode plan is stored with it: its parts reserve capacity on the card's captures (#13).
   */
  async createOfframp(
    user: UserEntity,
    input: { amount: bigint; destination: RampDestinationInput; expectedFiatAmount?: bigint },
    idempotencyKey: string,
    actor: Actor,
  ): Promise<ApiRampOfframpResult> {
    const { destination } = input;
    const requestHash = rampRequestHash({
      direction: "offramp",
      amount: input.amount,
      method: null,
      destination:
        destination.kind === "card"
          ? { kind: "card", paymentMethodId: destination.paymentMethodId }
          : { kind: "bank", bankAccountId: destination.bankAccountId },
    });
    const replay = await this.replay(user.id, idempotencyKey, requestHash);
    if (replay) return { order: await this.apiOrder(replay) };
    await this.policy.requireEligible(user, "offramp");
    await this.controls.requireOrdersOpen();
    const rail: RampPayoutRail = destination.kind;
    if (!this.policy.offeredRails().includes(rail))
      throw new ApiError(
        409,
        "ramp_rail_unavailable",
        `cash-outs to a ${rail === "card" ? "card" : "bank account"} are not available`,
        { rail },
      );
    const instrument = await this.policy.requireInstrument();
    const ref = { admin: instrument.admin, id: instrument.id };
    const q = this.figures("offramp", input.amount, instrument, undefined, destination);
    if (input.expectedFiatAmount !== undefined && input.expectedFiatAmount !== q.fiatAmount)
      throw new ApiError(409, "ramp_quote_changed", "the price changed; review the new quote", {
        fiatAmount: formatAmount(q.fiatAmount),
        fee: formatAmount(q.fee),
      });
    await this.policy.requireWithinLimits(user.id, "offramp", q.tokenAmount);

    let card: RampPaymentMethodEntity | null = null;
    let nonRefundExit = rail === "bank";
    if (destination.kind === "card") {
      card = await this.methods.findOne({
        where: { id: destination.paymentMethodId, userId: user.id },
      });
      if (
        !card ||
        card.status !== "active" ||
        !card.payoutEligible ||
        card.provider !== this.provider.name
      )
        throw new ApiError(
          403,
          "ramp_not_eligible",
          "cash-outs go back to a card you bought with",
          {
            reasons: ["no_payout_card"],
          },
        );
      const mode = this.policy.cardCashoutMode();
      if (mode === "oct") {
        if (!this.policy.octCountryAllowed(card))
          throw new ApiError(403, "ramp_not_eligible", "this card cannot receive a card payout", {
            reasons: ["no_payout_card"],
          });
        nonRefundExit = true;
      } else {
        const available = await this.cashout.available(user.id, card.id, null);
        if (q.fiatAmount > available) throw this.cardCashoutLimit(available);
      }
    } else {
      // S6: an active, proved BYN IBAN of this user that may take P now; until then 409 ramp_rail_unavailable.
      await this.bankRail.validateDestination(user.id, destination.bankAccountId, q.fiatAmount);
    }

    const party = user.partyId ?? "";
    const wallet = await this.ledger.fetchUserWallet(party, ref, { uncached: true });
    if (!wallet)
      throw new ApiError(409, "no_in_app_wallet", `you hold no in-app ${instrument.symbol}`, {
        instrument: ref,
      });
    if (wallet.balance < q.tokenAmount)
      throw new ApiError(
        409,
        "insufficient_balance",
        `your in-app ${instrument.symbol} balance is too low`,
        {
          balance: formatAmount(wallet.balance),
        },
      );
    if (nonRefundExit) {
      // I5: value bought by card may leave other than back to the card only above the exposure.
      const { withdrawable } = await this.policy.exposureView(user, ref);
      if (q.tokenAmount > withdrawable)
        throw new ApiError(
          409,
          "ramp_exposure",
          "value bought by card can go back to that card at any time, elsewhere only after the card dispute window",
          { withdrawableToBank: formatAmount(withdrawable) },
        );
    }
    const id = randomUUID();
    const decision = await this.decideCreate("offramp.create", user, id, "offramp", q, {
      rail,
      destination,
    });
    let details: Record<string, unknown> = {};
    if (card && this.policy.cardCashoutMode() === "refund") {
      // The plan reserves this card's capacity against every later cash-out (#13).
      const parts: CardCashoutPart[] | null = await this.cashout.plan(
        user.id,
        card.id,
        id,
        q.fiatAmount,
      );
      if (!parts) throw this.cardCashoutLimit(await this.cashout.available(user.id, card.id, null));
      details = { cardPayout: { mode: "refund", parts } };
    } else if (card) details = { cardPayout: { mode: "oct", parts: [] } };
    const { order } = await this.insert(
      user,
      instrument,
      "offramp",
      q,
      idempotencyKey,
      requestHash,
      actor,
      {
        id,
        status: "awaiting_withdrawal",
        method: null,
        payoutRail: rail,
        paymentMethodId: card?.id ?? null,
        bankAccountId: destination.kind === "bank" ? destination.bankAccountId : null,
        expiresAt: new Date(Date.now() + this.config.ramp.offrampSignTtlMin * MINUTE_MS),
        risk: { "offramp.create": riskEntry(decision) },
        consentId: await this.policy.consentId(user.id),
        details,
      },
      { point: "offramp.create", alerts: decision.pending },
    );
    return { order: await this.apiOrder(order, wallet.contractId) };
  }

  private cardCashoutLimit(available: bigint): ApiError {
    return new ApiError(
      409,
      "ramp_card_cashout_limit",
      `this card can take ${formatAmount(available)} back now; send the rest to a bank account`,
      { available: formatAmount(available) },
    );
  }

  /**
   * `POST /ramp/orders/:id/attach` — the user signed `Withdraw`; check the PendingPayout is the one
   * the order waits for (payee, instrument, exact amount, reason) and settle it now through
   * PayoutService, which binds it and runs MarkPaid. The payout scan does the same if this call is lost.
   * F6: a settlement blocked or in flight leaves the order waiting — said explicitly (`bindPending`
   * and why; the payee's neutral payout status, never an internal hold), still a 200.
   */
  async attach(
    user: UserEntity,
    orderId: string,
    cid: string,
    actor: Actor,
  ): Promise<ApiRampAttachResult> {
    const order = await this.requireOwned(user.id, orderId);
    if (
      order.direction !== "offramp" ||
      !["awaiting_withdrawal", "withdrawing"].includes(order.status)
    )
      throw new ApiError(409, "ramp_order_state", `this order is ${order.status}`, {
        status: order.status,
      });
    if (order.pendingPayoutCid && order.pendingPayoutCid !== cid)
      throw new ApiError(409, "ramp_order_state", "another withdrawal is bound to this order");
    const live = await this.ledger.fetchPendingPayout(cid, { uncached: true });
    if (
      !live ||
      live.user !== order.partyId ||
      live.reason !== "withdraw" ||
      live.amount !== order.tokenAmount ||
      live.instrument.admin !== order.instrumentAdmin ||
      live.instrument.id !== order.instrumentId
    )
      throw new ApiError(
        409,
        "ramp_order_state",
        "the signed withdrawal does not match this cash-out",
      );
    let bindReason = "not_bound";
    try {
      await this.payouts.settle(cid, {
        type: "user",
        userId: user.id,
        sessionId: actor.sessionId ?? undefined,
        ip: actor.ip ?? null,
      });
    } catch (err) {
      // Blocked or in flight: the payout row says why and the scans finish it; the order shows where it is.
      if (!ApiError.is(err) || err.status >= 500) throw err;
      bindReason = attachBindReason(err);
    }
    await this.fulfilment.advance(order.id);
    const fresh = await this.getOrder(user.id, order.id);
    const bindPending = fresh.status === "awaiting_withdrawal";
    return { order: fresh, bindPending, bindReason: bindPending ? bindReason : null };
  }

  /**
   * `POST /ramp/orders/:id/cancel` — before the user paid / signed, under the order lock. An
   * on-ramp is voided at the acquirer first (M7): `cancelled` → cancelled; `not_cancellable` →
   * 409 and the order stays (the payment may still arrive); `already_paid` → the capture is
   * applied and 409. An unreadable acquirer cancels nothing (I7).
   */
  async cancel(user: UserEntity, orderId: string, actor: Actor): Promise<ApiRampOrder> {
    await this.requireOwned(user.id, orderId);
    const lock = await this.redis.acquireLock(`lock:ramp:${orderId}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired)
      throw new ApiError(409, "ramp_order_state", "this order is being processed; try again");
    try {
      const order = await this.requireOwned(user.id, orderId);
      if (order.status === "awaiting_payment" && order.providerPaymentId) {
        const outcome = await this.provider.cancelPayment(order.providerPaymentId);
        if (outcome === "already_paid") {
          await this.fulfilment.applyPayment(
            order,
            await this.provider.getPayment(order.providerPaymentId),
          );
          throw new ApiError(409, "ramp_order_state", "this order is already paid", {
            status: order.status,
          });
        }
        if (outcome === "not_cancellable")
          throw new ApiError(409, "ramp_order_state", "the payment can no longer be cancelled", {
            status: order.status,
            reason: "not_cancellable",
          });
        await this.cancelled(order, ["awaiting_payment"], actor);
        return this.apiOrder(order);
      }
      if (order.status === "awaiting_withdrawal") {
        await this.cancelled(order, ["awaiting_withdrawal"], actor);
        return this.apiOrder(order);
      }
      throw new ApiError(409, "ramp_order_state", `this order is ${order.status}`, {
        status: order.status,
      });
    } finally {
      await lock.release();
    }
  }

  private async cancelled(
    order: RampOrderEntity,
    from: RampOrderStatus[],
    actor: Actor,
  ): Promise<void> {
    if (
      !(await this.store.transition(
        order,
        from,
        "cancelled",
        {},
        {
          actor,
          detail: "cancelled by the user",
        },
      ))
    )
      throw new ApiError(409, "ramp_order_state", `this order is already ${order.status}`, {
        status: order.status,
      });
  }

  // ───────────────────────────────────────────── webhooks ───────────────────────────────────

  /**
   * `POST /webhooks/ramp/:provider` (SPEC §8), checks in this order: the configured provider (else
   * 404) → for a provider in RAMP_IP_AUTH_PROVIDERS, the source address in its
   * RAMP_WEBHOOK_SOURCE_CIDRS → the signature over the raw body (JSON or form) → store first
   * (idempotent on the event key) → publish `{ eventId }`. Every refusal is `401 webhook_rejected`,
   * which the controller counts per (provider, source); a delivery that verifies is always stored.
   * Never makes the acquirer retry once the row is stored.
   */
  async receiveWebhook(provider: string, delivery: RampWebhookDelivery): Promise<void> {
    // Only the configured adapter, and only while it is usable (the mock never in prod / on mainnet).
    if (provider !== this.provider.name || !this.provider.isConfigured())
      throw new ApiError(404, "not_found", "unknown webhook");
    const hooks = this.config.rampWebhooks;
    if (
      hooks.ipAuthProviders.includes(provider) &&
      !new CidrList(hooks.sourceCidrs.get(provider) ?? []).has(delivery.sourceIp)
    )
      throw new ApiError(401, "webhook_rejected", "webhook source is not allowed");
    const { rawBody, headers } = delivery;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0)
      throw new ApiError(401, "webhook_rejected", "webhook body is missing or not JSON / form");
    const event = this.provider.verifyWebhook(rawBody, headers, {
      contentType: delivery.contentType,
      sourceIp: delivery.sourceIp,
    });
    if (!event) throw new ApiError(401, "webhook_rejected", "webhook signature rejected");
    const stored = await this.storeEvent(event, redactRampPayload(delivery.body));
    if (!stored.fresh) return;
    try {
      await this.nats.publish(
        NatsSubjects.rampWebhook(this.provider.name),
        { eventId: stored.id },
        { msgId: event.eventKey },
      );
    } catch (err) {
      // The row is durable; RampProcessor's sweep re-publishes it.
      this.logger.warn(
        `ramp webhook ${stored.id} stored but its trigger was not published: ${(err as Error).message}`,
      );
    }
  }

  private async storeEvent(
    event: RampWebhookEvent,
    payload: Record<string, unknown>,
  ): Promise<{ id: string; fresh: boolean }> {
    const res = await this.events
      .createQueryBuilder()
      .insert()
      .values({
        provider: this.provider.name,
        eventKey: event.eventKey,
        type: event.type,
        kind: event.kind,
        objectId: event.objectId,
        orderId: event.orderId && /^[0-9a-f-]{36}$/i.test(event.orderId) ? event.orderId : null,
        // TypeORM's deep-partial type cannot see through a jsonb `Record` (indexer/projection.ts jsonSafe).
        payload: payload as never,
        sandbox: event.sandbox,
        occurredAt: event.occurredAt,
        receivedAt: new Date(),
      })
      .orIgnore()
      .returning(["id"])
      .execute();
    const inserted = (res.raw as { id: string }[])[0];
    if (inserted) return { id: inserted.id, fresh: true };
    const existing = await this.events.findOneByOrFail({ eventKey: event.eventKey });
    return { id: existing.id, fresh: false };
  }

  /** Data minimisation: acquirer webhook payloads go after 30 days, like the KYC ones (ARCHITECTURE §9.7). */
  async purgeEventPayloads(retentionMs = 30 * DAY_MS): Promise<number> {
    const res = await this.events.update(
      { receivedAt: LessThan(new Date(Date.now() - retentionMs)), payload: Not(IsNull()) },
      { payload: null },
    );
    return res.affected ?? 0;
  }

  // ───────────────────────────────────────────── admin reads ────────────────────────────────

  /**
   * `GET /admin/ramp/orders?status&direction&userId&cursor` (SPEC §12.2): newest first; `cursor` (the
   * previous answer's `nextCursor`) pages by keyset like the user list, `page` still works.
   */
  async adminList(filter: {
    status?: RampOrderStatus;
    direction?: RampDirection;
    userId?: string;
    page?: number;
    limit?: number;
    cursor?: string;
  }): Promise<
    ApiPage<Awaited<ReturnType<RampOrderStore["toAdminApi"]>>> & { nextCursor: string | null }
  > {
    const limit = filter.limit ?? 25;
    const page = filter.cursor ? 1 : (filter.page ?? 1);
    const qb = this.store.orders
      .createQueryBuilder("o")
      .leftJoinAndSelect("o.paymentMethod", "pm")
      .orderBy("o.created_at", "DESC")
      .addOrderBy("o.id", "DESC");
    if (filter.status) qb.andWhere("o.status = :status", { status: filter.status });
    if (filter.direction) qb.andWhere("o.direction = :direction", { direction: filter.direction });
    if (filter.userId) qb.andWhere("o.user_id = :userId", { userId: filter.userId });
    const total = await qb.getCount();
    const after = decodeOrderCursor(filter.cursor);
    if (after)
      qb.andWhere("(o.created_at, o.id) < (:at, :id)", { at: after.createdAt, id: after.id });
    const rows = await qb
      .skip(after ? 0 : (page - 1) * limit)
      .take(limit + 1)
      .getMany();
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items: await Promise.all(items.map((o) => this.store.toAdminApi(o))),
      page,
      limit,
      total,
      nextCursor: rows.length > limit && last ? encodeOrderCursor(last) : null,
    };
  }

  /** `GET /admin/ramp/orders/:id` — the order with its webhooks, journal lines and audit trail. */
  async adminDetail(orderId: string): Promise<ApiAdminRampOrderDetail> {
    const order = await this.store.find(orderId);
    if (!order) throw new ApiError(404, "not_found", "order not found");
    const events = await this.events.find({ where: { orderId }, order: { receivedAt: "ASC" } });
    const trail = await this.audit.list({
      subjectType: "ramp_order",
      subjectId: orderId,
      page: 1,
      limit: 100,
    });
    const commands = await this.commands.find({
      where: { ref: orderId },
      order: { createdAt: "ASC" },
    });
    return {
      order: await this.store.toAdminApi(order),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        kind: e.kind,
        objectId: e.objectId,
        sandbox: e.sandbox,
        receivedAt: e.receivedAt.toISOString(),
        processedAt: e.processedAt?.toISOString() ?? null,
        attempts: e.attempts,
        nextAttemptAt: e.nextAttemptAt?.toISOString() ?? null,
        deadAt: e.deadAt?.toISOString() ?? null,
        error: e.error,
      })),
      journal: await this.journal.forOrder(orderId),
      tokenCommands: commands.map((c) => ({
        commandId: c.commandId,
        kind: c.kind,
        amount: formatAmount(c.amount),
        status: c.status,
        attempts: c.attempts,
        lastPostAt: c.lastPostAt?.toISOString() ?? null,
        lastError: c.lastError,
        recordedAt: c.recordedAt?.toISOString() ?? null,
        resolvedBy: c.resolvedBy,
      })),
      audit: trail.items.map((a) => this.audit.toApi(a)),
      approvals: await this.approvals.list({ subjectType: "ramp_order", subjectId: orderId }),
    };
  }

  // ───────────────────────────────────────────── helpers ────────────────────────────────────

  /** The quote with the method's (on) or the rail's (off) fee (SPEC §9.2, §9.3). */
  private figures(
    direction: RampDirection,
    amount: bigint,
    instrument: InstrumentEntity,
    method?: RampMethod,
    destination?: RampDestinationInput,
  ): RampQuoteFigures {
    const fee =
      direction === "onramp"
        ? this.policy.feeConfig({ method: method ?? "card" })
        : this.policy.feeConfig({ rail: destination?.kind ?? "card" });
    return quoteRamp(direction, amount, fee, this.config.ramp.fiatDecimals, instrument.decimals);
  }

  /**
   * A create point's decision (SPEC §11.5): deny refuses with the neutral `compliance` reason (the
   * order never exists); review lets the create proceed, flagged in `risk`, and its value point holds.
   */
  private async decideCreate(
    point: Extract<CompliancePoint, "onramp.create" | "offramp.create">,
    user: UserEntity,
    orderId: string,
    direction: RampDirection,
    q: RampQuoteFigures,
    extra: { method?: RampMethod; rail?: RampPayoutRail; destination?: RampDestinationInput },
  ) {
    const ctx: ComplianceContext = {
      point,
      userId: user.id,
      orderId,
      direction,
      method: extra.method ?? null,
      rail: extra.rail ?? null,
      fiatAmount: q.fiatAmount,
      tokenAmount: q.tokenAmount,
      currency: this.config.ramp.fiatCurrency,
      destination: extra.destination ?? null,
    };
    // C28: nothing is raised yet — the order's insert raises the alerts in its transaction.
    const decision = (await this.compliance.checkCreate(point, ctx)) ?? { ...ALLOW, pending: [] };
    if (decision.decision === "deny")
      throw new ApiError(403, "ramp_not_eligible", "this account cannot use the ramp right now", {
        reasons: ["compliance"],
      });
    return decision;
  }

  /** The user's view of an order with what only a read can add: the wallet to sign on, the bank destination. */
  private async apiOrder(order: RampOrderEntity, walletCid?: string): Promise<ApiRampOrder> {
    let withdraw: { walletContractId: string; amount: string } | null = null;
    if (order.status === "awaiting_withdrawal") {
      const cid =
        walletCid ??
        (
          await this.ledger
            .fetchUserWallet(order.partyId, {
              admin: order.instrumentAdmin,
              id: order.instrumentId,
            })
            .catch(() => null)
        )?.contractId ??
        "";
      withdraw = { walletContractId: cid, amount: formatAmount(order.tokenAmount) };
    }
    let bankDestination = null;
    if (order.payoutRail === "bank" && order.bankAccountId) {
      const d = await this.bankRail.describe(order.bankAccountId).catch(() => null);
      if (d)
        bankDestination = {
          kind: "bank" as const,
          bankAccountId: d.bankAccountId,
          bankName: d.bankName,
          ibanMasked: d.ibanMasked,
        };
    }
    return this.store.toApi(order, { withdraw, bankDestination });
  }

  /** The operator of record and the terms version, stamped on every order (R1). */
  private operatorSnapshot(): RampOperatorSnapshot {
    const { operator, termsVersion } = this.config.ramp;
    return { name: operator.name, unp: operator.unp, htpRef: operator.htpRef, termsVersion };
  }

  /**
   * Insert the order with its audit row in one transaction. The payout reference derives from the
   * order id; a unique-index collision re-derives it (m1). A unique violation of the idempotency
   * key is a racing retry (its order is answered); of the open-order index, `409 ramp_order_open`.
   */
  private async insert(
    user: UserEntity,
    instrument: InstrumentEntity,
    direction: RampDirection,
    q: RampQuoteFigures,
    idempotencyKey: string,
    requestHash: string,
    actor: Actor,
    seed: OrderSeed,
    created: { point: CompliancePoint; alerts: PendingAlert[] },
  ): Promise<{ order: RampOrderEntity; raced: boolean }> {
    for (let attempt = 0; ; attempt += 1) {
      const payoutReference = payoutReferenceFor(seed.id, attempt);
      try {
        await this.store.orders.manager.transaction(async (manager) => {
          // C28: the create decision's alerts exist only with their order (a refused or raced
          // insert rolls them back with it).
          const alertIds = await this.compliance.recordCreate(created.alerts, manager);
          const risk = alertIds.length
            ? {
                ...seed.risk,
                [created.point]: {
                  ...(seed.risk[created.point] as Record<string, unknown>),
                  alertIds,
                },
              }
            : seed.risk;
          await manager.insert(RampOrderEntity, {
            id: seed.id,
            userId: user.id,
            direction,
            status: seed.status,
            reviewStep: null,
            provider: this.provider.name,
            instrumentAdmin: instrument.admin,
            instrumentId: instrument.id,
            partyId: user.partyId ?? "",
            fiatCurrency: this.config.ramp.fiatCurrency,
            fiatAmount: q.fiatAmount,
            tokenAmount: q.tokenAmount,
            feeAmount: q.fee,
            method: seed.method,
            payoutRail: seed.payoutRail,
            paymentMethodId: seed.paymentMethodId,
            bankAccountId: seed.bankAccountId,
            payoutReference,
            operator: this.operatorSnapshot(),
            consentId: seed.consentId,
            risk,
            idempotencyKey,
            requestHash,
            expiresAt: seed.expiresAt,
            // The money transformer writes an unset bigint as NULL, not the column default.
            refundedAmount: 0n,
            details: {
              ...seed.details,
              timeline: [{ status: seed.status, at: new Date().toISOString() }],
            },
          } as never);
          await this.audit.record(
            {
              actorType: actor.type,
              actorUserId: actor.userId ?? null,
              actorSessionId: actor.sessionId ?? null,
              action: "ramp.order_created",
              subjectType: "ramp_order",
              subjectId: seed.id,
              metadata: {
                direction,
                status: seed.status,
                method: seed.method,
                rail: seed.payoutRail,
                fiatAmount: formatAmount(q.fiatAmount),
                tokenAmount: formatAmount(q.tokenAmount),
                fee: formatAmount(q.fee),
                instrument: { admin: instrument.admin, id: instrument.id },
                payoutReference,
                userId: user.id,
              },
              ip: actor.ip ?? null,
            },
            manager,
          );
        });
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code !== "23505") throw err;
        if (
          e.constraint === "uq_to_ramp_orders_payout_reference" &&
          attempt + 1 < REFERENCE_ATTEMPTS
        )
          continue;
        const raced = await this.store.orders.findOne({
          where: { userId: user.id, idempotencyKey },
        });
        if (raced) return { order: (await this.store.find(raced.id)) ?? raced, raced: true };
        const open = await this.store.orders.findOne({
          where: {
            userId: user.id,
            direction,
            method: seed.method ?? IsNull(),
            status: In(["created", "awaiting_payment", "awaiting_withdrawal"]),
          },
        });
        throw new ApiError(409, "ramp_order_open", "finish or cancel your open order first", {
          orderId: open?.id ?? null,
        });
      }
      const order = await this.store.find(seed.id);
      if (!order) throw new Error(`ramp order ${seed.id} vanished after its insert`);
      return { order, raced: false };
    }
  }
  /** The order a repeated `Idempotency-Key` already created; the key with another request is `409 idempotency_key_reused` (E-D9, L1). */
  private async replay(
    userId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<RampOrderEntity | null> {
    const existing = await this.store.orders.findOne({
      where: { userId, idempotencyKey },
      relations: { paymentMethod: true },
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash)
      throw new ApiError(
        409,
        "idempotency_key_reused",
        "this Idempotency-Key was used for a different request",
        { orderId: existing.id },
      );
    return existing;
  }

  private async requireOwned(userId: string, orderId: string): Promise<RampOrderEntity> {
    const order = await this.store.findOwned(orderId, userId);
    // A miss and someone else's order look the same.
    if (!order) throw new ApiError(404, "not_found", "order not found");
    return order;
  }
}

/** `<created_at ISO>|<id>` as base64url — opaque to clients. */
function encodeOrderCursor(o: { createdAt: Date; id: string }): string {
  return Buffer.from(`${o.createdAt.toISOString()}|${o.id}`, "utf8").toString("base64url");
}

function decodeOrderCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const createdAt = new Date(at ?? "");
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? ""))
    throw new ApiError(400, "validation_failed", "cursor is not valid");
  return { createdAt, id };
}

/** Where a validated `next` is stored: a redirect's URL, or the ERIP details (SPEC §3.1). */
function nextColumns(
  next: RampPaymentNext,
): Pick<RampOrderEntity, "checkoutUrl" | "paymentInstructions"> {
  return next.kind === "redirect"
    ? { checkoutUrl: next.url, paymentInstructions: null }
    : { checkoutUrl: null, paymentInstructions: next };
}
