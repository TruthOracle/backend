import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

import type { HaltScope } from "../types";

/** The red checks behind an automatic halt, as stored (`name` decides whether re-mints wait). */
export interface StoredFailingCheck {
  name: string;
  detail: string | null;
}

/**
 * The ramp's runtime halts (SPEC §6.1, `to_ramp_controls`): one row, key `ramp`; no row = nothing
 * halted. Scopes `orders` (no new orders), `mints` (startMint waits; a re-mint only when a token-
 * integrity check is among `failing_checks`), `payouts` (MarkPaid, card payouts, batch approval
 * and the first file download). Set at once by an `ops` operator or automatically by a red check;
 * cleared only by the four-eyes `ramp.controls.resume`.
 */
@Entity({ name: "to_ramp_controls" })
export class RampControlEntity {
  @PrimaryColumn({ type: "text" })
  key!: string;

  @Column({ name: "halted_scopes", type: "text", array: true, default: () => "'{}'" })
  haltedScopes!: HaltScope[];

  @Column({ type: "text", nullable: true })
  reason!: string | null;

  @Column({ type: "text", nullable: true })
  source!: "admin" | "auto" | null;

  @Column({ name: "failing_checks", type: "jsonb", nullable: true })
  failingChecks!: StoredFailingCheck[] | null;

  /** When the halt (any scope) began; kept while scopes are added. */
  @Column({ type: "timestamptz", nullable: true })
  since!: Date | null;

  @Column({ name: "set_by_user_id", type: "uuid", nullable: true })
  setByUserId!: string | null;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
