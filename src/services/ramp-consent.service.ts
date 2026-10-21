import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Config } from "../config";
import { RampConsentEntity } from "../entities/ramp-consent.entity";
import type { Actor, ApiRampConsentResult } from "../types";
import { ApiError } from "../util/errors";
import { sealAad } from "../util/sealed";
import { HOUR_MS } from "../util/time";
import type { AdminActor } from "./admin.service";
import { AuditService } from "./audit.service";
import { ComplianceAlertsService } from "./compliance-alerts.service";
import { RateLimitService } from "./rate-limit.service";
import {
  type ResealPage,
  type ResealPageInput,
  SealedDataService,
  type SealedResealer,
  UNVERSIONED_KID,
} from "./sealed-data.service";

/** AAD of a consent's principal (who the user acts for): bound to the account and the row. */
export function consentPrincipalAad(userId: string, consentId: string): string {
  return sealAad("ramp-consent-principal", userId, consentId);
}

/** AAD of a consent's PEP detail. */
export function consentPepAad(userId: string, consentId: string): string {
  return sealAad("ramp-consent-pep", userId, consentId);
}

/** One consent per user per hour beyond this is refused (each declaration is evidence and may raise an alert). */
const CONSENTS_PER_HOUR = 10;
/** R2b-7: declarations (each raises a block alert due the same day) per client IP per hour, any account. */
const DECLARATIONS_PER_IP_HOUR = 10;
const USER_AGENT_MAX = 512;

/**
 * The alert windows of a consent's declarations: one per CONSENT (C13) — every declaration is
 * reviewed on its own, so a new principal or PEP detail after a cleared one is never let through
 * on the old decision; eligibility reads the latest consent's own window.
 */
export const principalWindow = (consentId: string): string => `principal:${consentId}`;
export const pepWindow = (consentId: string): string => `pep:${consentId}`;

/** C13: `GET /admin/compliance/alerts/:id/declaration` — what a consent alert was raised on. */
export interface ApiConsentDeclaration {
  alertId: string;
  rule: "TM-PRINCIPAL" | "TM-PEP";
  consentId: string;
  termsVersion: string;
  acceptedAt: string;
  actsForSelf: boolean;
  pepDeclared: boolean;
  /** TM-PRINCIPAL: who the account declared it acts for. */
  principal?: string | null;
  /** TM-PEP: the declared PEP detail. */
  pepDetail?: string | null;
}

export interface ConsentInput {
  termsVersion: string;
  actsForSelf: boolean;
  principal?: string;
  pepDeclared: boolean;
  pepDetail?: string;
}

/**
 * Consent to the ramp terms (SPEC §11.2, B4; ПВК p.31): every acceptance is a new, append-only row
 * with IP and user agent, the "acting for myself" answer (the principal sealed when not) and the PEP
 * self-declaration (domestic PEPs appear in no vendor list; detail sealed). Not acting for oneself
 * raises TM-PRINCIPAL and a PEP declaration TM-PEP (block, due the same business day), one per
 * consent (C13): the account is not eligible until AML clears its latest declaration, read by the
 * officer through `declarationOf`; the principal is screened like the account (S7b). Orders store
 * the consent they were made under.
 */
@Injectable()
export class RampConsentService implements SealedResealer, OnModuleInit {
  readonly name = "ramp-consents";
  private readonly logger = new Logger(RampConsentService.name);

