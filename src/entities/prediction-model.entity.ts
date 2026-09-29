import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";

/** Every `Marketplace:PredictionModel` registry entry version (docs/INDEXER.md §3 `to_prediction_models`). */
@Entity({ name: "to_prediction_models" })
@Index("ix_to_prediction_models_model_id", ["modelId"])
@Index("ix_to_prediction_models_author", ["author"])
export class PredictionModelEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  author!: string;

  @Column({ type: "text" })
  admin!: string;

  @Column({ name: "model_id", type: "text" })
  modelId!: string;

  @Column({ type: "text", default: "" })
  name!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ name: "payout_party", type: "text" })
  payoutParty!: string;

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
