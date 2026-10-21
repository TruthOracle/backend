import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession, RequireRoles } from "../auth/decorators";
import { type AuthedRequest, actorOf } from "../auth/request";
import {
  AdminAuditQueryDto,
  AdminKycOverrideDto,
  AdminPayoutSettleDto,
  AdminPayoutsQueryDto,
  AdminPersonTransferDto,
  AdminReasonDto,
  AdminUsersQueryDto,
  FingerprintParamDto,
  WebhookEventParamDto,
} from "../dto/admin.dto";
import { PayoutMarkPaidDto } from "../dto/admin-controls.dto";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import { PayoutCidParamDto } from "../dto/payouts.dto";
import {
  type AdminActor,
  type AdminAuditFilter,
  type AdminKycQueueItem,
  AdminService,
  type AdminUserDetail,
} from "../services/admin.service";
import { Config } from "../config";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import type { PayoutMode } from "../services/payout.service";
import { RampApprovalActions } from "../services/ramp-approval-actions.service";
import {
  type ApiAdminSession,
  type ApiAuditEvent,
  type ApiIdentity,
  type ApiKycProviderStatus,
  type ApiKycVerification,
  type ApiPage,
  type ApiPayout,
  type ApiUser,
  KYC_PROVIDER,
  type KycProvider,
} from "../types";
import { ApiError } from "../util/errors";
import { answerApproval } from "./admin-approvals.controller";

/**
 * The operator behind an admin request: `actorOf` narrowed to the admin session AdminGuard
 * guarantees, with the party, person and roles AdminGuard recorded (SPEC §6.5).
 */
export function adminActorOf(req: AuthedRequest): AdminActor {
  const actor = actorOf(req);
  if (actor.type !== "admin" || !actor.userId || !actor.sessionId) {
    throw new ApiError(403, "forbidden", "an admin session is required");
  }
  const op = req.adminOperator;
  if (!op) throw new ApiError(403, "forbidden", "the operator was not resolved (AdminGuard)");
  return {
    type: "admin",
    userId: actor.userId,
    sessionId: actor.sessionId,
    ip: actor.ip ?? null,
    operatorParty: op.party,
    personId: op.personId,
    roles: [...op.roles],
    publicKey: op.publicKey,
  };
}

