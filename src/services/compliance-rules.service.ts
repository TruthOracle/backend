import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";

import { Config } from "../config";
import {
  COMPLIANCE_ALERT_SEVERITIES,
  type ComplianceAlertSeverity,
  type InstrumentId,
} from "../types";
import { minskDate } from "../util/by-calendar";
import { ApiError } from "../util/errors";
import { parseAmount } from "../util/money";
import { isUuid } from "../util/strings";
import { DAY_MS, HOUR_MS } from "../util/time";
import { ComplianceAlertsService } from "./compliance-alerts.service";
import { ComplianceFreezePort } from "./compliance-freeze.port";
import {
  ageBand,
  ageOn,
  cash,
  eligibilityReasons,
  type EligibilityFacts,
  ineligibleSeverity,
  manyCards,
  netOut,
  roundTrip,
  type RuleHit,
  structuring,
  thirdParty,
  unverifiedPayer,
  VALUE_POINT_OWN_HOLDS,
} from "./compliance-rules.logic";
import { KycIdentityService } from "./kyc-identity.service";
import {
  ALLOW,
  RampCompliancePort,
  type ComplianceContext,
  type ComplianceDecision,
  type CompliancePoint,
  type CreateDecision,
  type PendingAlert,
  type RampComplianceImpl,
  type RampConsentAnswer,
  type RampEligibilityAnswer,
} from "./ramp-compliance.port";
import { pepWindow, principalWindow, RampConsentService } from "./ramp-consent.service";
import { RAMP_UNCOUNTED } from "./ramp-order-store.service";

const CREATE_POINTS: readonly CompliancePoint[] = ["onramp.create", "offramp.create"];

/**
 * The compliance implementation of the ramp (SPEC §11.3–§11.5; binds RampCompliancePort at boot).
 * Eligibility from the stored identity, the consent, the account's undecided block alerts and the
 * freeze; at each value point the §11.4 rules with thresholds in base values (RAMP_BV_TABLE at the
 * operation date), volumes from the orders and — trading and deposits — from the ledger index of
 * every party the account ever linked. Decisions: deny only for eligibility failures, sanctions,
 * freezes and list hits (refused at a create point; held at a value point); review never refuses
 * — the alert linked to the order holds the value point until AML decides (`isHeld`). Every rule
 * that fires is an alert, once per (order, point, rule). RAMP_COMPLIANCE=off (off-prod): allow,
 * no consent required, nothing held — alerts other stages raise are still recorded.
 */
@Injectable()
export class ComplianceRulesService implements RampComplianceImpl, OnModuleInit {
  private readonly logger = new Logger(ComplianceRulesService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly port: RampCompliancePort,
    private readonly identity: KycIdentityService,
    private readonly consents: RampConsentService,
    private readonly alerts: ComplianceAlertsService,
    private readonly freeze: ComplianceFreezePort,
  ) {}

  onModuleInit(): void {
    this.port.bind(this);
  }

  private get on(): boolean {
    return this.config.compliance.enabled;
  }

  // ───────────────────────────────────────────── the port ───────────────────────────────────

  async eligibility(userId: string): Promise<RampEligibilityAnswer> {
    if (!this.on) return { allowed: true, reasons: [] };
    const reasons = eligibilityReasons(this.config.compliance, await this.facts(userId));
    return { allowed: reasons.length === 0, reasons };
  }

  async consent(userId: string): Promise<RampConsentAnswer> {
    const latest = await this.consents.latest(userId);
    if (!this.on) return { required: false, consentId: latest?.id ?? null };
    return { required: latest === null, consentId: latest?.id ?? null };
  }

  async isHeld(orderId: string): Promise<boolean> {
    if (!this.on) return false;
    if (await this.alerts.holdsOrder(orderId)) return true;
    // C26: an undecided account-level block alert (a PEP or principal declaration, a vendor flag)
    // holds every flagged order of the account until its four-eyes decision (art.6).
    const [order] = await this.dataSource.query<{ userId: string }[]>(
      `SELECT "user_id" AS "userId" FROM "to_ramp_orders" WHERE "id" = $1`,
      [orderId],
    );
    return order ? (await this.alerts.openAccountBlocks(order.userId)).length > 0 : false;
  }

