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

import type { IdentityProvider, IdentityStatus } from "../types";
import { UserEntity } from "./user.entity";

/**
 * A sign-in identity (ARCHITECTURE §5 `to_auth_identities`). `(provider, subject)` is unique
 * forever: rows are never deleted — unlink is revocation (`status = unlinked`).
 */
@Entity({ name: "to_auth_identities" })
@Index("uq_to_auth_identities_provider_subject", ["provider", "subject"], { unique: true })
export class AuthIdentityEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index("ix_to_auth_identities_user_id")
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  @Column({ type: "text" })
  provider!: IdentityProvider;

  /** Google `sub`, Telegram numeric user id, Canton party id. */
  @Column({ type: "text" })
  subject!: string;

  /** Google only. */
  @Column({ type: "citext", nullable: true })
  email!: string | null;

  /** name, username, picture, hd — never tokens. */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  profile!: Record<string, unknown>;

  @Column({ type: "text", default: "active" })
  status!: IdentityStatus;

  @Column({ name: "verified_at", type: "timestamptz" })
  verifiedAt!: Date;

  @Column({ name: "last_used_at", type: "timestamptz", nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: "unlinked_at", type: "timestamptz", nullable: true })
  unlinkedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
