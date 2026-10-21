import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, LessThan, Repository } from "typeorm";

import { Config } from "../config";
import { AdminApprovalEntity } from "../entities/admin-approval.entity";
import type { AdminRole, ApiApproval, ApiApproveManyResult, ApprovalStatus } from "../types";
import { BusinessCalendar } from "../util/by-calendar";
import { publicKeyMatchesParty, verifyPartySignature } from "../util/canton-crypto";
import { ApiError } from "../util/errors";
import { MINUTE_MS } from "../util/time";
import type { AdminActor } from "./admin.service";
import {
  type ApprovalDecision,
  approvalMessage,
  approveRefusal,
  asJson,
  canonicalJson,
  expiresAtFor,
  linkedPerson,
  type LinkedPerson,
  linkedRefusal,
  missingRole,
  type Operator,
  paramsHashOf,
  type Refusal,
} from "./admin-approval.logic";
import { AuditService } from "./audit.service";
import { RedisService } from "./redis.service";

/** Crash ceiling of `lock:approval:<id>` / a subject lock: an execution may call upstream. */
const DECISION_LOCK_TTL_MS = 5 * MINUTE_MS;
const LIST_LIMIT = 200;

/** What an action's `execute` runs with: the approval, the operator executing it, the request's reason. */
export interface ApprovalExecutionContext {
  approvalId: string;
  subjectId: string;
  /** The approver (or the requester when it executed at once under single control). */
  actor: AdminActor;
  requester: { userId: string; party: string; person: string };
  /** The request's reason (the underlying action's reason). */
  reason: string;
  decisionReason: string | null;
}

/**
 * One four-eyes action (SPEC §6.5 registry). `snapshot` and `validate` read FRESH state; the
 * snapshot taken at request time must equal a fresh one at execution, and `validate` must pass
 * again (an equal snapshot is necessary, not sufficient). `lockKey` = the subject lock this
 * service holds around validate + compare + execute; null when `execute` locks the subject itself
 * (ramp orders, token commands, payouts) and re-checks there.
 */
export interface ApprovalActionDefinition<P = Record<string, unknown>, S = unknown, R = unknown> {
  action: string;
  subjectType: string;
  requestRoles: AdminRole[];
  /** Default `["approver"]`; the approver must hold every one. */
  approveRoles?: AdminRole[];
  /** Normalise / check the request params (throw 400 on bad input). Default: as given. */
  params?(raw: Record<string, unknown>, subjectId: string): P | Promise<P>;
  /** True: one operator executes it at once (e.g. a retry that only re-reads, SPEC §4.2). */
  singleControl?(params: P, snapshot: S): boolean | Promise<boolean>;
  /**
   * C23: a single-control execution that releases value (a list hit's clear lifts its freeze, an
   * alert's clear or return ends a hold) carries the requester's wallet signature over
   * `requestMessage` when RAMP_APPROVAL_SIGNATURES — the session cookie alone never decides it.
   */
  signSingleControl?(params: P, snapshot: S): boolean;
  describe(params: P, snapshot: S): string;
  snapshot(subjectId: string, params: P): Promise<S>;
  validate(params: P, snapshot: S, subjectId: string): Promise<unknown>;
  execute(params: P, snapshot: S, ctx: ApprovalExecutionContext): Promise<R>;
  /** The account the subject belongs to (I8): no person linked to it may request or approve. */
  subjectUser?(subjectId: string, params: P, snapshot: S): Promise<string | null>;
  /**
   * I8 beyond one subject account (market.resolve: a stake in the market): a refusal when one of
   * `people` — through any account linked to them — may not act on the subject. Asked of the
   * requester at request, of both persons at approval, and of both again under the subject lock
   * before `execute` (there a refusal closes the approval as failed).
   */
  conflict?(
    subjectId: string,
    params: P,
    snapshot: S,
    people: LinkedPerson[],
  ): Promise<Refusal | null>;
  lockKey?(subjectId: string): string | null;
}

type AnyDefinition = ApprovalActionDefinition<Record<string, unknown>, unknown, unknown>;

export interface ApprovalOutcome {
  approval: ApiApproval;
  /** Present once executed. */
  result?: unknown;
}

