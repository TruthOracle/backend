import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from "typeorm";

import { KycVerificationEntity } from "./kyc-verification.entity";
import { UserEntity } from "./user.entity";

/**
 * The one-person-one-account binding (ARCHITECTURE §9.3 `to_kyc_persons`). `fingerprint` is a
 * peppered HMAC of a document or person key; raw values are never stored. A binding survives
 * expiry, closure and re-verification — only an audited admin transfer releases it.
 */
@Entity({ name: "to_kyc_persons" })
export class KycPersonEntity {
  @PrimaryColumn({ type: "text" })
  fingerprint!: string;

  /** `doc` | `person`. */
  @Column({ type: "text" })
  kind!: "doc" | "person";

  @Index("ix_to_kyc_persons_user_id")
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  @Column({ name: "verification_id", type: "uuid" })
  verificationId!: string;

  @ManyToOne(() => KycVerificationEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "verification_id" })
  verification?: KycVerificationEntity;

  @Column({ name: "fingerprint_version", type: "smallint", default: 1 })
  fingerprintVersion!: number;

  @Column({ name: "bound_at", type: "timestamptz" })
  boundAt!: Date;

  @Column({ name: "released_at", type: "timestamptz", nullable: true })
  releasedAt!: Date | null;

  @Column({ name: "released_by", type: "uuid", nullable: true })
  releasedBy!: string | null;

  @Column({ name: "release_reason", type: "text", nullable: true })
  releaseReason!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
