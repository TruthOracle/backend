import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import type { SessionKind } from "../types";
import { AuthIdentityEntity } from "./auth-identity.entity";
import { UserEntity } from "./user.entity";

/** Server-side session (ARCHITECTURE §5 `to_sessions`); only the sha256 of the token is stored. */
@Entity({ name: "to_sessions" })
export class SessionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index("ix_to_sessions_user_id")
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  /** The identity that authenticated this session (link-mode logins never change it). */
  @Column({ name: "auth_identity_id", type: "uuid" })
  authIdentityId!: string;

  @ManyToOne(() => AuthIdentityEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "auth_identity_id" })
  authIdentity?: AuthIdentityEntity;

  /** sha256(token) base64url. */
  @Index("uq_to_sessions_token_hash", { unique: true })
  @Column({ name: "token_hash", type: "text" })
  tokenHash!: string;

  @Column({ type: "text", default: "user" })
  kind!: SessionKind;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  /** Absolute expiry; activity never extends it. */
  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;

  /** Bumped at most every 5 minutes. */
  @Column({ name: "last_seen_at", type: "timestamptz", nullable: true })
  lastSeenAt!: Date | null;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt!: Date | null;

  @Column({ type: "text", nullable: true })
  ip!: string | null;

  @Column({ name: "user_agent", type: "text", nullable: true })
  userAgent!: string | null;
}
