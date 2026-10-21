/**
 * Proves the foundation directly: SessionService, IdentityService rules (§6),
 * WalletChallengeService (§7.3–7.4), the global guards (§6.6–6.8) and the error envelope (§11).
 * A 200 from a session-only route after a guard is the proof the guard passed; the routes used
 * as probes (`GET /me`, `POST /me/sessions/revoke-others`, `GET /admin/users`) are idempotent.
 */
import { createHash, createHmac } from "node:crypto";
import type request from "supertest";

import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { AuthIdentityEntity } from "../src/entities/auth-identity.entity";
import { SessionEntity } from "../src/entities/session.entity";
import { UserEntity } from "../src/entities/user.entity";
import { IdentityService } from "../src/services/identity.service";
import { SessionService } from "../src/services/session.service";
import { UserService } from "../src/services/user.service";
import { WalletChallengeService } from "../src/services/wallet-challenge.service";
import {
  KYC_LOCK_LOOKUP,
  type ApiChallenge,
  type ApiMe,
  type ChallengePurpose,
} from "../src/types";
import { SESSION_COOKIE } from "../src/util/cookies";
import { ApiError, type ErrorBody } from "../src/util/errors";
import { TEST_ORIGIN, useTestApp } from "./helpers/app";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const operator = makeTestWallet("operator");
const pinnedOperator = makeTestWallet("pinned");
const pinnedKeyOwner = makeTestWallet("pinnedkey");

/** Controllable stand-in for KycService.lockedIdentityId (P4 binds the real one). */
const kycLocks = new Map<string, string>();

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(`${e.status} ${e.code}`).toBe(`${status} ${code}`);
    return e;
  }
  throw new Error(`expected ${status} ${code}, resolved instead`);
}

