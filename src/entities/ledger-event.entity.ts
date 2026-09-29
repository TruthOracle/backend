import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { bigintNumberTransformer } from "../util/ledger-values";

/**
 * Every created / exercised event of the TruthOracle package the indexer saw, verbatim
 * (docs/INDEXER.md §3 `to_ledger_events`). The projections are derived from these rows and can
 * be rebuilt from them without re-reading the ledger; `event_id` (`<updateId>:<nodeId>`, or
 * `acs:<contractId>` for a bootstrap snapshot row) makes a replayed transaction a no-op.
 */
@Entity({ name: "to_ledger_events" })
@Index("ix_to_ledger_events_offset_node", ["offset", "nodeId"])
@Index("ix_to_ledger_events_entity_offset", ["entity", "offset"])
export class LedgerEventEntity {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Index("uq_to_ledger_events_event_id", { unique: true })
  @Column({ name: "event_id", type: "text" })
  eventId!: string;

  @Column({ type: "bigint", transformer: bigintNumberTransformer })
  offset!: number;

  @Column({ name: "node_id", type: "integer" })
  nodeId!: number;

  @Index("ix_to_ledger_events_update_id")
  @Column({ name: "update_id", type: "text" })
  updateId!: string;

  @Column({ type: "text" })
  kind!: "created" | "exercised";

  @Column({ name: "package_name", type: "text" })
  packageName!: string;

  @Column({ type: "text" })
  module!: string;

  @Column({ type: "text" })
  entity!: string;

  @Column({ name: "template_id", type: "text" })
  templateId!: string;

  @Index("ix_to_ledger_events_contract_id")
  @Column({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text", nullable: true })
  choice!: string | null;

  @Column({ type: "boolean", nullable: true })
  consuming!: boolean | null;

  @Column({ name: "acting_parties", type: "jsonb", default: () => "'[]'::jsonb" })
  actingParties!: string[];

  @Column({ name: "witness_parties", type: "jsonb", default: () => "'[]'::jsonb" })
  witnessParties!: string[];

  @Column({ type: "jsonb", nullable: true })
  signatories!: string[] | null;

  @Column({ type: "jsonb", nullable: true })
  observers!: string[] | null;

  /** `createArgument` for a create, `choiceArgument` for an exercise. */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;

  @Column({ type: "jsonb", nullable: true })
  result!: unknown;

  @Column({ name: "parent_node_id", type: "integer", nullable: true })
  parentNodeId!: number | null;

  @Column({ name: "root_node_id", type: "integer", nullable: true })
  rootNodeId!: number | null;

  @Column({ name: "last_descendant_node_id", type: "integer", nullable: true })
  lastDescendantNodeId!: number | null;

  @Column({ name: "effective_at", type: "timestamptz" })
  effectiveAt!: Date;

  @Column({ name: "record_time", type: "timestamptz", nullable: true })
  recordTime!: Date | null;

  @Column({ name: "command_id", type: "text", nullable: true })
  commandId!: string | null;

  @Column({ name: "workflow_id", type: "text", nullable: true })
  workflowId!: string | null;

  @Column({ name: "synchronizer_id", type: "text", nullable: true })
  synchronizerId!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
