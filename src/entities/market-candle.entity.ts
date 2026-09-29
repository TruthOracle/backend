import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

import { bigintNumberTransformer, decimalTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * OHLC candles of a market's pm-AMM price per period (1 min, 1 h, 1 d — Kalshi's
 * `period_interval`), maintained by the projection in the same Postgres transaction as the
 * market version that moved the price (docs/MARKETS.md §5, docs/INDEXER.md §5). One row per
 * period that saw at least one market version; the read side fills the gaps by carrying the
 * previous close forward. `open` is set on insert only; `close` follows the latest version by
 * (offset, node id); `volume_cc` is Σ Δ`totalVolumeCC`; `notional_cc` = Σ price × Δvolume
 * (so `mean = notional / volume`); `open_interest` is the market's outstanding shares after
 * the last version of the period.
 */
@Entity({ name: "to_market_candles" })
@Index("ix_to_market_candles_period_start", ["periodSecs", "periodStart"])
export class MarketCandleEntity {
  @PrimaryColumn({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @PrimaryColumn({ name: "period_secs", type: "integer" })
  periodSecs!: number;

  @PrimaryColumn({ name: "period_start", type: "timestamptz" })
  periodStart!: Date;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  open!: bigint;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  high!: bigint;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  low!: bigint;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  close!: bigint;

  @Column({
    name: "volume_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  volumeCC!: bigint;

  @Column({
    name: "notional_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  notionalCC!: bigint;

  @Column({ type: "integer", default: 0 })
  trades!: number;

  @Column({
    name: "open_interest",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  openInterest!: bigint;

  @Column({
    name: "liquidity_l",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  liquidityL!: bigint | null;

  @Column({ name: "last_offset", type: "bigint", transformer: bigintNumberTransformer })
  lastOffset!: number;

  @Column({ name: "last_node_id", type: "integer", default: 0 })
  lastNodeId!: number;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
