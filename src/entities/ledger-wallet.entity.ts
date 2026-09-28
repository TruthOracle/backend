import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * Every `UserWallet` contract version (docs/INDEXER.md §3 `to_ledger_wallets`). The active row
 * per owner is the in-app balance the ledger holds right now; the archived rows are how it got
 * there (one per Deposit / Credit / Debit / Withdraw — see `to_wallet_entries`).
 */
@Entity({ name: "to_ledger_wallets" })
@Index("ix_to_ledger_wallets_owner_active", ["owner", "active"])
export class LedgerWalletEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  owner!: string;

  @Column({ type: "text" })
  admin!: string;

  @Column({
    name: "balance_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  balanceCC!: bigint;

  @Column({
    name: "deposited_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  depositedCC!: bigint;

  @Column({
    name: "withdrawn_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  withdrawnCC!: bigint;

  @Column({ name: "deposit_refs", type: "jsonb", default: () => "'[]'::jsonb" })
  depositRefs!: string[];

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
