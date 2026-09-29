/**
 * Operator API end to end (docs/API.md "Admin"; ARCHITECTURE §6.8, §9.3–9.4, §11) against the REAL
 * services: a wallet-signed admin session — party in ADMIN_OPERATORS, purpose `admin-sign-in` —
 * reaches every route, a user session is 403, every mutation needs a `reason` and lands in the
 * audit trail with actorType `admin`, and the operator paths that bypass the KYC gate (force
 * settle), re-bind verified persons (transfer) and approve by hand (override) run the same
 * KycService / PayoutService / WalletLinkService the user routes run — the ledger, the Enterprise
 * Wallet and NATS are the in-memory fakes; KYC approvals go through the mock provider over HTTP.
 * KYC_ENFORCE_WITHDRAWALS is on so withdrawals actually block.
 */
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";

import type { KycMockDocumentDto, KycMockSubmitDto } from "../src/dto/kyc.dto";
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { KycPersonEntity } from "../src/entities/kyc-person.entity";
import { KycVerificationEntity } from "../src/entities/kyc-verification.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { SessionEntity } from "../src/entities/session.entity";
import { UserEntity } from "../src/entities/user.entity";
import { WalletEntity } from "../src/entities/wallet.entity";
import type { AdminUserDetail } from "../src/services/admin.service";
import { IdentityService } from "../src/services/identity.service";
import { KycService, fingerprintOf } from "../src/services/kyc.service";
import { commandIdsFor } from "../src/services/payout.service";
import { SessionService } from "../src/services/session.service";
import type {
  ApiAuditEvent,
  ApiIdentity,
  ApiKycVerification,
  ApiLoginResult,
  ApiMe,
  ApiPage,
  ApiPayout,
  ApiUser,
  KycVerificationStatus,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { parseCC } from "../src/util/money";
import { useTestApp } from "./helpers/app";
import { bodyOf, issueSessionDirect, linkWallet, signInAsAdmin } from "./helpers/session";
import { nextTelegramUser, signInWithTelegram } from "./helpers/telegram";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("operator");
const PERSON = { firstName: "Jane", lastName: "Doe", dob: "1990-01-01", country: "IND" };
const OTHER_PERSON = { firstName: "Rahul", lastName: "Sharma", dob: "1985-05-05", country: "IND" };
const PASSPORT: KycMockDocumentDto = { docType: "PASSPORT", country: "IND", number: "Z1234567" };
const FP64 = "a".repeat(64);

describe("Admin API (e2e)", () => {
  const ctx = useTestApp({
    env: {
      ADMIN_OPERATORS: operator.partyId,
      KYC_ENFORCE_WITHDRAWALS: "true",
      PAYOUT_SCAN_MS: "600000",
    },
  });

  let admin: { cookie: string; userId: string };

  beforeEach(async () => {
    admin = await adminSignIn();
  });

  /** Jar-less client: cookies are only ever what a test sets. */
  const http = (): request.Agent => request(ctx.app.getHttpServer() as Server);

  /** The real flow: `POST /auth/admin/challenge` (party in ADMIN_OPERATORS) → sign → `POST /auth/admin` (§7.4). */
  async function adminSignIn(): Promise<{ cookie: string; userId: string }> {
    const { cookie, user, result } = await signInAsAdmin(http(), operator);
    expect(result.kind).toBe("admin");
    return { cookie, userId: user.id };
  }

  const get = (path: string, cookie: string) =>
    http().get(`/api/v1/admin${path}`).set("Cookie", cookie);
  const post = (path: string, cookie: string) =>
    http().post(`/api/v1/admin${path}`).set("Cookie", cookie).set(ctx.csrf);
  const auditRows = (action: string) =>
    ctx.dataSource
      .getRepository(AuditEventEntity)
      .find({ where: { action }, order: { id: "ASC" } });
  const userRow = (id: string) => ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id });
  const persons = () => ctx.dataSource.getRepository(KycPersonEntity);
  const verifications = () => ctx.dataSource.getRepository(KycVerificationEntity);
  const fp = (canonical: string): string =>
    fingerprintOf(ctx.config.kycFingerprintPepper, canonical);

  /** A fresh user account opened by Telegram (§6.1) with `hint`'s wallet linked as its primary (§8.1); `identityId` is the Telegram identity. */
  async function newUser(
    hint: string,
  ): Promise<{
    cookie: string;
    user: ApiUser;
    wallet: ReturnType<typeof makeTestWallet>;
    identityId: string;
  }> {
    const wallet = makeTestWallet(hint);
    const { cookie, user, result } = await signInWithTelegram(http(), nextTelegramUser(hint));
    await linkWallet(http(), cookie, wallet);
    return { cookie, user, wallet, identityId: result.identity.id };
  }

  /** `POST /kyc/sessions` then `POST /kyc/mock/submit` for the user; returns the verification id and the final status. */
  async function mockKyc(
    cookie: string,
    outcome: KycMockSubmitDto["outcome"],
    person = PERSON,
    documents: KycMockDocumentDto[] = [PASSPORT],
  ): Promise<{ verificationId: string; status: KycVerificationStatus }> {
    const started = bodyOf<{ verificationId: string }>(
      await http()
        .post("/api/v1/kyc/sessions")
        .set("Cookie", cookie)
        .set(ctx.csrf)
        .send({})
        .expect(200),
    );
    const done = await http()
      .post("/api/v1/kyc/mock/submit")
      .set("Cookie", cookie)
      .set(ctx.csrf)
      .send({ verificationId: started.verificationId, outcome, person, documents })
      .expect(200);
    return {
      verificationId: started.verificationId,
      status: bodyOf<{ verification: ApiKycVerification }>(done).verification.status,
    };
  }

  async function seedVerification(
    userId: string,
    status: KycVerificationStatus,
    extra: Partial<KycVerificationEntity> = {},
  ): Promise<KycVerificationEntity> {
    const repo = verifications();
    return repo.save(
      repo.create({
        userId,
        provider: "mock",
        providerApplicantId: null,
        levelName: ctx.config.kycRequiredLevel,
        attemptNo: 1,
        status,
        initiatedIdentityId: null,
        providerEventAt: null,
        rejectLabels: null,
        moderationComment: null,
        manual: false,
        manualReason: null,
        reviewedAt: null,
        ...extra,
      }),
    );
  }

  // ───────────────────────────────────────── access ────────────────────────────────────────────
  describe("access", () => {
    it("anonymous → 401, a user session → 403 forbidden, the admin session → 200", async () => {
      const anon = await http().get("/api/v1/admin/users").expect(401);
      expect(bodyOf<ErrorBody>(anon).error).toBe("unauthenticated");

      const plain = await issueSessionDirect(ctx, makeTestWallet("plain"));
      const denied = await get("/users", plain.cookie).expect(403);
      expect(bodyOf<ErrorBody>(denied)).toEqual({
        error: "forbidden",
        message: "an admin session is required",
      });
      await post(`/users/${plain.user.id}/suspend`, plain.cookie)
        .send({ reason: "self" })
        .expect(403);
      await get("/payouts", plain.cookie).expect(403);
      await get("/audit", plain.cookie).expect(403);

      const ok = await get("/users", admin.cookie).expect(200);
      expect(bodyOf<ApiPage<ApiUser>>(ok)).toMatchObject({ page: 1, limit: 25 });
      await get("/kyc/duplicates", admin.cookie).expect(200);
      await get("/kyc/needs-review", admin.cookie).expect(200);
      await get("/payouts", admin.cookie).expect(200);
      await get("/audit", admin.cookie).expect(200);
    });

    it("a bearer admin session skips CSRF; a cookie admin session without Origin is refused", async () => {
      const direct = await issueSessionDirect(ctx, operator, { kind: "admin" });
      const target = await issueSessionDirect(ctx, makeTestWallet("bearer-target"));
      await http()
        .post(`/api/v1/admin/users/${target.user.id}/reinstate`)
        .set("Authorization", direct.bearer)
        .send({ reason: "noop" })
        .expect(200);
      const noOrigin = await http()
        .post(`/api/v1/admin/users/${target.user.id}/reinstate`)
        .set("Cookie", admin.cookie)
        .set("Content-Type", "application/json")
        .send({ reason: "noop" })
        .expect(403);
      expect(bodyOf<ErrorBody>(noOrigin).error).toBe("csrf_rejected");
    });

    it.each([
      ["/users/:id/suspend"],
      ["/users/:id/reinstate"],
      ["/users/:id/sessions/revoke"],
      ["/users/:id/identities/:id/reattach"],
      ["/users/:id/identities/:id/unlink"],
      ["/users/:id/kyc/override"],
      [`/kyc/persons/${FP64}/transfer`],
      ["/kyc/webhooks/:id/replay"],
      ["/payouts/pp-1/settle"],
    ])("POST %s without a reason → 400 validation_failed", async (template) => {
      const path = template.replace(/:id/g, randomUUID());
      const res = await post(path, admin.cookie).send({}).expect(400);
      const body = bodyOf<ErrorBody>(res);
      expect(body.error).toBe("validation_failed");
      expect(body.details?.issues).toEqual(
        expect.arrayContaining([expect.stringMatching(/reason/)]),
      );
    });

    it("rejects non-UUID user ids, malformed cids and non-hex fingerprints with 400 rather than a database or upstream error", async () => {
      const res = await get("/users/not-a-uuid", admin.cookie).expect(400);
      expect(bodyOf<ErrorBody>(res).error).toBe("validation_failed");
      await post("/users/not-a-uuid/suspend", admin.cookie).send({ reason: "x" }).expect(400);
      const cid = await post("/payouts/not%20a%20cid!/settle", admin.cookie)
        .send({ reason: "x" })
        .expect(400);
      expect(bodyOf<ErrorBody>(cid).details?.issues).toEqual(
        expect.arrayContaining([expect.stringMatching(/cid/)]),
      );
      const fpBad = await post("/kyc/persons/person-fp-7/transfer", admin.cookie)
        .send({ toUserId: randomUUID(), reason: "x" })
        .expect(400);
      expect(bodyOf<ErrorBody>(fpBad).details?.issues).toEqual(
        expect.arrayContaining([expect.stringMatching(/fingerprint/)]),
      );
    });
  });

  // ───────────────────────────────────────── users ─────────────────────────────────────────────
  describe("users", () => {
    it("searches by id, name, email, party and identity subject; paginates", async () => {
      const identities = ctx.get(IdentityService);
      const ada = await identities.resolveForLogin(
        {
          provider: "google",
          subject: "g-ada",
          email: "Ada@Example.com",
          profile: { name: "Ada Lovelace" },
        },
        { currentUser: null },
      );
      const bobWallet = makeTestWallet("bobwallet");
      const bob = await issueSessionDirect(ctx, bobWallet);
      await identities.resolveForLogin(
        { provider: "telegram", subject: "777001", profile: { username: "bobby" } },
        { currentUser: bob.user },
      );

      const search = async (q: string): Promise<ApiPage<ApiUser>> =>
        bodyOf<ApiPage<ApiUser>>(
          await get(`/users?q=${encodeURIComponent(q)}`, admin.cookie).expect(200),
        );

      const all = await search("");
      expect(all.total).toBe(3); // ada, bob and the operator's own account
      expect(all.items.map((u) => u.id)).toEqual(
        expect.arrayContaining([ada.user.id, bob.user.id, admin.userId]),
      );

      expect((await search("lovelace")).items.map((u) => u.id)).toEqual([ada.user.id]);
      expect((await search("ADA@example.com")).items.map((u) => u.id)).toEqual([ada.user.id]);
      expect((await search(ada.user.id)).items.map((u) => u.id)).toEqual([ada.user.id]);
      expect((await search("bobwallet")).items.map((u) => u.id)).toEqual([bob.user.id]);
      expect((await search(bobWallet.partyId)).items.map((u) => u.id)).toEqual([bob.user.id]);
      expect((await search("777001")).items.map((u) => u.id)).toEqual([bob.user.id]);
      expect((await search("nobody-here")).total).toBe(0);
      // LIKE metacharacters are literal search text, never wildcards.
      expect((await search("%")).total).toBe(0);
      expect((await search(randomUUID())).total).toBe(0);

      const page2 = bodyOf<ApiPage<ApiUser>>(
        await get("/users?page=2&limit=1", admin.cookie).expect(200),
      );
      expect(page2).toMatchObject({ page: 2, limit: 1, total: 3 });
      expect(page2.items).toHaveLength(1);
      await get("/users?limit=0", admin.cookie).expect(400);
      await get("/users?sort=email", admin.cookie).expect(400);
    });

    it("GET /admin/users/:id composes the whole account", async () => {
      const identities = ctx.get(IdentityService);
      const primary = makeTestWallet("detail");
      const target = await issueSessionDirect(ctx, primary);
      const google = await identities.resolveForLogin(
        {
          provider: "google",
          subject: "g-detail",
          email: "d@example.com",
          profile: { name: "Dee" },
        },
        { currentUser: target.user },
      );

      // A second, non-primary wallet that owns its own on-ledger UserWallet (§8.1) — a row, never an identity.
      const secondary = makeTestWallet("second");
      const wallets = ctx.dataSource.getRepository(WalletEntity);
      await wallets.save(
        wallets.create({
          userId: target.user.id,
          chain: "canton",
          kind: "cantor8",
          partyId: secondary.partyId,
          publicKey: secondary.publicKeyBase64,
          label: "cold",
          isPrimary: false,
          status: "active",
          creditedCC: parseCC("1.5"),
          verifiedAt: new Date(),
          revokedAt: null,
        }),
      );
      ctx.ledger.seedUserWallet(secondary.partyId, { balanceCC: "3", depositedCC: "3" });

      const onLedger = ctx.ledger.seedPendingPayout({
        user: primary.partyId,
        amountCC: "2",
        reason: "withdraw",
      });
      const payouts = ctx.dataSource.getRepository(PayoutEntity);
      await payouts.save(
        payouts.create({
          pendingPayoutCid: onLedger.contractId,
          payeeParty: primary.partyId,
          userId: target.user.id,
          payeeWalletId: null,
          status: "blocked_kyc",
          amountCC: parseCC("2"),
          reason: "withdraw",
          attempts: 0,
          lastError: null,
          firstSeenAt: new Date(),
          settledAt: null,
        }),
      );

      // A standing approval attached to the Google identity — the real KycService lock (§6.5) follows users.kyc_verification_id.
      const verification = await seedVerification(target.user.id, "approved", {
        initiatedIdentityId: google.identity.id,
        reviewedAt: new Date(),
      });
      await ctx.dataSource
        .getRepository(UserEntity)
        .update(
          { id: target.user.id },
          { kycStatus: "approved", kycVerificationId: verification.id },
        );
      await persons().save(
        persons().create({
          fingerprint: fp("IND|PASSPORT|DETAIL1"),
          kind: "doc",
          userId: target.user.id,
          verificationId: verification.id,
          fingerprintVersion: 1,
          boundAt: new Date(),
          releasedAt: null,
          releasedBy: null,
          releaseReason: null,
        }),
      );
      await persons().save(
        persons().create({
          fingerprint: fp("IND|PASSPORT|DETAILOLD"),
          kind: "doc",
          userId: target.user.id,
          verificationId: verification.id,
          fingerprintVersion: 1,
          boundAt: new Date(),
          releasedAt: new Date(),
          releasedBy: null,
          releaseReason: "moved",
        }),
      );

      const detail = bodyOf<AdminUserDetail>(
        await get(`/users/${target.user.id}`, admin.cookie).expect(200),
      );

      expect(detail.user).toMatchObject({
        id: target.user.id,
        status: "active",
        kycStatus: "approved",
        partyId: primary.partyId,
      });
      expect(detail.identities.map((i) => [i.provider, i.status, i.kycLocked])).toEqual(
        expect.arrayContaining([
          ["telegram", "active", false],
          ["google", "active", true],
        ]),
      );
      expect(detail.identities).toHaveLength(2);
      expect(detail.wallets).toHaveLength(2);
      const [w1, w2] = detail.wallets;
      expect(w1).toMatchObject({
        partyId: primary.partyId,
        isPrimary: true,
        ownLedgerWallet: null,
      });
      expect(w2).toMatchObject({
        partyId: secondary.partyId,
        isPrimary: false,
        label: "cold",
        creditedCC: "1.5000000000",
      });
      expect(Object.keys(w2).filter((k) => k.endsWith("CC"))).toEqual(["creditedCC"]);
      expect(w2.ownLedgerWallet).toMatchObject({
        owner: secondary.partyId,
        balanceCC: "3.0000000000",
      });
      expect(detail.kyc).toMatchObject({
        provider: "mock",
        status: "approved",
        attachedIdentityId: google.identity.id,
        requiredForWithdrawal: true,
      });
      expect(detail.kyc.history).toHaveLength(1);
      expect(detail.sessions).toHaveLength(1);
      expect(detail.sessions[0]).toMatchObject({
        id: target.session.id,
        kind: "user",
        authMethod: "telegram",
        identityId: target.identity.id,
        current: false,
      });
      expect(detail.payouts).toEqual([
        expect.objectContaining({
          pendingPayoutCid: onLedger.contractId,
          status: "blocked_kyc",
          retryAfterKyc: true,
          onLedger: true,
          amountCC: "2.0000000000",
        }),
      ]);
      // Only live bindings are listed; a released one is history.
      expect(detail.persons).toEqual([
        {
          fingerprint: fp("IND|PASSPORT|DETAIL1"),
          kind: "doc",
          boundAt: expect.any(String) as string,
        },
      ]);

      const missing = await get(`/users/${randomUUID()}`, admin.cookie).expect(404);
      expect(bodyOf<ErrorBody>(missing).error).toBe("not_found");
    });
  });

  // ─────────────────────────────────── suspend / reinstate / sessions ──────────────────────────
  describe("suspend / reinstate / sessions", () => {
    it("suspend revokes the target's live session immediately and is audited with the reason", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("target"));
      const alive = await http().get("/api/v1/me").set("Cookie", target.cookie);
      expect(alive.status).not.toBe(401);

      await post(`/users/${target.user.id}/suspend`, admin.cookie).send({}).expect(400);
      const res = await post(`/users/${target.user.id}/suspend`, admin.cookie)
        .send({ reason: "  chargeback abuse  " })
        .expect(200);
      expect(res.body).toEqual({ ok: true });

      // The session is revoked (not merely refused): the next request is 401.
      const dead = await http().get("/api/v1/me").set("Cookie", target.cookie).expect(401);
      expect(bodyOf<ErrorBody>(dead).error).toBe("unauthenticated");
      expect(await ctx.get(SessionService).verify(target.token)).toBeNull();
      const row = await userRow(target.user.id);
      expect(row.status).toBe("suspended");

      const [suspended] = await auditRows("user.suspended");
      expect(suspended).toMatchObject({
        actorType: "admin",
        actorUserId: admin.userId,
        subjectType: "user",
        subjectId: target.user.id,
        metadata: { reason: "chargeback abuse" },
      });
      expect(suspended.actorSessionId).not.toBeNull();
      expect(await auditRows("session.revoked_all")).toEqual([
        expect.objectContaining({
          subjectId: target.user.id,
          metadata: { reason: "user.suspended", revoked: 1 },
        }),
      ]);

      // The user cannot sign in again until reinstated.
      await expect(
        ctx
          .get(IdentityService)
          .resolveForLogin(
            { provider: "telegram", subject: target.identity.subject },
            { currentUser: null },
          ),
      ).rejects.toMatchObject({ code: "user_suspended" });

      await post(`/users/${target.user.id}/reinstate`, admin.cookie)
        .send({ reason: "dispute resolved" })
        .expect(200);
      expect((await userRow(target.user.id)).status).toBe("active");
      const [reinstated] = await auditRows("user.reinstated");
      expect(reinstated).toMatchObject({
        actorType: "admin",
        actorUserId: admin.userId,
        metadata: { reason: "dispute resolved" },
      });
      const back = await issueSessionDirect(ctx, makeTestWallet("unused"), {
        withWalletRow: false,
      });
      expect(back.user.status).toBe("active");

      await post(`/users/${randomUUID()}/suspend`, admin.cookie)
        .send({ reason: "ghost" })
        .expect(404);
    });

    it("sessions/revoke kills every session of the user and audits the count", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("multi"));
      const sessions = ctx.get(SessionService);
      const second = await sessions.issue({
        userId: target.user.id,
        authIdentityId: target.identity.id,
        kind: "user",
      });
      expect(await sessions.listForUser(target.user.id)).toHaveLength(2);

      await post(`/users/${target.user.id}/sessions/revoke`, admin.cookie)
        .send({ reason: "credential leak" })
        .expect(200);
      expect(await sessions.verify(target.token)).toBeNull();
      expect(await sessions.verify(second.token)).toBeNull();
      expect(await sessions.listForUser(target.user.id)).toHaveLength(0);
      expect(await ctx.redis.smembers(`user_sessions:${target.user.id}`)).toEqual([]);
      const revoked = await ctx.dataSource
        .getRepository(SessionEntity)
        .find({ where: { userId: target.user.id } });
      expect(revoked.every((s) => s.revokedAt !== null)).toBe(true);

      const [audit] = await auditRows("session.revoked_all");
      expect(audit).toMatchObject({
        actorType: "admin",
        actorUserId: admin.userId,
        subjectType: "user",
        subjectId: target.user.id,
        metadata: { reason: "credential leak", revoked: 2 },
      });
      // The account itself is untouched.
      expect((await userRow(target.user.id)).status).toBe("active");
    });
  });

  // ─────────────────────────────────────── identities ──────────────────────────────────────────
  describe("identities", () => {
    it("admin unlink bypasses the KYC lock, kills the identity's sessions and records the reason; reattach restores it without a proof", async () => {
      const identities = ctx.get(IdentityService);
      const sessions = ctx.get(SessionService);
      const target = await issueSessionDirect(ctx, makeTestWallet("ident"));
      const tg = await identities.resolveForLogin(
        { provider: "telegram", subject: "4242" },
        { currentUser: target.user },
      );
      const tgSession = await sessions.issue({
        userId: target.user.id,
        authIdentityId: tg.identity.id,
        kind: "user",
      });
      // The real lock: a standing approval initiated by the Telegram identity.
      const verification = await seedVerification(target.user.id, "approved", {
        initiatedIdentityId: tg.identity.id,
        reviewedAt: new Date(),
      });
      await ctx.dataSource
        .getRepository(UserEntity)
        .update(
          { id: target.user.id },
          { kycStatus: "approved", kycVerificationId: verification.id },
        );
      expect(await ctx.get(KycService).lockedIdentityId(target.user.id)).toBe(tg.identity.id);

      // The user could not (409 identity_locked_by_kyc — §6.5); an operator can.
      await expect(
        identities.unlink(target.user.id, tg.identity.id, { type: "user", userId: target.user.id }),
      ).rejects.toMatchObject({ code: "identity_locked_by_kyc" });
      const unlinked = await post(
        `/users/${target.user.id}/identities/${tg.identity.id}/unlink`,
        admin.cookie,
      )
        .send({ reason: "account takeover report" })
        .expect(200);
      expect(bodyOf<{ identity: ApiIdentity }>(unlinked).identity).toMatchObject({
        id: tg.identity.id,
        provider: "telegram",
        status: "unlinked",
        kycLocked: true,
      });
      expect(await sessions.verify(tgSession.token)).toBeNull();
      expect(await sessions.verify(target.token)).not.toBeNull();

      const unlinkAudits = await auditRows("identity.unlinked");
      expect(unlinkAudits).toHaveLength(2); // IdentityService's row + the operator's reason
      expect(
        unlinkAudits.every(
          (a) =>
            a.actorType === "admin" &&
            a.actorUserId === admin.userId &&
            a.subjectId === tg.identity.id,
        ),
      ).toBe(true);
      expect(unlinkAudits.map((a) => a.metadata.reason)).toEqual(
        expect.arrayContaining(["account takeover report"]),
      );

      // Signing in with the unlinked identity fails closed (§6.4) …
      await expect(
        identities.resolveForLogin(
          { provider: "telegram", subject: "4242" },
          { currentUser: null },
        ),
      ).rejects.toMatchObject({ code: "identity_unlinked" });
      // … until the operator re-attaches it.
      const reattached = await post(
        `/users/${target.user.id}/identities/${tg.identity.id}/reattach`,
        admin.cookie,
      )
        .send({ reason: "owner verified by call" })
        .expect(200);
      expect(bodyOf<{ identity: ApiIdentity }>(reattached).identity).toMatchObject({
        id: tg.identity.id,
        status: "active",
      });
      const reattachAudits = await auditRows("identity.reattached");
      expect(reattachAudits).toHaveLength(2);
      expect(reattachAudits.map((a) => a.metadata.reason)).toEqual(
        expect.arrayContaining(["owner verified by call"]),
      );
      expect(
        (
          await identities.resolveForLogin(
            { provider: "telegram", subject: "4242" },
            { currentUser: null },
          )
        ).user.id,
      ).toBe(target.user.id);

      // Idempotent: re-attaching an active identity changes and audits nothing.
      await post(`/users/${target.user.id}/identities/${tg.identity.id}/reattach`, admin.cookie)
        .send({ reason: "again" })
        .expect(200);
      expect(await auditRows("identity.reattached")).toHaveLength(2);
    });

    it("keeps the IdentityService rules for operators too: last identity and unknown ids", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("rules"));
      const last = await post(
        `/users/${target.user.id}/identities/${target.identity.id}/unlink`,
        admin.cookie,
      )
        .send({ reason: "x" })
        .expect(409);
      expect(bodyOf<ErrorBody>(last).error).toBe("last_identity");

      const other = await issueSessionDirect(ctx, makeTestWallet("other"));
      const foreign = await post(
        `/users/${target.user.id}/identities/${other.identity.id}/unlink`,
        admin.cookie,
      )
        .send({ reason: "x" })
        .expect(404);
      expect(bodyOf<ErrorBody>(foreign).error).toBe("not_found");
      await post(`/users/${target.user.id}/identities/${randomUUID()}/reattach`, admin.cookie)
        .send({ reason: "x" })
        .expect(404);
      expect(await auditRows("identity.unlinked")).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────── KYC ─────────────────────────────────────────────
  describe("kyc (real KycService, mock provider)", () => {
    it("override approved binds the applicant's keys re-read from the provider and the gate opens; without an applicant the approval is refused", async () => {
      // A needs_review case (GREEN, no document): the operator vouches for the person by hand.
      const target = await newUser("kyc-nr");
      const { verificationId: nr, status } = await mockKyc(target.cookie, "approved", PERSON, []);
      expect(status).toBe("needs_review");
      expect(
        (
          await http()
            .get("/api/v1/me")
            .set("Cookie", target.cookie)
            .expect(200)
            .then((r) => bodyOf<ApiMe>(r))
        ).capabilities.canWithdraw,
      ).toBe(false);

      const res = await post(`/users/${target.user.id}/kyc/override`, admin.cookie)
        .send({ status: "approved", reason: "documents checked by hand" })
        .expect(200);
      const { verification } = bodyOf<{ verification: ApiKycVerification }>(res);
      expect(verification).toMatchObject({
        provider: "admin",
        status: "approved",
        attemptNo: 1,
        levelName: ctx.config.kycRequiredLevel,
        rejectLabels: [],
      });
      expect(Object.keys(verification)).not.toContain("manualReason");

      const user = await userRow(target.user.id);
      expect(user).toMatchObject({ kycStatus: "approved", kycVerificationId: verification.id });
      expect((await verifications().findOneByOrFail({ id: nr })).status).toBe("expired");
      // The binding exists (the person key the provider could supply), so the §9.4 gate honours the approval.
      expect(
        (await persons().find({ where: { userId: target.user.id } })).map((p) => [
          p.kind,
          p.verificationId,
        ]),
      ).toEqual([["person", verification.id]]);
      expect(await ctx.get(KycService).withdrawalGate(target.user.id)).toEqual({ allowed: true });
      const me = bodyOf<ApiMe>(
        await http().get("/api/v1/me").set("Cookie", target.cookie).expect(200),
      );
      expect(me.capabilities.canWithdraw).toBe(true);
      expect(me.kyc.status).toBe("approved");
      const detail = bodyOf<AdminUserDetail>(
        await get(`/users/${target.user.id}`, admin.cookie).expect(200),
      );
      expect(detail.kyc.status).toBe("approved");
      expect(detail.kyc.history.map((v) => v.id)).toEqual([verification.id, nr]);
      const [audit] = await auditRows("kyc.admin_override");
      expect(audit).toMatchObject({
        actorType: "admin",
        actorUserId: admin.userId,
        subjectId: target.user.id,
        metadata: { status: "approved", reason: "documents checked by hand", provider: "admin" },
      });
      expect(
        ctx.nats
          .publishedOn("truthoracle.kyc.status_changed")
          .filter((e) => (e.payload as { provider: string }).provider === "admin"),
      ).toHaveLength(1);

      const bad = await post(`/users/${target.user.id}/kyc/override`, admin.cookie)
        .send({ status: "pending", reason: "x" })
        .expect(400);
      expect(bodyOf<ErrorBody>(bad).details?.issues).toEqual(
        expect.arrayContaining([expect.stringMatching(/status must be one of/)]),
      );

      // No provider applicant → nothing could ever be bound → the approval is refused rather than saved as one the gate never honours.
      const fresh = await newUser("kyc-fresh");
      const refused = await post(`/users/${fresh.user.id}/kyc/override`, admin.cookie)
        .send({ status: "approved", reason: "x" })
        .expect(409);
      expect(bodyOf<ErrorBody>(refused).error).toBe("bad_request");
      expect(await verifications().count({ where: { userId: fresh.user.id } })).toBe(0);
      expect((await userRow(fresh.user.id)).kycStatus).toBe("none");
      await post(`/users/${randomUUID()}/kyc/override`, admin.cookie)
        .send({ status: "approved", reason: "x" })
        .expect(404);

      // Rejections and expiries need no applicant and retire the standing approval.
      const expired = bodyOf<{ verification: ApiKycVerification }>(
        await post(`/users/${target.user.id}/kyc/override`, admin.cookie)
          .send({ status: "expired", reason: "renewal lapsed" })
          .expect(200),
      );
      expect(expired.verification.status).toBe("expired");
      expect((await verifications().findOneByOrFail({ id: verification.id })).status).toBe(
        "expired",
      );
      expect((await userRow(target.user.id)).kycStatus).toBe("none");
      expect(await ctx.get(KycService).withdrawalGate(target.user.id)).toEqual({
        allowed: false,
        reason: "kyc_required",
      });
    });

    it("override approved on a person bound to another account → 409 kyc_duplicate_identity from the binding; a person-key-only collision binds the documents and audits the skip", async () => {
      const a = await newUser("dup-a");
      expect((await mockKyc(a.cookie, "approved")).status).toBe("approved");

      // B presented A's passport: blocked; the operator cannot approve over a document collision.
      const b = await newUser("dup-b");
      expect((await mockKyc(b.cookie, "approved", OTHER_PERSON, [PASSPORT])).status).toBe(
        "blocked_duplicate",
      );
      const dup = await post(`/users/${b.user.id}/kyc/override`, admin.cookie)
        .send({ status: "approved", reason: "x" })
        .expect(409);
      expect(bodyOf<ErrorBody>(dup)).toMatchObject({
        error: "kyc_duplicate_identity",
        details: { fingerprints: [fp("IND|PASSPORT|Z1234567")] },
      });
      expect((await userRow(b.user.id)).kycStatus).toBe("blocked_duplicate");
      expect(await persons().count({ where: { userId: b.user.id } })).toBe(0);

      // C shares A's name, date of birth and country but holds a different passport: the person
      // key alone collided (§9.3 false positive). The operator's override binds C's document key,
      // skips the person key and records which fingerprint was skipped.
      const c = await newUser("dup-c");
      const otherPassport: KycMockDocumentDto = { ...PASSPORT, number: "X7654321" };
      expect((await mockKyc(c.cookie, "approved", PERSON, [otherPassport])).status).toBe(
        "blocked_duplicate",
      );
      const ok = await post(`/users/${c.user.id}/kyc/override`, admin.cookie)
        .send({ status: "approved", reason: "different person, checked both passports" })
        .expect(200);
      const approved = bodyOf<{ verification: ApiKycVerification }>(ok).verification;
      expect(approved.status).toBe("approved");
      expect(
        (await persons().find({ where: { userId: c.user.id } })).map((p) => [
          p.kind,
          p.fingerprint,
        ]),
      ).toEqual([["doc", fp("IND|PASSPORT|X7654321")]]);
      expect(
        (await persons().findOneByOrFail({ fingerprint: fp("IND|1990-01-01|DOE|JANE") })).userId,
      ).toBe(a.user.id);
      expect(await userRow(c.user.id)).toMatchObject({
        kycStatus: "approved",
        kycVerificationId: approved.id,
      });
      expect(await ctx.get(KycService).withdrawalGate(c.user.id)).toEqual({ allowed: true });
      const overrides = await auditRows("kyc.admin_override");
      expect(overrides.at(-1)?.metadata).toMatchObject({
        status: "approved",
        skippedPersonFingerprints: [fp("IND|1990-01-01|DOE|JANE")],
      });
      // The blocked attempt closed with the override.
      expect(
        (
          await verifications().find({ where: { userId: c.user.id }, order: { createdAt: "ASC" } })
        ).map((v) => v.status),
      ).toEqual(["expired", "approved"]);
    });

    it("duplicates and needs-review queues list verifications with their user id", async () => {
      const a = await issueSessionDirect(ctx, makeTestWallet("qa"), { withWalletRow: false });
      const b = await issueSessionDirect(ctx, makeTestWallet("qb"), { withWalletRow: false });
      const dup = await seedVerification(a.user.id, "blocked_duplicate", {
        rejectLabels: ["DUPLICATE"],
      });
      const review = await seedVerification(b.user.id, "needs_review");
      await seedVerification(b.user.id, "approved", { attemptNo: 2 });

      const duplicates = bodyOf<{ items: (ApiKycVerification & { userId: string })[] }>(
        await get("/kyc/duplicates", admin.cookie).expect(200),
      );
      expect(duplicates.items).toEqual([
        expect.objectContaining({
          id: dup.id,
          userId: a.user.id,
          status: "blocked_duplicate",
          rejectLabels: ["DUPLICATE"],
        }),
      ]);
      const needsReview = bodyOf<{ items: (ApiKycVerification & { userId: string })[] }>(
        await get("/kyc/needs-review", admin.cookie).expect(200),
      );
      expect(needsReview.items).toEqual([
        expect.objectContaining({ id: review.id, userId: b.user.id, status: "needs_review" }),
      ]);
    });

    it("person transfer moves every sibling fingerprint, approves the target's blocked attempt, expires ALL of the source's approvals (renewal included) and publishes both changes", async () => {
      const a = await newUser("pa");
      const first = await mockKyc(a.cookie, "approved");
      // A renews: attempt 2 approves and the bindings follow the standing approval.
      const renewal = await mockKyc(a.cookie, "approved");
      expect(renewal.status).toBe("approved");
      expect(renewal.verificationId).not.toBe(first.verificationId);
      const aRows = await persons().find({ where: { userId: a.user.id }, order: { kind: "ASC" } });
      expect(aRows.map((r) => r.kind)).toEqual(["doc", "person"]);
      expect(aRows.every((r) => r.verificationId === renewal.verificationId)).toBe(true);

      const b = await newUser("pb");
      const blocked = await mockKyc(b.cookie, "approved", OTHER_PERSON, [PASSPORT]);
      expect(blocked.status).toBe("blocked_duplicate");
      const docFp = fp("IND|PASSPORT|Z1234567");
      ctx.nats.reset();

      await post(`/kyc/persons/${docFp}/transfer`, admin.cookie)
        .send({ toUserId: b.user.id })
        .expect(400);
      await post(`/kyc/persons/${docFp}/transfer`, admin.cookie)
        .send({ toUserId: "not-a-uuid", reason: "x" })
        .expect(400);
      const ghost = await post(`/kyc/persons/${docFp}/transfer`, admin.cookie)
        .send({ toUserId: randomUUID(), reason: "x" })
        .expect(404);
      expect(bodyOf<ErrorBody>(ghost).error).toBe("not_found");
      await post(`/kyc/persons/${FP64}/transfer`, admin.cookie)
        .send({ toUserId: b.user.id, reason: "x" })
        .expect(404);
      const same = await post(`/kyc/persons/${docFp}/transfer`, admin.cookie)
        .send({ toUserId: a.user.id, reason: "x" })
        .expect(409);
      expect(bodyOf<ErrorBody>(same).error).toBe("bad_request");

      const res = await post(`/kyc/persons/${docFp}/transfer`, admin.cookie)
        .send({ toUserId: b.user.id, reason: "account merge ticket 42" })
        .expect(200);
      expect(res.body).toEqual({ ok: true });

      // Both keys (doc + person) moved to B and point at B's now-approved verification.
      const moved = await persons().find({ where: { userId: b.user.id }, order: { kind: "ASC" } });
      expect(moved.map((r) => [r.kind, r.verificationId])).toEqual([
        ["doc", blocked.verificationId],
        ["person", blocked.verificationId],
      ]);
      expect(await persons().count({ where: { userId: a.user.id } })).toBe(0);
      expect((await verifications().findOneByOrFail({ id: blocked.verificationId })).status).toBe(
        "approved",
      );
      expect(await userRow(b.user.id)).toMatchObject({
        kycStatus: "approved",
        kycVerificationId: blocked.verificationId,
      });
      expect(await ctx.get(KycService).withdrawalGate(b.user.id)).toEqual({ allowed: true });

      // Every approval of A expired — the renewal too — so A's status, lock and gate agree.
      const aVerifications = await verifications().find({
        where: { userId: a.user.id },
        order: { attemptNo: "ASC" },
      });
      expect(aVerifications.map((v) => v.status)).toEqual(["expired", "expired"]);
      expect(await userRow(a.user.id)).toMatchObject({
        kycStatus: "none",
        kycVerificationId: null,
      });
      expect(await ctx.get(KycService).lockedIdentityId(a.user.id)).toBeNull();
      expect(await ctx.get(KycService).withdrawalGate(a.user.id)).toEqual({
        allowed: false,
        reason: "kyc_required",
      });

      const detailB = bodyOf<AdminUserDetail>(
        await get(`/users/${b.user.id}`, admin.cookie).expect(200),
      );
      expect(detailB.persons.map((p) => p.fingerprint).sort()).toEqual(
        [docFp, fp("IND|1990-01-01|DOE|JANE")].sort(),
      );
      expect(
        bodyOf<AdminUserDetail>(await get(`/users/${a.user.id}`, admin.cookie).expect(200)).persons,
      ).toEqual([]);
      const [audit] = await auditRows("kyc.person_transferred");
      expect(audit).toMatchObject({
        actorType: "admin",
        actorUserId: admin.userId,
        subjectId: docFp,
        metadata: { fromUserId: a.user.id, toUserId: b.user.id, reason: "account merge ticket 42" },
      });
      expect((audit.metadata.fingerprints as string[]).sort()).toEqual(
        [docFp, fp("IND|1990-01-01|DOE|JANE")].sort(),
      );
      expect(ctx.nats.publishedOn("truthoracle.kyc.status_changed").map((e) => e.payload)).toEqual([
        expect.objectContaining({
          userId: b.user.id,
          status: "approved",
          userKycStatus: "approved",
        }),
        expect.objectContaining({ userId: a.user.id, status: "expired", userKycStatus: "none" }),
      ]);
    });
  });

  // ───────────────────────────────────────── payouts ───────────────────────────────────────────
  describe("payouts (real PayoutService)", () => {
    it("lists rows with the live ledger view, filters by status, and force-settles a blocked_kyc row: one cid-derived transfer, one MarkPaid, payout.admin_override with the overridden status", async () => {
      const payee = await newUser("payee");
      const queued = ctx.ledger.seedPendingPayout({
        user: payee.wallet.partyId,
        amountCC: "7",
        reason: "withdraw",
      });
      const blocked = ctx.ledger.seedPendingPayout({
        user: payee.wallet.partyId,
        amountCC: "3",
        reason: "withdraw",
      });
      const payouts = ctx.dataSource.getRepository(PayoutEntity);
      await payouts.save(
        payouts.create({
          pendingPayoutCid: queued.contractId,
          payeeParty: payee.wallet.partyId,
          userId: payee.user.id,
          payeeWalletId: null,
          status: "queued",
          amountCC: parseCC("7"),
          reason: "withdraw",
          attempts: 0,
          lastError: null,
          firstSeenAt: new Date(),
          settledAt: null,
        }),
      );
      // The gate is on and the payee is unverified: the user's own settle blocks the row.
      const userSettle = await http()
        .post(`/api/v1/in-app-wallet/payouts/${blocked.contractId}/settle`)
        .set("Cookie", payee.cookie)
        .set(ctx.csrf)
        .send({})
        .expect(409);
      expect(bodyOf<ErrorBody>(userSettle)).toMatchObject({
        error: "kyc_required",
        details: { status: "blocked_kyc" },
      });

      const all = bodyOf<{ items: ApiPayout[] }>(await get("/payouts", admin.cookie).expect(200));
      expect(all.items).toHaveLength(2);
      expect(all.items.find((p) => p.pendingPayoutCid === queued.contractId)).toMatchObject({
        status: "queued",
        onLedger: true,
        amountCC: "7.0000000000",
      });
      expect(all.items.find((p) => p.pendingPayoutCid === blocked.contractId)).toMatchObject({
        status: "blocked_kyc",
        onLedger: true,
        retryAfterKyc: true,
      });
      const filtered = bodyOf<{ items: ApiPayout[] }>(
        await get("/payouts?status=blocked_kyc", admin.cookie).expect(200),
      );
      expect(filtered.items.map((p) => p.pendingPayoutCid)).toEqual([blocked.contractId]);
      await get("/payouts?status=bogus", admin.cookie).expect(400);

      // Without force the operator gets the same gate verdict; force without a reason is a validation error.
      const refused = await post(`/payouts/${blocked.contractId}/settle`, admin.cookie)
        .send({ reason: "try" })
        .expect(409);
      expect(bodyOf<ErrorBody>(refused)).toMatchObject({
        error: "kyc_required",
        details: { status: "blocked_kyc" },
      });
      await post(`/payouts/${blocked.contractId}/settle`, admin.cookie)
        .send({ force: true })
        .expect(400);
      expect(ctx.wallet.transfers).toHaveLength(0);

      const { transferCommandId, markPaidCommandId } = commandIdsFor(blocked.contractId);
      const forced = await post(`/payouts/${blocked.contractId}/settle`, admin.cookie)
        .send({ force: true, reason: "KYC verified out of band" })
        .expect(200);
      expect(bodyOf<{ payout: ApiPayout; mode: string }>(forced)).toMatchObject({
        mode: "external",
        payout: {
          pendingPayoutCid: blocked.contractId,
          status: "settled_external",
          onLedger: false,
          attempts: 1,
        },
      });
      expect(ctx.wallet.transfers).toEqual([
        expect.objectContaining({
          to: payee.wallet.partyId,
          amountCC: parseCC("3"),
          commandId: transferCommandId,
        }),
      ]);
      expect(ctx.wallet.submits.map((x) => x.commandId)).toEqual([markPaidCommandId]);
      expect(ctx.ledger.payouts.has(blocked.contractId)).toBe(false);
      const [override] = await auditRows("payout.admin_override");
      expect(override).toMatchObject({
        actorType: "admin",
        actorUserId: admin.userId,
        subjectId: blocked.contractId,
        metadata: {
          overriddenStatus: "blocked_kyc",
          detail: "kyc_required",
          reason: "KYC verified out of band",
          payoutReason: "withdraw",
          userId: payee.user.id,
        },
      });
      expect(await auditRows("payout.settled")).toEqual([
        expect.objectContaining({
          actorType: "admin",
          actorUserId: admin.userId,
          subjectId: blocked.contractId,
          metadata: expect.objectContaining({ amountCC: "3.0000000000" }) as unknown,
        }),
      ]);

      // Only blocked_kyc / blocked_wallet_revoked are forceable: an unknown reason stays held.
      const mystery = ctx.ledger.seedPendingPayout({
        user: payee.wallet.partyId,
        amountCC: "1",
        reason: "mystery",
      });
      const held = await post(`/payouts/${mystery.contractId}/settle`, admin.cookie)
        .send({ force: true, reason: "no" })
        .expect(409);
      expect(bodyOf<ErrorBody>(held)).toMatchObject({
        error: "payout_blocked",
        details: { status: "blocked_unknown_reason" },
      });
      expect(ctx.wallet.transfers).toHaveLength(1);

      const missing = await post("/payouts/pp-nope/settle", admin.cookie)
        .send({ reason: "x" })
        .expect(404);
      expect(bodyOf<ErrorBody>(missing).error).toBe("payout_not_found");
    });
  });

  // ────────────────────────────────────────── audit ────────────────────────────────────────────
  describe("audit", () => {
    it("filters by subject and actor, paginates, and validates its query", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("audited"));
      await post(`/users/${target.user.id}/suspend`, admin.cookie)
        .send({ reason: "one" })
        .expect(200);
      await post(`/users/${target.user.id}/reinstate`, admin.cookie)
        .send({ reason: "two" })
        .expect(200);

      const bySubject = bodyOf<ApiPage<ApiAuditEvent>>(
        await get(`/audit?subjectType=user&subjectId=${target.user.id}`, admin.cookie).expect(200),
      );
      expect(bySubject.total).toBeGreaterThanOrEqual(2);
      expect(bySubject.items.map((e) => e.action)).toEqual(
        expect.arrayContaining(["user.suspended", "user.reinstated"]),
      );
      expect(
        bySubject.items.every((e) => e.subjectType === "user" && e.subjectId === target.user.id),
      ).toBe(true);
      // Newest first, with the operator's reason.
      expect(bySubject.items[0]).toMatchObject({
        action: "user.reinstated",
        actorType: "admin",
        actorUserId: admin.userId,
        metadata: { reason: "two" },
      });

      const byActor = bodyOf<ApiPage<ApiAuditEvent>>(
        await get(`/audit?actorUserId=${admin.userId}&limit=1`, admin.cookie).expect(200),
      );
      expect(byActor).toMatchObject({ page: 1, limit: 1 });
      expect(byActor.total).toBeGreaterThanOrEqual(2);
      expect(byActor.items).toHaveLength(1);
      const page2 = bodyOf<ApiPage<ApiAuditEvent>>(
        await get(`/audit?actorUserId=${admin.userId}&limit=1&page=2`, admin.cookie).expect(200),
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).not.toBe(byActor.items[0].id);

      await get("/audit?page=0", admin.cookie).expect(400);
      await get("/audit?actorUserId=me", admin.cookie).expect(400);
      await get("/audit?verbose=1", admin.cookie).expect(400);
    });
  });

  it("the operator's own login is an admin session whose removal from ADMIN_OPERATORS is enforced per request", async () => {
    // Belt and braces for the guard: the sign-in that produced `admin` is the real challenge flow.
    const login = bodyOf<ApiLoginResult>(
      await http().get("/api/v1/auth/session").set("Cookie", admin.cookie).expect(200),
    );
    expect(login).toMatchObject({ authenticated: true, kind: "admin" });
    expect(await auditRows("auth.admin_login")).toHaveLength(1);
  });
});
