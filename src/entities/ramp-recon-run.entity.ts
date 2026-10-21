import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { HaltScope, ReconStatus, ReconTrigger } from "../types";

/** One check as a run stores it; `unknownSince` carries an unreadable halting check across runs. */
export interface StoredReconCheck {
  name: string;
  status: ReconStatus;
  detail: string | null;
  figures: Record<string, unknown> | null;
  haltScopes: HaltScope[];
  /** First run (ISO) in the current streak of `unknown` for this check. */
  unknownSince?: string | null;
}

/**
 * A reconciliation run (SPEC §6.2, `to_ramp_recon_runs`). `trigger = sync` rows hold only the
 * token checks a token sync pass evaluated; every other trigger is a FULL run — what the gates read.
 */
@Entity({ name: "to_ramp_recon_runs" })
@Index("ix_to_ramp_recon_runs_trigger_started", ["trigger", "startedAt"])
@Index("ix_to_ramp_recon_runs_started", ["startedAt"])
export class RampReconRunEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  trigger!: ReconTrigger;

  @Column({ name: "started_at", type: "timestamptz", default: () => "now()" })
  startedAt!: Date;

  @Column({ name: "finished_at", type: "timestamptz", nullable: true })
  finishedAt!: Date | null;

  @Column({ type: "text", default: "unknown" })
  status!: ReconStatus;

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  checks!: StoredReconCheck[];

  /** The run set (or extended) a halt. */
  @Column({ type: "boolean", default: false })
  halted!: boolean;
}
