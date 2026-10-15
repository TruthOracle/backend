import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Instruments (docs/TOKENS.md §4): the platform trades a configurable CIP-56 collateral instrument
 * and pays rewards in a second one, so every amount in the schema now sits next to the instrument
 * it is in and the `_cc` suffix goes away everywhere. New tables: `to_instruments` (what the
 * platform knows about each token), `to_wallet_credits` (per-instrument attribution, replacing
 * `to_wallets.credited_cc`), `to_ledger_holdings` / `to_ledger_transfer_instructions` (the
 * treasury's token-standard holdings and two-step offers as indexed), `to_reward_rules` /
 * `to_reward_grants` (TRO rewards). Instrument columns are added to every table that holds an
 * amount, `collateral_*` to markets and catalog events, and every `*_cc` column is renamed.
 *
 * Deployed fresh (truthoracle-v17 is a new package; no v16 row is compatible). The NOT NULL
 * instrument columns are still added with a transient `DEFAULT ''` so the migration applies to a
 * development database that holds pre-v17 rows instead of failing on them; such rows carry an
 * empty instrument and are meaningless under v17 — rebuild the index (docs/INDEXER.md §9) rather
 * than trust them. Hand-written; `down()` reverses every step (CI runs run / revert / run).
 */
export class Instruments1792000000000 implements MigrationInterface {
  name = "Instruments1792000000000";

  public async up(q: QueryRunner): Promise<void> {
    // ── to_instruments ───────────────────────────────────────────────────────────────────────
    await q.query(
      `CREATE TABLE "to_instruments" ("admin" text NOT NULL, "id" text NOT NULL, "symbol" text NOT NULL, "name" text NOT NULL, "decimals" integer NOT NULL, "kind" text NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "is_default_collateral" boolean NOT NULL DEFAULT false, "registry_url" text, "registry_auth" text NOT NULL DEFAULT 'keycloak', "transfer_mode" text, "wallet_instrument_id" text NOT NULL, "setup_choices" jsonb NOT NULL DEFAULT '{}'::jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_instruments" PRIMARY KEY ("admin", "id"))`,
    );
    await q.query(`CREATE INDEX "ix_to_instruments_kind" ON "to_instruments" ("kind")`);
    // At most one default collateral: a unique index over the flag where it is set.
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_instruments_default_collateral" ON "to_instruments" ("is_default_collateral") WHERE "is_default_collateral" = true`,
    );

    // ── to_wallet_credits replaces to_wallets.credited_cc ─────────────────────────────────────
    await q.query(
      `CREATE TABLE "to_wallet_credits" ("wallet_id" uuid NOT NULL, "instrument_admin" text NOT NULL, "instrument_id" text NOT NULL, "credited" numeric(38,10) NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_wallet_credits" PRIMARY KEY ("wallet_id", "instrument_admin", "instrument_id"))`,
    );
    await q.query(
      `ALTER TABLE "to_wallet_credits" ADD CONSTRAINT "FK_to_wallet_credits_wallet" FOREIGN KEY ("wallet_id") REFERENCES "to_wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(`ALTER TABLE "to_wallets" DROP COLUMN "credited_cc"`);

    // ── to_deposit_credits ───────────────────────────────────────────────────────────────────
    await this.addInstrument(q, "to_deposit_credits");
    await q.query(`ALTER TABLE "to_deposit_credits" RENAME COLUMN "amount_cc" TO "amount"`);
    await q.query(
      `ALTER TABLE "to_deposit_credits" RENAME COLUMN "deposited_cc_before" TO "deposited_before"`,
    );

    // ── to_payouts ───────────────────────────────────────────────────────────────────────────
    await this.addInstrument(q, "to_payouts");
    await q.query(`ALTER TABLE "to_payouts" RENAME COLUMN "amount_cc" TO "amount"`);
    await q.query(`ALTER TABLE "to_payouts" ADD "details" jsonb NOT NULL DEFAULT '{}'::jsonb`);

    // ── to_markets / to_market_snapshots: collateral + renames ───────────────────────────────
    await this.addInstrument(q, "to_markets", "collateral");
    await q.query(
      `CREATE INDEX "ix_to_markets_collateral" ON "to_markets" ("collateral_admin", "collateral_id")`,
    );
    for (const table of ["to_markets", "to_market_snapshots"]) {
      await q.query(`ALTER TABLE "${table}" RENAME COLUMN "accumulated_fees_cc" TO "accumulated_fees"`);
      await q.query(`ALTER TABLE "${table}" RENAME COLUMN "prize_pool_cc" TO "prize_pool"`);
      await q.query(`ALTER TABLE "${table}" RENAME COLUMN "total_volume_cc" TO "total_volume"`);
    }
    // The stored policy / proposal JSON loses its suffix too (`bondCC` → `bond`).
    await q.query(
      `UPDATE "to_markets" SET "policy" = ("policy" - 'bondCC') || jsonb_build_object('bond', "policy"->'bondCC') WHERE "policy" ? 'bondCC'`,
    );
    await q.query(
      `UPDATE "to_markets" SET "proposal" = ("proposal" - 'bondCC') || jsonb_build_object('bond', "proposal"->'bondCC') WHERE "proposal" ? 'bondCC'`,
    );

    // ── to_events: the event's one collateral (null until its first market) ──────────────────
    await q.query(`ALTER TABLE "to_events" ADD "collateral_admin" text`);
    await q.query(`ALTER TABLE "to_events" ADD "collateral_id" text`);

    // ── activity, positions, candles ─────────────────────────────────────────────────────────
    await q.query(`ALTER TABLE "to_market_events" RENAME COLUMN "amount_cc" TO "amount"`);
    await q.query(`ALTER TABLE "to_market_events" RENAME COLUMN "net_cc" TO "net"`);
    await q.query(`ALTER TABLE "to_market_events" RENAME COLUMN "fee_cc" TO "fee"`);
    await q.query(`ALTER TABLE "to_positions" RENAME COLUMN "cost_basis_cc" TO "cost_basis"`);
    await q.query(`ALTER TABLE "to_liquidity_positions" RENAME COLUMN "deposited_cc" TO "deposited"`);
    await q.query(`ALTER TABLE "to_market_candles" RENAME COLUMN "volume_cc" TO "volume"`);
    await q.query(`ALTER TABLE "to_market_candles" RENAME COLUMN "notional_cc" TO "notional"`);

    // ── to_ledger_wallets: one wallet per (owner, instrument) ─────────────────────────────────
    await this.addInstrument(q, "to_ledger_wallets");
    await q.query(`ALTER TABLE "to_ledger_wallets" RENAME COLUMN "balance_cc" TO "balance"`);
    await q.query(`ALTER TABLE "to_ledger_wallets" RENAME COLUMN "deposited_cc" TO "deposited"`);
    await q.query(`ALTER TABLE "to_ledger_wallets" RENAME COLUMN "withdrawn_cc" TO "withdrawn"`);
    await q.query(`ALTER TABLE "to_ledger_wallets" RENAME COLUMN "deposit_refs" TO "credit_refs"`);
    await q.query(
      `ALTER TABLE "to_ledger_wallets" ADD "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_wallets_owner_instrument_active" ON "to_ledger_wallets" ("owner", "instrument_admin", "instrument_id", "active")`,
    );

    // ── to_wallet_entries ────────────────────────────────────────────────────────────────────
    await this.addInstrument(q, "to_wallet_entries");
    await q.query(`ALTER TABLE "to_wallet_entries" RENAME COLUMN "amount_cc" TO "amount"`);

    // ── to_ledger_payouts ────────────────────────────────────────────────────────────────────
    await this.addInstrument(q, "to_ledger_payouts");
    await q.query(`ALTER TABLE "to_ledger_payouts" RENAME COLUMN "amount_cc" TO "amount"`);
    await q.query(
      `ALTER TABLE "to_ledger_payouts" ADD "audit_observers" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );

    // ── to_ledger_transfers: any instrument, unique per (update, node) ───────────────────────
    await this.addInstrument(q, "to_ledger_transfers");
    await q.query(`ALTER TABLE "to_ledger_transfers" RENAME COLUMN "amount_cc" TO "amount"`);
    await q.query(`ALTER TABLE "to_ledger_transfers" ADD "kind" text NOT NULL DEFAULT 'amulet'`);
    await q.query(`ALTER TABLE "to_ledger_transfers" ALTER COLUMN "kind" DROP DEFAULT`);
    await q.query(`ALTER TABLE "to_ledger_transfers" ADD "node_id" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "to_ledger_transfers" ALTER COLUMN "node_id" DROP DEFAULT`);
    // Pre-v17 rows carry the node id inside event_id (`<updateId>:<nodeId>`).
    await q.query(
      `UPDATE "to_ledger_transfers" SET "node_id" = split_part("event_id", ':', 2)::integer WHERE "event_id" LIKE '%:%' AND split_part("event_id", ':', 2) ~ '^[0-9]+$'`,
    );
    await q.query(`DROP INDEX "public"."uq_to_ledger_transfers_event_id"`);
    await q.query(`ALTER TABLE "to_ledger_transfers" DROP COLUMN "event_id"`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ledger_transfers_update_node" ON "to_ledger_transfers" ("update_id", "node_id")`,
    );
    await q.query(
      `CREATE INDEX "ix_to_ledger_transfers_instrument_counterparty" ON "to_ledger_transfers" ("instrument_admin", "instrument_id", "counterparty", "direction")`,
    );

    // ── to_ledger_holdings / to_ledger_transfer_instructions ─────────────────────────────────
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

    // ── rewards ──────────────────────────────────────────────────────────────────────────────
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
    // The three automatic rules are NOT seeded here: RewardsService.seedRules creates them once at
    // boot — disabled, except on APP_ENV=dev where they come up enabled with their documented
    // defaults (docs/TOKENS.md §4.6) — so the migration stays data-free and the dev default is a
    // property of the environment, not of the first migration run. `manual` grants need no row.
    await q.query(
      `INSERT INTO "to_settings" ("key", "value") VALUES ('rewards_cursor', '0') ON CONFLICT ("key") DO NOTHING`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "to_settings" WHERE "key" = 'rewards_cursor'`);
    await q.query(`ALTER TABLE "to_reward_grants" DROP CONSTRAINT "FK_to_reward_grants_rule"`);
    await q.query(`ALTER TABLE "to_reward_grants" DROP CONSTRAINT "FK_to_reward_grants_user"`);
    await q.query(`DROP INDEX "public"."uq_to_reward_grants_ref"`);
    await q.query(`DROP INDEX "public"."uq_to_reward_grants_command_id"`);
    await q.query(`DROP INDEX "public"."uq_to_reward_grants_source_event_id"`);
    await q.query(`DROP INDEX "public"."ix_to_reward_grants_status"`);
    await q.query(`DROP INDEX "public"."ix_to_reward_grants_party"`);
    await q.query(`DROP INDEX "public"."ix_to_reward_grants_user"`);
    await q.query(`DROP TABLE "to_reward_grants"`);
    await q.query(`DROP INDEX "public"."uq_to_reward_rules_kind"`);
    await q.query(`DROP TABLE "to_reward_rules"`);

    await q.query(`DROP INDEX "public"."ix_to_ledger_transfer_instructions_status_receiver"`);
    await q.query(`DROP TABLE "to_ledger_transfer_instructions"`);
    await q.query(`DROP INDEX "public"."ix_to_ledger_holdings_archived"`);
    await q.query(`DROP INDEX "public"."ix_to_ledger_holdings_instrument_owner"`);
    await q.query(`DROP TABLE "to_ledger_holdings"`);

    await q.query(`DROP INDEX "public"."ix_to_ledger_transfers_instrument_counterparty"`);
    await q.query(`DROP INDEX "public"."uq_to_ledger_transfers_update_node"`);
    await q.query(`ALTER TABLE "to_ledger_transfers" ADD "event_id" text`);
    await q.query(
      `UPDATE "to_ledger_transfers" SET "event_id" = "update_id" || ':' || "node_id"::text`,
    );
    await q.query(`ALTER TABLE "to_ledger_transfers" ALTER COLUMN "event_id" SET NOT NULL`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_to_ledger_transfers_event_id" ON "to_ledger_transfers" ("event_id")`,
    );
    await q.query(`ALTER TABLE "to_ledger_transfers" DROP COLUMN "node_id"`);
    await q.query(`ALTER TABLE "to_ledger_transfers" DROP COLUMN "kind"`);
    await q.query(`ALTER TABLE "to_ledger_transfers" RENAME COLUMN "amount" TO "amount_cc"`);
    await this.dropInstrument(q, "to_ledger_transfers");

    await q.query(`ALTER TABLE "to_ledger_payouts" DROP COLUMN "audit_observers"`);
    await q.query(`ALTER TABLE "to_ledger_payouts" RENAME COLUMN "amount" TO "amount_cc"`);
    await this.dropInstrument(q, "to_ledger_payouts");

    await q.query(`ALTER TABLE "to_wallet_entries" RENAME COLUMN "amount" TO "amount_cc"`);
    await this.dropInstrument(q, "to_wallet_entries");

    await q.query(`DROP INDEX "public"."ix_to_ledger_wallets_owner_instrument_active"`);
    await q.query(`ALTER TABLE "to_ledger_wallets" DROP COLUMN "audit_observers"`);
    await q.query(`ALTER TABLE "to_ledger_wallets" RENAME COLUMN "credit_refs" TO "deposit_refs"`);
    await q.query(`ALTER TABLE "to_ledger_wallets" RENAME COLUMN "withdrawn" TO "withdrawn_cc"`);
    await q.query(`ALTER TABLE "to_ledger_wallets" RENAME COLUMN "deposited" TO "deposited_cc"`);
    await q.query(`ALTER TABLE "to_ledger_wallets" RENAME COLUMN "balance" TO "balance_cc"`);
    await this.dropInstrument(q, "to_ledger_wallets");

    await q.query(`ALTER TABLE "to_market_candles" RENAME COLUMN "notional" TO "notional_cc"`);
    await q.query(`ALTER TABLE "to_market_candles" RENAME COLUMN "volume" TO "volume_cc"`);
    await q.query(`ALTER TABLE "to_liquidity_positions" RENAME COLUMN "deposited" TO "deposited_cc"`);
    await q.query(`ALTER TABLE "to_positions" RENAME COLUMN "cost_basis" TO "cost_basis_cc"`);
    await q.query(`ALTER TABLE "to_market_events" RENAME COLUMN "fee" TO "fee_cc"`);
    await q.query(`ALTER TABLE "to_market_events" RENAME COLUMN "net" TO "net_cc"`);
    await q.query(`ALTER TABLE "to_market_events" RENAME COLUMN "amount" TO "amount_cc"`);

    await q.query(`ALTER TABLE "to_events" DROP COLUMN "collateral_id"`);
    await q.query(`ALTER TABLE "to_events" DROP COLUMN "collateral_admin"`);

    await q.query(
      `UPDATE "to_markets" SET "proposal" = ("proposal" - 'bond') || jsonb_build_object('bondCC', "proposal"->'bond') WHERE "proposal" ? 'bond'`,
    );
    await q.query(
      `UPDATE "to_markets" SET "policy" = ("policy" - 'bond') || jsonb_build_object('bondCC', "policy"->'bond') WHERE "policy" ? 'bond'`,
    );
    for (const table of ["to_market_snapshots", "to_markets"]) {
      await q.query(`ALTER TABLE "${table}" RENAME COLUMN "total_volume" TO "total_volume_cc"`);
      await q.query(`ALTER TABLE "${table}" RENAME COLUMN "prize_pool" TO "prize_pool_cc"`);
      await q.query(`ALTER TABLE "${table}" RENAME COLUMN "accumulated_fees" TO "accumulated_fees_cc"`);
    }
    await q.query(`DROP INDEX "public"."ix_to_markets_collateral"`);
    await this.dropInstrument(q, "to_markets", "collateral");

    await q.query(`ALTER TABLE "to_payouts" DROP COLUMN "details"`);
    await q.query(`ALTER TABLE "to_payouts" RENAME COLUMN "amount" TO "amount_cc"`);
    await this.dropInstrument(q, "to_payouts");

    await q.query(
      `ALTER TABLE "to_deposit_credits" RENAME COLUMN "deposited_before" TO "deposited_cc_before"`,
    );
    await q.query(`ALTER TABLE "to_deposit_credits" RENAME COLUMN "amount" TO "amount_cc"`);
    await this.dropInstrument(q, "to_deposit_credits");

    await q.query(
      `ALTER TABLE "to_wallets" ADD "credited_cc" numeric(38,10) NOT NULL DEFAULT '0'`,
    );
    // The per-wallet total of every instrument is the closest a single column can get.
    await q.query(
      `UPDATE "to_wallets" w SET "credited_cc" = COALESCE((SELECT SUM(c."credited") FROM "to_wallet_credits" c WHERE c."wallet_id" = w."id"), 0)`,
    );
    await q.query(`ALTER TABLE "to_wallet_credits" DROP CONSTRAINT "FK_to_wallet_credits_wallet"`);
    await q.query(`DROP TABLE "to_wallet_credits"`);

    await q.query(`DROP INDEX "public"."uq_to_instruments_default_collateral"`);
    await q.query(`DROP INDEX "public"."ix_to_instruments_kind"`);
    await q.query(`DROP TABLE "to_instruments"`);
  }

  /** `<prefix>_admin` / `<prefix>_id` NOT NULL; the transient default lets a non-empty development table take the columns (see the header). */
  private async addInstrument(q: QueryRunner, table: string, prefix = "instrument"): Promise<void> {
    for (const column of [`${prefix}_admin`, `${prefix}_id`]) {
      await q.query(`ALTER TABLE "${table}" ADD "${column}" text NOT NULL DEFAULT ''`);
      await q.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT`);
    }
  }

  private async dropInstrument(q: QueryRunner, table: string, prefix = "instrument"): Promise<void> {
    await q.query(`ALTER TABLE "${table}" DROP COLUMN "${prefix}_id"`);
    await q.query(`ALTER TABLE "${table}" DROP COLUMN "${prefix}_admin"`);
  }
}
