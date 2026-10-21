import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { KycVerificationEntity } from "../entities/kyc-verification.entity";
import {
  KYC_PROVIDER,
  type ApplicantNameForm,
  type ApplicantSummary,
  type KycProvider,
} from "../types";
import { toAlpha2 } from "../util/iso-country";
import { sealAad } from "../util/sealed";
import { UserService } from "./user.service";

/**
 * The verified identity of an account (SPEC §9.4, §11.1; owner: S7a). The ramp reads it for the
 * OCT recipient name (S5), bank beneficiary names (S6), the screening (S7b) and the compliance
 * rules (S7a). Bound implementation: `KycIdentityService` — the stored, sealed identity
 * (`to_kyc_identities`), refreshed from the provider on KYC approval and when older than
 * RAMP_KYC_REFRESH_DAYS. Unbound default (unit tests, tooling): read the provider's applicant LIVE.
 * An unreachable provider throws (fail closed, I7); an account without an approved verification
 * answers null.
 */

/** Which form of the name (Belarusian ID documents carry be + ru Cyrillic and Latin, M2). */
export type NameScript = "be" | "ru" | "lat";

export interface VerifiedName {
  script: NameScript;
  last: string;
  first: string;
  /** Patronymic, when the document has one (foreign residents have none). */
  middle?: string | null;
}

/** The identity document (art.8 / ПВК p.54); dates `YYYY-MM-DD`, country ISO alpha-2. */
export interface VerifiedDocument {
  type: string;
  country: string | null;
  number: string | null;
  personalNumber: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
}

export interface VerifiedAddress {
  country: string | null;
  region: string | null;
  city: string | null;
  line: string | null;
}

export interface VerifiedIdentity {
  userId: string;
  names: VerifiedName[];
  /** `YYYY-MM-DD`. */
  birthDate: string | null;
  /** ISO 3166-1 alpha-2. */
  citizenship: string | null;
  /** ISO 3166-1 alpha-2. */
  residenceCountry: string | null;
  /** The KYC level the verification passed. */
  level: string | null;
  verifiedAt: Date | null;
  /** Vendor screening flags; null = unknown (never read as false). */
  vendorPep: boolean | null;
  vendorSanctions: boolean | null;
  vendorAdverseMedia: boolean | null;
  // ── the rest of the art.8 data (S7a; absent from the live default where unknown) ──
  birthPlace?: string | null;
  address?: VerifiedAddress | null;
  doc?: VerifiedDocument | null;
  riskLevel?: "low" | "medium" | "high";
  /** Past it the account must re-verify (ПВК pp.45–49). */
  refreshDueAt?: Date | null;
  amlLabels?: string[];
  refreshedAt?: Date | null;
}

export interface KycIdentityImpl {
  get(userId: string): Promise<VerifiedIdentity | null>;
  /**
   * The identity as stored, without a provider refresh (bulk re-screens of dormant accounts, S7b:
   * one provider call per account would be needless and fail closed in bulk). Default: `get`.
   */
  stored?(userId: string): Promise<VerifiedIdentity | null>;
  /**
   * C14 / C15: the identity the account was verified with at `at` (the version valid then; the
   * operations register reads each order's own). No provider call. Default: `stored`.
   */
  asOf?(userId: string, at: Date): Promise<VerifiedIdentity | null>;
}

/** AAD of `to_kyc_identities.identity_sealed` (SPEC §3.4): bound to the account. */
export function kycIdentityAad(userId: string): string {
  return sealAad("kyc-id", userId);
}

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const BELARUSIAN_RE = /[іІўЎ]/;

/** The script of a name as written (Belarusian-only letters decide be vs ru). */
export function nameScript(...parts: (string | null | undefined)[]): NameScript {
  const text = parts.filter(Boolean).join(" ");
  if (!CYRILLIC_RE.test(text)) return "lat";
  return BELARUSIAN_RE.test(text) ? "be" : "ru";
}

/** A provider name form as a VerifiedName (its script read from the letters). */
export function verifiedName(form: ApplicantNameForm): VerifiedName {
  return {
    script: nameScript(form.lastName, form.firstName, form.middleName),
    last: form.lastName,
    first: form.firstName,
    middle: form.middleName,
  };
}

/** The provider's applicant as a VerifiedIdentity (what the live default can know). */
export function identityFromApplicant(
  userId: string,
  summary: ApplicantSummary,
  verifiedAt: Date | null,
): VerifiedIdentity {
  const { firstName, lastName, dob, country } = summary.person;
  const id = summary.identity;
  const names: VerifiedName[] = id?.names.length
    ? id.names.map(verifiedName)
    : firstName && lastName
      ? [{ script: nameScript(lastName, firstName), last: lastName, first: firstName }]
      : [];
  return {
    userId,
    names,
    birthDate: dob,
    citizenship: toAlpha2(id ? id.nationality : country),
    residenceCountry: toAlpha2(id?.residenceCountry),
    level: summary.levelName,
    verifiedAt,
    vendorPep: id?.aml?.pep ?? null,
    vendorSanctions: id?.aml?.sanctions ?? null,
    vendorAdverseMedia: id?.aml?.adverseMedia ?? null,
  };
}

/** The Latin name (OCT recipients, bank files), else the first form there is. */
export function latinName(identity: VerifiedIdentity | null): VerifiedName | null {
  if (!identity) return null;
  return identity.names.find((n) => n.script === "lat") ?? identity.names[0] ?? null;
}

@Injectable()
export class KycIdentityPort implements KycIdentityImpl {
  private readonly logger = new Logger(KycIdentityPort.name);
  /** Bound implementations, the last one answering (the service at boot, a test stub layered over it). */
  private impls: KycIdentityImpl[] = [];

  constructor(
    private readonly users: UserService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
    @InjectRepository(KycVerificationEntity)
    private readonly verifications: Repository<KycVerificationEntity>,
  ) {}

  /** Install an implementation (from its `onModuleInit`); returns the unbind, which restores the one below. */
  bind(impl: KycIdentityImpl): () => void {
    if (this.impls.includes(impl)) throw new Error("this identity implementation is already bound");
    if (this.impls.length > 0)
      this.logger.warn("identity implementation layered over the bound one");
    this.impls.push(impl);
    this.logger.log("identity implementation bound");
    return () => {
      this.impls = this.impls.filter((i) => i !== impl);
    };
  }

  get bound(): boolean {
    return this.impls.length > 0;
  }

  /** As stored (no provider call) when the implementation keeps identities; else `get`. */
  async stored(userId: string): Promise<VerifiedIdentity | null> {
    const impl = this.impls[this.impls.length - 1];
    return impl?.stored ? impl.stored(userId) : this.get(userId);
  }

  /** C14 / C15: the identity valid at `at` when the implementation keeps versions; else `stored`. */
  async asOf(userId: string, at: Date): Promise<VerifiedIdentity | null> {
    const impl = this.impls[this.impls.length - 1];
    return impl?.asOf ? impl.asOf(userId, at) : this.stored(userId);
  }

  async get(userId: string): Promise<VerifiedIdentity | null> {
    const impl = this.impls[this.impls.length - 1];
    if (impl) return impl.get(userId);
    const user = await this.users.findById(userId);
    if (!user || user.kycStatus !== "approved" || !user.kycApplicantId) return null;
    const summary = await this.provider.fetchApplicant(user.kycApplicantId);
    const verification = user.kycVerificationId
      ? await this.verifications.findOne({ where: { id: user.kycVerificationId } })
      : null;
    return identityFromApplicant(userId, summary, verification?.reviewedAt ?? null);
  }
}
