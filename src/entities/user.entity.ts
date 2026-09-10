import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

import type { UserKycStatus, UserStatus } from "../types";

/**
 * One row per account (ARCHITECTURE §5 `to_users`). There is no `role` column: admin authority
 * is a property of a wallet-signed admin session, derived per request.
 */
@Entity({ name: "to_users" })
@Index("uq_to_users_kyc_applicant", ["kycProvider", "kycApplicantId"], { unique: true })
export class UserEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "display_name", type: "text", nullable: true })
  displayName!: string | null;

  @Column({ name: "avatar_url", type: "text", nullable: true })
  avatarUrl!: string | null;

  /** Informational, from a verified Google identity; NOT unique — uniqueness lives on identities. */
  @Column({ type: "citext", nullable: true })
  email!: string | null;

  @Column({ type: "text", default: "active" })
  status!: UserStatus;

  /** Denormalised from the verification that set it (precedence in §9.2). */
  @Column({ name: "kyc_status", type: "text", default: "none" })
  kycStatus!: UserKycStatus;

  @Column({ name: "kyc_verification_id", type: "uuid", nullable: true })
  kycVerificationId!: string | null;

  @Column({ name: "kyc_provider", type: "text", nullable: true })
  kycProvider!: string | null;

  /** The provider applicant bound to this user — Sumsub keeps one applicant per externalUserId. */
  @Column({ name: "kyc_applicant_id", type: "text", nullable: true })
  kycApplicantId!: string | null;

  /** In-app wallet owner party = the primary wallet's party (§8.2). */
  @Index("uq_to_users_party_id", { unique: true })
  @Column({ name: "party_id", type: "text", nullable: true })
  partyId!: string | null;

  @Column({ name: "last_login_at", type: "timestamptz", nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
