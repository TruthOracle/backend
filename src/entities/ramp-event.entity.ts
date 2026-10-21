import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Stored-first acquirer webhook (SPEC §3.3 `to_ramp_events`), the same lifecycle as
 * `to_kyc_webhook_events`: verified, stored (idempotent on `event_key`), acked, then applied by
 * RampProcessor — which re-reads the payment / payout from the provider. A failure backs off
 * (`next_attempt_at`) and never runs out of attempts; `dead_at` marks one that failed for too long.
 * Payload purged after 30 days.
 */
@Entity({ name: "to_ramp_events" })
@Index("ix_to_ramp_events_order", ["orderId"])
export class RampEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  provider!: string;

  @Index("uq_to_ramp_events_event_key", { unique: true })
  @Column({ name: "event_key", type: "text" })
  eventKey!: string;

  @Column({ type: "text" })
  type!: string;

  @Column({ type: "text" })
  kind!: string;

  /** The provider's payment / payout id the event is about. */
  @Column({ name: "object_id", type: "text" })
  objectId!: string;

  @Column({ name: "order_id", type: "uuid", nullable: true })
  orderId!: string | null;

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

  @Column({ name: "last_attempt_at", type: "timestamptz", nullable: true })
  lastAttemptAt!: Date | null;

  /** When the sweep may re-publish it (back-off 5 s → 10 min, no attempt cap; E-D1). */
  @Column({ name: "next_attempt_at", type: "timestamptz", nullable: true })
  nextAttemptAt!: Date | null;

  /** Set after RAMP_EVENT_DEAD_AFTER_HOURS of failure: nothing retries it; reconciliation shows it (H6). */
  @Column({ name: "dead_at", type: "timestamptz", nullable: true })
  deadAt!: Date | null;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  /** The last operator replay (C31): the dead-after window counts from here, not `received_at`. */
  @Column({ name: "replayed_at", type: "timestamptz", nullable: true })
  replayedAt!: Date | null;

  /** Closed without applying it by a four-eyes `ramp.event.close` (C31; `processed_at` set too). */
  @Column({ name: "closed_at", type: "timestamptz", nullable: true })
  closedAt!: Date | null;

  @Column({ name: "close_reason", type: "text", nullable: true })
  closeReason!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