describe("foundation (e2e)", () => {
  const ctx = useTestApp({
    env: {
      // pinnedOperator is pinned to SOMEONE ELSE's key so the pin check can be exercised.
      ADMIN_OPERATORS: `${operator.partyId},${pinnedOperator.partyId}=${pinnedKeyOwner.publicKeyHex}`,
    },
    configure: (b) =>
      b
        .overrideProvider(KYC_LOCK_LOOKUP)
        .useValue({ lockedIdentityId: async (userId: string) => kycLocks.get(userId) ?? null }),
  });

  beforeEach(() => kycLocks.clear());

  // ───────────────────────────────────────────── sessions ─────────────────────────────────────
  describe("SessionService", () => {
    it("issues an opaque token, stores only its hash, verifies via Redis and Postgres", async () => {
      const w = makeTestWallet("sess");
      const { token, session, user } = await issueSessionDirect(ctx, w);
      const sessions = ctx.get(SessionService);
      expect(token.length).toBeGreaterThanOrEqual(43);

      const row = await ctx.dataSource
        .getRepository(SessionEntity)
        .findOneByOrFail({ id: session.id });
      expect(row.tokenHash).toBe(sessions.hashToken(token));
      expect(row.tokenHash).not.toContain(token);
      // HMAC keyed by SESSION_SECRET: a leaked to_sessions dump is useless without the key, and a plain sha256 does not match.
      expect(row.tokenHash).toBe(
        createHmac("sha256", ctx.config.sessionSecret).update(token, "utf8").digest("base64url"),
      );
      expect(row.tokenHash).not.toBe(
        createHash("sha256").update(token, "utf8").digest("base64url"),
      );
      expect(row.kind).toBe("user");
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeCloseTo(
        ctx.config.sessionTtlMs,
        -4,
      );

      const viaRedis = await sessions.verify(token);
      expect(viaRedis?.session.id).toBe(session.id);
      expect(viaRedis?.user.id).toBe(user.id);
      expect(await ctx.redis.smembers(`user_sessions:${user.id}`)).toEqual([row.tokenHash]);

      await ctx.redis.flushDb();
      const viaPostgres = await sessions.verify(token);
      expect(viaPostgres?.session.id).toBe(session.id);
      expect(await ctx.redis.getJson(`sess:${row.tokenHash}`)).toMatchObject({
        id: session.id,
        userId: user.id,
        kind: "user",
      });

      expect(await sessions.verify("nope")).toBeNull();
      expect(await sessions.verify(token.slice(0, -1) + "x")).toBeNull();
    });

    it("admin sessions get the short TTL", async () => {
      const { session } = await issueSessionDirect(ctx, operator, { kind: "admin" });
      expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
        ctx.config.adminSessionTtlMs + 1000,
      );
    });

    it("revoke, revokeAllForUser (keeping one) and listForUser", async () => {
      const w = makeTestWallet("revoke");
      const sessions = ctx.get(SessionService);
      const a = await issueSessionDirect(ctx, w);
      const b = await sessions.issue({
        userId: a.user.id,
        authIdentityId: a.identity.id,
        kind: "user",
      });
      const c = await sessions.issue({
        userId: a.user.id,
        authIdentityId: a.identity.id,
        kind: "user",
      });
      expect((await sessions.listForUser(a.user.id)).map((s) => s.id).sort()).toEqual(
        [a.session.id, b.session.id, c.session.id].sort(),
      );

      await sessions.revoke(c.session.id, { type: "user", userId: a.user.id });
      expect(await sessions.verify(c.token)).toBeNull();
      expect(await ctx.redis.getJson(`sess:${sessions.hashToken(c.token)}`)).toBeNull();

      expect(await sessions.revokeAllForUser(a.user.id, a.session.id)).toBe(1);
      expect(await sessions.verify(b.token)).toBeNull();
      expect(await sessions.verify(a.token)).not.toBeNull();
      expect(await ctx.redis.smembers(`user_sessions:${a.user.id}`)).toEqual([
        sessions.hashToken(a.token),
      ]);

      const audits = await ctx.dataSource
        .getRepository(AuditEventEntity)
        .find({ where: { action: "session.revoked" } });
      expect(audits).toHaveLength(1);
      expect(audits[0].subjectId).toBe(c.session.id);
    });

    it("revocation fails LOUD when the cache eviction fails, and the cached session dies at the next re-check anyway", async () => {
      const w = makeTestWallet("evict");
      const { token, session } = await issueSessionDirect(ctx, w);
      const sessions = ctx.get(SessionService);
      expect(await sessions.verify(token)).not.toBeNull();

      const del = jest
        .spyOn(ctx.redis, "del")
        .mockRejectedValueOnce(new Error("redis: connection lost"));
      try {
        await expectApiError(
          sessions.revoke(session.id, { type: "user", userId: session.userId }),
          502,
          "upstream_failed",
        );
      } finally {
        del.mockRestore();
      }
      // Postgres already says revoked; the stale cache entry is caught by the periodic re-check.
      expect(
        (await ctx.dataSource.getRepository(SessionEntity).findOneByOrFail({ id: session.id }))
          .revokedAt,
      ).not.toBeNull();
      await ctx.redis.del(`sess_recheck:${session.id}`);
      expect(await sessions.verify(token)).toBeNull();
      expect(await ctx.redis.getJson(`sess:${sessions.hashToken(token)}`)).toBeNull();
      // The retry the 502 asked for is idempotent and succeeds.
      await expect(
        sessions.revoke(session.id, { type: "user", userId: session.userId }),
      ).resolves.toBeUndefined();
    });

    it("expired sessions verify as null even when cached", async () => {
      const w = makeTestWallet("expired");
      const { token, session } = await issueSessionDirect(ctx, w);
      await ctx.dataSource
        .getRepository(SessionEntity)
        .update({ id: session.id }, { expiresAt: new Date(Date.now() - 1000) });
      await ctx.redis.flushDb();
      expect(await ctx.get(SessionService).verify(token)).toBeNull();
    });
  });

  // ───────────────────────────────────────────── identities ───────────────────────────────────
  describe("IdentityService rules (§6)", () => {
    const identities = (): IdentityService => ctx.get(IdentityService);

    it("creates a user on first sign-in, reuses it afterwards, links in session mode", async () => {
      const first = await identities().resolveForLogin(
        {
          provider: "google",
          subject: "g-1",
          email: "Ada@Example.com",
          profile: { name: "Ada", picture: "https://p/ada", extra: "dropped" },
        },
        { currentUser: null },
      );
      expect(first).toMatchObject({ mode: "login", created: true });
      expect(first.user.displayName).toBe("Ada");
      expect(first.user.email).toBe("Ada@Example.com");
      expect(first.identity.profile).toEqual({ name: "Ada", picture: "https://p/ada" });
      expect(ctx.nats.publishedOn("truthoracle.user.created")).toHaveLength(1);

      const again = await identities().resolveForLogin(
        { provider: "google", subject: "g-1" },
        { currentUser: null },
      );
      expect(again).toMatchObject({ mode: "login", created: false });
      expect(again.user.id).toBe(first.user.id);

      const linked = await identities().resolveForLogin(
        { provider: "telegram", subject: "42" },
        { currentUser: first.user },
      );
      expect(linked).toMatchObject({ mode: "link", created: false });
      expect(linked.identity.userId).toBe(first.user.id);
      expect((await identities().listForUser(first.user.id)).map((i) => i.provider).sort()).toEqual(
        ["google", "telegram"],
      );

      // citext: the same email with different casing is the same value
      const rows = await ctx.dataSource.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM to_users WHERE email = 'ada@example.com'`,
      );
      expect(rows[0].n).toBe(1);
    });

    it("refuses to link an identity owned by another account (409 identity_already_linked)", async () => {
      const a = await identities().resolveForLogin(
        { provider: "google", subject: "g-a" },
        { currentUser: null },
      );
      await identities().resolveForLogin(
        { provider: "google", subject: "g-b" },
        { currentUser: null },
      );
      await expectApiError(
        identities().resolveForLogin(
          { provider: "google", subject: "g-b" },
          { currentUser: a.user },
        ),
        409,
        "identity_already_linked",
      );
      // Idempotent re-link of your own identity is fine.
      const same = await identities().resolveForLogin(
        { provider: "google", subject: "g-a" },
        { currentUser: a.user },
      );
      expect(same.mode).toBe("link");
    });

    it("unlink is revocation: 403 on sign-in, reattach by the original owner or an admin, rows never deleted", async () => {
      const a = await identities().resolveForLogin(
        { provider: "google", subject: "g-u" },
        { currentUser: null },
      );
      const tg = await identities().resolveForLogin(
        { provider: "telegram", subject: "777" },
        { currentUser: a.user },
      );
      const sessions = ctx.get(SessionService);
      const tgSession = await sessions.issue({
        userId: a.user.id,
        authIdentityId: tg.identity.id,
        kind: "user",
      });

      await identities().unlink(a.user.id, tg.identity.id, { type: "user", userId: a.user.id });
      const row = await ctx.dataSource
        .getRepository(AuthIdentityEntity)
        .findOneByOrFail({ id: tg.identity.id });
      expect(row.status).toBe("unlinked");
      expect(row.unlinkedAt).not.toBeNull();
      expect(await sessions.verify(tgSession.token)).toBeNull();

      const err = await expectApiError(
        identities().resolveForLogin(
          { provider: "telegram", subject: "777" },
          { currentUser: null },
        ),
        403,
        "identity_unlinked",
      );
      expect(err.message).toMatch(/unlinked/);
      const refused = await ctx.dataSource
        .getRepository(AuditEventEntity)
        .find({ where: { action: "identity.unlinked_signin_refused" } });
      expect(refused).toHaveLength(1);

      // The refusal is audited without naming the owner: the refused requester reads this row through GET /me/audit (§9.3 / §11).
      expect(refused[0].metadata).toEqual({ provider: "telegram", linkMode: false });

      // Another account cannot take it over either — the row persists forever; in link mode the
      // answer is §6.2's 409 identity_already_linked ("applies to unlinked rows too"), never a hint
      // that the identity was unlinked elsewhere.
      const b = await identities().resolveForLogin(
        { provider: "google", subject: "g-other" },
        { currentUser: null },
      );
      await expectApiError(
        identities().resolveForLogin(
          { provider: "telegram", subject: "777" },
          { currentUser: b.user },
        ),
        409,
        "identity_already_linked",
      );
      await expectApiError(
        identities().reattach(
          b.user.id,
          tg.identity.id,
          { provider: "telegram", subject: "777" },
          { type: "user", userId: b.user.id },
        ),
        404,
        "not_found",
      );
      expect(
        await ctx.dataSource
          .getRepository(AuditEventEntity)
          .count({ where: { action: "identity.unlinked_signin_refused" } }),
      ).toBe(2);

      // The original owner re-attaches in link mode …
      const back = await identities().resolveForLogin(
        { provider: "telegram", subject: "777" },
        { currentUser: a.user },
      );
      expect(back.mode).toBe("link");
      expect(back.identity.status).toBe("active");
      expect(ctx.nats.publishedOn("truthoracle.identity.reattached")).toHaveLength(1);

      // … and an admin can re-attach explicitly without a proof.
      await identities().unlink(a.user.id, tg.identity.id, { type: "user", userId: a.user.id });
      await expectApiError(
        identities().reattach(a.user.id, tg.identity.id, null, { type: "user", userId: a.user.id }),
        403,
        "forbidden",
      );
      const adminBack = await identities().reattach(a.user.id, tg.identity.id, null, {
        type: "admin",
        userId: null,
      });
      expect(adminBack.status).toBe("active");
      expect(await ctx.dataSource.getRepository(AuthIdentityEntity).count()).toBe(3);
    });

    it("keeps the last identity (409 last_identity) and honours the KYC lock (409 identity_locked_by_kyc)", async () => {
      const a = await identities().resolveForLogin(
        { provider: "google", subject: "g-last" },
        { currentUser: null },
      );
      await expectApiError(
        identities().unlink(a.user.id, a.identity.id, { type: "user", userId: a.user.id }),
        409,
        "last_identity",
      );

      const tg = await identities().resolveForLogin(
        { provider: "telegram", subject: "999" },
        { currentUser: a.user },
      );
      kycLocks.set(a.user.id, tg.identity.id);
      await expectApiError(
        identities().unlink(a.user.id, tg.identity.id, { type: "user", userId: a.user.id }),
        409,
        "identity_locked_by_kyc",
      );
      expect(identities().toApi(tg.identity, tg.identity.id).kycLocked).toBe(true);
      // Admins can.
      await identities().unlink(a.user.id, tg.identity.id, { type: "admin", userId: null });
    });

    it("suspended users cannot sign in (403 user_suspended) and lose their sessions", async () => {
      const w = makeTestWallet("susp");
      const { user, identity, token } = await issueSessionDirect(ctx, w);
      await ctx.get(UserService).suspend(user.id, "abuse", { type: "admin" });
      await expectApiError(
        identities().resolveForLogin(
          { provider: "telegram", subject: identity.subject },
          { currentUser: null },
        ),
        403,
        "user_suspended",
      );
      expect(await ctx.get(SessionService).verify(token)).toBeNull();
      await ctx.get(UserService).reinstate(user.id, "resolved", { type: "admin" });
      expect(
        (
          await identities().resolveForLogin(
            { provider: "telegram", subject: identity.subject },
            { currentUser: null },
          )
        ).user.status,
      ).toBe("active");
    });
  });

  // ───────────────────────────────────────────── wallet challenge ─────────────────────────────
  describe("WalletChallengeService (§7.3, §7.4)", () => {
    const challenges = (): WalletChallengeService => ctx.get(WalletChallengeService);
    /** A `link-wallet` challenge for session `s1` (the purpose every user wallet signature carries). */
    const linkChallenge = (w: TestWallet, sessionId = "s1") =>
      challenges().issue({
        partyId: w.partyId,
        purpose: "link-wallet",
        sessionId,
        host: "app.test",
      });
    const verify = (
      w: TestWallet,
      c: ApiChallenge,
      opts: {
        expectedPurpose: ChallengePurpose;
        sessionId?: string | null;
        publicKey?: string;
        signature?: string;
        partyId?: string;
      },
    ) =>
      challenges().verify({
        challengeId: c.challengeId,
        partyId: opts.partyId ?? w.partyId,
        publicKey: opts.publicKey ?? w.publicKeyBase64,
        signature: opts.signature ?? w.sign(c.message),
        expectedPurpose: opts.expectedPurpose,
        sessionId: opts.sessionId,
      });

    it("verifies a good link-wallet signature and consumes the challenge (replay → challenge_rejected)", async () => {
      const w = makeTestWallet("good");
      const c = await linkChallenge(w);
      expect(c.message).toBe(
        `TruthOracle link-wallet\nDomain: app.test\nURI: https://app.test\nNetwork: devnet\nParty: ${w.partyId}\n` +
          c.message.split("\n").slice(5, 7).join("\n") +
          `\nExpires: ${c.expiresAt}`,
      );
      const verified = await verify(w, c, {
        expectedPurpose: "link-wallet",
        sessionId: "s1",
        publicKey: w.publicKeyHex,
      });
      expect(verified).toEqual({
        partyId: w.partyId,
        publicKeyBase64: w.publicKeyBase64,
        purpose: "link-wallet",
        form: "utf8",
      });
      await expectApiError(
        verify(w, c, {
          expectedPurpose: "link-wallet",
          sessionId: "s1",
          publicKey: w.publicKeyHex,
        }),
        401,
        "challenge_rejected",
      );
    });

    it("rejects a key that is not the party's namespace key (wallet_key_mismatch) and burns the challenge", async () => {
      const w = makeTestWallet("owner");
      const other = makeTestWallet("other");
      const c = await linkChallenge(w);
      await expectApiError(
        verify(w, c, {
          expectedPurpose: "link-wallet",
          sessionId: "s1",
          publicKey: other.publicKeyBase64,
          signature: other.sign(c.message),
        }),
        401,
        "wallet_key_mismatch",
      );
      await expectApiError(
        verify(w, c, { expectedPurpose: "link-wallet", sessionId: "s1" }),
        401,
        "challenge_rejected",
      );
    });

    it("rejects a bad signature, a party swap and a purpose mismatch", async () => {
      const w = makeTestWallet("sig");
      const c1 = await linkChallenge(w);
      await expectApiError(
        verify(w, c1, {
          expectedPurpose: "link-wallet",
          sessionId: "s1",
          signature: w.sign(c1.message + "x"),
        }),
        401,
        "signature_invalid",
      );
      const c2 = await linkChallenge(w);
      await expectApiError(
        verify(w, c2, {
          expectedPurpose: "link-wallet",
          sessionId: "s1",
          partyId: makeTestWallet("z").partyId,
        }),
        401,
        "challenge_rejected",
      );
      // A link-wallet challenge is not an admin-sign-in, whoever presents it.
      const c3 = await linkChallenge(w);
      await expectApiError(
        verify(w, c3, { expectedPurpose: "admin-sign-in" }),
        401,
        "challenge_purpose_mismatch",
      );
      await expectApiError(
        challenges().verify({
          challengeId: "not-a-uuid",
          partyId: w.partyId,
          publicKey: w.publicKeyBase64,
          signature: "x",
          expectedPurpose: "link-wallet",
          sessionId: "s1",
        }),
        401,
        "challenge_rejected",
      );
    });

    it("binds link-wallet challenges to the issuing session and keeps admin-sign-in out of sessions", async () => {
      const w = makeTestWallet("link");
      await expectApiError(
        challenges().issue({ partyId: w.partyId, purpose: "link-wallet", host: "app.test" }),
        401,
        "unauthenticated",
      );
      const issued = await expectApiError(
        challenges().issue({
          partyId: operator.partyId,
          purpose: "admin-sign-in",
          sessionId: "s1",
          host: "app.test",
        }),
        409,
        "challenge_purpose_mismatch",
      );
      expect(issued.message).toBe(
        "admin-sign-in challenges cannot be issued to an existing session",
      );

      // Issued to s1: another session or no session at all is refused; s1 passes.
      await expectApiError(
        verify(w, await linkChallenge(w), { expectedPurpose: "link-wallet", sessionId: "s2" }),
        401,
        "challenge_purpose_mismatch",
      );
      await expectApiError(
        verify(w, await linkChallenge(w), { expectedPurpose: "link-wallet", sessionId: null }),
        401,
        "challenge_purpose_mismatch",
      );
      expect(
        (
          await verify(w, await linkChallenge(w), {
            expectedPurpose: "link-wallet",
            sessionId: "s1",
          })
        ).purpose,
      ).toBe("link-wallet");

      // An admin-sign-in challenge is refused as soon as any session is presented (never link mode).
      const admin = (): Promise<ApiChallenge> =>
        challenges().issue({
          partyId: operator.partyId,
          purpose: "admin-sign-in",
          host: "app.test",
        });
      await expectApiError(
        verify(operator, await admin(), { expectedPurpose: "admin-sign-in", sessionId: "s1" }),
        401,
        "challenge_purpose_mismatch",
      );
      expect(
        (
          await verify(operator, await admin(), {
            expectedPurpose: "admin-sign-in",
            sessionId: null,
          })
        ).purpose,
      ).toBe("admin-sign-in");
    });

    it("admin-sign-in requires an operator party (checked at verify time, never at issue time) and honours the pinned key", async () => {
      // Issuing never reveals operator membership (an anonymous 403-vs-200 oracle over ADMIN_OPERATORS): the refusal comes after the signature proved key control.
      const nobody = makeTestWallet("nobody");
      const cn = await challenges().issue({
        partyId: nobody.partyId,
        purpose: "admin-sign-in",
        host: "app.test",
      });
      await expectApiError(
        verify(nobody, cn, { expectedPurpose: "admin-sign-in" }),
        403,
        "forbidden",
      );

      const c = await challenges().issue({
        partyId: operator.partyId,
        purpose: "admin-sign-in",
        host: "app.test",
      });
      expect((await verify(operator, c, { expectedPurpose: "admin-sign-in" })).purpose).toBe(
        "admin-sign-in",
      );

      // pinnedOperator's namespace key is its own, but the operator list pins a different key.
      const c2 = await challenges().issue({
        partyId: pinnedOperator.partyId,
        purpose: "admin-sign-in",
        host: "app.test",
      });
      await expectApiError(
        verify(pinnedOperator, c2, { expectedPurpose: "admin-sign-in" }),
        401,
        "wallet_key_mismatch",
      );
    });

    it("consumes a challenge atomically: two concurrent presentations of one signature yield exactly one claim", async () => {
      const w = makeTestWallet("race");
      const c = await linkChallenge(w);
      const proof = {
        challengeId: c.challengeId,
        partyId: w.partyId,
        publicKey: w.publicKeyBase64,
        signature: w.sign(c.message),
        expectedPurpose: "link-wallet" as const,
        sessionId: "s1",
      };
      const results = await Promise.allSettled([
        challenges().verify(proof),
        challenges().verify(proof),
        challenges().verify(proof),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect((r.reason as ApiError).code).toBe("challenge_rejected");
      }
    });

    it("rejects malformed party ids at issue time", async () => {
      await expectApiError(
        challenges().issue({
          partyId: "a::b::1220" + "0".repeat(64),
          purpose: "link-wallet",
          sessionId: "s1",
          host: "app.test",
        }),
        400,
        "validation_failed",
      );
    });
  });

  // ───────────────────────────────────────────── HTTP guards + envelope ───────────────────────
  describe("guards and error envelope (HTTP)", () => {
    const cookieOfToken = (token: string): string =>
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`;

    it("GET /me without a session → 401 envelope; with a cookie session → passes the guard (200)", async () => {
      const res = await ctx.agent.get("/api/v1/me").expect(401);
      expect(res.body).toEqual({ error: "unauthenticated", message: "authentication required" });
      expect(res.headers["cache-control"]).toBe("no-store");

      const { cookie, user } = await issueSessionDirect(ctx, makeTestWallet("me"));
      const ok = await ctx.agent.get("/api/v1/me").set("Cookie", cookie).expect(200);
      expect(bodyOf<ApiMe>(ok).user.id).toBe(user.id);
      expect(bodyOf<ApiMe>(ok).capabilities).toMatchObject({
        isAdmin: false,
        primaryPartyId: user.partyId,
      });
      await ctx.agent.get("/api/v1/me").set("Cookie", "to_session=garbage").expect(401);
    });

    it("CSRF: non-GET without Origin → 403; allowed Origin + JSON passes; bad origin / bad content type fail", async () => {
      // An idempotent session-only POST (logout would revoke the session under test).
      const probe = "/api/v1/me/sessions/revoke-others";
      const { cookie } = await issueSessionDirect(ctx, makeTestWallet("csrf"));
      const noOrigin = await ctx.agent
        .post(probe)
        .set("Cookie", cookie)
        .set("Content-Type", "application/json")
        .send({})
        .expect(403);
      expect(noOrigin.body).toMatchObject({ error: "csrf_rejected" });

      const ok = await ctx.agent
        .post(probe)
        .set("Cookie", cookie)
        .set(ctx.csrf)
        .send({})
        .expect(200);
      expect(ok.body).toEqual({ revoked: 0 });
      // Referer works as the origin source too.
      await ctx.agent
        .post(probe)
        .set("Cookie", cookie)
        .set("Referer", `${TEST_ORIGIN}/account`)
        .set("Content-Type", "application/json")
        .send({})
        .expect(200);
      // x-requested-with satisfies the second condition without a JSON body.
      await ctx.agent
        .post(probe)
        .set("Cookie", cookie)
        .set("Origin", TEST_ORIGIN)
        .set("x-requested-with", "truthoracle")
        .expect(200);

      const badOrigin = await ctx.agent
        .post(probe)
        .set("Cookie", cookie)
        .set("Origin", "https://evil.test")
        .set("Content-Type", "application/json")
        .send({})
        .expect(403);
      expect(bodyOf<ErrorBody>(badOrigin).message).toMatch(/origin is not allowed/);
      const badType = await ctx.agent
        .post(probe)
        .set("Cookie", cookie)
        .set("Origin", TEST_ORIGIN)
        .set("Content-Type", "text/plain")
        .send("x")
        .expect(403);
      expect(bodyOf<ErrorBody>(badType).message).toMatch(/application\/json/);
      // Public non-GET routes are CSRF-checked too.
      await ctx.agent
        .post("/api/v1/auth/admin/challenge")
        .send({ partyId: makeTestWallet("x").partyId })
        .expect(403);
    });

    it("bearer sessions skip CSRF; webhooks skip CSRF", async () => {
      const { bearer } = await issueSessionDirect(ctx, makeTestWallet("bearer"));
      // No Origin, no x-requested-with: only the bearer exemption lets this through.
      await ctx.agent
        .post("/api/v1/me/sessions/revoke-others")
        .set("Authorization", bearer)
        .send({})
        .expect(200);
      await ctx.agent.get("/api/v1/me").set("Authorization", bearer).expect(200);
      await ctx.agent.get("/api/v1/me").set("Authorization", "Bearer nope").expect(401);
      // The webhook reaches its handler (the digest check, not the CSRF guard, rejects it).
      const wh = await ctx.agent
        .post("/api/v1/webhooks/kyc/sumsub")
        .set("Content-Type", "application/json")
        .send({ a: 1 })
        .expect(401);
      expect(bodyOf<ErrorBody>(wh).error).toBe("webhook_rejected");
    });

    it("suspended users are 403 user_suspended on every route", async () => {
      const { cookie, user } = await issueSessionDirect(ctx, makeTestWallet("susp2"));
      await ctx.dataSource
        .getRepository(UserEntity)
        .update({ id: user.id }, { status: "suspended" });
      await ctx.get(UserService).invalidate(user.id);
      const res = await ctx.agent.get("/api/v1/me").set("Cookie", cookie).expect(403);
      expect(res.body).toMatchObject({ error: "user_suspended" });
      // Public routes with a suspended session are refused as well.
      await ctx.agent.get("/api/v1/auth/session").set("Cookie", cookie).expect(403);
    });

    it("AdminGuard: user sessions → 403; operator admin sessions pass; a user-kind session on the operator's identity is still 403; removal revokes", async () => {
      const { cookie } = await issueSessionDirect(ctx, makeTestWallet("plain"));
      const res = await ctx.agent.get("/api/v1/admin/users").set("Cookie", cookie).expect(403);
      expect(res.body).toMatchObject({ error: "forbidden" });

      const admin = await issueSessionDirect(ctx, operator, { kind: "admin" });
      await ctx.agent.get("/api/v1/admin/users").set("Cookie", admin.cookie).expect(200);

      // The kind is the authority, not the identity: a user-kind session authenticated by the very same operator identity is not admin.
      const userKind = await ctx
        .get(SessionService)
        .issue({ userId: admin.user.id, authIdentityId: admin.identity.id, kind: "user" });
      await ctx.agent
        .get("/api/v1/admin/users")
        .set("Cookie", cookieOfToken(userKind.token))
        .expect(403);

      const pinned = ctx.config.adminOperators.get(operator.partyId);
      ctx.config.adminOperators.delete(operator.partyId);
      try {
        await ctx.agent.get("/api/v1/admin/users").set("Cookie", admin.cookie).expect(403);
        // The session was revoked, not merely refused.
        await ctx.agent.get("/api/v1/me").set("Cookie", admin.cookie).expect(401);
      } finally {
        ctx.config.adminOperators.set(operator.partyId, pinned ?? "");
      }
    });

    it("AdminGuard re-checks a pinned operator key against the key stored on the identity and fails closed (§6.8)", async () => {
      const identities = ctx.dataSource.getRepository(AuthIdentityEntity);
      // pinnedOperator signed with its own key but ADMIN_OPERATORS pins someone else's: the stored key differs → revoked.
      const mismatched = await issueSessionDirect(ctx, pinnedOperator, { kind: "admin" });
      const res = await ctx.agent
        .get("/api/v1/admin/users")
        .set("Cookie", mismatched.cookie)
        .expect(403);
      expect(res.body).toMatchObject({
        error: "forbidden",
        message: expect.stringMatching(/pinned key/) as string,
      });
      await ctx.agent.get("/api/v1/me").set("Cookie", mismatched.cookie).expect(401);

      // A pin is configured but the identity carries no key at all → fail closed.
      const bare = await issueSessionDirect(ctx, pinnedOperator, { kind: "admin" });
      await identities.update({ id: bare.identity.id }, { profile: { name: "pinned" } });
      await ctx.agent.get("/api/v1/admin/users").set("Cookie", bare.cookie).expect(403);
      await ctx.agent.get("/api/v1/me").set("Cookie", bare.cookie).expect(401);

      // The stored key equal to the pin passes.
      const good = await issueSessionDirect(ctx, pinnedOperator, { kind: "admin" });
      await identities.update(
        { id: good.identity.id },
        { profile: { name: "pinned", publicKey: pinnedKeyOwner.publicKeyBase64 } },
      );
      await ctx.agent.get("/api/v1/admin/users").set("Cookie", good.cookie).expect(200);
    });

    it("SessionGuard refuses admin sessions on account routes (default deny) and admits them where a handler opted in (§6.8)", async () => {
      const admin = await issueSessionDirect(ctx, operator, { kind: "admin" });
      const w = makeTestWallet("gate");
      const refused = (res: request.Response): void => {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({
          error: "forbidden",
          message: "admin sessions cannot use account routes",
        });
      };
      refused(
        await ctx.agent
          .post("/api/v1/wallets/link-challenge")
          .set(ctx.csrf)
          .set("Cookie", admin.cookie)
          .send({ partyId: w.partyId }),
      );
      refused(
        await ctx.agent
          .post("/api/v1/kyc/sessions")
          .set(ctx.csrf)
          .set("Cookie", admin.cookie)
          .send({}),
      );
      refused(
        await ctx.agent
          .post("/api/v1/in-app-wallet/deposits/reconcile")
          .set(ctx.csrf)
          .set("Cookie", admin.cookie)
          .send({}),
      );
      refused(
        await ctx.agent
          .delete(`/api/v1/me/identities/${admin.identity.id}`)
          .set(ctx.csrf)
          .set("Cookie", admin.cookie),
      );
      refused(
        await ctx.agent
          .patch("/api/v1/me")
          .set(ctx.csrf)
          .set("Cookie", admin.cookie)
          .send({ displayName: "x" }),
      );
      refused(await ctx.agent.get("/api/v1/wallets").set("Cookie", admin.cookie));
      expect((await identities().findOne({ where: { id: admin.identity.id } }))?.status).toBe(
        "active",
      );

      // Opted in: the session reads itself, manages its own sessions and logs out.
      expect(
        bodyOf<ApiMe>(await ctx.agent.get("/api/v1/me").set("Cookie", admin.cookie).expect(200))
          .capabilities.isAdmin,
      ).toBe(true);
      await ctx.agent.get("/api/v1/me/sessions").set("Cookie", admin.cookie).expect(200);
      expect(
        (
          await ctx.agent
            .post("/api/v1/me/sessions/revoke-others")
            .set(ctx.csrf)
            .set("Cookie", admin.cookie)
            .send({})
            .expect(200)
        ).body,
      ).toEqual({ revoked: 0 });
      await ctx.agent
        .post("/api/v1/auth/logout")
        .set(ctx.csrf)
        .set("Cookie", admin.cookie)
        .send({})
        .expect(200);
      await ctx.agent.get("/api/v1/me").set("Cookie", admin.cookie).expect(401);
    });
    const identities = () => ctx.dataSource.getRepository(AuthIdentityEntity);

    it("ValidationPipe and body-parser failures render 400 validation_failed", async () => {
      const bad = await ctx.agent
        .post("/api/v1/auth/admin/challenge")
        .set(ctx.csrf)
        .send({ partyId: "nope", extra: 1 })
        .expect(400);
      const badBody = bodyOf<ErrorBody>(bad);
      expect(badBody.error).toBe("validation_failed");
      expect(badBody.details?.issues).toEqual(
        expect.arrayContaining([expect.stringMatching(/partyId/), expect.stringMatching(/extra/)]),
      );
      const notJson = await ctx.agent
        .post("/api/v1/auth/admin/challenge")
        .set(ctx.csrf)
        .send("{not json")
        .expect(400);
      expect(notJson.body).toEqual({
        error: "validation_failed",
        message: "request body is not valid JSON",
      });
    });

    it("POST /auth/admin/challenge is live: issues a message and rate-limits per party", async () => {
      const w = makeTestWallet("rl");
      for (let i = 0; i < 10; i += 1) {
        const res = await ctx.agent
          .post("/api/v1/auth/admin/challenge")
          .set(ctx.csrf)
          .send({ partyId: w.partyId })
          .expect(200);
        const body = res.body as ApiChallenge;
        expect(body.message).toContain("TruthOracle admin-sign-in");
        expect(body.message).toContain(`Party: ${w.partyId}`);
        expect(body.message).toContain("Network: devnet");
        expect(body.message).toMatch(/Domain: 127\.0\.0\.1:\d+/);
        expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
      }
      const limited = await ctx.agent
        .post("/api/v1/auth/admin/challenge")
        .set(ctx.csrf)
        .send({ partyId: w.partyId })
        .expect(429);
      expect(limited.body).toMatchObject({
        error: "rate_limited",
        details: { scope: "challenge" },
      });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    });

    it("the proxy contract decides the request host used in the challenge", async () => {
      // Without the secret configured, x-forwarded-host is ignored.
      const w = makeTestWallet("proxy");
      const res = await ctx.agent
        .post("/api/v1/auth/admin/challenge")
        .set(ctx.csrf)
        .set("x-forwarded-host", "spoofed.test")
        .set("x-truthoracle-proxy", "whatever")
        .send({ partyId: w.partyId })
        .expect(200);
      expect((res.body as ApiChallenge).message).not.toContain("spoofed.test");
    });

    it("echoes x-request-id", async () => {
      const res = await ctx.agent.get("/health").set("x-request-id", "abc-123").expect(200);
      expect(res.headers["x-request-id"]).toBe("abc-123");
    });
  });
});
