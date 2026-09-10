import {
  Body,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  createParamDecorator,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { AdminGuard } from "../auth/admin.guard";
import type { AuthedRequest } from "../auth/request";
import {
  AdminAuditQueryDto,
  AdminKycOverrideDto,
  AdminPayoutSettleDto,
  AdminPayoutsQueryDto,
  AdminPersonTransferDto,
  AdminReasonDto,
  AdminUsersQueryDto,
} from "../dto/admin.dto";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
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

/** The operator behind an admin request; AdminGuard guarantees the session and user exist. */
export function adminActorOf(req: AuthedRequest): AdminActor {
  if (!req.user || !req.session) {
    throw new ApiError(401, "unauthenticated", "authentication required");
  }
  return { type: "admin", userId: req.user.id, sessionId: req.session.id, ip: req.clientIp ?? null };
}

const Actor = createParamDecorator((_data: unknown, ctx: ExecutionContext): AdminActor =>
  adminActorOf(ctx.switchToHttp().getRequest<AuthedRequest>()),
);

/**
 * Operator API (docs/API.md "Admin"; ARCHITECTURE §11). Every route sits behind AdminGuard —
 * a wallet-signed `kind = admin` session whose party is still in ADMIN_OPERATORS (§6.8).
 * Every mutation requires a `reason` and is audited with actorType `admin`.
 */
@ApiTags("admin")
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
    @Actor() actor: AdminActor,
  ): Promise<{ ok: true }> {
    return this.admin.suspend(id, body.reason, actor);
  }

  @Post("users/:id/reinstate")
  @HttpCode(200)
  reinstate(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Actor() actor: AdminActor,
  ): Promise<{ ok: true }> {
    return this.admin.reinstate(id, body.reason, actor);
  }

  @Post("users/:id/sessions/revoke")
  @HttpCode(200)
  revokeSessions(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Actor() actor: AdminActor,
  ): Promise<{ ok: true }> {
    return this.admin.revokeSessions(id, body.reason, actor);
  }

  // ───────────────────────────────────────── identities ────────────────────────────────────────

  @Post("users/:id/identities/:identityId/reattach")
  @HttpCode(200)
  reattachIdentity(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("identityId", ParseUUIDPipe) identityId: string,
    @Body() body: AdminReasonDto,
    @Actor() actor: AdminActor,
  ): Promise<{ identity: ApiIdentity }> {
    return this.admin.reattachIdentity(id, identityId, body.reason, actor);
  }

  @Post("users/:id/identities/:identityId/unlink")
  @HttpCode(200)
  unlinkIdentity(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("identityId", ParseUUIDPipe) identityId: string,
    @Body() body: AdminReasonDto,
    @Actor() actor: AdminActor,
  ): Promise<{ identity: ApiIdentity }> {
    return this.admin.unlinkIdentity(id, identityId, body.reason, actor);
  }

  // ───────────────────────────────────────────── KYC ───────────────────────────────────────────

  @Post("users/:id/kyc/override")
  @HttpCode(200)
  kycOverride(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminKycOverrideDto,
    @Actor() actor: AdminActor,
  ): Promise<{ verification: ApiKycVerification }> {
    return this.admin.kycOverride(id, body.status, body.reason, actor);
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
    @Param("fingerprint") fingerprint: string,
    @Body() body: AdminPersonTransferDto,
    @Actor() actor: AdminActor,
  ): Promise<{ ok: true }> {
    return this.admin.transferPerson(fingerprint, body.toUserId, body.reason, actor);
  }

  // ─────────────────────────────────────────── payouts ─────────────────────────────────────────

  @Get("payouts")
  payouts(@Query() query: AdminPayoutsQueryDto): Promise<{ items: ApiPayout[] }> {
    return this.admin.listPayouts(query.status);
  }

  @Post("payouts/:cid/settle")
  @HttpCode(200)
  settlePayout(
    @Param("cid") cid: string,
    @Body() body: AdminPayoutSettleDto,
    @Actor() actor: AdminActor,
  ): Promise<{ payout: ApiPayout; mode: "external" | "in_app" | "already_settled" }> {
    return this.admin.settlePayout(cid, { force: body.force === true, reason: body.reason }, actor);
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
