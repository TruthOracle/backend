/**
 * The golden paths end to end with the PRODUCTION controls on (S8; SPEC §2, §6, §10, §11, §16):
 * four-eyes between two persons with wallet-signed decisions, the reserve gate enforcing against
 * the client-money account's confirmed statement (S6's reserve source), the payout gate enforcing,
 * auto-halt, compliance on (consent + stored identity), screening clear — on cBYN at 6 dp with real
 * customer and PSP fees. (1) card on-ramp → reserve gate → mint recorded by the token sync →
 * credited → card cash-out paid as refunds → completed; (2) ERIP on-ramp → credited → bank account
 * added, cooled off, proved by that payment → bank cash-out → MarkPaid → burn → payout_queued →
 * batch (Ana) → approval (Ben, signed) → export → submitted → statement (Ana uploads, Ben confirms
 * with his own copy, signed) → completed. After every step: the order status, the journal
 * identities (Σ = 0; customer_liability = the recorded net issuance of source ramp; client assets ≥
 * client liabilities, safeguard_bank = the attested statement) and every token-app record ours (I9).
 */
import { RampBankStatementEntity } from "../src/entities/ramp-bank-statement.entity";
import { TokenCommandEntity } from "../src/entities/token-command.entity";
import { PayoutService } from "../src/services/payout.service";
import { rampCommandId } from "../src/services/ramp-fulfilment.service";
import { RampGatesService } from "../src/services/ramp-gates.service";
import { RampReconciliationService } from "../src/services/ramp-reconciliation.service";
import { TokenAppSyncService } from "../src/services/token-app-sync.service";
import type {
  ApiApproval,
  ApiPayoutBatchDraft,
  ApiRampBankAccount,
  ApiRampOfframpResult,
  ApiRampOrder,
  ApiRampOverview,
  ApiStatementPreview,
  BankMatchKind,
} from "../src/types";
import { formatAmount, parseAmount } from "../src/util/money";
import { PROD_CONTROLS, TEST_DSO, TEST_TREASURY, useTestApp } from "./helpers/app";
import {
  base64,
  byIban,
  camt053,
  nextDay,
  recentBusinessDays,
  type StatementEntry,
  type StatementSpec,
} from "./helpers/bank";
import { type Buyer, dec, nextKey, rampKit } from "./helpers/ramp";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const ana = makeTestWallet("golden-ana"); // ops + aml + export: requests, uploads, files
const ben = makeTestWallet("golden-ben"); // approver: decides (signed), confirms with his own copy
const CBYN = { admin: TEST_DSO, id: "cBYN" } as const;
const TERMS = "2026-10-01";
const CLIENT = byIban("ALFA", "1");
const OPERATOR_ACC = byIban("PJCB", "2");
const PSP_ACC = byIban("MTBK", "3");
const USER_IBAN = byIban("AKBB", "5");

const ctx = useTestApp({
  env: {
    ...PROD_CONTROLS,
    ADMIN_OPERATORS: `${ana.partyId}#ana@ops+aml+export,${ben.partyId}#ben@approver`,
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
    RAMP_METHODS: "card,erip",
    RAMP_PAYOUT_RAILS: "card,bank",
    COLLATERAL_INSTRUMENT_ID: CBYN.id,
    COLLATERAL_INSTRUMENT_SYMBOL: "cBYN",
    COLLATERAL_INSTRUMENT_NAME: "cBYN",
    COLLATERAL_INSTRUMENT_DECIMALS: "6",
    TOKEN_APP_MAX_PER_CALL: "10000",
    TOKEN_APP_MAX_PER_DAY: "100000",
    RAMP_MINT_DAILY_CAP: "50000",
    RAMP_CARD_FEE_BPS: "150",
    RAMP_ERIP_FEE_BPS: "100",
    RAMP_PAYOUT_CARD_FEE_BPS: "100",
    RAMP_PAYOUT_BANK_FEE_BPS: "50",
    RAMP_CARD_PSP_FEE_BPS: "240",
    RAMP_ERIP_PSP_FEE_BPS: "120",
    RAMP_COMPLIANCE: "on",
    RAMP_TM_RULES_VERSION: "pvk-2026-10",
    RAMP_TERMS_VERSION: TERMS,
    RAMP_TERMS_URL: "https://truthoracle.example/terms/ramp",
    RAMP_OPERATOR_NAME: "TruthOracle LLC",
    RAMP_OPERATOR_UNP: "193456789",
    RAMP_OPERATOR_HTP_REF: "HTP-2026-0042",
    RAMP_BANK_ACCOUNT_IBAN: CLIENT,
    RAMP_BANK_BIC: "ALFABY2X",
    RAMP_BANK_NAME: "Alfa-Bank",
    RAMP_BANK_HOLDER_NAME: "TruthOracle LLC",
    RAMP_BANK_HOLDER_UNP: "193456789",
    RAMP_PSP_SETTLEMENT_IBANS: PSP_ACC,
  },
});
const k = rampKit(ctx, ana, CBYN);
/** Business days up to today (Minsk), oldest first: the first statement is on [0], the next one ends on [2]. */
const D = recentBusinessDays(3);
const gates = (): RampGatesService => ctx.get(RampGatesService);

