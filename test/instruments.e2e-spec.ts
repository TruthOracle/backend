/**
 * The instruments registry end to end (docs/TOKENS.md §4.1, §4.3; docs/API.md "Exchange",
 * "Admin — instruments"): the public list, the operator's CRUD with its audit trail, and the
 * per-instrument money paths that key on it — a deposit reconcile and a payout in the rewards
 * instrument, a disabled or unknown instrument refused. Real Postgres + Redis; the participant is
 * FakeLedgerStream, the ledger FakeLedgerClient, the wallet FakeEnterpriseWallet.
 */
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { IndexerService } from "../src/services/indexer.service";
import {
  NatsSubjects,
  type ApiAdminInstrument,
  type ApiInstrument,
  type ApiPayout,
  type ReconcileResult,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { formatAmount, parseAmount } from "../src/util/money";
import { TEST_DSO, TEST_REWARDS, TEST_TREASURY, TEST_TRO_ADMIN, useTestApp } from "./helpers/app";
import { FIXTURE_TOKEN, LedgerFixture } from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });
const dec = (v: string): string => formatAmount(parseAmount(v));
const H = { "x-requested-with": "truthoracle" };

async function adminHeaders(): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, operator, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

describe("instruments (docs/TOKENS.md §4.1)", () => {
  it("GET /exchange/instruments lists the enabled instruments with their wallet ids; the operator registers, edits and disables tokens with audit and announcements", async () => {
    const pub = bodyOf<{ instruments: ApiInstrument[] }>(
      await ctx.agent.get("/api/v1/exchange/instruments").expect(200),
    ).instruments;
    expect(pub).toEqual([
      {
        admin: TEST_DSO,
        id: "Amulet",
        symbol: "CC",
        name: "Canton Coin",
        decimals: 10,
        kind: "collateral",
        enabled: true,
        isDefaultCollateral: true,
        walletInstrumentId: "Amulet",
      },
      {
        admin: TEST_TRO_ADMIN,
        id: "TRO",
        symbol: "TRO",
        name: "TruthOracle Token",
        decimals: 6,
        kind: "rewards",
        enabled: true,
        isDefaultCollateral: false,
        walletInstrumentId: "TRO",
      },
    ]);

    const headers = await adminHeaders();
    const created = bodyOf<{ instrument: ApiAdminInstrument }>(
      await ctx.agent
        .post("/api/v1/admin/instruments")
        .set(headers)
        .send({
          admin: FIXTURE_TOKEN.admin,
          id: "cBYN",
          symbol: "cBYN",
          name: "Canton Belarusian Ruble",
          decimals: 6,
          kind: "collateral",
          registryUrl: "https://registry.test/api/c8",
          registryAuth: "keycloak",
          transferMode: "registry",
          reason: "Cantor8 stablecoin",
        })
        .expect(200),
    ).instrument;
    expect(created).toMatchObject({
      admin: FIXTURE_TOKEN.admin,
      id: "cBYN",
      symbol: "cBYN",
      decimals: 6,
      kind: "collateral",
      enabled: true,
      isDefaultCollateral: false,
      walletInstrumentId: "cBYN",
      registryUrl: "https://registry.test/api/c8",
      registryAuth: "keycloak",
      transferMode: "registry",
      setupChoices: {},
    });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/instruments")
          .set(headers)
          .send({
            admin: FIXTURE_TOKEN.admin,
            id: "cBYN",
            decimals: 6,
            kind: "collateral",
            reason: "again",
          })
          .expect(409),
      ).error,
    ).toBe("instrument_exists");
    for (const bad of [
      { admin: "nope", id: "X", decimals: 6, kind: "collateral", reason: "x" },
      { admin: FIXTURE_TOKEN.admin, id: "X", decimals: 11, kind: "collateral", reason: "x" },
      { admin: FIXTURE_TOKEN.admin, id: "X", decimals: 6, kind: "other", reason: "x" },
      {
        admin: FIXTURE_TOKEN.admin,
        id: "X",
        decimals: 6,
        kind: "collateral",
        registryUrl: "ftp://x",
        reason: "x",
      },
    ]) {
      await ctx.agent.post("/api/v1/admin/instruments").set(headers).send(bad).expect(400);
    }

    const patched = bodyOf<{ instrument: ApiAdminInstrument }>(
      await ctx.agent
        .patch(`/api/v1/admin/instruments/${encodeURIComponent(FIXTURE_TOKEN.admin)}/cBYN`)
        .set(headers)
        .send({ symbol: "BYNc", enabled: false, walletInstrumentId: "cbyn-v2", reason: "paused" })
        .expect(200),
    ).instrument;
    expect(patched).toMatchObject({
      symbol: "BYNc",
      enabled: false,
      walletInstrumentId: "cbyn-v2",
    });
    await ctx.agent
      .patch(`/api/v1/admin/instruments/${encodeURIComponent(FIXTURE_TOKEN.admin)}/NOPE`)
      .set(headers)
      .send({ enabled: false, reason: "x" })
      .expect(404);

    // Admin list shows the disabled row; the public list hides it.
    const all = bodyOf<{ instruments: ApiAdminInstrument[] }>(
      await ctx.agent.get("/api/v1/admin/instruments").set(headers).expect(200),
    ).instruments;
    // Collateral before rewards, then by symbol: the renamed `BYNc` sorts before `CC`.
    expect(all.map((i) => [i.id, i.enabled])).toEqual([
      ["cBYN", false],
      ["Amulet", true],
      ["TRO", true],
    ]);
    expect(
      bodyOf<{ instruments: ApiInstrument[] }>(
        await ctx.agent.get("/api/v1/exchange/instruments").expect(200),
      ).instruments.map((i) => i.id),
    ).toEqual(["Amulet", "TRO"]);

    const audits = await ctx.dataSource.getRepository(AuditEventEntity).find({
      where: [{ action: "instrument.created" }, { action: "instrument.updated" }],
      order: { id: "ASC" },
    });
    expect(audits.map((a) => [a.action, a.subjectId, a.actorType])).toEqual([
      ["instrument.created", `${FIXTURE_TOKEN.admin}:cBYN`, "admin"],
      ["instrument.updated", `${FIXTURE_TOKEN.admin}:cBYN`, "admin"],
    ]);
    expect(audits[1].metadata).toMatchObject({ reason: "paused" });
    expect(ctx.nats.publishedOn(NatsSubjects.instrumentChanged)).toHaveLength(2);

    // Sessions: anonymous and user sessions are refused on the admin routes.
    await ctx.agent.get("/api/v1/admin/instruments").expect(401);
    const { cookie } = await issueSessionDirect(ctx, makeTestWallet("u"));
    await ctx.agent.get("/api/v1/admin/instruments").set("Cookie", cookie).expect(403);
  });

  it("a deposit reconcile and a payout key on the instrument: TRO reconciles into the TRO wallet from the index, a TRO withdrawal transfers TRO; disabled and unknown instruments are refused", async () => {
    const alice = makeTestWallet("alice");
    const { cookie } = await issueSessionDirect(ctx, alice);
    const session = { Cookie: cookie, ...ctx.csrf, ...H };
    const f = new LedgerFixture(TEST_TREASURY);
    ctx.stream.push(f.tokenTransferIn(alice.partyId, "12.5", { instrument: TEST_REWARDS }).tx);
    await ctx.get(IndexerService).runOnce();

    // Canton Coin: nothing was sent; TRO: 12.5 credited into a wallet created on demand.
    expect(
      bodyOf<ReconcileResult>(
        await ctx.agent
          .post("/api/v1/in-app-wallet/deposits/reconcile")
          .set(session)
          .send({})
          .expect(200),
      ),
    ).toMatchObject({
      status: "nothing_outstanding",
      instrument: expect.objectContaining({ id: "Amulet" }) as unknown,
    });
    const tro = bodyOf<ReconcileResult>(
      await ctx.agent
        .post("/api/v1/in-app-wallet/deposits/reconcile")
        .set(session)
        .send({ instrument: TEST_REWARDS })
        .expect(200),
    );
    expect(tro).toMatchObject({
      status: "confirmed",
      credited: dec("12.5"),
      instrument: { admin: TEST_TRO_ADMIN, id: "TRO", symbol: "TRO", decimals: 6 },
      ledger: expect.objectContaining({
        deposited: dec("12.5"),
        instrument: expect.objectContaining({ id: "TRO" }) as unknown,
      }) as unknown,
    });
    expect(ctx.ledger.walletOf(alice.partyId)).toBeUndefined();
    expect(ctx.ledger.walletOf(alice.partyId, TEST_REWARDS)?.balance).toBe(parseAmount("12.5"));

    // Unknown and disabled instruments.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/in-app-wallet/deposits/reconcile")
          .set(session)
          .send({ instrument: { admin: TEST_TRO_ADMIN, id: "NOPE" } })
          .expect(404),
      ).error,
    ).toBe("instrument_unknown");
    const headers = await adminHeaders();
    await ctx.agent
      .patch(`/api/v1/admin/instruments/${encodeURIComponent(TEST_TRO_ADMIN)}/TRO`)
      .set(headers)
      .send({ enabled: false, reason: "pause TRO" })
      .expect(200);
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/in-app-wallet/deposits/reconcile")
          .set(session)
          .send({ instrument: TEST_REWARDS })
          .expect(409),
      ).error,
    ).toBe("instrument_disabled");
    await ctx.agent
      .patch(`/api/v1/admin/instruments/${encodeURIComponent(TEST_TRO_ADMIN)}/TRO`)
      .set(headers)
      .send({ enabled: true, reason: "resume TRO" })
      .expect(200);

    // A withdrawal in TRO settles as a TRO transfer (the wallet's instrument id), the payout naming its instrument.
    const payout = ctx.ledger.seedPendingPayout({
      user: alice.partyId,
      amount: "3",
      reason: "withdraw",
      instrument: TEST_REWARDS,
    });
    const settled = bodyOf<{ payout: ApiPayout; mode: string }>(
      await ctx.agent
        .post(`/api/v1/in-app-wallet/payouts/${payout.contractId}/settle`)
        .set(session)
        .expect(200),
    );
    expect(settled).toMatchObject({
      mode: "external",
      payout: {
        status: "settled_external",
        amount: dec("3"),
        instrument: expect.objectContaining({ id: "TRO", decimals: 6 }) as unknown,
      },
    });
    expect(ctx.wallet.transfers).toEqual([
      expect.objectContaining({
        to: alice.partyId,
        instrumentId: "TRO",
        amount: parseAmount("3"),
        reason: "withdraw",
      }),
    ]);
  });
});
