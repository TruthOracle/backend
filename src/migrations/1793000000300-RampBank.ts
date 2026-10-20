import type { MigrationInterface, QueryRunner } from "typeorm";

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

const ACCOUNT_STATUSES = ["cooling_off", "pending_proof", "active", "removed", "blocked"];
const PROOFS = ["bank_name_check", "payer_match", "manual"];
const NAME_FORMS = ["be", "ru", "lat"];
const BATCH_STATUSES = [
  "draft",
  "approved",
  "exported",
  "submitted",
  "settled",
  "cancelled",
  "voided",
];
const ITEM_STATUSES = ["included", "paid", "returned", "voided", "unpaid"];
const MATCH_KINDS = [
  "payout",
  "payout_batch",
  "payout_return",
  "refund",
  "refund_return",
  "psp_settlement",
  "psp_funding",
  "bank_fee",
  "operator_topup",
  "operator_sweep",
  "suspense",
];
const FLAGS = ["reference_credit", "iban_mismatch", "payout_duplicate"];

/**
 * The bank rail (SPEC §3.4 S6, §10): user bank accounts (sealed IBAN + keyed blind index, unique
 * among non-removed accounts), payout batches and their items (document numbers from one
 * sequence; one LIVE item per order), client-money statements (one chain per account: one first
 * statement, no fork, one confirmed copy per file) and their lines. Also the foreign keys S5 left
 * for this stage (orders → accounts / batches) and the journal's link to statement lines: a line
 * may carry ONE posting per kind on its own (line-scoped kinds) and one per order (a batch-total
 * debit books every item's `offramp.paid_bank` on the same line). `down()` restores what it changed.
 */
