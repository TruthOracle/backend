import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { type EntityManager, Repository } from "typeorm";

import { bvOn, Config } from "../config";
import { ComplianceAlertEntity } from "../entities/compliance-alert.entity";
import {
  COMPLIANCE_ALERT_DECISIONS,
  type ApiComplianceAlert,
  type ComplianceAlertDecision,
  type ComplianceAlertSeverity,
  type ComplianceAlertStatus,
} from "../types";
import { BusinessCalendar, minskDate } from "../util/by-calendar";
import { toCsv } from "../util/csv";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";
import { DAY_MS, HOUR_MS } from "../util/time";
import type { AdminActor } from "./admin.service";
import { AdminApprovalService } from "./admin-approval.service";
import { alertDueAt, dueKind, effectiveDueAt, ruleDefinition } from "./compliance-rules.logic";
import { AuditService } from "./audit.service";
import { RampReconciliationService } from "./ramp-reconciliation.service";

/** Alert statuses that still wait for a decision (the due date runs). */
export const UNDECIDED_STATUSES: readonly ComplianceAlertStatus[] = ["open", "escalated"];
/** Alert statuses that keep an order's value point held (SPEC §11.5: report and escalate keep it). */
export const HOLDING_STATUSES: readonly ComplianceAlertStatus[] = ["open", "escalated", "reported"];
/**
 * Which decision each status may take (cleared and returned are final). `return` (C25) ends a
 * hold without releasing it: the ramp gives the payment back instead of minting or paying out.
 */
const NEXT_STATUS: Record<
  ComplianceAlertStatus,
  Partial<Record<ComplianceAlertDecision, ComplianceAlertStatus>>
