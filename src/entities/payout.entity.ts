import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { PayoutStatus } from "../types";
import { moneyTransformer } from "../util/money";

/** Durable arbiter for settlement (ARCHITECTURE §9.4 `to_payouts`). */
@Entity({ name: "to_payouts" })
export class PayoutEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index("uq_to_payouts_pending_payout_cid", { unique: true })
  @Column({ name: "pending_payout_cid", type: "text" })
  pendingPayoutCid!: string;

  @Index("ix_to_payouts_user_id")
  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId!: string | null;

  @Column({ name: "payee_party", type: "text" })
  payeeParty!: string;

  @Column({ name: "payee_wallet_id", type: "uuid", nullable: true })
  payeeWalletId!: string | null;

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

  @Index("ix_to_payouts_status")
  @Column({ type: "text", default: "queued" })
  status!: PayoutStatus;

  @Column({ name: "transfer_command_id", type: "text", nullable: true })
  transferCommandId!: string | null;

  @Column({ name: "wallet_create_command_id", type: "text", nullable: true })
  walletCreateCommandId!: string | null;

  @Column({ name: "settle_command_id", type: "text", nullable: true })
  settleCommandId!: string | null;

  @Column({ name: "mark_paid_command_id", type: "text", nullable: true })
  markPaidCommandId!: string | null;

  @Column({ type: "integer", default: 0 })
  attempts!: number;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError!: string | null;

  @Column({ name: "first_seen_at", type: "timestamptz" })
  firstSeenAt!: Date;

  @Column({ name: "settled_at", type: "timestamptz", nullable: true })
  settledAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
