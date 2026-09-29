import { createHash, randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { OAuth2Client, type TokenPayload } from "google-auth-library";

import { Config } from "../config";
import type { IdentityClaim } from "../types";
import { ApiError } from "../util/errors";
import { timingSafeStringEqual } from "../util/strings";
import { MINUTE_MS } from "../util/time";
import { RedisService } from "./redis.service";

/** A nonce lives 10 minutes and is consumed exactly once (docs/ARCHITECTURE.md §7.1). */
export const GOOGLE_NONCE_TTL_MS = 10 * MINUTE_MS;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

function nonceKey(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("base64url");
}

/** Never echo a token-looking run into the log, whatever google-auth-library put in its message. */
function safeMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[A-Za-z0-9_-]{32,}/g, "…").slice(0, 160);
}

/**
 * Google Identity Services, ID-token flow (docs/ARCHITECTURE.md §7.1). The frontend posts the
 * GIS `credential`; we verify it against every configured client id, require a verified email,
 * and — when a nonce was issued — require the token's `nonce` claim to match a nonce that this
 * backend issued and that nobody has used before.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  /** Audience is passed per call, so one client serves every configured client id. The cert fetch gets a deadline too. */
  private readonly client = new OAuth2Client({ transporterOptions: { timeout: 10_000 } });

  constructor(
    private readonly config: Config,
    private readonly redis: RedisService,
  ) {}

  isConfigured(): boolean {
    return this.config.googleClientIds.length > 0;
  }

  /** `POST /auth/google/nonce` — the frontend passes it to `google.accounts.id.initialize({ nonce })`. */
  async issueNonce(_ip: string): Promise<{ nonce: string; expiresAt: string }> {
    this.requireConfigured();
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + GOOGLE_NONCE_TTL_MS);
    await this.redis.set(`gnonce:${nonceKey(nonce)}`, expiresAt.toISOString(), GOOGLE_NONCE_TTL_MS);
    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Verifies the credential and returns the identity claim. The nonce is consumed BEFORE the
   * token is verified, so a bad token burns it (same rule as wallet challenges).
   */
  async verifyCredential(credential: string, nonce: string | null | undefined): Promise<IdentityClaim> {
    this.requireConfigured();
    const idToken = typeof credential === "string" ? credential.trim() : "";
    if (!idToken) throw new ApiError(400, "validation_failed", "credential is required");

    const presented = typeof nonce === "string" ? nonce.trim() : "";
    if (this.config.googleNonceRequired && !presented) {
      throw new ApiError(400, "validation_failed", "nonce is required: call POST /auth/google/nonce first");
    }
    if (presented) await this.consumeNonce(presented);

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.config.googleClientIds });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(`google credential rejected: ${safeMessage(err)}`);
      throw new ApiError(401, "invalid_credential", "google credential could not be verified");
    }
    if (!payload || typeof payload.sub !== "string" || !payload.sub) {
      throw new ApiError(401, "invalid_credential", "google credential carries no subject");
    }
    if (payload.email_verified !== true) {
      throw new ApiError(401, "invalid_credential", "google account email is not verified");
    }
    if (presented && (typeof payload.nonce !== "string" || !timingSafeStringEqual(payload.nonce, presented))) {
      throw new ApiError(401, "invalid_credential", "google credential nonce does not match");
    }

    return {
      provider: "google",
      subject: payload.sub,
      email: typeof payload.email === "string" && payload.email ? payload.email : null,
      profile: { name: payload.name, picture: payload.picture, hd: payload.hd },
    };
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new ApiError(503, "upstream_failed", "google sign-in is not configured (GOOGLE_CLIENT_IDS)");
    }
  }

  /**
   * Single use, fleet-wide: the issued marker proves WE minted it; the `claimOnce` (SET NX)
   * makes the consumption atomic when two requests present the same nonce concurrently.
   */
  private async consumeNonce(nonce: string): Promise<void> {
    if (!NONCE_RE.test(nonce)) throw new ApiError(401, "invalid_credential", "nonce is malformed");
    const key = nonceKey(nonce);
    const issued = await this.redis.get(`gnonce:${key}`);
    if (!issued) throw new ApiError(401, "invalid_credential", "nonce unknown, expired or already used");
    const claimed = await this.redis.claimOnce(`gnonce_used:${key}`, GOOGLE_NONCE_TTL_MS);
    await this.redis.del(`gnonce:${key}`);
    if (!claimed) throw new ApiError(401, "invalid_credential", "nonce unknown, expired or already used");
  }
}
