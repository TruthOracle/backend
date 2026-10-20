import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, Repository } from "typeorm";

import { Config } from "../config";
import { ComplianceFreezeEntity } from "../entities/compliance-freeze.entity";
import { INDEXER_STATE_KEY } from "../entities/indexer-state.entity";
import { type ApiComplianceFreeze, FREEZING_LISTS, type FreezeSource } from "../types";
import { BusinessCalendar, minskDate } from "../util/by-calendar";
import { ApiError } from "../util/errors";
import { toIso } from "../util/time";
import type { AdminActor } from "./admin.service";
import { linkedRefusal } from "./admin-approval.logic";
import { AdminApprovalService, type ApprovalExecutionContext } from "./admin-approval.service";
import { AuditService } from "./audit.service";
import { RampCompliancePort } from "./ramp-compliance.port";
import { UserService } from "./user.service";

/** What `compliance.freeze.lift` compares between request and approval (fresh reads only). */
export interface FreezeSnapshot {
  id: string;
  userId: string;
  active: boolean;
  provisional: boolean;
  source: FreezeSource;
}

/** One frozen party's on-ledger transaction the scan found. */
interface FrozenActivityRow {
  update_id: string;
  party: string;
  offset: string;
  at: Date | null;
  what: string[];
}

const LIST_LIMIT = 200;

/**
 * Freezes (SPEC §11.6; B3, X6, I10). `isFrozen` is the one answer every value point asks through
 * ComplianceFreezePort (S5's call sites; bound by ComplianceScreeningService). A freeze is placed at
 * once by an `aml` operator (`freeze`) or provisionally by a Belarusian / UN list hit
 * (`ensureFrozen`); the AML decision on the hit confirms it (`confirmProvisional`) or lifts it
 * (`releaseProvisional`); any other lift is the four-eyes `compliance.freeze.lift` (aml requests,
 * another person with `approver` approves; nobody linked to the account). Lifting resumes
 * everything the freeze held on the next pass of each loop — nothing is replayed here.
 * `scanFrozenActivity` raises TM-FROZEN-ACTIVITY for every indexed transaction a frozen party
 * acted in (user-signed trades bypass the backend; an on-ledger freeze is a contracts follow-up).
 */
