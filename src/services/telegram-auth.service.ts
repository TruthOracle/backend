import { createHash, randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

import { originMatchesPattern } from "../auth/request";
import { Config } from "../config";
import type { ErrorCode, IdentityClaim } from "../types";
import { oidcCookie } from "../util/cookies";
import { ApiError } from "../util/errors";
import { getRemoteJwks } from "../util/jwks";
import { timingSafeStringEqual } from "../util/strings";
import { type TelegramUser, verifyLoginWidget, verifyMiniAppInitData } from "../util/telegram";
import { HOUR_MS, MINUTE_MS } from "../util/time";
import { RedisService } from "./redis.service";

export type OidcMode = "login" | "link";

/** Where the browser is sent after the callback — the app host stored at start (§7.2). */
export interface OidcRedirectTarget {
  host: string;
  proto: "http" | "https";
  returnTo: string;
}

export interface OidcCallbackResult extends OidcRedirectTarget {
  claim: IdentityClaim;
  mode: OidcMode;
  userId: string | null;
  sessionId: string | null;
}

/**
 * A callback failure that already knows where the browser came from: the controller turns it
 * into `302 <app origin><returnTo>?auth=error&code=<code>`. `target` is null while the state
 * record is unknown (nothing to redirect to safely → the JSON envelope is returned instead).
 */
export class OidcCallbackError extends ApiError {
  readonly target: OidcRedirectTarget | null;

  constructor(status: number, code: ErrorCode, message: string, target: OidcRedirectTarget | null) {
    super(status, code, message);
    this.name = "OidcCallbackError";
    this.target = target;
  }
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface OidcStateRecord {
  verifier: string;
  nonce: string;
  mode: OidcMode;
  returnTo: string;
  /** sha256(to_oidc cookie value), base64url — the callback must present the same browser. */
  cookieHash: string;
  userId: string | null;
  sessionId: string | null;
  host: string;
  proto: "http" | "https";
  redirectUri: string;
  issuedAt: string;
}

export const OIDC_STATE_TTL_MS = 10 * MINUTE_MS;
const DISCOVERY_TTL_MS = HOUR_MS;
const DISCOVERY_KEY = "oidc:telegram:discovery";
const REPLAY_GRACE_MS = MINUTE_MS;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const NUMERIC_ID_RE = /^\d{1,20}$/;
/** Same-origin path: starts with exactly one "/" (`//host` would be a protocol-relative URL). */
const RETURN_TO_RE = /^\/(?!\/)/;

function sha256b64url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/[^\s]+$/.test(value);
}

/** `returnTo` must be a same-origin path (`^/(?!/)`), else `/` (§7.2). */
export function sanitizeReturnTo(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 1024) return "/";
  if (!RETURN_TO_RE.test(value) || /[\s\\]/.test(value)) return "/";
  return value;
}

/** Append `?auth=ok` / `?auth=error&code=<code>` to a validated `returnTo`, keeping its own query and hash. */
export function withAuthResult(returnTo: string, result: "ok" | "error", code?: string): string {
  const url = new URL(sanitizeReturnTo(returnTo), "https://returnto.invalid");
  url.searchParams.set("auth", result);
  if (result === "error" && code) url.searchParams.set("code", code);
  else url.searchParams.delete("code");
  return `${url.pathname}${url.search}${url.hash}`;
}

function numericId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && NUMERIC_ID_RE.test(value)) return value;
  return null;
}

/**
 * Telegram — three verified entry points, one identity (`subject` = numeric user id), docs
 * ARCHITECTURE §7.2. Widget and mini-app verification is pure (util/telegram); this service
 * adds the replay claim and the OIDC Authorization Code + PKCE flow:
 *
 *   start    → `to_oidc` cookie (random 32 bytes) + Redis state { verifier, nonce, mode, returnTo,
 *              cookieHash, userId?, sessionId?, host } → 302 to Telegram
 *   callback → state consumed once, cookie hash must match, link-mode user must match, code
 *              exchanged with the verifier, id_token verified with jose (remote JWKS, issuer,
 *              audience, nonce, exp), numeric user id claim required (`sub`, else `id`)
 */
