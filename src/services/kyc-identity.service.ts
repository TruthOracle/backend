import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Config } from "../config";
import { KycIdentityEntity, type KycRiskLevel } from "../entities/kyc-identity.entity";
import { KycVerificationEntity } from "../entities/kyc-verification.entity";
import type { UserEntity } from "../entities/user.entity";
import {
  KYC_PROVIDER,
  type ApplicantAmlScreening,
  type ApplicantSummary,
  type KycProvider,
} from "../types";
import { ApiError } from "../util/errors";
import { toAlpha2 } from "../util/iso-country";
import { DAY_MS } from "../util/time";
import { AuditService } from "./audit.service";
import { ComplianceAlertsService } from "./compliance-alerts.service";
import {
  KycIdentityPort,
  kycIdentityAad,
  nameScript,
  verifiedName,
  type KycIdentityImpl,
  type VerifiedAddress,
  type VerifiedDocument,
  type VerifiedIdentity,
  type VerifiedName,
} from "./kyc-identity.port";
import { type KycStatusChange, KycService } from "./kyc.service";
import {
  type ResealPage,
  type ResealPageInput,
  SealedDataService,
  type SealedResealer,
  UNVERSIONED_KID,
} from "./sealed-data.service";
import { UserService } from "./user.service";

/** What `identity_sealed` holds (SPEC §3.4): the art.8 data; countries ISO alpha-2. */
export interface SealedIdentityData {
  names: VerifiedName[];
  birthDate: string | null;
  birthPlace: string | null;
  birthCountry: string | null;
  citizenship: string | null;
  residenceCountry: string | null;
  address: VerifiedAddress | null;
  doc: VerifiedDocument | null;
}

/** The plain facts of an identity version (C14): compared on every refresh, with the sealed data. */
interface VersionFacts {
  provider: string;
  applicantId: string;
  verificationId: string | null;
  levelName: string | null;
  verifiedAt: string | null;
  citizenship: string | null;
  residenceCountry: string | null;
  docExpiresAt: string | null;
  riskLevel: KycRiskLevel;
  vendorPep: boolean | null;
  vendorSanctions: boolean | null;
  vendorAdverseMedia: boolean | null;
  amlLabels: string[];
}

interface OpenVersionRow extends Omit<VersionFacts, "verifiedAt"> {
  id: string;
  version: number;
  sealed: string;
  verifiedAt: Date | null;
}

/** One stored version as read back (C14 / C15). */
interface VersionRow {
  version: number;
  sealed: string;
  citizenship: string | null;
  residenceCountry: string | null;
  levelName: string | null;
  verifiedAt: Date | null;
  riskLevel: KycRiskLevel;
  vendorPep: boolean | null;
  vendorSanctions: boolean | null;
  vendorAdverseMedia: boolean | null;
  amlLabels: string[];
  validFrom: Date;
}

/** JSON with sorted keys (a stored version and a fresh read compare equal when they are). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** Re-verification interval by risk (ПВК pp.45–49): low 3, medium 2, high 1 years. */
const REFRESH_YEARS: Record<KycRiskLevel, number> = { low: 3, medium: 2, high: 1 };

/** Merge AML evidence: any `true` wins; a source that screened turns unknown into false. */
export function mergeAml(
  ...sources: (ApplicantAmlScreening | null | undefined)[]
): ApplicantAmlScreening | null {
  const present = sources.filter((s): s is ApplicantAmlScreening => Boolean(s));
  if (present.length === 0) return null;
  const flag = (k: "pep" | "sanctions" | "adverseMedia"): boolean | null => {
    const values = present.map((s) => s[k]);
    if (values.includes(true)) return true;
    return values.includes(false) ? false : null;
  };
  return {
    pep: flag("pep"),
    sanctions: flag("sanctions"),
    adverseMedia: flag("adverseMedia"),
    labels: [...new Set(present.flatMap((s) => s.labels))].sort(),
  };
}

/** The risk level a refreshed identity starts from: PEP / sanctions high, adverse media medium. */
export function riskLevelOf(aml: ApplicantAmlScreening | null): KycRiskLevel {
  if (aml?.pep === true || aml?.sanctions === true) return "high";
  return aml?.adverseMedia === true ? "medium" : "low";
}

