import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

import { Config, type InstrumentConfig } from "../config";
import { InstrumentEntity } from "../entities/instrument.entity";
import {
  instrumentKey,
  NatsSubjects,
  type Actor,
  type ApiAdminInstrument,
  type ApiInstrument,
  type InstrumentId,
  type InstrumentKind,
  type InstrumentRef,
  type RegistryAuth,
  type TreasuryTransferMode,
} from "../types";
import { ApiError } from "../util/errors";
import { AMOUNT_DECIMALS } from "../util/money";
import { AuditService } from "./audit.service";
import { NatsService } from "./nats.service";

/** How long the in-memory snapshot serves `refOf` before it is re-read from Postgres (another replica may have changed a row). */
export const INSTRUMENT_CACHE_TTL_MS = 10_000;

export interface InstrumentInput {
  admin: string;
  id: string;
  symbol?: string;
  name?: string;
  decimals: number;
  kind: InstrumentKind;
  enabled?: boolean;
  isDefaultCollateral?: boolean;
  registryUrl?: string | null;
  registryAuth?: RegistryAuth;
  transferMode?: TreasuryTransferMode | null;
  walletInstrumentId?: string;
  setupChoices?: Record<string, string>;
}

/** `PATCH /admin/instruments/:admin/:id` — the (admin, id) pair is immutable; everything else may change. */
export type InstrumentPatch = Partial<Omit<InstrumentInput, "admin" | "id" | "kind">>;

/**
 * The instruments the platform knows (docs/TOKENS.md §4.1 `to_instruments`) and the one place
 * their presentation is resolved: every `InstrumentRef` on the wire comes from `refOf`, so a
 * market's collateral, a wallet's balance and a payout all name the same symbol and decimals.
 *
 * Boot upserts the two env-configured instruments (the collateral as the default collateral, TRO
 * as the rewards instrument) after the migrations ran — `onApplicationBootstrap`, because Nest
 * runs every provider's `onModuleInit` concurrently and AppService migrates in its own. The
 * indexer registers any instrument it meets on a ledger-first market as disabled with the token id
 * as its symbol (`ensureKnown`), so the market still renders while an operator fills in the rest.
 * Reads go through a short-lived snapshot: `refOf` must be synchronous (it runs inside the
 * market / position shapers), and an unknown instrument falls back to its id at the full 10-dp
 * scale rather than failing the read.
 */
