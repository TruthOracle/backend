import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/**
 * A market's presentation — image and description — owned by the backend, never by the contract
 * (docs/MARKETS.md §1 "What lives where"): nothing on-ledger reads it, no trader signs for it,
 * and an operator must be able to fix a broken image link without minting a new market. Keyed
 * by the market's ticker (`to_markets.ticker`, upper case) rather than its id because the
 * operator writes it in `POST /admin/markets` before the ledger create is indexed; the
 * projection never touches this table. A market without a row shows its event's image and no
 * description (`MarketsService.extrasFor`).
 */
@Entity({ name: "to_market_metadata" })
export class MarketMetadataEntity {
  @PrimaryColumn({ type: "text" })
  ticker!: string;

  @Column({ name: "image_url", type: "text", default: "" })
  imageUrl!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ name: "updated_by_user_id", type: "uuid", nullable: true })
  updatedByUserId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