beforeEach(() => {
  k.mock().reset();
});

async function admin(w: TestWallet): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, w, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

/** The decision a person signs with the wallet behind their admin session (SPEC §6.5). */
function signed(w: TestWallet, a: Pick<ApiApproval, "id" | "paramsHash">): string {
  return w.sign(`truthoracle-approval:${a.id}:${a.paramsHash}:approve`);
}

/** Ana uploads the client-money statement and asks to confirm; Ben confirms with HIS download, signed. */
/** Uploads (Ana) and confirms (Ben, his own copy, signed); `book` classifies lines by ref in the confirm. */
async function confirmStatement(
  spec: StatementSpec,
  book: Record<string, BankMatchKind> = {},
): Promise<ApiStatementPreview> {
  const preview = bodyOf<ApiStatementPreview>(
    await ctx.agent
      .post("/api/v1/admin/ramp/bank-statements")
      .set(await admin(ana))
      .send({ format: "camt053", content: base64(camt053(spec)) })
      .expect(200),
  );
  const requested = bodyOf<{ approval: ApiApproval }>(
    await ctx.agent
      .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
      .set(await admin(ana))
      .send({
        reason: "statement of the client-money account",
        classifications: Object.entries(book).map(([ref, matchKind]) => ({
          lineId: preview.lines.find((l) => l.lineRef === ref)!.id,
          matchKind,
        })),
      })
      .expect(202),
  ).approval;
  const done = bodyOf<{ approval: ApiApproval }>(
    await ctx.agent
      .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm/approve`)
      .set(await admin(ben))
      .send({
        format: "camt053",
        content: base64(camt053({ ...spec, messageId: "MSG-BEN" })),
        reason: "my own download matches",
        signature: signed(ben, requested),
      })
      .expect(200),
  );
  expect(done.approval).toMatchObject({ action: "ramp.statement.confirm", status: "executed" });
  return preview;
}

/** One statement of the client-money account (closing = opening + Σ entries). */
function statement(
  from: string,
  to: string,
  opening: string,
  entries: StatementEntry[],
): StatementSpec {
  const closing = entries.reduce(
    (sum, e) => sum + (e.credit ? parseAmount(e.amount) : -parseAmount(e.amount)),
    parseAmount(opening),
  );
  return {
    account: CLIENT,
    from,
    to,
    opening,
    closing: formatAmount(closing).replace(/0{8}$/, ""),
    entries,
  };
}

const letters = (n: number): string =>
  String(n)
    .split("")
    .map((d) => "abcdefghij"[Number(d)])
    .join("");
let seq = 0;

/** A KYC'd person (the identity is stored on approval) whose Latin name a bank file accepts. */
async function customer(hint: string): Promise<Buyer & { first: string; last: string }> {
  const wallet = makeTestWallet(hint);
  const { user, cookie } = await issueSessionDirect(ctx, wallet);
  const headers = { Cookie: cookie, ...ctx.csrf };
  const started = bodyOf<{ verificationId: string }>(
    await ctx.agent.post("/api/v1/kyc/sessions").set(headers).send({}).expect(200),
  );
  const n = 7000 + (seq += 1);
  const first = `Ivan${letters(n)}`;
  const last = `Petrou${letters(n)}`;
  await ctx.agent
    .post("/api/v1/kyc/mock/submit")
    .set(headers)
    .send({
      verificationId: started.verificationId,
      outcome: "approved",
      person: { firstName: first, lastName: last, dob: "1988-04-12", country: "BLR" },
      documents: [{ docType: "PASSPORT", country: "BLR", number: `MG${n}` }],
    })
    .expect(200);
  return { wallet, user, cookie, headers, first, last };
}

async function overview(b: Buyer): Promise<ApiRampOverview> {
  return bodyOf<ApiRampOverview>(await ctx.agent.get("/api/v1/ramp").set(b.headers).expect(200));
}

/** The terms consent (SPEC §11.2): acting for oneself, no PEP. */
async function consent(b: Buyer): Promise<void> {
  await ctx.agent
    .post("/api/v1/ramp/consent")
    .set(b.headers)
    .send({ termsVersion: TERMS, actsForSelf: true, pepDeclared: false })
    .expect(200);
}

/** Order status through the user's own API (statusText included) and the books after the step. */
async function at(b: Buyer, orderId: string, status: string): Promise<ApiRampOrder> {
  const order = bodyOf<{ order: ApiRampOrder }>(
    await ctx.agent.get(`/api/v1/ramp/orders/${orderId}`).set(b.headers).expect(200),
  ).order;
  expect(order.status).toBe(status);
  await books();
  return order;
}

/**
 * SPEC §5's identities and I9 after a step: every entry sums to zero; customer_liability = the
 * recorded net issuance of source ramp; client assets (safeguard_bank + provider_clearing) cover
 * the client liabilities (issuance_pending + customer_liability + payout_clearing + a credit
 * bank_suspense); safeguard_bank is what the latest CONFIRMED statement attests; every record
 * token-app holds is a command of ours (kind, party, instrument, amount).
 */
async function books(): Promise<void> {
  await k.expectIdentities();
  const rows = await ctx.dataSource.query<{ account: string; total: string }[]>(
    `SELECT account, SUM(amount)::text AS total FROM to_ramp_journal GROUP BY account`,
  );
  const bal = (a: string): bigint => parseAmount(rows.find((r) => r.account === a)?.total ?? "0");
  const suspense = -bal("bank_suspense");
  const assets = bal("safeguard_bank") + bal("provider_clearing");
  const liabilities =
    -bal("issuance_pending") -
    bal("customer_liability") -
    bal("payout_clearing") +
    (suspense > 0n ? suspense : 0n);
  expect({ assets: formatAmount(assets), covers: assets >= liabilities }).toEqual({
    assets: formatAmount(assets),
    covers: true,
  });
  const [attested] = await ctx.dataSource
    .getRepository(RampBankStatementEntity)
    .find({ where: { status: "confirmed" }, order: { periodTo: "DESC" }, take: 1 });
  expect(formatAmount(bal("safeguard_bank"))).toBe(formatAmount(attested?.closingBalance ?? 0n));
  const commands = ctx.dataSource.getRepository(TokenCommandEntity);
  for (const [kind, records] of [
    ["mint", ctx.tokenApp.minted],
    ["burn", ctx.tokenApp.burned],
  ] as const)
    for (const r of records)
      expect(await commands.findOneBy({ commandId: r.commandId })).toMatchObject({
        kind,
        partyId: r.partyId,
        instrumentId: r.instrumentId,
        amount: r.amount,
      });
}

/** A fresh token sync pass and a fresh full reconciliation: no red check (auto-halt is on). */
async function freshReconciliation(): Promise<void> {
  await ctx.get(TokenAppSyncService).syncOnce("test");
  await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
  const run = await ctx.get(RampReconciliationService).runFull("admin");
  expect(
    run?.checks.filter((c) => c.status === "red").map((c) => `${c.name}: ${c.detail}`),
  ).toEqual([]);
}

const LIST_HEADER = "kind,name_variants,birth_date,ids";

/**
 * The day's controls before any money: the three Belarusian / UN lists imported (Ana, aml; nobody
 * here is on them), the client-money account's first statement confirmed four-eyes (opening 0, the
 * operator's 1 000 BYN top-up: it covers the PSP fees customers do not pay), the ledger index
 * caught up with the treasury's cBYN float, a fresh sync pass and full reconciliation.
 */
async function openTheBooks(): Promise<void> {
  // The production values of every control (SPEC §6, §11), not the test defaults.
  expect(ctx.config.rampControls).toMatchObject({
    dualControl: true,
    approvalSignatures: true,
    autoHalt: true,
    reserveGate: "enforce",
    payoutGate: "enforce",
  });
  expect(ctx.config.compliance.enabled).toBe(true);
  for (const list of ["by_terror", "un", "decree48"] as const) {
    const rows =
      list === "decree48"
        ? [`address,,,"nobody::1220aa"`]
        : [`person,"Пятроў Пётр Пятровіч",1960,`];
    await ctx.agent
      .post("/api/v1/admin/compliance/screening-lists")
      .set(await admin(ana))
      .send({
        list,
        version: "2026-10-19",
        deliveredAt: new Date().toISOString(),
        content: Buffer.from([LIST_HEADER, ...rows].join("\r\n") + "\r\n").toString("base64"),
      })
      .expect(200);
  }
  await confirmStatement(
    statement(D[0], D[0], "0", [
      {
        ref: "TOPUP-1",
        amount: "1000.00",
        credit: true,
        date: D[0],
        iban: OPERATOR_ACC,
        name: "TruthOracle LLC",
        purpose: "Пополнение счёта клиентских средств",
      },
    ]),
    // The operator's own money in: classified four-eyes (one account, no auto-booking).
    { "TOPUP-1": "operator_topup" },
  );
  await ctx.dataSource.query(
    `INSERT INTO to_indexer_state (key, "offset", ledger_end) VALUES ('ledger', 10, 10)
     ON CONFLICT (key) DO UPDATE SET "offset" = 10, ledger_end = 10`,
  );
  await ctx.dataSource.query(
    `INSERT INTO to_ledger_holdings (contract_id, owner, instrument_admin, instrument_id, amount, created_offset)
     VALUES ('treasury-float', $1, $2, $3, '1000000', 1)
     ON CONFLICT (contract_id) DO UPDATE SET amount = EXCLUDED.amount, archived_offset = NULL`,
    [TEST_TREASURY, CBYN.admin, CBYN.id],
  );
  await freshReconciliation();
  await books();
}

/** Open a cash-out of `amount` cBYN to `destination`; the user signs the withdrawal and attaches it. */
async function cashOut(
  b: Buyer,
  amount: string,
  destination: Record<string, string>,
): Promise<ApiRampOrder> {
  const order = bodyOf<ApiRampOfframpResult>(
    await ctx.agent
      .post("/api/v1/ramp/offramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount, destination })
      .expect(200),
  ).order;
  await at(b, order.id, "awaiting_withdrawal");
  await ctx.agent
    .post(`/api/v1/ramp/orders/${order.id}/attach`)
    .set(b.headers)
    .send({ pendingPayoutCid: k.signWithdraw(b, amount) })
    .expect(200);
  await at(b, order.id, "withdrawing");
  return order;
}

/** The payout gate is open (fresh full run, no red / unknown token check, a clean sync pass). */
async function payoutGateOpen(): Promise<void> {
  expect(await gates().payoutGate()).toMatchObject({ ok: true });
}

/** MarkPaid (after the payout gate), the ledger's proof of it, the burn command out. */
async function markPaid(b: Buyer, orderId: string): Promise<void> {
  await payoutGateOpen();
  await ctx.get(PayoutService).scan();
  await k.indexPayouts();
  await k.fulfilment().scan();
  await at(b, orderId, "burning");
  expect(await k.commands(orderId)).toMatchObject([
    {
      commandId: rampCommandId("burn", orderId),
      kind: "burn",
      status: "submitted",
      source: "ramp",
    },
  ]);
}

describe("golden paths with the production controls on (S8)", () => {
  it("(1) consent + identity → card on-ramp → capture → reserve gate → mint recorded by the token sync → credited → card cash-out paid as refunds → completed", async () => {
    await openTheBooks();
    const b = await k.buyer("golden-card");
    // The verified identity was stored (sealed) at the KYC approval; the terms are still to accept.
    expect(
      await ctx.dataSource.query(
        `SELECT residence_country FROM to_kyc_identities WHERE user_id = $1`,
        [b.user.id],
      ),
    ).toEqual([{ residence_country: "BY" }]);
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["consent_required"],
    });
    await consent(b);
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    // Screened against today's lists before contracting: clear.
    expect(
      await ctx.dataSource.query(`SELECT identity FROM to_screening_subjects WHERE user_id = $1`, [
        b.user.id,
      ]),
    ).toEqual([{ identity: true }]);
    expect(
      await ctx.dataSource.query(`SELECT id FROM to_screening_hits WHERE user_id = $1`, [
        b.user.id,
      ]),
    ).toEqual([]);

    // 123.45 BYN by card: 1.5 % fee (1.86, rounded up) → 121.59 cBYN.
    const res = await k.openOnramp(b, "123.45");
    expect(res.order).toMatchObject({
      method: "card",
      fiatAmount: dec("123.45"),
      feeAmount: dec("1.86"),
      tokenAmount: dec("121.59"),
    });
    await at(b, res.order.id, "awaiting_payment");
    expect((await gates().statementStatus()).ok).toBe(true);
    // Captured with 3-D Secure, checked at onramp.capture, booked; the reserve gate passed against
    // the confirmed statement and the mint command is out (written in the same transaction).
    await k.pay(b, res);
    await at(b, res.order.id, "minting");
    const mintId = rampCommandId("mint", res.order.id);
    expect(await k.order(res.order.id)).toMatchObject({
      lastError: null,
      mintCommandId: mintId,
      risk: { "onramp.create": { decision: "allow" }, "onramp.capture": { decision: "allow" } },
    });
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: mintId, kind: "mint", status: "submitted", amount: parseAmount("121.59") },
    ]);
    expect(await k.journal(res.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("123.45"),
      "onramp.captured:issuance_pending": dec("-121.59"),
      "onramp.captured:fee_revenue": dec("-1.86"),
      "psp.fee_accrued:psp_fees": dec("2.97"),
      "psp.fee_accrued:provider_clearing": dec("-2.97"),
    });
    // The token sync sees token-app record the mint: onramp.minted and → crediting, one transaction.
    await ctx.get(TokenAppSyncService).syncOnce("test");
    await at(b, res.order.id, "crediting");
    expect(ctx.tokenApp.minted).toEqual([
      {
        commandId: mintId,
        instrumentId: "cBYN",
        partyId: TEST_TREASURY,
        amount: parseAmount("121.59"),
        decimals: 6,
      },
    ]);
    expect(await k.commands(res.order.id)).toMatchObject([{ status: "recorded" }]);
    expect(await k.journal(res.order.id)).toMatchObject({
      "onramp.minted:issuance_pending": dec("121.59"),
      "onramp.minted:customer_liability": dec("-121.59"),
    });
    await k.fulfilment().scan();
    await at(b, res.order.id, "completed");
    expect(ctx.ledger.walletOf(b.wallet.partyId, CBYN)?.balance).toBe(parseAmount("121.59"));

    // Card cash-out of 100 cBYN (1 % fee → 99.00 BYN), paid back as a refund of that capture.
    const card = await k.payoutCard(b);
    expect(card.cashout).toEqual({ mode: "refund", available: dec("123.45") });
    const off = await cashOut(b, "100", { kind: "card", paymentMethodId: card.id });
    expect(off).toMatchObject({
      tokenAmount: dec("100"),
      feeAmount: dec("1"),
      fiatAmount: dec("99"),
    });
    await markPaid(b, off.id);
    await ctx.get(TokenAppSyncService).syncOnce("test");
    await at(b, off.id, "paying_out");
    expect(await k.journal(off.id)).toEqual({
      "offramp.burned:customer_liability": dec("100"),
      "offramp.burned:payout_clearing": dec("-99"),
      "offramp.burned:fee_revenue": dec("-1"),
    });
    await payoutGateOpen();
    await k.fulfilment().scan();
    const done = await at(b, off.id, "completed");
    expect(done.destination).toMatchObject({ kind: "card", paymentMethodId: card.id });
    expect(await k.order(off.id)).toMatchObject({
      details: {
        cardPayout: {
          mode: "refund",
          parts: [{ onrampOrderId: res.order.id, amount: dec("99"), status: "succeeded" }],
        },
      },
    });
    const bought = await k.order(res.order.id);
    expect(bought.refundedAmount).toBe(parseAmount("99"));
    expect(k.mock().refundsOf(bought.providerPaymentId ?? "")).toMatchObject([
      { amount: parseAmount("99"), status: "succeeded" },
    ]);
    expect(await k.journal(off.id)).toEqual({
      "offramp.burned:customer_liability": dec("100"),
      "offramp.burned:payout_clearing": dec("-99"),
      "offramp.burned:fee_revenue": dec("-1"),
      "offramp.paid_card:payout_clearing": dec("99"),
      "offramp.paid_card:provider_clearing": dec("-99"),
    });
    expect(ctx.tokenApp.burned).toEqual([
      {
        commandId: rampCommandId("burn", off.id),
        instrumentId: "cBYN",
        partyId: TEST_TREASURY,
        amount: parseAmount("100"),
        decimals: 6,
      },
    ]);
    expect(ctx.ledger.walletOf(b.wallet.partyId, CBYN)?.balance).toBe(parseAmount("21.59"));
    await freshReconciliation();
    await books();
  });

  it("(2) ERIP on-ramp → credited → bank account added, cooled off, proved by that payment → bank cash-out → MarkPaid → burn → payout_queued → batch (Ana) → approval (Ben, signed) → export → submitted → statement (Ana uploads, Ben confirms with his own copy, signed) → completed", async () => {
    await openTheBooks();
    const b = await customer("golden-erip");
    await consent(b);
    // 250 BYN by ERIP: 1 % fee → 247.50 cBYN; the details name our reference digits.
    const res = await k.openOnramp(b, "250", nextKey(), "erip");
    expect(res.order).toMatchObject({
      method: "erip",
      fiatAmount: dec("250"),
      feeAmount: dec("2.5"),
      tokenAmount: dec("247.5"),
      next: { kind: "erip", serviceCode: "100001", amount: dec("250") },
    });
    await at(b, res.order.id, "awaiting_payment");
    // The payer's bank names the payer — the verified Latin name (no TM-THIRDPARTY) — online, from USER_IBAN.
    await k.pay(b, res, "succeeded", {
      channel: "online",
      payerIban: USER_IBAN,
      payerBankBic: "AKBBBY2X",
      payerNameSource: "bank",
      payerName: `${b.last.toUpperCase()} ${b.first.toUpperCase()}`,
    });
    await at(b, res.order.id, "minting");
    expect(await k.journal(res.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("250"),
      "onramp.captured:issuance_pending": dec("-247.5"),
      "onramp.captured:fee_revenue": dec("-2.5"),
      "psp.fee_accrued:psp_fees": dec("3"),
      "psp.fee_accrued:provider_clearing": dec("-3"),
    });
    await ctx.get(TokenAppSyncService).syncOnce("test");
    await at(b, res.order.id, "crediting");
    await k.fulfilment().scan();
    await at(b, res.order.id, "completed");
    expect(ctx.ledger.walletOf(b.wallet.partyId, CBYN)?.balance).toBe(parseAmount("247.5"));

    // The bank account: added in a fresh session, cooling off, then proved by the ERIP payment from it.
    const account = bodyOf<{ account: ApiRampBankAccount }>(
      await ctx.agent
        .post("/api/v1/ramp/bank-accounts")
        .set(b.headers)
        .send({ iban: USER_IBAN, nameForm: "lat" })
        .expect(200),
    ).account;
    expect(account).toMatchObject({ status: "cooling_off" });
    await ctx.dataSource.query(
      `UPDATE to_ramp_bank_accounts SET cooling_off_until = now() - interval '1 minute' WHERE id = $1`,
      [account.id],
    );
    expect(
      bodyOf<{ accounts: ApiRampBankAccount[] }>(
        await ctx.agent.get("/api/v1/ramp/bank-accounts").set(b.headers).expect(200),
      ).accounts,
    ).toEqual([
      expect.objectContaining({ id: account.id, status: "active", proof: "payer_match" }),
    ]);

    // Bank cash-out of 200 cBYN (0.5 % fee → 199.00 BYN): MarkPaid, the burn, then the bank queue.
    const off = await cashOut(b, "200", { kind: "bank", bankAccountId: account.id });
    expect(off).toMatchObject({ rail: "bank", fiatAmount: dec("199"), feeAmount: dec("1") });
    await markPaid(b, off.id);
    await ctx.get(TokenAppSyncService).syncOnce("test");
    await at(b, off.id, "payout_queued");
    expect(await k.journal(off.id)).toEqual({
      "offramp.burned:customer_liability": dec("200"),
      "offramp.burned:payout_clearing": dec("-199"),
      "offramp.burned:fee_revenue": dec("-1"),
    });

    // Ana drafts the batch; Ben approves it (signed; pre-batch reconciliation + payout gate).
    const draft = bodyOf<ApiPayoutBatchDraft>(
      await ctx.agent
        .post("/api/v1/admin/ramp/payout-batches")
        .set(await admin(ana))
        .send({ reason: "daily payouts" })
        .expect(200),
    );
    expect(draft.items).toEqual([
      expect.objectContaining({ orderId: off.id, kind: "payout", amount: dec("199") }),
    ]);
    await at(b, off.id, "payout_queued");
    // Four-eyes is between persons, and the decision is signed: Ana cannot approve her own
    // request, Ben cannot approve unsigned; then Ben's signed approval executes it.
    const requested = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/approve`)
        .set(await admin(ana))
        .send({ reason: "daily payouts" })
        .expect(202),
    ).approval;
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post(`/api/v1/admin/approvals/${requested.id}/approve`)
          .set(await admin(ana))
          .send({ reason: "my own", signature: signed(ana, requested) })
          .expect(403),
      ).error,
    ).toBe("approval_self");
    expect(
      bodyOf<{ error: string }>(
        await ctx.agent
          .post(`/api/v1/admin/approvals/${requested.id}/approve`)
          .set(await admin(ben))
          .send({ reason: "unsigned" })
          .expect(400),
      ).error,
    ).toBe("approval_signature_required");
    const approved = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/approvals/${requested.id}/approve`)
        .set(await admin(ben))
        .send({ reason: "checked", signature: signed(ben, requested) })
        .expect(200),
    ).approval;
    expect(approved).toMatchObject({ action: "ramp.batch.approve", status: "executed" });
    // Ana downloads the bank file (role export) and marks it submitted with the bank's reference.
    const file = await ctx.agent
      .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/export`)
      .set(await admin(ana))
      .send({})
      .expect(200);
    expect(file.text).toContain(off.payoutReference ?? "-");
    expect(file.text).toContain(`${b.last} ${b.first}`);
    await ctx.agent
      .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/submitted`)
      .set(await admin(ana))
      .send({ bankReference: "PP-2026-1019" })
      .expect(200);
    await at(b, off.id, "payout_sent");

    // The bank debits it: Ana uploads the next statement, Ben confirms with his own download (signed).
    const ref = off.payoutReference ?? "";
    const preview = await confirmStatement(
      statement(nextDay(D[0]), D[2], "1000", [
        {
          ref: "DBT-GOLDEN-1",
          amount: "199.00",
          date: D[2],
          iban: USER_IBAN,
          bic: "AKBBBY2X",
          name: `${b.last} ${b.first}`,
          purpose: `Выплата по заказу ${ref}`,
          endToEnd: ref,
        },
      ]),
    );
    expect(preview.lines).toEqual([
      expect.objectContaining({ status: "proposed", matchKind: "payout", matchedOrderId: off.id }),
    ]);
    await at(b, off.id, "completed");
    expect(await k.journal(off.id)).toEqual({
      "offramp.burned:customer_liability": dec("200"),
      "offramp.burned:payout_clearing": dec("-199"),
      "offramp.burned:fee_revenue": dec("-1"),
      "offramp.paid_bank:payout_clearing": dec("199"),
      "offramp.paid_bank:safeguard_bank": dec("-199"),
    });
    expect(ctx.tokenApp.burned).toEqual([
      {
        commandId: rampCommandId("burn", off.id),
        instrumentId: "cBYN",
        partyId: TEST_TREASURY,
        amount: parseAmount("200"),
        decimals: 6,
      },
    ]);
    expect(ctx.ledger.walletOf(b.wallet.partyId, CBYN)?.balance).toBe(parseAmount("47.5"));
    await freshReconciliation();
    await books();
  });
});
