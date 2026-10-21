/**
 * Boots the real AppModule against real Postgres + Redis with NATS / ledger / wallet / token
 * registry faked (docs/INTERNALS.md "Test helpers"). Migrations run once per Jest worker; every
 * `reset()` truncates the `to_*` tables (except settings/migrations), FLUSHDBs Redis and clears
 * the fakes.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";

import { AppModule } from "../../src/app.module";
import { setupHttpApp } from "../../src/app.setup";
import { Config, getConfiguration } from "../../src/config";
import { buildDataSourceOptions } from "../../src/data-source";
import { EnterpriseWalletService } from "../../src/services/enterprise-wallet.service";
import { InstrumentsService } from "../../src/services/instruments.service";
import { LedgerClientService } from "../../src/services/ledger-client.service";
import { LedgerStreamService } from "../../src/services/ledger-stream.service";
import { NatsService } from "../../src/services/nats.service";
import { RedisService } from "../../src/services/redis.service";
import { RewardsService } from "../../src/services/rewards.service";
import { TokenAppService } from "../../src/services/token-app.service";
import { TokenRegistryService } from "../../src/services/token-registry.service";
import {
  FakeEnterpriseWallet,
  FakeLedgerClient,
  FakeLedgerStream,
  FakeNatsService,
  FakeTokenApp,
  FakeTokenRegistry,
} from "./fakes";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/truthoracle_backend_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";
/** An allowed browser origin for CSRF-passing requests (FRONTEND_ORIGINS in the test env). */
export const TEST_ORIGIN = "http://app.test";
export const TEST_TREASURY = "treasury::1220" + "f".repeat(64);
/** The DevNet stand-in collateral: Canton Coin, admin = the DSO party (docs/TOKENS.md §2 decision 10). */
export const TEST_DSO = "DSO::1220" + "d".repeat(64);
export const TEST_COLLATERAL = { admin: TEST_DSO, id: "Amulet" } as const;
/** The rewards instrument (TRO) the test env registers alongside. */
export const TEST_TRO_ADMIN = "tro::1220" + "e".repeat(64);
export const TEST_REWARDS = { admin: TEST_TRO_ADMIN, id: "TRO" } as const;
/** The bot token the test env configures; test/helpers/telegram.ts signs Login Widget payloads with it. */
export const TEST_TELEGRAM_BOT_TOKEN = "123456789:AAFakeBotTokenForE2E";

/**
 * The production values of the SPEC §6 controls (S4): spread into a prod-like `testEnv(…)` — the
 * test defaults below switch them off and prod-like boots refuse that.
 */
export const PROD_CONTROLS: Record<string, string> = {
  RAMP_DUAL_CONTROL: "true",
  RAMP_APPROVAL_SIGNATURES: "true",
  RAMP_RESERVE_GATE: "enforce",
  RAMP_PAYOUT_GATE: "enforce",
  RAMP_AUTO_HALT: "true",
};

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: "dev",
    APP_NETWORK: "devnet",
    LOG_JSON: "false",
    DATABASE_URL: TEST_DATABASE_URL,
    DB_MIGRATE_ON_BOOT: "false",
    REDIS_URL: TEST_REDIS_URL,
    NATS_URL: "nats://fake:4222",
    SESSION_SECRET: "e2e-session-secret-that-is-at-least-32-chars",
    KYC_FINGERPRINT_PEPPER: "e2e-kyc-pepper-that-is-at-least-32-chars!!",
    FRONTEND_ORIGINS: TEST_ORIGIN,
    COOKIE_SECURE: "false",
    GOOGLE_NONCE_REQUIRED: "false",
    TELEGRAM_BOT_TOKEN: TEST_TELEGRAM_BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: "truthoracle_test_bot",
    TREASURY_PARTY_ID: TEST_TREASURY,
    TRUTHORACLE_PACKAGE_ID: "fakepkg",
    TRUTHORACLE_PACKAGE_NAME: "truthoracle-test",
    ENTERPRISE_WALLET_URL: "http://wallet.fake",
    LEDGER_API_URL: "http://ledger.fake",
    KYC_PROVIDER: "mock",
    LEDGER_CACHE_MS: "0",
    SWAGGER_ENABLED: "false",
    SESSION_CLEANUP_MS: "3600000",
    // The indexer loop stays off under test; specs drive IndexerService against the FakeLedgerStream.
    INDEXER_ENABLED: "false",
    // So does the rewards loop; specs drive RewardsService.scan() / RewardsProcessor.tick().
    REWARDS_ENABLED: "false",
    // And the token-app sync loop; specs drive TokenAppSyncService.syncOnce() (docs/RAMP.md §7).
    TOKEN_APP_SYNC_SEC: "0",
    // SPEC §6 controls (S4): the production defaults (four-eyes, signed decisions, enforcing gates,
    // auto-halt) are switched on only by the specs that test them (ramp-controls, approvals).
    RAMP_DUAL_CONTROL: "false",
    RAMP_APPROVAL_SIGNATURES: "false",
    RAMP_RESERVE_GATE: "warn",
    RAMP_PAYOUT_GATE: "warn",
    RAMP_AUTO_HALT: "false",
    // SPEC §11 compliance (S7a): eligibility, consent and the monitoring rules are on only in the specs
    // that test them (compliance.e2e-spec); identities are stored and raised alerts recorded either way.
    RAMP_COMPLIANCE: "off",
    // Canton Coin as the default collateral (10 decimals, symbol CC) and TRO as the rewards instrument.
    COLLATERAL_INSTRUMENT_ADMIN: TEST_DSO,
    COLLATERAL_INSTRUMENT_ID: TEST_COLLATERAL.id,
    COLLATERAL_INSTRUMENT_SYMBOL: "CC",
    COLLATERAL_INSTRUMENT_NAME: "Canton Coin",
    COLLATERAL_INSTRUMENT_DECIMALS: "10",
    COLLATERAL_REGISTRY_AUTH: "ledger",
    REWARDS_INSTRUMENT_ADMIN: TEST_TRO_ADMIN,
    REWARDS_INSTRUMENT_ID: TEST_REWARDS.id,
    REWARDS_INSTRUMENT_NAME: "TruthOracle Token",
    REWARDS_INSTRUMENT_DECIMALS: "6",
    ...overrides,
  };
}

