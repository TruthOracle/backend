import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, In, Repository } from "typeorm";

import { Config } from "../config";
import { ScreeningEntryEntity } from "../entities/screening-entry.entity";
import { ScreeningHitEntity } from "../entities/screening-hit.entity";
import { ScreeningListEntity } from "../entities/screening-list.entity";
import { ScreeningRunEntity } from "../entities/screening-run.entity";
import { ScreeningSubjectEntity } from "../entities/screening-subject.entity";
import {
  type ApiScreeningHit,
  type ApiScreeningHitDetail,
  type ApiScreeningImport,
  type ApiScreeningList,
  type ApiScreeningRun,
  SCREENING_LISTS,
  type ScreeningHitStatus,
  type ScreeningListName,
  type ScreeningRunTrigger,
} from "../types";
import { BusinessCalendar } from "../util/by-calendar";
import { decodeText, type TextCharset } from "../util/charset";
import { ApiError } from "../util/errors";
import { MINUTE_MS, toIso } from "../util/time";
import type { AdminActor } from "./admin.service";
import { AdminApprovalService } from "./admin-approval.service";
import { AuditService } from "./audit.service";
import { ComplianceAlertsService } from "./compliance-alerts.service";
import { ComplianceFreezePort } from "./compliance-freeze.port";
import { ComplianceFreezeService } from "./compliance-freeze.service";
import { KycIdentityPort, type VerifiedIdentity } from "./kyc-identity.port";
import { RampCompliancePort } from "./ramp-compliance.port";
import { consentPrincipalAad } from "./ramp-consent.service";
import { type ReconCheckOutcome, RampReconciliationService } from "./ramp-reconciliation.service";
import { RedisService } from "./redis.service";
import { SealedDataService } from "./sealed-data.service";
import {
  buildScreeningIndex,
  type CompiledEntry,
  decodeBase64Upload,
  freezesOnHit,
  parseScreeningList,
  rescreenDue,
  type ScreeningIndex,
  type ScreeningMatch,
  screeningStaleness,
  screenSubject,
} from "./screening.logic";

/** Crash ceiling of `lock:compliance-rescreen`; a full re-screen reads every identity. */
const RESCREEN_LOCK_TTL_MS = 30 * MINUTE_MS;
const USER_PAGE = 500;
const ENTRY_INSERT_CHUNK = 1_000;
const LIST_LIMIT = 200;
/** The upload's decoded size cap (the route's body limit is 8 MB of base64). */
const MAX_LIST_BYTES = 6 * 1024 * 1024;

/** `compliance.hit.decide` params and the state it compares between request and execution. */
export interface HitDecisionParams extends Record<string, unknown> {
  decision: "confirm" | "clear";
}
export interface HitSnapshot {
  id: string;
  userId: string;
  status: ScreeningHitStatus;
  list: ScreeningListName;
}

interface LatestList {
  id: string;
  list: ScreeningListName;
  version: string;
}

/** What one re-screen pass over an account found. */
interface SubjectOutcome {
  identity: boolean;
  parties: number;
  newHits: number;
  /** C44: the identity (or a declared principal) could not be read; the parties were screened. */
  unreadable: boolean;
}

/**
 * List screening (SPEC §11.6; B1): imports (`aml`, normalized CSV, charset, the admin_import
 * limit), entries keyed with util/name-fold.ts, and re-screens of EVERY account with a verified
 * identity or a party — dormant ones included — on import and every RAMP_RESCREEN_DAYS
 * (ComplianceScreeningProcessor, `lock:compliance-rescreen`; identities AS STORED, no provider call
 * per account), and of one account before an order when it is not screened against the latest
 * lists, its current KYC verification and its latest identity refresh (art.9-1: screen before
 * contracting; `ordersDenied`). These tables are the ONE screening state (no copy on the identity;
 * S8). A Belarusian / UN /
 * Decree No. 48 hit freezes the account provisionally (every value movement held) and raises
 * TM-LIST (block, due the end of the same Belarusian business day) through the compliance port; a
 * foreign-list hit denies new orders and raises a review alert, never a freeze. The AML officer
 * decides each hit (`compliance.hit.decide`, single control, role `aml`): confirm → the freeze
 * stays (provisional = false), clear → the provisional freeze is lifted. Binds
 * ComplianceFreezePort (isFrozen + ordersDenied) and registers the `screening_stale` check.
 */
