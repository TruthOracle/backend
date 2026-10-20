import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type {
  ApplicantAmlScreening,
  ApplicantIdentityData,
  ApplicantNameForm,
  ApplicantSummary,
  KycEvent,
  KycEventKind,
  KycProvider,
  KycProviderHealth,
  KycSessionResult,
} from "../types";
import { ApiError } from "../util/errors";
import { asString } from "../util/strings";

/**
 * A Sumsub webhook normalised to the shared `KycEvent` shape plus the two fields the stored
 * row needs: the provider's raw `type` and the user-facing `moderationComment` (≤ 500 chars).
 * `clientComment` (Sumsub's internal note) is never carried anywhere.
 */
export interface SumsubKycEvent extends KycEvent {
  type: string;
  moderationComment: string | null;
}

/** `x-payload-digest-alg` → Node hash name. SHA1 is only honoured with SUMSUB_ALLOW_SHA1=true. */
export const SUMSUB_DIGEST_ALGS: Readonly<Record<string, string>> = {
  HMAC_SHA256_HEX: "sha256",
  HMAC_SHA512_HEX: "sha512",
  HMAC_SHA1_HEX: "sha1",
};

/** Sumsub event `type` → the provider-agnostic kind the state machine understands (§9.2). */
export const SUMSUB_EVENT_KINDS: Readonly<Record<string, KycEventKind>> = {
  applicantCreated: "created",
  applicantPending: "pending",
  applicantPrechecked: "pending",
  // Sumsub is waiting on the applicant or on an internal service: the review is still in flight.
  applicantAwaitingUser: "pending",
  applicantAwaitingService: "pending",
  // A partial reset (some steps cleared): the applicant re-submits, the attempt stays in flight.
  applicantStepsReset: "pending",
  applicantReviewed: "reviewed",
  applicantWorkflowCompleted: "reviewed",
  applicantOnHold: "onHold",
  // A workflow that cannot complete needs an operator: same queue as onHold (needs_review).
  applicantWorkflowFailed: "onHold",
  applicantReset: "reset",
  applicantDeleted: "reset",
  applicantDeactivated: "reset",
};

/** `x-payload-digest-alg` values a deployment accepts (the dashboard must be set to one of them). */
export function acceptedDigestAlgorithms(allowSha1: boolean): string[] {
  return Object.keys(SUMSUB_DIGEST_ALGS).filter(
    (alg) => allowSha1 || SUMSUB_DIGEST_ALGS[alg] !== "sha1",
  );
}

/**
 * What the credential probe means (docs/KYC.md §6): a lookup of an applicant that cannot exist
 * answers 404 iff the app token and the request signature were accepted.
 */
export function interpretSumsubProbe(
  status: number,
  detail = "",
): { ok: boolean; message: string } {
  switch (status) {
    case 404:
      return { ok: true, message: "Sumsub accepted the app token and the request signature" };
    case 200:
      return {
        ok: true,
        message: "Sumsub accepted the credentials (and found an applicant for the probe id)",
      };
    case 401:
      return {
        ok: false,
        message:
          "Sumsub rejected the app token or the request signature — check SUMSUB_APP_TOKEN / SUMSUB_SECRET_KEY and that the server clock is within a minute of UTC",
      };
    case 403:
      return {
        ok: false,
        message: "the app token is valid but lacks the 'View applicants' permission",
      };
    case 0:
      return { ok: false, message: `Sumsub is unreachable${detail ? `: ${detail}` : ""}` };
    default:
      return { ok: false, message: `Sumsub answered HTTP ${status}${detail ? ` ${detail}` : ""}` };
  }
}

const SDK_TOKEN_TTL_SEC = 1_200;
const MODERATION_COMMENT_MAX = 500;
const REQUEST_TIMEOUT_MS = 20_000;
/** Sumsub timestamps: `2020-02-21 13:23:19.002` (UTC, no zone designator). */
const SUMSUB_TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/;

