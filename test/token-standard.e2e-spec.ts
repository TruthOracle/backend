/**
 * The token standard end to end (docs/TOKENS.md §4.2–§4.4; docs/INDEXER.md §6): holdings and
 * two-step offers through the interface views, transfers derived from `TransferFactory_Transfer`
 * / `TransferInstruction_Accept`, the acceptor processor, registry-mode treasury transfers
 * behind a payout, the instrument setup action and the admin reads. Real Postgres + Redis; the
 * participant is FakeLedgerStream, the registry FakeTokenRegistry, the wallet FakeEnterpriseWallet.
 */
import type { Server } from "node:http";
import request from "supertest";

import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { LedgerHoldingEntity } from "../src/entities/ledger-holding.entity";
import { LedgerTransferInstructionEntity } from "../src/entities/ledger-transfer-instruction.entity";
import { LedgerTransferEntity } from "../src/entities/ledger-transfer.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { TransferInstructionAcceptorProcessor } from "../src/processors/transfer-instruction-acceptor.processor";
import { IndexerService } from "../src/services/indexer.service";
import { InstrumentsService } from "../src/services/instruments.service";
import { commandIdsFor } from "../src/services/payout.service";
import {
  NatsSubjects,
  type ApiInstrumentSetupResult,
  type ApiLedgerHolding,
  type ApiLedgerTransfer,
  type ApiPage,
  type ApiPayout,
  type ApiTransferInstruction,
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
import { FIXTURE_TOKEN, LedgerFixture, parties } from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect, linkWallet } from "./helpers/session";
import { nextTelegramUser, signInWithTelegram } from "./helpers/telegram";
import { makeTestWallet } from "./helpers/wallet";

const operator = makeTestWallet("op");
const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });
const [alice, bob] = parties(2, "trader");
const dec = (v: string): string => formatAmount(parseAmount(v));

type LedgerCommand = {
  ExerciseCommand?: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
};

