import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, In, Repository } from "typeorm";

import { Config } from "../config";
import { InstrumentEntity } from "../entities/instrument.entity";
import { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import {
  TOKEN_COMMAND_DEFINITIVE_NO,
  TokenCommandEntity,
  type TokenCommandKind,
  type TokenCommandSource,
  type TokenCommandStatus,
} from "../entities/token-command.entity";
import type { Actor, InstrumentId } from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, parseAmount, quantizeDown } from "../util/money";
import { AuditService } from "./audit.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { TokenAppService } from "./token-app.service";
import { TokenAppSyncService } from "./token-app-sync.service";
import {
  abandonRefusals,
  adoptionSet,
  type CapCheck,
  compensationCommandId,
  compensationIds,
  compensationPlan,
  compensationsSoFar,
  inGenerations,
  MAX_COMPENSATIONS,
  evaluateCaps,
  intentConflicts,
  legacyCommandId,
  mayHaveLanded,
  netOf,
  resendRefusal,
  statusAfterPost,
} from "./token-commands.logic";

const DAY_MS = 24 * 3_600_000;
/** Crash ceiling of `lock:token-command:<id>`: two 60 s POSTs, two bearer mints, the DB writes. */
const COMMAND_LOCK_TTL_MS = 3 * 60_000;

/** What a caller wants minted or burned; `amount` in 1e-10 units, whole at the instrument's decimals. */
export interface TokenCommandIntent {
  commandId: string;
  kind: TokenCommandKind;
  instrument: InstrumentId;
  party: string;
  amount: bigint;
  source: TokenCommandSource;
  ref?: string | null;
}

/** Who runs an operator action and under which approval (S4 passes the four-eyes approval's id). */
export interface TokenActionContext {
  actor: Actor;
  approvalId?: string | null;
  reason?: string | null;
}

/** Filter of `sumCommands`; every field narrows. */
export interface TokenCommandSumFilter {
  instrument: InstrumentId;
  kind?: TokenCommandKind;
  statuses?: readonly TokenCommandStatus[];
  /** Default when `statuses` is unset: every status except definitive-no. */
  sources?: readonly TokenCommandSource[];
  excludeSources?: readonly TokenCommandSource[];
  createdAfter?: Date;
  excludeCommandId?: string;
}

/** The would-be `token.records.adopt` set: what an approval snapshots and `tokenapp:check` prints. */
export interface TokenAdoptionPlan {
  before: Date;
  records: TokenAppRecordEntity[];
  net: bigint;
  /** sha256 over the sorted legacy ids — equal digests = the same set. */
  digest: string;
}

/**
 * The token-app command ledger (docs/RAMP.md §7): every mint / burn is a `to_token_commands`
 * row written BEFORE it is sent (`recordIntent`, inside the caller's transaction), sent once
 * (`submit`), and settled by the token sync's matching. Nothing re-sends on its own: a command
 * that may have landed is re-sent, abandoned or compensated only by an operator action
 * (`resend` / `abandon` / `compensate` / `adoptLegacy`, wrapped by S4 in four-eyes approvals);
 * each re-validates its preconditions with fresh reads under `lock:token-command:<id>`.
 *
 * Classes: UNRESOLVED = pending | submitted | unknown ("may land"), DEFINITIVE-NO = rejected |
 * abandoned ("never lands"); recorded; mismatch (red until compensated).
 */
@Injectable()
export class TokenCommandService {
  private readonly logger = new Logger(TokenCommandService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(TokenCommandEntity)
    private readonly commands: Repository<TokenCommandEntity>,
    @InjectRepository(TokenAppRecordEntity)
    private readonly records: Repository<TokenAppRecordEntity>,
    private readonly tokenApp: TokenAppService,
    private readonly sync: TokenAppSyncService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly sentry: SentryService,
  ) {}

  // ───────────────────────────────────────────── intent + submit ─────────────────────────────────────

