import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { RampBankAccountStatus, RampBankProof, RampNameForm } from "../types";
import { UserEntity } from "./user.entity";

/**
 * A user's payout bank account (SPEC §3.4 S6, §10.2): a BYN IBAN held in the user's VERIFIED name.
 * The IBAN is sealed v2 (AAD `ramp-iban|<userId>|<id>`); uniqueness and matching use the keyed
 * blind index `iban_hash` (purpose `ramp-iban`, shared with the acquirer's payer IBAN hash, S5).
 * Lifecycle: `cooling_off` (RAMP_BANK_ACCOUNT_COOLOFF_HOURS) → `pending_proof` → `active` once
 * proved (`bank_name_check`, `payer_match`, four-eyes `manual`); `blocked` after a bank return;
 * `removed` by the user. The beneficiary NAME is never stored here: it is read from the identity
 * (`name_form`) when a file is built.
 */
@Entity({ name: "to_ramp_bank_accounts" })
@Index("ix_to_ramp_bank_accounts_user", ["userId", "status"])
// The migration's partial unique index `uq_to_ramp_bank_accounts_iban (iban_hash) WHERE status <> 'removed'`.
export class RampBankAccountEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  @Column({ name: "iban_sealed", type: "text" })
  ibanSealed!: string;

  @Column({ name: "iban_hash", type: "text" })
  ibanHash!: string;

  @Column({ name: "iban_hash_kid", type: "text" })
  ibanHashKid!: string;

  @Column({ name: "iban_last4", type: "text" })
  ibanLast4!: string;

  @Column({ type: "text", default: "BY" })
  country!: string;

  /** IBAN characters 5–8 = the bank's BIC prefix. */
  @Column({ name: "bank_code", type: "text" })
  bankCode!: string;

  @Column({ type: "text" })
  bic!: string;

  @Column({ name: "bank_name", type: "text" })
  bankName!: string;

  @Column({ name: "name_form", type: "text" })
  nameForm!: RampNameForm;

  @Column({ type: "text" })
  status!: RampBankAccountStatus;

  @Column({ name: "cooling_off_until", type: "timestamptz" })
  coolingOffUntil!: Date;

  @Column({ type: "text", nullable: true })
  proof!: RampBankProof | null;

  /** payer_match: the on-ramp that proved it; manual: the operator's reference. */
  @Column({ name: "proof_ref", type: "text", nullable: true })
  proofRef!: string | null;

  @Column({ name: "verified_at", type: "timestamptz", nullable: true })
  verifiedAt!: Date | null;

  /** The first payout to this account that completed (until then RAMP_BANK_FIRST_PAYOUT_MAX applies). */
  @Column({ name: "first_payout_order_id", type: "uuid", nullable: true })
  firstPayoutOrderId!: string | null;

  @Column({ name: "last_used_at", type: "timestamptz", nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: "removed_at", type: "timestamptz", nullable: true })
  removedAt!: Date | null;

  /** Why it is blocked (a bank return's code, an operator note). */
  @Column({ name: "blocked_reason", type: "text", nullable: true })
  blockedReason!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
