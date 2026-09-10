import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey, type KeyObject, SignJWT } from "jose";

import { getConfiguration } from "../config";
import { ApiError } from "../util/errors";
import { signMiniAppInitData, signWidgetPayload, verifyLoginWidget, verifyMiniAppInitData } from "../util/telegram";
import type { RedisService } from "./redis.service";
import { OidcCallbackError, TelegramAuthService, sanitizeReturnTo, withAuthResult } from "./telegram-auth.service";

const BOT_TOKEN = "123456789:AAFakeBotTokenForUnitTestsOnly_xyz";
const CLIENT_ID = "unit-oidc-client";
const DISCOVERY = {
  issuer: "https://oauth.telegram.org",
  authorization_endpoint: "https://oauth.telegram.org/auth",
  token_endpoint: "https://oauth.telegram.org/token",
  jwks_uri: "https://oauth.telegram.org/.well-known/jwks.json",
};

/** The Redis surface the service touches, over a Map — with a real single-use `takeJson`. */
class MapRedis {
  readonly store = new Map<string, string>();
  async getJson<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async setJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }
  async takeJson<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    this.store.delete(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async claimOnce(key: string): Promise<boolean> {
    if (this.store.has(`claim:${key}`)) return false;
    this.store.set(`claim:${key}`, "1");
    return true;
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** The network + key-material seams the service exposes for tests. */
class TestTelegramAuth extends TelegramAuthService {
  discoveryDoc: Record<string, unknown> = DISCOVERY;
  tokenResponse: unknown = {};
  tokenExchangeFails = false;
  lastTokenBody: URLSearchParams | null = null;
  jwks: JWTVerifyGetKey | null = null;

  protected override async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    if (url.endsWith("/.well-known/openid-configuration")) return this.discoveryDoc;
    if (url === DISCOVERY.token_endpoint) {
      if (this.tokenExchangeFails) throw new Error("HTTP 500");
      this.lastTokenBody = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      return this.tokenResponse;
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  protected override keyResolver(): JWTVerifyGetKey {
    if (!this.jwks) throw new Error("no jwks");
    return this.jwks;
  }
}

function build(): { service: TestTelegramAuth; redis: MapRedis } {
  const config = getConfiguration({
    APP_ENV: "dev",
    DATABASE_URL: "postgresql://localhost:5432/x",
    REDIS_URL: "redis://localhost:6379",
    NATS_URL: "nats://localhost:4222",
    SESSION_SECRET: "s".repeat(32),
    KYC_FINGERPRINT_PEPPER: "p".repeat(32),
    FRONTEND_ORIGINS: "https://app.test",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OIDC_CLIENT_ID: CLIENT_ID,
    TELEGRAM_OIDC_CLIENT_SECRET: "oidc-secret",
    COOKIE_SECURE: "true",
  });
  const redis = new MapRedis();
  return { service: new TestTelegramAuth(config, redis as unknown as RedisService), redis };
}

let privateKey: KeyObject;
let jwk: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "tg-1", alg: "ES256" };
});

async function idToken(claims: Record<string, unknown>, opts: { audience?: string; issuer?: string } = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "tg-1" })
    .setIssuer(opts.issuer ?? DISCOVERY.issuer)
    .setAudience(opts.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

interface Started {
  state: string;
  nonce: string;
  codeChallenge: string;
  cookieValue: string;
  redirectUrl: URL;
}

async function start(service: TestTelegramAuth, input: Partial<Parameters<TelegramAuthService["oidcStart"]>[0]> = {}): Promise<Started> {
  const started = await service.oidcStart({ mode: "login", returnTo: "/account", host: "app.test", proto: "https", ...input });
  const url = new URL(started.redirectUrl);
  return {
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    cookieValue: started.cookie.split(";")[0].split("=")[1],
    redirectUrl: url,
  };
}

async function expectCallbackError(p: Promise<unknown>, status: number, targetKnown: boolean, messagePattern?: RegExp): Promise<OidcCallbackError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(OidcCallbackError);
    const e = err as OidcCallbackError;
    expect(e.status).toBe(status);
    expect(e.code).toBe("oidc_failed");
    expect(e.target === null).toBe(!targetKnown);
    if (messagePattern) expect(e.message).toMatch(messagePattern);
    return e;
  }
  throw new Error("expected an OidcCallbackError");
}