function refusal(r: Refusal): ApiError {
  return new ApiError(r.status, r.code, r.message, r.details);
}

/**
 * Four-eyes approvals between PERSONS (SPEC §6.5, I8, X11, M9). `request` stores the params, their
 * hash and a precondition snapshot (one pending request per action and subject); it executes at
 * once when the action is single-control or RAMP_DUAL_CONTROL=false — through the same path an
 * approval takes. `approve` needs another person with the approve roles, neither person linked to
 * the subject's account, a live (business-day TTL) request, and — RAMP_APPROVAL_SIGNATURES — the
 * approver's wallet signature over `truthoracle-approval:<id>:<params_hash>:approve`, verified like
 * the admin sign-in against the operator's pinned key. Execution re-validates with fresh reads and
 * compares the snapshot, under the subject lock; every step is audited (`admin.approval.*`).
 */
@Injectable()
export class AdminApprovalService {
  private readonly logger = new Logger(AdminApprovalService.name);
  private readonly definitions = new Map<string, AnyDefinition>();
  private readonly calendar: BusinessCalendar;

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(AdminApprovalEntity) private readonly rows: Repository<AdminApprovalEntity>,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {
    this.calendar = new BusinessCalendar(
      config.rampControls.bankHolidays,
      config.rampControls.bankWorkdays,
    );
  }

  /** Register an action (from the registering module's `onModuleInit`); returns its unregister. */
  register<P extends Record<string, unknown>, S, R>(
    definition: ApprovalActionDefinition<P, S, R>,
  ): () => void {
    if (this.definitions.has(definition.action))
      throw new Error(`approval action ${definition.action} is already registered`);
    // Stored type-erased: params and snapshots come back from jsonb; each action reads its own.
    this.definitions.set(definition.action, definition);
    return () => {
      this.definitions.delete(definition.action);
    };
  }

  registeredActions(): string[] {
    return [...this.definitions.keys()].sort();
  }

  // ───────────────────────────────────────────── request ────────────────────────────────────

  async request(
    input: {
      action: string;
      subjectId: string;
      params?: Record<string, unknown>;
      reason: string;
      /** C23: the requester's signature over `requestMessage` (single control that releases value). */
      signature?: string | null;
    },
    actor: AdminActor,
  ): Promise<ApprovalOutcome> {
    const def = this.require(input.action);
    if (!input.reason?.trim()) throw new ApiError(400, "validation_failed", "a reason is required");
    const role = missingRole(actor.roles, def.requestRoles);
    if (role)
      throw new ApiError(403, "role_required", `requesting this needs the ${role} role`, { role });
    const params = def.params
      ? await def.params(input.params ?? {}, input.subjectId)
      : (input.params ?? {});
    const paramsHash = paramsHashOf({
      action: def.action,
      subjectType: def.subjectType,
      subjectId: input.subjectId,
      params,
    });
    const snapshot = await def.snapshot(input.subjectId, params);
    const subjectUser = def.subjectUser
      ? await def.subjectUser(input.subjectId, params, snapshot)
      : null;
    const linked = linkedRefusal(
      subjectUser,
      [operatorOf(actor)],
      this.config.rampControls.operatorAccounts,
    );
    if (linked) throw refusal(linked);
    await this.requireNoConflict(def, input.subjectId, params, snapshot, [operatorOf(actor)]);
    await def.validate(params, snapshot, input.subjectId);

    await this.expireSubject(def, input.subjectId);
    const existing = await this.pendingFor(def, input.subjectId);
    if (existing) return this.samePending(existing, paramsHash);

    const singleControl =
      !this.config.rampControls.dualControl ||
      (def.singleControl ? await def.singleControl(params, snapshot) : false);
    // C23: verified before anything is saved — an unsigned request leaves no row behind.
    const signature =
      singleControl && def.signSingleControl?.(params, snapshot)
        ? this.verifyRequestSignature(
            requestMessage(def.action, input.subjectId, paramsHash, snapshot),
            input.signature ?? null,
            actor,
          )
        : null;
    const now = new Date();
    let row: AdminApprovalEntity;
    try {
      row = await this.rows.save(
        this.rows.create({
          action: def.action,
          subjectType: def.subjectType,
          subjectId: input.subjectId,
          params: asJson(params) as Record<string, unknown>,
          paramsHash,
          precondition: asJson(snapshot) as Record<string, unknown>,
          reason: input.reason.trim(),
          status: "pending",
          requestedByUserId: actor.userId,
          requestedByParty: actor.operatorParty,
          requestedByPerson: actor.personId,
          requestedAt: now,
          singleControl,
          expiresAt: expiresAtFor(now, this.config.rampControls.approvalTtlBdays, this.calendar),
        }),
      );
    } catch (err) {
      // The partial unique index: another request for this subject won the race.
      const raced = await this.pendingFor(def, input.subjectId);
      if (raced) return this.samePending(raced, paramsHash);
      throw err;
    }
    await this.auditRow("admin.approval.requested", row, actor, { singleControl });
    if (!singleControl) return { approval: this.toApi(row, def, params, snapshot) };
    return this.decide(row.id, actor, { reason: null, signature }, { atRequest: true });
  }

