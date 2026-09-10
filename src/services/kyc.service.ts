import { createHash, createHmac, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, In, IsNull, LessThan, Not, Repository } from "typeorm";

import { Config } from "../config";
import { KYC_DOC_TYPES, type KycMockSubmitDto } from "../dto/kyc.dto";
import { KycPersonEntity } from "../entities/kyc-person.entity";
import { KycVerificationEntity } from "../entities/kyc-verification.entity";
import { KycWebhookEventEntity } from "../entities/kyc-webhook-event.entity";
import { SETTING_KYC_PEPPER_HASH, SettingEntity } from "../entities/setting.entity";
import type { SessionEntity } from "../entities/session.entity";
import { UserEntity } from "../entities/user.entity";
import {
  type Actor,
  type ApiKycSummary,
  type ApiKycVerification,
  type ApplicantSummary,
  KYC_PROVIDER,
  type KycEvent,
  type KycLockLookup,
  type KycProvider,
  type KycProviderName,
  type KycVerificationStatus,
  NatsSubjects,
  type UserKycStatus,
  type UserStatus,
} from "../types";
import { ApiError } from "../util/errors";
import { DAY_MS } from "../util/time";
import { AuditService } from "./audit.service";
import { KycProviderMockService } from "./kyc-provider-mock.service";
import { NatsService } from "./nats.service";
import { UserService } from "./user.service";

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for unit tests; the services barrel re-exports the class only)
// ---------------------------------------------------------------------------------------------

export const FINGERPRINT_VERSION = 1;
export const IN_FLIGHT_STATUSES: readonly KycVerificationStatus[] = ["initiated", "pending", "needs_review"];
/** Statuses a provider review may still move: in flight, or a retryable rejection. */
export const REVIEWABLE_STATUSES: readonly KycVerificationStatus[] = [...IN_FLIGHT_STATUSES, "rejected_retry"];
export const ADMIN_OVERRIDE_STATUSES: readonly KycVerificationStatus[] = ["approved", "rejected_final", "expired"];
export const WEBHOOK_PAYLOAD_RETENTION_MS = 30 * DAY_MS;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const REASON_MAX = 500;

/** NFKC-normalised, upper-cased, trimmed, internal whitespace collapsed to one space. */
export function nfkcUpper(value: string): string {
  return value.normalize("NFKC").toUpperCase().trim().replace(/\s+/g, " ");
}

/** `upper(country)|upper(docType)|NFKC-upper-alnum(number)` — null when any part is unusable (§9.3). */
export function canonicalDocKey(doc: { docType: string; country: string; number: string }): string | null {
  const docType = nfkcUpper(doc.docType ?? "");
  if (!(KYC_DOC_TYPES as readonly string[]).includes(docType)) return null;
  const country = nfkcUpper(doc.country ?? "").replace(/[^A-Z]/g, "");
  const number = nfkcUpper(doc.number ?? "").replace(/[^A-Z0-9]/g, "");
  if (!country || !number) return null;
  return `${country}|${docType}|${number}`;
}

/** `upper(country)|dob(YYYY-MM-DD)|NFKC-upper(lastName)|NFKC-upper(firstName)` — null when incomplete. */
export function canonicalPersonKey(person: {
  firstName: string | null;
  lastName: string | null;
  dob: string | null;
  country: string | null;
}): string | null {
  const country = nfkcUpper(person.country ?? "").replace(/[^A-Z]/g, "");
  const dobMatch = ISO_DATE_RE.exec((person.dob ?? "").trim());
  const last = nfkcUpper(person.lastName ?? "");
  const first = nfkcUpper(person.firstName ?? "");
  if (!country || !dobMatch || !last || !first) return null;
  return `${country}|${dobMatch[1]}|${last}|${first}`;
}

/** HMAC-SHA256(pepper, canonical) hex — the only form that is ever stored. */
export function fingerprintOf(pepper: string, canonical: string): string {
  return createHmac("sha256", pepper).update(canonical, "utf8").digest("hex");
}

export interface PersonKey {
  kind: "doc" | "person";
  fingerprint: string;
}

/** Every binding key an applicant yields: one per usable document plus the person key. */
export function personKeysFor(pepper: string, summary: ApplicantSummary): PersonKey[] {
  const keys: PersonKey[] = [];
  const seen = new Set<string>();
  const push = (kind: PersonKey["kind"], canonical: string | null): void => {
    if (!canonical) return;
    const fingerprint = fingerprintOf(pepper, canonical);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    keys.push({ kind, fingerprint });
  };
  for (const doc of summary.documents) push("doc", canonicalDocKey(doc));
  push("person", canonicalPersonKey(summary.person));
  return keys;
}

/**
 * `users.kyc_status` precedence (§9.2): blocked_duplicate beats everything; a standing
 * approval is never downgraded by a later attempt; otherwise the newest attempt speaks.
 * `verifications` must be ordered newest first.
 */
export function computeUserKycStatus(
  verifications: Pick<KycVerificationEntity, "id" | "status">[],
): { status: UserKycStatus; verificationId: string | null } {
  const pick = (pred: (s: KycVerificationStatus) => boolean): Pick<KycVerificationEntity, "id" | "status"> | undefined =>
    verifications.find((v) => pred(v.status));
  const blocked = pick((s) => s === "blocked_duplicate");
  if (blocked) return { status: "blocked_duplicate", verificationId: blocked.id };
  const approved = pick((s) => s === "approved");
  if (approved) return { status: "approved", verificationId: approved.id };
  const inFlight = pick((s) => IN_FLIGHT_STATUSES.includes(s));
  if (inFlight) return { status: "pending", verificationId: inFlight.id };
  const rejected = pick((s) => s === "rejected_retry" || s === "rejected_final");
  if (rejected) return { status: "rejected", verificationId: rejected.id };
  return { status: "none", verificationId: null };
}