/** `verifiedAt` + 3 / 2 / 1 years by risk (null without a verification date). */
export function refreshDueAt(verifiedAt: Date | null, risk: KycRiskLevel): Date | null {
  if (!verifiedAt) return null;
  const due = new Date(verifiedAt.getTime());
  due.setUTCFullYear(due.getUTCFullYear() + REFRESH_YEARS[risk]);
  return due;
}

/** The provider applicant → the sealed art.8 data (every name form; countries alpha-2). */
export function sealedIdentityFrom(summary: ApplicantSummary): SealedIdentityData {
  const id = summary.identity;
  const { firstName, lastName, dob, country } = summary.person;
  const names: VerifiedName[] = id?.names.length
    ? id.names.map(verifiedName)
    : firstName && lastName
      ? [
          {
            script: nameScript(lastName, firstName),
            last: lastName,
            first: firstName,
            middle: null,
          },
        ]
      : [];
  return {
    names,
    birthDate: dob,
    birthPlace: id?.birthPlace ?? null,
    birthCountry: toAlpha2(id?.birthCountry),
    citizenship: toAlpha2(id ? id.nationality : country),
    residenceCountry: toAlpha2(id ? id.residenceCountry : country),
    address: id?.address ? { ...id.address, country: toAlpha2(id.address.country) } : null,
    doc: id?.document ? { ...id.document, country: toAlpha2(id.document.country) } : null,
  };
}

/**
 * The verified identity store (SPEC §11.1, M11; implements KycIdentityPort): the provider's
 * applicant kept as art.8 data — every name form, date and place of birth, citizenship, residence,
 * address, the identity document — sealed with AAD `kyc-id|<userId>`, plus the vendor AML flags
 * (null = not screened, never false) and the refresh due date by risk. Refreshed on KYC approval
 * (kyc.service listener) and lazily when missing, for another applicant, or older than
 * RAMP_KYC_REFRESH_DAYS; an unreachable provider fails closed (409 kyc_identity_unavailable). A
 * vendor sanctions / PEP flag raises TM-SANCTIONS / TM-PEP (block). Rows are never deleted (R4).
 */
@Injectable()
export class KycIdentityService implements KycIdentityImpl, SealedResealer, OnModuleInit {
  readonly name = "kyc-identities";
  private readonly logger = new Logger(KycIdentityService.name);

  constructor(
    private readonly config: Config,
    @InjectRepository(KycIdentityEntity)
    private readonly identities: Repository<KycIdentityEntity>,
    @InjectRepository(KycVerificationEntity)
    private readonly verifications: Repository<KycVerificationEntity>,
    private readonly users: UserService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
    private readonly sealed: SealedDataService,
    private readonly port: KycIdentityPort,
    private readonly kyc: KycService,
    private readonly alerts: ComplianceAlertsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.port.bind(this);
    this.sealed.registerResealer(this);
    this.sealed.registerResealer(this.versionResealer);
    this.kyc.onStatusChanged((change) => this.onKycChange(change));
  }

  /** KycIdentityPort: the stored identity, refreshed when due; null without an approved KYC. */
  async get(userId: string): Promise<VerifiedIdentity | null> {
    const user = await this.users.findById(userId);
    if (!user || user.kycStatus !== "approved" || !user.kycApplicantId) return null;
    const row = await this.identities.findOne({ where: { userId } });
    const fresh =
      row &&
      row.applicantId === user.kycApplicantId &&
      row.provider === user.kycProvider &&
      Date.now() - row.refreshedAt.getTime() < this.config.compliance.kycRefreshDays * DAY_MS;
    return this.toIdentity(fresh ? row : await this.refreshFor(user));
  }

  /** KycIdentityPort.stored: the stored identity without a provider call (null when none is stored). */
  async stored(userId: string): Promise<VerifiedIdentity | null> {
    const row = await this.identities.findOne({ where: { userId } });
    return row ? this.toIdentity(row) : null;
  }

