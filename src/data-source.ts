import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DataSource, type DataSourceOptions } from "typeorm";

import type { DbSslMode } from "./config";
import { postgresEntities } from "./entities";

export type DbSslOptions = false | { rejectUnauthorized: boolean; ca?: string };

/** `DB_SSL_CA` is either a PEM block inline or the path of a PEM file. */
export function resolveDbSslCa(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  if (value.includes("-----BEGIN")) return value;
  return readFileSync(value, "utf8");
}

/**
 * `verify` = TLS with the server certificate checked (against `DB_SSL_CA` when the managed
 * database uses a private CA); `true` = TLS without verification (opportunistic, MITM-able —
 * refused in prod without DB_SSL_INSECURE_ACK, see config.ts); `auto` = plain TCP for local /
 * docker-compose hosts, unverified TLS everywhere else; `false` = plain TCP.
 */
export function resolveDbSsl(databaseUrl: string, mode: DbSslMode, ca?: string): DbSslOptions {
  if (mode === "false") return false;
  if (mode === "verify") return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  if (mode === "true") return { rejectUnauthorized: false };
  return /(localhost|127\.0\.0\.1|@postgres[:/])/.test(databaseUrl) ? false : { rejectUnauthorized: false };
}

/** Shared by the Nest TypeOrmModule and the TypeORM CLI so both see the same options. */
export function buildDataSourceOptions(input: {
  databaseUrl: string;
  dbSsl: DbSslMode;
  dbSslCa?: string;
}): DataSourceOptions {
  return {
    type: "postgres",
    url: input.databaseUrl,
    entities: postgresEntities,
    // Compiled migrations only: this file is consumed from dist/ by the CLI and the app.
    migrations: [join(__dirname, "migrations", "*.js")],
    migrationsTableName: "to_migrations",
    // gen_random_uuid() is built into Postgres 13+; TypeORM still names the extension.
    uuidExtension: "pgcrypto",
    synchronize: false,
    logging: false,
    ssl: resolveDbSsl(input.databaseUrl, input.dbSsl, input.dbSslCa),
  };
}

// CLI entrypoint: `typeorm migration:{generate,run,revert} -d dist/data-source.js`.
// dotenv-free: Node's own loader (ARCHITECTURE §2); a missing .env is not an error.
try {
  process.loadEnvFile(join(__dirname, "..", ".env"));
} catch {
  // no .env — environment variables only
}

const AppDataSource = new DataSource(
  buildDataSourceOptions({
    databaseUrl: process.env.DATABASE_URL ?? "",
    dbSsl: (process.env.DB_SSL as DbSslMode | undefined) ?? "auto",
    dbSslCa: resolveDbSslCa(process.env.DB_SSL_CA),
  }),
);

// TypeORM 1.x CLI requires exactly ONE exported DataSource instance (0.3 tolerated named + default).
export default AppDataSource;
