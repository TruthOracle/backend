/**
 * TRO rewards end to end (docs/TOKENS.md §4.6; docs/API.md "Rewards", "Admin — rewards"): grants
 * derived from the ledger index (trades, winning redemptions, first deposits), credited through
 * `UserWallet.Grant` on the account's rewards wallet and confirmed against the ledger, the float
 * rule with its block / auto-mint, the manual grant, the rules and the account's view. Real
 * Postgres + Redis; the participant is FakeLedgerStream, the ledger FakeLedgerClient, the wallet
 * FakeEnterpriseWallet (which applies Create UserWallet / Grant), token-app FakeTokenApp. The
 * processor loop is off under test (`REWARDS_ENABLED=false`); the specs drive `scan()` / `tick()`.
 */
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { RewardGrantEntity } from "../src/entities/reward-grant.entity";
import { RewardsProcessor } from "../src/processors/rewards.processor";
import { IndexerService } from "../src/services/indexer.service";
import { RewardsService } from "../src/services/rewards.service";
import { UserService } from "../src/services/user.service";
import {
  NatsSubjects,
  type ApiPage,
  type ApiRewardGrant,
  type ApiRewardRule,
  type ApiRewardsFloat,
  type ApiRewardsOverview,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { formatAmount, parseAmount } from "../src/util/money";
import {
  TEST_REWARDS,
  TEST_TREASURY,
  TEST_TRO_ADMIN,
  useTestApp,
  type TestApp,
} from "./helpers/app";
import { LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const [unlinked] = parties(1, "stranger");
const dec = (v: string): string => formatAmount(parseAmount(v));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LedgerCommand = {
  CreateCommand?: { templateId: string; createArguments: Record<string, unknown> };
  ExerciseCommand?: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
};

/** The test harness shared by both app configurations below. */
function harness(ctx: TestApp): {
  index: (...txs: ReturnType<LedgerFixture["tx"]>[]) => Promise<void>;
  adminHeaders: () => Promise<Record<string, string>>;
  fundTreasury: (f: LedgerFixture, amount: string) => Promise<void>;
  grants: () => Promise<RewardGrantEntity[]>;
  audits: (action: string) => Promise<AuditEventEntity[]>;
  scan: () => ReturnType<RewardsService["scan"]>;
} {
  return {
    index: async (...txs) => {
      ctx.stream.push(...txs);
      await ctx.get(IndexerService).runOnce();
    },
    adminHeaders: async () => {
      const { cookie } = await issueSessionDirect(ctx, operator, { kind: "admin" });
      return { Cookie: cookie, ...ctx.csrf };
    },
    /** The treasury's TRO float: a token-standard transfer indexed as a treasury holding. */
    fundTreasury: async (f, amount) => {
      ctx.stream.push(f.tokenTransferIn(unlinked, amount, { instrument: TEST_REWARDS }).tx);
      await ctx.get(IndexerService).runOnce();
    },
    grants: () =>
      ctx.dataSource.getRepository(RewardGrantEntity).find({ order: { createdAt: "ASC" } }),
    audits: (action) =>
      ctx.dataSource
        .getRepository(AuditEventEntity)
        .find({ where: { action }, order: { id: "ASC" } }),
    scan: () => ctx.get(RewardsService).scan(),
  };
}

describe("rewards (docs/TOKENS.md §4.6)", () => {
  const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });
  const h = harness(ctx);

  it("a buy on a default-collateral market and the trader's first deposit become grants, credited with UserWallet.Grant on a TRO wallet created on demand; a second pass adds nothing", async () => {
    const alice = makeTestWallet("alice");
    const { cookie, user } = await issueSessionDirect(ctx, alice);
    const f = new LedgerFixture(TEST_TREASURY);
    await h.fundTreasury(f, "25.5");
    const created = f.createMarket({ marketId: 1 });
    const w0 = f.createWallet(alice.partyId);
    const d = f.deposit(w0.wallet, "100", "reconcile:deposit-1");
    f.buy({
      market: created.market,
      wallet: d.wallet,
      buyer: alice.partyId,
      side: "Yes",
      amount: "10",
    });
    await h.index(...f.txs.slice(1));

    const first = await h.scan();
    expect(first).toMatchObject({ queued: 2, submitted: 2, credited: 2, blocked: 0, failed: 0 });
    const rows = await h.grants();
    expect(rows.map((g) => [g.kind, formatAmount(g.amount), g.status, g.party, g.userId])).toEqual([
      ["first_deposit_bonus", dec("10"), "credited", alice.partyId, user.id],
      ["trade_volume_rebate", dec("0.1"), "credited", alice.partyId, user.id],
    ]);
    for (const g of rows) {
      expect(g.ref).toBe(`reward:${g.id}`);
      expect(g.commandId).toBe(`reward-grant-${g.id}-1`);
      expect(g.sourceEventId).toMatch(/^update-/);
      expect(g.creditedAt).toBeInstanceOf(Date);
    }
    // One empty TRO wallet under the deterministic id, then one Grant per row, v17 argument names.
    const commands = ctx.wallet.submits.map((s) => (s.commands as LedgerCommand[])[0]);
    expect(commands[0].CreateCommand).toMatchObject({
      templateId: "fakepkg:Truthoracle:UserWallet",
      createArguments: { owner: alice.partyId, instrument: TEST_REWARDS, creditRefs: [] },
    });
    expect(ctx.wallet.submits[0].commandId).toBe(
      ctx.ledger.walletCreateCommandId(alice.partyId, TEST_REWARDS),
    );
    expect(commands.slice(1).map((c) => c.ExerciseCommand)).toEqual([
      expect.objectContaining({
        choice: "Grant",
        choiceArgument: { amount: dec("10"), ref: rows[0].ref, reason: "first_deposit_bonus" },
      }),
      expect.objectContaining({
        choice: "Grant",
        choiceArgument: { amount: dec("0.1"), ref: rows[1].ref, reason: "trade_volume_rebate" },
      }),
    ]);
    const wallet = ctx.ledger.walletOf(alice.partyId, TEST_REWARDS);
    expect(wallet).toMatchObject({ balance: parseAmount("10.1"), deposited: 0n });
    expect(wallet?.creditRefs).toEqual(rows.map((g) => g.ref));
    expect((await h.audits("reward.granted")).map((a) => a.subjectId)).toEqual(
      rows.map((g) => g.id),
    );
    expect(ctx.nats.publishedOn(NatsSubjects.rewardGranted)).toHaveLength(2);
    // The cursor moved past both tables.
    const [{ value }] = await ctx.dataSource.query<{ value: string }[]>(
      `SELECT value FROM to_settings WHERE key = 'rewards_cursor'`,
    );
    expect(value).toMatch(/^\d+:\d+:\d+$/);
    expect(value).not.toBe("0");

    // Idempotent: the index is consumed, the grants are unique per source row.
    expect(await h.scan()).toMatchObject({ queued: 0, submitted: 0, credited: 0 });
    expect(await h.grants()).toHaveLength(2);
    expect(ctx.wallet.submits).toHaveLength(3);

    // The account's view.
    const me = bodyOf<ApiRewardsOverview>(
      await ctx.agent.get("/api/v1/me/rewards").set("Cookie", cookie).expect(200),
    );
    expect(me).toMatchObject({
      instrument: { admin: TEST_TRO_ADMIN, id: "TRO", symbol: "TRO", decimals: 6 },
      wallet: { owner: alice.partyId, balance: dec("10.1"), creditRefs: rows.map((g) => g.ref) },
      totals: { credited: dec("10.1"), queued: dec("0") },
    });
    expect(me.grants.map((g) => g.kind).sort()).toEqual([
      "first_deposit_bonus",
      "trade_volume_rebate",
    ]);
    expect(me.grants.find((g) => g.kind === "trade_volume_rebate")).toMatchObject({
      status: "credited",
      amount: dec("0.1"),
      instrument: expect.objectContaining({ id: "TRO" }) as unknown,
      ref: rows[1].ref,
      userId: user.id,
    });
    // Admin: the queue and the float (the index does not hold the fake ledger's wallets, so the
    // credited grants are still `pending` for the float rule until a `grant` entry carries the ref).
    const headers = await h.adminHeaders();
    const credited = bodyOf<ApiPage<ApiRewardGrant>>(
      await ctx.agent.get("/api/v1/admin/rewards/grants?status=credited").set(headers).expect(200),
    );
    expect(credited.total).toBe(2);
    expect(
      bodyOf<ApiPage<ApiRewardGrant>>(
        await ctx.agent
          .get(`/api/v1/admin/rewards/grants?userId=${user.id}&status=queued`)
          .set(headers)
          .expect(200),
      ).total,
    ).toBe(0);
    expect(
      bodyOf<ApiRewardsFloat>(
        await ctx.agent.get("/api/v1/admin/rewards/float").set(headers).expect(200),
      ),
    ).toEqual({
      instrument: expect.objectContaining({ id: "TRO" }) as unknown,
      treasuryHoldings: dec("25.5"),
      liabilities: dec("0"),
      pending: dec("10.1"),
      headroom: dec("15.4"),
    });
    // Once the index shows the grant in the wallet statement, it is a liability and no longer pending.
    const troWallet = f.createWallet(alice.partyId, TEST_REWARDS);
    const granted = f.grant(troWallet.wallet, "10.1", rows[0].ref, "first_deposit_bonus");
    await h.index(troWallet.tx, granted.tx);
    expect(
      bodyOf<ApiRewardsFloat>(
        await ctx.agent.get("/api/v1/admin/rewards/float").set(headers).expect(200),
      ),
    ).toMatchObject({ liabilities: dec("10.1"), pending: dec("0.1"), headroom: dec("15.3") });
  });

  it("a winning redemption earns the bonus; a voided one, a sell below minTrade, an unlinked party and a disabled rule earn nothing", async () => {
    const alice = makeTestWallet("alice");
    const { user } = await issueSessionDirect(ctx, alice);
    const headers = await h.adminHeaders();
    const rules = bodyOf<{ rules: ApiRewardRule[] }>(
      await ctx.agent.get("/api/v1/admin/rewards/rules").set(headers).expect(200),
    ).rules;
    const deposit = rules.find((r) => r.kind === "first_deposit_bonus")!;
    await ctx.agent
      .put(`/api/v1/admin/rewards/rules/${deposit.id}`)
      .set(headers)
      .send({ enabled: false, reason: "no deposit bonus in this test" })
      .expect(200);

    const f = new LedgerFixture(TEST_TREASURY);
    await h.fundTreasury(f, "100");
    const won = f.createMarket({ marketId: 1 });
    const voided = f.createMarket({ marketId: 2 });
    const w0 = f.createWallet(alice.partyId);
    const d = f.deposit(w0.wallet, "100", "r1");
    const b1 = f.buy({
      market: won.market,
      wallet: d.wallet,
      buyer: alice.partyId,
      side: "Yes",
      amount: "10",
    });
    const b2 = f.buy({
      market: voided.market,
      wallet: b1.wallet,
      buyer: alice.partyId,
      side: "No",
      amount: "4",
    });
    // A sell below minTrade (1 CC gross) earns no rebate.
    const s = f.sell({
      market: b2.market,
      wallet: b2.wallet,
      position: b2.position,
      seller: alice.partyId,
      side: "No",
      sharesIn: "1",
      gross: "0.5",
    });
    // A stranger trades too: no account, no grant.
    const sw = f.createWallet(unlinked);
    const sd = f.deposit(sw.wallet, "50", "r2");
    const sb = f.buy({
      market: s.market,
      wallet: sd.wallet,
      buyer: unlinked,
      side: "Yes",
      amount: "20",
    });
    const r1 = f.resolveT0(b1.market, "Yes");
    const rd1 = f.redeem({
      market: r1.market,
      wallet: s.wallet,
      position: b1.position,
      holder: alice.partyId,
    });
    const r2 = f.resolveT0(sb.market, "VoidOutcome");
    f.redeem({
      market: r2.market,
      wallet: rd1.wallet,
      position: s.position,
      holder: alice.partyId,
    });
    await h.index(...f.txs.slice(1));

    const result = await h.scan();
    expect(result).toMatchObject({ queued: 3, credited: 3 });
    const rows = await h.grants();
    expect(rows.map((g) => [g.kind, formatAmount(g.amount), g.status])).toEqual([
      ["trade_volume_rebate", dec("0.1"), "credited"],
      ["trade_volume_rebate", dec("0.04"), "credited"],
      // 18 YES shares (10 × 1.8) redeemed at 1 → 5 % of 18.
      ["winning_redeem_bonus", dec("0.9"), "credited"],
    ]);
    expect(new Set(rows.map((g) => g.userId))).toEqual(new Set([user.id]));
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance).toBe(parseAmount("1.04"));
    expect(ctx.ledger.walletOf(unlinked, TEST_REWARDS)).toBeUndefined();
  });

  it("the float rule blocks a grant the treasury's indexed TRO holdings do not cover (audited, Sentry-worthy, announced), and clears it once the float is there", async () => {
    const alice = makeTestWallet("alice");
    await issueSessionDirect(ctx, alice);
    const f = new LedgerFixture(TEST_TREASURY);
    const created = f.createMarket({ marketId: 1 });
    const w0 = f.createWallet(alice.partyId);
    const d = f.deposit(w0.wallet, "100", "r1");
    f.buy({
      market: created.market,
      wallet: d.wallet,
      buyer: alice.partyId,
      side: "Yes",
      amount: "10",
    });
    await h.index(...f.txs);

    expect(await h.scan()).toMatchObject({ queued: 2, submitted: 0, blocked: 2, minted: null });
    const blocked = await h.grants();
    expect(blocked.map((g) => g.status)).toEqual(["blocked_float", "blocked_float"]);
    expect(blocked[0].error).toMatch(
      /^blocked_float: shortfall 10\.0000000000 TRO \(holdings 0\.0000000000, liabilities 0\.0000000000, pending 0\.0000000000\)$/,
    );
    expect(ctx.wallet.submits).toEqual([]);
    expect(ctx.tokenApp.minted).toEqual([]);
    expect((await h.audits("reward.blocked_float")).map((a) => a.subjectId)).toEqual(
      blocked.map((g) => g.id),
    );
    expect(ctx.nats.publishedOn(NatsSubjects.rewardBlockedFloat)).toHaveLength(2);
    // Still blocked on the next pass: no second audit row / message.
    expect(await h.scan()).toMatchObject({ blocked: 2 });
    expect(await h.audits("reward.blocked_float")).toHaveLength(2);
    expect(ctx.nats.publishedOn(NatsSubjects.rewardBlockedFloat)).toHaveLength(2);

    // The float arrives (a transfer to the treasury) — but only 10.05 TRO: the deposit bonus fits, the rebate does not.
    await h.fundTreasury(f, "10.05");
    expect(await h.scan()).toMatchObject({ submitted: 1, credited: 1, blocked: 1 });
    expect((await h.grants()).map((g) => [g.kind, g.status])).toEqual([
      ["first_deposit_bonus", "credited"],
      ["trade_volume_rebate", "blocked_float"],
    ]);
    await h.fundTreasury(f, "1");
    expect(await h.scan()).toMatchObject({ submitted: 1, credited: 1, blocked: 0 });
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance).toBe(parseAmount("10.1"));
  });

  it("rules: listed with the dev defaults, re-parameterised and switched with audit; bad params / unknown ids are refused; a disabled rule earns nothing", async () => {
    const headers = await h.adminHeaders();
    const rules = bodyOf<{ rules: ApiRewardRule[] }>(
      await ctx.agent.get("/api/v1/admin/rewards/rules").set(headers).expect(200),
    ).rules;
    expect(rules.map((r) => [r.kind, r.params, r.enabled])).toEqual([
      ["first_deposit_bonus", { amount: "10" }, true],
      ["trade_volume_rebate", { perUnit: "0.01", minTrade: "1" }, true],
      ["winning_redeem_bonus", { fraction: "0.05" }, true],
    ]);
    const rebate = rules.find((r) => r.kind === "trade_volume_rebate")!;
    expect(rebate.id).toMatch(UUID_RE);
    const updated = bodyOf<{ rule: ApiRewardRule }>(
      await ctx.agent
        .put(`/api/v1/admin/rewards/rules/${rebate.id}`)
        .set(headers)
        .send({ params: { perUnit: "0.02", minTrade: "5" }, enabled: false, reason: "tune" })
        .expect(200),
    ).rule;
    expect(updated).toMatchObject({ params: { perUnit: "0.02", minTrade: "5" }, enabled: false });
    for (const bad of [
      { params: { perUnit: "0.02" }, reason: "x" },
      { params: { perUnit: 0.02, minTrade: "5" }, reason: "x" },
      { params: { perUnit: "0.02", minTrade: "5", nope: "1" }, reason: "x" },
      { enabled: true },
    ]) {
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .put(`/api/v1/admin/rewards/rules/${rebate.id}`)
            .set(headers)
            .send(bad)
            .expect(400),
        ).error,
      ).toBe("validation_failed");
    }
    await ctx.agent
      .put(`/api/v1/admin/rewards/rules/00000000-0000-4000-8000-000000000000`)
      .set(headers)
      .send({ enabled: true, reason: "x" })
      .expect(404);
    const audits = await h.audits("reward.rule_updated");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "admin",
      subjectId: rebate.id,
      metadata: {
        kind: "trade_volume_rebate",
        reason: "tune",
        before: { params: { perUnit: "0.01", minTrade: "1" }, enabled: true },
        after: { params: { perUnit: "0.02", minTrade: "5" }, enabled: false },
      },
    });

    // With the rebate off, a trade earns nothing (the cursor still moves).
    const alice = makeTestWallet("alice");
    await issueSessionDirect(ctx, alice);
    const f = new LedgerFixture(TEST_TREASURY);
    await h.fundTreasury(f, "100");
    const created = f.createMarket({ marketId: 1 });
    // No deposit entry is indexed, so the (still enabled) deposit bonus has nothing to pay either.
    const w0 = f.createWallet(alice.partyId);
    f.buy({
      market: created.market,
      wallet: w0.wallet,
      buyer: alice.partyId,
      side: "Yes",
      amount: "10",
    });
    await h.index(...f.txs.slice(1));
    expect(await h.scan()).toMatchObject({ queued: 0, marketEvents: 2 });
    expect(await h.grants()).toEqual([]);

    // Sessions: anonymous and user sessions are refused on the admin routes; an admin has no rewards view.
    await ctx.agent.get("/api/v1/admin/rewards/rules").expect(401);
    const { cookie } = await issueSessionDirect(ctx, makeTestWallet("u"));
    await ctx.agent.get("/api/v1/admin/rewards/rules").set("Cookie", cookie).expect(403);
    await ctx.agent.get("/api/v1/me/rewards").set("Cookie", headers.Cookie).expect(403);
  });

  it("a manual grant by userId goes to the primary party, by party to that party (attributed when linked); it is queued, audited and credited on the next pass", async () => {
    const headers = await h.adminHeaders();
    const alice = makeTestWallet("alice");
    const { user, cookie } = await issueSessionDirect(ctx, alice);
    const f = new LedgerFixture(TEST_TREASURY);
    await h.fundTreasury(f, "100");

    const byUser = bodyOf<{ grant: ApiRewardGrant }>(
      await ctx.agent
        .post("/api/v1/admin/rewards/grant")
        .set(headers)
        .send({ userId: user.id, amount: "2.5", reason: "beta tester" })
        .expect(200),
    ).grant;
    expect(byUser).toMatchObject({
      userId: user.id,
      party: alice.partyId,
      kind: "manual",
      ruleId: null,
      sourceEventId: null,
      amount: dec("2.5"),
      reason: "beta tester",
      status: "queued",
      commandId: null,
      error: null,
      creditedAt: null,
    });
    expect(byUser.ref).toBe(`reward:${byUser.id}`);
    const byParty = bodyOf<{ grant: ApiRewardGrant }>(
      await ctx.agent
        .post("/api/v1/admin/rewards/grant")
        .set(headers)
        .send({ party: unlinked, amount: "1", reason: "airdrop" })
        .expect(200),
    ).grant;
    expect(byParty).toMatchObject({ userId: null, party: unlinked, status: "queued" });
    expect((await h.audits("reward.grant_requested")).map((a) => a.subjectId)).toEqual([
      byUser.id,
      byParty.id,
    ]);

    for (const bad of [
      { amount: "1", reason: "x" },
      { userId: user.id, amount: "1.0000001", reason: "finer than 6 decimals" },
      { userId: user.id, amount: "0", reason: "zero" },
      { userId: user.id, amount: "1" },
      { party: "not-a-party", amount: "1", reason: "x" },
    ]) {
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent.post("/api/v1/admin/rewards/grant").set(headers).send(bad).expect(400),
        ).error,
      ).toBe("validation_failed");
    }
    await ctx.agent
      .post("/api/v1/admin/rewards/grant")
      .set(headers)
      .send({ userId: "00000000-0000-4000-8000-000000000000", amount: "1", reason: "x" })
      .expect(404);

    // The processor tick credits both: the unlinked party gets its own TRO wallet too.
    const tick = await ctx.get(RewardsProcessor).tick();
    expect(tick).toMatchObject({ submitted: 2, credited: 2 });
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance).toBe(parseAmount("2.5"));
    expect(ctx.ledger.walletOf(unlinked, TEST_REWARDS)?.balance).toBe(parseAmount("1"));
    const me = bodyOf<ApiRewardsOverview>(
      await ctx.agent.get("/api/v1/me/rewards").set("Cookie", cookie).expect(200),
    );
    expect(me.totals).toEqual({ credited: dec("2.5"), queued: dec("0") });
    expect(me.grants).toHaveLength(1);
    expect(
      bodyOf<ApiPage<ApiRewardGrant>>(
        await ctx.agent.get("/api/v1/admin/rewards/grants").set(headers).expect(200),
      ).items.map((g) => [g.party, g.status]),
    ).toEqual([
      [unlinked, "credited"],
      [alice.partyId, "credited"],
    ]);
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent.get("/api/v1/admin/rewards/grants?status=nope").set(headers).expect(400),
      ).error,
    ).toBe("validation_failed");

    // A suspended account cannot be granted to.
    await ctx.get(UserService).suspend(user.id, "test", { type: "system" });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/rewards/grant")
          .set(headers)
          .send({ userId: user.id, amount: "1", reason: "x" })
          .expect(403),
      ).error,
    ).toBe("user_suspended");
  });
});