  /** Re-read the provider's applicant now (KYC approval, tests); null without an approved KYC. */
  async refresh(userId: string): Promise<VerifiedIdentity | null> {
    const user = await this.users.findById(userId);
    if (!user || user.kycStatus !== "approved" || !user.kycApplicantId) return null;
    return this.toIdentity(await this.refreshFor(user));
  }

  private async onKycChange(change: KycStatusChange): Promise<void> {
    if (change.userKycStatus === "approved") await this.refresh(change.userId);
  }

  /** Read, merge and store; fail closed (409 kyc_identity_unavailable) when the provider cannot answer. */
  private async refreshFor(user: UserEntity): Promise<KycIdentityEntity> {
    const applicantId = user.kycApplicantId as string;
    let summary: ApplicantSummary;
    let screened: ApplicantAmlScreening | null = null;
    try {
      if (user.kycProvider !== this.provider.name)
        throw new Error(`the applicant belongs to ${user.kycProvider ?? "no provider"}`);
      summary = await this.provider.fetchApplicant(applicantId);
      if (this.provider.fetchAmlScreening)
        screened = await this.provider.fetchAmlScreening(applicantId);
    } catch (err) {
      this.logger.warn(`identity of ${user.id} cannot be refreshed: ${(err as Error).message}`);
      throw new ApiError(
        409,
        "kyc_identity_unavailable",
        "the verified identity cannot be read right now; try again later",
      );
    }
    const data = sealedIdentityFrom(summary);
    const aml = mergeAml(summary.identity?.aml, screened);
    const risk = riskLevelOf(aml);
    const verification = user.kycVerificationId
      ? await this.verifications.findOne({ where: { id: user.kycVerificationId } })
      : null;
    const verifiedAt = verification?.reviewedAt ?? null;
    const facts: VersionFacts = {
      provider: this.provider.name,
      applicantId,
      verificationId: user.kycVerificationId ?? null,
      levelName: summary.levelName,
      verifiedAt: verifiedAt?.toISOString() ?? null,
      citizenship: data.citizenship,
      residenceCountry: data.residenceCountry,
      docExpiresAt: data.doc?.expiresAt ?? null,
      riskLevel: risk,
      vendorPep: aml?.pep ?? null,
      vendorSanctions: aml?.sanctions ?? null,
      vendorAdverseMedia: aml?.adverseMedia ?? null,
      amlLabels: aml?.labels ?? [],
    };
    const sealedData = this.sealed.seal(JSON.stringify(data), kycIdentityAad(user.id));
    // C14 (R4, ПВК p.43): the identity is versioned, never overwritten — a refresh that changes
    // anything closes the open version and adds the next; the current row below is its cache.
    // One refresh per account at a time (advisory lock), so the chain never forks.
    const version = await this.identities.manager.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`kyc-identity:${user.id}`]);
      const [open] = await m.query<OpenVersionRow[]>(
        `SELECT id, version, identity_sealed AS "sealed", provider, applicant_id AS "applicantId",
                verification_id AS "verificationId", level_name AS "levelName", verified_at AS "verifiedAt",
                citizenship, residence_country AS "residenceCountry", doc_expires_at::text AS "docExpiresAt",
                risk_level AS "riskLevel", vendor_pep AS "vendorPep", vendor_sanctions AS "vendorSanctions",
                vendor_adverse_media AS "vendorAdverseMedia", aml_labels AS "amlLabels"
           FROM to_kyc_identity_versions WHERE user_id = $1 AND valid_to IS NULL`,
        [user.id],
      );
      const changedFields = open ? this.changedFields(user.id, open, data, facts) : [];
      let current = open ? { id: open.id, version: open.version } : null;
      if (!open || changedFields.length > 0) {
        if (open)
          await m.query(
            `UPDATE to_kyc_identity_versions SET valid_to = now() WHERE id = $1 AND valid_to IS NULL`,
            [open.id],
          );
        [current] = await m.query<{ id: string; version: number }[]>(
          `INSERT INTO to_kyc_identity_versions ("user_id", "version", "provider", "applicant_id", "verification_id", "level_name", "verified_at", "identity_sealed", "citizenship", "residence_country", "doc_expires_at", "risk_level", "vendor_pep", "vendor_sanctions", "vendor_adverse_media", "aml_labels", "changed_fields")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id, version`,
          [
            user.id,
            (open?.version ?? 0) + 1,
            facts.provider,
            facts.applicantId,
            facts.verificationId,
            facts.levelName,
            verifiedAt,
            sealedData,
            facts.citizenship,
            facts.residenceCountry,
            facts.docExpiresAt,
            facts.riskLevel,
            facts.vendorPep,
            facts.vendorSanctions,
            facts.vendorAdverseMedia,
            facts.amlLabels,
            changedFields,
          ],
        );
      }
      // Every refresh moves `refreshed_at`, after which S7b screens the account again before its
      // next order.
      await m.query(
        `INSERT INTO "to_kyc_identities" ("user_id", "provider", "applicant_id", "level_name", "verified_at", "refreshed_at", "refresh_due_at", "identity_sealed", "citizenship", "residence_country", "doc_expires_at", "risk_level", "vendor_pep", "vendor_sanctions", "vendor_adverse_media", "aml_labels")
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT ("user_id") DO UPDATE SET "provider" = EXCLUDED."provider", "applicant_id" = EXCLUDED."applicant_id",
         "level_name" = EXCLUDED."level_name", "verified_at" = EXCLUDED."verified_at", "refreshed_at" = now(),
         "refresh_due_at" = EXCLUDED."refresh_due_at", "identity_sealed" = EXCLUDED."identity_sealed",
         "citizenship" = EXCLUDED."citizenship", "residence_country" = EXCLUDED."residence_country",
         "doc_expires_at" = EXCLUDED."doc_expires_at", "risk_level" = EXCLUDED."risk_level",
         "vendor_pep" = EXCLUDED."vendor_pep", "vendor_sanctions" = EXCLUDED."vendor_sanctions",
         "vendor_adverse_media" = EXCLUDED."vendor_adverse_media", "aml_labels" = EXCLUDED."aml_labels",
         "updated_at" = now()`,
        [
          user.id,
          this.provider.name,
          applicantId,
          summary.levelName,
          verifiedAt,
          refreshDueAt(verifiedAt, risk),
          sealedData,
          data.citizenship,
          data.residenceCountry,
          data.doc?.expiresAt ?? null,
          risk,
          aml?.pep ?? null,
          aml?.sanctions ?? null,
          aml?.adverseMedia ?? null,
          aml?.labels ?? [],
        ],
      );
      return {
        id: current?.id ?? null,
        version: current?.version ?? null,
        changed: !open || changedFields.length > 0,
        changedFields,
      };
    });
    await this.audit.record({
      actorType: "system",
      action: "kyc.identity_refreshed",
      subjectType: "user",
      subjectId: user.id,
      metadata: {
        provider: this.provider.name,
        forms: data.names.length,
        // C14, ПВК p.43's change journal: which version, and which fields changed (never values).
        versionId: version.id,
        version: version.version,
        changed: version.changed,
        changedFields: version.changedFields,
        risk,
        vendorPep: aml?.pep ?? null,
        vendorSanctions: aml?.sanctions ?? null,
        vendorAdverseMedia: aml?.adverseMedia ?? null,
      },
    });
    await this.raiseVendorAlerts(user.id, applicantId, aml);
    return this.identities.findOneOrFail({ where: { userId: user.id } });
  }

  /**
   * C14: the names of what differs between the open version and a fresh read (field names only,
   * never values: the audit's change journal). A version that no longer opens counts as changed.
   */
  private changedFields(
    userId: string,
    open: OpenVersionRow,
    data: SealedIdentityData,
    facts: VersionFacts,
  ): string[] {
    const out: string[] = [];
    let before: SealedIdentityData | null = null;
    try {
      before = JSON.parse(
        this.sealed.unseal(open.sealed, kycIdentityAad(userId)),
      ) as SealedIdentityData;
    } catch {
      out.push("identity");
    }
    if (before)
      for (const key of Object.keys(data) as (keyof SealedIdentityData)[])
        if (stable(before[key]) !== stable(data[key])) out.push(key);
    const was: Record<keyof VersionFacts, unknown> = {
      ...open,
      verifiedAt: open.verifiedAt?.toISOString() ?? null,
      amlLabels: [...open.amlLabels].sort(),
    };
    for (const key of Object.keys(facts) as (keyof VersionFacts)[]) {
      const now = key === "amlLabels" ? [...facts.amlLabels].sort() : facts[key];
      if (stable(was[key]) !== stable(now) && !out.includes(key)) out.push(key);
    }
    return out;
  }

  /**
   * KycIdentityPort.asOf (C14 / C15): the identity the account was verified with at `at` — the
   * version valid then, else the first one after it (an operation made before the first stored
   * version: the earliest identification on record). Null when none was ever stored. No provider call.
   */
  async asOf(userId: string, at: Date): Promise<VerifiedIdentity | null> {
    const select = `SELECT version, identity_sealed AS "sealed", citizenship, residence_country AS "residenceCountry",
              level_name AS "levelName", verified_at AS "verifiedAt", risk_level AS "riskLevel",
              vendor_pep AS "vendorPep", vendor_sanctions AS "vendorSanctions",
              vendor_adverse_media AS "vendorAdverseMedia", aml_labels AS "amlLabels", valid_from AS "validFrom"
         FROM to_kyc_identity_versions WHERE user_id = $1`;
    const [valid] = await this.identities.query<VersionRow[]>(
      `${select} AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) LIMIT 1`,
      [userId, at],
    );
    const [first] = valid
      ? [valid]
      : await this.identities.query<VersionRow[]>(
          `${select} AND valid_from > $2 ORDER BY version LIMIT 1`,
          [userId, at],
        );
    if (!first) return null;
    const data = JSON.parse(
      this.sealed.unseal(first.sealed, kycIdentityAad(userId)),
    ) as SealedIdentityData;
    return {
      userId,
      names: data.names,
      birthDate: data.birthDate,
      citizenship: first.citizenship,
      residenceCountry: first.residenceCountry,
      level: first.levelName,
      verifiedAt: first.verifiedAt,
      vendorPep: first.vendorPep,
      vendorSanctions: first.vendorSanctions,
      vendorAdverseMedia: first.vendorAdverseMedia,
      birthPlace: data.birthPlace,
      address: data.address,
      doc: data.doc,
      riskLevel: first.riskLevel,
      amlLabels: first.amlLabels,
      refreshedAt: first.validFrom,
    };
  }

  /** A vendor sanctions / PEP flag is a refusal ground (SPEC §11.3, §11.4): one block alert per applicant. */
  private async raiseVendorAlerts(
    userId: string,
    applicantId: string,
    aml: ApplicantAmlScreening | null,
  ): Promise<void> {
    const windowKey = `vendor:${applicantId}`;
    if (aml?.sanctions === true)
      await this.alerts.raise({
        userId,
        rule: "TM-SANCTIONS",
        point: "identity",
        figures: { source: "vendor", labels: aml.labels },
        windowKey,
      });
    if (aml?.pep === true)
      await this.alerts.raise({
        userId,
        rule: "TM-PEP",
        point: "identity",
        figures: { source: "vendor", labels: aml.labels },
        windowKey,
      });
  }

  private unsealData(row: KycIdentityEntity): SealedIdentityData {
    return JSON.parse(
      this.sealed.unseal(row.identitySealed, kycIdentityAad(row.userId)),
    ) as SealedIdentityData;
  }

  private toIdentity(row: KycIdentityEntity): VerifiedIdentity {
    const data = this.unsealData(row);
    return {
      userId: row.userId,
      names: data.names,
      birthDate: data.birthDate,
      citizenship: row.citizenship,
      residenceCountry: row.residenceCountry,
      level: row.levelName,
      verifiedAt: row.verifiedAt,
      vendorPep: row.vendorPep,
      vendorSanctions: row.vendorSanctions,
      vendorAdverseMedia: row.vendorAdverseMedia,
      birthPlace: data.birthPlace,
      address: data.address,
      doc: data.doc,
      riskLevel: row.riskLevel,
      refreshDueAt: row.refreshDueAt,
      amlLabels: row.amlLabels,
      refreshedAt: row.refreshedAt,
    };
  }

  // ───────────────────────────────────────────── re-sealer (SPEC §8) ───────────────────────

  /**
   * C14: the versions' sealed column, moved onto the active kid through the append-only trigger
   * (a re-seal is the one rewrite it lets through besides closing a version).
   */
  private readonly versionResealer: SealedResealer = {
    name: "kyc-identity-versions",
    countByKid: async () => {
      const rows: { kid: string; n: number }[] = await this.identities.query(
        `SELECT CASE WHEN "identity_sealed" ~ '^v2\\.[A-Za-z0-9_-]{1,32}\\.' THEN split_part("identity_sealed", '.', 2) ELSE $1 END AS "kid", count(*)::int AS "n"
           FROM "to_kyc_identity_versions" GROUP BY 1`,
        [UNVERSIONED_KID],
      );
      return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
    },
    resealBatch: async (input) => {
      const rows: { id: string; user_id: string; sealed: string }[] = await this.identities.query(
        `SELECT "id", "user_id", "identity_sealed" AS "sealed" FROM "to_kyc_identity_versions"
          WHERE NOT starts_with("identity_sealed", $1) AND ($2::uuid IS NULL OR "id" > $2::uuid)
          ORDER BY "id" LIMIT $3`,
        [`v2.${input.activeKid}.`, input.after, input.limit],
      );
      let changed = 0;
      let failed = 0;
      for (const row of rows) {
        let next: string;
        try {
          next = this.sealed.reseal(row.sealed, kycIdentityAad(row.user_id));
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `identity version ${row.id} cannot be re-sealed: ${(err as Error).message}`,
          );
          continue;
        }
        const res: [unknown[], number] = await this.identities.query(
          `UPDATE "to_kyc_identity_versions" SET "identity_sealed" = $1 WHERE "id" = $2 AND "identity_sealed" = $3`,
          [next, row.id, row.sealed],
        );
        changed += res[1] ?? 0;
      }
      return {
        changed,
        failed,
        last: rows.length < input.limit ? null : rows[rows.length - 1].id,
      };
    },
  };

  async countByKid(): Promise<Record<string, number>> {
    const rows: { kid: string; n: number }[] = await this.identities.query(
      `SELECT CASE WHEN "identity_sealed" ~ '^v2\\.[A-Za-z0-9_-]{1,32}\\.' THEN split_part("identity_sealed", '.', 2) ELSE $1 END AS "kid", count(*)::int AS "n"
         FROM "to_kyc_identities" GROUP BY 1`,
      [UNVERSIONED_KID],
    );
    return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
  }

  async resealBatch(input: ResealPageInput): Promise<ResealPage> {
    const rows: { user_id: string; sealed: string }[] = await this.identities.query(
      `SELECT "user_id", "identity_sealed" AS "sealed" FROM "to_kyc_identities"
        WHERE NOT starts_with("identity_sealed", $1) AND ($2::uuid IS NULL OR "user_id" > $2::uuid)
        ORDER BY "user_id" LIMIT $3`,
      [`v2.${input.activeKid}.`, input.after, input.limit],
    );
    let changed = 0;
    let failed = 0;
    for (const row of rows) {
      let next: string;
      try {
        next = this.sealed.reseal(row.sealed, kycIdentityAad(row.user_id));
      } catch (err) {
        failed += 1;
        this.logger.warn(`identity ${row.user_id} cannot be re-sealed: ${(err as Error).message}`);
        continue;
      }
      const res = await this.identities
        .createQueryBuilder()
        .update(KycIdentityEntity)
        .set({ identitySealed: next })
        .where(`"user_id" = :id AND "identity_sealed" = :old`, { id: row.user_id, old: row.sealed })
        .execute();
      changed += res.affected ?? 0;
    }
    return {
      changed,
      failed,
      last: rows.length < input.limit ? null : rows[rows.length - 1].user_id,
    };
  }
}
