/**
 * The operator's token operations end to end (docs/TOKENS.md §4.7; docs/API.md "Admin — tokens"):
 * mint and burn through a fake token-app, the mint-and-credit on-ramp through the deposit
 * write-ahead machinery (and the reconcile invariant it must keep), the status view. Real
 * Postgres + Redis; token-app is FakeTokenApp, the ledger / wallet / participant the usual fakes.
 */
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { DepositCreditEntity } from "../src/entities/deposit-credit.entity";
import { WalletCreditEntity } from "../src/entities/wallet-credit.entity";
import { WalletEntity } from "../src/entities/wallet.entity";
import { DepositService, mintCreditCommandId } from "../src/services/deposit.service";
import { IndexerService } from "../src/services/indexer.service";
import { UserService } from "../src/services/user.service";
import {
  NatsSubjects,
  type ApiTokenMintResult,
  type ApiTokenStatus,
  type ReconcileResult,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { formatAmount, parseAmount } from "../src/util/money";
import {
  TEST_COLLATERAL,
  TEST_DSO,
  TEST_REWARDS,
  TEST_TREASURY,
  TEST_TRO_ADMIN,
  useTestApp,
} from "./helpers/app";
import { LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });
const [bob] = parties(1, "holder");
const dec = (v: string): string => formatAmount(parseAmount(v));

async function adminHeaders(): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, operator, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

const audits = (action: string): Promise<AuditEventEntity[]> =>
  ctx.dataSource.getRepository(AuditEventEntity).find({ where: { action }, order: { id: "ASC" } });