> = {
  open: { clear: "cleared", escalate: "escalated", report: "reported", return: "returned" },
  escalated: { clear: "cleared", report: "reported", return: "returned" },
  reported: { clear: "cleared", return: "returned" },
  cleared: {},
  returned: {},
};
/** The decisions that end a hold: the deciding operator signs them (C23, RAMP_APPROVAL_SIGNATURES). */
const RELEASING_DECISIONS: readonly ComplianceAlertDecision[] = ["clear", "return"];
/** Block alerts whose hold S7b's screening state governs (the hit and its provisional freeze). */
const S7B_GOVERNED_RULES: readonly string[] = ["TM-LIST", "TM-FROZEN-ACTIVITY"];
/** `compliance_alerts_overdue` turns amber this close to a due date (SPEC §6.2). */
const DUE_SOON_MS = 2 * HOUR_MS;
const EXPORT_MAX_DAYS = 31;
const LIST_MAX = 200;
const REPORT_REF_RE = /^[\p{L}\p{N}][\p{L}\p{N} ./_#-]{0,63}$/u;

/** What raising an alert needs (the window makes it idempotent: one per user, rule and window). */
export interface AlertInput {
  userId: string;
  rule: string;
  /** Default: the rule's catalogue severity. */
  severity?: ComplianceAlertSeverity;
  point?: string | null;
  orderId?: string | null;
  figures: Record<string, unknown>;
  windowKey: string;
  /** A tighter deadline than the rule's (never a later one: `effectiveDueAt`). */
  dueAt?: Date | string | null;
  /** The base value the thresholds used; default: the one in force now (null when none). */
  bv?: bigint | null;
}

interface DecideParams extends Record<string, unknown> {
  decision: ComplianceAlertDecision;
  reportRef: string | null;
}

interface AlertSnapshot {
  status: ComplianceAlertStatus;
  severity: ComplianceAlertSeverity;
  decidedAt: string | null;
  /** The order the alert holds (null: an account-level alert — nothing to return, C25). */
  orderId: string | null;
}

/**
 * Compliance alerts (SPEC §11.5, §11.6; ПВК pp.64–77): raised once per (user, rule, window) with
 * the legal due date in Belarusian business days, the rules version and the base value; decided by
 * AML through the four-eyes registry (`compliance.alert.decide`: single control by `aml` for a
 * review alert, `aml` + another person with `approver` for a block alert). `clear` releases what
 * the alert held — the ramp asks `holdsOrder` on its next pass, no further approval; `report`
 * (with the DFM special-form number) and `escalate` keep it; `return` (C25) ends the hold and the
 * ramp gives the payment back (`returnRequested`). Clear and return are signed (C23). Undecided
 * alerts near or past their due date are the `compliance_alerts_overdue` check (amber 2 h before,
 * red after: paged).
 */
@Injectable()
export class ComplianceAlertsService implements OnModuleInit {
  private readonly logger = new Logger(ComplianceAlertsService.name);
  readonly calendar: BusinessCalendar;

  constructor(
    private readonly config: Config,
    @InjectRepository(ComplianceAlertEntity)
    readonly alerts: Repository<ComplianceAlertEntity>,
    private readonly approvals: AdminApprovalService,
    private readonly reconciliation: RampReconciliationService,
    private readonly audit: AuditService,
  ) {
    this.calendar = new BusinessCalendar(
      config.rampControls.bankHolidays,
      config.rampControls.bankWorkdays,
    );
  }

  onModuleInit(): void {
    this.approvals.register<DecideParams, AlertSnapshot, { alert: ApiComplianceAlert }>({
      action: "compliance.alert.decide",
      subjectType: "compliance_alert",
      requestRoles: ["aml"],
      approveRoles: ["approver"],
      params: (raw) => decideParams(raw),
      singleControl: (_p, snapshot) => snapshot.severity !== "block",
      signSingleControl: (p) => RELEASING_DECISIONS.includes(p.decision),
      describe: (p, s) =>
        `${p.decision} a ${s.severity} compliance alert${p.reportRef ? ` (special form ${p.reportRef})` : ""}`,
      snapshot: (id) => this.snapshot(id),
      validate: async (p, s) => validateDecision(p, s),
      execute: (p, s, ctx) => this.applyDecision(ctx.subjectId, p, s, ctx.actor, ctx.reason),
      subjectUser: async (id) => (await this.alerts.findOne({ where: { id } }))?.userId ?? null,
    });
    this.reconciliation.registerCheck({
      name: "compliance_alerts_overdue",
      haltScopes: [],
      page: true,
      run: () => this.overdueCheck(),
    });
    this.reconciliation.registerCheck({
      name: "compliance_bv_table",
      haltScopes: [],
      run: async (ctx) => this.bvTableCheck(ctx.now),
    });
  }

  // ───────────────────────────────────────────── raising ────────────────────────────────────

  /** The base value in force at `at` (the Minsk day of the operation); null = the table has none. */
  bvAt(at: Date): bigint | null {
    return bvOn(this.config.compliance.bvTable, minskDate(at));
  }

  /**
   * Raise the alert of (user, rule, window) — or find it: a repeated evaluation never duplicates.
   * Returns its id and whether this call created it.
   */
  async raise(
    input: AlertInput,
    manager?: EntityManager,
  ): Promise<{ id: string; created: boolean }> {
    const def = ruleDefinition(input.rule);
    const severity = input.severity ?? def.severity;
    const now = new Date();
    const bv = input.bv === undefined ? this.bvAt(now) : input.bv;
    const repo = manager ? manager.getRepository(ComplianceAlertEntity) : this.alerts;
    const inserted: { id: string }[] = await repo.query(
      `INSERT INTO "to_compliance_alerts" ("user_id", "rule", "point", "severity", "order_id", "figures", "window_key", "due_at", "rules_version", "bv_byn")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT ("user_id", "rule", "window_key") DO NOTHING RETURNING "id"`,
      [
        input.userId,
        input.rule,
        input.point ?? def.point ?? null,
        severity,
        input.orderId ?? null,
        JSON.stringify(input.figures),
        input.windowKey,
        effectiveDueAt(alertDueAt(dueKind(input.rule, severity), now, this.calendar), input.dueAt),
        this.config.compliance.rulesVersion || "dev",
        bv === null ? null : formatAmount(bv),
      ],
    );
    if (inserted.length > 0) {
      const id = inserted[0].id;
      await this.audit.record(
        {
          actorType: "system",
          action: "compliance.alert_raised",
          subjectType: "compliance_alert",
          subjectId: id,
          metadata: {
            rule: input.rule,
            severity,
            orderId: input.orderId ?? null,
            userId: input.userId,
          },
        },
        manager,
      );
      return { id, created: true };
    }
    const existing = await repo.findOneOrFail({
      where: { userId: input.userId, rule: input.rule, windowKey: input.windowKey },
    });
    return { id: existing.id, created: false };
  }

  /** R2b-7: does the account have an undecided (open or escalated) alert of `rule`? */
  async undecided(userId: string, rule: string): Promise<boolean> {
    const n = await this.alerts
      .createQueryBuilder("a")
      .where("a.user_id = :userId AND a.rule = :rule", { userId, rule })
      .andWhere("a.status IN ('open', 'escalated')")
      .getCount();
    return n > 0;
  }

  // ───────────────────────────────────────────── holds ──────────────────────────────────────

  /** Does an undecided or reported review / block alert hold this order (SPEC §11.5)? */
  async holdsOrder(orderId: string): Promise<boolean> {
    const n = await this.alerts
      .createQueryBuilder("a")
      .where("a.order_id = :orderId", { orderId })
      .andWhere("a.severity IN ('review', 'block')")
      .andWhere("a.status IN (:...statuses)", { statuses: [...HOLDING_STATUSES] })
      .getCount();
    return n > 0;
  }

  /**
   * Rules of the account's holding block alerts outside orders (consent, identity): they refuse
   * new orders until AML decides. List hits and frozen-party activity are left to S7b's own state
   * (the provisional freeze, the open hit) so one decision — `compliance.hit.decide` — governs them.
   */
  async openAccountBlocks(userId: string): Promise<string[]> {
    const rows = await this.alerts
      .createQueryBuilder("a")
      .select("DISTINCT a.rule", "rule")
      .where("a.user_id = :userId AND a.order_id IS NULL AND a.severity = 'block'", { userId })
      .andWhere("a.status IN (:...statuses)", { statuses: [...HOLDING_STATUSES] })
      .andWhere("a.rule NOT IN (:...own)", { own: [...S7B_GOVERNED_RULES] })
      .getRawMany<{ rule: string }>();
    return rows.map((r) => r.rule).sort();
  }

  /**
   * C25 (RampCompliancePort.returnRequested): did AML decide `return` on a review / block alert of
   * this order? Its payment then goes back (refund / refund_bank) — the ramp never releases it.
   */
  async returnRequested(orderId: string): Promise<boolean> {
    const n = await this.alerts
      .createQueryBuilder("a")
      .where("a.order_id = :orderId", { orderId })
      .andWhere("a.severity IN ('review', 'block')")
      .andWhere("a.status = 'returned'")
      .getCount();
    return n > 0;
  }

  /** The status of one window's alert (null = never raised). */
  async statusOf(
    userId: string,
    rule: string,
    windowKey: string,
  ): Promise<ComplianceAlertStatus | null> {
    const row = await this.alerts.findOne({ where: { userId, rule, windowKey } });
    return row?.status ?? null;
  }

  // ───────────────────────────────────────────── decisions ──────────────────────────────────

  private async snapshot(id: string): Promise<AlertSnapshot> {
    const row = await this.alerts.findOne({ where: { id } });
    if (!row) throw new ApiError(404, "not_found", "alert not found");
    return {
      status: row.status,
      severity: row.severity,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      orderId: row.orderId,
    };
  }

  /** The AML decision (under the approval's subject lock; CAS on the status the request saw). */
  private async applyDecision(
    id: string,
    p: DecideParams,
    s: AlertSnapshot,
    actor: AdminActor,
    reason: string,
  ): Promise<{ alert: ApiComplianceAlert }> {
    const status = NEXT_STATUS[s.status][p.decision];
    if (!status)
      throw new ApiError(409, "compliance_alert_state", "the alert cannot take this decision");
    const res = await this.alerts
      .createQueryBuilder()
      .update(ComplianceAlertEntity)
      .set({
        status,
        decidedByUserId: actor.userId,
        decidedAt: new Date(),
        decisionReason: reason,
        ...(p.reportRef ? { reportRef: p.reportRef } : {}),
      })
      .where("id = :id AND status = :status", { id, status: s.status })
      .execute();
    if (!res.affected)
      throw new ApiError(409, "compliance_alert_state", "the alert changed meanwhile");
    const row = await this.alerts.findOneOrFail({ where: { id } });
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      ip: actor.ip,
      action: "compliance.alert_decided",
      subjectType: "compliance_alert",
      subjectId: id,
      metadata: {
        decision: p.decision,
        from: s.status,
        to: status,
        rule: row.rule,
        severity: row.severity,
        orderId: row.orderId,
        reportRef: p.reportRef,
        operatorPerson: actor.personId,
      },
    });
    return { alert: alertToApi(row) };
  }

  /**
   * A list hit's decision (S7b `compliance.hit.decide`: single control, `aml`; SPEC §11.6) decides
   * the TM-LIST alert it raised, in the hit's transaction — one AML decision, not two: `clear` →
   * cleared; `confirm` → escalated (the special form is still owed: `report` with its number ends
   * it, and the due date keeps running). An alert already past that point is left as it is.
   */
  async decideForHit(
    manager: EntityManager,
    alertId: string,
    hit: { id: string; decision: "confirm" | "clear" },
    actor: AdminActor,
    reason: string,
  ): Promise<ComplianceAlertStatus | null> {
    const repo = manager.getRepository(ComplianceAlertEntity);
    const row = await repo.findOne({ where: { id: alertId } });
    if (!row) return null;
    const decision: ComplianceAlertDecision = hit.decision === "clear" ? "clear" : "escalate";
    const status = NEXT_STATUS[row.status][decision];
    if (!status) return null;
    const res = await repo
      .createQueryBuilder()
      .update(ComplianceAlertEntity)
      .set({
        status,
        decidedByUserId: actor.userId,
        decidedAt: new Date(),
        decisionReason: `list hit ${hit.decision === "clear" ? "cleared" : "confirmed"}: ${reason}`,
      })
      .where("id = :id AND status = :status", { id: alertId, status: row.status })
      .execute();
    if (!res.affected)
      throw new ApiError(409, "compliance_alert_state", "the alert changed meanwhile");
    await this.audit.record(
      {
        actorType: "admin",
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        ip: actor.ip,
        action: "compliance.alert_decided",
        subjectType: "compliance_alert",
        subjectId: alertId,
        metadata: {
          decision,
          from: row.status,
          to: status,
          rule: row.rule,
          severity: row.severity,
          orderId: row.orderId,
          screeningHitId: hit.id,
          operatorPerson: actor.personId,
        },
      },
      manager,
    );
    return status;
  }

  // ───────────────────────────────────────────── reconciliation ─────────────────────────────

  /** `compliance_alerts_overdue` (SPEC §6.2): amber within 2 h of a due date, red past one (paged). */
  async overdueCheck(now = new Date()): Promise<{
    status: "green" | "amber" | "red";
    detail: string | null;
    figures: Record<string, unknown>;
  }> {
    const undecided = this.alerts
      .createQueryBuilder("a")
      .where("a.status IN (:...statuses)", { statuses: [...UNDECIDED_STATUSES] })
      .andWhere("a.due_at IS NOT NULL");
    const overdue = await undecided.clone().andWhere("a.due_at < :now", { now }).getCount();
    const soon = await undecided
      .clone()
      .andWhere("a.due_at >= :now AND a.due_at < :soon", {
        now,
        soon: new Date(now.getTime() + DUE_SOON_MS),
      })
      .getCount();
    const oldest = await undecided.clone().orderBy("a.dueAt", "ASC").getOne();
    const figures = { overdue, dueWithin2h: soon, nextDueAt: oldest?.dueAt?.toISOString() ?? null };
    if (overdue > 0)
      return { status: "red", detail: `${overdue} alert(s) past their legal due date`, figures };
    if (soon > 0)
      return { status: "amber", detail: `${soon} alert(s) due within 2 hours`, figures };
    return { status: "green", detail: null, figures };
  }

  /** `compliance_bv_table` (m3): amber when the BV table has no value for the current Minsk year. */
  bvTableCheck(now: Date): {
    status: "green" | "amber";
    detail: string | null;
    figures: Record<string, unknown>;
  } {
    const year = minskDate(now).slice(0, 4);
    const has = this.config.compliance.bvTable.some((e) => e.from.startsWith(year));
    const bv = this.bvAt(now);
    const figures = { year, bvByn: bv === null ? null : formatAmount(bv) };
    return has
      ? { status: "green", detail: null, figures }
      : { status: "amber", detail: `RAMP_BV_TABLE has no entry for ${year}`, figures };
  }

  // ───────────────────────────────────────────── admin reads ────────────────────────────────

  /** `GET /admin/compliance/alerts`: undecided first by due date, then newest. */
  async list(filter: {
    status?: ComplianceAlertStatus;
    rule?: string;
    userId?: string;
    orderId?: string;
    severity?: ComplianceAlertSeverity;
    due?: "overdue" | "soon";
    limit?: number;
  }): Promise<{ items: ApiComplianceAlert[]; nextCursor: null }> {
    const qb = this.alerts.createQueryBuilder("a");
    if (filter.status) qb.andWhere("a.status = :status", { status: filter.status });
    if (filter.rule) qb.andWhere("a.rule = :rule", { rule: filter.rule });
    if (filter.userId) qb.andWhere("a.user_id = :userId", { userId: filter.userId });
    if (filter.orderId) qb.andWhere("a.order_id = :orderId", { orderId: filter.orderId });
    if (filter.severity) qb.andWhere("a.severity = :severity", { severity: filter.severity });
    if (filter.due) {
      const horizon = filter.due === "overdue" ? new Date() : new Date(Date.now() + DUE_SOON_MS);
      qb.andWhere("a.status IN (:...undecided)", { undecided: [...UNDECIDED_STATUSES] }).andWhere(
        "a.due_at < :horizon",
        { horizon },
      );
    }
    const rows = await qb
      .orderBy("a.dueAt", "ASC", "NULLS LAST")
      .addOrderBy("a.createdAt", "DESC")
      .take(Math.min(LIST_MAX, Math.max(1, filter.limit ?? LIST_MAX)))
      .getMany();
    return { items: rows.map(alertToApi), nextCursor: null };
  }

  async get(id: string): Promise<ApiComplianceAlert> {
    const row = await this.alerts.findOne({ where: { id } });
    if (!row) throw new ApiError(404, "not_found", "alert not found");
    return alertToApi(row);
  }

  /**
   * `POST /admin/compliance/alerts/export` (SPEC §11.6): alerts raised in [from, to] (≤ 31 days),
   * optionally one status, as a human-mode CSV (formula-safe). The export id names the file and the
   * audit row; figures go as JSON (no PII by construction).
   */
  async export(
    range: { from: Date; to: Date; status?: ComplianceAlertStatus },
    actor: AdminActor,
  ): Promise<{ exportId: string; filename: string; csv: string; count: number }> {
    const { from, to } = range;
    if (
      !(from.getTime() < to.getTime()) ||
      to.getTime() - from.getTime() > EXPORT_MAX_DAYS * DAY_MS
    )
      throw new ApiError(
        400,
        "export_range",
        `the range must be from < to and at most ${EXPORT_MAX_DAYS} days`,
        {
          maxDays: EXPORT_MAX_DAYS,
        },
      );
    const qb = this.alerts
      .createQueryBuilder("a")
      .where("a.created_at >= :from AND a.created_at <= :to", { from, to })
      .orderBy("a.createdAt", "ASC")
      .addOrderBy("a.id", "ASC");
    if (range.status) qb.andWhere("a.status = :status", { status: range.status });
    const rows = await qb.getMany();
    const exportId = randomUUID();
    const csv = toCsv(
      rows.map((r) => [
        r.id,
        r.createdAt,
        r.userId,
        r.rule,
        r.point,
        r.severity,
        r.status,
        r.dueAt,
        r.orderId,
        r.rulesVersion,
        r.bvByn === null ? null : formatAmount(r.bvByn),
        JSON.stringify(r.figures),
        r.decidedByUserId,
        r.decidedAt,
        r.decisionReason,
        r.reportRef,
      ]),
      "human",
      [
        "alert_id",
        "created_at_utc",
        "user_id",
        "rule",
        "point",
        "severity",
        "status",
        "due_at_utc",
        "order_id",
        "rules_version",
        "bv_byn",
        "figures",
        "decided_by_user_id",
        "decided_at_utc",
        "decision_reason",
        "report_ref",
      ],
    );
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      ip: actor.ip,
      action: "compliance.alerts_exported",
      subjectType: "compliance_export",
      subjectId: exportId,
      metadata: {
        from: from.toISOString(),
        to: to.toISOString(),
        status: range.status ?? null,
        rows: rows.length,
        operatorPerson: actor.personId,
      },
    });
    const day = (d: Date): string => d.toISOString().slice(0, 10);
    return {
      exportId,
      filename: `compliance-alerts-${day(from)}-${day(to)}-${exportId.slice(0, 8)}.csv`,
      csv,
      count: rows.length,
    };
  }
}