async function index(...txs: ReturnType<LedgerFixture["tx"]>[]): Promise<void> {
  ctx.stream.push(...txs);
  await ctx.get(IndexerService).runOnce();
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, operator, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

describe("token-standard index (docs/TOKENS.md §4.2)", () => {
  it("a direct transfer to the treasury becomes an `in` row and a treasury holding; a transfer out consumes inputs and leaves the change", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    const inbound = f.tokenTransferIn(alice, "25.5", { instrument: TEST_REWARDS });
    await index(inbound.tx);

    const transfers = await ctx.dataSource.getRepository(LedgerTransferEntity).find();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      direction: "in",
      counterparty: alice,
      instrumentAdmin: TEST_TRO_ADMIN,
      instrumentId: "TRO",
      amount: parseAmount("25.5"),
      kind: "token_standard",
      choice: "TransferFactory_Transfer",
      nodeId: 0,
    });
    const holdings = ctx.dataSource.getRepository(LedgerHoldingEntity);
    // Only the treasury's holdings are kept — Alice's change is hers.
    expect(await holdings.find()).toEqual([
      expect.objectContaining({
        contractId: inbound.treasuryHoldingCid,
        owner: TEST_TREASURY,
        instrumentId: "TRO",
        amount: parseAmount("25.5"),
        locked: false,
        archivedOffset: null,
      }),
    ]);
    expect(ctx.nats.publishedOn(NatsSubjects.transferSeen)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          direction: "in",
          counterparty: alice,
          instrument: TEST_REWARDS,
          kind: "token_standard",
        }) as unknown,
      }),
    ]);

    const outbound = f.tokenTransferOut(bob, "20", [inbound.treasuryHoldingCid], {
      instrument: TEST_REWARDS,
      change: "5.5",
    });
    await index(outbound.tx);
    const after = await ctx.dataSource
      .getRepository(LedgerTransferEntity)
      .find({ order: { offset: "ASC" } });
    expect(after.map((t) => [t.direction, t.counterparty, formatAmount(t.amount)])).toEqual([
      ["in", alice, dec("25.5")],
      ["out", bob, dec("20")],
    ]);
    const rows = await holdings.find({ order: { createdOffset: "ASC" } });
    expect(rows.map((h) => [formatAmount(h.amount), h.archivedOffset])).toEqual([
      [dec("25.5"), outbound.tx.offset],
      [dec("5.5"), null],
    ]);
    // Replaying the page writes nothing twice.
    await ctx.get(IndexerService).runOnce();
    expect(await ctx.dataSource.getRepository(LedgerTransferEntity).count()).toBe(2);
    expect(await holdings.count()).toBe(2);
  });

  it("a two-step offer is a pending instruction (no transfer yet); the accept completes it and yields the `in` row; a reject fails it", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    const offer = f.tokenOfferIn(alice, "7", { instrument: TEST_REWARDS });
    await index(offer.tx);
    const instructions = ctx.dataSource.getRepository(LedgerTransferInstructionEntity);
    expect(await instructions.find()).toEqual([
      expect.objectContaining({
        contractId: offer.instructionCid,
        sender: alice,
        receiver: TEST_TREASURY,
        instrumentId: "TRO",
        amount: parseAmount("7"),
        status: "pending",
        archivedOffset: null,
      }),
    ]);
    expect(await ctx.dataSource.getRepository(LedgerTransferEntity).count()).toBe(0);
    // The sender's locked holding is not the treasury's.
    expect(await ctx.dataSource.getRepository(LedgerHoldingEntity).count()).toBe(0);

    const accepted = f.acceptInstruction(offer.instructionCid, "7", { instrument: TEST_REWARDS });
    await index(accepted.tx);
    expect(await instructions.findOneByOrFail({ contractId: offer.instructionCid })).toMatchObject({
      status: "completed",
      archivedOffset: accepted.tx.offset,
    });
    const transfers = await ctx.dataSource.getRepository(LedgerTransferEntity).find();
    expect(transfers).toEqual([
      expect.objectContaining({
        direction: "in",
        counterparty: alice,
        amount: parseAmount("7"),
        kind: "token_standard",
        choice: "TransferInstruction_Accept",
      }),
    ]);
    expect(ctx.nats.publishedOn(NatsSubjects.transferInstructionAccepted)).toEqual([
      expect.objectContaining({
        payload: {
          contractId: offer.instructionCid,
          instrument: TEST_REWARDS,
          offset: accepted.tx.offset,
        },
      }),
    ]);

    const second = f.tokenOfferIn(bob, "1", { instrument: TEST_REWARDS });
    await index(
      second.tx,
      f.endInstruction(second.instructionCid, "TransferInstruction_Reject", TEST_TREASURY),
    );
    expect(await instructions.findOneByOrFail({ contractId: second.instructionCid })).toMatchObject(
      {
        status: "failed",
      },
    );
    expect(await ctx.dataSource.getRepository(LedgerTransferEntity).count()).toBe(1);
  });

  it("Canton Coin keeps working: a Splice transfer is an `amulet` row whose Amulet is a holding, and one made through the token standard is counted once", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    await index(f.spliceTransferIn(alice, "25"), f.amuletTokenStandardTransferIn(bob, "9"));
    const transfers = await ctx.dataSource
      .getRepository(LedgerTransferEntity)
      .find({ order: { offset: "ASC" } });
    expect(
      transfers.map((t) => [t.kind, t.counterparty, formatAmount(t.amount), t.instrumentId]),
    ).toEqual([
      ["amulet", alice, dec("25"), "Amulet"],
      ["token_standard", bob, dec("9"), "Amulet"],
    ]);
    expect(transfers.every((t) => t.instrumentAdmin === TEST_DSO)).toBe(true);
    const holdings = await ctx.dataSource
      .getRepository(LedgerHoldingEntity)
      .find({ order: { createdOffset: "ASC" } });
    expect(holdings.map((h) => [h.owner, h.instrumentId, formatAmount(h.amount)])).toEqual([
      [TEST_TREASURY, "Amulet", dec("25")],
      [TEST_TREASURY, "Amulet", dec("9")],
    ]);
  });

  it("bootstrap from an ACS snapshot loads the treasury's holdings; a resync archives the ones that vanished without inventing an outcome", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    f.offset = 5;
    ctx.stream.pruned = 5;
    ctx.stream.end = 5;
    ctx.stream.acs = [
      f.holdingAcsEntry(TEST_TREASURY, "40", {
        instrument: TEST_REWARDS,
        offset: 3,
        contractId: "00hold-acs",
      }),
      f.holdingAcsEntry(alice, "1", { instrument: TEST_REWARDS, offset: 4 }),
    ];
    const indexer = ctx.get(IndexerService);
    const run = await indexer.runOnce();
    expect(run.bootstrapped).toBe(true);
    const holdings = ctx.dataSource.getRepository(LedgerHoldingEntity);
    expect(await holdings.find()).toEqual([
      expect.objectContaining({
        contractId: "00hold-acs",
        owner: TEST_TREASURY,
        amount: parseAmount("40"),
        createdOffset: 3,
      }),
    ]);

    // Streaming resumes from the snapshot: the fixed ledger end goes, the fixture's offsets rule again.
    ctx.stream.end = null;
    const offer = f.tokenOfferIn(bob, "2", { instrument: TEST_REWARDS });
    await index(offer.tx);
    // The operator resync at the ledger end: neither contract is active any more.
    ctx.stream.acs = [];
    ctx.stream.end = offer.tx.offset + 3;
    await indexer.resyncNow("verify");
    expect(await holdings.findOneByOrFail({ contractId: "00hold-acs" })).toMatchObject({
      archivedOffset: offer.tx.offset + 3,
    });
    expect(
      await ctx.dataSource.getRepository(LedgerTransferInstructionEntity).findOneByOrFail({
        contractId: offer.instructionCid,
      }),
    ).toMatchObject({ status: "pending", archivedOffset: offer.tx.offset + 3 });
  });
});