  /**
   * Insert the command `pending` inside the caller's transaction (the order CAS, #8). The same id
   * with identical fields returns the existing row (a retried CAS); different fields →
   * `409 token_command_conflict`. `404 instrument_unknown`; `400 validation_failed` for an amount
   * that is not positive and whole at the instrument's decimals; on mainnet the ramp instrument is
   * minted only to and burned only from the treasury (`403 forbidden`).
   */
  async recordIntent(
    manager: EntityManager,
    intent: TokenCommandIntent,
  ): Promise<TokenCommandEntity> {
    const instrument = await manager
      .getRepository(InstrumentEntity)
      .findOneBy({ admin: intent.instrument.admin, id: intent.instrument.id });
    if (!instrument)
      throw new ApiError(
        404,
        "instrument_unknown",
        `instrument ${intent.instrument.id} is not registered`,
      );
    if (intent.amount <= 0n || quantizeDown(intent.amount, instrument.decimals) !== intent.amount)
      throw new ApiError(
        400,
        "validation_failed",
        `a ${instrument.symbol} command amount must be positive and whole at ${instrument.decimals} decimals`,
      );
    await this.assertTreasuryRule(intent.kind, intent.instrument, intent.party, manager);
    const fields = {
      kind: intent.kind,
      instrumentAdmin: intent.instrument.admin,
      instrumentId: intent.instrument.id,
      partyId: intent.party,
      amount: intent.amount,
      source: intent.source,
      ref: intent.ref ?? null,
    };
    await manager.query(
      `INSERT INTO to_token_commands (command_id, kind, instrument_admin, instrument_id, party_id, amount, source, ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (command_id) DO NOTHING`,
      [
        intent.commandId,
        fields.kind,
        fields.instrumentAdmin,
        fields.instrumentId,
        fields.partyId,
        formatAmount(fields.amount),
        fields.source,
        fields.ref,
      ],
    );
    const row = await manager
      .getRepository(TokenCommandEntity)
      .findOneByOrFail({ commandId: intent.commandId });
    const diff = intentConflicts(row, fields);
    if (diff.length > 0)
      throw new ApiError(
        409,
        "token_command_conflict",
        `command ${intent.commandId} was recorded with another ${diff.join(", ")}`,
        { commandId: intent.commandId, fields: diff },
      );
    return row;
  }

  /**
   * POST a never-sent `pending` command (0 attempts) and record the outcome: 2xx → submitted;
   * timeout / 5xx / network → unknown; a definitive 401 / 403 / 422 → rejected; nothing sent
   * (unconfigured, no bearer) → stays pending with `last_error`, safe to submit again. Caps that
   * trip now mark it rejected (`token_app_cap`). Any other row is returned unchanged: nothing
   * re-sends on its own.
   */
  async submit(commandId: string): Promise<TokenCommandEntity> {
    return this.withCommandLock(commandId, async () => {
      const row = await this.require(commandId);
      if (row.status !== "pending" || row.attempts !== 0) return row;
      return this.post(row, false);
    });
  }

  /** The row (null = unknown id). */
  status(commandId: string): Promise<TokenCommandEntity | null> {
    return this.commands.findOneBy({ commandId });
  }

  /**
   * `TOKEN_APP_MAX_PER_CALL` (mints and burns) and `TOKEN_APP_MAX_PER_DAY` (rolling 24 h Σ of the
   * instrument's mints of every source but legacy, statuses except definitive-no). S4's reserve
   * gate calls it before the order CAS.
   */
  async checkCaps(
    kind: TokenCommandKind,
    instrument: InstrumentId,
    amount: bigint,
    opts: { excludeCommandId?: string; manager?: EntityManager } = {},
  ): Promise<CapCheck> {
    const { maxPerCall, maxPerDay } = this.config.tokenCommands;
    const usedToday =
      kind === "mint" && maxPerDay !== null
        ? await this.sumCommands(
            {
              instrument,
              kind: "mint",
              excludeSources: ["legacy"],
              createdAfter: new Date(Date.now() - DAY_MS),
              excludeCommandId: opts.excludeCommandId,
            },
            opts.manager,
          )
        : 0n;
    return evaluateCaps({ kind, amount, maxPerCall, maxPerDay, usedToday });
  }

