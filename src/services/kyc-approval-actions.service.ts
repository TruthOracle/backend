import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import { KycPersonEntity } from "../entities/kyc-person.entity";
import { type ApiKycVerification, KYC_PROVIDER, type KycProvider } from "../types";
import { ApiError } from "../util/errors";
import { AdminService } from "./admin.service";
import { AdminApprovalService } from "./admin-approval.service";
import { UserService } from "./user.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `kyc.override` params: only an approval goes through four eyes (closing the gate is one decision). */
interface KycOverrideParams extends Record<string, unknown> {
  status: "approved";
}

/** What the requester saw: the account's KYC state (any change in between fails the approval). */
interface KycOverrideSnapshot {
  userId: string;
  status: string;
  kycStatus: string;
  kycProvider: string | null;
  kycApplicantId: string | null;
  kycVerificationId: string | null;
  /** The provider's own review of the applicant (what the approver overrides; null: none read). */
  providerAnswer: "GREEN" | "RED" | null;
  providerRejectType: "RETRY" | "FINAL" | null;
  providerLevel: string | null;
}

/** `kyc.person_transfer` params: the account the verified person moves to. */
interface PersonTransferParams extends Record<string, unknown> {
  toUserId: string;
}

/** The binding and both accounts' KYC state as the requester saw them (any change fails the approval). */
interface PersonTransferSnapshot {
  fingerprint: string;
  fromUserId: string;
  verificationId: string;
  releasedAt: string | null;
  toUserId: string;
  toStatus: string;
  toKycStatus: string;
  toKycVerificationId: string | null;
  fromKycStatus: string | null;
}

/**
 * C22 (SPEC §6.5, I8): a manual KYC approval opens the KYC-gated fiat ramp, so it is the four-eyes
 * `kyc.override` — requested by a person with `aml`, approved by ANOTHER person with `approver`,
 * neither linked to the account (their own admin user or an ADMIN_OPERATOR_ACCOUNTS entry; the
 * registry's linked-person rule). With RAMP_DUAL_CONTROL=false it executes at once, like every
 * action. Overrides that close the gate (rejected, expired) stay one aml decision.
 */
@Injectable()
export class KycApprovalActions implements OnModuleInit {
  constructor(
    private readonly approvals: AdminApprovalService,
    private readonly admin: AdminService,
    private readonly users: UserService,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
    @InjectRepository(KycPersonEntity) private readonly persons: Repository<KycPersonEntity>,
  ) {}

  onModuleInit(): void {
    this.approvals.register<
      KycOverrideParams,
      KycOverrideSnapshot,
      { verification: ApiKycVerification }
    >({
      action: "kyc.override",
      subjectType: "user",
      requestRoles: ["aml"],
      approveRoles: ["approver"],
      params: (raw) => {
        if (raw.status !== "approved")
          throw new ApiError(400, "validation_failed", "kyc.override approves a KYC by hand");
        return { status: "approved" };
      },
      snapshot: (id) => this.snapshot(id),
      validate: async (_p, s) => {
        if (s.status === "closed")
          throw new ApiError(409, "user_suspended", "the account is closed");
      },
      describe: (_p, s) =>
        `approve the KYC of account ${s.userId} by hand (now ${s.kycStatus}; ${s.kycProvider ?? "no provider"} review: ${s.providerAnswer ?? "none"}${s.providerRejectType ? ` ${s.providerRejectType}` : ""})`,
      subjectUser: async (id) => id,
      execute: (_p, _s, ctx) =>
        this.admin.kycOverride(ctx.subjectId, "approved", ctx.reason, ctx.actor),
    });

    // A person transfer approves the target account's KYC (it opens the ramp there) and takes it
    // from the source: the same four eyes as kyc.override, nobody linked to EITHER account (I8).
    this.approvals.register<PersonTransferParams, PersonTransferSnapshot, { ok: true }>({
      action: "kyc.person_transfer",
      subjectType: "kyc_person",
      requestRoles: ["aml"],
      approveRoles: ["approver"],
      params: (raw) => {
        if (typeof raw.toUserId !== "string" || !UUID_RE.test(raw.toUserId))
          throw new ApiError(400, "validation_failed", "toUserId must be a UUID");
        return { toUserId: raw.toUserId.toLowerCase() };
      },
      snapshot: (fingerprint, p) => this.transferSnapshot(fingerprint, p.toUserId),
      validate: async (_p, s) => {
        if (s.fromUserId === s.toUserId && !s.releasedAt)
          throw new ApiError(409, "bad_request", "this person is already bound to that account");
        if (s.toStatus === "closed")
          throw new ApiError(409, "user_suspended", "the receiving account is closed");
      },
      describe: (_p, s) =>
        `move the verified person ${s.fingerprint.slice(0, 12)}… from account ${s.fromUserId} (KYC ${s.fromKycStatus ?? "?"}) to account ${s.toUserId} (KYC now ${s.toKycStatus}), approving it there`,
      subjectUser: async (_id, p) => p.toUserId,
      conflict: async (_id, _p, s, people) => {
        const from = s.fromUserId.toLowerCase();
        const linked = people.find((p) => p.userIds.some((u) => u.toLowerCase() === from));
        return linked
          ? {
              status: 403,
              code: "approval_linked_person",
              message: `${linked.person} is linked to the account the person leaves; another person must act`,
              details: { person: linked.person, reason: "source_account" },
            }
          : null;
      },
      execute: (p, _s, ctx) =>
        this.admin.transferPerson(ctx.subjectId, p.toUserId, ctx.reason, ctx.actor),
    });
  }

  /** The binding the fingerprint names and both accounts' KYC state (404 for either missing). */
  private async transferSnapshot(
    fingerprint: string,
    toUserId: string,
  ): Promise<PersonTransferSnapshot> {
    const anchor = await this.persons.findOne({ where: { fingerprint } });
    if (!anchor) throw new ApiError(404, "not_found", "no binding with this fingerprint");
    const to = await this.users.findById(toUserId);
    if (!to) throw new ApiError(404, "not_found", "user not found");
    const from = await this.users.findById(anchor.userId);
    return {
      fingerprint,
      fromUserId: anchor.userId,
      verificationId: anchor.verificationId,
      releasedAt: anchor.releasedAt?.toISOString() ?? null,
      toUserId,
      toStatus: to.status,
      toKycStatus: to.kycStatus,
      toKycVerificationId: to.kycVerificationId ?? null,
      fromKycStatus: from?.kycStatus ?? null,
    };
  }

  /**
   * The account's KYC state and the provider's own verdict on its applicant (a RED / FINAL review
   * is shown to both persons; the approval fails if it changes in between). A provider that cannot
   * be read refuses the request — the override itself re-reads the applicant anyway (I7).
   */
  private async snapshot(userId: string): Promise<KycOverrideSnapshot> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    const review =
      user.kycApplicantId && user.kycProvider === this.provider.name
        ? await this.provider.fetchApplicant(user.kycApplicantId)
        : null;
    return {
      userId,
      status: user.status,
      kycStatus: user.kycStatus,
      kycProvider: user.kycProvider ?? null,
      kycApplicantId: user.kycApplicantId ?? null,
      kycVerificationId: user.kycVerificationId ?? null,
      providerAnswer: review?.answer ?? null,
      providerRejectType: review?.rejectType ?? null,
      providerLevel: review?.levelName ?? null,
    };
  }
}
