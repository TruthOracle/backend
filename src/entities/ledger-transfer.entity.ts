import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * Canton Coin transfers between the treasury and any other party, read from the treasury's own
 * transaction stream (docs/INDEXER.md §6 `to_ledger_transfers`). `in` rows are the deposits users
 * sent (what the reconcile credits), `out` rows the payouts / withdrawals the treasury paid.
 */
@Entity({ name: "to_ledger_transfers" })
@Index("ix_to_ledger_transfers_counterparty_offset", ["counterparty", "offset"])
@Index("ix_to_ledger_transfers_direction_offset", ["direction", "offset"])
export class LedgerTransferEntity {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  /** `<updateId>:<nodeId of the transfer exercise>` — one transaction may carry several transfers. */
  @Index("uq_to_ledger_transfers_event_id", { unique: true })
  @Column({ name: "event_id", type: "text" })
  eventId!: string;

  @Column({ name: "update_id", type: "text" })
  updateId!: string;

  @Column({ type: "bigint", transformer: bigintNumberTransformer })
  offset!: number;

  @Column({ type: "text" })
  direction!: "in" | "out";

  @Column({ type: "text" })
  counterparty!: string;

  @Column({
    name: "amount_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  amountCC!: bigint;

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
