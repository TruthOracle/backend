/**
 * Review F0: resolving or voiding a market is the four-eyes `market.resolve` — the only way any
 * market, of any collateral, is resolved. `ops` requests ResolveT0 / Resolve / VoidMarket of a
 * market id; another person with `approver` approves; the backend exercises the choice on the
 * market's CURRENT contract treasury-signed through the Enterprise Wallet, with its own clock as
 * `nowSeconds`. Request and execution need a fresh index and judge status, window, policy and
 * attestations by the backend clock. The last blocks run the dev single-control path
 * (RAMP_DUAL_CONTROL=false), with and without signed requests (C23).
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { AdminApprovalEntity } from "../src/entities/admin-approval.entity";
import type { LedgerTransaction } from "../src/indexer/events";
import { IndexerService } from "../src/services/indexer.service";
import type { ApiApproval, InstrumentId } from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { TEST_DSO, TEST_TREASURY, type TestApp, useTestApp } from "./helpers/app";
import {
  FIXTURE_TOKEN,
  LedgerFixture,
  type MarketFixtureState,
  type Payload,
  parties,
} from "./helpers/ledger-fixtures";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const SRC = "https://source.test/price";
const DAY = 86_400;
const TEMPLATE = "fakepkg:Truthoracle:PredictionMarket";

/** `GET /admin/markets/:marketId/resolution` (typed here: the spec must also run on the baseline). */
interface ResolutionView {
  market: Record<string, unknown> & { marketId: string; status: string; outcome: string | null };
  windows: { resolveT0From: string; resolveT0To: string; resolveFrom: string; voidFrom: string };
  choicesAvailable: string[];
  pending: ApiApproval | null;
  lastSubmission?: Record<string, unknown> | null;
  attestations?: Record<string, unknown>[];
  asOf: string;
}
interface Executed {
  approval: ApiApproval;
  result: { marketId: string; choice: string; commandId: string; status?: string };
}
interface Exercise {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/** Ledger fixtures, the admin calls and the reads every block uses. */
function kit(ctx: TestApp) {
  let f = new LedgerFixture(TEST_TREASURY);
  beforeEach(() => {
    f = new LedgerFixture(TEST_TREASURY);
  });

  async function index(...txs: LedgerTransaction[]): Promise<void> {
    ctx.stream.push(...txs);
    await ctx.get(IndexerService).runOnce();
  }

  async function openMarket(input: {
    marketId: number;
    expiresAt: number;
    policy?: Partial<Payload>;
    collateral?: InstrumentId;
  }): Promise<MarketFixtureState> {
    const { tx, market } = f.createMarket({ createdAt: input.expiresAt - 30 * DAY, ...input });
    await index(tx);
    return market;
  }

  /**
   * A pool action lands (a Buy here; after expiry the ledger's own would be a LiquidityPosition
   * exit — the index treats both alike): a successor contract with new pool figures, indexed.
   */
  async function trade(
    market: MarketFixtureState,
    collateral?: InstrumentId,
    opts: { buyer?: string; indexed?: boolean } = {},
  ): Promise<MarketFixtureState> {
    const [trader] = opts.buyer
      ? [opts.buyer]
      : parties(1, `trader${String(market.payload.marketId)}`);
    const w = f.createWallet(trader, collateral);
    const funded = f.deposit(w.wallet, "50", `dep-${trader.slice(0, 12)}-${market.cid}`);
    const traded = f.buy({
      market,
      wallet: funded.wallet,
      buyer: trader,
      side: "No",
      amount: "10",
    });
    // Not indexed: the trade is on the ledger only (the index trails it, still within freshness).
    if (opts.indexed === false) ctx.stream.push(w.tx, funded.tx, traded.tx);
    else await index(w.tx, funded.tx, traded.tx);
    expect(traded.market.cid).not.toBe(market.cid);
    return traded.market;
  }

  /** `provider` holds LP shares of market `marketId` (a LiquidityPosition, indexed). */
  async function lpShares(marketId: number, provider: string): Promise<void> {
    const lp = f.created(
      "LiquidityPosition",
      f.cid("lp"),
      {
        provider,
        admin: TEST_TREASURY,
        marketId: String(marketId),
        lpTokens: "5.0000000000",
        deposited: "5.0000000000",
        auditObservers: [],
      },
      { signatories: [TEST_TREASURY], observers: [provider] },
    );
    await index(f.tx([lp]));
  }

  /** An OutcomeAttestation (attester signs, the treasury observes), indexed; returns its cid. */
  async function attest(input: {
    marketId: number;
    attester: string;
    fetchedAt: number;
    outcome?: "Yes" | "No" | "VoidOutcome";
    sourceUri?: string;
    payloadHash?: string;
    signature?: string;
  }): Promise<string> {
    const cid = f.cid("at");
    const payload = {
      attester: input.attester,
      admin: TEST_TREASURY,
      marketId: String(input.marketId),
      sourceUri: input.sourceUri ?? SRC,
      fetchedAt: String(input.fetchedAt),
      outcome: input.outcome ?? "Yes",
      payloadHash: input.payloadHash ?? "ab".repeat(32),
      sourceSignature: input.signature ?? null,
      responseExcerpt: null,
    };
    const created = f.created("OutcomeAttestation", cid, payload, {
      signatories: [input.attester],
      observers: [TEST_TREASURY],
    });
    await index(f.tx([created]));
    return cid;
  }

  async function headers(w: TestWallet): Promise<Record<string, string>> {
    const { cookie } = await issueSessionDirect(ctx, w, { kind: "admin" });
    return { Cookie: cookie, ...ctx.csrf };
  }

  async function ask<T = { approval: ApiApproval }>(
    w: TestWallet,
    marketId: number | string,
    body: Record<string, unknown>,
    status: number,
  ): Promise<T> {
    const res = await ctx.agent
      .post(`/api/v1/admin/markets/${marketId}/resolution`)
      .set(await headers(w))
      .send({ reason: "the source published the result", ...body })
      .expect(status);
    return bodyOf<T>(res);
  }

  async function view<T = ResolutionView>(
    w: TestWallet,
    marketId: number | string,
    status = 200,
  ): Promise<T> {
    const res = await ctx.agent
      .get(`/api/v1/admin/markets/${marketId}/resolution`)
      .set(await headers(w))
      .expect(status);
    return bodyOf<T>(res);
  }

  async function approve<T = Executed>(w: TestWallet, a: ApiApproval, status: number): Promise<T> {
    const res = await ctx.agent
      .post(`/api/v1/admin/approvals/${a.id}/approve`)
      .set(await headers(w))
      .send({
        reason: "checked the source",
        signature: w.sign(`truthoracle-approval:${a.id}:${a.paramsHash}:approve`),
      })
      .expect(status);
    return bodyOf<T>(res);
  }

  async function audits(marketId: string): Promise<{ action: string; metadata: Payload }[]> {
    return ctx.dataSource.query(
      `SELECT action, metadata FROM to_audit_events
        WHERE subject_type = 'market' AND subject_id = $1 ORDER BY id`,
      [marketId],
    );
  }

  /** The one exercise the treasury submitted, with its command id. */
  function submitted(): { commandId: string; exercise: Exercise["ExerciseCommand"] } {
    expect(ctx.wallet.submits).toHaveLength(1);
    const [s] = ctx.wallet.submits;
    expect(s.commands).toHaveLength(1);
    return { commandId: s.commandId, exercise: (s.commands[0] as Exercise).ExerciseCommand };
  }

  return {
    fx: () => f,
    index,
    openMarket,
    trade,
    lpShares,
    attest,
    ask,
    view,
    approve,
    audits,
    submitted,
  };
}

const alice = makeTestWallet("mr-alice"); // ops
const bob = makeTestWallet("mr-bob"); // approver
const carol = makeTestWallet("mr-carol"); // ops + approver
const erin = makeTestWallet("mr-erin"); // aml only

describe("market.resolve: four eyes, signed decisions (RAMP_DUAL_CONTROL / RAMP_APPROVAL_SIGNATURES on)", () => {
  const ctx = useTestApp({
    env: {
      RAMP_DUAL_CONTROL: "true",
      RAMP_APPROVAL_SIGNATURES: "true",
      ADMIN_OPERATORS: [
        `${alice.partyId}#alice@ops`,
        `${bob.partyId}#bob@approver`,
        `${carol.partyId}#carol@ops+approver`,
        `${erin.partyId}#erin@aml`,
      ].join(","),
    },
  });
  const k = kit(ctx);

  it("GET: the decision fields, the windows in UTC, the choices open by the backend clock and the pending request — ops or approver only", async () => {
    const t = nowSec();
    await k.openMarket({ marketId: 3, expiresAt: t - 3_600 });
    await k.openMarket({ marketId: 4, expiresAt: t + 3_600 });
    const [r1, r2] = parties(2, "reporter");
    await k.openMarket({
      marketId: 5,
      expiresAt: t - 2 * DAY,
      policy: { operatorResolution: false, reporters: [r1, r2], quorum: "2" },
    });
    const v = await k.view(alice, 3);
    expect(v).toEqual({
      market: {
        marketId: "3",
        ticker: "TEST-3",
        question: "Market 3?",
        status: "Trading",
        expiresAt: iso(t - 3_600),
        gracePeriodSecs: DAY,
        collateral: expect.objectContaining({
          admin: TEST_DSO,
          id: "Amulet",
          symbol: "CC",
        }) as object,
        operatorResolution: true,
        sources: [SRC],
        outcome: null,
      },
      windows: {
        resolveT0From: iso(t - 3_600),
        resolveT0To: iso(t - 3_600 + DAY),
        resolveFrom: iso(t - 3_600),
        voidFrom: iso(t - 3_600 + DAY + 1),
      },
      // No reporter quorum and no pinned key: no attestation could ever resolve it.
      choicesAvailable: ["ResolveT0"],
      pending: null,
      lastSubmission: null,
      attestations: [],
      asOf: expect.any(String) as string,
    });
    expect(Math.abs(Date.parse(v.asOf) / 1000 - t)).toBeLessThan(60);
    expect((await k.view(bob, 4)).choicesAvailable).toEqual([]);
    expect((await k.view(bob, 5)).choicesAvailable).toEqual(["Resolve", "VoidMarket"]);

    const asked = await k.ask(
      alice,
      3,
      { choice: "ResolveT0", outcome: "No", sourceUri: SRC },
      202,
    );
    expect((await k.view(bob, "03")).pending).toMatchObject({
      id: asked.approval.id,
      action: "market.resolve",
      status: "pending",
    });
    expect((await k.view<ErrorBody>(erin, 3, 403)).error).toBe("role_required");
    expect(await k.view<ErrorBody>(alice, 99, 404)).toMatchObject({
      error: "not_found",
      message: "market #99 is not indexed",
    });
    expect((await k.view<ErrorBody>(alice, "3x", 400)).error).toBe("validation_failed");
  });

  it("ResolveT0: ops asks (202, nothing submitted); a trade re-creates the contract; another person approves → the treasury exercises the CURRENT contract with the backend's clock", async () => {
    const t = nowSec();
    const m = await k.openMarket({ marketId: 1, expiresAt: t - 3_600 });
    const asked = await k.ask(
      alice,
      1,
      { choice: "ResolveT0", outcome: "Yes", sourceUri: SRC },
      202,
    );
    expect(asked.approval).toMatchObject({
      action: "market.resolve",
      subjectType: "market",
      subjectId: "1",
      status: "pending",
      singleControl: false,
      requestedByPerson: "alice",
      params: { choice: "ResolveT0", outcome: "Yes", sourceUri: SRC },
      description: `ResolveT0 market #1 (TEST-1) → Yes from ${SRC}`,
    });
    // The decision fields only: no contract id, no pool figures.
    expect(asked.approval.precondition).toEqual({
      marketId: "1",
      ticker: "TEST-1",
      question: "Market 1?",
      status: "Trading",
      expiresAt: iso(t - 3_600),
      gracePeriodSecs: DAY,
      collateral: { admin: TEST_DSO, id: "Amulet" },
      operatorResolution: true,
      sources: [SRC],
      outcome: null,
    });
    expect(ctx.wallet.submits).toHaveLength(0);

    // A pool action lands while the request waits: a new contract id, new pool figures.
    const traded = { market: await k.trade(m) };

    const before = nowSec();
    const done = await k.approve(bob, asked.approval, 200);
    const after = nowSec();
    expect(done.approval).toMatchObject({ status: "executed", decidedByPerson: "bob" });
    const commandId = `market-resolve-1-${asked.approval.id}`;
    expect(done.result).toEqual({
      marketId: "1",
      choice: "ResolveT0",
      commandId,
      status: "succeeded",
    });
    const { commandId: sent, exercise } = k.submitted();
    expect(sent).toBe(commandId);
    expect(exercise).toEqual({
      templateId: TEMPLATE,
      contractId: traded.market.cid,
      choice: "ResolveT0",
      choiceArgument: {
        resolvedOutcome: "Yes",
        sourceUri: SRC,
        nowSeconds: expect.any(String) as string,
      },
    });
    const seconds = Number(exercise.choiceArgument.nowSeconds);
    expect(seconds).toBeGreaterThanOrEqual(before);
    expect(seconds).toBeLessThanOrEqual(after);

    const trail = await k.audits("1");
    expect(trail.map((r) => r.action)).toEqual([
      "admin.approval.requested",
      "market.resolution_submitted",
      "admin.approval.executed",
    ]);
    expect(trail[1].metadata).toMatchObject({
      marketId: "1",
      choice: "ResolveT0",
      outcome: "Yes",
      commandId,
      approvalId: asked.approval.id,
      contractId: traded.market.cid,
      nowSeconds: seconds,
    });

    // The ledger accepts it; the indexer projects the outcome as for any resolution.
    await k.index(k.fx().resolveT0(traded.market, "Yes", seconds).tx);
    expect(await k.view(alice, 1)).toMatchObject({
      market: { status: "Resolved", outcome: "Yes" },
      choicesAvailable: [],
      pending: null,
    });
  });

  it("Resolve of a cBYN market from a reporter quorum: the attestations are snapshotted and submitted in the order asked", async () => {
    const t = nowSec();
    const [r1, r2] = parties(2, "reporter");
    const m = await k.openMarket({
      marketId: 2,
      expiresAt: t - 7_200,
      collateral: FIXTURE_TOKEN,
      policy: { operatorResolution: false, reporters: [r1, r2], quorum: "2" },
    });
    const a1 = await k.attest({ marketId: 2, attester: r1, fetchedAt: t - 7_000, outcome: "No" });
    const a2 = await k.attest({ marketId: 2, attester: r2, fetchedAt: t - 6_000, outcome: "No" });
    const asked = await k.ask(alice, 2, { choice: "Resolve", attestationCids: [a2, a1] }, 202);
    expect(asked.approval).toMatchObject({
      params: { choice: "Resolve", attestationCids: [a2, a1] },
      description: "Resolve market #2 (TEST-2) → No from 2 attestations",
      precondition: {
        collateral: { admin: FIXTURE_TOKEN.admin, id: "cBYN" },
        operatorResolution: false,
        attestations: [
          { cid: a2, outcome: "No", sourceUri: SRC, fetchedAt: iso(t - 6_000) },
          { cid: a1, outcome: "No", sourceUri: SRC, fetchedAt: iso(t - 7_000) },
        ],
      },
    });
    const current = await k.trade(m, FIXTURE_TOKEN);
    const before = nowSec();
    const done = await k.approve(carol, asked.approval, 200);
    const after = nowSec();
    expect(done.result).toEqual({
      marketId: "2",
      choice: "Resolve",
      commandId: `market-resolve-2-${asked.approval.id}`,
      status: "succeeded",
    });
    const { exercise } = k.submitted();
    expect(exercise).toEqual({
      templateId: TEMPLATE,
      contractId: current.cid,
      choice: "Resolve",
      choiceArgument: { attestationCids: [a2, a1], nowSeconds: expect.any(String) as string },
    });
    const seconds = Number(exercise.choiceArgument.nowSeconds);
    expect(seconds >= before && seconds <= after).toBe(true);
    expect(
      (await k.audits("2")).find((r) => r.action === "market.resolution_submitted"),
    ).toMatchObject({
      metadata: { marketId: "2", choice: "Resolve", outcome: "No", attestationCids: [a2, a1] },
    });
  });

  it("Resolve from a first-party source (T1): the pinned key's signature over the payload is accepted, another key's is refused", async () => {
    const t = nowSec();
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const key = publicKey.export({ type: "spki", format: "der" }).toString("hex");
    const payloadHash = createHash("sha256").update("ECB fixing 2026-10-19").digest("hex");
    const signed = (k2 = privateKey) =>
      sign("sha256", Buffer.from(payloadHash, "hex"), k2).toString("hex");
    const [desk] = parties(1, "desk");
    await k.openMarket({
      marketId: 6,
      expiresAt: t - 3_600,
      policy: { sourceKeys: [{ sourceUri: SRC, publicKey: key }] },
    });
    const forged = await k.attest({
      marketId: 6,
      attester: desk,
      fetchedAt: t - 3_000,
      payloadHash,
      signature: signed(generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey),
    });
    expect(
      await k.ask<ErrorBody>(alice, 6, { choice: "Resolve", attestationCids: [forged] }, 409),
    ).toMatchObject({ error: "market_not_resolvable", details: { reason: "no_tier" } });
    const genuine = await k.attest({
      marketId: 6,
      attester: desk,
      fetchedAt: t - 3_000,
      payloadHash,
      signature: signed(),
    });
    const asked = await k.ask(alice, 6, { choice: "Resolve", attestationCids: [genuine] }, 202);
    await k.approve(bob, asked.approval, 200);
    expect(k.submitted().exercise).toMatchObject({
      choice: "Resolve",
      choiceArgument: { attestationCids: [genuine] },
    });
  });

  it("VoidMarket after the grace period: a wallet failure fails that approval (nothing recorded as submitted); a new request gets its own command id", async () => {
    const t = nowSec();
    const m = await k.openMarket({ marketId: 7, expiresAt: t - 2 * DAY });
    const first = await k.ask(alice, 7, { choice: "VoidMarket" }, 202);
    expect(first.approval).toMatchObject({
      params: { choice: "VoidMarket" },
      description: `VoidMarket market #7 (TEST-7) → Void from no resolution by ${iso(t - DAY)}`,
    });
    ctx.wallet.failNext = new Error("wallet down");
    const failed = await k.approve<ErrorBody>(bob, first.approval, 409);
    expect(failed.error).toBe("approval_failed");
    expect(
      await ctx.dataSource
        .getRepository(AdminApprovalEntity)
        .findOneByOrFail({ id: first.approval.id }),
    ).toMatchObject({ status: "failed" });
    expect((await k.audits("7")).map((r) => r.action)).not.toContain("market.resolution_submitted");

    const again = await k.ask(alice, 7, { choice: "VoidMarket" }, 202);
    expect(again.approval.id).not.toBe(first.approval.id);
    const current = await k.trade(m);
    const before = nowSec();
    const done = await k.approve(bob, again.approval, 200);
    const after = nowSec();
    expect(done.result).toEqual({
      marketId: "7",
      choice: "VoidMarket",
      commandId: `market-resolve-7-${again.approval.id}`,
      status: "succeeded",
    });
    const { exercise } = k.submitted();
    expect(exercise).toEqual({
      templateId: TEMPLATE,
      contractId: current.cid,
      choice: "VoidMarket",
      choiceArgument: { nowSeconds: expect.any(String) as string },
    });
    const seconds = Number(exercise.choiceArgument.nowSeconds);
    expect(seconds >= before && seconds <= after).toBe(true);
    expect(
      (await k.audits("7")).find((r) => r.action === "market.resolution_submitted"),
    ).toMatchObject({ metadata: { choice: "VoidMarket", outcome: "Void" } });
  });

  it("refused at request by the backend clock, status and policy (409 market_not_resolvable; nothing stored or submitted)", async () => {
    const t = nowSec();
    await k.openMarket({ marketId: 10, expiresAt: t + 3_600 });
    await k.openMarket({ marketId: 11, expiresAt: t - 2 * DAY });
    await k.openMarket({
      marketId: 12,
      expiresAt: t - 3_600,
      policy: { operatorResolution: false },
    });
    const settled = await k.openMarket({ marketId: 13, expiresAt: t - 2 * DAY });
    await k.index(k.fx().resolveT0(settled, "No", t - DAY - 60).tx);
    await k.openMarket({ marketId: 14, expiresAt: t - 3_600 });
    const t0 = { choice: "ResolveT0", outcome: "Yes", sourceUri: SRC };
    const cases: [number, Record<string, unknown>, string][] = [
      [10, t0, "not_expired"],
      [10, { choice: "Resolve", attestationCids: ["00at-none"] }, "not_expired"],
      [10, { choice: "VoidMarket" }, "grace_not_elapsed"],
      [11, t0, "window_closed"],
      [12, t0, "operator_resolution_off"],
      [13, t0, "status"],
      [13, { choice: "Resolve", attestationCids: ["00at-none"] }, "status"],
      [13, { choice: "VoidMarket" }, "status"],
      [14, { ...t0, sourceUri: "https://elsewhere.test/x" }, "source_not_allowed"],
      [14, { choice: "VoidMarket" }, "grace_not_elapsed"],
    ];
    for (const [marketId, body, reason] of cases)
      expect(await k.ask<ErrorBody>(alice, marketId, body, 409)).toMatchObject({
        error: "market_not_resolvable",
        details: { reason, choice: body.choice, marketId: String(marketId) },
      });
    expect(await ctx.dataSource.getRepository(AdminApprovalEntity).count()).toBe(0);
    expect(ctx.wallet.submits).toHaveLength(0);
  });

  it("Resolve refuses an attestation that is unknown, archived, of another market, off the allowlist, read outside the window — and a set without a tier or agreement", async () => {
    const t = nowSec();
    const [r1, r2, outsider] = parties(3, "reporter");
    const policy = { reporters: [r1, r2], quorum: "2" };
    await k.openMarket({ marketId: 20, expiresAt: t - 7_200, policy });
    await k.openMarket({ marketId: 21, expiresAt: t - 7_200, policy });
    const at = (input: Partial<Parameters<typeof k.attest>[0]>) =>
      k.attest({ marketId: 20, attester: r2, fetchedAt: t - 7_000, ...input });
    const good = await at({ attester: r1 });
    const second = await at({});
    const other = await at({ marketId: 21 });
    const early = await at({ fetchedAt: t - 7_201 });
    const late = await at({ fetchedAt: t - 7_200 + DAY + 1 });
    const offList = await at({ sourceUri: "https://elsewhere.test/x" });
    const dissent = await at({ attester: outsider, outcome: "No" });
    const archived = await at({});
    const f = k.fx();
    await k.index(f.tx([f.exercised("OutcomeAttestation", archived, "ArchiveAttestation", {})]));
    const cases: [string[], string][] = [
      [[good, "00at-unknown"], "attestation_unknown"],
      [[good, archived], "attestation_archived"],
      [[good, other], "attestation_other_market"],
      [[good, offList], "attestation_source"],
      [[good, early], "attestation_window"],
      [[good, late], "attestation_window"],
      [[good], "no_tier"],
      [[good, second, dissent], "attestations_disagree"],
    ];
    for (const [attestationCids, reason] of cases)
      expect(
        await k.ask<ErrorBody>(alice, 20, { choice: "Resolve", attestationCids }, 409),
      ).toMatchObject({ error: "market_not_resolvable", details: { reason, choice: "Resolve" } });
    // The quorum on its own resolves.
    await k.ask(alice, 20, { choice: "Resolve", attestationCids: [good, second] }, 202);
  });

  it("guards: unknown market 404, unknown or misplaced fields 400, no ops role 403, a stale index 503, one pending request per market, no approving one's own", async () => {
    const t = nowSec();
    await k.openMarket({ marketId: 30, expiresAt: t - 3_600 });
    const t0 = { choice: "ResolveT0", outcome: "Yes", sourceUri: SRC };
    expect(await k.ask<ErrorBody>(alice, 31, t0, 404)).toMatchObject({
      error: "not_found",
      message: "market #31 is not indexed",
    });
    for (const body of [
      { ...t0, nowSeconds: "1700000000" },
      { ...t0, contractId: "00mk-any" },
      { choice: "VoidMarket", outcome: "Void" },
      { choice: "VoidMarket", sourceUri: SRC },
      { choice: "ResolveT0", outcome: "Yes" },
      { choice: "ResolveT0", outcome: "VoidOutcome", sourceUri: SRC },
      { ...t0, sourceUri: "javascript:alert(1)" },
      { ...t0, attestationCids: ["00at-x"] },
      { choice: "Resolve", attestationCids: [] },
      { choice: "Resolve" },
      { choice: "Settle" },
      { ...t0, reason: "" },
    ])
      expect((await k.ask<ErrorBody>(alice, 30, body, 400)).error).toBe("validation_failed");
    expect((await k.ask<ErrorBody>(alice, "30.0", t0, 400)).error).toBe("validation_failed");
    expect((await k.ask<ErrorBody>(bob, 30, t0, 403)).error).toBe("role_required");
    expect((await k.ask<ErrorBody>(erin, 30, t0, 403)).error).toBe("role_required");

    ctx.stream.end = (await ctx.get(IndexerService).currentOffset()) + 1_000;
    expect((await k.ask<ErrorBody>(alice, 30, t0, 503)).error).toBe("ledger_stale");
    ctx.stream.end = null;

    const asked = await k.ask(carol, 30, t0, 202);
    // The same request again answers the pending one; a different one waits its turn.
    expect((await k.ask(alice, "030", t0, 202)).approval.id).toBe(asked.approval.id);
    expect((await k.ask<ErrorBody>(alice, 30, { ...t0, outcome: "No" }, 409)).error).toBe(
      "approval_pending",
    );
    expect((await k.approve<ErrorBody>(carol, asked.approval, 403)).error).toBe("approval_self");
    expect(ctx.wallet.submits).toHaveLength(0);
  });

  it("at approval the subject is re-read: resolved elsewhere meanwhile → approval_precondition_changed, the approval fails, nothing is submitted", async () => {
    const t = nowSec();
    const m = await k.openMarket({ marketId: 40, expiresAt: t - 3_600 });
    const asked = await k.ask(
      alice,
      40,
      { choice: "ResolveT0", outcome: "Yes", sourceUri: SRC },
      202,
    );
    await k.index(k.fx().resolveT0(m, "No", t - 60).tx);
    const refused = await k.approve<ErrorBody>(bob, asked.approval, 409);
    expect(refused).toMatchObject({
      error: "approval_precondition_changed",
      details: { expected: { status: "Trading" }, actual: { status: "Resolved", outcome: "No" } },
    });
    expect(
      await ctx.dataSource
        .getRepository(AdminApprovalEntity)
        .findOneByOrFail({ id: asked.approval.id }),
    ).toMatchObject({ status: "failed" });
    expect(ctx.wallet.submits).toHaveLength(0);
  });

  it("at approval validate runs again on fresh reads: an attestation archived meanwhile (same snapshot) or a stale index refuses", async () => {
    const t = nowSec();
    const [r1, r2] = parties(2, "reporter");
    await k.openMarket({
      marketId: 41,
      expiresAt: t - 7_200,
      policy: { reporters: [r1, r2], quorum: "2" },
    });
    const a1 = await k.attest({ marketId: 41, attester: r1, fetchedAt: t - 7_000 });
    const a2 = await k.attest({ marketId: 41, attester: r2, fetchedAt: t - 7_000 });
    const asked = await k.ask(alice, 41, { choice: "Resolve", attestationCids: [a1, a2] }, 202);
    const f = k.fx();
    await k.index(f.tx([f.exercised("OutcomeAttestation", a2, "ArchiveAttestation", {})]));
    expect(await k.approve<ErrorBody>(bob, asked.approval, 409)).toMatchObject({
      error: "approval_precondition_changed",
      details: { cause: "market_not_resolvable", reason: "attestation_archived", cid: a2 },
    });

    await k.openMarket({ marketId: 42, expiresAt: t - 3_600 });
    const second = await k.ask(
      alice,
      42,
      { choice: "ResolveT0", outcome: "No", sourceUri: SRC },
      202,
    );
    ctx.stream.end = (await ctx.get(IndexerService).currentOffset()) + 1_000;
    expect(await k.approve<ErrorBody>(bob, second.approval, 409)).toMatchObject({
      error: "approval_precondition_changed",
      details: { cause: "ledger_stale" },
    });
    ctx.stream.end = null;
    expect(ctx.wallet.submits).toHaveLength(0);
  });

  const t0 = { choice: "ResolveT0", outcome: "Yes", sourceUri: SRC };

  it("W9g F0: execution exercises the contract the LEDGER holds — a trade the index has not applied yet is honoured", async () => {
    const t = nowSec();
    const m = await k.openMarket({ marketId: 11, expiresAt: t - 3_600 });
    const asked = await k.ask(alice, 11, t0, 202);
    // A trade lands on the ledger; the index has not applied it (3 offsets behind: still fresh).
    const onLedger = await k.trade(m, undefined, { indexed: false });
    expect(await k.view(alice, 11)).toMatchObject({ market: { status: "Trading" } });
    await k.approve(bob, asked.approval, 200);
    expect(k.submitted().exercise).toMatchObject({ contractId: onLedger.cid, choice: "ResolveT0" });
    expect(
      (await k.audits("11")).find((r) => r.action === "market.resolution_submitted"),
    ).toMatchObject({ metadata: { contractId: onLedger.cid } });
  });

  it("W9g F0: a ledger that cannot be read at execution refuses — the approval closes failed, nothing is submitted", async () => {
    const t = nowSec();
    await k.openMarket({ marketId: 17, expiresAt: t - 3_600 });
    const asked = await k.ask(alice, 17, t0, 202);
    ctx.ledger.failReads = new Error("ledger read failed (503)");
    try {
      expect(await k.approve<ErrorBody>(bob, asked.approval, 409)).toMatchObject({
        error: "approval_failed",
        details: { cause: "upstream_failed" },
      });
    } finally {
      ctx.ledger.failReads = null;
    }
    expect(ctx.wallet.submits).toHaveLength(0);
    expect(
      await ctx.dataSource
        .getRepository(AdminApprovalEntity)
        .findOneByOrFail({ id: asked.approval.id }),
    ).toMatchObject({ status: "failed" });
  });

  it("W9g F0: the wallet's word is awaited — a ledger rejection closes the approval failed with its reason (market.resolution_failed); GET lastSubmission follows the latest submission live", async () => {
    const t = nowSec();
    await k.openMarket({ marketId: 12, expiresAt: t - 3_600 });
    expect((await k.view(alice, 12)).lastSubmission).toBeNull();
    const first = await k.ask(alice, 12, { ...t0, outcome: "No" }, 202);
    ctx.wallet.rejectNext = "CONTRACT_NOT_ACTIVE: the market moved";
    expect(await k.approve<ErrorBody>(bob, first.approval, 409)).toMatchObject({
      error: "approval_failed",
      message: expect.stringContaining("CONTRACT_NOT_ACTIVE: the market moved") as string,
      details: { cause: "upstream_failed" },
    });
    const firstId = `market-resolve-12-${first.approval.id}`;
    const trail = await k.audits("12");
    expect(trail.map((r) => r.action)).toEqual([
      "admin.approval.requested",
      "market.resolution_submitted",
      "market.resolution_failed",
      "admin.approval.failed",
    ]);
    expect(trail[2].metadata).toEqual({
      marketId: "12",
      choice: "ResolveT0",
      commandId: firstId,
      error: "CONTRACT_NOT_ACTIVE: the market moved",
    });
    expect((await k.view(alice, 12)).lastSubmission).toEqual({
      commandId: firstId,
      choice: "ResolveT0",
      at: expect.stringMatching(/Z$/) as string,
      status: "failed",
      error: "CONTRACT_NOT_ACTIVE: the market moved",
    });
    // Asked again, it commits: succeeded, and the GET reads the wallet live.
    const second = await k.ask(alice, 12, { ...t0, outcome: "No" }, 202);
    const done = await k.approve(bob, second.approval, 200);
    const secondId = `market-resolve-12-${second.approval.id}`;
    expect(done.result).toEqual({
      marketId: "12",
      choice: "ResolveT0",
      commandId: secondId,
      status: "succeeded",
    });
    expect((await k.view(bob, 12)).lastSubmission).toMatchObject({
      commandId: secondId,
      status: "succeeded",
      error: null,
    });
    // The wallet's index cannot be read: unknown, not an error.
    ctx.wallet.statusReadsFail = true;
    expect((await k.view(bob, 12)).lastSubmission).toMatchObject({
      commandId: secondId,
      status: "unknown",
    });
  });

  it("W9g F0: no word from the wallet within 15 s → the result reads submitted, as does the GET", async () => {
    const t = nowSec();
    await k.openMarket({ marketId: 18, expiresAt: t - 3_600 });
    const asked = await k.ask(alice, 18, t0, 202);
    // Accepted, never applied: the command index keeps answering `submitted`.
    ctx.wallet.lagLedger = true;
    const started = Date.now();
    const done = await k.approve(bob, asked.approval, 200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
    expect(done.result).toMatchObject({ status: "submitted" });
    expect((await k.view(alice, 18)).lastSubmission).toMatchObject({
      commandId: `market-resolve-18-${asked.approval.id}`,
      status: "submitted",
      error: null,
    });
  }, 40_000);

  it("W9g F0: GET lists every indexed active attestation of the market with validate's own verdict — usable, or the reason", async () => {
    const t = nowSec();
    const [r1, r2] = parties(2, "reporter13");
    const policy = { operatorResolution: false, reporters: [r1, r2], quorum: "2" };
    await k.openMarket({ marketId: 13, expiresAt: t - 7_200, policy });
    await k.openMarket({ marketId: 14, expiresAt: t - 7_200, policy });
    const good = await k.attest({
      marketId: 13,
      attester: r1,
      fetchedAt: t - 7_000,
      outcome: "No",
    });
    const early = await k.attest({ marketId: 13, attester: r2, fetchedAt: t - 7_201 });
    const offList = await k.attest({
      marketId: 13,
      attester: r2,
      fetchedAt: t - 6_000,
      sourceUri: "https://elsewhere.test/x",
    });
    const archived = await k.attest({ marketId: 13, attester: r2, fetchedAt: t - 6_500 });
    const f = k.fx();
    await k.index(f.tx([f.exercised("OutcomeAttestation", archived, "ArchiveAttestation", {})]));
    await k.attest({ marketId: 14, attester: r1, fetchedAt: t - 7_000 });
    expect((await k.view(alice, 13)).attestations).toEqual([
      {
        cid: good,
        outcome: "No",
        sourceUri: SRC,
        fetchedAt: iso(t - 7_000),
        usable: true,
        reason: null,
      },
      {
        cid: early,
        outcome: "Yes",
        sourceUri: SRC,
        fetchedAt: iso(t - 7_201),
        usable: false,
        reason: "attestation_window",
      },
      {
        cid: offList,
        outcome: "Yes",
        sourceUri: "https://elsewhere.test/x",
        fetchedAt: iso(t - 6_000),
        usable: false,
        reason: "attestation_source",
      },
    ]);
    // Validate names the same reasons for the same attestations.
    for (const [cid, reason] of [
      [early, "attestation_window"],
      [offList, "attestation_source"],
    ])
      expect(
        await k.ask<ErrorBody>(alice, 13, { choice: "Resolve", attestationCids: [good, cid] }, 409),
      ).toMatchObject({ details: { reason, cid } });
  });

  it("W9g F0 (I8): nobody holding a stake in the market — through their operator party or a linked account — requests or approves its resolution; without one it executes", async () => {
    const t = nowSec();
    const m = await k.openMarket({ marketId: 15, expiresAt: t - 3_600 });
    const links = ctx.config.rampControls.operatorAccounts;
    // Alice's own party holds a position: her request is refused, nothing stored.
    await k.trade(m, undefined, { buyer: alice.partyId });
    expect(await k.ask<ErrorBody>(alice, 15, t0, 403)).toMatchObject({
      error: "approval_linked_person",
      details: { person: "alice", reason: "position_in_market", marketId: "15" },
    });
    expect(await ctx.dataSource.getRepository(AdminApprovalEntity).count()).toBe(0);
    // Carol asks; Bob's personal account (ADMIN_OPERATOR_ACCOUNTS) holds LP shares of the market.
    const asked = await k.ask(carol, 15, t0, 202);
    const own = await issueSessionDirect(ctx, makeTestWallet("mr-bob-own"));
    await k.lpShares(15, own.user.partyId ?? "");
    links.set("bob", [own.user.id]);
    try {
      expect(await k.approve<ErrorBody>(bob, asked.approval, 403)).toMatchObject({
        error: "approval_linked_person",
        details: { person: "bob", reason: "position_in_market", marketId: "15" },
      });
    } finally {
      links.delete("bob");
    }
    expect(ctx.wallet.submits).toHaveLength(0);
    // Bob holds nothing in market 15 himself: approved, executed.
    expect((await k.approve(bob, asked.approval, 200)).approval.status).toBe("executed");
    expect(k.submitted().exercise.choice).toBe("ResolveT0");
  });
});

describe("market.resolve with RAMP_DUAL_CONTROL=false (dev): one operator, executed at once", () => {
  const op = makeTestWallet("mr-dev");
  const ctx = useTestApp({ env: { ADMIN_OPERATORS: op.partyId } });
  const k = kit(ctx);

  it("the request is the action: 200 {approval, result} with singleControl, the submit and the audit; refusals still apply", async () => {
    const t = nowSec();
    const m = await k.openMarket({ marketId: 50, expiresAt: t - 3_600 });
    expect(await k.ask<ErrorBody>(op, 50, { choice: "VoidMarket" }, 409)).toMatchObject({
      error: "market_not_resolvable",
      details: { reason: "grace_not_elapsed" },
    });
    const done = await k.ask<Executed>(
      op,
      50,
      { choice: "ResolveT0", outcome: "Void", sourceUri: SRC },
      200,
    );
    expect(done.approval).toMatchObject({ status: "executed", singleControl: true });
    expect(done.result).toEqual({
      marketId: "50",
      choice: "ResolveT0",
      commandId: `market-resolve-50-${done.approval.id}`,
      status: "succeeded",
    });
    expect(k.submitted().exercise).toMatchObject({
      contractId: m.cid,
      choice: "ResolveT0",
      choiceArgument: { resolvedOutcome: "VoidOutcome", sourceUri: SRC },
    });
    expect((await k.audits("50")).map((r) => r.action)).toEqual([
      "admin.approval.requested",
      "market.resolution_submitted",
      "admin.approval.executed",
    ]);
  });
});

describe("market.resolve with RAMP_DUAL_CONTROL=false and RAMP_APPROVAL_SIGNATURES=true: the request is signed (C23)", () => {
  const op = makeTestWallet("mr-signer");
  const other = makeTestWallet("mr-other");
  const ctx = useTestApp({
    env: {
      ADMIN_OPERATORS: [op.partyId, other.partyId].join(","),
      RAMP_APPROVAL_SIGNATURES: "true",
    },
  });
  const k = kit(ctx);

  it("unsigned → 400 with the message to sign (nothing stored or submitted); another wallet's signature → 401; the requester's → executed", async () => {
    const t = nowSec();
    await k.openMarket({ marketId: 60, expiresAt: t - 2 * DAY });
    const unsigned = await k.ask<ErrorBody>(op, 60, { choice: "VoidMarket" }, 400);
    expect(unsigned.error).toBe("approval_signature_required");
    const message = (unsigned.details as { message: string }).message;
    expect(message).toMatch(
      /^truthoracle-approval:request:market\.resolve:60:[0-9a-f]{64}:[0-9a-f]{64}$/,
    );
    expect(await ctx.dataSource.getRepository(AdminApprovalEntity).count()).toBe(0);
    expect(
      (
        await k.ask<ErrorBody>(
          op,
          60,
          { choice: "VoidMarket", signature: other.sign(message) },
          401,
        )
      ).error,
    ).toBe("approval_signature_invalid");
    expect(ctx.wallet.submits).toHaveLength(0);
    const done = await k.ask<Executed>(
      op,
      60,
      { choice: "VoidMarket", signature: op.sign(message) },
      200,
    );
    expect(done.approval).toMatchObject({ status: "executed", singleControl: true });
    expect(k.submitted().exercise.choice).toBe("VoidMarket");
  });
});
