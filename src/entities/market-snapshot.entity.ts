import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { MarketStatus } from "../types";
import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * One row per `PredictionMarket` version (docs/INDEXER.md §3 `to_market_snapshots`) — the
 * price / reserve / volume history a chart is drawn from. `cause` is the choice that produced
 * the version (CreateMarket, Buy, Sell, …).
 */
@Entity({ name: "to_market_snapshots" })
@Index("ix_to_market_snapshots_market_time", ["marketId", "effectiveAt"])
@Index("ix_to_market_snapshots_market_offset", ["marketId", "offset"])
export class MarketSnapshotEntity {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Index("uq_to_market_snapshots_event_id", { unique: true })
  @Column({ name: "event_id", type: "text" })
  eventId!: string;

  @Column({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Column({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "bigint", transformer: bigintNumberTransformer })
  offset!: number;

  @Column({ name: "node_id", type: "integer" })
  nodeId!: number;

  @Column({ name: "effective_at", type: "timestamptz" })
  effectiveAt!: Date;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  price!: bigint;

  @Column({
    name: "reserve_yes",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  reserveYes!: bigint;

  @Column({
    name: "reserve_no",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  reserveNo!: bigint;

  @Column({
    name: "liquidity_l",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  liquidityL!: bigint;

  @Column({
    name: "lp_token_supply",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  lpTokenSupply!: bigint;

  @Column({
    name: "total_volume_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  totalVolumeCC!: bigint;

  @Column({
    name: "accumulated_fees_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  accumulatedFeesCC!: bigint;

  @Column({
    name: "prize_pool_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  prizePoolCC!: bigint;

  @Column({ type: "text" })
  status!: MarketStatus;

  @Column({ type: "text", nullable: true })
  cause!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
