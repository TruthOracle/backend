import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { AdminGuard } from "../auth/admin.guard";
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
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import { PayoutCidParamDto } from "../dto/payouts.dto";
import {
  type AdminActor,
  type AdminAuditFilter,
  type AdminKycQueueItem,
  AdminService,
  type AdminUserDetail,
} from "../services/admin.service";
import type {
  ApiAuditEvent,
  ApiIdentity,
  ApiKycVerification,
  ApiPage,
  ApiPayout,
  ApiUser,
} from "../types";
import { ApiError } from "../util/errors";

/** The operator behind an admin request: `actorOf` narrowed to the admin session AdminGuard guarantees. */
export function adminActorOf(req: AuthedRequest): AdminActor {
  const actor = actorOf(req);
  if (actor.type !== "admin" || !actor.userId || !actor.sessionId) {
    throw new ApiError(403, "forbidden", "an admin session is required");
  }
  return { type: "admin", userId: actor.userId, sessionId: actor.sessionId, ip: actor.ip ?? null };
}

/**
 * Operator API (docs/API.md "Admin"; ARCHITECTURE §11). Every route sits behind AdminGuard —
 * a wallet-signed `kind = admin` session whose party is still in ADMIN_OPERATORS (§6.8).
 * Every mutation requires a `reason` and is audited with actorType `admin`.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

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

  @Post("users/:id/reinstate")
  @HttpCode(200)
  reinstate(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.admin.reinstate(id, body.reason, adminActorOf(req));
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

  @Post("users/:id/kyc/override")
  @HttpCode(200)
  kycOverride(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminKycOverrideDto,
    @Req() req: AuthedRequest,
  ): Promise<{ verification: ApiKycVerification }> {
    return this.admin.kycOverride(id, body.status, body.reason, adminActorOf(req));
  }

  @Get("kyc/duplicates")
  kycDuplicates(): Promise<{ items: AdminKycQueueItem[] }> {
    return this.admin.kycDuplicates();
  }

  @Get("kyc/needs-review")
  kycNeedsReview(): Promise<{ items: AdminKycQueueItem[] }> {
    return this.admin.kycNeedsReview();
  }

  @Post("kyc/persons/:fingerprint/transfer")
  @HttpCode(200)
  transferPerson(
    @Param() params: FingerprintParamDto,
    @Body() body: AdminPersonTransferDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.admin.transferPerson(params.fingerprint, body.toUserId, body.reason, adminActorOf(req));
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

  @Post("payouts/:cid/settle")
  @HttpCode(200)
  settlePayout(
    @Param() params: PayoutCidParamDto,
    @Body() body: AdminPayoutSettleDto,
    @Req() req: AuthedRequest,
  ): Promise<{ payout: ApiPayout; mode: "external" | "in_app" | "already_settled" }> {
    return this.admin.settlePayout(params.cid, { force: body.force === true, reason: body.reason }, adminActorOf(req));
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
