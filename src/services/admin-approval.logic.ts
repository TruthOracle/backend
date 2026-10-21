/**
 * Pure rules of four-eyes approvals (SPEC §6.5, X11, M9): the params hash a signed decision
 * commits to, the message the operator's wallet signs, business-day expiry, and who may decide.
 * Persons, not parties: one person behind two operator parties is still one person.
 */
import { createHash } from "node:crypto";

import type { AdminRole, ErrorCode } from "../types";
import { type BusinessCalendar, minskDate } from "../util/by-calendar";

export type ApprovalDecision = "approve" | "reject";

/** JSON with sorted keys at every level; bigint → decimal string, Date → ISO (one value, one text). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalise(v);
    }
    return out;
  }
  return value;
}

/** A value as it round-trips through jsonb (what a stored precondition looks like). */
export function asJson<T>(value: T): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

/** sha256 hex over the canonical {action, subjectType, subjectId, params}: the approval binds all four. */
export function paramsHashOf(input: {
  action: string;
  subjectType: string;
  subjectId: string;
  params: Record<string, unknown>;
}): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

/** What the deciding operator's wallet signs (F2's `approvalMessage`, verified like the admin sign-in). */
export function approvalMessage(
  id: string,
  paramsHash: string,
  decision: ApprovalDecision,
): string {
  return `truthoracle-approval:${id}:${paramsHash}:${decision}`;
}

/** A pending approval lives until 23:59:59 Minsk of the TTL-th Belarusian business day after the request (M9). */
export function expiresAtFor(
  requestedAt: Date,
  ttlBdays: number,
  calendar: BusinessCalendar,
): Date {
  return calendar.endOfBusinessDayUtc(calendar.addBusinessDays(minskDate(requestedAt), ttlBdays));
}

export interface Operator {
  userId: string;
  party: string;
  person: string;
}

export interface Refusal {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** The first role in `needed` the operator lacks, else null. */
export function missingRole(
  roles: readonly AdminRole[],
  needed: readonly AdminRole[],
): AdminRole | null {
  return needed.find((r) => !roles.includes(r)) ?? null;
}

/** A person and their linked accounts (I8): their admin user and ADMIN_OPERATOR_ACCOUNTS. */
export interface LinkedPerson {
  person: string;
  /** The operator party they act from. */
  party: string;
  userIds: string[];
}

/** The user accounts linked to a person — I8's one definition of "theirs". */
export function linkedPerson(
  p: Operator,
  accounts: ReadonlyMap<string, readonly string[]>,
): LinkedPerson {
  return {
    person: p.person,
    party: p.party,
    userIds: [p.userId, ...(accounts.get(p.person) ?? [])],
  };
}

/**
 * I8: neither the acting person nor (at approval) the requesting person may be linked to the
 * subject's account — their own admin user, or a personal account in ADMIN_OPERATOR_ACCOUNTS.
 */
export function linkedRefusal(
  subjectUserId: string | null,
  people: readonly Operator[],
  accounts: ReadonlyMap<string, readonly string[]>,
): Refusal | null {
  if (!subjectUserId) return null;
  const id = subjectUserId.toLowerCase();
  for (const p of people) {
    const own = linkedPerson(p, accounts).userIds.map((u) => u.toLowerCase());
    if (own.includes(id))
      return {
        status: 403,
        code: "approval_linked_person",
        message: `${p.person} is linked to the subject's account; another person must act`,
        details: { person: p.person },
      };
  }
  return null;
}

/**
 * Who may APPROVE (SPEC §6.5): another person than the requester (and so another party and user),
 * holding every approve role, linked to the subject's account neither as approver nor requester.
 */
export function approveRefusal(input: {
  approver: Operator & { roles: readonly AdminRole[] };
  requester: Operator;
  approveRoles: readonly AdminRole[];
  subjectUserId: string | null;
  accounts: ReadonlyMap<string, readonly string[]>;
}): Refusal | null {
  const { approver, requester } = input;
  if (approver.userId === requester.userId || approver.party === requester.party)
    return {
      status: 403,
      code: "approval_self",
      message: "the requester cannot approve their own request",
    };
  if (approver.person === requester.person)
    return {
      status: 403,
      code: "approval_same_person",
      message: "the same person requested this (from another party); a second person must approve",
    };
  const role = missingRole(approver.roles, input.approveRoles);
  if (role)
    return {
      status: 403,
      code: "approval_role_required",
      message: `approving this needs the ${role} role`,
      details: { role },
    };
  return linkedRefusal(input.subjectUserId, [approver, requester], input.accounts);
}
