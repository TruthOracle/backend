import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

import type { ApiSettlementSource } from "../types";

/**
 * An event: one dated instance of a series that groups the markets traded on it (Kalshi
 * `event`, docs/MARKETS.md §2). "Will the Fed cut in March?" is the event; "cut ≥ 25 bps",
 * "cut ≥ 50 bps" are its markets. Operator-managed catalog data; membership is decided by the
 * market's on-ledger `eventTicker` when it carries one, and by `to_markets.event_ticker`
 * (catalog assignment) otherwise. Named CatalogEvent to keep clear of MarketEventEntity, which
 * is ledger activity.
 */
@Entity({ name: "to_events" })
@Index("ix_to_events_series", ["seriesTicker"])
@Index("ix_to_events_archived", ["archived"])
export class CatalogEventEntity {
  @PrimaryColumn({ type: "text" })
  ticker!: string;

  @Column({ name: "series_ticker", type: "text" })
  seriesTicker!: string;

  @Column({ type: "text" })
  title!: string;

  @Column({ name: "sub_title", type: "text", default: "" })
  subTitle!: string;

  @Column({ name: "image_url", type: "text", default: "" })
  imageUrl!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ name: "mutually_exclusive", type: "boolean", default: false })
  mutuallyExclusive!: boolean;

  @Column({ name: "strike_date", type: "timestamptz", nullable: true })
  strikeDate!: Date | null;

  @Column({ name: "strike_period", type: "text", nullable: true })
  strikePeriod!: string | null;

  /** Overrides the series' sources when non-empty. */
  @Column({ name: "settlement_sources", type: "jsonb", default: () => "'[]'::jsonb" })
  settlementSources!: ApiSettlementSource[];

  @Column({ name: "product_metadata", type: "jsonb", default: () => "'{}'::jsonb" })
  productMetadata!: Record<string, unknown>;

  @Column({ type: "boolean", default: false })
  archived!: boolean;

  /** The event's one collateral, fixed by its first market (docs/TOKENS.md §2 decision 9); null until then. */
  @Column({ name: "collateral_admin", type: "text", nullable: true })
  collateralAdmin!: string | null;

  @Column({ name: "collateral_id", type: "text", nullable: true })
  collateralId!: string | null;

  @Column({ name: "created_by_user_id", type: "uuid", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
