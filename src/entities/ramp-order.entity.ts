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

import type {
  RampDirection,
  RampMethod,
  RampOperatorSnapshot,
  RampOrderStatus,
  RampPaymentNext,
  RampPayoutRail,
  RampStep,
} from "../types";
import { moneyTransformer } from "../util/money";
import { RampPaymentMethodEntity } from "./ramp-payment-method.entity";
import { UserEntity } from "./user.entity";

/**
 * One fiat ramp order (SPEC §3.1 `to_ramp_orders`), on- or off-ramp. Every external side
 * effect's idempotency key is a column here, written by compare-and-set BEFORE the call
 * (`mint_command_id`, `burn_command_id`, `remint_command_id` — each with its `to_token_commands`
 * row in the same transaction — and the provider ids), so a crash resumes by asking whether the
 * recorded key landed. Every write is `… WHERE status IN (…) AND version = v` and bumps `version`
 * (I6). `fiat_amount` / `token_amount` / `fee_amount` are 1e-10 units; 1 BYN = 1 unit of the ramp
 * instrument; the migration CHECKs F = N + f (on) and T = P + f (off).
 */
@Entity({ name: "to_ramp_orders" })
@Index("ix_to_ramp_orders_user", ["userId", "createdAt"])
@Index("ix_to_ramp_orders_status", ["status"])
@Index("uq_to_ramp_orders_idempotency", ["userId", "idempotencyKey"], { unique: true })
// At most one order per account, direction and method waiting on the user (SPEC §3.1): the migration's
// expression index `uq_to_ramp_orders_open (user_id, direction, coalesce(method, ''))`.
@Index("uq_to_ramp_orders_payout_reference", ["payoutReference"], { unique: true })
@Index("uq_to_ramp_orders_provider_payment_id", ["provider", "providerPaymentId"], { unique: true })
@Index("uq_to_ramp_orders_provider_payout_id", ["provider", "providerPayoutId"], { unique: true })
@Index("uq_to_ramp_orders_provider_refund_id", ["provider", "providerRefundId"], { unique: true })
export class RampOrderEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "user_id" })
  user?: UserEntity;

  @Column({ type: "text" })
  direction!: RampDirection;

  @Column({ type: "text" })
  status!: RampOrderStatus;

  /** Set with `needs_review` (and only then): why; `details.reviewFrom` says which status it left. */
  @Column({ name: "review_step", type: "text", nullable: true })
  reviewStep!: RampStep | null;

  /** +1 on every write; the compare-and-set of I6 and the approvals' snapshot (S4). */
  @Column({ type: "integer", default: 0 })
  version!: number;

  @Column({ type: "text" })
  provider!: string;

  @Column({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  /** The account's primary party when the order was created: the wallet credited / debited. */
  @Column({ name: "party_id", type: "text" })
  partyId!: string;

  @Column({ name: "fiat_currency", type: "text" })
  fiatCurrency!: string;

  @Column({
    name: "fiat_amount",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  fiatAmount!: bigint;

  @Column({
    name: "token_amount",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  tokenAmount!: bigint;

  @Column({
    name: "fee_amount",
    type: "numeric",
    precision: 38,
    scale: 10,
    transformer: moneyTransformer,
  })
  feeAmount!: bigint;

  @Column({ name: "payment_method_id", type: "uuid", nullable: true })
  paymentMethodId!: string | null;

  @ManyToOne(() => RampPaymentMethodEntity, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "payment_method_id" })
  paymentMethod?: RampPaymentMethodEntity;

  /** The client's `Idempotency-Key` header (unique per user): a retried POST answers the same order. */
  @Column({ name: "idempotency_key", type: "text" })
  idempotencyKey!: string;

  /** sha256 of the canonical request (`rampRequestHash`): the same key with another request is a 409 (E-D9, L1). */
  @Column({ name: "request_hash", type: "text" })
  requestHash!: string;

  @Column({ name: "provider_payment_id", type: "text", nullable: true })
  providerPaymentId!: string | null;

  @Column({ name: "provider_payout_id", type: "text", nullable: true })
  providerPayoutId!: string | null;

  @Column({ name: "provider_refund_id", type: "text", nullable: true })
  providerRefundId!: string | null;

  @Column({ name: "checkout_url", type: "text", nullable: true })
  checkoutUrl!: string | null;

  /** Checkout (on) / signing (off) deadline. */
  @Column({ name: "expires_at", type: "timestamptz", nullable: true })
  expiresAt!: Date | null;

  /** C: what the acquirer captured (C ≠ F is refund-only); null until the first capture is seen. */
  @Column({
    name: "captured_amount",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: moneyTransformer,
  })
  capturedAmount!: bigint | null;

  /** The first time a capture was observed (the card's exposure window starts here). */
  @Column({ name: "captured_at", type: "timestamptz", nullable: true })
  capturedAt!: Date | null;

  /** Σ provider refunds of THIS on-ramp's capture (our refund, and S5's card cash-out parts). */
  @Column({
    name: "refunded_amount",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  refundedAmount!: bigint;

  @Index("uq_to_ramp_orders_mint_command_id", { unique: true })
  @Column({ name: "mint_command_id", type: "text", nullable: true })
  mintCommandId!: string | null;

  /** DepositService's write-ahead id for the credit (`mint-credit-<h>`). */
  @Column({ name: "credit_command_id", type: "text", nullable: true })
  creditCommandId!: string | null;

  @Index("uq_to_ramp_orders_pending_payout_cid", { unique: true })
  @Column({ name: "pending_payout_cid", type: "text", nullable: true })
  pendingPayoutCid!: string | null;

  @Index("uq_to_ramp_orders_burn_command_id", { unique: true })
  @Column({ name: "burn_command_id", type: "text", nullable: true })
  burnCommandId!: string | null;

  @Index("uq_to_ramp_orders_remint_command_id", { unique: true })
  @Column({ name: "remint_command_id", type: "text", nullable: true })
  remintCommandId!: string | null;

  @Column({ name: "remint_credit_command_id", type: "text", nullable: true })
  remintCreditCommandId!: string | null;

  // ── S5 (SPEC §3.1, §9) ──

  /** On-ramp: how it is paid (null on an off-ramp; CHECK). */
  @Column({ type: "text", nullable: true })
  method!: RampMethod | null;

  /** The validated ERIP `next` (X15); shown only while `awaiting_payment`. A redirect is `checkout_url`. */
  @Column({ name: "payment_instructions", type: "jsonb", nullable: true })
  paymentInstructions!: Extract<RampPaymentNext, { kind: "erip" }> | null;

  /** Off-ramp: where the fiat goes (null on an on-ramp; CHECK). */
  @Column({ name: "payout_rail", type: "text", nullable: true })
  payoutRail!: RampPayoutRail | null;

  /** The bank destination (S6 adds the foreign key). */
  @Column({ name: "bank_account_id", type: "uuid", nullable: true })
  bankAccountId!: string | null;

  /** The payout batch the order is in now (S6). */
  @Column({ name: "payout_batch_id", type: "uuid", nullable: true })
  payoutBatchId!: string | null;

  /** `TO` + 12 digits (util/payout-reference.ts): ERIP account number, bank purpose, refund description. */
  @Column({ name: "payout_reference", type: "text" })
  payoutReference!: string;

  /** The operator of record and terms version the order was made under (R1). */
  @Column({ type: "jsonb" })
  operator!: RampOperatorSnapshot;

  /** The consent row the order was created under (S7a adds the foreign key; B4). */
  @Column({ name: "consent_id", type: "uuid", nullable: true })
  consentId!: string | null;

  /** Compliance decisions by point: `{point: {decision, rules[], alertIds[], at}}` (SPEC §11.5). */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  risk!: Record<string, unknown>;

  /** Attempts of the current step; reset when a step completes, capped by RAMP_MAX_ATTEMPTS. */
  @Column({ type: "integer", default: 0 })
  attempts!: number;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError!: string | null;

  /**
   * Facts worth keeping (SPEC §3.1): `timeline [{status, at, step?}]` (appended by every
   * transition), `reviewFrom` / `reviewReason`, `threeDs`, `card`, `failureCode`, `payment {…}`
   * (capture facts, M11), `cardPayout {mode, parts[]}` (card cash-out), `hold {reason}` (a deferred
   * MarkPaid or payout part), `complianceHold {point}` (the port put it in review), `chargeback
   * {state, amount, at}`, `cbburnCommandId`.
   */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  details!: Record<string, unknown>;

  /** Set by every transition: what "stuck" is measured from (polls and attempts touch `updated_at`). */
  @Column({ name: "status_changed_at", type: "timestamptz", default: () => "now()" })
  statusChangedAt!: Date;

  @Column({ name: "last_polled_at", type: "timestamptz", nullable: true })
  lastPolledAt!: Date | null;

  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