  /** `checkCaps`, as a `409 token_app_cap` refusal. */
  async requireCaps(
    kind: TokenCommandKind,
    instrument: InstrumentId,
    amount: bigint,
  ): Promise<void> {
    const cap = await this.checkCaps(kind, instrument, amount);
    if (!cap.ok) throw capError(cap);
  }

  /** Σ `amount` of the matching rows (unsigned). */
  async sumCommands(filter: TokenCommandSumFilter, manager?: EntityManager): Promise<bigint> {
    const qb = (manager ?? this.dataSource.manager)
      .getRepository(TokenCommandEntity)
      .createQueryBuilder("c")
      .select("COALESCE(SUM(c.amount), 0)::text", "total")
      .where("c.instrument_admin = :admin AND c.instrument_id = :id", {
        admin: filter.instrument.admin,
        id: filter.instrument.id,
      });
    if (filter.kind) qb.andWhere("c.kind = :kind", { kind: filter.kind });
    if (filter.statuses)
      qb.andWhere("c.status IN (:...statuses)", { statuses: [...filter.statuses] });
    else qb.andWhere("c.status NOT IN (:...no)", { no: [...TOKEN_COMMAND_DEFINITIVE_NO] });
    if (filter.sources) qb.andWhere("c.source IN (:...sources)", { sources: [...filter.sources] });
    if (filter.excludeSources?.length)
      qb.andWhere("c.source NOT IN (:...excluded)", { excluded: [...filter.excludeSources] });
    if (filter.createdAfter) qb.andWhere("c.created_at > :after", { after: filter.createdAfter });
    if (filter.excludeCommandId)
      qb.andWhere("c.command_id <> :exclude", { exclude: filter.excludeCommandId });
    const row = await qb.getRawOne<{ total: string }>();
    return parseAmount(row?.total ?? "0");
  }

  /**
   * Net issuance token-app recorded under our command ids: Σ ± `recorded_amount` of `recorded`
   * and `mismatch` rows (a mismatch's recorded amount is what actually landed), optionally by
   * source and up to a record time (S4: `issuance_matches_liability`, `supply_matches_issuance`).
   */
  async recordedNet(
    instrument: InstrumentId,
    opts: { sources?: readonly TokenCommandSource[]; recordedAtOrBefore?: Date } = {},
  ): Promise<bigint> {
    const qb = this.commands
      .createQueryBuilder("c")
      .select(
        "COALESCE(SUM(CASE WHEN c.kind = 'mint' THEN c.recorded_amount ELSE -c.recorded_amount END), 0)::text",
        "net",
      )
      .where("c.instrument_admin = :admin AND c.instrument_id = :id", {
        admin: instrument.admin,
        id: instrument.id,
      })
      .andWhere("c.status IN ('recorded', 'mismatch') AND c.recorded_amount IS NOT NULL");
    if (opts.sources) qb.andWhere("c.source IN (:...sources)", { sources: [...opts.sources] });
    if (opts.recordedAtOrBefore)
      qb.andWhere("c.recorded_at <= :before", { before: opts.recordedAtOrBefore });
    const row = await qb.getRawOne<{ net: string }>();
    return parseAmount(row?.net ?? "0");
  }

  // ───────────────────────────────────────────── operator actions ─────────────────────────────────────

  /**
   * `token.command.resend`: re-POST the same id with the identical body. Allowed for an
   * unresolved or rejected command while a FRESH re-page of the instrument shows no record of it,
   * and only while its last POST is younger than `TOKEN_APP_RESEND_MAX_AGE_HOURS` (inside the
   * participant's dedup window). Restarts the confirm timer (`last_post_at`).
   */
  async resend(commandId: string, ctx: TokenActionContext): Promise<TokenCommandEntity> {
    return this.withCommandLock(commandId, async () => {
      const row = await this.validateResend(commandId);
      const fresh = await this.post(row, true);
      await this.auditAction("token.command.resent", fresh, ctx, {
        before: row.status,
        attempts: fresh.attempts,
        httpStatus: fresh.lastHttpStatus,
      });
      return fresh;
    });
  }

