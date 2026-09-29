/**
 * Sign-in end to end (docs/API.md "Auth" + "Me"; ARCHITECTURE §6–§7, §13) over the real HTTP
 * pipeline. User accounts are opened only by Google (verifier faked at the OAuth2Client seam) and
 * Telegram (Login Widget payloads signed in-process with the documented HMAC; Mini App initData).
 * A Cantor8 wallet never signs a user in: it is linked to a signed-in account through
 * `/wallets/link-challenge` + `/wallets/link` (purpose isolation, session binding, the party →
 * first-account rule, unlink / relink). Operators sign into the admin API through
 * `/auth/admin/challenge` + `/auth/admin`. Also: unlink / reattach of identities, native bearer
 * sessions, logout, sessions, CSRF and the login rate limits.
 *
 * Every request goes through a jar-less `request(server)`: superagent's agent merges its cookie
 * jar into an explicit `Cookie` header (the jar wins for a same-named cookie), which would make
 * multi-session scenarios ambiguous. Cookies are therefore always passed explicitly.
 *
 * Every scenario is written to the spec and passes against the current tree, so nothing carries
 * a `.failing` marker. One status the spec leaves open is pinned where asserted: verify-time
 * `challenge_purpose_mismatch` is 401 (INTERNALS "WalletChallengeService.verify"); the
 * issue-time refusal is 409.
 */
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { LoginTicket, type OAuth2Client, type TokenPayload, type VerifyIdTokenOptions } from "google-auth-library";
import request from "supertest";
import { IsNull } from "typeorm";

