import "reflect-metadata";
import { join } from "node:path";
import { DataSource, type DataSourceOptions } from "typeorm";

import type { DbSslMode } from "./config";
import { postgresEntities } from "./entities";

export function resolveDbSsl(
  databaseUrl: string,
  mode: DbSslMode,
): false | { rejectUnauthorized: boolean } {
  if (mode === "false") return false;
  if (mode === "true") return { rejectUnauthorized: false };
  // auto: plain TCP for local / docker-compose hosts, TLS everywhere else (managed Postgres).
  return /(localhost|127\.0\.0\.1|@postgres[:/])/.test(databaseUrl)
    ? false
    : { rejectUnauthorized: false };
}

/** Shared by the Nest TypeOrmModule and the TypeORM CLI so both see the same options. */
export function buildDataSourceOptions(input: {
  databaseUrl: string;
  dbSsl: DbSslMode;
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
    ssl: resolveDbSsl(input.databaseUrl, input.dbSsl),
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
  }),
);

// TypeORM 1.x CLI requires exactly ONE exported DataSource instance (0.3 tolerated named + default).
export default AppDataSource;
