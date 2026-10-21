import { Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, Repository } from "typeorm";

import { AuthIdentityEntity } from "../entities/auth-identity.entity";
import { UserEntity } from "../entities/user.entity";
import {
  type Actor,
  type ApiIdentity,
  type IdentityClaim,
  KYC_LOCK_LOOKUP,
  type KycLockLookup,
  NatsSubjects,
} from "../types";
import { ApiError } from "../util/errors";
import { AuditService } from "./audit.service";
import { NatsService } from "./nats.service";
import { SessionService } from "./session.service";
import { UserService } from "./user.service";

/** `publicKey` is written only by `POST /auth/admin` (the operator's verified key, re-checked by AdminGuard against the pin). */
const PROFILE_KEYS = ["name", "username", "picture", "hd", "publicKey"] as const;

export interface LoginContext {
  currentUser: UserEntity | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
}

export interface LoginResolution {
  user: UserEntity;
  identity: AuthIdentityEntity;
  mode: "login" | "link";
  created: boolean;
}

/**
 * Identity rules (docs/ARCHITECTURE.md §6). Sign-in resolves an identity, then a user;
 * `(provider, subject)` is unique forever; rows are never deleted; unlink is revocation.
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(AuthIdentityEntity)
    private readonly identities: Repository<AuthIdentityEntity>,
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Resolved lazily at call time so KycService (P4) can depend on this service without a cycle. */
  private kycLock(): KycLockLookup | null {
    try {
      return this.moduleRef.get<KycLockLookup>(KYC_LOCK_LOOKUP, { strict: false });
    } catch {
      return null;
    }
  }

  async lockedIdentityId(userId: string): Promise<string | null> {
    const lookup = this.kycLock();
    if (!lookup) return null;
    return lookup.lockedIdentityId(userId);
  }

  async findById(id: string): Promise<AuthIdentityEntity | null> {
    return this.identities.findOne({ where: { id } });
  }

  async listForUser(userId: string): Promise<AuthIdentityEntity[]> {
    return this.identities.find({ where: { userId }, order: { createdAt: "ASC" } });
  }

  /**
   * §6.1–6.4:
   *  known active identity      → its user (login) / the same user (link, idempotent) / 409 for another user
   *  known unlinked identity    → 403 identity_unlinked on sign-in; a link-mode action by the ORIGINAL user
   *                               re-attaches; a link-mode action by ANOTHER account is 409
   *                               identity_already_linked (§6.2 "applies to unlinked rows too")
   *  unknown identity, no session → new user + identity
   *  unknown identity, session  → attached to the current user (link)
   */
  async resolveForLogin(claim: IdentityClaim, ctx: LoginContext): Promise<LoginResolution> {
    const subject = claim.subject.trim();
    if (!subject) throw new ApiError(400, "validation_failed", "identity subject is empty");
    const profile = pickProfile(claim.profile);
    const email = claim.provider === "google" ? (claim.email ?? null) : null;
    const actor: Actor = {
      type: "user",
      userId: ctx.currentUser?.id ?? null,
      sessionId: ctx.sessionId ?? null,
      ip: ctx.ip ?? null,
    };

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AuthIdentityEntity);
      const existing = await repo.findOne({ where: { provider: claim.provider, subject } });
      const now = new Date();

      if (existing) {
        if (existing.status === "unlinked") {
          if (ctx.currentUser && ctx.currentUser.id === existing.userId) {
            // (a) link-mode re-attachment by the original owner.
            const identity = await this.reattachRow(
              manager,
              existing,
              { ...actor, type: "user" },
              profile,
              email,
            );
            const user = await this.requireActiveUser(manager, existing.userId);
            return { user, identity, mode: "link", created: false };
          }
          // Deliberately NOT written through `manager`: the refusal below rolls this transaction
          // back, and §6.4 requires the refusal itself to be audited — so the row commits on its
          // own. The owner's user id is NOT in the metadata: the actor is the refused requester,
          // who reads this row through GET /me/audit; operators resolve the owner via subjectId.
          await this.audit.record({
            actorType: "user",
            actorUserId: ctx.currentUser?.id ?? null,
            actorSessionId: ctx.sessionId ?? null,
            action: "identity.unlinked_signin_refused",
            subjectType: "identity",
            subjectId: existing.id,
            metadata: { provider: existing.provider, linkMode: Boolean(ctx.currentUser) },
            ip: ctx.ip ?? null,
          });
          if (ctx.currentUser) {
            // Link mode by another account: the identity is bound to its first account (§6.2).
            throw new ApiError(
              409,
              "identity_already_linked",
              "this sign-in method is linked to another account",
            );
          }
          throw new ApiError(
            403,
            "identity_unlinked",
            "this sign-in method was unlinked from its account; the original account owner or an operator can re-attach it",
          );
        }

        if (ctx.currentUser && ctx.currentUser.id !== existing.userId) {
          throw new ApiError(
            409,
            "identity_already_linked",
            "this sign-in method is linked to another account",
          );
        }

        existing.lastUsedAt = now;
        existing.profile = { ...existing.profile, ...profile };
        if (email) existing.email = email;
        await repo.save(existing);

        const user = await this.requireActiveUser(manager, existing.userId);
        if (ctx.currentUser) return { user, identity: existing, mode: "link", created: false };
        await manager.getRepository(UserEntity).update({ id: user.id }, { lastLoginAt: now });
        user.lastLoginAt = now;
        await this.users.invalidate(user.id);
        return { user, identity: existing, mode: "login", created: false };
      }

      // Unknown identity.
      let user: UserEntity;
      let created = false;
      if (ctx.currentUser) {
        user = await this.requireActiveUser(manager, ctx.currentUser.id);
      } else {
        user = await this.users.create(
          {
            displayName:
              typeof profile.name === "string"
                ? profile.name
                : typeof profile.username === "string"
                  ? profile.username
                  : null,
            avatarUrl: typeof profile.picture === "string" ? profile.picture : null,
            email,
          },
          manager,
        );
        await manager.getRepository(UserEntity).update({ id: user.id }, { lastLoginAt: now });
        user.lastLoginAt = now;
        created = true;
      }

      const identity = repo.create({
        userId: user.id,
        provider: claim.provider,
        subject,
        email,
        profile,
        status: "active",
        verifiedAt: now,
        lastUsedAt: now,
        unlinkedAt: null,
      });
      await repo.save(identity);

      if (created) {
        await this.audit.record(
          {
            actorType: "user",
            actorUserId: user.id,
            actorSessionId: null,
            action: "user.created",
            subjectType: "user",
            subjectId: user.id,
            metadata: { provider: claim.provider },
            ip: ctx.ip ?? null,
          },
          manager,
        );
      }
      await this.audit.record(
        {
          actorType: "user",
          actorUserId: user.id,
          actorSessionId: ctx.sessionId ?? null,
          action: "identity.linked",
          subjectType: "identity",
          subjectId: identity.id,
          metadata: {
            provider: claim.provider,
            userId: user.id,
            mode: ctx.currentUser ? "link" : "login",
          },
          ip: ctx.ip ?? null,
        },
        manager,
      );
      // Published after the row exists; a NATS failure must not roll back the account.
      void this.nats.publishSafe(created ? NatsSubjects.userCreated : NatsSubjects.identityLinked, {
        userId: user.id,
        identityId: identity.id,
        provider: claim.provider,
      });
      return { user, identity, mode: ctx.currentUser ? "link" : "login", created };
    });
  }

  /**
   * Unlink = revoke (§6.3–6.5). Refused — in this order — for the identity locked by a standing
   * KYC approval (`identity_locked_by_kyc`, admins excepted) and for the last active identity
   * (`last_identity`). Wallet rows are never involved: a linked wallet has no identity (§8.1) and
   * an operator's `canton_wallet` identity has no wallet row.
   */
  async unlink(userId: string, identityId: string, actor: Actor): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AuthIdentityEntity);
      const identity = await repo.findOne({ where: { id: identityId, userId } });
      if (!identity || identity.status !== "active")
        throw new ApiError(404, "not_found", "identity not found");

      // Refusal precedence: §6.5 KYC lock (users only) → §6.3 last identity.
      if (actor.type !== "admin") {
        const locked = await this.lockedIdentityId(userId);
        if (locked && locked === identity.id) {
          throw new ApiError(
            409,
            "identity_locked_by_kyc",
            "this sign-in method is attached to your identity verification and cannot be unlinked",
          );
        }
      }

      const others = await repo.count({ where: { userId, status: "active" } });
      if (others <= 1)
        throw new ApiError(
          409,
          "last_identity",
          "an account must keep at least one sign-in method",
        );

      identity.status = "unlinked";
      identity.unlinkedAt = new Date();
      await repo.save(identity);
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "identity.unlinked",
          subjectType: "identity",
          subjectId: identity.id,
          metadata: { provider: identity.provider, userId },
          ip: actor.ip ?? null,
        },
        manager,
      );
    });
    // Sessions that were authenticated by this identity die with it.
    await this.sessions.revokeByIdentity(identityId);
    void this.nats.publishSafe(NatsSubjects.identityUnlinked, { userId, identityId });
  }

  /**
   * Re-attach an unlinked identity (§6.4). A user must be the original owner and present a fresh
   * proof for the same provider/subject; an admin needs no proof (`claim` may then be null).
   */
  async reattach(
    userId: string,
    identityId: string,
    claim: IdentityClaim | null,
    actor: Actor,
  ): Promise<AuthIdentityEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AuthIdentityEntity);
      const identity = await repo.findOne({ where: { id: identityId, userId } });
      if (!identity) throw new ApiError(404, "not_found", "identity not found");
      if (identity.status === "active") return identity;
      if (actor.type !== "admin") {
        if (
          !claim ||
          claim.provider !== identity.provider ||
          claim.subject.trim() !== identity.subject
        ) {
          throw new ApiError(403, "forbidden", "a fresh proof for this sign-in method is required");
        }
      }
      await this.requireActiveUser(manager, userId);
      return this.reattachRow(
        manager,
        identity,
        actor,
        pickProfile(claim?.profile),
        claim?.provider === "google" ? (claim.email ?? null) : null,
      );
    });
  }

  toApi(identity: AuthIdentityEntity, kycLockedIdentityId?: string | null): ApiIdentity {
    return {
      id: identity.id,
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email,
      profile: pickProfile(identity.profile),
      status: identity.status,
      verifiedAt: identity.verifiedAt.toISOString(),
      lastUsedAt: identity.lastUsedAt ? identity.lastUsedAt.toISOString() : null,
      kycLocked: Boolean(kycLockedIdentityId && kycLockedIdentityId === identity.id),
    };
  }

  private async reattachRow(
    manager: EntityManager,
    identity: AuthIdentityEntity,
    actor: Actor,
    profile: Record<string, unknown>,
    email: string | null,
  ): Promise<AuthIdentityEntity> {
    const repo = manager.getRepository(AuthIdentityEntity);
    identity.status = "active";
    identity.unlinkedAt = null;
    identity.lastUsedAt = new Date();
    identity.profile = { ...identity.profile, ...profile };
    if (email) identity.email = email;
    await repo.save(identity);
    await this.audit.record(
      {
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        actorSessionId: actor.sessionId ?? null,
        action: "identity.reattached",
        subjectType: "identity",
        subjectId: identity.id,
        metadata: { provider: identity.provider, userId: identity.userId, by: actor.type },
        ip: actor.ip ?? null,
      },
      manager,
    );
    void this.nats.publishSafe(NatsSubjects.identityReattached, {
      userId: identity.userId,
      identityId: identity.id,
    });
    return identity;
  }

  private async requireActiveUser(manager: EntityManager, userId: string): Promise<UserEntity> {
    const user = await manager.getRepository(UserEntity).findOne({ where: { id: userId } });
    if (!user) throw new ApiError(404, "not_found", "user not found");
    if (user.status !== "active")
      throw new ApiError(403, "user_suspended", "this account is suspended");
    return user;
  }
}

/** Only the documented profile keys survive (never tokens or unexpected provider fields). */
export function pickProfile(
  profile: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!profile) return out;
  for (const k of PROFILE_KEYS) {
    const v = profile[k];
    if (typeof v === "string" && v) out[k] = v.slice(0, 512);
  }
  return out;
}
