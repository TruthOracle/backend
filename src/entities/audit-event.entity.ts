import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { ActorType } from "../types";

/** Structured audit trail (ARCHITECTURE §5 `to_audit_events`); metadata is allow-listed per action. */
@Entity({ name: "to_audit_events" })
@Index("ix_to_audit_events_subject", ["subjectType", "subjectId"])
export class AuditEventEntity {
  /** bigserial — surfaces as a string. */
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ name: "actor_type", type: "text" })
  actorType!: ActorType;

  @Index("ix_to_audit_events_actor_user_id")
  @Column({ name: "actor_user_id", type: "uuid", nullable: true })
  actorUserId!: string | null;

  @Column({ name: "actor_session_id", type: "uuid", nullable: true })
  actorSessionId!: string | null;

  @Column({ type: "text" })
  action!: string;

  @Column({ name: "subject_type", type: "text" })
  subjectType!: string;

  @Column({ name: "subject_id", type: "text" })
  subjectId!: string;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @Column({ type: "text", nullable: true })
  ip!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
