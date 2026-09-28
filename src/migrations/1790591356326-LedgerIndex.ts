import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The ledger index (docs/INDEXER.md §3): fourteen `to_*` tables the indexer keeps as a projection
 * of the treasury's view of the ledger — the cursor row, the raw event log, and the typed
 * markets / snapshots / activity / positions / LP positions / wallets / wallet entries / payouts /
 * attestations / forecasts / models / transfers. No foreign keys to the account tables: rows are
 * keyed by Canton party and contract id, and the join to an account happens at read time through
 * `to_users.party_id` / `to_wallets.party_id`. Generated from the entities with
 * `typeorm migration:generate` (the cosmetic `'{}'` vs `'{}'::jsonb` default rewrites it also
 * proposed for the Init tables were dropped — Init.ts notes those are not drift). Additive:
 * nothing in the Init schema changes, so `down` only drops what `up` created.
 */
export class LedgerIndex1790591356326 implements MigrationInterface {
    name = 'LedgerIndex1790591356326'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "to_indexer_state" ("key" text NOT NULL, "offset" bigint NOT NULL DEFAULT '0', "ledger_end" bigint, "pruned_offset" bigint, "bootstrapped_at" TIMESTAMP WITH TIME ZONE, "bootstrap_offset" bigint, "last_update_id" text, "last_record_time" TIMESTAMP WITH TIME ZONE, "last_error" text, "last_error_at" TIMESTAMP WITH TIME ZONE, "market_counter_cid" text, "market_counter_value" bigint, "gaps" jsonb NOT NULL DEFAULT '[]'::jsonb, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_10af6f71f4d7d9f0aabfeb04869" PRIMARY KEY ("key"))`);
        await queryRunner.query(`CREATE TABLE "to_ledger_events" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "offset" bigint NOT NULL, "node_id" integer NOT NULL, "update_id" text NOT NULL, "kind" text NOT NULL, "package_name" text NOT NULL, "module" text NOT NULL, "entity" text NOT NULL, "template_id" text NOT NULL, "contract_id" text NOT NULL, "choice" text, "consuming" boolean, "acting_parties" jsonb NOT NULL DEFAULT '[]'::jsonb, "witness_parties" jsonb NOT NULL DEFAULT '[]'::jsonb, "signatories" jsonb, "observers" jsonb, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "result" jsonb, "parent_node_id" integer, "root_node_id" integer, "last_descendant_node_id" integer, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "record_time" TIMESTAMP WITH TIME ZONE, "command_id" text, "workflow_id" text, "synchronizer_id" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ae79f115b1ca70d70ceb03f3430" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_ledger_events_event_id" ON "to_ledger_events"  ("event_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_events_update_id" ON "to_ledger_events"  ("update_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_events_contract_id" ON "to_ledger_events"  ("contract_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_events_entity_offset" ON "to_ledger_events"  ("entity", "offset") `);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_events_offset_node" ON "to_ledger_events"  ("offset", "node_id") `);
        await queryRunner.query(`CREATE TABLE "to_markets" ("market_id" bigint NOT NULL, "contract_id" text NOT NULL, "admin" text NOT NULL, "question" text NOT NULL, "image_url" text NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "resolution_description" text NOT NULL DEFAULT '', "category" text NOT NULL DEFAULT '', "created_at_sec" bigint NOT NULL, "expires_at_sec" bigint NOT NULL, "grace_period_secs" integer NOT NULL DEFAULT '0', "is_dynamic" boolean NOT NULL DEFAULT false, "liquidity_period_secs" integer NOT NULL DEFAULT '0', "reserve_yes" numeric(38,10) NOT NULL DEFAULT '0', "reserve_no" numeric(38,10) NOT NULL DEFAULT '0', "liquidity_l" numeric(38,10) NOT NULL DEFAULT '0', "lp_token_supply" numeric(38,10) NOT NULL DEFAULT '0', "current_price" numeric(38,10) NOT NULL DEFAULT '0', "fee_bps" integer NOT NULL DEFAULT '0', "prize_fee_share_bps" integer NOT NULL DEFAULT '0', "accumulated_fees_cc" numeric(38,10) NOT NULL DEFAULT '0', "prize_pool_cc" numeric(38,10) NOT NULL DEFAULT '0', "total_volume_cc" numeric(38,10) NOT NULL DEFAULT '0', "status" text NOT NULL DEFAULT 'Trading', "outcome" text, "resolved_at_sec" bigint, "proposal" jsonb, "policy" jsonb NOT NULL DEFAULT '{}'::jsonb, "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb, "created_event_blob" text, "synchronizer_id" text, "created_offset" bigint NOT NULL, "updated_offset" bigint NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "updated_at_ledger" TIMESTAMP WITH TIME ZONE, "archived" boolean NOT NULL DEFAULT false, "archived_offset" bigint, "trade_count" integer NOT NULL DEFAULT '0', "last_trade_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_98f76274c8dc876849d0cb2f3f1" PRIMARY KEY ("market_id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_markets_contract_id" ON "to_markets"  ("contract_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_markets_updated_offset" ON "to_markets"  ("updated_offset") `);
        await queryRunner.query(`CREATE INDEX "ix_to_markets_expires_at" ON "to_markets"  ("expires_at_sec") `);
        await queryRunner.query(`CREATE INDEX "ix_to_markets_category" ON "to_markets"  ("category") `);
        await queryRunner.query(`CREATE INDEX "ix_to_markets_status" ON "to_markets"  ("status") `);
        await queryRunner.query(`CREATE TABLE "to_market_snapshots" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "market_id" bigint NOT NULL, "contract_id" text NOT NULL, "offset" bigint NOT NULL, "node_id" integer NOT NULL, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "price" numeric(38,10) NOT NULL, "reserve_yes" numeric(38,10) NOT NULL, "reserve_no" numeric(38,10) NOT NULL, "liquidity_l" numeric(38,10) NOT NULL, "lp_token_supply" numeric(38,10) NOT NULL, "total_volume_cc" numeric(38,10) NOT NULL, "accumulated_fees_cc" numeric(38,10) NOT NULL, "prize_pool_cc" numeric(38,10) NOT NULL, "status" text NOT NULL, "cause" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_df263b306d21fa52fc119b5640b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_market_snapshots_event_id" ON "to_market_snapshots"  ("event_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_market_snapshots_market_offset" ON "to_market_snapshots"  ("market_id", "offset") `);
        await queryRunner.query(`CREATE INDEX "ix_to_market_snapshots_market_time" ON "to_market_snapshots"  ("market_id", "effective_at") `);
        await queryRunner.query(`CREATE TABLE "to_market_events" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "market_id" bigint NOT NULL, "kind" text NOT NULL, "actor" text NOT NULL, "side" text, "amount_cc" numeric(38,10), "net_cc" numeric(38,10), "shares" numeric(38,10), "shares_out" numeric(38,10), "fee_cc" numeric(38,10), "price_before" numeric(38,10), "price_after" numeric(38,10), "lp_tokens" numeric(38,10), "outcome" text, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "offset" bigint NOT NULL, "node_id" integer NOT NULL, "update_id" text NOT NULL, "command_id" text, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "record_time" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7db09e88ac04339a68921222c95" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_market_events_event_id" ON "to_market_events"  ("event_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_market_events_effective_at" ON "to_market_events"  ("effective_at") `);
        await queryRunner.query(`CREATE INDEX "ix_to_market_events_kind_offset" ON "to_market_events"  ("kind", "offset") `);
        await queryRunner.query(`CREATE INDEX "ix_to_market_events_actor_offset" ON "to_market_events"  ("actor", "offset") `);
        await queryRunner.query(`CREATE INDEX "ix_to_market_events_market_offset" ON "to_market_events"  ("market_id", "offset") `);
        await queryRunner.query(`CREATE TABLE "to_positions" ("contract_id" text NOT NULL, "holder" text NOT NULL, "admin" text NOT NULL, "market_id" bigint NOT NULL, "yes_shares" numeric(38,10) NOT NULL DEFAULT '0', "no_shares" numeric(38,10) NOT NULL DEFAULT '0', "cost_basis_cc" numeric(38,10) NOT NULL DEFAULT '0', "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_event_id" text NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "archived_choice" text, "archived_at_ledger" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_c06986686141c8b8e30fd14420a" PRIMARY KEY ("contract_id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_positions_holder_market" ON "to_positions"  ("holder", "market_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_positions_market_active" ON "to_positions"  ("market_id", "active") `);
        await queryRunner.query(`CREATE INDEX "ix_to_positions_holder_active" ON "to_positions"  ("holder", "active") `);
        await queryRunner.query(`CREATE TABLE "to_liquidity_positions" ("contract_id" text NOT NULL, "provider" text NOT NULL, "admin" text NOT NULL, "market_id" bigint NOT NULL, "lp_tokens" numeric(38,10) NOT NULL DEFAULT '0', "deposited_cc" numeric(38,10) NOT NULL DEFAULT '0', "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_event_id" text NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "archived_choice" text, "archived_at_ledger" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_04555772bdcb035ae9ecd49aacf" PRIMARY KEY ("contract_id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_liquidity_positions_market_active" ON "to_liquidity_positions"  ("market_id", "active") `);
        await queryRunner.query(`CREATE INDEX "ix_to_liquidity_positions_provider_active" ON "to_liquidity_positions"  ("provider", "active") `);
        await queryRunner.query(`CREATE TABLE "to_ledger_wallets" ("contract_id" text NOT NULL, "owner" text NOT NULL, "admin" text NOT NULL, "balance_cc" numeric(38,10) NOT NULL DEFAULT '0', "deposited_cc" numeric(38,10) NOT NULL DEFAULT '0', "withdrawn_cc" numeric(38,10) NOT NULL DEFAULT '0', "deposit_refs" jsonb NOT NULL DEFAULT '[]'::jsonb, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_event_id" text NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "archived_choice" text, "archived_at_ledger" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e70cc33bd1a7afe401cb9017e6f" PRIMARY KEY ("contract_id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_wallets_owner_active" ON "to_ledger_wallets"  ("owner", "active") `);
        await queryRunner.query(`CREATE TABLE "to_wallet_entries" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "owner" text NOT NULL, "wallet_cid" text NOT NULL, "new_wallet_cid" text, "kind" text NOT NULL, "amount_cc" numeric(38,10) NOT NULL, "reason" text, "tx_ref" text, "balance_after" numeric(38,10), "market_id" bigint, "root_choice" text, "root_template" text, "offset" bigint NOT NULL, "node_id" integer NOT NULL, "update_id" text NOT NULL, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "record_time" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_264e5785e39b0d2bbe8b6ca0dba" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_wallet_entries_event_id" ON "to_wallet_entries"  ("event_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_wallet_entries_market" ON "to_wallet_entries"  ("market_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_wallet_entries_kind" ON "to_wallet_entries"  ("kind") `);
        await queryRunner.query(`CREATE INDEX "ix_to_wallet_entries_owner_offset" ON "to_wallet_entries"  ("owner", "offset") `);
        await queryRunner.query(`CREATE TABLE "to_ledger_payouts" ("contract_id" text NOT NULL, "admin" text NOT NULL, "user_party" text NOT NULL, "market_id" bigint NOT NULL, "amount_cc" numeric(38,10) NOT NULL, "reason" text NOT NULL, "created_at_sec" bigint NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_event_id" text NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "settled_kind" text, "settled_offset" bigint, "settled_at_ledger" TIMESTAMP WITH TIME ZONE, "tx_hash" text, "refunded" boolean, "settle_wallet_cid" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_064cafcd12665e656458dc51c26" PRIMARY KEY ("contract_id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_payouts_market" ON "to_ledger_payouts"  ("market_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_payouts_active" ON "to_ledger_payouts"  ("active") `);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_payouts_user_active" ON "to_ledger_payouts"  ("user_party", "active") `);
        await queryRunner.query(`CREATE TABLE "to_attestations" ("contract_id" text NOT NULL, "attester" text NOT NULL, "admin" text NOT NULL, "market_id" bigint NOT NULL, "source_uri" text NOT NULL, "fetched_at_sec" bigint NOT NULL, "outcome" text NOT NULL, "payload_hash" text NOT NULL, "source_signature" text, "response_excerpt" text, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_45e9adcc95e5be5609b2304286e" PRIMARY KEY ("contract_id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_attestations_market" ON "to_attestations"  ("market_id") `);
        await queryRunner.query(`CREATE TABLE "to_model_forecasts" ("contract_id" text NOT NULL, "author" text NOT NULL, "admin" text NOT NULL, "market_id" bigint NOT NULL, "model_id" text NOT NULL, "probability_yes" numeric(38,10) NOT NULL, "committed_at_sec" bigint NOT NULL, "market_price_at_commit" numeric(38,10) NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e18d4b8ea77d98fedbb75da1b8d" PRIMARY KEY ("contract_id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_model_forecasts_author" ON "to_model_forecasts"  ("author") `);
        await queryRunner.query(`CREATE INDEX "ix_to_model_forecasts_market" ON "to_model_forecasts"  ("market_id") `);
        await queryRunner.query(`CREATE TABLE "to_prediction_models" ("contract_id" text NOT NULL, "author" text NOT NULL, "admin" text NOT NULL, "model_id" text NOT NULL, "name" text NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "payout_party" text NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_offset" bigint NOT NULL, "created_at_ledger" TIMESTAMP WITH TIME ZONE, "archived_offset" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0ffecb423bf5a3bcd67e0c5b61f" PRIMARY KEY ("contract_id"))`);
        await queryRunner.query(`CREATE INDEX "ix_to_prediction_models_author" ON "to_prediction_models"  ("author") `);
        await queryRunner.query(`CREATE INDEX "ix_to_prediction_models_model_id" ON "to_prediction_models"  ("model_id") `);
        await queryRunner.query(`CREATE TABLE "to_ledger_transfers" ("id" BIGSERIAL NOT NULL, "event_id" text NOT NULL, "update_id" text NOT NULL, "offset" bigint NOT NULL, "direction" text NOT NULL, "counterparty" text NOT NULL, "amount_cc" numeric(38,10) NOT NULL, "choice" text NOT NULL, "record_time" TIMESTAMP WITH TIME ZONE, "effective_at" TIMESTAMP WITH TIME ZONE NOT NULL, "details" jsonb NOT NULL DEFAULT '{}'::jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e39cd1135497a0e5833e294afd9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_ledger_transfers_event_id" ON "to_ledger_transfers"  ("event_id") `);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_transfers_direction_offset" ON "to_ledger_transfers"  ("direction", "offset") `);
        await queryRunner.query(`CREATE INDEX "ix_to_ledger_transfers_counterparty_offset" ON "to_ledger_transfers"  ("counterparty", "offset") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_transfers_counterparty_offset"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_transfers_direction_offset"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_ledger_transfers_event_id"`);
        await queryRunner.query(`DROP TABLE "to_ledger_transfers"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_prediction_models_model_id"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_prediction_models_author"`);
        await queryRunner.query(`DROP TABLE "to_prediction_models"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_model_forecasts_market"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_model_forecasts_author"`);
        await queryRunner.query(`DROP TABLE "to_model_forecasts"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_attestations_market"`);
        await queryRunner.query(`DROP TABLE "to_attestations"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_payouts_user_active"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_payouts_active"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_payouts_market"`);
        await queryRunner.query(`DROP TABLE "to_ledger_payouts"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_wallet_entries_owner_offset"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_wallet_entries_kind"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_wallet_entries_market"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_wallet_entries_event_id"`);
        await queryRunner.query(`DROP TABLE "to_wallet_entries"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_wallets_owner_active"`);
        await queryRunner.query(`DROP TABLE "to_ledger_wallets"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_liquidity_positions_provider_active"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_liquidity_positions_market_active"`);
        await queryRunner.query(`DROP TABLE "to_liquidity_positions"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_positions_holder_active"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_positions_market_active"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_positions_holder_market"`);
        await queryRunner.query(`DROP TABLE "to_positions"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_market_events_market_offset"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_market_events_actor_offset"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_market_events_kind_offset"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_market_events_effective_at"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_market_events_event_id"`);
        await queryRunner.query(`DROP TABLE "to_market_events"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_market_snapshots_market_time"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_market_snapshots_market_offset"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_market_snapshots_event_id"`);
        await queryRunner.query(`DROP TABLE "to_market_snapshots"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_markets_status"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_markets_category"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_markets_expires_at"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_markets_updated_offset"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_markets_contract_id"`);
        await queryRunner.query(`DROP TABLE "to_markets"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_events_offset_node"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_events_entity_offset"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_events_contract_id"`);
        await queryRunner.query(`DROP INDEX "public"."ix_to_ledger_events_update_id"`);
        await queryRunner.query(`DROP INDEX "public"."uq_to_ledger_events_event_id"`);
        await queryRunner.query(`DROP TABLE "to_ledger_events"`);
        await queryRunner.query(`DROP TABLE "to_indexer_state"`);
    }

}
