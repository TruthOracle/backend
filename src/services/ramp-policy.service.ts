import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, MoreThanOrEqual, Not, Repository } from "typeorm";

import { Config, type RampDirectionConfig, type RampFeeConfig } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import { LedgerPayoutEntity } from "../entities/ledger-payout.entity";
import { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import type { UserEntity } from "../entities/user.entity";
import {
  RAMP_PROVIDER,
  sameInstrument,
  type Actor,
  type InstrumentId,
  type LedgerPayoutSettledKind,
  type PayoutStatus,
  type PendingPayoutRecord,
  type RampCardCashoutMode,
  type RampDirection,
  type RampLimitName,
  type RampMethod,
  type RampPayment,
  type RampPaymentNext,
  type RampPayoutRail,
  type RampProvider,
  type RampProviderCapabilities,
} from "../types";
import { ApiError } from "../util/errors";
import {
  AMOUNT_DECIMALS,
  formatAmount,
  formatAmountWithDecimals,
  quantizeDown,
  tryParseAmount,
} from "../util/money";
import { DAY_MS } from "../util/time";
import { ComplianceFreezePort } from "./compliance-freeze.port";
import { InstrumentsService } from "./instruments.service";
import { KycService } from "./kyc.service";
import { LedgerClientService } from "./ledger-client.service";
import { RampBankRailPort } from "./ramp-bank-rail.port";
import { RampCardCashoutService } from "./ramp-card-cashout.service";
import { RampCompliancePort } from "./ramp-compliance.port";
import { RampGatesService } from "./ramp-gates.service";
import { RAMP_UNCOUNTED, RampOrderStore } from "./ramp-order-store.service";
import { RampReleaseGuard } from "./ramp-release-guard.service";
import { TokenAppService } from "./token-app.service";

/**
 * Holds a step sets and lifts itself (MarkPaid's own deferrals — also mirrored as `blocked_*` —
 * and a freeze); any other (a chargeback) never lifts by itself (R1-4).
 */
const SELF_LIFTING_HOLDS: ReadonlySet<string> = new Set([
  "payout_gate",
  "exposure",
  "compliance",
  "frozen",
]);

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested in ramp-policy.service.spec.ts)
// ---------------------------------------------------------------------------------------------

/** Round up to what a currency with `decimals` can represent (a fee never rounds in the user's favour into dust we cannot collect). */
export function quantizeUp(amount: bigint, decimals: number): bigint {
  const down = quantizeDown(amount, decimals);
  if (down === amount) return amount;
  return down + 10n ** BigInt(AMOUNT_DECIMALS - decimals);
}

/** `fixed + amount × bps / 10 000`, rounded up to the fiat's smallest unit. */
export function rampFee(amount: bigint, cfg: RampFeeConfig, fiatDecimals: number): bigint {
  const pct = (amount * BigInt(cfg.feeBps) + 9_999n) / 10_000n;
  return quantizeUp(cfg.feeFixed + pct, fiatDecimals);
}

export interface RampQuoteFigures {
  fiatAmount: bigint;
  tokenAmount: bigint;
  fee: bigint;
}

/**
 * docs/RAMP.md §1: the amount is always the side the user gives — fiat paid on-ramp, tokens
 * withdrawn off-ramp — and must be whole in the fiat's decimals (1 BYN = 1 token, so the other
 * side is exact) and in the token's. The fee (the method's on-ramp, the rail's off-ramp; SPEC
 * §9.2, §9.3) comes off the side the user receives.
 */
export function quoteRamp(
  direction: RampDirection,
  amount: bigint,
  cfg: RampFeeConfig,
  fiatDecimals: number,
  tokenDecimals: number,
): RampQuoteFigures {
  if (amount <= 0n) throw new ApiError(400, "validation_failed", "amount must be positive");
  if (quantizeDown(amount, fiatDecimals) !== amount)
    throw new ApiError(
      400,
      "validation_failed",
      `amount carries more than ${fiatDecimals} decimals (the fiat's smallest unit)`,
    );
  if (quantizeDown(amount, tokenDecimals) !== amount)
    throw new ApiError(
      400,
      "validation_failed",
      `amount is finer than the token's ${tokenDecimals} decimals`,
    );
  const fee = rampFee(amount, cfg, fiatDecimals);
  const net = amount - fee;
  if (net <= 0n)
    throw new ApiError(400, "validation_failed", "amount does not cover the fee", {
      fee: formatAmount(fee),
    });
  return direction === "onramp"
    ? { fiatAmount: amount, tokenAmount: net, fee }
    : { fiatAmount: net, tokenAmount: amount, fee };
}

/** One card on-ramp's dispute risk (SPEC §9.3): C − refunded − charged back. */
export interface ExposureRow {
  captured: bigint;
  refunded: bigint;
  chargedBack: bigint;
}

/** Exposure = Σ (C − refunded − charged back) of recent card captures (I5); never negative per row. */
export function cardExposure(rows: readonly ExposureRow[]): bigint {
  return rows.reduce((sum, r) => {
    const left = r.captured - r.refunded - r.chargedBack;
    return sum + (left > 0n ? left : 0n);
  }, 0n);
}