/**
 * `X-App-Access-Sig` (ARCHITECTURE §9.1): hex(HMAC-SHA256(secret, ts + METHOD + path(+query) + body)).
 * Exported so the vector can be checked in a unit test.
 */
export function signSumsubRequest(
  secretKey: string,
  ts: number | string,
  method: string,
  pathWithQuery: string,
  body = "",
): string {
  return createHmac("sha256", secretKey)
    .update(`${ts}${method.toUpperCase()}${pathWithQuery}${body}`, "utf8")
    .digest("hex");
}

function firstHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  // Node lowercases incoming header names; fakes and tests may not, so match case-insensitively.
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === wanted);
  const raw = key === undefined ? undefined : headers[key];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Webhook digest check over the RAW body: both headers required, algorithm allow-listed,
 * `timingSafeEqual` on the hex digests. Any deviation → false (never throws).
 */
export function verifySumsubDigest(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  webhookSecret: string,
  allowSha1: boolean,
): boolean {
  if (!webhookSecret || !Buffer.isBuffer(rawBody)) return false;
  const digest = firstHeader(headers, "x-payload-digest").toLowerCase();
  const algHeader = firstHeader(headers, "x-payload-digest-alg").toUpperCase();
  if (!digest || !algHeader) return false;
  const alg = SUMSUB_DIGEST_ALGS[algHeader];
  if (!alg) return false;
  if (alg === "sha1" && !allowSha1) return false;
  if (!/^[0-9a-f]+$/.test(digest)) return false;
  const expected = createHmac(alg, webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(digest, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function eventKeyOf(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => asString(v).trim().toUpperCase()).filter(Boolean);
}

/** Sumsub's `createdAtMs` / `createdAt` (UTC without designator, ISO, or epoch ms) → Date. */
export function parseSumsubTimestamp(value: unknown, fallback = new Date()): Date {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  const s = asString(value).trim();
  if (!s) return fallback;
  const m = SUMSUB_TS_RE.exec(s);
  const parsed = m ? Date.parse(`${m[1]}T${m[2]}Z`) : Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed) : fallback;
}

function reviewAnswer(value: unknown): "GREEN" | "RED" | null {
  const v = asString(value).toUpperCase();
  return v === "GREEN" || v === "RED" ? v : null;
}

function rejectType(value: unknown): "RETRY" | "FINAL" | null {
  const v = asString(value).toUpperCase();
  return v === "RETRY" || v === "FINAL" ? v : null;
}

function isSandbox(payload: Record<string, unknown>): boolean {
  return payload.sandboxMode === true || payload.testMode === true;
}

/** Normalise a (digest-verified) webhook body. Null when it is not a Sumsub applicant event. */
export function parseSumsubEvent(payload: unknown, eventKey: string): SumsubKycEvent | null {
  const p = obj(payload);
  const type = asString(p.type).trim();
  if (!type) return null;
  const result = obj(p.reviewResult);
  const answer = reviewAnswer(result.reviewAnswer);
  const reject = rejectType(result.reviewRejectType);
  const comment = asString(result.moderationComment).trim();
  return {
    type,
    applicantId: asString(p.applicantId).trim(),
    externalUserId: asString(p.externalUserId).trim(),
    levelName: asString(p.levelName).trim(),
    kind: SUMSUB_EVENT_KINDS[type] ?? "unknown",
    ...(answer ? { answer } : {}),
    ...(reject ? { rejectType: reject } : {}),
    labels: stringList(result.rejectLabels),
    occurredAt: parseSumsubTimestamp(p.createdAtMs ?? p.createdAt),
    sandbox: isSandbox(p),
    eventKey,
    moderationComment: comment ? comment.slice(0, MODERATION_COMMENT_MAX) : null,
  };
}

/**
 * The webhook body as it may be stored (§9.7): `clientComment` is removed wherever it appears.
 * Everything else in a Sumsub applicant event is ids, level names, statuses and timestamps.
 */
export function redactSumsubPayload(payload: unknown): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === "clientComment") continue;
        out[k] = strip(v);
      }
      return out;
    }
    return value;
  };
  return obj(strip(obj(payload)));
}

