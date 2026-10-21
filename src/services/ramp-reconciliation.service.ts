import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, Not, Repository } from "typeorm";

import { Config } from "../config";
import { RampReconRunEntity, type StoredReconCheck } from "../entities/ramp-recon-run.entity";
import type { ApiReconRun, HaltScope, ReconStatus, ReconTrigger } from "../types";
import { HOUR_MS, MINUTE_MS } from "../util/time";
import { AuditService } from "./audit.service";
import { escalateUnknown, haltScopesOf, worstStatus } from "./ramp-controls.logic";
import { RampControlsService } from "./ramp-controls.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";

/** Crash ceiling of `lock:ramp-recon`; an unfinished run older than this is no longer "running". */
export const RAMP_RECON_LOCK_TTL_MS = 10 * MINUTE_MS;
/** On demand (SPEC §6.2): a run that finished this recently is answered instead of a new one. */
const ON_DEMAND_REUSE_MS = 60_000;
/** A red paging check pages at most this often. */
const PAGE_EVERY_MS = HOUR_MS;
/** A token-only (sync) run is written when a status changes, else at most this often. */
const SYNC_HEARTBEAT_MS = 15 * MINUTE_MS;

export const FULL_RUN_TRIGGERS: readonly ReconTrigger[] = ["schedule", "admin", "pre_batch"];

export interface ReconCheckContext {
  trigger: ReconTrigger;
  now: Date;
  /** This check's outcome in the latest run that evaluated it (history-dependent checks). */
  previous: StoredReconCheck | null;
  /** Per-run memo: checks reading the same source share one read. */
  cache: Map<string, unknown>;
}

export interface ReconCheckOutcome {
  status: ReconStatus;
  detail?: string | null;
  /** 10-dp strings, counts and ISO times — never PII. */
  figures?: Record<string, unknown> | null;
}

/** A reconciliation check (SPEC §6.2). Stages register their own from their module's `onModuleInit`. */
export interface ReconCheckDefinition {
  name: string;
  /** Scopes a red (or an unknown past RAMP_RECON_UNKNOWN_MAX_MIN) halts; [] = report only. */
  haltScopes: HaltScope[];
  /** Page (Sentry error, tag page=true) on red — the SPEC §6.2 paging set only. */
  page?: boolean;
  run(ctx: ReconCheckContext): Promise<ReconCheckOutcome>;
}

/** The latest CONFIRMED bank statement of the client-money account (S6 registers the source). */
export interface ReserveStatement {
  statementId: string;
  /** The statement's period end, a Minsk calendar day (`YYYY-MM-DD`). */
  periodTo: string;
  closingBalance: bigint;
  confirmedAt?: Date | null;
  /**
   * C3: Σ (≤ 0) of the debit lines of the confirmed statements still unbooked — money the bank
   * shows gone that the journal's safeguard_bank still counts. The reserve gate and
   * reserve_covers_liabilities take it off A; S6's source always fills it (absent = 0).
   */
  unbookedDebits?: bigint;
}

export type ReserveSource = () => Promise<ReserveStatement | null>;

export interface CheckResult {
  definition: Pick<ReconCheckDefinition, "name" | "haltScopes" | "page">;
  outcome: ReconCheckOutcome;
}

/**
 * Reconciliation (SPEC §6.2) with a check registry: every registered check runs in a FULL run —
 * every RAMP_RECON_EVERY_MIN (RampReconProcessor) under `lock:ramp-recon`, on demand (the run in
 * progress or one finished < 60 s ago is answered instead) and before a batch approval — and the
 * token checks also on every token sync pass (`recordRun('sync', …)`, X8). A check that throws
 * is `unknown`; a halting check unknown for longer than RAMP_RECON_UNKNOWN_MAX_MIN counts as red.
 * Red halting checks halt their scopes at once (RAMP_AUTO_HALT); red checks of the paging set
 * page (Sentry error + `page=true`, once an hour each). Every run is stored with its checks.
 */
@Injectable()
export class RampReconciliationService {
  private readonly logger = new Logger(RampReconciliationService.name);
  private readonly checks = new Map<string, ReconCheckDefinition>();
  private reserveSource: ReserveSource | null = null;

