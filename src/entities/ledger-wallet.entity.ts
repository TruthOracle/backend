import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * Every `UserWallet` contract version (docs/INDEXER.md §3 `to_ledger_wallets`). The active row
 * per (owner, instrument) is the in-app balance the ledger holds right now in that instrument;
 * the archived rows are how it got there (one per Deposit / Grant / Credit / Debit / Withdraw —
 * see `to_wallet_entries`).
 */
@Entity({ name: "to_ledger_wallets" })
@Index("ix_to_ledger_wallets_owner_active", ["owner", "active"])
@Index("ix_to_ledger_wallets_owner_instrument_active", [
  "owner",
  "instrumentAdmin",
  "instrumentId",
  "active",
])
export class LedgerWalletEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  owner!: string;

  @Column({ type: "text" })
  admin!: string;

  @Column({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, default: 0, transformer: moneyTransformer })
  balance!: bigint;

  @Column({ type: "numeric", precision: 38, scale: 10, default: 0, transformer: moneyTransformer })
  deposited!: bigint;

  @Column({ type: "numeric", precision: 38, scale: 10, default: 0, transformer: moneyTransformer })
  withdrawn!: bigint;

  /** Deposit txRefs and grant refs already applied, newest first (`UserWallet.creditRefs`). */
  @Column({ name: "credit_refs", type: "jsonb", default: () => "'[]'::jsonb" })
  creditRefs!: string[];

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