/**
 * `GET /resources/applicants/{id}/one` → ApplicantSummary. The answer counts only once the
 * review is `completed`; anything else is "not decided" so the service never approves on a
 * partial read. Names prefer the transliterated (`*En`) variants Sumsub provides.
 */
export function normaliseSumsubApplicant(data: unknown): ApplicantSummary {
  const a = obj(data);
  const review = obj(a.review);
  const result = obj(review.reviewResult);
  const info = obj(a.info);
  const completed = asString(review.reviewStatus).toLowerCase() === "completed";
  const answer = completed ? reviewAnswer(result.reviewAnswer) : null;
  const docs = Array.isArray(info.idDocs) ? info.idDocs : [];
  const labels = stringList(result.rejectLabels);
  return {
    answer,
    rejectType: answer === "RED" ? rejectType(result.reviewRejectType) : null,
    labels,
    levelName: asString(review.levelName).trim() || asString(a.levelName).trim() || null,
    sandbox: isSandbox(a),
    documents: docs
      .map((d) => {
        const doc = obj(d);
        return {
          docType: asString(doc.idDocType).trim(),
          country: asString(doc.country).trim(),
          number: asString(doc.number).trim(),
          dob: asString(doc.dob).trim() || null,
        };
      })
      .filter((d) => d.docType),
    person: {
      firstName: asString(info.firstNameEn).trim() || asString(info.firstName).trim() || null,
      lastName: asString(info.lastNameEn).trim() || asString(info.lastName).trim() || null,
      dob: asString(info.dob).trim() || null,
      country: asString(info.country).trim() || null,
    },
    identity: sumsubIdentity(a, info, docs.map(obj), labels),
  };
}

// ── compliance identity (SPEC §11.1; stage S7a) ──

/** Sumsub's AML-type reject labels → its AML risk-label API names (rejection buttons, docs.sumsub.com). */
const SUMSUB_AML_REJECT_LABELS: Readonly<Record<string, string>> = {
  PEP: "pep",
  SANCTIONS: "sanctions",
  ADVERSE_MEDIA: "adverseMedia",
  CRIMINAL: "crime",
  COMPROMISED_PERSONS: "compromisedPersons",
};
/** Which document is "the" identity document when several are on file. */
const SUMSUB_DOC_PREFERENCE = ["ID_CARD", "PASSPORT", "RESIDENCE_PERMIT", "DRIVERS"];
/** Sumsub answers this date for a document marked termless (`termless: true`). */
const SUMSUB_TERMLESS = "2099-01-01";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string | null {
  return asString(value).trim() || null;
}

function isoDate(value: unknown): string | null {
  const v = text(value);
  return v && ISO_DATE_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : null;
}

/**
 * Every distinct name form Sumsub holds: the profile's and each document's, as written (the
 * document's own language) and as `*En` (its transliteration) — a Belarusian document can carry
 * Belarusian, Russian and Latin forms (M2). Forms equal up to case are kept once.
 */
function sumsubNames(sources: Record<string, unknown>[]): ApplicantNameForm[] {
  const seen = new Set<string>();
  const out: ApplicantNameForm[] = [];
  for (const s of sources)
    for (const suffix of ["", "En"]) {
      const firstName = text(s[`firstName${suffix}`]);
      const lastName = text(s[`lastName${suffix}`]);
      if (!firstName || !lastName) continue;
      const middleName = text(s[`middleName${suffix}`]);
      const key = [lastName, firstName, middleName ?? ""].join("|").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ firstName, lastName, middleName });
    }
  return out;
}

