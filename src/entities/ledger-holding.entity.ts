import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * Every token-standard `Holding` the indexer saw through the `HoldingV1.Holding` interface filter
 * (docs/INDEXER.md §6 `to_ledger_holdings`): the treasury's float per instrument, and the inputs
 * a registry-mode transfer spends (unlocked holdings, largest first). Archived rows are kept with
 * their `archived_offset` so a transfer's change can be reconciled; the active set is
 * `archived_offset IS NULL`.
 */
@Entity({ name: "to_ledger_holdings" })
@Index("ix_to_ledger_holdings_instrument_owner", ["instrumentAdmin", "instrumentId", "owner"])
@Index("ix_to_ledger_holdings_archived", ["archivedOffset"])
export class LedgerHoldingEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  owner!: string;

  @Column({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  /** A locked holding (an open allocation / two-step transfer) is not spendable as a transfer input. */
  @Column({ type: "boolean", default: false })
  locked!: boolean;

  @Column({ name: "lock_expires_at", type: "timestamptz", nullable: true })
  lockExpiresAt!: Date | null;

  @Column({ name: "created_offset", type: "bigint", transformer: bigintNumberTransformer })
  createdOffset!: number;

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
