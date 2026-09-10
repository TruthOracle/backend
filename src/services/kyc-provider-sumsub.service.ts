import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type { ApplicantSummary, KycEvent, KycEventKind, KycProvider, KycSessionResult } from "../types";
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
  applicantReviewed: "reviewed",
  applicantWorkflowCompleted: "reviewed",
  applicantOnHold: "onHold",
  applicantReset: "reset",
  applicantDeleted: "reset",
  applicantDeactivated: "reset",
};

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
  const raw = headers[name] ?? headers[name.toLowerCase()];
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
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  return {
    answer,
    rejectType: answer === "RED" ? rejectType(result.reviewRejectType) : null,
    labels: stringList(result.rejectLabels),
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
  };
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
    const body = { userId: user.id, levelName: level, ttlInSecs: SDK_TOKEN_TTL_SEC };
    const res = await this.request<{ token?: unknown }>("POST", "/resources/accessTokens/sdk", body);
    const token = asString(res.token);
    if (!token) throw new ApiError(502, "upstream_failed", "Sumsub returned no SDK token");
    const resolvedApplicant = applicantId ?? (await this.findApplicantByExternalUserId(user.id));
    return {
      accessToken: token,
      expiresAt: new Date(Date.now() + SDK_TOKEN_TTL_SEC * 1000),
      ...(resolvedApplicant ? { applicantId: resolvedApplicant } : {}),
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): KycEvent | null {
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
    const data = await this.request<unknown>("GET", `/resources/applicants/${encodeURIComponent(applicantId)}/one`);
    return normaliseSumsubApplicant(data);
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

  private async request<T>(method: "GET" | "POST", pathWithQuery: string, body?: unknown): Promise<T> {
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
      throw new ApiError(502, "upstream_failed", `Sumsub ${method} ${pathWithQuery.split(";")[0]} returned non-JSON`);
    }
  }
}
