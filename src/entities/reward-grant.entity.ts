import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";

import type { RewardGrantStatus, RewardRuleKind } from "../types";
import { moneyTransformer } from "../util/money";
import { RewardRuleEntity } from "./reward-rule.entity";
import { UserEntity } from "./user.entity";

/**
 * One rewards grant (docs/TOKENS.md §4.6 `to_reward_grants`): computed off-ledger from the index,
 * credited on-ledger with `UserWallet.Grant { amount, ref, reason }` on the user's rewards wallet.
 * `source_event_id` (unique) makes a rule's grant idempotent per source entry; `ref`
 * (`reward:<id>`, unique) is what `UserWallet.creditRefs` carries once credited, so the confirm
 * pass can prove the grant landed the same way deposits are proven.
 */
@Entity({ name: "to_reward_grants" })
@Index("ix_to_reward_grants_user", ["userId"])
@Index("ix_to_reward_grants_party", ["party"])
@Index("ix_to_reward_grants_status", ["status"])
export class RewardGrantEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** The account the party belonged to when the grant was computed; null for a manual grant to an unlinked party. */
  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  /** The party whose rewards wallet is credited (the account's primary party). */
  @Column({ type: "text" })
  party!: string;

  @Column({ name: "rule_id", type: "uuid", nullable: true })
  ruleId!: string | null;

  @ManyToOne(() => RewardRuleEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "rule_id" })
  rule?: RewardRuleEntity;

  @Column({ type: "text" })
  kind!: RewardRuleKind;

  /** The `to_wallet_entries.event_id` / `to_market_events.event_id` the grant was earned on; null for `manual`. */
  @Index("uq_to_reward_grants_source_event_id", { unique: true })
  @Column({ name: "source_event_id", type: "text", nullable: true })
  sourceEventId!: string | null;

  @Column({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  @Column({ type: "text" })
  reason!: string;

  @Column({ type: "text", default: "queued" })
  status!: RewardGrantStatus;

  /** The `external/submit` command id of the `Grant` exercise; unique so a retry never submits twice. */
  @Index("uq_to_reward_grants_command_id", { unique: true })
  @Column({ name: "command_id", type: "text", nullable: true })
  commandId!: string | null;

  /** `reward:<id>` — the `ref` the Daml `Grant` appends to `creditRefs`. */
  @Index("uq_to_reward_grants_ref", { unique: true })
  @Column({ type: "text" })
  ref!: string;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  /** When the `Grant` was (last) submitted; the confirm pass's grace period counts from here, like a deposit credit's. */
  @Column({ name: "submitted_at", type: "timestamptz", nullable: true })
  submittedAt!: Date | null;

  @Column({ name: "credited_at", type: "timestamptz", nullable: true })
  creditedAt!: Date | null;
}