/** Events older than the last applied provider event are dropped (§9.2). */
export function isStaleEvent(occurredAt: Date, providerEventAt: Date | null | undefined): boolean {
  return Boolean(providerEventAt) && occurredAt.getTime() < providerEventAt!.getTime();
}

export type GateResult = { allowed: true } | { allowed: false; reason: "kyc_required" | "kyc_duplicate_identity" | "user_suspended" };

/** The §9.4 gate as a pure decision (the service supplies the facts). */
export function gateDecision(input: {
  enforce: boolean;
  userStatus: UserStatus | null;
  kycStatus: UserKycStatus;
  hasApprovedAtLevel: boolean;
  hasBinding: boolean;
}): GateResult {
  if (input.userStatus !== "active") return { allowed: false, reason: "user_suspended" };
  if (!input.enforce) return { allowed: true };
  if (input.kycStatus === "blocked_duplicate") return { allowed: false, reason: "kyc_duplicate_identity" };
  return input.hasApprovedAtLevel && input.hasBinding ? { allowed: true } : { allowed: false, reason: "kyc_required" };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** What a stored webhook row carries in `payload.event` (a KycEvent with dates as ISO strings). */
export interface StoredKycEvent extends KycEvent {
  type?: string;
  moderationComment?: string | null;
}

export type KycSessionStart =
  | { provider: "sumsub"; accessToken: string; expiresAt: string; levelName: string; verificationId: string }
  | { provider: "mock"; verificationId: string; levelName: string };

export type ApplyOutcome =
  | { outcome: "applied"; verificationId: string; status: KycVerificationStatus; changed: boolean }
  | { outcome: "skipped"; reason: string };

/** Thrown by `applyEvent` so the processor can decide between retry (nak) and give-up (term). */
export class KycEventProcessingError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "KycEventProcessingError";
  }
}

interface ProviderWithConfig extends KycProvider {
  isConfigured?(): boolean;
}

/** The colliding keys of one binding attempt, carried out of a savepoint. */
interface Collision {
  key: PersonKey;
  boundUserId: string;
}

/**
 * KYC lifecycle (ARCHITECTURE §9): sessions bound to the sign-in identity, provider events
 * ordered by `occurredAt`, approval only after the provider API confirms GREEN, one person one
 * account through peppered fingerprints, the withdrawal gate, admin override and transfer.
 * Applicant data lives in memory for one call — never logged, stored or put in audit / NATS.
 */
@Injectable()
export class KycService implements KycLockLookup {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(KycVerificationEntity) private readonly verifications: Repository<KycVerificationEntity>,
    @InjectRepository(KycPersonEntity) private readonly persons: Repository<KycPersonEntity>,
    @InjectRepository(KycWebhookEventEntity) private readonly webhookEvents: Repository<KycWebhookEventEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @Inject(KYC_PROVIDER) private readonly provider: ProviderWithConfig,
    private readonly mockProvider: KycProviderMockService,
    private readonly userService: UserService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  // ─────────────────────────────────────────────── reads ──────────────────────────────────────

  providerConfigured(): boolean {
    return typeof this.provider.isConfigured === "function" ? this.provider.isConfigured() : true;
  }

  get providerName(): KycProviderName {
    return this.provider.name;
  }

