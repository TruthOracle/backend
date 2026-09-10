import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, IsNull, Repository } from "typeorm";

import type { AdminKycOverrideStatus } from "../dto/admin.dto";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import type { AuthIdentityEntity } from "../entities/auth-identity.entity";
import { KycPersonEntity } from "../entities/kyc-person.entity";
import { KycVerificationEntity } from "../entities/kyc-verification.entity";
import { UserEntity } from "../entities/user.entity";
import type {
  Actor,
  ApiAuditEvent,
  ApiIdentity,
  ApiKycSummary,
  ApiKycVerification,
  ApiPage,
  ApiPayout,
  ApiSession,
  ApiUser,
  ApiWallet,
  IdentityProvider,
  KycProviderName,
  KycVerificationStatus,
  PayoutStatus,
} from "../types";
import { ApiError, errors } from "../util/errors";
import { toIso } from "../util/time";
import { AuditService } from "./audit.service";
import { IdentityService } from "./identity.service";
import { KycService } from "./kyc.service";
import { LedgerClientService } from "./ledger-client.service";
import { PayoutService } from "./payout.service";
import { SessionService } from "./session.service";
import { UserService } from "./user.service";
import { WalletLinkService } from "./wallet-link.service";

/** The acting operator — always an admin session (AdminGuard), always on the audit row. */
export interface AdminActor extends Actor {
  type: "admin";
  userId: string;
  sessionId: string;
  ip: string | null;
}

/** `GET /admin/users/:id` (docs/API.md "Admin"). */
export interface AdminUserDetail {
  user: ApiUser;
  identities: ApiIdentity[];
  wallets: ApiWallet[];
  kyc: ApiKycSummary & { history: ApiKycVerification[] };
  sessions: ApiSession[];
  payouts: ApiPayout[];
  persons: { fingerprint: string; kind: "doc" | "person"; boundAt: string }[];
}

export type AdminKycQueueItem = ApiKycVerification & { userId: string };

export interface AdminAuditFilter {
  subjectType?: string;
  subjectId?: string;
  actorUserId?: string;
  page: number;
  limit: number;
}

const MAX_PAGE_LIMIT = 100;
/** Queue listings are unpaged in the API; newest first, capped so a runaway queue cannot flood the UI. */
const KYC_QUEUE_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Operator API composition (docs/ARCHITECTURE.md §1.5, §11; docs/API.md "Admin"). Every
 * mutation runs through the owning service with an `admin` actor so the rules (§6, §9) and the
 * audit rows are the same ones the user-facing routes exercise. Where a seam cannot carry the
 * operator's reason (`SessionService.revokeAllForUser`, `IdentityService.unlink/reattach`) this
 * service writes the audit row itself, with the reason, under the same action name.
 */
