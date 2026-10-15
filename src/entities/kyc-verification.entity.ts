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

import type { KycVerificationStatus } from "../types";
import { AuthIdentityEntity } from "./auth-identity.entity";
import { UserEntity } from "./user.entity";

/** One verification attempt (ARCHITECTURE §5 `to_kyc_verifications`). */
@Entity({ name: "to_kyc_verifications" })
@Index("uq_to_kyc_verifications_attempt", ["userId", "provider", "levelName", "attemptNo"], {
  unique: true,
})
export class KycVerificationEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index("ix_to_kyc_verifications_user_id")
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  /** `mock` | `sumsub` | `admin`. */
  @Column({ type: "text" })
  provider!: string;

  /** Reference only (non-unique); the binding lives on to_users. */
  @Column({ name: "provider_applicant_id", type: "text", nullable: true })
  providerApplicantId!: string | null;

  @Column({ name: "level_name", type: "text" })
  levelName!: string;

  @Column({ name: "attempt_no", type: "integer", default: 1 })
  attemptNo!: number;

  @Column({ type: "text", default: "initiated" })
  status!: KycVerificationStatus;

  /** = `session.auth_identity_id` of the session that started it; null for admin overrides. */
  @Column({ name: "initiated_identity_id", type: "uuid", nullable: true })
  initiatedIdentityId!: string | null;

  @ManyToOne(() => AuthIdentityEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "initiated_identity_id" })
  initiatedIdentity?: AuthIdentityEntity | null;

  /** Last applied provider event time — stale events are dropped. */
  @Column({ name: "provider_event_at", type: "timestamptz", nullable: true })
  providerEventAt!: Date | null;

  @Column({ name: "reject_labels", type: "jsonb", nullable: true })
  rejectLabels!: string[] | null;

  /** User-facing text only, ≤ 500 chars; `clientComment` is never stored. */
  @Column({ name: "moderation_comment", type: "text", nullable: true })
  moderationComment!: string | null;

  @Column({ type: "boolean", default: false })
  manual!: boolean;

  @Column({ name: "manual_reason", type: "text", nullable: true })
  manualReason!: string | null;

  @Column({ name: "reviewed_at", type: "timestamptz", nullable: true })
  reviewedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