export function alertToApi(row: ComplianceAlertEntity): ApiComplianceAlert {
  return {
    id: row.id,
    userId: row.userId,
    rule: row.rule,
    point: row.point,
    severity: row.severity,
    orderId: row.orderId,
    figures: row.figures,
    windowKey: row.windowKey,
    status: row.status,
    dueAt: row.dueAt?.toISOString() ?? null,
    rulesVersion: row.rulesVersion,
    bvByn: row.bvByn === null ? null : formatAmount(row.bvByn),
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    reportRef: row.reportRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Normalise and check a decide request's params (400 on bad input). */
export function decideParams(raw: Record<string, unknown>): DecideParams {
  const decision = raw.decision;
  if (
    typeof decision !== "string" ||
    !(COMPLIANCE_ALERT_DECISIONS as readonly string[]).includes(decision)
  )
    throw new ApiError(
      400,
      "validation_failed",
      "decision must be clear, escalate, report or return",
    );
  const ref = typeof raw.reportRef === "string" ? raw.reportRef.trim() : "";
  if (decision === "report" && !REPORT_REF_RE.test(ref))
    throw new ApiError(
      400,
      "validation_failed",
      "report needs reportRef: the special-form number (1-64 characters)",
    );
  return {
    decision: decision as ComplianceAlertDecision,
    reportRef: decision === "report" ? ref : null,
  };
}

/** May an alert in this state take this decision (409 compliance_alert_state)? */
export function validateDecision(p: DecideParams, s: AlertSnapshot): void {
  // C25: only a held payment can go back — an alert on an order that holds it (review / block).
  if (p.decision === "return" && (!s.orderId || s.severity === "info"))
    throw new ApiError(
      409,
      "compliance_alert_state",
      "only an alert that holds an order's payment can return it",
      { status: s.status },
    );
  if (!NEXT_STATUS[s.status][p.decision])
    throw new ApiError(
      409,
      "compliance_alert_state",
      `a ${s.status} alert cannot take the decision ${p.decision}`,
      {
        status: s.status,
      },
    );
}