function sumsubDocument(docs: Record<string, unknown>[]): ApplicantIdentityData["document"] {
  const typed = docs.filter((d) => text(d.idDocType));
  const rank = (d: Record<string, unknown>): number => {
    const i = SUMSUB_DOC_PREFERENCE.indexOf(asString(d.idDocType).trim().toUpperCase());
    return i < 0 ? SUMSUB_DOC_PREFERENCE.length : i;
  };
  const doc = [...typed].sort((x, y) => rank(x) - rank(y))[0];
  if (!doc) return null;
  const validUntil = isoDate(doc.validUntil);
  return {
    type: asString(doc.idDocType).trim().toUpperCase(),
    country: text(doc.country),
    number: text(doc.number),
    personalNumber: text(doc.additionalNumber),
    issuedAt: isoDate(doc.issuedDate),
    expiresAt: doc.termless === true || validUntil === SUMSUB_TERMLESS ? null : validUntil,
  };
}

/** Labels → flags. `screened` = the source ran an AML check (an absent label is then a false). */
export function amlFromLabels(labels: readonly string[], screened: boolean): ApplicantAmlScreening {
  const has = (...names: string[]): boolean | null =>
    names.some((n) => labels.includes(n)) ? true : screened ? false : null;
  return {
    pep: has("pep"),
    sanctions: has("sanctions", "terrorism"),
    adverseMedia: has("adverseMedia"),
    labels: [...new Set(labels)],
  };
}

/** AML evidence on the applicant record: AML-type reject labels and `riskLabels.aml` when present. */
function sumsubApplicantAml(
  a: Record<string, unknown>,
  rejectLabels: readonly string[],
): ApplicantAmlScreening | null {
  const fromReject = rejectLabels
    .map((l) => SUMSUB_AML_REJECT_LABELS[l])
    .filter((l): l is string => Boolean(l));
  const risk = obj(a.riskLabels).aml;
  const screened = Array.isArray(risk);
  const fromRisk = screened ? riskLabelNames(risk) : [];
  if (!screened && fromReject.length === 0) return null;
  return amlFromLabels([...fromReject, ...fromRisk], screened);
}

/** Risk labels as strings or `{label | name | value}` objects. */
function riskLabelNames(list: unknown[]): string[] {
  return list
    .map((v) => {
      if (typeof v === "string") return v.trim();
      const o = obj(v);
      return asString(o.label ?? o.name ?? o.value).trim();
    })
    .filter(Boolean);
}

function sumsubIdentity(
  a: Record<string, unknown>,
  info: Record<string, unknown>,
  docs: Record<string, unknown>[],
  rejectLabels: readonly string[],
): ApplicantIdentityData {
  const document = sumsubDocument(docs);
  const primary = docs.find((d) => asString(d.idDocType).trim().toUpperCase() === document?.type);
  const addresses = Array.isArray(info.addresses) ? info.addresses.map(obj) : [];
  const addr = addresses[0] ?? obj(primary?.address);
  const hasAddress = Object.keys(addr).length > 0;
  const line =
    text(addr.formattedAddress) ??
    ([addr.street, addr.buildingNumber, addr.flatNumber, addr.subStreet, addr.postCode]
      .map(text)
      .filter(Boolean)
      .join(", ") ||
      null);
  // Citizenship: the stated nationality, else a passport's / ID card's issuing country.
  const citizenDoc = docs.find((d) =>
    ["PASSPORT", "ID_CARD"].includes(asString(d.idDocType).trim().toUpperCase()),
  );
  const permit = docs.find(
    (d) => asString(d.idDocType).trim().toUpperCase() === "RESIDENCE_PERMIT",
  );
  return {
    names: sumsubNames([info, ...docs]),
    birthPlace: text(info.placeOfBirthEn) ?? text(info.placeOfBirth) ?? text(primary?.placeOfBirth),
    birthCountry: text(info.countryOfBirth),
    nationality: text(info.nationality) ?? text(primary?.nationality) ?? text(citizenDoc?.country),
    // Residence: the proof-of-address country, else a residence permit's, else the profile country.
    residenceCountry: text(addr.country) ?? text(permit?.country) ?? text(info.country),
    address: hasAddress
      ? { country: text(addr.country), region: text(addr.state), city: text(addr.town), line }
      : null,
    document,
    aml: sumsubApplicantAml(a, rejectLabels),
  };
}

