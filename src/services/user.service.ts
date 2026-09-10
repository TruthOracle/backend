import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, Repository } from "typeorm";

import { REASON_MAX_LENGTH } from "../dto/admin.dto";
import { UserEntity } from "../entities/user.entity";
import type { Actor, ApiUser } from "../types";
import { ApiError } from "../util/errors";
import { AuditService } from "./audit.service";
import { RedisService } from "./redis.service";
import { SessionService } from "./session.service";

/** `users.status` is read per request; this short cache is invalidated by suspension. */
const USER_CACHE_MS = 30_000;

@Injectable()
export class UserService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async findById(id: string, manager?: EntityManager): Promise<UserEntity | null> {
    const repo = manager ? manager.getRepository(UserEntity) : this.users;
    return repo.findOne({ where: { id } });
  }

  /** ≤ 30 s cached read for the per-request status check (suspend/update invalidate it). */
  async findByIdCached(id: string): Promise<UserEntity | null> {
    const cached = await this.redis.getJson<Record<string, unknown>>(`user:${id}`).catch(() => null);
    if (cached) return this.users.create(reviveDates(cached));
    const user = await this.findById(id);
    if (user) await this.redis.setJson(`user:${id}`, user, USER_CACHE_MS).catch(() => undefined);
    return user;
  }

  async invalidate(id: string): Promise<void> {
    await this.redis.del(`user:${id}`).catch(() => undefined);
  }

  async create(
    input: { displayName?: string | null; avatarUrl?: string | null; email?: string | null },
    manager?: EntityManager,
  ): Promise<UserEntity> {
    const repo = manager ? manager.getRepository(UserEntity) : this.users;
    const user = repo.create({
      displayName: clip(input.displayName, 120),
      avatarUrl: clip(input.avatarUrl, 2048),
      email: clip(input.email, 320),
      status: "active",
      kycStatus: "none",
    });
    return repo.save(user);
  }

  async update(
    id: string,
    patch: { displayName?: string | null; avatarUrl?: string | null; email?: string | null; lastLoginAt?: Date },
    manager?: EntityManager,
  ): Promise<UserEntity> {
    const repo = manager ? manager.getRepository(UserEntity) : this.users;
    const user = await repo.findOne({ where: { id } });
    if (!user) throw new ApiError(404, "not_found", "user not found");
    if (patch.displayName !== undefined) user.displayName = clip(patch.displayName, 120);
    if (patch.avatarUrl !== undefined) user.avatarUrl = clip(patch.avatarUrl, 2048);
    if (patch.email !== undefined) user.email = clip(patch.email, 320);
    if (patch.lastLoginAt !== undefined) user.lastLoginAt = patch.lastLoginAt;
    const saved = await repo.save(user);
    await this.invalidate(id);
    return saved;
  }

  async setPrimaryParty(userId: string, partyId: string | null, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(UserEntity) : this.users;
    await repo.update({ id: userId }, { partyId });
    await this.invalidate(userId);
  }

  /**
   * Suspension revokes every live session immediately (§6.6). The status change and its audit
   * row commit together; the session revocation follows (its own audit trail) and fails loud when
   * the cache cannot be evicted, so an operator never sees "ok" for a suspension that left a
   * session alive.
   */
  async suspend(userId: string, reason: string, actor: Actor): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    if (user.status === "closed") throw new ApiError(409, "user_suspended", "user is closed");
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(UserEntity).update({ id: userId }, { status: "suspended" });
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "user.suspended",
          subjectType: "user",
          subjectId: userId,
          metadata: { reason: clip(reason, REASON_MAX_LENGTH) },
          ip: actor.ip ?? null,
        },
        manager,
      );
    });
    await this.invalidate(userId);
    const revoked = await this.sessions.revokeAllForUser(userId);
    if (revoked > 0) {
      await this.audit.record({
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        actorSessionId: actor.sessionId ?? null,
        action: "session.revoked_all",
        subjectType: "user",
        subjectId: userId,
        metadata: { reason: "user.suspended", revoked },
        ip: actor.ip ?? null,
      });
    }
  }

  async reinstate(userId: string, reason: string, actor: Actor): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(UserEntity).update({ id: userId }, { status: "active" });
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "user.reinstated",
          subjectType: "user",
          subjectId: userId,
          metadata: { reason: clip(reason, REASON_MAX_LENGTH) },
          ip: actor.ip ?? null,
        },
        manager,
      );
    });
    await this.invalidate(userId);
  }

  toApi(user: UserEntity): ApiUser {
    return {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      email: user.email,
      status: user.status,
      kycStatus: user.kycStatus,
      partyId: user.partyId,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    };
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

const DATE_FIELDS = ["createdAt", "updatedAt", "lastLoginAt"] as const;

function reviveDates(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const f of DATE_FIELDS) {
    const v = out[f];
    if (typeof v === "string") out[f] = new Date(v);
  }
  return out;
}