describe("transfer-instruction acceptor (docs/TOKENS.md §4.4)", () => {
  it("accepts a pending offer to the treasury in a known, enabled instrument through the registry's context, once; unknown instruments stay pending", async () => {
    // The sender is a signed-in account's linked wallet, so the accepted offer can be credited below.
    const agent = request(ctx.app.getHttpServer() as Server);
    const user = makeTestWallet("alice-user");
    const { cookie } = await signInWithTelegram(agent, nextTelegramUser("Alice"));
    await linkWallet(agent, cookie, user);
    const f = new LedgerFixture(TEST_TREASURY);
    const tro = f.tokenOfferIn(user.partyId, "7", { instrument: TEST_REWARDS });
    const unknown = f.tokenOfferIn(bob, "3", { instrument: FIXTURE_TOKEN });
    await index(tro.tx, unknown.tx);

    const processor = ctx.get(TransferInstructionAcceptorProcessor);
    processor.reset();
    await expect(processor.tick()).resolves.toEqual({ accepted: 1, skipped: 1, failed: 0 });
    expect(ctx.registry.calls).toEqual([
      { instrument: "TRO", kind: "accept", input: tro.instructionCid },
    ]);
    expect(ctx.wallet.submits).toHaveLength(1);
    const [accept] = ctx.wallet.submits[0].commands as LedgerCommand[];
    expect(accept.ExerciseCommand).toMatchObject({
      templateId:
        "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      contractId: tro.instructionCid,
      choice: "TransferInstruction_Accept",
    });
    expect(ctx.wallet.submits[0].disclosedContracts).toHaveLength(2);
    expect(ctx.wallet.submits[0].commandId).toMatch(/^ti-accept-[0-9a-f]{40}$/);

    // A second scan before the index saw the accept does not submit again.
    await expect(processor.tick()).resolves.toEqual({ accepted: 0, skipped: 2, failed: 0 });
    expect(ctx.wallet.submits).toHaveLength(1);

    // The accept lands: the offer completes, the deposit is an `in` row the reconcile credits.
    await index(f.acceptInstruction(tro.instructionCid, "7", { instrument: TEST_REWARDS }).tx);
    await expect(processor.tick()).resolves.toEqual({ accepted: 0, skipped: 1, failed: 0 });
    const res = await agent
      .post("/api/v1/in-app-wallet/deposits/reconcile")
      .set(ctx.csrf)
      .set("x-requested-with", "truthoracle")
      .set("Cookie", cookie)
      .send({ instrument: TEST_REWARDS })
      .expect(200);
    expect(bodyOf<ReconcileResult>(res)).toMatchObject({
      instrument: expect.objectContaining({ id: "TRO" }) as unknown,
      credited: dec("7"),
      status: "confirmed",
    });
  });

  it("a registry that fails leaves the offer pending for the next scan", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    const tro = f.tokenOfferIn(alice, "7", { instrument: TEST_REWARDS });
    await index(tro.tx);
    const processor = ctx.get(TransferInstructionAcceptorProcessor);
    processor.reset();
    ctx.registry.failNext = new Error("registry down");
    await expect(processor.tick()).resolves.toEqual({ accepted: 0, skipped: 0, failed: 1 });
    expect(ctx.wallet.submits).toHaveLength(0);
    await expect(processor.tick()).resolves.toEqual({ accepted: 1, skipped: 0, failed: 0 });
  });
});

