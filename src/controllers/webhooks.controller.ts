import { Controller, HttpCode, Logger, Param, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import { type AuthedRequest, webhookSourceIpOf } from "../auth/request";
import { Config } from "../config";
import {
  KycProviderSumsubService,
  redactSumsubPayload,
} from "../services/kyc-provider-sumsub.service";
import { KycService } from "../services/kyc.service";
import { RampService } from "../services/ramp.service";
import { RateLimitService } from "../services/rate-limit.service";
import type { KycEvent } from "../types";
import { ApiError } from "../util/errors";

/**
 * Signature-verified provider webhooks (docs/API.md "Webhooks"; ARCHITECTURE §9.2). @Public
 * and exempt from CSRF (no cookies are involved — `CsrfGuard` skips `/webhooks/**`); the digest
 * over the RAW body (`req.rawBody`, captured by app.setup's parsers) is the authentication.
 * Events are stored first (idempotent on the body hash), acked 200, then `{ eventId }` is
 * published for the durable consumer — the webhook is only a trigger; approval is decided by
 * re-reading the provider API.
 *
 * Rate limiting (SPEC §8, X13): verification runs first and a delivery that verifies is ALWAYS
 * accepted; only rejected deliveries are counted, per (provider, source address), and past the
 * limit a rejection answers 429. Senders sharing an edge address can therefore never starve the
 * provider's real deliveries.
 */
@ApiTags("webhooks")
@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly config: Config,
    private readonly kyc: KycService,
    private readonly sumsub: KycProviderSumsubService,
    private readonly ramp: RampService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** `200 { received: true }` | `401 webhook_rejected` | `429 rate_limited` (rejections only, §13). */
  @Public()
  @Post("kyc/sumsub")
  @HttpCode(200)
  async sumsubWebhook(@Req() req: AuthedRequest): Promise<{ received: true }> {
    let event: KycEvent;
    try {
      event = this.verifiedSumsubEvent(req);
    } catch (err) {
      return this.countRejection("sumsub", webhookSourceIpOf(req, this.config), err);
    }

    const body = redactSumsubPayload(req.body);
    const stored = await this.kyc.storeWebhookEvent("sumsub", event, body);
    if (!stored.processed) {
      try {
        await this.kyc.publishWebhookTrigger("sumsub", stored.id, event.eventKey);
      } catch (err) {
        // The row is durable; KycWebhookProcessor's sweep re-publishes it. Never make Sumsub retry.
        this.logger.warn(
          `webhook ${stored.id} stored but its trigger was not published: ${(err as Error).message}`,
        );
      }
    }
    return { received: true };
  }

  /**
   * The acquirer (SPEC §8, §9): `200 { received: true }` | `401 webhook_rejected` | `404 not_found`
   * (not the configured provider) | `429 rate_limited` (rejections only). JSON or
   * `application/x-www-form-urlencoded`, both captured raw; RampService runs the checks in order
   * (provider → source allow-list for IP-authenticated providers → signature → inbox), and the
   * order moves only on the acquirer's API read that follows.
   */
  @Public()
  @Post("ramp/:provider")
  @HttpCode(200)
  async rampWebhook(
    @Param("provider") provider: string,
    @Req() req: AuthedRequest,
  ): Promise<{ received: true }> {
    const sourceIp = webhookSourceIpOf(req, this.config);
    const contentType = req.headers["content-type"];
    try {
      await this.ramp.receiveWebhook(provider, {
        rawBody: req.rawBody ?? Buffer.alloc(0),
        headers: req.headers,
        body: req.body,
        contentType: typeof contentType === "string" ? contentType : "",
        sourceIp,
      });
    } catch (err) {
      return this.countRejection(provider, sourceIp, err);
    }
    return { received: true };
  }

  /** Digest + algorithm headers both required, allow-listed algorithm, timing-safe compare. */
  private verifiedSumsubEvent(req: AuthedRequest): KycEvent {
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      throw new ApiError(401, "webhook_rejected", "webhook body is missing or not JSON");
    }
    const event = this.sumsub.verifyWebhook(raw, req.headers);
    if (!event) throw new ApiError(401, "webhook_rejected", "webhook signature rejected");
    return event;
  }

  /** Count a REJECTED delivery against (provider, source); past the limit it answers 429. */
  private async countRejection(provider: string, sourceIp: string, err: unknown): Promise<never> {
    if (ApiError.is(err) && err.code === "webhook_rejected") {
      await this.rateLimit.enforce("webhook_failure", { subject: `${provider}|${sourceIp}` });
    }
    throw err;
  }
}
