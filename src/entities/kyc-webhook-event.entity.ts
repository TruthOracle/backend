import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** Stored-first webhook (ARCHITECTURE §9.2 `to_kyc_webhook_events`); payload purged after 30 days. */
@Entity({ name: "to_kyc_webhook_events" })
export class KycWebhookEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  provider!: string;

  /** sha256 of the raw body — idempotency key. */
  @Index("uq_to_kyc_webhook_events_event_key", { unique: true })
  @Column({ name: "event_key", type: "text" })
  eventKey!: string;

  @Column({ type: "text" })
  type!: string;

  @Column({ type: "jsonb", nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: "boolean", default: false })
  sandbox!: boolean;

  @Column({ name: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  @Column({ name: "received_at", type: "timestamptz" })
  receivedAt!: Date;

  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;

  @Column({ type: "integer", default: 0 })
  attempts!: number;

  /** Last time the durable consumer tried to apply the row (the sweep's re-arm cooldown counts from here). */
  @Column({ name: "last_attempt_at", type: "timestamptz", nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
