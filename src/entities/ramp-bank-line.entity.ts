import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { BankLineFlag, BankLineStatus, BankMatchKind } from "../types";
import { moneyTransformer } from "../util/money";

/**
 * One booked line of a client-money statement (SPEC §3.4 S6, §10.4). The full line (counterparty
 * name and IBAN, purpose text) is sealed v2 (`raw_sealed`, AAD `ramp-line|<statementId>|<id>`);
 * in the clear stay the amount, dates, the counterparty IBAN's blind index and last four, the BIC,
 * the bank transaction code, return information, the `TO…` reference (homoglyphs folded) and the
 * document number. `status`: `proposed` on a draft's preview, `matched` once a confirm or a
 * classification booked it (its journal lines carry `statement_line_id`), else `unmatched`.
 */
@Entity({ name: "to_ramp_bank_lines" })
@Index("uq_to_ramp_bank_lines_ref", ["statementId", "lineRef"], { unique: true })
@Index("ix_to_ramp_bank_lines_reference", ["reference"])
@Index("ix_to_ramp_bank_lines_status", ["status"])
export class RampBankLineEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "statement_id", type: "uuid" })
  statementId!: string;

  /** The bank's transaction id (unique per account across confirmed statements). */
  @Column({ name: "line_ref", type: "text" })
  lineRef!: string;

  @Column({ name: "booking_date", type: "date" })
  bookingDate!: string;

  @Column({ name: "value_date", type: "date", nullable: true })
  valueDate!: string | null;

  /** Signed: + credit, − debit. */
  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  @Column({ type: "text" })
  currency!: string;

  @Column({ name: "counterparty_iban_hash", type: "text", nullable: true })
  counterpartyIbanHash!: string | null;

  @Column({ name: "counterparty_iban_hash_kid", type: "text", nullable: true })
  counterpartyIbanHashKid!: string | null;

  @Column({ name: "counterparty_iban_last4", type: "text", nullable: true })
  counterpartyIbanLast4!: string | null;

  @Column({ name: "counterparty_bic", type: "text", nullable: true })
  counterpartyBic!: string | null;

  @Column({ name: "bank_tx_code", type: "text", nullable: true })
  bankTxCode!: string | null;

  /** camt.053 `RtrInf` or a return `BkTxCd` (RRTN), or the CSV `return_code` column. */
  @Column({ name: "return_info", type: "boolean", default: false })
  returnInfo!: boolean;

  @Column({ name: "return_code", type: "text", nullable: true })
  returnCode!: string | null;

  /** `TO` + 12 digits (stored form), when the line quotes a valid one. */
  @Column({ type: "text", nullable: true })
  reference!: string | null;

  @Column({ name: "document_no", type: "text", nullable: true })
  documentNo!: string | null;

  @Column({ name: "raw_sealed", type: "text" })
  rawSealed!: string;

  @Column({ name: "match_kind", type: "text", nullable: true })
  matchKind!: BankMatchKind | null;

  @Column({ name: "matched_order_id", type: "uuid", nullable: true })
  matchedOrderId!: string | null;

  @Column({ name: "matched_batch_id", type: "uuid", nullable: true })
  matchedBatchId!: string | null;

  @Column({ type: "text", default: "unmatched" })
  status!: BankLineStatus;

  @Column({ type: "text", array: true, default: () => "'{}'::text[]" })
  flags!: BankLineFlag[];

  /** The four-eyes approval that booked it (a confirm or a classification). */
  @Column({ name: "approval_id", type: "uuid", nullable: true })
  approvalId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