  /**
   * An alert detected elsewhere (S6 TM-SHAREDIBAN, S7b TM-LIST / TM-FROZEN-ACTIVITY). The figures'
   * hints are honoured alike when valid: `severity` (else the rule catalogue's), `dueAt` (else the
   * due date by rule and severity; never later than that) and `windowKey` (else the hit / bank
   * account / order it is about, else a digest of the figures) — a repeated raise is deduplicated
   * (null).
   * `figures.orderId` (a uuid) links it to an order; figures must carry no PII.
   */
  async raise(
    rule: string,
    userId: string,
    figures: Record<string, unknown>,
  ): Promise<string | null> {
    const pick = (k: string): string | null => {
      const v = figures[k];
      return typeof v === "string" && v.trim() ? v : null;
    };
    const windowKey =
      pick("windowKey") ??
      (pick("hitId") && `hit:${pick("hitId")}`) ??
      (pick("bankAccountId") && `bank-account:${pick("bankAccountId")}`) ??
      (pick("orderId") && `order:${pick("orderId")}`) ??
      `figures:${createHash("sha256").update(JSON.stringify(figures)).digest("hex").slice(0, 32)}`;
    const orderId = pick("orderId");
    const severity = pick("severity");
    const { id, created } = await this.alerts.raise({
      userId,
      rule,
      // S7b: a freezing list's hit blocks, a foreign list's is a review (B1).
      ...(severity && (COMPLIANCE_ALERT_SEVERITIES as readonly string[]).includes(severity)
        ? { severity: severity as ComplianceAlertSeverity }
        : {}),
      point: pick("point"),
      orderId: orderId && isUuid(orderId) ? orderId : null,
      figures,
      windowKey,
      dueAt: pick("dueAt"),
    });
    return created ? id : null;
  }

  /**
   * One value point's decision (asked once per order and point; idempotent per (order, point): the
   * alerts are keyed by them). An unreadable identity or BV table throws (fail closed, I7).
   */
  async check(point: CompliancePoint, ctx: ComplianceContext): Promise<ComplianceDecision> {
    const { pending, ...decision } = await this.checkCreate(point, ctx);
    return { ...decision, alertIds: await this.recordCreate(pending) };
  }

  /** C28: the alerts of a decision, raised in `manager`'s transaction (the order's insert) when given. */
  async recordCreate(pending: readonly PendingAlert[], manager?: EntityManager): Promise<string[]> {
    const ids: string[] = [];
    for (const p of pending) {
      const { id } = await this.alerts.raise(
        {
          userId: p.userId,
          rule: p.rule,
          severity: p.severity,
          point: p.point,
          orderId: p.orderId,
          figures: p.figures,
          windowKey: p.windowKey,
          bv: p.bv,
        },
        manager,
      );
      ids.push(id);
    }
    return ids;
  }

  /** C25: an alert of the order was decided `return` (its payment goes back). */
  returnRequested(orderId: string): Promise<boolean> {
    return this.alerts.returnRequested(orderId);
  }