  async summaryForUser(userId: string): Promise<ApiKycSummary & { history: ApiKycVerification[] }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new ApiError(404, "not_found", "user not found");
    const history = await this.verifications.find({ where: { userId }, order: { createdAt: "DESC", attemptNo: "DESC" } });
    const current = (user.kycVerificationId ? history.find((v) => v.id === user.kycVerificationId) : undefined) ?? history[0] ?? null;
    return {
      provider: this.providerConfigured() ? this.provider.name : null,
      status: user.kycStatus,
      levelName: this.config.kycRequiredLevel,
      requiredForWithdrawal: this.config.kycEnforceWithdrawals,
      attachedIdentityId: current?.initiatedIdentityId ?? null,
      verification: current ? this.toApi(current) : null,
      history: history.map((v) => this.toApi(v)),
    };
  }

  /** §9.4: the gate is evaluated on the given (payee) account. */
  async withdrawalGate(userId: string): Promise<GateResult> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) return { allowed: false, reason: "user_suspended" };
    const hasApprovedAtLevel =
      (await this.verifications.count({ where: { userId, status: "approved", levelName: this.config.kycRequiredLevel } })) > 0;
    const hasBinding = (await this.persons.count({ where: { userId, releasedAt: IsNull() } })) > 0;
    return gateDecision({
      enforce: this.config.kycEnforceWithdrawals,
      userStatus: user.status,
      kycStatus: user.kycStatus,
      hasApprovedAtLevel,
      hasBinding,
    });
  }

  /** §6.5 / §9.5: the identity that started the standing approval cannot be unlinked. */
  async lockedIdentityId(userId: string): Promise<string | null> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user?.kycVerificationId) return null;
    const v = await this.verifications.findOne({ where: { id: user.kycVerificationId } });
    return v && v.status === "approved" ? v.initiatedIdentityId : null;
  }

  async listByStatus(status: KycVerificationStatus): Promise<KycVerificationEntity[]> {
    return this.verifications.find({ where: { status }, order: { updatedAt: "DESC" } });
  }

  async personsForUser(userId: string): Promise<KycPersonEntity[]> {
    return this.persons.find({ where: { userId }, order: { boundAt: "ASC" } });
  }

  toApi(v: KycVerificationEntity): ApiKycVerification {
    return {
      id: v.id,
      provider: v.provider as ApiKycVerification["provider"],
      levelName: v.levelName,
      attemptNo: v.attemptNo,
      status: v.status,
      rejectLabels: v.rejectLabels ?? [],
      moderationComment: v.moderationComment,
      reviewedAt: v.reviewedAt ? v.reviewedAt.toISOString() : null,
      createdAt: v.createdAt.toISOString(),
    };
  }

  // ─────────────────────────────────────────────── sessions ───────────────────────────────────

  /**
   * `POST /kyc/sessions` (§9.5): refused for blocked duplicates, 503 without a configured
   * provider. An in-flight verification is reused (the WebSDK token refresh calls the same
   * route); otherwise a new attempt is opened with `initiated_identity_id = session.auth_identity_id`.
   */
  async startSession(user: UserEntity, session: SessionEntity, actor?: Actor): Promise<KycSessionStart> {
    if (user.kycStatus === "blocked_duplicate") throw duplicateIdentityError();
    if (!this.providerConfigured()) {
      throw new ApiError(503, "kyc_provider_unavailable", "identity verification is not available right now");
    }
    const provider = this.provider.name;
    const level = this.config.kycRequiredLevel;

    const { verification, created } = await this.dataSource.transaction(async (manager) => {
      const fresh = await lockUser(manager, user.id);
      if (fresh.kycStatus === "blocked_duplicate") throw duplicateIdentityError();
      if (fresh.status !== "active") throw new ApiError(403, "user_suspended", "this account is suspended");
      const repo = manager.getRepository(KycVerificationEntity);
      const rows = await repo.find({ where: { userId: user.id, provider, levelName: level }, order: { attemptNo: "DESC" } });
      const inFlight = rows.find((r) => IN_FLIGHT_STATUSES.includes(r.status));
      if (inFlight) return { verification: inFlight, created: false };

      const attemptNo = rows.reduce((max, r) => Math.max(max, r.attemptNo), 0) + 1;
      const row = repo.create({
        userId: user.id,
        provider,
        providerApplicantId: fresh.kycProvider === provider ? fresh.kycApplicantId : null,
        levelName: level,
        attemptNo,
        status: "initiated",
        initiatedIdentityId: session.authIdentityId,
        providerEventAt: null,
        rejectLabels: null,
        moderationComment: null,
        manual: false,
        manualReason: null,
        reviewedAt: null,
      });
      await repo.save(row);
      await this.refreshUserKycStatus(manager, user.id);
      await this.audit.record(
        {
          actorType: "user",
          actorUserId: user.id,
          actorSessionId: session.id,
          action: "kyc.session_started",
          subjectType: "kyc_verification",
          subjectId: row.id,
          metadata: {
            verificationId: row.id,
            provider,
            level,
            attemptNo,
            status: row.status,
            identityId: session.authIdentityId,
            sessionKind: session.kind,
          },
          ip: actor?.ip ?? null,
        },
        manager,
      );
      return { verification: row, created: true };
    });

    // Provider call outside the DB transaction (network); applicant data is not involved here.
    const knownApplicant = user.kycProvider === provider ? user.kycApplicantId : null;
    const result = await this.provider.createSession({ id: user.id, email: user.email }, knownApplicant, level);
    if (result.applicantId && !knownApplicant) {
      await this.bindApplicant(user.id, provider, result.applicantId, verification.id);
    }
    if (created) {
      void this.publish(NatsSubjects.kycSessionStarted, { userId: user.id, verificationId: verification.id, provider });
    }
    if (provider === "mock") return { provider: "mock", verificationId: verification.id, levelName: level };
    return {
      provider: "sumsub",
      accessToken: result.accessToken,
      expiresAt: result.expiresAt.toISOString(),
      levelName: level,
      verificationId: verification.id,
    };
  }

  /** `POST /kyc/mock/submit`: the mock runs the identical pipeline (stored event → applyEvent). */
  async submitMock(user: UserEntity, dto: KycMockSubmitDto): Promise<{ verification: ApiKycVerification; userKycStatus: UserKycStatus }> {
    if (this.provider.name !== "mock") throw new ApiError(404, "not_found", "mock provider is not active");
    const verification = await this.verifications.findOne({ where: { id: dto.verificationId, userId: user.id, provider: "mock" } });
    if (!verification) throw new ApiError(404, "not_found", "verification not found");
    if (!REVIEWABLE_STATUSES.includes(verification.status)) {
      throw new ApiError(409, "bad_request", `verification is ${verification.status}; start a new session`, { status: verification.status });
    }
    const applicantId = user.kycProvider === "mock" && user.kycApplicantId ? user.kycApplicantId : KycProviderMockService.applicantIdFor(user.id);
    if (!user.kycApplicantId) await this.bindApplicant(user.id, "mock", applicantId, verification.id);

    const answer = dto.outcome === "approved" ? "GREEN" : "RED";
    const rejectType = dto.outcome === "rejected_final" ? "FINAL" : dto.outcome === "rejected_retry" ? "RETRY" : null;
    // In memory only: fingerprinted inside applyEvent and discarded right after.
    const summary: ApplicantSummary = {
      answer,
      rejectType,
      labels: [],
      levelName: verification.levelName,
      sandbox: false,
      documents: dto.documents.map((d) => ({ docType: d.docType, country: d.country, number: d.number, dob: dto.person.dob })),
      person: { firstName: dto.person.firstName, lastName: dto.person.lastName, dob: dto.person.dob, country: dto.person.country },
    };
    const event: StoredKycEvent = {
      type: "mock.submit",
      applicantId,
      externalUserId: user.id,
      levelName: verification.levelName,
      kind: "reviewed",
      answer,
      ...(rejectType ? { rejectType } : {}),
      labels: [],
      occurredAt: new Date(),
      sandbox: false,
      eventKey: createHash("sha256").update(`mock:${randomUUID()}`).digest("hex"),
      moderationComment: null,
    };
    this.mockProvider.stage(applicantId, summary);
    try {
      const stored = await this.storeWebhookEvent("mock", event, null);
      await this.applyEvent(stored.id);
    } finally {
      this.mockProvider.discard(applicantId);
    }
    const fresh = await this.verifications.findOneOrFail({ where: { id: verification.id } });
    const freshUser = await this.users.findOneOrFail({ where: { id: user.id } });
    return { verification: this.toApi(fresh), userKycStatus: freshUser.kycStatus };
  }

  // ─────────────────────────────────────────────── webhooks ───────────────────────────────────

  /**
   * Store a verified event idempotently on `event_key` (§9.2). `body` is the raw provider
   * payload with `clientComment` already stripped; the normalised event rides along so the
   * processor can re-read the row without the request headers. Both are purged after 30 days.
   */
  async storeWebhookEvent(
    provider: KycProviderName,
    event: StoredKycEvent,
    body: Record<string, unknown> | null,
  ): Promise<{ id: string; created: boolean; processed: boolean }> {
    const payload: Record<string, unknown> = {
      event: { ...event, occurredAt: event.occurredAt.toISOString() },
      ...(body ? { body } : {}),
    };
    const inserted = await this.dataSource.query<{ id: string }[]>(
      `INSERT INTO to_kyc_webhook_events (provider, event_key, type, payload, sandbox, occurred_at, received_at, attempts)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now(), 0)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [provider, event.eventKey, event.type ?? event.kind, JSON.stringify(payload), event.sandbox, event.occurredAt],
    );
    if (inserted.length > 0) {
      await this.audit.record({
        actorType: "system",
        action: "kyc.webhook_received",
        subjectType: "kyc_webhook_event",
        subjectId: inserted[0].id,
        metadata: { provider, kind: event.kind, level: event.levelName, sandbox: event.sandbox },
      });
      return { id: inserted[0].id, created: true, processed: false };
    }
    const existing = await this.webhookEvents.findOneOrFail({ where: { eventKey: event.eventKey } });
    return { id: existing.id, created: false, processed: existing.processedAt !== null };
  }

  /** `{ eventId }` on `truthoracle.kyc.webhook.<provider>`; `msgId` dedups within JetStream's window. */
  async publishWebhookTrigger(provider: KycProviderName, eventId: string, msgId: string): Promise<void> {
    await this.nats.publish(NatsSubjects.kycWebhook(provider), { eventId }, { msgId });
  }

  /**
   * Apply one stored event (the durable consumer's unit of work). Expected conditions —
   * stale, sandbox on mainnet, unknown user, provider mismatch — are recorded on the row and
   * return `skipped`; infrastructure / provider failures throw `KycEventProcessingError`.
   */
  async applyEvent(eventRowId: string): Promise<ApplyOutcome> {
    const row = await this.webhookEvents.findOne({ where: { id: eventRowId } });
    if (!row) return { outcome: "skipped", reason: "unknown_event" };
    if (row.processedAt) return { outcome: "skipped", reason: "already_processed" };
    const attempts = row.attempts + 1;
    await this.webhookEvents.update({ id: row.id }, { attempts });
    try {
      const outcome = await this.applyRow(row);
      await this.webhookEvents.update(
        { id: row.id },
        { processedAt: new Date(), error: outcome.outcome === "skipped" ? outcome.reason : null },
      );
      if (outcome.outcome === "skipped") {
        this.logger.log(`event ${row.id} (${row.provider}) skipped: ${outcome.reason}`);
      }
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.webhookEvents.update({ id: row.id }, { error: message.slice(0, 500) }).catch(() => undefined);
      const retryable = !(err instanceof ApiError) || err.status >= 500;
      throw new KycEventProcessingError(message, attempts, retryable);
    }
  }

  private async applyRow(row: KycWebhookEventEntity): Promise<ApplyOutcome> {
    if (row.sandbox && this.config.isMainnet) return { outcome: "skipped", reason: "sandbox_event_ignored_on_mainnet" };
    const event = eventFromRow(row);
    if (!event) return { outcome: "skipped", reason: "payload_unavailable" };
    if (row.provider !== this.provider.name) return { outcome: "skipped", reason: "provider_mismatch" };
    const level = this.config.kycRequiredLevel;
    if (event.levelName && event.levelName !== level) return { outcome: "skipped", reason: "level_mismatch" };
    if (!isUuid(event.externalUserId)) return { outcome: "skipped", reason: "unknown_user" };

    // The webhook is only a trigger: an approval is decided by the provider API's answer.
    let summary: ApplicantSummary | null = null;
    if (event.kind === "reviewed" && event.answer === "GREEN" && event.applicantId) {
      summary = await this.provider.fetchApplicant(event.applicantId);
    }

    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(UserEntity);
      const user = await userRepo.findOne({ where: { id: event.externalUserId }, lock: { mode: "pessimistic_write" } });
      if (!user) return { outcome: "skipped", reason: "unknown_user" };

      // Applicant ↔ user binding (unique per provider): learn it from the first event, then insist on it.
      if (user.kycProvider === row.provider && user.kycApplicantId) {
        if (event.applicantId && user.kycApplicantId !== event.applicantId) return { outcome: "skipped", reason: "applicant_mismatch" };
      } else if (event.applicantId) {
        const taken = await userRepo.findOne({ where: { kycProvider: row.provider, kycApplicantId: event.applicantId } });
        if (taken && taken.id !== user.id) return { outcome: "skipped", reason: "applicant_bound_elsewhere" };
        await userRepo.update({ id: user.id }, { kycProvider: row.provider, kycApplicantId: event.applicantId });
        user.kycProvider = row.provider;
        user.kycApplicantId = event.applicantId;
      }

      const repo = manager.getRepository(KycVerificationEntity);
      const verification = await this.targetVerification(manager, user.id, row.provider, level);
      if (!verification) return { outcome: "skipped", reason: "no_verification" };
      if (isStaleEvent(event.occurredAt, verification.providerEventAt)) return { outcome: "skipped", reason: "stale_event" };
      if (event.applicantId && !verification.providerApplicantId) verification.providerApplicantId = event.applicantId;

      const before = verification.status;
      const next = await this.transition(manager, user, verification, event, summary);
      verification.providerEventAt = event.occurredAt;
      if (next.status !== before) {
        verification.status = next.status;
        verification.reviewedAt = next.reviewed ? event.occurredAt : verification.reviewedAt;
      }
      if (next.rejectLabels !== undefined) verification.rejectLabels = next.rejectLabels;
      if (next.moderationComment !== undefined) verification.moderationComment = next.moderationComment;
      await repo.save(verification);

      const changed = next.status !== before;
      if (changed) await this.recordStatusChange(manager, user.id, verification, { type: "system" }, next.collisions);
      return { outcome: "applied", verificationId: verification.id, status: verification.status, changed };
    });
  }

  /** The verification a provider event addresses: the open attempt, else the newest one. */
  private async targetVerification(
    manager: EntityManager,
    userId: string,
    provider: string,
    levelName: string,
  ): Promise<KycVerificationEntity | null> {
    const rows = await manager
      .getRepository(KycVerificationEntity)
      .find({ where: { userId, provider, levelName }, order: { attemptNo: "DESC" } });
    return rows.find((r) => REVIEWABLE_STATUSES.includes(r.status)) ?? rows[0] ?? null;
  }

  /**
   * The §9.2 state machine for one event against one verification. Returns the resulting
   * status (possibly unchanged) and, on a local duplicate, the colliding keys.
   */
  private async transition(
    manager: EntityManager,
    user: UserEntity,
    verification: KycVerificationEntity,
    event: StoredKycEvent,
    summary: ApplicantSummary | null,
  ): Promise<{
    status: KycVerificationStatus;
    reviewed?: boolean;
    rejectLabels?: string[] | null;
    moderationComment?: string | null;
    collisions?: Collision[];
  }> {
    const current = verification.status;
    const inFlight = IN_FLIGHT_STATUSES.includes(current);
    const comment = event.moderationComment === undefined ? undefined : event.moderationComment;

    switch (event.kind) {
      case "created":
        return { status: current };
      case "pending":
        return { status: inFlight ? "pending" : current };
      case "onHold":
        return { status: inFlight ? "needs_review" : current, moderationComment: comment };
      case "reset":
        // The provider withdrew the applicant: a standing approval ends, an open attempt restarts.
        if (current === "approved") return { status: "expired", reviewed: true };
        if (inFlight || current === "rejected_retry") return { status: "initiated", rejectLabels: null, moderationComment: null };
        return { status: current };
      case "reviewed":
        return this.review(manager, user, verification, event, summary);
      default:
        return { status: current };
    }
  }

  private async review(
    manager: EntityManager,
    user: UserEntity,
    verification: KycVerificationEntity,
    event: StoredKycEvent,
    summary: ApplicantSummary | null,
  ): Promise<{
    status: KycVerificationStatus;
    reviewed?: boolean;
    rejectLabels?: string[] | null;
    moderationComment?: string | null;
    collisions?: Collision[];
  }> {
    const current = verification.status;
    const comment = event.moderationComment ?? null;

    // A standing approval can only be withdrawn by the provider (→ expired) or re-confirmed.
    if (current === "approved") {
      if (event.answer === "RED") return { status: "expired", reviewed: true, rejectLabels: event.labels, moderationComment: comment };
      return { status: current };
    }
    if (!REVIEWABLE_STATUSES.includes(current)) return { status: current };

    // The provider's own duplicate detection (SUMSUB_DUPLICATE_LABELS) — from the webhook or the API read.
    const labels = summary?.labels.length ? summary.labels : event.labels;
    if (this.isDuplicateLabel(labels)) {
      return { status: "blocked_duplicate", reviewed: true, rejectLabels: labels, moderationComment: comment };
    }

    if (event.answer !== "GREEN") {
      const rejectType = event.rejectType ?? "RETRY";
      return { status: rejectType === "FINAL" ? "rejected_final" : "rejected_retry", reviewed: true, rejectLabels: labels, moderationComment: comment };
    }

    // GREEN on the webhook: only the provider API decides. Not GREEN there → never approved.
    if (!summary) return { status: "needs_review", rejectLabels: labels, moderationComment: comment };
    if (summary.answer === "RED") {
      return {
        status: summary.rejectType === "FINAL" ? "rejected_final" : "rejected_retry",
        reviewed: true,
        rejectLabels: summary.labels,
        moderationComment: comment,
      };
    }
    if (summary.answer !== "GREEN" || summary.levelName !== this.config.kycRequiredLevel) {
      return { status: "needs_review", rejectLabels: labels, moderationComment: comment };
    }
    if (summary.sandbox && this.config.isMainnet) return { status: "needs_review", moderationComment: comment };

    const keys = personKeysFor(this.config.kycFingerprintPepper, summary);
    if (!keys.some((k) => k.kind === "doc")) return { status: "needs_review", rejectLabels: null, moderationComment: comment };

    const collisions = await this.bindKeys(manager, user.id, verification.id, keys);
    if (collisions.length > 0) {
      return { status: "blocked_duplicate", reviewed: true, rejectLabels: ["DUPLICATE"], moderationComment: comment, collisions };
    }
    return { status: "approved", reviewed: true, rejectLabels: null, moderationComment: comment };
  }

  private isDuplicateLabel(labels: string[]): boolean {
    const dup = this.config.sumsub.duplicateLabels;
    return labels.some((l) => dup.includes(l.toUpperCase()));
  }

  // ─────────────────────────────────────────────── bindings ───────────────────────────────────

  /**
   * §9.3 binding under a savepoint: `INSERT … ON CONFLICT DO NOTHING`, then read the row.
   * Same user (or a released row) proceeds; another user's live row is a collision, in which
   * case every insert of this attempt is rolled back so no partial binding survives.
   */
  private async bindKeys(manager: EntityManager, userId: string, verificationId: string, keys: PersonKey[]): Promise<Collision[]> {
    const qr = manager.queryRunner;
    if (!qr) throw new Error("bindKeys requires a transactional EntityManager");
    await qr.query("SAVEPOINT kyc_bind");
    const collisions: Collision[] = [];
    const repo = manager.getRepository(KycPersonEntity);
    for (const key of keys) {
      await manager.query(
        `INSERT INTO to_kyc_persons (fingerprint, kind, user_id, verification_id, fingerprint_version, bound_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (fingerprint) DO NOTHING`,
        [key.fingerprint, key.kind, userId, verificationId, FINGERPRINT_VERSION],
      );
      const row = await repo.findOne({ where: { fingerprint: key.fingerprint } });
      if (!row) throw new Error("kyc person row vanished after insert");
      if (row.userId === userId && !row.releasedAt) continue;
      if (row.releasedAt) {
        // A released binding (transfer / pepper rotation) is free to take.
        await repo.update(
          { fingerprint: key.fingerprint },
          { userId, verificationId, boundAt: new Date(), releasedAt: null, releasedBy: null, releaseReason: null, fingerprintVersion: FINGERPRINT_VERSION },
        );
        continue;
      }
      collisions.push({ key, boundUserId: row.userId });
    }
    if (collisions.length > 0) {
      await qr.query("ROLLBACK TO SAVEPOINT kyc_bind");
    } else {
      await qr.query("RELEASE SAVEPOINT kyc_bind");
    }
    return collisions;
  }

  private async bindApplicant(userId: string, provider: string, applicantId: string, verificationId: string): Promise<void> {
    try {
      await this.users.update({ id: userId, kycApplicantId: IsNull() }, { kycProvider: provider, kycApplicantId: applicantId });
      await this.verifications.update({ id: verificationId, providerApplicantId: IsNull() }, { providerApplicantId: applicantId });
      await this.userService.invalidate(userId);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(409, "kyc_duplicate_identity", "this verification applicant is already bound to another account");
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────── admin ──────────────────────────────────────

  /**
   * `POST /admin/users/:id/kyc/override`: a `provider = admin` verification. An approval binds
   * the person keys re-read from the provider and is refused (409) when they belong to another
   * account — the transfer action exists for that. Rejections / expiries retire the standing
   * approval so the precedence drops.
   */
  async adminOverride(userId: string, status: KycVerificationStatus, reason: string, actor: Actor): Promise<KycVerificationEntity> {
    if (!ADMIN_OVERRIDE_STATUSES.includes(status)) {
      throw new ApiError(400, "validation_failed", "status must be approved, rejected_final or expired");
    }
    const cleanReason = clipReason(reason);
    if (!cleanReason) throw new ApiError(400, "validation_failed", "reason is required");
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new ApiError(404, "not_found", "user not found");

    let keys: PersonKey[] = [];
    if (status === "approved" && user.kycApplicantId && user.kycProvider === this.provider.name) {
      // Fail closed: without the provider's data there is nothing to bind, so retry later.
      const summary = await this.provider.fetchApplicant(user.kycApplicantId);
      keys = personKeysFor(this.config.kycFingerprintPepper, summary);
    }
    const level = this.config.kycRequiredLevel;

    const verification = await this.dataSource.transaction(async (manager) => {
      await lockUser(manager, userId);
      const repo = manager.getRepository(KycVerificationEntity);
      const attemptNo = await this.nextAttempt(manager, userId, "admin", level);
      const now = new Date();
      const row = repo.create({
        userId,
        provider: "admin",
        providerApplicantId: user.kycApplicantId,
        levelName: level,
        attemptNo,
        status,
        initiatedIdentityId: null,
        providerEventAt: now,
        rejectLabels: null,
        moderationComment: null,
        manual: true,
        manualReason: cleanReason,
        reviewedAt: now,
      });
      await repo.save(row);

      if (status === "approved") {
        if (keys.length > 0) {
          const collisions = await this.bindKeys(manager, userId, row.id, keys);
          if (collisions.length > 0) {
            throw new ApiError(409, "kyc_duplicate_identity", "this person is bound to another account; transfer the binding first", {
              fingerprints: collisions.map((c) => c.key.fingerprint),
            });
          }
        }
        // The admin decision supersedes a standing duplicate block and closes open attempts.
        await repo.update({ userId, status: In(["blocked_duplicate", ...IN_FLIGHT_STATUSES]) }, { status: "expired", manual: true, manualReason: cleanReason });
      } else {
        await repo.update({ userId, status: "approved" }, { status: "expired", manual: true, manualReason: cleanReason });
        if (status === "rejected_final") {
          await repo.update({ userId, status: In([...IN_FLIGHT_STATUSES, "rejected_retry"]) }, { status: "rejected_final", manual: true, manualReason: cleanReason });
        }
      }
      const userStatus = await this.refreshUserKycStatus(manager, userId);
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "kyc.admin_override",
          subjectType: "user",
          subjectId: userId,
          metadata: { verificationId: row.id, provider: "admin", level, status, attemptNo, reason: cleanReason },
          ip: actor.ip ?? null,
        },
        manager,
      );
      void this.publish(NatsSubjects.kycStatusChanged, { userId, verificationId: row.id, provider: "admin", status, userKycStatus: userStatus });
      return row;
    });
    return verification;
  }

  /**
   * `POST /admin/kyc/persons/:fingerprint/transfer`: move the verified person — every key
   * bound by the same verification — to another account. The target's blocked attempt
   * becomes approved (or an admin approval is created), the source approval expires.
   */
  async transferPerson(fingerprint: string, toUserId: string, reason: string, actor: Actor): Promise<void> {
    const cleanReason = clipReason(reason);
    if (!cleanReason) throw new ApiError(400, "validation_failed", "reason is required");
    const outcome = await this.dataSource.transaction(async (manager) => {
      const personRepo = manager.getRepository(KycPersonEntity);
      const repo = manager.getRepository(KycVerificationEntity);
      const anchor = await personRepo.findOne({ where: { fingerprint } });
      if (!anchor) throw new ApiError(404, "not_found", "no binding with this fingerprint");
      const fromUserId = anchor.userId;
      const toUser = await lockUser(manager, toUserId);
      if (fromUserId === toUserId && !anchor.releasedAt) {
        throw new ApiError(409, "bad_request", "this person is already bound to that account");
      }
      if (fromUserId !== toUserId) await lockUser(manager, fromUserId);

      const siblings = await personRepo.find({ where: { verificationId: anchor.verificationId } });
      const now = new Date();
      const level = this.config.kycRequiredLevel;

      // Target verification on the receiving account.
      const targets = await repo.find({ where: { userId: toUserId }, order: { createdAt: "DESC" } });
      let target = targets.find((v) => v.status === "blocked_duplicate") ?? targets.find((v) => v.status === "approved") ?? null;
      if (target && target.status === "blocked_duplicate") {
        target.status = "approved";
        target.reviewedAt = now;
        target.rejectLabels = null;
        target.manual = true;
        target.manualReason = `person transfer: ${cleanReason}`;
        await repo.save(target);
      } else if (!target) {
        target = repo.create({
          userId: toUserId,
          provider: "admin",
          providerApplicantId: toUser.kycApplicantId,
          levelName: level,
          attemptNo: await this.nextAttempt(manager, toUserId, "admin", level),
          status: "approved",
          initiatedIdentityId: null,
          providerEventAt: now,
          rejectLabels: null,
          moderationComment: null,
          manual: true,
          manualReason: `person transfer: ${cleanReason}`,
          reviewedAt: now,
        });
        await repo.save(target);
      }

      for (const s of siblings) {
        await personRepo.update(
          { fingerprint: s.fingerprint },
          { userId: toUserId, verificationId: target.id, boundAt: now, releasedAt: null, releasedBy: null, releaseReason: null },
        );
      }

      // The source approval no longer has a person behind it.
      if (fromUserId !== toUserId) {
        const source = await repo.findOne({ where: { id: anchor.verificationId } });
        if (source && source.status === "approved") {
          source.status = "expired";
          source.manual = true;
          source.manualReason = `person transferred: ${cleanReason}`;
          await repo.save(source);
        }
      }

      const toStatus = await this.refreshUserKycStatus(manager, toUserId);
      const fromStatus = fromUserId !== toUserId ? await this.refreshUserKycStatus(manager, fromUserId) : toStatus;
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "kyc.person_transferred",
          subjectType: "kyc_person",
          subjectId: fingerprint,
          metadata: {
            fingerprints: siblings.map((s) => s.fingerprint),
            fromUserId,
            toUserId,
            verificationId: target.id,
            reason: cleanReason,
          },
          ip: actor.ip ?? null,
        },
        manager,
      );
      return { fromUserId, toUserId, targetId: target.id, toStatus, fromStatus };
    });

    void this.publish(NatsSubjects.kycStatusChanged, {
      userId: outcome.toUserId,
      verificationId: outcome.targetId,
      provider: "admin",
      status: "approved",
      userKycStatus: outcome.toStatus,
    });
    if (outcome.fromUserId !== outcome.toUserId) {
      void this.publish(NatsSubjects.kycStatusChanged, {
        userId: outcome.fromUserId,
        verificationId: null,
        provider: "admin",
        status: "expired",
        userKycStatus: outcome.fromStatus,
      });
    }
  }

  // ─────────────────────────────────────────────── housekeeping ───────────────────────────────

  /** §9.7: webhook payloads (raw body + normalised event) are nulled after 30 days. */
  async purgeWebhookPayloads(retentionMs = WEBHOOK_PAYLOAD_RETENTION_MS): Promise<number> {
    const cutoff = new Date(Date.now() - retentionMs);
    const result = await this.webhookEvents.update({ receivedAt: LessThan(cutoff), payload: Not(IsNull()) }, { payload: null });
    return result.affected ?? 0;
  }

  /**
   * §9.6 boot hook: record `sha256(KYC_FINGERPRINT_PEPPER)` on first boot, refuse a silent
   * rotation afterwards (throws), accept an acknowledged one. AppService may delegate here.
   */
  async checkPepperSetting(): Promise<"initialised" | "ok" | "rotated"> {
    const repo = this.dataSource.getRepository(SettingEntity);
    const expected = this.config.kycPepperHash;
    const row = await repo.findOne({ where: { key: SETTING_KYC_PEPPER_HASH } });
    if (!row) {
      await repo.insert({ key: SETTING_KYC_PEPPER_HASH, value: expected });
      return "initialised";
    }
    if (row.value === expected) return "ok";
    if (this.config.kycPepperRotationAck === expected) {
      await repo.update({ key: SETTING_KYC_PEPPER_HASH }, { value: expected });
      this.logger.warn("KYC_FINGERPRINT_PEPPER rotated: existing to_kyc_persons rows carry the old pepper (docs/KYC.md runbook)");
      return "rotated";
    }
    throw new Error(
      "Refusing to boot: KYC_FINGERPRINT_PEPPER does not match to_settings.kyc_pepper_hash. Set KYC_PEPPER_ROTATION_ACK=<sha256 hex of the new pepper> to acknowledge a rotation (docs/KYC.md).",
    );
  }

  /** Unprocessed rows the sweep may re-publish (attempt cap applied by the caller). */
  async unprocessedWebhookEvents(olderThanMs: number, maxAttempts: number): Promise<KycWebhookEventEntity[]> {
    return this.webhookEvents.find({
      where: { processedAt: IsNull(), receivedAt: LessThan(new Date(Date.now() - olderThanMs)), attempts: LessThan(maxAttempts) },
      order: { receivedAt: "ASC" },
      take: 200,
    });
  }

  // ─────────────────────────────────────────────── internals ──────────────────────────────────

  private async nextAttempt(manager: EntityManager, userId: string, provider: string, levelName: string): Promise<number> {
    const rows = await manager.getRepository(KycVerificationEntity).find({ where: { userId, provider, levelName }, order: { attemptNo: "DESC" }, take: 1 });
    return (rows[0]?.attemptNo ?? 0) + 1;
  }

  /** Recompute `users.kyc_status` / `kyc_verification_id` from every verification of the user. */
  private async refreshUserKycStatus(manager: EntityManager, userId: string): Promise<UserKycStatus> {
    const rows = await manager.getRepository(KycVerificationEntity).find({ where: { userId }, order: { createdAt: "DESC", attemptNo: "DESC" } });
    const { status, verificationId } = computeUserKycStatus(rows);
    await manager.getRepository(UserEntity).update({ id: userId }, { kycStatus: status, kycVerificationId: verificationId });
    await this.userService.invalidate(userId);
    return status;
  }

  private async recordStatusChange(
    manager: EntityManager,
    userId: string,
    verification: KycVerificationEntity,
    actor: Actor,
    collisions?: Collision[],
  ): Promise<void> {
    const userStatus = await this.refreshUserKycStatus(manager, userId);
    const metadata = {
      verificationId: verification.id,
      provider: verification.provider,
      level: verification.levelName,
      status: verification.status,
      rejectType: verification.status === "rejected_final" ? "FINAL" : verification.status === "rejected_retry" ? "RETRY" : null,
      labels: verification.rejectLabels ?? [],
      attemptNo: verification.attemptNo,
    };
    const base = { actorType: actor.type, actorUserId: actor.userId ?? null, actorSessionId: actor.sessionId ?? null, ip: actor.ip ?? null };
    await this.audit.record({ ...base, action: "kyc.status_changed", subjectType: "user", subjectId: userId, metadata }, manager);
    if (verification.status === "needs_review") {
      await this.audit.record({ ...base, action: "kyc.needs_review", subjectType: "kyc_verification", subjectId: verification.id, metadata }, manager);
    }
    if (verification.status === "blocked_duplicate") {
      await this.audit.record(
        {
          ...base,
          action: "kyc.duplicate_detected",
          subjectType: "kyc_verification",
          subjectId: verification.id,
          // Fingerprints are opaque binding ids (needed for the transfer action) — never raw values.
          metadata: { ...metadata, fingerprints: (collisions ?? []).map((c) => c.key.fingerprint) },
        },
        manager,
      );
      void this.publish(NatsSubjects.kycDuplicateDetected, { userId, verificationId: verification.id, provider: verification.provider });
    }
    void this.publish(NatsSubjects.kycStatusChanged, {
      userId,
      verificationId: verification.id,
      provider: verification.provider,
      status: verification.status,
      userKycStatus: userStatus,
    });
  }

  private async publish(subject: `truthoracle.${string}`, payload: object): Promise<void> {
    try {
      await this.nats.publish(subject, payload);
    } catch (err) {
      this.logger.warn(`publish ${subject} failed: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------------------------

function duplicateIdentityError(): ApiError {
  return new ApiError(
    409,
    "kyc_duplicate_identity",
    "identity verification is blocked for this account because the verified person is already registered; contact support",
  );
}

function clipReason(reason: string): string {
  return typeof reason === "string" ? reason.trim().slice(0, REASON_MAX) : "";
}

async function lockUser(manager: EntityManager, userId: string): Promise<UserEntity> {
  const user = await manager.getRepository(UserEntity).findOne({ where: { id: userId }, lock: { mode: "pessimistic_write" } });
  if (!user) throw new ApiError(404, "not_found", "user not found");
  return user;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/** Rebuild the KycEvent stored in `payload.event` (null once the payload was purged). */
export function eventFromRow(row: Pick<KycWebhookEventEntity, "payload" | "occurredAt" | "sandbox" | "eventKey" | "type">): StoredKycEvent | null {
  const raw = row.payload?.event;
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const answer = e.answer === "GREEN" || e.answer === "RED" ? e.answer : undefined;
  const rejectType = e.rejectType === "RETRY" || e.rejectType === "FINAL" ? e.rejectType : undefined;
  const kind = e.kind;
  const occurred = typeof e.occurredAt === "string" ? new Date(e.occurredAt) : row.occurredAt;
  return {
    type: str(e.type) || row.type,
    applicantId: str(e.applicantId),
    externalUserId: str(e.externalUserId),
    levelName: str(e.levelName),
    kind: kind === "created" || kind === "pending" || kind === "reviewed" || kind === "onHold" || kind === "reset" ? kind : "unknown",
    ...(answer ? { answer } : {}),
    ...(rejectType ? { rejectType } : {}),
    labels: Array.isArray(e.labels) ? e.labels.filter((l): l is string => typeof l === "string") : [],
    occurredAt: Number.isFinite(occurred.getTime()) ? occurred : row.occurredAt,
    sandbox: e.sandbox === true || row.sandbox,
    eventKey: str(e.eventKey) || row.eventKey,
    moderationComment: typeof e.moderationComment === "string" ? e.moderationComment.slice(0, 500) : null,
  };
}
