import { Brackets, IsNull, type Repository } from "typeorm";

import type { AuthIdentityEntity } from "../entities/auth-identity.entity";
import type { KycPersonEntity } from "../entities/kyc-person.entity";
import type { KycVerificationEntity } from "../entities/kyc-verification.entity";
import type { PayoutEntity } from "../entities/payout.entity";
import type { SessionEntity } from "../entities/session.entity";
import type { UserEntity } from "../entities/user.entity";
import type { WalletEntity } from "../entities/wallet.entity";
import { ApiError } from "../util/errors";
import { type AdminActor, AdminService, escapeLike, verificationToApi } from "./admin.service";
import type { AuditService } from "./audit.service";
import type { IdentityService } from "./identity.service";
import type { KycService } from "./kyc.service";
import type { LedgerClientService } from "./ledger-client.service";
import type { PayoutService } from "./payout.service";
import type { SessionService } from "./session.service";
import type { UserService } from "./user.service";
import type { WalletLinkService } from "./wallet-link.service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const actor: AdminActor = { type: "admin", userId: "admin-user", sessionId: "admin-sess", ip: "10.0.0.1" };
const NOW = new Date("2026-09-10T10:00:00.000Z");

const user = { id: USER_ID, status: "active", kycStatus: "none", createdAt: NOW } as UserEntity;
const verification = {
  id: "v-1",
  userId: USER_ID,
  provider: "admin",
  levelName: "basic-kyc-level",
  attemptNo: 1,
  status: "approved",
  rejectLabels: null,
  moderationComment: null,
  reviewedAt: NOW,
  createdAt: NOW,
} as KycVerificationEntity;

