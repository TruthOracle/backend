import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";

import { UserEntity } from "./user.entity";

export type RampPaymentMethodStatus = "active" | "removed" | "blocked";

/**
 * A card the acquirer tokenised for an account (SPEC §3.3 `to_ramp_payment_methods`). No PAN, CVV
 * or holder name — the provider token sealed v2 (AAD `ramp-pm|<provider>|<userId>|<id>`), the
 * provider's fingerprint (unique per provider: one card, one account) and display fields.
 * `payout_eligible` turns true when the card funds a completed, 3DS-authenticated on-ramp of the
 * account — the closed-loop rule for cash-outs.
 */
@Entity({ name: "to_ramp_payment_methods" })
@Index("ix_to_ramp_payment_methods_user", ["userId"])
@Index("uq_to_ramp_payment_methods_fingerprint", ["provider", "fingerprint"], { unique: true })
export class RampPaymentMethodEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  @Column({ type: "text" })
  provider!: string;

  @Column({ type: "text" })
  fingerprint!: string;

  @Column({ name: "token_sealed", type: "text" })
  tokenSealed!: string;

  @Column({ type: "text", nullable: true })
  brand!: string | null;

  @Column({ type: "text", nullable: true })
  last4!: string | null;

  @Column({ name: "exp_month", type: "integer", nullable: true })
  expMonth!: number | null;

  @Column({ name: "exp_year", type: "integer", nullable: true })
  expYear!: number | null;

  @Column({ name: "issuer_country", type: "text", nullable: true })
  issuerCountry!: string | null;

  @Column({ type: "text", default: "active" })
  status!: RampPaymentMethodStatus;

  @Column({ name: "payout_eligible", type: "boolean", default: false })
  payoutEligible!: boolean;

  @Column({ name: "first_order_id", type: "uuid", nullable: true })
  firstOrderId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "last_used_at", type: "timestamptz", nullable: true })
  lastUsedAt!: Date | null;
}
