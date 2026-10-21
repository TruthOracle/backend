import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { FreezeSource } from "../types";
import { bigintNumberTransformer } from "../util/ledger-values";

/**
 * A freeze of an account (SPEC §3.4 S7b, §11.6; B3, X6; `to_compliance_freezes`): while one is
 * active no fiat leaves to the user and the backend prepares no value movement for them. At most
 * one ACTIVE freeze per account (partial unique index). Placed at once by an `aml` operator, or
 * automatically (`created_by_user_id` null, `provisional`) by a Belarusian / UN list hit awaiting
 * the AML decision; lifted by the four-eyes `compliance.freeze.lift`, or — provisional only — by
 * clearing the hit. Rows are never deleted (R4).
 */
@Entity({ name: "to_compliance_freezes" })
@Index("uq_to_compliance_freezes_active_user", ["userId"], { unique: true, where: `"active"` })
@Index("ix_to_compliance_freezes_user", ["userId", "createdAt"])
@Index("ix_to_compliance_freezes_active", ["active", "createdAt"])
export class ComplianceFreezeEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ type: "text" })
  reason!: string;

  @Column({ type: "text" })
  source!: FreezeSource;

  /** A list hit's automatic freeze until the AML officer confirms (→ false) or clears it (→ lifted). */
  @Column({ type: "boolean", default: false })
  provisional!: boolean;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  /** The operator's admin user; null = automatic (screening). */
  @Column({ name: "created_by_user_id", type: "uuid", nullable: true })
  createdByUserId!: string | null;

  @Column({ name: "created_by_person", type: "text", nullable: true })
  createdByPerson!: string | null;

  @Column({ name: "lift_approval_id", type: "uuid", nullable: true })
  liftApprovalId!: string | null;

  @Column({ name: "lifted_by_user_id", type: "uuid", nullable: true })
  liftedByUserId!: string | null;

  @Column({ name: "lift_reason", type: "text", nullable: true })
  liftReason!: string | null;

  @Column({ name: "lifted_at", type: "timestamptz", nullable: true })
  liftedAt!: Date | null;

  /** TM-FROZEN-ACTIVITY: the ledger offset up to which the account's on-ledger activity was checked. */
  @Column({
    name: "activity_offset",
    type: "bigint",
    default: 0,
    transformer: bigintNumberTransformer,
  })
  activityOffset!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