@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(KycVerificationEntity)
    private readonly verifications: Repository<KycVerificationEntity>,
    @InjectRepository(KycPersonEntity) private readonly persons: Repository<KycPersonEntity>,
    private readonly users: UserService,
    private readonly identities: IdentityService,
    private readonly sessions: SessionService,
    private readonly walletLinks: WalletLinkService,
    private readonly kyc: KycService,
    private readonly payouts: PayoutService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerClientService,
  ) {}

  // ─────────────────────────────────────────── users ───────────────────────────────────────────

  /**
   * `GET /admin/users?q=&page=`. A UUID matches an account id exactly; anything else is a
   * case-insensitive substring match over display name, email, primary party, every sign-in
   * identity (subject / email) and every linked wallet party — active or revoked.
   */
  async listUsers(q: string, page: number, limit: number): Promise<ApiPage<ApiUser>> {
    const p = normalisePage(page);
    const l = normaliseLimit(limit);
    const term = (q ?? "").trim();

    const qb = this.userRepo.createQueryBuilder("u");
    if (UUID_RE.test(term)) {
      qb.where("u.id = :id", { id: term });
    } else if (term) {
      const like = `%${escapeLike(term)}%`;
      qb.where(
        new Brackets((b) => {
          b.where("u.display_name ILIKE :like", { like })
            .orWhere("u.email ILIKE :like")
            .orWhere("u.party_id ILIKE :like")
            .orWhere(
              "EXISTS (SELECT 1 FROM to_auth_identities i WHERE i.user_id = u.id AND (i.subject ILIKE :like OR i.email ILIKE :like))",
            )
            .orWhere(
              "EXISTS (SELECT 1 FROM to_wallets w WHERE w.user_id = u.id AND w.party_id ILIKE :like)",
            );
        }),
      );
    }
    const [rows, total] = await qb
      .orderBy("u.createdAt", "DESC")
      .addOrderBy("u.id", "ASC")
      .skip((p - 1) * l)
      .take(l)
      .getManyAndCount();
    return { items: rows.map((u) => this.users.toApi(u)), page: p, limit: l, total };
  }

  /** `GET /admin/users/:id` — the whole account in one read. */
  async userDetail(userId: string): Promise<AdminUserDetail> {
    const user = await this.requireUser(userId);
    const [identities, walletRows, kyc, sessionRows, payoutRows, personRows, lockedIdentityId] =
      await Promise.all([
        this.identities.listForUser(userId),
        this.walletLinks.listForUser(userId),
        this.kyc.summaryForUser(userId),
        this.sessions.listForUser(userId),
        this.payouts.listForUser(userId),
        this.persons.find({ where: { userId, releasedAt: IsNull() }, order: { boundAt: "ASC" } }),
        this.kyc.lockedIdentityId(userId),
      ]);

    // A non-primary party may own its own on-ledger UserWallet (§8.1); the primary's IS the in-app wallet.
    const wallets = await Promise.all(
      walletRows.map(async (w) =>
        this.walletLinks.toApi(w, {
          ownLedgerWallet: w.isPrimary ? null : await this.ledger.fetchUserWallet(w.partyId),
        }),
      ),
    );

    const providerOf = new Map<string, IdentityProvider>(identities.map((i) => [i.id, i.provider]));
    const sessions = await Promise.all(
      sessionRows.map(async (s) =>
        this.sessions.toApi(s, await this.sessionProvider(s.authIdentityId, providerOf), null),
      ),
    );

    const activeCids = payoutRows.length > 0 ? await this.activePayoutCids() : new Set<string>();

    return {
      user: this.users.toApi(user),
      identities: identities.map((i) => this.identities.toApi(i, lockedIdentityId)),
      wallets,
      kyc,
      sessions,
      payouts: payoutRows.map((p) => this.payouts.toApi(p, activeCids.has(p.pendingPayoutCid))),
      persons: personRows.map((p) => ({
        fingerprint: p.fingerprint,
        kind: p.kind,
        boundAt: p.boundAt.toISOString(),
      })),
    };
  }

  /** `POST /admin/users/:id/suspend` — UserService revokes every session and audits the reason. */
  async suspend(userId: string, reason: string, actor: AdminActor): Promise<{ ok: true }> {
    await this.users.suspend(userId, reason, actor);
    return { ok: true };
  }

  /** `POST /admin/users/:id/reinstate` */
  async reinstate(userId: string, reason: string, actor: AdminActor): Promise<{ ok: true }> {
    await this.users.reinstate(userId, reason, actor);
    return { ok: true };
  }

  /** `POST /admin/users/:id/sessions/revoke` — every live session, immediately (per-user index §6.6). */
  async revokeSessions(userId: string, reason: string, actor: AdminActor): Promise<{ ok: true }> {
    await this.requireUser(userId);
    const revoked = await this.sessions.revokeAllForUser(userId);
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action: "session.revoked_all",
      subjectType: "user",
      subjectId: userId,
      metadata: { reason, revoked },
      ip: actor.ip,
    });
    return { ok: true };
  }

  // ───────────────────────────────────────── identities ────────────────────────────────────────

  /**
   * `POST /admin/users/:id/identities/:identityId/unlink`. Admins bypass the KYC lock (§6.5) but
   * not the last-identity / primary-wallet rules — those are enforced by IdentityService for
   * every actor. Sessions authenticated by the identity die with it.
   */
  async unlinkIdentity(
    userId: string,
    identityId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<{ identity: ApiIdentity }> {
    await this.requireUser(userId);
    await this.identities.unlink(userId, identityId, actor);
    const identity = await this.requireIdentity(userId, identityId);
    // IdentityService audited the change (actorType admin); this row carries the operator's reason.
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action: "identity.unlinked",
      subjectType: "identity",
      subjectId: identityId,
      metadata: { reason, userId, provider: identity.provider },
      ip: actor.ip,
    });
    return { identity: await this.identityApi(userId, identity) };
  }

  /**
   * `POST /admin/users/:id/identities/:identityId/reattach` — re-attachment without a fresh proof
   * (§6.4 b). Idempotent: an identity that is already active is returned unchanged, unaudited.
   */
  async reattachIdentity(
    userId: string,
    identityId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<{ identity: ApiIdentity }> {
    await this.requireUser(userId);
    const before = await this.requireIdentity(userId, identityId);
    if (before.status === "active") return { identity: await this.identityApi(userId, before) };

    const identity = await this.identities.reattach(userId, identityId, null, actor);
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action: "identity.reattached",
      subjectType: "identity",
      subjectId: identityId,
      metadata: { reason, userId, provider: identity.provider },
      ip: actor.ip,
    });
    return { identity: await this.identityApi(userId, identity) };
  }

  // ───────────────────────────────────────────── KYC ───────────────────────────────────────────

  /**
   * `POST /admin/users/:id/kyc/override { status, reason }` → a `provider = admin` verification.
   * KycService refuses (409 kyc_duplicate_identity) when the person is bound to another account.
   */
  async kycOverride(
    userId: string,
    status: AdminKycOverrideStatus,
    reason: string,
    actor: AdminActor,
  ): Promise<{ verification: ApiKycVerification }> {
    await this.requireUser(userId);
    const verification = await this.kyc.adminOverride(userId, status, reason, actor);
    return { verification: verificationToApi(verification) };
  }

  /** `GET /admin/kyc/duplicates` — verifications parked as `blocked_duplicate` (§9.3). */
  async kycDuplicates(): Promise<{ items: AdminKycQueueItem[] }> {
    return this.kycQueue("blocked_duplicate");
  }

  /** `GET /admin/kyc/needs-review` — GREEN answers with no usable document key (§9.3). */
  async kycNeedsReview(): Promise<{ items: AdminKycQueueItem[] }> {
    return this.kycQueue("needs_review");
  }

  /** `POST /admin/kyc/persons/:fingerprint/transfer { toUserId, reason }` — release + re-bind (§9.3). */
  async transferPerson(
    fingerprint: string,
    toUserId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<{ ok: true }> {
    await this.requireUser(toUserId);
    await this.kyc.transferPerson(fingerprint, toUserId, reason, actor);
    return { ok: true };
  }

  // ─────────────────────────────────────────── payouts ─────────────────────────────────────────

  /** `GET /admin/payouts?status=` — the durable `to_payouts` rows, with the live ledger view. */
  async listPayouts(status?: PayoutStatus): Promise<{ items: ApiPayout[] }> {
    const rows = await this.payouts.listAll(status ? { status } : {});
    const activeCids = rows.length > 0 ? await this.activePayoutCids() : new Set<string>();
    return {
      items: rows.map((p) => this.payouts.toApi(p, activeCids.has(p.pendingPayoutCid))),
    };
  }

  /**
   * `POST /admin/payouts/:cid/settle { force?, reason }` — the same `PayoutService.settle` the
   * processor and the user route call (§9.4); `force` is honoured only with a reason and is
   * audited by the payout service as `payout.admin_override`.
   */
  async settlePayout(
    cid: string,
    opts: { force: boolean; reason: string },
    actor: AdminActor,
  ): Promise<{ payout: ApiPayout; mode: "external" | "in_app" | "already_settled" }> {
    const { payout, mode } = await this.payouts.settle(cid, {
      type: "admin",
      userId: actor.userId,
      sessionId: actor.sessionId,
      force: opts.force,
      reason: opts.reason,
      ip: actor.ip,
    });
    // The contract was (probably) just archived: never answer from the 15 s ledger cache here.
    const onLedger = (await this.ledger.fetchPendingPayout(cid, { uncached: true })) !== null;
    return { payout: this.payouts.toApi(payout, onLedger), mode };
  }

  // ──────────────────────────────────────────── audit ──────────────────────────────────────────

  /** `GET /admin/audit?subjectType=&subjectId=&actorUserId=&page=` */
  async auditTrail(filter: AdminAuditFilter): Promise<ApiPage<ApiAuditEvent>> {
    const page = normalisePage(filter.page);
    const limit = normaliseLimit(filter.limit);
    const { items, total } = await this.audit.list({
      subjectType: filter.subjectType || undefined,
      subjectId: filter.subjectId || undefined,
      actorUserId: filter.actorUserId || undefined,
      page,
      limit,
    });
    return { items: items.map((e) => this.audit.toApi(e)), page, limit, total };
  }

  // ─────────────────────────────────────────── helpers ─────────────────────────────────────────

  private async requireUser(userId: string): Promise<UserEntity> {
    const user = await this.users.findById(userId);
    if (!user) throw errors.notFound("user not found");
    return user;
  }

  private async requireIdentity(userId: string, identityId: string): Promise<AuthIdentityEntity> {
    const identity = await this.identities.findById(identityId);
    if (!identity || identity.userId !== userId) throw errors.notFound("identity not found");
    return identity;
  }

  private async identityApi(userId: string, identity: AuthIdentityEntity): Promise<ApiIdentity> {
    return this.identities.toApi(identity, await this.kyc.lockedIdentityId(userId));
  }

  /** The sign-in method behind a session: a session's identity always belongs to its user (§5). */
  private async sessionProvider(
    identityId: string,
    known: Map<string, IdentityProvider>,
  ): Promise<IdentityProvider> {
    const hit = known.get(identityId);
    if (hit) return hit;
    const identity = await this.identities.findById(identityId);
    if (!identity) throw new ApiError(500, "internal_error", "session references an unknown identity");
    return identity.provider;
  }

  private async kycQueue(status: KycVerificationStatus): Promise<{ items: AdminKycQueueItem[] }> {
    const rows = await this.verifications.find({
      where: { status },
      order: { updatedAt: "DESC", id: "ASC" },
      take: KYC_QUEUE_LIMIT,
    });
    return { items: rows.map((v) => ({ ...verificationToApi(v), userId: v.userId })) };
  }

  /** Contract ids of every PendingPayout still active on the ledger (read as the treasury). */
  private async activePayoutCids(): Promise<Set<string>> {
    const live = await this.ledger.fetchPendingPayouts();
    return new Set(live.map((p) => p.contractId));
  }
}

/** Wire shape of a verification (docs/API.md `KycVerification`); never includes applicant data. */
export function verificationToApi(v: KycVerificationEntity): ApiKycVerification {
  return {
    id: v.id,
    provider: v.provider as KycProviderName | "admin",
    levelName: v.levelName,
    attemptNo: v.attemptNo,
    status: v.status,
    rejectLabels: Array.isArray(v.rejectLabels) ? v.rejectLabels : [],
    moderationComment: v.moderationComment,
    reviewedAt: toIso(v.reviewedAt),
    createdAt: v.createdAt.toISOString(),
  };
}

function normalisePage(page: number): number {
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
}

function normaliseLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.floor(limit));
}

/** `%`, `_` and `\` are LIKE metacharacters; Postgres's default escape character is `\`. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}