  constructor(
    private readonly config: Config,
    @InjectRepository(RampReconRunEntity) private readonly runs: Repository<RampReconRunEntity>,
    private readonly controls: RampControlsService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────────────────────── registry ───────────────────────────────────

  /** Register a check (names are unique); returns its unregister. */
  registerCheck(definition: ReconCheckDefinition): () => void {
    if (this.checks.has(definition.name))
      throw new Error(`reconciliation check ${definition.name} is already registered`);
    this.checks.set(definition.name, definition);
    return () => {
      this.checks.delete(definition.name);
    };
  }

  registeredChecks(): ReconCheckDefinition[] {
    return [...this.checks.values()];
  }

  /** S6: the latest confirmed statement of the client-money account. One source; returns its unregister. */
  registerReserveSource(source: ReserveSource): () => void {
    if (this.reserveSource) throw new Error("a reserve source is already registered");
    this.reserveSource = source;
    return () => {
      if (this.reserveSource === source) this.reserveSource = null;
    };
  }

  hasReserveSource(): boolean {
    return this.reserveSource !== null;
  }

  /** The latest confirmed statement; null without a source or a statement. Throws when the source fails (callers: unknown / fail closed). */
  async reserveStatement(): Promise<ReserveStatement | null> {
    return this.reserveSource ? this.reserveSource() : null;
  }

  // ───────────────────────────────────────────── runs ───────────────────────────────────────

  /** The latest FINISHED full run (what the gates read). */
  async latestFullRun(): Promise<RampReconRunEntity | null> {
    return this.runs.findOne({
      where: { trigger: In([...FULL_RUN_TRIGGERS]), finishedAt: Not(IsNull()) },
      order: { startedAt: "DESC" },
    });
  }

  /** The newest full run, finished or not, and whether one is running now. */
  async latest(): Promise<{ run: RampReconRunEntity | null; running: boolean }> {
    const newest = await this.runs.findOne({
      where: { trigger: In([...FULL_RUN_TRIGGERS]) },
      order: { startedAt: "DESC" },
    });
    const running = Boolean(newest && !newest.finishedAt && this.young(newest));
    const run = newest?.finishedAt ? newest : await this.latestFullRun();
    return { run, running };
  }

  /**
   * One full run under `lock:ramp-recon`; null when another instance holds the lock. Every check
   * runs on its own (a throw is `unknown`), then the run is finished (escalation, halts, pages).
   */
  async runFull(trigger: ReconTrigger = "schedule"): Promise<RampReconRunEntity | null> {
    const lock = await this.redis
      .acquireLock("lock:ramp-recon", RAMP_RECON_LOCK_TTL_MS)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) return null;
    try {
      const run = await this.runs.save(
        this.runs.create({ trigger, startedAt: new Date(), status: "unknown", checks: [] }),
      );
      const previous = await this.previousChecks();
      const results: CheckResult[] = [];
      const cache = new Map<string, unknown>();
      for (const definition of this.checks.values()) {
        const ctx: ReconCheckContext = {
          trigger,
          now: new Date(),
          previous: previous.get(definition.name) ?? null,
          cache,
        };
        let outcome: ReconCheckOutcome;
        try {
          outcome = await definition.run(ctx);
        } catch (err) {
          outcome = { status: "unknown", detail: `could not be read: ${(err as Error).message}` };
        }
        results.push({ definition, outcome });
      }
      return await this.finish(run, results, previous);
    } finally {
      await lock.release();
    }
  }

  /**
   * `POST /admin/ramp/reconciliation/run` (rate-limited): the run in progress, or one that
   * finished < 60 s ago, else a new full run.
   */
  async runOnDemand(trigger: ReconTrigger = "admin"): Promise<RampReconRunEntity> {
    const { run, running } = await this.latest();
    if (running) {
      const newest = await this.runs.findOne({
        where: { trigger: In([...FULL_RUN_TRIGGERS]) },
        order: { startedAt: "DESC" },
      });
      if (newest) return newest;
    }
    if (run?.finishedAt && Date.now() - run.finishedAt.getTime() < ON_DEMAND_REUSE_MS) return run;
    const fresh = await this.runFull(trigger);
    if (fresh) return fresh;
    const newest = await this.runs.findOne({
      where: { trigger: In([...FULL_RUN_TRIGGERS]) },
      order: { startedAt: "DESC" },
    });
    if (!newest) throw new Error("reconciliation is locked but no run is recorded");
    return newest;
  }