/**
 * What may leave other than back to a funding card (SPEC §9.3): max(0, balance (+ the payout being
 * settled, already debited from it) − exposure).
 */
export function withdrawableBeyondExposure(
  balance: bigint,
  alreadyDebited: bigint,
  exposure: bigint,
): bigint {
  const free = balance + alreadyDebited - exposure;
  return free > 0n ? free : 0n;
}

/**
 * E-D7 / X15: where a checkout redirect may point. The mock's page is the app's own
 * (RAMP_PUBLIC_APP_URL's origin, http allowed off-prod: the mock is refused prod-like); a real
 * acquirer's must be https, without credentials, on a host of RAMP_CHECKOUT_HOSTS. Returns the
 * problem, or null when the URL may be stored and shown.
 */
export function checkoutUrlProblem(
  raw: string,
  ctx: { provider: string; publicAppUrl: string; checkoutHosts: readonly string[] },
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "checkout_url_malformed";
  }
  if (url.username || url.password) return "checkout_url_credentials";
  if (ctx.provider === "mock") {
    let app: URL;
    try {
      app = new URL(ctx.publicAppUrl);
    } catch {
      return "checkout_url_unexpected_origin";
    }
    return url.origin === app.origin ? null : "checkout_url_unexpected_origin";
  }
  if (url.protocol !== "https:") return "checkout_url_not_https";
  return ctx.checkoutHosts.includes(url.hostname.toLowerCase())
    ? null
    : "checkout_url_unknown_host";
}

const NEXT_KEYS: Record<RampPaymentNext["kind"], ReadonlySet<string>> = {
  redirect: new Set(["kind", "url"]),
  erip: new Set([
    "kind",
    "serviceCode",
    "accountNumber",
    "amount",
    "instructions",
    "qrPng",
    "qrRaw",
    "deeplinks",
  ]),
};
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const QR_PNG_MAX_BYTES = 64 * 1024;
const TEXT_MAX = 512;
/** C0 controls and DEL: never inside text we show. */
const hasControl = (v: string): boolean =>
  [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const FORBIDDEN_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);

const text = (v: unknown, max = TEXT_MAX): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !hasControl(v);

/** Context of `rampNextProblem`: the order's method, F, its reference digits, and the link rules. */
export interface RampNextContext {
  method: RampMethod;
  provider: string;
  publicAppUrl: string;
  checkoutHosts: readonly string[];
  deeplinkSchemes: readonly string[];
  /** The order's payout-reference digits: the only ERIP account number we accept. */
  accountNumber: string;
  amount: bigint;
  fiatDecimals: number;
}

/** A deeplink may be a bank-app scheme of RAMP_DEEPLINK_SCHEMES or https on RAMP_CHECKOUT_HOSTS. */
function deeplinkProblem(raw: unknown, ctx: RampNextContext): string | null {
  if (typeof raw !== "object" || raw === null) return "erip_deeplink";
  const { name, url } = raw as { name?: unknown; url?: unknown };
  if (!text(name) || !text(url)) return "erip_deeplink";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "erip_deeplink";
  }
  const scheme = parsed.protocol.toLowerCase();
  if (FORBIDDEN_SCHEMES.has(scheme) || parsed.username || parsed.password)
    return "erip_deeplink_scheme";
  if (scheme === "https:")
    return ctx.checkoutHosts.includes(parsed.hostname.toLowerCase()) ? null : "erip_deeplink_host";
  return ctx.deeplinkSchemes.includes(scheme.slice(0, -1)) ? null : "erip_deeplink_scheme";
}

/** Raw base64 of a PNG of at most 64 KB (no data: URL, no whitespace). */
function qrPngProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length % 4 !== 0) return "erip_qr_png";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return "erip_qr_png";
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > QR_PNG_MAX_BYTES) return "erip_qr_png_too_large";
  return bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? null : "erip_qr_png_magic";
}

/**
 * X15 / SPEC §9.2: the acquirer's `next` before it is stored or shown. Redirect: as
 * `checkoutUrlProblem`. ERIP: digits-only service code (≤ 16), the account number = the order's
 * reference digits, the amount = F, ≤ 10 instruction lines of ≤ 512 characters, a PNG QR ≤ 64 KB,
 * a raw QR ≤ 512 characters naming our service code and the amount, ≤ 20 deeplinks with allowed
 * schemes — and nothing else. Returns the problem (the order then fails closed) or null.
 */
