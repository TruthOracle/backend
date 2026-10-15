import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import { InstrumentsService } from "../services/instruments.service";
import type { ApiInstrument } from "../types";

/**
 * `GET /exchange/instruments` (docs/TOKENS.md §4.1): every enabled instrument with its symbol,
 * decimals and the id the Cantor8 wallet SDK expects — what a client needs to label amounts and
 * to offer a deposit. Public: the list is the platform's configuration, not anyone's data.
 */
@ApiTags("exchange")
@Controller("exchange/instruments")
@Public()
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  @Get()
  async list(): Promise<{ instruments: ApiInstrument[] }> {
    const rows = await this.instruments.list();
    return { instruments: rows.map((r) => this.instruments.toApi(r)) };
  }
}
