import { Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, actorOf, principalOf } from "../auth/request";
import { type KycSessionStart, KycService } from "../services/kyc.service";
import { RateLimitService } from "../services/rate-limit.service";
import type { ApiKycSummary, ApiKycVerification } from "../types";

/**
 * KYC routes (docs/API.md "KYC"; ARCHITECTURE §9.5). A verification is attached to the account
 * AND to the sign-in identity of the session that started it (`initiated_identity_id`), which
 * the KYC lock (§6.5) then protects while the approval stands.
 */
@ApiTags("kyc")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("kyc")
export class KycController {
  constructor(
    private readonly kyc: KycService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** `KycSummary & { history }` — which identity the verification is attached to, every attempt. */
  @Get()
  summary(@Req() req: AuthedRequest): Promise<ApiKycSummary & { history: ApiKycVerification[] }> {
    const { user } = principalOf(req);
    return this.kyc.summaryForUser(user.id);
  }

  /**
   * `200 { provider: "sumsub", accessToken, expiresAt, levelName, verificationId }` |
   * `200 { provider: "mock", verificationId, levelName }` | `409 kyc_duplicate_identity` |
   * `503 kyc_provider_unavailable`. The WebSDK token refresh calls the same route (idempotent).
   * Rate limit: kyc session 5/min/user (§13).
   */
  @Post("sessions")
  @HttpCode(200)
  async startSession(@Req() req: AuthedRequest): Promise<KycSessionStart> {
    const { user, session } = principalOf(req);
    await this.rateLimit.enforce("kyc_session", { userId: user.id });
    return this.kyc.startSession(user, session, actorOf(req));
  }
}
