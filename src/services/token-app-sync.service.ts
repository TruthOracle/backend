import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, In, Repository } from "typeorm";

import { Config } from "../config";
import { InstrumentEntity } from "../entities/instrument.entity";
import { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import {
  isUnresolved,
  TOKEN_COMMAND_UNRESOLVED,
  TokenCommandEntity,
  type TokenCommandKind,
  type TokenCommandSource,
  type TokenCommandStatus,
} from "../entities/token-command.entity";
import type { InstrumentId } from "../types";
import { formatAmount } from "../util/money";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { TokenAppService, type TokenAppParsedRecord } from "./token-app.service";
import {
  ABANDON_REPAGE_MAX_AGE_MS,
  matchCommands,
  mismatchError,
  netOf,
} from "./token-commands.logic";

/**
 * Called inside ONE transaction per newly recorded command, after its row became `recorded`
 * (same `manager`): S2 posts the journal and moves the order there (#9). A throw rolls the whole
 * transaction back — the command stays unresolved and the next pass tries again.
 */
export type TokenRecordedHook = (
  manager: EntityManager,
  command: TokenCommandEntity,
  record: TokenAppRecordEntity,
) => Promise<void>;

/** Called after every pass with its integrity result (S4: I9, auto-halt, X8). Errors are logged, never thrown. */
export type TokenPassHook = (result: TokenSyncPassResult) => Promise<void> | void;

export interface TokenRecordView {
  kind: TokenCommandKind;
  commandId: string | null;
  updateId: string | null;
  instrumentId: string;
  partyId: string;
  amount: bigint;
  recordCreatedAt: Date | null;
}

export interface TokenCommandView {
  commandId: string;
  kind: TokenCommandKind;
  instrument: InstrumentId;
  partyId: string;
  amount: bigint;
  source: TokenCommandSource;
  ref: string | null;
  status: TokenCommandStatus;
  attempts: number;
  lastPostAt: Date | null;
  recordedAmount: bigint | null;
  lastError: string | null;
  resolvedBy: string | null;
}

/** One instrument's integrity after a pass (amounts in 1e-10 units). */
export interface TokenSyncInstrumentResult {
  instrumentId: string;
  /** null when no command row / config names its admin. */
  instrument: InstrumentId | null;
  decimals: number;
  /** Paged in full and every match applied. */
  complete: boolean;
  error: string | null;
  /** Mirror records with no command row (I9 for the ramp instrument). */
  unknownRecords: TokenRecordView[];
  /** Every `mismatch` row (resolved ones carry `resolvedBy`). */
  mismatches: TokenCommandView[];
  /** Rows token-app recorded more than once. */
  duplicates: TokenCommandView[];
  unresolved: TokenCommandView[];
  newlyRecorded: string[];
  newlyMismatched: string[];
  /** Σ ± recorded amount of our `recorded` + `mismatch` rows (every source). */
  ourNet: bigint;
  /** Σ mints − Σ burns of the mirror. */
  tokenAppNet: bigint;
  /** token-app `/status` `tokens.<id>.total_supply`; null when unreadable or not listed. */
  statusTotalSupply: bigint | null;
  statusUpdatedAt: Date | null;
  monitorAgeSec: number | null;
  monitorError: string | null;
}

/**
 * What `onPass` receives (SPEC §7): the top-level fields are the RAMP instrument's (I9 is about
 * it; empty / null without one), `instruments` has every synced instrument.
 */
export interface TokenSyncPassResult {
  trigger: string;
  startedAt: Date;
  finishedAt: Date;
  /**
   * token-app configured and the RAMP instrument paged in full with every match applied: what the
   * payout gate and the ramp's token checks read. Another instrument's failure (a client not
   * scoped to it, a 403, a corrupt amount) must not close the ramp's gate or halt it (C16); it is
   * in `allComplete` / `instruments` and the report-only `token_sync_other_instruments` check.
   */
  complete: boolean;
  /** The ramp instrument's error ("token-app is not configured" when it is not). */
  error: string | null;
  /** token-app configured and EVERY instrument paged in full, every match applied. */
  allComplete: boolean;
  rampInstrument: InstrumentId | null;
  unknownRecords: TokenRecordView[];
  mismatches: TokenCommandView[];
  duplicates: TokenCommandView[];
  unresolved: TokenCommandView[];
  ourNet: bigint | null;
  tokenAppNet: bigint | null;
  statusTotalSupply: bigint | null;
  statusUpdatedAt: Date | null;
  monitorAgeSec: number | null;
  instruments: TokenSyncInstrumentResult[];
}

/** One instrument's line of the summary. */
export interface TokenSyncInstrumentSummary {
  instrumentId: string;
  complete: boolean;
  error: string | null;
}

/** The last pass, as kept in Redis for every instance (S4's payout gate reads `unknownRecords`). */
export interface TokenSyncSummary {
  trigger: string;
  startedAt: string;
  finishedAt: string;
  /** The ramp instrument's, as in TokenSyncPassResult (C16). */
  complete: boolean;
  error: string | null;
  allComplete: boolean;
  /** Every synced instrument (absent in a summary written before C16: read as []). */
  instruments: TokenSyncInstrumentSummary[];
  rampInstrument: InstrumentId | null;
  unknownRecords: number;
  mismatches: number;
  unresolvedMismatches: number;
  duplicates: number;
  unresolved: number;
  ourNet: string | null;
  tokenAppNet: string | null;
}

const LAST_PASS_KEY = "token-sync:last-pass";
const LAST_PASS_TTL_MS = 7 * 24 * 3_600_000;
const REPAGES_TTL_MS = 2 * 24 * 3_600_000;
const REPAGES_KEPT = 10;
const MIRROR_CHUNK = 1000;
/** Past this a pass is near the re-page age abandon accepts (ABANDON_REPAGE_MAX_AGE_MS): warn, hourly (C42). */
const LONG_PASS_MS = ABANDON_REPAGE_MAX_AGE_MS / 2;
const LONG_PASS_ALERT_EVERY_MS = 3_600_000;

/** `syncOnce` stopped because its caller lost the lock: nothing remembered, no pass hooks (C42). */
export class TokenSyncAbortedError extends Error {
  constructor(message = "the token sync lock was lost mid-pass") {
    super(message);
    this.name = "TokenSyncAbortedError";
  }
}

/**
 * The token-app mirror and integrity pass (docs/RAMP.md §7). Each pass pages every record of
 * every token-app-managed instrument (the ramp instrument plus every instrument with a command
 * row) — `/data/admin/mints|burns?instrument_id=<id>&limit=1000&offset=…`, no party filter, until
 * a short page — upserts the mirror, then matches rows to records: an unresolved row with exactly
 * one record of its party and amount becomes `recorded` (with the `onRecorded` hooks in the same
 * transaction), anything else that has records becomes `mismatch`. Finally the `onPass` hooks get
 * the integrity result. Nothing here sends a command. The processor drives it every
 * `TOKEN_APP_SYNC_SEC` while a command is unresolved, else every `RAMP_RECON_EVERY_MIN`.
 */
@Injectable()
export class TokenAppSyncService {
  private readonly logger = new Logger(TokenAppSyncService.name);
  private readonly recordedHooks: { name: string; fn: TokenRecordedHook }[] = [];
  private readonly passHooks: { name: string; fn: TokenPassHook }[] = [];

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(TokenCommandEntity)
    private readonly commands: Repository<TokenCommandEntity>,
    @InjectRepository(TokenAppRecordEntity)
    private readonly records: Repository<TokenAppRecordEntity>,
    private readonly tokenApp: TokenAppService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  /** Register a recorded-command hook (from the registering module's `onModuleInit`); returns its unregister. */
  onRecorded(fn: TokenRecordedHook, name = "anonymous"): () => void {
    const entry = { name, fn };
    this.recordedHooks.push(entry);
    return () => this.recordedHooks.splice(this.recordedHooks.indexOf(entry), 1);
  }

  /** Register a pass hook; returns its unregister. */
  onPass(fn: TokenPassHook, name = "anonymous"): () => void {
    const entry = { name, fn };
    this.passHooks.push(entry);
    return () => this.passHooks.splice(this.passHooks.indexOf(entry), 1);
  }

  /** The ramp's instrument: `RAMP_INSTRUMENT`, else the default collateral (the DB's, else the env's). */
  async rampInstrument(manager?: EntityManager): Promise<InstrumentId | null> {
    const ref = this.config.ramp.instrument;
    if (ref) return { admin: ref.admin, id: ref.id };
    const row = await (manager ?? this.dataSource.manager)
      .getRepository(InstrumentEntity)
      .findOneBy({ isDefaultCollateral: true });
    if (row) return { admin: row.admin, id: row.id };
    const c = this.config.collateralInstrument;
    return c.admin && c.id ? { admin: c.admin, id: c.id } : null;
  }

  /** Any command that may still land (the processor's fast cadence). */
  async hasUnresolved(): Promise<boolean> {
    return (await this.commands.countBy({ status: In([...TOKEN_COMMAND_UNRESOLVED]) })) > 0;
  }

  /** The last pass of any instance (null before the first, or after a Redis flush — fail closed). */
  async lastPassSummary(): Promise<TokenSyncSummary | null> {
    return this.redis.getJson<TokenSyncSummary>(LAST_PASS_KEY).catch(() => null);
  }

  /** Start times of the last complete full re-pages of an instrument, newest first (abandon's evidence). */
  async repageHistory(instrumentId: string): Promise<Date[]> {
    const raw = await this.redis
      .getJson<string[]>(`token-sync:repages:${instrumentId}`)
      .catch(() => null);
    return (raw ?? []).map((s) => new Date(s)).filter((d) => !Number.isNaN(d.getTime()));
  }

  /** Remember a complete full re-page that started at `at`. */
  async recordRepage(instrumentId: string, at: Date): Promise<void> {
    const before = await this.repageHistory(instrumentId);
    const kept = [at, ...before]
      .sort((a, b) => b.getTime() - a.getTime())
      .slice(0, REPAGES_KEPT)
      .map((d) => d.toISOString());
    await this.redis
      .setJson(`token-sync:repages:${instrumentId}`, kept, REPAGES_TTL_MS)
      .catch((err: Error) => this.logger.warn(`re-page history write failed: ${err.message}`));
  }

  /**
   * One full re-page of an instrument into the mirror (both kinds, every page); no matching.
   * Throws when token-app cannot be read or serves a record of another instrument.
   */
  async repageInstrument(instrumentId: string, decimals?: number): Promise<number> {
    const d = decimals ?? (await this.decimalsOf(instrumentId));
    const startedAt = new Date();
    const filter = { instrumentId };
    const fetched = [
      ...(await this.tokenApp.listRecords("mint", filter, d)),
      ...(await this.tokenApp.listRecords("burn", filter, d)),
    ];
    const stray = fetched.find((r) => r.instrumentId !== instrumentId);
    if (stray)
      throw new Error(
        `token-app answered a ${stray.instrumentId || "blank"} record for instrument_id=${instrumentId}`,
      );
    await this.upsertMirror(fetched);
    await this.recordRepage(instrumentId, startedAt);
    return fetched.length;
  }

  /**
   * One full pass over every token-app-managed instrument; never throws for upstream failures.
   * `stillHeld` (the processor's lock): checked before each instrument and before the pass is
   * remembered — once false the pass throws TokenSyncAbortedError instead (C42).
   */
  async syncOnce(
    trigger = "schedule",
    opts: { stillHeld?: () => boolean } = {},
  ): Promise<TokenSyncPassResult> {
    const held = (): void => {
      if (opts.stillHeld && !opts.stillHeld()) throw new TokenSyncAbortedError();
    };
    const startedAt = new Date();
    const ramp = await this.rampInstrument();
    const configured = this.tokenApp.isConfigured();
    const instruments: TokenSyncInstrumentResult[] = [];
    for (const target of await this.targets(ramp)) {
      held();
      // Only the ramp instrument's /status is read: nothing consumes another's, and its refusal
      // must not page as the backend's credential being refused (C16).
      instruments.push(
        await this.syncInstrument(target, configured, target.instrumentId === ramp?.id),
      );
    }
    held();
    const rampResult = ramp ? instruments.find((i) => i.instrumentId === ramp.id) : undefined;
    const result: TokenSyncPassResult = {
      trigger,
      startedAt,
      finishedAt: new Date(),
      // C16: the ramp instrument's own result, never another instrument's (see the field docs).
      complete: configured && (ramp ? rampResult?.complete === true : true),
      error: configured ? (rampResult?.error ?? null) : "token-app is not configured",
      allComplete: configured && instruments.every((i) => i.complete),
      rampInstrument: ramp,
      unknownRecords: rampResult?.unknownRecords ?? [],
      mismatches: rampResult?.mismatches ?? [],
      duplicates: rampResult?.duplicates ?? [],
      unresolved: rampResult?.unresolved ?? [],
      ourNet: rampResult?.ourNet ?? null,
      tokenAppNet: rampResult?.tokenAppNet ?? null,
      statusTotalSupply: rampResult?.statusTotalSupply ?? null,
      statusUpdatedAt: rampResult?.statusUpdatedAt ?? null,
      monitorAgeSec: rampResult?.monitorAgeSec ?? null,
      instruments,
    };
    await this.warnIfSlow(result);
    await this.remember(result);
    for (const hook of this.passHooks) {
      try {
        await hook.fn(result);
      } catch (err) {
        this.logger.error(`token sync pass hook ${hook.name} failed: ${(err as Error).message}`);
        this.sentry.captureException(err, { component: "token-sync", hook: hook.name });
      }
    }
    return result;
  }

  // ───────────────────────────────────────────── internals ─────────────────────────────────────────────

  /**
   * A pass this slow re-pages too slowly for abandon's evidence (re-pages ≤ ABANDON_REPAGE_MAX_AGE_MS
   * old) and loads the instance holding the lock: warn, at most hourly (C42).
   */
  private async warnIfSlow(r: TokenSyncPassResult): Promise<void> {
    const ms = r.finishedAt.getTime() - r.startedAt.getTime();
    if (ms <= LONG_PASS_MS) return;
    const first = await this.redis
      .claimOnce("alert:token-sync-slow", LONG_PASS_ALERT_EVERY_MS)
      .catch(() => true);
    if (!first) return;
    this.logger.warn(
      `token sync pass took ${Math.round(ms / 1000)} s (abandon needs re-pages under ${ABANDON_REPAGE_MAX_AGE_MS / 60_000} min)`,
    );
    this.sentry.captureMessage("token sync pass is slow", "warning", { component: "token-sync" });
  }

  /** The ramp instrument plus every instrument a command row names, one per token id (records carry no admin). */
  private async targets(
    ramp: InstrumentId | null,
  ): Promise<{ instrumentId: string; ref: InstrumentId | null }[]> {
    const byId = new Map<string, InstrumentId>();
    if (ramp) byId.set(ramp.id, ramp);
    const rows = await this.dataSource.query<{ instrument_admin: string; instrument_id: string }[]>(
      `SELECT DISTINCT instrument_admin, instrument_id FROM to_token_commands ORDER BY instrument_id, instrument_admin`,
    );
    for (const r of rows)
      if (!byId.has(r.instrument_id))
        byId.set(r.instrument_id, { admin: r.instrument_admin, id: r.instrument_id });
    return [...byId.entries()].map(([instrumentId, ref]) => ({ instrumentId, ref }));
  }

  private async decimalsOf(instrumentId: string, ref?: InstrumentId | null): Promise<number> {
    const repo = this.dataSource.getRepository(InstrumentEntity);
    const row = ref
      ? await repo.findOneBy({ admin: ref.admin, id: ref.id })
      : await repo.findOneBy({ id: instrumentId });
    if (!row) throw new Error(`instrument ${instrumentId} is not registered`);
    return row.decimals;
  }

  private async syncInstrument(
    target: { instrumentId: string; ref: InstrumentId | null },
    configured: boolean,
    readMonitor: boolean,
  ): Promise<TokenSyncInstrumentResult> {
    const id = target.instrumentId;
    const out: TokenSyncInstrumentResult = {
      instrumentId: id,
      instrument: target.ref,
      decimals: 0,
      complete: false,
      error: null,
      unknownRecords: [],
      mismatches: [],
      duplicates: [],
      unresolved: [],
      newlyRecorded: [],
      newlyMismatched: [],
      ourNet: 0n,
      tokenAppNet: 0n,
      statusTotalSupply: null,
      statusUpdatedAt: null,
      monitorAgeSec: null,
      monitorError: null,
    };
    let decimalsKnown = false;
    /** The rows the matching read, when the pass changes none of them (the views reuse them). */
    let unchanged: { commands: TokenCommandEntity[]; mirror: TokenAppRecordEntity[] } | null = null;
    try {
      out.decimals = await this.decimalsOf(id, target.ref);
      decimalsKnown = true;
      if (!configured) throw new Error("token-app is not configured");
      await this.repageInstrument(id, out.decimals);
      const loaded = {
        commands: await this.commands.findBy({ instrumentId: id }),
        mirror: await this.records.findBy({ instrumentId: id }),
      };
      const match = matchCommands(loaded.commands, loaded.mirror);
      // Nothing to apply (the steady state while a command waits): no second full load (C42).
      if (!match.toRecord.length && !match.toMismatch.length) unchanged = loaded;
      let applied = true;
      for (const { command, record } of match.toRecord) {
        if (await this.applyRecorded(command, record)) out.newlyRecorded.push(command.commandId);
        else applied = false;
      }
      for (const m of match.toMismatch) {
        const res = await this.commands
          .createQueryBuilder()
          .update(TokenCommandEntity)
          .set({
            status: "mismatch",
            // A new mismatch needs its own resolution, whatever closed the row before.
            resolvedBy: null,
            lastError: mismatchError(m.reason, m.detail),
            updateId: m.records[0].updateId,
            recordedAmount: m.records.reduce((s, r) => s + r.amount, 0n),
            recordedAt: m.records[0].recordCreatedAt ?? new Date(),
          })
          .where("command_id = :id AND status = :status", {
            id: m.command.commandId,
            status: m.command.status,
          })
          .execute();
        if (!res.affected) continue;
        out.newlyMismatched.push(m.command.commandId);
        this.logger.error(`token command ${m.command.commandId}: ${m.reason} (${m.detail})`);
        this.sentry.captureMessage(`token command mismatch: ${m.reason}`, "error", {
          component: "token-sync",
          commandId: m.command.commandId,
          page: "true",
        });
      }
      out.complete = applied;
      if (!applied) out.error = "a recorded-command hook failed; retried next pass";
    } catch (err) {
      out.error = (err as Error).message.slice(0, 500);
      this.logger.warn(`token sync of ${id} incomplete: ${out.error}`);
    }

    // The views come from the database as it stands now (also after a failed read): re-read
    // unless this pass changed nothing since the matching read it.
    const { commands, mirror } = unchanged ?? {
      commands: await this.commands.findBy({ instrumentId: id }),
      mirror: await this.records.findBy({ instrumentId: id }),
    };
    const after = matchCommands(commands, mirror);
    out.unknownRecords = after.unknownRecords.map(recordView);
    out.duplicates = after.duplicates.map(commandView);
    out.mismatches = commands.filter((c) => c.status === "mismatch").map(commandView);
    out.unresolved = commands.filter((c) => isUnresolved(c.status)).map(commandView);
    out.ourNet = netOf(
      commands
        .filter(
          (c) => (c.status === "recorded" || c.status === "mismatch") && c.recordedAmount !== null,
        )
        .map((c) => ({ kind: c.kind, amount: c.recordedAmount ?? 0n })),
    );
    out.tokenAppNet = netOf(mirror);
    if (configured && decimalsKnown && readMonitor) {
      try {
        const m = await this.tokenApp.monitor(id, out.decimals);
        out.statusTotalSupply = m.token?.totalSupply ?? null;
        out.statusUpdatedAt = m.token?.updatedAt ?? m.updatedAt;
        out.monitorAgeSec = m.monitor.ageSeconds;
      } catch (err) {
        out.monitorError = (err as Error).message.slice(0, 300);
      }
    }
    return out;
  }

  /** unresolved → recorded and the hooks, in ONE transaction; false when a hook failed (rolled back). */
  private async applyRecorded(
    command: TokenCommandEntity,
    record: TokenAppRecordEntity,
  ): Promise<boolean> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const res = await manager
          .createQueryBuilder()
          .update(TokenCommandEntity)
          .set({
            status: "recorded",
            updateId: record.updateId,
            recordedAmount: record.amount,
            recordedAt: record.recordCreatedAt ?? new Date(),
            lastError: null,
          })
          .where("command_id = :id AND status IN (:...from)", {
            id: command.commandId,
            from: [...TOKEN_COMMAND_UNRESOLVED],
          })
          .execute();
        if (!res.affected) return;
        const fresh = await manager
          .getRepository(TokenCommandEntity)
          .findOneByOrFail({ commandId: command.commandId });
        for (const hook of this.recordedHooks) await hook.fn(manager, fresh, record);
      });
      return true;
    } catch (err) {
      this.logger.error(
        `recording token command ${command.commandId} rolled back: ${(err as Error).message}`,
      );
      this.sentry.captureException(err, { component: "token-sync", commandId: command.commandId });
      return false;
    }
  }

  /** Insert what is new; the identity index (with coalesce) makes a re-read a no-op. */
  private async upsertMirror(records: TokenAppParsedRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += MIRROR_CHUNK) {
      const chunk = records.slice(i, i + MIRROR_CHUNK);
      await this.dataSource.query(
        `INSERT INTO to_token_app_records (kind, command_id, update_id, instrument_id, party_id, amount, record_created_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::timestamptz[])
         ON CONFLICT (kind, (coalesce(update_id, '')), (coalesce(command_id, '')), party_id, amount) DO NOTHING`,
        [
          chunk.map((r) => r.kind),
          chunk.map((r) => r.commandId),
          chunk.map((r) => r.updateId),
          chunk.map((r) => r.instrumentId),
          chunk.map((r) => r.partyId),
          chunk.map((r) => formatAmount(r.amount)),
          chunk.map((r) => r.createdAt?.toISOString() ?? null),
        ],
      );
    }
  }

  private async remember(result: TokenSyncPassResult): Promise<void> {
    const previous = await this.lastPassSummary();
    const summary: TokenSyncSummary = {
      trigger: result.trigger,
      startedAt: result.startedAt.toISOString(),
      finishedAt: result.finishedAt.toISOString(),
      complete: result.complete,
      error: result.error,
      allComplete: result.allComplete,
      instruments: result.instruments.map((i) => ({
        instrumentId: i.instrumentId,
        complete: i.complete,
        error: i.error,
      })),
      rampInstrument: result.rampInstrument,
      unknownRecords: result.unknownRecords.length,
      mismatches: result.mismatches.length,
      unresolvedMismatches: result.mismatches.filter((m) => !m.resolvedBy).length,
      duplicates: result.duplicates.length,
      unresolved: result.unresolved.length,
      ourNet: result.ourNet === null ? null : formatAmount(result.ourNet),
      tokenAppNet: result.tokenAppNet === null ? null : formatAmount(result.tokenAppNet),
    };
    // A pass that started earlier than the stored one never overwrites it: an older "complete"
    // must not replace a newer "incomplete" the payout gate has to see (C42).
    await this.redis
      .setJsonUnlessNewer(LAST_PASS_KEY, { ...summary }, "startedAt", LAST_PASS_TTL_MS)
      .then((written) => {
        if (!written) this.logger.warn("token sync summary not written: a newer pass's is stored");
      })
      .catch((err: Error) => this.logger.warn(`token sync summary write failed: ${err.message}`));
    if (summary.unknownRecords > (previous?.unknownRecords ?? 0)) {
      this.logger.error(
        `token-app holds ${summary.unknownRecords} record(s) of ${result.rampInstrument?.id} no command accounts for (I9)`,
      );
      this.sentry.captureMessage("token-app records without a command (I9)", "error", {
        component: "token-sync",
        page: "true",
      });
    }
  }
}

function recordView(r: TokenAppRecordEntity): TokenRecordView {
  return {
    kind: r.kind,
    commandId: r.commandId,
    updateId: r.updateId,
    instrumentId: r.instrumentId,
    partyId: r.partyId,
    amount: r.amount,
    recordCreatedAt: r.recordCreatedAt,
  };
}

function commandView(c: TokenCommandEntity): TokenCommandView {
  return {
    commandId: c.commandId,
    kind: c.kind,
    instrument: { admin: c.instrumentAdmin, id: c.instrumentId },
    partyId: c.partyId,
    amount: c.amount,
    source: c.source,
    ref: c.ref,
    status: c.status,
    attempts: c.attempts,
    lastPostAt: c.lastPostAt,
    recordedAmount: c.recordedAmount,
    lastError: c.lastError,
    resolvedBy: c.resolvedBy,
  };
}