  // ───────────────────────────────────────────── decisions ──────────────────────────────────

  /** A second person approves: checks, then the same execution path as a single-control request. */
  async approve(
    id: string,
    body: { reason: string; signature?: string | null },
    actor: AdminActor,
  ): Promise<ApprovalOutcome> {
    if (!body.reason?.trim()) throw new ApiError(400, "validation_failed", "a reason is required");
    const row = await this.live(id);
    const def = this.require(row.action);
    const subjectUser = def.subjectUser
      ? await def.subjectUser(row.subjectId, row.params, row.precondition)
      : null;
    const refused = approveRefusal({
      approver: { ...operatorOf(actor), roles: actor.roles },
      requester: requesterOf(row),
      approveRoles: def.approveRoles ?? ["approver"],
      subjectUserId: subjectUser,
      accounts: this.config.rampControls.operatorAccounts,
    });
    if (refused) throw refusal(refused);
    await this.requireNoConflict(def, row.subjectId, row.params, row.precondition, [
      operatorOf(actor),
      requesterOf(row),
    ]);
    this.verifySignature(row, "approve", body.signature ?? null, actor);
    return this.decide(
      id,
      actor,
      { reason: body.reason.trim(), signature: body.signature ?? null },
      { atRequest: false },
    );
  }

  /** The requester (same person) cancels; another person holding the approve roles rejects. */
  async reject(
    id: string,
    body: { reason: string; signature?: string | null },
    actor: AdminActor,
  ): Promise<ApprovalOutcome> {
    if (!body.reason?.trim()) throw new ApiError(400, "validation_failed", "a reason is required");
    const row = await this.live(id);
    const def = this.require(row.action);
    const own = actor.personId === row.requestedByPerson;
    if (!own) {
      const role = missingRole(actor.roles, def.approveRoles ?? ["approver"]);
      if (role)
        throw new ApiError(403, "approval_role_required", `rejecting this needs the ${role} role`, {
          role,
        });
    }
    this.verifySignature(row, "reject", body.signature ?? null, actor);
    const status: ApprovalStatus = own ? "cancelled" : "rejected";
    const res = await this.rows.update(
      { id, status: "pending" },
      {
        status,
        decidedByUserId: actor.userId,
        decidedByParty: actor.operatorParty,
        decidedByPerson: actor.personId,
        decidedAt: new Date(),
        decisionReason: body.reason.trim(),
        decisionSignature: body.signature ?? null,
      },
    );
    if (!res.affected)
      throw new ApiError(409, "approval_not_pending", "the approval is no longer pending");
    const fresh = await this.rows.findOneByOrFail({ id });
    await this.auditRow(
      own ? "admin.approval.cancelled" : "admin.approval.rejected",
      fresh,
      actor,
      {},
    );
    return { approval: this.toApi(fresh, def) };
  }

