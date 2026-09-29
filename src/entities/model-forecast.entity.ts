import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/** Every `ModelForecast` committed through `CommitForecast` (docs/INDEXER.md §3 `to_model_forecasts`). */
@Entity({ name: "to_model_forecasts" })
@Index("ix_to_model_forecasts_market", ["marketId"])
@Index("ix_to_model_forecasts_author", ["author"])
export class ModelForecastEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  author!: string;

  @Column({ type: "text" })
  admin!: string;

  @Column({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Column({ name: "model_id", type: "text" })
  modelId!: string;

  @Column({
    name: "probability_yes",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  probabilityYes!: bigint;

  @Column({ name: "committed_at_sec", type: "bigint", transformer: bigintNumberTransformer })
  committedAtSec!: number;

  @Column({
    name: "market_price_at_commit",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  marketPriceAtCommit!: bigint;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Column({ name: "created_offset", type: "bigint", transformer: bigintNumberTransformer })
  createdOffset!: number;

  @Column({ name: "created_at_ledger", type: "timestamptz", nullable: true })
  createdAtLedger!: Date | null;

  @Column({
    name: "archived_offset",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  archivedOffset!: number | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