describe("registry-mode treasury transfers (docs/TOKENS.md §4.4)", () => {
  async function registryMode(): Promise<void> {
    await ctx.get(InstrumentsService).update(
      TEST_DSO,
      "Amulet",
      {
        transferMode: "registry",
        registryUrl: "https://registry.test/api/validator/v0/scan-proxy",
      },
      { type: "system" },
      "e2e",
    );
  }

  it("a withdrawal settles through TransferFactory_Transfer with the treasury's indexed holdings as inputs and the registry's disclosed contracts", async () => {
    await registryMode();
    const f = new LedgerFixture(TEST_TREASURY);
    // The treasury's float: two Canton Coin holdings from earlier deposits.
    await index(f.spliceTransferIn(bob, "2"), f.spliceTransferIn(bob, "10"));
    const holdingCids = (
      await ctx.dataSource.getRepository(LedgerHoldingEntity).find({ order: { amount: "DESC" } })
    ).map((h) => h.contractId);

    const agent = request(ctx.app.getHttpServer() as Server);
    const wallet = makeTestWallet("payee");
    const { cookie } = await signInWithTelegram(agent, nextTelegramUser("Payee"));
    await linkWallet(agent, cookie, wallet);
    ctx.ledger.seedUserWallet(wallet.partyId, { balance: "10", deposited: "10" });
    const payout = ctx.ledger.seedPendingPayout({
      user: wallet.partyId,
      amount: "3",
      reason: "withdraw",
    });

    const res = await agent
      .post(`/api/v1/in-app-wallet/payouts/${payout.contractId}/settle`)
      .set(ctx.csrf)
      .set("x-requested-with", "truthoracle")
      .set("Cookie", cookie)
      .expect(200);
    expect(bodyOf<{ payout: ApiPayout; mode: string }>(res)).toMatchObject({
      mode: "external",
      payout: { status: "settled_external", amount: dec("3") },
    });
    // No Enterprise Wallet transfer: the factory exercise went through externalSubmit, then MarkPaid.
    expect(ctx.wallet.transfers).toEqual([]);
    const { transferCommandId, markPaidCommandId } = commandIdsFor(payout.contractId);
    expect(ctx.wallet.submits.map((s) => s.commandId)).toEqual([
      transferCommandId,
      markPaidCommandId,
    ]);
    const [transfer] = ctx.wallet.submits[0].commands as LedgerCommand[];
    expect(transfer.ExerciseCommand).toMatchObject({
      templateId:
        "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
      contractId: ctx.registry.factoryId,
      choice: "TransferFactory_Transfer",
    });
    const arg = transfer.ExerciseCommand!.choiceArgument as {
      expectedAdmin: string;
      transfer: {
        sender: string;
        receiver: string;
        amount: string;
        instrumentId: unknown;
        inputHoldingCids: string[];
        meta: { values: Record<string, string> };
      };
      extraArgs: { context: unknown };
    };
    expect(arg.expectedAdmin).toBe(TEST_DSO);
    expect(arg.transfer).toMatchObject({
      sender: TEST_TREASURY,
      receiver: wallet.partyId,
      amount: dec("3"),
      instrumentId: TEST_COLLATERAL,
      // Largest first: the 10 CC holding alone covers 3 CC.
      inputHoldingCids: [holdingCids[0]],
    });
    expect(arg.transfer.meta.values).toMatchObject({
      "truthoracle/reason": "withdraw",
      "truthoracle/pending_payout_cid": payout.contractId,
    });
    expect(arg.extraArgs.context).toEqual(
      expect.objectContaining({ values: expect.any(Object) as unknown }),
    );
    expect(ctx.wallet.submits[0].disclosedContracts).toHaveLength(2);
    expect(ctx.registry.calls).toEqual([
      expect.objectContaining({ instrument: "Amulet", kind: "transferFactory" }),
    ]);
    const row = await ctx.dataSource
      .getRepository(PayoutEntity)
      .findOneByOrFail({ pendingPayoutCid: payout.contractId });
    expect(row.details).toMatchObject({ transferMode: "registry", sent: dec("3"), dust: dec("0") });
  });

  it("refuses with 409 insufficient_treasury_holdings when the indexed float does not cover the payout; the row waits in settling", async () => {
    await registryMode();
    const f = new LedgerFixture(TEST_TREASURY);
    await index(f.spliceTransferIn(bob, "1"));
    const agent = request(ctx.app.getHttpServer() as Server);
    const wallet = makeTestWallet("payee2");
    const { cookie } = await signInWithTelegram(agent, nextTelegramUser("Payee2"));
    await linkWallet(agent, cookie, wallet);
    const payout = ctx.ledger.seedPendingPayout({
      user: wallet.partyId,
      amount: "3",
      reason: "withdraw",
    });
    const res = await agent
      .post(`/api/v1/in-app-wallet/payouts/${payout.contractId}/settle`)
      .set(ctx.csrf)
      .set("x-requested-with", "truthoracle")
      .set("Cookie", cookie)
      .expect(409);
    expect(bodyOf<ErrorBody>(res)).toMatchObject({
      error: "insufficient_treasury_holdings",
      details: { requested: dec("3"), spendable: dec("1"), holdings: 1 },
    });
    expect(ctx.wallet.submits).toEqual([]);
    expect(ctx.ledger.payouts.has(payout.contractId)).toBe(true);
    expect(
      await ctx.dataSource
        .getRepository(PayoutEntity)
        .findOneByOrFail({ pendingPayoutCid: payout.contractId }),
    ).toMatchObject({ status: "settling", attempts: 1 });
  });
});

