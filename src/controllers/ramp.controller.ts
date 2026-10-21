import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, actorOf, principalOf } from "../auth/request";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import {
  IDEMPOTENCY_KEY_RE,
  RampAttachDto,
  type RampDestinationDto,
  RampOfframpDto,
  RampOnrampDto,
  RampOrdersQueryDto,
  RampQuoteDto,
} from "../dto/ramp.dto";
import { type RampDestinationInput, RampService } from "../services/ramp.service";
import { RateLimitService } from "../services/rate-limit.service";
import type {
  ApiRampAttachResult,
  ApiRampCards,
  ApiRampOfframpResult,
  ApiRampOnrampResult,
  ApiRampOrder,
  ApiRampOrderList,
  ApiRampOverview,
  ApiRampQuote,
} from "../types";
import { ApiError } from "../util/errors";
import { parseAmount } from "../util/money";

/** `400 validation_failed` unless the header is a usable retry token. */
function idempotencyKeyOf(raw: string | undefined): string {
  const key = (raw ?? "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(key))
    throw new ApiError(
      400,
      "validation_failed",
      "the Idempotency-Key header is required (8-128 characters: letters, digits, _ . : -)",
    );
  return key;
}

/** The destination DTO as the service's union: exactly the id its kind names. */
function destinationOf(d: RampDestinationDto): RampDestinationInput {
  if (d.kind === "card" && d.paymentMethodId && !d.bankAccountId)
    return { kind: "card", paymentMethodId: d.paymentMethodId };
  if (d.kind === "bank" && d.bankAccountId && !d.paymentMethodId)
    return { kind: "bank", bankAccountId: d.bankAccountId };
  throw new ApiError(
    400,
    "validation_failed",
    "destination is {kind: card, paymentMethodId} or {kind: bank, bankAccountId}",
  );
}

/**
 * The account's fiat ramp (SPEC §12.1; docs/API.md "Fiat ramp"): buy the ramp instrument (cBYN)
 * by card or ERIP, cash it out back to a funding card or (S6) to a bank account. Amounts are
 * re-quoted by the service; the order moves only on the acquirer's API and the ledger. Opening,
 * attaching and cancelling share the `ramp_order` rate limit (10/min/user).
 */
@ApiTags("ramp")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("ramp")
export class RampController {
  constructor(
    private readonly ramp: RampService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  overview(@Req() req: AuthedRequest): Promise<ApiRampOverview> {
    return this.ramp.overview(principalOf(req).user);
  }

  /**
   * `{fiatAmount, tokenAmount, fee, withinLimits, limit?}` — `limit.name` ∈ min | max | daily |
   * monthly | card_cashout | exposure. `400 validation_failed` (decimals, below the fee) | `503 ramp_unavailable`.
   */
  @Post("quote")
  @HttpCode(200)
  quote(@Body() body: RampQuoteDto, @Req() req: AuthedRequest): Promise<ApiRampQuote> {
    return this.ramp.quote(principalOf(req).user, {
      direction: body.direction,
      amount: parseAmount(body.amount),
      method: body.method,
      destination: body.destination ? destinationOf(body.destination) : undefined,
    });
  }

  /**
   * `{order}` with `order.next` (hosted page or ERIP details). `503 ramp_unavailable` | `403
   * user_suspended | ramp_not_eligible` | `409 no_primary_wallet | kyc_required |
   * ramp_limit_exceeded | ramp_quote_changed | ramp_order_open` | `400 validation_failed` | `502
   * upstream_failed` (the acquirer refused, or its payment details were unusable: the order is `failed`).
   */
  @Post("onramp")
  @HttpCode(200)
  async onramp(
    @Body() body: RampOnrampDto,
    @Headers("idempotency-key") key: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ApiRampOnrampResult> {
    const { user } = principalOf(req);
    const idempotencyKey = idempotencyKeyOf(key);
    await this.rateLimit.enforce("ramp_order", { userId: user.id });
    return this.ramp.createOnramp(
      user,
      {
        amount: parseAmount(body.amount),
        method: body.method ?? "card",
        expectedTokenAmount:
          body.expectedTokenAmount !== undefined
            ? parseAmount(body.expectedTokenAmount)
            : undefined,
      },
      idempotencyKey,
      actorOf(req),
    );
  }

  /**
   * `{order}` with `order.withdraw` to sign. The on-ramp's errors plus `403 ramp_not_eligible` (no
   * payout-eligible card) | `409 ramp_rail_unavailable | ramp_card_cashout_limit (details.available)
   * | ramp_exposure (details.withdrawableToBank) | no_in_app_wallet | insufficient_balance`.
   */
  @Post("offramp")
  @HttpCode(200)
  async offramp(
    @Body() body: RampOfframpDto,
    @Headers("idempotency-key") key: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<ApiRampOfframpResult> {
    const { user } = principalOf(req);
    const idempotencyKey = idempotencyKeyOf(key);
    await this.rateLimit.enforce("ramp_order", { userId: user.id });
    return this.ramp.createOfframp(
      user,
      {
        amount: parseAmount(body.amount),
        destination: destinationOf(body.destination),
        expectedFiatAmount:
          body.expectedFiatAmount !== undefined ? parseAmount(body.expectedFiatAmount) : undefined,
      },
      idempotencyKey,
      actorOf(req),
    );
  }

  /** `{orders, nextCursor}`, newest first; pass `nextCursor` back as `cursor` for the next page. */
  @Get("orders")
  orders(@Query() query: RampOrdersQueryDto, @Req() req: AuthedRequest): Promise<ApiRampOrderList> {
    return this.ramp.listOrders(principalOf(req).user.id, {
      direction: query.direction,
      cursor: query.cursor,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  @Get("orders/:id")
  async order(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ order: ApiRampOrder }> {
    return { order: await this.ramp.getOrder(principalOf(req).user.id, id) };
  }

  /**
   * `409 ramp_order_state` (not waiting, or the PendingPayout does not match the order) | `404
   * not_found`. A 200 with `bindPending` (F6): the withdrawal matched but is not bound yet (why in
   * `bindReason`) — attach it again later, never sign twice.
   */
  @Post("orders/:id/attach")
  @HttpCode(200)
  async attach(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RampAttachDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiRampAttachResult> {
    const { user } = principalOf(req);
    await this.rateLimit.enforce("ramp_order", { userId: user.id });
    return this.ramp.attach(user, id, body.pendingPayoutCid, actorOf(req));
  }

  /** `409 ramp_order_state` once the user paid / signed, or when the acquirer can no longer void the checkout. */
  @Post("orders/:id/cancel")
  @HttpCode(200)
  async cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ order: ApiRampOrder }> {
    const { user } = principalOf(req);
    await this.rateLimit.enforce("ramp_order", { userId: user.id });
    return { order: await this.ramp.cancel(user, id, actorOf(req)) };
  }

  /** `{cards}`, each with `cashout {mode: refund | oct | none, available}`. */
  @Get("payment-methods")
  paymentMethods(@Req() req: AuthedRequest): Promise<ApiRampCards> {
    return this.ramp.paymentMethods(principalOf(req).user);
  }

  @Delete("payment-methods/:id")
  @HttpCode(204)
  async removePaymentMethod(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.ramp.removePaymentMethod(principalOf(req).user.id, id, actorOf(req));
  }
}
