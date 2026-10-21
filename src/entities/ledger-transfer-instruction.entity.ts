import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import type { TransferInstructionStatus } from "../types";
import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * Two-step token-standard transfers the treasury is sender or receiver of
 * (`TransferInstructionV1.TransferInstruction` interface views; docs/INDEXER.md §6
 * `to_ledger_transfer_instructions`). The acceptor processor completes the pending ones addressed
 * to the treasury for known, enabled instruments; `status` follows the archive (`completed` on
 * `TransferInstruction_Accept`, `failed` on a reject / withdraw / expiry).
 */
@Entity({ name: "to_ledger_transfer_instructions" })
@Index("ix_to_ledger_transfer_instructions_status_receiver", ["status", "receiver"])
export class LedgerTransferInstructionEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  @Column({ type: "text" })
  sender!: string;

  @Column({ type: "text" })
  receiver!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  @Column({ name: "execute_before", type: "timestamptz", nullable: true })
  executeBefore!: Date | null;

  @Column({ type: "text", default: "pending" })
  status!: TransferInstructionStatus;

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
