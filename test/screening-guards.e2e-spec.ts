/**
 * What a freeze stops outside the ramp's own steps (SPEC §11.6; S7b; B3, X6): the on-ramp credit
 * of a mint that landed before the freeze, deposit reconciliation (a book transfer into the in-app
 * wallet), in-app payout settlement, reward grants, the admin mint-and-credit — each waits and goes
 * on after the four-eyes lift — and TM-FROZEN-ACTIVITY for every indexed transaction a frozen
 * party acted in after the freeze (user-signed trades bypass the backend).
 */
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { RewardGrantEntity } from "../src/entities/reward-grant.entity";
import { ComplianceScreeningProcessor } from "../src/processors/compliance-screening.processor";
import { IndexerService } from "../src/services/indexer.service";
import { PayoutService } from "../src/services/payout.service";
import { RampCompliancePort } from "../src/services/ramp-compliance.port";
import { RewardsService } from "../src/services/rewards.service";
import { TokenAppSyncService } from "../src/services/token-app-sync.service";
import type { ApiApproval, ApiComplianceFreeze } from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { parseAmount } from "../src/util/money";
import { TEST_COLLATERAL, TEST_REWARDS, TEST_TREASURY, useTestApp } from "./helpers/app";
import { LedgerFixture } from "./helpers/ledger-fixtures";
import { dec, rampKit } from "./helpers/ramp";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const anna = makeTestWallet("anna"); // aml + ops
const bob = makeTestWallet("bob"); // approver

const ctx = useTestApp({
  env: {
    ADMIN_OPERATORS: [`${anna.partyId}#anna@aml+ops`, `${bob.partyId}#bob@approver`].join(","),
    RAMP_DUAL_CONTROL: "true",
    RAMP_APPROVAL_SIGNATURES: "false",
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
  },
});
const k = rampKit(ctx, anna);

let raise: jest.SpyInstance<
  Promise<string | null>,
  [rule: string, userId: string, figures: Record<string, unknown>]
>;
beforeEach(() => {
  k.mock().reset();
  raise = jest.spyOn(ctx.get(RampCompliancePort), "raise");
});
afterEach(() => {
  raise.mockRestore();
});

async function headers(w: TestWallet): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, w, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

async function freeze(userId: string): Promise<ApiComplianceFreeze> {
  return bodyOf<{ freeze: ApiComplianceFreeze }>(
    await ctx.agent
      .post("/api/v1/admin/compliance/freezes")
      .set(await headers(anna))
      .send({ userId, reason: "AML decision 2026-10-19", source: "aml" })
      .expect(200),
  ).freeze;
}

/** The four-eyes lift: anna requests, bob approves. */
async function lift(freezeId: string): Promise<void> {
  const { approval } = bodyOf<{ approval: ApiApproval }>(
    await ctx.agent
      .post(`/api/v1/admin/compliance/freezes/${freezeId}/lift`)
      .set(await headers(anna))
      .send({ reason: "released" })
      .expect(202),
  );
  await ctx.agent
    .post(`/api/v1/admin/approvals/${approval.id}/approve`)
    .set(await headers(bob))
    .send({ reason: "ok" })
    .expect(200);
}

