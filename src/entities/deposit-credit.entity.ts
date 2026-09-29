import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";

import { moneyTransformer } from "../util/money";
import { UserEntity } from "./user.entity";

export interface DepositAttribution {
  walletId: string;
  partyId: string;
  /** 10-dp string (jsonb cannot hold bigint). */
  amountCC: string;
}

/** Write-ahead record of every treasury-signed credit (ARCHITECTURE §8.3 `to_deposit_credits`). */
@Entity({ name: "to_deposit_credits" })
export class DepositCreditEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index("ix_to_deposit_credits_user_id")
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  @Column({ name: "owner_party", type: "text" })
  ownerParty!: string;

  /** `deposit-<sha256(...)[:40]>` — deterministic; concurrent duplicates collide here. */
  @Index("uq_to_deposit_credits_command_id", { unique: true })
  @Column({ name: "command_id", type: "text" })
  commandId!: string;

  @Column({ name: "tx_ref", type: "text" })
  txRef!: string;

  @Column({
    name: "amount_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  amountCC!: bigint;

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  attribution!: DepositAttribution[];

  @Column({
    name: "deposited_cc_before",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  depositedCCBefore!: bigint;

  @Column({ name: "wallet_cid_before", type: "text", nullable: true })
  walletCidBefore!: string | null;

  @Index("ix_to_deposit_credits_status")
  @Column({ type: "text", default: "submitted" })
  status!: "submitted" | "confirmed" | "failed";

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  /** When the row was (re-)armed `submitted`; the confirm pass grace period counts from here. */
  @Column({ name: "submitted_at", type: "timestamptz", default: () => "now()" })
  submittedAt!: Date;

  @Column({ name: "confirmed_at", type: "timestamptz", nullable: true })
  confirmedAt!: Date | null;
}
