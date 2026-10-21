import type { MigrationInterface, QueryRunner } from "typeorm";

/** SPEC §3.2 — the CHECKs below repeat `RAMP_ORDER_STATUSES` / `RAMP_STEPS` (types.ts). */
const STATUSES = [
  "created",
  "awaiting_payment",
  "paid",
  "minting",
  "crediting",
  "awaiting_withdrawal",
  "withdrawing",
  "burning",
  "paying_out",
  "reversing",
  "payout_queued",
  "payout_sent",
  "needs_review",
  "refunding",
  "completed",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "chargeback",
];
const STEPS = [
  "payment",
  "mint",
  "credit",
  "withdrawal",
  "burn",
  "payout",
  "refund",
  "reversal",
  "compliance",
];
/** SPEC §5 — every journal account (S6's bank accounts included, so its postings need no DDL). */
const ACCOUNTS = [
  "provider_clearing",
  "safeguard_bank",
  "chargeback_receivable",
  "issuance_pending",
  "customer_liability",
  "payout_clearing",
  "bank_suspense",
  "operator_money",
  "fee_revenue",
  "psp_fees",
  "bank_fees",
];
/** SPEC §9.2 / §9.3 (S5): on-ramp methods and cash-out rails (types.ts RAMP_METHODS / RAMP_PAYOUT_RAILS). */
const METHODS = ["card", "erip"];
const RAILS = ["card", "bank"];
/** Postings that release issuance_pending back to the payer: at most one per order (#10). */
const IP_RELEASES = ["onramp.refunded", "onramp.voided", "onramp.chargeback", "onramp.refund_queued"];
const list = (values: string[]): string => values.map((v) => `'${v}'`).join(", ");

/**
 * Fiat ramp (SPEC §3): BYN on-ramp and off-ramp for the ramp instrument (cBYN). Tables:
 * `to_ramp_payment_methods` (tokenised cards, sealed tokens, one card one account),
 * `to_ramp_orders` (the state machine: every idempotency key a column, `version` for the CAS of
 * I6, the captured / refunded amounts, the amount identities as CHECKs), `to_ramp_events` (the
 * webhook inbox with back-off and a dead letter) and `to_ramp_journal` (double entry in fiat;
 * append-only — triggers refuse UPDATE, DELETE and TRUNCATE). Hand-written; `down()` drops what
 * `up()` created (CI runs run / revert / run).
 */