  /** The resend preconditions with fresh reads (S4's approval `validate`); throws `409 token_command_state`. */
  async validateResend(commandId: string): Promise<TokenCommandEntity> {
    const row = await this.require(commandId);
    await this.sync.repageInstrument(row.instrumentId);
    const refusal = resendRefusal(row, {
      now: new Date(),
      mirrorHasRecord: await this.mirrorHas(row),
      maxAgeHours: this.config.tokenCommands.resendMaxAgeHours,
    });
    if (refusal)
      throw new ApiError(409, "token_command_state", `cannot re-send ${commandId}: ${refusal}`, {
        commandId,
        status: row.status,
      });
    return row;
  }

  /**
   * `token.command.abandon` → `abandoned` ("never lands"), iff every precondition of
   * `abandonRefusals` holds now; `expectedTreasuryHoldings` is the approval's statement of what
   * the treasury holds of the instrument if the command never landed (1e-10 units).
   */
  async abandon(
    commandId: string,
    params: { expectedTreasuryHoldings: bigint },
    ctx: TokenActionContext,
  ): Promise<TokenCommandEntity> {
    return this.withCommandLock(commandId, async () => {
      const row = await this.validateAbandon(commandId, params);
      const res = await this.commands
        .createQueryBuilder()
        .update(TokenCommandEntity)
        .set({
          status: "abandoned",
          lastError: `abandoned${ctx.approvalId ? ` (approval ${ctx.approvalId})` : ""} after ${row.attempts} POST(s); never recorded`,
        })
        .where("command_id = :id AND status = :status AND attempts = :attempts", {
          id: commandId,
          status: row.status,
          attempts: row.attempts,
        })
        .execute();
      if (!res.affected)
        throw new ApiError(409, "token_command_state", `command ${commandId} changed meanwhile`);
      const fresh = await this.require(commandId);
      await this.auditAction("token.command.abandoned", fresh, ctx, {
        before: row.status,
        lastPostAt: row.lastPostAt?.toISOString() ?? null,
        expectedTreasuryHoldings: formatAmount(params.expectedTreasuryHoldings),
      });
      return fresh;
    });
  }

  /** The abandon preconditions with fresh reads; throws `409 token_command_state` listing every unmet one. */
  async validateAbandon(
    commandId: string,
    params: { expectedTreasuryHoldings: bigint },
  ): Promise<TokenCommandEntity> {
    const row = await this.require(commandId);
    const instrument = await this.instrumentRow(row.instrumentAdmin, row.instrumentId);
    const monitorLastSuccessAt = await this.tokenApp
      .monitor(row.instrumentId, instrument.decimals)
      .then((m) => m.monitor.lastSuccessAt)
      .catch(() => null);
    const refusals = abandonRefusals(row, {
      now: new Date(),
      mirrorHasRecord: await this.mirrorHas(row),
      repages: await this.sync.repageHistory(row.instrumentId),
      monitorLastSuccessAt,
      indexedTreasuryHoldings: await this.indexedTreasuryHoldings({
        admin: row.instrumentAdmin,
        id: row.instrumentId,
      }),
      expectedTreasuryHoldings: params.expectedTreasuryHoldings,
    });
    if (refusals.length > 0)
      throw new ApiError(
        409,
        "token_command_state",
        `cannot abandon ${commandId}: ${refusals.join("; ")}`,
        { commandId, refusals },
      );
    return row;
  }

