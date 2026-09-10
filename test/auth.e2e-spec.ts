/**
 * Sign-in end to end (docs/API.md "Auth" + "Me"; ARCHITECTURE §6–§7, §13) over the real HTTP
 * pipeline: wallet challenge → signature → session cookie / bearer token, link mode and purpose
 * isolation, unlink / reattach, admin sign-in, Google (verifier faked at the OAuth2Client seam),
 * Telegram Login Widget (payload signed here with the documented HMAC), logout, sessions, CSRF
 * and the login rate limit.
 *
 * Every request goes through a jar-less `request(server)`: superagent's agent merges its cookie
 * jar into an explicit `Cookie` header (the jar wins for a same-named cookie), which would make
 * multi-session scenarios ambiguous. Cookies are therefore always passed explicitly.
 *
 * Every scenario is written to the spec and passes against the current tree, so nothing carries
 * a `.failing` marker. Two statuses the spec leaves open are pinned by comments where asserted:
 * verify-time `challenge_purpose_mismatch` is 401 (INTERNALS "WalletChallengeService.verify"),
 * and the sole identity of a wallet-only account is refused as either `last_identity` (§6.3) or
 * `primary_wallet_in_use` (§8.2).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
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
import type { ApiChallenge, ApiIdentity, ApiLoginResult, ApiMe, ApiSession, ApiSessionState, ChallengePurpose } from "../src/types";
import { SESSION_COOKIE } from "../src/util/cookies";
import type { ErrorBody } from "../src/util/errors";
import { TEST_ORIGIN, useTestApp } from "./helpers/app";
import { bodyOf, cookieFromResponse, signInWithWallet } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const operator = makeTestWallet("operator");
const GOOGLE_CLIENT_ID = "e2e-client.apps.googleusercontent.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHALLENGE_URL = "/api/v1/auth/wallet/challenge";
const WALLET_URL = "/api/v1/auth/wallet";
/** Browser-style headers for every non-GET (API.md "Auth"): Origin + JSON + x-requested-with. */
const CSRF: Record<string, string> = { Origin: TEST_ORIGIN, "Content-Type": "application/json", "x-requested-with": "truthoracle" };

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

// ───────────────────────────────────────── Telegram stand-in ───────────────────────────────────

/** Signs a Login Widget payload the way Telegram does (§7.2): key = SHA256(bot token), sorted `k=v` lines. */
function signTelegramWidget(fields: Record<string, string>, botToken: string): Record<string, string> {
  const key = createHash("sha256").update(botToken, "utf8").digest();
  const dataCheckString = Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  return { ...fields, hash: createHmac("sha256", key).update(dataCheckString, "utf8").digest("hex") };
}

