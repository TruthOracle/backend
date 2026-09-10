import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Initial schema — every table of docs/ARCHITECTURE.md §5, generated from the entities with
 * `typeorm migration:generate` and then hand-edited to (1) create the extensions the columns
 * need and (2) seed `to_settings.app_network` from the environment the migration runs in.
 * Regenerating against a migrated database must yield "No changes in database schema".
 */
export class Init1789034073083 implements MigrationInterface {
    name = 'Init1789034073083'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // citext backs every email column; pgcrypto is named for gen_random_uuid() (built in since PG13).
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext`);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
        await queryRunner.query(`CREATE TABLE "to_settings" ("key" text NOT NULL, "value" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_56b960e6569b05b8d490f640dd2" PRIMARY KEY ("key"))`);
        await queryRunner.query(`CREATE TABLE "to_users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "display_name" text, "avatar_url" text, "email" citext, "status" text NOT NULL DEFAULT 'active', "kyc_status" text NOT NULL DEFAULT 'none', "kyc_verification_id" uuid, "kyc_provider" text, "kyc_applicant_id" text, "party_id" text, "last_login_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b9fbc0303871fc9ed9ba477e805" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_users_party_id" ON "to_users"  ("party_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_users_kyc_applicant" ON "to_users"  ("kyc_provider", "kyc_applicant_id") `);
        await queryRunner.query(`CREATE TABLE "to_auth_identities" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "provider" text NOT NULL, "subject" text NOT NULL, "email" citext, "profile" jsonb NOT NULL DEFAULT '{}'::jsonb, "status" text NOT NULL DEFAULT 'active', "verified_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_used_at" TIMESTAMP WITH TIME ZONE, "unlinked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d1fcbe46842bd243ff7baee943b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_auth_identities_user_id" ON "to_auth_identities"  ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_auth_identities_provider_subject" ON "to_auth_identities"  ("provider", "subject") `);
        await queryRunner.query(`CREATE TABLE "to_wallets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "chain" text NOT NULL DEFAULT 'canton', "kind" text NOT NULL, "party_id" text NOT NULL, "public_key" text NOT NULL, "label" text, "is_primary" boolean NOT NULL DEFAULT false, "status" text NOT NULL DEFAULT 'active', "legacy_credited_cc" numeric(38,10) NOT NULL DEFAULT '0', "credited_cc" numeric(38,10) NOT NULL DEFAULT '0', "verified_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6b2bf66cbd555adc600d8a3718e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_wallets_user_id" ON "to_wallets"  ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_wallets_party_id" ON "to_wallets"  ("party_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_wallets_primary_per_user" ON "to_wallets"  ("user_id") WHERE "is_primary" = true AND "status" = 'active'`);
        await queryRunner.query(`CREATE TABLE "to_sessions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "auth_identity_id" uuid NOT NULL, "token_hash" text NOT NULL, "kind" text NOT NULL DEFAULT 'user', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_seen_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, "ip" text, "user_agent" text, CONSTRAINT "PK_41c51bd3c316dd298a0d3c0ca55" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_sessions_user_id" ON "to_sessions"  ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_sessions_token_hash" ON "to_sessions"  ("token_hash") `);
        await queryRunner.query(`CREATE TABLE "to_kyc_verifications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "provider" text NOT NULL, "provider_applicant_id" text, "level_name" text NOT NULL, "attempt_no" integer NOT NULL DEFAULT '1', "status" text NOT NULL DEFAULT 'initiated', "initiated_identity_id" uuid, "provider_event_at" TIMESTAMP WITH TIME ZONE, "reject_labels" jsonb, "moderation_comment" text, "manual" boolean NOT NULL DEFAULT false, "manual_reason" text, "reviewed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_85bf788e4eaa364dcf69ee4df37" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_kyc_verifications_user_id" ON "to_kyc_verifications"  ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_kyc_verifications_attempt" ON "to_kyc_verifications"  ("user_id", "provider", "level_name", "attempt_no") `);
        await queryRunner.query(`CREATE TABLE "to_kyc_persons" ("fingerprint" text NOT NULL, "kind" text NOT NULL, "user_id" uuid NOT NULL, "verification_id" uuid NOT NULL, "fingerprint_version" smallint NOT NULL DEFAULT '1', "bound_at" TIMESTAMP WITH TIME ZONE NOT NULL, "released_at" TIMESTAMP WITH TIME ZONE, "released_by" uuid, "release_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3a5a75850c06918fa2c89c66217" PRIMARY KEY ("fingerprint"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_kyc_persons_user_id" ON "to_kyc_persons"  ("user_id") `);
        await queryRunner.query(`CREATE TABLE "to_kyc_webhook_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "provider" text NOT NULL, "event_key" text NOT NULL, "type" text NOT NULL, "payload" jsonb, "sandbox" boolean NOT NULL DEFAULT false, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_69514b4525f9fe6b16311eb9cd9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_kyc_webhook_events_event_key" ON "to_kyc_webhook_events"  ("event_key") `);
        await queryRunner.query(`CREATE TABLE "to_payouts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "pending_payout_cid" text NOT NULL, "user_id" uuid, "payee_party" text NOT NULL, "payee_wallet_id" uuid, "amount_cc" numeric(38,10) NOT NULL, "reason" text NOT NULL, "status" text NOT NULL DEFAULT 'queued', "transfer_command_id" text, "wallet_create_command_id" text, "settle_command_id" text, "mark_paid_command_id" text, "attempts" integer NOT NULL DEFAULT '0', "last_error" text, "first_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL, "settled_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_76b7931cda6977c37f9520a0ef4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_payouts_pending_payout_cid" ON "to_payouts"  ("pending_payout_cid") `);
        await queryRunner.query(`CREATE INDEX "ix_to_payouts_user_id" ON "to_payouts"  ("user_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_payouts_status" ON "to_payouts"  ("status") `);
        await queryRunner.query(`CREATE TABLE "to_deposit_credits" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "owner_party" text NOT NULL, "command_id" text NOT NULL, "tx_ref" text NOT NULL, "amount_cc" numeric(38,10) NOT NULL, "attribution" jsonb NOT NULL DEFAULT '[]'::jsonb, "deposited_cc_before" numeric(38,10) NOT NULL, "wallet_cid_before" text, "status" text NOT NULL DEFAULT 'submitted', "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "confirmed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_79e716569b543f69bbca4bf0775" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_deposit_credits_user_id" ON "to_deposit_credits"  ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_deposit_credits_command_id" ON "to_deposit_credits"  ("command_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_deposit_credits_status" ON "to_deposit_credits"  ("status") `);
        await queryRunner.query(`CREATE TABLE "to_audit_events" ("id" BIGSERIAL NOT NULL, "actor_type" text NOT NULL, "actor_user_id" uuid, "actor_session_id" uuid, "action" text NOT NULL, "subject_type" text NOT NULL, "subject_id" text NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb, "ip" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0f102be5b5cf77e533d79bc848e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_audit_events_actor_user_id" ON "to_audit_events"  ("actor_user_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_audit_events_subject" ON "to_audit_events"  ("subject_type", "subject_id") `);
        await queryRunner.query(`ALTER TABLE "to_auth_identities" ADD CONSTRAINT "FK_582f57d0467c0c0da6d111941e5" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "to_wallets" ADD CONSTRAINT "FK_858f3793a96ab3fe2cd2907bb8f" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "to_sessions" ADD CONSTRAINT "FK_49becbbb778e2cb789827d7a130" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "to_sessions" ADD CONSTRAINT "FK_e3a0d04bcf72847bca3430dd5a0" FOREIGN KEY ("auth_identity_id") REFERENCES "to_auth_identities"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "to_kyc_verifications" ADD CONSTRAINT "FK_41526beccfef6cde673850e4763" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "to_kyc_verifications" ADD CONSTRAINT "FK_0baba53b144c6106e40d3a6202f" FOREIGN KEY ("initiated_identity_id") REFERENCES "to_auth_identities"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "to_kyc_persons" ADD CONSTRAINT "FK_1417d0a1096d9e9ed7fa0c7bd98" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "to_kyc_persons" ADD CONSTRAINT "FK_5f658e9d187447f8ce1f73d21cd" FOREIGN KEY ("verification_id") REFERENCES "to_kyc_verifications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "to_deposit_credits" ADD CONSTRAINT "FK_7d9120de70b2a4a242e53ae724e" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

        // The database is bound to the network it was created for (ARCHITECTURE §12 boot check).
        // Read from the environment the migration runs in; AppService refuses to boot on a mismatch.
        const network = (process.env.APP_NETWORK ?? "devnet").trim().toLowerCase() || "devnet";
        await queryRunner.query(
            `INSERT INTO "to_settings" ("key", "value") VALUES ('app_network', $1) ON CONFLICT ("key") DO NOTHING`,
            [network],
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "to_deposit_credits" DROP CONSTRAINT "FK_7d9120de70b2a4a242e53ae724e"`);
        await queryRunner.query(`ALTER TABLE "to_kyc_persons" DROP CONSTRAINT "FK_5f658e9d187447f8ce1f73d21cd"`);
        await queryRunner.query(`ALTER TABLE "to_kyc_persons" DROP CONSTRAINT "FK_1417d0a1096d9e9ed7fa0c7bd98"`);
        await queryRunner.query(`ALTER TABLE "to_kyc_verifications" DROP CONSTRAINT "FK_0baba53b144c6106e40d3a6202f"`);
        await queryRunner.query(`ALTER TABLE "to_kyc_verifications" DROP CONSTRAINT "FK_41526beccfef6cde673850e4763"`);
        await queryRunner.query(`ALTER TABLE "to_sessions" DROP CONSTRAINT "FK_e3a0d04bcf72847bca3430dd5a0"`);
        await queryRunner.query(`ALTER TABLE "to_sessions" DROP CONSTRAINT "FK_49becbbb778e2cb789827d7a130"`);
        await queryRunner.query(`ALTER TABLE "to_wallets" DROP CONSTRAINT "FK_858f3793a96ab3fe2cd2907bb8f"`);
        await queryRunner.query(`ALTER TABLE "to_auth_identities" DROP CONSTRAINT "FK_582f57d0467c0c0da6d111941e5"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_audit_events_subject"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_audit_events_actor_user_id"`);
        await queryRunner.query(`DROP TABLE "to_audit_events"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_deposit_credits_status"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_deposit_credits_command_id"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_deposit_credits_user_id"`);
        await queryRunner.query(`DROP TABLE "to_deposit_credits"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_payouts_status"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_payouts_user_id"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_payouts_pending_payout_cid"`);
        await queryRunner.query(`DROP TABLE "to_payouts"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_kyc_webhook_events_event_key"`);
        await queryRunner.query(`DROP TABLE "to_kyc_webhook_events"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_kyc_persons_user_id"`);
        await queryRunner.query(`DROP TABLE "to_kyc_persons"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_kyc_verifications_attempt"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_kyc_verifications_user_id"`);
        await queryRunner.query(`DROP TABLE "to_kyc_verifications"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_sessions_token_hash"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_sessions_user_id"`);
        await queryRunner.query(`DROP TABLE "to_sessions"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_wallets_primary_per_user"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_wallets_party_id"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_wallets_user_id"`);
        await queryRunner.query(`DROP TABLE "to_wallets"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_auth_identities_provider_subject"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_auth_identities_user_id"`);
        await queryRunner.query(`DROP TABLE "to_auth_identities"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_users_kyc_applicant"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_users_party_id"`);
        await queryRunner.query(`DROP TABLE "to_users"`);
        await queryRunner.query(`DROP TABLE "to_settings"`);
    }

}
