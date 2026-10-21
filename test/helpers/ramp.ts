/**
 * Shared driving and assertions for the ramp e2e specs (SPEC §16): a KYC'd buyer, the mock
 * checkout through the signed-webhook pipeline, the indexer's view of PendingPayouts, the token
 * sync, the scan — and the journal identities every money scenario must keep:
 * Σ per entry = 0 and customer_liability = the recorded net issuance of source `ramp`.
 */
import { LedgerPayoutEntity } from "../../src/entities/ledger-payout.entity";
import { RampJournalEntity } from "../../src/entities/ramp-journal.entity";
import { RampOrderEntity } from "../../src/entities/ramp-order.entity";
import { TokenCommandEntity } from "../../src/entities/token-command.entity";
import type { UserEntity } from "../../src/entities/user.entity";
import { RampFulfilmentService } from "../../src/services/ramp-fulfilment.service";
import {
  RampProviderMockService,
  type SignedDelivery,
} from "../../src/services/ramp-provider-mock.service";
import { TokenAppSyncService } from "../../src/services/token-app-sync.service";
import { TokenCommandService } from "../../src/services/token-command.service";
import {
  NatsSubjects,
  type ApiRampCards,
  type ApiRampOnrampResult,
  type ApiRampPaymentMethod,
  type ApiRampReconciliation,
  type ApiReconCheck,
  type ApiReconRun,
  type InstrumentId,
} from "../../src/types";
import { formatAmount, parseAmount } from "../../src/util/money";
import { TEST_COLLATERAL, type TestApp } from "./app";
import { bodyOf, issueSessionDirect } from "./session";
import { makeTestWallet, type TestWallet } from "./wallet";

export interface Buyer {
  wallet: TestWallet;
  user: UserEntity;
  cookie: string;
  headers: Record<string, string>;
}

const WEBHOOK_SUBJECT = NatsSubjects.rampWebhook("mock");
/** Reconciliation checks every money scenario keeps green in any test environment (see `identityRed`). */
const IDENTITY_CHECKS = [
  "journal_balanced",
  "token_records_known",
  "token_commands_consistent",
  "issuance_matches_liability",
];
let seq = 0;
export const nextKey = (): string => `e2e-key-${Date.now()}-${(seq += 1)}`;
export const dec = (v: string): string => formatAmount(parseAmount(v));

const SETTLED_KIND: Record<string, string> = {
  MarkPaid: "mark_paid",
  CancelPayout: "cancelled",
  SettleToWallet: "settle_to_wallet",
};

