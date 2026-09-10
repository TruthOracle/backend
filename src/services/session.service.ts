import { createHash, randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, LessThan, Not, Repository } from "typeorm";

import { Config } from "../config";
import { SessionEntity } from "../entities/session.entity";
import { UserEntity } from "../entities/user.entity";
import type { ActorType, ApiSession, IdentityProvider, SessionKind } from "../types";
import { clearedSessionCookie, sessionCookie } from "../util/cookies";
import { MINUTE_MS } from "../util/time";
import { AuditService } from "./audit.service";
import { RedisService } from "./redis.service";

/** What the Redis cache holds for a live session (never the token, never user data). */
interface CachedSession {
  id: string;
  userId: string;
  identityId: string;
  kind: SessionKind;
  expiresAt: string;
}

const TOUCH_INTERVAL_MS = 5 * MINUTE_MS;

/**
 * Server-side sessions (docs/ARCHITECTURE.md §6.6). Tokens are opaque 32-byte values; only
 * sha256(token) is stored. Verification is Redis `sess:<hash>` first, Postgres fallback with
 * re-warm. A per-user Redis SET `user_sessions:<userId>` (members = token hashes) lets
 * suspend / revoke-others / admin removal revoke every live session immediately.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly config: Config,
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("base64url");
  }

  ttlMsFor(kind: SessionKind): number {
    return kind === "admin" ? this.config.adminSessionTtlMs : this.config.sessionTtlMs;
  }

  async issue(input: {
    userId: string;
    authIdentityId: string;
    kind: SessionKind;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ token: string; session: SessionEntity }> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = SessionService.hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMsFor(input.kind));
    const session = this.sessions.create({
      userId: input.userId,
      authIdentityId: input.authIdentityId,
      tokenHash,
      kind: input.kind,
      expiresAt,
      lastSeenAt: now,
      revokedAt: null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 512) : null,
    });
    await this.sessions.save(session);
    await this.warm(session);
    return { token, session };
  }

  /** Redis first, Postgres fallback (re-warming the cache). Null = unknown, expired or revoked. */
  async verify(token: string): Promise<{ session: SessionEntity; user: UserEntity } | null> {
    if (!token || token.length < 32 || token.length > 128) return null;
    const tokenHash = SessionService.hashToken(token);

    let session: SessionEntity;
    const cached = await this.redis.getJson<CachedSession>(`sess:${tokenHash}`).catch(() => null);
    if (cached) {
      session = this.sessions.create({
        id: cached.id,
        userId: cached.userId,
        authIdentityId: cached.identityId,
        kind: cached.kind,
        tokenHash,
        expiresAt: new Date(cached.expiresAt),
        revokedAt: null,
      });
    } else {
      const stored = await this.sessions.findOne({ where: { tokenHash } });
      if (!stored) return null;
      if (stored.revokedAt || stored.expiresAt.getTime() <= Date.now()) return null;
      await this.warm(stored);
      session = stored;
    }
    if (session.expiresAt.getTime() <= Date.now()) return null;

    const user = await this.users.findOne({ where: { id: session.userId } });
    if (!user) return null;
    return { session, user };
  }

  /** Bump `last_seen_at` at most every 5 minutes (a Redis claim throttles the write). */
  async touch(session: SessionEntity): Promise<void> {
    const claimed = await this.redis.claimOnce(`sess_touch:${session.id}`, TOUCH_INTERVAL_MS).catch(() => false);
    if (!claimed) return;
    await this.sessions.update({ id: session.id, revokedAt: IsNull() }, { lastSeenAt: new Date() });
  }

  async revoke(sessionId: string, actor?: { type: ActorType; userId?: string | null; sessionId?: string | null; ip?: string | null }): Promise<void> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) return;
    if (!session.revokedAt) {
      await this.sessions.update({ id: sessionId }, { revokedAt: new Date() });
    }
    await this.evict(session.userId, session.tokenHash);
    if (actor) {
      await this.audit.record({
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        actorSessionId: actor.sessionId ?? null,
        action: "session.revoked",
        subjectType: "session",
        subjectId: sessionId,
        metadata: { userId: session.userId, kind: session.kind },
        ip: actor.ip ?? null,
      });
    }
  }

  /** Revoke every live session of a user (optionally keeping one). Returns the number revoked. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const live = await this.sessions.find({ where: { userId, revokedAt: IsNull() } });
    let revoked = 0;
    for (const s of live) {
      if (exceptSessionId && s.id === exceptSessionId) continue;
      await this.sessions.update({ id: s.id }, { revokedAt: new Date() });
      await this.evict(userId, s.tokenHash);
      revoked += 1;
    }
    // Belt and braces: anything the index still knows about is evicted too.
    const indexed = await this.redis.smembers(`user_sessions:${userId}`).catch(() => [] as string[]);
    const keepHash = exceptSessionId ? live.find((s) => s.id === exceptSessionId)?.tokenHash : undefined;
    for (const hash of indexed) {
      if (hash === keepHash) continue;
      await this.evict(userId, hash);
    }
    return revoked;
  }

  /** Revoke live sessions authenticated by one identity (used when an identity is unlinked). */
  async revokeByIdentity(authIdentityId: string): Promise<number> {
    const live = await this.sessions.find({ where: { authIdentityId, revokedAt: IsNull() } });
    for (const s of live) {
      await this.sessions.update({ id: s.id }, { revokedAt: new Date() });
      await this.evict(s.userId, s.tokenHash);
    }
    return live.length;
  }

  async listForUser(userId: string): Promise<SessionEntity[]> {
    return this.sessions.find({
      where: { userId, revokedAt: IsNull(), expiresAt: Not(LessThan(new Date())) },
      order: { createdAt: "DESC" },
    });
  }

  async findById(id: string): Promise<SessionEntity | null> {
    return this.sessions.findOne({ where: { id } });
  }

  /** Delete rows that expired or were revoked more than `olderThanMs` ago. */
  async purgeStale(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const a = await this.sessions.delete({ expiresAt: LessThan(cutoff) });
    const b = await this.sessions.delete({ revokedAt: LessThan(cutoff) });
    return (a.affected ?? 0) + (b.affected ?? 0);
  }

  cookieFor(token: string, kind: SessionKind): string {
    return sessionCookie(token, this.ttlMsFor(kind), this.config);
  }

  clearedCookie(): string {
    return clearedSessionCookie(this.config);
  }

  toApi(session: SessionEntity, authMethod: IdentityProvider, currentSessionId: string | null): ApiSession {
    return {
      id: session.id,
      kind: session.kind,
      authMethod,
      identityId: session.authIdentityId,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      lastSeenAt: session.lastSeenAt ? session.lastSeenAt.toISOString() : null,
      ip: session.ip,
      userAgent: session.userAgent,
      current: session.id === currentSessionId,
    };
  }

  private async warm(session: SessionEntity): Promise<void> {
    const ttl = session.expiresAt.getTime() - Date.now();
    if (ttl <= 0) return;
    const cached: CachedSession = {
      id: session.id,
      userId: session.userId,
      identityId: session.authIdentityId,
      kind: session.kind,
      expiresAt: session.expiresAt.toISOString(),
    };
    try {
      await this.redis.setJson(`sess:${session.tokenHash}`, cached, ttl);
      await this.redis.sadd(`user_sessions:${session.userId}`, session.tokenHash);
      await this.redis.pexpire(`user_sessions:${session.userId}`, Math.max(ttl, this.config.sessionTtlMs));
    } catch (err) {
      this.logger.warn(`session cache warm failed: ${(err as Error).message}`);
    }
  }

  private async evict(userId: string, tokenHash: string): Promise<void> {
    try {
      await this.redis.del(`sess:${tokenHash}`);
      await this.redis.srem(`user_sessions:${userId}`, tokenHash);
    } catch (err) {
      this.logger.warn(`session cache evict failed: ${(err as Error).message}`);
    }
  }
}
