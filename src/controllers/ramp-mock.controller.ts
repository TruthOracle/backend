import { Body, Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, principalOf } from "../auth/request";
import { RampMockCompleteDto } from "../dto/ramp.dto";
import {
  RampProviderMockService,
  type SignedDelivery,
} from "../services/ramp-provider-mock.service";
import { RampService } from "../services/ramp.service";
import { parseAmount } from "../util/money";

/**
 * The mock acquirer's hosted page (docs/RAMP.md §9). NOT in the controllers barrel: AppModule
 * registers it only while `RAMP_PROVIDER=mock` (refused with RAMP_ENABLED in prod and on
 * mainnet). Completing a payment produces the SIGNED delivery a real acquirer would POST and
 * runs it through the same webhook pipeline (`RampService.receiveWebhook`), so signature,
 * timestamp and idempotency checks are exercised end to end; nothing here decides an order.
 */
@ApiTags("ramp")
@Controller("ramp/mock")
export class RampMockController {
  constructor(
    private readonly mock: RampProviderMockService,
    private readonly ramp: RampService,
  ) {}

  /**
   * The payer finishes a mock payment (`:paymentId` may be the order id — the user API shows no
   * payment id for ERIP): `succeeded` (card: 3DS authenticated), `declined`, or `no_3ds`.
   */
  @Post("payments/:paymentId/complete")
  @HttpCode(200)
  async complete(
    @Param("paymentId") paymentId: string,
    @Body() body: RampMockCompleteDto,
    @Req() req: AuthedRequest,
  ): Promise<{ delivered: true }> {
    const { user } = principalOf(req);
    await this.deliver(
      this.mock.complete(paymentId, user.id, body.outcome, {
        cardSeed: body.cardSeed,
        cardCountry: body.cardCountry,
        capturedAmount:
          body.capturedAmount !== undefined ? parseAmount(body.capturedAmount) : undefined,
        payerName: body.payerName,
        payerNameSource: body.payerNameSource,
        channel: body.channel,
        payerIban: body.payerIban,
        payerBankBic: body.payerBankBic,
      }),
    );
    return { delivered: true };
  }

  /** The issuer disputes a captured mock payment (dev / test of the chargeback path). */
  @Post("payments/:paymentId/chargeback")
  @HttpCode(200)
  async chargeback(
    @Param("paymentId") paymentId: string,
    @Req() req: AuthedRequest,
  ): Promise<{ delivered: true }> {
    const { user } = principalOf(req);
    await this.deliver(this.mock.chargeback(paymentId, user.id));
    return { delivered: true };
  }

  private async deliver(delivery: SignedDelivery): Promise<void> {
    await this.ramp.receiveWebhook("mock", {
      rawBody: delivery.rawBody,
      headers: delivery.headers,
      body: JSON.parse(delivery.rawBody.toString("utf8")) as unknown,
      contentType: "application/json",
      // In-process: the "acquirer" is this host, so the source is loopback.
      sourceIp: "127.0.0.1",
    });
  }
}
