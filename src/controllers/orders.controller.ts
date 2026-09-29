import { Body, Controller, HttpCode, Param, Post, Req, UseInterceptors } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, principalOf } from "../auth/request";
import { PrepareOrderDto } from "../dto/orders.dto";
import { MarketsService } from "../services/markets.service";
import { QuoteService } from "../services/quote.service";
import type { ApiPreparedOrder } from "../types";
import { LedgerOffsetInterceptor } from "../util/ledger-offset.interceptor";
import { parseCC } from "../util/money";

/**
 * Order preparation (docs/API.md "Quotes and orders"; docs/MARKETS.md §7): the signed-in
 * account asks for the exact ExerciseCommand its primary wallet must sign, with the market's
 * disclosed contract and the account's own contract ids read from the index. Nothing is
 * submitted here — the user's Cantor8 wallet signs and submits, and the caller then waits on
 * `GET /ledger/wait?offset=` for the index to reflect the trade. User sessions only.
 */
@ApiTags("orders")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("markets")
@UseInterceptors(LedgerOffsetInterceptor)
export class OrdersController {
  constructor(
    private readonly markets: MarketsService,
    private readonly quotes: QuoteService,
  ) {}

  @Post(":market/orders/prepare")
  @HttpCode(200)
  async prepare(
    @Param("market") ref: string,
    @Body() body: PrepareOrderDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiPreparedOrder> {
    const { user } = principalOf(req);
    const market = await this.markets.resolve(ref);
    return this.quotes.prepare(user, market, {
      action: body.action,
      side: body.side,
      amountCC: body.amountCC === undefined ? undefined : parseCC(body.amountCC),
      shares: body.shares === undefined ? undefined : parseCC(body.shares),
      lpTokens: body.lpTokens === undefined ? undefined : parseCC(body.lpTokens),
      slippageBps: body.slippageBps,
    });
  }
}