  /** `POST /admin/approvals/approve-many {ids, reason, signatures}`: one action type, each id on its own. */
  async approveMany(
    body: { ids: string[]; reason: string; signatures?: Record<string, string> | null },
    actor: AdminActor,
  ): Promise<ApiApproveManyResult> {
    const ids = [...new Set(body.ids)];
    if (!ids.length) throw new ApiError(400, "validation_failed", "ids must not be empty");
    const rows = await this.rows.findBy({ id: In(ids) });
    const actions = new Set(rows.map((r) => r.action));
    if (actions.size > 1)
      throw new ApiError(400, "validation_failed", "approve-many takes one action type per call", {
        actions: [...actions],
      });
    const results: ApiApproveManyResult["results"] = [];
    for (const id of ids) {
      try {
        const out = await this.approve(
          id,
          { reason: body.reason, signature: body.signatures?.[id] ?? null },
          actor,
        );
        results.push({
          id,
          approval: out.approval,
          ...(out.result !== undefined ? { result: out.result } : {}),
        });
      } catch (err) {
        const e = ApiError.is(err)
          ? err
          : new ApiError(500, "internal_error", (err as Error).message);
        const approval = await this.rows.findOneBy({ id });
        results.push({
          id,
          ...(approval
            ? { approval: this.toApi(approval, this.definitions.get(approval.action)) }
            : {}),
          error: { error: e.code, message: e.message },
        });
      }
    }
    return { results };
  }

  // ───────────────────────────────────────────── execution ──────────────────────────────────

  /**
   * The one execution path (approval, or a single-control request): under `lock:approval:<id>`
   * the row must still be pending; under the subject lock a fresh snapshot must equal the stored
   * one and `validate` must pass (else `failed` + 409 approval_precondition_changed); then
   * pending → approved (the decision), `execute`, → executed (result) or failed (error).
   */
  private async decide(
    id: string,
    actor: AdminActor,
    decision: { reason: string | null; signature: string | null },
    opts: { atRequest: boolean },
  ): Promise<ApprovalOutcome> {
    const lock = await this.redis.acquireLock(`lock:approval:${id}`, DECISION_LOCK_TTL_MS);
    if (!lock.acquired)
      throw new ApiError(409, "approval_not_pending", "a decision on this approval is in progress");
    try {
      const row = await this.live(id);
      const def = this.require(row.action);
      const subjectKey = def.lockKey
        ? def.lockKey(row.subjectId)
        : `lock:approval-subject:${def.subjectType}:${row.subjectId}`;
      const subject = subjectKey
        ? await this.redis.acquireLock(subjectKey, DECISION_LOCK_TTL_MS)
        : null;
      if (subject && !subject.acquired)
        throw new ApiError(
          409,
          "approval_not_pending",
          "the subject is busy; try again in a moment",
        );
      try {
        return await this.executeLocked(row, def, actor, decision, opts);
      } finally {
        await subject?.release();
      }
    } finally {
      await lock.release();
    }
  }

  private async executeLocked(
    row: AdminApprovalEntity,
    def: AnyDefinition,
    actor: AdminActor,
    decision: { reason: string | null; signature: string | null },
    opts: { atRequest: boolean },
  ): Promise<ApprovalOutcome> {
    const params = row.params;
    let fresh: unknown;
    try {
      fresh = await def.snapshot(row.subjectId, params);
      if (canonicalJson(asJson(fresh)) !== canonicalJson(row.precondition))
        throw new ApiError(
          409,
          "approval_precondition_changed",
          "the subject changed since the request",
          {
            expected: row.precondition,
            actual: asJson(fresh),
          },
        );
      await def.validate(params, row.precondition, row.subjectId);
      await this.requireNoConflict(def, row.subjectId, params, row.precondition, [
        operatorOf(actor),
        requesterOf(row),
      ]);
    } catch (err) {
      const e = ApiError.is(err)
        ? err
        : new ApiError(500, "internal_error", (err as Error).message);
      await this.close(row, "failed", actor, decision, { error: `${e.code}: ${e.message}` });
      throw new ApiError(
        409,
        "approval_precondition_changed",
        `the request no longer applies: ${e.message}`,
        {
          approvalId: row.id,
          cause: e.code,
          ...(e.details ?? {}),
        },
      );
    }
    const won = await this.rows.update(
      { id: row.id, status: "pending" },
      {
        status: "approved",
        decidedByUserId: actor.userId,
        decidedByParty: actor.operatorParty,
        decidedByPerson: actor.personId,
        decidedAt: new Date(),
        decisionReason: decision.reason,
        decisionSignature: decision.signature,
      },
    );
    if (!won.affected)
      throw new ApiError(409, "approval_not_pending", "the approval is no longer pending");
    let result: unknown;
    try {
      result = await def.execute(params, row.precondition, {
        approvalId: row.id,
        subjectId: row.subjectId,
        actor,
        requester: requesterOf(row),
        reason: row.reason,
        decisionReason: decision.reason,
      });
    } catch (err) {
      const e = ApiError.is(err)
        ? err
        : new ApiError(500, "internal_error", (err as Error).message);
      const failed = await this.close(row, "failed", actor, decision, {
        error: `${e.code}: ${e.message}`,
        from: "approved",
      });
      this.logger.warn(`approval ${row.id} (${row.action}) failed: ${e.message}`);
      // A request that executed at once IS the action: its own error. A second person's approval: approval_failed.
      if (opts.atRequest) throw e;
      throw new ApiError(409, "approval_failed", `the approved action failed: ${e.message}`, {
        approvalId: row.id,
        cause: e.code,
        approval: this.toApi(failed, def),
      });
    }
    const executed = await this.close(row, "executed", actor, decision, {
      result: asJson(result ?? null),
      from: "approved",
    });
    return { approval: this.toApi(executed, def), result };
  }

