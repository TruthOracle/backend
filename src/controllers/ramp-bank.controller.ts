import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, actorOf, principalOf } from "../auth/request";
import { RampBankAccountAddDto } from "../dto/ramp-bank.dto";
import { RampBankAccountsService } from "../services/ramp-bank-accounts.service";
import type { ApiRampBankAccount } from "../types";

/**
 * The account's payout bank accounts (SPEC §10.2, §12.1): BYN IBANs in the user's verified name.
 * Adding needs a session signed in within 15 minutes (`401 recent_auth_required`), a verified
 * identity with the chosen name form, and stays within the per-user limits; a new account cools off
 * and becomes usable once proved. `400 bank_account_invalid` never says why a valid-looking IBAN
 * is refused (no enumeration). Removal is refused while a payout to the account is in progress.
 */
@ApiTags("ramp")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("ramp/bank-accounts")
export class RampBankController {
  constructor(private readonly accounts: RampBankAccountsService) {}

  @Get()
  async list(@Req() req: AuthedRequest): Promise<{ accounts: ApiRampBankAccount[] }> {
    return { accounts: await this.accounts.list(principalOf(req).user.id) };
  }

  /**
   * `{account}`. `401 recent_auth_required` | `400 bank_account_invalid | validation_failed` (no
   * name in that form) | `409 bank_account_exists | bank_account_limit | kyc_required |
   * kyc_identity_unavailable | ramp_rail_unavailable` | `429 rate_limited`.
   */
  @Post()
  @HttpCode(200)
  async add(
    @Body() body: RampBankAccountAddDto,
    @Req() req: AuthedRequest,
  ): Promise<{ account: ApiRampBankAccount }> {
    const { user, session } = principalOf(req);
    return {
      account: await this.accounts.add(
        user,
        session,
        { iban: body.iban, nameForm: body.nameForm },
        actorOf(req),
      ),
    };
  }

  /** `{account}` (status `removed`). `409 bank_account_in_use` while a payout to it is in progress. */
  @Delete(":id")
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ account: ApiRampBankAccount }> {
    return { account: await this.accounts.remove(principalOf(req).user.id, id, actorOf(req)) };
  }
}