describe("value movements a freeze holds outside the ramp's own steps", () => {
  it("an on-ramp whose mint landed before the freeze is not credited until the lift", async () => {
    const b = await k.buyer("credit");
    const res = await k.openOnramp(b, "30");
    await k.pay(b, res);
    // One loop round: the mint is posted; the token sync records it (minting → crediting).
    await k.fulfilment().scan();
    await ctx.get(TokenAppSyncService).syncOnce("test");
    expect((await k.order(res.order.id)).status).toBe("crediting");
    const placed = await freeze(b.user.id);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "crediting",
      creditCommandId: null,
      details: { hold: { reason: "frozen" } },
    });
    expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)?.balance ?? 0n).toBe(0n);
    expect(await k.commands(res.order.id)).toMatchObject([{ kind: "mint", status: "recorded" }]);
    await lift(placed.id);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "completed",
      details: { hold: null },
    });
    expect(ctx.ledger.walletOf(b.wallet.partyId, TEST_COLLATERAL)?.balance).toBe(parseAmount("30"));
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.captured:provider_clearing": dec("30"),
      "onramp.minted:customer_liability": dec("-30"),
    });
    await k.expectIdentities();
  });

  it("deposit reconciliation is refused neutrally while frozen and credits after the lift", async () => {
    const alice = makeTestWallet("alice");
    const { user, cookie } = await issueSessionDirect(ctx, alice);
    const f = new LedgerFixture(TEST_TREASURY);
    ctx.stream.push(f.spliceTransferIn(alice.partyId, "7"));
    await ctx.get(IndexerService).runOnce();
    const placed = await freeze(user.id);
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/in-app-wallet/deposits/reconcile")
        .set({ Cookie: cookie, ...ctx.csrf })
        .send({})
        .expect(403),
    );
    expect(refused).toMatchObject({
      error: "forbidden",
      message: "this operation is not available for this account",
    });
    expect(ctx.ledger.walletOf(alice.partyId, TEST_COLLATERAL)?.balance ?? 0n).toBe(0n);
    await lift(placed.id);
    await ctx.agent
      .post("/api/v1/in-app-wallet/deposits/reconcile")
      .set({ Cookie: cookie, ...ctx.csrf })
      .send({})
      .expect(200);
    expect(ctx.ledger.walletOf(alice.partyId, TEST_COLLATERAL)?.balance).toBe(parseAmount("7"));
  });

  it("an in-app payout (bond) waits blocked_compliance while the payee is frozen, then settles in-app", async () => {
    const alice = makeTestWallet("alice");
    const { user, cookie } = await issueSessionDirect(ctx, alice);
    const bond = ctx.ledger.seedPendingPayout({ user: alice.partyId, amount: "2", reason: "bond" });
    const placed = await freeze(user.id);
    const blocked = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/in-app-wallet/payouts/${bond.contractId}/settle`)
        .set({ Cookie: cookie, ...ctx.csrf })
        .send({})
        .expect(409),
    );
    expect(blocked).toMatchObject({ error: "payout_blocked" });
    // C8 / C11: the payee learns no reason — the 409 and the list say `processing`, nothing more.
    expect(blocked.details).toEqual({ status: "processing" });
    await ctx.get(PayoutService).scan();
    const row = () =>
      ctx.dataSource
        .getRepository(PayoutEntity)
        .findOneByOrFail({ pendingPayoutCid: bond.contractId });
    expect(await row()).toMatchObject({ status: "blocked_compliance", settleCommandId: null });
    const seen = bodyOf<{ payouts: { pendingPayoutCid: string }[] }>(
      await ctx.agent.get("/api/v1/in-app-wallet/payouts").set({ Cookie: cookie }).expect(200),
    ).payouts.find((p) => p.pendingPayoutCid === bond.contractId);
    expect(seen).toMatchObject({ status: "processing", lastError: null });
    expect(JSON.stringify(seen)).not.toMatch(/compliance|frozen|freeze/i);
    expect(ctx.ledger.walletOf(alice.partyId, TEST_COLLATERAL)?.balance ?? 0n).toBe(0n);
    await lift(placed.id);
    await ctx.get(PayoutService).scan();
    expect(await row()).toMatchObject({ status: "settled_in_app" });
    expect(ctx.ledger.walletOf(alice.partyId, TEST_COLLATERAL)?.balance).toBe(parseAmount("2"));
  });

  it("a reward grant stays queued while the account is frozen and is credited after the lift", async () => {
    const alice = makeTestWallet("alice");
    const { user } = await issueSessionDirect(ctx, alice);
    const f = new LedgerFixture(TEST_TREASURY);
    // The treasury's TRO float, then the account's first deposit (a first_deposit_bonus grant).
    ctx.stream.push(
      f.tokenTransferIn(makeTestWallet("funder").partyId, "50", { instrument: TEST_REWARDS }).tx,
    );
    const w = f.createWallet(alice.partyId);
    f.deposit(w.wallet, "100", "reconcile:deposit-1");
    ctx.stream.push(...f.txs.slice(1));
    await ctx.get(IndexerService).runOnce();
    const placed = await freeze(user.id);
    expect(await ctx.get(RewardsService).scan()).toMatchObject({
      queued: 1,
      submitted: 0,
      held: 1,
    });
    const grants = () =>
      ctx.dataSource.getRepository(RewardGrantEntity).find({ where: { userId: user.id } });
    expect((await grants()).map((g) => g.status)).toEqual(["queued"]);
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance ?? 0n).toBe(0n);
    await lift(placed.id);
    expect(await ctx.get(RewardsService).scan()).toMatchObject({
      submitted: 1,
      credited: 1,
      held: 0,
    });
    expect((await grants()).map((g) => g.status)).toEqual(["credited"]);
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance).toBe(parseAmount("10"));
  });

  it("an admin mint-and-credit leaves the minted tokens with the treasury while the account is frozen", async () => {
    const alice = makeTestWallet("alice");
    const { user } = await issueSessionDirect(ctx, alice);
    const placed = await freeze(user.id);
    const res = bodyOf<{ commandId: string }>(
      await ctx.agent
        .post("/api/v1/admin/tokens/mint")
        .set(await headers(anna))
        .send({ instrument: TEST_REWARDS, amount: "5", creditUserId: user.id, reason: "promo" })
        .expect(200),
    );
    await ctx.get(TokenAppSyncService).syncOnce("test");
    await ctx.get(TokenAppSyncService).syncOnce("test");
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance ?? 0n).toBe(0n);
    await lift(placed.id);
    await ctx.get(TokenAppSyncService).syncOnce("test");
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)).toMatchObject({
      balance: parseAmount("5"),
      creditRefs: [`mint:${res.commandId}`],
    });
  });
});

describe("TM-FROZEN-ACTIVITY (X6: user-signed transactions bypass the backend)", () => {
  it("raises a block alert for each indexed transaction a frozen party acted in after the freeze — not before it, not the treasury's own, not twice", async () => {
    const b = await k.buyer("active");
    const party = b.wallet.partyId;
    const f = new LedgerFixture(TEST_TREASURY);
    const w = f.createWallet(party);
    const d = f.deposit(w.wallet, "20", "ref-a");
    const before = f.withdraw(d.wallet, "1"); // the user's own Withdraw, BEFORE the freeze
    ctx.stream.push(...f.txs);
    await ctx.get(IndexerService).runOnce();
    const placed = await freeze(b.user.id);
    const processor = ctx.get(ComplianceScreeningProcessor);
    expect(await processor.tick()).toMatchObject({ frozenActivity: 0 });
    const treasuryOnly = f.deposit(before.wallet, "3", "ref-b"); // the treasury acts: not the user's activity
    const own = f.withdraw(treasuryOnly.wallet, "2").tx;
    ctx.stream.push(treasuryOnly.tx, own);
    await ctx.get(IndexerService).runOnce();
    expect(await processor.tick()).toMatchObject({ frozenActivity: 1 });
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledWith(
      "TM-FROZEN-ACTIVITY",
      b.user.id,
      expect.objectContaining({
        severity: "block",
        freezeId: placed.id,
        party,
        updateId: own.updateId,
        offset: own.offset,
        what: ["UserWallet.Withdraw"],
        windowKey: expect.stringMatching(
          new RegExp(`^frozen-activity:${placed.id}:\\d{4}-\\d{2}-\\d{2}$`),
        ) as string,
      }),
    );
    expect(await processor.tick()).toMatchObject({ frozenActivity: 0 });
    const audits = await ctx.dataSource
      .getRepository(AuditEventEntity)
      .find({ where: { action: "compliance.frozen_activity" } });
    expect(audits).toEqual([
      expect.objectContaining({
        subjectId: placed.id,
        metadata: expect.objectContaining({ updateId: own.updateId }) as unknown,
      }),
    ]);
  });
});