  /**
   * `token.command.compensate` of a `mismatch`: a NEW command (same source and ref, the original
   * party) that restores the expected net — `compensationPlan`; the mismatched row keeps its
   * status and gets `resolved_by` (the compensating id, or the approval when the net is already
   * right). `expectedNet` overrides the default expectation (S4, after the order's outcome).
   */
  async compensate(
    commandId: string,
    ctx: TokenActionContext,
    opts: { expectedNet?: bigint } = {},
  ): Promise<{ original: TokenCommandEntity; compensation: TokenCommandEntity | null }> {
    return this.withCommandLock(commandId, async () => {
      const { row, plan, generation } = await this.planCompensation(commandId, opts.expectedNet);
      const compId = plan.kind ? compensationCommandId(commandId, generation) : null;
      await this.dataSource.transaction(async (manager) => {
        if (compId && plan.kind)
          await this.recordIntent(manager, {
            commandId: compId,
            kind: plan.kind,
            instrument: { admin: row.instrumentAdmin, id: row.instrumentId },
            party: row.partyId,
            amount: plan.amount,
            source: row.source,
            ref: row.ref,
          });
        const res = await manager
          .createQueryBuilder()
          .update(TokenCommandEntity)
          .set({
            resolvedBy: compId ?? ctx.approvalId ?? `actor:${ctx.actor.userId ?? ctx.actor.type}`,
          })
          .where("command_id = :id AND status = 'mismatch' AND resolved_by IS NULL", {
            id: commandId,
          })
          .execute();
        if (!res.affected)
          throw new ApiError(409, "token_command_state", `command ${commandId} changed meanwhile`);
      });
      const compensation = compId ? await this.submit(compId) : null;
      const original = await this.require(commandId);
      await this.auditAction("token.command.compensated", original, ctx, {
        compensation: compId,
        compensationStatus: compensation?.status ?? null,
        kind: plan.kind,
        amount: formatAmount(plan.amount),
        expectedNet: formatAmount(plan.expectedNet),
        actualNet: formatAmount(plan.actualNet),
        compensatedNet: formatAmount(plan.compensatedNet),
        generation,
      });
      return { original, compensation };
    });
  }

  /**
   * The compensation a mismatch needs (S4's `describe` / `validate`); `409 token_command_state`
   * unless it is an unresolved mismatch whose earlier compensations all settled. `generation` =
   * the one a compensating command now takes (C21: a mismatch re-opened by a later record counts
   * what the earlier generations recorded).
   */
  async planCompensation(
    commandId: string,
    expectedNet?: bigint,
  ): Promise<{
    row: TokenCommandEntity;
    plan: ReturnType<typeof compensationPlan>;
    generation: number;
  }> {
    const row = await this.require(commandId);
    if (row.status !== "mismatch")
      throw new ApiError(
        409,
        "token_command_state",
        `command ${commandId} is ${row.status}, not mismatch`,
      );
    if (row.resolvedBy)
      throw new ApiError(
        409,
        "token_command_state",
        `command ${commandId} is already resolved by ${row.resolvedBy}`,
      );
    const records = await this.records.findBy({
      kind: row.kind,
      commandId: row.commandId,
      instrumentId: row.instrumentId,
    });
    const earlier = await this.compensationsOf(commandId);
    const so = compensationsSoFar(earlier);
    if (so.unsettled.length)
      throw new ApiError(
        409,
        "token_command_state",
        `an earlier compensation of ${commandId} is not settled (${so.unsettled.join(", ")})`,
        { unsettled: so.unsettled },
      );
    if (earlier.length >= MAX_COMPENSATIONS)
      throw new ApiError(
        409,
        "token_command_state",
        `${commandId} was compensated ${earlier.length} times already; an engineer must look`,
      );
    return {
      row,
      plan: compensationPlan(row, records, expectedNet, so.net),
      generation: earlier.length + 1,
    };
  }

  /** The compensating commands of `original`, generation 1 onwards. */
  async compensationsOf(original: string): Promise<TokenCommandEntity[]> {
    const rows = await this.commands.findBy({ commandId: In(compensationIds(original)) });
    return inGenerations(original, rows);
  }

