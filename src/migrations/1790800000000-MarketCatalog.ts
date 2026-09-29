import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The market catalog and candles (docs/MARKETS.md): `to_series` and `to_events` (operator-managed
 * Kalshi-style series → event hierarchy), `to_market_candles` (OHLC per 1 min / 1 h / 1 d,
 * maintained by the projection), and the identity + open-interest columns on `to_markets`
 * (`ticker`, `event_ticker`, the Yes / No sub titles — mandatory `Text` on every truthoracle-v15
 * `PredictionMarket` — and the active version's template id). Additive over LedgerIndex.
 *
 * The four identity columns are NOT NULL with no default: the v15 index never produces a row
 * without them, and a from-scratch deployment starts with an empty index. Rows that predate this
 * migration in a development index can only come from a v14 package, which the v15 deployment
 * abandons; they are backfilled deterministically (`MKT-<marketId>`, `Yes` / `No`) rather than
 * deleted so the migration never destroys data. Hand-written so the backfill runs before the
 * NOT NULL constraints and the unique index; `migration:generate` against the migrated database
 * proposes nothing but the cosmetic jsonb-default rewrites Init.ts documents.
 */
export class MarketCatalog1790800000000 implements MigrationInterface {
  name = "MarketCatalog1790800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "to_series" ("ticker" text NOT NULL, "title" text NOT NULL, "category" text NOT NULL DEFAULT '', "frequency" text NOT NULL DEFAULT 'one_off', "tags" jsonb NOT NULL DEFAULT '[]'::jsonb, "settlement_sources" jsonb NOT NULL DEFAULT '[]'::jsonb, "contract_url" text, "description" text NOT NULL DEFAULT '', "status" text NOT NULL DEFAULT 'active', "product_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb, "created_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_series" PRIMARY KEY ("ticker"))`,
    );
    await queryRunner.query(`CREATE INDEX "ix_to_series_status" ON "to_series" ("status")`);
    await queryRunner.query(`CREATE INDEX "ix_to_series_category" ON "to_series" ("category")`);
    await queryRunner.query(
      `CREATE TABLE "to_events" ("ticker" text NOT NULL, "series_ticker" text NOT NULL, "title" text NOT NULL, "sub_title" text NOT NULL DEFAULT '', "image_url" text NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "mutually_exclusive" boolean NOT NULL DEFAULT false, "strike_date" TIMESTAMP WITH TIME ZONE, "strike_period" text, "settlement_sources" jsonb NOT NULL DEFAULT '[]'::jsonb, "product_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb, "archived" boolean NOT NULL DEFAULT false, "created_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_events" PRIMARY KEY ("ticker"))`,
    );
    await queryRunner.query(`CREATE INDEX "ix_to_events_archived" ON "to_events" ("archived")`);
    await queryRunner.query(`CREATE INDEX "ix_to_events_series" ON "to_events" ("series_ticker")`);
    await queryRunner.query(
      `CREATE TABLE "to_market_candles" ("market_id" bigint NOT NULL, "period_secs" integer NOT NULL, "period_start" TIMESTAMP WITH TIME ZONE NOT NULL, "open" numeric(38,10) NOT NULL, "high" numeric(38,10) NOT NULL, "low" numeric(38,10) NOT NULL, "close" numeric(38,10) NOT NULL, "volume_cc" numeric(38,10) NOT NULL DEFAULT '0', "notional_cc" numeric(38,10) NOT NULL DEFAULT '0', "trades" integer NOT NULL DEFAULT '0', "open_interest" numeric(38,10) NOT NULL DEFAULT '0', "liquidity_l" numeric(38,10), "last_offset" bigint NOT NULL, "last_node_id" integer NOT NULL DEFAULT '0', "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_market_candles" PRIMARY KEY ("market_id", "period_secs", "period_start"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_to_market_candles_period_start" ON "to_market_candles" ("period_secs", "period_start")`,
    );
    // Identity columns: added nullable, backfilled for any pre-v15 rows (see the header), then
    // constrained. A v15 index never writes a row without all four.
    await queryRunner.query(`ALTER TABLE "to_markets" ADD "ticker" text`);
    await queryRunner.query(`ALTER TABLE "to_markets" ADD "event_ticker" text`);
    await queryRunner.query(`ALTER TABLE "to_markets" ADD "yes_sub_title" text`);
    await queryRunner.query(`ALTER TABLE "to_markets" ADD "no_sub_title" text`);
    await queryRunner.query(
      `UPDATE "to_markets" SET "ticker" = 'MKT-' || "market_id"::text, "event_ticker" = 'MKT-' || "market_id"::text, "yes_sub_title" = 'Yes', "no_sub_title" = 'No'`,
    );
    await queryRunner.query(`ALTER TABLE "to_markets" ALTER COLUMN "ticker" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "to_markets" ALTER COLUMN "event_ticker" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "to_markets" ALTER COLUMN "yes_sub_title" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "to_markets" ALTER COLUMN "no_sub_title" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "to_markets" ADD "template_id" text`);
    await queryRunner.query(
      `ALTER TABLE "to_markets" ADD "open_interest_yes" numeric(38,10) NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "to_markets" ADD "open_interest_no" numeric(38,10) NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_to_markets_ticker" ON "to_markets" ("ticker")`);
    await queryRunner.query(`CREATE INDEX "ix_to_markets_event_ticker" ON "to_markets" ("event_ticker")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."ix_to_markets_event_ticker"`);
    await queryRunner.query(`DROP INDEX "public"."uq_to_markets_ticker"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "open_interest_no"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "open_interest_yes"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "template_id"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "no_sub_title"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "yes_sub_title"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "event_ticker"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "ticker"`);
    await queryRunner.query(`DROP INDEX "public"."ix_to_market_candles_period_start"`);
    await queryRunner.query(`DROP TABLE "to_market_candles"`);
    await queryRunner.query(`DROP INDEX "public"."ix_to_events_series"`);
    await queryRunner.query(`DROP INDEX "public"."ix_to_events_archived"`);
    await queryRunner.query(`DROP TABLE "to_events"`);
    await queryRunner.query(`DROP INDEX "public"."ix_to_series_category"`);
    await queryRunner.query(`DROP INDEX "public"."ix_to_series_status"`);
    await queryRunner.query(`DROP TABLE "to_series"`);
  }
}
