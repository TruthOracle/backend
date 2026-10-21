import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { ScreeningHitMatch, ScreeningHitStatus } from "../types";

/**
 * A screening hit (`to_screening_hits`): an account matched an entry of one list version (by its
 * verified names and birth date, or by one of its party ids). One per (list version, entry,
 * account), so a cleared hit stays cleared for that version. `open` until the AML officer decides
 * (`compliance.hit.decide`): `confirmed` (a Belarusian / UN hit keeps the account frozen,
 * provisional = false) or `cleared` (the provisional freeze is lifted). `match` holds what matched —
 * the list side verbatim, the account side only as the matched name form and birth-date level.
 */
@Entity({ name: "to_screening_hits" })
@Index("uq_to_screening_hits_entry_user", ["listId", "entryId", "userId"], { unique: true })
@Index("ix_to_screening_hits_user", ["userId", "status"])
@Index("ix_to_screening_hits_status", ["status", "createdAt"])
export class ScreeningHitEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "list_id", type: "uuid" })
  listId!: string;

  @Column({ name: "entry_id", type: "uuid" })
  entryId!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  /** The re-screen that found it. */
  @Column({ name: "run_id", type: "uuid", nullable: true })
  runId!: string | null;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  match!: ScreeningHitMatch;

  @Column({ type: "text", default: "open" })
  status!: ScreeningHitStatus;

  /** The compliance alert raised for it (S7a's id; null when the compliance port raised none). */
  @Column({ name: "alert_id", type: "text", nullable: true })
  alertId!: string | null;

  /** The freeze the hit placed or found active (Belarusian / UN lists only). */
  @Column({ name: "freeze_id", type: "uuid", nullable: true })
  freezeId!: string | null;

  @Column({ name: "decided_by_user_id", type: "uuid", nullable: true })
  decidedByUserId!: string | null;

  @Column({ name: "decided_by_person", type: "text", nullable: true })
  decidedByPerson!: string | null;

  @Column({ name: "decided_at", type: "timestamptz", nullable: true })
  decidedAt!: Date | null;

  @Column({ name: "decision_reason", type: "text", nullable: true })
  decisionReason!: string | null;

  @Column({ name: "decision_approval_id", type: "uuid", nullable: true })
  decisionApprovalId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
