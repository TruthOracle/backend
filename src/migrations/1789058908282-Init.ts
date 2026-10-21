import type { MigrationInterface, QueryRunner } from "typeorm";

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

/** `RAMP_FIAT_CURRENCIES` (types.ts): every ramp amount is in one of these — BYN only. */
const FIAT_CURRENCIES = ["BYN"];
/** RAMP SPEC §3.2 — the CHECKs below repeat `RAMP_ORDER_STATUSES` / `RAMP_STEPS` (types.ts). */
const ORDER_STATUSES = [
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
const REVIEW_STEPS = [
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
/** RAMP SPEC §5 — every journal account. */
const JOURNAL_ACCOUNTS = [
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
/** RAMP SPEC §9.2 / §9.3: on-ramp methods and cash-out rails (types.ts RAMP_METHODS / RAMP_PAYOUT_RAILS). */
const METHODS = ["card", "erip"];
const RAILS = ["card", "bank"];
/** Postings that release issuance_pending back to the payer: at most one per order (#10). */
const IP_RELEASES = ["onramp.refunded", "onramp.voided", "onramp.chargeback", "onramp.refund_queued"];
/** RAMP SPEC §10 — the bank rail. */
const BANK_ACCOUNT_STATUSES = ["cooling_off", "pending_proof", "active", "removed", "blocked"];
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
const LINE_FLAGS = ["reference_credit", "iban_mismatch", "payout_duplicate"];
/** RAMP SPEC §11.6, R4 (≥ 5 years after the relationship ends): a trigger refuses DELETE on these. */
const RETAINED = [
  "to_compliance_freezes",
  "to_screening_lists",
  "to_screening_entries",
  "to_screening_runs",
  "to_screening_subjects",
  "to_screening_hits",
];

/**
 * The one and only schema migration: every `to_*` table, index, constraint, trigger and seed row,
 * created in its final form. Greenfield (ARCHITECTURE §18): nothing predates this schema and there
 * is no upgrade path from an older layout — a database built by an earlier chain of migrations is
 * dropped and recreated, never migrated.
 *
 * The plain tables come from `typeorm migration:generate`; the rest is hand-written because TypeORM
 * cannot declare it: the extensions, the CHECK constraints, the expression index of
 * `to_token_app_records`, the append-only / retention triggers, the payout document sequence and
 * the two `to_settings` seeds. Because the entities do not declare those CHECKs, partial /
 * expression indexes and hand-named foreign keys, `migration:generate` against a migrated database
 * proposes dropping them (plus cosmetic `'{}'` vs `'{}'::jsonb` default rewrites): never apply its
 * output unreviewed. `down()` drops everything `up()` created (CI runs run / revert / run).
 *
 * Sections: accounts (ARCHITECTURE §5), the ledger index (docs/INDEXER.md §3), the market catalog
 * (docs/MARKETS.md), instruments and rewards (docs/TOKENS.md §4), and the fiat ramp
 * (docs/RAMP.md): orders and journal, token-app commands, controls and approvals, the bank rail,
 * compliance, screening and freezes.
 */
export class Init1789058908282 implements MigrationInterface {
  name = "Init1789058908282";

  public async up(q: QueryRunner): Promise<void> {
    // citext backs every email column; pgcrypto is named for gen_random_uuid() (built in since PG13).
    await q.query(`CREATE EXTENSION IF NOT EXISTS citext`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // ── accounts ─────────────────────────────────────────────────────────────────────────────
    await q.query(
      `CREATE TABLE "to_settings" ("key" text NOT NULL, "value" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_56b960e6569b05b8d490f640dd2" PRIMARY KEY ("key"))`,
    );
    await q.query(
      `CREATE TABLE "to_users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "display_name" text, "avatar_url" text, "email" citext, "status" text NOT NULL DEFAULT 'active', "kyc_status" text NOT NULL DEFAULT 'none', "kyc_verification_id" uuid, "kyc_provider" text, "kyc_applicant_id" text, "party_id" text, "last_login_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b9fbc0303871fc9ed9ba477e805" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE UNIQUE INDEX "uq_to_users_party_id" ON "to_users" ("party_id")`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_users_kyc_applicant" ON "to_users" ("kyc_provider", "kyc_applicant_id")`,
    );
    await q.query(
      `CREATE TABLE "to_auth_identities" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "provider" text NOT NULL, "subject" text NOT NULL, "email" citext, "profile" jsonb NOT NULL DEFAULT '{}'::jsonb, "status" text NOT NULL DEFAULT 'active', "verified_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_used_at" TIMESTAMP WITH TIME ZONE, "unlinked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d1fcbe46842bd243ff7baee943b" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_auth_identities_user_id" ON "to_auth_identities" ("user_id")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_auth_identities_provider_subject" ON "to_auth_identities" ("provider", "subject")`,
    );
    await q.query(
      `CREATE TABLE "to_wallets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "chain" text NOT NULL DEFAULT 'canton', "kind" text NOT NULL, "party_id" text NOT NULL, "public_key" text NOT NULL, "label" text, "is_primary" boolean NOT NULL DEFAULT false, "status" text NOT NULL DEFAULT 'active', "verified_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6b2bf66cbd555adc600d8a3718e" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "ix_to_wallets_user_id" ON "to_wallets" ("user_id")`);
    await q.query(`CREATE UNIQUE INDEX "uq_to_wallets_party_id" ON "to_wallets" ("party_id")`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_wallets_primary_per_user" ON "to_wallets" ("user_id") WHERE "is_primary" = true AND "status" = 'active'`,
    );
    // Per-instrument deposit attribution of a wallet (docs/TOKENS.md §4).
    await q.query(
      `CREATE TABLE "to_wallet_credits" ("wallet_id" uuid NOT NULL, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "credited" numeric(38,10) NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_wallet_credits" PRIMARY KEY ("wallet_id", "instrument_admin", "instrument_id"))`,
    );
    await q.query(
      `CREATE TABLE "to_sessions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "auth_identity_id" uuid NOT NULL, "token_hash" text NOT NULL, "kind" text NOT NULL DEFAULT 'user', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_seen_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, "ip" text, "user_agent" text, CONSTRAINT "PK_41c51bd3c316dd298a0d3c0ca55" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "ix_to_sessions_user_id" ON "to_sessions" ("user_id")`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_sessions_token_hash" ON "to_sessions" ("token_hash")`,
    );
    await q.query(
      `CREATE TABLE "to_kyc_verifications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "provider" text NOT NULL, "provider_applicant_id" text, "level_name" text NOT NULL, "attempt_no" integer NOT NULL DEFAULT '1', "status" text NOT NULL DEFAULT 'initiated', "initiated_identity_id" uuid, "provider_event_at" TIMESTAMP WITH TIME ZONE, "reject_labels" jsonb, "moderation_comment" text, "manual" boolean NOT NULL DEFAULT false, "manual_reason" text, "reviewed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_85bf788e4eaa364dcf69ee4df37" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_kyc_verifications_user_id" ON "to_kyc_verifications" ("user_id")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_kyc_verifications_attempt" ON "to_kyc_verifications" ("user_id", "provider", "level_name", "attempt_no")`,
    );
    await q.query(
      `CREATE TABLE "to_kyc_persons" ("fingerprint" text NOT NULL, "kind" text NOT NULL, "user_id" uuid NOT NULL, "verification_id" uuid NOT NULL, "fingerprint_version" smallint NOT NULL DEFAULT '1', "bound_at" TIMESTAMP WITH TIME ZONE NOT NULL, "released_at" TIMESTAMP WITH TIME ZONE, "released_by" uuid, "release_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3a5a75850c06918fa2c89c66217" PRIMARY KEY ("fingerprint"))`,
    );
    await q.query(`CREATE INDEX "ix_to_kyc_persons_user_id" ON "to_kyc_persons" ("user_id")`);
    // last_attempt_at: when the durable consumer last tried the row; the sweep re-arms exhausted
    // rows only after a cooldown measured from here.
    await q.query(
      `CREATE TABLE "to_kyc_webhook_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "provider" text NOT NULL, "event_key" text NOT NULL, "type" text NOT NULL, "payload" jsonb, "sandbox" boolean NOT NULL DEFAULT false, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', "last_attempt_at" TIMESTAMP WITH TIME ZONE, "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_69514b4525f9fe6b16311eb9cd9" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_kyc_webhook_events_event_key" ON "to_kyc_webhook_events" ("event_key")`,
    );
    await q.query(
      `CREATE TABLE "to_payouts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "pending_payout_cid" text NOT NULL, "user_id" uuid, "payee_party" text NOT NULL, "payee_wallet_id" uuid, "amount" numeric(38,10) NOT NULL, "reason" text NOT NULL, "status" text NOT NULL DEFAULT 'queued', "transfer_command_id" text, "wallet_create_command_id" text, "settle_command_id" text, "mark_paid_command_id" text, "attempts" integer NOT NULL DEFAULT '0', "last_error" text, "first_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL, "settled_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, CONSTRAINT "PK_76b7931cda6977c37f9520a0ef4" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_payouts_pending_payout_cid" ON "to_payouts" ("pending_payout_cid")`,
    );
    await q.query(`CREATE INDEX "ix_to_payouts_user_id" ON "to_payouts" ("user_id")`);
    await q.query(`CREATE INDEX "ix_to_payouts_status" ON "to_payouts" ("status")`);
    // submitted_at: when the row was (re-)armed; the confirm pass never fails a credit younger than
    // DEPOSIT_CONFIRM_GRACE_MS (a re-armed row starts a fresh grace period, which created_at cannot express).
    await q.query(
      `CREATE TABLE "to_deposit_credits" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "owner_party" text NOT NULL, "command_id" text NOT NULL, "tx_ref" text NOT NULL, "amount" numeric(38,10) NOT NULL, "attribution" jsonb NOT NULL DEFAULT '[]'::jsonb, "deposited_before" numeric(38,10) NOT NULL, "wallet_cid_before" text, "status" text NOT NULL DEFAULT 'submitted', "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "confirmed_at" TIMESTAMP WITH TIME ZONE, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, CONSTRAINT "PK_79e716569b543f69bbca4bf0775" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_deposit_credits_user_id" ON "to_deposit_credits" ("user_id")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_deposit_credits_command_id" ON "to_deposit_credits" ("command_id")`,
    );
    await q.query(`CREATE INDEX "ix_to_deposit_credits_status" ON "to_deposit_credits" ("status")`);
    await q.query(
      `CREATE TABLE "to_audit_events" ("id" BIGSERIAL NOT NULL, "actor_type" text NOT NULL, "actor_user_id" uuid, "actor_session_id" uuid, "action" text NOT NULL, "subject_type" text NOT NULL, "subject_id" text NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb, "ip" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0f102be5b5cf77e533d79bc848e" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_audit_events_actor_user_id" ON "to_audit_events" ("actor_user_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_audit_events_subject" ON "to_audit_events" ("subject_type", "subject_id")`,
    );
    await q.query(
      `ALTER TABLE "to_auth_identities" ADD CONSTRAINT "FK_582f57d0467c0c0da6d111941e5" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_wallets" ADD CONSTRAINT "FK_858f3793a96ab3fe2cd2907bb8f" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_wallet_credits" ADD CONSTRAINT "FK_to_wallet_credits_wallet" FOREIGN KEY ("wallet_id") REFERENCES "to_wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_sessions" ADD CONSTRAINT "FK_49becbbb778e2cb789827d7a130" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_sessions" ADD CONSTRAINT "FK_e3a0d04bcf72847bca3430dd5a0" FOREIGN KEY ("auth_identity_id") REFERENCES "to_auth_identities"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_kyc_verifications" ADD CONSTRAINT "FK_41526beccfef6cde673850e4763" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_kyc_verifications" ADD CONSTRAINT "FK_0baba53b144c6106e40d3a6202f" FOREIGN KEY ("initiated_identity_id") REFERENCES "to_auth_identities"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_kyc_persons" ADD CONSTRAINT "FK_1417d0a1096d9e9ed7fa0c7bd98" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_kyc_persons" ADD CONSTRAINT "FK_5f658e9d187447f8ce1f73d21cd" FOREIGN KEY ("verification_id") REFERENCES "to_kyc_verifications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_deposit_credits" ADD CONSTRAINT "FK_7d9120de70b2a4a242e53ae724e" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    // The database is bound to the network it was created for (ARCHITECTURE §12 boot check).
    // Read from the environment the migration runs in; AppService refuses to boot on a mismatch.
    const network = (process.env.APP_NETWORK ?? "devnet").trim().toLowerCase() || "devnet";
    await q.query(
      `INSERT INTO "to_settings" ("key", "value") VALUES ('app_network', $1) ON CONFLICT ("key") DO NOTHING`,
      [network],
    );

    // ── ledger index ─────────────────────────────────────────────────────────────────────────
    // A projection of the treasury's view of the ledger. No foreign keys to the account tables:
    // rows are keyed by Canton party and contract id, and the join to an account happens at read
    // time through to_users.party_id / to_wallets.party_id.
    await q.query(
      `CREATE TABLE "to_indexer_state" ("key" text NOT NULL, "offset" bigint NOT NULL DEFAULT '0', "ledger_end" bigint, "pruned_offset" bigint, "bootstrapped_at" TIMESTAMP WITH TIME ZONE, "bootstrap_offset" bigint, "last_update_id" text, "last_record_time" TIMESTAMP WITH TIME ZONE, "last_error" text, "last_error_at" TIMESTAMP WITH TIME ZONE, "market_counter_cid" text, "market_counter_value" bigint, "gaps" jsonb NOT NULL DEFAULT '[]'::jsonb, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_10af6f71f4d7d9f0aabfeb04869" PRIMARY KEY ("key"))`,
    );
    await q.query(
      `CREATE TABLE "to_ledger_events" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "offset" bigint NOT NULL, "node_id" integer NOT NULL, "update_id" text NOT NULL, "kind" text NOT NULL, "package_name" text NOT NULL, "module" text NOT NULL, "entity" text NOT NULL, "template_id" text NOT NULL, "contract_id" text NOT NULL, "choice" text, "consuming" boolean, "acting_parties" jsonb NOT NULL DEFAULT '[]'::jsonb, "witness_parties" jsonb NOT NULL DEFAULT '[]'::jsonb, "signatories" jsonb, "observers" jsonb, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "result" jsonb, "parent_node_id" integer, "root_node_id" integer, "last_descendant_node_id" integer, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "record_time" TIMESTAMP WITH TIME ZONE, "command_id" text, "workflow_id" text, "synchronizer_id" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ae79f115b1ca70d70ceb03f3430" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ledger_events_event_id" ON "to_ledger_events" ("event_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_events_update_id" ON "to_ledger_events" ("update_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_events_contract_id" ON "to_ledger_events" ("contract_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_events_entity_offset" ON "to_ledger_events" ("entity", "offset")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_events_offset_node" ON "to_ledger_events" ("offset", "node_id")`,
    );
    // Presentation (image, description) lives in to_market_metadata and the category is the
    // series'; the identity columns (ticker … no_sub_title) are mandatory on every PredictionMarket.
    await q.query(
      `CREATE TABLE "to_markets" ("market_id" bigint NOT NULL, "contract_id" text NOT NULL, "admin" text NOT NULL, "question" text NOT NULL, "resolution_description" text NOT NULL DEFAULT '', "created_at_sec" bigint NOT NULL, "expires_at_sec" bigint NOT NULL, "grace_period_secs" integer NOT NULL DEFAULT '0', "is_dynamic" boolean NOT NULL DEFAULT false, "liquidity_period_secs" integer NOT NULL DEFAULT '0', "reserve_yes" numeric(38,10) NOT NULL DEFAULT '0', "reserve_no" numeric(38,10) NOT NULL DEFAULT '0', "liquidity_l" numeric(38,10) NOT NULL DEFAULT '0', "lp_token_supply" numeric(38,10) NOT NULL DEFAULT '0', "current_price" numeric(38,10) NOT NULL DEFAULT '0', "fee_bps" integer NOT NULL DEFAULT '0', "prize_fee_share_bps" integer NOT NULL DEFAULT '0', "accumulated_fees" numeric(38,10) NOT NULL DEFAULT '0', "prize_pool" numeric(38,10) NOT NULL DEFAULT '0', "total_volume" numeric(38,10) NOT NULL DEFAULT '0', "status" text NOT NULL DEFAULT 'Trading', "outcome" text, "resolved_at_sec" bigint, "proposal" jsonb, "policy" jsonb NOT NULL DEFAULT '{}'::jsonb, "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb, "created_event_blob" text, "synchronizer_id" text, "created_offset" bigint NOT NULL, "updated_offset" bigint NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "updated_at_ledger" TIMESTAMP WITH TIME ZONE, "archived" boolean NOT NULL DEFAULT false, "archived_offset" bigint, "trade_count" integer NOT NULL DEFAULT '0', "last_trade_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "ticker" text NOT NULL, "event_ticker" text NOT NULL, "yes_sub_title" text NOT NULL, "no_sub_title" text NOT NULL, "template_id" text, "open_interest_yes" numeric(38,10) NOT NULL DEFAULT '0', "open_interest_no" numeric(38,10) NOT NULL DEFAULT '0', "collateral_admin" text NOT NULL, "collateral_id" text NOT NULL, CONSTRAINT "PK_98f76274c8dc876849d0cb2f3f1" PRIMARY KEY ("market_id"))`,
    );
    await q.query(`CREATE UNIQUE INDEX "uq_to_markets_contract_id" ON "to_markets" ("contract_id")`);
    await q.query(`CREATE UNIQUE INDEX "uq_to_markets_ticker" ON "to_markets" ("ticker")`);
    await q.query(`CREATE INDEX "ix_to_markets_event_ticker" ON "to_markets" ("event_ticker")`);
    await q.query(`CREATE INDEX "ix_to_markets_updated_offset" ON "to_markets" ("updated_offset")`);
    await q.query(`CREATE INDEX "ix_to_markets_expires_at" ON "to_markets" ("expires_at_sec")`);
    await q.query(`CREATE INDEX "ix_to_markets_status" ON "to_markets" ("status")`);
    await q.query(
      `CREATE INDEX "ix_to_markets_collateral" ON "to_markets" ("collateral_admin", "collateral_id")`,
    );
    await q.query(
      `CREATE TABLE "to_market_snapshots" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "market_id" bigint NOT NULL, "contract_id" text NOT NULL, "offset" bigint NOT NULL, "node_id" integer NOT NULL, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "price" numeric(38,10) NOT NULL, "reserve_yes" numeric(38,10) NOT NULL, "reserve_no" numeric(38,10) NOT NULL, "liquidity_l" numeric(38,10) NOT NULL, "lp_token_supply" numeric(38,10) NOT NULL, "total_volume" numeric(38,10) NOT NULL, "accumulated_fees" numeric(38,10) NOT NULL, "prize_pool" numeric(38,10) NOT NULL, "status" text NOT NULL, "cause" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_df263b306d21fa52fc119b5640b" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_market_snapshots_event_id" ON "to_market_snapshots" ("event_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_market_snapshots_market_offset" ON "to_market_snapshots" ("market_id", "offset")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_market_snapshots_market_time" ON "to_market_snapshots" ("market_id", "effective_at")`,
    );
    await q.query(
      `CREATE TABLE "to_market_events" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "market_id" bigint NOT NULL, "kind" text NOT NULL, "actor" text NOT NULL, "side" text, "amount" numeric(38,10), "net" numeric(38,10), "shares" numeric(38,10), "shares_out" numeric(38,10), "fee" numeric(38,10), "price_before" numeric(38,10), "price_after" numeric(38,10), "lp_tokens" numeric(38,10), "outcome" text, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "offset" bigint NOT NULL, "node_id" integer NOT NULL, "update_id" text NOT NULL, "command_id" text, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "record_time" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7db09e88ac04339a68921222c95" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_market_events_event_id" ON "to_market_events" ("event_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_market_events_effective_at" ON "to_market_events" ("effective_at")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_market_events_kind_offset" ON "to_market_events" ("kind", "offset")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_market_events_actor_offset" ON "to_market_events" ("actor", "offset")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_market_events_market_offset" ON "to_market_events" ("market_id", "offset")`,
    );
    await q.query(
      `CREATE TABLE "to_positions" ("contract_id" text NOT NULL, "holder" text NOT NULL, "admin" text NOT NULL, "market_id" bigint NOT NULL, "yes_shares" numeric(38,10) NOT NULL DEFAULT '0', "no_shares" numeric(38,10) NOT NULL DEFAULT '0', "cost_basis" numeric(38,10) NOT NULL DEFAULT '0', "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_event_id" text NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "archived_choice" text, "archived_at_ledger" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_c06986686141c8b8e30fd14420a" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_positions_holder_market" ON "to_positions" ("holder", "market_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_positions_market_active" ON "to_positions" ("market_id", "active")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_positions_holder_active" ON "to_positions" ("holder", "active")`,
    );
    await q.query(
      `CREATE TABLE "to_liquidity_positions" ("contract_id" text NOT NULL, "provider" text NOT NULL, "admin" text NOT NULL, "market_id" bigint NOT NULL, "lp_tokens" numeric(38,10) NOT NULL DEFAULT '0', "deposited" numeric(38,10) NOT NULL DEFAULT '0', "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_event_id" text NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "archived_choice" text, "archived_at_ledger" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_04555772bdcb035ae9ecd49aacf" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_liquidity_positions_market_active" ON "to_liquidity_positions" ("market_id", "active")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_liquidity_positions_provider_active" ON "to_liquidity_positions" ("provider", "active")`,
    );
    // One wallet per (owner, instrument).
    await q.query(
      `CREATE TABLE "to_ledger_wallets" ("contract_id" text NOT NULL, "owner" text NOT NULL, "admin" text NOT NULL, "balance" numeric(38,10) NOT NULL DEFAULT '0', "deposited" numeric(38,10) NOT NULL DEFAULT '0', "withdrawn" numeric(38,10) NOT NULL DEFAULT '0', "credit_refs" jsonb NOT NULL DEFAULT '[]'::jsonb, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_event_id" text NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "archived_choice" text, "archived_at_ledger" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb, CONSTRAINT "PK_e70cc33bd1a7afe401cb9017e6f" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_wallets_owner_active" ON "to_ledger_wallets" ("owner", "active")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_wallets_owner_instrument_active" ON "to_ledger_wallets" ("owner", "instrument_admin", "instrument_id", "active")`,
    );
    await q.query(
      `CREATE TABLE "to_wallet_entries" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "owner" text NOT NULL, "wallet_cid" text NOT NULL, "new_wallet_cid" text, "kind" text NOT NULL, "amount" numeric(38,10) NOT NULL, "reason" text, "tx_ref" text, "balance_after" numeric(38,10), "market_id" bigint, "root_choice" text, "root_template" text, "offset" bigint NOT NULL, "node_id" integer NOT NULL, "update_id" text NOT NULL, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "record_time" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, CONSTRAINT "PK_264e5785e39b0d2bbe8b6ca0dba" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_wallet_entries_event_id" ON "to_wallet_entries" ("event_id")`,
    );
    await q.query(`CREATE INDEX "ix_to_wallet_entries_market" ON "to_wallet_entries" ("market_id")`);
    await q.query(`CREATE INDEX "ix_to_wallet_entries_kind" ON "to_wallet_entries" ("kind")`);
    await q.query(
      `CREATE INDEX "ix_to_wallet_entries_owner_offset" ON "to_wallet_entries" ("owner", "offset")`,
    );
    await q.query(
      `CREATE TABLE "to_ledger_payouts" ("contract_id" text NOT NULL, "admin" text NOT NULL, "user_party" text NOT NULL, "market_id" bigint NOT NULL, "amount" numeric(38,10) NOT NULL, "reason" text NOT NULL, "created_at_sec" bigint NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_event_id" text NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "settled_kind" text, "settled_offset" bigint, "settled_at_ledger" TIMESTAMP WITH TIME ZONE, "tx_hash" text, "refunded" boolean, "settle_wallet_cid" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb, CONSTRAINT "PK_064cafcd12665e656458dc51c26" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(`CREATE INDEX "ix_to_ledger_payouts_market" ON "to_ledger_payouts" ("market_id")`);
    await q.query(`CREATE INDEX "ix_to_ledger_payouts_active" ON "to_ledger_payouts" ("active")`);
    await q.query(
      `CREATE INDEX "ix_to_ledger_payouts_user_active" ON "to_ledger_payouts" ("user_party", "active")`,
    );
    await q.query(
      `CREATE TABLE "to_attestations" ("contract_id" text NOT NULL, "attester" text NOT NULL, "admin" text NOT NULL, "market_id" bigint NOT NULL, "source_uri" text NOT NULL, "fetched_at_sec" bigint NOT NULL, "outcome" text NOT NULL, "payload_hash" text NOT NULL, "source_signature" text, "response_excerpt" text, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_45e9adcc95e5be5609b2304286e" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(`CREATE INDEX "ix_to_attestations_market" ON "to_attestations" ("market_id")`);
    await q.query(
      `CREATE TABLE "to_model_forecasts" ("contract_id" text NOT NULL, "author" text NOT NULL, "admin" text NOT NULL, "market_id" bigint NOT NULL, "model_id" text NOT NULL, "probability_yes" numeric(38,10) NOT NULL, "committed_at_sec" bigint NOT NULL, "market_price_at_commit" numeric(38,10) NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e18d4b8ea77d98fedbb75da1b8d" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(`CREATE INDEX "ix_to_model_forecasts_author" ON "to_model_forecasts" ("author")`);
    await q.query(
      `CREATE INDEX "ix_to_model_forecasts_market" ON "to_model_forecasts" ("market_id")`,
    );
    await q.query(
      `CREATE TABLE "to_prediction_models" ("contract_id" text NOT NULL, "author" text NOT NULL, "admin" text NOT NULL, "model_id" text NOT NULL, "name" text NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "payout_party" text NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0ffecb423bf5a3bcd67e0c5b61f" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_prediction_models_author" ON "to_prediction_models" ("author")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_prediction_models_model_id" ON "to_prediction_models" ("model_id")`,
    );
    // Any instrument; one row per (update, node).
    await q.query(
      `CREATE TABLE "to_ledger_transfers" ("id" BIGSERIAL NOT NULL, "update_id" text NOT NULL, "offset" bigint NOT NULL, "direction" text NOT NULL, "counterparty" text NOT NULL, "amount" numeric(38,10) NOT NULL, "choice" text NOT NULL, "record_time" TIMESTAMP WITH TIME ZONE, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "kind" text NOT NULL, "node_id" integer NOT NULL, CONSTRAINT "PK_e39cd1135497a0e5833e294afd9" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ledger_transfers_update_node" ON "to_ledger_transfers" ("update_id", "node_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_transfers_direction_offset" ON "to_ledger_transfers" ("direction", "offset")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_transfers_counterparty_offset" ON "to_ledger_transfers" ("counterparty", "offset")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_transfers_instrument_counterparty" ON "to_ledger_transfers" ("instrument_admin", "instrument_id", "counterparty", "direction")`,
    );
    // The treasury's token-standard holdings and two-step transfer offers.
    await q.query(
      `CREATE TABLE "to_ledger_holdings" ("contract_id" text NOT NULL, "owner" text NOT NULL, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "amount" numeric(38,10) NOT NULL, "locked" boolean NOT NULL DEFAULT false, "lock_expires_at" TIMESTAMP WITH TIME ZONE, "created_offset" bigint NOT NULL, "archived_offset" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ledger_holdings" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_holdings_instrument_owner" ON "to_ledger_holdings" ("instrument_admin", "instrument_id", "owner")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_holdings_archived" ON "to_ledger_holdings" ("archived_offset")`,
    );
    await q.query(
      `CREATE TABLE "to_ledger_transfer_instructions" ("contract_id" text NOT NULL, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "sender" text NOT NULL, "receiver" text NOT NULL, "amount" numeric(38,10) NOT NULL, "execute_before" TIMESTAMP WITH TIME ZONE, "status" text NOT NULL DEFAULT 'pending', "created_offset" bigint NOT NULL, "archived_offset" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ledger_transfer_instructions" PRIMARY KEY ("contract_id"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_transfer_instructions_status_receiver" ON "to_ledger_transfer_instructions" ("status", "receiver")`,
    );

    // ── market catalog ───────────────────────────────────────────────────────────────────────
    // Operator-managed series → event hierarchy, OHLC candles per 1 min / 1 h / 1 d (maintained by
    // the projection) and per-ticker presentation, which the contract does not carry.
    await q.query(
      `CREATE TABLE "to_series" ("ticker" text NOT NULL, "title" text NOT NULL, "category" text NOT NULL DEFAULT '', "frequency" text NOT NULL DEFAULT 'one_off', "tags" jsonb NOT NULL DEFAULT '[]'::jsonb, "settlement_sources" jsonb NOT NULL DEFAULT '[]'::jsonb, "contract_url" text, "description" text NOT NULL DEFAULT '', "status" text NOT NULL DEFAULT 'active', "product_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb, "created_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_series" PRIMARY KEY ("ticker"))`,
    );
    await q.query(`CREATE INDEX "ix_to_series_status" ON "to_series" ("status")`);
    await q.query(`CREATE INDEX "ix_to_series_category" ON "to_series" ("category")`);
    // collateral_*: the event's one collateral, null until its first market.
    await q.query(
      `CREATE TABLE "to_events" ("ticker" text NOT NULL, "series_ticker" text NOT NULL, "title" text NOT NULL, "sub_title" text NOT NULL DEFAULT '', "image_url" text NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "mutually_exclusive" boolean NOT NULL DEFAULT false, "strike_date" TIMESTAMP WITH TIME ZONE, "strike_period" text, "settlement_sources" jsonb NOT NULL DEFAULT '[]'::jsonb, "product_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb, "archived" boolean NOT NULL DEFAULT false, "created_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "collateral_admin" text, "collateral_id" text, CONSTRAINT "PK_to_events" PRIMARY KEY ("ticker"))`,
    );
    await q.query(`CREATE INDEX "ix_to_events_archived" ON "to_events" ("archived")`);
    await q.query(`CREATE INDEX "ix_to_events_series" ON "to_events" ("series_ticker")`);
    await q.query(
      `CREATE TABLE "to_market_candles" ("market_id" bigint NOT NULL, "period_secs" integer NOT NULL, "period_start" TIMESTAMP WITH TIME ZONE NOT NULL, "open" numeric(38,10) NOT NULL, "high" numeric(38,10) NOT NULL, "low" numeric(38,10) NOT NULL, "close" numeric(38,10) NOT NULL, "volume" numeric(38,10) NOT NULL DEFAULT '0', "notional" numeric(38,10) NOT NULL DEFAULT '0', "trades" integer NOT NULL DEFAULT '0', "open_interest" numeric(38,10) NOT NULL DEFAULT '0', "liquidity_l" numeric(38,10), "last_offset" bigint NOT NULL, "last_node_id" integer NOT NULL DEFAULT '0', "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_market_candles" PRIMARY KEY ("market_id", "period_secs", "period_start"))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_market_candles_period_start" ON "to_market_candles" ("period_secs", "period_start")`,
    );
    await q.query(
      `CREATE TABLE "to_market_metadata" ("ticker" text NOT NULL, "image_url" text NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "updated_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_market_metadata" PRIMARY KEY ("ticker"))`,
    );

    // ── instruments and rewards ──────────────────────────────────────────────────────────────
    await q.query(
      `CREATE TABLE "to_instruments" ("admin" text NOT NULL, "id" text NOT NULL, "symbol" text NOT NULL, "name" text NOT NULL, "decimals" integer NOT NULL, "kind" text NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "is_default_collateral" boolean NOT NULL DEFAULT false, "registry_url" text, "registry_auth" text NOT NULL DEFAULT 'keycloak', "transfer_mode" text, "wallet_instrument_id" text NOT NULL, "setup_choices" jsonb NOT NULL DEFAULT '{}'::jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_instruments" PRIMARY KEY ("admin", "id"))`,
    );
    await q.query(`CREATE INDEX "ix_to_instruments_kind" ON "to_instruments" ("kind")`);
    // At most one default collateral: a unique index over the flag where it is set.
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_instruments_default_collateral" ON "to_instruments" ("is_default_collateral") WHERE "is_default_collateral" = true`,
    );
    await q.query(
      `CREATE TABLE "to_reward_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "kind" text NOT NULL, "params" jsonb NOT NULL DEFAULT '{}'::jsonb, "enabled" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_reward_rules" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE UNIQUE INDEX "uq_to_reward_rules_kind" ON "to_reward_rules" ("kind")`);
    await q.query(
      `CREATE TABLE "to_reward_grants" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid, "party" text NOT NULL, "rule_id" uuid, "kind" text NOT NULL, "source_event_id" text, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "amount" numeric(38,10) NOT NULL, "reason" text NOT NULL, "status" text NOT NULL DEFAULT 'queued', "command_id" text, "ref" text NOT NULL, "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "submitted_at" TIMESTAMP WITH TIME ZONE, "credited_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_to_reward_grants" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "ix_to_reward_grants_user" ON "to_reward_grants" ("user_id")`);
    await q.query(`CREATE INDEX "ix_to_reward_grants_party" ON "to_reward_grants" ("party")`);
    await q.query(`CREATE INDEX "ix_to_reward_grants_status" ON "to_reward_grants" ("status")`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_reward_grants_source_event_id" ON "to_reward_grants" ("source_event_id")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_reward_grants_command_id" ON "to_reward_grants" ("command_id")`,
    );
    await q.query(`CREATE UNIQUE INDEX "uq_to_reward_grants_ref" ON "to_reward_grants" ("ref")`);
    await q.query(
      `ALTER TABLE "to_reward_grants" ADD CONSTRAINT "FK_to_reward_grants_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_reward_grants" ADD CONSTRAINT "FK_to_reward_grants_rule" FOREIGN KEY ("rule_id") REFERENCES "to_reward_rules"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    // Where the RewardsProcessor starts reading the index. The three automatic rules are NOT seeded
    // here: RewardsService.seedRules creates them once at boot — disabled, except on APP_ENV=dev
    // where they come up enabled with their documented defaults (docs/TOKENS.md §4.6) — so the dev
    // default is a property of the environment, not of the migration. `manual` grants need no row.
    await q.query(
      `INSERT INTO "to_settings" ("key", "value") VALUES ('rewards_cursor', '0') ON CONFLICT ("key") DO NOTHING`,
    );

    // ── ramp: orders, webhook inbox, journal ─────────────────────────────────────────────────
    // Tokenised cards: sealed tokens, one card one account.
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
    // The state machine: every idempotency key a column, `version` for the CAS of I6, the captured /
    // refunded amounts, the amount identities as CHECKs.
    await q.query(
      `CREATE TABLE "to_ramp_orders" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "direction" text NOT NULL, "status" text NOT NULL, "review_step" text, "version" integer NOT NULL DEFAULT 0, "provider" text NOT NULL, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "party_id" text NOT NULL, "fiat_currency" text NOT NULL, "fiat_amount" numeric(38,10) NOT NULL, "token_amount" numeric(38,10) NOT NULL, "fee_amount" numeric(38,10) NOT NULL, "payment_method_id" uuid, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL, "provider_payment_id" text, "provider_payout_id" text, "provider_refund_id" text, "checkout_url" text, "expires_at" TIMESTAMP WITH TIME ZONE, "captured_amount" numeric(38,10), "captured_at" TIMESTAMP WITH TIME ZONE, "refunded_amount" numeric(38,10) NOT NULL DEFAULT 0, "mint_command_id" text, "credit_command_id" text, "pending_payout_cid" text, "burn_command_id" text, "remint_command_id" text, "remint_credit_command_id" text, "method" text, "payment_instructions" jsonb, "payout_rail" text, "bank_account_id" uuid, "payout_batch_id" uuid, "payout_reference" text NOT NULL, "operator" jsonb NOT NULL, "consent_id" uuid, "risk" jsonb NOT NULL DEFAULT '{}'::jsonb, "attempts" integer NOT NULL DEFAULT 0, "last_error" text, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "status_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_polled_at" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_orders" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "CHK_to_ramp_orders_direction" CHECK ("direction" IN ('onramp', 'offramp')), ` +
        `CONSTRAINT "CHK_to_ramp_orders_fiat_currency" CHECK ("fiat_currency" IN (${list(FIAT_CURRENCIES)})), ` +
        `CONSTRAINT "CHK_to_ramp_orders_status" CHECK ("status" IN (${list(ORDER_STATUSES)})), ` +
        `CONSTRAINT "CHK_to_ramp_orders_review_step" CHECK ((("status" = 'needs_review') = ("review_step" IS NOT NULL)) AND ("review_step" IS NULL OR "review_step" IN (${list(REVIEW_STEPS)}))), ` +
        `CONSTRAINT "CHK_to_ramp_orders_amounts" CHECK ("fiat_amount" > 0 AND "token_amount" > 0 AND "fee_amount" >= 0), ` +
        // F = N + f on-ramp, T = P + f off-ramp: every posting of SPEC §5 balances because of these.
        `CONSTRAINT "CHK_to_ramp_orders_identity" CHECK (("direction" = 'onramp' AND "fiat_amount" = "token_amount" + "fee_amount") OR ("direction" = 'offramp' AND "token_amount" = "fiat_amount" + "fee_amount")), ` +
        `CONSTRAINT "CHK_to_ramp_orders_capture" CHECK (("captured_amount" IS NULL) = ("captured_at" IS NULL) AND ("captured_amount" IS NULL OR "captured_amount" > 0) AND "refunded_amount" >= 0 AND "refunded_amount" <= COALESCE("captured_amount", 0) AND ("direction" = 'onramp' OR "captured_amount" IS NULL)), ` +
        `CONSTRAINT "CHK_to_ramp_orders_counters" CHECK ("version" >= 0 AND "attempts" >= 0), ` +
        // A method on every on-ramp only, a rail on every off-ramp only; a bank cash-out names its account.
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
    // A card's captures (card cash-out planning) and the bank rail's lookups.
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_payment_method" ON "to_ramp_orders" ("payment_method_id") WHERE "payment_method_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_bank_account" ON "to_ramp_orders" ("bank_account_id") WHERE "bank_account_id" IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_orders_payout_batch" ON "to_ramp_orders" ("payout_batch_id") WHERE "payout_batch_id" IS NOT NULL`,
    );
    await q.query(`CREATE INDEX "ix_to_ramp_orders_consent" ON "to_ramp_orders" ("consent_id")`);
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
    // The bank account, payout batch and consent foreign keys follow their tables below.
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_payment_method" FOREIGN KEY ("payment_method_id") REFERENCES "to_ramp_payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    // The webhook inbox, with back-off and a dead letter.
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
    // Double entry in fiat. The statement-line foreign key follows to_ramp_bank_lines below.
    await q.query(
      `CREATE TABLE "to_ramp_journal" ("id" BIGSERIAL NOT NULL, "entry_id" uuid NOT NULL, "kind" text NOT NULL, "order_id" uuid, "statement_line_id" uuid, "user_id" uuid, "account" text NOT NULL, "currency" text NOT NULL, "amount" numeric(38,10) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_journal" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "CHK_to_ramp_journal_account" CHECK ("account" IN (${list(JOURNAL_ACCOUNTS)})), ` +
        `CONSTRAINT "CHK_to_ramp_journal_amount" CHECK ("amount" <> 0), ` +
        `CONSTRAINT "CHK_to_ramp_journal_currency" CHECK ("currency" IN (${list(FIAT_CURRENCIES)})), ` +
        // The per-client sub-ledger (R12): every client-liability line names its user.
        `CONSTRAINT "CHK_to_ramp_journal_user" CHECK ("account" NOT IN ('issuance_pending', 'customer_liability', 'payout_clearing') OR "user_id" IS NOT NULL), ` +
        // An on-ramp's bank refund and its return are never booked without the statement line.
        `CONSTRAINT "CHK_to_ramp_journal_bank_refund_line" CHECK ("kind" NOT IN ('refund.paid_bank', 'refund.returned_bank') OR "statement_line_id" IS NOT NULL))`,
    );
    await q.query(`CREATE INDEX "ix_to_ramp_journal_entry" ON "to_ramp_journal" ("entry_id")`);
    await q.query(`CREATE INDEX "ix_to_ramp_journal_account" ON "to_ramp_journal" ("account")`);
    await q.query(`CREATE INDEX "ix_to_ramp_journal_user" ON "to_ramp_journal" ("user_id")`);
    // One posting per (order, kind): a line per account each. A bank refund the bank returns is paid
    // again, so its two kinds repeat per order — once per statement line each (the index after next).
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_order_kind" ON "to_ramp_journal" ("order_id", "kind", "account") WHERE "order_id" IS NOT NULL AND "kind" NOT IN ('refund.paid_bank', 'refund.returned_bank')`,
    );
    // A line-scoped kind once per statement line; an order-scoped kind booked on a line once per
    // (line, order) — a batch-total debit books every item's `offramp.paid_bank` on the same line.
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_line_kind" ON "to_ramp_journal" ("statement_line_id", "kind", "account") WHERE "statement_line_id" IS NOT NULL AND "order_id" IS NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ramp_journal_line_order_kind" ON "to_ramp_journal" ("statement_line_id", "order_id", "kind", "account") WHERE "statement_line_id" IS NOT NULL AND "order_id" IS NOT NULL`,
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

    // ── ramp: token-app command ledger (docs/RAMP.md §3.4, §7) ───────────────────────────────
    // One row per token-app mint / burn, written before the POST.
    await q.query(
      `CREATE TABLE "to_token_commands" ("command_id" text NOT NULL, "kind" text NOT NULL, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "party_id" text NOT NULL, "amount" numeric(38,10) NOT NULL, "source" text NOT NULL, "ref" text, "status" text NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT 0, "last_post_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "last_http_status" integer, "update_id" text, "recorded_amount" numeric(38,10), "recorded_at" TIMESTAMP WITH TIME ZONE, "resolved_by" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_token_commands" PRIMARY KEY ("command_id"), CONSTRAINT "CHK_to_token_commands_kind" CHECK ("kind" IN ('mint', 'burn')), CONSTRAINT "CHK_to_token_commands_source" CHECK ("source" IN ('ramp', 'admin', 'rewards', 'faucet', 'check', 'legacy')), CONSTRAINT "CHK_to_token_commands_status" CHECK ("status" IN ('pending', 'submitted', 'unknown', 'recorded', 'rejected', 'mismatch', 'abandoned')), CONSTRAINT "CHK_to_token_commands_amounts" CHECK ("amount" > 0 AND ("recorded_amount" IS NULL OR "recorded_amount" >= 0) AND "attempts" >= 0))`,
    );
    await q.query(`CREATE INDEX "ix_to_token_commands_status" ON "to_token_commands" ("status")`);
    await q.query(
      `CREATE INDEX "ix_to_token_commands_instrument" ON "to_token_commands" ("instrument_id", "kind", "status")`,
    );
    await q.query(`CREATE INDEX "ix_to_token_commands_ref" ON "to_token_commands" ("ref")`);
    // The paged mirror of token-app's records. Its identity is a unique EXPRESSION index over
    // coalesce(update_id, '') / coalesce(command_id, ''): with plain nullable columns Postgres treats
    // NULLs as distinct and a record without either id would be re-inserted on every sync pass (#14).
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

    // ── ramp: controls and four-eyes approvals (SPEC §6) ─────────────────────────────────────
    // The one halt row, key 'ramp'; no row = no halt.
    await q.query(
      `CREATE TABLE "to_ramp_controls" ("key" text NOT NULL, "halted_scopes" text[] NOT NULL DEFAULT '{}', "reason" text, "source" text, "failing_checks" jsonb, "since" TIMESTAMP WITH TIME ZONE, "set_by_user_id" uuid, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_controls" PRIMARY KEY ("key"), CONSTRAINT "CHK_to_ramp_controls_key" CHECK ("key" = 'ramp'), CONSTRAINT "CHK_to_ramp_controls_scopes" CHECK ("halted_scopes" <@ ARRAY['orders', 'mints', 'payouts']::text[]), CONSTRAINT "CHK_to_ramp_controls_source" CHECK ("source" IS NULL OR "source" IN ('admin', 'auto')))`,
    );
    // Every reconciliation run with its checks.
    await q.query(
      `CREATE TABLE "to_ramp_recon_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "trigger" text NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, "status" text NOT NULL DEFAULT 'unknown', "checks" jsonb NOT NULL DEFAULT '[]'::jsonb, "halted" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_to_ramp_recon_runs" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_ramp_recon_runs_trigger" CHECK ("trigger" IN ('schedule', 'admin', 'pre_batch', 'sync')), CONSTRAINT "CHK_to_ramp_recon_runs_status" CHECK ("status" IN ('green', 'amber', 'red', 'unknown')))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_recon_runs_trigger_started" ON "to_ramp_recon_runs" ("trigger", "started_at")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ramp_recon_runs_started" ON "to_ramp_recon_runs" ("started_at")`,
    );
    // Four-eyes requests: one PENDING request per action and subject.
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

    // ── ramp: the bank rail (SPEC §10) ───────────────────────────────────────────────────────
    // User bank accounts: sealed IBAN + keyed blind index.
    await q.query(
      `CREATE TABLE "to_ramp_bank_accounts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "iban_sealed" text NOT NULL, "iban_hash" text NOT NULL, "iban_hash_kid" text NOT NULL, "iban_last4" text NOT NULL, "country" text NOT NULL DEFAULT 'BY', "bank_code" text NOT NULL, "bic" text NOT NULL, "bank_name" text NOT NULL, "name_form" text NOT NULL, "status" text NOT NULL, "cooling_off_until" TIMESTAMP WITH TIME ZONE NOT NULL, "proof" text, "proof_ref" text, "verified_at" TIMESTAMP WITH TIME ZONE, "first_payout_order_id" uuid, "last_used_at" TIMESTAMP WITH TIME ZONE, "removed_at" TIMESTAMP WITH TIME ZONE, "blocked_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_bank_accounts" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "FK_to_ramp_bank_accounts_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT, ` +
        `CONSTRAINT "CHK_to_ramp_bank_accounts_status" CHECK ("status" IN (${list(BANK_ACCOUNT_STATUSES)})), ` +
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
        `CONSTRAINT "CHK_to_ramp_payout_batches_currency" CHECK ("currency" IN (${list(FIAT_CURRENCIES)})), ` +
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
    // Client-money statements: one chain per account (one first statement, no fork), one confirmed
    // copy per file.
    await q.query(
      `CREATE TABLE "to_ramp_bank_statements" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "account_iban" text NOT NULL, "format" text NOT NULL, "file_sha256" text NOT NULL, "canonical_hash" text NOT NULL, "canonical_kid" text NOT NULL, "period_from" date NOT NULL, "period_to" date NOT NULL, "opening_balance" numeric(38,10) NOT NULL, "closing_balance" numeric(38,10) NOT NULL, "currency" text NOT NULL, "prev_statement_id" uuid, "status" text NOT NULL DEFAULT 'draft', "imported_by_user_id" uuid NOT NULL, "imported_by_person" text NOT NULL, "approval_id" uuid, "second_copy_person" text, "second_copy_at" TIMESTAMP WITH TIME ZONE, "confirmed_at" TIMESTAMP WITH TIME ZONE, "line_count" integer NOT NULL DEFAULT 0, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_ramp_bank_statements" PRIMARY KEY ("id"), ` +
        `CONSTRAINT "FK_to_ramp_bank_statements_prev" FOREIGN KEY ("prev_statement_id") REFERENCES "to_ramp_bank_statements"("id") ON DELETE RESTRICT, ` +
        `CONSTRAINT "CHK_to_ramp_bank_statements_format" CHECK ("format" IN ('csv', 'camt053')), ` +
        `CONSTRAINT "CHK_to_ramp_bank_statements_currency" CHECK ("currency" IN (${list(FIAT_CURRENCIES)})), ` +
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
        `CONSTRAINT "CHK_to_ramp_bank_lines_currency" CHECK ("currency" IN (${list(FIAT_CURRENCIES)})), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_status" CHECK ("status" IN ('unmatched', 'proposed', 'matched') AND (("status" = 'unmatched') = ("match_kind" IS NULL))), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_kind" CHECK ("match_kind" IS NULL OR "match_kind" IN (${list(MATCH_KINDS)})), ` +
        `CONSTRAINT "CHK_to_ramp_bank_lines_flags" CHECK ("flags" <@ ARRAY[${list(LINE_FLAGS)}]::text[]), ` +
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
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_bank_account" FOREIGN KEY ("bank_account_id") REFERENCES "to_ramp_bank_accounts"("id") ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_orders" ADD CONSTRAINT "FK_to_ramp_orders_payout_batch" FOREIGN KEY ("payout_batch_id") REFERENCES "to_ramp_payout_batches"("id") ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE "to_ramp_journal" ADD CONSTRAINT "FK_to_ramp_journal_statement_line" FOREIGN KEY ("statement_line_id") REFERENCES "to_ramp_bank_lines"("id") ON DELETE RESTRICT`,
    );

    // ── ramp: compliance (SPEC §11) ──────────────────────────────────────────────────────────
    // Nothing here is ever deleted by a job (≥ 5 years, R4).
    // The verified art.8 identity of an account, sealed with AAD `kyc-id|<userId>`; plain columns
    // only for what the rules filter on.
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
    // One alert per user, rule and window. Alerts reference orders by id only: a create-point alert
    // names an order that may never exist.
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

    // ── ramp: screening and freezes (SPEC §11.6; B1, B3) ─────────────────────────────────────
    // One ACTIVE freeze per account. `provisional` = placed by a list hit, awaiting the AML decision;
    // `activity_offset` = the ledger offset up to which the account's on-ledger activity was checked
    // for TM-FROZEN-ACTIVITY.
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
    // One row per imported list version.
    await q.query(
      `CREATE TABLE "to_screening_lists" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "list" text NOT NULL, "version" text NOT NULL, "delivered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "imported_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "imported_by_user_id" uuid, "imported_by_person" text, "charset" text NOT NULL DEFAULT 'utf-8', "sha256" text NOT NULL, "entry_count" integer NOT NULL, CONSTRAINT "PK_to_screening_lists" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_screening_lists_list" CHECK ("list" IN ('by_terror', 'un', 'decree48', 'foreign')), CONSTRAINT "CHK_to_screening_lists_version" CHECK (length("version") BETWEEN 1 AND 64), CONSTRAINT "CHK_to_screening_lists_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'), CONSTRAINT "CHK_to_screening_lists_count" CHECK ("entry_count" >= 0))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_screening_lists_version" ON "to_screening_lists" ("list", "version")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_screening_lists_latest" ON "to_screening_lists" ("list", "imported_at")`,
    );
    // Name-fold keys, birth date, ids.
    await q.query(
      `CREATE TABLE "to_screening_entries" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "list_id" uuid NOT NULL, "line" integer NOT NULL, "kind" text NOT NULL, "names" text[] NOT NULL DEFAULT '{}', "name_keys" text[] NOT NULL DEFAULT '{}', "birth_date" text, "ids" text[] NOT NULL DEFAULT '{}', CONSTRAINT "PK_to_screening_entries" PRIMARY KEY ("id"), CONSTRAINT "FK_to_screening_entries_list" FOREIGN KEY ("list_id") REFERENCES "to_screening_lists"("id") ON DELETE RESTRICT, CONSTRAINT "CHK_to_screening_entries_kind" CHECK ("kind" IN ('person', 'org', 'address')), CONSTRAINT "CHK_to_screening_entries_birth_date" CHECK ("birth_date" IS NULL OR "birth_date" ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$'))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_screening_entries_list" ON "to_screening_entries" ("list_id", "line")`,
    );
    // Every re-screen: the record that every client was screened at least every RAMP_RESCREEN_DAYS.
    await q.query(
      `CREATE TABLE "to_screening_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "trigger" text NOT NULL, "scope" text NOT NULL, "user_id" uuid, "list_ids" uuid[] NOT NULL DEFAULT '{}', "status" text NOT NULL DEFAULT 'running', "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, "started_by_user_id" uuid, "subjects" integer NOT NULL DEFAULT 0, "identities" integer NOT NULL DEFAULT 0, "parties" integer NOT NULL DEFAULT 0, "hits" integer NOT NULL DEFAULT 0, "failures" integer NOT NULL DEFAULT 0, "unreadable" integer NOT NULL DEFAULT 0, "error" text, CONSTRAINT "PK_to_screening_runs" PRIMARY KEY ("id"), CONSTRAINT "CHK_to_screening_runs_trigger" CHECK ("trigger" IN ('import', 'schedule', 'admin', 'user')), CONSTRAINT "CHK_to_screening_runs_scope" CHECK (("scope" = 'full' AND "user_id" IS NULL) OR ("scope" = 'user' AND "user_id" IS NOT NULL)), CONSTRAINT "CHK_to_screening_runs_status" CHECK ("status" IN ('running', 'done', 'partial', 'failed')))`,
    );
    await q.query(
      `CREATE INDEX "ix_to_screening_runs_scope_started" ON "to_screening_runs" ("scope", "started_at")`,
    );
    // When each account was last screened, against which list versions, which KYC verification,
    // which party ids and which latest consent — a change re-screens before the next order (C27 /
    // C13) — and, when its identity could not be read, why: the account stays refused and a full
    // re-screen still completes (C44).
    await q.query(
      `CREATE TABLE "to_screening_subjects" ("user_id" uuid NOT NULL, "screened_at" TIMESTAMP WITH TIME ZONE NOT NULL, "run_id" uuid NOT NULL, "list_ids" uuid[] NOT NULL DEFAULT '{}', "identity" boolean NOT NULL, "kyc_verification_id" uuid, "identity_refreshed_at" TIMESTAMP WITH TIME ZONE, "parties" integer NOT NULL DEFAULT 0, "party_ids" text[] NOT NULL DEFAULT '{}', "consent_id" uuid, "identity_error" text, "identity_unreadable_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_to_screening_subjects" PRIMARY KEY ("user_id"), CONSTRAINT "FK_to_screening_subjects_user" FOREIGN KEY ("user_id") REFERENCES "to_users"("id") ON DELETE RESTRICT, CONSTRAINT "FK_to_screening_subjects_run" FOREIGN KEY ("run_id") REFERENCES "to_screening_runs"("id") ON DELETE RESTRICT)`,
    );
    // One hit per list version, entry and account.
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
    await q.query(
      `CREATE FUNCTION "to_compliance_no_delete"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% rows are retained (SPEC §11.6, R4): DELETE is refused', TG_TABLE_NAME; END $$`,
    );
    for (const table of RETAINED)
      await q.query(
        `CREATE TRIGGER "trg_${table}_no_delete" BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "to_compliance_no_delete"()`,
      );
  }

  public async down(q: QueryRunner): Promise<void> {
    // One statement, so the foreign keys between the tables impose no order.
    await q.query(
      `DROP TABLE "to_screening_hits", "to_screening_subjects", "to_screening_runs", "to_screening_entries", "to_screening_lists", "to_compliance_freezes", ` +
        `"to_compliance_alerts", "to_ramp_consents", "to_kyc_identity_versions", "to_kyc_identities", ` +
        `"to_ramp_bank_lines", "to_ramp_bank_statements", "to_ramp_payout_batch_items", "to_ramp_payout_batches", "to_ramp_bank_accounts", ` +
        `"to_admin_approvals", "to_ramp_recon_runs", "to_ramp_controls", ` +
        `"to_token_app_records", "to_token_commands", ` +
        `"to_ramp_journal", "to_ramp_events", "to_ramp_orders", "to_ramp_payment_methods", ` +
        `"to_reward_grants", "to_reward_rules", "to_instruments", ` +
        `"to_market_metadata", "to_market_candles", "to_events", "to_series", ` +
        `"to_ledger_transfer_instructions", "to_ledger_holdings", "to_ledger_transfers", "to_prediction_models", "to_model_forecasts", "to_attestations", "to_ledger_payouts", "to_wallet_entries", "to_ledger_wallets", "to_liquidity_positions", "to_positions", "to_market_events", "to_market_snapshots", "to_markets", "to_ledger_events", "to_indexer_state", ` +
        `"to_audit_events", "to_deposit_credits", "to_payouts", "to_kyc_webhook_events", "to_kyc_persons", "to_kyc_verifications", "to_sessions", "to_wallet_credits", "to_wallets", "to_auth_identities", "to_users", "to_settings"`,
    );
    await q.query(`DROP SEQUENCE "to_ramp_payout_document_no_seq"`);
    await q.query(`DROP FUNCTION "to_compliance_no_delete"()`);
    await q.query(`DROP FUNCTION "to_ramp_consents_append_only"()`);
    await q.query(`DROP FUNCTION "to_kyc_identity_versions_append_only"()`);
    await q.query(`DROP FUNCTION "to_kyc_identities_retained"()`);
    await q.query(`DROP FUNCTION "to_ramp_journal_append_only"()`);
  }
}