  constructor(
    private readonly config: Config,
    @InjectRepository(RampConsentEntity) readonly consents: Repository<RampConsentEntity>,
    private readonly sealed: SealedDataService,
    private readonly alerts: ComplianceAlertsService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  onModuleInit(): void {
    this.sealed.registerResealer(this);
  }

  /** The account's latest consent under `termsVersion` (default: the current RAMP_TERMS_VERSION). */
  latest(
    userId: string,
    termsVersion = this.config.ramp.termsVersion,
  ): Promise<RampConsentEntity | null> {
    return this.consents.findOne({
      where: { userId, termsVersion },
      order: { acceptedAt: "DESC", id: "DESC" },
    });
  }

  /**
   * `POST /ramp/consent`: record the acceptance (always a new row), raise the declarations' alerts.
   * R2b-7: a declaration (principal or PEP) raises a block alert due the same business day, so it
   * needs the ramp on and an approved KYC, at most one undecided alert per rule and account (a new
   * one waits for AML's decision) and a per-IP hourly limit across accounts.
   */
  async give(
    userId: string,
    input: ConsentInput,
    meta: { userAgent: string | null; kycStatus: string },
    actor: Actor,
  ): Promise<ApiRampConsentResult> {
    if (!this.config.ramp.enabled)
      throw new ApiError(503, "ramp_unavailable", "the ramp is not available right now", {
        reason: "ramp_disabled",
      });
    const current = this.config.ramp.termsVersion;
    if (input.termsVersion !== current)
      throw new ApiError(400, "validation_failed", "these are not the current ramp terms", {
        termsVersion: current,
      });
    const principal = input.principal?.trim() ?? "";
    if (!input.actsForSelf && !principal)
      throw new ApiError(400, "validation_failed", "name who you act for (principal)");
    if (input.actsForSelf && principal)
      throw new ApiError(
        400,
        "validation_failed",
        "a principal is only given when not acting for yourself",
      );
    const pepDetail = input.pepDetail?.trim() ?? "";
    if (!input.pepDeclared && pepDetail)
      throw new ApiError(
        400,
        "validation_failed",
        "pepDetail is only given with a PEP declaration",
      );
    await this.rateLimit.hit("ramp_consent", `userId:${userId}`, HOUR_MS, CONSENTS_PER_HOUR);
    const declares: ("TM-PRINCIPAL" | "TM-PEP")[] = [
      ...(input.actsForSelf ? [] : ["TM-PRINCIPAL" as const]),
      ...(input.pepDeclared ? ["TM-PEP" as const] : []),
    ];
    if (declares.length) {
      if (meta.kycStatus !== "approved")
        throw new ApiError(409, "kyc_required", "identity verification is required for the ramp");
      for (const rule of declares)
        if (await this.alerts.undecided(userId, rule))
          throw new ApiError(
            429,
            "rate_limited",
            "your previous declaration is still being reviewed; try again later",
            { scope: "ramp_consent_declaration" },
          );
      if (actor.ip)
        await this.rateLimit.hit(
          "ramp_consent_ip",
          `ip:${actor.ip}`,
          HOUR_MS,
          DECLARATIONS_PER_IP_HOUR,
        );
    }

    const id = randomUUID();
    await this.consents.insert({
      id,
      userId,
      termsVersion: current,
      acceptedAt: new Date(),
      ip: actor.ip ?? null,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, USER_AGENT_MAX) : null,
      actsForSelf: input.actsForSelf,
      principalSealed: input.actsForSelf
        ? null
        : this.sealed.seal(principal, consentPrincipalAad(userId, id)),
      pepDeclared: input.pepDeclared,
      pepDetailSealed: pepDetail ? this.sealed.seal(pepDetail, consentPepAad(userId, id)) : null,
    });
    const figures = { consentId: id, termsVersion: current };
    if (!input.actsForSelf)
      await this.alerts.raise({
        userId,
        rule: "TM-PRINCIPAL",
        figures,
        windowKey: principalWindow(id),
      });
    if (input.pepDeclared)
      await this.alerts.raise({ userId, rule: "TM-PEP", figures, windowKey: pepWindow(id) });
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      ip: actor.ip ?? null,
      action: "compliance.consent_given",
      subjectType: "ramp_consent",
      subjectId: id,
      metadata: {
        termsVersion: current,
        actsForSelf: input.actsForSelf,
        pepDeclared: input.pepDeclared,
      },
    });
    return { consent: { required: false, termsVersion: current } };
  }

  /**
   * C13: the declaration behind a TM-PRINCIPAL / TM-PEP alert, unsealed for the AML officer who
   * decides it — only the rule's own field. Audited (who, which alert and consent; never the text).
   */
  async declarationOf(
    alert: { id: string; rule: string; userId: string; figures: Record<string, unknown> },
    actor: AdminActor,
  ): Promise<ApiConsentDeclaration> {
    const consentId = alert.figures.consentId;
    if ((alert.rule !== "TM-PRINCIPAL" && alert.rule !== "TM-PEP") || typeof consentId !== "string")
      throw new ApiError(404, "not_found", "this alert carries no declaration");
    const row = await this.consents.findOne({ where: { id: consentId } });
    if (!row || row.userId !== alert.userId)
      throw new ApiError(404, "not_found", "the declaration of this alert was not found");
    const open = this.unsealed(row);
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      ip: actor.ip,
      action: "compliance.consent_unsealed",
      subjectType: "ramp_consent",
      subjectId: row.id,
      metadata: {
        alertId: alert.id,
        rule: alert.rule,
        userId: row.userId,
        operatorPerson: actor.personId,
      },
    });
    return {
      alertId: alert.id,
      rule: alert.rule,
      consentId: row.id,
      termsVersion: row.termsVersion,
      acceptedAt: row.acceptedAt.toISOString(),
      actsForSelf: row.actsForSelf,
      pepDeclared: row.pepDeclared,
      ...(alert.rule === "TM-PRINCIPAL"
        ? { principal: open.principal }
        : { pepDetail: open.pepDetail }),
    };
  }

  /** Open a consent's sealed answers (AML review; never shown to the user again). */
  unsealed(row: RampConsentEntity): { principal: string | null; pepDetail: string | null } {
    return {
      principal: row.principalSealed
        ? this.sealed.unseal(row.principalSealed, consentPrincipalAad(row.userId, row.id))
        : null,
      pepDetail: row.pepDetailSealed
        ? this.sealed.unseal(row.pepDetailSealed, consentPepAad(row.userId, row.id))
        : null,
    };
  }

  // ───────────────────────────────────────────── re-sealer (SPEC §8) ───────────────────────

  /** Both sealed columns, counted per kid. */
  async countByKid(): Promise<Record<string, number>> {
    const rows: { kid: string; n: number }[] = await this.consents.query(
      `SELECT CASE WHEN v ~ '^v2\\.[A-Za-z0-9_-]{1,32}\\.' THEN split_part(v, '.', 2) ELSE $1 END AS "kid", count(*)::int AS "n"
         FROM (SELECT "principal_sealed" AS v FROM "to_ramp_consents" WHERE "principal_sealed" IS NOT NULL
               UNION ALL SELECT "pep_detail_sealed" FROM "to_ramp_consents" WHERE "pep_detail_sealed" IS NOT NULL) s
        GROUP BY 1`,
      [UNVERSIONED_KID],
    );
    return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
  }

  /** The append-only trigger lets exactly this through: a sealed value rewritten, never added or removed. */
  async resealBatch(input: ResealPageInput): Promise<ResealPage> {
    const prefix = `v2.${input.activeKid}.`;
    const rows: { id: string; user_id: string; p: string | null; d: string | null }[] =
      await this.consents.query(
        `SELECT "id", "user_id", "principal_sealed" AS "p", "pep_detail_sealed" AS "d" FROM "to_ramp_consents"
          WHERE ((("principal_sealed" IS NOT NULL AND NOT starts_with("principal_sealed", $1))
              OR ("pep_detail_sealed" IS NOT NULL AND NOT starts_with("pep_detail_sealed", $1))))
            AND ($2::uuid IS NULL OR "id" > $2::uuid)
          ORDER BY "id" LIMIT $3`,
        [prefix, input.after, input.limit],
      );
    let changed = 0;
    let failed = 0;
    for (const row of rows) {
      let p = row.p;
      let d = row.d;
      try {
        if (p && !p.startsWith(prefix))
          p = this.sealed.reseal(p, consentPrincipalAad(row.user_id, row.id));
        if (d && !d.startsWith(prefix))
          d = this.sealed.reseal(d, consentPepAad(row.user_id, row.id));
      } catch (err) {
        failed += 1;
        this.logger.warn(`consent ${row.id} cannot be re-sealed: ${(err as Error).message}`);
        continue;
      }
      const res = await this.consents
        .createQueryBuilder()
        .update(RampConsentEntity)
        .set({ principalSealed: p, pepDetailSealed: d })
        .where(
          `"id" = :id AND "principal_sealed" IS NOT DISTINCT FROM CAST(:oldP AS text) AND "pep_detail_sealed" IS NOT DISTINCT FROM CAST(:oldD AS text)`,
          { id: row.id, oldP: row.p, oldD: row.d },
        )
        .execute();
      changed += res.affected ?? 0;
    }
    return { changed, failed, last: rows.length < input.limit ? null : rows[rows.length - 1].id };
  }
}
