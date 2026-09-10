/**
 * Operator API end to end (docs/API.md "Admin"; ARCHITECTURE §6.8, §11). A wallet-signed admin
 * session — party in ADMIN_OPERATORS, purpose `admin-sign-in` — reaches every route, a user
 * session is 403, every mutation needs a `reason` and lands in the audit trail with actorType
 * `admin`, and suspension kills the target's sessions on the spot.
 *
 * The P2 / P3 / P4 seams (WalletLinkService, PayoutService, KycService) are still 501 stubs in
 * this tree, so the spec binds small DB-backed fakes that honour the INTERNALS signatures. The
 * routes, guards, DTOs, AdminService composition, UserService / IdentityService / SessionService
 * / AuditService and Postgres + Redis under test are the real ones.
 */
import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";

import type { Config } from "../src/config";
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { KycPersonEntity } from "../src/entities/kyc-person.entity";
import { KycVerificationEntity } from "../src/entities/kyc-verification.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { SessionEntity } from "../src/entities/session.entity";
import { UserEntity } from "../src/entities/user.entity";
import { WalletEntity } from "../src/entities/wallet.entity";
import { type AdminUserDetail, verificationToApi } from "../src/services/admin.service";
import { AuditService } from "../src/services/audit.service";
import { IdentityService } from "../src/services/identity.service";
import { KycService } from "../src/services/kyc.service";
import { type PayoutActor, PayoutService } from "../src/services/payout.service";
import { SessionService } from "../src/services/session.service";
import { WalletLinkService } from "../src/services/wallet-link.service";
import type {
  Actor,
  ApiAuditEvent,
  ApiChallenge,
  ApiIdentity,
  ApiKycSummary,
  ApiKycVerification,
  ApiLoginResult,
  ApiPage,
  ApiPayout,
  ApiUser,
  ApiWallet,
  KycVerificationStatus,
  LedgerWallet,
  PayoutStatus,
} from "../src/types";
import { ApiError, type ErrorBody, errors } from "../src/util/errors";
import { formatCC, parseCC } from "../src/util/money";
import { toIso } from "../src/util/time";
import { TEST_ORIGIN, useTestApp } from "./helpers/app";
import { bodyOf, cookieFromResponse, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

// ─────────────────────────────────────── seam fakes (P2 / P3 / P4) ──────────────────────────────

/** KycService per INTERNALS: summary, admin override, person transfer and the lock lookup — DB-backed. */
class FakeKycService {
  ds!: DataSource;
  config!: Config;
  audit!: AuditService;
  /** userId → identity locked by a standing approval (§6.5). */
  readonly locks = new Map<string, string>();

  async lockedIdentityId(userId: string): Promise<string | null> {
    return this.locks.get(userId) ?? null;
  }

  async summaryForUser(userId: string): Promise<ApiKycSummary & { history: ApiKycVerification[] }> {
    const user = await this.ds.getRepository(UserEntity).findOneByOrFail({ id: userId });
    const history = await this.ds.getRepository(KycVerificationEntity).find({ where: { userId }, order: { createdAt: "DESC" } });
    const current = history.find((v) => v.id === user.kycVerificationId) ?? history[0] ?? null;
    return {
      provider: "mock",
      status: user.kycStatus,
      levelName: this.config.kycRequiredLevel,
      requiredForWithdrawal: this.config.kycEnforceWithdrawals,
      attachedIdentityId: current?.initiatedIdentityId ?? null,
      verification: current ? verificationToApi(current) : null,
      history: history.map(verificationToApi),
    };
  }

  async adminOverride(userId: string, status: KycVerificationStatus, reason: string, actor: Actor): Promise<KycVerificationEntity> {
    const users = this.ds.getRepository(UserEntity);
    const user = await users.findOneByOrFail({ id: userId });
    if (user.kycStatus === "blocked_duplicate") {
      throw new ApiError(409, "kyc_duplicate_identity", "this person is bound to another account");
    }
    const repo = this.ds.getRepository(KycVerificationEntity);
    const attemptNo = (await repo.count({ where: { userId, provider: "admin", levelName: this.config.kycRequiredLevel } })) + 1;
    const verification = await repo.save(
      repo.create({
        userId,
        provider: "admin",
        providerApplicantId: null,
        levelName: this.config.kycRequiredLevel,
        attemptNo,
        status,
        initiatedIdentityId: null,
        providerEventAt: null,
        rejectLabels: [],
        moderationComment: null,
        manual: true,
        manualReason: reason,
        reviewedAt: new Date(),
      }),
    );
    await users.update(
      { id: userId },
      { kycStatus: status === "approved" ? "approved" : status === "rejected_final" ? "rejected" : "none", kycVerificationId: verification.id },
    );
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "kyc.admin_override",
      subjectType: "user",
      subjectId: userId,
      metadata: { verificationId: verification.id, status, reason },
      ip: actor.ip ?? null,
    });
    return verification;
  }

  async transferPerson(fingerprint: string, toUserId: string, reason: string, actor: Actor): Promise<void> {
    const repo = this.ds.getRepository(KycPersonEntity);
    const row = await repo.findOne({ where: { fingerprint } });
    if (!row) throw errors.notFound("person binding not found");
    await repo.update({ fingerprint }, { userId: toUserId, boundAt: new Date(), releasedAt: null, releasedBy: actor.userId ?? null, releaseReason: reason });
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "kyc.person_transferred",
      subjectType: "kyc_person",
      subjectId: fingerprint,
      metadata: { fromUserId: row.userId, toUserId, reason },
      ip: actor.ip ?? null,
    });
  }

  async withdrawalGate(): Promise<never> {
    throw errors.notImplemented("FakeKycService.withdrawalGate");
  }

  async startSession(): Promise<never> {
    throw errors.notImplemented("FakeKycService.startSession");
  }

  async applyEvent(): Promise<never> {
    throw errors.notImplemented("FakeKycService.applyEvent");
  }
}

