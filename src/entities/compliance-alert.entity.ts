import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { ComplianceAlertSeverity, ComplianceAlertStatus } from "../types";
import { moneyTransformer } from "../util/money";

/**
 * A monitoring alert (SPEC §3.4 S7a, §11.4–§11.6; ПВК pp.64–77): one per (user, rule, window).
 * `review` / `block` alerts linked to an order HOLD its value point until an AML decision clears
 * them (I10); `report` (the DFM special-form number) and `escalate` keep the hold. `due_at` = the
 * legal deadline in Belarusian business days; `rules_version` = RAMP_TM_RULES_VERSION and
 * `bv_byn` = the base value the thresholds were computed with. `order_id` has no foreign key (a
 * create-point alert names the order the create would make). `figures` never carry PII.
 */
@Entity({ name: "to_compliance_alerts" })
@Index("uq_to_compliance_alerts_window", ["userId", "rule", "windowKey"], { unique: true })
@Index("ix_to_compliance_alerts_status_due", ["status", "dueAt"])
@Index("ix_to_compliance_alerts_user", ["userId", "createdAt"])
@Index("ix_to_compliance_alerts_created", ["createdAt"])
export class ComplianceAlertEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ type: "text" })
  rule!: string;

  /** The value point (`onramp.create` …), or what raised it (`consent`, `identity`, `bank_account`, …). */
  @Column({ type: "text", nullable: true })
  point!: string | null;

  @Column({ type: "text" })
  severity!: ComplianceAlertSeverity;

  @Column({ name: "order_id", type: "uuid", nullable: true })
  orderId!: string | null;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  figures!: Record<string, unknown>;

  @Column({ name: "window_key", type: "text" })
  windowKey!: string;

  @Column({ type: "text", default: "open" })
  status!: ComplianceAlertStatus;

  @Column({ name: "due_at", type: "timestamptz", nullable: true })
  dueAt!: Date | null;

  @Column({ name: "rules_version", type: "text" })
  rulesVersion!: string;

  @Column({
    name: "bv_byn",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: moneyTransformer,
  })
  bvByn!: bigint | null;

  @Column({ name: "decided_by_user_id", type: "uuid", nullable: true })
  decidedByUserId!: string | null;

  @Column({ name: "decided_at", type: "timestamptz", nullable: true })
  decidedAt!: Date | null;

  @Column({ name: "decision_reason", type: "text", nullable: true })
  decisionReason!: string | null;

  @Column({ name: "report_ref", type: "text", nullable: true })
  reportRef!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