@Injectable()
export class ComplianceFreezeService implements OnModuleInit {
  private readonly logger = new Logger(ComplianceFreezeService.name);
  private readonly calendar: BusinessCalendar;

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(ComplianceFreezeEntity)
    private readonly freezes: Repository<ComplianceFreezeEntity>,
    private readonly approvals: AdminApprovalService,
    private readonly compliance: RampCompliancePort,
    private readonly users: UserService,
    private readonly audit: AuditService,
  ) {
    this.calendar = new BusinessCalendar(
      config.rampControls.bankHolidays,
      config.rampControls.bankWorkdays,
    );
  }

  onModuleInit(): void {
    this.approvals.register<Record<string, never>, FreezeSnapshot, ApiComplianceFreeze>({
      action: "compliance.freeze.lift",
      subjectType: "compliance_freeze",
      requestRoles: ["aml"],
      approveRoles: ["approver"],
      params: () => ({}),
      snapshot: (id) => this.snapshot(id),
      validate: (_p, s) => this.validateLift(s),
      describe: (_p, s) =>
        `lift the ${s.provisional ? "provisional " : ""}${s.source} freeze of account ${s.userId}`,
      subjectUser: async (_id, _p, s) => s.userId,
      lockKey: (id) => `lock:compliance-freeze:${id}`,
      execute: (_p, s, ctx) => this.liftApproved(s, ctx),
    });
  }

  // ───────────────────────────────────────────── answers ────────────────────────────────────

  /** Is the account frozen now? A read failure throws (fail closed, I7). */
  async isFrozen(userId: string): Promise<boolean> {
    const [row] = await this.dataSource.query<{ frozen: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM to_compliance_freezes WHERE user_id = $1 AND active) AS frozen`,
      [userId],
    );
    return row?.frozen === true;
  }

  async active(userId: string, manager?: EntityManager): Promise<ComplianceFreezeEntity | null> {
    const repo = manager ? manager.getRepository(ComplianceFreezeEntity) : this.freezes;
    return repo.findOne({ where: { userId, active: true } });
  }

  // ───────────────────────────────────────────── operator freeze ────────────────────────────

  /**
   * `POST /admin/compliance/freezes` (role `aml`, at once): a freeze only reduces risk, so it needs
   * no second person — but nobody freezes an account linked to themselves (I8). One active freeze
   * per account: `409 freeze_active {freezeId}` when there is one (a provisional one is confirmed
   * through its hit).
   */
  async freeze(
    input: { userId: string; reason: string; source: FreezeSource },
    actor: AdminActor,
  ): Promise<ApiComplianceFreeze> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    const linked = linkedRefusal(
      user.id,
      [{ userId: actor.userId, party: actor.operatorParty, person: actor.personId }],
      this.config.rampControls.operatorAccounts,
    );
    if (linked) throw new ApiError(linked.status, linked.code, linked.message, linked.details);
    const placed = await this.insertActive(user.id, {
      reason: input.reason,
      source: input.source,
      provisional: false,
      createdByUserId: actor.userId,
      createdByPerson: actor.personId,
    });
    if (!placed) {
      const existing = await this.active(user.id);
      throw new ApiError(409, "freeze_active", "the account already has an active freeze", {
        freezeId: existing?.id ?? null,
      });
    }
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      ip: actor.ip,
      action: "compliance.freeze.created",
      subjectType: "compliance_freeze",
      subjectId: placed.id,
      metadata: {
        userId: user.id,
        source: input.source,
        reason: input.reason,
        operatorPerson: actor.personId,
        provisional: false,
      },
    });
    this.logger.warn(`account ${user.id} frozen by ${actor.personId} (${input.source})`);
    return this.toApi(placed);
  }

  /**
   * A list hit's provisional freeze (automatic, `created_by_user_id` null), in the caller's
   * transaction. An account already frozen keeps its freeze (returned with `created: false`).
   */
  async ensureFrozen(
    manager: EntityManager,
    userId: string,
    reason: string,
  ): Promise<{ freeze: ComplianceFreezeEntity; created: boolean }> {
    const placed = await this.insertActive(
      userId,
      {
        reason,
        source: "screening",
        provisional: true,
        createdByUserId: null,
        createdByPerson: null,
      },
      manager,
    );
    if (placed) return { freeze: placed, created: true };
    const existing = await this.active(userId, manager);
    if (!existing) throw new Error(`account ${userId}: no freeze placed and none active`);
    return { freeze: existing, created: false };
  }

  /** `INSERT … ON CONFLICT DO NOTHING` on the one-active-freeze index; null when one is active. */
  private async insertActive(
    userId: string,
    v: {
      reason: string;
      source: FreezeSource;
      provisional: boolean;
      createdByUserId: string | null;
      createdByPerson: string | null;
    },
    manager?: EntityManager,
  ): Promise<ComplianceFreezeEntity | null> {
    const q = manager ?? this.dataSource.manager;
    // Activity before the freeze is not frozen activity: the TM-FROZEN-ACTIVITY scan starts here.
    const offset = await this.indexedOffset(q);
    const rows = await q.query<{ id: string }[]>(
      `INSERT INTO to_compliance_freezes (user_id, reason, source, provisional, active, created_by_user_id, created_by_person, activity_offset)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
      [userId, v.reason, v.source, v.provisional, v.createdByUserId, v.createdByPerson, offset],
    );
    if (rows.length === 0) return null;
    return q.getRepository(ComplianceFreezeEntity).findOneByOrFail({ id: rows[0].id });
  }

  // ───────────────────────────────────────────── hit decisions ──────────────────────────────

  /**
   * R2b-3: serialise, per account, a list hit's freeze link with a lift — held for the rest of the
   * caller's transaction. ON CONFLICT DO NOTHING never waits on a row lock, so without it a hit
   * committed between a lift's count and its UPDATE stays open behind the lifted freeze.
   */
  async lockAccount(manager: EntityManager, userId: string): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`freeze:${userId}`]);
  }

  /** Open hits of a freezing list (Belarusian, UN, Decree No. 48) on the account. */
  private async openFreezingHits(q: EntityManager, userId: string): Promise<number> {
    const [open] = await q.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM to_screening_hits h JOIN to_screening_lists l ON l.id = h.list_id
        WHERE h.user_id = $1 AND h.status = 'open' AND l.list = ANY($2)`,
      [userId, [...FREEZING_LISTS]],
    );
    return open?.n ?? 0;
  }

  /**
   * Lock the account's active freeze row (if any) for the rest of the caller's transaction — after
   * the account lock, the order every freeze writer takes them in (no deadlock with a lift).
   */
  async lockActive(manager: EntityManager, userId: string): Promise<void> {
    await this.lockAccount(manager, userId);
    await manager.query(
      `SELECT id FROM to_compliance_freezes WHERE user_id = $1 AND active FOR UPDATE`,
      [userId],
    );
  }

  /**
   * `compliance.hit.decide confirm` on a Belarusian / UN hit: the account's freeze stops being
   * provisional (or, when none is active any more, a firm one is placed). Returns the freeze id.
   */
  async confirmProvisional(
    manager: EntityManager,
    userId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<string> {
    const repo = manager.getRepository(ComplianceFreezeEntity);
    const current = await this.active(userId, manager);
    if (current) {
      if (current.provisional)
        await repo.update({ id: current.id, active: true }, { provisional: false });
      return current.id;
    }
    const placed = await this.insertActive(
      userId,
      {
        reason,
        source: "screening",
        provisional: false,
        createdByUserId: actor.userId,
        createdByPerson: actor.personId,
      },
      manager,
    );
    if (!placed)
      throw new ApiError(409, "freeze_active", "the account's freeze changed; try again");
    return placed.id;
  }

  /**
   * `compliance.hit.decide clear`: the provisional screening freeze is lifted once no other open
   * hit of a freezing list holds it. A firm freeze (confirmed, or placed by an operator) stays.
   * Returns the lifted freeze id, or null.
   */
  async releaseProvisional(
    manager: EntityManager,
    userId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<string | null> {
    await this.lockAccount(manager, userId);
    const current = await this.active(userId, manager);
    if (!current?.provisional || current.source !== "screening") return null;
    if ((await this.openFreezingHits(manager, userId)) > 0) return null;
    const res = await manager
      .getRepository(ComplianceFreezeEntity)
      .update(
        { id: current.id, active: true },
        { active: false, liftedAt: new Date(), liftedByUserId: actor.userId, liftReason: reason },
      );
    return res.affected ? current.id : null;
  }

  // ───────────────────────────────────────────── four-eyes lift ─────────────────────────────

  private async snapshot(id: string): Promise<FreezeSnapshot> {
    const row = await this.freezes.findOne({ where: { id } });
    if (!row) throw new ApiError(404, "not_found", "freeze not found");
    return {
      id: row.id,
      userId: row.userId,
      active: row.active,
      provisional: row.provisional,
      source: row.source,
    };
  }

  /** Only an active freeze lifts; a list hit still open is decided first (its decision lifts a provisional freeze). */
  private async validateLift(s: FreezeSnapshot): Promise<void> {
    if (!s.active) throw new ApiError(409, "freeze_state", "the freeze is no longer active");
    this.requireNoOpenHits(
      s.userId,
      await this.openFreezingHits(this.dataSource.manager, s.userId),
    );
  }

  private requireNoOpenHits(userId: string, openHits: number): void {
    if (openHits > 0)
      throw new ApiError(
        409,
        "screening_hits_open",
        "an open list hit holds this account; decide it first",
        { userId, openHits },
      );
  }

  private async liftApproved(
    s: FreezeSnapshot,
    ctx: ApprovalExecutionContext,
  ): Promise<ApiComplianceFreeze> {
    // R2b-3: counted again under the account lock, in the transaction that lifts — a hit recorded
    // after validate either commits first (and is counted) or waits and places its own freeze.
    const res = await this.dataSource.transaction(async (m) => {
      await this.lockAccount(m, s.userId);
      this.requireNoOpenHits(s.userId, await this.openFreezingHits(m, s.userId));
      return m.getRepository(ComplianceFreezeEntity).update(
        { id: s.id, active: true },
        {
          active: false,
          liftedAt: new Date(),
          liftedByUserId: ctx.actor.userId,
          liftApprovalId: ctx.approvalId,
          liftReason: ctx.reason,
        },
      );
    });
    if (!res.affected) throw new ApiError(409, "freeze_state", "the freeze is no longer active");
    await this.audit.record({
      actorType: "admin",
      actorUserId: ctx.actor.userId,
      actorSessionId: ctx.actor.sessionId,
      ip: ctx.actor.ip,
      action: "compliance.freeze.lifted",
      subjectType: "compliance_freeze",
      subjectId: s.id,
      metadata: {
        userId: s.userId,
        approvalId: ctx.approvalId,
        requester: ctx.requester.person,
        approver: ctx.actor.personId,
        reason: ctx.reason,
      },
    });
    this.logger.warn(`freeze ${s.id} of account ${s.userId} lifted (approval ${ctx.approvalId})`);
    return this.toApi(await this.freezes.findOneByOrFail({ id: s.id }));
  }

  // ───────────────────────────────────────────── reads ──────────────────────────────────────

  /** `GET /admin/compliance/freezes?active&userId`: newest first (at most 200). */
  async list(filter: { active?: boolean; userId?: string }): Promise<ApiComplianceFreeze[]> {
    const rows = await this.freezes.find({
      where: {
        ...(filter.active === undefined ? {} : { active: filter.active }),
        ...(filter.userId ? { userId: filter.userId } : {}),
      },
      order: { createdAt: "DESC", id: "DESC" },
      take: LIST_LIMIT,
    });
    return rows.map((r) => this.toApi(r));
  }

  async get(id: string): Promise<ApiComplianceFreeze> {
    const row = await this.freezes.findOne({ where: { id } });
    if (!row) throw new ApiError(404, "not_found", "freeze not found");
    return this.toApi(row);
  }

  toApi(r: ComplianceFreezeEntity): ApiComplianceFreeze {
    return {
      id: r.id,
      userId: r.userId,
      reason: r.reason,
      source: r.source,
      provisional: r.provisional,
      active: r.active,
      createdByUserId: r.createdByUserId,
      createdByPerson: r.createdByPerson,
      liftApprovalId: r.liftApprovalId,
      liftedByUserId: r.liftedByUserId,
      liftReason: r.liftReason,
      liftedAt: toIso(r.liftedAt),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  // ───────────────────────────────────────────── TM-FROZEN-ACTIVITY ─────────────────────────

  /** The indexer's committed offset (rows up to it are complete transactions). */
  private async indexedOffset(q: EntityManager = this.dataSource.manager): Promise<number> {
    const [row] = await q.query<{ offset: string }[]>(
      `SELECT "offset"::text AS "offset" FROM to_indexer_state WHERE key = $1`,
      [INDEXER_STATE_KEY],
    );
    return row ? Number(row.offset) : 0;
  }

  /**
   * Every transaction the indexer committed since each active freeze was last checked in which a
   * party of the frozen account ACTED (an exercise it controlled, a root create it signed, a token
   * transfer to or from the treasury): one TM-FROZEN-ACTIVITY (block, due the end of the same
   * Belarusian business day) per transaction and party through the compliance port, and an audit
   * row. The indexer stays untouched — this reads its committed rows. Returns how many were found.
   */
  async scanFrozenActivity(): Promise<number> {
    const indexed = await this.indexedOffset();
    const freezes = await this.freezes.find({
      where: { active: true },
      order: { createdAt: "ASC" },
    });
    let found = 0;
    for (const f of freezes) {
      if (f.activityOffset >= indexed) continue;
      const parties = await this.partiesOf(f.userId);
      const rows = parties.length ? await this.activity(parties, f.activityOffset, indexed) : [];
      for (const row of rows) {
        await this.raiseActivity(f, row);
        found += 1;
      }
      // Compare-and-set: two scanners never report the same range twice.
      await this.freezes.update(
        { id: f.id, activityOffset: f.activityOffset },
        { activityOffset: indexed },
      );
    }
    return found;
  }

  /** Every party ever linked to the account (a party is bound to its first account forever, §8.1). */
  async partiesOf(userId: string): Promise<string[]> {
    const rows = await this.dataSource.query<{ party: string }[]>(
      `SELECT party_id AS party FROM to_wallets WHERE user_id = $1
        UNION SELECT party_id FROM to_users WHERE id = $1 AND party_id IS NOT NULL`,
      [userId],
    );
    return rows.map((r) => r.party);
  }

  private async activity(
    parties: string[],
    fromExclusive: number,
    toInclusive: number,
  ): Promise<FrozenActivityRow[]> {
    return this.dataSource.query<FrozenActivityRow[]>(
      `SELECT x.update_id, x.party, min(x.offset)::text AS "offset", min(x.at) AS at,
              array_agg(DISTINCT x.what) AS what
         FROM (
           SELECT e.update_id, p.party, e.offset, e.effective_at AS at,
                  coalesce(e.entity || '.' || e.choice, 'create ' || e.entity) AS what
             FROM to_ledger_events e
             JOIN unnest($1::text[]) AS p(party) ON
                  (e.kind = 'exercised' AND e.acting_parties ? p.party)
               OR (e.kind = 'created' AND e.parent_node_id IS NULL AND e.signatories ? p.party)
            WHERE e.offset > $2 AND e.offset <= $3 AND e.update_id <> 'acs'
           UNION ALL
           SELECT t.update_id, t.counterparty, t.offset, t.effective_at, 'transfer ' || t.direction
             FROM to_ledger_transfers t
            WHERE t.offset > $2 AND t.offset <= $3 AND t.counterparty = ANY($1::text[])
         ) x
        GROUP BY x.update_id, x.party
        ORDER BY min(x.offset)`,
      [parties, fromExclusive, toInclusive],
    );
  }

  private async raiseActivity(f: ComplianceFreezeEntity, row: FrozenActivityRow): Promise<void> {
    const at = row.at ? new Date(row.at) : new Date();
    const figures = {
      severity: "block",
      freezeId: f.id,
      party: row.party,
      updateId: row.update_id,
      offset: Number(row.offset),
      at: at.toISOString(),
      what: row.what,
      // One alert per frozen account and Minsk day; every transaction is in the audit trail.
      windowKey: `frozen-activity:${f.id}:${minskDate(at)}`,
      dueAt: this.calendar
        .endOfBusinessDayUtc(this.calendar.addBusinessDays(new Date(), 0))
        .toISOString(),
    };
    const alertId = await this.compliance.raise("TM-FROZEN-ACTIVITY", f.userId, figures);
    await this.audit.record({
      actorType: "system",
      action: "compliance.frozen_activity",
      subjectType: "compliance_freeze",
      subjectId: f.id,
      metadata: { ...figures, userId: f.userId, alertId },
    });
    this.logger.warn(
      `frozen account ${f.userId}: party ${row.party.slice(0, 24)}… acted on the ledger (${row.update_id})`,
    );
  }
}
