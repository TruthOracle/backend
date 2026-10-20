import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { ScreeningListName } from "../types";

/**
 * One imported version of a screening list (SPEC §3.4 S7b, §11.6; B1; `to_screening_lists`): the
 * Belarusian list of persons involved in terrorist activity (`by_terror`), the UN Security Council
 * list (`un`), the Decree No. 48 register of wallet addresses (`decree48`) and any foreign list
 * (`foreign`: a hit denies new orders but never freezes). Matching always uses the LATEST version
 * of each list; older versions stay as the record of what was screened (R4).
 */
@Entity({ name: "to_screening_lists" })
@Index("uq_to_screening_lists_version", ["list", "version"], { unique: true })
@Index("ix_to_screening_lists_latest", ["list", "importedAt"])
export class ScreeningListEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  list!: ScreeningListName;

  @Column({ type: "text" })
  version!: string;

  /** When the list reached the operator (the SB Secretariat's delivery): the 1-working-day clock starts here. */
  @Column({ name: "delivered_at", type: "timestamptz" })
  deliveredAt!: Date;

  @Column({ name: "imported_at", type: "timestamptz", default: () => "now()" })
  importedAt!: Date;

  @Column({ name: "imported_by_user_id", type: "uuid", nullable: true })
  importedByUserId!: string | null;

  @Column({ name: "imported_by_person", type: "text", nullable: true })
  importedByPerson!: string | null;

  @Column({ type: "text", default: "utf-8" })
  charset!: string;

  /** sha256 of the uploaded bytes. */
  @Column({ type: "text" })
  sha256!: string;

  @Column({ name: "entry_count", type: "int" })
  entryCount!: number;
}