  /** CAS from `pending` (or `approved`) to a final status, with the audit row. */
  private async close(
    row: AdminApprovalEntity,
    status: "executed" | "failed",
    actor: AdminActor,
    decision: { reason: string | null; signature: string | null },
    set: { result?: unknown; error?: string; from?: ApprovalStatus },
  ): Promise<AdminApprovalEntity> {
    const now = new Date();
    await this.rows.update(
      { id: row.id, status: set.from ?? "pending" },
      {
        status,
        ...(set.from
          ? {}
          : {
              decidedByUserId: actor.userId,
              decidedByParty: actor.operatorParty,
              decidedByPerson: actor.personId,
              decidedAt: now,
              decisionReason: decision.reason,
              decisionSignature: decision.signature,
            }),
        ...(status === "executed" ? { executedAt: now, result: set.result as never } : {}),
        ...(set.error ? { error: set.error.slice(0, 1000) } : {}),
      },
    );
    const fresh = await this.rows.findOneByOrFail({ id: row.id });
    await this.auditRow(
      status === "executed" ? "admin.approval.executed" : "admin.approval.failed",
      fresh,
      actor,
      {
        error: set.error ?? null,
      },
    );
    return fresh;
  }

  /** The action's `conflict` hook over each person once, with their linked accounts (I8). */
  private async requireNoConflict(
    def: AnyDefinition,
    subjectId: string,
    params: Record<string, unknown>,
    snapshot: unknown,
    people: Operator[],
  ): Promise<void> {
    if (!def.conflict) return;
    const persons = new Map<string, LinkedPerson>();
    for (const p of people)
      if (!persons.has(p.person))
        persons.set(p.person, linkedPerson(p, this.config.rampControls.operatorAccounts));
    const refused = await def.conflict(subjectId, params, snapshot, [...persons.values()]);
    if (refused) throw refusal(refused);
  }

  // ───────────────────────────────────────────── reads ──────────────────────────────────────

