import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { BankStatementStatus } from "../types";
import { moneyTransformer } from "../util/money";

/**
 * A statement of the CLIENT-MONEY account (SPEC §3.4 S6, §10.4). Account, period and balances come
 * from the file (camt.053 or the CSV layout), never from the request (X3); an upload must chain on
 * to the latest confirmed statement (opening = its closing, contiguous business days) and add up
 * (Σ lines = closing − opening). A `draft` becomes `confirmed` only by the four-eyes
 * `ramp.statement.confirm`, whose approver uploads their OWN copy: its canonical parse must hash the
 * same (`canonical_hash`, an HMAC under the index keyring, so no IBAN is recoverable from it).
 */
@Entity({ name: "to_ramp_bank_statements" })
@Index("ix_to_ramp_bank_statements_status", ["status", "periodTo"])
export class RampBankStatementEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** The company's client-money account (normalised IBAN). */
  @Column({ name: "account_iban", type: "text" })
  accountIban!: string;

  @Column({ type: "text" })
  format!: "csv" | "camt053";

  @Column({ name: "file_sha256", type: "text" })
  fileSha256!: string;

  @Column({ name: "canonical_hash", type: "text" })
  canonicalHash!: string;

  @Column({ name: "canonical_kid", type: "text" })
  canonicalKid!: string;

  /** Minsk calendar days, `YYYY-MM-DD`. */
  @Column({ name: "period_from", type: "date" })
  periodFrom!: string;

  @Column({ name: "period_to", type: "date" })
  periodTo!: string;

  @Column({
    name: "opening_balance",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  openingBalance!: bigint;

  @Column({
    name: "closing_balance",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  closingBalance!: bigint;

  @Column({ type: "text" })
  currency!: string;

  /** The confirmed statement this one chains on to (null for the first). */
  @Column({ name: "prev_statement_id", type: "uuid", nullable: true })
  prevStatementId!: string | null;

  @Column({ type: "text" })
  status!: BankStatementStatus;

  @Column({ name: "imported_by_user_id", type: "uuid" })
  importedByUserId!: string;

  /** The importing PERSON: the confirming approver must be someone else. */
  @Column({ name: "imported_by_person", type: "text" })
  importedByPerson!: string;

  @Column({ name: "approval_id", type: "uuid", nullable: true })
  approvalId!: string | null;

  /** The person whose own copy parsed identically (SPEC §10.4), and when. */
  @Column({ name: "second_copy_person", type: "text", nullable: true })
  secondCopyPerson!: string | null;

  @Column({ name: "second_copy_at", type: "timestamptz", nullable: true })
  secondCopyAt!: Date | null;

  @Column({ name: "confirmed_at", type: "timestamptz", nullable: true })
  confirmedAt!: Date | null;

  @Column({ name: "line_count", type: "integer", default: 0 })
  lineCount!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
