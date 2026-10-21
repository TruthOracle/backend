import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * One acceptance of the ramp terms (SPEC §3.4 S7a, §11.2, B4; ПВК p.31): APPEND-ONLY (a trigger
 * refuses DELETE and every UPDATE but a re-seal). Who, when, from where, the terms version, whether
 * the person acts for themselves (else the principal, sealed) and the PEP self-declaration (detail
 * sealed). AAD `ramp-consent-principal|<userId>|<id>` / `ramp-consent-pep|<userId>|<id>`. Every order
 * stores the consent it was made under (`to_ramp_orders.consent_id`).
 */
@Entity({ name: "to_ramp_consents" })
@Index("ix_to_ramp_consents_user_terms", ["userId", "termsVersion", "acceptedAt"])
export class RampConsentEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ name: "terms_version", type: "text" })
  termsVersion!: string;

  @Column({ name: "accepted_at", type: "timestamptz", default: () => "now()" })
  acceptedAt!: Date;

  @Column({ type: "text", nullable: true })
  ip!: string | null;

  @Column({ name: "user_agent", type: "text", nullable: true })
  userAgent!: string | null;

  @Column({ name: "acts_for_self", type: "boolean" })
  actsForSelf!: boolean;

  @Column({ name: "principal_sealed", type: "text", nullable: true })
  principalSealed!: string | null;

  @Column({ name: "pep_declared", type: "boolean" })
  pepDeclared!: boolean;

  @Column({ name: "pep_detail_sealed", type: "text", nullable: true })
  pepDetailSealed!: string | null;
}
