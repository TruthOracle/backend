import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

import { moneyTransformer } from "../util/money";

export const TOKEN_COMMAND_KINDS = ["mint", "burn"] as const;
export type TokenCommandKind = (typeof TOKEN_COMMAND_KINDS)[number];

/** Who asked for the command: the ramp, an operator, the rewards float, a faucet, `npm run tokenapp:check`, or an adopted pre-existing record. */
export const TOKEN_COMMAND_SOURCES = [
  "ramp",
  "admin",
  "rewards",
  "faucet",
  "check",
  "legacy",
] as const;
export type TokenCommandSource = (typeof TOKEN_COMMAND_SOURCES)[number];

export const TOKEN_COMMAND_STATUSES = [
  "pending",
  "submitted",
  "unknown",
  "recorded",
  "rejected",
  "mismatch",
  "abandoned",
] as const;
export type TokenCommandStatus = (typeof TOKEN_COMMAND_STATUSES)[number];

/** "May land": written but not sent (or sent with no definitive answer), accepted, or the answer was lost. */
export const TOKEN_COMMAND_UNRESOLVED: readonly TokenCommandStatus[] = [
  "pending",
  "submitted",
  "unknown",
];
/** "Never lands": refused before it ran, or abandoned after the participant's dedup window. */
export const TOKEN_COMMAND_DEFINITIVE_NO: readonly TokenCommandStatus[] = ["rejected", "abandoned"];

export function isUnresolved(status: TokenCommandStatus): boolean {
  return TOKEN_COMMAND_UNRESOLVED.includes(status);
}

export function isDefinitiveNo(status: TokenCommandStatus): boolean {
  return TOKEN_COMMAND_DEFINITIVE_NO.includes(status);
}

/**
 * The write-ahead ledger of every token-app mint / burn (docs/RAMP.md §3.4, §7). The row is
 * written BEFORE the POST — inside the caller's transaction when there is one (the ramp's order
 * CAS) — so a crash anywhere leaves a row that says what may have been sent. `command_id` is the
 * token-app idempotency key; `amount` is whole at the instrument's decimals. The token sync
 * matches token-app's records to rows (`recorded` / `mismatch`); nothing re-sends on its own.
 * `resolved_by` names the compensating command (or approval) of a `mismatch`.
 */
@Entity({ name: "to_token_commands" })
@Index("ix_to_token_commands_status", ["status"])
@Index("ix_to_token_commands_instrument", ["instrumentId", "kind", "status"])
@Index("ix_to_token_commands_ref", ["ref"])
export class TokenCommandEntity {
  @PrimaryColumn({ name: "command_id", type: "text" })
  commandId!: string;

  @Column({ type: "text" })
  kind!: TokenCommandKind;

  @Column({ name: "instrument_admin", type: "text" })
  instrumentAdmin!: string;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  /** Minted to / burned from. */
  @Column({ name: "party_id", type: "text" })
  partyId!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  @Column({ type: "text" })
  source!: TokenCommandSource;

  /** What it belongs to: `ramp:<orderId>`-style refs of the caller, `credit:<userId>` (admin mint-and-credit), `adopted:<approvalId>`. */
  @Column({ type: "text", nullable: true })
  ref!: string | null;

  @Column({ type: "text", default: "pending" })
  status!: TokenCommandStatus;

  /** POSTs made under this id (written before each POST). */
  @Column({ type: "integer", default: 0 })
  attempts!: number;

  @Column({ name: "last_post_at", type: "timestamptz", nullable: true })
  lastPostAt!: Date | null;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError!: string | null;

  @Column({ name: "last_http_status", type: "integer", nullable: true })
  lastHttpStatus!: number | null;

  @Column({ name: "update_id", type: "text", nullable: true })
  updateId!: string | null;

  @Column({
    name: "recorded_amount",
    type: "numeric",
    precision: 38,
    scale: 10,
    nullable: true,
    transformer: moneyTransformer,
  })
  recordedAmount!: bigint | null;

  /** When token-app's record says it landed (the record's `created_at`, else when we first saw it). */
  @Column({ name: "recorded_at", type: "timestamptz", nullable: true })
  recordedAt!: Date | null;

  @Column({ name: "resolved_by", type: "text", nullable: true })
  resolvedBy!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
