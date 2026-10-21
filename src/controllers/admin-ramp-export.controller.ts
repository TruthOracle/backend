import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession, RequireRoles } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { RampOperationsExportDto } from "../dto/compliance-screening.dto";
import { RampOperationsExportService } from "../services/ramp-operations-export.service";
import { RateLimitService } from "../services/rate-limit.service";
import { adminActorOf } from "./admin.controller";

/**
 * The operations register (SPEC §11.6): `POST /admin/ramp/operations/export {from, to}` (role
 * `export`, ≤ 31 days, admin_export limit) answers the CSV itself — `Content-Disposition`
 * attachment, `X-Export-Id` — and the row count is audited (`ramp.operations.exported`).
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/ramp/operations")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminRampExportController {
  constructor(
    private readonly exports: RampOperationsExportService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post("export")
  @HttpCode(200)
  @RequireRoles("export")
  async export(
    @Body() body: RampOperationsExportDto,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const actor = adminActorOf(req);
    await this.rateLimit.enforce("admin_export", { userId: actor.userId });
    const out = await this.exports.operations({ from: body.from, to: body.to }, actor);
    res
      .status(200)
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "X-Export-Id": out.exportId,
        "Cache-Control": "no-store",
      })
      .send(out.csv);
  }
}