/** A chainable QueryBuilder stub whose terminal call resolves `[rows, total]`. */
function queryBuilder(rows: UserEntity[], total: number) {
  const chain: Record<string, jest.Mock> = {};
  for (const m of ["where", "orWhere", "andWhere", "orderBy", "addOrderBy", "skip", "take"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return chain;
}

async function expectApiError(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await p.catch((e: ApiError) => expect(`${e.status} ${e.code}`).toBe(`${status} ${code}`));
}

interface Mocks {
  userRepo: { createQueryBuilder: jest.Mock };
  verifications: { find: jest.Mock };
  persons: { find: jest.Mock };
  users: { findById: jest.Mock; suspend: jest.Mock; reinstate: jest.Mock; toApi: jest.Mock };
  identities: { listForUser: jest.Mock; findById: jest.Mock; unlink: jest.Mock; reattach: jest.Mock; toApi: jest.Mock };
  sessions: { listForUser: jest.Mock; revokeAllForUser: jest.Mock; toApi: jest.Mock };
  walletLinks: { listForUser: jest.Mock; toApi: jest.Mock; ownLedgerWallets: jest.Mock };
  kyc: { summaryForUser: jest.Mock; lockedIdentityId: jest.Mock; adminOverride: jest.Mock; transferPerson: jest.Mock };
  payouts: { listForUser: jest.Mock; listAll: jest.Mock; settle: jest.Mock; toApi: jest.Mock };
  audit: { record: jest.Mock; list: jest.Mock; toApi: jest.Mock };
  ledger: { fetchUserWallet: jest.Mock; fetchPendingPayouts: jest.Mock; fetchPendingPayout: jest.Mock };
}

function build(): { service: AdminService; m: Mocks } {
  const m: Mocks = {
    userRepo: { createQueryBuilder: jest.fn() },
    verifications: { find: jest.fn().mockResolvedValue([]) },
    persons: { find: jest.fn().mockResolvedValue([]) },
    users: {
      findById: jest.fn().mockResolvedValue(user),
      suspend: jest.fn().mockResolvedValue(undefined),
      reinstate: jest.fn().mockResolvedValue(undefined),
      toApi: jest.fn((u: UserEntity) => ({ id: u.id, api: true })),
    },
    identities: {
      listForUser: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue(null),
      unlink: jest.fn().mockResolvedValue(undefined),
      reattach: jest.fn(),
      toApi: jest.fn((i: AuthIdentityEntity, locked?: string | null) => ({ id: i.id, kycLocked: locked === i.id })),
    },
    sessions: {
      listForUser: jest.fn().mockResolvedValue([]),
      revokeAllForUser: jest.fn().mockResolvedValue(2),
      toApi: jest.fn((s: SessionEntity, authMethod: string, current: string | null) => ({ id: s.id, authMethod, current: s.id === current })),
    },
    walletLinks: {
      listForUser: jest.fn().mockResolvedValue([]),
      toApi: jest.fn((w: WalletEntity, extras?: { ownLedgerWallet?: unknown }) => ({ id: w.id, ownLedgerWallet: extras?.ownLedgerWallet ?? null })),
      ownLedgerWallets: jest.fn().mockResolvedValue(new Map()),
    },
    kyc: {
      summaryForUser: jest.fn().mockResolvedValue({ status: "none", history: [] }),
      lockedIdentityId: jest.fn().mockResolvedValue(null),
      adminOverride: jest.fn().mockResolvedValue(verification),
      transferPerson: jest.fn().mockResolvedValue(undefined),
    },
    payouts: {
      listForUser: jest.fn().mockResolvedValue([]),
      listAll: jest.fn().mockResolvedValue([]),
      settle: jest.fn(),
      toApi: jest.fn((p: PayoutEntity, onLedger: boolean) => ({ pendingPayoutCid: p.pendingPayoutCid, onLedger })),
    },
    audit: {
      record: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      toApi: jest.fn((e: { id: string }) => ({ id: String(e.id) })),
    },
    ledger: {
      fetchUserWallet: jest.fn().mockResolvedValue(null),
      fetchPendingPayouts: jest.fn().mockResolvedValue([]),
      fetchPendingPayout: jest.fn().mockResolvedValue(null),
    },
  };
  const service = new AdminService(
    m.userRepo as unknown as Repository<UserEntity>,
    m.verifications as unknown as Repository<KycVerificationEntity>,
    m.persons as unknown as Repository<KycPersonEntity>,
    m.users as unknown as UserService,
    m.identities as unknown as IdentityService,
    m.sessions as unknown as SessionService,
    m.walletLinks as unknown as WalletLinkService,
    m.kyc as unknown as KycService,
    m.payouts as unknown as PayoutService,
    m.audit as unknown as AuditService,
    m.ledger as unknown as LedgerClientService,
  );
  return { service, m };
}

describe("AdminService", () => {
  describe("listUsers", () => {
    it("matches a UUID term on the id exactly and normalises paging", async () => {
      const { service, m } = build();
      const qb = queryBuilder([user], 1);
      m.userRepo.createQueryBuilder.mockReturnValue(qb);

      const page = await service.listUsers(USER_ID, 0, 1000);
      expect(qb.where).toHaveBeenCalledWith("u.id = :id", { id: USER_ID });
      expect(qb.orderBy).toHaveBeenCalledWith("u.createdAt", "DESC");
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(100);
      expect(page).toEqual({ items: [{ id: USER_ID, api: true }], page: 1, limit: 100, total: 1 });
    });

    it("searches name / email / party / identities / wallets with an escaped ILIKE term", async () => {
      const { service, m } = build();
      const qb = queryBuilder([], 0);
      m.userRepo.createQueryBuilder.mockReturnValue(qb);

      const page = await service.listUsers("  50%_off\\  ", 3, Number.NaN);
      expect(page).toEqual({ items: [], page: 3, limit: 25, total: 0 });
      expect(qb.skip).toHaveBeenCalledWith(50);
      const brackets = (qb.where.mock.calls as unknown[][])[0][0] as Brackets;
      expect(brackets).toBeInstanceOf(Brackets);

      const inner = queryBuilder([], 0);
      brackets.whereFactory(inner as never);
      expect(inner.where).toHaveBeenCalledWith("u.display_name ILIKE :like", { like: "%50\\%\\_off\\\\%" });
      const fragments = inner.orWhere.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(fragments).toEqual([
        "u.email ILIKE :like",
        "u.party_id ILIKE :like",
        expect.stringContaining("FROM to_auth_identities i WHERE i.user_id = u.id"),
        expect.stringContaining("FROM to_wallets w WHERE w.user_id = u.id"),
      ]);
    });

    it("lists everything when the term is blank", async () => {
      const { service, m } = build();
      const qb = queryBuilder([], 0);
      m.userRepo.createQueryBuilder.mockReturnValue(qb);
      await service.listUsers("   ", 1, 10);
      expect(qb.where).not.toHaveBeenCalled();
    });
  });

  describe("userDetail", () => {
    it("404s for an unknown user", async () => {
      const { service, m } = build();
      m.users.findById.mockResolvedValue(null);
      await expectApiError(service.userDetail(USER_ID), 404, "not_found");
    });

    it("composes identities, wallets (own ledger wallet for non-primary), kyc, sessions, payouts and active person bindings", async () => {
      const { service, m } = build();
      const google = { id: "i-google", provider: "google" } as AuthIdentityEntity;
      const wallet = { id: "i-wallet", provider: "canton_wallet" } as AuthIdentityEntity;
      m.identities.listForUser.mockResolvedValue([google, wallet]);
      m.kyc.lockedIdentityId.mockResolvedValue("i-google");
      const walletRows = [
        { id: "w-primary", partyId: "p::1", isPrimary: true } as WalletEntity,
        { id: "w-second", partyId: "p::2", isPrimary: false } as WalletEntity,
      ];
      m.walletLinks.listForUser.mockResolvedValue(walletRows);
      m.walletLinks.ownLedgerWallets.mockResolvedValue(new Map([["w-primary", null], ["w-second", { contractId: "uw-2", owner: "p::2" }]]));
      m.kyc.summaryForUser.mockResolvedValue({ status: "approved", history: [{ id: "v-1" }] });
      m.sessions.listForUser.mockResolvedValue([{ id: "s-1", authIdentityId: "i-wallet" } as SessionEntity]);
      m.payouts.listForUser.mockResolvedValue([
        { pendingPayoutCid: "pp-live" } as PayoutEntity,
        { pendingPayoutCid: "pp-gone" } as PayoutEntity,
      ]);
      m.ledger.fetchPendingPayouts.mockResolvedValue([{ contractId: "pp-live" }]);
      m.persons.find.mockResolvedValue([{ fingerprint: "fp-1", kind: "doc", boundAt: NOW } as KycPersonEntity]);

      const detail = await service.userDetail(USER_ID);

      expect(detail.user).toEqual({ id: USER_ID, api: true });
      expect(detail.identities).toEqual([
        { id: "i-google", kycLocked: true },
        { id: "i-wallet", kycLocked: false },
      ]);
      // One ledger read for every row (WalletLinkService.ownLedgerWallets), never one per wallet.
      expect(m.walletLinks.ownLedgerWallets).toHaveBeenCalledWith(walletRows, undefined);
      expect(m.ledger.fetchUserWallet).not.toHaveBeenCalled();
      expect(detail.wallets).toEqual([
        { id: "w-primary", ownLedgerWallet: null },
        { id: "w-second", ownLedgerWallet: { contractId: "uw-2", owner: "p::2" } },
      ]);
      expect(detail.kyc).toEqual({ status: "approved", history: [{ id: "v-1" }] });
      expect(detail.sessions).toEqual([{ id: "s-1", authMethod: "canton_wallet", current: false }]);
      expect(detail.payouts).toEqual([
        { pendingPayoutCid: "pp-live", onLedger: true },
        { pendingPayoutCid: "pp-gone", onLedger: false },
      ]);
      expect(detail.persons).toEqual([{ fingerprint: "fp-1", kind: "doc", boundAt: NOW.toISOString() }]);
      expect(m.persons.find).toHaveBeenCalledWith({ where: { userId: USER_ID, releasedAt: IsNull() }, order: { boundAt: "ASC" } });
    });

    it("skips the ledger payout read when the user has no payout rows", async () => {
      const { service, m } = build();
      await service.userDetail(USER_ID);
      expect(m.ledger.fetchPendingPayouts).not.toHaveBeenCalled();
    });

    it("resolves a session's sign-in method by lookup when the identity is not in the user's list", async () => {
      const { service, m } = build();
      m.sessions.listForUser.mockResolvedValue([{ id: "s-x", authIdentityId: "i-missing" } as SessionEntity]);
      m.identities.findById.mockResolvedValueOnce({ id: "i-missing", provider: "telegram" });
      const detail = await service.userDetail(USER_ID);
      expect(detail.sessions[0].authMethod).toBe("telegram");

      m.identities.findById.mockResolvedValueOnce(null);
      await expectApiError(service.userDetail(USER_ID), 500, "internal_error");
    });
  });

  describe("suspend / reinstate / revokeSessions", () => {
    it("delegates suspend and reinstate to UserService with the admin actor and reason", async () => {
      const { service, m } = build();
      await expect(service.suspend(USER_ID, "abuse", actor)).resolves.toEqual({ ok: true });
      expect(m.users.suspend).toHaveBeenCalledWith(USER_ID, "abuse", actor);
      await expect(service.reinstate(USER_ID, "resolved", actor)).resolves.toEqual({ ok: true });
      expect(m.users.reinstate).toHaveBeenCalledWith(USER_ID, "resolved", actor);
    });

    it("revokes every session and audits the reason and count as an admin", async () => {
      const { service, m } = build();
      await expect(service.revokeSessions(USER_ID, "lost laptop", actor)).resolves.toEqual({ ok: true });
      expect(m.sessions.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
      expect(m.audit.record).toHaveBeenCalledWith({
        actorType: "admin",
        actorUserId: "admin-user",
        actorSessionId: "admin-sess",
        action: "session.revoked_all",
        subjectType: "user",
        subjectId: USER_ID,
        metadata: { reason: "lost laptop", revoked: 2 },
        ip: "10.0.0.1",
      });
    });

    it("revokeSessions 404s for an unknown user before touching sessions", async () => {
      const { service, m } = build();
      m.users.findById.mockResolvedValue(null);
      await expectApiError(service.revokeSessions(USER_ID, "x", actor), 404, "not_found");
      expect(m.sessions.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe("identities", () => {
    const unlinked = { id: "i-tg", userId: USER_ID, provider: "telegram", status: "unlinked" } as AuthIdentityEntity;
    const active = { ...unlinked, status: "active" } as AuthIdentityEntity;

    it("unlink goes through IdentityService with the admin actor and records the reason", async () => {
      const { service, m } = build();
      m.identities.findById.mockResolvedValue(unlinked);
      m.kyc.lockedIdentityId.mockResolvedValue("i-tg");
      const out = await service.unlinkIdentity(USER_ID, "i-tg", "shared device", actor);
      expect(m.identities.unlink).toHaveBeenCalledWith(USER_ID, "i-tg", actor);
      expect(m.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: "admin",
          action: "identity.unlinked",
          subjectType: "identity",
          subjectId: "i-tg",
          metadata: { reason: "shared device", userId: USER_ID, provider: "telegram" },
        }),
      );
      expect(out).toEqual({ identity: { id: "i-tg", kycLocked: true } });
    });

    it("unlink surfaces IdentityService rules (last_identity) without auditing", async () => {
      const { service, m } = build();
      m.identities.unlink.mockRejectedValue(new ApiError(409, "last_identity", "keep one"));
      await expectApiError(service.unlinkIdentity(USER_ID, "i-tg", "x", actor), 409, "last_identity");
      expect(m.audit.record).not.toHaveBeenCalled();
    });

    it("reattach re-activates without a proof and records the reason; already-active is a no-op", async () => {
      const { service, m } = build();
      m.identities.findById.mockResolvedValue(unlinked);
      m.identities.reattach.mockResolvedValue(active);
      const out = await service.reattachIdentity(USER_ID, "i-tg", "owner verified by phone", actor);
      expect(m.identities.reattach).toHaveBeenCalledWith(USER_ID, "i-tg", null, actor);
      expect(m.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "identity.reattached",
          subjectId: "i-tg",
          metadata: { reason: "owner verified by phone", userId: USER_ID, provider: "telegram" },
        }),
      );
      expect(out).toEqual({ identity: { id: "i-tg", kycLocked: false } });

      m.identities.reattach.mockClear();
      m.audit.record.mockClear();
      m.identities.findById.mockResolvedValue(active);
      await service.reattachIdentity(USER_ID, "i-tg", "again", actor);
      expect(m.identities.reattach).not.toHaveBeenCalled();
      expect(m.audit.record).not.toHaveBeenCalled();
    });

    it("refuses an identity that belongs to another account (404)", async () => {
      const { service, m } = build();
      m.identities.findById.mockResolvedValue({ ...unlinked, userId: OTHER_ID });
      await expectApiError(service.reattachIdentity(USER_ID, "i-tg", "x", actor), 404, "not_found");
      expect(m.identities.reattach).not.toHaveBeenCalled();
    });
  });

  describe("KYC", () => {
    it("override delegates to KycService and maps the verification", async () => {
      const { service, m } = build();
      const out = await service.kycOverride(USER_ID, "approved", "manual check", actor);
      expect(m.kyc.adminOverride).toHaveBeenCalledWith(USER_ID, "approved", "manual check", actor);
      expect(out.verification).toEqual({
        id: "v-1",
        provider: "admin",
        levelName: "basic-kyc-level",
        attemptNo: 1,
        status: "approved",
        rejectLabels: [],
        moderationComment: null,
        reviewedAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
      });
    });

    it("override propagates the duplicate-person refusal", async () => {
      const { service, m } = build();
      m.kyc.adminOverride.mockRejectedValue(new ApiError(409, "kyc_duplicate_identity", "bound elsewhere"));
      await expectApiError(service.kycOverride(USER_ID, "approved", "x", actor), 409, "kyc_duplicate_identity");
    });

    it("queues list verifications by status, newest first, with the user id", async () => {
      const { service, m } = build();
      m.verifications.find.mockResolvedValue([{ ...verification, status: "blocked_duplicate", rejectLabels: ["DUPLICATE"] }]);
      const dup = await service.kycDuplicates();
      expect(m.verifications.find).toHaveBeenCalledWith({ where: { status: "blocked_duplicate" }, order: { updatedAt: "DESC", id: "ASC" }, take: 200 });
      expect(dup.items).toEqual([expect.objectContaining({ id: "v-1", userId: USER_ID, status: "blocked_duplicate", rejectLabels: ["DUPLICATE"] })]);
      await service.kycNeedsReview();
      expect(m.verifications.find).toHaveBeenLastCalledWith(expect.objectContaining({ where: { status: "needs_review" } }));
    });

    it("transfer requires an existing target user, then delegates", async () => {
      const { service, m } = build();
      await expect(service.transferPerson("fp-1", OTHER_ID, "merge", actor)).resolves.toEqual({ ok: true });
      expect(m.users.findById).toHaveBeenCalledWith(OTHER_ID);
      expect(m.kyc.transferPerson).toHaveBeenCalledWith("fp-1", OTHER_ID, "merge", actor);

      m.users.findById.mockResolvedValue(null);
      await expectApiError(service.transferPerson("fp-1", OTHER_ID, "merge", actor), 404, "not_found");
      expect(m.kyc.transferPerson).toHaveBeenCalledTimes(1);
    });
  });

  describe("payouts", () => {
    it("lists rows with the live ledger view and passes the status filter through", async () => {
      const { service, m } = build();
      m.payouts.listAll.mockResolvedValue([{ pendingPayoutCid: "pp-1" }, { pendingPayoutCid: "pp-2" }]);
      m.ledger.fetchPendingPayouts.mockResolvedValue([{ contractId: "pp-2" }]);
      const out = await service.listPayouts("blocked_kyc");
      expect(m.payouts.listAll).toHaveBeenCalledWith({ status: "blocked_kyc" });
      expect(out.items).toEqual([
        { pendingPayoutCid: "pp-1", onLedger: false },
        { pendingPayoutCid: "pp-2", onLedger: true },
      ]);

      m.payouts.listAll.mockResolvedValue([]);
      m.ledger.fetchPendingPayouts.mockClear();
      await service.listPayouts();
      expect(m.payouts.listAll).toHaveBeenLastCalledWith({});
      expect(m.ledger.fetchPendingPayouts).not.toHaveBeenCalled();
    });

    it("settles through PayoutService with an admin actor carrying force + reason and re-reads the ledger uncached", async () => {
      const { service, m } = build();
      m.payouts.settle.mockResolvedValue({ payout: { pendingPayoutCid: "pp-1" }, mode: "external" });
      const out = await service.settlePayout("pp-1", { force: true, reason: "manual KYC check done" }, actor);
      expect(m.payouts.settle).toHaveBeenCalledWith("pp-1", {
        type: "admin",
        userId: "admin-user",
        sessionId: "admin-sess",
        force: true,
        reason: "manual KYC check done",
        ip: "10.0.0.1",
      });
      expect(m.ledger.fetchPendingPayout).toHaveBeenCalledWith("pp-1", { uncached: true });
      expect(out).toEqual({ payout: { pendingPayoutCid: "pp-1", onLedger: false }, mode: "external" });
    });
  });

  describe("auditTrail", () => {
    it("normalises paging, drops blank filters and maps events", async () => {
      const { service, m } = build();
      m.audit.list.mockResolvedValue({ items: [{ id: "7" }], total: 1 });
      const out = await service.auditTrail({ subjectType: "user", subjectId: "", actorUserId: undefined, page: -1, limit: 0 });
      expect(m.audit.list).toHaveBeenCalledWith({ subjectType: "user", subjectId: undefined, actorUserId: undefined, page: 1, limit: 25 });
      expect(out).toEqual({ items: [{ id: "7" }], page: 1, limit: 25, total: 1 });
    });
  });

  it("verificationToApi never leaks anything but the documented fields", () => {
    const api = verificationToApi({ ...verification, manualReason: "secret note", providerApplicantId: "app-1" });
    expect(Object.keys(api).sort()).toEqual(["attemptNo", "createdAt", "id", "levelName", "moderationComment", "provider", "rejectLabels", "reviewedAt", "status"]);
  });

  it("escapeLike escapes LIKE metacharacters", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(escapeLike("plain")).toBe("plain");
  });
});
