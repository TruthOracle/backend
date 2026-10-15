import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import {
  CreateInstrumentDto,
  InstrumentParamsDto,
  InstrumentSetupDto,
  UpdateInstrumentDto,
} from "../dto/instruments.dto";
import { InstrumentsService } from "../services/instruments.service";
import { TreasuryTransferService } from "../services/treasury-transfer.service";
import type { ApiAdminInstrument, ApiInstrumentSetupResult } from "../types";
import { adminActorOf } from "./admin.controller";

/**
 * Operator side of the instruments registry (docs/TOKENS.md §4.1, §4.4): list (disabled rows
 * included), register a token, change its presentation / registry / transfer wiring or enable /
 * disable it, and run the one-off setup a Cantor8 token needs from the treasury (AutoAccept,
 * MintDelegation — exercised on the token's factory through its registry). The `(admin, id)` pair
 * is immutable — it IS the token on the ledger. Same guard chain as AdminController; every
 * mutation is audited.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/instruments")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminInstrumentsController {
  constructor(
    private readonly instruments: InstrumentsService,
    private readonly treasuryTransfers: TreasuryTransferService,
  ) {}

  @Get()
  async list(): Promise<{ instruments: ApiAdminInstrument[] }> {
    const rows = await this.instruments.list({ includeDisabled: true });
    return { instruments: rows.map((r) => this.instruments.toAdminApi(r)) };
  }

  @Post()
  @HttpCode(200)
  async create(
    @Body() body: CreateInstrumentDto,
    @Req() req: AuthedRequest,
  ): Promise<{ instrument: ApiAdminInstrument }> {
    const { reason, ...input } = body;
    const row = await this.instruments.create(input, adminActorOf(req), reason);
    return { instrument: this.instruments.toAdminApi(row) };
  }

  @Patch(":admin/:id")
  @HttpCode(200)
  async update(
    @Param() params: InstrumentParamsDto,
    @Body() body: UpdateInstrumentDto,
    @Req() req: AuthedRequest,
  ): Promise<{ instrument: ApiAdminInstrument }> {
    const { reason, ...patch } = body;
    const row = await this.instruments.update(
      params.admin,
      params.id,
      patch,
      adminActorOf(req),
      reason,
    );
    return { instrument: this.instruments.toAdminApi(row) };
  }

  /**
   * `400 validation_failed` (neither action) | `404 not_found` | `503 not_ready` (no registry URL)
   * | `502 upstream_failed` (registry or wallet). Audited `token.setup` per action.
   */
  @Post(":admin/:id/setup")
  @HttpCode(200)
  async setup(
    @Param() params: InstrumentParamsDto,
    @Body() body: InstrumentSetupDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiInstrumentSetupResult> {
    const instrument = await this.instruments.require(params.admin, params.id);
    return this.treasuryTransfers.setup(
      instrument,
      { autoAccept: body.autoAccept, mintDelegation: body.mintDelegation },
      adminActorOf(req),
      body.reason,
    );
  }
}