export interface TestAppOverrides {
  env?: Record<string, string>;
  /** Extra `overrideProvider(...)` calls on the builder before compile. */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface TestApp {
  app: INestApplication;
  config: Config;
  agent: request.Agent;
  nats: FakeNatsService;
  ledger: FakeLedgerClient;
  wallet: FakeEnterpriseWallet;
  /** The indexer's source (docs/INDEXER.md); push transactions, then run `IndexerService.runOnce()`. */
  stream: FakeLedgerStream;
  /** The CIP-56 registries (docs/TOKENS.md §4.4): canned factory / choice contexts, every call recorded. */
  registry: FakeTokenRegistry;
  /** Cantor8's token-app (docs/TOKENS.md §4.7): mints / burns recorded, nothing reaches the index. */
  tokenApp: FakeTokenApp;
  redis: RedisService;
  dataSource: DataSource;
  /** `{ Origin, Content-Type }` that satisfy the CSRF guard. */
  csrf: Record<string, string>;
  get<T>(token: abstract new (...args: never[]) => T): T;
  reset(): Promise<void>;
  close(): Promise<void>;
}

let migrated = false;

async function ensureDatabase(url: string): Promise<void> {
  const probe = new DataSource({ type: "postgres", url, entities: [], synchronize: false });
  try {
    await probe.initialize();
    await probe.destroy();
  } catch (err) {
    // 3D000 = database does not exist → create it (Postgres must be reachable and createdb on PATH).
    const code = (err as { code?: string }).code;
    if (code !== "3D000") throw err;
    const dbName = new URL(url).pathname.replace(/^\//, "");
    execFileSync("createdb", [dbName], { stdio: "inherit" });
  }
}

/**
 * Empties every `to_*` table but settings and migrations through its own connection. Each spec file
 * starts and ends on an empty database: rows another file sealed under ANOTHER keyring (or a run that
 * died) would otherwise make this file's boot refuse them — S3's keyring check runs at bootstrap,
 * before any `reset()` (SPEC §8).
 */
export async function purgeTestDatabase(url = TEST_DATABASE_URL): Promise<void> {
  const ds = new DataSource({ type: "postgres", url, entities: [], synchronize: false });
  try {
    await ds.initialize();
  } catch (err) {
    // 3D000: no database yet, so nothing to purge (the boot creates it).
    if ((err as { code?: string }).code === "3D000") return;
    throw err;
  }
  try {
    const rows = await ds.query<{ name: string }[]>(
      `SELECT tablename AS name FROM pg_tables
        WHERE schemaname = current_schema() AND tablename LIKE 'to\\_%'
          AND tablename NOT IN ('to_settings', 'to_migrations')`,
    );
    if (rows.length === 0) return;
    const journal = rows.some((r) => r.name === "to_ramp_journal");
    // The ramp journal refuses TRUNCATE (append-only, SPEC §3.3); the owner lifts that here only.
    if (journal) await ds.query(`ALTER TABLE "to_ramp_journal" DISABLE TRIGGER USER`);
    try {
      const list = rows.map((r) => `"${r.name}"`).join(", ");
      await ds.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    } finally {
      if (journal) await ds.query(`ALTER TABLE "to_ramp_journal" ENABLE TRIGGER USER`);
    }
  } finally {
    await ds.destroy();
  }
}

async function runMigrationsOnce(config: Config): Promise<void> {
  if (migrated) return;
  await ensureDatabase(config.databaseUrl);
  const ds = new DataSource({
    ...buildDataSourceOptions(config),
    // Under ts-jest the migrations are TypeScript sources (dist/ is not involved).
    migrations: [join(__dirname, "..", "..", "src", "migrations", "*.ts")],
  });
  await ds.initialize();
  try {
    await ds.runMigrations();
  } finally {
    await ds.destroy();
  }
  migrated = true;
}

export async function createTestApp(overrides: TestAppOverrides = {}): Promise<TestApp> {
  const config = getConfiguration(testEnv(overrides.env));
  await runMigrationsOnce(config);

  const nats = new FakeNatsService();
  const ledger = new FakeLedgerClient(config.collateralInstrument);
  const wallet = new FakeEnterpriseWallet(ledger, config.treasuryPartyId);
  const stream = new FakeLedgerStream(config.indexerParty);
  // What the stream carries is on the ledger: the fake ledger's PredictionMarket reads follow it.
  ledger.stream = stream;
  const registry = new FakeTokenRegistry();
  const tokenApp = new FakeTokenApp();

  let builder = Test.createTestingModule({ imports: [AppModule.register(config)] })
    .overrideProvider(NatsService)
    .useValue(nats)
    .overrideProvider(LedgerClientService)
    .useValue(ledger)
    .overrideProvider(EnterpriseWalletService)
    .useValue(wallet)
    .overrideProvider(LedgerStreamService)
    .useValue(stream)
    .overrideProvider(TokenRegistryService)
    .useValue(registry)
    .overrideProvider(TokenAppService)
    .useValue(tokenApp);
  if (overrides.configure) builder = overrides.configure(builder);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
    bodyParser: false,
    logger: false,
  });
  setupHttpApp(app, config);
  try {
    await app.init();
  } catch (err) {
    // A refused boot must not keep the database / Redis handles open (Jest would never exit).
    await app.close().catch(() => undefined);
    throw err;
  }

