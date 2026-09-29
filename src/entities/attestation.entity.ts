import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

import type { MarketOutcome } from "../types";
import { bigintNumberTransformer } from "../util/ledger-values";

/** Every `OutcomeAttestation` (docs/INDEXER.md §3 `to_attestations`) — the resolution evidence a market was settled on. */
@Entity({ name: "to_attestations" })
@Index("ix_to_attestations_market", ["marketId"])
export class AttestationEntity {
  @PrimaryColumn({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  attester!: string;

  @Column({ type: "text" })
  admin!: string;

  @Column({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Column({ name: "source_uri", type: "text" })
  sourceUri!: string;

  @Column({ name: "fetched_at_sec", type: "bigint", transformer: bigintNumberTransformer })
  fetchedAtSec!: number;

  @Column({ type: "text" })
  outcome!: MarketOutcome;

  @Column({ name: "payload_hash", type: "text" })
  payloadHash!: string;

  @Column({ name: "source_signature", type: "text", nullable: true })
  sourceSignature!: string | null;

  @Column({ name: "response_excerpt", type: "text", nullable: true })
  responseExcerpt!: string | null;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Column({ name: "created_offset", type: "bigint", transformer: bigintNumberTransformer })
  createdOffset!: number;

  @Column({ name: "created_at_ledger", type: "timestamptz", nullable: true })
  createdAtLedger!: Date | null;

  @Column({
    name: "archived_offset",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  archivedOffset!: number | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