/** PayoutService per INTERNALS over the real `to_payouts` rows; `force` unblocks and audits. */
class FakePayoutService {
  ds!: DataSource;
  audit!: AuditService;

  async listForUser(userId: string): Promise<PayoutEntity[]> {
    return this.ds.getRepository(PayoutEntity).find({ where: { userId }, order: { firstSeenAt: "DESC" } });
  }

  async listAll(filter: { status?: PayoutStatus }): Promise<PayoutEntity[]> {
    return this.ds.getRepository(PayoutEntity).find({ where: filter.status ? { status: filter.status } : {}, order: { firstSeenAt: "DESC" } });
  }

  async settle(cid: string, actor: PayoutActor): Promise<{ payout: PayoutEntity; mode: "external" | "in_app" | "already_settled" }> {
    const repo = this.ds.getRepository(PayoutEntity);
    const payout = await repo.findOne({ where: { pendingPayoutCid: cid } });
    if (!payout) throw new ApiError(404, "payout_not_found", "payout not found");
    if (payout.status === "settled_external" || payout.status === "settled_in_app") return { payout, mode: "already_settled" };
    const blocked = payout.status === "blocked_kyc" || payout.status === "blocked_wallet_revoked";
    if (blocked && !actor.force) throw new ApiError(409, "payout_blocked", "payout is blocked", { status: payout.status });
    payout.status = "settled_external";
    payout.settledAt = new Date();
    payout.transferCommandId = `payout-${cid}`;
    await repo.save(payout);
    if (blocked) {
      await this.audit.record({
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        actorSessionId: actor.sessionId ?? null,
        action: "payout.admin_override",
        subjectType: "payout",
        subjectId: cid,
        metadata: { reason: actor.reason, force: true },
        ip: actor.ip ?? null,
      });
    }
    return { payout, mode: "external" };
  }

  toApi(p: PayoutEntity, onLedger: boolean): ApiPayout {
    return {
      pendingPayoutCid: p.pendingPayoutCid,
      payeeParty: p.payeeParty,
      walletId: p.payeeWalletId,
      amountCC: formatCC(p.amountCC),
      reason: p.reason,
      status: p.status,
      retryAfterKyc: p.status === "blocked_kyc",
      attempts: p.attempts,
      lastError: p.lastError,
      firstSeenAt: p.firstSeenAt.toISOString(),
      settledAt: toIso(p.settledAt),
      onLedger,
    };
  }

  async scan(): Promise<never> {
    throw errors.notImplemented("FakePayoutService.scan");
  }

  async requeueBlockedKyc(): Promise<never> {
    throw errors.notImplemented("FakePayoutService.requeueBlockedKyc");
  }
}

/** WalletLinkService per INTERNALS: list + wire mapping over the real `to_wallets` rows. */
class FakeWalletLinkService {
  ds!: DataSource;

  async listForUser(userId: string): Promise<WalletEntity[]> {
    return this.ds.getRepository(WalletEntity).find({ where: { userId }, order: { createdAt: "ASC" } });
  }

  toApi(w: WalletEntity, extras?: { ownLedgerWallet?: LedgerWallet | null }): ApiWallet {
    const own = extras?.ownLedgerWallet ?? null;
    return {
      id: w.id,
      chain: "canton",
      kind: w.kind,
      partyId: w.partyId,
      label: w.label,
      isPrimary: w.isPrimary,
      status: w.status,
      verifiedAt: w.verifiedAt.toISOString(),
      creditedCC: formatCC(w.creditedCC),
      legacyCreditedCC: formatCC(w.legacyCreditedCC),
      ownLedgerWallet: own
        ? { contractId: own.contractId, owner: own.owner, balanceCC: formatCC(own.balanceCC), depositedCC: formatCC(own.depositedCC), withdrawnCC: formatCC(own.withdrawnCC) }
        : null,
    };
  }

  async link(): Promise<never> {
    throw errors.notImplemented("FakeWalletLinkService.link");
  }

  async findByParty(): Promise<never> {
    throw errors.notImplemented("FakeWalletLinkService.findByParty");
  }

  async unlink(): Promise<never> {
    throw errors.notImplemented("FakeWalletLinkService.unlink");
  }

