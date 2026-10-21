import { Body, Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, actorOf, principalOf } from "../auth/request";
import { RampConsentDto } from "../dto/compliance.dto";
import { RampConsentService } from "../services/ramp-consent.service";
import type { ApiRampConsentResult } from "../types";

/**
 * The ramp terms consent (SPEC §11.2, §12.1; B4, ПВК p.31): the current terms version, "I act for
 * myself" (else who for) and the PEP self-declaration — appended with IP and user agent, never
 * edited. `GET /ramp.consent.required` says whether the current terms still need it. A declaration
 * of acting for another or of being a PEP is recorded and reviewed (the user sees the neutral
 * `compliance` reason until AML decides).
 */
@ApiTags("ramp")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("ramp")
export class RampConsentController {
  constructor(private readonly consents: RampConsentService) {}

  /**
   * `{consent: {required: false, termsVersion}}`; `400 validation_failed` (stale terms, missing
   * principal) | `503 ramp_unavailable` | `409 kyc_required` (a declaration before KYC) | `429`
   * (also while the account's previous declaration of the kind is undecided, R2b-7).
   */
  @Post("consent")
  @HttpCode(200)
  consent(
    @Body() body: RampConsentDto,
    @Headers("user-agent") userAgent: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ApiRampConsentResult> {
    const { user } = principalOf(req);
    return this.consents.give(
      user.id,
      {
        termsVersion: body.termsVersion,
        actsForSelf: body.actsForSelf,
        principal: body.principal,
        pepDeclared: body.pepDeclared,
        pepDetail: body.pepDetail,
      },
      { userAgent: userAgent ?? null, kycStatus: user.kycStatus },
      actorOf(req),
    );
  }
}
