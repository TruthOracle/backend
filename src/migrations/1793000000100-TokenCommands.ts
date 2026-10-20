import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Token-app command ledger (docs/RAMP.md §3.4, §7): `to_token_commands` (one row per token-app
 * mint / burn, written before the POST) and `to_token_app_records` (the paged mirror of
 * token-app's records). The mirror's identity is a unique EXPRESSION index over
 * `coalesce(update_id, '')` / `coalesce(command_id, '')`: with plain nullable columns Postgres
 * treats NULLs as distinct and a record without either id would be re-inserted on every sync
 * pass (#14). Hand-written; `down()` drops what `up()` created (CI runs run / revert / run).
 */
export class TokenCommands1793000000100 implements MigrationInterface {
  name = "TokenCommands1793000000100";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "to_token_commands" ("command_id" text NOT NULL, "kind" text NOT NULL, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "party_id" text NOT NULL, "amount" numeric(38,10) NOT NULL, "source" text NOT NULL, "ref" text, "status" text NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT 0, "last_post_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "last_http_status" integer, "update_id" text, "recorded_amount" numeric(38,10), "recorded_at" TIMESTAMP WITH TIME ZONE, "resolved_by" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_token_commands" PRIMARY KEY ("command_id"), CONSTRAINT "CHK_to_token_commands_kind" CHECK ("kind" IN ('mint', 'burn')), CONSTRAINT "CHK_to_token_commands_source" CHECK ("source" IN ('ramp', 'admin', 'rewards', 'faucet', 'check', 'legacy')), CONSTRAINT "CHK_to_token_commands_status" CHECK ("status" IN ('pending', 'submitted', 'unknown', 'recorded', 'rejected', 'mismatch', 'abandoned')), CONSTRAINT "CHK_to_token_commands_amounts" CHECK ("amount" > 0 AND ("recorded_amount" IS NULL OR "recorded_amount" >= 0) AND "attempts" >= 0))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_token_commands_status" ON "to_token_commands" ("status")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_token_commands_instrument" ON "to_token_commands" ("instrument_id", "kind", "status")`,
    );
    await q.query(`CREATE INDEX "ix_to_token_commands_ref" ON "to_token_commands" ("ref")`);

    await q.query(
      `CREATE TABLE "to_token_app_records" ("id" BIGSERIAL NOT NULL, "kind" text NOT NULL, "command_id" text, "update_id" text, "instrument_id" text NOT NULL, "party_id" text NOT NULL, "amount" numeric(38,10) NOT NULL, "record_created_at" TIMESTAMP WITH TIME ZONE, "first_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_token_app_records" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_token_app_records_kind" CHECK ("kind" IN ('mint', 'burn')))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_token_app_records_identity" ON "to_token_app_records" ("kind", (coalesce("update_id", '')), (coalesce("command_id", '')), "party_id", "amount")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_token_app_records_command" ON "to_token_app_records" ("command_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_token_app_records_instrument" ON "to_token_app_records" ("instrument_id", "kind")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "to_token_app_records"`);
    await q.query(`DROP TABLE "to_token_commands"`);
  }
}
