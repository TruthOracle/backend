import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/** Every `LiquidityPosition` contract version (docs/INDEXER.md §3 `to_liquidity_positions`); the active row is the LP's current claim. */
@Entity({ name: "to_liquidity_positions" })
@Index("ix_to_liquidity_positions_provider_active", ["provider", "active"])
@Index("ix_to_liquidity_positions_market_active", ["marketId", "active"])
export class LiquidityPositionEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  provider!: string;

  @Column({ type: "text" })
  admin!: string;

  @Column({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Column({
    name: "lp_tokens",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  lpTokens!: bigint;

  /** Collateral the provider put in (`LiquidityPosition.deposited`), in the market's collateral. */
  @Column({ type: "numeric", precision: 38, scale: 10, default: 0, transformer: moneyTransformer })
  deposited!: bigint;

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
