import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import { SETTING_APP_NETWORK, SETTING_KYC_PEPPER_HASH, SettingEntity } from "../entities/setting.entity";
import type { CheckState, HealthResponse, ReadinessResponse } from "../types";
import { SERVICE_NAME, SERVICE_VERSION } from "../util/version";
import { NatsService } from "./nats.service";
import { RedisService } from "./redis.service";

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly nats: NatsService,
  ) {}

  /**
   * Boot checks against `to_settings` (ARCHITECTURE §9.6, §12): the database must belong to this
   * network, and the KYC pepper must be the one the stored fingerprints were built with unless a
   * rotation is explicitly acknowledged. Both refuse to boot by throwing.
   */
  async onModuleInit(): Promise<void> {
    await this.checkAppNetwork();
    await this.checkPepper();
  }

  private async checkAppNetwork(): Promise<void> {
    const repo = this.dataSource.getRepository(SettingEntity);
    const row = await repo.findOne({ where: { key: SETTING_APP_NETWORK } });
    if (!row) {
      await repo.insert({ key: SETTING_APP_NETWORK, value: this.config.appNetwork });
      this.logger.log(`to_settings.app_network initialised to ${this.config.appNetwork}`);
      return;
    }
    if (row.value !== this.config.appNetwork) {
      throw new Error(
        `Refusing to boot: to_settings.app_network is "${row.value}" but APP_NETWORK=${this.config.appNetwork}. This database belongs to another network.`,
      );
    }
  }

  private async checkPepper(): Promise<void> {
    const repo = this.dataSource.getRepository(SettingEntity);
    const expected = this.config.kycPepperHash;
    const row = await repo.findOne({ where: { key: SETTING_KYC_PEPPER_HASH } });
    if (!row) {
      await repo.insert({ key: SETTING_KYC_PEPPER_HASH, value: expected });
      this.logger.log("to_settings.kyc_pepper_hash recorded (first boot)");
      return;
    }
    if (row.value === expected) return;
    if (this.config.kycPepperRotationAck === expected) {
      await repo.update({ key: SETTING_KYC_PEPPER_HASH }, { value: expected });
      this.logger.warn(
        "KYC_FINGERPRINT_PEPPER rotated (acknowledged by KYC_PEPPER_ROTATION_ACK). Existing to_kyc_persons bindings were built with the OLD pepper — recompute them per docs/RUNBOOK.md and then unset the ack.",
      );
      return;
    }
    throw new Error(
      "Refusing to boot: KYC_FINGERPRINT_PEPPER does not match to_settings.kyc_pepper_hash. Set KYC_PEPPER_ROTATION_ACK=<sha256 hex of the new pepper> to acknowledge a rotation (docs/RUNBOOK.md).",
    );
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
    const status = Object.values(checks).every((c) => c === "ok") ? "ok" : "degraded";
    return { status, checks };
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