  /**
   * The decision and the alerts it rests on, none raised yet (C28: a create point raises them with
   * its order, in the insert transaction; `check` raises them at once).
   */
  async checkCreate(point: CompliancePoint, ctx: ComplianceContext): Promise<CreateDecision> {
    if (!this.on) return { ...ALLOW, pending: [] };
    const now = new Date();
    const bv = this.alerts.bvAt(now);
    if (bv === null) throw new Error("compliance: RAMP_BV_TABLE has no base value in force");
    const facts = await this.facts(ctx.userId, now);
    if (facts.unavailable)
      throw new ApiError(
        409,
        "kyc_identity_unavailable",
        "the verified identity cannot be read right now",
      );
    const reasons = eligibilityReasons(this.config.compliance, facts);
    if (CREATE_POINTS.includes(point) && reasons.length > 0)
      // Refused neutrally; the order never exists. Vendor flags raised their alerts at the refresh.
      return {
        decision: "deny",
        rules: reasons.map((r) => `eligibility:${r}`),
        alertIds: [],
        pending: [],
      };

    const hits: RuleHit[] = [];
    if (!CREATE_POINTS.includes(point)) {
      // The value is in or about to leave: hold it on an alert AML decides (a freeze holds by itself).
      if (reasons.includes("vendor_sanctions"))
        hits.push({ rule: "TM-SANCTIONS", severity: "block", figures: { source: "vendor" } });
      const others = reasons.filter((r) => !VALUE_POINT_OWN_HOLDS.has(r));
      // C26: a PEP, a principal or an open block alert is released by four eyes only.
      if (others.length > 0)
        hits.push({
          rule: "TM-INELIGIBLE",
          severity: ineligibleSeverity(others),
          figures: { reasons: others },
        });
    }
    hits.push(...(await this.rulesAt(point, ctx, facts, bv, now)));

    const pending: PendingAlert[] = hits.map((hit) => ({
      userId: ctx.userId,
      rule: hit.rule,
      severity: hit.severity,
      point,
      orderId: ctx.orderId,
      figures: { ...hit.figures, direction: ctx.direction, method: ctx.method, rail: ctx.rail },
      windowKey: `order:${ctx.orderId}:${point}`,
      bv,
    }));
    const decision: ComplianceDecision["decision"] = hits.some(
      (h) => h.severity === "block" || h.rule === "TM-INELIGIBLE",
    )
      ? "deny"
      : hits.some((h) => h.severity === "review")
        ? "review"
        : "allow";
    if (decision !== "allow")
      this.logger.log(
        `compliance ${point} ${ctx.orderId}: ${decision} (${hits.map((h) => h.rule).join(", ")})`,
      );
    return { decision, rules: hits.map((h) => h.rule), alertIds: [], pending };
  }

  // ───────────────────────────────────────────── facts ──────────────────────────────────────

  /** What eligibility is decided on; an identity that cannot be refreshed is `unavailable` (fail closed). */
  private async facts(userId: string, now = new Date()): Promise<EligibilityFacts> {
    let identity: EligibilityFacts["identity"] = null;
    let unavailable = false;
    try {
      identity = await this.identity.get(userId);
    } catch (err) {
      if (!(ApiError.is(err) && err.code === "kyc_identity_unavailable")) throw err;
      unavailable = true;
    }
    const terms = this.config.ramp.termsVersion;
    const latest = await this.consents.latest(userId, terms);
    const cleared = async (rule: string, windowKey: string): Promise<boolean> =>
      (await this.alerts.statusOf(userId, rule, windowKey)) === "cleared";
    return {
      identity,
      unavailable,
      today: minskDate(now),
      now,
      frozen: await this.freeze.isFrozen(userId),
      consent: latest
        ? {
            actsForSelf: latest.actsForSelf,
            pepDeclared: latest.pepDeclared,
            // C13: the latest declaration's own alert (a new principal or PEP detail is new review).
            principalCleared:
              latest.actsForSelf || (await cleared("TM-PRINCIPAL", principalWindow(latest.id))),
            pepCleared: !latest.pepDeclared || (await cleared("TM-PEP", pepWindow(latest.id))),
          }
        : null,
      openBlocks: await this.alerts.openAccountBlocks(userId),
    };
  }

