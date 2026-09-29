import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Presentation leaves the contract (docs/MARKETS.md §1 "What lives where"): truthoracle-v16
 * drops `imageUrl`, `description` and `category` from `PredictionMarket` — nothing on-ledger read
 * them, no trader signs for them, and a broken image link must not need a new market. The
 * backend owns them from here: `to_market_metadata` (image and description per ticker, written by
 * `POST /admin/markets` before the ledger create is indexed and by
 * `PATCH /admin/markets/:market/metadata`), and a market's category is its series' through the
 * event. The three columns are dropped from `to_markets`; whatever a development index held in
 * them is carried into the metadata table first so nothing is destroyed (a v16 index never
 * writes them again). Hand-written; `down()` restores the columns and copies the rows back.
 */
export class MarketMetadata1790900000000 implements MigrationInterface {
  name = "MarketMetadata1790900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "to_market_metadata" ("ticker" text NOT NULL, "image_url" text NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "updated_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_to_market_metadata" PRIMARY KEY ("ticker"))`,
    );
    // Pre-v16 rows (a development index built against v15) keep their presentation as metadata.
    await queryRunner.query(
      `INSERT INTO "to_market_metadata" ("ticker", "image_url", "description")
         SELECT "ticker", "image_url", "description" FROM "to_markets"
          WHERE "image_url" <> '' OR "description" <> ''
       ON CONFLICT ("ticker") DO NOTHING`,
    );
    await queryRunner.query(`DROP INDEX "public"."ix_to_markets_category"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "category"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "description"`);
    await queryRunner.query(`ALTER TABLE "to_markets" DROP COLUMN "image_url"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "to_markets" ADD "image_url" text NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "to_markets" ADD "description" text NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "to_markets" ADD "category" text NOT NULL DEFAULT ''`);
    await queryRunner.query(`CREATE INDEX "ix_to_markets_category" ON "to_markets" ("category")`);
    await queryRunner.query(
      `UPDATE "to_markets" m SET "image_url" = md."image_url", "description" = md."description"
         FROM "to_market_metadata" md WHERE md."ticker" = m."ticker"`,
    );
    await queryRunner.query(`DROP TABLE "to_market_metadata"`);
  }
}
