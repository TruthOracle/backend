import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { RewardRuleKind } from "../types";

/**
 * One reward rule the RewardsProcessor applies to new wallet entries / market events
 * (docs/TOKENS.md §4.6 `to_reward_rules`). One row per kind: `RewardsService.seedRules` creates
 * the three automatic rules once at boot with their documented default `params` (decimal strings,
 * never numbers) — disabled, except on `APP_ENV=dev` where they come up enabled — and an operator
 * enables or re-parameterises them through `PUT /admin/rewards/rules/:id`.
 */
@Entity({ name: "to_reward_rules" })
@Index("uq_to_reward_rules_kind", ["kind"], { unique: true })
export class RewardRuleEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  kind!: RewardRuleKind;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  params!: Record<string, string>;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
