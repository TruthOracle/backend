import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import { ExchangeService } from "../services/exchange.service";
import type { ApiExchangeStatus } from "../types";

/** `GET /exchange/status` — Kalshi's exchange / trading flags for this platform (docs/MARKETS.md §8). */
@ApiTags("exchange")
@Controller("exchange")
@Public()
export class ExchangeController {
  constructor(private readonly exchange: ExchangeService) {}

  @Get("status")
  status(): Promise<ApiExchangeStatus> {
    return this.exchange.status();
  }
}