export class RampBank1793000000300 implements MigrationInterface {
  name = "RampBank1793000000300";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "to_ramp_bank_accounts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "iban_sealed" text NOT NULL, "iban_hash" text NOT NULL, "iban_hash_kid" text NOT NULL, "iban_last4" text NOT NULL, "country" text NOT NULL DEFAULT 'BY', "bank_code" text NOT NULL, "bic" text NOT NULL, "bank_name" text NOT NULL, "name_form" text NOT NULL, "status" text NOT NULL, "cooling_off_until" TIMESTAMP WITH TIME ZONE NOT NULL, "proof" text, "proof_ref" text, "verified_at" TIMESTAMP WITH TIME ZONE, "first_payout_order_id" uuid, "last_used_at" TIMESTAMP WITH TIME ZONE, "removed_at" TIMESTAMP WITH TIME ZONE, "blocked_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_bank_accounts" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "FK_to_ramp_bank_accounts_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT, ` +
        `CONSTRAINT "CHK_to_ramp_bank_accounts_status" CHECK ("status" IN (${list(ACCOUNT_STATUSES)})), ` +
        `CONSTRAINT "CHK_to_ramp_bank_accounts_proof" CHECK ("proof" IS NULL OR "proof" IN (${list(PROOFS)})), ` +
        `CONSTRAINT "CHK_to_ramp_bank_accounts_active" CHECK ("status" <> 'active' OR ("proof" IS NOT NULL AND "verified_at" IS NOT NULL)), ` +
        `CONSTRAINT "CHK_to_ramp_bank_accounts_name_form" CHECK ("name_form" IN (${list(NAME_FORMS)})), ` +
        `CONSTRAINT "CHK_to_ramp_bank_accounts_codes" CHECK ("country" = 'BY' AND "bank_code" ~ '^[A-Z0-9]{4}$' AND "iban_last4" ~ '^[A-Z0-9]{4}$'), ` +
        `CONSTRAINT "CHK_to_ramp_bank_accounts_sealed" CHECK ("iban_sealed" LIKE 'v2.%'))`,
    );
    // One live account per IBAN across ALL users (a hit on another user is TM-SHAREDIBAN).
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_bank_accounts_iban" ON "to_ramp_bank_accounts" ("iban_hash") WHERE "status" <> 'removed'`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_bank_accounts_user" ON "to_ramp_bank_accounts" ("user_id", "status")`,
    );

    await q.query(
      `CREATE TABLE "to_ramp_payout_batches" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "status" text NOT NULL, "currency" text NOT NULL, "item_count" integer NOT NULL DEFAULT 0, "total_amount" numeric(38,10) NOT NULL, "created_by_user_id" uuid NOT NULL, "created_by_person" text NOT NULL, "approval_id" uuid, "file_format" text, "file_sha256" text, "exported_at" TIMESTAMP WITH TIME ZONE, "exported_by_user_id" uuid, "export_count" integer NOT NULL DEFAULT 0, "submitted_at" TIMESTAMP WITH TIME ZONE, "submitted_by_user_id" uuid, "bank_reference" text, "settled_at" TIMESTAMP WITH TIME ZONE, "void_approval_id" uuid, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_payout_batches" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "CHK_to_ramp_payout_batches_status" CHECK ("status" IN (${list(BATCH_STATUSES)})), ` +
        `CONSTRAINT "CHK_to_ramp_payout_batches_figures" CHECK ("item_count" >= 0 AND "total_amount" >= 0 AND "export_count" >= 0), ` +
        `CONSTRAINT "CHK_to_ramp_payout_batches_file" CHECK ("file_sha256" IS NULL OR "file_sha256" ~ '^[0-9a-f]{64}$'), ` +
        // A file exists exactly from the first export on; it never comes back to draft / approved.
        `CONSTRAINT "CHK_to_ramp_payout_batches_exported" CHECK (("status" IN ('draft', 'approved')) OR "status" = 'cancelled' OR ("file_sha256" IS NOT NULL AND "exported_at" IS NOT NULL)))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_payout_batches_status" ON "to_ramp_payout_batches" ("status", "created_at")`,
    );

    // Document numbers are unique across batches: a debit quoting one names one item.
    await q.query(`CREATE SEQUENCE "to_ramp_payout_document_no_seq" START 1`);
    await q.query(
      `CREATE TABLE "to_ramp_payout_batch_items" ("batch_id" uuid NOT NULL, "order_id" uuid NOT NULL, "kind" text NOT NULL, "document_no" text NOT NULL, "amount" numeric(38,10) NOT NULL, "user_id" uuid NOT NULL, "bank_account_id" uuid NOT NULL, "iban_hash" text NOT NULL, "iban_hash_kid" text NOT NULL, "status" text NOT NULL DEFAULT 'included', "paid_line_id" uuid, "returned_line_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_payout_batch_items" PRIMARY KEY ("batch_id", "order_id"), ` +
        `CONSTRAINT "FK_to_ramp_payout_batch_items_batch" FOREIGN KEY ("batch_id") REFERENCES "to_ramp_payout_batches"("id") ON DELETE RESTRICT, ` +
        `CONSTRAINT "FK_to_ramp_payout_batch_items_order" FOREIGN KEY ("order_id") REFERENCES "to_ramp_orders"("id") ON DELETE RESTRICT, ` +
        `CONSTRAINT "FK_to_ramp_payout_batch_items_account" FOREIGN KEY ("bank_account_id") REFERENCES "to_ramp_bank_accounts"("id") ON DELETE RESTRICT, ` +
        `CONSTRAINT "CHK_to_ramp_payout_batch_items_kind" CHECK ("kind" IN ('payout', 'refund')), ` +
        `CONSTRAINT "CHK_to_ramp_payout_batch_items_status" CHECK ("status" IN (${list(ITEM_STATUSES)})), ` +
        `CONSTRAINT "CHK_to_ramp_payout_batch_items_figures" CHECK ("amount" > 0 AND "document_no" ~ '^[0-9]{1,18}$'))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_payout_batch_items_document" ON "to_ramp_payout_batch_items" ("document_no")`,
    );
    // An order is in at most one live batch.
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_payout_batch_items_live" ON "to_ramp_payout_batch_items" ("order_id") WHERE "status" = 'included'`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_payout_batch_items_order" ON "to_ramp_payout_batch_items" ("order_id")`,
    );

    await q.query(
      `CREATE TABLE "to_ramp_bank_statements" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_iban" text NOT NULL, "format" text NOT NULL, "file_sha256" text NOT NULL, "canonical_hash" text NOT NULL, "canonical_kid" text NOT NULL, "period_from" date NOT NULL, "period_to" date NOT NULL, "opening_balance" numeric(38,10) NOT NULL, "closing_balance" numeric(38,10) NOT NULL, "currency" text NOT NULL, "prev_statement_id" uuid, "status" text NOT NULL DEFAULT 'draft', "imported_by_user_id" uuid NOT NULL, "imported_by_person" text NOT NULL, "approval_id" uuid, "second_copy_person" text, "second_copy_at" TIMESTAMP WITH TIME ZONE, "confirmed_at" TIMESTAMP WITH TIME ZONE, "line_count" integer NOT NULL DEFAULT 0, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_bank_statements" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "FK_to_ramp_bank_statements_prev" FOREIGN KEY ("prev_statement_id") REFERENCES "to_ramp_bank_statements"("id") ON DELETE RESTRICT, ` +
        `CONSTRAINT "CHK_to_ramp_bank_statements_format" CHECK ("format" IN ('csv', 'camt053')), ` +
        `CONSTRAINT "CHK_to_ramp_bank_statements_status" CHECK ("status" IN ('draft', 'confirmed', 'rejected')), ` +
        `CONSTRAINT "CHK_to_ramp_bank_statements_period" CHECK ("period_from" <= "period_to"), ` +
        `CONSTRAINT "CHK_to_ramp_bank_statements_hashes" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$' AND "canonical_hash" ~ '^[0-9a-f]{64}$'), ` +
        `CONSTRAINT "CHK_to_ramp_bank_statements_confirmed" CHECK (("status" = 'confirmed') = ("confirmed_at" IS NOT NULL)))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_bank_statements_file" ON "to_ramp_bank_statements" ("file_sha256") WHERE "status" <> 'rejected'`,
    );
    // One chain per account: one first statement, and no confirmed statement has two successors.
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_bank_statements_first" ON "to_ramp_bank_statements" ("account_iban") WHERE "status" = 'confirmed' AND "prev_statement_id" IS NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_bank_statements_next" ON "to_ramp_bank_statements" ("prev_statement_id") WHERE "status" = 'confirmed'`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_bank_statements_status" ON "to_ramp_bank_statements" ("status", "period_to")`,
    );

    await q.query(
      `CREATE TABLE "to_ramp_bank_lines" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "statement_id" uuid NOT NULL, "line_ref" text NOT NULL, "booking_date" date NOT NULL, "value_date" date, "amount" numeric(38,10) NOT NULL, "currency" text NOT NULL, "counterparty_iban_hash" text, "counterparty_iban_hash_kid" text, "counterparty_iban_last4" text, "counterparty_bic" text, "bank_tx_code" text, "return_info" boolean NOT NULL DEFAULT false, "return_code" text, "reference" text, "document_no" text, "raw_sealed" text NOT NULL, "match_kind" text, "matched_order_id" uuid, "matched_batch_id" uuid, "status" text NOT NULL DEFAULT 'unmatched', "flags" text[] NOT NULL DEFAULT '{}', "approval_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_bank_lines" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "FK_to_ramp_bank_lines_statement" FOREIGN KEY ("statement_id") REFERENCES "to_ramp_bank_statements"("id") ON DELETE RESTRICT, ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_amount" CHECK ("amount" <> 0), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_status" CHECK ("status" IN ('unmatched', 'proposed', 'matched') AND (("status" = 'unmatched') = ("match_kind" IS NULL))), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_kind" CHECK ("match_kind" IS NULL OR "match_kind" IN (${list(MATCH_KINDS)})), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_flags" CHECK ("flags" <@ ARRAY[${list(FLAGS)}]::text[]), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_reference" CHECK ("reference" IS NULL OR "reference" ~ '^TO[0-9]{12}$'), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_iban" CHECK (("counterparty_iban_hash" IS NULL) = ("counterparty_iban_hash_kid" IS NULL)), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_sealed" CHECK ("raw_sealed" LIKE 'v2.%'))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_bank_lines_ref" ON "to_ramp_bank_lines" ("statement_id", "line_ref")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_bank_lines_reference" ON "to_ramp_bank_lines" ("reference") WHERE "reference" IS NOT NULL`,
    );
    await q.query(`CREATE INDEX "ix_to_ramp_bank_lines_status" ON "to_ramp_bank_lines" ("status")`);

    // S5's order columns get their foreign keys (SPEC §3.1).
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_bank_account" FOREIGN KEY ("bank_account_id") REFERENCES "to_ramp_bank_accounts"("id") ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_payout_batch" FOREIGN KEY ("payout_batch_id") REFERENCES "to_ramp_payout_batches"("id") ON DELETE RESTRICT`,
    );

    // Journal ↔ statement lines: a line-scoped kind once per line; an order-scoped kind booked on a
    // line once per (line, order) — the per-order index of the Ramp migration still holds.
    await q.query(
      `ALTER TABLE "to_ramp_journal" ADD CONSTRAINT "FK_to_ramp_journal_statement_line" FOREIGN KEY ("statement_line_id") REFERENCES "to_ramp_bank_lines"("id") ON DELETE RESTRICT`,
    );
    await q.query(`DROP INDEX "uq_to_ramp_journal_line_kind"`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_line_kind" ON "to_ramp_journal" ("statement_line_id", "kind", "account") WHERE "statement_line_id" IS NOT NULL AND "order_id" IS NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_line_order_kind" ON "to_ramp_journal" ("statement_line_id", "order_id", "kind", "account") WHERE "statement_line_id" IS NOT NULL AND "order_id" IS NOT NULL`,
    );
    // S8: an on-ramp's bank refund the bank returns is paid again — its two kinds repeat per order,
    // once per statement line each (the index above); they are never booked without a line.
    await q.query(`DROP INDEX "uq_to_ramp_journal_order_kind"`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_order_kind" ON "to_ramp_journal" ("order_id", "kind", "account") WHERE "order_id" IS NOT NULL AND "kind" NOT IN ('refund.paid_bank', 'refund.returned_bank')`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_journal" ADD CONSTRAINT "CHK_to_ramp_journal_bank_refund_line" CHECK ("kind" NOT IN ('refund.paid_bank', 'refund.returned_bank') OR "statement_line_id" IS NOT NULL)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "to_ramp_journal" DROP CONSTRAINT "CHK_to_ramp_journal_bank_refund_line"`,
    );
    await q.query(`DROP INDEX "uq_to_ramp_journal_order_kind"`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_order_kind" ON "to_ramp_journal" ("order_id", "kind", "account") WHERE "order_id" IS NOT NULL`,
    );
    await q.query(`DROP INDEX "uq_to_ramp_journal_line_order_kind"`);
    await q.query(`DROP INDEX "uq_to_ramp_journal_line_kind"`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_line_kind" ON "to_ramp_journal" ("statement_line_id", "kind", "account") WHERE "statement_line_id" IS NOT NULL`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_journal" DROP CONSTRAINT "FK_to_ramp_journal_statement_line"`,
    );
    await q.query(`ALTER TABLE "to_ramp_orders" DROP CONSTRAINT "FK_to_ramp_orders_payout_batch"`);
    await q.query(`ALTER TABLE "to_ramp_orders" DROP CONSTRAINT "FK_to_ramp_orders_bank_account"`);
    await q.query(`DROP TABLE "to_ramp_bank_lines"`);
    await q.query(`DROP TABLE "to_ramp_bank_statements"`);
    await q.query(`DROP TABLE "to_ramp_payout_batch_items"`);
    await q.query(`DROP SEQUENCE "to_ramp_payout_document_no_seq"`);
    await q.query(`DROP TABLE "to_ramp_payout_batches"`);
    await q.query(`DROP TABLE "to_ramp_bank_accounts"`);
  }
}