  async list(filter: {
    status?: ApprovalStatus;
    action?: string;
    subjectType?: string;
    subjectId?: string;
  }): Promise<ApiApproval[]> {
    await this.expireStale();
    const rows = await this.rows.find({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.action ? { action: filter.action } : {}),
        ...(filter.subjectType ? { subjectType: filter.subjectType } : {}),
        ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
      },
      order: { requestedAt: "DESC" },
      take: LIST_LIMIT,
    });
    return rows.map((r) => this.toApi(r, this.definitions.get(r.action)));
  }

  async get(id: string): Promise<ApiApproval> {
    await this.expireStale();
    const row = await this.rows.findOneBy({ id });
    if (!row) throw new ApiError(404, "not_found", "approval not found");
    return this.toApi(row, this.definitions.get(row.action));
  }

  /** Pending approvals past their TTL → expired (the recon processor sweeps; reads expire lazily too). */
  async expireStale(): Promise<number> {
    const stale = await this.rows.find({
      where: { status: "pending", expiresAt: LessThan(new Date()) },
      take: 500,
    });
    let n = 0;
    for (const row of stale) {
      const res = await this.rows.update({ id: row.id, status: "pending" }, { status: "expired" });
      if (!res.affected) continue;
      n += 1;
      await this.audit.record({
        actorType: "system",
        action: "admin.approval.expired",
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        metadata: {
          approvalId: row.id,
          action: row.action,
          expiresAt: row.expiresAt.toISOString(),
        },
      });
    }
    return n;
  }

  toApi(
    row: AdminApprovalEntity,
    def?: AnyDefinition,
    params?: unknown,
    snapshot?: unknown,
  ): ApiApproval {
    let description: string | null;
    try {
      description = def
        ? def.describe(
            (params ?? row.params) as Record<string, unknown>,
            snapshot ?? row.precondition,
          )
        : null;
    } catch {
      // A describe that cannot read an old snapshot never hides the approval itself.
      description = null;
    }
    return {
      id: row.id,
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      params: row.params,
      paramsHash: row.paramsHash,
      precondition: row.precondition,
      description,
      reason: row.reason,
      status: row.status,
      singleControl: row.singleControl,
      requestedByUserId: row.requestedByUserId,
      requestedByParty: row.requestedByParty,
      requestedByPerson: row.requestedByPerson,
      requestedAt: row.requestedAt.toISOString(),
      decidedByUserId: row.decidedByUserId,
      decidedByParty: row.decidedByParty,
      decidedByPerson: row.decidedByPerson,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReason: row.decisionReason,
      executedAt: row.executedAt?.toISOString() ?? null,
      result: row.result ?? null,
      error: row.error,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  // ───────────────────────────────────────────── helpers ────────────────────────────────────

  private require(action: string): AnyDefinition {
    const def = this.definitions.get(action);
    if (!def) throw new ApiError(400, "validation_failed", `unknown approval action ${action}`);
    return def;
  }

  /** The approval, pending and not past its TTL (an expired one is closed on the way: 409 approval_expired). */
  private async live(id: string): Promise<AdminApprovalEntity> {
    const row = await this.rows.findOneBy({ id });
    if (!row) throw new ApiError(404, "not_found", "approval not found");
    if (row.status === "pending" && row.expiresAt.getTime() < Date.now()) {
      await this.expireStale();
      throw new ApiError(409, "approval_expired", "the approval expired; request it again", {
        approvalId: id,
      });
    }
    if (row.status !== "pending")
      throw new ApiError(409, "approval_not_pending", `the approval is ${row.status}`, {
        approvalId: id,
        status: row.status,
      });
    return row;
  }

  private async pendingFor(
    def: AnyDefinition,
    subjectId: string,
  ): Promise<AdminApprovalEntity | null> {
    return this.rows.findOneBy({
      action: def.action,
      subjectType: def.subjectType,
      subjectId,
      status: "pending",
    });
  }

  private async expireSubject(def: AnyDefinition, subjectId: string): Promise<void> {
    const row = await this.pendingFor(def, subjectId);
    if (row && row.expiresAt.getTime() < Date.now()) await this.expireStale();
  }

  /** A second identical request answers the pending one; different params → 409 approval_pending. */
  private samePending(existing: AdminApprovalEntity, paramsHash: string): ApprovalOutcome {
    if (existing.paramsHash === paramsHash)
      return { approval: this.toApi(existing, this.definitions.get(existing.action)) };
    throw new ApiError(409, "approval_pending", "another request for this subject is pending", {
      approvalId: existing.id,
    });
  }

  /**
   * C23 (RAMP_APPROVAL_SIGNATURES): the requester's wallet signed `message` — the request of a
   * single-control decision that releases value. Missing → 400 with the message to sign; a key
   * that is not the operator's or a signature that does not verify → 401. Returns the signature.
   */
  private verifyRequestSignature(
    message: string,
    signature: string | null,
    actor: AdminActor,
  ): string | null {
    if (!this.config.rampControls.approvalSignatures) return null;
    if (!signature)
      throw new ApiError(
        400,
        "approval_signature_required",
        "this decision must carry the operator wallet's signature",
        { message },
      );
    const key = actor.publicKey;
    if (!key || !publicKeyMatchesParty(key, actor.operatorParty))
      throw new ApiError(
        401,
        "approval_signature_invalid",
        "no verified key is known for this operator",
      );
    if (!verifyPartySignature({ message, signature, publicKey: key }).ok)
      throw new ApiError(
        401,
        "approval_signature_invalid",
        "the decision signature did not verify",
      );
    return signature;
  }

  /** RAMP_APPROVAL_SIGNATURES: the decider's wallet signed this exact decision (as the admin sign-in verifies). */
  private verifySignature(
    row: AdminApprovalEntity,
    decision: ApprovalDecision,
    signature: string | null,
    actor: AdminActor,
  ): void {
    if (!this.config.rampControls.approvalSignatures) return;
    if (!signature)
      throw new ApiError(
        400,
        "approval_signature_required",
        "this decision must carry the operator wallet's signature",
        {
          message: approvalMessage(row.id, row.paramsHash, decision),
        },
      );
    const key = actor.publicKey;
    if (!key || !publicKeyMatchesParty(key, actor.operatorParty))
      throw new ApiError(
        401,
        "approval_signature_invalid",
        "no verified key is known for this operator",
      );
    const res = verifyPartySignature({
      message: approvalMessage(row.id, row.paramsHash, decision),
      signature,
      publicKey: key,
    });
    if (!res.ok)
      throw new ApiError(
        401,
        "approval_signature_invalid",
        "the decision signature did not verify",
      );
  }

  private async auditRow(
    action:
      | "admin.approval.requested"
      | "admin.approval.executed"
      | "admin.approval.failed"
      | "admin.approval.rejected"
      | "admin.approval.cancelled",
    row: AdminApprovalEntity,
    actor: AdminActor,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      metadata: {
        approvalId: row.id,
        action: row.action,
        paramsHash: row.paramsHash,
        status: row.status,
        reason: row.reason,
        decisionReason: row.decisionReason,
        requester: {
          userId: row.requestedByUserId,
          party: row.requestedByParty,
          person: row.requestedByPerson,
        },
        decider: row.decidedByUserId
          ? { userId: row.decidedByUserId, party: row.decidedByParty, person: row.decidedByPerson }
          : null,
        singleControl: row.singleControl,
        // F2/F8: what the approval moves and for whom, as the deciding person read it.
        description: this.toApi(row, this.definitions.get(row.action)).description,
        ...(action === "admin.approval.executed" ? { result: summarise(row.result) } : {}),
        ...extra,
      },
      ip: actor.ip,
    });
  }
}