/**
 * `GET /resources/api/applicants/{id}/amlCase` → screening (SPEC §11.1). The case's hits count
 * unless an analyst marked them `false_positive`; a case without counting hits is a clean screen
 * (false flags), never "unknown".
 */
export function normaliseSumsubAmlCase(data: unknown): ApplicantAmlScreening {
  const hits = Array.isArray(obj(data).hits) ? (obj(data).hits as unknown[]).map(obj) : [];
  const labels = hits
    .filter((h) => asString(obj(h.review).matchStatus).toLowerCase() !== "false_positive")
    .flatMap((h) => (Array.isArray(h.riskLabels) ? riskLabelNames(h.riskLabels) : []));
  return amlFromLabels(labels, true);
}

/**
 * Sumsub adapter (ARCHITECTURE §9.1). Request signing, SDK tokens (one applicant per
 * externalUserId = our user id, so a token for the same user always reuses that applicant),
 * webhook digest verification over the raw body and applicant normalisation. Applicant data
 * is returned to the caller and never logged; app token, secret key and webhook secret never
 * leave this class.
 */
@Injectable()
export class KycProviderSumsubService implements KycProvider {
  readonly name = "sumsub" as const;
  private readonly logger = new Logger(KycProviderSumsubService.name);

  constructor(private readonly config: Config) {}

  isConfigured(): boolean {
    const s = this.config.sumsub;
    return Boolean(s.baseUrl && s.appToken && s.secretKey);
  }

  /**
   * SDK access token for the WebSDK. `userId` is the externalUserId Sumsub keys applicants by,
   * so a refresh (same endpoint, same user) is idempotent. When no applicant is bound yet the
   * applicant created by an earlier session is looked up by externalUserId (best effort — the
   * `applicantCreated` webhook binds it too).
   */
  async createSession(
    user: { id: string; email?: string | null },
    applicantId: string | null,
    level: string,
  ): Promise<KycSessionResult> {
    // `applicantIdentifiers` are added to the applicant profile by Sumsub (its own duplicate
    // checks and applicant notifications use them); the email is the account's verified one.
    const email = (user.email ?? "").trim();
    const body = {
      userId: user.id,
      levelName: level,
      ttlInSecs: SDK_TOKEN_TTL_SEC,
      ...(email ? { applicantIdentifiers: { email } } : {}),
    };
    const res = await this.request<{ token?: unknown }>(
      "POST",
      "/resources/accessTokens/sdk",
      body,
    );
    const token = asString(res.token);
    if (!token) throw new ApiError(502, "upstream_failed", "Sumsub returned no SDK token");
    const resolvedApplicant = applicantId ?? (await this.findApplicantByExternalUserId(user.id));
    return {
      accessToken: token,
      expiresAt: new Date(Date.now() + SDK_TOKEN_TTL_SEC * 1000),
      ...(resolvedApplicant ? { applicantId: resolvedApplicant } : {}),
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): KycEvent | null {
    const secret = this.config.sumsub.webhookSecret;
    if (!secret) {
      this.logger.warn("SUMSUB_WEBHOOK_SECRET is not configured: webhook rejected");
      return null;
    }
    if (!verifySumsubDigest(rawBody, headers, secret, this.config.sumsub.allowSha1)) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return null;
    }
    return parseSumsubEvent(payload, eventKeyOf(rawBody));
  }

  async fetchApplicant(applicantId: string): Promise<ApplicantSummary> {
    const data = await this.request<unknown>(
      "GET",
      `/resources/applicants/${encodeURIComponent(applicantId)}/one`,
    );
    return normaliseSumsubApplicant(data);
  }