describe("TelegramAuthService — OIDC Authorization Code + PKCE (§7.2)", () => {
  it("start: PKCE (S256 of the stored verifier), nonce, single-use state bound to the to_oidc cookie, redirect to the discovered endpoint", async () => {
    const { service, redis } = build();
    const s = await start(service);
    expect(`${s.redirectUrl.origin}${s.redirectUrl.pathname}`).toBe(DISCOVERY.authorization_endpoint);
    expect(s.redirectUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(s.redirectUrl.searchParams.get("redirect_uri")).toBe("https://app.test/__backend/api/v1/auth/telegram/oidc/callback");
    expect(s.redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const record = await redis.getJson<{ verifier: string; cookieHash: string; mode: string; returnTo: string; userId: string | null }>(`oidc:state:${s.state}`);
    expect(record).toMatchObject({ mode: "login", returnTo: "/account", userId: null });
    expect(s.codeChallenge).toBe(createHash("sha256").update(record!.verifier).digest("base64url"));
    expect(record!.cookieHash).toBe(createHash("sha256").update(s.cookieValue).digest("base64url"));
    // Host outside FRONTEND_ORIGINS, link mode without a session: refused before any state exists.
    await expect(service.oidcStart({ mode: "login", returnTo: "/", host: "evil.test", proto: "https" })).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    await expect(service.oidcStart({ mode: "link", returnTo: "/", host: "app.test", proto: "https" })).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(redis.store.size).toBe(2); // one state + the cached discovery document
  });

  it("callback happy path: the id_token's numeric sub is the same subject the widget and the mini app yield for that user", async () => {
    const { service } = build();
    service.jwks = createLocalJWKSet({ keys: [jwk] });
    const s = await start(service);
    service.tokenResponse = { id_token: await idToken({ sub: "424242", nonce: s.nonce, name: "Ada Lovelace", preferred_username: "ada", picture: "https://t.me/i/ada.jpg" }) };

    const result = await service.oidcCallback({ code: "the-code", state: s.state, cookieValue: s.cookieValue, currentUserId: null });
    expect(result).toMatchObject({ mode: "login", userId: null, host: "app.test", proto: "https", returnTo: "/account" });
    expect(result.claim).toEqual({ provider: "telegram", subject: "424242", email: null, profile: { name: "Ada Lovelace", username: "ada", picture: "https://t.me/i/ada.jpg" } });
    // The token exchange carried the code, the stored PKCE verifier and the exact redirect_uri.
    expect(service.lastTokenBody?.get("grant_type")).toBe("authorization_code");
    expect(service.lastTokenBody?.get("code")).toBe("the-code");
    expect(service.lastTokenBody?.get("redirect_uri")).toBe("https://app.test/__backend/api/v1/auth/telegram/oidc/callback");
    expect(service.lastTokenBody?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const now = Math.floor(Date.now() / 1000);
    const widget = verifyLoginWidget(signWidgetPayload({ id: "424242", first_name: "Ada", auth_date: String(now) }, BOT_TOKEN), BOT_TOKEN, { maxAgeSec: 300, now });
    const mini = verifyMiniAppInitData(signMiniAppInitData({ user: JSON.stringify({ id: 424242, first_name: "Ada" }), auth_date: String(now) }, BOT_TOKEN), BOT_TOKEN, { maxAgeSec: 3600, now });
    expect(widget.ok && mini.ok && widget.user.id === result.claim.subject && mini.user.id === result.claim.subject).toBe(true);

    // The state was consumed: a replay has nothing to redirect to (target null) and yields no claim.
    await expectCallbackError(service.oidcCallback({ code: "the-code", state: s.state, cookieValue: s.cookieValue }), 401, false, /already used/);
  });

  it("refuses a browser that did not start the flow (cookie mismatch), a provider error, and a missing code — each with the redirect target", async () => {
    const { service } = build();
    let s = await start(service);
    await expectCallbackError(service.oidcCallback({ code: "c", state: s.state, cookieValue: "not-the-cookie-value-1234567890", currentUserId: null }), 401, true, /did not start/);
    s = await start(service);
    await expectCallbackError(service.oidcCallback({ code: "c", state: s.state, cookieValue: s.cookieValue, providerError: "access_denied" }), 401, true, /refused/);
    s = await start(service);
    await expectCallbackError(service.oidcCallback({ state: s.state, cookieValue: s.cookieValue }), 401, true, /code is missing/);
    // Malformed / unknown state: nothing safe to redirect to.
    await expectCallbackError(service.oidcCallback({ code: "c", state: "!!", cookieValue: s.cookieValue }), 401, false);
    await expectCallbackError(service.oidcCallback({ code: "c", state: "a".repeat(32), cookieValue: s.cookieValue }), 401, false);
  });

  it("link mode is bound to the account that started it: another account (or none) → 409, the same account proceeds", async () => {
    const { service } = build();
    service.jwks = createLocalJWKSet({ keys: [jwk] });
    const s = await start(service, { mode: "link", userId: "user-a", sessionId: "sess-a" });
    await expectCallbackError(service.oidcCallback({ code: "c", state: s.state, cookieValue: s.cookieValue, currentUserId: "user-b" }), 409, true, /different account/);
    const s2 = await start(service, { mode: "link", userId: "user-a", sessionId: "sess-a" });
    await expectCallbackError(service.oidcCallback({ code: "c", state: s2.state, cookieValue: s2.cookieValue, currentUserId: null }), 409, true);
    const s3 = await start(service, { mode: "link", userId: "user-a", sessionId: "sess-a" });
    service.tokenResponse = { id_token: await idToken({ sub: "7", nonce: s3.nonce }) };
    const ok = await service.oidcCallback({ code: "c", state: s3.state, cookieValue: s3.cookieValue, currentUserId: "user-a" });
    expect(ok).toMatchObject({ mode: "link", userId: "user-a", sessionId: "sess-a", claim: { subject: "7" } });
  });

  it("verifies the id_token: wrong nonce, wrong audience, wrong issuer and a non-numeric user id are 401; `id` is the fallback claim; exchange failures are 502", async () => {
    const { service } = build();
    service.jwks = createLocalJWKSet({ keys: [jwk] });
    const attempt = async (token: string | null, fail = false): Promise<OidcCallbackError | { subject: string }> => {
      const s = await start(service);
      service.tokenExchangeFails = fail;
      service.tokenResponse = token ? { id_token: token } : {};
      try {
        return { subject: (await service.oidcCallback({ code: "c", state: s.state, cookieValue: s.cookieValue })).claim.subject };
      } catch (err) {
        return err as OidcCallbackError;
      }
    };
    const s0 = await start(service);
    expect(await attempt(await idToken({ sub: "1", nonce: "not-" + s0.nonce }))).toMatchObject({ status: 401, message: expect.stringMatching(/nonce/) as string });
    // The nonce must be the one stored for THAT state: reusing another start's nonce is a mismatch too.
    const bad = await attempt(await idToken({ sub: "1", nonce: s0.nonce }));
    expect(bad).toMatchObject({ status: 401 });
    // Audience / issuer are checked by jose.
    const s1 = await start(service);
    service.tokenResponse = { id_token: await idToken({ sub: "1", nonce: s1.nonce }, { audience: "someone-else" }) };
    await expectCallbackError(service.oidcCallback({ code: "c", state: s1.state, cookieValue: s1.cookieValue }), 401, true, /could not be verified/);
    const s2 = await start(service);
    service.tokenResponse = { id_token: await idToken({ sub: "1", nonce: s2.nonce }, { issuer: "https://evil.example" }) };
    await expectCallbackError(service.oidcCallback({ code: "c", state: s2.state, cookieValue: s2.cookieValue }), 401, true, /could not be verified/);
    // Fail closed without a numeric Telegram id; `id` is the documented fallback.
    const s3 = await start(service);
    service.tokenResponse = { id_token: await idToken({ sub: "not-numeric", nonce: s3.nonce }) };
    await expectCallbackError(service.oidcCallback({ code: "c", state: s3.state, cookieValue: s3.cookieValue }), 401, true, /numeric user id/);
    const s4 = await start(service);
    service.tokenResponse = { id_token: await idToken({ sub: "abc", id: 99, nonce: s4.nonce }) };
    expect((await service.oidcCallback({ code: "c", state: s4.state, cookieValue: s4.cookieValue })).claim.subject).toBe("99");
    // No id_token / failed exchange → 502 with the target (the browser is sent back with ?auth=error).
    expect(await attempt(null)).toMatchObject({ status: 502, message: expect.stringMatching(/no id_token/) as string });
    expect(await attempt(null, true)).toMatchObject({ status: 502, message: expect.stringMatching(/token exchange/) as string });
  });

  it("refuses to boot the flow on a discovery document with a foreign issuer or non-https endpoints", async () => {
    const { service, redis } = build();
    service.discoveryDoc = { ...DISCOVERY, issuer: "https://evil.example" };
    await expect(service.oidcStart({ mode: "login", returnTo: "/", host: "app.test", proto: "https" })).rejects.toMatchObject({ status: 502, code: "oidc_failed" });
    service.discoveryDoc = { ...DISCOVERY, token_endpoint: "http://oauth.telegram.org/token" };
    await expect(service.oidcStart({ mode: "login", returnTo: "/", host: "app.test", proto: "https" })).rejects.toBeInstanceOf(ApiError);
    expect(redis.store.size).toBe(0);
  });

  it("returnTo is a same-origin path or `/`, and the auth result is appended without disturbing the query or hash", () => {
    expect(sanitizeReturnTo("/account?tab=kyc#top")).toBe("/account?tab=kyc#top");
    expect(sanitizeReturnTo("//evil.test")).toBe("/");
    expect(sanitizeReturnTo("https://evil.test/x")).toBe("/");
    expect(sanitizeReturnTo("/a b")).toBe("/");
    expect(sanitizeReturnTo("/a\\b")).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
    expect(sanitizeReturnTo("/" + "x".repeat(2000))).toBe("/");
    expect(withAuthResult("/account?tab=kyc#top", "ok")).toBe("/account?tab=kyc&auth=ok#top");
    expect(withAuthResult("/account", "error", "oidc_failed")).toBe("/account?auth=error&code=oidc_failed");
    expect(withAuthResult("//evil.test", "ok")).toBe("/?auth=ok");
  });
});
