import { Injectable } from "@nestjs/common";

import { ApiError } from "../util/errors";
import { RedisService } from "./redis.service";

export type RateLimitScope =
  | "login"
  | "nonce"
  | "challenge"
  | "telegram"
  | "link"
  | "reconcile"
  | "settle"
  | "kyc_session"
  | "webhook";

export interface RateLimitDims {
  ip?: string | null;
  subject?: string | null;
  userId?: string | null;
}

const MINUTE = 60_000;

/**
 * Fixed-window limits keyed by client IP (from the proxy contract) AND by subject
 * (docs/ARCHITECTURE.md §13). Each entry: [dimension, max per minute].
 */
export const RATE_LIMITS: Record<
  RateLimitScope,
  { dim: "ip" | "subject" | "userId"; max: number; windowMs: number }[]
> = {
  login: [
    { dim: "ip", max: 10, windowMs: MINUTE },
    { dim: "subject", max: 5, windowMs: MINUTE },
  ],
  nonce: [{ dim: "ip", max: 30, windowMs: MINUTE }],
  challenge: [
    { dim: "ip", max: 30, windowMs: MINUTE },
    { dim: "subject", max: 10, windowMs: MINUTE },
  ],
  telegram: [{ dim: "ip", max: 10, windowMs: MINUTE }],
  link: [{ dim: "userId", max: 10, windowMs: MINUTE }],
  reconcile: [{ dim: "userId", max: 30, windowMs: MINUTE }],
  settle: [{ dim: "userId", max: 30, windowMs: MINUTE }],
  kyc_session: [{ dim: "userId", max: 5, windowMs: MINUTE }],
  webhook: [{ dim: "ip", max: 600, windowMs: MINUTE }],
};

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /** Count one hit; throws `429 rate_limited` (with `details.retryAfterSec`) when over `max`. */
  async hit(scope: string, key: string, windowMs: number, max: number): Promise<void> {
    const result = await this.redis.hitRateLimit(`rl:${scope}:${key}`, windowMs, max);
    if (result.limited) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      throw new ApiError(429, "rate_limited", "too many requests, try again shortly", {
        scope,
        retryAfterSec,
      });
    }
  }

  /** Apply every configured dimension of `scope` that the caller supplied. */
  async enforce(scope: RateLimitScope, dims: RateLimitDims): Promise<void> {
    for (const rule of RATE_LIMITS[scope]) {
      const value = dims[rule.dim];
      if (!value) continue;
      await this.hit(scope, `${rule.dim}:${value}`, rule.windowMs, rule.max);
    }
  }
}