describe("admin token operations (docs/TOKENS.md §4.7)", () => {
  it("mints to the treasury by default, to a party on request; audited token.mint and announced; validation before any call", async () => {
    const headers = await adminHeaders();
    const res = bodyOf<ApiTokenMintResult>(
      await ctx.agent
        .post("/api/v1/admin/tokens/mint")
        .set(headers)
        .send({ instrument: TEST_REWARDS, amount: "1000", reason: "DevNet float" })
        .expect(200),
    );
    expect(res).toEqual({
      commandId: expect.stringMatching(/^mint-[0-9a-f]{24}$/) as string,
      status: "submitted",
      instrument: {
        admin: TEST_TRO_ADMIN,
        id: "TRO",
        symbol: "TRO",
        name: "TruthOracle Token",
        decimals: 6,
      },
      amount: dec("1000"),
      party: TEST_TREASURY,
      credit: null,
    });
    expect(ctx.tokenApp.minted).toEqual([
      {
        commandId: res.commandId,
        instrumentId: "TRO",
        partyId: TEST_TREASURY,
        amount: parseAmount("1000"),
        decimals: 6,
      },
    ]);
    const toParty = bodyOf<ApiTokenMintResult>(
      await ctx.agent
        .post("/api/v1/admin/tokens/mint")
        .set(headers)
        .send({ instrument: TEST_REWARDS, amount: "2.5", to: bob, reason: "a holder" })
        .expect(200),
    );
    expect(toParty).toMatchObject({ party: bob, amount: dec("2.5"), credit: null });
    expect(ctx.tokenApp.minted[1].partyId).toBe(bob);
    const rows = await audits("token.mint");
    expect(rows.map((a) => a.metadata.party)).toEqual([TEST_TREASURY, bob]);
    expect(rows[0]).toMatchObject({
      actorType: "admin",
      subjectType: "instrument",
      subjectId: `${TEST_TRO_ADMIN}:TRO`,
      metadata: {
        commandId: res.commandId,
        amount: dec("1000"),
        reason: "DevNet float",
        creditUserId: null,
      },
    });
    expect(ctx.nats.publishedOn(NatsSubjects.tokenMinted)).toHaveLength(2);

    // Refused before token-app is called: finer than the token, zero, no reason, an unknown or disabled instrument.
    for (const [body, status, code] of [
      [{ instrument: TEST_REWARDS, amount: "1.0000001", reason: "x" }, 400, "validation_failed"],
      [{ instrument: TEST_REWARDS, amount: "0", reason: "x" }, 400, "validation_failed"],
      [{ instrument: TEST_REWARDS, amount: "1" }, 400, "validation_failed"],
      [
        { instrument: { admin: TEST_TRO_ADMIN, id: "NOPE" }, amount: "1", reason: "x" },
        404,
        "instrument_unknown",
      ],
      [
        {
          instrument: TEST_REWARDS,
          amount: "1",
          to: "treasury",
          creditUserId: "not-a-uuid",
          reason: "x",
        },
        400,
        "validation_failed",
      ],
    ] as const) {
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent.post("/api/v1/admin/tokens/mint").set(headers).send(body).expect(status),
        ).error,
      ).toBe(code);
    }
    expect(ctx.tokenApp.minted).toHaveLength(2);

    // Without token-app every mint / burn is 503 token_app_unconfigured, and nothing is audited.
    ctx.tokenApp.configured = false;
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/tokens/mint")
          .set(headers)
          .send({ instrument: TEST_REWARDS, amount: "1", reason: "x" })
          .expect(503),
      ).error,
    ).toBe("token_app_unconfigured");
    expect(await audits("token.mint")).toHaveLength(2);
  });

  it("mint-and-credit: the account's wallet is created first, the mint lands on the treasury, then UserWallet.Deposit { txRef: mint:<commandId> } through the write-ahead row — and the next reconcile sees nothing to credit", async () => {
    const headers = await adminHeaders();
    const alice = makeTestWallet("alice");
    const { user, cookie } = await issueSessionDirect(ctx, alice);
    const res = bodyOf<ApiTokenMintResult>(
      await ctx.agent
        .post("/api/v1/admin/tokens/mint")
        .set(headers)
        .send({ instrument: TEST_REWARDS, amount: "100", creditUserId: user.id, reason: "on-ramp" })
        .expect(200),
    );
    expect(res).toMatchObject({
      party: TEST_TREASURY,
      amount: dec("100"),
      credit: {
        commandId: mintCreditCommandId(res.commandId),
        txRef: `mint:${res.commandId}`,
        status: "confirmed",
      },
    });
    expect(ctx.tokenApp.minted).toEqual([
      expect.objectContaining({ partyId: TEST_TREASURY, amount: parseAmount("100") }),
    ]);
    // Create UserWallet (TRO) BEFORE the mint, Deposit after it.
    expect(ctx.wallet.submits.map((s) => s.commandId)).toEqual([
      ctx.ledger.walletCreateCommandId(alice.partyId, TEST_REWARDS),
      mintCreditCommandId(res.commandId),
    ]);
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)).toMatchObject({
      balance: parseAmount("100"),
      deposited: parseAmount("100"),
      creditRefs: [`mint:${res.commandId}`],
    });
    const credit = await ctx.dataSource
      .getRepository(DepositCreditEntity)
      .findOneByOrFail({ commandId: mintCreditCommandId(res.commandId) });
    const walletRow = await ctx.dataSource
      .getRepository(WalletEntity)
      .findOneByOrFail({ partyId: alice.partyId });
    expect(credit).toMatchObject({
      userId: user.id,
      ownerParty: alice.partyId,
      instrumentAdmin: TEST_TRO_ADMIN,
      instrumentId: "TRO",
      txRef: `mint:${res.commandId}`,
      amount: parseAmount("100"),
      status: "confirmed",
      attribution: [{ walletId: walletRow.id, partyId: alice.partyId, amount: dec("100") }],
    });
    expect(
      await ctx.dataSource.getRepository(WalletCreditEntity).findOneByOrFail({
        walletId: walletRow.id,
        instrumentAdmin: TEST_TRO_ADMIN,
        instrumentId: "TRO",
      }),
    ).toMatchObject({ credited: parseAmount("100") });
    expect((await audits("token.mint"))[0].metadata).toMatchObject({ creditUserId: user.id });
    expect((await audits("deposit.credited")).map((a) => a.subjectId)).toEqual([credit.id]);

    // The reconcile invariant: the mint credit counts as received by the wallet it was attributed
    // to, so a TRO reconcile finds nothing outstanding and no drift.
    const reconcile = bodyOf<ReconcileResult>(
      await ctx.agent
        .post("/api/v1/in-app-wallet/deposits/reconcile")
        .set({ Cookie: cookie, ...ctx.csrf })
        .send({ instrument: TEST_REWARDS })
        .expect(200),
    );
    expect(reconcile).toMatchObject({
      status: "nothing_outstanding",
      instrument: expect.objectContaining({ id: "TRO" }) as unknown,
      ledger: expect.objectContaining({ deposited: dec("100") }) as unknown,
    });
    // A later genuine TRO deposit still credits exactly its own amount.
    const f = new LedgerFixture(TEST_TREASURY);
    ctx.stream.push(f.tokenTransferIn(alice.partyId, "7", { instrument: TEST_REWARDS }).tx);
    await ctx.get(IndexerService).runOnce();
    expect(
      bodyOf<ReconcileResult>(
        await ctx.agent
          .post("/api/v1/in-app-wallet/deposits/reconcile")
          .set({ Cookie: cookie, ...ctx.csrf })
          .send({ instrument: TEST_REWARDS })
          .expect(200),
      ),
    ).toMatchObject({ status: "confirmed", credited: dec("7") });
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.deposited).toBe(parseAmount("107"));
  });

  it("mint-and-credit preconditions are settled before the mint: unknown / suspended / wallet-less accounts and a non-treasury target are refused without a mint", async () => {
    const headers = await adminHeaders();
    const alice = makeTestWallet("alice");
    const { user } = await issueSessionDirect(ctx, alice);
    const noWallet = await issueSessionDirect(ctx, makeTestWallet("nowallet"), {
      withWalletRow: false,
    });
    for (const [body, status, code] of [
      [
        { instrument: TEST_REWARDS, amount: "1", to: bob, creditUserId: user.id, reason: "x" },
        400,
        "validation_failed",
      ],
      [
        {
          instrument: TEST_REWARDS,
          amount: "1",
          creditUserId: "00000000-0000-4000-8000-000000000000",
          reason: "x",
        },
        404,
        "not_found",
      ],
      [
        { instrument: TEST_REWARDS, amount: "1", creditUserId: noWallet.user.id, reason: "x" },
        409,
        "no_primary_wallet",
      ],
    ] as const) {
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent.post("/api/v1/admin/tokens/mint").set(headers).send(body).expect(status),
        ).error,
      ).toBe(code);
    }
    await ctx.get(UserService).suspend(user.id, "test", { type: "system" });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/tokens/mint")
          .set(headers)
          .send({ instrument: TEST_REWARDS, amount: "1", creditUserId: user.id, reason: "x" })
          .expect(403),
      ).error,
    ).toBe("user_suspended");
    expect(ctx.tokenApp.minted).toEqual([]);
    expect(ctx.wallet.submits).toEqual([]);
  });

  it("a credit the ledger has not shown yet is `submitted`, finished by the confirm pass; a repeat for the same mint answers the existing row; a wallet failure leaves the write-ahead row for the pass", async () => {
    const headers = await adminHeaders();
    const alice = makeTestWallet("alice");
    const { user } = await issueSessionDirect(ctx, alice);
    ctx.ledger.seedUserWallet(alice.partyId, { instrument: TEST_REWARDS });
    // The wallet accepts the Deposit but the ledger has not applied it yet: the credit is `submitted`, not an error.
    ctx.wallet.lagLedger = true;
    const res = bodyOf<ApiTokenMintResult>(
      await ctx.agent
        .post("/api/v1/admin/tokens/mint")
        .set(headers)
        .send({
          instrument: TEST_REWARDS,
          amount: "5",
          creditUserId: user.id,
          reason: "slow ledger",
        })
        .expect(200),
    );
    expect(res.credit).toMatchObject({ status: "submitted", txRef: `mint:${res.commandId}` });
    ctx.wallet.applyPending();
    ctx.wallet.lagLedger = false;
    // The same mint again (a retry of the credit step) is answered by the existing row once confirmed — no second Deposit.
    await ctx.get(DepositService).confirmPending(user.id);
    const again = await ctx.get(DepositService).creditMint({
      userId: user.id,
      instrument: TEST_REWARDS,
      amount: parseAmount("5"),
      mintCommandId: res.commandId,
      actor: { type: "system" },
    });
    expect(again).toEqual({
      commandId: mintCreditCommandId(res.commandId),
      txRef: `mint:${res.commandId}`,
      status: "confirmed",
    });
    expect(ctx.wallet.submits).toHaveLength(1);
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance).toBe(parseAmount("5"));

    // A Deposit submit the wallet refuses: the command may or may not have reached the ledger, so the
    // row stays `submitted` for the confirm pass (fail closed) and the route reports exactly that.
    ctx.wallet.failNext = new Error("wallet down");
    const failed = bodyOf<ApiTokenMintResult>(
      await ctx.agent
        .post("/api/v1/admin/tokens/mint")
        .set(headers)
        .send({
          instrument: TEST_REWARDS,
          amount: "6",
          creditUserId: user.id,
          reason: "wallet down",
        })
        .expect(200),
    );
    expect(failed.credit).toMatchObject({ status: "submitted", txRef: `mint:${failed.commandId}` });
    expect(ctx.tokenApp.minted).toHaveLength(2);
    expect(
      await ctx.dataSource
        .getRepository(DepositCreditEntity)
        .countBy({ userId: user.id, status: "submitted" }),
    ).toBe(1);
    // While that credit is in flight a new mint-and-credit for the account is refused — and the
    // refusal names the mint that already landed.
    const busy = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/admin/tokens/mint")
        .set(headers)
        .send({ instrument: TEST_REWARDS, amount: "1", creditUserId: user.id, reason: "again" })
        .expect(409),
    );
    expect(busy.error).toBe("deposit_in_progress");
    expect(busy.details).toMatchObject({
      mint: {
        commandId: expect.stringMatching(/^mint-/) as string,
        amount: dec("1"),
        party: TEST_TREASURY,
      },
    });
  });

  it("burns from any party of a registered instrument; status shows token-app and the index's float per instrument", async () => {
    const headers = await adminHeaders();
    const burn = bodyOf<ApiTokenMintResult>(
      await ctx.agent
        .post("/api/v1/admin/tokens/burn")
        .set(headers)
        .send({ instrument: TEST_REWARDS, amount: "4", party: bob, reason: "clawback" })
        .expect(200),
    );
    expect(burn).toMatchObject({
      commandId: expect.stringMatching(/^burn-[0-9a-f]{24}$/) as string,
      status: "submitted",
      amount: dec("4"),
      party: bob,
      credit: null,
    });
    expect(ctx.tokenApp.burned).toEqual([
      {
        commandId: burn.commandId,
        instrumentId: "TRO",
        partyId: bob,
        amount: parseAmount("4"),
        decimals: 6,
      },
    ]);
    expect((await audits("token.burn"))[0]).toMatchObject({
      actorType: "admin",
      metadata: { party: bob, reason: "clawback" },
    });
    expect(ctx.nats.publishedOn(NatsSubjects.tokenBurned)).toHaveLength(1);
    await ctx.agent
      .post("/api/v1/admin/tokens/burn")
      .set(headers)
      .send({ instrument: TEST_REWARDS, amount: "4", reason: "no party" })
      .expect(400);

    // Status: the treasury's indexed holdings against the indexed wallet balances, per registered instrument.
    const f = new LedgerFixture(TEST_TREASURY);
    const w = f.createWallet(bob, TEST_REWARDS);
    ctx.stream.push(
      f.spliceTransferIn(bob, "12"),
      f.tokenTransferIn(bob, "25.5", { instrument: TEST_REWARDS }).tx,
      w.tx,
      f.grant(w.wallet, "3", "reward:x", "manual").tx,
    );
    await ctx.get(IndexerService).runOnce();
    const status = bodyOf<ApiTokenStatus>(
      await ctx.agent.get("/api/v1/admin/tokens/status").set(headers).expect(200),
    );
    expect(status.tokenApp).toEqual({
      configured: true,
      url: "http://token-app.fake",
      appName: "truthoracle",
      reachable: true,
      raw: expect.any(Object) as unknown,
    });
    expect(status.instruments).toEqual([
      {
        instrument: {
          admin: TEST_DSO,
          id: TEST_COLLATERAL.id,
          symbol: "CC",
          name: "Canton Coin",
          decimals: 10,
        },
        treasuryHoldings: dec("12"),
        liabilities: dec("0"),
      },
      {
        instrument: expect.objectContaining({ id: "TRO" }) as unknown,
        treasuryHoldings: dec("25.5"),
        liabilities: dec("3"),
      },
    ]);
    ctx.tokenApp.configured = false;
    expect(
      bodyOf<ApiTokenStatus>(
        await ctx.agent.get("/api/v1/admin/tokens/status").set(headers).expect(200),
      ).tokenApp,
    ).toEqual({
      configured: false,
      url: null,
      appName: "truthoracle",
      reachable: false,
      raw: null,
    });

    // Sessions: anonymous and user sessions are refused.
    await ctx.agent.get("/api/v1/admin/tokens/status").expect(401);
    const { cookie } = await issueSessionDirect(ctx, makeTestWallet("u"));
    await ctx.agent.get("/api/v1/admin/tokens/status").set("Cookie", cookie).expect(403);
  });
});