describe("rewards: auto-mint and resubmission (REWARDS_AUTO_MINT=true, no confirm grace)", () => {
  const ctx = useTestApp({
    env: {
      ADMIN_OPERATORS: operator.partyId,
      REWARDS_AUTO_MINT: "true",
      REWARDS_MINT_MIN: "1000",
      DEPOSIT_CONFIRM_GRACE_MS: "0",
    },
  });
  const h = harness(ctx);

  it("a blocked grant mints max(shortfall, REWARDS_MINT_MIN) to the treasury through token-app once (audited token.mint); the next pass with the holding indexed submits", async () => {
    const alice = makeTestWallet("alice");
    await issueSessionDirect(ctx, alice);
    const headers = await h.adminHeaders();
    const grant = bodyOf<{ grant: ApiRewardGrant }>(
      await ctx.agent
        .post("/api/v1/admin/rewards/grant")
        .set(headers)
        .send({ party: alice.partyId, amount: "1500", reason: "big one" })
        .expect(200),
    ).grant;

    expect(await h.scan()).toMatchObject({ blocked: 1, minted: `reward-float-${grant.id}` });
    expect(ctx.tokenApp.minted).toEqual([
      {
        commandId: `reward-float-${grant.id}`,
        instrumentId: "TRO",
        partyId: TEST_TREASURY,
        amount: parseAmount("1500"),
        decimals: 6,
      },
    ]);
    const [row] = await h.grants();
    expect(row.status).toBe("blocked_float");
    expect(row.error).toContain(
      `auto-mint reward-float-${grant.id} submitted (1500.0000000000 TRO, submitted)`,
    );
    const mintAudits = await h.audits("token.mint");
    expect(mintAudits).toHaveLength(1);
    expect(mintAudits[0]).toMatchObject({
      actorType: "system",
      subjectType: "instrument",
      metadata: {
        commandId: `reward-float-${grant.id}`,
        amount: dec("1500"),
        party: TEST_TREASURY,
      },
    });
    expect(ctx.nats.publishedOn(NatsSubjects.tokenMinted)).toHaveLength(1);
    // Still short on the next pass (the mint is not indexed yet): no second mint for the same grant.
    expect(await h.scan()).toMatchObject({ blocked: 1, minted: null });
    expect(ctx.tokenApp.minted).toHaveLength(1);
    expect((await h.grants())[0].error).toContain("auto-mint");

    // The minted holding reaches the index: the grant goes through.
    const f = new LedgerFixture(TEST_TREASURY);
    await h.index(f.tx([f.holding(TEST_TREASURY, "1500", { instrument: TEST_REWARDS })]));
    expect(await h.scan()).toMatchObject({ submitted: 1, credited: 1, blocked: 0 });
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance).toBe(parseAmount("1500"));
    // A small shortfall mints the minimum.
    const small = bodyOf<{ grant: ApiRewardGrant }>(
      await ctx.agent
        .post("/api/v1/admin/rewards/grant")
        .set(headers)
        .send({ party: alice.partyId, amount: "0.5", reason: "small" })
        .expect(200),
    ).grant;
    expect(await h.scan()).toMatchObject({ blocked: 1, minted: `reward-float-${small.id}` });
    expect(ctx.tokenApp.minted[1].amount).toBe(parseAmount("1000"));
  });

  it("a Grant the ledger rejected is re-queued under a fresh command id (the ref stays the idempotency key) and lands on the retry", async () => {
    const alice = makeTestWallet("alice");
    await issueSessionDirect(ctx, alice);
    const headers = await h.adminHeaders();
    const f = new LedgerFixture(TEST_TREASURY);
    await h.fundTreasury(f, "100");
    // The TRO wallet exists already (so the lagging ledger only affects the Grant).
    ctx.ledger.seedUserWallet(alice.partyId, { instrument: TEST_REWARDS });
    const grant = bodyOf<{ grant: ApiRewardGrant }>(
      await ctx.agent
        .post("/api/v1/admin/rewards/grant")
        .set(headers)
        .send({ party: alice.partyId, amount: "3", reason: "retry me" })
        .expect(200),
    ).grant;

    ctx.wallet.lagLedger = true;
    expect(await h.scan()).toMatchObject({ submitted: 1, credited: 0 });
    let [row] = await h.grants();
    expect(row).toMatchObject({ status: "submitted", commandId: `reward-grant-${grant.id}-1` });
    expect(row.submittedAt).toBeInstanceOf(Date);
    // In flight: nothing changes while the wallet still says "submitted".
    expect(await h.scan()).toMatchObject({ credited: 0, requeued: 0, failed: 0 });
    // The ledger rejects it (a stale wallet cid, say): the grace period is 0 here, so the pass re-queues.
    ctx.wallet.rejectPending();
    ctx.wallet.lagLedger = false;
    expect(await h.scan()).toMatchObject({ requeued: 1, credited: 0 });
    [row] = await h.grants();
    expect(row.status).toBe("queued");
    expect(row.error).toMatch(/^attempt 1: wallet reports the command as failed/);
    // Next pass: a fresh attempt id, and it lands.
    expect(await h.scan()).toMatchObject({ submitted: 1, credited: 1 });
    [row] = await h.grants();
    expect(row).toMatchObject({
      status: "credited",
      commandId: `reward-grant-${grant.id}-2`,
      error: null,
    });
    expect(ctx.wallet.submits.map((s) => s.commandId)).toEqual([
      `reward-grant-${grant.id}-1`,
      `reward-grant-${grant.id}-2`,
    ]);
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)).toMatchObject({
      balance: parseAmount("3"),
      creditRefs: [grant.ref],
    });
  });
});
