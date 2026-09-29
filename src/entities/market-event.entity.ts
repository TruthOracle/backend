import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { MarketEventKind, MarketOutcome, TradeSide } from "../types";
import { bigintNumberTransformer, decimalTransformer } from "../util/ledger-values";

/**
 * Market activity derived from every `PredictionMarket` / `MarketCounter` choice
 * (docs/INDEXER.md §5 `to_market_events`): trades (buy, sell, swap, split, merge), liquidity,
 * resolution steps, redemptions and forecasts, each with the numbers the ledger actually
 * produced (share deltas from the Position versions, CC from the UserWallet Debit / Credit,
 * fees from the market's fee-pot deltas) — never a re-computation.
 */
@Entity({ name: "to_market_events" })
@Index("ix_to_market_events_market_offset", ["marketId", "offset"])
@Index("ix_to_market_events_actor_offset", ["actor", "offset"])
@Index("ix_to_market_events_kind_offset", ["kind", "offset"])
@Index("ix_to_market_events_effective_at", ["effectiveAt"])
export class MarketEventEntity {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Index("uq_to_market_events_event_id", { unique: true })
  @Column({ name: "event_id", type: "text" })
  eventId!: string;

  @Column({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Column({ type: "text" })
  kind!: MarketEventKind;

  @Column({ type: "text" })
  actor!: string;

  @Column({ type: "text", nullable: true })
  side!: TradeSide | null;

  @Column({
    name: "amount_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  amountCC!: bigint | null;

  @Column({
    name: "net_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  netCC!: bigint | null;

  @Column({
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  shares!: bigint | null;

  @Column({
    name: "shares_out",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  sharesOut!: bigint | null;

  @Column({
    name: "fee_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  feeCC!: bigint | null;

  @Column({
    name: "price_before",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  priceBefore!: bigint | null;

  @Column({
    name: "price_after",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  priceAfter!: bigint | null;

  @Column({
    name: "lp_tokens",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  lpTokens!: bigint | null;

  @Column({ type: "text", nullable: true })
  outcome!: MarketOutcome | null;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  details!: Record<string, unknown>;

  @Column({ type: "bigint", transformer: bigintNumberTransformer })
  offset!: number;

  @Column({ name: "node_id", type: "integer" })
  nodeId!: number;

  @Column({ name: "update_id", type: "text" })
  updateId!: string;

  @Column({ name: "command_id", type: "text", nullable: true })
  commandId!: string | null;

  @Column({ name: "effective_at", type: "timestamptz" })
  effectiveAt!: Date;

  @Column({ name: "record_time", type: "timestamptz", nullable: true })
  recordTime!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