/** The ramp e2e toolkit over one test app (`operator` = an ADMIN_OPERATORS wallet). */
export function rampKit(
  ctx: TestApp,
  operator: TestWallet,
  instrument: InstrumentId = TEST_COLLATERAL,
) {
  const mock = (): RampProviderMockService => ctx.get(RampProviderMockService);
  const fulfilment = (): RampFulfilmentService => ctx.get(RampFulfilmentService);

  /** A signed-in account with a primary wallet and an approved KYC (each one a different person). */
  async function buyer(hint: string): Promise<Buyer> {
    const wallet = makeTestWallet(hint);
    const { user, cookie } = await issueSessionDirect(ctx, wallet);
    const headers = { Cookie: cookie, ...ctx.csrf };
    const started = bodyOf<{ verificationId: string }>(
      await ctx.agent.post("/api/v1/kyc/sessions").set(headers).send({}).expect(200),
    );
    const n = String(1_000_000 + (seq += 1));
    await ctx.agent
      .post("/api/v1/kyc/mock/submit")
      .set(headers)
      .send({
        verificationId: started.verificationId,
        outcome: "approved",
        person: { firstName: `First${n}`, lastName: `Last${n}`, dob: "1990-01-01", country: "BLR" },
        documents: [{ docType: "PASSPORT", country: "BLR", number: `MP${n}` }],
      })
      .expect(200);
    return { wallet, user, cookie, headers };
  }

  async function adminHeaders(): Promise<Record<string, string>> {
    const { cookie } = await issueSessionDirect(ctx, operator, { kind: "admin" });
    return { Cookie: cookie, ...ctx.csrf };
  }

  /** Deliver every webhook trigger published since `from` to the durable consumer (RampProcessor). */
  async function flushWebhooks(from = 0): Promise<void> {
    for (const p of ctx.nats.publishedOn(WEBHOOK_SUBJECT).slice(from))
      expect(await ctx.nats.dispatch(p.subject, p.payload)).toEqual(["ack"]);
  }

  /** Post a signed delivery through the public route, then deliver its trigger. */
  async function deliver(delivery: SignedDelivery): Promise<void> {
    const from = ctx.nats.publishedOn(WEBHOOK_SUBJECT).length;
    await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set(delivery.headers)
      .send(delivery.rawBody.toString("utf8"))
      .expect(200);
    await flushWebhooks(from);
  }

  async function openOnramp(
    b: Buyer,
    amount: string,
    key = nextKey(),
    method: "card" | "erip" = "card",
  ): Promise<ApiRampOnrampResult> {
    return bodyOf<ApiRampOnrampResult>(
      await ctx.agent
        .post("/api/v1/ramp/onramp")
        .set(b.headers)
        .set("Idempotency-Key", key)
        .send({ amount, method })
        .expect(200),
    );
  }

  /** The mock payment of an on-ramp: from the hosted page's URL, else the order id (ERIP; the mock maps it). */
  function paymentIdOf(res: ApiRampOnrampResult): string {
    const next = res.order.next;
    if (next?.kind === "redirect") return new URL(next.url).searchParams.get("payment") ?? "";
    return res.order.id;
  }

  /** The payer finishes the mock payment; the signed delivery goes through the webhook route's pipeline. */
  async function pay(
    b: Buyer,
    res: ApiRampOnrampResult,
    outcome: "succeeded" | "declined" | "no_3ds" = "succeeded",
    opts: {
      cardSeed?: string;
      capturedAmount?: string;
      cardCountry?: string;
      payerName?: string;
      payerNameSource?: "bank" | "checkout";
      channel?: "online" | "cash" | "card" | "unknown";
      payerIban?: string;
      payerBankBic?: string;
    } = {},
  ): Promise<void> {
    const from = ctx.nats.publishedOn(WEBHOOK_SUBJECT).length;
    await ctx.agent
      .post(`/api/v1/ramp/mock/payments/${paymentIdOf(res)}/complete`)
      .set(b.headers)
      .send({ outcome, ...opts })
      .expect(200);
    await flushWebhooks(from);
  }

  async function order(id: string): Promise<RampOrderEntity> {
    return ctx.dataSource.getRepository(RampOrderEntity).findOneByOrFail({ id });
  }

  /** `<kind>:<account>` → amount of every journal line of the order. */
  async function journal(orderId: string): Promise<Record<string, string>> {
    const rows = await ctx.dataSource
      .getRepository(RampJournalEntity)
      .find({ where: { orderId }, order: { id: "ASC" } });
    return Object.fromEntries(rows.map((r) => [`${r.kind}:${r.account}`, formatAmount(r.amount)]));
  }

  async function commands(orderId: string): Promise<TokenCommandEntity[]> {
    return ctx.dataSource
      .getRepository(TokenCommandEntity)
      .find({ where: { ref: orderId }, order: { createdAt: "ASC" } });
  }

  /**
   * What the indexer would have projected by now: every PendingPayout the fake ledger knows, live
   * or archived (with the choice and txHash that archived it).
   */
  async function indexPayouts(): Promise<void> {
    const repo = ctx.dataSource.getRepository(LedgerPayoutEntity);
    const rows = [
      ...[...ctx.ledger.payouts.values()].map((record) => ({ record, end: null })),
      ...[...ctx.ledger.payoutEnds.values()].map((e) => ({ record: e.record, end: e })),
    ];
    for (const { record, end } of rows) {
      await repo.upsert(
        {
          contractId: record.contractId,
          admin: TEST_COLLATERAL.admin,
          userParty: record.user,
          marketId: Number(record.marketId),
          instrumentAdmin: record.instrument.admin,
          instrumentId: record.instrument.id,
          amount: record.amount,
          reason: record.reason,
          auditObservers: [],
          createdAtSec: Math.floor((record.createdAt ?? new Date()).getTime() / 1000),
          active: end === null,
          createdOffset: 1,
          createdEventId: `ev-${record.contractId}`,
          createdAtLedger: record.createdAt,
          settledKind: (end ? (SETTLED_KIND[end.choice] ?? "archived") : null) as never,
          settledOffset: end ? 2 : null,
          settledAtLedger: end ? new Date() : null,
          txHash: end?.txHash ?? null,
          refunded: null,
          settleWalletCid: null,
        },
        ["contractId"],
      );
    }
  }

  /** The background loops once each, `rounds` times: the indexer, the token sync, the ramp scan. */
  async function drive(rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await indexPayouts();
      await ctx.get(TokenAppSyncService).syncOnce("test");
      await fulfilment().scan();
    }
  }

  /** A completed on-ramp of `amount` for `b`. */
  async function bought(b: Buyer, amount: string, cardSeed?: string): Promise<RampOrderEntity> {
    const res = await openOnramp(b, amount);
    await pay(b, res, "succeeded", cardSeed ? { cardSeed } : {});
    await drive();
    const done = await order(res.order.id);
    expect(done.status).toBe("completed");
    return done;
  }

  /** What the Cantor8 wallet does when the user signs `UserWallet.Withdraw { amount }`. */
  function signWithdraw(b: Buyer, amount: string): string {
    const w = ctx.ledger.walletOf(b.wallet.partyId, instrument);
    if (!w) throw new Error("no in-app wallet");
    ctx.ledger.setWallet({
      ...w,
      contractId: ctx.ledger.nextCid("uw"),
      balance: w.balance - parseAmount(amount),
      withdrawn: w.withdrawn + parseAmount(amount),
    });
    return ctx.ledger.seedPendingPayout({
      user: b.wallet.partyId,
      amount,
      reason: "withdraw",
      instrument,
      // UserWallet.Withdraw queues marketId 0 (not market-specific); the treasury check relies on it.
      marketId: "0",
    }).contractId;
  }

  /** The user's own CancelPayout: T back into the wallet, the PendingPayout archived. */
  function cancelPayout(b: Buyer, cid: string): void {
    const payout = ctx.ledger.payouts.get(cid);
    const w = ctx.ledger.walletOf(b.wallet.partyId, instrument);
    if (!payout || !w) throw new Error("nothing to cancel");
    ctx.ledger.setWallet({
      ...w,
      contractId: ctx.ledger.nextCid("uw"),
      balance: w.balance + payout.amount,
    });
    ctx.ledger.archivePayout(cid, { choice: "CancelPayout" });
  }

  /**
   * Time passes beyond the card dispute window (RAMP_CARD_EXPOSURE_DAYS, 120): every card capture
   * moves `days` back — still inside the refund window (RAMP_CARD_REFUND_MAX_DAYS, 180) at 121.
   */
  async function decayExposure(days = 121): Promise<void> {
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET captured_at = captured_at - make_interval(days => $1) WHERE captured_at IS NOT NULL`,
      [days],
    );
  }

  async function cards(b: Buyer): Promise<ApiRampPaymentMethod[]> {
    return bodyOf<ApiRampCards>(
      await ctx.agent.get("/api/v1/ramp/payment-methods").set(b.headers).expect(200),
    ).cards;
  }

  async function payoutCard(b: Buyer): Promise<ApiRampPaymentMethod> {
    const list = await cards(b);
    expect(list).toHaveLength(1);
    return list[0];
  }

  /** A fresh full run (POST …/run), then the reconciliation view (GET): the run, reserve, journal. */
  async function reconciliation(): Promise<ApiRampReconciliation & { run: ApiReconRun }> {
    const headers = await adminHeaders();
    // A run that finished < 60 s ago is reused on demand: drop it so every call reconciles anew.
    await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
    await ctx.agent.post("/api/v1/admin/ramp/reconciliation/run").set(headers).send({}).expect(200);
    const rec = bodyOf<ApiRampReconciliation>(
      await ctx.agent.get("/api/v1/admin/ramp/reconciliation").set(headers).expect(200),
    );
    if (!rec.run) throw new Error("no reconciliation run");
    return { ...rec, run: rec.run };
  }

  /**
   * The checks a money scenario must keep green whatever the test environment (no bank statements,
   * no ledger index): the journal and the token-integrity identities. Returns the red ones.
   */
  function identityRed(rec: { run: ApiReconRun }): string[] {
    return rec.run.checks
      .filter((c) => IDENTITY_CHECKS.includes(c.name) && c.status === "red")
      .map((c) => `${c.name}: ${c.detail ?? ""}`);
  }

  function checkOf(rec: { run: ApiReconRun }, name: string): ApiReconCheck {
    const c = rec.run.checks.find((x) => x.name === name);
    if (!c) throw new Error(`no ${name} check in the run`);
    return c;
  }

  /**
   * SPEC §5's identities, after every money scenario: every entry sums to zero, and
   * customer_liability (a credit balance) equals the recorded net issuance of source `ramp`.
   */
  async function expectIdentities(): Promise<void> {
    const unbalanced = await ctx.dataSource.query<{ entry_id: string }[]>(
      `SELECT entry_id FROM to_ramp_journal GROUP BY entry_id HAVING SUM(amount) <> 0`,
    );
    expect(unbalanced).toEqual([]);
    const [row] = await ctx.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ramp_journal WHERE account = 'customer_liability'`,
    );
    const issued = await ctx
      .get(TokenCommandService)
      .recordedNet(instrument, { sources: ["ramp"] });
    expect(formatAmount(-parseAmount(row.total))).toBe(formatAmount(issued));
  }

  return {
    mock,
    fulfilment,
    buyer,
    adminHeaders,
    flushWebhooks,
    deliver,
    openOnramp,
    paymentIdOf,
    pay,
    order,
    journal,
    commands,
    indexPayouts,
    drive,
    bought,
    signWithdraw,
    cancelPayout,
    decayExposure,
    cards,
    payoutCard,
    reconciliation,
    identityRed,
    checkOf,
    expectIdentities,
    WEBHOOK_SUBJECT,
  };
}
