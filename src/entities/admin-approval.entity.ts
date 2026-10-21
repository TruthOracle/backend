import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import type { ApprovalStatus } from "../types";

/**
 * A four-eyes request (SPEC §6.5, `to_admin_approvals`): an action on a subject with its params,
 * their hash (what a signed decision commits to) and the precondition snapshot taken at request
 * time — execution needs a FRESH snapshot equal to it. Requester and decider are recorded as user,
 * party and PERSON (four-eyes compares persons). One `pending` row per (action, subject).
 */
@Entity({ name: "to_admin_approvals" })
@Index("ix_to_admin_approvals_status", ["status", "requestedAt"])
@Index("ix_to_admin_approvals_subject", ["subjectType", "subjectId"])
export class AdminApprovalEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  action!: string;

  @Column({ name: "subject_type", type: "text" })
  subjectType!: string;

  @Column({ name: "subject_id", type: "text" })
  subjectId!: string;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  params!: Record<string, unknown>;

  /** sha256 hex over the canonical {action, subjectType, subjectId, params}. */
  @Column({ name: "params_hash", type: "text" })
  paramsHash!: string;

  @Column({ type: "jsonb", nullable: true })
  precondition!: Record<string, unknown> | null;

  @Column({ type: "text" })
  reason!: string;

  @Column({ type: "text", default: "pending" })
  status!: ApprovalStatus;

  @Column({ name: "requested_by_user_id", type: "uuid" })
  requestedByUserId!: string;

  @Column({ name: "requested_by_party", type: "text" })
  requestedByParty!: string;

  @Column({ name: "requested_by_person", type: "text" })
  requestedByPerson!: string;

  @Column({ name: "requested_at", type: "timestamptz", default: () => "now()" })
  requestedAt!: Date;

  @Column({ name: "decided_by_user_id", type: "uuid", nullable: true })
  decidedByUserId!: string | null;

  @Column({ name: "decided_by_party", type: "text", nullable: true })
  decidedByParty!: string | null;

  @Column({ name: "decided_by_person", type: "text", nullable: true })
  decidedByPerson!: string | null;

  @Column({ name: "decided_at", type: "timestamptz", nullable: true })
  decidedAt!: Date | null;

  @Column({ name: "decision_reason", type: "text", nullable: true })
  decisionReason!: string | null;

  /** The wallet signature over `truthoracle-approval:<id>:<params_hash>:<approve|reject>` (when required). */
  @Column({ name: "decision_signature", type: "text", nullable: true })
  decisionSignature!: string | null;

  @Column({ name: "executed_at", type: "timestamptz", nullable: true })
  executedAt!: Date | null;

  @Column({ type: "jsonb", nullable: true })
  result!: unknown;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  /** Executed at request time by one operator (RAMP_DUAL_CONTROL=false, or the action's singleControl). */
  @Column({ name: "single_control", type: "boolean", default: false })
  singleControl!: boolean;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
