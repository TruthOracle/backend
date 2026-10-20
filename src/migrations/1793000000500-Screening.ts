import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Screening and freezes (SPEC §3.4 S7b, §11.6; B1, B3): `to_compliance_freezes` (one ACTIVE freeze
 * per account — a partial unique index; `provisional` = placed by a list hit, awaiting the AML
 * decision; `activity_offset` = the ledger offset up to which the account's on-ledger activity was
 * checked for TM-FROZEN-ACTIVITY), `to_screening_lists` (one row per imported list version),
 * `to_screening_entries` (name-fold keys, birth date, ids), `to_screening_hits` (one per list
 * version, entry and account), plus two additions: `to_screening_runs` (every re-screen — the
 * record that every client was screened at least every RAMP_RESCREEN_DAYS) and
 * `to_screening_subjects` (when each account was last screened, against which list versions, which
 * KYC verification, which party ids and which latest consent — a change re-screens before the next
 * order, C27 / C13 — and, when its identity could not be read, why: the account stays refused and
 * a full re-screen still completes, C44).
 * Retention (R4, ≥ 5 years): a trigger refuses DELETE on all six. Hand-written; `down()` drops what
 * `up()` created (CI runs run / revert / run).
 */
export class Screening1793000000500 implements MigrationInterface {
  name = "Screening1793000000500";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "to_compliance_freezes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "reason" text NOT NULL, "source" text NOT NULL, "provisional" boolean NOT NULL DEFAULT false, "active" boolean NOT NULL DEFAULT true, "created_by_user_id" uuid, "created_by_person" text, "lift_approval_id" uuid, "lifted_by_user_id" uuid, "lift_reason" text, "lifted_at" TIMESTAMP WITH TIME ZONE, "activity_offset" bigint NOT NULL DEFAULT 0, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_compliance_freezes" PRIMARY KEY ("id"), CONSTRAINT "FK_to_compliance_freezes_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT, CONSTRAINT "CHK_to_compliance_freezes_source" CHECK ("source" IN ('screening', 'sanctions', 'aml', 'manual', 'court')), CONSTRAINT "CHK_to_compliance_freezes_reason" CHECK (length(btrim("reason")) > 0), CONSTRAINT "CHK_to_compliance_freezes_lifted" CHECK (("active" AND "lifted_at" IS NULL) OR (NOT "active" AND "lifted_at" IS NOT NULL)))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_compliance_freezes_active_user" ON "to_compliance_freezes" ("user_id") WHERE "active"`,
    );
    await q.query(
      `CREATE INDEX "ix_to_compliance_freezes_user" ON "to_compliance_freezes" ("user_id", "created_at")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_compliance_freezes_active" ON "to_compliance_freezes" ("active", "created_at")`,
    );

    await q.query(
      `CREATE TABLE "to_screening_lists" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "list" text NOT NULL, "version" text NOT NULL, "delivered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "imported_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "imported_by_user_id" uuid, "imported_by_person" text, "charset" text NOT NULL DEFAULT 'utf-8', "sha256" text NOT NULL, "entry_count" integer NOT NULL, CONSTRAINT "PK_to_screening_lists" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_screening_lists_list" CHECK ("list" IN ('by_terror', 'un', 'decree48', 'foreign')), CONSTRAINT "CHK_to_screening_lists_version" CHECK (length("version") BETWEEN 1 AND 64), CONSTRAINT "CHK_to_screening_lists_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'), CONSTRAINT "CHK_to_screening_lists_count" CHECK ("entry_count" >= 0))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_screening_lists_version" ON "to_screening_lists" ("list", "version")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_screening_lists_latest" ON "to_screening_lists" ("list", "imported_at")`,
    );

    await q.query(
      `CREATE TABLE "to_screening_entries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "list_id" uuid NOT NULL, "line" integer NOT NULL, "kind" text NOT NULL, "names" text[] NOT NULL DEFAULT '{}', "name_keys" text[] NOT NULL DEFAULT '{}', "birth_date" text, "ids" text[] NOT NULL DEFAULT '{}', CONSTRAINT "PK_to_screening_entries" PRIMARY KEY ("id"), CONSTRAINT "FK_to_screening_entries_list" FOREIGN KEY ("list_id") REFERENCES "to_screening_lists"("id") ON DELETE RESTRICT, CONSTRAINT "CHK_to_screening_entries_kind" CHECK ("kind" IN ('person', 'org', 'address')), CONSTRAINT "CHK_to_screening_entries_birth_date" CHECK ("birth_date" IS NULL OR "birth_date" ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$'))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_screening_entries_list" ON "to_screening_entries" ("list_id", "line")`,
    );

    await q.query(
      `CREATE TABLE "to_screening_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "trigger" text NOT NULL, "scope" text NOT NULL, "user_id" uuid, "list_ids" uuid[] NOT NULL DEFAULT '{}', "status" text NOT NULL DEFAULT 'running', "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, "started_by_user_id" uuid, "subjects" integer NOT NULL DEFAULT 0, "identities" integer NOT NULL DEFAULT 0, "parties" integer NOT NULL DEFAULT 0, "hits" integer NOT NULL DEFAULT 0, "failures" integer NOT NULL DEFAULT 0, "unreadable" integer NOT NULL DEFAULT 0, "error" text, CONSTRAINT "PK_to_screening_runs" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_screening_runs_trigger" CHECK ("trigger" IN ('import', 'schedule', 'admin', 'user')), CONSTRAINT "CHK_to_screening_runs_scope" CHECK (("scope" = 'full' AND "user_id" IS NULL) OR ("scope" = 'user' AND "user_id" IS NOT NULL)), CONSTRAINT "CHK_to_screening_runs_status" CHECK ("status" IN ('running', 'done', 'partial', 'failed')))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_screening_runs_scope_started" ON "to_screening_runs" ("scope", "started_at")`,
    );

    await q.query(
      `CREATE TABLE "to_screening_subjects" ("user_id" uuid NOT NULL, "screened_at" TIMESTAMP WITH TIME ZONE NOT NULL, "run_id" uuid NOT NULL, "list_ids" uuid[] NOT NULL DEFAULT '{}', "identity" boolean NOT NULL, "kyc_verification_id" uuid, "identity_refreshed_at" TIMESTAMP WITH TIME ZONE, "parties" integer NOT NULL DEFAULT 0, "party_ids" text[] NOT NULL DEFAULT '{}', "consent_id" uuid, "identity_error" text, "identity_unreadable_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_to_screening_subjects" PRIMARY KEY ("user_id"), CONSTRAINT "FK_to_screening_subjects_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT, CONSTRAINT "FK_to_screening_subjects_run" FOREIGN KEY ("run_id") REFERENCES "to_screening_runs"("id") ON DELETE RESTRICT)`,
    );

    await q.query(
      `CREATE TABLE "to_screening_hits" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "list_id" uuid NOT NULL, "entry_id" uuid NOT NULL, "user_id" uuid NOT NULL, "run_id" uuid, "match" jsonb NOT NULL DEFAULT '{}'::jsonb, "status" text NOT NULL DEFAULT 'open', "alert_id" text, "freeze_id" uuid, "decided_by_user_id" uuid, "decided_by_person" text, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_reason" text, "decision_approval_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_screening_hits" PRIMARY KEY ("id"), CONSTRAINT "FK_to_screening_hits_list" FOREIGN KEY ("list_id") REFERENCES "to_screening_lists"("id") ON DELETE RESTRICT, CONSTRAINT "FK_to_screening_hits_entry" FOREIGN KEY ("entry_id") REFERENCES "to_screening_entries"("id") ON DELETE RESTRICT, CONSTRAINT "FK_to_screening_hits_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT, CONSTRAINT "FK_to_screening_hits_run" FOREIGN KEY ("run_id") REFERENCES "to_screening_runs"("id") ON DELETE RESTRICT, CONSTRAINT "FK_to_screening_hits_freeze" FOREIGN KEY ("freeze_id") REFERENCES "to_compliance_freezes"("id") ON DELETE RESTRICT, CONSTRAINT "CHK_to_screening_hits_status" CHECK ("status" IN ('open', 'confirmed', 'cleared')), CONSTRAINT "CHK_to_screening_hits_decided" CHECK (("status" = 'open') = ("decided_at" IS NULL)))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_screening_hits_entry_user" ON "to_screening_hits" ("list_id", "entry_id", "user_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_screening_hits_user" ON "to_screening_hits" ("user_id", "status")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_screening_hits_status" ON "to_screening_hits" ("status", "created_at")`,
    );

    // R4 (≥ 5 years after the relationship ends): these rows are never deleted.
    await q.query(
      `CREATE FUNCTION "to_compliance_no_delete"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% rows are retained (SPEC §11.6, R4): DELETE is refused', TG_TABLE_NAME; END $$`,
    );
    for (const table of RETAINED)
      await q.query(
        `CREATE TRIGGER "trg_${table}_no_delete" BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "to_compliance_no_delete"()`,
      );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "to_screening_hits"`);
    await q.query(`DROP TABLE "to_screening_subjects"`);
    await q.query(`DROP TABLE "to_screening_runs"`);
    await q.query(`DROP TABLE "to_screening_entries"`);
    await q.query(`DROP TABLE "to_screening_lists"`);
    await q.query(`DROP TABLE "to_compliance_freezes"`);
    await q.query(`DROP FUNCTION "to_compliance_no_delete"()`);
  }
}

const RETAINED = [
  "to_compliance_freezes",
  "to_screening_lists",
  "to_screening_entries",
  "to_screening_runs",
  "to_screening_subjects",
  "to_screening_hits",
] as const;
