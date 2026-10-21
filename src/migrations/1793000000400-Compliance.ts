import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Compliance (SPEC §3.4 S7a, §11): `to_kyc_identities` (the verified art.8 identity of an account,
 * sealed with AAD `kyc-id|<userId>`; plain columns only for what the rules filter on; never
 * deleted) and `to_kyc_identity_versions` (every identity it was ever verified with, APPEND-ONLY,
 * valid_from / valid_to — the register reads the one an operation was made under; C14),
 * `to_ramp_consents` (APPEND-ONLY: a trigger refuses DELETE and every UPDATE except a re-seal of a
 * sealed value, B4, R4) and `to_compliance_alerts` (one per user, rule and window). Orders get their
 * consent's foreign key; alerts reference orders by id only (a create-point alert names an order
 * that may never exist). Nothing here is ever deleted by a job (≥ 5 years, R4). Hand-written;
 * `down()` drops what `up()` created (CI runs run / revert / run).
 */
export class Compliance1793000000400 implements MigrationInterface {
  name = "Compliance1793000000400";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "to_kyc_identities" ("user_id" uuid NOT NULL, "provider" text NOT NULL, "applicant_id" text NOT NULL, "level_name" text, "verified_at" TIMESTAMP WITH TIME ZONE, "refreshed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "refresh_due_at" TIMESTAMP WITH TIME ZONE, "identity_sealed" text NOT NULL, "citizenship" text, "residence_country" text, "doc_expires_at" date, "risk_level" text NOT NULL DEFAULT 'low', "vendor_pep" boolean, "vendor_sanctions" boolean, "vendor_adverse_media" boolean, "aml_labels" text[] NOT NULL DEFAULT '{}', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_kyc_identities" PRIMARY KEY ("user_id"), CONSTRAINT "CHK_to_kyc_identities_risk" CHECK ("risk_level" IN ('low', 'medium', 'high')), CONSTRAINT "CHK_to_kyc_identities_countries" CHECK (("citizenship" IS NULL OR "citizenship" ~ '^[A-Z]{2}$') AND ("residence_country" IS NULL OR "residence_country" ~ '^[A-Z]{2}$')), CONSTRAINT "CHK_to_kyc_identities_sealed" CHECK ("identity_sealed" LIKE 'v2.%'))`,
    );
    await q.query(
      `ALTER TABLE "to_kyc_identities" ADD CONSTRAINT "FK_to_kyc_identities_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    // R4: an identity row is never deleted (its history is the versions below).
    await q.query(
      `CREATE FUNCTION "to_kyc_identities_retained"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'to_kyc_identities rows are retained (R4): DELETE is refused'; END $$`,
    );
    await q.query(
      `CREATE TRIGGER "trg_to_kyc_identities_retained" BEFORE DELETE ON "to_kyc_identities" FOR EACH ROW EXECUTE FUNCTION "to_kyc_identities_retained"()`,
    );
    // C14 (R4, ПВК p.43): every identity the account was verified with, append-only — a refresh that
    // changes anything closes the open version (valid_to) and adds the next; nothing is overwritten.
    await q.query(
      `CREATE TABLE "to_kyc_identity_versions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "version" integer NOT NULL, "provider" text NOT NULL, "applicant_id" text NOT NULL, "verification_id" uuid, "level_name" text, "verified_at" TIMESTAMP WITH TIME ZONE, "identity_sealed" text NOT NULL, "citizenship" text, "residence_country" text, "doc_expires_at" date, "risk_level" text NOT NULL, "vendor_pep" boolean, "vendor_sanctions" boolean, "vendor_adverse_media" boolean, "aml_labels" text[] NOT NULL DEFAULT '{}', "changed_fields" text[] NOT NULL DEFAULT '{}', "valid_from" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "valid_to" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_to_kyc_identity_versions" PRIMARY KEY ("id"), CONSTRAINT "FK_to_kyc_identity_versions_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT, CONSTRAINT "CHK_to_kyc_identity_versions_sealed" CHECK ("identity_sealed" LIKE 'v2.%'), CONSTRAINT "CHK_to_kyc_identity_versions_risk" CHECK ("risk_level" IN ('low', 'medium', 'high')), CONSTRAINT "CHK_to_kyc_identity_versions_valid" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"), CONSTRAINT "CHK_to_kyc_identity_versions_version" CHECK ("version" >= 1))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_kyc_identity_versions_version" ON "to_kyc_identity_versions" ("user_id", "version")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_kyc_identity_versions_open" ON "to_kyc_identity_versions" ("user_id") WHERE "valid_to" IS NULL`,
    );
    // Append-only: no DELETE; an UPDATE may only close the open version (valid_to, nothing else) or
    // re-seal identity_sealed (key rotation, nothing else).
    await q.query(
      `CREATE FUNCTION "to_kyc_identity_versions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'to_kyc_identity_versions is append-only: DELETE refused'; END IF; IF (NEW."id", NEW."user_id", NEW."version", NEW."provider", NEW."applicant_id", NEW."verification_id", NEW."level_name", NEW."verified_at", NEW."citizenship", NEW."residence_country", NEW."doc_expires_at", NEW."risk_level", NEW."vendor_pep", NEW."vendor_sanctions", NEW."vendor_adverse_media", NEW."aml_labels", NEW."changed_fields", NEW."valid_from") IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."version", OLD."provider", OLD."applicant_id", OLD."verification_id", OLD."level_name", OLD."verified_at", OLD."citizenship", OLD."residence_country", OLD."doc_expires_at", OLD."risk_level", OLD."vendor_pep", OLD."vendor_sanctions", OLD."vendor_adverse_media", OLD."aml_labels", OLD."changed_fields", OLD."valid_from") OR (NEW."valid_to" IS DISTINCT FROM OLD."valid_to" AND (OLD."valid_to" IS NOT NULL OR NEW."identity_sealed" IS DISTINCT FROM OLD."identity_sealed")) THEN RAISE EXCEPTION 'to_kyc_identity_versions is append-only: only closing a version or a re-seal may change a row'; END IF; RETURN NEW; END $$`,
    );
    await q.query(
      `CREATE TRIGGER "trg_to_kyc_identity_versions_append_only" BEFORE UPDATE OR DELETE ON "to_kyc_identity_versions" FOR EACH ROW EXECUTE FUNCTION "to_kyc_identity_versions_append_only"()`,
    );