/**
 * Operator API (docs/API.md "Admin"; ARCHITECTURE §11). Every route sits behind AdminGuard —
 * a wallet-signed `kind = admin` session whose party is still in ADMIN_OPERATORS (§6.8); the
 * class-level @AllowAdminSession lets SessionGuard admit that kind here at all. Every mutation
 * requires a `reason` and is audited with actorType `admin`.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly config: Config,
    @Inject(KYC_PROVIDER) private readonly kycProvider: KycProvider,
    private readonly approvals: AdminApprovalService,
    private readonly rampApprovals: RampApprovalActions,
  ) {}

  /** `GET /admin/session` (SPEC §12.2): the operator's party, person, roles and how decisions are made. */
  @Get("session")
  session(@Req() req: AuthedRequest): ApiAdminSession {
    const actor = adminActorOf(req);
    return {
      party: actor.operatorParty,
      personId: actor.personId,
      roles: actor.roles,
      approvalSignatures: this.config.rampControls.approvalSignatures,
      dualControl: this.config.rampControls.dualControl,
    };
  }

  /** The KYC provider's wiring plus a live credential probe (docs/KYC.md §6) — never applicant data. */
  @Get("kyc/provider")
  async kycProviderStatus(): Promise<ApiKycProviderStatus> {
    return {
      provider: this.kycProvider.name,
      configured: this.kycProvider.isConfigured(),
      levelName: this.config.kycRequiredLevel,
      enforceWithdrawals: this.config.kycEnforceWithdrawals,
      webhookPath: `/api/v1/webhooks/kyc/${this.kycProvider.name}`,
      health: await this.kycProvider.healthCheck(),
    };
  }

  // ─────────────────────────────────────────── users ───────────────────────────────────────────

  @Get("users")
  listUsers(@Query() query: AdminUsersQueryDto): Promise<ApiPage<ApiUser>> {
    return this.admin.listUsers(query.q ?? "", query.page ?? 1, query.limit ?? DEFAULT_PAGE_LIMIT);
  }

  @Get("users/:id")
  user(@Param("id", ParseUUIDPipe) id: string): Promise<AdminUserDetail> {
    return this.admin.userDetail(id);
  }

  @Post("users/:id/suspend")
  @HttpCode(200)
  suspend(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.admin.suspend(id, body.reason, adminActorOf(req));
  }

  /**
   * `{ ok: true }` — or, when the account has a chargeback, a blocked card or a ramp order in review
   * (X12 c), the four-eyes `user.reinstate`: 202 `{approval}` / 200 `{approval, result}`.
   */
  @Post("users/:id/reinstate")
  @HttpCode(200)
  async reinstate(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true } | ApprovalOutcome> {
    const actor = adminActorOf(req);
    const flags = await this.rampApprovals.reinstateFlags(id);
    if (flags.chargebacks + flags.blockedCards + flags.ordersInReview === 0)
      return this.admin.reinstate(id, body.reason, actor);
    const outcome = await this.approvals.request(
      { action: "user.reinstate", subjectId: id, reason: body.reason },
      actor,
    );
    return answerApproval(res, outcome);
  }

  @Post("users/:id/sessions/revoke")
  @HttpCode(200)
  revokeSessions(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.admin.revokeSessions(id, body.reason, adminActorOf(req));
  }

  // ───────────────────────────────────────── identities ────────────────────────────────────────

  @Post("users/:id/identities/:identityId/reattach")
  @HttpCode(200)
  reattachIdentity(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("identityId", ParseUUIDPipe) identityId: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<{ identity: ApiIdentity }> {
    return this.admin.reattachIdentity(id, identityId, body.reason, adminActorOf(req));
  }

  @Post("users/:id/identities/:identityId/unlink")
  @HttpCode(200)
  unlinkIdentity(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("identityId", ParseUUIDPipe) identityId: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<{ identity: ApiIdentity }> {
    return this.admin.unlinkIdentity(id, identityId, body.reason, adminActorOf(req));
  }

  // ───────────────────────────────────────────── KYC ───────────────────────────────────────────

  /**
   * Role `aml` (C22). Approving by hand opens the KYC-gated fiat ramp, so `approved` is the
   * four-eyes `kyc.override` (another person with `approver`; nobody linked to the account): 202
   * `{approval}` pending, 200 `{verification, approval}` once executed. Closing the gate
   * (`rejected`, `expired`) is one aml decision: 200 `{verification}`.
   */
  @Post("users/:id/kyc/override")
  @HttpCode(200)
  @RequireRoles("aml")
  async kycOverride(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminKycOverrideDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ verification: ApiKycVerification } | ApprovalOutcome> {
    const actor = adminActorOf(req);
    if (body.status !== "approved")
      return this.admin.kycOverride(id, body.status, body.reason, actor);
    const outcome = await this.approvals.request(
      {
        action: "kyc.override",
        subjectId: id,
        params: { status: "approved" },
        reason: body.reason,
      },
      actor,
    );
    const answered = answerApproval(res, outcome);
    const result = outcome.result as { verification: ApiKycVerification } | undefined;
    return result ? { ...result, approval: answered.approval } : answered;
  }

  @Get("kyc/duplicates")
  kycDuplicates(): Promise<{ items: AdminKycQueueItem[] }> {
    return this.admin.kycDuplicates();
  }

  @Get("kyc/needs-review")
  kycNeedsReview(): Promise<{ items: AdminKycQueueItem[] }> {
    return this.admin.kycNeedsReview();
  }

  /**
   * Role `aml`: moving a verified person approves the receiving account's KYC, so it is the
   * four-eyes `kyc.person_transfer` (another person with `approver`; nobody linked to either
   * account): 202 `{approval}` pending, 200 `{ok, approval}` once executed.
   */
  @Post("kyc/persons/:fingerprint/transfer")
  @HttpCode(200)
  @RequireRoles("aml")
  async transferPerson(
    @Param() params: FingerprintParamDto,
    @Body() body: AdminPersonTransferDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true } | ApprovalOutcome> {
    const outcome = await this.approvals.request(
      {
        action: "kyc.person_transfer",
        subjectId: params.fingerprint,
        params: { toUserId: body.toUserId },
        reason: body.reason,
      },
      adminActorOf(req),
    );
    const answered = answerApproval(res, outcome);
    const result = outcome.result as { ok: true } | undefined;
    return result ? { ...result, approval: answered.approval } : answered;
  }

  /** Operator escape hatch for a stored webhook the durable consumer gave up on (RUNBOOK §4). */
  @Post("kyc/webhooks/:id/replay")
  @HttpCode(200)
  replayWebhook(
    @Param() params: WebhookEventParamDto,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true; eventId: string }> {
    return this.admin.replayWebhook(params.id, body.reason, adminActorOf(req));
  }

  // ─────────────────────────────────────────── payouts ─────────────────────────────────────────

  @Get("payouts")
  payouts(@Query() query: AdminPayoutsQueryDto): Promise<{ items: ApiPayout[] }> {
    return this.admin.listPayouts(query.status);
  }

  /**
   * The processor's settle on demand (`{payout, mode}`); with `force` it is the four-eyes
   * `payout.force_settle` (SPEC §6.5): 202 `{approval}` / 200 `{approval, result: {payout, mode}}`.
   */
  @Post("payouts/:cid/settle")
  @HttpCode(200)
  async settlePayout(
    @Param() params: PayoutCidParamDto,
    @Body() body: AdminPayoutSettleDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<{ payout: ApiPayout; mode: PayoutMode } | ApprovalOutcome> {
    const actor = adminActorOf(req);
    if (body.force !== true)
      return this.admin.settlePayout(params.cid, { force: false, reason: body.reason }, actor);
    const outcome = await this.approvals.request(
      { action: "payout.force_settle", subjectId: params.cid, reason: body.reason },
      actor,
    );
    return res ? answerApproval(res, outcome) : outcome;
  }

  /**
   * `payout.mark_paid` (SPEC §6.5, X1): record that a PendingPayout was paid outside the platform —
   * never one bound to (or bindable by) a ramp cash-out. 202 `{approval}` / 200 `{approval, result}`.
   */
  @Post("payouts/:cid/mark-paid")
  async markPaid(
    @Param() params: PayoutCidParamDto,
    @Body() body: PayoutMarkPaidDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      {
        action: "payout.mark_paid",
        subjectId: params.cid,
        params: { txHash: body.txHash },
        reason: body.reason,
      },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  // ──────────────────────────────────────────── audit ──────────────────────────────────────────

  @Get("audit")
  audit(@Query() query: AdminAuditQueryDto): Promise<ApiPage<ApiAuditEvent>> {
    const filter: AdminAuditFilter = {
      subjectType: query.subjectType,
      subjectId: query.subjectId,
      actorUserId: query.actorUserId,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    };
    return this.admin.auditTrail(filter);
  }
}