/**
 * C23: what a single-control request that releases value is signed over — the action, the
 * subject, the params hash and the subject's state when asked (a replay after the state moved no
 * longer verifies).
 */
export function requestMessage(
  action: string,
  subjectId: string,
  paramsHash: string,
  snapshot: unknown,
): string {
  const state = createHash("sha256")
    .update(canonicalJson(asJson(snapshot)), "utf8")
    .digest("hex");
  return `truthoracle-approval:request:${action}:${subjectId}:${paramsHash}:${state}`;
}

function operatorOf(actor: AdminActor): { userId: string; party: string; person: string } {
  return { userId: actor.userId, party: actor.operatorParty, person: actor.personId };
}

function requesterOf(row: AdminApprovalEntity): { userId: string; party: string; person: string } {
  return {
    userId: row.requestedByUserId,
    party: row.requestedByParty,
    person: row.requestedByPerson,
  };
}

/** The result on the audit row: ids and statuses only (a whole order would bloat the trail). */
function summarise(result: unknown): unknown {
  if (!result || typeof result !== "object") return result ?? null;
  const r = result as Record<string, unknown>;
  const pick = [
    "id",
    "status",
    "reviewStep",
    "version",
    "commandId",
    "pendingPayoutCid",
    "mode",
    "ok",
  ];
  const out: Record<string, unknown> = {};
  for (const k of pick) if (k in r) out[k] = r[k];
  return Object.keys(out).length ? out : "(see the approval)";
}
