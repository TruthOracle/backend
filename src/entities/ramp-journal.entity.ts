import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { moneyTransformer } from "../util/money";

/**
 * The closed set of journal accounts (SPEC §5; the migration CHECKs it). Client assets:
 * provider_clearing, safeguard_bank, chargeback_receivable. Client liabilities: issuance_pending,
 * customer_liability, payout_clearing, bank_suspense (credit balance only). Operator:
 * operator_money, fee_revenue, psp_fees, bank_fees.
 */
export const RAMP_ACCOUNTS = [
  "provider_clearing",
  "safeguard_bank",
  "chargeback_receivable",
  "issuance_pending",
  "customer_liability",
  "payout_clearing",
  "bank_suspense",
  "operator_money",
  "fee_revenue",
  "psp_fees",
  "bank_fees",
] as const;
export type RampAccount = (typeof RAMP_ACCOUNTS)[number];

/** Client-liability accounts: their lines carry `user_id` (the per-client sub-ledger, R12). */
export const RAMP_CLIENT_LIABILITY_ACCOUNTS: readonly RampAccount[] = [
  "issuance_pending",
  "customer_liability",
  "payout_clearing",
];

/**
 * One line of the ramp's append-only double-entry journal in fiat (SPEC §5 `to_ramp_journal`).
 * `amount` is signed: + debit, − credit; the lines of one `entry_id` sum to zero (checked when
 * posting and by the reconciliation). A posting is unique per (order, kind) and per (statement
 * line, kind) — one line per account; triggers refuse UPDATE, DELETE and TRUNCATE.
 */
@Entity({ name: "to_ramp_journal" })
@Index("ix_to_ramp_journal_entry", ["entryId"])
@Index("ix_to_ramp_journal_account", ["account"])
@Index("ix_to_ramp_journal_user", ["userId"])
export class RampJournalEntity {
  @PrimaryGeneratedColumn("increment", { type: "bigint" })
  id!: string;

  @Column({ name: "entry_id", type: "uuid" })
  entryId!: string;

  /** The posting's kind (`onramp.captured`, `offramp.burned`, `psp.settlement`, …). */
  @Column({ type: "text" })
  kind!: string;

  @Column({ name: "order_id", type: "uuid", nullable: true })
  orderId!: string | null;

  /** The bank statement line a line-scoped posting books (S6). */
  @Column({ name: "statement_line_id", type: "uuid", nullable: true })
  statementLineId!: string | null;

  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId!: string | null;

  @Column({ type: "text" })
  account!: RampAccount;

  @Column({ type: "text" })
  currency!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
