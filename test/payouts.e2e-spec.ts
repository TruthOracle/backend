/**
 * Payout settlement end to end (docs/API.md "In-app wallet" → payouts; ARCHITECTURE §9.4, §19).
 *
 * Real Postgres + Redis and the real PayoutsController / PayoutService / PayoutSettlementProcessor
 * / KycService; the ledger, the Enterprise Wallet and NATS are the in-memory fakes from
 * test/helpers: FakeLedgerClient holds the PendingPayouts and UserWallets, FakeEnterpriseWallet
 * applies the treasury-signed commands to it (MarkPaid / SettleToWallet / Create UserWallet) and
 * records every transfer and submit, FakeNatsService delivers `dispatch()`ed events to the
 * processor's durable consumer. Two apps boot in turn: the default config
 * (KYC_ENFORCE_WITHDRAWALS=false) and one with the gate on.
 *
 * Two seams of other packages may still be 501 stubs in this tree; the spec goes through HTTP
 * first and falls back to the service so every payout scenario stays meaningful:
 *   - sign-in: `POST /auth/wallet` (P1) → `issueSessionDirect`;
 *   - KYC approval: `POST /kyc/sessions` + `POST /kyc/mock/submit` (P4) → `KycService`.
 */
import type { Server } from "node:http";
import request from "supertest";

import type { KycMockSubmitDto } from "../src/dto/kyc.dto";
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import type { SessionEntity } from "../src/entities/session.entity";
import { UserEntity } from "../src/entities/user.entity";
import { WalletEntity } from "../src/entities/wallet.entity";
import { PayoutSettlementProcessor } from "../src/processors/payout-settlement.processor";
import { KycService } from "../src/services/kyc.service";
import {
  PayoutService,
  commandIdsFor,
  walletCreateCommandIdFor,
} from "../src/services/payout.service";
import { SessionService } from "../src/services/session.service";
import {
  type ApiPayout,
  type AuditAction,
  NatsSubjects,
  type PendingPayoutRecord,
} from "../src/types";
import { SESSION_COOKIE } from "../src/util/cookies";
import type { ErrorBody } from "../src/util/errors";
import { parseCC } from "../src/util/money";
import { type TestApp, useTestApp } from "./helpers/app";
import type { FakeEnterpriseWallet } from "./helpers/fakes";
import { bodyOf, issueSessionDirect, signInWithWallet } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

// ─────────────────────────────────────────── private helpers ─────────────────────────────────────

interface SettleBody {
  payout: ApiPayout;
  mode: "external" | "in_app" | "already_settled";
}

interface SignedIn {
  wallet: TestWallet;
  cookie: string;
  user: UserEntity;
  session: SessionEntity;
  /** The `to_wallets` row the sign-in seeded (primary). */
  walletRow: WalletEntity;
}

/**
 * The real challenge → sign → login flow on a throwaway agent (supertest's cookie jar would
 * otherwise attach this session to every later request and override the explicit `Cookie`
 * header the tests set for other users). Falls back to a directly issued session while P1's
 * login route is a 501 stub — the guards, wallet row and primary party are the same either way.
 */
async function signIn(ctx: TestApp, hint: string): Promise<SignedIn> {
  const wallet = makeTestWallet(hint);
  const agent = request.agent(ctx.app.getHttpServer() as Server);
  let cookie: string;
  try {
    ({ cookie } = await signInWithWallet(agent, wallet));
  } catch (err) {
    if (!/→ 501\b/.test((err as Error).message)) throw err;
    ({ cookie } = await issueSessionDirect(ctx, wallet));
  }
  const token = decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1));
  const verified = await ctx.get(SessionService).verify(token);
  if (!verified) throw new Error("the sign-in cookie does not verify");
  const walletRow = await ctx.dataSource
    .getRepository(WalletEntity)
    .findOneByOrFail({ partyId: wallet.partyId });
  return { wallet, cookie, user: verified.user, session: verified.session, walletRow };
}

interface Scenario {
  a: SignedIn;
  y: SignedIn;
  /** A party that never signed in — no `to_wallets` row anywhere. */
  unknownParty: string;
  /** A's on-ledger UserWallet contract id at seed time. */
  aWalletCid: string;
  withdraw: PendingPayoutRecord;
  bond: PendingPayoutRecord;
  prize: PendingPayoutRecord;
  other: PendingPayoutRecord;
  mystery: PendingPayoutRecord;
}

/** The setup every scenario in the brief starts from. */
async function seedScenario(ctx: TestApp): Promise<Scenario> {
  const a = await signIn(ctx, "alice");
  const y = await signIn(ctx, "yves");
  const unknownParty = makeTestWallet("stranger").partyId;
  const aWallet = ctx.ledger.seedUserWallet(a.wallet.partyId, {
    balanceCC: "10",
    depositedCC: "10",
  });
  return {
    a,
    y,
    unknownParty,
    aWalletCid: aWallet.contractId,
    withdraw: ctx.ledger.seedPendingPayout({
      user: a.wallet.partyId,
      amountCC: "3",
      reason: "withdraw",
    }),
    bond: ctx.ledger.seedPendingPayout({ user: a.wallet.partyId, amountCC: "1", reason: "bond" }),
    prize: ctx.ledger.seedPendingPayout({
      user: unknownParty,
      amountCC: "2",
      reason: "model-prize",
    }),
    other: ctx.ledger.seedPendingPayout({
      user: y.wallet.partyId,
      amountCC: "4",
      reason: "withdraw",
    }),
    mystery: ctx.ledger.seedPendingPayout({
      user: a.wallet.partyId,
      amountCC: "0.5",
      reason: "mystery",
    }),
  };
}

function settle(ctx: TestApp, cid: string, cookie: string): request.Test {
  return ctx.agent
    .post(`/api/v1/in-app-wallet/payouts/${cid}/settle`)
    .set("Cookie", cookie)
    .set(ctx.csrf)
    .set("x-requested-with", "truthoracle")
    .send({});
}

async function listPayouts(ctx: TestApp, cookie: string): Promise<ApiPayout[]> {
  const res = await ctx.agent
    .get("/api/v1/in-app-wallet/payouts")
    .set("Cookie", cookie)
    .expect(200);
  return bodyOf<{ payouts: ApiPayout[] }>(res).payouts;
}

