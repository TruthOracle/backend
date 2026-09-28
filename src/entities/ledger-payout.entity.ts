import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import type { LedgerPayoutSettledKind } from "../types";
import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/**
 * Every `PendingPayout` contract and how it ended (docs/INDEXER.md §3 `to_ledger_payouts`):
 * the on-ledger side of what `to_payouts` (the backend's settlement arbiter) tracks. Keyed by
 * contract id like `to_payouts.pending_payout_cid`, so the two join directly.
 */
@Entity({ name: "to_ledger_payouts" })
@Index("ix_to_ledger_payouts_user_active", ["userParty", "active"])
@Index("ix_to_ledger_payouts_active", ["active"])
@Index("ix_to_ledger_payouts_market", ["marketId"])
export class LedgerPayoutEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  admin!: string;

  /** The payee — `PendingPayout.user` in the Daml. */
  @Column({ name: "user_party", type: "text" })
  userParty!: string;

  @Column({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Column({
    name: "amount_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  amountCC!: bigint;

  @Column({ type: "text" })
  reason!: string;

  @Column({ name: "created_at_sec", type: "bigint", transformer: bigintNumberTransformer })
  createdAtSec!: number;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Column({ name: "created_offset", type: "bigint", transformer: bigintNumberTransformer })
  createdOffset!: number;

  @Column({ name: "created_event_id", type: "text" })
  createdEventId!: string;

  @Column({ name: "created_at_ledger", type: "timestamptz", nullable: true })
  createdAtLedger!: Date | null;

  @Column({ name: "settled_kind", type: "text", nullable: true })
  settledKind!: LedgerPayoutSettledKind | null;

  @Column({
    name: "settled_offset",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  settledOffset!: number | null;

  @Column({ name: "settled_at_ledger", type: "timestamptz", nullable: true })
  settledAtLedger!: Date | null;

  @Column({ name: "tx_hash", type: "text", nullable: true })
  txHash!: string | null;

  @Column({ type: "boolean", nullable: true })
  refunded!: boolean | null;

  @Column({ name: "settle_wallet_cid", type: "text", nullable: true })
  settleWalletCid!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
