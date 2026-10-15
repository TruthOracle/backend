import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { TransferKind } from "../types";
import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * Token transfers between the treasury and any other party, in any instrument, read from the
 * treasury's own transaction stream (docs/INDEXER.md §6 `to_ledger_transfers`): token-standard
 * transfers from the `Holding` / `TransferInstruction` interface views (`kind = token_standard`),
 * Canton Coin from the Splice `Amulet` events (`kind = amulet`). `in` rows are the deposits users
 * sent (what the reconcile credits, per instrument), `out` rows the payouts / withdrawals the
 * treasury paid. One row per transfer exercise: unique on `(update_id, node_id)`.
 */
@Entity({ name: "to_ledger_transfers" })
@Index("uq_to_ledger_transfers_update_node", ["updateId", "nodeId"], { unique: true })
@Index("ix_to_ledger_transfers_counterparty_offset", ["counterparty", "offset"])
@Index("ix_to_ledger_transfers_direction_offset", ["direction", "offset"])
@Index("ix_to_ledger_transfers_instrument_counterparty", [
  "instrumentAdmin",
  "instrumentId",
  "counterparty",
  "direction",
])
export class LedgerTransferEntity {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ name: "update_id", type: "text" })
  updateId!: string;

  /** Node id of the transfer exercise — one transaction may carry several transfers. */
  @Column({ name: "node_id", type: "integer" })
  nodeId!: number;

  @Column({ type: "bigint", transformer: bigintNumberTransformer })
  offset!: number;

  @Column({ type: "text" })
  direction!: "in" | "out";

  @Column({ type: "text" })
  counterparty!: string;

  @Column({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  @Column({ type: "text" })
  kind!: TransferKind;

  @Column({ type: "text" })
  choice!: string;

  @Column({ name: "record_time", type: "timestamptz", nullable: true })
  recordTime!: Date | null;

  @Column({ name: "effective_at", type: "timestamptz" })
  effectiveAt!: Date;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  details!: Record<string, unknown>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
