import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";

export interface IndexerGap {
  fromOffset: number;
  toOffset: number;
  reason: string;
  at: string;
}

/** The one row (`key = 'ledger'`) the indexer advances — its cursor, bootstrap record and last error (docs/INDEXER.md §3). */
@Entity({ name: "to_indexer_state" })
export class IndexerStateEntity {
  @PrimaryColumn({ type: "text" })
  key!: string;

  /** Last ledger offset applied to the index (inclusive); 0 = nothing yet. Advanced in the same transaction as the rows. */
  @Column({ type: "bigint", default: 0, transformer: bigintNumberTransformer })
  offset!: number;

  @Column({
    name: "ledger_end",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  ledgerEnd!: number | null;

  @Column({
    name: "pruned_offset",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  prunedOffset!: number | null;

  @Column({ name: "bootstrapped_at", type: "timestamptz", nullable: true })
  bootstrappedAt!: Date | null;

  /** The ACS snapshot offset the index started from (0 = replayed from ledger begin). */
  @Column({
    name: "bootstrap_offset",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  bootstrapOffset!: number | null;

  @Column({ name: "last_update_id", type: "text", nullable: true })
  lastUpdateId!: string | null;

  @Column({ name: "last_record_time", type: "timestamptz", nullable: true })
  lastRecordTime!: Date | null;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError!: string | null;

  @Column({ name: "last_error_at", type: "timestamptz", nullable: true })
  lastErrorAt!: Date | null;

  @Column({ name: "market_counter_cid", type: "text", nullable: true })
  marketCounterCid!: string | null;

  @Column({
    name: "market_counter_value",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  marketCounterValue!: number | null;

  /** Ranges of updates the index never saw (a resync after falling behind the prune point). */
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  gaps!: IndexerGap[];

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

export const INDEXER_STATE_KEY = "ledger";