import { Config } from "../src/config";
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { AuthIdentityEntity } from "../src/entities/auth-identity.entity";
import { SessionEntity } from "../src/entities/session.entity";
import { UserEntity } from "../src/entities/user.entity";
import { WalletEntity } from "../src/entities/wallet.entity";
import { GoogleAuthService } from "../src/services/google-auth.service";
import { RedisService } from "../src/services/redis.service";
import type { ApiChallenge, ApiIdentity, ApiLoginResult, ApiMe, ApiSession, ApiSessionState, ApiWallet } from "../src/types";
import { SESSION_COOKIE } from "../src/util/cookies";
import type { ErrorBody } from "../src/util/errors";
import { signMiniAppInitData } from "../src/util/telegram";
import { TEST_ORIGIN, useTestApp } from "./helpers/app";
import { bodyOf, cookieFromResponse, linkWallet } from "./helpers/session";
import { freshWidgetPayload, signInWithTelegram, signTelegramWidget, type TelegramTestUser } from "./helpers/telegram";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const operator = makeTestWallet("operator");
const GOOGLE_CLIENT_ID = "e2e-client.apps.googleusercontent.com";
/** Lets a test present a client IP through the proxy contract (§4.1): `x-truthoracle-proxy` + `x-real-ip`. */
const PROXY_SECRET = "e2e-proxy-secret-that-is-at-least-32-chars-long";
const OIDC_DISCOVERY = {
  issuer: "https://oauth.telegram.org",
  authorization_endpoint: "https://oauth.telegram.org/auth",
  token_endpoint: "https://oauth.telegram.org/token",
  jwks_uri: "https://oauth.telegram.org/.well-known/jwks.json",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADMIN_CHALLENGE_URL = "/api/v1/auth/admin/challenge";
const ADMIN_URL = "/api/v1/auth/admin";
const LINK_CHALLENGE_URL = "/api/v1/wallets/link-challenge";
const LINK_URL = "/api/v1/wallets/link";
const WIDGET_URL = "/api/v1/auth/telegram/widget";
/** Browser-style headers for every non-GET (API.md "Auth"): Origin + JSON + x-requested-with. */
const CSRF: Record<string, string> = { Origin: TEST_ORIGIN, "Content-Type": "application/json", "x-requested-with": "truthoracle" };

/** A Telegram user for a test; every test names its own numeric id. */
const tg = (id: string, first_name: string): TelegramTestUser => ({ id, first_name });

// ───────────────────────────────────────── Google stand-in ─────────────────────────────────────

/** A three-segment token whose payload the fake verifier trusts verbatim (the signature is never checked here). */
function fakeIdToken(payload: Partial<TokenPayload> & Record<string, unknown>): string {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT", kid: "e2e" })}.${b64({ iss: "https://accounts.google.com", aud: GOOGLE_CLIENT_ID, ...payload })}.e2e-signature`;
}

/**
 * Replaces `OAuth2Client.verifyIdToken` inside the real GoogleAuthService: the nonce issue /
 * single-use / `email_verified` rules stay the production code, only Google's RSA check is faked.
 * Mirrors the library's audience refusal so a token for another client id is still rejected.
 */
const fakeOAuthClient: Pick<OAuth2Client, "verifyIdToken"> = {
  verifyIdToken: async (options: VerifyIdTokenOptions): Promise<LoginTicket> => {
    const segments = options.idToken.split(".");
    if (segments.length !== 3) throw new Error("Wrong number of segments in token");
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as TokenPayload;
    const audiences = Array.isArray(options.audience) ? options.audience : options.audience ? [options.audience] : [];
    if (!audiences.includes(payload.aud)) throw new Error("Wrong recipient, payload audience != requiredAudience");
    return new LoginTicket(segments[0], payload);
  },
};

describe("auth (e2e)", () => {
  const ctx = useTestApp({
    env: {
      ADMIN_OPERATORS: operator.partyId,
      GOOGLE_CLIENT_IDS: GOOGLE_CLIENT_ID,
      // Production default outside dev (§7.1): the nonce is mandatory.
      GOOGLE_NONCE_REQUIRED: "true",
      BACKEND_PROXY_SECRET: PROXY_SECRET,
      TELEGRAM_OIDC_CLIENT_ID: "e2e-oidc-client",
      TELEGRAM_OIDC_CLIENT_SECRET: "e2e-oidc-secret",
    },
    configure: (b) =>
      b.overrideProvider(GoogleAuthService).useFactory({
        factory: (config: Config, redis: RedisService): GoogleAuthService => {
          const service = new GoogleAuthService(config, redis);
          (service as unknown as { client: Pick<OAuth2Client, "verifyIdToken"> }).client = fakeOAuthClient;
          return service;
        },
        inject: [Config, RedisService],
      }),
  });

  // ─────────────────────────────────────── private helpers ─────────────────────────────────────
  const server = (): Server => ctx.app.getHttpServer() as Server;
  /** Jar-less request: cookies are only ever what the test sets. */
  const http = (): request.Agent => request(server());
  const repo = <T extends object>(entity: new () => T) => ctx.dataSource.getRepository(entity);
  const setCookies = (res: request.Response): string[] => res.get("Set-Cookie") ?? [];
  const sessionCookieOf = (res: request.Response): string | undefined => setCookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const errorOf = (res: request.Response): ErrorBody => bodyOf<ErrorBody>(res);
  const auditRows = (action: string) => repo(AuditEventEntity).find({ where: { action }, order: { id: "ASC" } });
  const liveSessions = (userId: string) => repo(SessionEntity).count({ where: { userId, revokedAt: IsNull() } });

  /** Accounts are opened by Google or Telegram only (§6.1): every user fixture starts here. With `cookie`, link mode. */
  const tgSignIn = (user: TelegramTestUser, cookie?: string) => signInWithTelegram(http(), user, cookie ? { cookie } : {});

  async function issueAdminChallenge(wallet: TestWallet): Promise<ApiChallenge> {
    const res = await http().post(ADMIN_CHALLENGE_URL).set(CSRF).send({ partyId: wallet.partyId });
    if (res.status !== 200) throw new Error(`POST /auth/admin/challenge → ${res.status} ${JSON.stringify(res.body)}`);
    return bodyOf<ApiChallenge>(res);
  }

  async function issueLinkChallenge(wallet: TestWallet, cookie: string): Promise<ApiChallenge> {
    const res = await http().post(LINK_CHALLENGE_URL).set(CSRF).set("Cookie", cookie).send({ partyId: wallet.partyId });
    if (res.status !== 200) throw new Error(`POST /wallets/link-challenge → ${res.status} ${JSON.stringify(res.body)}`);
    return bodyOf<ApiChallenge>(res);
  }

  /** The wallet proof for a challenge — the body of `POST /auth/admin` and of `POST /wallets/link`. */
  function proof(wallet: TestWallet, challenge: ApiChallenge): Record<string, string> {
    return { challengeId: challenge.challengeId, partyId: wallet.partyId, publicKey: wallet.publicKeyBase64, signature: wallet.sign(challenge.message), kind: "cantor8" };
  }

  function postAdmin(body: Record<string, unknown>, cookie?: string): request.Test {
    const req = http().post(ADMIN_URL).set(CSRF);
    if (cookie) req.set("Cookie", cookie);
    return req.send(body);
  }

  function postLink(body: Record<string, unknown>, cookie?: string): request.Test {
    const req = http().post(LINK_URL).set(CSRF);
    if (cookie) req.set("Cookie", cookie);
    return req.send(body);
  }

  /** Headers that make the backend see `ip` as the client (the relay's contract, secret + x-real-ip). */
  const fromIp = (ip: string): Record<string, string> => ({ ...CSRF, "x-truthoracle-proxy": PROXY_SECRET, "x-real-ip": ip, "x-forwarded-host": "app.test", "x-forwarded-proto": "http" });

  /** The house helper: `POST /wallets/link-challenge` → sign → `POST /wallets/link` for `cookie`'s account. */
  const link = (wallet: TestWallet, cookie: string) => linkWallet(http(), cookie, wallet);

  const getMe = (cookie: string) => http().get("/api/v1/me").set("Cookie", cookie);
  const deleteIdentity = (identityId: string, cookie: string) => http().delete(`/api/v1/me/identities/${identityId}`).set(CSRF).set("Cookie", cookie);
  /** `POST /me/identities/:id/reattach` with a freshly signed widget payload for `user`. */
  const reattachTelegram = (identityId: string, user: TelegramTestUser, cookie: string) =>
    http().post(`/api/v1/me/identities/${identityId}/reattach`).set(CSRF).set("Cookie", cookie).send(freshWidgetPayload(user));

  /** Google sign-in through the real nonce + credential routes (the verifier is the fake above). */
  async function googleSignIn(sub: string, email: string, cookie?: string): Promise<{ result: ApiLoginResult; cookie: string }> {
    const { nonce } = bodyOf<{ nonce: string }>(await http().post("/api/v1/auth/google/nonce").set(CSRF).send({}).expect(200));
    const req = http().post("/api/v1/auth/google").set(CSRF);
    if (cookie) req.set("Cookie", cookie);
    const res = await req.send({ credential: fakeIdToken({ sub, email, email_verified: true, name: sub, nonce }), nonce });
    if (res.status !== 200) throw new Error(`POST /auth/google → ${res.status} ${JSON.stringify(res.body)}`);
    return { result: bodyOf<ApiLoginResult>(res), cookie: cookie ?? cookieFromResponse(res) };
  }

  // ─────────────────────────────── wallets never sign users in ─────────────────────────────────
  describe("wallet routes never issue user sessions (§7.3)", () => {
    it("POST /auth/wallet/challenge and POST /auth/wallet no longer exist: 404 not_found envelope", async () => {
      const w = makeTestWallet("gone");
      const challenge = await http().post("/api/v1/auth/wallet/challenge").set(CSRF).send({ partyId: w.partyId, purpose: "sign-in" }).expect(404);
      expect(errorOf(challenge)).toEqual({ error: "not_found", message: "Cannot POST /api/v1/auth/wallet/challenge" });
      const login = await http()
        .post("/api/v1/auth/wallet")
        .set(CSRF)
        .send({ challengeId: randomUUID(), partyId: w.partyId, publicKey: w.publicKeyBase64, signature: w.sign("nothing"), kind: "cantor8" })
        .expect(404);
      expect(errorOf(login)).toEqual({ error: "not_found", message: "Cannot POST /api/v1/auth/wallet" });
      expect(await repo(UserEntity).count()).toBe(0);
    });

    it("a wallet signature alone opens no account: /auth/admin/challenge answers 200 for any well-formed party, /auth/admin by a non-operator → 403 forbidden with no user, no identity, no cookie", async () => {
      const nobody = makeTestWallet("nobody");
      const challenge = await issueAdminChallenge(nobody);
      expect(challenge.challengeId).toMatch(UUID_RE);
      expect(challenge.message.split("\n")[0]).toBe("TruthOracle admin-sign-in");

      const res = await postAdmin(proof(nobody, challenge)).expect(403);
      expect(errorOf(res).error).toBe("forbidden");
      expect(sessionCookieOf(res)).toBeUndefined();
      expect(await repo(UserEntity).count()).toBe(0);
      expect(await repo(AuthIdentityEntity).count()).toBe(0);
      expect(await repo(WalletEntity).count()).toBe(0);
      expect(await repo(SessionEntity).count()).toBe(0);
    });

    it("a link-wallet challenge needs a session (401); the link binds the wallet to a Telegram account — one primary wallet, users.partyId set, NO canton_wallet identity", async () => {
      const w = makeTestWallet("alice");
      const anon = await http().post(LINK_CHALLENGE_URL).set(CSRF).send({ partyId: w.partyId }).expect(401);
      expect(errorOf(anon).error).toBe("unauthenticated");

      const { cookie, user, result } = await tgSignIn(tg("100001", "Alice"));
      expect(result).toMatchObject({ mode: "login", created: true, kind: "user" });
      expect(user.partyId).toBeNull();

      const issued = await http().post(LINK_CHALLENGE_URL).set(CSRF).set("Cookie", cookie).send({ partyId: w.partyId }).expect(200);
      const { challengeId, message, expiresAt } = bodyOf<ApiChallenge>(issued);
      expect(challengeId).toMatch(UUID_RE);
      expect(message.split("\n")[0]).toBe("TruthOracle link-wallet");
      expect(message).toContain(`Party: ${w.partyId}`);
      expect(message).toMatch(/^Nonce: [0-9a-f]{32}$/m);
      expect(message).toMatch(/^Domain: 127\.0\.0\.1:\d+$/m);
      expect(message).toMatch(/^URI: https:\/\/127\.0\.0\.1:\d+$/m);
      expect(message).toMatch(/^Network: devnet$/m);
      expect(message).toMatch(/^Issued: \d{4}-\d{2}-\d{2}T/m);
      expect(message).toContain(`Expires: ${expiresAt}`);
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

      const linked = await postLink({ challengeId, partyId: w.partyId, publicKey: w.publicKeyBase64, signature: w.sign(message), kind: "cantor8" }, cookie).expect(200);
      const body = bodyOf<{ wallet: ApiWallet }>(linked);
      expect(Object.keys(body)).toEqual(["wallet"]);
      expect(body.wallet).toMatchObject({ partyId: w.partyId, isPrimary: true, status: "active", kind: "cantor8", creditedCC: "0.0000000000" });
      expect(setCookies(linked)).toEqual([]); // linking issues no session

      // §8.1: the row, the primary, users.party_id — and no identity for the wallet.
      const wallets = await repo(WalletEntity).find({ where: { userId: user.id } });
      expect(wallets).toHaveLength(1);
      expect(wallets[0]).toMatchObject({ partyId: w.partyId, isPrimary: true, status: "active", publicKey: w.publicKeyBase64, creditedCC: 0n });
      expect((await repo(UserEntity).findOneByOrFail({ id: user.id })).partyId).toBe(w.partyId);
      const identities = await repo(AuthIdentityEntity).find({ where: { userId: user.id } });
      expect(identities.map((i) => [i.provider, i.subject, i.status])).toEqual([["telegram", "100001", "active"]]);
      expect(await repo(AuthIdentityEntity).count()).toBe(1);
      expect(await liveSessions(user.id)).toBe(1);

      const state = bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Cookie", cookie).expect(200));
      expect(state).toMatchObject({ authenticated: true, kind: "user", user: { id: user.id, partyId: w.partyId } });
      const me = bodyOf<ApiMe>(await getMe(cookie).expect(200));
      expect(me.identities.map((i) => [i.provider, i.subject])).toEqual([["telegram", "100001"]]);
      expect(me.wallets.map((x) => [x.partyId, x.isPrimary])).toEqual([[w.partyId, true]]);
      expect(me.capabilities).toMatchObject({ primaryPartyId: w.partyId, canDeposit: true, isAdmin: false });

      const actions = (await repo(AuditEventEntity).find({ order: { id: "ASC" } })).map((e) => e.action);
      expect(actions.filter((a) => a.startsWith("wallet."))).toEqual(["wallet.linked", "wallet.primary_changed"]);
      expect(await auditRows("identity.linked")).toHaveLength(1); // the Telegram identity, at sign-in
      expect(ctx.nats.publishedOn("truthoracle.wallet.linked")).toEqual([expect.objectContaining({ payload: { userId: user.id, walletId: body.wallet.id, relinked: false } })]);
      expect(ctx.nats.publishedOn("truthoracle.identity.linked")).toHaveLength(0);
    });

    it("a link-wallet challenge is bound to the session it was issued to: another session → 401 challenge_purpose_mismatch, and the failed presentation burns it", async () => {
      const w = makeTestWallet("bound");
      const a = await tgSignIn(tg("100011", "Anna"));
      const b = await tgSignIn(tg("100012", "Bert"));

      const forA = await issueLinkChallenge(w, a.cookie);
      const byB = await postLink(proof(w, forA), b.cookie).expect(401);
      expect(errorOf(byB).error).toBe("challenge_purpose_mismatch");
      const burned = await postLink(proof(w, forA), a.cookie).expect(401);
      expect(errorOf(burned).error).toBe("challenge_rejected");
      // The link route itself needs a session: without one the challenge is never reached.
      const orphan = await issueLinkChallenge(w, a.cookie);
      expect(errorOf(await postLink(proof(w, orphan)).expect(401)).error).toBe("unauthenticated");
      expect(await repo(WalletEntity).count()).toBe(0);

      // A fresh challenge presented by the right session links.
      const fresh = await issueLinkChallenge(w, a.cookie);
      await postLink(proof(w, fresh), a.cookie).expect(200);
      expect((await repo(WalletEntity).findOneByOrFail({ partyId: w.partyId })).userId).toBe(a.user.id);
      expect(await repo(WalletEntity).count({ where: { userId: b.user.id } })).toBe(0);
    });

    it("refuses a foreign key (wallet_key_mismatch), a tampered signature (signature_invalid), a replayed challenge (challenge_rejected) and a malformed party (validation_failed)", async () => {
      const { cookie, user } = await tgSignIn(tg("100021", "Carol"));
      const w = makeTestWallet("carol");
      const other = makeTestWallet("mallory");

      // Wrong public key for the party: the fingerprint does not match → 401, and the attempt burns the challenge.
      const c1 = await issueLinkChallenge(w, cookie);
      const mismatch = await postLink({ ...proof(w, c1), publicKey: other.publicKeyBase64, signature: other.sign(c1.message) }, cookie).expect(401);
      expect(errorOf(mismatch).error).toBe("wallet_key_mismatch");
      const burned = await postLink(proof(w, c1), cookie).expect(401);
      expect(errorOf(burned).error).toBe("challenge_rejected");

      // Tampered signature (one byte flipped, still 64 bytes).
      const c2 = await issueLinkChallenge(w, cookie);
      const sig = Buffer.from(w.sign(c2.message), "base64");
      sig[3] ^= 0xff;
      const tampered = await postLink({ ...proof(w, c2), signature: sig.toString("base64") }, cookie).expect(401);
      expect(errorOf(tampered).error).toBe("signature_invalid");

      // Replay: the same challengeId a second time.
      const c3 = await issueLinkChallenge(w, cookie);
      const body = proof(w, c3);
      await postLink(body, cookie).expect(200);
      const replay = await postLink(body, cookie).expect(401);
      expect(errorOf(replay).error).toBe("challenge_rejected");

      // Unknown / made-up challenge id.
      const unknown = await postLink({ ...proof(w, c3), challengeId: randomUUID() }, cookie).expect(401);
      expect(errorOf(unknown).error).toBe("challenge_rejected");

      // Invalid party id shape (two `::`, no fingerprint) → 400 on both routes.
      const badChallenge = await http().post(LINK_CHALLENGE_URL).set(CSRF).set("Cookie", cookie).send({ partyId: "a::b::1220" + "0".repeat(64) }).expect(400);
      expect(errorOf(badChallenge).error).toBe("validation_failed");
      expect(errorOf(badChallenge).details?.issues).toEqual(expect.arrayContaining([expect.stringMatching(/partyId/)]));
      const badLink = await postLink({ ...proof(w, c3), challengeId: randomUUID(), partyId: "nope" }, cookie).expect(400);
      expect(errorOf(badLink).error).toBe("validation_failed");

      // Exactly one wallet was linked; every refusal linked none and touched no identity or session.
      expect(await repo(WalletEntity).count()).toBe(1);
      expect(await repo(WalletEntity).count({ where: { partyId: other.partyId } })).toBe(0);
      expect(await repo(AuthIdentityEntity).count()).toBe(1);
      expect(await liveSessions(user.id)).toBe(1);
    });

    it("linking a wallet that belongs to another account → 409 wallet_already_linked, active or revoked; nothing moves", async () => {
      const hot = makeTestWallet("owner-hot");
      const cold = makeTestWallet("owner-cold");
      const owner = await tgSignIn(tg("100031", "Owen"));
      await link(hot, owner.cookie);
      const coldRow = (await link(cold, owner.cookie)).wallet;
      const intruder = await tgSignIn(tg("100032", "Ivy"));

      const active = await postLink(proof(hot, await issueLinkChallenge(hot, intruder.cookie)), intruder.cookie).expect(409);
      expect(errorOf(active).error).toBe("wallet_already_linked");

      await http().delete(`/api/v1/wallets/${coldRow.id}`).set(CSRF).set("Cookie", owner.cookie).expect(200);
      const revoked = await postLink(proof(cold, await issueLinkChallenge(cold, intruder.cookie)), intruder.cookie).expect(409);
      expect(errorOf(revoked).error).toBe("wallet_already_linked");

      // Both rows still belong to the owner; the intruder has no wallet; no identity was created for either party.
      expect(await repo(WalletEntity).findOneByOrFail({ partyId: hot.partyId })).toMatchObject({ userId: owner.user.id, status: "active", isPrimary: true });
      expect(await repo(WalletEntity).findOneByOrFail({ partyId: cold.partyId })).toMatchObject({ userId: owner.user.id, status: "revoked" });
      expect(await repo(WalletEntity).count({ where: { userId: intruder.user.id } })).toBe(0);
      expect((await repo(AuthIdentityEntity).find()).map((i) => i.provider)).toEqual(["telegram", "telegram"]);
    });

    it("DELETE /wallets/:id: the primary → 409 primary_wallet_in_use; a secondary is revoked and relinking reactivates the same row; identities are never touched", async () => {
      const a = makeTestWallet("hot");
      const b = makeTestWallet("cold");
      const { cookie, user } = await tgSignIn(tg("100041", "Rita"));
      const primary = (await link(a, cookie)).wallet;
      const secondary = (await link(b, cookie)).wallet;
      expect([primary.isPrimary, secondary.isPrimary]).toEqual([true, false]);

      const refused = await http().delete(`/api/v1/wallets/${primary.id}`).set(CSRF).set("Cookie", cookie).expect(409);
      expect(errorOf(refused).error).toBe("primary_wallet_in_use");

      const ok = await http().delete(`/api/v1/wallets/${secondary.id}`).set(CSRF).set("Cookie", cookie).expect(200);
      expect(ok.body).toEqual({ ok: true });
      const revoked = await repo(WalletEntity).findOneByOrFail({ id: secondary.id });
      expect(revoked).toMatchObject({ status: "revoked", isPrimary: false, userId: user.id });
      expect(revoked.revokedAt).not.toBeNull();
      expect(await auditRows("wallet.unlinked")).toEqual([expect.objectContaining({ subjectType: "wallet", subjectId: secondary.id, metadata: { userId: user.id, partyId: b.partyId } })]);
      expect(ctx.nats.publishedOn("truthoracle.wallet.unlinked")).toEqual([expect.objectContaining({ payload: { userId: user.id, walletId: secondary.id } })]);
      expect(await auditRows("identity.unlinked")).toHaveLength(0);
      expect(await liveSessions(user.id)).toBe(1); // no identity died, so the session survives

      // Relink by the same user: the same row comes back, never a second one.
      const relinked = (await link(b, cookie)).wallet;
      expect(relinked).toMatchObject({ id: secondary.id, status: "active", isPrimary: false });
      expect(await repo(WalletEntity).count({ where: { partyId: b.partyId } })).toBe(1);
      expect(await auditRows("wallet.relinked")).toHaveLength(1);
      expect((await repo(AuthIdentityEntity).find({ where: { userId: user.id } })).map((i) => [i.provider, i.status])).toEqual([["telegram", "active"]]);
    });

    it("an unlinked Telegram identity cannot sign in (403 identity_unlinked) until the original owner re-attaches it with a fresh widget payload", async () => {
      const main = tg("100051", "Main");
      const spare = tg("100052", "Spare");
      const { cookie, user } = await tgSignIn(main);
      const linked = await tgSignIn(spare, cookie); // link mode
      expect(linked.result).toMatchObject({ mode: "link", created: false });
      expect(linked.result.user.id).toBe(user.id);
      expect(linked.result.identity).toMatchObject({ provider: "telegram", subject: "100052", status: "active" });
      const spareId = linked.result.identity.id;

      const unlinked = await deleteIdentity(spareId, cookie).expect(200);
      expect(unlinked.body).toEqual({ ok: true });
      const row = await repo(AuthIdentityEntity).findOneByOrFail({ id: spareId });
      expect(row.status).toBe("unlinked");
      expect(row.unlinkedAt).not.toBeNull();

      // §6.4: sign-in with the unlinked identity fails closed — no session, audited, no second account.
      const refused = await http().post(WIDGET_URL).set(CSRF).send(freshWidgetPayload(spare)).expect(403);
      expect(errorOf(refused).error).toBe("identity_unlinked");
      expect(sessionCookieOf(refused)).toBeUndefined();
      expect(await liveSessions(user.id)).toBe(1);
      expect(await auditRows("identity.unlinked_signin_refused")).toHaveLength(1);
      expect(await repo(UserEntity).count()).toBe(1);

      // Another account can neither take it over in link mode (§6.2) nor re-attach it (the row is not theirs).
      const other = await tgSignIn(tg("100053", "Other"));
      const takeover = await http().post(WIDGET_URL).set(CSRF).set("Cookie", other.cookie).send(freshWidgetPayload(spare)).expect(409);
      expect(errorOf(takeover).error).toBe("identity_already_linked");
      expect(errorOf(await reattachTelegram(spareId, spare, other.cookie).expect(404)).error).toBe("not_found");
      // A proof for a different Telegram user does not re-attach it either.
      await reattachTelegram(spareId, tg("100054", "Wrong"), cookie).expect(403);
      expect((await repo(AuthIdentityEntity).findOneByOrFail({ id: spareId })).status).toBe("unlinked");

      // Re-attachment by the original owner with a fresh widget payload …
      const reattached = await reattachTelegram(spareId, spare, cookie).expect(200);
      expect(bodyOf<{ identity: ApiIdentity }>(reattached).identity).toMatchObject({ id: spareId, provider: "telegram", subject: "100052", status: "active" });
      expect(ctx.nats.publishedOn("truthoracle.identity.reattached")).toHaveLength(1);

      // … and signing in with it lands on the same account again.
      const again = await tgSignIn(spare);
      expect(again.result).toMatchObject({ mode: "login", created: false, kind: "user" });
      expect(again.result.user.id).toBe(user.id);
      expect(again.result.identity.id).toBe(spareId);
    });

    it("refuses to unlink the last identity (409 last_identity): a linked wallet is not an identity, a second sign-in method is", async () => {
      const { cookie, result } = await googleSignIn("g-solo", "solo@example.com");
      expect(errorOf(await deleteIdentity(result.identity.id, cookie).expect(409)).error).toBe("last_identity");
      expect((await repo(AuthIdentityEntity).findOneByOrFail({ id: result.identity.id })).status).toBe("active");
      await getMe(cookie).expect(200);

      // Linking a wallet changes nothing about identities: Google is still the last one.
      const w = makeTestWallet("solo-wallet");
      await link(w, cookie);
      expect(errorOf(await deleteIdentity(result.identity.id, cookie).expect(409)).error).toBe("last_identity");

      // A second sign-in method (Telegram, link mode) frees it; the session Google authenticated dies with it (§6.4).
      const spare = tg("100061", "Solo");
      const linked = await tgSignIn(spare, cookie);
      expect((await deleteIdentity(result.identity.id, cookie).expect(200)).body).toEqual({ ok: true });
      await getMe(cookie).expect(401);
      const via = await tgSignIn(spare);
      expect(via.result.user.id).toBe(result.user.id);
      expect(via.user.partyId).toBe(w.partyId); // the wallet stayed with the account
      // The remaining identity is again the last one.
      expect(errorOf(await deleteIdentity(linked.result.identity.id, via.cookie).expect(409)).error).toBe("last_identity");
    });
  });

  // ────────────────────────────────────────── GET /me ──────────────────────────────────────────
  describe("GET /me (API.md 'Me')", () => {
    it("a fresh Telegram account: one identity, no wallets, primaryPartyId null and canDeposit false", async () => {
      const { cookie, result } = await tgSignIn(tg("100101", "Me"));
      const me = bodyOf<ApiMe>(await getMe(cookie).expect(200));
      expect(me.user).toMatchObject({ id: result.user.id, partyId: null, status: "active" });
      expect(me.identities).toEqual([expect.objectContaining({ id: result.identity.id, provider: "telegram", subject: "100101", status: "active", kycLocked: false })]);
      expect(me.wallets).toEqual([]);
      expect(me.capabilities).toMatchObject({ primaryPartyId: null, canDeposit: false, canWithdraw: false, isAdmin: false });
      expect(me.kyc).toMatchObject({ status: "none" });
    });

    it("lists linked wallets (first primary, second not) without adding identities", async () => {
      const a = makeTestWallet("hot");
      const b = makeTestWallet("cold");
      const { cookie, user } = await tgSignIn(tg("100102", "Two"));
      await link(a, cookie);
      await link(b, cookie);

      const me = bodyOf<ApiMe>(await getMe(cookie).expect(200));
      expect(me.user).toMatchObject({ id: user.id, partyId: a.partyId });
      expect(me.wallets.map((x) => [x.partyId, x.isPrimary, x.status])).toEqual([
        [a.partyId, true, "active"],
        [b.partyId, false, "active"],
      ]);
      expect(me.wallets[0]).toMatchObject({ chain: "canton", kind: "cantor8", creditedCC: "0.0000000000", ownLedgerWallet: null });
      expect(me.identities.map((i) => [i.provider, i.subject, i.status])).toEqual([["telegram", "100102", "active"]]);
      expect(me.capabilities).toMatchObject({ primaryPartyId: a.partyId, canDeposit: true });
    });
  });

  // ─────────────────────────────────────── admin sign-in ───────────────────────────────────────
  describe("admin sign-in (§6.8, §7.4)", () => {
    it("an operator through /auth/admin/challenge + /auth/admin → kind admin, short TTL, one canton_wallet identity carrying its key, NO wallet row; the admin session cannot start KYC or re-attach that identity", async () => {
      const challenge = await issueAdminChallenge(operator);
      expect(challenge.message.split("\n")[0]).toBe("TruthOracle admin-sign-in");
      const login = await postAdmin(proof(operator, challenge)).expect(200);
      const result = bodyOf<ApiLoginResult>(login);
      expect(result).toMatchObject({ mode: "login", kind: "admin", created: true });
      expect(result.identity).toMatchObject({ provider: "canton_wallet", subject: operator.partyId, status: "active", profile: { name: "operator", publicKey: operator.publicKeyBase64 } });
      expect(result.user.partyId).toBeNull();
      expect(result.token).toBeUndefined();
      const ttl = Date.parse(result.expiresAt) - Date.now();
      expect(ttl).toBeLessThanOrEqual(ctx.config.adminSessionTtlMs + 5_000);
      expect(ttl).toBeGreaterThan(ctx.config.adminSessionTtlMs - 60_000);
      const cookie = cookieFromResponse(login);
      expect(bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Cookie", cookie).expect(200))).toMatchObject({ authenticated: true, kind: "admin" });
      await http().get("/api/v1/admin/users").set("Cookie", cookie).expect(200);

      // §7.4: the operator's wallet is a credential for the admin API, not a linked wallet.
      expect(await repo(WalletEntity).count()).toBe(0);
      expect((await repo(AuthIdentityEntity).find()).map((i) => [i.provider, i.subject])).toEqual([["canton_wallet", operator.partyId]]);
      expect((await repo(SessionEntity).findOneByOrFail({ userId: result.user.id })).kind).toBe("admin");
      expect(await auditRows("auth.admin_login")).toHaveLength(1);
      expect(await auditRows("auth.login")).toHaveLength(0);
      expect(ctx.nats.publishedOn("truthoracle.auth.admin_login")).toHaveLength(1);
      expect(bodyOf<ApiMe>(await getMe(cookie).expect(200)).capabilities.isAdmin).toBe(true);

      // §9.5: identity verification is started from a user session only.
      const kyc = await http().post("/api/v1/kyc/sessions").set(CSRF).set("Cookie", cookie).send({}).expect(403);
      expect(errorOf(kyc).error).toBe("forbidden");
      // A wallet identity is never re-attached through /me — and the admin session cannot reach identity routes anyway (§6.8).
      const reattach = await http().post(`/api/v1/me/identities/${result.identity.id}/reattach`).set(CSRF).set("Cookie", cookie).send({}).expect(403);
      expect(errorOf(reattach).error).toBe("forbidden");
      // Admin sign-in is web only: `client` is not part of the body.
      const native = await postAdmin({ ...proof(operator, await issueAdminChallenge(operator)), client: "native" }).expect(400);
      expect(errorOf(native).error).toBe("validation_failed");
    });

    it("a non-operator is refused at verify time (403 forbidden), never at issue time; with a session cookie: 409 at issue, 403 at login BEFORE the challenge is consumed", async () => {
      // Issue answers 200 for any well-formed party: the operator list is not an anonymous 403-vs-200 oracle.
      const nobody = makeTestWallet("nobody");
      const res = await postAdmin(proof(nobody, await issueAdminChallenge(nobody))).expect(403);
      expect(errorOf(res).error).toBe("forbidden");
      expect(sessionCookieOf(res)).toBeUndefined();
      expect(await repo(UserEntity).count()).toBe(0);

      const { cookie } = await tgSignIn(tg("100071", "Opal"));
      const linkMode = await http().post(ADMIN_CHALLENGE_URL).set(CSRF).set("Cookie", cookie).send({ partyId: operator.partyId }).expect(409);
      expect(errorOf(linkMode).error).toBe("challenge_purpose_mismatch");
      // A challenge issued anonymously and presented with a session is refused before it is consumed …
      const anon = await issueAdminChallenge(operator);
      const withSession = await postAdmin(proof(operator, anon), cookie).expect(403);
      expect(errorOf(withSession)).toMatchObject({ error: "forbidden", message: expect.stringMatching(/link mode/) as string });
      expect(await repo(SessionEntity).count({ where: { kind: "admin" } })).toBe(0);
      // … so the operator can still use it without the cookie.
      expect(bodyOf<ApiLoginResult>(await postAdmin(proof(operator, anon)).expect(200)).kind).toBe("admin");
    });
  });

  // ─────────────────────────────────────── native clients ──────────────────────────────────────
  describe("native clients (bearer sessions)", () => {
    it("client:'native' returns the token in the body and sets no cookie; the bearer authenticates GET /me and skips CSRF on logout", async () => {
      const phone = tg("100081", "Phone");
      const login = await http().post(WIDGET_URL).set(CSRF).send({ ...freshWidgetPayload(phone), client: "native" }).expect(200);
      const result = bodyOf<ApiLoginResult>(login);
      expect(result).toMatchObject({ mode: "login", kind: "user", created: true });
      expect(typeof result.token).toBe("string");
      expect(result.token?.length).toBeGreaterThanOrEqual(43);
      expect(setCookies(login)).toEqual([]);
      const bearer = `Bearer ${result.token}`;

      const state = bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Authorization", bearer).expect(200));
      expect(state).toMatchObject({ authenticated: true, user: { id: result.user.id } });
      const me = bodyOf<ApiMe>(await http().get("/api/v1/me").set("Authorization", bearer).expect(200));
      expect(me.user.id).toBe(result.user.id);
      expect(me.identities.map((i) => i.id)).toEqual([result.identity.id]);
      expect(me.wallets).toEqual([]);
      const garbage = await http().get("/api/v1/me").set("Authorization", "Bearer definitely-not-a-session-token-xxxxxxxxxxxx").expect(401);
      expect(errorOf(garbage).error).toBe("unauthenticated");

      // No Origin, no x-requested-with: bearer requests are CSRF-exempt (§6.7).
      const out = await http().post("/api/v1/auth/logout").set("Authorization", bearer).send({}).expect(200);
      expect(out.body).toEqual({ ok: true });
      expect(await liveSessions(result.user.id)).toBe(0);
      expect(bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Authorization", bearer).expect(200))).toEqual({ authenticated: false });
      await http().get("/api/v1/me").set("Authorization", bearer).expect(401);
      const [audit] = await auditRows("auth.login");
      expect(audit.metadata).toMatchObject({ client: "native" });
    });
  });

  // ───────────────────────────────────────────── logout ────────────────────────────────────────
  describe("logout", () => {
    it("POST /auth/logout revokes the session and clears the cookie; the old cookie is dead", async () => {
      const { cookie, user } = await tgSignIn(tg("100091", "Bye"));
      await http().get("/api/v1/auth/session").set("Cookie", cookie).expect(200);

      const out = await http().post("/api/v1/auth/logout").set(CSRF).set("Cookie", cookie).send({}).expect(200);
      expect(out.body).toEqual({ ok: true });
      const cleared = sessionCookieOf(out);
      expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
      expect(cleared).toMatch(/Max-Age=0(;|$)/);

      const dead = await getMe(cookie).expect(401);
      expect(errorOf(dead).error).toBe("unauthenticated");
      expect(bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Cookie", cookie).expect(200))).toEqual({ authenticated: false });
      expect(await liveSessions(user.id)).toBe(0);
      const [row] = await repo(SessionEntity).find({ where: { userId: user.id } });
      expect(row.revokedAt).not.toBeNull();
      const [audit] = await auditRows("auth.logout");
      expect(audit).toMatchObject({ actorType: "user", actorUserId: user.id, subjectType: "session", subjectId: row.id });

      // A second logout with the dead cookie is 401 — the route needs a session.
      await http().post("/api/v1/auth/logout").set(CSRF).set("Cookie", cookie).send({}).expect(401);
      await http().post("/api/v1/auth/logout").set(CSRF).send({}).expect(401);
    });
  });

  // ─────────────────────────────────────────── sessions ────────────────────────────────────────
  describe("sessions through /me/sessions", () => {
    it("lists the current session, a second sign-in adds one, revoke-others leaves exactly one", async () => {
      const multi = tg("100111", "Multi");
      const first = await tgSignIn(multi);
      const list1 = bodyOf<{ sessions: ApiSession[] }>(await http().get("/api/v1/me/sessions").set("Cookie", first.cookie).expect(200)).sessions;
      expect(list1).toHaveLength(1);
      expect(list1[0]).toMatchObject({ current: true, kind: "user", authMethod: "telegram", identityId: first.result.identity.id });

      const second = await tgSignIn(multi);
      expect(second.result).toMatchObject({ mode: "login", created: false });
      expect(second.result.user.id).toBe(first.result.user.id);
      const list2 = bodyOf<{ sessions: ApiSession[] }>(await http().get("/api/v1/me/sessions").set("Cookie", second.cookie).expect(200)).sessions;
      expect(list2).toHaveLength(2);
      expect(list2.filter((s) => s.current)).toHaveLength(1);
      expect(list2.find((s) => s.current)?.id).not.toBe(list1[0].id);

      const revoke = await http().post("/api/v1/me/sessions/revoke-others").set(CSRF).set("Cookie", second.cookie).send({}).expect(200);
      expect(revoke.body).toEqual({ revoked: 1 });
      const list3 = bodyOf<{ sessions: ApiSession[] }>(await http().get("/api/v1/me/sessions").set("Cookie", second.cookie).expect(200)).sessions;
      expect(list3.map((s) => [s.id, s.current])).toEqual([[list2.find((s) => s.current)?.id, true]]);
      await getMe(first.cookie).expect(401);
      expect(await liveSessions(first.user.id)).toBe(1);
    });
  });

  // ─────────────────────────────────────────── Google ──────────────────────────────────────────
  describe("Google ID-token flow (§7.1)", () => {
    it("nonce → credential → login; the nonce is single use; unverified email, nonce mismatch and a missing nonce are refused", async () => {
      const issued = await http().post("/api/v1/auth/google/nonce").set(CSRF).send({}).expect(200);
      const { nonce, expiresAt } = bodyOf<{ nonce: string; expiresAt: string }>(issued);
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

      const credential = fakeIdToken({ sub: "g-10001", email: "Ada@Example.com", email_verified: true, name: "Ada Lovelace", picture: "https://p/ada", hd: "example.com", nonce });
      const login = await http().post("/api/v1/auth/google").set(CSRF).send({ credential, nonce }).expect(200);
      const result = bodyOf<ApiLoginResult>(login);
      expect(result).toMatchObject({ mode: "login", kind: "user", created: true });
      expect(result.identity).toMatchObject({ provider: "google", subject: "g-10001", email: "Ada@Example.com", status: "active", profile: { name: "Ada Lovelace", picture: "https://p/ada", hd: "example.com" } });
      expect(result.user).toMatchObject({ email: "Ada@Example.com", displayName: "Ada Lovelace", avatarUrl: "https://p/ada", partyId: null });
      const cookie = cookieFromResponse(login);
      expect(bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Cookie", cookie).expect(200))).toMatchObject({ authenticated: true, user: { id: result.user.id } });

      // Reusing the nonce → 401.
      const replay = await http().post("/api/v1/auth/google").set(CSRF).send({ credential, nonce }).expect(401);
      expect(errorOf(replay).error).toBe("invalid_credential");

      // email_verified:false with a fresh nonce → 401.
      const nonce2 = bodyOf<{ nonce: string }>(await http().post("/api/v1/auth/google/nonce").set(CSRF).send({}).expect(200)).nonce;
      const unverified = await http()
        .post("/api/v1/auth/google")
        .set(CSRF)
        .send({ credential: fakeIdToken({ sub: "g-20002", email: "eve@example.com", email_verified: false, nonce: nonce2 }), nonce: nonce2 })
        .expect(401);
      expect(errorOf(unverified).error).toBe("invalid_credential");

      // The token's nonce claim must match the presented nonce → 401 (and that nonce is now spent).
      const nonce3 = bodyOf<{ nonce: string }>(await http().post("/api/v1/auth/google/nonce").set(CSRF).send({}).expect(200)).nonce;
      const mismatch = await http()
        .post("/api/v1/auth/google")
        .set(CSRF)
        .send({ credential: fakeIdToken({ sub: "g-30003", email: "x@example.com", email_verified: true, nonce: "someone-elses-nonce-value" }), nonce: nonce3 })
        .expect(401);
      expect(errorOf(mismatch).error).toBe("invalid_credential");

      // GOOGLE_NONCE_REQUIRED=true: no nonce → 400 validation_failed.
      const missing = await http().post("/api/v1/auth/google").set(CSRF).send({ credential: fakeIdToken({ sub: "g-40004", email: "y@example.com", email_verified: true }) }).expect(400);
      expect(errorOf(missing).error).toBe("validation_failed");

      expect(await repo(UserEntity).count()).toBe(1);
      expect(await repo(AuthIdentityEntity).count()).toBe(1);
      expect(await liveSessions(result.user.id)).toBe(1);
    });
  });

  // ─────────────────────────────────────────── Telegram ────────────────────────────────────────
  describe("Telegram Login Widget (§7.2)", () => {
    it("a payload signed with HMAC(sha256(bot token)) signs in with subject = numeric id; stale, replayed, future and tampered payloads are 401", async () => {
      const botToken = ctx.config.telegramBotToken;
      expect(botToken).toBeTruthy();
      const now = Math.floor(Date.now() / 1000);
      const fields = { id: "777000111", first_name: "Tele", last_name: "Gram", username: "telegram_user", photo_url: "https://t.me/i/userpic/320/tele.jpg", auth_date: String(now) };
      const payload = signTelegramWidget(fields, botToken);
      const post = (body: Record<string, unknown>) => http().post(WIDGET_URL).set(CSRF).send(body);

      // Telegram posts id / auth_date as numbers; the hash is over their string forms.
      const login = await post({ ...payload, id: Number(payload.id), auth_date: Number(payload.auth_date) }).expect(200);
      const result = bodyOf<ApiLoginResult>(login);
      expect(result).toMatchObject({ mode: "login", kind: "user", created: true });
      expect(result.identity).toMatchObject({ provider: "telegram", subject: "777000111", email: null, status: "active", profile: { name: "Tele Gram", username: "telegram_user", picture: "https://t.me/i/userpic/320/tele.jpg" } });
      expect(result.user).toMatchObject({ displayName: "Tele Gram", partyId: null });
      expect(sessionCookieOf(login)).toBeDefined();

      // Replay of the very same payload → 401 (claimed once).
      const replay = await post(payload).expect(401);
      expect(errorOf(replay).error).toBe("invalid_credential");

      // Stale auth_date (validly signed) → 401.
      const stale = signTelegramWidget({ ...fields, auth_date: String(now - ctx.config.telegramAuthMaxAgeSec - 120) }, botToken);
      expect(errorOf(await post(stale).expect(401)).error).toBe("invalid_credential");

      // auth_date more than 60 s in the future → 401.
      const future = signTelegramWidget({ ...fields, auth_date: String(now + 3_600) }, botToken);
      expect(errorOf(await post(future).expect(401)).error).toBe("invalid_credential");

      // Tampered hash (still 64 hex chars so the DTO accepts it) → 401.
      const fresh = signTelegramWidget({ ...fields, auth_date: String(now - 1) }, botToken);
      const flipped = (fresh.hash[0] === "0" ? "1" : "0") + fresh.hash.slice(1);
      expect(errorOf(await post({ ...fresh, hash: flipped }).expect(401)).error).toBe("invalid_credential");
      // Tampered field under a valid hash → 401.
      expect(errorOf(await post({ ...fresh, username: "impostor" }).expect(401)).error).toBe("invalid_credential");

      expect(await repo(UserEntity).count()).toBe(1);
      expect(await repo(AuthIdentityEntity).count()).toBe(1);
      expect(await liveSessions(result.user.id)).toBe(1);
    });
  });

  // ───────────────────────────────────────────── CSRF ──────────────────────────────────────────
  describe("CSRF (§6.7)", () => {
    it("POST /auth/admin/challenge without Origin → 403 csrf_rejected; text/plain without x-requested-with → 403", async () => {
      const w = makeTestWallet("csrf");
      const body = { partyId: w.partyId };

      const noOrigin = await http().post(ADMIN_CHALLENGE_URL).set("Content-Type", "application/json").send(body).expect(403);
      expect(errorOf(noOrigin)).toMatchObject({ error: "csrf_rejected" });

      const textPlain = await http().post(ADMIN_CHALLENGE_URL).set("Origin", TEST_ORIGIN).set("Content-Type", "text/plain").send(JSON.stringify(body)).expect(403);
      expect(errorOf(textPlain)).toMatchObject({ error: "csrf_rejected" });
      expect(errorOf(textPlain).message).toMatch(/application\/json/);

      // x-requested-with satisfies the second condition (the text/plain body then fails validation, not CSRF).
      const rescued = await http().post(ADMIN_CHALLENGE_URL).set("Origin", TEST_ORIGIN).set("Content-Type", "text/plain").set("x-requested-with", "truthoracle").send(JSON.stringify(body));
      expect(rescued.status).not.toBe(403);
      expect(rescued.status).toBe(400);

      // A disallowed origin is refused even with JSON.
      const evil = await http().post(ADMIN_CHALLENGE_URL).set("Origin", "https://evil.test").set("Content-Type", "application/json").send(body).expect(403);
      expect(errorOf(evil).error).toBe("csrf_rejected");

      await http().post(ADMIN_CHALLENGE_URL).set(CSRF).send(body).expect(200);
    });
  });

  // ───────────────────────────────────────── rate limits ───────────────────────────────────────
  describe("rate limits (§13)", () => {
    it("more than 10 login attempts per minute from one IP → 429 rate_limited with Retry-After", async () => {
      const attempt = (hint: string) => {
        const w = makeTestWallet(hint);
        return postAdmin({ challengeId: randomUUID(), partyId: w.partyId, publicKey: w.publicKeyBase64, signature: w.sign("nothing to see here"), kind: "cantor8" });
      };
      for (let i = 0; i < 10; i += 1) {
        const res = await attempt(`rl-${i}`);
        expect(res.status).toBe(401);
        expect(errorOf(res).error).toBe("challenge_rejected");
      }
      const limited = await attempt("rl-eleven").expect(429);
      expect(errorOf(limited)).toMatchObject({ error: "rate_limited", details: { scope: "login" } });
      const retryAfter = Number(limited.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(limited.headers["cache-control"]).toBe("no-store");
    });

    it("more than 5 VERIFIED sign-ins per minute for one Telegram user → 429, even from different IPs and under every IP limit", async () => {
      const hammered = tg("100121", "Hammer");
      const attempt = (ip: string) => http().post(WIDGET_URL).set(fromIp(ip)).send(freshWidgetPayload(hammered));
      for (let i = 0; i < 5; i += 1) expect((await attempt(`10.9.0.${i + 1}`)).status).toBe(200);
      const limited = await attempt("10.9.0.99");
      expect(limited.status).toBe(429);
      expect(errorOf(limited)).toMatchObject({ error: "rate_limited", details: { scope: "login" } });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(await repo(UserEntity).count()).toBe(1);
    });

    it("junk attempts naming an operator's party never spend that party's quota: 10 from IP A, then the real operator signs in from IP B", async () => {
      // The party id is public (it is on the ledger); a limit keyed on the unverified body would keep
      // the operator at 429 for as long as an attacker cared to continue.
      const victim = operator;
      const junk = () => http().post(ADMIN_URL).set(fromIp("203.0.113.66")).send({ challengeId: randomUUID(), partyId: victim.partyId, publicKey: victim.publicKeyBase64, signature: victim.sign("junk"), kind: "cantor8" });
      for (let i = 0; i < 10; i += 1) {
        const res = await junk();
        expect(res.status).toBe(401);
        expect(errorOf(res).error).toBe("challenge_rejected");
      }
      // The attacker's own IP is now exhausted …
      expect((await junk()).status).toBe(429);
      // … the victim's party is not: challenge and admin sign-in from another IP succeed.
      const challenge = bodyOf<ApiChallenge>(await http().post(ADMIN_CHALLENGE_URL).set(fromIp("198.51.100.7")).send({ partyId: victim.partyId }).expect(200));
      const login = await http().post(ADMIN_URL).set(fromIp("198.51.100.7")).send(proof(victim, challenge)).expect(200);
      expect(bodyOf<ApiLoginResult>(login).kind).toBe("admin");
    });

    it("the per-party challenge limit is keyed by (IP, party): 10 challenges for a party from IP A leave IP B's quota for that party untouched", async () => {
      const w = makeTestWallet("challenged");
      for (let i = 0; i < 10; i += 1) await http().post(ADMIN_CHALLENGE_URL).set(fromIp("203.0.113.1")).send({ partyId: w.partyId }).expect(200);
      const limited = await http().post(ADMIN_CHALLENGE_URL).set(fromIp("203.0.113.1")).send({ partyId: w.partyId }).expect(429);
      expect(errorOf(limited).details).toMatchObject({ scope: "challenge" });
      await http().post(ADMIN_CHALLENGE_URL).set(fromIp("203.0.113.2")).send({ partyId: w.partyId }).expect(200);
    });
  });

  // ────────────────────────────────── Telegram Mini App + OIDC start ───────────────────────────
  describe("Telegram Mini App and OIDC start (§7.2)", () => {
    it("POST /auth/telegram/miniapp signs in with subject = the numeric id inside initData; a replay is 401", async () => {
      const botToken = ctx.config.telegramBotToken;
      const now = Math.floor(Date.now() / 1000);
      const initData = signMiniAppInitData(
        { query_id: "AAHdF6IQAAAAAN0XohDhrOrc", user: JSON.stringify({ id: 424242, first_name: "Mini", last_name: "App", username: "mini_app" }), auth_date: String(now) },
        botToken,
      );
      const login = await http().post("/api/v1/auth/telegram/miniapp").set(CSRF).send({ initData }).expect(200);
      const result = bodyOf<ApiLoginResult>(login);
      expect(result).toMatchObject({ mode: "login", kind: "user", created: true });
      expect(result.identity).toMatchObject({ provider: "telegram", subject: "424242", profile: { name: "Mini App", username: "mini_app" } });
      expect(sessionCookieOf(login)).toBeDefined();
      const replay = await http().post("/api/v1/auth/telegram/miniapp").set(CSRF).send({ initData }).expect(401);
      expect(errorOf(replay).error).toBe("invalid_credential");
      // The same Telegram user through the widget lands on the same account (§7.2 "one identity").
      const widget = signTelegramWidget({ id: "424242", first_name: "Mini", auth_date: String(now) }, botToken);
      expect(bodyOf<ApiLoginResult>(await http().post(WIDGET_URL).set(CSRF).send(widget).expect(200)).user.id).toBe(result.user.id);
    });

    it("GET /auth/telegram/oidc/start → 302 to the authorization endpoint with PKCE + nonce + state, and the to_oidc cookie", async () => {
      // The discovery document is served from the Redis cache the service consults first — no network in tests.
      await ctx.redis.setJson("oidc:telegram:discovery", OIDC_DISCOVERY, 60_000);
      const res = await http().get("/api/v1/auth/telegram/oidc/start?returnTo=/account").set("Origin", TEST_ORIGIN).set("Host", "app.test").expect(302);
      const location = new URL(res.headers.location);
      expect(`${location.origin}${location.pathname}`).toBe(OIDC_DISCOVERY.authorization_endpoint);
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("client_id")).toBe("e2e-oidc-client");
      expect(location.searchParams.get("redirect_uri")).toBe("http://app.test/__backend/api/v1/auth/telegram/oidc/callback");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location.searchParams.get("nonce")).toMatch(/^[0-9a-f]{32}$/);
      const state = location.searchParams.get("state") ?? "";
      expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
      const cookie = setCookies(res).find((c) => c.startsWith("to_oidc="));
      expect(cookie).toMatch(/;\s*HttpOnly(;|$)/i);
      expect(cookie).toMatch(/;\s*SameSite=Lax(;|$)/i);
      expect(await ctx.redis.getJson(`oidc:state:${state}`)).toMatchObject({ mode: "login", returnTo: "/account", host: "app.test", proto: "http" });
      // A host outside FRONTEND_ORIGINS is refused before any state is stored.
      const bad = await http().get("/api/v1/auth/telegram/oidc/start").set("Host", "evil.test").expect(400);
      expect(errorOf(bad).error).toBe("validation_failed");
      // An unknown / replayed state at the callback has nothing to redirect to: the JSON envelope, 401.
      const cb = await http().get(`/api/v1/auth/telegram/oidc/callback?code=x&state=${"a".repeat(32)}`).expect(401);
      expect(errorOf(cb).error).toBe("oidc_failed");
    });
  });
});
