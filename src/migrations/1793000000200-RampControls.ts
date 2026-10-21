import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Ramp controls (SPEC §3.4 S4, §6): `to_ramp_controls` (the one halt row, key 'ramp'; no row = no
 * halt), `to_ramp_recon_runs` (every reconciliation run with its checks) and `to_admin_approvals`
 * (four-eyes requests; one PENDING request per action and subject — a partial unique index).
 * Hand-written; `down()` drops what `up()` created (CI runs run / revert / run).
 */
export class RampControls1793000000200 implements MigrationInterface {
  name = "RampControls1793000000200";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "to_ramp_controls" ("key" text NOT NULL, "halted_scopes" text[] NOT NULL DEFAULT '{}', "reason" text, "source" text, "failing_checks" jsonb, "since" TIMESTAMP WITH TIME ZONE, "set_by_user_id" uuid, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_controls" PRIMARY KEY ("key"), CONSTRAINT "CHK_to_ramp_controls_key" CHECK ("key" = 'ramp'), CONSTRAINT "CHK_to_ramp_controls_scopes" CHECK ("halted_scopes" <@ ARRAY['orders', 'mints', 'payouts']::text[]), CONSTRAINT "CHK_to_ramp_controls_source" CHECK ("source" IS NULL OR "source" IN ('admin', 'auto')))`,
    );

    await q.query(
      `CREATE TABLE "to_ramp_recon_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "trigger" text NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, "status" text NOT NULL DEFAULT 'unknown', "checks" jsonb NOT NULL DEFAULT '[]'::jsonb, "halted" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_to_ramp_recon_runs" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_ramp_recon_runs_trigger" CHECK ("trigger" IN ('schedule', 'admin', 'pre_batch', 'sync')), CONSTRAINT "CHK_to_ramp_recon_runs_status" CHECK ("status" IN ('green', 'amber', 'red', 'unknown')))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_recon_runs_trigger_started" ON "to_ramp_recon_runs" ("trigger", "started_at")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_recon_runs_started" ON "to_ramp_recon_runs" ("started_at")`,
    );

    await q.query(
      `CREATE TABLE "to_admin_approvals" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "action" text NOT NULL, "subject_type" text NOT NULL, "subject_id" text NOT NULL, "params" jsonb NOT NULL DEFAULT '{}'::jsonb, "params_hash" text NOT NULL, "precondition" jsonb, "reason" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "requested_by_user_id" uuid NOT NULL, "requested_by_party" text NOT NULL, "requested_by_person" text NOT NULL, "requested_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "decided_by_user_id" uuid, "decided_by_party" text, "decided_by_person" text, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_reason" text, "decision_signature" text, "executed_at" TIMESTAMP WITH TIME ZONE, "result" jsonb, "error" text, "single_control" boolean NOT NULL DEFAULT false, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_admin_approvals" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_admin_approvals_status" CHECK ("status" IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired', 'cancelled')), CONSTRAINT "CHK_to_admin_approvals_hash" CHECK ("params_hash" ~ '^[0-9a-f]{64}$'))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_admin_approvals_pending" ON "to_admin_approvals" ("action", "subject_type", "subject_id") WHERE "status" = 'pending'`,
    );
    await q.query(
      `CREATE INDEX "ix_to_admin_approvals_status" ON "to_admin_approvals" ("status", "requested_at")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_admin_approvals_subject" ON "to_admin_approvals" ("subject_type", "subject_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "to_admin_approvals"`);
    await q.query(`DROP TABLE "to_ramp_recon_runs"`);
    await q.query(`DROP TABLE "to_ramp_controls"`);
  }
}
