import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { type EntityManager, Repository } from "typeorm";

import { AuditEventEntity } from "../entities/audit-event.entity";
import type { ActorType, ApiAuditEvent, AuditAction } from "../types";
import { formatAmount } from "../util/money";

export interface AuditInput {
  actorType: ActorType;
  actorUserId?: string | null;
  actorSessionId?: string | null;
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Keys that may never appear in audit metadata, whatever the action (ARCHITECTURE §9.7). */
const FORBIDDEN_METADATA_KEYS = new Set([
  "token",
  "signature",
  "publicKey",
  "secret",
  "password",
  "credential",
  "initData",
  "firstName",
  "lastName",
  "dob",
  "number",
  "documents",
  "person",
  "email",
]);

/**
 * Structured audit trail written synchronously — pass the transaction's `EntityManager` so the
 * row commits with the change it describes (ARCHITECTURE §5 `to_audit_events`).
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly repo: Repository<AuditEventEntity>,
  ) {}

  async record(input: AuditInput, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(AuditEventEntity) : this.repo;
    const row = repo.create({
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      actorSessionId: input.actorSessionId ?? null,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      metadata: sanitizeMetadata(input.metadata ?? {}),
      ip: input.ip ?? null,
    });
    await repo.save(row);
  }

  async list(filter: {
    subjectType?: string;
    subjectId?: string;
    actorUserId?: string;
    page: number;
    limit: number;
  }): Promise<{ items: AuditEventEntity[]; total: number }> {
    const qb = this.repo.createQueryBuilder("a").orderBy("a.id", "DESC");
    if (filter.subjectType)
      qb.andWhere("a.subject_type = :subjectType", { subjectType: filter.subjectType });
    if (filter.subjectId) qb.andWhere("a.subject_id = :subjectId", { subjectId: filter.subjectId });
    if (filter.actorUserId)
      qb.andWhere("a.actor_user_id = :actorUserId", { actorUserId: filter.actorUserId });
    const page = Math.max(1, filter.page);
    const limit = Math.min(100, Math.max(1, filter.limit));
    const [items, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items, total };
  }

  /** The user's own trail: events they performed OR that concern them. */
  async listForUser(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ items: AuditEventEntity[]; total: number }> {
    const p = Math.max(1, page);
    const l = Math.min(100, Math.max(1, limit));
    const [items, total] = await this.repo
      .createQueryBuilder("a")
      // Two parameters on purpose: one placeholder compared with a uuid AND a text column makes
      // Postgres refuse the statement ("inconsistent types deduced for parameter").
      .where(
        "a.actor_user_id = :actorUserId OR (a.subject_type = 'user' AND a.subject_id = :subjectId)",
        { actorUserId: userId, subjectId: userId },
      )
      .orderBy("a.id", "DESC")
      .skip((p - 1) * l)
      .take(l)
      .getManyAndCount();
    return { items, total };
  }

  toApi(event: AuditEventEntity): ApiAuditEvent {
    return {
      id: String(event.id),
      actorType: event.actorType,
      actorUserId: event.actorUserId,
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      metadata: event.metadata ?? {},
      createdAt: event.createdAt.toISOString(),
    };
  }
}

/**
 * Drop forbidden keys and `undefined`; a `bigint` is always a token amount in 1e-10 units
 * (util/money), so it is rendered as the 10-decimal wire string — never as raw units, which
 * would put two money encodings into one audit trail (API.md: "Money is a string with exactly
 * 10 decimals").
 */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = typeof v === "bigint" ? formatAmount(v) : v;
  }
  return out;
}