  /**
   * `token.records.adopt {before}` (#14): write `legacy` rows (recorded, ref
   * `adopted:<approval>`) for every mirrored record created before `before` that no row accounts
   * for — the history of a recreated database, earlier check round trips. `before` may not be in
   * the future nor after this database's first own command, so a record of ours-to-be (or an
   * attacker's mint after go-live) can never be adopted.
   */
  async adoptLegacy(
    params: { before: Date; instrumentId?: string; digest?: string },
    ctx: TokenActionContext,
  ): Promise<{ adopted: TokenCommandEntity[]; plan: TokenAdoptionPlan }> {
    const plan = await this.planAdoption(params.before, params.instrumentId);
    if (params.digest && params.digest !== plan.digest)
      throw new ApiError(
        409,
        "token_command_state",
        "the adoption set changed since it was approved",
        {
          expected: params.digest,
          actual: plan.digest,
        },
      );
    const admins = new Map<string, string>();
    for (const r of plan.records)
      if (!admins.has(r.instrumentId))
        admins.set(r.instrumentId, await this.adminOf(r.instrumentId));
    const ref = `adopted:${ctx.approvalId ?? "manual"}`;
    const ids = await this.dataSource.transaction(async (manager) => {
      const out: string[] = [];
      for (const r of plan.records) {
        const id = legacyCommandId(r);
        await manager.query(
          `INSERT INTO to_token_commands (command_id, kind, instrument_admin, instrument_id, party_id, amount, source, ref, status, update_id, recorded_amount, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'legacy', $7, 'recorded', $8, $6, $9) ON CONFLICT (command_id) DO NOTHING`,
          [
            id,
            r.kind,
            admins.get(r.instrumentId),
            r.instrumentId,
            r.partyId,
            formatAmount(r.amount),
            ref,
            r.updateId,
            r.recordCreatedAt,
          ],
        );
        out.push(id);
      }
      return out;
    });
    const adopted = ids.length
      ? await this.commands.findBy(ids.map((commandId) => ({ commandId })))
      : [];
    await this.audit.record({
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId ?? null,
      actorSessionId: ctx.actor.sessionId ?? null,
      action: "token.records.adopted",
      subjectType: "token_records",
      subjectId: params.instrumentId ?? "*",
      metadata: {
        approvalId: ctx.approvalId ?? null,
        reason: ctx.reason ?? null,
        before: params.before.toISOString(),
        count: adopted.length,
        net: formatAmount(plan.net),
        digest: plan.digest,
      },
      ip: ctx.actor.ip ?? null,
    });
    return { adopted, plan };
  }

  /** The adoption set for `before` (refused when the cutoff is in the future or after this database's first own command). */
  async planAdoption(before: Date, instrumentId?: string): Promise<TokenAdoptionPlan> {
    if (Number.isNaN(before.getTime()) || before.getTime() > Date.now())
      throw new ApiError(400, "validation_failed", "`before` must be a past timestamp");
    const first = await this.commands
      .createQueryBuilder("c")
      .select("MIN(c.created_at)", "first")
      .where("c.source <> 'legacy'")
      .getRawOne<{ first: Date | string | null }>();
    if (first?.first && before.getTime() > new Date(first.first).getTime())
      throw new ApiError(
        400,
        "validation_failed",
        `\`before\` must not be after this database's first own command (${new Date(first.first).toISOString()})`,
      );
    const where = instrumentId ? { instrumentId } : {};
    const [commands, mirror] = await Promise.all([
      this.commands.findBy(where),
      this.records.find({ where, order: { id: "ASC" } }),
    ]);
    // Matching is per instrument: a record never belongs to another instrument's row.
    const records: TokenAppRecordEntity[] = [];
    for (const id of new Set(mirror.map((r) => r.instrumentId)))
      records.push(
        ...adoptionSet(
          commands.filter((c) => c.instrumentId === id),
          mirror.filter((r) => r.instrumentId === id),
          before,
        ),
      );
    const digest = createHash("sha256")
      .update(records.map(legacyCommandId).sort().join(","))
      .digest("hex");
    return { before, records, net: netOf(records), digest };
  }

  // ───────────────────────────────────────────── internals ─────────────────────────────────────────────

