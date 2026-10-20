import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";

import { Config } from "../config";
import { InstrumentEntity } from "../entities/instrument.entity";
import { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import { TOKEN_COMMAND_UNRESOLVED, TokenCommandEntity } from "../entities/token-command.entity";
import type { InstrumentId } from "../types";
import { parseAmount } from "../util/money";
import { HOUR_MS, MINUTE_MS } from "../util/time";
import { ALL_SCOPES } from "./ramp-controls.logic";
import {
  evalCommandsConfirmed,
  evalCommandsConsistent,
  evalRecordsKnown,
  evalSupply,
  mismatchResolution,
  type MismatchLite,
  type TokenRecordLite,
} from "./ramp-recon-checks.logic";
import {
  type CheckResult,
  type ReconCheckContext,
  type ReconCheckDefinition,
  type ReconCheckOutcome,
  RampReconciliationService,
} from "./ramp-reconciliation.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { TokenAppService } from "./token-app.service";
import { TokenAppSyncService, type TokenSyncPassResult } from "./token-app-sync.service";
import { matchCommands } from "./token-commands.logic";

/** What the four token checks read, from a sync pass or from the database. */
interface TokenView {
  instrument: InstrumentId | null;
  /** token-app is not configured and nothing was ever commanded or recorded: nothing to verify. */
  vacuous: boolean;
  complete: boolean;
  why: string | null;
  unknownRecords: TokenRecordLite[];
  mismatches: MismatchLite[];
  duplicates: string[];
  unresolved: { commandId: string; lastPostAt: Date | null; createdAt: Date }[];
  supply: { totalSupply: bigint | null; updatedAt: Date | null; monitorAgeSec: number | null };
  supplyError: string | null;
  /** When the mirror was last paged (the pass start). */
  mirrorAsOf: Date | null;
}

const NAMES = {
  known: "token_records_known",
  consistent: "token_commands_consistent",
  confirmed: "token_commands_confirmed",
  supply: "supply_matches_issuance",
} as const;

/**
 * The token checks of SPEC §6.2 (I9, X8): records known, commands consistent, commands confirmed,
 * supply vs issuance — of the RAMP instrument. In a full run they read the mirror and the command
 * ledger (as fresh as the last sync pass) and token-app's monitor; on every token sync pass they
 * are evaluated from the pass itself and recorded at once (`trigger = sync`) — so an unknown record
 * halts everything within one pass, not one reconciliation interval. token-app answering 401/403
 * after a refresh pages too.
 */
@Injectable()
export class RampTokenChecks implements OnModuleInit {
  private readonly logger = new Logger(RampTokenChecks.name);

  constructor(
    private readonly config: Config,
    private readonly reconciliation: RampReconciliationService,
    private readonly sync: TokenAppSyncService,
    private readonly tokenApp: TokenAppService,
    @InjectRepository(TokenCommandEntity) private readonly commands: Repository<TokenCommandEntity>,
    @InjectRepository(TokenAppRecordEntity)
    private readonly records: Repository<TokenAppRecordEntity>,
    @InjectRepository(InstrumentEntity) private readonly instruments: Repository<InstrumentEntity>,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  onModuleInit(): void {
    for (const definition of this.definitions(() => this.viewFromDatabase()))
      this.reconciliation.registerCheck(definition);
    this.sync.onPass((result) => this.onPass(result), "ramp-recon-token-checks");
  }

  /** The four checks over a view source (memoised in the run's cache: one read serves all four). */
  private definitions(source: () => Promise<TokenView>): ReconCheckDefinition[] {
    const view = (ctx: ReconCheckContext): Promise<TokenView> => {
      let hit = ctx.cache.get("token-view") as Promise<TokenView> | undefined;
      if (!hit) {
        hit = source();
        ctx.cache.set("token-view", hit);
      }
      return hit;
    };
    return [
      {
        name: NAMES.known,
        haltScopes: [...ALL_SCOPES],
        page: true,
        run: async (ctx) => this.known(await view(ctx)),
      },
      {
        name: NAMES.consistent,
        haltScopes: [...ALL_SCOPES],
        page: true,
        run: async (ctx) => this.consistent(await view(ctx)),
      },
      {
        name: NAMES.confirmed,
        haltScopes: [],
        run: async (ctx) => this.confirmed(await view(ctx)),
      },
      {
        name: NAMES.supply,
        haltScopes: [...ALL_SCOPES],
        page: true,
        run: async (ctx) => this.supply(await view(ctx)),
      },
    ];
  }

  /** Every token sync pass (X8): evaluate the token checks from the pass and record them at once. */
  async onPass(result: TokenSyncPassResult): Promise<void> {
    await this.pageAuthFailures(result);
    const view = await this.viewFromPass(result);
    const results: CheckResult[] = [];
    const ctx: ReconCheckContext = {
      trigger: "sync",
      now: new Date(),
      previous: null,
      cache: new Map(),
    };
    for (const definition of this.definitions(async () => view))
      results.push({ definition, outcome: await definition.run(ctx) });
    await this.reconciliation.recordRun("sync", results);
  }

  // ───────────────────────────────────────────── checks ─────────────────────────────────────

  private known(v: TokenView): ReconCheckOutcome {
    return idle(v) ?? evalRecordsKnown(v);
  }

  private async consistent(v: TokenView): Promise<ReconCheckOutcome> {
    const nothing = idle(v);
    if (nothing) return nothing;
    const compIds = v.mismatches
      .map((m) => m.resolvedBy)
      .filter((id): id is string => !!id?.startsWith("comp-"));
    const comps = compIds.length ? await this.commands.findBy({ commandId: In(compIds) }) : [];
    const statusOf = new Map(comps.map((c) => [c.commandId, c.status]));
    return evalCommandsConsistent({
      mismatches: v.mismatches.map((m) => ({
        commandId: m.commandId,
        resolution: mismatchResolution(
          m,
          m.resolvedBy ? (statusOf.get(m.resolvedBy) ?? null) : null,
        ),
      })),
      duplicates: v.duplicates,
      complete: v.complete,
      why: v.why,
    });
  }

  private confirmed(v: TokenView): ReconCheckOutcome {
    return evalCommandsConfirmed({
      unresolved: v.unresolved,
      confirmMin: this.config.tokenCommands.confirmMin,
      now: new Date(),
    });
  }

  private async supply(v: TokenView): Promise<ReconCheckOutcome> {
    const nothing = idle(v);
    if (nothing || !v.instrument) return nothing ?? { status: "green", detail: "" };
    const updatedAt = v.supply.updatedAt;
    const rows = await this.records
      .createQueryBuilder("r")
      .select("r.kind", "kind")
      .addSelect("COALESCE(SUM(r.amount), 0)::text", "total")
      .where("r.instrument_id = :id", { id: v.instrument.id })
      .andWhere("(r.record_created_at IS NULL OR r.record_created_at <= :at)", {
        at: updatedAt ?? new Date(),
      })
      .groupBy("r.kind")
      .getRawMany<{ kind: string; total: string }>();
    const sum = (k: string): bigint => parseAmount(rows.find((r) => r.kind === k)?.total ?? "0");
    return evalSupply({
      ...v.supply,
      updatedAt,
      mirrorNet: sum("mint") - sum("burn"),
      mirrorAsOf: v.mirrorAsOf,
      error: v.supplyError,
    });
  }

  // ───────────────────────────────────────────── views ──────────────────────────────────────

  private async viewFromPass(r: TokenSyncPassResult): Promise<TokenView> {
    return {
      instrument: r.rampInstrument,
      vacuous: await this.vacuous(r.rampInstrument),
      complete: r.complete,
      why: r.error,
      unknownRecords: r.unknownRecords,
      mismatches: r.mismatches,
      duplicates: r.duplicates.filter((d) => d.status !== "mismatch").map((d) => d.commandId),
      unresolved: r.unresolved.map((c) => ({
        commandId: c.commandId,
        lastPostAt: c.lastPostAt,
        createdAt: c.lastPostAt ?? r.startedAt,
      })),
      supply: {
        totalSupply: r.statusTotalSupply,
        updatedAt: r.statusUpdatedAt,
        monitorAgeSec: r.monitorAgeSec,
      },
      supplyError:
        r.instruments.find((i) => i.instrumentId === r.rampInstrument?.id)?.monitorError ?? null,
      mirrorAsOf: r.startedAt,
    };
  }

  /** A full run's view: the mirror and command ledger as the last sync pass left them, the monitor read now. */
  private async viewFromDatabase(): Promise<TokenView> {
    const instrument = await this.sync.rampInstrument();
    const last = await this.sync.lastPassSummary();
    const freshMs = 2 * this.config.rampControls.reconEveryMin * MINUTE_MS;
    const lastAt = last ? Date.parse(last.finishedAt) : NaN;
    const why = !last
      ? "no token sync pass yet"
      : !last.complete
        ? `the last token sync pass was incomplete: ${last.error ?? "?"}`
        : Date.now() - lastAt > freshMs
          ? `the last complete token sync pass is ${Math.floor((Date.now() - lastAt) / MINUTE_MS)} min old`
          : null;
    const view: TokenView = {
      instrument,
      vacuous: await this.vacuous(instrument),
      complete: why === null,
      why,
      unknownRecords: [],
      mismatches: [],
      duplicates: [],
      unresolved: [],
      supply: { totalSupply: null, updatedAt: null, monitorAgeSec: null },
      supplyError: null,
      mirrorAsOf: last ? new Date(last.startedAt) : null,
    };
    if (!instrument) return view;
    const [rows, mirror] = await Promise.all([
      this.commands.findBy({ instrumentId: instrument.id }),
      this.records.findBy({ instrumentId: instrument.id }),
    ]);
    const match = matchCommands(rows, mirror);
    view.unknownRecords = match.unknownRecords;
    view.duplicates = match.duplicates
      .filter((d) => d.status !== "mismatch")
      .map((d) => d.commandId);
    view.mismatches = rows.filter((c) => c.status === "mismatch");
    view.unresolved = rows.filter((c) =>
      (TOKEN_COMMAND_UNRESOLVED as readonly string[]).includes(c.status),
    );
    try {
      const row = await this.instruments.findOneBy({ admin: instrument.admin, id: instrument.id });
      if (!row) throw new Error(`instrument ${instrument.id} is not registered`);
      const m = await this.tokenApp.monitor(instrument.id, row.decimals);
      view.supply = {
        totalSupply: m.token?.totalSupply ?? null,
        updatedAt: m.token?.updatedAt ?? m.updatedAt,
        monitorAgeSec: m.monitor.ageSeconds,
      };
    } catch (err) {
      view.supplyError = `token-app /status: ${(err as Error).message}`;
    }
    return view;
  }

  /** Without token-app no record can exist; with no command ever written there is nothing at stake either. */
  private async vacuous(instrument: InstrumentId | null): Promise<boolean> {
    if (!instrument || this.tokenApp.isConfigured()) return false;
    const [commands, records] = await Promise.all([
      this.commands.countBy({ instrumentId: instrument.id }),
      this.records.countBy({ instrumentId: instrument.id }),
    ]);
    return commands === 0 && records === 0;
  }

  /** SPEC §6.2 paging set: token-app refusing our credential (401 after a refresh, 403). */
  private async pageAuthFailures(r: TokenSyncPassResult): Promise<void> {
    const texts = [r.error, ...r.instruments.map((i) => i.monitorError)].filter(
      (t): t is string => !!t,
    );
    if (!texts.some((t) => /\((401|403)\)/.test(t))) return;
    const once = await this.redis
      .acquireLock("page:token-app-auth", HOUR_MS)
      .catch(() => ({ acquired: true }));
    if (!once.acquired) return;
    this.logger.error("token-app refuses our credential (401 after refresh / 403)");
    this.sentry.captureMessage("token-app refuses the backend's credential (401/403)", "error", {
      component: "token-sync",
      page: "true",
    });
  }
}

/** Green when there is nothing to check: no ramp instrument, or token-app unconfigured with no history. */
function idle(v: TokenView): ReconCheckOutcome | null {
  if (!v.instrument) return { status: "green", detail: "no ramp instrument configured" };
  if (v.vacuous)
    return {
      status: "green",
      detail: "token-app is not configured and no command was ever written",
    };
  return null;
}