  const dataSource = app.get(DataSource);
  const redis = app.get(RedisService);
  const tables = dataSource.entityMetadatas
    .map((m) => m.tableName)
    .filter((t) => t !== "to_settings")
    .map((t) => `"${t}"`)
    .join(", ");

  const ctx: TestApp = {
    app,
    config,
    // Deliberately NOT `request.agent(...)`: supertest's agent persists Set-Cookie between requests
    // and MERGES its jar into an explicit `Cookie` header (the jar wins on a name collision), so
    // after any login/logout response every later `.set("Cookie", …)` in the file would silently
    // carry the wrong session. Tests pass cookies explicitly from the helpers instead.
    agent: request(app.getHttpServer()),
    nats,
    ledger,
    wallet,
    stream,
    registry,
    tokenApp,
    redis,
    dataSource,
    csrf: { Origin: TEST_ORIGIN, "Content-Type": "application/json" },
    get: <T>(token: abstract new (...args: never[]) => T): T => app.get(token),
    reset: async () => {
      // The ramp journal refuses TRUNCATE (append-only, SPEC §3.3); the table owner lifts that for the reset only.
      await dataSource.query(`ALTER TABLE "to_ramp_journal" DISABLE TRIGGER USER`);
      try {
        await dataSource.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
      } finally {
        await dataSource.query(`ALTER TABLE "to_ramp_journal" ENABLE TRIGGER USER`);
      }
      // to_settings survives the truncate (boot facts); the operator halt must not leak between specs,
      // and the rewards cursor must restart with the (re-numbered) index tables it points into.
      await dataSource.query(`DELETE FROM to_settings WHERE key = 'exchange_halt'`);
      await dataSource.query(`UPDATE to_settings SET value = '0' WHERE key = 'rewards_cursor'`);
      // The env-configured instruments and the reward rules are boot state: re-seed them after the truncate.
      await app.get(InstrumentsService).syncFromConfig();
      await app.get(RewardsService).seedRules();
      await redis.flushDb();
      nats.reset();
      ledger.reset();
      wallet.reset();
      stream.reset();
      registry.reset();
      tokenApp.reset();
    },
    close: async () => {
      await app.close();
    },
  };
  return ctx;
}

/**
 * Registers the Jest lifecycle for a spec: purge and boot once, `reset()` before every test, reset
 * and close after (nothing outlives the file: see `purgeTestDatabase`). Returns a handle whose
 * fields are populated after `beforeAll` ran.
 */
export function useTestApp(overrides: TestAppOverrides = {}): TestApp {
  const handle = {} as TestApp;
  beforeAll(async () => {
    await purgeTestDatabase(testEnv(overrides.env).DATABASE_URL);
    Object.assign(handle, await createTestApp(overrides));
  });
  beforeEach(async () => {
    await handle.reset();
  });
  afterAll(async () => {
    try {
      if (handle.reset) await handle.reset();
    } finally {
      if (handle.close) await handle.close();
    }
  });
  return handle;
}