  /**
   * One POST under the row's id. Caps and the mainnet treasury rule first (a first send that
   * fails them is `rejected`; a re-send is refused and the row left alone); then the write-ahead
   * (`attempts + 1`, `last_post_at`), the call, and the outcome — every UPDATE a CAS on the
   * status and attempt count, so a record the sync matched meanwhile is never overwritten.
   */
  private async post(row: TokenCommandEntity, resend: boolean): Promise<TokenCommandEntity> {
    const instrument = await this.instrumentRow(row.instrumentAdmin, row.instrumentId);
    const ref = { admin: row.instrumentAdmin, id: row.instrumentId };
    const before = row.status;
    const attemptsBefore = row.attempts;
    const cas = (q: { where: (s: string, p: object) => unknown }): void => {
      q.where("command_id = :id AND status = :status AND attempts = :attempts", {
        id: row.commandId,
        status: before,
        attempts: attemptsBefore,
      });
    };

    const cap = await this.checkCaps(row.kind, ref, row.amount, {
      excludeCommandId: row.commandId,
    });
    let refusal: ApiError | null = cap.ok ? null : capError(cap);
    if (!refusal) {
      try {
        await this.assertTreasuryRule(row.kind, ref, row.partyId);
      } catch (err) {
        refusal = err as ApiError;
      }
    }
    if (refusal) {
      if (resend || mayHaveLanded(before, attemptsBefore)) throw refusal;
      const q = this.commands
        .createQueryBuilder()
        .update(TokenCommandEntity)
        .set({
          status: "rejected",
          lastError: `${refusal.code}: ${refusal.message}`.slice(0, 800),
        });
      cas(q);
      await q.execute();
      return this.require(row.commandId);
    }

    const prevLastPost = row.lastPostAt;
    const ahead = this.commands
      .createQueryBuilder()
      .update(TokenCommandEntity)
      .set({ attempts: () => "attempts + 1", lastPostAt: () => "now()" });
    cas(ahead);
    if (!(await ahead.execute()).affected)
      throw new ApiError(409, "token_command_state", `command ${row.commandId} changed meanwhile`);

    const res = await this.tokenApp.postCommand(row.kind, {
      commandId: row.commandId,
      instrumentId: row.instrumentId,
      partyId: row.partyId,
      amount: row.amount,
      decimals: instrument.decimals,
    });
    const error =
      res.outcome === "accepted"
        ? null
        : `${res.code ?? "error"}: ${res.message ?? ""}`.slice(0, 800);
    const after = {
      where: "command_id = :id AND status = :status AND attempts = :attempts",
      params: { id: row.commandId, status: before, attempts: attemptsBefore + 1 },
    };
    if (res.outcome === "not_sent") {
      // Nothing left this process: undo the write-ahead so the send stays a first send.
      await this.commands
        .createQueryBuilder()
        .update(TokenCommandEntity)
        .set({ attempts: () => "attempts - 1", lastPostAt: prevLastPost, lastError: error })
        .where(after.where, after.params)
        .execute();
      if (resend)
        throw new ApiError(
          res.code === "token_app_unconfigured" ? 503 : 502,
          res.code ?? "upstream_failed",
          res.message ?? "token-app not reached",
        );
      return this.require(row.commandId);
    }
    await this.commands
      .createQueryBuilder()
      .update(TokenCommandEntity)
      .set({
        status: statusAfterPost(before, attemptsBefore, res.outcome),
        lastHttpStatus: res.httpStatus || null,
        lastError: error,
      })
      .where(after.where, after.params)
      .execute();
    if (res.code === "token_app_unauthorized" || res.code === "token_app_forbidden") {
      // Credentials or scope broke: page (docs/RAMP.md §6.2).
      this.sentry.captureMessage(`token-app ${res.code} on ${row.kind} ${row.commandId}`, "error", {
        component: "token-app",
        page: "true",
      });
    }
    this.logger.log(
      `${row.kind} ${row.commandId} (${formatAmount(row.amount)} ${row.instrumentId}): ${res.outcome}${res.httpStatus ? ` HTTP ${res.httpStatus}` : ""}`,
    );
    return this.require(row.commandId);
  }