describe("admin: setup action and ledger reads", () => {
  it("POST /admin/instruments/:admin/:id/setup exercises the configured factory choices as the treasury, audited token.setup", async () => {
    const headers = await adminHeaders();
    const path = `/api/v1/admin/instruments/${encodeURIComponent(TEST_TRO_ADMIN)}/TRO/setup`;
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent.post(path).set(headers).send({ reason: "nothing" }).expect(400),
      ).error,
    ).toBe("validation_failed");
    const res = await ctx.agent
      .post(path)
      .set(headers)
      .send({ autoAccept: true, mintDelegation: true, reason: "DevNet onboarding" })
      .expect(200);
    const body = bodyOf<ApiInstrumentSetupResult>(res);
    expect(body).toMatchObject({
      instrument: expect.objectContaining({ id: "TRO" }) as unknown,
      factoryId: ctx.registry.factoryId,
      factoryTemplateId: ctx.registry.factoryTemplateId,
    });
    expect(body.actions.map((a) => [a.kind, a.choice])).toEqual([
      ["autoAccept", "CreateAutoAccept"],
      ["mintDelegation", "CreateMintDelegation"],
    ]);
    expect(ctx.registry.calls).toEqual([
      expect.objectContaining({ instrument: "TRO", kind: "transferFactory" }),
    ]);
    const commands = ctx.wallet.submits.map(
      (s) => (s.commands as LedgerCommand[])[0].ExerciseCommand,
    );
    expect(commands).toEqual([
      {
        templateId: ctx.registry.factoryTemplateId,
        contractId: ctx.registry.factoryId,
        choice: "CreateAutoAccept",
        choiceArgument: { receiver: TEST_TREASURY },
      },
      {
        templateId: ctx.registry.factoryTemplateId,
        contractId: ctx.registry.factoryId,
        choice: "CreateMintDelegation",
        choiceArgument: { recipient: TEST_TREASURY },
      },
    ]);
    expect(ctx.wallet.submits.map((s) => s.commandId)).toEqual([
      expect.stringMatching(/^setup-autoaccept-/),
      expect.stringMatching(/^setup-mintdelegation-/),
    ]);
    const audits = await ctx.dataSource
      .getRepository(AuditEventEntity)
      .find({ where: { action: "token.setup" } });
    expect(audits.map((a) => a.metadata.kind).sort()).toEqual(["autoAccept", "mintDelegation"]);
    expect(audits[0]).toMatchObject({ actorType: "admin", subjectType: "instrument" });
    // The ids are deterministic per instrument, action and treasury: a repeat collides on command
    // dedup (the AutoAccept exists) and surfaces as the wallet's refusal, never a second create.
    await ctx.agent.post(path).set(headers).send({ autoAccept: true, reason: "again" }).expect(502);
    expect(ctx.wallet.submits).toHaveLength(2);
  });

  it("the setup action exercises the instrument's configured choice names (setupChoices) instead of the defaults", async () => {
    const headers = await adminHeaders();
    await ctx
      .get(InstrumentsService)
      .update(
        TEST_TRO_ADMIN,
        "TRO",
        { setupChoices: { autoAccept: "TroFactory_CreateAutoAccept" } },
        { type: "system" },
      );
    const res = await ctx.agent
      .post(`/api/v1/admin/instruments/${encodeURIComponent(TEST_TRO_ADMIN)}/TRO/setup`)
      .set(headers)
      .send({ autoAccept: true, reason: "TRO factory" })
      .expect(200);
    expect(bodyOf<ApiInstrumentSetupResult>(res).actions).toEqual([
      expect.objectContaining({ kind: "autoAccept", choice: "TroFactory_CreateAutoAccept" }),
    ]);
    expect((ctx.wallet.submits[0].commands as LedgerCommand[])[0].ExerciseCommand?.choice).toBe(
      "TroFactory_CreateAutoAccept",
    );
  });

  it("GET /admin/ledger/holdings, /transfer-instructions and /transfers expose the instrument and amount, with filters", async () => {
    const f = new LedgerFixture(TEST_TREASURY);
    const inbound = f.tokenTransferIn(alice, "25.5", { instrument: TEST_REWARDS });
    const offer = f.tokenOfferIn(bob, "7", { instrument: TEST_REWARDS });
    await index(inbound.tx, offer.tx, f.spliceTransferIn(alice, "2"));
    const headers = await adminHeaders();
    const troKey = encodeURIComponent(`${TEST_TRO_ADMIN}:TRO`);

    const holdings = bodyOf<ApiPage<ApiLedgerHolding>>(
      await ctx.agent
        .get(`/api/v1/admin/ledger/holdings?active=true&instrument=${troKey}`)
        .set(headers)
        .expect(200),
    );
    expect(holdings.items).toEqual([
      {
        contractId: inbound.treasuryHoldingCid,
        owner: TEST_TREASURY,
        instrument: expect.objectContaining({ id: "TRO", symbol: "TRO", decimals: 6 }) as unknown,
        amount: dec("25.5"),
        locked: false,
        lockExpiresAt: null,
        createdOffset: inbound.tx.offset,
        active: true,
      },
    ]);
    expect(
      bodyOf<ApiPage<ApiLedgerHolding>>(
        await ctx.agent.get("/api/v1/admin/ledger/holdings").set(headers).expect(200),
      ).total,
    ).toBe(2);

    const instructions = bodyOf<ApiPage<ApiTransferInstruction>>(
      await ctx.agent
        .get("/api/v1/admin/ledger/transfer-instructions?status=pending")
        .set(headers)
        .expect(200),
    );
    expect(instructions.items).toEqual([
      {
        contractId: offer.instructionCid,
        instrument: expect.objectContaining({ id: "TRO" }) as unknown,
        sender: bob,
        receiver: TEST_TREASURY,
        amount: dec("7"),
        executeBefore: expect.any(String) as string,
        status: "pending",
        createdOffset: offer.tx.offset,
      },
    ]);
    expect(
      bodyOf<ApiPage<unknown>>(
        await ctx.agent
          .get(`/api/v1/admin/ledger/transfer-instructions?party=${encodeURIComponent(alice)}`)
          .set(headers)
          .expect(200),
      ).total,
    ).toBe(0);

    const transfers = bodyOf<ApiPage<ApiLedgerTransfer>>(
      await ctx.agent.get("/api/v1/admin/ledger/transfers").set(headers).expect(200),
    );
    expect(transfers.items.map((t) => [t.kind, t.instrument.id, t.amount, t.counterparty])).toEqual(
      [
        ["amulet", "Amulet", dec("2"), alice],
        ["token_standard", "TRO", dec("25.5"), alice],
      ],
    );
    expect(
      bodyOf<ApiPage<ApiLedgerTransfer>>(
        await ctx.agent
          .get(`/api/v1/admin/ledger/transfers?instrument=${troKey}`)
          .set(headers)
          .expect(200),
      ).items.map((t) => t.instrument.id),
    ).toEqual(["TRO"]);
    await ctx.agent.get("/api/v1/admin/ledger/transfers?instrument=nope").set(headers).expect(400);

    // The user's own view filters the same way.
    const { cookie } = await issueSessionDirect(ctx, { ...makeTestWallet("a"), partyId: alice });
    const mine = bodyOf<ApiPage<ApiLedgerTransfer>>(
      await ctx.agent
        .get(`/api/v1/in-app-wallet/transfers?instrument=${troKey}`)
        .set("Cookie", cookie)
        .expect(200),
    );
    expect(mine.items.map((t) => [t.instrument.symbol, t.amount])).toEqual([["TRO", dec("25.5")]]);
  });
});