  /**
   * A partial run computed elsewhere — the token checks of a sync pass (X8). Halts and pages at
   * once like a full run; stored when a status changed since the last sync run (else every 15 min).
   */
  async recordRun(trigger: "sync", results: CheckResult[]): Promise<RampReconRunEntity | null> {
    const previous = await this.previousChecks();
    const last = await this.runs.findOne({ where: { trigger }, order: { startedAt: "DESC" } });
    const run = this.runs.create({ trigger, startedAt: new Date(), status: "unknown", checks: [] });
    const finished = await this.finish(run, results, previous, { persist: false });
    const changed =
      !last ||
      Date.now() - last.startedAt.getTime() >= SYNC_HEARTBEAT_MS ||
      finished.halted ||
      finished.checks.some((c) => last.checks.find((p) => p.name === c.name)?.status !== c.status);
    return changed ? this.runs.save(finished) : null;
  }

  toApi(run: RampReconRunEntity): ApiReconRun {
    return {
      id: run.id,
      trigger: run.trigger,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      status: run.status,
      checks: run.checks.map((c) => ({
        name: c.name,
        status: c.status,
        detail: c.detail,
        figures: c.figures,
        haltScopes: c.haltScopes,
      })),
      halted: run.halted,
    };
  }

  // ───────────────────────────────────────────── internals ──────────────────────────────────

  private young(run: RampReconRunEntity): boolean {
    return Date.now() - run.startedAt.getTime() < RAMP_RECON_LOCK_TTL_MS;
  }

  /** Each check's latest stored outcome across the newest full run and the newest sync run. */
  private async previousChecks(): Promise<Map<string, StoredReconCheck>> {
    const [full, sync] = await Promise.all([
      this.latestFullRun(),
      this.runs.findOne({ where: { trigger: "sync" }, order: { startedAt: "DESC" } }),
    ]);
    const ordered = [full, sync]
      .filter((r): r is RampReconRunEntity => r !== null)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const out = new Map<string, StoredReconCheck>();
    for (const r of ordered) for (const c of r.checks) out.set(c.name, c);
    return out;
  }

  private async finish(
    run: RampReconRunEntity,
    results: CheckResult[],
    previous: Map<string, StoredReconCheck>,
    opts: { persist?: boolean } = {},
  ): Promise<RampReconRunEntity> {
    const now = new Date();
    const checks: StoredReconCheck[] = results.map(({ definition, outcome }) => {
      // An unknown streak carries across runs (also once escalated to red); anything else starts it anew.
      const since = previous.get(definition.name)?.unknownSince ?? null;
      const esc = escalateUnknown(
        { status: outcome.status, haltScopes: definition.haltScopes },
        since ? new Date(since) : null,
        now,
        this.config.rampControls.reconUnknownMaxMin,
      );
      return {
        name: definition.name,
        status: esc.status,
        detail: esc.escalated
          ? `unknown for over ${this.config.rampControls.reconUnknownMaxMin} min: ${outcome.detail ?? ""}`.slice(
              0,
              1000,
            )
          : ((outcome.detail ?? null)?.slice(0, 1000) ?? null),
        figures: outcome.figures ?? null,
        haltScopes: [...definition.haltScopes],
        unknownSince: esc.unknownSince,
      };
    });
    run.checks = checks;
    run.status = worstStatus(checks.map((c) => c.status));
    run.finishedAt = now;

    const red = checks.filter((c) => c.status === "red");
    const scopes = haltScopesOf(red);
    if (scopes.length && this.config.rampControls.autoHalt) {
      const failing = red
        .filter((c) => c.haltScopes.length)
        .map((c) => ({ name: c.name, detail: c.detail }));
      run.halted = await this.controls.autoHalt(scopes, failing);
    }
    for (const c of red) {
      if (previous.get(c.name)?.status !== "red") {
        this.logger.error(`reconciliation ${c.name} is red: ${c.detail ?? ""}`);
        await this.audit
          .record({
            actorType: "system",
            action: "ramp.recon.red",
            subjectType: "ramp_recon",
            subjectId: c.name,
            metadata: { trigger: run.trigger, detail: c.detail, haltScopes: c.haltScopes },
          })
          .catch(() => undefined);
      }
      const definition = results.find((r) => r.definition.name === c.name)?.definition;
      if (definition?.page) await this.page(c);
    }
    return opts.persist === false ? run : this.runs.save(run);
  }

  /** Sentry error + `page=true`, at most once an hour per check (any instance). */
  private async page(check: StoredReconCheck): Promise<void> {
    const once = await this.redis
      .acquireLock(`page:ramp-recon:${check.name}`, PAGE_EVERY_MS)
      .catch(() => ({ acquired: true }));
    if (!once.acquired) return;
    this.sentry.captureMessage(`ramp reconciliation: ${check.name} is red`, "error", {
      component: "ramp-recon",
      check: check.name,
      page: "true",
    });
  }
}
