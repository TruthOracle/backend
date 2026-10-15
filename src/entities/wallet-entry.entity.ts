import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { WalletEntryKind } from "../types";
import { bigintNumberTransformer, decimalTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * One row per `UserWallet` choice (docs/INDEXER.md §5 `to_wallet_entries`): the in-app
 * statement — deposits and reward grants credited by the treasury, trade debits / credits (with
 * the market and the choice they were part of), withdrawals queued to a PendingPayout. Amounts
 * are in the wallet's instrument.
 */
@Entity({ name: "to_wallet_entries" })
@Index("ix_to_wallet_entries_owner_offset", ["owner", "offset"])
@Index("ix_to_wallet_entries_kind", ["kind"])
@Index("ix_to_wallet_entries_market", ["marketId"])
export class WalletEntryEntity {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Index("uq_to_wallet_entries_event_id", { unique: true })
  @Column({ name: "event_id", type: "text" })
  eventId!: string;

  @Column({ type: "text" })
  owner!: string;

  /** The wallet contract the choice consumed. */
  @Column({ name: "wallet_cid", type: "text" })
  walletCid!: string;

  @Column({ name: "new_wallet_cid", type: "text", nullable: true })
  newWalletCid!: string | null;

  @Column({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  @Column({ type: "text" })
  kind!: WalletEntryKind;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  @Column({ type: "text", nullable: true })
  reason!: string | null;

  @Column({ name: "tx_ref", type: "text", nullable: true })
  txRef!: string | null;

  @Column({
    name: "balance_after",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: decimalTransformer,
  })
  balanceAfter!: bigint | null;

  @Column({
    name: "market_id",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  marketId!: number | null;

  @Column({ name: "root_choice", type: "text", nullable: true })
  rootChoice!: string | null;

  @Column({ name: "root_template", type: "text", nullable: true })
  rootTemplate!: string | null;

  @Column({ type: "bigint", transformer: bigintNumberTransformer })
  offset!: number;

  @Column({ name: "node_id", type: "integer" })
  nodeId!: number;

  @Column({ name: "update_id", type: "text" })
  updateId!: string;

  @Column({ name: "effective_at", type: "timestamptz" })
  effectiveAt!: Date;

  @Column({ name: "record_time", type: "timestamptz", nullable: true })
  recordTime!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
