import { Injectable, Logger, type BeforeApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import { SETTING_APP_NETWORK, SETTING_KYC_PEPPER_HASH, SettingEntity } from "../entities/setting.entity";
import type { CheckState, HealthResponse, ReadinessResponse } from "../types";
import { SERVICE_NAME, SERVICE_VERSION } from "../util/version";
import { NatsService } from "./nats.service";
import { RedisService } from "./redis.service";

/** One advisory-lock key for "a replica is migrating this database" (any stable bigint). */
export const MIGRATION_ADVISORY_LOCK_KEY = 7_202_609_101n;

@Injectable()
export class AppService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(AppService.name);
  private readonly startedAt = Date.now();
  private draining = false;

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly nats: NatsService,
  ) {}

  /**
   * Boot: run pending migrations under a Postgres advisory lock (several replicas booting on a
   * fresh database or a new migration would otherwise all run it and crash-loop on "relation
   * already exists"), then the `to_settings` checks (ARCHITECTURE §9.6, §12): the database must
   * belong to this network, and the KYC pepper must be the one the stored fingerprints were built
   * with unless a rotation is explicitly acknowledged. Both refuse to boot by throwing. A missing
   * sign-in provider only warns (RUNBOOK §1).
   */
  async onModuleInit(): Promise<void> {
    if (this.config.dbMigrateOnBoot) await this.migrate();
    await this.checkAppNetwork();
    await this.checkPepper();
    this.warnWithoutSignInProvider();
  }

  /**
   * Accounts are opened only by Google or Telegram (ARCHITECTURE §6.1); with neither configured the
   * deployment can serve operators but no user can ever exist. A warning, not a refusal: local
   * development boots without them.
   */
  private warnWithoutSignInProvider(): void {
    if (this.config.googleClientIds.length > 0 || this.config.telegramBotToken) return;
    this.logger.warn("no sign-in provider is configured (GOOGLE_CLIENT_IDS / TELEGRAM_BOT_TOKEN): nobody can create an account, so nobody can deposit or trade");
  }

  /** The load balancer must stop routing here while the HTTP server drains (§14). */
  beforeApplicationShutdown(): void {
    this.draining = true;
  }

  async migrate(): Promise<number> {
    // Advisory locks are session-scoped: lock and unlock must run on the same connection.
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
      try {
        const applied = await this.dataSource.runMigrations({ transaction: "all" });
        if (applied.length > 0) this.logger.log(`applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(", ")}`);
        return applied.length;
      } finally {
        await runner.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
      }
    } finally {
      await runner.release();
    }
  }

  private async checkAppNetwork(): Promise<void> {
    const stored = await this.settingOrInit(SETTING_APP_NETWORK, this.config.appNetwork);
    if (stored.initialised) {
      this.logger.log(`to_settings.app_network initialised to ${this.config.appNetwork}`);
      return;
    }
    if (stored.value !== this.config.appNetwork) {
      throw new Error(
        `Refusing to boot: to_settings.app_network is "${stored.value}" but APP_NETWORK=${this.config.appNetwork}. This database belongs to another network.`,
      );
    }
  }

  private async checkPepper(): Promise<void> {
    const expected = this.config.kycPepperHash;
    const stored = await this.settingOrInit(SETTING_KYC_PEPPER_HASH, expected);
    if (stored.initialised) {
      this.logger.log("to_settings.kyc_pepper_hash recorded (first boot)");
      return;
    }
    if (stored.value === expected) return;
    if (this.config.kycPepperRotationAck === expected) {
      await this.dataSource.getRepository(SettingEntity).update({ key: SETTING_KYC_PEPPER_HASH }, { value: expected });
      this.logger.warn(
        "KYC_FINGERPRINT_PEPPER rotated (acknowledged by KYC_PEPPER_ROTATION_ACK). Existing to_kyc_persons bindings were built with the OLD pepper — recompute them per docs/RUNBOOK.md and then unset the ack.",
      );
      return;
    }
    throw new Error(
      "Refusing to boot: KYC_FINGERPRINT_PEPPER does not match to_settings.kyc_pepper_hash. Set KYC_PEPPER_ROTATION_ACK=<sha256 hex of the new pepper> to acknowledge a rotation (docs/RUNBOOK.md).",
    );
  }

  /**
   * `INSERT … ON CONFLICT (key) DO NOTHING`, then read back: two first boots racing on an empty
   * table both get the row one of them wrote (and compare against it) instead of one dying on a
   * raw primary-key violation.
   */
  private async settingOrInit(key: string, value: string): Promise<{ value: string; initialised: boolean }> {
    const inserted = await this.dataSource.query<{ key: string }[]>(
      `INSERT INTO to_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, value],
    );
    if (inserted.length > 0) return { value, initialised: true };
    const row = await this.dataSource.getRepository(SettingEntity).findOneByOrFail({ key });
    return { value: row.value, initialised: false };
  }

  health(): HealthResponse {
    return {
      status: "ok",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      env: this.config.appEnv,
      network: this.config.appNetwork,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      ts: new Date().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessResponse> {
    const [postgres, redis, nats] = await Promise.all([
      this.check("postgres", () => this.dataSource.query("SELECT 1")),
      this.check("redis", () => this.redis.ping()),
      this.check("nats", () => Promise.resolve(this.nats.isConnected())),
    ]);
    const checks = { postgres, redis, nats };
    const status = Object.values(checks).every((c) => c === "ok") && !this.draining ? "ok" : "degraded";
    return this.draining ? { status, checks, draining: true } : { status, checks };
  }

  private async check(name: string, probe: () => Promise<unknown>): Promise<CheckState> {
    try {
      const result = await probe();
      return result === false ? "fail" : "ok";
    } catch (err) {
      this.logger.warn(`${name} readiness probe failed: ${(err as Error).message}`);
      return "fail";
    }
  }
}
