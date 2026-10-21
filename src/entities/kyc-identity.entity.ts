import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

export const KYC_RISK_LEVELS = ["low", "medium", "high"] as const;
export type KycRiskLevel = (typeof KYC_RISK_LEVELS)[number];

/**
 * The verified identity of an account (SPEC §3.4 S7a, §11.1; art.8 data, M11): refreshed from the
 * KYC provider on approval and when older than RAMP_KYC_REFRESH_DAYS. Everything personal is in
 * `identity_sealed` (sealed v2, AAD `kyc-id|<userId>`); the plain columns are what the rules and
 * the screening filter on. Vendor flags: null = the provider did not screen (never read as false).
 * Screening state is NOT kept here: S7b's subjects / hits / freezes are its one source (asked
 * through ComplianceFreezePort.ordersDenied / isFrozen). Never deleted (R4).
 */
@Entity({ name: "to_kyc_identities" })
export class KycIdentityEntity {
  @PrimaryColumn({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ type: "text" })
  provider!: string;

  @Column({ name: "applicant_id", type: "text" })
  applicantId!: string;

  @Column({ name: "level_name", type: "text", nullable: true })
  levelName!: string | null;

  /** When the KYC review approved the account (the verification's `reviewed_at`). */
  @Column({ name: "verified_at", type: "timestamptz", nullable: true })
  verifiedAt!: Date | null;

  /** The last successful read of the provider's applicant. */
  @Column({ name: "refreshed_at", type: "timestamptz" })
  refreshedAt!: Date;

  /** verified + 3 / 2 / 1 years by risk (ПВК pp.45–49): past it the account must re-verify. */
  @Column({ name: "refresh_due_at", type: "timestamptz", nullable: true })
  refreshDueAt!: Date | null;

  @Column({ name: "identity_sealed", type: "text" })
  identitySealed!: string;

  /** ISO 3166-1 alpha-2. */
  @Column({ type: "text", nullable: true })
  citizenship!: string | null;

  /** ISO 3166-1 alpha-2. */
  @Column({ name: "residence_country", type: "text", nullable: true })
  residenceCountry!: string | null;

  /** `YYYY-MM-DD`: the identity document's expiry (null = none known / termless). */
  @Column({ name: "doc_expires_at", type: "date", nullable: true })
  docExpiresAt!: string | null;

  @Column({ name: "risk_level", type: "text", default: "low" })
  riskLevel!: KycRiskLevel;

  @Column({ name: "vendor_pep", type: "boolean", nullable: true })
  vendorPep!: boolean | null;

  @Column({ name: "vendor_sanctions", type: "boolean", nullable: true })
  vendorSanctions!: boolean | null;

  @Column({ name: "vendor_adverse_media", type: "boolean", nullable: true })
  vendorAdverseMedia!: boolean | null;

  /** The provider's AML labels (`pep`, `sanctions`, `adverseMedia`, `crime`, …). */
  @Column({ name: "aml_labels", type: "text", array: true, default: () => "'{}'" })
  amlLabels!: string[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
