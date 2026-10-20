import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { ScreeningEntryKind } from "../types";

/**
 * One entry of an imported list version (`to_screening_entries`): its name variants as delivered,
 * their name-fold keys (`util/name-fold.ts`; be / ru Cyrillic and every Latin transliteration),
 * the birth date (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`) and identifiers (documents, or the wallet
 * addresses / party ids of the Decree No. 48 register).
 */
@Entity({ name: "to_screening_entries" })
@Index("ix_to_screening_entries_list", ["listId", "line"])
export class ScreeningEntryEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "list_id", type: "uuid" })
  listId!: string;

  /** The CSV record number (1 = the first record after the header). */
  @Column({ type: "int" })
  line!: number;

  @Column({ type: "text" })
  kind!: ScreeningEntryKind;

  @Column({ type: "text", array: true, default: () => "'{}'" })
  names!: string[];

  @Column({ name: "name_keys", type: "text", array: true, default: () => "'{}'" })
  nameKeys!: string[];

  @Column({ name: "birth_date", type: "text", nullable: true })
  birthDate!: string | null;

  @Column({ type: "text", array: true, default: () => "'{}'" })
  ids!: string[];
}