@Injectable()
export class ComplianceScreeningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ComplianceScreeningService.name);
  private readonly calendar: BusinessCalendar;
  private cache: { key: string; index: ScreeningIndex } | null = null;
  private unbind: (() => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(ScreeningListEntity) private readonly lists: Repository<ScreeningListEntity>,
    @InjectRepository(ScreeningEntryEntity)
    private readonly entries: Repository<ScreeningEntryEntity>,
    @InjectRepository(ScreeningHitEntity) private readonly hits: Repository<ScreeningHitEntity>,
    @InjectRepository(ScreeningRunEntity) private readonly runs: Repository<ScreeningRunEntity>,
    @InjectRepository(ScreeningSubjectEntity)
    private readonly subjects: Repository<ScreeningSubjectEntity>,
    private readonly freezes: ComplianceFreezeService,
    private readonly freezePort: ComplianceFreezePort,
    private readonly identities: KycIdentityPort,
    private readonly compliance: RampCompliancePort,
    private readonly alerts: ComplianceAlertsService,
    private readonly approvals: AdminApprovalService,
    private readonly reconciliation: RampReconciliationService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly sealed: SealedDataService,
  ) {
    this.calendar = new BusinessCalendar(
      config.rampControls.bankHolidays,
      config.rampControls.bankWorkdays,
    );
  }

  onModuleInit(): void {
    this.unbind = this.freezePort.bind({
      isFrozen: (userId) => this.freezes.isFrozen(userId),
      ordersDenied: (userId) => this.ordersDenied(userId),
      screenNewParties: (userId) => this.screenNewParties(userId),
    });
    this.approvals.register<HitDecisionParams, HitSnapshot, ApiScreeningHit>({
      action: "compliance.hit.decide",
      subjectType: "screening_hit",
      requestRoles: ["aml"],
      approveRoles: ["aml"],
      params: (raw) => {
        if (raw.decision !== "confirm" && raw.decision !== "clear")
          throw new ApiError(400, "validation_failed", "decision must be confirm or clear");
        return { decision: raw.decision };
      },
      // SPEC §6.5: the AML officer decides alone (the freeze it leaves is lifted only by four eyes).
      singleControl: () => true,
      // C23: a clear lifts the provisional freeze — signed by the officer's wallet, not the cookie alone.
      signSingleControl: (p) => p.decision === "clear",
      snapshot: (id) => this.hitSnapshot(id),
      validate: async (p, s) => this.validateDecision(p, s),
      describe: (p, s) => `${p.decision} the ${s.list} list hit on account ${s.userId}`,
      subjectUser: async (_id, _p, s) => s.userId,
      lockKey: (id) => `lock:screening-hit:${id}`,
      execute: (p, s, ctx) => this.applyDecision(p.decision, s, ctx.actor, ctx),
    });
    this.reconciliation.registerCheck({
      name: "screening_stale",
      haltScopes: [],
      run: () => this.staleCheck(),
    });
  }

  onModuleDestroy(): void {
    this.unbind?.();
    this.unbind = null;
  }

  // ───────────────────────────────────────────── the port's answers ─────────────────────────

  /**
   * New orders are refused (SPEC §11.3, §11.6): the account is frozen, a list hit is open, or a
   * foreign-list hit was confirmed (B1: deny, never freeze). An account not yet screened against
   * the latest lists is screened first (art.9-1); an identity that cannot be read then refuses
   * (fail closed, I7) — the reason the user sees is the neutral `compliance` either way.
   */
  async ordersDenied(userId: string): Promise<boolean> {
    if (await this.freezes.isFrozen(userId)) return true;
    if (await this.unresolvedHit(userId)) return true;
    if (!(await this.needsScreening(userId))) return false;
    try {
      await this.screenUser(userId, "user", null);
    } catch (err) {
      this.logger.warn(`account ${userId} could not be screened: ${(err as Error).message}`);
      return true;
    }
    return (await this.freezes.isFrozen(userId)) || (await this.unresolvedHit(userId));
  }

  /** An open hit of any list, or a confirmed foreign-list hit, refuses new orders. */
  async unresolvedHit(userId: string): Promise<boolean> {
    const [row] = await this.dataSource.query<{ held: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM to_screening_hits h JOIN to_screening_lists l ON l.id = h.list_id
                       WHERE h.user_id = $1 AND (h.status = 'open' OR (h.status = 'confirmed' AND l.list = 'foreign'))) AS held`,
      [userId],
    );
    return row?.held === true;
  }

  /**
   * No screening yet, not against every latest list version, of another KYC verification, older
   * than the identity's latest refresh (its names or birth date may have changed), of other party
   * ids (C27: a newly linked party), before the latest consent (C13: its declared principal), or
   * last time unreadable (C44: refused until it is read).
   */
  private async needsScreening(userId: string): Promise<boolean> {
    const subject = await this.subjects.findOne({ where: { userId } });
    if (!subject) return true;
    if (subject.identityUnreadableAt) return true;
    if (subject.kycVerificationId !== (await this.verificationOf(userId))) return true;
    if (!sameParties(await this.freezes.partiesOf(userId), subject.partyIds)) return true;
    if ((await this.latestConsentOf(userId)) !== subject.consentId) return true;
    // Compared as read (ms), not against `screened_at`: app and database clocks may differ.
    const [identity] = await this.dataSource.query<{ refreshedAt: Date }[]>(
      `SELECT refreshed_at AS "refreshedAt" FROM to_kyc_identities WHERE user_id = $1`,
      [userId],
    );
    if (identity && identity.refreshedAt.getTime() !== subject.identityRefreshedAt?.getTime())
      return true;
    const covered = new Set(subject.listIds);
    return (await this.latestLists()).some((l) => !covered.has(l.id));
  }

  /** The account's latest consent (any terms): a newer one may declare a principal (C13). */
  private async latestConsentOf(userId: string): Promise<string | null> {
    const [row] = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM to_ramp_consents WHERE user_id = $1 ORDER BY accepted_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    return row?.id ?? null;
  }

  /** C13: the principals the account's consents declare it acts for (unsealed; throws when one cannot be). */
  private async principalsOf(userId: string): Promise<{ consentId: string; text: string }[]> {
    const rows = await this.dataSource.query<{ id: string; sealed: string }[]>(
      `SELECT id, principal_sealed AS sealed FROM to_ramp_consents
        WHERE user_id = $1 AND NOT acts_for_self AND principal_sealed IS NOT NULL ORDER BY accepted_at, id`,
      [userId],
    );
    return rows.map((r) => ({
      consentId: r.id,
      text: this.sealed.unseal(r.sealed, consentPrincipalAad(userId, r.id)),
    }));
  }

  /** The account's current KYC verification (a first approval or a re-verification changes it). */
  private async verificationOf(userId: string): Promise<string | null> {
    const [row] = await this.dataSource.query<{ id: string | null }[]>(
      `SELECT kyc_verification_id AS id FROM to_users WHERE id = $1`,
      [userId],
    );
    return row?.id ?? null;
  }

  // ───────────────────────────────────────────── the latest lists ───────────────────────────

  /** The latest imported version of every list. */
  async latestLists(manager?: EntityManager): Promise<LatestList[]> {
    const q = manager ?? this.dataSource.manager;
    return q.query<LatestList[]>(
      `SELECT DISTINCT ON (list) id, list, version FROM to_screening_lists ORDER BY list, imported_at DESC, id DESC`,
    );
  }

  /** The matcher over the latest lists, rebuilt when a list version changes. */
  private async index(latest: LatestList[]): Promise<ScreeningIndex> {
    const key = latest
      .map((l) => l.id)
      .sort()
      .join(",");
    if (this.cache?.key === key) return this.cache.index;
    const listOf = new Map(latest.map((l) => [l.id, l.list]));
    const rows = latest.length
      ? await this.entries.find({ where: { listId: In(latest.map((l) => l.id)) } })
      : [];
    const compiled: CompiledEntry[] = rows.map((r) => ({
      id: r.id,
      listId: r.listId,
      list: listOf.get(r.listId) as ScreeningListName,
      kind: r.kind,
      names: r.names,
      nameKeys: r.nameKeys,
      birthDate: r.birthDate,
      ids: r.ids,
    }));
    const index = buildScreeningIndex(compiled);
    this.cache = { key, index };
    return index;
  }

  // ───────────────────────────────────────────── import ─────────────────────────────────────

  /**
   * `POST /admin/compliance/screening-lists` (role `aml`): the list version and its entries in one
   * transaction (`409 screening_list_exists` for a version already imported), then the full
   * re-screen of every account (its new hits are in the answer; null when another re-screen held
   * the lock — the processor follows up).
   */
  async importList(
    input: {
      list: ScreeningListName;
      version: string;
      deliveredAt: Date;
      content: string;
      charset: TextCharset;
    },
    actor: AdminActor,
  ): Promise<ApiScreeningImport> {
    if (input.deliveredAt.getTime() > Date.now() + 5 * MINUTE_MS)
      throw new ApiError(400, "validation_failed", "deliveredAt is in the future");
    const bytes = decodeBase64Upload(input.content, MAX_LIST_BYTES);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const parsed = parseScreeningList(decodeText(bytes, input.charset));
    let saved: ScreeningListEntity;
    try {
      saved = await this.dataSource.transaction(async (m) => {
        const repo = m.getRepository(ScreeningListEntity);
        const row = await repo.save(
          repo.create({
            list: input.list,
            version: input.version,
            deliveredAt: input.deliveredAt,
            importedAt: new Date(),
            importedByUserId: actor.userId,
            importedByPerson: actor.personId,
            charset: input.charset,
            sha256,
            entryCount: parsed.length,
          }),
        );
        for (let i = 0; i < parsed.length; i += ENTRY_INSERT_CHUNK)
          await m
            .createQueryBuilder()
            .insert()
            .into(ScreeningEntryEntity)
            .values(
              parsed.slice(i, i + ENTRY_INSERT_CHUNK).map((e) => ({
                listId: row.id,
                line: e.line,
                kind: e.kind,
                names: e.names,
                nameKeys: e.nameKeys,
                birthDate: e.birthDate,
                ids: e.ids,
              })),
            )
            .execute();
        return row;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505")
        throw new ApiError(
          409,
          "screening_list_exists",
          `${input.list} version ${input.version} is already imported`,
        );
      throw err;
    }
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      ip: actor.ip,
      action: "compliance.screening.imported",
      subjectType: "screening_list",
      subjectId: saved.id,
      metadata: {
        list: saved.list,
        version: saved.version,
        deliveredAt: saved.deliveredAt.toISOString(),
        sha256,
        entries: parsed.length,
        operatorPerson: actor.personId,
      },
    });
    this.logger.log(`${saved.list} ${saved.version} imported: ${parsed.length} entries`);
    const run = await this.rescreen("import", actor.userId);
    return { list: this.listToApi(saved), hits: run ? run.hits : null, run };
  }

  // ───────────────────────────────────────────── re-screens ─────────────────────────────────

  /**
   * A FULL re-screen: every account with a KYC applicant or a party (dormant included), against the
   * latest version of every list, under `lock:compliance-rescreen`. An identity that cannot be read
   * is a failure (the run ends `partial` and is retried); null when another re-screen holds the lock.
   */
  async rescreen(
    trigger: Exclude<ScreeningRunTrigger, "user">,
    startedBy: string | null,
  ): Promise<ApiScreeningRun | null> {
    const lockKey = "lock:compliance-rescreen";
    const lock = await this.redis.acquireLock(lockKey, RESCREEN_LOCK_TTL_MS);
    if (!lock.acquired) return null;
    let runId: string | null = null;
    try {
      const latest = await this.latestLists();
      const index = await this.index(latest);
      const run = await this.runs.save(
        this.runs.create({
          trigger,
          scope: "full",
          userId: null,
          listIds: latest.map((l) => l.id),
          status: "running",
          startedAt: new Date(),
          startedByUserId: startedBy,
        }),
      );
      runId = run.id;
      const totals = {
        subjects: 0,
        identities: 0,
        parties: 0,
        hits: 0,
        failures: 0,
        unreadable: 0,
      };
      const unreadableIds: string[] = [];
      const errors: string[] = [];
      let after = "00000000-0000-0000-0000-000000000000";
      for (;;) {
        const page = await this.dataSource.query<{ id: string }[]>(
          `SELECT u.id FROM to_users u
            WHERE u.id > $1 AND (u.kyc_applicant_id IS NOT NULL OR u.party_id IS NOT NULL
                  OR EXISTS (SELECT 1 FROM to_wallets w WHERE w.user_id = u.id))
            ORDER BY u.id LIMIT $2`,
          [after, USER_PAGE],
        );
        if (page.length === 0) break;
        for (const { id } of page) {
          try {
            const out = await this.screenOne(id, latest, index, run.id, "stored");
            totals.subjects += 1;
            if (out.identity) totals.identities += 1;
            totals.parties += out.parties;
            totals.hits += out.newHits;
            if (out.unreadable) {
              totals.unreadable += 1;
              if (unreadableIds.length < 20) unreadableIds.push(id);
            }
          } catch (err) {
            totals.failures += 1;
            if (errors.length < 5) errors.push(`${id}: ${(err as Error).message}`.slice(0, 200));
          }
        }
        after = page[page.length - 1].id;
        await this.redis.pexpire(lockKey, RESCREEN_LOCK_TTL_MS);
      }
      const status = totals.failures > 0 ? "partial" : "done";
      await this.runs.update(
        { id: run.id },
        {
          ...totals,
          status,
          finishedAt: new Date(),
          error: errors.length ? errors.join("; ") : null,
        },
      );
      await this.audit.record({
        actorType: startedBy ? "admin" : "system",
        actorUserId: startedBy,
        action: "compliance.screening.rescreened",
        subjectType: "screening_run",
        subjectId: run.id,
        metadata: { trigger, status, ...totals, unreadableIds, lists: latest },
      });
      if (status !== "done" || totals.hits > 0 || totals.unreadable > 0)
        this.logger.warn(
          `re-screen ${run.id} (${trigger}) ${status}: ${totals.subjects} account(s), ${totals.hits} new hit(s), ${totals.failures} failure(s), ${totals.unreadable} unreadable identit(ies)`,
        );
      return this.runToApi(await this.runs.findOneByOrFail({ id: run.id }));
    } catch (err) {
      if (runId)
        await this.runs
          .update(
            { id: runId },
            {
              status: "failed",
              finishedAt: new Date(),
              error: (err as Error).message.slice(0, 500),
            },
          )
          .catch(() => undefined);
      throw err;
    } finally {
      await lock.release();
    }
  }

  /** One account against the latest lists (before its first order, or on request). */
  async screenUser(
    userId: string,
    trigger: ScreeningRunTrigger,
    startedBy: string | null,
  ): Promise<ApiScreeningRun> {
    const [known] = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM to_users WHERE id = $1`,
      [userId],
    );
    if (!known) throw new ApiError(404, "not_found", "user not found");
    const latest = await this.latestLists();
    const index = await this.index(latest);
    const run = await this.runs.save(
      this.runs.create({
        trigger,
        scope: "user",
        userId,
        listIds: latest.map((l) => l.id),
        status: "running",
        startedAt: new Date(),
        startedByUserId: startedBy,
      }),
    );
    try {
      const out = await this.screenOne(userId, latest, index, run.id, "fresh");
      await this.runs.update(
        { id: run.id },
        {
          status: "done",
          finishedAt: new Date(),
          subjects: 1,
          identities: out.identity ? 1 : 0,
          parties: out.parties,
          hits: out.newHits,
        },
      );
    } catch (err) {
      await this.runs.update(
        { id: run.id },
        {
          status: "failed",
          finishedAt: new Date(),
          failures: 1,
          error: (err as Error).message.slice(0, 500),
        },
      );
      throw err;
    }
    return this.runToApi(await this.runs.findOneByOrFail({ id: run.id }));
  }

  /**
   * `stored` (full re-screens): the identity as stored — a provider call only for an approved
   * account that has none stored yet; `fresh` (one account): refreshed when due (KycIdentityPort.get),
   * else the stored one (KYC no longer approved: the person's last verified identity still counts).
   * Every party id and every declared principal (C13) is screened too. An identity or principal
   * that cannot be read throws for `fresh` (the order is refused, I7); a full re-screen (C44)
   * still screens what it can, records why on the subject — which keeps the account refused until
   * it is read — and moves on, so one unreadable account never fails the whole run.
   */
  private async screenOne(
    userId: string,
    latest: LatestList[],
    index: ScreeningIndex,
    runId: string,
    read: "stored" | "fresh",
  ): Promise<SubjectOutcome> {
    const verification = await this.verificationOf(userId);
    const consentId = await this.latestConsentOf(userId);
    let identity: VerifiedIdentity | null = null;
    let principals: { consentId: string; text: string }[] = [];
    let unreadable: string | null = null;
    try {
      identity =
        read === "stored"
          ? ((await this.identities.stored(userId)) ?? (await this.identities.get(userId)))
          : ((await this.identities.get(userId)) ?? (await this.identities.stored(userId)));
    } catch (err) {
      if (read === "fresh") throw err;
      unreadable = `the verified identity cannot be read: ${(err as Error).message}`;
    }
    try {
      principals = await this.principalsOf(userId);
    } catch (err) {
      if (read === "fresh") throw err;
      unreadable ??= `a declared principal cannot be read: ${(err as Error).message}`;
    }
    const parties = (await this.freezes.partiesOf(userId)).sort();
    const matches = screenSubject(index, {
      names: identity?.names ?? [],
      birthDate: identity?.birthDate ?? null,
      parties,
      principals,
    });
    let newHits = 0;
    for (const m of matches) if (await this.recordHit(userId, m, latest, runId)) newHits += 1;
    await this.subjects.upsert(
      {
        userId,
        screenedAt: new Date(),
        runId,
        listIds: latest.map((l) => l.id),
        identity: identity !== null,
        kycVerificationId: verification,
        identityRefreshedAt: identity?.refreshedAt ?? null,
        parties: parties.length,
        partyIds: parties,
        consentId,
        identityError: unreadable?.slice(0, 300) ?? null,
        identityUnreadableAt: unreadable ? new Date() : null,
      },
      ["userId"],
    );
    if (unreadable) this.logger.warn(`account ${userId}: ${unreadable}`);
    return {
      identity: identity !== null,
      parties: parties.length,
      newHits,
      unreadable: unreadable !== null,
    };
  }

  /**
   * C27, before value moves outside an order (ComplianceFreezePort.assertNotFrozen: market order
   * prepare, deposit reconcile; a payout's verdict): the account's parties linked since its last
   * screening are screened against the latest lists — party ids only, no identity read — and a
   * listed one is a hit (a freezing list freezes provisionally). R2b-5: an account never screened
   * (it never opened a ramp view) has every party screened so, on every call; no subject is
   * written (its first order still screens it in full) and a run only when a party is listed.
   */
  async screenNewParties(userId: string): Promise<void> {
    const subject = await this.subjects.findOne({ where: { userId } });
    const parties = (await this.freezes.partiesOf(userId)).sort();
    const known = new Set(subject?.partyIds ?? []);
    const fresh = parties.filter((p) => !known.has(p));
    if (fresh.length === 0) return;
    const latest = await this.latestLists();
    const index = await this.index(latest);
    const matches = screenSubject(index, { names: [], birthDate: null, parties: fresh });
    if (!subject && matches.length === 0) return;
    const run = await this.runs.save(
      this.runs.create({
        trigger: "user",
        scope: "user",
        userId,
        listIds: latest.map((l) => l.id),
        status: "running",
        startedAt: new Date(),
        startedByUserId: null,
      }),
    );
    let hits = 0;
    for (const m of matches) if (await this.recordHit(userId, m, latest, run.id)) hits += 1;
    if (subject)
      await this.subjects.update(
        { userId },
        { partyIds: [...new Set([...subject.partyIds, ...fresh])].sort(), parties: parties.length },
      );
    await this.runs.update(
      { id: run.id },
      { status: "done", finishedAt: new Date(), subjects: 1, parties: fresh.length, hits },
    );
  }

  /**
   * A NEW hit (one per list version, entry and account; a decided one is never re-opened for that
   * version): with its provisional freeze for a freezing list in the same transaction, then the
   * TM-LIST alert and the audit row. False when the hit already existed.
   */
  private async recordHit(
    userId: string,
    m: ScreeningMatch,
    latest: LatestList[],
    runId: string,
  ): Promise<boolean> {
    const list = latest.find((l) => l.id === m.entry.listId);
    if (!list) return false;
    const freezing = freezesOnHit(list.list);
    const hit = await this.dataSource.transaction(async (manager) => {
      // R2b-3: a lift of the account's freeze runs before this hit or after it, never between.
      if (freezing) await this.freezes.lockAccount(manager, userId);
      const rows = await manager.query<{ id: string }[]>(
        `INSERT INTO to_screening_hits (list_id, entry_id, user_id, run_id, match)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (list_id, entry_id, user_id) DO NOTHING RETURNING id`,
        [list.id, m.entry.id, userId, runId, JSON.stringify(m.match)],
      );
      if (rows.length === 0) return null;
      let freezeId: string | null = null;
      if (freezing) {
        const placed = await this.freezes.ensureFrozen(
          manager,
          userId,
          `${list.list} ${list.version}: list hit (provisional, awaiting the AML decision)`,
        );
        freezeId = placed.freeze.id;
        await manager.getRepository(ScreeningHitEntity).update({ id: rows[0].id }, { freezeId });
      }
      return { id: rows[0].id, freezeId };
    });
    if (!hit) return false;
    const figures = {
      // A freezing list blocks; a foreign list refuses new orders: both are due the same business day.
      severity: freezing ? "block" : "review",
      list: list.list,
      listVersion: list.version,
      listId: list.id,
      hitId: hit.id,
      entryId: m.entry.id,
      basis: m.match.basis,
      freezeId: hit.freezeId,
      windowKey: `hit:${hit.id}`,
      dueAt: this.calendar
        .endOfBusinessDayUtc(this.calendar.addBusinessDays(new Date(), 0))
        .toISOString(),
    };
    let alertId: string | null = null;
    try {
      alertId = await this.compliance.raise("TM-LIST", userId, figures);
    } catch (err) {
      // The hit and its freeze stand; the open hit is on the AML console whatever the alert does.
      this.logger.error(`TM-LIST for hit ${hit.id} could not be raised: ${(err as Error).message}`);
    }
    if (alertId) await this.hits.update({ id: hit.id }, { alertId });
    await this.audit.record({
      actorType: "system",
      action: "compliance.screening.hit",
      subjectType: "screening_hit",
      subjectId: hit.id,
      metadata: { userId, ...figures, alertId },
    });
    this.logger.warn(
      `list hit ${hit.id}: account ${userId} on ${list.list} ${list.version}${freezing ? " — frozen provisionally" : " — new orders refused"}`,
    );
    return true;
  }

  /** The processor's call: a full re-screen when one is due (RAMP_RESCREEN_DAYS, a new list version, a failed attempt). */
  async rescreenIfDue(now = new Date()): Promise<ApiScreeningRun | null> {
    const latest = await this.latestLists();
    const [lastDone] = await this.runs.find({
      where: { scope: "full", status: "done" },
      order: { startedAt: "DESC" },
      take: 1,
    });
    const [lastAttempt] = await this.runs.find({
      where: { scope: "full" },
      order: { startedAt: "DESC" },
      take: 1,
    });
    const due = rescreenDue({
      now,
      rescreenDays: this.config.screening.rescreenDays,
      latestListIds: latest.map((l) => l.id),
      lastDone: lastDone ?? null,
      lastAttempt: lastAttempt ?? null,
    });
    if (!due) return null;
    this.logger.log(`full re-screen due (${due})`);
    return this.rescreen(due === "new_list" ? "import" : "schedule", null);
  }

  // ───────────────────────────────────────────── hit decisions ──────────────────────────────

  private async hitSnapshot(id: string): Promise<HitSnapshot> {
    const [row] = await this.dataSource.query<HitSnapshot[]>(
      `SELECT h.id, h.user_id AS "userId", h.status, l.list
         FROM to_screening_hits h JOIN to_screening_lists l ON l.id = h.list_id WHERE h.id = $1`,
      [id],
    );
    if (!row) throw new ApiError(404, "not_found", "screening hit not found");
    return row;
  }

  /** Open hits are decided; a confirmed FOREIGN hit may still be cleared (it froze nothing). */
  private validateDecision(p: HitDecisionParams, s: HitSnapshot): void {
    const reopenable = p.decision === "clear" && s.status === "confirmed" && s.list === "foreign";
    if (s.status !== "open" && !reopenable)
      throw new ApiError(409, "screening_hit_state", `the hit is already ${s.status}`);
  }

  private async applyDecision(
    decision: HitDecisionParams["decision"],
    s: HitSnapshot,
    actor: AdminActor,
    ctx: { approvalId: string; reason: string },
  ): Promise<ApiScreeningHit> {
    const freezing = freezesOnHit(s.list);
    const effect = await this.dataSource.transaction(async (m) => {
      // Decisions on one account serialize on its freeze row (a clear counts the OTHER open hits).
      if (freezing) await this.freezes.lockActive(m, s.userId);
      const res = await m.getRepository(ScreeningHitEntity).update(
        { id: s.id, status: s.status },
        {
          status: decision === "confirm" ? "confirmed" : "cleared",
          decidedByUserId: actor.userId,
          decidedByPerson: actor.personId,
          decidedAt: new Date(),
          decisionReason: ctx.reason,
          decisionApprovalId: ctx.approvalId,
        },
      );
      if (!res.affected)
        throw new ApiError(409, "screening_hit_state", "the hit was decided meanwhile");
      // The TM-LIST alert this hit raised is decided with it (S8: one AML decision, not two).
      const { alertId } = await m.getRepository(ScreeningHitEntity).findOneByOrFail({ id: s.id });
      const alert = alertId
        ? await this.alerts.decideForHit(m, alertId, { id: s.id, decision }, actor, ctx.reason)
        : null;
      if (!freezing) return { confirmed: null, lifted: null, alert };
      if (decision === "confirm") {
        const freezeId = await this.freezes.confirmProvisional(
          m,
          s.userId,
          `${s.list} list hit confirmed: ${ctx.reason}`,
          actor,
        );
        await m.getRepository(ScreeningHitEntity).update({ id: s.id }, { freezeId });
        return { confirmed: freezeId, lifted: null, alert };
      }
      const lifted = await this.freezes.releaseProvisional(
        m,
        s.userId,
        `list hit cleared: ${ctx.reason}`,
        actor,
      );
      return { confirmed: null, lifted, alert };
    });
    const base = {
      actorType: "admin" as const,
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      ip: actor.ip,
    };
    await this.audit.record({
      ...base,
      action: "compliance.screening.decided",
      subjectType: "screening_hit",
      subjectId: s.id,
      metadata: {
        userId: s.userId,
        list: s.list,
        decision,
        reason: ctx.reason,
        approvalId: ctx.approvalId,
        ...effect,
      },
    });
    if (effect.confirmed)
      await this.audit.record({
        ...base,
        action: "compliance.freeze.confirmed",
        subjectType: "compliance_freeze",
        subjectId: effect.confirmed,
        metadata: { userId: s.userId, hitId: s.id, reason: ctx.reason },
      });
    if (effect.lifted)
      await this.audit.record({
        ...base,
        action: "compliance.freeze.lifted",
        subjectType: "compliance_freeze",
        subjectId: effect.lifted,
        metadata: { userId: s.userId, hitId: s.id, reason: ctx.reason, provisional: true },
      });
    return this.hit(s.id);
  }

  // ───────────────────────────────────────────── reads ──────────────────────────────────────

  /** `GET /admin/compliance/screening-lists`: imported versions, newest first. */
  async listLists(): Promise<ApiScreeningList[]> {
    const rows = await this.lists.find({
      order: { importedAt: "DESC", id: "DESC" },
      take: LIST_LIMIT,
    });
    return rows.map((r) => this.listToApi(r));
  }

  /** `GET /admin/compliance/screening-hits?status&userId&list`: newest first. */
  async listHits(filter: {
    status?: ScreeningHitStatus;
    userId?: string;
    list?: ScreeningListName;
  }): Promise<ApiScreeningHit[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) where.push(`h.status = $${params.push(filter.status)}`);
    if (filter.userId) where.push(`h.user_id = $${params.push(filter.userId)}`);
    if (filter.list) where.push(`l.list = $${params.push(filter.list)}`);
    return this.hitRows(where, params);
  }

  async hit(id: string): Promise<ApiScreeningHit> {
    const [row] = await this.hitRows(["h.id = $1"], [id]);
    if (!row) throw new ApiError(404, "not_found", "screening hit not found");
    return row;
  }

  /** One hit with the account's verified identity (the officer compares both sides; audited as a PII read). */
  async hitDetail(id: string, actor: AdminActor): Promise<ApiScreeningHitDetail> {
    const hit = await this.hit(id);
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      ip: actor.ip,
      action: "compliance.screening.identity_viewed",
      subjectType: "screening_hit",
      subjectId: hit.id,
      metadata: { userId: hit.userId, operatorPerson: actor.personId },
    });
    try {
      const v = await this.identities.get(hit.userId);
      return {
        hit,
        identity: v
          ? {
              names: v.names.map((n) => ({ ...n })),
              birthDate: v.birthDate,
              citizenship: v.citizenship,
              residenceCountry: v.residenceCountry,
            }
          : null,
      };
    } catch (err) {
      return { hit, identity: null, identityError: (err as Error).message.slice(0, 200) };
    }
  }

  private async hitRows(where: string[], params: unknown[]): Promise<ApiScreeningHit[]> {
    const rows = await this.dataSource.query<
      (Omit<ApiScreeningHit, "decidedAt" | "createdAt"> & {
        decidedAt: Date | null;
        createdAt: Date;
      })[]
    >(
      `SELECT h.id, h.list_id AS "listId", l.list, l.version AS "listVersion", h.entry_id AS "entryId",
              e.kind AS "entryKind", h.user_id AS "userId", h.match, h.status, h.alert_id AS "alertId",
              h.freeze_id AS "freezeId", h.decided_by_person AS "decidedByPerson", h.decided_at AS "decidedAt",
              h.decision_reason AS "decisionReason", h.created_at AS "createdAt"
         FROM to_screening_hits h
         JOIN to_screening_lists l ON l.id = h.list_id
         JOIN to_screening_entries e ON e.id = h.entry_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY h.created_at DESC, h.id DESC LIMIT ${LIST_LIMIT}`,
      params,
    );
    return rows.map((r) => ({
      ...r,
      decidedAt: toIso(r.decidedAt),
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  /** The latest re-screens (full and per-account), newest first. */
  async listRuns(): Promise<ApiScreeningRun[]> {
    const rows = await this.runs.find({ order: { startedAt: "DESC", id: "DESC" }, take: 50 });
    return rows.map((r) => this.runToApi(r));
  }

  listToApi(r: ScreeningListEntity): ApiScreeningList {
    return {
      id: r.id,
      list: r.list,
      version: r.version,
      deliveredAt: r.deliveredAt.toISOString(),
      importedAt: r.importedAt.toISOString(),
      importedByPerson: r.importedByPerson,
      charset: r.charset,
      sha256: r.sha256,
      entryCount: r.entryCount,
    };
  }

  runToApi(r: ScreeningRunEntity): ApiScreeningRun {
    return {
      id: r.id,
      trigger: r.trigger,
      scope: r.scope,
      userId: r.userId,
      status: r.status,
      listIds: r.listIds,
      startedAt: r.startedAt.toISOString(),
      finishedAt: toIso(r.finishedAt),
      subjects: r.subjects,
      identities: r.identities,
      parties: r.parties,
      hits: r.hits,
      failures: r.failures,
      unreadable: r.unreadable,
      error: r.error,
    };
  }

  // ───────────────────────────────────────────── reconciliation ─────────────────────────────

  /**
   * SPEC §6.2 `screening_stale` (amber, report only): no complete full re-screen in 90 days, or a
   * freezing list (by_terror, un, decree48) not imported within RAMP_SCREENING_LIST_MAX_AGE_DAYS.
   */
  private async staleCheck(): Promise<ReconCheckOutcome> {
    const [lastDone] = await this.runs.find({
      where: { scope: "full", status: "done" },
      order: { startedAt: "DESC" },
      take: 1,
    });
    const imports = await this.dataSource.query<{ list: ScreeningListName; at: Date }[]>(
      `SELECT list, max(imported_at) AS at FROM to_screening_lists GROUP BY list`,
    );
    const latestImports: Partial<Record<ScreeningListName, Date>> = {};
    for (const r of imports) latestImports[r.list] = new Date(r.at);
    const [unreadable] = await this.dataSource.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM to_screening_subjects WHERE identity_unreadable_at IS NOT NULL`,
    );
    const res = screeningStaleness({
      now: new Date(),
      listMaxAgeDays: this.config.screening.listMaxAgeDays,
      lastDoneFullAt: lastDone?.startedAt ?? null,
      latestImports,
      unreadableAccounts: unreadable?.n ?? 0,
    });
    return {
      status: res.status,
      detail: res.problems.length ? res.problems.join("; ") : null,
      figures: {
        lastFullRescreenAt: toIso(lastDone?.startedAt),
        lists: Object.fromEntries(SCREENING_LISTS.map((l) => [l, toIso(latestImports[l] ?? null)])),
      },
    };
  }
}

/** The same party ids (order and repeats aside)? */
function sameParties(current: readonly string[], screened: readonly string[]): boolean {
  const a = [...new Set(current)].sort();
  const b = [...new Set(screened)].sort();
  return a.length === b.length && a.every((p, i) => p === b[i]);
}
