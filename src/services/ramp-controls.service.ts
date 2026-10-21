import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, Repository } from "typeorm";

import { RampControlEntity, type StoredFailingCheck } from "../entities/ramp-control.entity";
import type { Actor, ApiRampControls, HaltScope } from "../types";
import { ApiError } from "../util/errors";
import { AuditService } from "./audit.service";
import { ALL_SCOPES, mintsHaltHolds } from "./ramp-controls.logic";
import { SentryService } from "./sentry.service";

const KEY = "ramp";

/** What a `ramp.controls.resume` approval snapshots: the halt as the requester saw it. */
export interface RampControlsSnapshot {
  haltedScopes: HaltScope[];
  since: string | null;
  source: string | null;
  failingChecks: string[];
}

/**
 * The ramp's runtime halts (SPEC §6.1). `orders`: no new orders (GET /ramp says paused; open
 * orders stay visible and cancellable). `mints`: startMint waits; a re-mint only when a token-
 * integrity check is among the halt's failing checks. `payouts`: MarkPaid, card payouts, batch
 * approval and the first file download. Burns, refunds of unminted captures, cancels, expiries,
 * credits of recorded mints, bank submissions, statements and returns always run. A halt is set
 * at once (an `ops` operator, or a red check); clearing it is the four-eyes `ramp.controls.resume`.
 * `RAMP_ENABLED=false` stays the static switch for new orders. No row = nothing halted.
 */