@Injectable()
export class InstrumentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InstrumentsService.name);
  private snapshot = new Map<string, InstrumentEntity>();
  private snapshotAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(InstrumentEntity) private readonly repo: Repository<InstrumentEntity>,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.syncFromConfig();
  }

  // ───────────────────────────────────────────── boot ─────────────────────────────────────────

  /**
   * Upsert the env-configured instruments. Identity and presentation come from the environment
   * on every boot (an operator changes them there); `enabled` is operator state and is only set on
   * insert, so an instrument disabled through the admin API stays disabled across restarts. The
   * collateral becomes THE default collateral (the unique partial index allows exactly one).
   */
  async syncFromConfig(): Promise<void> {
    const { collateralInstrument, rewardsInstrument } = this.config;
    if (this.config.hasCollateralInstrument) {
      await this.upsertFromConfig(collateralInstrument, "collateral", true);
    } else {
      this.logger.warn(
        "no collateral instrument is configured (COLLATERAL_INSTRUMENT_ADMIN / _ID): markets cannot be created until one is",
      );
    }
    if (this.config.hasRewardsInstrument) {
      await this.upsertFromConfig(rewardsInstrument, "rewards", false);
    } else if (rewardsInstrument.id) {
      this.logger.warn(
        `REWARDS_INSTRUMENT_ID=${rewardsInstrument.id} has no REWARDS_INSTRUMENT_ADMIN: rewards stay idle until the token's admin party is configured`,
      );
    }
    await this.refresh();
  }

  private async upsertFromConfig(
    cfg: InstrumentConfig,
    kind: InstrumentKind,
    isDefaultCollateral: boolean,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      if (isDefaultCollateral) {
        await manager
          .createQueryBuilder()
          .update(InstrumentEntity)
          .set({ isDefaultCollateral: false })
          .where("is_default_collateral = true AND NOT (admin = :admin AND id = :id)", {
            admin: cfg.admin,
            id: cfg.id,
          })
          .execute();
      }
      await manager.query(
        `INSERT INTO to_instruments (admin, id, symbol, name, decimals, kind, enabled, is_default_collateral, registry_url, registry_auth, wallet_instrument_id)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10)
         ON CONFLICT (admin, id) DO UPDATE SET
           symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals, kind = EXCLUDED.kind,
           is_default_collateral = EXCLUDED.is_default_collateral, registry_url = EXCLUDED.registry_url,
           registry_auth = EXCLUDED.registry_auth, wallet_instrument_id = EXCLUDED.wallet_instrument_id, updated_at = now()`,
        [
          cfg.admin,
          cfg.id,
          cfg.symbol,
          cfg.name,
          cfg.decimals,
          kind,
          isDefaultCollateral,
          cfg.registryUrl || null,
          cfg.registryAuth,
          cfg.walletInstrumentId,
        ],
      );
    });
    this.logger.log(
      `instrument ${cfg.id} (${kind}${isDefaultCollateral ? ", default collateral" : ""}) upserted from the environment: admin ${cfg.admin.slice(0, 24)}…, ${cfg.decimals} decimals`,
    );
  }

  // ───────────────────────────────────────────── reads ────────────────────────────────────────

  async list(opts: { includeDisabled?: boolean } = {}): Promise<InstrumentEntity[]> {
    const qb = this.repo
      .createQueryBuilder("i")
      .orderBy("i.kind", "ASC")
      .addOrderBy("i.symbol", "ASC");
    if (!opts.includeDisabled) qb.where("i.enabled = true");
    return qb.getMany();
  }

  async get(admin: string, id: string): Promise<InstrumentEntity | null> {
    return this.repo.findOneBy({ admin, id });
  }

  /** `404 not_found` for an instrument the platform does not know. */
  async require(admin: string, id: string): Promise<InstrumentEntity> {
    const row = await this.get(admin, id);
    if (!row)
      throw new ApiError(
        404,
        "not_found",
        `instrument ${id} (${admin.slice(0, 24)}…) is not registered`,
      );
    return row;
  }

  /** The one `is_default_collateral` row, or null when no collateral is configured. */
  async defaultCollateral(): Promise<InstrumentEntity | null> {
    return this.repo.findOneBy({ isDefaultCollateral: true });
  }

  /** `503 not_ready` without a default collateral: nothing can be denominated. */
  async requireDefaultCollateral(): Promise<InstrumentEntity> {
    const row = await this.defaultCollateral();
    if (!row)
      throw new ApiError(
        503,
        "not_ready",
        "no default collateral instrument is configured (COLLATERAL_INSTRUMENT_ADMIN / COLLATERAL_INSTRUMENT_ID)",
      );
    return row;
  }

  /**
   * An instrument a market may be created in (docs/TOKENS.md §4.5): known, enabled and of kind
   * `collateral` — otherwise `400 validation_failed` naming the problem. `ref` omitted = the default.
   */
  async requireCollateral(ref: InstrumentId | null | undefined): Promise<InstrumentEntity> {
    const row = ref ? await this.get(ref.admin, ref.id) : await this.requireDefaultCollateral();
    if (!row)
      throw new ApiError(
        400,
        "validation_failed",
        `collateral ${ref?.id ?? ""} is not a registered instrument`,
      );
    if (row.kind !== "collateral")
      throw new ApiError(
        400,
        "validation_failed",
        `${row.symbol} is a ${row.kind} instrument and cannot back a market`,
      );
    if (!row.enabled) throw new ApiError(400, "validation_failed", `${row.symbol} is disabled`);
    return row;
  }

  /** The rewards instrument (TRO), or null when none is registered. */
  async rewardsInstrument(): Promise<InstrumentEntity | null> {
    return this.repo.findOne({ where: { kind: "rewards" }, order: { createdAt: "ASC" } });
  }

  /** An enabled instrument deposits / transfers may move (`409 instrument_disabled`, `404 instrument_unknown`). */
  async requireEnabled(ref: InstrumentId): Promise<InstrumentEntity> {
    const row = await this.get(ref.admin, ref.id);
    if (!row)
      throw new ApiError(404, "instrument_unknown", `instrument ${ref.id} is not registered`);
    if (!row.enabled) throw new ApiError(409, "instrument_disabled", `${row.symbol} is disabled`);
    return row;
  }

  /**
   * The wire ref of an instrument, synchronously from the snapshot (refreshed in the background
   * when older than INSTRUMENT_CACHE_TTL_MS). Unknown instruments render as their id at the full
   * 10-dp scale: a ledger-first market must never fail to render because the operator has not
   * described its token yet.
   */
  refOf(ref: InstrumentId): InstrumentRef {
    this.maybeRefresh();
    const row = this.snapshot.get(instrumentKey(ref));
    if (row) return this.toRef(row);
    return {
      admin: ref.admin,
      id: ref.id,
      symbol: ref.id,
      name: ref.id,
      decimals: AMOUNT_DECIMALS,
    };
  }

  /** Same as `refOf` for the two entity columns every amount-carrying table has. */
  refFor(admin: string, id: string): InstrumentRef {
    return this.refOf({ admin, id });
  }

  toRef(row: InstrumentEntity): InstrumentRef {
    return {
      admin: row.admin,
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
    };
  }

  toApi(row: InstrumentEntity): ApiInstrument {
    return {
      ...this.toRef(row),
      kind: row.kind,
      enabled: row.enabled,
      isDefaultCollateral: row.isDefaultCollateral,
      walletInstrumentId: row.walletInstrumentId,
    };
  }

  toAdminApi(row: InstrumentEntity): ApiAdminInstrument {
    return {
      ...this.toApi(row),
      registryUrl: row.registryUrl,
      registryAuth: row.registryAuth,
      transferMode: row.transferMode,
      setupChoices: row.setupChoices ?? {},
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The transfer mode an outbound transfer of `row` uses: the row's override, else the process default. */
  transferModeOf(row: InstrumentEntity): TreasuryTransferMode {
    return row.transferMode ?? this.config.treasuryTransferMode;
  }

  // ───────────────────────────────────────────── writes ───────────────────────────────────────

  /** `POST /admin/instruments` — `409 instrument_exists` when the (admin, id) pair is already registered. */
  async create(input: InstrumentInput, actor: Actor, reason?: string): Promise<InstrumentEntity> {
    const row = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(InstrumentEntity);
      if (await repo.findOneBy({ admin: input.admin, id: input.id }))
        throw new ApiError(
          409,
          "instrument_exists",
          `instrument ${input.id} is already registered for this admin party`,
        );
      const isDefault = input.isDefaultCollateral === true;
      if (isDefault && input.kind !== "collateral")
        throw new ApiError(
          400,
          "validation_failed",
          "only a collateral instrument can be the default collateral",
        );
      if (isDefault)
        await repo.update({ isDefaultCollateral: true }, { isDefaultCollateral: false });
      const created = repo.create({
        admin: input.admin,
        id: input.id,
        symbol: (input.symbol ?? "").trim() || input.id,
        name: (input.name ?? "").trim() || input.id,
        decimals: input.decimals,
        kind: input.kind,
        enabled: input.enabled ?? true,
        isDefaultCollateral: isDefault,
        registryUrl: input.registryUrl?.trim() || null,
        registryAuth: input.registryAuth ?? "keycloak",
        transferMode: input.transferMode ?? null,
        walletInstrumentId: (input.walletInstrumentId ?? "").trim() || input.id,
        setupChoices: input.setupChoices ?? {},
      });
      const saved = await repo.save(created);
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "instrument.created",
          subjectType: "instrument",
          subjectId: instrumentKey(saved),
          metadata: {
            reason,
            kind: saved.kind,
            symbol: saved.symbol,
            decimals: saved.decimals,
            isDefaultCollateral: saved.isDefaultCollateral,
          },
          ip: actor.ip ?? null,
        },
        manager,
      );
      return saved;
    });
    await this.announce(row);
    return row;
  }

  /** `PATCH /admin/instruments/:admin/:id` — the pair is immutable; `isDefaultCollateral: true` moves the default here. */
  async update(
    admin: string,
    id: string,
    patch: InstrumentPatch,
    actor: Actor,
    reason?: string,
  ): Promise<InstrumentEntity> {
    const row = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(InstrumentEntity);
      const existing = await repo.findOneBy({ admin, id });
      if (!existing)
        throw new ApiError(
          404,
          "not_found",
          `instrument ${id} is not registered for this admin party`,
        );
      if (patch.symbol !== undefined) existing.symbol = patch.symbol.trim() || existing.id;
      if (patch.name !== undefined) existing.name = patch.name.trim() || existing.id;
      if (patch.decimals !== undefined) existing.decimals = patch.decimals;
      if (patch.enabled !== undefined) existing.enabled = patch.enabled;
      if (patch.registryUrl !== undefined) existing.registryUrl = patch.registryUrl?.trim() || null;
      if (patch.registryAuth !== undefined) existing.registryAuth = patch.registryAuth;
      if (patch.transferMode !== undefined) existing.transferMode = patch.transferMode;
      if (patch.walletInstrumentId !== undefined)
        existing.walletInstrumentId = patch.walletInstrumentId.trim() || existing.id;
      if (patch.setupChoices !== undefined) existing.setupChoices = patch.setupChoices;
      if (patch.isDefaultCollateral !== undefined) {
        if (patch.isDefaultCollateral && existing.kind !== "collateral")
          throw new ApiError(
            400,
            "validation_failed",
            "only a collateral instrument can be the default collateral",
          );
        if (patch.isDefaultCollateral)
          await repo.update({ isDefaultCollateral: true }, { isDefaultCollateral: false });
        existing.isDefaultCollateral = patch.isDefaultCollateral;
      }
      const saved = await repo.save(existing);
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "instrument.updated",
          subjectType: "instrument",
          subjectId: instrumentKey(saved),
          metadata: {
            reason,
            fields: Object.keys(patch).filter(
              (k) => patch[k as keyof InstrumentPatch] !== undefined,
            ),
            enabled: saved.enabled,
            isDefaultCollateral: saved.isDefaultCollateral,
          },
          ip: actor.ip ?? null,
        },
        manager,
      );
      return saved;
    });
    await this.announce(row);
    return row;
  }

  /**
   * The indexer's hook (docs/TOKENS.md §4.1): an instrument met on a ledger-first market or wallet
   * is registered as disabled with the token id as its symbol, so the rows it is on still render;
   * a known instrument is left exactly as it is. Returns true when a row was inserted.
   */
  async ensureKnown(ref: InstrumentId, kind: InstrumentKind = "collateral"): Promise<boolean> {
    if (!ref.admin || !ref.id) return false;
    const res = await this.dataSource.query<{ admin: string }[]>(
      `INSERT INTO to_instruments (admin, id, symbol, name, decimals, kind, enabled, is_default_collateral, registry_auth, wallet_instrument_id)
         VALUES ($1, $2, $2, $2, $3, $4, false, false, 'keycloak', $2)
       ON CONFLICT (admin, id) DO NOTHING RETURNING admin`,
      [ref.admin, ref.id, AMOUNT_DECIMALS, kind],
    );
    if (res.length === 0) return false;
    this.logger.warn(
      `instrument ${ref.id} (${ref.admin.slice(0, 24)}…) met on the ledger is not registered — added as disabled; describe and enable it through /admin/instruments`,
    );
    await this.refresh();
    return true;
  }

  // ───────────────────────────────────────────── snapshot ─────────────────────────────────────

  /** Re-read every row into the snapshot (after a write, or when `refOf` finds it stale). */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const rows = await this.repo.find();
        this.snapshot = new Map(rows.map((r) => [instrumentKey(r), r]));
        this.snapshotAt = Date.now();
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private maybeRefresh(): void {
    if (Date.now() - this.snapshotAt < INSTRUMENT_CACHE_TTL_MS) return;
    void this.refresh().catch((err: unknown) => {
      this.logger.warn(`instrument snapshot refresh failed: ${(err as Error).message}`);
    });
  }

  private async announce(row: InstrumentEntity): Promise<void> {
    await this.refresh();
    await this.nats.publishSafe(NatsSubjects.instrumentChanged, {
      admin: row.admin,
      id: row.id,
      enabled: row.enabled,
    });
  }
}