export function rampNextProblem(next: unknown, ctx: RampNextContext): string | null {
  if (typeof next !== "object" || next === null) return "next_missing";
  const n = next as Record<string, unknown>;
  const kind = n.kind;
  if (kind !== "redirect" && kind !== "erip") return "next_unknown_kind";
  if ((kind === "redirect") !== (ctx.method === "card")) return "next_kind_mismatch";
  for (const key of Object.keys(n))
    if (!NEXT_KEYS[kind].has(key) && n[key] !== undefined) return "next_unexpected_field";
  if (kind === "redirect")
    return typeof n.url === "string" ? checkoutUrlProblem(n.url, ctx) : "checkout_url_malformed";
  if (typeof n.serviceCode !== "string" || !/^\d{1,16}$/.test(n.serviceCode))
    return "erip_service_code";
  if (n.accountNumber !== ctx.accountNumber) return "erip_account_number";
  if (typeof n.amount !== "string" || tryParseAmount(n.amount) !== ctx.amount) return "erip_amount";
  const lines = n.instructions;
  if (!Array.isArray(lines) || lines.length > 10 || !lines.every((l) => text(l)))
    return "erip_instructions";
  if (n.qrPng !== undefined && n.qrPng !== null) {
    const problem = qrPngProblem(n.qrPng);
    if (problem) return problem;
  }
  if (n.qrRaw !== undefined && n.qrRaw !== null) {
    if (!text(n.qrRaw)) return "erip_qr_raw";
    const amounts = [
      formatAmountWithDecimals(ctx.amount, ctx.fiatDecimals),
      formatAmount(ctx.amount),
    ];
    if (!n.qrRaw.includes(n.serviceCode) || !amounts.some((a) => (n.qrRaw as string).includes(a)))
      return "erip_qr_raw_mismatch";
  }
  if (n.deeplinks !== undefined && n.deeplinks !== null) {
    if (!Array.isArray(n.deeplinks) || n.deeplinks.length > 20) return "erip_deeplink";
    for (const link of n.deeplinks) {
      const problem = deeplinkProblem(link, ctx);
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * SPEC §9.2 / belarus-rails §3: why the acquirer cannot refund an ERIP payment now (null = it can,
 * or the order is not ERIP). It refunds ERIP only when `refundMethods` has it, only non-cash
 * payments, and only `eripRefundMinHoursAfterSettle` after settlement; otherwise the money goes
 * back by bank transfer (`refund_bank`, S6).
 */
export function eripRefundProblem(
  method: RampMethod | null,
  payment: Pick<RampPayment, "settledAt" | "payer">,
  caps: Pick<RampProviderCapabilities, "refundMethods" | "eripRefundMinHoursAfterSettle">,
  now = new Date(),
): string | null {
  if (method !== "erip") return null;
  if (!caps.refundMethods.includes("erip"))
    return "the acquirer does not refund ERIP payments: refund by bank transfer (refund_bank)";
  const channel = payment.payer?.channel ?? "unknown";
  if (channel === "cash" || channel === "unknown")
    return "a cash (or unknown-channel) ERIP payment is refunded by bank transfer (refund_bank)";
  if (!payment.settledAt)
    return "the ERIP payment is not settled yet; a refund opens after settlement";
  const opens = payment.settledAt.getTime() + caps.eripRefundMinHoursAfterSettle * 3_600_000;
  return now.getTime() < opens
    ? `ERIP refunds open ${caps.eripRefundMinHoursAfterSettle} h after settlement (${new Date(opens).toISOString()})`
    : null;
}

/** How a PendingPayout ended on the ledger, as the indexer recorded it (`to_ledger_payouts`). */
export interface PayoutLedgerState {
  /** null = the indexer has not seen the contract yet (wait, never guess). */
  active: boolean | null;
  settledKind: LedgerPayoutSettledKind | null;
  txHash: string | null;
}

/**
 * C1's ledger proof: MarkPaid with `txHash = ramp:<order id>` archived the PendingPayout — the only
 * fact that makes a cash-out's tokens the treasury's. `cancelled` = the user's CancelPayout did.
 */
export function offrampLedgerOutcome(
  state: PayoutLedgerState,
  orderId: string,
): "live" | "mark_paid" | "cancelled" | "unindexed" | "other" {
  if (state.active === null) return "unindexed";
  if (state.active) return "live";
  if (state.settledKind === "mark_paid" && state.txHash === `ramp:${orderId}`) return "mark_paid";
  if (state.settledKind === "cancelled") return "cancelled";
  return "other";
}

/**
 * User-facing eligibility reasons (`GET /ramp.eligibility.*.reasons`, `403 ramp_not_eligible`
 * `details.reasons`). Compliance reasons are only `kyc_required`, `consent_required`,
 * `additional_info_required` or the neutral `compliance` (X6, M3; F1's wire codes).
 */
export type RampIneligibility =
  | "ramp_disabled"
  | "provider_unconfigured"
  | "token_app_unconfigured"
  | "instrument_unconfigured"
  | "payouts_unsupported"
  | "user_suspended"
  | "no_primary_wallet"
  | "kyc_required"
  | "kyc_duplicate_identity"
  | "consent_required"
  | "additional_info_required"
  | "compliance"
  | "no_payout_card";

/** The user's reason for a compliance port code (internal codes never leave the backend). */
export function userComplianceReason(code: string): RampIneligibility {
  switch (code) {
    case "kyc_required":
    case "consent_required":
    case "additional_info_required":
      return code;
    case "kyc_refresh_required":
      return "additional_info_required";
    default:
      return "compliance";
  }
}

/** The 503s first (the platform), then the account, in the order the user can fix them. */
function ineligibilityError(reason: RampIneligibility, all: RampIneligibility[]): ApiError {
  switch (reason) {
    case "ramp_disabled":
    case "provider_unconfigured":
    case "token_app_unconfigured":
    case "instrument_unconfigured":
    case "payouts_unsupported":
      return new ApiError(503, "ramp_unavailable", "the ramp is not available right now", {
        reason,
      });
    case "user_suspended":
      return new ApiError(403, "user_suspended", "this account is suspended");
    case "no_primary_wallet":
      return new ApiError(409, "no_primary_wallet", "link a Canton wallet first");
    case "kyc_required":
      return new ApiError(409, "kyc_required", "identity verification is required for the ramp");
    case "kyc_duplicate_identity":
      return new ApiError(
        409,
        "kyc_duplicate_identity",
        "the ramp is disabled while an identity verification conflict is open",
      );
    default:
      // consent / additional information / compliance / no payout card: one 403 with the codes.
      return new ApiError(403, "ramp_not_eligible", "this account cannot use the ramp right now", {
        reasons: all,
      });
  }
}

/** On-ramps whose card value is out in the world (M1): from paid → minting on. */
const EXPOSED_ONRAMP_STATUSES = ["minting", "crediting", "completed"] as const;
/** A cash-out rail's delivery estimate for `GET /ramp.rails[].eta` (business days; card refunds post in days). */
export const RAMP_RAIL_ETA_BDAYS: Record<RampPayoutRail, number> = { card: 5, bank: 2 };

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

/**
 * The ramp's rules (docs/RAMP.md §6, SPEC §9): which instrument, which methods and rails, who may
 * use it (the compliance and freeze ports answer for compliance), how much (per order, rolling
 * 24 h / 30 d, the card's refundable capacity, the card exposure), the checks before MarkPaid, and
 * the binding of a signed `withdraw` PendingPayout to its off-ramp order. Reads only —
 * repositories, the ledger, the ports — so PayoutService can consult it without a dependency
 * cycle through the deposit machinery.
 */
@Injectable()
export class RampPolicyService implements OnApplicationBootstrap {
  constructor(
    private readonly config: Config,
    @InjectRepository(RampOrderEntity) private readonly orders: Repository<RampOrderEntity>,
    @InjectRepository(RampPaymentMethodEntity)
    private readonly methods: Repository<RampPaymentMethodEntity>,
    @InjectRepository(LedgerPayoutEntity)
    private readonly ledgerPayouts: Repository<LedgerPayoutEntity>,
    @Inject(RAMP_PROVIDER) private readonly provider: RampProvider,
    private readonly instruments: InstrumentsService,
    private readonly kyc: KycService,
    private readonly ledger: LedgerClientService,
    private readonly tokenApp: TokenAppService,
    private readonly store: RampOrderStore,
    private readonly gates: RampGatesService,
    private readonly compliance: RampCompliancePort,
    private readonly freeze: ComplianceFreezePort,
    private readonly bankRail: RampBankRailPort,
    private readonly cashout: RampCardCashoutService,
    private readonly release: RampReleaseGuard,
  ) {}

  /**
   * Boot refusals that need the acquirer adapter (config.ts cannot see it) while the ramp is on:
   * L3 (an instrument coarser than the fiat would truncate what is minted against what is
   * charged), RAMP_METHODS ⊆ the acquirer's methods, and prod-like "no card cash-out ⇒ bank rail"
   * (Decree 8 p.4.4: the tokens must stay redeemable).
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.ramp.enabled) return;
    const row = await this.configuredInstrument().catch(() => null);
    if (row && row.decimals < this.config.ramp.fiatDecimals)
      throw new Error(
        `Invalid configuration: RAMP_FIAT_DECIMALS (${this.config.ramp.fiatDecimals}) exceeds the ramp instrument ${row.id}'s ${row.decimals} decimals`,
      );
    const caps = this.provider.capabilities;
    const missing = this.config.ramp.methods.filter((m) => !caps.methods.includes(m));
    if (missing.length)
      throw new Error(
        `Invalid configuration: RAMP_METHODS lists ${missing.join(", ")}, which the ${this.provider.name} acquirer does not offer`,
      );
    if (
      this.config.isProdLike &&
      caps.cardCashout === "none" &&
      !this.config.ramp.payoutRails.includes("bank")
    )
      throw new Error(
        `Invalid configuration: the ${this.provider.name} acquirer has no card cash-out; RAMP_PAYOUT_RAILS must include bank`,
      );
  }

  /** Limits of a direction (fees are per method / rail). */
  directionConfig(direction: RampDirection): RampDirectionConfig {
    return direction === "onramp" ? this.config.ramp.onramp : this.config.ramp.offramp;
  }

  /** The customer fee of an on-ramp method or a cash-out rail (SPEC §9.2, §9.3). */
  feeConfig(via: { method: RampMethod } | { rail: RampPayoutRail }): RampFeeConfig {
    return "method" in via ? this.config.ramp.method[via.method] : this.config.ramp.rail[via.rail];
  }

  /** RAMP_METHODS the acquirer offers (all of them: boot refuses anything else). */
  offeredMethods(): RampMethod[] {
    const caps = this.provider.capabilities;
    return this.config.ramp.methods.filter((m) => caps.methods.includes(m));
  }

  /** RAMP_PAYOUT_RAILS usable now: the card rail only when the acquirer has a card cash-out. */
  offeredRails(): RampPayoutRail[] {
    return this.config.ramp.payoutRails.filter(
      (r) => r !== "card" || this.cardCashoutMode() !== "none",
    );
  }

  /** How a card cash-out works now (`none` when the card rail is off). */
  cardCashoutMode(): RampCardCashoutMode {
    return this.config.ramp.payoutRails.includes("card")
      ? this.provider.capabilities.cardCashout
      : "none";
  }

  /** `RAMP_INSTRUMENT`, else the default collateral; null when neither is configured and enabled, or too coarse for the fiat (L3). */
  async instrument(): Promise<InstrumentEntity | null> {
    const row = await this.configuredInstrument();
    return row?.enabled && row.decimals >= this.config.ramp.fiatDecimals ? row : null;
  }

  private async configuredInstrument(): Promise<InstrumentEntity | null> {
    const ref = this.config.ramp.instrument;
    return ref
      ? this.instruments.get(ref.admin, ref.id)
      : this.instruments.requireDefaultCollateral().catch(() => null);
  }

  /** The PendingPayout's end as indexed (C1's ledger proof); `active: null` = not indexed yet. */
  async payoutOnLedger(cid: string): Promise<PayoutLedgerState> {
    const row = await this.ledgerPayouts.findOne({ where: { contractId: cid } });
    if (!row) return { active: null, settledKind: null, txHash: null };
    return { active: row.active, settledKind: row.settledKind, txHash: row.txHash };
  }

  async requireInstrument(): Promise<InstrumentEntity> {
    const row = await this.instrument();
    if (!row)
      throw new ApiError(503, "ramp_unavailable", "the ramp has no enabled instrument", {
        reason: "instrument_unconfigured",
      });
    return row;
  }

  /**
   * Every reason the account cannot use `direction` now, platform first; empty = allowed. The
   * compliance port (eligibility, consent; S7a) and the freeze port (S7b) answer for compliance —
   * reported only as `kyc_required`, `consent_required`, `additional_info_required` or `compliance`.
   */
  async eligibility(user: UserEntity, direction: RampDirection): Promise<RampIneligibility[]> {
    const reasons: RampIneligibility[] = [];
    const add = (r: RampIneligibility): void => {
      if (!reasons.includes(r)) reasons.push(r);
    };
    if (!this.config.ramp.enabled) add("ramp_disabled");
    if (!this.provider.isConfigured()) add("provider_unconfigured");
    if (!this.tokenApp.isConfigured()) add("token_app_unconfigured");
    if (!(await this.instrument())) add("instrument_unconfigured");
    if (direction === "offramp" && this.offeredRails().length === 0) add("payouts_unsupported");
    if (user.status !== "active") add("user_suspended");
    if (!user.partyId) add("no_primary_wallet");
    if (user.kycStatus === "blocked_duplicate") add("kyc_duplicate_identity");
    else if (this.config.ramp.requireKyc) {
      const gate = await this.kyc.withdrawalGate(user.id, { enforce: true });
      if (!gate.allowed && gate.reason === "kyc_required") add("kyc_required");
    }
    // SPEC §11.2, §11.3, §11.6 (I10): the ports answer; a frozen account — or one with an open list
    // hit, a confirmed foreign-list hit, or not screenable before its first order (S7b) — reads as `compliance`.
    if (await this.freeze.ordersDenied(user.id)) add("compliance");
    if ((await this.compliance.consent(user.id)).required) add("consent_required");
    const verdict = await this.compliance.eligibility(user.id);
    if (!verdict.allowed) {
      if (verdict.reasons.length === 0) add("compliance");
      for (const code of verdict.reasons) add(userComplianceReason(code));
    }
    if (direction === "offramp" && !(await this.hasPayoutDestination(user.id)))
      add("no_payout_card");
    return reasons;
  }

  async requireEligible(user: UserEntity, direction: RampDirection): Promise<void> {
    const reasons = await this.eligibility(user, direction);
    if (reasons.length > 0) throw ineligibilityError(reasons[0], reasons);
  }

  /** The consent the user's next order is made under (null until S7a's consent table exists). */
  async consentId(userId: string): Promise<string | null> {
    return (await this.compliance.consent(userId)).consentId;
  }

  /** Σ of the orders that count toward the limits (fiat paid on-ramp, tokens withdrawn off-ramp) since `since`. */
  async usage(userId: string, direction: RampDirection, since: Date): Promise<bigint> {
    const rows = await this.orders.find({
      select: { fiatAmount: true, tokenAmount: true },
      where: {
        userId,
        direction,
        createdAt: MoreThanOrEqual(since),
        status: Not(In([...RAMP_UNCOUNTED])),
      },
    });
    return rows.reduce((s, r) => s + (direction === "onramp" ? r.fiatAmount : r.tokenAmount), 0n);
  }

  /** `{ daily, monthly }` still available to the account in `direction`. */
  async remaining(
    userId: string,
    direction: RampDirection,
  ): Promise<{ daily: bigint; monthly: bigint }> {
    const cfg = this.directionConfig(direction);
    const now = Date.now();
    const [day, month] = await Promise.all([
      this.usage(userId, direction, new Date(now - DAY_MS)),
      this.usage(userId, direction, new Date(now - 30 * DAY_MS)),
    ]);
    const clamp = (v: bigint): bigint => (v > 0n ? v : 0n);
    return { daily: clamp(cfg.dailyMax - day), monthly: clamp(cfg.monthlyMax - month) };
  }

  /** The first per-order or rolling limit `amount` breaks (F1's names), or null. */
  async limitBreach(
    userId: string,
    direction: RampDirection,
    amount: bigint,
  ): Promise<{ name: RampLimitName; min?: bigint; max?: bigint; available?: bigint } | null> {
    const cfg = this.directionConfig(direction);
    if (amount < cfg.min) return { name: "min", min: cfg.min, max: cfg.max };
    if (amount > cfg.max) return { name: "max", min: cfg.min, max: cfg.max };
    const left = await this.remaining(userId, direction);
    if (amount > left.daily) return { name: "daily", available: left.daily };
    if (amount > left.monthly) return { name: "monthly", available: left.monthly };
    return null;
  }

  /** `400 validation_failed` outside min..max, `409 ramp_limit_exceeded` past a rolling sum. */
  async requireWithinLimits(
    userId: string,
    direction: RampDirection,
    amount: bigint,
  ): Promise<void> {
    const breach = await this.limitBreach(userId, direction, amount);
    if (!breach) return;
    const cfg = this.directionConfig(direction);
    if (breach.name === "min" || breach.name === "max")
      throw new ApiError(
        400,
        "validation_failed",
        `amount must be between ${formatAmount(cfg.min)} and ${formatAmount(cfg.max)}`,
        { min: formatAmount(cfg.min), max: formatAmount(cfg.max), limit: breach.name },
      );
    throw new ApiError(409, "ramp_limit_exceeded", `this exceeds your ${breach.name} limit`, {
      limit: breach.name,
      available: formatAmount(breach.available ?? 0n),
    });
  }

  // ───────────────────────────────────────────── exposure (I5) ─────────────────────────────

  /**
   * The account's card exposure in `instrument` (SPEC §9.3): Σ (C − refunded − charged back) of
   * its CARD on-ramps captured within RAMP_CARD_EXPOSURE_DAYS whose value is out (minting /
   * crediting / completed, or in review with a mint). ERIP counts nothing.
   */
  async exposure(userId: string, instrument: InstrumentId): Promise<bigint> {
    const days = this.config.ramp.cardExposureDays;
    if (days <= 0) return 0n;
    const rows = await this.orders
      .createQueryBuilder("o")
      .select(["o.capturedAmount", "o.refundedAmount", "o.details"])
      .where("o.user_id = :userId AND o.direction = 'onramp' AND o.method = 'card'", { userId })
      .andWhere("o.instrument_admin = :admin AND o.instrument_id = :id", {
        admin: instrument.admin,
        id: instrument.id,
      })
      .andWhere("o.captured_amount IS NOT NULL AND o.captured_at >= :since", {
        since: new Date(Date.now() - days * DAY_MS),
      })
      .andWhere(
        "(o.status IN (:...exposed) OR (o.status = 'needs_review' AND o.mint_command_id IS NOT NULL))",
        { exposed: [...EXPOSED_ONRAMP_STATUSES] },
      )
      .getMany();
    return cardExposure(
      rows.map((r) => {
        const cb = (r.details?.chargeback as { amount?: unknown } | undefined)?.amount;
        return {
          captured: r.capturedAmount ?? 0n,
          refunded: r.refundedAmount,
          chargedBack: (typeof cb === "string" ? tryParseAmount(cb) : null) ?? 0n,
        };
      }),
    );
  }

  /**
   * `GET /ramp.exposure` and the create-time check: the exposure and what may leave other than
   * back to a funding card now (`withdrawableToBank`), from a fresh wallet read.
   */
  async exposureView(
    user: Pick<UserEntity, "id" | "partyId">,
    instrument: InstrumentId,
  ): Promise<{ exposure: bigint; balance: bigint; withdrawable: bigint }> {
    const exposure = await this.exposure(user.id, instrument);
    const wallet = user.partyId
      ? await this.ledger.fetchUserWallet(user.partyId, instrument, { uncached: true })
      : null;
    const balance = wallet?.balance ?? 0n;
    return { exposure, balance, withdrawable: withdrawableBeyondExposure(balance, 0n, exposure) };
  }

  /**
   * A non-refund exit of `amount` (already debited from the balance: a live PendingPayout) — a
   * plain withdrawal (PayoutService) or a bank / OCT cash-out before MarkPaid (H2): null when it
   * fits max(0, balance + amount − exposure), else the figures.
   */
  async exposureHold(
    userId: string,
    party: string,
    instrument: InstrumentId,
    amount: bigint,
  ): Promise<{ exposure: bigint; withdrawable: bigint } | null> {
    const exposure = await this.exposure(userId, instrument);
    if (exposure === 0n) return null;
    const wallet = await this.ledger.fetchUserWallet(party, instrument, { uncached: true });
    const withdrawable = withdrawableBeyondExposure(wallet?.balance ?? 0n, amount, exposure);
    return amount > withdrawable ? { exposure, withdrawable } : null;
  }

  // ───────────────────────────────────────────── card cash-out ─────────────────────────────

  /**
   * `GET /ramp/payment-methods[].cashout`: the mode, and what a cash-out to this card can take now
   * — refund: the card's refundable capacity (other cash-outs in flight excluded, #13); oct: the
   * balance above the exposure, for a BY-issued, payout-eligible card; none: 0.
   */
  async cardCashout(
    user: Pick<UserEntity, "id" | "partyId">,
    card: RampPaymentMethodEntity,
    instrument: InstrumentId | null,
  ): Promise<{ mode: RampCardCashoutMode; available: bigint }> {
    const mode = this.cardCashoutMode();
    if (mode === "none" || card.status !== "active" || !card.payoutEligible || !instrument)
      return { mode, available: 0n };
    if (mode === "refund")
      return { mode, available: await this.cashout.available(user.id, card.id, null) };
    if (!this.octCountryAllowed(card)) return { mode, available: 0n };
    return { mode, available: (await this.exposureView(user, instrument)).withdrawable };
  }

  /** OCT only to cards issued in RAMP_CARD_PAYOUT_COUNTRIES (when the acquirer pays domestically only). */
  octCountryAllowed(card: Pick<RampPaymentMethodEntity, "issuerCountry">): boolean {
    if (!this.provider.capabilities.payoutDomesticOnly) return true;
    return this.config.ramp.cardPayoutCountries.includes((card.issuerCountry ?? "").toUpperCase());
  }

  // ───────────────────────────────────────────── MarkPaid ──────────────────────────────────

  /**
   * Why PayoutService must not submit MarkPaid for this cash-out now (null = it may; SPEC §4.1):
   * the order must still be `withdrawing` (never after an operator failed it or the user
   * cancelled); the payout gate passes (§6.4); the user is not frozen and no compliance decision
   * holds it (I10 → `blocked_compliance`, neutral); the destination is still valid (the card
   * active, eligible, the user's — and in refund mode able to take P; the bank account per S6);
   * and a non-refund exit (bank, OCT) fits the balance above the card exposure with the LIVE
   * amount (H2 → `blocked_ramp_exposure`). A refusal leaves the PendingPayout live: the user may
   * cancel it.
   */
  async markPaidRefusal(
    orderId: string,
    live: PendingPayoutRecord,
  ): Promise<{ status: PayoutStatus; detail: string } | null> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order || order.direction !== "offramp")
      return {
        status: "blocked_unknown_reason",
        detail: "no cash-out order is bound to this withdrawal",
      };
    if (order.status !== "withdrawing")
      return {
        status: "blocked_unknown_reason",
        detail: `the cash-out is ${order.status}; cancelling the withdrawal returns the tokens`,
      };
    // SPEC §6.4: MarkPaid takes the user's tokens for fiat — never while the payout gate refuses.
    const gate = await this.gates.payoutGate();
    if (!gate.ok)
      return {
        status: "blocked_payout_gate",
        detail: `payout_gate:${gate.reason}: ${gate.detail}`,
      };
    const hold = await this.release.hold(order);
    if (hold) return { status: "blocked_compliance", detail: `${hold.reason}: ${hold.detail}` };
    // R1-4: on a retried MarkPaid too (PayoutService checks the payee before the first only) —
    // a suspended account, or a hold that never lifts by itself (a chargeback), stops it.
    const [user] = await this.orders.manager.query<{ status: string }[]>(
      `SELECT status FROM to_users WHERE id = $1`,
      [order.userId],
    );
    if (user?.status !== "active") return { status: "blocked_kyc", detail: "user_suspended" };
    const held = order.details?.hold as { reason?: string } | null | undefined;
    if (held?.reason && !SELF_LIFTING_HOLDS.has(held.reason) && !held.reason.startsWith("blocked_"))
      return { status: "blocked_compliance", detail: `held: ${held.reason}` };
    const nonRefundExit = order.payoutRail === "bank" || this.cardCashoutMode() === "oct";
    const destination = await this.destinationProblem(order);
    if (destination) return { status: "blocked_unknown_reason", detail: destination };
    if (nonRefundExit) {
      const exposed = await this.exposureHold(
        order.userId,
        live.user,
        live.instrument,
        live.amount,
      );
      if (exposed)
        return {
          status: "blocked_ramp_exposure",
          detail: `card value inside the dispute window: ${formatAmount(exposed.withdrawable)} can leave by this rail now`,
        };
    }
    return null;
  }

  /** Is the cash-out's destination still able to take it (SPEC §4.1 "destination still valid")? */
  private async destinationProblem(order: RampOrderEntity): Promise<string | null> {
    if (order.payoutRail === "bank") {
      try {
        // S6: the order itself does not count against its account's first-payout cap.
        await this.bankRail.validateDestination(
          order.userId,
          order.bankAccountId ?? "",
          order.fiatAmount,
          { orderId: order.id },
        );
        return null;
      } catch (err) {
        return `the bank account cannot take this payout: ${(err as Error).message}`;
      }
    }
    const method = order.paymentMethodId
      ? await this.methods.findOne({ where: { id: order.paymentMethodId } })
      : null;
    if (
      !method ||
      method.status !== "active" ||
      !method.payoutEligible ||
      method.userId !== order.userId
    )
      return "the cash-out card is no longer eligible";
    const mode = this.cardCashoutMode();
    if (mode === "none") return "card cash-out is not available";
    if (mode === "oct" && !this.octCountryAllowed(method))
      return "the card's issuer country cannot receive a card payout";
    if (mode === "refund") {
      const available = await this.cashout.available(order.userId, method.id, order.id);
      if (available < order.fiatAmount)
        return `the card can take ${formatAmount(available)} back now, less than this cash-out`;
    }
    return null;
  }

  /**
   * Bind a `withdraw` PendingPayout to the account's off-ramp order waiting for exactly it
   * (docs/RAMP.md §3.2): same instrument, the exact amount, status `awaiting_withdrawal`. A cid
   * already bound answers its order. Compare-and-set: of two settlements racing on one cid only
   * one binds; a second cid of the same amount finds the order taken and settles as a plain
   * withdrawal. Returns the bound order id, or null (not a cash-out).
   */
  async bindWithdrawal(
    input: { cid: string; userId: string; party: string; instrument: InstrumentId; amount: bigint },
    actor: Actor,
  ): Promise<string | null> {
    const bound = await this.orders.findOne({ where: { pendingPayoutCid: input.cid } });
    if (bound) return bound.direction === "offramp" ? bound.id : null;
    const candidates = await this.orders.find({
      where: {
        userId: input.userId,
        direction: "offramp",
        status: "awaiting_withdrawal",
        pendingPayoutCid: IsNull(),
      },
    });
    // L2: the payee party must be the order's (as /attach checks), not only the account.
    const order = candidates.find(
      (o) =>
        o.tokenAmount === input.amount &&
        o.partyId === input.party &&
        sameInstrument({ admin: o.instrumentAdmin, id: o.instrumentId }, input.instrument),
    );
    if (!order) return null;
    const won = await this.store.transition(
      order,
      ["awaiting_withdrawal"],
      "withdrawing",
      { pendingPayoutCid: input.cid, attempts: 0, lastError: null },
      { actor, detail: `bound PendingPayout ${input.cid.slice(0, 24)}…` },
    );
    return won ? order.id : null;
  }

  /**
   * F5: the live `withdraw` PendingPayout each waiting cash-out would bind — `bindWithdrawal`'s rule
   * (the order's party, its instrument, the exact amount) — created on the ledger by the order's
   * deadline and bound to no order. One fresh ledger read for all; an unreadable ledger throws
   * (I7: the caller expires nothing while unsure).
   */
  async signedInTime(
    orders: readonly RampOrderEntity[],
  ): Promise<Map<string, PendingPayoutRecord>> {
    const found = new Map<string, PendingPayoutRecord>();
    if (!orders.length) return found;
    const live = (await this.ledger.fetchPendingPayouts({ uncached: true })).filter(
      (p) => p.reason === "withdraw",
    );
    if (!live.length) return found;
    const bound = new Set(
      (
        await this.orders.find({
          where: { pendingPayoutCid: In(live.map((p) => p.contractId)) },
          select: { id: true, pendingPayoutCid: true },
        })
      ).map((o) => o.pendingPayoutCid),
    );
    for (const order of orders) {
      const deadline = order.expiresAt?.getTime() ?? null;
      const signed = live.find(
        (p) =>
          !bound.has(p.contractId) &&
          p.user === order.partyId &&
          p.amount === order.tokenAmount &&
          sameInstrument(p.instrument, { admin: order.instrumentAdmin, id: order.instrumentId }) &&
          deadline !== null &&
          p.createdAt !== null &&
          p.createdAt.getTime() <= deadline,
      );
      if (signed) found.set(order.id, signed);
    }
    return found;
  }

  /** A cash-out can go somewhere: the bank rail is on, or a card cash-out to an eligible card of this account. */
  private async hasPayoutDestination(userId: string): Promise<boolean> {
    const rails = this.offeredRails();
    if (rails.includes("bank")) return true;
    if (!rails.includes("card")) return false;
    return (
      (await this.methods.count({
        where: { userId, provider: this.provider.name, status: "active", payoutEligible: true },
      })) > 0
    );
  }
}
