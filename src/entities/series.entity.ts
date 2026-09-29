import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

import type { ApiSettlementSource, SeriesFrequency, SeriesStatus } from "../types";

/**
 * A series: the recurring question template every event is an instance of (Kalshi `series`,
 * docs/MARKETS.md §2). Operator-managed catalog data — nothing here is on the ledger; the
 * ledger's markets point at events, and events point here.
 */
@Entity({ name: "to_series" })
@Index("ix_to_series_category", ["category"])
@Index("ix_to_series_status", ["status"])
export class SeriesEntity {
  @PrimaryColumn({ type: "text" })
  ticker!: string;

  @Column({ type: "text" })
  title!: string;

  @Column({ type: "text", default: "" })
  category!: string;

  @Column({ type: "text", default: "one_off" })
  frequency!: SeriesFrequency;

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  tags!: string[];

  @Column({ name: "settlement_sources", type: "jsonb", default: () => "'[]'::jsonb" })
  settlementSources!: ApiSettlementSource[];

  @Column({ name: "contract_url", type: "text", nullable: true })
  contractUrl!: string | null;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ type: "text", default: "active" })
  status!: SeriesStatus;

  @Column({ name: "product_metadata", type: "jsonb", default: () => "'{}'::jsonb" })
  productMetadata!: Record<string, unknown>;

  @Column({ name: "created_by_user_id", type: "uuid", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
