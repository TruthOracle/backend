import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * Every `Position` contract version (docs/INDEXER.md §3 `to_positions`). A trade archives the
 * holder's position and creates a successor, so the active row (`active = true`) is the current
 * holding and the archived rows are its history.
 */
@Entity({ name: "to_positions" })
@Index("ix_to_positions_holder_active", ["holder", "active"])
@Index("ix_to_positions_market_active", ["marketId", "active"])
@Index("ix_to_positions_holder_market", ["holder", "marketId"])
export class PositionEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  holder!: string;

  @Column({ type: "text" })
  admin!: string;

  @Column({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Column({
    name: "yes_shares",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  yesShares!: bigint;

  @Column({
    name: "no_shares",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  noShares!: bigint;

  @Column({
    name: "cost_basis_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  costBasisCC!: bigint;

  @Column({ name: "audit_observers", type: "jsonb", default: () => "'[]'::jsonb" })
  auditObservers!: string[];

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Column({ name: "created_offset", type: "bigint", transformer: bigintNumberTransformer })
  createdOffset!: number;

  @Column({ name: "created_event_id", type: "text" })
  createdEventId!: string;

  @Column({ name: "created_at_ledger", type: "timestamptz", nullable: true })
  createdAtLedger!: Date | null;

  @Column({
    name: "archived_offset",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  archivedOffset!: number | null;

  @Column({ name: "archived_choice", type: "text", nullable: true })
  archivedChoice!: string | null;

  @Column({ name: "archived_at_ledger", type: "timestamptz", nullable: true })
  archivedAtLedger!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
