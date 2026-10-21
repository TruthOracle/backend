import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

import type { PayoutItemStatus } from "../types";
import { moneyTransformer } from "../util/money";

/**
 * One order in a payout batch (SPEC §3.4 S6): `included` until a statement settles it — `paid`
 * (its debit matched), `returned` (a strict return matched), `voided` (the batch was cancelled or
 * voided), `unpaid` (`ramp.order.bank_unpaid` proved no debit). `document_no` comes from one
 * sequence, so it is unique across batches and a debit quoting it names one item. The item keeps
 * the account's IBAN hash at batching time: a statement debit to any other IBAN is a mismatch.
 */
@Entity({ name: "to_ramp_payout_batch_items" })
@Index("ix_to_ramp_payout_batch_items_order", ["orderId"])
@Index("uq_to_ramp_payout_batch_items_document", ["documentNo"], { unique: true })
export class RampPayoutBatchItemEntity {
  @PrimaryColumn({ name: "batch_id", type: "uuid" })
  batchId!: string;

  @PrimaryColumn({ name: "order_id", type: "uuid" })
  orderId!: string;

  @Column({ type: "text" })
  kind!: "payout" | "refund";

  /** Numeric (a bigint sequence value as text). */
  @Column({ name: "document_no", type: "text" })
  documentNo!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ name: "bank_account_id", type: "uuid" })
  bankAccountId!: string;

  @Column({ name: "iban_hash", type: "text" })
  ibanHash!: string;

  @Column({ name: "iban_hash_kid", type: "text" })
  ibanHashKid!: string;

  @Column({ type: "text" })
  status!: PayoutItemStatus;

  @Column({ name: "paid_line_id", type: "uuid", nullable: true })
  paidLineId!: string | null;

  @Column({ name: "returned_line_id", type: "uuid", nullable: true })
  returnedLineId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