  /** The §11.4 rules of one point. */
  private async rulesAt(
    point: CompliancePoint,
    ctx: ComplianceContext,
    facts: EligibilityFacts,
    bv: bigint,
    now: Date,
  ): Promise<RuleHit[]> {
    const tm = this.config.compliance.tm;
    const out: (RuleHit | null)[] = [];
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const month = ago(30 * DAY_MS);
    const age = ageOn(facts.identity?.birthDate ?? null, minskDate(now));
    switch (point) {
      case "onramp.create": {
        const day = await this.orderSums(ctx.userId, ago(24 * HOUR_MS), ctx.orderId);
        out.push(
          structuring(tm, {
            count: day.onCount + 1,
            sum: day.onSum + ctx.fiatAmount,
            dailyMax: this.config.ramp.onramp.dailyMax,
          }),
        );
        const m = await this.orderSums(ctx.userId, month, ctx.orderId);
        out.push(ageBand(tm, bv, { age, volume30d: m.onSum + m.offSum + ctx.fiatAmount }));
        break;
      }
      case "offramp.create": {
        const m = await this.orderSums(ctx.userId, month, ctx.orderId);
        out.push(ageBand(tm, bv, { age, volume30d: m.onSum + m.offSum + ctx.fiatAmount }));
        const parties = await this.parties(ctx.userId);
        const window = ago(tm.roundtripDays * DAY_MS);
        out.push(
          roundTrip(tm, bv, {
            onramps: await this.valueIn(ctx.userId, window),
            trading: await this.trading(parties, window),
          }),
        );
        out.push(
          netOut(tm, bv, {
            offramps: m.offSum + ctx.fiatAmount,
            onramps: await this.valueIn(ctx.userId, month),
            deposits: await this.deposits(parties, month),
          }),
        );
        break;
      }
      case "onramp.capture": {
        const payer = ctx.payer ?? null;
        const unverified =
          ctx.method === "erip" && !(payer?.nameSource === "bank" && payer.name?.trim());
        out.push(
          thirdParty(tm, bv, {
            payerName: payer?.name ?? null,
            nameSource: payer?.nameSource ?? null,
            amount: ctx.fiatAmount,
            names: facts.identity?.names ?? [],
          }),
        );
        out.push(
          unverifiedPayer(tm, bv, {
            method: ctx.method,
            payerName: payer?.name ?? null,
            nameSource: payer?.nameSource ?? null,
            unverified30d:
              (await this.unverifiedIn(ctx.userId, month, ctx.orderId)) +
              (unverified ? ctx.fiatAmount : 0n),
          }),
        );
        out.push(
          cash(this.config.compliance, { method: ctx.method, channel: payer?.channel ?? null }),
        );
        if (ctx.method === "card")
          out.push(
            manyCards(tm, { cards: await this.cards(ctx.userId, month, ctx.paymentMethodId) }),
          );
        break;
      }
      case "offramp.payout":
        // No §11.4 rule fires at the payout itself: the create-point reviews hold it (isHeld).
        break;
    }
    return out.filter((h): h is RuleHit => h !== null);
  }

  // ───────────────────────────────────────────── queries ────────────────────────────────────

  private get instrument(): InstrumentId {
    const ref = this.config.ramp.instrument;
    return (
      ref ?? {
        admin: this.config.collateralInstrument.admin,
        id: this.config.collateralInstrument.id,
      }
    );
  }

  /** Every party the account ever linked (revoked included) and its in-app wallet owner. */
  private async parties(userId: string): Promise<string[]> {
    const rows: { party: string }[] = await this.dataSource.query(
      `SELECT "party_id" AS "party" FROM "to_wallets" WHERE "user_id" = $1
       UNION SELECT "party_id" FROM "to_users" WHERE "id" = $1 AND "party_id" IS NOT NULL`,
      [userId],
    );
    return rows.map((r) => r.party);
  }

  /** Counted orders (the limits' statuses) created since `since`: on-ramp count and Σ F, off-ramp Σ P. */
  private async orderSums(
    userId: string,
    since: Date,
    excludeOrderId: string,
  ): Promise<{ onCount: number; onSum: bigint; offSum: bigint }> {
    const rows: { direction: string; n: number; total: string }[] = await this.dataSource.query(
      `SELECT "direction", count(*)::int AS "n", COALESCE(sum("fiat_amount"), 0)::text AS "total"
         FROM "to_ramp_orders" WHERE "user_id" = $1 AND "created_at" >= $2 AND "status" <> ALL($3::text[]) AND "id" <> $4
        GROUP BY "direction"`,
      [userId, since, [...RAMP_UNCOUNTED], excludeOrderId],
    );
    const on = rows.find((r) => r.direction === "onramp");
    const off = rows.find((r) => r.direction === "offramp");
    return {
      onCount: on?.n ?? 0,
      onSum: parseAmount(on?.total ?? "0"),
      offSum: parseAmount(off?.total ?? "0"),
    };
  }

