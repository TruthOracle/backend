import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, principalOf } from "../auth/request";
import { KycMockSubmitDto } from "../dto/kyc.dto";
import { KycService } from "../services/kyc.service";
import type { ApiKycVerification, UserKycStatus } from "../types";

/**
 * Mock provider driver (docs/API.md `POST /kyc/mock/submit`; ARCHITECTURE §9.1). NOT in the
 * controllers barrel: AppModule registers it only when `config.kycProvider === "mock"` (which
 * config.ts refuses in prod and on mainnet), so the route is absent otherwise. The submitted
 * person/document values are fingerprinted inside KycService and never persisted or logged.
 */
@ApiTags("kyc")
@Controller("kyc/mock")
export class KycMockController {
  constructor(private readonly kyc: KycService) {}

  /** Drives the identical stored-event → applyEvent → fetchApplicant pipeline Sumsub uses. */
  @Post("submit")
  @HttpCode(200)
  submit(@Body() body: KycMockSubmitDto, @Req() req: AuthedRequest): Promise<{ verification: ApiKycVerification; userKycStatus: UserKycStatus }> {
    const { user } = principalOf(req);
    return this.kyc.submitMock(user, body);
  }
}