@Injectable()
export class RampControlsService {
  private readonly logger = new Logger(RampControlsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RampControlEntity) private readonly rows: Repository<RampControlEntity>,
    private readonly audit: AuditService,
    private readonly sentry: SentryService,
  ) {}

  async state(manager?: EntityManager): Promise<RampControlEntity | null> {
    return (manager?.getRepository(RampControlEntity) ?? this.rows).findOneBy({ key: KEY });
  }

  async controls(): Promise<ApiRampControls> {
    return toApi(await this.state());
  }

  async isHalted(scope: HaltScope): Promise<boolean> {
    return (await this.state())?.haltedScopes.includes(scope) ?? false;
  }

  /** Does the `mints` halt hold an on-ramp mint / a reversal's re-mint now (SPEC §6.1, #6 d)? */
  async mintsHalted(kind: "mint" | "remint"): Promise<boolean> {
    const row = await this.state();
    return row ? mintsHaltHolds(kind, row) : false;
  }

  /** New orders: `503 ramp_paused` while `orders` is halted (the reason stays internal). */
  async requireOrdersOpen(): Promise<void> {
    if (await this.isHalted("orders"))
      throw new ApiError(503, "ramp_paused", "the ramp is paused; open orders still complete");
  }

  /** `POST /admin/ramp/controls/halt` (role `ops`): at once — a halt only reduces risk. */
  async halt(scopes: HaltScope[], reason: string, actor: Actor): Promise<ApiRampControls> {
    if (!reason?.trim()) throw new ApiError(400, "validation_failed", "a reason is required");
    const wanted = ALL_SCOPES.filter((s) => scopes.includes(s));
    if (!wanted.length) throw new ApiError(400, "validation_failed", "name at least one scope");
    const row = await this.merge(wanted, { reason, source: "admin", userId: actor.userId ?? null });
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "ramp.controls.halted",
      subjectType: "ramp_controls",
      subjectId: KEY,
      metadata: { scopes: wanted, reason, source: "admin", haltedScopes: row.haltedScopes },
      ip: actor.ip ?? null,
    });
    this.logger.warn(`ramp halted by an operator: ${wanted.join(", ")} (${reason})`);
    return toApi(row);
  }

  /**
   * A red check halts its scopes at once (SPEC §6.2; X8: also from a token sync pass). Failing
   * checks accumulate by name. True when a scope was newly halted.
   */
  async autoHalt(scopes: HaltScope[], failing: StoredFailingCheck[]): Promise<boolean> {
    const wanted = ALL_SCOPES.filter((s) => scopes.includes(s));
    if (!wanted.length) return false;
    const before = (await this.state())?.haltedScopes ?? [];
    const reason = `automatic: ${failing.map((f) => f.name).join(", ")}`;
    const row = await this.merge(wanted, { reason, source: "auto", userId: null, failing });
    const added = wanted.filter((s) => !before.includes(s));
    if (added.length) {
      await this.audit.record({
        actorType: "system",
        action: "ramp.controls.halted",
        subjectType: "ramp_controls",
        subjectId: KEY,
        metadata: { scopes: added, reason, source: "auto", haltedScopes: row.haltedScopes },
      });
      this.logger.error(`ramp halted automatically: ${added.join(", ")} (${reason})`);
    }
    return added.length > 0;
  }

  /** The `ramp.controls.resume` snapshot (and its validate: something must be halted). */
  async snapshot(): Promise<RampControlsSnapshot> {
    const row = await this.state();
    if (!row || !row.haltedScopes.length)
      throw new ApiError(409, "ramp_order_state", "nothing is halted");
    return {
      haltedScopes: [...row.haltedScopes].sort(),
      since: row.since?.toISOString() ?? null,
      source: row.source,
      failingChecks: (row.failingChecks ?? []).map((f) => f.name).sort(),
    };
  }

  /** Executes an approved `ramp.controls.resume`: every scope lifted (a red check re-halts on its next run). */
  async resume(
    actor: Actor,
    ctx: { approvalId: string | null; reason: string },
  ): Promise<ApiRampControls> {
    const before = await this.state();
    await this.rows.upsert(
      {
        key: KEY,
        haltedScopes: [],
        reason: null,
        source: null,
        failingChecks: null,
        since: null,
        setByUserId: actor.userId ?? null,
      },
      ["key"],
    );
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "ramp.controls.resumed",
      subjectType: "ramp_controls",
      subjectId: KEY,
      metadata: {
        approvalId: ctx.approvalId,
        reason: ctx.reason,
        lifted: before?.haltedScopes ?? [],
        failingChecks: (before?.failingChecks ?? []).map((f) => f.name),
      },
      ip: actor.ip ?? null,
    });
    this.sentry.captureMessage("ramp halts lifted (four-eyes resume)", "warning", {
      component: "ramp-controls",
    });
    return this.controls();
  }

  /** Union the scopes into the one row under a row lock (two halts at once both stick). */
  private async merge(
    scopes: HaltScope[],
    set: {
      reason: string;
      source: "admin" | "auto";
      userId: string | null;
      failing?: StoredFailingCheck[];
    },
  ): Promise<RampControlEntity> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO to_ramp_controls (key, halted_scopes) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING`,
        [KEY],
      );
      const current = await manager
        .getRepository(RampControlEntity)
        .createQueryBuilder("c")
        .setLock("pessimistic_write")
        .where("c.key = :key", { key: KEY })
        .getOneOrFail();
      const wasHalted = current.haltedScopes.length > 0;
      const failing = new Map((current.failingChecks ?? []).map((f) => [f.name, f]));
      for (const f of set.failing ?? []) failing.set(f.name, f);
      await manager.getRepository(RampControlEntity).update(
        { key: KEY },
        {
          haltedScopes: ALL_SCOPES.filter(
            (s) => scopes.includes(s) || current.haltedScopes.includes(s),
          ),
          reason: set.reason.slice(0, 500),
          source: set.source,
          failingChecks: failing.size ? [...failing.values()] : null,
          since: wasHalted && current.since ? current.since : new Date(),
          setByUserId: set.userId,
        },
      );
      return manager.getRepository(RampControlEntity).findOneByOrFail({ key: KEY });
    });
  }
}

function toApi(row: RampControlEntity | null): ApiRampControls {
  const halted = row?.haltedScopes ?? [];
  return {
    haltedScopes: [...halted],
    reason: halted.length ? (row?.reason ?? null) : null,
    source: halted.length ? (row?.source ?? null) : null,
    failingChecks: halted.length && row?.failingChecks ? row.failingChecks : null,
    since: halted.length ? (row?.since?.toISOString() ?? null) : null,
    setByUserId: row?.setByUserId ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}