  /** One action per command at a time, across instances. */
  private async withCommandLock<T>(commandId: string, fn: () => Promise<T>): Promise<T> {
    const lock = await this.redis.acquireLock(
      `lock:token-command:${commandId}`,
      COMMAND_LOCK_TTL_MS,
    );
    if (!lock.acquired)
      throw new ApiError(
        409,
        "token_command_state",
        `another action on ${commandId} is in progress`,
      );
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  private async require(commandId: string): Promise<TokenCommandEntity> {
    const row = await this.commands.findOneBy({ commandId });
    if (!row) throw new ApiError(404, "not_found", `token command ${commandId} not found`);
    return row;
  }

  /** Mainnet: the ramp instrument is minted only to and burned only from the treasury (SPEC §7). */
  private async assertTreasuryRule(
    kind: TokenCommandKind,
    instrument: InstrumentId,
    party: string,
    manager?: EntityManager,
  ): Promise<void> {
    if (!this.config.isMainnet) return;
    const ramp = await this.sync.rampInstrument(manager);
    if (!ramp || ramp.admin !== instrument.admin || ramp.id !== instrument.id) return;
    if (!this.config.treasuryPartyId || party !== this.config.treasuryPartyId)
      throw new ApiError(
        403,
        "forbidden",
        `on mainnet ${instrument.id} is ${kind === "mint" ? "minted only to" : "burned only from"} the treasury`,
      );
  }

  private async mirrorHas(row: TokenCommandEntity): Promise<boolean> {
    return (
      (await this.records.countBy({
        kind: row.kind,
        commandId: row.commandId,
        instrumentId: row.instrumentId,
      })) > 0
    );
  }

  /** Σ of the treasury's active indexed holdings of the instrument; null without a treasury. */
  private async indexedTreasuryHoldings(instrument: InstrumentId): Promise<bigint | null> {
    if (!this.config.treasuryPartyId) return null;
    const [row] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ledger_holdings
        WHERE owner = $1 AND instrument_admin = $2 AND instrument_id = $3 AND archived_offset IS NULL`,
      [this.config.treasuryPartyId, instrument.admin, instrument.id],
    );
    return parseAmount(row.total);
  }

  private async instrumentRow(admin: string, id: string): Promise<InstrumentEntity> {
    const row = await this.dataSource.getRepository(InstrumentEntity).findOneBy({ admin, id });
    if (!row) throw new ApiError(404, "instrument_unknown", `instrument ${id} is not registered`);
    return row;
  }

  /** The instrument admin of a token id (records carry the id only): the ramp instrument's, else the one registered row. */
  private async adminOf(instrumentId: string): Promise<string> {
    const ramp = await this.sync.rampInstrument();
    if (ramp?.id === instrumentId) return ramp.admin;
    const rows = await this.dataSource.getRepository(InstrumentEntity).findBy({ id: instrumentId });
    if (rows.length !== 1)
      throw new ApiError(
        409,
        "token_command_state",
        `token id ${instrumentId} matches ${rows.length} registered instruments; adopt it per instrument`,
      );
    return rows[0].admin;
  }

  private async auditAction(
    action: "token.command.resent" | "token.command.abandoned" | "token.command.compensated",
    row: TokenCommandEntity,
    ctx: TokenActionContext,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId ?? null,
      actorSessionId: ctx.actor.sessionId ?? null,
      action,
      subjectType: "token_command",
      subjectId: row.commandId,
      metadata: {
        approvalId: ctx.approvalId ?? null,
        reason: ctx.reason ?? null,
        kind: row.kind,
        instrument: { admin: row.instrumentAdmin, id: row.instrumentId },
        party: row.partyId,
        amount: formatAmount(row.amount),
        status: row.status,
        ...extra,
      },
      ip: ctx.actor.ip ?? null,
    });
  }
}

/** `409 token_app_cap` naming the cap that tripped. */
export function capError(cap: Exclude<CapCheck, { ok: true }>): ApiError {
  const name = cap.reason === "per_call" ? "TOKEN_APP_MAX_PER_CALL" : "TOKEN_APP_MAX_PER_DAY";
  return new ApiError(
    409,
    "token_app_cap",
    `token-app cap ${name} (${formatAmount(cap.limit)}) would be exceeded${cap.reason === "per_day" ? ` (rolling 24 h: ${formatAmount(cap.used)})` : ""}`,
    { cap: name, limit: formatAmount(cap.limit), used: formatAmount(cap.used) },
  );
}
