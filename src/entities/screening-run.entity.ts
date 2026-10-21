import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { ScreeningRunScope, ScreeningRunStatus, ScreeningRunTrigger } from "../types";

/**
 * One re-screen (`to_screening_runs`, an S7b addition): `full` = every account with a verified
 * identity or a party (dormant ones included) against the latest version of every list, on import
 * and every RAMP_RESCREEN_DAYS — the record that every client was screened in time (ПВК p.57);
 * `user` = one account screened before its first order (art.9-1: screen before contracting).
 * `partial` = some identities could not be read (they are retried; the run does not count as full).
 */
@Entity({ name: "to_screening_runs" })
@Index("ix_to_screening_runs_scope_started", ["scope", "startedAt"])
export class ScreeningRunEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  trigger!: ScreeningRunTrigger;

  @Column({ type: "text" })
  scope!: ScreeningRunScope;

  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId!: string | null;

  /** The list versions screened against. */
  @Column({ name: "list_ids", type: "uuid", array: true, default: () => "'{}'" })
  listIds!: string[];

  @Column({ type: "text", default: "running" })
  status!: ScreeningRunStatus;

  @Column({ name: "started_at", type: "timestamptz", default: () => "now()" })
  startedAt!: Date;

  @Column({ name: "finished_at", type: "timestamptz", nullable: true })
  finishedAt!: Date | null;

  @Column({ name: "started_by_user_id", type: "uuid", nullable: true })
  startedByUserId!: string | null;

  /** Accounts screened, identities among them, party ids checked, NEW hits, unreadable identities. */
  @Column({ type: "int", default: 0 })
  subjects!: number;

  @Column({ type: "int", default: 0 })
  identities!: number;

  @Column({ type: "int", default: 0 })
  parties!: number;

  @Column({ type: "int", default: 0 })
  hits!: number;

  @Column({ type: "int", default: 0 })
  failures!: number;

  /** C44: accounts whose identity could not be read (their parties screened; not a failure). */
  @Column({ type: "int", default: 0 })
  unreadable!: number;

  @Column({ type: "text", nullable: true })
  error!: string | null;
}
