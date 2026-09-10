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

import type { WalletKind, WalletStatus } from "../types";
import { moneyTransformer } from "../util/money";
import { UserEntity } from "./user.entity";

/**
 * A linked Canton wallet (ARCHITECTURE §5 `to_wallets`). A party is bound to its first account
 * forever (active or revoked); relinking reactivates the row and never inserts.
 */
@Entity({ name: "to_wallets" })
@Index("uq_to_wallets_primary_per_user", ["userId"], {
  unique: true,
  where: `"is_primary" = true AND "status" = 'active'`,
})
export class WalletEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index("ix_to_wallets_user_id")
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  @Column({ type: "text", default: "canton" })
  chain!: "canton";

  @Column({ type: "text" })
  kind!: WalletKind;

  @Index("uq_to_wallets_party_id", { unique: true })
  @Column({ name: "party_id", type: "text" })
  partyId!: string;

  /** base64 raw Ed25519, verified against the party fingerprint at link time. */
  @Column({ name: "public_key", type: "text" })
  publicKey!: string;

  @Column({ type: "text", nullable: true })
  label!: string | null;

  @Column({ name: "is_primary", type: "boolean", default: false })
  isPrimary!: boolean;

  @Column({ type: "text", default: "active" })
  status!: WalletStatus;

  /** Immutable seed at link time = the party's own on-ledger `UserWallet.depositedCC` (0 if none). */
  @Column({ name: "legacy_credited_cc", type: "numeric", precision: 38, scale: 10, default: 0, transformer: moneyTransformer })
  legacyCreditedCC!: bigint;

  /** In-app credits attributed to this wallet by the backend since link. */
  @Column({ name: "credited_cc", type: "numeric", precision: 38, scale: 10, default: 0, transformer: moneyTransformer })
  creditedCC!: bigint;

  @Column({ name: "verified_at", type: "timestamptz" })
  verifiedAt!: Date;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
