import { createHash, createHmac, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";

import { Config } from "../config";
import type {
  RampCancelOutcome,
  RampCard,
  RampCardCashoutMode,
  RampCreatePaymentInput,
  RampCreatePayoutInput,
  RampMethod,
  RampPayer,
  RampPayerChannel,
  RampPayment,
  RampPaymentNext,
  RampPaymentStatus,
  RampPayout,
  RampPayoutStatus,
  RampProvider,
  RampProviderCapabilities,
  RampProviderHealth,
  RampRefund,
  RampThreeDs,
  RampWebhookEvent,
  RampWebhookMeta,
} from "../types";
import { eripPaymentNext } from "../util/erip";
import { ApiError } from "../util/errors";
import { formatAmountWithDecimals } from "../util/money";
import { timingSafeStringEqual } from "../util/strings";
import { rampIbanIndex } from "./ramp-bank-rail.port";

/** `x-mock-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` — the shape real acquirers use. */
export const MOCK_SIGNATURE_HEADER = "x-mock-signature";
/** A signed delivery older (or newer) than this is a replay and is rejected. */
export const MOCK_WEBHOOK_TOLERANCE_SEC = 300;
/** Bounded: the mock is one process of dev / test state, never a ledger of record. */
const MAX_OBJECTS = 2_000;

export type MockPaymentOutcome = "succeeded" | "declined" | "no_3ds";
export type MockPayoutBehaviour = "succeed" | "fail" | "hold";
export type MockRefundBehaviour = "succeed" | "pending" | "fail";

/** A 1×1 PNG: the mock ERIP QR (the real one is bePaid's `erip.qr_code`). */
export const MOCK_QR_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** How the payer finished a mock payment (SPEC §9.2: partial captures, cash channel, foreign cards). */
export interface MockCompleteOptions {
  /** Pick a different test card (default: one card per account). */
  cardSeed?: string;
  /** The card's issuer country (default BY). */
  cardCountry?: string;
  /** C ≠ F: a partial (or over-) capture. */
  capturedAmount?: bigint;
  /** The payer name the acquirer reports, and who supplied it (ERIP: the payer's bank). */
  payerName?: string;
  payerNameSource?: "bank" | "checkout";
  /** ERIP: how the money came in (default online). */
  channel?: RampPayerChannel;
  /** ERIP: the payer's IBAN (hashed at once, never kept) and bank. */
  payerIban?: string;
  payerBankBic?: string;
}

interface MockPayment {
  id: string;
  orderId: string;
  userId: string;
  method: RampMethod;
  settledAt: Date | null;
  payer: RampPayer | null;
  amount: bigint;
  capturedAmount: bigint | null;
  refundedAmount: bigint;
  chargebackAmount: bigint | null;
  currency: string;
  status: RampPaymentStatus;
  threeDs: RampThreeDs;
  card: RampCard | null;
  failureCode: string | null;
  createdAt: number;
}

interface MockPayout {
  id: string;
  orderId: string;
  amount: bigint;
  currency: string;
  status: RampPayoutStatus;
  failureCode: string | null;
  createdAt: number;
  recipient: { firstName: string; lastName: string };
  depositRef: string | null;
}

interface MockRefund {
  id: string;
  paymentId: string;
  key: string;
  amount: bigint;
  currency: string;
  status: RampPayoutStatus;
  description: string | null;
  fee: bigint | null;
}

export interface SignedDelivery {
  rawBody: Buffer;
  headers: Record<string, string>;
}

/** HMAC-SHA256 hex over `<t>.<body>` — exported so tests can sign (and mis-sign) deliveries. */
export function mockSignature(secret: string, timestamp: number, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(`${timestamp}.`, "utf8").update(rawBody).digest("hex");
}

/**
 * A signed delivery's fields: JSON `{id, type, data: {object_id, order_id}}`, or the same as form
 * fields `id, type, object_id, order_id` (form-posting acquirers, SPEC §8). null = unreadable.
 */
function mockDeliveryFields(
  rawBody: Buffer,
  contentType: string,
): { id: string; type: string; objectId: string; orderId: string | null } | null {
  const text = rawBody.toString("utf8");
  if (contentType.split(";")[0].trim().toLowerCase() === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(text);
    return {
      id: form.get("id") ?? "",
      type: form.get("type") ?? "",
      objectId: form.get("object_id") ?? "",
      orderId: form.get("order_id"),
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const data = (typeof b.data === "object" && b.data !== null ? b.data : {}) as Record<
    string,
    unknown
  >;
  return {
    id: typeof b.id === "string" ? b.id : "",
    type: typeof b.type === "string" ? b.type : "",
    objectId: typeof data.object_id === "string" ? data.object_id : "",
    orderId: typeof data.order_id === "string" ? data.order_id : null,
  };
}

/**
 * The mock acquirer (SPEC §9) — dev / test only (config.ts refuses it with RAMP_ENABLED in prod
 * or on mainnet; RampMockController exists only while it is selected). It behaves like bePaid:
 * `createPayment` answers a card checkout URL (the frontend's mock checkout page) or ERIP payment
 * details (RAMP_MOCK_ERIP_SERVICE_CODE, the order's reference digits as the account number, a QR),
 * card cash-out by partial refunds (`cardCashoutMode`, refund by default; `oct` and `none` for
 * the other paths), `complete` settles the payment the way a payer would and returns a SIGNED webhook
 * delivery that the caller posts through the same `/webhooks/ramp/mock` pipeline a real acquirer
 * uses. Like a real one, it keeps two memories: the idempotency keys of refunds / payouts (which
 * `forgetIdempotencyKeys()` drops, as a PSP does after its retention window) and the objects
 * themselves, found by merchant reference (`findPaymentByOrder`, `findRefund`,
 * `findPayoutByOrder`), which outlive the keys (I3). Test knobs: `payoutBehaviour`,
 * `refundBehaviour`, `cancelBehaviour`, `payoutTimeouts`, `createTimeouts`, `onCreatePayment`,
 * `lookupFailure`, `readFailure`.
 * Payouts complete on the first `getPayout`. State lives in memory.
 */
@Injectable()
export class RampProviderMockService implements RampProvider {
  readonly name = "mock" as const;
  /** How a card cash-out works (SPEC §9.3): bePaid partial refunds by default. */
  cardCashoutMode: RampCardCashoutMode = "refund";
  /** Methods the mock refunds itself (bePaid refunds ERIP only after settlement; the mock never). */
  refundMethods: RampMethod[] = ["card"];
  /** Set: the next ERIP payment's details take these fields (a tampered adapter; X15). */
  eripNextOverride: Partial<Extract<RampPaymentNext, { kind: "erip" }>> | null = null;
  /** Per payment id: how ITS next refund ends (a card cash-out part failing; overrides refundBehaviour). */
  readonly refundBehaviourFor = new Map<string, MockRefundBehaviour>();
  /** The fee a new refund reports (null = the acquirer charges nothing for refunds). */
  refundFee: bigint | null = null;
  /** How a pending payout ends on its next read (the reversal / review paths). */
  payoutBehaviour: MockPayoutBehaviour = "succeed";
  /** How a new refund ends: at once, later (`settleRefunds`), or refused. */
  refundBehaviour: MockRefundBehaviour = "succeed";
  /** `not_cancellable` = the acquirer can no longer void the checkout (M7). */
  cancelBehaviour: "cancel" | "not_cancellable" = "cancel";
  /** The next N createPayout calls execute the payout and then time out (C3, #3). */
  payoutTimeouts = 0;
  /** Set: every find* lookup throws it (fail closed, I3). */
  lookupFailure: Error | null = null;
  /** Set: getPayment / getPayout throw it (the acquirer API is down). */
  readFailure: Error | null = null;
  /** The next N createPayment calls create the payment and then time out (H5). */
  createTimeouts = 0;
  /** Runs inside createPayment once the payment exists, before the answer (a race window for tests). */
  onCreatePayment: ((orderId: string) => Promise<void>) | null = null;
  /** Set: createPayment answers this checkout link (a tampered or broken adapter; E-D7). */
  checkoutUrlOverride: string | null = null;
  private readonly payments = new Map<string, MockPayment>();
  private readonly payouts = new Map<string, MockPayout>();
  private readonly refunds = new Map<string, MockRefund>();
  /** The PSP's idempotency memory (RequestID retention): key → object id. */
  private readonly payoutKeys = new Map<string, string>();
  private readonly refundKeys = new Map<string, string>();
  private clock = 0;

  constructor(private readonly config: Config) {}

  get capabilities(): RampProviderCapabilities {
    return {
      methods: ["card", "erip"],
      refundMethods: [...this.refundMethods],
      cardCashout: this.cardCashoutMode,
      cardRefundMaxDays: 180,
      payoutDomesticOnly: true,
      cancelPayment: true,
      eripRefundMinHoursAfterSettle: 24,
      eripServiceCode: this.config.ramp.mockEripServiceCode,
    };
  }

  isConfigured(): boolean {
    return (
      this.config.ramp.provider === "mock" &&
      !this.config.isMainnet &&
      this.config.appEnv !== "prod"
    );
  }

  async healthCheck(): Promise<RampProviderHealth> {
    const configured = this.isConfigured();
    return {
      ok: configured,
      message: configured
        ? "mock acquirer active (dev / test only)"
        : "mock acquirer is refused in prod and on mainnet",
      upstreamStatus: null,
      checkedAt: new Date().toISOString(),
      details: { payments: this.payments.size, payouts: this.payouts.size },
    };
  }

  async createPayment(
    input: RampCreatePaymentInput,
  ): Promise<{ paymentId: string; expiresAt: Date; next: RampPaymentNext }> {
    if (!this.capabilities.methods.includes(input.method))
      throw new ApiError(400, "validation_failed", `mock acquirer: no ${input.method} payments`);
    const id = `mockpay_${randomUUID()}`;
    this.remember(this.payments, id, {
      id,
      orderId: input.orderId,
      userId: input.customer.userId,
      method: input.method,
      settledAt: null,
      payer: null,
      amount: input.amount,
      capturedAmount: null,
      refundedAmount: 0n,
      chargebackAmount: null,
      currency: input.currency,
      status: "pending",
      threeDs: "unknown",
      card: null,
      failureCode: null,
      createdAt: (this.clock += 1),
    });
    if (this.onCreatePayment) await this.onCreatePayment(input.orderId);
    if (this.createTimeouts > 0) {
      this.createTimeouts -= 1;
      throw new ApiError(
        502,
        "upstream_failed",
        "mock acquirer: timeout (the payment was created)",
      );
    }
    if (input.method === "erip")
      return { paymentId: id, expiresAt: input.expiresAt, next: this.eripNext(input) };
    const query = new URLSearchParams({ payment: id, order: input.orderId });
    return {
      paymentId: id,
      expiresAt: input.expiresAt,
      next: {
        kind: "redirect",
        url:
          this.checkoutUrlOverride ??
          `${this.config.ramp.publicAppUrl}/wallet/ramp/mock-checkout?${query.toString()}`,
      },
    };
  }

  /** What bePaid's ERIP invoice answers: service code, account number (our reference digits), amount, QR. */
  private eripNext(input: RampCreatePaymentInput): Extract<RampPaymentNext, { kind: "erip" }> {
    const next = eripPaymentNext({
      serviceCode: this.config.ramp.mockEripServiceCode,
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      fiatDecimals: this.config.ramp.fiatDecimals,
    });
    const shown = formatAmountWithDecimals(input.amount, this.config.ramp.fiatDecimals);
    return {
      ...next,
      qrPng: MOCK_QR_PNG,
      qrRaw: `ERIP|${next.serviceCode}|${next.accountNumber}|${shown}`,
      ...(this.eripNextOverride ?? {}),
    };
  }

  async getPayment(paymentId: string): Promise<RampPayment> {
    if (this.readFailure) throw this.readFailure;
    const p = this.payments.get(paymentId);
    if (!p) throw new ApiError(502, "upstream_failed", "mock acquirer: unknown payment");
    return this.paymentView(p);
  }

  async findPaymentByOrder(orderId: string): Promise<RampPayment | null> {
    if (this.lookupFailure) throw this.lookupFailure;
    const found = [...this.payments.values()]
      .filter((p) => p.orderId === orderId)
      .sort((x, y) => y.createdAt - x.createdAt)[0];
    return found ? this.paymentView(found) : null;
  }

  async cancelPayment(paymentId: string): Promise<RampCancelOutcome> {
    const p = this.payments.get(paymentId);
    if (!p) throw new ApiError(502, "upstream_failed", "mock acquirer: unknown payment");
    if (p.capturedAmount !== null) return "already_paid";
    if (p.status !== "pending") return "cancelled";
    if (this.cancelBehaviour === "not_cancellable") return "not_cancellable";
    p.status = "cancelled";
    return "cancelled";
  }

  async refundPayment(
    paymentId: string,
    amount: bigint,
    idempotencyKey: string,
    description?: string,
  ): Promise<{ refundId: string; status: RampPayoutStatus }> {
    const remembered = this.refundKeys.get(idempotencyKey);
    const known = remembered ? this.refunds.get(remembered) : undefined;
    if (known) return { refundId: known.id, status: known.status };
    const p = this.payments.get(paymentId);
    if (!p) throw new ApiError(502, "upstream_failed", "mock acquirer: unknown payment");
    if (!this.refundMethods.includes(p.method))
      throw new ApiError(
        502,
        "upstream_failed",
        `mock acquirer: ${p.method} payments are not refundable here`,
      );
    if (p.capturedAmount === null || (p.status !== "succeeded" && p.status !== "refunded"))
      throw new ApiError(502, "upstream_failed", `mock acquirer: payment is ${p.status}`);
    if (amount <= 0n || p.refundedAmount + amount > p.capturedAmount)
      throw new ApiError(502, "upstream_failed", "mock acquirer: refund exceeds the capture");
    const behaviour = this.refundBehaviourFor.get(paymentId) ?? this.refundBehaviour;
    const id = `mockrf_${randomUUID()}`;
    const refund: MockRefund = {
      id,
      paymentId,
      key: idempotencyKey,
      amount,
      currency: p.currency,
      status: behaviour === "fail" ? "failed" : "pending",
      description: description ?? null,
      fee: this.refundFee,
    };
    this.refunds.set(id, refund);
    this.refundKeys.set(idempotencyKey, id);
    if (behaviour === "succeed") this.settleRefund(refund);
    return { refundId: id, status: refund.status };
  }

  async findRefund(paymentId: string, key: string): Promise<RampRefund | null> {
    if (this.lookupFailure) throw this.lookupFailure;
    const r = [...this.refunds.values()].find((x) => x.paymentId === paymentId && x.key === key);
    return r
      ? {
          refundId: r.id,
          paymentId: r.paymentId,
          key: r.key,
          status: r.status,
          amount: r.amount,
          currency: r.currency,
          fee: r.fee,
        }
      : null;
  }

  async createPayout(
    input: RampCreatePayoutInput,
  ): Promise<{ payoutId: string; status: RampPayoutStatus }> {
    // Idempotent on the key while the acquirer still remembers it (adapter checklist).
    const existing = this.payoutKeys.get(input.idempotencyKey);
    const known = existing ? this.payouts.get(existing) : undefined;
    if (known) return { payoutId: known.id, status: known.status };
    const id = `mockpo_${randomUUID()}`;
    this.payoutKeys.set(input.idempotencyKey, id);
    this.remember(this.payouts, id, {
      id,
      orderId: input.orderId,
      amount: input.amount,
      currency: input.currency,
      status: "pending",
      failureCode: null,
      createdAt: (this.clock += 1),
      recipient: { ...input.recipient },
      depositRef: input.depositRef ?? null,
    });
    if (this.payoutTimeouts > 0) {
      this.payoutTimeouts -= 1;
      throw new ApiError(502, "upstream_failed", "mock acquirer: timeout (the payout was created)");
    }
    return { payoutId: id, status: "pending" };
  }

  async getPayout(payoutId: string): Promise<RampPayout> {
    if (this.readFailure) throw this.readFailure;
    const po = this.payouts.get(payoutId);
    if (!po) throw new ApiError(502, "upstream_failed", "mock acquirer: unknown payout");
    if (po.status === "pending" && this.payoutBehaviour !== "hold") {
      po.status = this.payoutBehaviour === "succeed" ? "succeeded" : "failed";
      po.failureCode = this.payoutBehaviour === "fail" ? "card_not_eligible_for_credit" : null;
    }
    return this.payoutView(po);
  }

  async findPayoutByOrder(orderId: string): Promise<RampPayout | null> {
    if (this.lookupFailure) throw this.lookupFailure;
    const found = [...this.payouts.values()]
      .filter((po) => po.orderId === orderId)
      .sort((x, y) => y.createdAt - x.createdAt)[0];
    return found ? this.payoutView(found) : null;
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    meta: RampWebhookMeta,
  ): RampWebhookEvent | null {
    const raw = headers[MOCK_SIGNATURE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return null;
    const parts = new Map(
      header.split(",").map((kv) => {
        const at = kv.indexOf("=");
        return [kv.slice(0, at).trim(), kv.slice(at + 1).trim()] as const;
      }),
    );
    const t = Number(parts.get("t"));
    const v1 = parts.get("v1") ?? "";
    if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return null;
    if (Math.abs(Date.now() / 1000 - t) > MOCK_WEBHOOK_TOLERANCE_SEC) return null;
    if (!timingSafeStringEqual(v1, mockSignature(this.config.ramp.mockWebhookSecret, t, rawBody)))
      return null;
    const fields = mockDeliveryFields(rawBody, meta.contentType);
    if (!fields) return null;
    const { id, type, objectId, orderId } = fields;
    if (!id || !type || !objectId) return null;
    const kind = type.split(".")[0];
    return {
      eventKey: `mock:${id}`,
      type,
      kind:
        kind === "payment" || kind === "payout" || kind === "refund" || kind === "chargeback"
          ? kind
          : "unknown",
      objectId,
      orderId,
      occurredAt: new Date(t * 1000),
      sandbox: true,
    };
  }

  // ── mock driver (RampMockController, tests) ──────────────────────────────────────────────

  /**
   * The payer finishes the payment: the card checkout (`cardSeed` picks the card, default one per
   * user; `cardCountry` its issuer) or ERIP (`payerName` / `payerNameSource`, `channel`,
   * `payerIban`, `payerBankBic`). `capturedAmount` makes a partial (or over-) capture, C ≠ F.
   * `paymentId` may also be the ORDER id (the user API shows no payment id for ERIP).
   */
  complete(
    paymentId: string,
    userId: string,
    outcome: MockPaymentOutcome,
    opts: MockCompleteOptions = {},
  ): SignedDelivery {
    const p = this.requireOwnPayment(this.paymentIdOf(paymentId), userId);
    if (p.status !== "pending" && p.status !== "cancelled" && p.status !== "expired")
      throw new ApiError(409, "ramp_order_state", `the mock payment is already ${p.status}`);
    if (outcome === "declined") {
      p.status = "failed";
      p.failureCode = p.method === "card" ? "card_declined" : "payment_declined";
      p.threeDs = p.method === "card" ? "not_authenticated" : "unknown";
    } else {
      // A capture after cancel / expiry is what a late-settling acquirer does (H6).
      p.status = "succeeded";
      p.capturedAmount = opts.capturedAmount ?? p.amount;
      p.settledAt = new Date();
      if (p.method === "card") {
        p.threeDs = outcome === "no_3ds" ? "not_authenticated" : "authenticated";
        p.card = mockCard(opts.cardSeed ?? userId, opts.cardCountry);
        p.payer = {
          name: opts.payerName ?? null,
          nameSource: opts.payerName ? (opts.payerNameSource ?? "checkout") : null,
          channel: "card",
        };
      } else {
        p.threeDs = "unknown";
        p.payer = {
          name: opts.payerName ?? null,
          nameSource: opts.payerName ? (opts.payerNameSource ?? "bank") : null,
          channel: opts.channel ?? "online",
          bankBic: opts.payerBankBic ?? null,
          ibanHash: opts.payerIban
            ? rampIbanIndex(this.config.sealing.index, opts.payerIban)
            : null,
        };
      }
    }
    return this.delivery(`payment.${p.status}`, p.id, p.orderId);
  }

  /** An order id → its latest payment's id (anything else is taken as a payment id). */
  private paymentIdOf(id: string): string {
    if (this.payments.has(id)) return id;
    const latest = [...this.payments.values()]
      .filter((p) => p.orderId === id)
      .sort((x, y) => y.createdAt - x.createdAt)[0];
    return latest?.id ?? id;
  }

  /**
   * The issuer disputes a captured payment (also after a refund: #10). Default amount: what is not
   * refunded (C − refunded), or C for a fully refunded payment (the issuer disputes the original).
   */
  chargeback(paymentId: string, userId: string, amount?: bigint): SignedDelivery {
    const p = this.requireOwnPayment(paymentId, userId);
    if (p.status !== "succeeded" && p.status !== "refunded")
      throw new ApiError(409, "ramp_order_state", `the mock payment is ${p.status}`);
    const captured = p.capturedAmount ?? p.amount;
    p.chargebackAmount =
      amount ?? (p.status === "refunded" ? captured : captured - p.refundedAmount);
    p.status = "chargeback";
    return this.delivery("chargeback.created", p.id, p.orderId);
  }

  /** The merchant won the dispute: the money comes back. */
  disputeWon(paymentId: string): SignedDelivery {
    const p = this.requirePayment(paymentId);
    if (p.status !== "chargeback")
      throw new ApiError(409, "ramp_order_state", `the mock payment is ${p.status}`);
    p.status = "chargeback_reversed";
    return this.delivery("chargeback.reversed", p.id, p.orderId);
  }

  /** The acquirer refunds on its own (its risk desk; H4). Default: everything not yet refunded. */
  pspRefund(paymentId: string, amount?: bigint): SignedDelivery {
    const p = this.requirePayment(paymentId);
    if (p.capturedAmount === null)
      throw new ApiError(409, "ramp_order_state", "the mock payment was never captured");
    const take = amount ?? p.capturedAmount - p.refundedAmount;
    const id = `mockrf_${randomUUID()}`;
    const refund: MockRefund = {
      id,
      paymentId,
      key: `psp-${id}`,
      amount: take,
      currency: p.currency,
      status: "pending",
      description: null,
      fee: null,
    };
    this.refunds.set(id, refund);
    this.settleRefund(refund);
    return this.delivery("payment.refunded", p.id, p.orderId);
  }

  /** The acquirer's own checkout expiry. */
  expire(paymentId: string): void {
    const p = this.requirePayment(paymentId);
    if (p.status === "pending") p.status = "expired";
  }

  /** `refundBehaviour = pending`: the refunds land now. */
  settleRefunds(): void {
    for (const r of this.refunds.values()) if (r.status === "pending") this.settleRefund(r);
  }

  /** The PSP's idempotency memory expired (RequestID retention): a repeated key creates a new object. */
  forgetIdempotencyKeys(): void {
    this.payoutKeys.clear();
    this.refundKeys.clear();
  }

  /** How many payouts the acquirer holds for an order (what a double payout would show). */
  payoutsFor(orderId: string): RampPayout[] {
    return [...this.payouts.values()]
      .filter((po) => po.orderId === orderId)
      .map((po) => this.payoutView(po));
  }

  /** A signed delivery for an arbitrary event — what a real acquirer would POST. */
  delivery(type: string, objectId: string, orderId: string | null): SignedDelivery {
    const t = Math.floor(Date.now() / 1000);
    const rawBody = Buffer.from(
      JSON.stringify({
        id: `evt_${randomUUID()}`,
        type,
        created: t,
        livemode: false,
        data: { object_id: objectId, order_id: orderId },
      }),
      "utf8",
    );
    return {
      rawBody,
      headers: {
        "content-type": "application/json",
        [MOCK_SIGNATURE_HEADER]: `t=${t},v1=${mockSignature(this.config.ramp.mockWebhookSecret, t, rawBody)}`,
      },
    };
  }

  /** The OCT recipient and statement reference a payout was created with. */
  payoutRequestOf(
    payoutId: string,
  ): { recipient: { firstName: string; lastName: string }; depositRef: string | null } | null {
    const po = this.payouts.get(payoutId);
    return po ? { recipient: { ...po.recipient }, depositRef: po.depositRef } : null;
  }

  /** The refunds the acquirer holds for a payment (card cash-out parts and refunds). */
  refundsOf(paymentId: string): RampRefund[] {
    return [...this.refunds.values()]
      .filter((r) => r.paymentId === paymentId)
      .map((r) => ({
        refundId: r.id,
        paymentId: r.paymentId,
        key: r.key,
        status: r.status,
        amount: r.amount,
        currency: r.currency,
        fee: r.fee,
      }));
  }

  /** The description a refund was created with (the payout reference). */
  refundDescriptionOf(refundId: string): string | null {
    return this.refunds.get(refundId)?.description ?? null;
  }

  reset(): void {
    this.payments.clear();
    this.payouts.clear();
    this.refunds.clear();
    this.payoutKeys.clear();
    this.refundKeys.clear();
    this.cardCashoutMode = "refund";
    this.refundMethods = ["card"];
    this.eripNextOverride = null;
    this.refundBehaviourFor.clear();
    this.refundFee = null;
    this.payoutBehaviour = "succeed";
    this.refundBehaviour = "succeed";
    this.cancelBehaviour = "cancel";
    this.payoutTimeouts = 0;
    this.lookupFailure = null;
    this.readFailure = null;
    this.createTimeouts = 0;
    this.onCreatePayment = null;
    this.checkoutUrlOverride = null;
  }

  private settleRefund(r: MockRefund): void {
    const p = this.payments.get(r.paymentId);
    if (!p || p.capturedAmount === null) return;
    r.status = "succeeded";
    p.refundedAmount += r.amount;
    if (p.refundedAmount >= p.capturedAmount && p.status === "succeeded") p.status = "refunded";
  }

  private paymentView(p: MockPayment): RampPayment {
    return {
      paymentId: p.id,
      orderId: p.orderId,
      status: p.status,
      method: p.method,
      amount: p.amount,
      capturedAmount: p.capturedAmount,
      refundedAmount: p.refundedAmount,
      chargebackAmount: p.chargebackAmount,
      fee: null,
      currency: p.currency,
      threeDs: p.threeDs,
      card: p.card ? { ...p.card } : null,
      failureCode: p.failureCode,
      sandbox: true,
      settledAt: p.settledAt,
      payer: p.payer ? { ...p.payer } : null,
      rrn:
        p.method === "card" && p.capturedAmount !== null ? `rrn${hash(p.id).slice(0, 10)}` : null,
      erip:
        p.method === "erip" && p.capturedAmount !== null
          ? {
              transactionId: `erip${hash(p.id).slice(0, 12)}`,
              agentCode: "MOCK01",
              agentName: "Mock agent bank",
            }
          : null,
    };
  }

  private payoutView(po: MockPayout): RampPayout {
    return {
      payoutId: po.id,
      orderId: po.orderId,
      status: po.status,
      amount: po.amount,
      currency: po.currency,
      failureCode: po.failureCode,
      sandbox: true,
      fee: null,
    };
  }

  private requirePayment(paymentId: string): MockPayment {
    const p = this.payments.get(paymentId);
    if (!p) throw new ApiError(404, "not_found", "payment not found");
    return p;
  }

  private requireOwnPayment(paymentId: string, userId: string): MockPayment {
    const p = this.payments.get(paymentId);
    // A miss and someone else's payment look the same.
    if (!p || p.userId !== userId) throw new ApiError(404, "not_found", "payment not found");
    return p;
  }

  private remember<T>(map: Map<string, T>, id: string, value: T): void {
    map.set(id, value);
    if (map.size > MAX_OBJECTS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
}

function hash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 24);
}

/** A deterministic test card per seed: the same seed is the same card (fingerprint), as with a real acquirer. */
function mockCard(seed: string, issuerCountry = "BY"): RampCard {
  const h = hash(`card|${seed}`);
  return {
    token: `mocktok_${h}`,
    fingerprint: `mockfp_${h}`,
    brand: "VISA",
    last4: String(parseInt(h.slice(0, 6), 16) % 10_000).padStart(4, "0"),
    expMonth: 12,
    expYear: 2030,
    issuerCountry: issuerCountry.toUpperCase(),
    issuerName: "Mock Issuer Bank",
  };
}