function payoutRow(ctx: TestApp, cid: string): Promise<PayoutEntity> {
  return ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid });
}

function auditRows(ctx: TestApp, action: AuditAction): Promise<AuditEventEntity[]> {
  return ctx.dataSource
    .getRepository(AuditEventEntity)
    .find({ where: { action }, order: { id: "ASC" } });
}

/** Asymmetric matchers are typed `any`; this alias keeps them lint-clean as object property values (cf. `expect.any(String) as string`). */
function containing(subset: Record<string, unknown>): Record<string, unknown> {
  return expect.objectContaining(subset) as Record<string, unknown>;
}

/**
 * One processor pass. INTERNALS pins `PayoutService.scan()`; the processor wraps it in `tick()`
 * (scan lock + Sentry). Drives whichever the processor exposes so the spec survives a rename.
 */
async function runScan(ctx: TestApp): Promise<void> {
  const processor = ctx.get(PayoutSettlementProcessor) as unknown as {
    scan?: () => Promise<void>;
    tick?: () => Promise<void>;
  };
  if (typeof processor.scan === "function") return processor.scan();
  if (typeof processor.tick === "function") return processor.tick();
  return ctx.get(PayoutService).scan();
}

/**
 * A `transfer()` the wallet accepts (recorded, status `completed`) whose HTTP response is lost —
 * the crash window the write-ahead row exists for. Returns the restore function; `afterEach`
 * restores too.
 */
function loseTransferResponse(wallet: FakeEnterpriseWallet): () => void {
  const original = wallet.transfer.bind(wallet);
  wallet.transfer = async (args) => {
    await original(args);
    throw new Error("socket hang up");
  };
  return () => restoreTransfer(wallet);
}

function restoreTransfer(wallet: FakeEnterpriseWallet): void {
  // The override is an own property; deleting it uncovers the prototype method again.
  delete (wallet as Partial<FakeEnterpriseWallet>).transfer;
}

/**
 * Approve the user through the mock provider (docs/API.md "KYC"): `POST /kyc/sessions` then
 * `POST /kyc/mock/submit { outcome: approved, person, documents: [PASSPORT] }`. While P4's routes
 * are 501 stubs the same pipeline is driven through KycService (startSession → submitMock →
 * applyEvent → fingerprints → to_kyc_persons binding).
 */
async function approveKyc(ctx: TestApp, who: SignedIn): Promise<void> {
  const hint = who.wallet.partyId.split("::")[0];
  const dto: KycMockSubmitDto = {
    verificationId: "",
    outcome: "approved",
    person: {
      firstName: hint.toUpperCase(),
      lastName: "Lovelace",
      dob: "1985-12-10",
      country: "GBR",
    },
    documents: [{ docType: "PASSPORT", country: "GBR", number: `P-${hint}-001` }],
  };
  const headers = { ...ctx.csrf, "x-requested-with": "truthoracle", Cookie: who.cookie };
  const start = await ctx.agent.post("/api/v1/kyc/sessions").set(headers).send({});
  if (start.status === 200) {
    dto.verificationId = bodyOf<{ verificationId: string }>(start).verificationId;
    await ctx.agent.post("/api/v1/kyc/mock/submit").set(headers).send(dto).expect(200);
    return;
  }
  if (start.status !== 501)
    throw new Error(`POST /kyc/sessions → ${start.status} ${JSON.stringify(start.body)}`);
  const kyc = ctx.get(KycService);
  const started = await kyc.startSession(who.user, who.session);
  dto.verificationId = started.verificationId;
  await kyc.submitMock(who.user, dto);
}

/** Drive a fresh withdraw to `failed`: the first transfer never reaches the wallet, every retry is refused (never re-sent). */
async function driveToFailed(ctx: TestApp, cid: string, cookie: string): Promise<request.Response> {
  const max = ctx.config.payoutMaxAttempts;
  ctx.wallet.failNext = new Error("ECONNRESET");
  let last = await settle(ctx, cid, cookie);
  for (let i = 1; i < max; i += 1) {
    expect(last.status).toBe(502);
    last = await settle(ctx, cid, cookie);
  }
  return last;
}

// ────────────────────────────────────────────── spec ─────────────────────────────────────────────