    await q.query(
      `CREATE TABLE "to_ramp_consents" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "terms_version" text NOT NULL, "accepted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "ip" text, "user_agent" text, "acts_for_self" boolean NOT NULL, "principal_sealed" text, "pep_declared" boolean NOT NULL, "pep_detail_sealed" text, CONSTRAINT "PK_to_ramp_consents" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_ramp_consents_principal" CHECK ("acts_for_self" OR "principal_sealed" IS NOT NULL), CONSTRAINT "CHK_to_ramp_consents_pep_detail" CHECK ("pep_declared" OR "pep_detail_sealed" IS NULL))`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_consents" ADD CONSTRAINT "FK_to_ramp_consents_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_consents_user_terms" ON "to_ramp_consents" ("user_id", "terms_version", "accepted_at")`,
    );
    // Append-only (B4, R4): a consent is evidence. Only a re-seal (key rotation) may rewrite a sealed
    // value, and never turn one into NULL or back.
    await q.query(
      `CREATE FUNCTION "to_ramp_consents_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'to_ramp_consents is append-only: DELETE refused'; END IF; IF (NEW."id", NEW."user_id", NEW."terms_version", NEW."accepted_at", NEW."ip", NEW."user_agent", NEW."acts_for_self", NEW."pep_declared") IS DISTINCT FROM (OLD."id", OLD."user_id", OLD."terms_version", OLD."accepted_at", OLD."ip", OLD."user_agent", OLD."acts_for_self", OLD."pep_declared") OR (NEW."principal_sealed" IS NULL) <> (OLD."principal_sealed" IS NULL) OR (NEW."pep_detail_sealed" IS NULL) <> (OLD."pep_detail_sealed" IS NULL) THEN RAISE EXCEPTION 'to_ramp_consents is append-only: only a re-seal may rewrite a sealed value'; END IF; RETURN NEW; END $$`,
    );
    await q.query(
      `CREATE TRIGGER "trg_to_ramp_consents_append_only" BEFORE UPDATE OR DELETE ON "to_ramp_consents" FOR EACH ROW EXECUTE FUNCTION "to_ramp_consents_append_only"()`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_consent" FOREIGN KEY ("consent_id") REFERENCES "to_ramp_consents"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(`CREATE INDEX "ix_to_ramp_orders_consent" ON "to_ramp_orders" ("consent_id")`);

    await q.query(
      `CREATE TABLE "to_compliance_alerts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "rule" text NOT NULL, "point" text, "severity" text NOT NULL, "order_id" uuid, "figures" jsonb NOT NULL DEFAULT '{}'::jsonb, "window_key" text NOT NULL, "status" text NOT NULL DEFAULT 'open', "due_at" TIMESTAMP WITH TIME ZONE, "rules_version" text NOT NULL, "bv_byn" numeric(38,10), "decided_by_user_id" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_reason" text, "report_ref" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_compliance_alerts" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_compliance_alerts_severity" CHECK ("severity" IN ('info', 'review', 'block')), CONSTRAINT "CHK_to_compliance_alerts_status" CHECK ("status" IN ('open', 'cleared', 'escalated', 'reported', 'returned')), CONSTRAINT "CHK_to_compliance_alerts_report" CHECK ("status" <> 'reported' OR "report_ref" IS NOT NULL), CONSTRAINT "CHK_to_compliance_alerts_decided" CHECK ("status" = 'open' OR "decided_at" IS NOT NULL))`,
    );
    await q.query(
      `ALTER TABLE "to_compliance_alerts" ADD CONSTRAINT "FK_to_compliance_alerts_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_compliance_alerts_window" ON "to_compliance_alerts" ("user_id", "rule", "window_key")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_compliance_alerts_status_due" ON "to_compliance_alerts" ("status", "due_at")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_compliance_alerts_order" ON "to_compliance_alerts" ("order_id") WHERE "order_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX "ix_to_compliance_alerts_user" ON "to_compliance_alerts" ("user_id", "created_at")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_compliance_alerts_created" ON "to_compliance_alerts" ("created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "to_compliance_alerts"`);
    await q.query(`DROP INDEX "ix_to_ramp_orders_consent"`);
    await q.query(`ALTER TABLE "to_ramp_orders" DROP CONSTRAINT "FK_to_ramp_orders_consent"`);
    await q.query(`DROP TABLE "to_ramp_consents"`);
    await q.query(`DROP FUNCTION "to_ramp_consents_append_only"()`);
    await q.query(`DROP TABLE "to_kyc_identity_versions"`);
    await q.query(`DROP FUNCTION "to_kyc_identity_versions_append_only"()`);
    await q.query(`DROP TABLE "to_kyc_identities"`);
    await q.query(`DROP FUNCTION "to_kyc_identities_retained"()`);
  }
}
