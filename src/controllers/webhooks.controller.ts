import { Controller, HttpCode, Logger, Post, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import {
  KycProviderSumsubService,
  redactSumsubPayload,
} from "../services/kyc-provider-sumsub.service";
import { KycService } from "../services/kyc.service";
import { RateLimitService } from "../services/rate-limit.service";
import { ApiError } from "../util/errors";

/**
 * Signature-verified provider webhooks (docs/API.md "Webhooks"; ARCHITECTURE §9.2). @Public
 * and exempt from CSRF (no cookies are involved — `CsrfGuard` skips `/webhooks/**`); the digest
 * over the RAW body (`req.rawBody`, captured by app.setup's JSON parser) is the authentication.
 * Events are stored first (idempotent on the body hash), acked 200, then `{ eventId }` is
 * published for the durable consumer — the webhook is only a trigger; approval is decided by
 * re-reading the provider API.
 */
@ApiTags("webhooks")
@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly kyc: KycService,
    private readonly sumsub: KycProviderSumsubService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** `200 { received: true }` | `401 webhook_rejected`. Rate limit: webhook 600/min/IP (§13). */
  @Public()
  @Post("kyc/sumsub")
  @HttpCode(200)
  async sumsubWebhook(@Req() req: AuthedRequest): Promise<{ received: true }> {
    await this.rateLimit.enforce("webhook", { ip: req.clientIp });
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      throw new ApiError(401, "webhook_rejected", "webhook body is missing or not JSON");
    }
    // Digest + algorithm headers both required, allow-listed algorithm, timing-safe compare.
    const event = this.sumsub.verifyWebhook(raw, req.headers);
    if (!event) throw new ApiError(401, "webhook_rejected", "webhook signature rejected");

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
}