describe("payouts (e2e)", () => {
  // ═══════════════════════════════════ KYC enforcement OFF (default) ═══════════════════════════
  describe("KYC enforcement off (default config)", () => {
    // A long scan interval keeps the processor's timer out of the way; the spec drives scans itself.
    const ctx = useTestApp({ env: { PAYOUT_SCAN_MS: "600000" } });

    afterEach(() => restoreTransfer(ctx.wallet));

    it("GET /in-app-wallet/payouts lists only the caller's payouts — on ledger, queued on first sight", async () => {
      const s = await seedScenario(ctx);
      expect(s.a.user.partyId).toBe(s.a.wallet.partyId);
      expect(s.a.walletRow.isPrimary).toBe(true);
      expect(ctx.config.kycEnforceWithdrawals).toBe(false);

      const mine = await listPayouts(ctx, s.a.cookie);
      expect(mine.map((p) => p.pendingPayoutCid).sort()).toEqual(
        [s.withdraw.contractId, s.bond.contractId, s.mystery.contractId].sort(),
      );
      for (const p of mine) {
        expect(p).toMatchObject({
          payeeParty: s.a.wallet.partyId,
          walletId: s.a.walletRow.id,
          status: "queued",
          onLedger: true,
          retryAfterKyc: false,
          attempts: 0,
          lastError: null,
          settledAt: null,
        });
        expect(Date.parse(p.firstSeenAt)).not.toBeNaN();
      }
      expect(mine.find((p) => p.pendingPayoutCid === s.withdraw.contractId)).toMatchObject({
        amountCC: "3.0000000000",
        reason: "withdraw",
      });
      expect(mine.find((p) => p.pendingPayoutCid === s.bond.contractId)).toMatchObject({
        amountCC: "1.0000000000",
        reason: "bond",
      });
      expect(mine.find((p) => p.pendingPayoutCid === s.mystery.contractId)).toMatchObject({
        amountCC: "0.5000000000",
        reason: "mystery",
      });
      // Listing is a read: nothing is written until a settlement is attempted.
      expect(await ctx.dataSource.getRepository(PayoutEntity).count()).toBe(0);

      const theirs = await listPayouts(ctx, s.y.cookie);
      expect(theirs.map((p) => p.pendingPayoutCid)).toEqual([s.other.contractId]);
      expect(theirs[0]).toMatchObject({
        amountCC: "4.0000000000",
        walletId: s.y.walletRow.id,
        status: "queued",
        onLedger: true,
      });

      const anon = await ctx.agent.get("/api/v1/in-app-wallet/payouts").expect(401);
      expect(bodyOf<ErrorBody>(anon).error).toBe("unauthenticated");
    });

    it("withdraw settles external exactly once: one transfer with the cid-derived id, one MarkPaid, then already_settled", async () => {
      const s = await seedScenario(ctx);
      const cid = s.withdraw.contractId;
      const { transferCommandId, markPaidCommandId } = commandIdsFor(cid);
      expect(transferCommandId).toMatch(/^payout-[0-9a-f]{40,64}$/);

      const res = await settle(ctx, cid, s.a.cookie).expect(200);
      const body = bodyOf<SettleBody>(res);
      expect(body.mode).toBe("external");
      expect(body.payout).toMatchObject({
        pendingPayoutCid: cid,
        payeeParty: s.a.wallet.partyId,
        walletId: s.a.walletRow.id,
        amountCC: "3.0000000000",
        reason: "withdraw",
        status: "settled_external",
        retryAfterKyc: false,
        attempts: 1,
        lastError: null,
        onLedger: false,
      });
      expect(body.payout.settledAt).not.toBeNull();

      // Exactly one treasury transfer, addressed by the ledger's payee and amount.
      expect(ctx.wallet.transfers).toHaveLength(1);
      expect(ctx.wallet.transfers[0]).toMatchObject({
        to: s.a.wallet.partyId,
        amountCC: parseCC("3"),
        commandId: transferCommandId,
      });
      // Exactly one submission: MarkPaid on the PendingPayout, referencing the transfer.
      expect(ctx.wallet.submits).toHaveLength(1);
      expect(ctx.wallet.submits[0].commandId).toBe(markPaidCommandId);
      expect(ctx.wallet.submits[0].commands).toEqual([
        expect.objectContaining({
          ExerciseCommand: containing({
            contractId: cid,
            choice: "MarkPaid",
            choiceArgument: { txHash: transferCommandId },
          }),
        }),
      ]);
      expect(ctx.ledger.payouts.has(cid)).toBe(false);
      expect(ctx.ledger.archived.has(cid)).toBe(true);

      const row = await payoutRow(ctx, cid);
      expect(row).toMatchObject({
        status: "settled_external",
        userId: s.a.user.id,
        payeeWalletId: s.a.walletRow.id,
        amountCC: parseCC("3"),
        transferCommandId,
        markPaidCommandId,
        walletCreateCommandId: null,
        settleCommandId: null,
        attempts: 1,
        lastError: null,
      });
      expect(row.settledAt).not.toBeNull();

      const seen = await auditRows(ctx, "payout.seen");
      expect(seen).toEqual([
        expect.objectContaining({
          actorType: "user",
          actorUserId: s.a.user.id,
          subjectType: "payout",
          subjectId: cid,
        }),
      ]);
      const settled = await auditRows(ctx, "payout.settled");
      expect(settled).toEqual([
        expect.objectContaining({
          actorType: "user",
          actorUserId: s.a.user.id,
          subjectId: cid,
          metadata: containing({ mode: "external" }),
        }),
      ]);
      expect(settled[0].actorSessionId).toBe(s.a.session.id);
      expect(ctx.nats.publishedOn(NatsSubjects.payoutSettled)).toEqual([
        expect.objectContaining({
          payload: containing({
            cid,
            userId: s.a.user.id,
            mode: "external",
            amountCC: "3.0000000000",
          }),
        }),
      ]);

      // Settling again pays nothing: the row is the arbiter.
      const again = bodyOf<SettleBody>(await settle(ctx, cid, s.a.cookie).expect(200));
      expect(again.mode).toBe("already_settled");
      expect(again.payout).toMatchObject({
        status: "settled_external",
        onLedger: false,
        attempts: 1,
      });
      expect(ctx.wallet.transfers).toHaveLength(1);
      expect(ctx.wallet.submits).toHaveLength(1);
      expect(await auditRows(ctx, "payout.settled")).toHaveLength(1);

      // The listing now shows it from the row only (no longer an active contract).
      const mine = await listPayouts(ctx, s.a.cookie);
      expect(mine.find((p) => p.pendingPayoutCid === cid)).toMatchObject({
        status: "settled_external",
        onLedger: false,
      });
      expect(
        mine
          .filter((p) => p.status === "queued")
          .map((p) => p.pendingPayoutCid)
          .sort(),
      ).toEqual([s.bond.contractId, s.mystery.contractId].sort());
    });

    it("bond settles into the in-app wallet: one SettleToWallet on the payee's UserWallet, no transfer", async () => {
      const s = await seedScenario(ctx);
      const cid = s.bond.contractId;
      const { settleCommandId } = commandIdsFor(cid);

      const body = bodyOf<SettleBody>(await settle(ctx, cid, s.a.cookie).expect(200));
      expect(body.mode).toBe("in_app");
      expect(body.payout).toMatchObject({
        pendingPayoutCid: cid,
        status: "settled_in_app",
        onLedger: false,
        attempts: 1,
        amountCC: "1.0000000000",
      });

      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(ctx.wallet.submits).toHaveLength(1);
      expect(ctx.wallet.submits[0].commandId).toBe(settleCommandId);
      expect(ctx.wallet.submits[0].commands).toEqual([
        expect.objectContaining({
          ExerciseCommand: containing({
            contractId: cid,
            choice: "SettleToWallet",
            choiceArgument: { walletCid: s.aWalletCid },
          }),
        }),
      ]);
      // The fake ledger applied it: 10 + 1 CC, PendingPayout consumed.
      const ledgerWallet = await ctx.ledger.fetchUserWallet(s.a.wallet.partyId);
      expect(ledgerWallet?.balanceCC).toBe(parseCC("11"));
      expect(ctx.ledger.payouts.has(cid)).toBe(false);

      expect(await payoutRow(ctx, cid)).toMatchObject({
        status: "settled_in_app",
        userId: s.a.user.id,
        settleCommandId,
        walletCreateCommandId: null,
        transferCommandId: null,
        markPaidCommandId: null,
        attempts: 1,
      });
      expect(ctx.nats.publishedOn(NatsSubjects.payoutSettled)).toEqual([
        expect.objectContaining({ payload: containing({ cid, mode: "in_app" }) }),
      ]);

      const again = bodyOf<SettleBody>(await settle(ctx, cid, s.a.cookie).expect(200));
      expect(again.mode).toBe("already_settled");
      expect(ctx.wallet.submits).toHaveLength(1);
    });

    it("a payee without a UserWallet gets one created first: wallet-create then SettleToWallet, one attempt", async () => {
      const b = await signIn(ctx, "bob");
      expect(await ctx.ledger.fetchUserWallet(b.wallet.partyId)).toBeNull();
      const bond = ctx.ledger.seedPendingPayout({
        user: b.wallet.partyId,
        amountCC: "1.5",
        reason: "bond",
      });
      const cid = bond.contractId;
      const walletCreateCommandId = walletCreateCommandIdFor(b.wallet.partyId);
      const { settleCommandId } = commandIdsFor(cid);

      const body = bodyOf<SettleBody>(await settle(ctx, cid, b.cookie).expect(200));
      expect(body.mode).toBe("in_app");
      expect(body.payout).toMatchObject({ status: "settled_in_app", onLedger: false, attempts: 1 });

      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(ctx.wallet.submits.map((x) => x.commandId)).toEqual([
        walletCreateCommandId,
        settleCommandId,
      ]);
      expect(ctx.wallet.submits[0].commands).toEqual([
        expect.objectContaining({
          CreateCommand: containing({
            templateId: expect.stringMatching(/:UserWallet$/) as string,
            createArguments: containing({
              owner: b.wallet.partyId,
              balanceCC: "0.0000000000",
              depositedCC: "0.0000000000",
              withdrawnCC: "0.0000000000",
            }),
          }),
        }),
      ]);
      const created = await ctx.ledger.fetchUserWallet(b.wallet.partyId);
      expect(created).not.toBeNull();
      expect(created?.balanceCC).toBe(parseCC("1.5"));
      expect(ctx.wallet.submits[1].commands).toEqual([
        expect.objectContaining({
          ExerciseCommand: containing({
            contractId: cid,
            choice: "SettleToWallet",
            choiceArgument: containing({ walletCid: expect.any(String) as string }),
          }),
        }),
      ]);

      expect(await payoutRow(ctx, cid)).toMatchObject({
        status: "settled_in_app",
        userId: b.user.id,
        walletCreateCommandId,
        settleCommandId,
        attempts: 1,
      });
    });

    it("an unknown reason is held for an operator: blocked_unknown_reason, 409 payout_blocked with details.status", async () => {
      const s = await seedScenario(ctx);
      const cid = s.mystery.contractId;

      const res = await settle(ctx, cid, s.a.cookie).expect(409);
      expect(bodyOf<ErrorBody>(res)).toMatchObject({
        error: "payout_blocked",
        details: { status: "blocked_unknown_reason" },
      });
      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(ctx.wallet.submits).toHaveLength(0);
      expect(ctx.ledger.payouts.has(cid)).toBe(true);

      expect(await payoutRow(ctx, cid)).toMatchObject({
        status: "blocked_unknown_reason",
        userId: s.a.user.id,
        reason: "mystery",
        attempts: 0,
      });
      const mine = await listPayouts(ctx, s.a.cookie);
      expect(mine.find((p) => p.pendingPayoutCid === cid)).toMatchObject({
        status: "blocked_unknown_reason",
        retryAfterKyc: false,
        onLedger: true,
      });

      expect(await auditRows(ctx, "payout.blocked")).toEqual([
        expect.objectContaining({
          actorType: "user",
          actorUserId: s.a.user.id,
          subjectId: cid,
          metadata: containing({ status: "blocked_unknown_reason" }),
        }),
      ]);
      expect(ctx.nats.publishedOn(NatsSubjects.payoutBlocked)).toEqual([
        expect.objectContaining({ payload: containing({ cid, status: "blocked_unknown_reason" }) }),
      ]);

      // A retry answers the same and does not re-audit an unchanged verdict.
      await settle(ctx, cid, s.a.cookie).expect(409);
      expect(await auditRows(ctx, "payout.blocked")).toHaveLength(1);
    });

    it("another user's payout, an unknown party's payout and an unknown cid are all 404 payout_not_found", async () => {
      const s = await seedScenario(ctx);

      for (const cid of [s.other.contractId, s.prize.contractId, "pp-9999"]) {
        const res = await settle(ctx, cid, s.a.cookie).expect(404);
        expect(bodyOf<ErrorBody>(res)).toEqual({
          error: "payout_not_found",
          message: expect.any(String) as string,
        });
      }
      // No row is created for a payout that is not the caller's — a miss never leaks the cid's existence.
      expect(await ctx.dataSource.getRepository(PayoutEntity).count()).toBe(0);
      expect(ctx.wallet.transfers).toHaveLength(0);
      // A malformed cid is refused by validation before any upstream read.
      const bad = await settle(ctx, "not a cid!", s.a.cookie).expect(400);
      expect(bodyOf<ErrorBody>(bad).error).toBe("validation_failed");

      // The rightful owner settles it.
      const ok = bodyOf<SettleBody>(await settle(ctx, s.other.contractId, s.y.cookie).expect(200));
      expect(ok.mode).toBe("external");
      expect(ctx.wallet.transfers).toEqual([
        expect.objectContaining({ to: s.y.wallet.partyId, amountCC: parseCC("4") }),
      ]);
    });

    it("write-ahead: a lost transfer response leaves `settling` + command id; an unreadable status stops; a confirmed one resumes at MarkPaid", async () => {
      const s = await seedScenario(ctx);
      const cid = s.withdraw.contractId;
      const { transferCommandId, markPaidCommandId } = commandIdsFor(cid);

      // (a) The wallet accepted the transfer but the response never arrived.
      const restore = loseTransferResponse(ctx.wallet);
      const lost = await settle(ctx, cid, s.a.cookie);
      restore();
      expect(lost.status).toBe(502);
      expect(bodyOf<ErrorBody>(lost)).toMatchObject({
        error: "upstream_failed",
        details: { status: "settling", attempts: 1 },
      });
      expect(ctx.wallet.transfers).toHaveLength(1);
      expect(ctx.wallet.statuses.get(transferCommandId)).toBe("completed");
      expect(ctx.wallet.submits).toHaveLength(0);
      expect(ctx.ledger.payouts.has(cid)).toBe(true);
      let row = await payoutRow(ctx, cid);
      expect(row).toMatchObject({
        status: "settling",
        transferCommandId,
        markPaidCommandId: null,
        attempts: 1,
      });
      expect(row.lastError).toMatch(/transfer/);
      expect(row.settledAt).toBeNull();
      expect(
        (await listPayouts(ctx, s.a.cookie)).find((p) => p.pendingPayoutCid === cid),
      ).toMatchObject({ status: "settling", onLedger: true, attempts: 1 });

      // (b) The wallet cannot say what happened to the recorded id: fail closed, no new transfer, no attempt charged.
      ctx.wallet.statusReadsFail = true;
      const paused = await settle(ctx, cid, s.a.cookie).expect(502);
      ctx.wallet.statusReadsFail = false;
      expect(bodyOf<ErrorBody>(paused)).toMatchObject({
        error: "upstream_failed",
        details: { status: "settling" },
      });
      expect(ctx.wallet.transfers).toHaveLength(1);
      expect(ctx.wallet.submits).toHaveLength(0);
      row = await payoutRow(ctx, cid);
      expect(row).toMatchObject({ status: "settling", transferCommandId, attempts: 1 });
      expect(row.lastError).toMatch(/could not be read|paused/);

      // (c) The wallet confirms the recorded transfer: resume at MarkPaid without paying again.
      const done = bodyOf<SettleBody>(await settle(ctx, cid, s.a.cookie).expect(200));
      expect(done.mode).toBe("external");
      expect(done.payout).toMatchObject({
        status: "settled_external",
        onLedger: false,
        attempts: 2,
        lastError: null,
      });
      expect(ctx.wallet.transfers).toHaveLength(1);
      expect(ctx.wallet.submits.map((x) => x.commandId)).toEqual([markPaidCommandId]);
      expect(ctx.ledger.payouts.has(cid)).toBe(false);
      expect(await payoutRow(ctx, cid)).toMatchObject({
        status: "settled_external",
        transferCommandId,
        markPaidCommandId,
        attempts: 2,
      });
      expect(await auditRows(ctx, "payout.settled")).toHaveLength(1);
    });

    it("a recorded transfer the wallet never saw is never re-sent, and the attempts cap parks the row as `failed`", async () => {
      const s = await seedScenario(ctx);
      const cid = s.withdraw.contractId;
      const { transferCommandId } = commandIdsFor(cid);
      const max = ctx.config.payoutMaxAttempts;
      expect(max).toBe(5);

      // The request died before the wallet recorded anything.
      ctx.wallet.failNext = new Error("ECONNRESET");
      const first = await settle(ctx, cid, s.a.cookie).expect(502);
      expect(bodyOf<ErrorBody>(first)).toMatchObject({
        error: "upstream_failed",
        details: { status: "settling", attempts: 1 },
      });
      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(await payoutRow(ctx, cid)).toMatchObject({
        status: "settling",
        transferCommandId,
        attempts: 1,
      });

      // The wallet reports the id as never submitted: still never re-sent (a lagging index is the double-pay case).
      const second = await settle(ctx, cid, s.a.cookie).expect(502);
      expect(bodyOf<ErrorBody>(second)).toMatchObject({
        error: "upstream_failed",
        details: { status: "settling", attempts: 2 },
      });
      expect(ctx.wallet.transfers).toHaveLength(0);
      let row = await payoutRow(ctx, cid);
      expect(row).toMatchObject({ status: "settling", transferCommandId, attempts: 2 });
      expect(row.lastError).toMatch(/transfer/);

      let last = second;
      while (row.attempts < max) {
        last = await settle(ctx, cid, s.a.cookie);
        expect(last.status).toBe(502);
        row = await payoutRow(ctx, cid);
      }
      expect(bodyOf<ErrorBody>(last)).toMatchObject({
        error: "upstream_failed",
        details: { status: "failed", attempts: max },
      });
      expect(row).toMatchObject({
        status: "failed",
        transferCommandId,
        attempts: max,
        settledAt: null,
      });
      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(ctx.wallet.submits).toHaveLength(0);
      // Nothing left the platform, so the PendingPayout is still owed on the ledger.
      expect(ctx.ledger.payouts.has(cid)).toBe(true);

      expect(await auditRows(ctx, "payout.failed")).toEqual([
        expect.objectContaining({ subjectId: cid, metadata: containing({ attempts: max }) }),
      ]);
      expect(ctx.nats.publishedOn(NatsSubjects.payoutFailed)).toEqual([
        expect.objectContaining({ payload: containing({ cid, status: "failed" }) }),
      ]);
      expect(
        (await listPayouts(ctx, s.a.cookie)).find((p) => p.pendingPayoutCid === cid),
      ).toMatchObject({ status: "failed", attempts: max, onLedger: true, retryAfterKyc: false });
    });

    // ARCHITECTURE §9.4: "attempts capped at PAYOUT_MAX_ATTEMPTS (5) → failed (admin queue)"; API.md:
    // `409 payout_blocked (details.status)`. Once failed, the row belongs to the operator queue:
    // a user retry must be refused (before any recorded-command shortcut, so `attempts` never
    // climbs past the cap) and the scan must not touch it (RETRIABLE excludes `failed`).
    it(
      "a failed row belongs to the operator queue: the user's retry is 409 payout_blocked and the scan leaves it alone",
      async () => {
        const s = await seedScenario(ctx);
        const cid = s.withdraw.contractId;
        const { transferCommandId } = commandIdsFor(cid);
        const max = ctx.config.payoutMaxAttempts;
        await driveToFailed(ctx, cid, s.a.cookie);
        expect(await payoutRow(ctx, cid)).toMatchObject({ status: "failed", attempts: max });

        const refused = await settle(ctx, cid, s.a.cookie).expect(409);
        expect(bodyOf<ErrorBody>(refused)).toMatchObject({
          error: "payout_blocked",
          details: { status: "failed" },
        });
        expect(await payoutRow(ctx, cid)).toMatchObject({ status: "failed", attempts: max });

        // The scan settles the other open payouts of the scenario but never picks this row up again.
        await runScan(ctx);
        expect(await payoutRow(ctx, cid)).toMatchObject({ status: "failed", attempts: max });
        expect(ctx.wallet.transfers.find((t) => t.commandId === transferCommandId)).toBeUndefined();
        expect(ctx.ledger.payouts.has(cid)).toBe(true);
        expect(await auditRows(ctx, "payout.failed")).toHaveLength(1);
      },
    );

    it("archived contracts: settled_external when the recorded transfer went through, archived when nothing was submitted", async () => {
      const s = await seedScenario(ctx);
      const { transferCommandId: withdrawTransferId, markPaidCommandId: withdrawMarkPaidId } =
        commandIdsFor(s.withdraw.contractId);

      // (a) Transfer accepted, response lost, then the contract vanished (another instance's MarkPaid consumed it).
      const restore = loseTransferResponse(ctx.wallet);
      await settle(ctx, s.withdraw.contractId, s.a.cookie).expect(502);
      restore();
      expect(await payoutRow(ctx, s.withdraw.contractId)).toMatchObject({
        status: "settling",
        transferCommandId: withdrawTransferId,
      });
      ctx.ledger.archivePayout(s.withdraw.contractId);

      // (b) A blocked row whose contract the user cancelled on-ledger (CancelPayout).
      await settle(ctx, s.mystery.contractId, s.a.cookie).expect(409);
      ctx.ledger.archivePayout(s.mystery.contractId);

      // (c) Write-ahead recorded, the wallet never received the command, the user cancelled meanwhile.
      ctx.wallet.failNext = new Error("ECONNRESET");
      await settle(ctx, s.other.contractId, s.y.cookie).expect(502);
      expect(await payoutRow(ctx, s.other.contractId)).toMatchObject({
        status: "settling",
        transferCommandId: commandIdsFor(s.other.contractId).transferCommandId,
      });
      ctx.ledger.archivePayout(s.other.contractId);

      expect(ctx.wallet.transfers).toHaveLength(1);
      await runScan(ctx);

      const settled = await payoutRow(ctx, s.withdraw.contractId);
      expect(settled).toMatchObject({
        status: "settled_external",
        transferCommandId: withdrawTransferId,
        lastError: null,
      });
      expect(settled.settledAt).not.toBeNull();
      expect(await payoutRow(ctx, s.mystery.contractId)).toMatchObject({
        status: "archived",
        transferCommandId: null,
        settleCommandId: null,
        settledAt: null,
      });
      expect(await payoutRow(ctx, s.other.contractId)).toMatchObject({
        status: "archived",
        settledAt: null,
      });

      // Nothing was paid or submitted for the vanished contracts.
      expect(ctx.wallet.transfers).toHaveLength(1);
      const archivedCids = new Set([
        s.withdraw.contractId,
        s.mystery.contractId,
        s.other.contractId,
      ]);
      const touched = ctx.wallet.submits.filter(
        (x) =>
          x.commandId === withdrawMarkPaidId ||
          JSON.stringify(x.commands)
            .split('"')
            .some((t) => archivedCids.has(t)),
      );
      expect(touched).toHaveLength(0);

      const settledAudit = await auditRows(ctx, "payout.settled");
      expect(settledAudit.find((e) => e.subjectId === s.withdraw.contractId)).toMatchObject({
        actorType: "system",
        actorUserId: null,
        metadata: containing({ mode: "external" }),
      });

      const mine = await listPayouts(ctx, s.a.cookie);
      expect(mine.find((p) => p.pendingPayoutCid === s.withdraw.contractId)).toMatchObject({
        status: "settled_external",
        onLedger: false,
      });
      expect(mine.find((p) => p.pendingPayoutCid === s.mystery.contractId)).toMatchObject({
        status: "archived",
        onLedger: false,
      });
      expect(
        (await listPayouts(ctx, s.y.cookie)).find((p) => p.pendingPayoutCid === s.other.contractId),
      ).toMatchObject({ status: "archived", onLedger: false });
    });

    it("the processor scan settles bond / model-prize in-app (creating wallets as needed) and open-gate withdrawals; unknown reasons are held", async () => {
      const s = await seedScenario(ctx);
      await runScan(ctx);

      expect(await payoutRow(ctx, s.bond.contractId)).toMatchObject({
        status: "settled_in_app",
        userId: s.a.user.id,
        settleCommandId: commandIdsFor(s.bond.contractId).settleCommandId,
        walletCreateCommandId: null,
      });
      // model-prize to a party nobody linked: the in-app path needs no account — a treasury-created wallet holds it.
      expect(await payoutRow(ctx, s.prize.contractId)).toMatchObject({
        status: "settled_in_app",
        userId: null,
        payeeWalletId: null,
        walletCreateCommandId: walletCreateCommandIdFor(s.unknownParty),
        settleCommandId: commandIdsFor(s.prize.contractId).settleCommandId,
      });
      expect(await payoutRow(ctx, s.withdraw.contractId)).toMatchObject({
        status: "settled_external",
        transferCommandId: commandIdsFor(s.withdraw.contractId).transferCommandId,
      });
      expect(await payoutRow(ctx, s.other.contractId)).toMatchObject({
        status: "settled_external",
        userId: s.y.user.id,
      });
      expect(await payoutRow(ctx, s.mystery.contractId)).toMatchObject({
        status: "blocked_unknown_reason",
        attempts: 0,
      });

      expect(ctx.wallet.transfers.map((t) => [t.to, t.amountCC]).sort()).toEqual(
        [
          [s.a.wallet.partyId, parseCC("3")],
          [s.y.wallet.partyId, parseCC("4")],
        ].sort(),
      );
      expect((await ctx.ledger.fetchUserWallet(s.a.wallet.partyId))?.balanceCC).toBe(parseCC("11"));
      expect((await ctx.ledger.fetchUserWallet(s.unknownParty))?.balanceCC).toBe(parseCC("2"));
      expect([...ctx.ledger.payouts.keys()]).toEqual([s.mystery.contractId]);

      const settled = await auditRows(ctx, "payout.settled");
      expect(settled).toHaveLength(4);
      expect(settled.every((e) => e.actorType === "system" && e.actorUserId === null)).toBe(true);

      // A second pass finds nothing to do.
      const submits = ctx.wallet.submits.length;
      await runScan(ctx);
      expect(ctx.wallet.submits).toHaveLength(submits);
      expect(ctx.wallet.transfers).toHaveLength(2);
      expect(await auditRows(ctx, "payout.settled")).toHaveLength(4);
      expect(await payoutRow(ctx, s.mystery.contractId)).toMatchObject({
        status: "blocked_unknown_reason",
        attempts: 0,
      });
    });

    it("a withdrawal addressed to a revoked payee wallet is blocked_wallet_revoked; in-app payouts to it still settle", async () => {
      const a = await signIn(ctx, "revoker");
      // A second wallet the user linked and later unlinked (§8.1: the row stays, revoked).
      const cold = makeTestWallet("cold");
      const wallets = ctx.dataSource.getRepository(WalletEntity);
      const coldRow = await wallets.save(
        wallets.create({
          userId: a.user.id,
          chain: "canton",
          kind: "cantor8",
          partyId: cold.partyId,
          publicKey: cold.publicKeyBase64,
          label: "cold",
          isPrimary: false,
          status: "revoked",
          legacyCreditedCC: 0n,
          creditedCC: 0n,
          verifiedAt: new Date(),
          revokedAt: new Date(),
        }),
      );
      const withdraw = ctx.ledger.seedPendingPayout({
        user: cold.partyId,
        amountCC: "2",
        reason: "withdraw",
      });
      const bond = ctx.ledger.seedPendingPayout({
        user: cold.partyId,
        amountCC: "1",
        reason: "bond",
      });

      const res = await settle(ctx, withdraw.contractId, a.cookie).expect(409);
      expect(bodyOf<ErrorBody>(res)).toMatchObject({
        error: "payout_blocked",
        details: { status: "blocked_wallet_revoked" },
      });
      expect(await payoutRow(ctx, withdraw.contractId)).toMatchObject({
        status: "blocked_wallet_revoked",
        userId: a.user.id,
        payeeWalletId: coldRow.id,
        attempts: 0,
      });
      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(
        (await listPayouts(ctx, a.cookie)).find((p) => p.pendingPayoutCid === withdraw.contractId),
      ).toMatchObject({
        status: "blocked_wallet_revoked",
        walletId: coldRow.id,
        retryAfterKyc: false,
        onLedger: true,
      });
      expect(ctx.nats.publishedOn(NatsSubjects.payoutBlocked)).toEqual([
        expect.objectContaining({
          payload: containing({ cid: withdraw.contractId, status: "blocked_wallet_revoked" }),
        }),
      ]);

      // External only: the in-app policy does not consult the wallet row.
      const inApp = bodyOf<SettleBody>(await settle(ctx, bond.contractId, a.cookie).expect(200));
      expect(inApp.mode).toBe("in_app");
      expect((await ctx.ledger.fetchUserWallet(cold.partyId))?.balanceCC).toBe(parseCC("1"));

      // The scan does not override a blocked verdict either.
      await runScan(ctx);
      expect(await payoutRow(ctx, withdraw.contractId)).toMatchObject({
        status: "blocked_wallet_revoked",
        attempts: 0,
      });
      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(ctx.ledger.payouts.has(withdraw.contractId)).toBe(true);
    });
  });

  // ═══════════════════════════════════ KYC enforcement ON ══════════════════════════════════════
  describe("KYC enforcement on (KYC_ENFORCE_WITHDRAWALS=true)", () => {
    const ctx = useTestApp({
      env: {
        KYC_ENFORCE_WITHDRAWALS: "true",
        LEGACY_WALLET_ENDPOINTS_RETIRED: "true",
        PAYOUT_SCAN_MS: "600000",
      },
    });

    afterEach(() => restoreTransfer(ctx.wallet));

    it("withdraw → 409 kyc_required / blocked_kyc / retryAfterKyc; a mock approval + kyc.status_changed re-queues and settles it external", async () => {
      expect(ctx.config.kycEnforceWithdrawals).toBe(true);
      const a = await signIn(ctx, "kycalice");
      const withdraw = ctx.ledger.seedPendingPayout({
        user: a.wallet.partyId,
        amountCC: "3",
        reason: "withdraw",
      });
      const cid = withdraw.contractId;
      const { transferCommandId, markPaidCommandId } = commandIdsFor(cid);

      const blocked = await settle(ctx, cid, a.cookie).expect(409);
      expect(bodyOf<ErrorBody>(blocked)).toMatchObject({
        error: "kyc_required",
        details: { status: "blocked_kyc" },
      });
      expect(await payoutRow(ctx, cid)).toMatchObject({
        status: "blocked_kyc",
        userId: a.user.id,
        payeeWalletId: a.walletRow.id,
        attempts: 0,
        transferCommandId: null,
      });
      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(ctx.ledger.payouts.has(cid)).toBe(true);
      expect(await listPayouts(ctx, a.cookie)).toEqual([
        expect.objectContaining({
          pendingPayoutCid: cid,
          status: "blocked_kyc",
          retryAfterKyc: true,
          onLedger: true,
          attempts: 0,
        }),
      ]);
      expect(await auditRows(ctx, "payout.blocked")).toEqual([
        expect.objectContaining({
          subjectId: cid,
          metadata: containing({ status: "blocked_kyc" }),
        }),
      ]);
      expect(ctx.nats.publishedOn(NatsSubjects.payoutBlocked)).toHaveLength(1);

      // Still unverified: same answer, nothing re-audited.
      await settle(ctx, cid, a.cookie).expect(409);
      expect(await auditRows(ctx, "payout.blocked")).toHaveLength(1);

      await approveKyc(ctx, a);
      expect(
        (await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: a.user.id }))
          .kycStatus,
      ).toBe("approved");
      const approvals = ctx.nats
        .publishedOn(NatsSubjects.kycStatusChanged)
        .filter((e) => (e.payload as { status?: string }).status === "approved");
      expect(approvals.length).toBeGreaterThan(0);
      expect(approvals[0].payload).toMatchObject({ userId: a.user.id });

      // The processor's durable consumer receives the approval → the user's blocked_kyc rows are re-queued and settled.
      const outcomes = await ctx.nats.dispatch(NatsSubjects.kycStatusChanged, {
        userId: a.user.id,
        status: "approved",
      });
      expect(outcomes).toContain("ack");
      expect(outcomes).not.toContain("nak");
      expect(outcomes).not.toContain("term");

      const row = await payoutRow(ctx, cid);
      expect(row).toMatchObject({
        status: "settled_external",
        transferCommandId,
        markPaidCommandId,
        attempts: 1,
        lastError: null,
      });
      expect(row.settledAt).not.toBeNull();
      expect(ctx.wallet.transfers).toEqual([
        expect.objectContaining({
          to: a.wallet.partyId,
          amountCC: parseCC("3"),
          commandId: transferCommandId,
        }),
      ]);
      expect(ctx.wallet.submits.map((x) => x.commandId)).toEqual([markPaidCommandId]);
      expect(ctx.ledger.payouts.has(cid)).toBe(false);
      expect(await auditRows(ctx, "payout.requeued")).toEqual([
        expect.objectContaining({
          actorType: "system",
          subjectId: cid,
          metadata: containing({ from: "blocked_kyc" }),
        }),
      ]);
      expect(await auditRows(ctx, "payout.settled")).toEqual([
        expect.objectContaining({ actorType: "system", subjectId: cid }),
      ]);
      expect(await listPayouts(ctx, a.cookie)).toEqual([
        expect.objectContaining({
          pendingPayoutCid: cid,
          status: "settled_external",
          retryAfterKyc: false,
          onLedger: false,
        }),
      ]);

      // A repeat of the event has nothing left to re-queue and stays harmless.
      expect(
        await ctx.nats.dispatch(NatsSubjects.kycStatusChanged, {
          userId: a.user.id,
          status: "approved",
        }),
      ).toContain("ack");
      expect(ctx.wallet.transfers).toHaveLength(1);
    });

    it("the in-app path is not gated: bond settles for an unverified user (wallet created first)", async () => {
      const b = await signIn(ctx, "kycbob");
      const bond = ctx.ledger.seedPendingPayout({
        user: b.wallet.partyId,
        amountCC: "1",
        reason: "bond",
      });

      const body = bodyOf<SettleBody>(await settle(ctx, bond.contractId, b.cookie).expect(200));
      expect(body.mode).toBe("in_app");
      expect(body.payout).toMatchObject({ status: "settled_in_app", onLedger: false });
      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(ctx.wallet.submits.map((x) => x.commandId)).toEqual([
        walletCreateCommandIdFor(b.wallet.partyId),
        commandIdsFor(bond.contractId).settleCommandId,
      ]);
      expect((await ctx.ledger.fetchUserWallet(b.wallet.partyId))?.balanceCC).toBe(parseCC("1"));
    });

    it("the scan blocks withdrawals on the payee's gate and settles bonds; after approval the payee's own retry settles, others stay blocked", async () => {
      const a = await signIn(ctx, "kyccarol");
      const y = await signIn(ctx, "kycdave");
      const aWithdraw = ctx.ledger.seedPendingPayout({
        user: a.wallet.partyId,
        amountCC: "2",
        reason: "withdraw",
      });
      const yWithdraw = ctx.ledger.seedPendingPayout({
        user: y.wallet.partyId,
        amountCC: "5",
        reason: "withdraw",
      });
      const aBond = ctx.ledger.seedPendingPayout({
        user: a.wallet.partyId,
        amountCC: "1",
        reason: "bond",
      });

      await runScan(ctx);
      expect(await payoutRow(ctx, aWithdraw.contractId)).toMatchObject({
        status: "blocked_kyc",
        userId: a.user.id,
        attempts: 0,
      });
      expect(await payoutRow(ctx, yWithdraw.contractId)).toMatchObject({
        status: "blocked_kyc",
        userId: y.user.id,
        attempts: 0,
      });
      expect(await payoutRow(ctx, aBond.contractId)).toMatchObject({ status: "settled_in_app" });
      expect(ctx.wallet.transfers).toHaveLength(0);
      expect(await listPayouts(ctx, a.cookie)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pendingPayoutCid: aWithdraw.contractId,
            status: "blocked_kyc",
            retryAfterKyc: true,
            onLedger: true,
          }),
          expect.objectContaining({
            pendingPayoutCid: aBond.contractId,
            status: "settled_in_app",
            onLedger: false,
          }),
        ]),
      );

      await approveKyc(ctx, a);

      // The gate is re-evaluated on the payee's account at the user's retry.
      const ok = bodyOf<SettleBody>(await settle(ctx, aWithdraw.contractId, a.cookie).expect(200));
      expect(ok.mode).toBe("external");
      expect(ok.payout).toMatchObject({
        status: "settled_external",
        onLedger: false,
        retryAfterKyc: false,
      });
      expect(ctx.wallet.transfers).toEqual([
        expect.objectContaining({ to: a.wallet.partyId, amountCC: parseCC("2") }),
      ]);

      const still = await settle(ctx, yWithdraw.contractId, y.cookie).expect(409);
      expect(bodyOf<ErrorBody>(still)).toMatchObject({
        error: "kyc_required",
        details: { status: "blocked_kyc" },
      });

      await runScan(ctx);
      expect(await payoutRow(ctx, yWithdraw.contractId)).toMatchObject({
        status: "blocked_kyc",
        attempts: 0,
      });
      expect(ctx.wallet.transfers).toHaveLength(1);
      expect(ctx.ledger.payouts.has(yWithdraw.contractId)).toBe(true);
    });
  });
});
