import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * When an account was last screened and against which list versions (`to_screening_subjects`, an
 * S7b addition): an account without a row — or screened against older list versions, another KYC
 * verification or an older identity refresh — is screened before its next order (art.9-1).
 */
@Entity({ name: "to_screening_subjects" })
export class ScreeningSubjectEntity {
  @PrimaryColumn({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ name: "screened_at", type: "timestamptz" })
  screenedAt!: Date;

  @Column({ name: "run_id", type: "uuid" })
  runId!: string;

  @Column({ name: "list_ids", type: "uuid", array: true, default: () => "'{}'" })
  listIds!: string[];

  /** Whether a verified identity was screened (false: party ids only). */
  @Column({ type: "boolean" })
  identity!: boolean;

  /** The account's KYC verification when screened: a new one (first approval, re-verification) re-screens. */
  @Column({ name: "kyc_verification_id", type: "uuid", nullable: true })
  kycVerificationId!: string | null;

  /** The screened identity's `refreshed_at` (to_kyc_identities): a later refresh re-screens (S8). */
  @Column({ name: "identity_refreshed_at", type: "timestamptz", nullable: true })
  identityRefreshedAt!: Date | null;

  @Column({ type: "int", default: 0 })
  parties!: number;

  /** C27: the party ids screened (sorted): a newly linked party re-screens before the next order. */
  @Column({ name: "party_ids", type: "text", array: true, default: () => "'{}'" })
  partyIds!: string[];

  /** C13: the account's latest consent when screened (its declared principals): a newer one re-screens. */
  @Column({ name: "consent_id", type: "uuid", nullable: true })
  consentId!: string | null;

  /** C44: why the identity could not be read at the last full re-screen (null = it was read). */
  @Column({ name: "identity_error", type: "text", nullable: true })
  identityError!: string | null;

  @Column({ name: "identity_unreadable_at", type: "timestamptz", nullable: true })
  identityUnreadableAt!: Date | null;
}