export class Ramp1793000000000 implements MigrationInterface {
  name = "Ramp1793000000000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "to_ramp_payment_methods" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "provider" text NOT NULL, "fingerprint" text NOT NULL, "token_sealed" text NOT NULL, "brand" text, "last4" text, "exp_month" integer, "exp_year" integer, "issuer_country" text, "status" text NOT NULL DEFAULT 'active', "payout_eligible" boolean NOT NULL DEFAULT false, "first_order_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_used_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_to_ramp_payment_methods" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_ramp_payment_methods_status" CHECK ("status" IN ('active', 'removed', 'blocked')))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_payment_methods_user" ON "to_ramp_payment_methods" ("user_id")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_payment_methods_fingerprint" ON "to_ramp_payment_methods" ("provider", "fingerprint")`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_payment_methods" ADD CONSTRAINT "FK_to_ramp_payment_methods_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "to_ramp_orders" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "direction" text NOT NULL, "status" text NOT NULL, "review_step" text, "version" integer NOT NULL DEFAULT 0, "provider" text NOT NULL, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "party_id" text NOT NULL, "fiat_currency" text NOT NULL, "fiat_amount" numeric(38,10) NOT NULL, "token_amount" numeric(38,10) NOT NULL, "fee_amount" numeric(38,10) NOT NULL, "payment_method_id" uuid, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL, "provider_payment_id" text, "provider_payout_id" text, "provider_refund_id" text, "checkout_url" text, "expires_at" TIMESTAMP WITH TIME ZONE, "captured_amount" numeric(38,10), "captured_at" TIMESTAMP WITH TIME ZONE, "refunded_amount" numeric(38,10) NOT NULL DEFAULT 0, "mint_command_id" text, "credit_command_id" text, "pending_payout_cid" text, "burn_command_id" text, "remint_command_id" text, "remint_credit_command_id" text, "method" text, "payment_instructions" jsonb, "payout_rail" text, "bank_account_id" uuid, "payout_batch_id" uuid, "payout_reference" text NOT NULL, "operator" jsonb NOT NULL, "consent_id" uuid, "risk" jsonb NOT NULL DEFAULT '{}'::jsonb, "attempts" integer NOT NULL DEFAULT 0, "last_error" text, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "status_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_polled_at" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_orders" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "CHK_to_ramp_orders_direction" CHECK ("direction" IN ('onramp', 'offramp')), ` +
        `CONSTRAINT "CHK_to_ramp_orders_status" CHECK ("status" IN (${list(STATUSES)})), ` +
        `CONSTRAINT "CHK_to_ramp_orders_review_step" CHECK ((("status" = 'needs_review') = ("review_step" IS NOT NULL)) AND ("review_step" IS NULL OR "review_step" IN (${list(STEPS)}))), ` +
        `CONSTRAINT "CHK_to_ramp_orders_amounts" CHECK ("fiat_amount" > 0 AND "token_amount" > 0 AND "fee_amount" >= 0), ` +
        // F = N + f on-ramp, T = P + f off-ramp: every posting of SPEC §5 balances because of these.
        `CONSTRAINT "CHK_to_ramp_orders_identity" CHECK (("direction" = 'onramp' AND "fiat_amount" = "token_amount" + "fee_amount") OR ("direction" = 'offramp' AND "token_amount" = "fiat_amount" + "fee_amount")), ` +
        `CONSTRAINT "CHK_to_ramp_orders_capture" CHECK (("captured_amount" IS NULL) = ("captured_at" IS NULL) AND ("captured_amount" IS NULL OR "captured_amount" > 0) AND "refunded_amount" >= 0 AND "refunded_amount" <= COALESCE("captured_amount", 0) AND ("direction" = 'onramp' OR "captured_amount" IS NULL)), ` +
        `CONSTRAINT "CHK_to_ramp_orders_counters" CHECK ("version" >= 0 AND "attempts" >= 0), ` +
        // S5: a method on every on-ramp only, a rail on every off-ramp only; a bank cash-out names its account.
        `CONSTRAINT "CHK_to_ramp_orders_method" CHECK ((("direction" = 'onramp') = ("method" IS NOT NULL)) AND ("method" IS NULL OR "method" IN (${list(METHODS)}))), ` +
        `CONSTRAINT "CHK_to_ramp_orders_rail" CHECK ((("direction" = 'offramp') = ("payout_rail" IS NOT NULL)) AND ("payout_rail" IS NULL OR "payout_rail" IN (${list(RAILS)})) AND ("payout_rail" IS DISTINCT FROM 'bank' OR "bank_account_id" IS NOT NULL) AND ("payout_rail" IS DISTINCT FROM 'card' OR "bank_account_id" IS NULL)), ` +
        `CONSTRAINT "CHK_to_ramp_orders_payout_reference" CHECK ("payout_reference" ~ '^TO[0-9]{12}$'), ` +
        `CONSTRAINT "CHK_to_ramp_orders_request_hash" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_user" ON "to_ramp_orders" ("user_id", "created_at")`,
    );
    await q.query(`CREATE INDEX "ix_to_ramp_orders_status" ON "to_ramp_orders" ("status")`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_orders_idempotency" ON "to_ramp_orders" ("user_id", "idempotency_key")`,
    );
    // One order per account, direction and method waiting on the user (an ERIP invoice open for a day
    // must not block a card purchase).
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_orders_open" ON "to_ramp_orders" ("user_id", "direction", COALESCE("method", '')) WHERE "status" IN ('created', 'awaiting_payment', 'awaiting_withdrawal')`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_orders_payout_reference" ON "to_ramp_orders" ("payout_reference")`,
    );
    // A card's captures (card cash-out planning) and the bank rail's lookups (S6 adds the foreign keys).
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_payment_method" ON "to_ramp_orders" ("payment_method_id") WHERE "payment_method_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_bank_account" ON "to_ramp_orders" ("bank_account_id") WHERE "bank_account_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_payout_batch" ON "to_ramp_orders" ("payout_batch_id") WHERE "payout_batch_id" IS NOT NULL`,
    );
    // C43: the scan's post-close poll (every RAMP_SCAN_MS) reads only on-ramps closed in the last
    // RAMP_CLOSED_POLL_HOURS — by status_changed_at, never the whole history; no_stuck_orders reads
    // only the open ones (its literal status list).
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_closed_poll" ON "to_ramp_orders" ("status_changed_at") WHERE "direction" = 'onramp' AND "provider_payment_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_open" ON "to_ramp_orders" ("status_changed_at") WHERE "status" NOT IN ('completed', 'failed', 'expired', 'cancelled', 'refunded', 'chargeback', 'needs_review')`,
    );
    for (const column of ["provider_payment_id", "provider_payout_id", "provider_refund_id"]) {
      await q.query(
        `CREATE UNIQUE INDEX "uq_to_ramp_orders_${column}" ON "to_ramp_orders" ("provider", "${column}")`,
      );
    }
    for (const column of [
      "mint_command_id",
      "pending_payout_cid",
      "burn_command_id",
      "remint_command_id",
    ]) {
      await q.query(
        `CREATE UNIQUE INDEX "uq_to_ramp_orders_${column}" ON "to_ramp_orders" ("${column}")`,
      );
    }
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_payment_method" FOREIGN KEY ("payment_method_id") REFERENCES "to_ramp_payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "to_ramp_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "provider" text NOT NULL, "event_key" text NOT NULL, "type" text NOT NULL, "kind" text NOT NULL, "object_id" text NOT NULL, "order_id" uuid, "payload" jsonb, "sandbox" boolean NOT NULL DEFAULT false, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT 0, "last_attempt_at" TIMESTAMP WITH TIME ZONE, "next_attempt_at" TIMESTAMP WITH TIME ZONE, "dead_at" TIMESTAMP WITH TIME ZONE, "error" text, "replayed_at" TIMESTAMP WITH TIME ZONE, "closed_at" TIMESTAMP WITH TIME ZONE, "close_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_events" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_ramp_events_closed" CHECK ("closed_at" IS NULL OR ("processed_at" IS NOT NULL AND "close_reason" IS NOT NULL)))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_events_event_key" ON "to_ramp_events" ("event_key")`,
    );
    await q.query(`CREATE INDEX "ix_to_ramp_events_order" ON "to_ramp_events" ("order_id")`);
    // The sweep's work list: unapplied, not dead, due.
    await q.query(
      `CREATE INDEX "ix_to_ramp_events_due" ON "to_ramp_events" ("next_attempt_at") WHERE "processed_at" IS NULL AND "dead_at" IS NULL`,
    );

    await q.query(
      `CREATE TABLE "to_ramp_journal" ("id" BIGSERIAL NOT NULL, "entry_id" uuid NOT NULL, "kind" text NOT NULL, "order_id" uuid, "statement_line_id" uuid, "user_id" uuid, "account" text NOT NULL, "currency" text NOT NULL, "amount" numeric(38,10) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_journal" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "CHK_to_ramp_journal_account" CHECK ("account" IN (${list(ACCOUNTS)})), ` +
        `CONSTRAINT "CHK_to_ramp_journal_amount" CHECK ("amount" <> 0), ` +
        // The per-client sub-ledger (R12): every client-liability line names its user.
        `CONSTRAINT "CHK_to_ramp_journal_user" CHECK ("account" NOT IN ('issuance_pending', 'customer_liability', 'payout_clearing') OR "user_id" IS NOT NULL))`,
    );
    await q.query(`CREATE INDEX "ix_to_ramp_journal_entry" ON "to_ramp_journal" ("entry_id")`);
    await q.query(`CREATE INDEX "ix_to_ramp_journal_account" ON "to_ramp_journal" ("account")`);
    await q.query(`CREATE INDEX "ix_to_ramp_journal_user" ON "to_ramp_journal" ("user_id")`);
    // One posting per (order, kind) and per (statement line, kind): a line per account each.
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_order_kind" ON "to_ramp_journal" ("order_id", "kind", "account") WHERE "order_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_line_kind" ON "to_ramp_journal" ("statement_line_id", "kind", "account") WHERE "statement_line_id" IS NOT NULL`,
    );
    // refunded / voided / chargeback / refund_queued each release issuance_pending: at most one per order.
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_ip_release" ON "to_ramp_journal" ("order_id") WHERE "account" = 'issuance_pending' AND "kind" IN (${list(IP_RELEASES)})`,
    );
    // Append-only at the database (L5, X17): corrections are new postings, never edits.
    await q.query(
      `CREATE FUNCTION "to_ramp_journal_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'to_ramp_journal is append-only: % refused', TG_OP; END $$`,
    );
    await q.query(
      `CREATE TRIGGER "trg_to_ramp_journal_no_change" BEFORE UPDATE OR DELETE ON "to_ramp_journal" FOR EACH ROW EXECUTE FUNCTION "to_ramp_journal_append_only"()`,
    );
    await q.query(
      `CREATE TRIGGER "trg_to_ramp_journal_no_truncate" BEFORE TRUNCATE ON "to_ramp_journal" FOR EACH STATEMENT EXECUTE FUNCTION "to_ramp_journal_append_only"()`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "to_ramp_journal"`);
    await q.query(`DROP FUNCTION "to_ramp_journal_append_only"()`);
    await q.query(`DROP TABLE "to_ramp_events"`);
    await q.query(`DROP TABLE "to_ramp_orders"`);
    await q.query(`DROP TABLE "to_ramp_payment_methods"`);
  }
}