  /**
   * The applicant's AML case (SPEC §11.1): `GET /resources/api/applicants/{id}/amlCase`. 404 = the
   * level runs no AML screening → null (unknown, never "clean"); any other failure throws so the
   * identity refresh fails closed.
   */
  async fetchAmlScreening(applicantId: string): Promise<ApplicantAmlScreening | null> {
    try {
      const data = await this.request<unknown>(
        "GET",
        `/resources/api/applicants/${encodeURIComponent(applicantId)}/amlCase`,
      );
      return normaliseSumsubAmlCase(data);
    } catch (err) {
      if (ApiError.is(err) && err.details?.upstreamStatus === 404) return null;
      throw err;
    }
  }

  /**
   * Operator probe (`GET /admin/kyc/provider`, `npm run kyc:check`): a signed lookup of an
   * externalUserId that cannot exist. 404 proves the token and the signature are accepted;
   * 401 / 403 / unreachable are reported as such. No applicant data is involved.
   */
  async healthCheck(): Promise<KycProviderHealth> {
    const s = this.config.sumsub;
    const base = {
      checkedAt: new Date().toISOString(),
      details: {
        baseUrl: s.baseUrl,
        sandboxToken: s.appToken.startsWith("sbx:"),
        webhookSecretConfigured: Boolean(s.webhookSecret),
        acceptedDigestAlgorithms: acceptedDigestAlgorithms(s.allowSha1),
        duplicateLabels: s.duplicateLabels,
      },
    };
    if (!this.isConfigured()) {
      return {
        ok: false,
        upstreamStatus: null,
        message: "SUMSUB_BASE_URL, SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY must all be set",
        ...base,
      };
    }
    if (!s.webhookSecret) {
      return {
        ok: false,
        upstreamStatus: null,
        message: "SUMSUB_WEBHOOK_SECRET is not set: every webhook would be rejected with 401",
        ...base,
      };
    }
    const probe = `health-${randomUUID()}`;
    try {
      await this.request<unknown>(
        "GET",
        `/resources/applicants/-;externalUserId=${encodeURIComponent(probe)}/one`,
      );
      return { ...interpretSumsubProbe(200), upstreamStatus: 200, ...base };
    } catch (err) {
      const status = err instanceof ApiError ? Number(err.details?.upstreamStatus ?? 0) : 0;
      const detail = err instanceof ApiError && status !== 0 ? "" : (err as Error).message;
      return { ...interpretSumsubProbe(status, detail), upstreamStatus: status || null, ...base };
    }
  }

  private async findApplicantByExternalUserId(userId: string): Promise<string | null> {
    try {
      const data = await this.request<{ id?: unknown }>(
        "GET",
        `/resources/applicants/-;externalUserId=${encodeURIComponent(userId)}/one`,
      );
      return asString(data.id).trim() || null;
    } catch (err) {
      if (err instanceof ApiError && err.details?.upstreamStatus === 404) return null;
      this.logger.warn(`applicant lookup failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    pathWithQuery: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new ApiError(503, "kyc_provider_unavailable", "Sumsub is not configured");
    }
    const { baseUrl, appToken, secretKey } = this.config.sumsub;
    const ts = Math.floor(Date.now() / 1000);
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-App-Token": appToken,
      "X-App-Access-Ts": String(ts),
      "X-App-Access-Sig": signSumsubRequest(secretKey, ts, method, pathWithQuery, bodyText),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${pathWithQuery}`, {
        method,
        headers,
        body: body === undefined ? undefined : bodyText,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError(502, "upstream_failed", `Sumsub unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // Error bodies carry { description, code, errorName } — no applicant data.
      let description = "";
      try {
        const e = obj(JSON.parse(text));
        description = asString(e.errorName) || asString(e.description);
      } catch {
        // not JSON: the status alone is reported
      }
      throw new ApiError(
        502,
        "upstream_failed",
        `Sumsub ${method} ${pathWithQuery.split(";")[0]} failed: HTTP ${res.status}${description ? ` ${description.slice(0, 120)}` : ""}`,
        { upstreamStatus: res.status },
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        502,
        "upstream_failed",
        `Sumsub ${method} ${pathWithQuery.split(";")[0]} returned non-JSON`,
      );
    }
  }
}