@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);

  constructor(
    private readonly config: Config,
    private readonly redis: RedisService,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.telegramBotToken);
  }

  oidcEnabled(): boolean {
    return Boolean(
      this.config.telegramOidcClientId &&
      this.config.telegramOidcClientSecret &&
      this.config.telegramOidcIssuer,
    );
  }

  // ── Login Widget / Mini App ─────────────────────────────────────────────────

  async verifyWidget(payload: unknown): Promise<IdentityClaim> {
    this.requireConfigured();
    const maxAgeSec = this.config.telegramAuthMaxAgeSec;
    const result = verifyLoginWidget(payload, this.config.telegramBotToken, { maxAgeSec });
    if (!result.ok)
      throw new ApiError(
        401,
        "invalid_credential",
        `telegram widget payload rejected: ${result.reason}`,
      );
    await this.claimReplay(result.replayKey, maxAgeSec);
    return claimFromUser(result.user);
  }

  async verifyMiniApp(initData: string): Promise<IdentityClaim> {
    this.requireConfigured();
    const maxAgeSec = this.config.telegramInitDataMaxAgeSec;
    const result = verifyMiniAppInitData(initData, this.config.telegramBotToken, { maxAgeSec });
    if (!result.ok)
      throw new ApiError(401, "invalid_credential", `telegram initData rejected: ${result.reason}`);
    await this.claimReplay(result.replayKey, maxAgeSec);
    return claimFromUser(result.user);
  }

  /** The payload hash is claimed once (`tg:<hash>`) so a leaked redirect URL cannot be replayed. */
  private async claimReplay(hash: string, maxAgeSec: number): Promise<void> {
    const claimed = await this.redis.claimOnce(`tg:${hash}`, maxAgeSec * 1000 + REPLAY_GRACE_MS);
    if (!claimed)
      throw new ApiError(401, "invalid_credential", "telegram payload was already used");
  }

  // ── OIDC ───────────────────────────────────────────────────────────────────

  async oidcStart(input: {
    mode: OidcMode;
    returnTo: string;
    host: string;
    proto?: string;
    userId?: string | null;
    sessionId?: string | null;
  }): Promise<{ redirectUrl: string; cookie: string }> {
    this.requireOidcConfigured();
    const host = String(input.host ?? "")
      .trim()
      .toLowerCase();
    const proto: "http" | "https" = input.proto === "http" ? "http" : "https";
    if (!host) throw new ApiError(400, "validation_failed", "request host is unknown");
    if (!this.hostAllowed(proto, host)) {
      throw new ApiError(
        400,
        "validation_failed",
        "this host is not an allowed frontend origin (FRONTEND_ORIGINS)",
      );
    }
    if (input.mode === "link" && (!input.userId || !input.sessionId)) {
      throw new ApiError(401, "unauthenticated", "link mode requires a session");
    }

    const discovery = await this.discovery();
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const cookieValue = randomBytes(32).toString("base64url");
    // The redirect URI registered with Telegram is the app-origin proxied path (§7.2).
    const redirectUri = `${proto}://${host}/__backend/api/v1/auth/telegram/oidc/callback`;
    const record: OidcStateRecord = {
      verifier,
      nonce: randomBytes(16).toString("hex"),
      mode: input.mode === "link" ? "link" : "login",
      returnTo: sanitizeReturnTo(input.returnTo),
      cookieHash: sha256b64url(cookieValue),
      userId: input.mode === "link" ? (input.userId ?? null) : null,
      sessionId: input.mode === "link" ? (input.sessionId ?? null) : null,
      host,
      proto,
      redirectUri,
      issuedAt: new Date().toISOString(),
    };
    await this.redis.setJson(`oidc:state:${state}`, record, OIDC_STATE_TTL_MS);

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.telegramOidcClientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "openid profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", record.nonce);
    url.searchParams.set("code_challenge", sha256b64url(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return {
      redirectUrl: url.toString(),
      cookie: oidcCookie(cookieValue, OIDC_STATE_TTL_MS, this.config),
    };
  }

  async oidcCallback(input: {
    code?: string | null;
    state?: string | null;
    cookieValue: string;
    currentUserId?: string | null;
    /** Telegram's `error` query parameter, when it refused the authorisation. */
    providerError?: string | null;
  }): Promise<OidcCallbackResult> {
    this.requireOidcConfigured();
    const state = String(input.state ?? "").trim();
    if (!TOKEN_RE.test(state))
      throw new OidcCallbackError(401, "oidc_failed", "state is missing or malformed", null);

    // Consume first — atomically: two callbacks presenting the same state race on one GETDEL, so
    // exactly one of them ever sees the record.
    const record = await this.redis.takeJson<OidcStateRecord>(`oidc:state:${state}`);
    if (!record)
      throw new OidcCallbackError(
        401,
        "oidc_failed",
        "state unknown, expired or already used",
        null,
      );
    if (!this.hostAllowed(record.proto, record.host)) {
      throw new OidcCallbackError(
        401,
        "oidc_failed",
        "the stored app host is no longer an allowed origin",
        null,
      );
    }
    const target: OidcRedirectTarget = {
      host: record.host,
      proto: record.proto,
      returnTo: record.returnTo,
    };

    const cookieValue = String(input.cookieValue ?? "").trim();
    if (
      !TOKEN_RE.test(cookieValue) ||
      !timingSafeStringEqual(sha256b64url(cookieValue), record.cookieHash)
    ) {
      throw new OidcCallbackError(
        401,
        "oidc_failed",
        "this browser did not start the sign-in",
        target,
      );
    }
    if (input.providerError) {
      throw new OidcCallbackError(
        401,
        "oidc_failed",
        `telegram refused the sign-in (${String(input.providerError).slice(0, 64)})`,
        target,
      );
    }
    if (record.mode === "link" && (!input.currentUserId || input.currentUserId !== record.userId)) {
      throw new OidcCallbackError(
        409,
        "oidc_failed",
        "this link flow was started by a different account",
        target,
      );
    }
    const code = String(input.code ?? "").trim();
    if (!code || code.length > 2048)
      throw new OidcCallbackError(401, "oidc_failed", "authorization code is missing", target);

    const discovery = await this.discovery().catch((err: unknown) => {
      throw new OidcCallbackError(
        502,
        "oidc_failed",
        err instanceof ApiError ? err.message : "telegram discovery failed",
        target,
      );
    });

    let tokens: { id_token?: unknown };
    try {
      tokens = (await this.fetchJson(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: record.redirectUri,
          client_id: this.config.telegramOidcClientId,
          client_secret: this.config.telegramOidcClientSecret,
          code_verifier: record.verifier,
        }).toString(),
      })) as { id_token?: unknown };
    } catch (err) {
      this.logger.warn(
        `telegram token exchange failed: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`,
      );
      throw new OidcCallbackError(502, "oidc_failed", "telegram token exchange failed", target);
    }
    const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : "";
    if (!idToken)
      throw new OidcCallbackError(502, "oidc_failed", "telegram returned no id_token", target);

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.keyResolver(discovery.jwks_uri), {
        issuer: discovery.issuer,
        audience: this.config.telegramOidcClientId,
        clockTolerance: 60,
      }));
    } catch (err) {
      this.logger.warn(`telegram id_token rejected: ${err instanceof Error ? err.name : "error"}`);
      throw new OidcCallbackError(
        401,
        "oidc_failed",
        "telegram id_token could not be verified",
        target,
      );
    }
    if (typeof payload.nonce !== "string" || !timingSafeStringEqual(payload.nonce, record.nonce)) {
      throw new OidcCallbackError(
        401,
        "oidc_failed",
        "telegram id_token nonce does not match",
        target,
      );
    }
    // Fail closed: without a numeric Telegram user id there is no identity to resolve.
    const subject = numericId(payload.sub) ?? numericId(payload.id);
    if (!subject)
      throw new OidcCallbackError(
        401,
        "oidc_failed",
        "telegram id_token carries no numeric user id",
        target,
      );

    return {
      claim: claimFromOidc(subject, payload),
      mode: record.mode,
      userId: record.userId,
      sessionId: record.sessionId,
      ...target,
    };
  }

  /** Discovery document, cached 1 h in Redis; its `issuer` must be the configured issuer. */
  private async discovery(): Promise<OidcDiscovery> {
    const cached = await this.redis.getJson<OidcDiscovery>(DISCOVERY_KEY).catch(() => null);
    if (cached) return cached;
    const issuer = this.config.telegramOidcIssuer.replace(/\/$/, "");
    let raw: unknown;
    try {
      raw = await this.fetchJson(`${issuer}/.well-known/openid-configuration`, {
        headers: { accept: "application/json" },
      });
    } catch (err) {
      this.logger.warn(
        `telegram discovery failed: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`,
      );
      throw new ApiError(502, "oidc_failed", "telegram OIDC discovery failed");
    }
    const doc = (raw ?? {}) as Record<string, unknown>;
    if (
      !isHttpsUrl(doc.authorization_endpoint) ||
      !isHttpsUrl(doc.token_endpoint) ||
      !isHttpsUrl(doc.jwks_uri)
    ) {
      throw new ApiError(502, "oidc_failed", "telegram OIDC discovery document is incomplete");
    }
    const docIssuer = typeof doc.issuer === "string" ? doc.issuer.replace(/\/$/, "") : "";
    if (docIssuer !== issuer)
      throw new ApiError(502, "oidc_failed", "telegram OIDC discovery issuer mismatch");
    const discovery: OidcDiscovery = {
      issuer: docIssuer,
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      jwks_uri: doc.jwks_uri,
    };
    await this.redis.setJson(DISCOVERY_KEY, discovery, DISCOVERY_TTL_MS).catch(() => undefined);
    return discovery;
  }

  /** Overridable seams for tests (network + key material). */
  protected async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return text ? (JSON.parse(text) as unknown) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  protected keyResolver(jwksUri: string): JWTVerifyGetKey {
    return getRemoteJwks(jwksUri);
  }

  private hostAllowed(proto: string, host: string): boolean {
    const origin = `${proto}://${host}`.toLowerCase();
    return this.config.frontendOrigins.some((pattern) => originMatchesPattern(origin, pattern));
  }

  private requireConfigured(): void {
    if (!this.isConfigured())
      throw new ApiError(
        503,
        "upstream_failed",
        "telegram sign-in is not configured (TELEGRAM_BOT_TOKEN)",
      );
  }

  private requireOidcConfigured(): void {
    if (!this.oidcEnabled())
      throw new ApiError(
        503,
        "upstream_failed",
        "telegram OIDC is not configured (TELEGRAM_OIDC_CLIENT_ID/SECRET)",
      );
  }
}

function claimFromUser(user: TelegramUser): IdentityClaim {
  return {
    provider: "telegram",
    subject: user.id,
    email: null,
    profile: {
      name: [user.firstName, user.lastName].filter(Boolean).join(" "),
      username: user.username,
      picture: user.photoUrl,
    },
  };
}

function claimFromOidc(subject: string, payload: JWTPayload): IdentityClaim {
  const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const name =
    s(payload.name) ?? [s(payload.given_name), s(payload.family_name)].filter(Boolean).join(" ");
  return {
    provider: "telegram",
    subject,
    email: null,
    profile: {
      name: name || undefined,
      username: s(payload.preferred_username) ?? s(payload.username),
      picture: s(payload.picture) ?? s(payload.photo_url),
    },
  };
}
