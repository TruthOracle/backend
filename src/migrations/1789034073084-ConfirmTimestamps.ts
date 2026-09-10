import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Timestamps the confirm / retry loops reason about:
 *   - `to_deposit_credits.submitted_at` — when the row was (re-)armed; the confirm pass never fails
 *     a credit younger than DEPOSIT_CONFIRM_GRACE_MS (a re-armed row starts a fresh grace period,
 *     which `created_at` cannot express).
 *   - `to_kyc_webhook_events.last_attempt_at` — when the durable consumer last tried the row; the
 *     sweep re-arms exhausted rows only after a cooldown measured from here.
 */
export class ConfirmTimestamps1789034073084 implements MigrationInterface {
  name = "ConfirmTimestamps1789034073084";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "to_deposit_credits" ADD "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "to_kyc_webhook_events" ADD "last_attempt_at" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "to_kyc_webhook_events" DROP COLUMN "last_attempt_at"`);
    await queryRunner.query(`ALTER TABLE "to_deposit_credits" DROP COLUMN "submitted_at"`);
  }
}