  async setPrimary(): Promise<never> {
    throw errors.notImplemented("FakeWalletLinkService.setPrimary");
  }
}

// ──────────────────────────────────────────── spec ───────────────────────────────────────────────

const operator = makeTestWallet("operator");
const fakeKyc = new FakeKycService();
const fakePayouts = new FakePayoutService();
const fakeWallets = new FakeWalletLinkService();

describe("Admin API (e2e)", () => {
  const ctx = useTestApp({
    env: { ADMIN_OPERATORS: operator.partyId },
    configure: (b) =>
      b
        .overrideProvider(KycService)
        .useValue(fakeKyc)
        .overrideProvider(PayoutService)
        .useValue(fakePayouts)
        .overrideProvider(WalletLinkService)
        .useValue(fakeWallets),
  });

  let admin: { cookie: string; userId: string };

  beforeAll(() => {
    const audit = ctx.get(AuditService);
    fakeKyc.ds = ctx.dataSource;
    fakeKyc.config = ctx.config;
    fakeKyc.audit = audit;
    fakePayouts.ds = ctx.dataSource;
    fakePayouts.audit = audit;
    fakeWallets.ds = ctx.dataSource;
  });

  beforeEach(async () => {
    fakeKyc.locks.clear();
    admin = await adminSignIn();
  });

  /**
   * The real flow: `POST /auth/wallet/challenge` (purpose admin-sign-in, party in ADMIN_OPERATORS)
   * → sign → `POST /auth/wallet`. While P1's login route is still the 501 stub the session is
   * issued directly through SessionService with `kind = admin` — the guards under test are the same.
   */
  async function adminSignIn(): Promise<{ cookie: string; userId: string }> {
    const headers = { Origin: TEST_ORIGIN, "Content-Type": "application/json" };
    const challenge = await ctx.agent.post("/api/v1/auth/wallet/challenge").set(headers).send({ partyId: operator.partyId, purpose: "admin-sign-in" }).expect(200);
    const { challengeId, message } = bodyOf<ApiChallenge>(challenge);
    expect(message).toContain("TruthOracle admin-sign-in");
    const login = await ctx.agent
      .post("/api/v1/auth/wallet")
      .set(headers)
      .send({ challengeId, partyId: operator.partyId, publicKey: operator.publicKeyBase64, signature: operator.sign(message), kind: "cantor8" });
    if (login.status === 200) {
      const result = bodyOf<ApiLoginResult>(login);
      expect(result.kind).toBe("admin");
      return { cookie: cookieFromResponse(login), userId: result.user.id };
    }
    if (login.status !== 501) throw new Error(`POST /auth/wallet → ${login.status} ${JSON.stringify(login.body)}`);
    const direct = await issueSessionDirect(ctx, operator, { kind: "admin" });
    return { cookie: direct.cookie, userId: direct.user.id };
  }

  const get = (path: string, cookie: string) => ctx.agent.get(`/api/v1/admin${path}`).set("Cookie", cookie);
  const post = (path: string, cookie: string) => ctx.agent.post(`/api/v1/admin${path}`).set("Cookie", cookie).set(ctx.csrf);
  const auditRows = (action: string) => ctx.dataSource.getRepository(AuditEventEntity).find({ where: { action }, order: { id: "ASC" } });

  async function seedVerification(userId: string, status: KycVerificationStatus, extra: Partial<KycVerificationEntity> = {}): Promise<KycVerificationEntity> {
    const repo = ctx.dataSource.getRepository(KycVerificationEntity);
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

  async function seedPayout(fields: Partial<PayoutEntity> & { pendingPayoutCid: string; payeeParty: string }): Promise<PayoutEntity> {
    const repo = ctx.dataSource.getRepository(PayoutEntity);
    return repo.save(
      repo.create({
        userId: null,
        payeeWalletId: null,
        amountCC: parseCC("5"),
        reason: "withdraw",
        status: "queued",
        attempts: 0,
        lastError: null,
        firstSeenAt: new Date(),
        settledAt: null,
        ...fields,
      }),
    );
  }

  // ───────────────────────────────────────── access ────────────────────────────────────────────
  describe("access", () => {
    it("anonymous → 401, a user session → 403 forbidden, the admin session → 200", async () => {
      const anon = await ctx.agent.get("/api/v1/admin/users").expect(401);
      expect(bodyOf<ErrorBody>(anon).error).toBe("unauthenticated");

      const plain = await issueSessionDirect(ctx, makeTestWallet("plain"));
      const denied = await get("/users", plain.cookie).expect(403);
      expect(bodyOf<ErrorBody>(denied)).toEqual({ error: "forbidden", message: "an admin session is required" });
      await post(`/users/${plain.user.id}/suspend`, plain.cookie).send({ reason: "self" }).expect(403);
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
      await ctx.agent.post(`/api/v1/admin/users/${target.user.id}/reinstate`).set("Authorization", direct.bearer).send({ reason: "noop" }).expect(200);
      const noOrigin = await ctx.agent.post(`/api/v1/admin/users/${target.user.id}/reinstate`).set("Cookie", admin.cookie).set("Content-Type", "application/json").send({ reason: "noop" }).expect(403);
      expect(bodyOf<ErrorBody>(noOrigin).error).toBe("csrf_rejected");
    });

    it.each([
      ["/users/:id/suspend"],
      ["/users/:id/reinstate"],
      ["/users/:id/sessions/revoke"],
      ["/users/:id/identities/:id/reattach"],
      ["/users/:id/identities/:id/unlink"],
      ["/users/:id/kyc/override"],
      ["/kyc/persons/fp/transfer"],
      ["/payouts/pp-1/settle"],
    ])("POST %s without a reason → 400 validation_failed", async (template) => {
      const path = template.replace(/:id/g, randomUUID());
      const res = await post(path, admin.cookie).send({}).expect(400);
      const body = bodyOf<ErrorBody>(res);
      expect(body.error).toBe("validation_failed");
      expect(body.details?.issues).toEqual(expect.arrayContaining([expect.stringMatching(/reason/)]));
    });

    it("rejects non-UUID user ids with 400 rather than a database error", async () => {
      const res = await get("/users/not-a-uuid", admin.cookie).expect(400);
      expect(bodyOf<ErrorBody>(res).error).toBe("validation_failed");
      await post("/users/not-a-uuid/suspend", admin.cookie).send({ reason: "x" }).expect(400);
    });
  });

  // ───────────────────────────────────────── users ─────────────────────────────────────────────
  describe("users", () => {
    it("searches by id, name, email, party and identity subject; paginates", async () => {
      const identities = ctx.get(IdentityService);
      const ada = await identities.resolveForLogin({ provider: "google", subject: "g-ada", email: "Ada@Example.com", profile: { name: "Ada Lovelace" } }, { currentUser: null });
      const bobWallet = makeTestWallet("bobwallet");
      const bob = await issueSessionDirect(ctx, bobWallet);
      await identities.resolveForLogin({ provider: "telegram", subject: "777001", profile: { username: "bobby" } }, { currentUser: bob.user });

      const search = async (q: string): Promise<ApiPage<ApiUser>> => bodyOf<ApiPage<ApiUser>>(await get(`/users?q=${encodeURIComponent(q)}`, admin.cookie).expect(200));

      const all = await search("");
      expect(all.total).toBe(3); // ada, bob and the operator's own account
      expect(all.items.map((u) => u.id)).toEqual(expect.arrayContaining([ada.user.id, bob.user.id, admin.userId]));

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

      const page2 = bodyOf<ApiPage<ApiUser>>(await get("/users?page=2&limit=1", admin.cookie).expect(200));
      expect(page2).toMatchObject({ page: 2, limit: 1, total: 3 });
      expect(page2.items).toHaveLength(1);
      await get("/users?limit=0", admin.cookie).expect(400);
      await get("/users?sort=email", admin.cookie).expect(400);
    });

    it("GET /admin/users/:id composes the whole account", async () => {
      const identities = ctx.get(IdentityService);
      const primary = makeTestWallet("detail");
      const target = await issueSessionDirect(ctx, primary);
      const google = await identities.resolveForLogin({ provider: "google", subject: "g-detail", email: "d@example.com", profile: { name: "Dee" } }, { currentUser: target.user });

      // A second, non-primary wallet that owns its own on-ledger UserWallet (§8.1).
      const secondary = makeTestWallet("second");
      await identities.resolveForLogin({ provider: "canton_wallet", subject: secondary.partyId }, { currentUser: target.user });
      const wallets = ctx.dataSource.getRepository(WalletEntity);
      await wallets.save(
        wallets.create({ userId: target.user.id, chain: "canton", kind: "cantor8", partyId: secondary.partyId, publicKey: secondary.publicKeyBase64, label: "cold", isPrimary: false, status: "active", legacyCreditedCC: parseCC("1.5"), creditedCC: 0n, verifiedAt: new Date(), revokedAt: null }),
      );
      ctx.ledger.seedUserWallet(secondary.partyId, { balanceCC: "3", depositedCC: "3" });

      const onLedger = ctx.ledger.seedPendingPayout({ user: primary.partyId, amountCC: "2", reason: "withdraw" });
      await seedPayout({ pendingPayoutCid: onLedger.contractId, payeeParty: primary.partyId, userId: target.user.id, status: "blocked_kyc", amountCC: parseCC("2") });

      const verification = await seedVerification(target.user.id, "approved", { initiatedIdentityId: google.identity.id, reviewedAt: new Date() });
      await ctx.dataSource.getRepository(UserEntity).update({ id: target.user.id }, { kycStatus: "approved", kycVerificationId: verification.id });
      const persons = ctx.dataSource.getRepository(KycPersonEntity);
      await persons.save(persons.create({ fingerprint: "doc-fp-1", kind: "doc", userId: target.user.id, verificationId: verification.id, fingerprintVersion: 1, boundAt: new Date(), releasedAt: null, releasedBy: null, releaseReason: null }));
      await persons.save(persons.create({ fingerprint: "doc-fp-old", kind: "doc", userId: target.user.id, verificationId: verification.id, fingerprintVersion: 1, boundAt: new Date(), releasedAt: new Date(), releasedBy: null, releaseReason: "moved" }));
      fakeKyc.locks.set(target.user.id, google.identity.id);

      const detail = bodyOf<AdminUserDetail>(await get(`/users/${target.user.id}`, admin.cookie).expect(200));

      expect(detail.user).toMatchObject({ id: target.user.id, status: "active", kycStatus: "approved", partyId: primary.partyId });
      expect(detail.identities.map((i) => [i.provider, i.status, i.kycLocked])).toEqual(
        expect.arrayContaining([
          ["canton_wallet", "active", false],
          ["google", "active", true],
          ["canton_wallet", "active", false],
        ]),
      );
      expect(detail.identities).toHaveLength(3);
      expect(detail.wallets).toHaveLength(2);
      const [w1, w2] = detail.wallets;
      expect(w1).toMatchObject({ partyId: primary.partyId, isPrimary: true, ownLedgerWallet: null });
      expect(w2).toMatchObject({ partyId: secondary.partyId, isPrimary: false, label: "cold", legacyCreditedCC: "1.5000000000" });
      expect(w2.ownLedgerWallet).toMatchObject({ owner: secondary.partyId, balanceCC: "3.0000000000" });
      expect(detail.kyc).toMatchObject({ provider: "mock", status: "approved", attachedIdentityId: google.identity.id });
      expect(detail.kyc.history).toHaveLength(1);
      expect(detail.sessions).toHaveLength(1);
      expect(detail.sessions[0]).toMatchObject({ id: target.session.id, kind: "user", authMethod: "canton_wallet", identityId: target.identity.id, current: false });
      expect(detail.payouts).toEqual([expect.objectContaining({ pendingPayoutCid: onLedger.contractId, status: "blocked_kyc", retryAfterKyc: true, onLedger: true, amountCC: "2.0000000000" })]);
      // Only live bindings are listed; a released one is history.
      expect(detail.persons).toEqual([{ fingerprint: "doc-fp-1", kind: "doc", boundAt: expect.any(String) as string }]);

      const missing = await get(`/users/${randomUUID()}`, admin.cookie).expect(404);
      expect(bodyOf<ErrorBody>(missing).error).toBe("not_found");
    });
  });

  // ─────────────────────────────────── suspend / reinstate / sessions ──────────────────────────
  describe("suspend / reinstate / sessions", () => {
    it("suspend revokes the target's live session immediately and is audited with the reason", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("target"));
      const alive = await ctx.agent.get("/api/v1/me").set("Cookie", target.cookie);
      expect(alive.status).not.toBe(401);

      await post(`/users/${target.user.id}/suspend`, admin.cookie).send({}).expect(400);
      const res = await post(`/users/${target.user.id}/suspend`, admin.cookie).send({ reason: "  chargeback abuse  " }).expect(200);
      expect(res.body).toEqual({ ok: true });

      // The session is revoked (not merely refused): the next request is 401.
      const dead = await ctx.agent.get("/api/v1/me").set("Cookie", target.cookie).expect(401);
      expect(bodyOf<ErrorBody>(dead).error).toBe("unauthenticated");
      expect(await ctx.get(SessionService).verify(target.token)).toBeNull();
      const row = await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: target.user.id });
      expect(row.status).toBe("suspended");

      const [suspended] = await auditRows("user.suspended");
      expect(suspended).toMatchObject({ actorType: "admin", actorUserId: admin.userId, subjectType: "user", subjectId: target.user.id, metadata: { reason: "chargeback abuse", sessionsRevoked: 1 } });
      expect(suspended.actorSessionId).not.toBeNull();

      // The user cannot sign in again until reinstated.
      await expect(ctx.get(IdentityService).resolveForLogin({ provider: "canton_wallet", subject: target.identity.subject }, { currentUser: null })).rejects.toMatchObject({ code: "user_suspended" });

      await post(`/users/${target.user.id}/reinstate`, admin.cookie).send({ reason: "dispute resolved" }).expect(200);
      expect((await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: target.user.id })).status).toBe("active");
      const [reinstated] = await auditRows("user.reinstated");
      expect(reinstated).toMatchObject({ actorType: "admin", actorUserId: admin.userId, metadata: { reason: "dispute resolved" } });
      const back = await issueSessionDirect(ctx, makeTestWallet("unused"), { withWalletRow: false });
      expect(back.user.status).toBe("active");

      await post(`/users/${randomUUID()}/suspend`, admin.cookie).send({ reason: "ghost" }).expect(404);
    });

    it("sessions/revoke kills every session of the user and audits the count", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("multi"));
      const sessions = ctx.get(SessionService);
      const second = await sessions.issue({ userId: target.user.id, authIdentityId: target.identity.id, kind: "user" });
      expect(await sessions.listForUser(target.user.id)).toHaveLength(2);

      await post(`/users/${target.user.id}/sessions/revoke`, admin.cookie).send({ reason: "credential leak" }).expect(200);
      expect(await sessions.verify(target.token)).toBeNull();
      expect(await sessions.verify(second.token)).toBeNull();
      expect(await sessions.listForUser(target.user.id)).toHaveLength(0);
      expect(await ctx.redis.smembers(`user_sessions:${target.user.id}`)).toEqual([]);
      const revoked = await ctx.dataSource.getRepository(SessionEntity).find({ where: { userId: target.user.id } });
      expect(revoked.every((s) => s.revokedAt !== null)).toBe(true);

      const [audit] = await auditRows("session.revoked_all");
      expect(audit).toMatchObject({ actorType: "admin", actorUserId: admin.userId, subjectType: "user", subjectId: target.user.id, metadata: { reason: "credential leak", revoked: 2 } });
      // The account itself is untouched.
      expect((await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: target.user.id })).status).toBe("active");
    });
  });

  // ─────────────────────────────────────── identities ──────────────────────────────────────────
  describe("identities", () => {
    it("admin unlink bypasses the KYC lock, kills the identity's sessions and records the reason; reattach restores it without a proof", async () => {
      const identities = ctx.get(IdentityService);
      const sessions = ctx.get(SessionService);
      const target = await issueSessionDirect(ctx, makeTestWallet("ident"));
      const tg = await identities.resolveForLogin({ provider: "telegram", subject: "4242" }, { currentUser: target.user });
      const tgSession = await sessions.issue({ userId: target.user.id, authIdentityId: tg.identity.id, kind: "user" });
      fakeKyc.locks.set(target.user.id, tg.identity.id);

      // The user could not (409 identity_locked_by_kyc — §6.5); an operator can.
      await expect(identities.unlink(target.user.id, tg.identity.id, { type: "user", userId: target.user.id })).rejects.toMatchObject({ code: "identity_locked_by_kyc" });
      const unlinked = await post(`/users/${target.user.id}/identities/${tg.identity.id}/unlink`, admin.cookie).send({ reason: "account takeover report" }).expect(200);
      expect(bodyOf<{ identity: ApiIdentity }>(unlinked).identity).toMatchObject({ id: tg.identity.id, provider: "telegram", status: "unlinked", kycLocked: true });
      expect(await sessions.verify(tgSession.token)).toBeNull();
      expect(await sessions.verify(target.token)).not.toBeNull();

      const unlinkAudits = await auditRows("identity.unlinked");
      expect(unlinkAudits).toHaveLength(2); // IdentityService's row + the operator's reason
      expect(unlinkAudits.every((a) => a.actorType === "admin" && a.actorUserId === admin.userId && a.subjectId === tg.identity.id)).toBe(true);
      expect(unlinkAudits.map((a) => a.metadata.reason)).toEqual(expect.arrayContaining(["account takeover report"]));

      // Signing in with the unlinked identity fails closed (§6.4) …
      await expect(identities.resolveForLogin({ provider: "telegram", subject: "4242" }, { currentUser: null })).rejects.toMatchObject({ code: "identity_unlinked" });
      // … until the operator re-attaches it.
      const reattached = await post(`/users/${target.user.id}/identities/${tg.identity.id}/reattach`, admin.cookie).send({ reason: "owner verified by call" }).expect(200);
      expect(bodyOf<{ identity: ApiIdentity }>(reattached).identity).toMatchObject({ id: tg.identity.id, status: "active" });
      const reattachAudits = await auditRows("identity.reattached");
      expect(reattachAudits).toHaveLength(2);
      expect(reattachAudits.map((a) => a.metadata.reason)).toEqual(expect.arrayContaining(["owner verified by call"]));
      expect((await identities.resolveForLogin({ provider: "telegram", subject: "4242" }, { currentUser: null })).user.id).toBe(target.user.id);

      // Idempotent: re-attaching an active identity changes and audits nothing.
      await post(`/users/${target.user.id}/identities/${tg.identity.id}/reattach`, admin.cookie).send({ reason: "again" }).expect(200);
      expect(await auditRows("identity.reattached")).toHaveLength(2);
    });

    it("keeps the IdentityService rules for operators too: primary wallet identity and unknown ids", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("rules"));
      const primary = await post(`/users/${target.user.id}/identities/${target.identity.id}/unlink`, admin.cookie).send({ reason: "x" }).expect(409);
      expect(bodyOf<ErrorBody>(primary).error).toBe("primary_wallet_in_use");

      const other = await issueSessionDirect(ctx, makeTestWallet("other"));
      const foreign = await post(`/users/${target.user.id}/identities/${other.identity.id}/unlink`, admin.cookie).send({ reason: "x" }).expect(404);
      expect(bodyOf<ErrorBody>(foreign).error).toBe("not_found");
      await post(`/users/${target.user.id}/identities/${randomUUID()}/reattach`, admin.cookie).send({ reason: "x" }).expect(404);
      expect(await auditRows("identity.unlinked")).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────── KYC ─────────────────────────────────────────────
  describe("kyc", () => {
    it("override creates a provider=admin verification, updates the user and is refused for a bound duplicate", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("kyc"));
      const res = await post(`/users/${target.user.id}/kyc/override`, admin.cookie).send({ status: "approved", reason: "documents checked by hand" }).expect(200);
      const { verification } = bodyOf<{ verification: ApiKycVerification }>(res);
      expect(verification).toMatchObject({ provider: "admin", status: "approved", attemptNo: 1, levelName: ctx.config.kycRequiredLevel, rejectLabels: [] });
      expect(Object.keys(verification)).not.toContain("manualReason");

      const user = await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: target.user.id });
      expect(user.kycStatus).toBe("approved");
      expect(user.kycVerificationId).toBe(verification.id);
      const detail = bodyOf<AdminUserDetail>(await get(`/users/${target.user.id}`, admin.cookie).expect(200));
      expect(detail.kyc.status).toBe("approved");
      expect(detail.kyc.history.map((v) => v.id)).toEqual([verification.id]);
      const [audit] = await auditRows("kyc.admin_override");
      expect(audit).toMatchObject({ actorType: "admin", actorUserId: admin.userId, subjectId: target.user.id, metadata: { status: "approved", reason: "documents checked by hand" } });

      const bad = await post(`/users/${target.user.id}/kyc/override`, admin.cookie).send({ status: "pending", reason: "x" }).expect(400);
      expect(bodyOf<ErrorBody>(bad).details?.issues).toEqual(expect.arrayContaining([expect.stringMatching(/status must be one of/)]));

      await ctx.dataSource.getRepository(UserEntity).update({ id: target.user.id }, { kycStatus: "blocked_duplicate" });
      const dup = await post(`/users/${target.user.id}/kyc/override`, admin.cookie).send({ status: "approved", reason: "x" }).expect(409);
      expect(bodyOf<ErrorBody>(dup).error).toBe("kyc_duplicate_identity");
      await post(`/users/${randomUUID()}/kyc/override`, admin.cookie).send({ status: "approved", reason: "x" }).expect(404);
    });

    it("duplicates and needs-review queues list verifications with their user id", async () => {
      const a = await issueSessionDirect(ctx, makeTestWallet("qa"), { withWalletRow: false });
      const b = await issueSessionDirect(ctx, makeTestWallet("qb"), { withWalletRow: false });
      const dup = await seedVerification(a.user.id, "blocked_duplicate", { rejectLabels: ["DUPLICATE"] });
      const review = await seedVerification(b.user.id, "needs_review");
      await seedVerification(b.user.id, "approved", { attemptNo: 2 });

      const duplicates = bodyOf<{ items: (ApiKycVerification & { userId: string })[] }>(await get("/kyc/duplicates", admin.cookie).expect(200));
      expect(duplicates.items).toEqual([expect.objectContaining({ id: dup.id, userId: a.user.id, status: "blocked_duplicate", rejectLabels: ["DUPLICATE"] })]);
      const needsReview = bodyOf<{ items: (ApiKycVerification & { userId: string })[] }>(await get("/kyc/needs-review", admin.cookie).expect(200));
      expect(needsReview.items).toEqual([expect.objectContaining({ id: review.id, userId: b.user.id, status: "needs_review" })]);
    });

    it("person transfer re-binds the fingerprint to another account and is audited", async () => {
      const a = await issueSessionDirect(ctx, makeTestWallet("pa"), { withWalletRow: false });
      const b = await issueSessionDirect(ctx, makeTestWallet("pb"), { withWalletRow: false });
      const verification = await seedVerification(a.user.id, "approved");
      const persons = ctx.dataSource.getRepository(KycPersonEntity);
      await persons.save(persons.create({ fingerprint: "person-fp-7", kind: "person", userId: a.user.id, verificationId: verification.id, fingerprintVersion: 1, boundAt: new Date(), releasedAt: null, releasedBy: null, releaseReason: null }));

      await post("/kyc/persons/person-fp-7/transfer", admin.cookie).send({ toUserId: b.user.id }).expect(400);
      await post("/kyc/persons/person-fp-7/transfer", admin.cookie).send({ toUserId: "not-a-uuid", reason: "x" }).expect(400);
      const ghost = await post("/kyc/persons/person-fp-7/transfer", admin.cookie).send({ toUserId: randomUUID(), reason: "x" }).expect(404);
      expect(bodyOf<ErrorBody>(ghost).error).toBe("not_found");
      await post("/kyc/persons/unknown-fp/transfer", admin.cookie).send({ toUserId: b.user.id, reason: "x" }).expect(404);

      const res = await post("/kyc/persons/person-fp-7/transfer", admin.cookie).send({ toUserId: b.user.id, reason: "account merge ticket 42" }).expect(200);
      expect(res.body).toEqual({ ok: true });
      expect((await persons.findOneByOrFail({ fingerprint: "person-fp-7" })).userId).toBe(b.user.id);
      const detailB = bodyOf<AdminUserDetail>(await get(`/users/${b.user.id}`, admin.cookie).expect(200));
      expect(detailB.persons.map((p) => p.fingerprint)).toEqual(["person-fp-7"]);
      const detailA = bodyOf<AdminUserDetail>(await get(`/users/${a.user.id}`, admin.cookie).expect(200));
      expect(detailA.persons).toEqual([]);
      const [audit] = await auditRows("kyc.person_transferred");
      expect(audit).toMatchObject({ actorType: "admin", actorUserId: admin.userId, subjectId: "person-fp-7", metadata: { fromUserId: a.user.id, toUserId: b.user.id, reason: "account merge ticket 42" } });
    });
  });

  // ───────────────────────────────────────── payouts ───────────────────────────────────────────
  describe("payouts", () => {
    it("lists rows with the live ledger view, filters by status, and force-settles blocked rows with a reason", async () => {
      const payee = makeTestWallet("payee");
      const target = await issueSessionDirect(ctx, payee);
      const live = ctx.ledger.seedPendingPayout({ user: payee.partyId, amountCC: "7", reason: "withdraw" });
      await seedPayout({ pendingPayoutCid: live.contractId, payeeParty: payee.partyId, userId: target.user.id, status: "queued", amountCC: parseCC("7") });
      await seedPayout({ pendingPayoutCid: "pp-blocked", payeeParty: payee.partyId, userId: target.user.id, status: "blocked_kyc", amountCC: parseCC("3") });

      const all = bodyOf<{ items: ApiPayout[] }>(await get("/payouts", admin.cookie).expect(200));
      expect(all.items).toHaveLength(2);
      expect(all.items.find((p) => p.pendingPayoutCid === live.contractId)).toMatchObject({ status: "queued", onLedger: true, amountCC: "7.0000000000" });
      expect(all.items.find((p) => p.pendingPayoutCid === "pp-blocked")).toMatchObject({ status: "blocked_kyc", onLedger: false, retryAfterKyc: true });

      const blocked = bodyOf<{ items: ApiPayout[] }>(await get("/payouts?status=blocked_kyc", admin.cookie).expect(200));
      expect(blocked.items.map((p) => p.pendingPayoutCid)).toEqual(["pp-blocked"]);
      await get("/payouts?status=bogus", admin.cookie).expect(400);

      const refused = await post("/payouts/pp-blocked/settle", admin.cookie).send({ reason: "try" }).expect(409);
      expect(bodyOf<ErrorBody>(refused)).toMatchObject({ error: "payout_blocked", details: { status: "blocked_kyc" } });
      await post("/payouts/pp-blocked/settle", admin.cookie).send({ force: true }).expect(400);

      const forced = await post("/payouts/pp-blocked/settle", admin.cookie).send({ force: true, reason: "KYC verified out of band" }).expect(200);
      expect(bodyOf<{ payout: ApiPayout; mode: string }>(forced)).toMatchObject({ mode: "external", payout: { pendingPayoutCid: "pp-blocked", status: "settled_external", onLedger: false } });
      const [override] = await auditRows("payout.admin_override");
      expect(override).toMatchObject({ actorType: "admin", actorUserId: admin.userId, subjectId: "pp-blocked", metadata: { reason: "KYC verified out of band", force: true } });

      const missing = await post("/payouts/pp-nope/settle", admin.cookie).send({ reason: "x" }).expect(404);
      expect(bodyOf<ErrorBody>(missing).error).toBe("payout_not_found");
    });
  });

  // ────────────────────────────────────────── audit ────────────────────────────────────────────
  describe("audit", () => {
    it("filters by subject and actor, paginates, and validates its query", async () => {
      const target = await issueSessionDirect(ctx, makeTestWallet("audited"));
      await post(`/users/${target.user.id}/suspend`, admin.cookie).send({ reason: "one" }).expect(200);
      await post(`/users/${target.user.id}/reinstate`, admin.cookie).send({ reason: "two" }).expect(200);

      const bySubject = bodyOf<ApiPage<ApiAuditEvent>>(await get(`/audit?subjectType=user&subjectId=${target.user.id}`, admin.cookie).expect(200));
      expect(bySubject.total).toBeGreaterThanOrEqual(2);
      expect(bySubject.items.map((e) => e.action)).toEqual(expect.arrayContaining(["user.suspended", "user.reinstated"]));
      expect(bySubject.items.every((e) => e.subjectType === "user" && e.subjectId === target.user.id)).toBe(true);
      // Newest first, with the operator's reason.
      expect(bySubject.items[0]).toMatchObject({ action: "user.reinstated", actorType: "admin", actorUserId: admin.userId, metadata: { reason: "two" } });

      const byActor = bodyOf<ApiPage<ApiAuditEvent>>(await get(`/audit?actorUserId=${admin.userId}&limit=1`, admin.cookie).expect(200));
      expect(byActor).toMatchObject({ page: 1, limit: 1 });
      expect(byActor.total).toBeGreaterThanOrEqual(2);
      expect(byActor.items).toHaveLength(1);
      const page2 = bodyOf<ApiPage<ApiAuditEvent>>(await get(`/audit?actorUserId=${admin.userId}&limit=1&page=2`, admin.cookie).expect(200));
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).not.toBe(byActor.items[0].id);

      await get("/audit?page=0", admin.cookie).expect(400);
      await get("/audit?actorUserId=me", admin.cookie).expect(400);
      await get("/audit?verbose=1", admin.cookie).expect(400);
    });
  });
});
