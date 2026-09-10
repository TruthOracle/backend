import type { DataSource } from "typeorm";

import type { Config } from "../config";
import { AppService, MIGRATION_ADVISORY_LOCK_KEY } from "./app.service";
import type { NatsService } from "./nats.service";
import type { RedisService } from "./redis.service";

interface Mocks {
  runner: { connect: jest.Mock; query: jest.Mock; release: jest.Mock };
  dataSource: { createQueryRunner: jest.Mock; runMigrations: jest.Mock; query: jest.Mock; getRepository: jest.Mock };
  repo: { findOneByOrFail: jest.Mock; update: jest.Mock };
}

function build(overrides: Partial<Config> = {}): { service: AppService; m: Mocks } {
  const runner = { connect: jest.fn().mockResolvedValue(undefined), query: jest.fn().mockResolvedValue([]), release: jest.fn().mockResolvedValue(undefined) };
  const repo = { findOneByOrFail: jest.fn(), update: jest.fn().mockResolvedValue(undefined) };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(runner),
    runMigrations: jest.fn().mockResolvedValue([{ name: "M1" }]),
    query: jest.fn().mockResolvedValue([]),
    getRepository: jest.fn().mockReturnValue(repo),
  };
  const config = { appEnv: "dev", appNetwork: "devnet", dbMigrateOnBoot: true, kycPepperHash: "hash-new", kycPepperRotationAck: "", ...overrides } as unknown as Config;
  const service = new AppService(config, dataSource as unknown as DataSource, { ping: jest.fn().mockResolvedValue(true) } as unknown as RedisService, { isConnected: () => true } as unknown as NatsService);
  return { service, m: { runner, dataSource, repo } };
}

describe("AppService boot", () => {
  it("runs migrations under one Postgres advisory lock on a dedicated connection, unlocking even when they fail", async () => {
    const { service, m } = build();
    await expect(service.migrate()).resolves.toBe(1);
    expect(m.runner.query.mock.calls).toEqual([
      ["SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]],
      ["SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()]],
    ]);
    expect(m.dataSource.runMigrations).toHaveBeenCalledWith({ transaction: "all" });
    expect(m.runner.release).toHaveBeenCalledTimes(1);

    m.dataSource.runMigrations.mockRejectedValueOnce(new Error("relation exists"));
    await expect(service.migrate()).rejects.toThrow("relation exists");
    expect((m.runner.query.mock.calls as [string, unknown][]).filter((c) => c[0].includes("unlock"))).toHaveLength(2);
    expect(m.runner.release).toHaveBeenCalledTimes(2);
  });

  it("initialises to_settings with INSERT … ON CONFLICT DO NOTHING and compares against whatever row won", async () => {
    const { service, m } = build();
    // Both rows are ours on a fresh database.
    m.dataSource.query.mockResolvedValue([{ key: "x" }]);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(m.dataSource.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (key) DO NOTHING"), ["app_network", "devnet"]);
    expect(m.dataSource.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (key) DO NOTHING"), ["kyc_pepper_hash", "hash-new"]);

    // Another replica won the insert: the stored value is read back and checked.
    m.dataSource.query.mockResolvedValue([]);
    m.repo.findOneByOrFail.mockResolvedValueOnce({ key: "app_network", value: "mainnet" });
    await expect(service.onModuleInit()).rejects.toThrow(/belongs to another network/);
    m.repo.findOneByOrFail.mockResolvedValueOnce({ key: "app_network", value: "devnet" }).mockResolvedValueOnce({ key: "kyc_pepper_hash", value: "hash-old" });
    await expect(service.onModuleInit()).rejects.toThrow(/KYC_PEPPER_ROTATION_ACK/);
  });

  it("accepts an acknowledged pepper rotation and rewrites the stored hash", async () => {
    const { service, m } = build({ kycPepperRotationAck: "hash-new", dbMigrateOnBoot: false });
    m.dataSource.query.mockResolvedValue([]);
    m.repo.findOneByOrFail.mockResolvedValueOnce({ key: "app_network", value: "devnet" }).mockResolvedValueOnce({ key: "kyc_pepper_hash", value: "hash-old" });
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(m.repo.update).toHaveBeenCalledWith({ key: "kyc_pepper_hash" }, { value: "hash-new" });
    expect(m.dataSource.runMigrations).not.toHaveBeenCalled();
  });

  it("readiness reports draining (503) from beforeApplicationShutdown on, even while every dependency is fine", async () => {
    const { service } = build();
    await expect(service.readiness()).resolves.toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok", nats: "ok" } });
    service.beforeApplicationShutdown();
    await expect(service.readiness()).resolves.toEqual({ status: "degraded", checks: { postgres: "ok", redis: "ok", nats: "ok" }, draining: true });
  });
});