describe("auth (e2e)", () => {
  const ctx = useTestApp({
    env: {
      ADMIN_OPERATORS: operator.partyId,
      GOOGLE_CLIENT_IDS: GOOGLE_CLIENT_ID,
      // Production default outside dev (§7.1): the nonce is mandatory.
      GOOGLE_NONCE_REQUIRED: "true",
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

  async function issueChallenge(wallet: TestWallet, purpose: ChallengePurpose = "sign-in", cookie?: string): Promise<ApiChallenge> {
    const req = http().post(CHALLENGE_URL).set(CSRF);
    if (cookie) req.set("Cookie", cookie);
    const res = await req.send({ partyId: wallet.partyId, purpose });
    if (res.status !== 200) throw new Error(`POST /auth/wallet/challenge → ${res.status} ${JSON.stringify(res.body)}`);
    return bodyOf<ApiChallenge>(res);
  }

  /** The `POST /auth/wallet` body for a challenge (also the wallet half of `POST /me/identities/:id/reattach`). */
  function proof(wallet: TestWallet, challenge: ApiChallenge): Record<string, string> {
    return { challengeId: challenge.challengeId, partyId: wallet.partyId, publicKey: wallet.publicKeyBase64, signature: wallet.sign(challenge.message), kind: "cantor8" };
  }

  function postWallet(body: Record<string, unknown>, cookie?: string): request.Test {
    const req = http().post(WALLET_URL).set(CSRF);
    if (cookie) req.set("Cookie", cookie);
    return req.send(body);
  }

  /** The house helper over a fresh (empty-jar) agent so its cookie handling stays explicit. */
  const signIn = (wallet: TestWallet, purpose: ChallengePurpose = "sign-in", opts: { client?: "web" | "native"; cookie?: string } = {}) =>
    signInWithWallet(request.agent(server()), wallet, purpose, opts);

  /** Link mode through `POST /auth/wallet` with a `link-wallet` challenge issued to `cookie`'s session. */
  async function linkWallet(wallet: TestWallet, cookie: string): Promise<ApiLoginResult> {
    const { result } = await signIn(wallet, "link-wallet", { cookie });
    return result;
  }

  const getMe = (cookie: string) => http().get("/api/v1/me").set("Cookie", cookie);

  /** Google sign-in through the real nonce + credential routes (the verifier is the fake above). */
  async function googleSignIn(sub: string, email: string, cookie?: string): Promise<{ result: ApiLoginResult; cookie: string }> {
    const { nonce } = bodyOf<{ nonce: string }>(await http().post("/api/v1/auth/google/nonce").set(CSRF).send({}).expect(200));
    const req = http().post("/api/v1/auth/google").set(CSRF);
    if (cookie) req.set("Cookie", cookie);
    const res = await req.send({ credential: fakeIdToken({ sub, email, email_verified: true, name: sub, nonce }), nonce });
    if (res.status !== 200) throw new Error(`POST /auth/google → ${res.status} ${JSON.stringify(res.body)}`);
    return { result: bodyOf<ApiLoginResult>(res), cookie: cookie ?? cookieFromResponse(res) };
  }

  // ──────────────────────────────────────── wallet sign-in ─────────────────────────────────────
  describe("wallet sign-in (§7.3)", () => {
    it("challenge → sign → login: session cookie, new account, canton_wallet identity and a seeded primary wallet", async () => {
      const w = makeTestWallet("alice");

      const issued = await http().post(CHALLENGE_URL).set(CSRF).send({ partyId: w.partyId, purpose: "sign-in" }).expect(200);
      const { challengeId, message, expiresAt } = bodyOf<ApiChallenge>(issued);
      expect(challengeId).toMatch(UUID_RE);
      expect(message.split("\n")[0]).toBe("TruthOracle sign-in");
      expect(message).toContain(`Party: ${w.partyId}`);
      expect(message).toMatch(/^Nonce: [0-9a-f]{32}$/m);
      expect(message).toMatch(/^Domain: 127\.0\.0\.1:\d+$/m);
      expect(message).toMatch(/^URI: https:\/\/127\.0\.0\.1:\d+$/m);
      expect(message).toMatch(/^Network: devnet$/m);
      expect(message).toMatch(/^Issued: \d{4}-\d{2}-\d{2}T/m);
      expect(message).toContain(`Expires: ${expiresAt}`);
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

      const login = await postWallet({ challengeId, partyId: w.partyId, publicKey: w.publicKeyBase64, signature: w.sign(message), kind: "cantor8" }).expect(200);
      const result = bodyOf<ApiLoginResult>(login);
      expect(result).toMatchObject({ mode: "login", created: true, kind: "user" });
      expect(result.identity).toMatchObject({ provider: "canton_wallet", subject: w.partyId, status: "active", kycLocked: false, profile: { name: "alice" } });
      expect(result.user).toMatchObject({ id: expect.stringMatching(UUID_RE) as string, partyId: w.partyId, status: "active", kycStatus: "none" });
      expect(result.user.lastLoginAt).not.toBeNull();
      expect(result.token).toBeUndefined();
      expect(Date.parse(result.expiresAt) - Date.now()).toBeGreaterThan(ctx.config.sessionTtlMs - 60_000);

      // §6.6: HttpOnly, SameSite=Lax, Path=/, host-only (Secure is off in the test env: COOKIE_SECURE=false).
      const cookieHeader = sessionCookieOf(login);
      expect(cookieHeader).toBeDefined();
      expect(cookieHeader).toMatch(/;\s*HttpOnly(;|$)/i);
      expect(cookieHeader).toMatch(/;\s*SameSite=Lax(;|$)/i);
      expect(cookieHeader).toMatch(/;\s*Path=\/(;|$)/i);
      expect(cookieHeader).not.toMatch(/Domain=/i);
      const cookie = cookieFromResponse(login);

      const state = bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Cookie", cookie).expect(200));
      expect(state).toMatchObject({ authenticated: true, kind: "user", expiresAt: result.expiresAt, user: { id: result.user.id, partyId: w.partyId } });
      expect(bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").expect(200))).toEqual({ authenticated: false });

      // §7.3 "On success": identity + wallet row seeded, first wallet primary, users.party_id set.
      const wallets = await repo(WalletEntity).find({ where: { userId: result.user.id } });
      expect(wallets).toHaveLength(1);
      expect(wallets[0]).toMatchObject({ partyId: w.partyId, isPrimary: true, status: "active", kind: "cantor8", publicKey: w.publicKeyBase64, legacyCreditedCC: 0n, creditedCC: 0n });
      const user = await repo(UserEntity).findOneByOrFail({ id: result.user.id });
      expect(user.partyId).toBe(w.partyId);
      const identities = await repo(AuthIdentityEntity).find({ where: { userId: result.user.id } });
      expect(identities.map((i) => [i.provider, i.subject, i.status])).toEqual([["canton_wallet", w.partyId, "active"]]);
      expect(await liveSessions(result.user.id)).toBe(1);

      const [loginAudit] = await auditRows("auth.login");
      expect(loginAudit).toMatchObject({ actorType: "user", actorUserId: result.user.id, subjectType: "user", subjectId: result.user.id, metadata: { provider: "canton_wallet", created: true, client: "web" } });
      expect(loginAudit.actorSessionId).not.toBeNull();
      expect(ctx.nats.publishedOn("truthoracle.user.created")).toHaveLength(1);
      expect(ctx.nats.publishedOn("truthoracle.wallet.linked")).toHaveLength(1);
      expect(ctx.nats.publishedOn("truthoracle.auth.login")).toHaveLength(1);
    });

    it("a second sign-in with the same wallet reuses the account (created:false, same user id)", async () => {
      const w = makeTestWallet("bob");
      const first = await signIn(w);
      const second = await signIn(w);
      expect(first.result).toMatchObject({ created: true });
      expect(second.result).toMatchObject({ mode: "login", created: false, kind: "user" });
      expect(second.result.user.id).toBe(first.result.user.id);
      expect(second.result.identity.id).toBe(first.result.identity.id);
      expect(second.cookie).not.toBe(first.cookie);

      expect(await liveSessions(first.user.id)).toBe(2);
      expect(await repo(WalletEntity).count({ where: { userId: first.user.id } })).toBe(1);
      expect(await repo(UserEntity).count()).toBe(1);
      expect(ctx.nats.publishedOn("truthoracle.user.created")).toHaveLength(1);
      expect(ctx.nats.publishedOn("truthoracle.auth.login")).toHaveLength(2);
    });

    it("refuses a foreign key (wallet_key_mismatch), a tampered signature (signature_invalid), a replayed challenge (challenge_rejected) and a malformed party (validation_failed)", async () => {
      const w = makeTestWallet("carol");
      const other = makeTestWallet("mallory");

      // Wrong public key for the party: the fingerprint does not match → 401, and the attempt burns the challenge.
      const c1 = await issueChallenge(w);
      const mismatch = await postWallet({ ...proof(w, c1), publicKey: other.publicKeyBase64, signature: other.sign(c1.message) }).expect(401);
      expect(errorOf(mismatch).error).toBe("wallet_key_mismatch");
      const burned = await postWallet(proof(w, c1)).expect(401);
      expect(errorOf(burned).error).toBe("challenge_rejected");

      // Tampered signature (one byte flipped, still 64 bytes).
      const tamperer = makeTestWallet("dave");
      const c2 = await issueChallenge(tamperer);
      const sig = Buffer.from(tamperer.sign(c2.message), "base64");
      sig[3] ^= 0xff;
      const tampered = await postWallet({ ...proof(tamperer, c2), signature: sig.toString("base64") }).expect(401);
      expect(errorOf(tampered).error).toBe("signature_invalid");

      // Replay: the same challengeId a second time.
      const c3 = await issueChallenge(w);
      const body = proof(w, c3);
      await postWallet(body).expect(200);
      const replay = await postWallet(body).expect(401);
      expect(errorOf(replay).error).toBe("challenge_rejected");

      // Unknown / made-up challenge id.
      const unknown = await postWallet({ ...proof(w, c3), challengeId: randomUUID() }).expect(401);
      expect(errorOf(unknown).error).toBe("challenge_rejected");

      // Invalid party id shape (two `::`, no fingerprint) → 400 on both routes.
      const badChallenge = await http().post(CHALLENGE_URL).set(CSRF).send({ partyId: "a::b::1220" + "0".repeat(64), purpose: "sign-in" }).expect(400);
      expect(errorOf(badChallenge).error).toBe("validation_failed");
      expect(errorOf(badChallenge).details?.issues).toEqual(expect.arrayContaining([expect.stringMatching(/partyId/)]));
      const badLogin = await postWallet({ ...proof(w, c3), challengeId: randomUUID(), partyId: "nope" }).expect(400);
      expect(errorOf(badLogin).error).toBe("validation_failed");

      // Exactly one session was issued (the successful login); every refusal issued none.
      const users = await repo(UserEntity).find();
      expect(users).toHaveLength(1);
      expect(await liveSessions(users[0].id)).toBe(1);
      expect(await repo(AuthIdentityEntity).count()).toBe(1);
      expect(await repo(WalletEntity).count({ where: { partyId: other.partyId } })).toBe(0);
    });
  });

  // ──────────────────────────────────── purpose isolation + linking ────────────────────────────
  describe("purpose isolation and link mode (§7.3, §8.1)", () => {
    it("sign-in challenges are refused while signed in; a link-wallet challenge attaches a second, non-primary wallet", async () => {
      const a = makeTestWallet("alice");
      const b = makeTestWallet("alice-cold");
      const { cookie, user } = await signIn(a);

      // Issuing a sign-in challenge with a session present → 409 challenge_purpose_mismatch.
      const issued = await http().post(CHALLENGE_URL).set(CSRF).set("Cookie", cookie).send({ partyId: b.partyId, purpose: "sign-in" }).expect(409);
      expect(errorOf(issued).error).toBe("challenge_purpose_mismatch");

      // A sign-in challenge issued anonymously and presented with the session → challenge_purpose_mismatch.
      // Status: INTERNALS pins `WalletChallengeService.verify` to 401 for every verify-time refusal
      // (ARCHITECTURE §11 / API.md only fix the code); the issue-time refusal above is the 409.
      const anon = await issueChallenge(b);
      const misuse = await postWallet(proof(b, anon), cookie).expect(401);
      expect(errorOf(misuse).error).toBe("challenge_purpose_mismatch");

      // "and vice versa": link-wallet needs a session to be issued and the SAME session to be used.
      const noSession = await http().post(CHALLENGE_URL).set(CSRF).send({ partyId: b.partyId, purpose: "link-wallet" }).expect(401);
      expect(errorOf(noSession).error).toBe("unauthenticated");
      const orphan = await issueChallenge(b, "link-wallet", cookie);
      const withoutCookie = await postWallet(proof(b, orphan)).expect(401);
      expect(errorOf(withoutCookie).error).toBe("challenge_purpose_mismatch");
      const stranger = await signIn(makeTestWallet("stranger"));
      const wrongSession = await issueChallenge(b, "link-wallet", cookie);
      const otherSession = await postWallet(proof(b, wrongSession), stranger.cookie).expect(401);
      expect(errorOf(otherSession).error).toBe("challenge_purpose_mismatch");
      expect(await repo(WalletEntity).count({ where: { partyId: b.partyId } })).toBe(0);

      // The real link.
      const linkChallenge = await issueChallenge(b, "link-wallet", cookie);
      expect(linkChallenge.message.split("\n")[0]).toBe("TruthOracle link-wallet");
      const link = await postWallet(proof(b, linkChallenge), cookie).expect(200);
      const result = bodyOf<ApiLoginResult>(link);
      expect(result).toMatchObject({ mode: "link", kind: "user", created: false });
      expect(result.identity).toMatchObject({ provider: "canton_wallet", subject: b.partyId, status: "active" });
      expect(result.user).toMatchObject({ id: user.id, partyId: a.partyId });
      expect(result.token).toBeUndefined();
      expect(setCookies(link)).toEqual([]); // no new session in link mode

      const rows = await repo(WalletEntity).find({ where: { userId: user.id }, order: { createdAt: "ASC" } });
      expect(rows.map((r) => [r.partyId, r.isPrimary, r.status])).toEqual([
        [a.partyId, true, "active"],
        [b.partyId, false, "active"],
      ]);
      expect((await repo(UserEntity).findOneByOrFail({ id: user.id })).partyId).toBe(a.partyId);
      expect(await liveSessions(user.id)).toBe(1);
      const linked = await auditRows("identity.linked");
      expect(linked.map((e) => e.metadata.mode)).toEqual(["login", "login", "link"]);
      expect(ctx.nats.publishedOn("truthoracle.wallet.linked")).toHaveLength(3);
    });

    it("linking a wallet that belongs to another account → 409 wallet_already_linked", async () => {
      const a = makeTestWallet("owner-a");
      const b = makeTestWallet("owner-b");
      const sessA = await signIn(a);
      const sessB = await signIn(b);

      const challenge = await issueChallenge(b, "link-wallet", sessA.cookie);
      const res = await postWallet(proof(b, challenge), sessA.cookie).expect(409);
      expect(errorOf(res).error).toBe("wallet_already_linked");

      // Nothing moved: b's row and identity still belong to b's account, a still has one wallet.
      const row = await repo(WalletEntity).findOneByOrFail({ partyId: b.partyId });
      expect(row).toMatchObject({ userId: sessB.user.id, status: "active", isPrimary: true });
      const identity = await repo(AuthIdentityEntity).findOneByOrFail({ provider: "canton_wallet", subject: b.partyId });
      expect(identity).toMatchObject({ userId: sessB.user.id, status: "active" });
      expect(await repo(WalletEntity).count({ where: { userId: sessA.user.id } })).toBe(1);
    });
  });

  // ────────────────────────────────────────── GET /me ──────────────────────────────────────────
  describe("GET /me (API.md 'Me')", () => {
    it("shows the canton_wallet identity, the wallet as primary and capabilities.primaryPartyId", async () => {
      const w = makeTestWallet("me");
      const { cookie, result } = await signIn(w);
      const me = bodyOf<ApiMe>(await getMe(cookie).expect(200));
      expect(me.user).toMatchObject({ id: result.user.id, partyId: w.partyId, status: "active" });
      expect(me.identities).toEqual([expect.objectContaining({ id: result.identity.id, provider: "canton_wallet", subject: w.partyId, status: "active", kycLocked: false })]);
      expect(me.wallets).toEqual([
        expect.objectContaining({ chain: "canton", kind: "cantor8", partyId: w.partyId, isPrimary: true, status: "active", creditedCC: "0.0000000000", legacyCreditedCC: "0.0000000000", ownLedgerWallet: null }),
      ]);
      expect(me.capabilities).toMatchObject({ primaryPartyId: w.partyId, isAdmin: false });
      expect(me.kyc).toMatchObject({ status: "none" });
    });

    it("lists a linked second wallet as non-primary alongside its identity", async () => {
      const a = makeTestWallet("hot");
      const b = makeTestWallet("cold");
      const { cookie, user } = await signIn(a);
      const linked = await linkWallet(b, cookie);

      const me = bodyOf<ApiMe>(await getMe(cookie).expect(200));
      expect(me.user.partyId).toBe(a.partyId);
      expect(me.wallets.map((x) => [x.partyId, x.isPrimary, x.status])).toEqual([
        [a.partyId, true, "active"],
        [b.partyId, false, "active"],
      ]);
      expect(me.identities.map((i) => [i.provider, i.subject, i.status])).toEqual([
        ["canton_wallet", a.partyId, "active"],
        ["canton_wallet", b.partyId, "active"],
      ]);
      expect(me.identities.map((i) => i.id)).toContain(linked.identity.id);
      expect(me.user.id).toBe(user.id);
    });
  });

  // ─────────────────────────────────── unlink / reattach through /me ───────────────────────────
  describe("unlink and reattach through /me/identities (§6.3–6.4)", () => {
    it("refuses to unlink the last identity (409 last_identity)", async () => {
      // A wallet-less account: its single Google identity is the last one and nothing else refuses first.
      const { cookie, result } = await googleSignIn("g-solo", "solo@example.com");
      const res = await http().delete(`/api/v1/me/identities/${result.identity.id}`).set(CSRF).set("Cookie", cookie).expect(409);
      expect(errorOf(res).error).toBe("last_identity");
      expect((await repo(AuthIdentityEntity).findOneByOrFail({ id: result.identity.id })).status).toBe("active");
      // The account keeps working.
      await getMe(cookie).expect(200);

      // Once a second identity exists the first can go; the remaining one is again the last.
      const wallet = makeTestWallet("solo-wallet");
      const linked = await linkWallet(wallet, cookie);
      const unlinked = await http().delete(`/api/v1/me/identities/${result.identity.id}`).set(CSRF).set("Cookie", cookie).expect(200);
      expect(unlinked.body).toEqual({ ok: true });
      // The Google identity authenticated this session, so the session died with it (§6.4 "unlink is revocation").
      await getMe(cookie).expect(401);
      const viaWallet = await signIn(wallet);
      expect(viaWallet.result.user.id).toBe(result.user.id);
      const again = await http().delete(`/api/v1/me/identities/${linked.identity.id}`).set(CSRF).set("Cookie", viaWallet.cookie).expect(409);
      // This row is both the last identity (§6.3) and the primary wallet's (§8.2); the spec does not
      // order the two refusals, IdentityService documents primary_wallet_in_use first.
      expect(["last_identity", "primary_wallet_in_use"]).toContain(errorOf(again).error);
      expect((await repo(AuthIdentityEntity).findOneByOrFail({ id: linked.identity.id })).status).toBe("active");
    });

    it("an unlinked wallet identity cannot sign in (403 identity_unlinked) until the original owner re-attaches it with a fresh link proof", async () => {
      const a = makeTestWallet("main");
      const b = makeTestWallet("spare");
      const { cookie, user } = await signIn(a);
      const linked = await linkWallet(b, cookie);

      const unlinked = await http().delete(`/api/v1/me/identities/${linked.identity.id}`).set(CSRF).set("Cookie", cookie).expect(200);
      expect(unlinked.body).toEqual({ ok: true });
      const row = await repo(AuthIdentityEntity).findOneByOrFail({ id: linked.identity.id });
      expect(row.status).toBe("unlinked");
      expect(row.unlinkedAt).not.toBeNull();
      expect((await repo(WalletEntity).findOneByOrFail({ partyId: b.partyId })).status).toBe("revoked");

      // §6.4: sign-in with the unlinked identity fails closed — no session, audited.
      const challenge = await issueChallenge(b);
      const refused = await postWallet(proof(b, challenge)).expect(403);
      expect(errorOf(refused).error).toBe("identity_unlinked");
      expect(sessionCookieOf(refused)).toBeUndefined();
      expect(await liveSessions(user.id)).toBe(1);
      expect(await auditRows("identity.unlinked_signin_refused")).toHaveLength(1);
      // The row persists: no second account was created for the party.
      expect(await repo(UserEntity).count()).toBe(1);

      // Re-attachment by the original owner with a fresh link-wallet proof issued to this session.
      const reproof = await issueChallenge(b, "link-wallet", cookie);
      const reattached = await http().post(`/api/v1/me/identities/${linked.identity.id}/reattach`).set(CSRF).set("Cookie", cookie).send(proof(b, reproof)).expect(200);
      expect(bodyOf<{ identity: ApiIdentity }>(reattached).identity).toMatchObject({ id: linked.identity.id, provider: "canton_wallet", subject: b.partyId, status: "active" });
      expect((await repo(WalletEntity).findOneByOrFail({ partyId: b.partyId })).status).toBe("active");
      expect(ctx.nats.publishedOn("truthoracle.identity.reattached")).toHaveLength(1);

      // … and signing in with that wallet works again, landing on the same account.
      const again = await signIn(b);
      expect(again.result).toMatchObject({ mode: "login", created: false, kind: "user" });
      expect(again.result.user.id).toBe(user.id);
      expect(again.result.identity.id).toBe(linked.identity.id);
    });

    it("only the original owner can re-attach: another account gets 404, a stale proof is refused", async () => {
      const a = makeTestWallet("orig");
      const b = makeTestWallet("orig-spare");
      const { cookie } = await signIn(a);
      const linked = await linkWallet(b, cookie);
      await http().delete(`/api/v1/me/identities/${linked.identity.id}`).set(CSRF).set("Cookie", cookie).expect(200);

      const other = await signIn(makeTestWallet("someone"));
      const foreignProof = await issueChallenge(b, "link-wallet", other.cookie);
      const foreign = await http().post(`/api/v1/me/identities/${linked.identity.id}/reattach`).set(CSRF).set("Cookie", other.cookie).send(proof(b, foreignProof)).expect(404);
      expect(errorOf(foreign).error).toBe("not_found");

      // A proof for the wrong wallet does not re-attach b.
      const wrongWallet = makeTestWallet("wrong");
      const wrongProof = await issueChallenge(wrongWallet, "link-wallet", cookie);
      await http().post(`/api/v1/me/identities/${linked.identity.id}/reattach`).set(CSRF).set("Cookie", cookie).send(proof(wrongWallet, wrongProof)).expect(403);
      expect((await repo(AuthIdentityEntity).findOneByOrFail({ id: linked.identity.id })).status).toBe("unlinked");
    });
  });

  // ─────────────────────────────────────── admin sign-in ───────────────────────────────────────
  describe("admin sign-in (§6.8, §7.4)", () => {
    it("purpose admin-sign-in by an operator → kind:'admin' with the short TTL; the same party with sign-in → kind:'user'", async () => {
      const admin = await signIn(operator, "admin-sign-in");
      expect(admin.result).toMatchObject({ mode: "login", kind: "admin", created: true });
      expect(admin.result.identity).toMatchObject({ provider: "canton_wallet", subject: operator.partyId });
      const ttl = Date.parse(admin.result.expiresAt) - Date.now();
      expect(ttl).toBeLessThanOrEqual(ctx.config.adminSessionTtlMs + 5_000);
      expect(ttl).toBeGreaterThan(ctx.config.adminSessionTtlMs - 60_000);
      expect(bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Cookie", admin.cookie).expect(200))).toMatchObject({ authenticated: true, kind: "admin" });
      await http().get("/api/v1/admin/users").set("Cookie", admin.cookie).expect(200);
      expect(await auditRows("auth.admin_login")).toHaveLength(1);
      expect(ctx.nats.publishedOn("truthoracle.auth.admin_login")).toHaveLength(1);
      expect((await repo(SessionEntity).findOneByOrFail({ userId: admin.user.id })).kind).toBe("admin");

      const plain = await signIn(operator, "sign-in");
      expect(plain.result).toMatchObject({ mode: "login", kind: "user", created: false });
      expect(plain.result.user.id).toBe(admin.result.user.id);
      const denied = await http().get("/api/v1/admin/users").set("Cookie", plain.cookie).expect(403);
      expect(errorOf(denied).error).toBe("forbidden");
      expect(await auditRows("auth.login")).toHaveLength(1);
    });

    it("a non-operator party cannot obtain an admin-sign-in challenge (403 forbidden); admin-sign-in never runs in link mode", async () => {
      const nobody = makeTestWallet("nobody");
      const res = await http().post(CHALLENGE_URL).set(CSRF).send({ partyId: nobody.partyId, purpose: "admin-sign-in" }).expect(403);
      expect(errorOf(res).error).toBe("forbidden");
      expect(await repo(UserEntity).count()).toBe(0);

      const { cookie } = await signIn(operator, "sign-in");
      const linkMode = await http().post(CHALLENGE_URL).set(CSRF).set("Cookie", cookie).send({ partyId: operator.partyId, purpose: "admin-sign-in" }).expect(409);
      expect(errorOf(linkMode).error).toBe("challenge_purpose_mismatch");
      expect(await repo(SessionEntity).count({ where: { kind: "admin" } })).toBe(0);
    });
  });

  // ─────────────────────────────────────── native clients ──────────────────────────────────────
  describe("native clients (bearer sessions)", () => {
    it("client:'native' returns the token in the body and sets no cookie; the bearer authenticates and skips CSRF on logout", async () => {
      const w = makeTestWallet("phone");
      const challenge = await issueChallenge(w);
      const login = await postWallet({ ...proof(w, challenge), client: "native" }).expect(200);
      const result = bodyOf<ApiLoginResult>(login);
      expect(result).toMatchObject({ mode: "login", kind: "user", created: true });
      expect(typeof result.token).toBe("string");
      expect(result.token?.length).toBeGreaterThanOrEqual(43);
      expect(setCookies(login)).toEqual([]);
      const bearer = `Bearer ${result.token}`;

      const state = bodyOf<ApiSessionState>(await http().get("/api/v1/auth/session").set("Authorization", bearer).expect(200));
      expect(state).toMatchObject({ authenticated: true, user: { id: result.user.id } });
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

    it("Authorization: Bearer reaches GET /me", async () => {
      // Not through signInWithWallet: the helper insists on a Set-Cookie, which native logins never send.
      const w = makeTestWallet("tablet");
      const challenge = await issueChallenge(w);
      const result = bodyOf<ApiLoginResult>(await postWallet({ ...proof(w, challenge), client: "native" }).expect(200));
      expect(result.token).toBeDefined();
      const me = bodyOf<ApiMe>(await http().get("/api/v1/me").set("Authorization", `Bearer ${result.token}`).expect(200));
      expect(me.user.id).toBe(result.user.id);
      expect(me.wallets.map((x) => x.partyId)).toEqual([w.partyId]);
      expect(me.identities.map((i) => i.id)).toEqual([result.identity.id]);
    });
  });

  // ───────────────────────────────────────────── logout ────────────────────────────────────────
  describe("logout", () => {
    it("POST /auth/logout revokes the session and clears the cookie; the old cookie is dead", async () => {
      const w = makeTestWallet("bye");
      const { cookie, user } = await signIn(w);
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
      const w = makeTestWallet("multi");
      const first = await signIn(w);
      const list1 = bodyOf<{ sessions: ApiSession[] }>(await http().get("/api/v1/me/sessions").set("Cookie", first.cookie).expect(200)).sessions;
      expect(list1).toHaveLength(1);
      expect(list1[0]).toMatchObject({ current: true, kind: "user", authMethod: "canton_wallet", identityId: first.result.identity.id });

      const second = await signIn(w);
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
      const post = (body: Record<string, unknown>) => http().post("/api/v1/auth/telegram/widget").set(CSRF).send(body);

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
    it("POST /auth/wallet/challenge without Origin → 403 csrf_rejected; text/plain without x-requested-with → 403", async () => {
      const w = makeTestWallet("csrf");
      const body = { partyId: w.partyId, purpose: "sign-in" };

      const noOrigin = await http().post(CHALLENGE_URL).set("Content-Type", "application/json").send(body).expect(403);
      expect(errorOf(noOrigin)).toMatchObject({ error: "csrf_rejected" });

      const textPlain = await http().post(CHALLENGE_URL).set("Origin", TEST_ORIGIN).set("Content-Type", "text/plain").send(JSON.stringify(body)).expect(403);
      expect(errorOf(textPlain)).toMatchObject({ error: "csrf_rejected" });
      expect(errorOf(textPlain).message).toMatch(/application\/json/);

      // x-requested-with satisfies the second condition (the text/plain body then fails validation, not CSRF).
      const rescued = await http().post(CHALLENGE_URL).set("Origin", TEST_ORIGIN).set("Content-Type", "text/plain").set("x-requested-with", "truthoracle").send(JSON.stringify(body));
      expect(rescued.status).not.toBe(403);
      expect(rescued.status).toBe(400);

      // A disallowed origin is refused even with JSON.
      const evil = await http().post(CHALLENGE_URL).set("Origin", "https://evil.test").set("Content-Type", "application/json").send(body).expect(403);
      expect(errorOf(evil).error).toBe("csrf_rejected");

      await http().post(CHALLENGE_URL).set(CSRF).send(body).expect(200);
    });
  });

  // ───────────────────────────────────────── rate limits ───────────────────────────────────────
  describe("rate limits (§13)", () => {
    it("more than 10 login attempts per minute from one IP → 429 rate_limited with Retry-After", async () => {
      const attempt = (hint: string) => {
        const w = makeTestWallet(hint);
        return postWallet({ challengeId: randomUUID(), partyId: w.partyId, publicKey: w.publicKeyBase64, signature: w.sign("nothing to see here"), kind: "cantor8" });
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

    it("more than 5 login attempts per minute for one subject → 429 even under the IP limit", async () => {
      const w = makeTestWallet("hammered");
      const attempt = () => postWallet({ challengeId: randomUUID(), partyId: w.partyId, publicKey: w.publicKeyBase64, signature: w.sign("nope"), kind: "cantor8" });
      for (let i = 0; i < 5; i += 1) expect((await attempt()).status).toBe(401);
      const limited = await attempt().expect(429);
      expect(errorOf(limited)).toMatchObject({ error: "rate_limited", details: { scope: "login" } });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    });
  });
});
