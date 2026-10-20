import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { moneyTransformer } from "../util/money";
import type { TokenCommandKind } from "./token-command.entity";

/**
 * The mirror of token-app's `/data/admin/mints|burns` (docs/RAMP.md §3.4, §7): every record the
 * token sync has paged, kept forever, never updated. A record is identified by
 * `(kind, coalesce(update_id, ''), coalesce(command_id, ''), party_id, amount)` — a unique
 * EXPRESSION index of the migration (TypeORM cannot declare it), so a record without a command id
 * or update id is not re-inserted on every pass (#14). Records carry the token id only, no admin.
 */
@Entity({ name: "to_token_app_records" })
@Index("ix_to_token_app_records_command", ["commandId"])
@Index("ix_to_token_app_records_instrument", ["instrumentId", "kind"])
export class TokenAppRecordEntity {
  @PrimaryGeneratedColumn("increment", { type: "bigint" })
  id!: string;

  @Column({ type: "text" })
  kind!: TokenCommandKind;

  @Column({ name: "command_id", type: "text", nullable: true })
  commandId!: string | null;

  @Column({ name: "update_id", type: "text", nullable: true })
  updateId!: string | null;

  @Column({ name: "instrument_id", type: "text" })
  instrumentId!: string;

  @Column({ name: "party_id", type: "text" })
  partyId!: string;

  @Column({ type: "numeric", precision: 38, scale: 10, transformer: moneyTransformer })
  amount!: bigint;

  /** token-app's `created_at`: when the confirmed transaction was recorded. */
  @Column({ name: "record_created_at", type: "timestamptz", nullable: true })
  recordCreatedAt!: Date | null;

  @Column({ name: "first_seen_at", type: "timestamptz", default: () => "now()" })
  firstSeenAt!: Date;
}
