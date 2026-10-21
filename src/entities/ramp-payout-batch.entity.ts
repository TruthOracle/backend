import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { PayoutBatchStatus } from "../types";
import { moneyTransformer } from "../util/money";

/**
 * An operator payout batch (SPEC §3.4 S6, §10.3): `draft` (ops) → `approved` (four-eyes
 * `ramp.batch.approve`, after a pre-batch reconciliation and the payout gate) → `exported` (the
 * first file needs the payout gate; a re-export must hash the same) → `submitted` (orders →
 * `payout_sent`) → `settled` (every item resolved by statements). `cancelled` only from draft or
 * approved; `voided` (four-eyes `ramp.batch.void`) only from exported, with statement proof or the
 * bank's rejection reference — a file that left our hands is never cancelled (#4, X4).
 */
@Entity({ name: "to_ramp_payout_batches" })
@Index("ix_to_ramp_payout_batches_status", ["status", "createdAt"])
export class RampPayoutBatchEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  status!: PayoutBatchStatus;

  @Column({ type: "text" })
  currency!: string;

  @Column({ name: "item_count", type: "integer", default: 0 })
  itemCount!: number;

  @Column({
    name: "total_amount",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  totalAmount!: bigint;

  @Column({ name: "created_by_user_id", type: "uuid" })
  createdByUserId!: string;

  /** The creating PERSON: the approver must be someone else. */
  @Column({ name: "created_by_person", type: "text" })
  createdByPerson!: string;

  @Column({ name: "approval_id", type: "uuid", nullable: true })
  approvalId!: string | null;

  @Column({ name: "file_format", type: "text", nullable: true })
  fileFormat!: string | null;

  @Column({ name: "file_sha256", type: "text", nullable: true })
  fileSha256!: string | null;

  @Column({ name: "exported_at", type: "timestamptz", nullable: true })
  exportedAt!: Date | null;

  @Column({ name: "exported_by_user_id", type: "uuid", nullable: true })
  exportedByUserId!: string | null;

  @Column({ name: "export_count", type: "integer", default: 0 })
  exportCount!: number;

  @Column({ name: "submitted_at", type: "timestamptz", nullable: true })
  submittedAt!: Date | null;

  @Column({ name: "submitted_by_user_id", type: "uuid", nullable: true })
  submittedByUserId!: string | null;

  /** The bank's reference for the uploaded file (a batch-total debit may quote it). */
  @Column({ name: "bank_reference", type: "text", nullable: true })
  bankReference!: string | null;

  @Column({ name: "settled_at", type: "timestamptz", nullable: true })
  settledAt!: Date | null;

  @Column({ name: "void_approval_id", type: "uuid", nullable: true })
  voidApprovalId!: string | null;

  /** `{cancelReason, voidReason, bankRejectionRef}` and similar facts. */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  details!: Record<string, unknown>;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