  /** Value that came in by on-ramp since `since`: Σ (C − refunded) of captures not charged back. */
  private async valueIn(userId: string, since: Date): Promise<bigint> {
    const [row]: { total: string }[] = await this.dataSource.query(
      `SELECT COALESCE(sum("captured_amount" - "refunded_amount"), 0)::text AS "total" FROM "to_ramp_orders"
        WHERE "user_id" = $1 AND "direction" = 'onramp' AND "captured_amount" IS NOT NULL AND "captured_at" >= $2
          AND "status" NOT IN ('chargeback', 'refunded')`,
      [userId, since],
    );
    return parseAmount(row?.total ?? "0");
  }

  /** Trading volume (ПВК 64.16): Σ |amount| of the parties' buys and sells in markets of the ramp instrument. */
  private async trading(parties: string[], since: Date): Promise<bigint> {
    if (parties.length === 0) return 0n;
    const [row]: { total: string }[] = await this.dataSource.query(
      `SELECT COALESCE(sum(abs(e."amount")), 0)::text AS "total" FROM "to_market_events" e
         JOIN "to_markets" m ON m."market_id" = e."market_id"
        WHERE e."actor" = ANY($1::text[]) AND e."kind" IN ('buy', 'sell') AND e."amount" IS NOT NULL
          AND e."effective_at" >= $2 AND m."collateral_admin" = $3 AND m."collateral_id" = $4`,
      [parties, since, this.instrument.admin, this.instrument.id],
    );
    return parseAmount(row?.total ?? "0");
  }

  /** In-app deposits from outside the ramp: `UserWallet.Deposit`s whose txRef is not a mint credit. */
  private async deposits(parties: string[], since: Date): Promise<bigint> {
    if (parties.length === 0) return 0n;
    const [row]: { total: string }[] = await this.dataSource.query(
      `SELECT COALESCE(sum("amount"), 0)::text AS "total" FROM "to_wallet_entries"
        WHERE "owner" = ANY($1::text[]) AND "kind" = 'deposit' AND "effective_at" >= $2
          AND "instrument_admin" = $3 AND "instrument_id" = $4 AND ("tx_ref" IS NULL OR "tx_ref" NOT LIKE 'mint:%')`,
      [parties, since, this.instrument.admin, this.instrument.id],
    );
    return parseAmount(row?.total ?? "0");
  }

  /** Σ C of other ERIP captures since `since` whose payer name the payer's bank did not supply. */
  private async unverifiedIn(userId: string, since: Date, excludeOrderId: string): Promise<bigint> {
    const [row]: { total: string }[] = await this.dataSource.query(
      `SELECT COALESCE(sum("captured_amount"), 0)::text AS "total" FROM "to_ramp_orders"
        WHERE "user_id" = $1 AND "direction" = 'onramp' AND "method" = 'erip' AND "captured_amount" IS NOT NULL
          AND "captured_at" >= $2 AND "id" <> $3
          AND (COALESCE("details" -> 'payment' ->> 'payerNameSource', '') <> 'bank'
               OR "details" -> 'payment' ->> 'payerNameSealed' IS NULL)`,
      [userId, since, excludeOrderId],
    );
    return parseAmount(row?.total ?? "0");
  }

  /** Distinct cards that paid since `since`, this payment's included. */
  private async cards(
    userId: string,
    since: Date,
    current: string | null | undefined,
  ): Promise<number> {
    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT DISTINCT "payment_method_id" AS "id" FROM "to_ramp_orders"
        WHERE "user_id" = $1 AND "direction" = 'onramp' AND "method" = 'card' AND "captured_at" >= $2
          AND "payment_method_id" IS NOT NULL`,
      [userId, since],
    );
    const ids = new Set(rows.map((r) => r.id));
    if (current) ids.add(current);
    return ids.size;
  }
}
