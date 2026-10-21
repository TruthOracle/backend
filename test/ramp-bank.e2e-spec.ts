/**
 * The bank rail end to end (SPEC §10; S6) with dual control on: Alice runs the ramp (ops, export)
 * and Bob is the second person (approver). A user's bank account is added with a fresh session,
 * cools off and is proved by an ERIP payment from it; an off-ramp to it burns and waits in
 * payout_queued; a batch is drafted, approved by the other person, exported and submitted; a
 * statement uploaded by one person and confirmed by the other with their OWN copy completes the
 * payout (offramp.paid_bank). Then the hostile and broken cases: a 0.01 BYN "return", a genuine
 * return, a duplicate debit, a debit to another IBAN, a void after export, a payout the bank never
 * made (bank_unpaid), an ERIP refund by bank transfer, PSP / operator / fee / suspense lines, the
 * reserve gate's statement freshness and the statement chain. Every money scenario checks order
 * status, journal and token commands, then the journal identities.
 */
import { randomUUID } from "node:crypto";

import { RampBankAccountEntity } from "../src/entities/ramp-bank-account.entity";
import { RampPayoutBatchItemEntity } from "../src/entities/ramp-payout-batch-item.entity";
import { RampPayoutBatchEntity } from "../src/entities/ramp-payout-batch.entity";
import { UserEntity } from "../src/entities/user.entity";
import { RampBankProcessor } from "../src/processors/ramp-bank.processor";
import {
  ALLOW,
  type ComplianceDecision,
  type CompliancePoint,
  RampCompliancePort,
} from "../src/services/ramp-compliance.port";
import { ComplianceScreeningService } from "../src/services/compliance-screening.service";
import { RampControlsService } from "../src/services/ramp-controls.service";
import { RampGatesService } from "../src/services/ramp-gates.service";
import { type BlindIndexReindexer, SealedDataService } from "../src/services/sealed-data.service";
import { SentryService } from "../src/services/sentry.service";
import { TokenAppSyncService } from "../src/services/token-app-sync.service";
import { UserService } from "../src/services/user.service";
import type {
  ApiApproval,
  ApiBankLine,
  ApiPayoutBatch,
  ApiPayoutBatchDraft,
  ApiRampBankAccount,
  ApiRampOfframpResult,
  ApiRampOrder,
  ApiStatementPreview,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { formatAmount, parseAmount } from "../src/util/money";
import { useTestApp } from "./helpers/app";
import {
  base64,
  byIban,
  camt053,
  nextDay,
  recentBusinessDays,
  type StatementEntry,
  type StatementSpec,
  statementCsv,
} from "./helpers/bank";
import { dec, nextKey, rampKit, type Buyer } from "./helpers/ramp";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const alice = makeTestWallet("bank-alice");
const bob = makeTestWallet("bank-bob");
const CLIENT = byIban("ALFA", "1");
const OPERATOR_ACC = byIban("PJCB", "2");
const PSP_ACC = byIban("MTBK", "3");
const USER_IBAN = byIban("AKBB", "5");
const OTHER_IBAN = byIban("PJCB", "6");

const ctx = useTestApp({
  env: {
    // Alice also holds `aml` (the freezes of the hold tests: aml places and requests the lift, Bob approves).
    ADMIN_OPERATORS: `${alice.partyId}#alice@ops+approver+export+aml,${bob.partyId}#bob@ops+approver+export`,
    RAMP_DUAL_CONTROL: "true",
    RAMP_APPROVAL_SIGNATURES: "false",
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
    RAMP_METHODS: "card,erip",
    RAMP_PAYOUT_RAILS: "card,bank",
    // Compliance rules are S7a's suites; here everyone is allowed (the port's default).
    RAMP_COMPLIANCE: "off",
    RAMP_CARD_PSP_FEE_BPS: "240",
    RAMP_ERIP_PSP_FEE_BPS: "0",
    RAMP_BANK_ACCOUNT_IBAN: CLIENT,
    RAMP_BANK_BIC: "ALFABY2X",
    RAMP_BANK_NAME: "Alfa-Bank",
    RAMP_BANK_HOLDER_NAME: "TruthOracle LLC",
    RAMP_BANK_HOLDER_UNP: "193456789",
    RAMP_PSP_SETTLEMENT_IBANS: PSP_ACC,
    RAMP_BANK_MANUAL_PROOF: "true",
    RAMP_BANK_FEE_MAX: "5",
    RAMP_BLOCKED_BANK_CODES: "MMBN",
  },
});
const k = rampKit(ctx, alice);
/** The 8 most recent business days up to today (Minsk), oldest first: statements are dated on them. */
const D = recentBusinessDays(8);

beforeEach(() => {
  k.mock().reset();
});
async function admin(w: TestWallet): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, w, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

let seq = 0;
/** The verified Latin name of each customer (the bank names an ERIP payer as `LAST FIRST`). */
const NAMES = new Map<string, { first: string; last: string }>();
const letters = (n: number): string =>
  String(n)
    .split("")
    .map((d) => "abcdefghij"[Number(d)])
    .join("");

/** A KYC'd account whose verified Latin name a bank file accepts (letters only). */
async function customer(hint: string): Promise<Buyer> {
  const wallet = makeTestWallet(hint);
  const { user, cookie } = await issueSessionDirect(ctx, wallet);
  const headers = { Cookie: cookie, ...ctx.csrf };
  const started = bodyOf<{ verificationId: string }>(
    await ctx.agent.post("/api/v1/kyc/sessions").set(headers).send({}).expect(200),
  );
  const n = 4000 + (seq += 1);
  await ctx.agent
    .post("/api/v1/kyc/mock/submit")
    .set(headers)
    .send({
      verificationId: started.verificationId,
      outcome: "approved",
      person: {
        firstName: `Ivan${letters(n)}`,
        lastName: `Petrou${letters(n)}`,
        dob: "1990-01-01",
        country: "BLR",
      },
      documents: [{ docType: "PASSPORT", country: "BLR", number: `MB${n}` }],
    })
    .expect(200);
  const fresh = await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: user.id });
  NAMES.set(user.id, { first: `Ivan${letters(n)}`, last: `Petrou${letters(n)}` });
  return { wallet, user: fresh, cookie, headers };
}

/** The customer's own name as their bank reports it on an ERIP payment. */
function bankPayerName(b: Buyer): string {
  const n = NAMES.get(b.user.id)!;
  return `${n.last.toUpperCase()} ${n.first.toUpperCase()}`;
}

async function addAccount(
  b: Buyer,
  iban: string,
  status = 200,
  nameForm = "lat",
): Promise<Record<string, unknown>> {
  return bodyOf<Record<string, unknown>>(
    await ctx.agent
      .post("/api/v1/ramp/bank-accounts")
      .set(b.headers)
      .send({ iban, nameForm })
      .expect(status),
  );
}

async function accounts(b: Buyer): Promise<ApiRampBankAccount[]> {
  return bodyOf<{ accounts: ApiRampBankAccount[] }>(
    await ctx.agent.get("/api/v1/ramp/bank-accounts").set(b.headers).expect(200),
  ).accounts;
}

/** The cooling-off ends (time passes). */
async function coolOff(accountId: string): Promise<void> {
  await ctx.dataSource.query(
    `UPDATE to_ramp_bank_accounts SET cooling_off_until = now() - interval '1 minute' WHERE id = $1`,
    [accountId],
  );
}

/**
 * A completed ERIP purchase paid from `payerIban` (online channel, the bank names the payer: the
 * customer, unless `payerName` says otherwise).
 */
async function eripBuy(
  b: Buyer,
  amount: string,
  payerIban: string,
  payer: { payerName?: string; payerNameSource?: "bank" | "checkout" } = {},
): Promise<string> {
  const res = await k.openOnramp(b, amount, nextKey(), "erip");
  await k.pay(b, res, "succeeded", {
    channel: "online",
    payerIban,
    payerName: payer.payerName ?? bankPayerName(b),
    payerNameSource: payer.payerNameSource ?? "bank",
  });
  await k.drive();
  expect((await k.order(res.order.id)).status).toBe("completed");
  return res.order.id;
}

/** A customer with `balance` cBYN bought by ERIP from USER_IBAN, which is their active (payer_match) account. */
async function provedCustomer(
  hint: string,
  balance = "100",
  iban = USER_IBAN,
): Promise<{ b: Buyer; accountId: string }> {
  const b = await customer(hint);
  const { account } = (await addAccount(b, iban)) as { account: ApiRampBankAccount };
  await eripBuy(b, balance, iban);
  await coolOff(account.id);
  expect(await accounts(b)).toEqual([
    expect.objectContaining({ id: account.id, status: "active", proof: "payer_match" }),
  ]);
  return { b, accountId: account.id };
}

function offramp(
  b: Buyer,
  amount: string,
  accountId: string,
): Promise<{ status: number; body: unknown }> {
  return ctx.agent
    .post("/api/v1/ramp/offramp")
    .set(b.headers)
    .set("Idempotency-Key", nextKey())
    .send({ amount, destination: { kind: "bank", bankAccountId: accountId } });
}

/** Cash out `amount` to the bank account: sign, attach, the loops run → payout_queued. */
async function bankCashOut(b: Buyer, amount: string, accountId: string): Promise<ApiRampOrder> {
  const res = await offramp(b, amount, accountId);
  expect(res.status).toBe(200);
  const order = (res.body as ApiRampOfframpResult).order;
  await ctx.agent
    .post(`/api/v1/ramp/orders/${order.id}/attach`)
    .set(b.headers)
    .send({ pendingPayoutCid: k.signWithdraw(b, amount) })
    .expect(200);
  await k.drive();
  expect(await k.order(order.id)).toMatchObject({ status: "payout_queued", payoutBatchId: null });
  return order;
}

/** Bob (the second person) approves a pending approval. */
async function bobApproves(
  approval: Pick<ApiApproval, "id">,
  status = 200,
): Promise<Record<string, unknown>> {
  return bodyOf<Record<string, unknown>>(
    await ctx.agent
      .post(`/api/v1/admin/approvals/${approval.id}/approve`)
      .set(await admin(bob))
      .send({ reason: "second pair of eyes" })
      .expect(status),
  );
}

/** Alice requests (202), Bob approves: the action's result. */
async function fourEyes(path: string, body: Record<string, unknown>): Promise<unknown> {
  const requested = bodyOf<{ approval: ApiApproval }>(
    await ctx.agent
      .post(`/api/v1${path}`)
      .set(await admin(alice))
      .send(body)
      .expect(202),
  ).approval;
  const out = await bobApproves(requested);
  expect((out.approval as ApiApproval).status).toBe("executed");
  return out.result;
}

async function createBatch(): Promise<ApiPayoutBatchDraft> {
  return bodyOf<ApiPayoutBatchDraft>(
    await ctx.agent
      .post("/api/v1/admin/ramp/payout-batches")
      .set(await admin(alice))
      .send({ reason: "daily payouts" })
      .expect(200),
  );
}

async function exportBatch(batchId: string, status = 200): Promise<string> {
  const res = await ctx.agent
    .post(`/api/v1/admin/ramp/payout-batches/${batchId}/export`)
    .set(await admin(alice))
    .send({})
    .expect(status);
  return res.text;
}

async function submitBatch(
  batchId: string,
  bankReference = "PP-2026-0001",
): Promise<ApiPayoutBatch> {
  return bodyOf<{ batch: ApiPayoutBatch }>(
    await ctx.agent
      .post(`/api/v1/admin/ramp/payout-batches/${batchId}/submitted`)
      .set(await admin(alice))
      .send({ bankReference })
      .expect(200),
  ).batch;
}

/** Draft → four-eyes approval → export → submitted: the queued orders are payout_sent. */
async function sendBatch(): Promise<ApiPayoutBatchDraft> {
  const draft = await createBatch();
  await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
  await exportBatch(draft.batch.id);
  await submitBatch(draft.batch.id);
  return draft;
}

async function upload(
  spec: StatementSpec,
  format: "camt053" | "csv" = "camt053",
  status = 200,
): Promise<ApiStatementPreview & ErrorBody> {
  return bodyOf<ApiStatementPreview & ErrorBody>(
    await ctx.agent
      .post("/api/v1/admin/ramp/bank-statements")
      .set(await admin(alice))
      .send({ format, content: base64(format === "csv" ? statementCsv(spec) : camt053(spec)) })
      .expect(status),
  );
}

/**
 * Alice uploads and requests the confirm; Bob confirms with his OWN download of the same statement
 * (a different MsgId: the bytes differ, the canonical parse does not). Returns the confirm's result.
 */
async function bookStatement(
  spec: StatementSpec,
  opts: {
    classifications?: Record<string, unknown>[];
    copy?: StatementSpec;
    copyFormat?: "camt053" | "csv";
  } = {},
): Promise<{ preview: ApiStatementPreview; result: Record<string, unknown> }> {
  const preview = await upload(spec);
  const requested = bodyOf<{ approval: ApiApproval }>(
    await ctx.agent
      .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
      .set(await admin(alice))
      .send({
        reason: "statement in",
        ...(opts.classifications ? { classifications: opts.classifications } : {}),
      })
      .expect(202),
  ).approval;
  expect(requested).toMatchObject({ action: "ramp.statement.confirm", status: "pending" });
  const copy = opts.copy ?? { ...spec, messageId: "MSG-BOB" };
  const format = opts.copyFormat ?? "camt053";
  const out = bodyOf<{ approval: ApiApproval; result: Record<string, unknown> }>(
    await ctx.agent
      .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm/approve`)
      .set(await admin(bob))
      .send({
        format,
        content: base64(format === "csv" ? statementCsv(copy) : camt053(copy)),
        reason: "my own download matches",
      })
      .expect(200),
  );
  expect(out.approval.status).toBe("executed");
  return { preview, result: out.result };
}

/** A payout debit as the bank books it (EndToEndId = the order's reference, the document number). */
function payoutDebit(
  order: { payoutReference: string | null },
  amount: string,
  date: string,
  over: Partial<StatementEntry> = {},
): StatementEntry {
  const ref = order.payoutReference ?? "";
  return {
    ref: `DBT-${randomUUID().slice(0, 8)}`,
    amount,
    date,
    iban: USER_IBAN,
    bic: "AKBBBY2X",
    name: "PETROU IVAN",
    purpose: `Выплата по заказу ${ref}`,
    endToEnd: ref,
    ...over,
  };
}

/** One statement of the client-money account. */
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

/** `<kind>:<account>` → Σ over every journal line booked on the statement lines of `statementId`. */
async function lineJournal(statementId: string): Promise<Record<string, string>> {
  const rows = await ctx.dataSource.query<{ kind: string; account: string; total: string }[]>(
    `SELECT j.kind, j.account, SUM(j.amount)::text AS total FROM to_ramp_journal j
       JOIN to_ramp_bank_lines l ON l.id = j.statement_line_id
      WHERE l.statement_id = $1 GROUP BY j.kind, j.account ORDER BY j.kind, j.account`,
    [statementId],
  );
  return Object.fromEntries(
    rows.map((r) => [`${r.kind}:${r.account}`, formatAmount(parseAmount(r.total))]),
  );
}

async function balance(account: string): Promise<string> {
  const [row] = await ctx.dataSource.query<{ total: string }[]>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ramp_journal WHERE account = $1`,
    [account],
  );
  return formatAmount(parseAmount(row.total));
}

/** A paid bank payout of 50: customer, account, ERIP purchase, cash-out, batch, statement on day `day`. */
async function paidPayout(
  hint: string,
  day: string,
): Promise<{ b: Buyer; accountId: string; order: ApiRampOrder; statementId: string }> {
  const { b, accountId } = await provedCustomer(hint);
  const order = await bankCashOut(b, "50", accountId);
  await sendBatch();
  const { preview } = await bookStatement(
    statement(day, day, "1000", [payoutDebit(order, "50.00", day)]),
  );
  expect((await k.order(order.id)).status).toBe("completed");
  return { b, accountId, order, statementId: preview.statement.id };
}

/** An AML freeze of the account (role aml, at once): the real freeze service (S7b). */
async function freezeUser(userId: string): Promise<string> {
  return bodyOf<{ freeze: { id: string } }>(
    await ctx.agent
      .post("/api/v1/admin/compliance/freezes")
      .set(await admin(alice))
      .send({ userId, reason: "AML decision", source: "aml" })
      .expect(200),
  ).freeze.id;
}

/** The four-eyes lift: Alice (aml) requests, Bob (approver) approves. */
async function liftFreeze(freezeId: string): Promise<void> {
  await fourEyes(`/admin/compliance/freezes/${freezeId}/lift`, { reason: "released" });
}

const REVIEW: ComplianceDecision = { decision: "review", rules: ["TM-TEST"], alertIds: [] };

/**
 * A compliance implementation layered over the bound one: `held` says whether a review holds;
 * `returned` names the orders whose alert AML decided to return (C25).
 */
function stubCompliance(answers: Partial<Record<CompliancePoint, ComplianceDecision>>): {
  held: boolean;
  returned: Set<string>;
  unbind: () => void;
} {
  const state = { held: false, returned: new Set<string>(), unbind: (): void => undefined };
  state.unbind = ctx.get(RampCompliancePort).bind({
    eligibility: async () => ({ allowed: true, reasons: [] }),
    consent: async () => ({ required: false, consentId: null }),
    check: async (point) => answers[point] ?? ALLOW,
    isHeld: async () => state.held,
    raise: async () => null,
    returnRequested: async (orderId) => state.returned.has(orderId),
  });
  return state;
}

/** A batch's row as stored. */
function batchRow(id: string): Promise<RampPayoutBatchEntity> {
  return ctx.dataSource.getRepository(RampPayoutBatchEntity).findOneByOrFail({ id });
}

/** The submission (and the file) moved back to `day`; the batch's orders sent then. */
async function sentOn(batchId: string, day: string, orderIds: string[]): Promise<void> {
  await ctx.dataSource.query(
    `UPDATE to_ramp_payout_batches SET submitted_at = $2::timestamptz, exported_at = $2::timestamptz WHERE id = $1`,
    [batchId, `${day}T09:00:00Z`],
  );
  await ctx.dataSource.query(
    `UPDATE to_ramp_orders SET status_changed_at = $2::timestamptz WHERE id = ANY($1::uuid[])`,
    [orderIds, `${day}T09:00:00Z`],
  );
}

describe("bank rail (SPEC §10)", () => {
  it("user bank accounts: fresh session, BY IBAN of a directory bank, no enumeration, limits, cooling-off, proof (§10.2, X10)", async () => {
    const b = await customer("acct");
    // A session older than 15 minutes cannot add an account.
    const old = await customer("acct-old");
    await ctx.dataSource.query(
      `UPDATE to_sessions SET created_at = now() - interval '20 minutes' WHERE user_id = $1`,
      [old.user.id],
    );
    expect(await addAccount(old, USER_IBAN, 401)).toMatchObject({ error: "recent_auth_required" });

    // Malformed IBANs say what is wrong; bank-level refusals all look alike (no enumeration).
    expect(await addAccount(b, USER_IBAN.slice(0, 27) + "9", 400)).toMatchObject({
      error: "bank_account_invalid",
      message: expect.stringMatching(/check digits/) as string,
    });
    const generic = {
      error: "bank_account_invalid",
      message: "this IBAN cannot be used for payouts",
    };
    expect(await addAccount(b, "BY13NBRB3600900000002Z00AB00", 400)).toEqual(generic); // the NBRB holds no personal accounts
    expect(await addAccount(b, byIban("MMBN", "8"), 400)).toEqual(generic); // RAMP_BLOCKED_BANK_CODES
    expect(await addAccount(b, USER_IBAN, 400, "be")).toMatchObject({
      error: "validation_failed",
      details: { nameForms: ["lat"] },
    });

    const { account } = (await addAccount(
      b,
      ` ${USER_IBAN.toLowerCase().replace(/(.{4})/g, "$1 ")}`,
    )) as {
      account: ApiRampBankAccount;
    };
    expect(account).toMatchObject({
      ibanMasked: "BY•• •••• … 0005",
      bankName: "Belarusbank",
      bic: "AKBBBY2X",
      holderName: expect.stringMatching(/^Petrou[a-j]+ Ivan[a-j]+$/) as string,
      status: "cooling_off",
      proof: null,
    });
    expect(Date.parse(account.usableFrom ?? "") - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const row = await ctx.dataSource
      .getRepository(RampBankAccountEntity)
      .findOneByOrFail({ id: account.id });
    expect(row.ibanSealed).toMatch(/^v2\./);
    expect(row.ibanSealed).not.toContain(USER_IBAN);
    expect(await addAccount(b, USER_IBAN, 409)).toMatchObject({ error: "bank_account_exists" });

    // Another user with the same IBAN: refused like any unusable IBAN, TM-SHAREDIBAN for both.
    const raised = jest.spyOn(ctx.get(RampCompliancePort), "raise");
    const mule = await customer("acct-mule");
    expect(await addAccount(mule, USER_IBAN, 400)).toEqual(generic);
    expect(raised.mock.calls.map(([rule, userId]) => [rule, userId]).sort()).toEqual(
      [
        ["TM-SHAREDIBAN", b.user.id],
        ["TM-SHAREDIBAN", mule.user.id],
      ].sort(),
    );
    raised.mockRestore();

    // At most RAMP_MAX_BANK_ACCOUNTS (2) live accounts.
    const second = ((await addAccount(b, OTHER_IBAN)) as { account: ApiRampBankAccount }).account;
    expect(await addAccount(b, byIban("BLNB", "7"), 409)).toMatchObject({
      error: "bank_account_limit",
      details: { max: 2 },
    });
    // Not usable while cooling off.
    expect((await offramp(b, "10", second.id)).body).toMatchObject({
      error: "ramp_rail_unavailable",
      details: { reason: "bank_account_cooling_off" },
    });

    // Manual proof is four-eyes; the account turns active when its cooling-off ends.
    const verified = (await fourEyes(`/admin/ramp/bank-accounts/${second.id}/verify`, {
      reason: "bank letter",
      proofRef: "letter 2026/118",
    })) as { status: string; proof: string };
    expect(verified).toMatchObject({ status: "cooling_off", proof: "manual" });
    await coolOff(second.id);
    expect((await accounts(b)).find((a) => a.id === second.id)).toMatchObject({
      status: "active",
      proof: "manual",
      usableFrom: null,
    });
    // An account with no proof waits in pending_proof.
    await coolOff(account.id);
    expect((await accounts(b)).find((a) => a.id === account.id)).toMatchObject({
      status: "pending_proof",
      proof: null,
    });

    // Removal; the IBAN may then be added again (a new cooling-off).
    const removed = bodyOf<{ account: ApiRampBankAccount }>(
      await ctx.agent.delete(`/api/v1/ramp/bank-accounts/${account.id}`).set(b.headers).expect(200),
    ).account;
    expect(removed.status).toBe("removed");
    expect((await accounts(b)).map((a) => a.id)).toEqual([second.id]);
    // The operator's list shows the directory's sanctions flags.
    const listed = bodyOf<{ items: { id: string; sanctions: { eu: string[] } }[] }>(
      await ctx.agent
        .get(`/api/v1/admin/ramp/bank-accounts?userId=${b.user.id}`)
        .set(await admin(alice))
        .expect(200),
    ).items;
    expect(listed.find((a) => a.id === account.id)?.sanctions.eu).toEqual([
      "EU Reg 765/2006 Annex IX",
    ]);
  });

  it("off-ramp to a proved account: burn → payout_queued → four-eyes batch → file → submitted → statement (A uploads, B confirms with his own copy) → completed + offramp.paid_bank", async () => {
    const { b, accountId } = await provedCustomer("happy", "100");
    // The first payouts to a new account are capped (RAMP_BANK_FIRST_PAYOUT_MAX 500) before the balance is read.
    expect((await offramp(b, "600", accountId)).body).toMatchObject({
      error: "ramp_limit_exceeded",
      details: { limit: "bank_first_payout", available: dec("500") },
    });
    const order = await bankCashOut(b, "50", accountId);
    expect(order).toMatchObject({
      rail: "bank",
      destination: {
        kind: "bank",
        bankAccountId: accountId,
        bankName: "Belarusbank",
        ibanMasked: "BY•• •••• … 0005",
      },
    });
    expect(await k.journal(order.id)).toEqual({
      "offramp.burned:customer_liability": dec("50"),
      "offramp.burned:payout_clearing": dec("-50"),
    });
    const [burn] = await k.commands(order.id);
    expect(burn).toMatchObject({ kind: "burn", status: "recorded", source: "ramp" });

    // The draft (ops), then four-eyes: the creator's own approval is refused, Bob's executes.
    const draft = await createBatch();
    expect(draft.skipped).toEqual([]);
    expect(draft.items).toEqual([
      expect.objectContaining({
        orderId: order.id,
        kind: "payout",
        amount: dec("50"),
        status: "included",
        payoutReference: order.payoutReference,
        ibanMasked: "BY•• •••• … 0005",
      }),
    ]);
    expect((await k.order(order.id)).payoutBatchId).toBe(draft.batch.id);
    const requested = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/approve`)
        .set(await admin(alice))
        .send({ reason: "batch ok" })
        .expect(202),
    ).approval;
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/approvals/${requested.id}/approve`)
          .set(await admin(alice))
          .send({ reason: "self" })
          .expect(403),
      ).error,
    ).toBe("approval_self");
    // The file needs an approved batch.
    expect(await exportBatch(draft.batch.id, 409)).toMatch(/approve the batch first/);
    await bobApproves(requested);

    // The bank file: one row in the bank's layout; a re-export is byte-identical.
    const csv = await exportBatch(draft.batch.id);
    const [header, row, ...rest] = csv.trim().split("\r\n");
    expect(rest).toEqual([]);
    expect(header).toBe(
      '"batch_id","document_no","reference","amount","currency","beneficiary_name","beneficiary_iban","beneficiary_bic","beneficiary_bank","purpose_code","purpose_text","payer_iban","payer_name","payer_unp"',
    );
    const cells = row.slice(1, -1).split('","');
    expect(cells).toEqual([
      draft.batch.id,
      draft.items[0].documentNo,
      order.payoutReference,
      "50.00",
      "BYN",
      expect.stringMatching(/^Petrou[a-j]+ Ivan[a-j]+$/),
      USER_IBAN,
      "AKBBBY2X",
      "Belarusbank",
      "40109",
      `Выплата по заказу ${order.payoutReference}`,
      CLIENT,
      "TruthOracle LLC",
      "193456789",
    ]);
    expect(await exportBatch(draft.batch.id)).toBe(csv);
    const exported = await ctx.dataSource
      .getRepository(RampPayoutBatchEntity)
      .findOneByOrFail({ id: draft.batch.id });
    expect(exported).toMatchObject({ status: "exported", exportCount: 2, fileFormat: "csv" });
    // An exported batch is never cancelled (it may be at the bank).
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/cancel`)
          .set(await admin(alice))
          .send({ reason: "oops" })
          .expect(409),
      ),
    ).toMatchObject({ error: "batch_state", message: expect.stringMatching(/void it/) as string });

    await submitBatch(draft.batch.id, "PP-77");
    expect(await k.order(order.id)).toMatchObject({
      status: "payout_sent",
      payoutBatchId: draft.batch.id,
    });
    expect(await exportBatch(draft.batch.id, 409)).toMatch(/never exported again/);

    // Alice uploads the statement; the debit is PROPOSED.
    const day = D[7];
    const spec = statement(day, day, "1000", [
      payoutDebit(order, "50.00", day, { documentNo: draft.items[0].documentNo }),
    ]);
    const preview = await upload(spec);
    expect(preview.statement).toMatchObject({
      status: "draft",
      accountIban: CLIENT,
      periodFrom: day,
      periodTo: day,
      openingBalance: dec("1000"),
      closingBalance: dec("950"),
      lineCount: 1,
    });
    expect(preview.lines).toEqual([
      expect.objectContaining({
        amount: dec("-50"),
        status: "proposed",
        matchKind: "payout",
        matchedOrderId: order.id,
        reference: order.payoutReference,
        counterpartyIbanLast4: "0005",
        counterpartyName: "PETROU IVAN",
      }),
    ]);
    const requestConfirm = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
        .set(await admin(alice))
        .send({ reason: "statement in" })
        .expect(202),
    ).approval;
    // The generic approve route cannot confirm without the approver's own copy.
    expect(await bobApproves(requestConfirm, 409)).toMatchObject({
      error: "approval_failed",
      details: { cause: "statement_mismatch" },
    });
    expect((await k.order(order.id)).status).toBe("payout_sent");
    const again = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
        .set(await admin(alice))
        .send({ reason: "statement in, again" })
        .expect(202),
    ).approval;
    expect(again.id).not.toBe(requestConfirm.id);
    const approveWith = async (
      w: TestWallet,
      copy: StatementSpec,
      status: number,
      format: "camt053" | "csv" = "camt053",
    ): Promise<Record<string, unknown>> =>
      bodyOf<Record<string, unknown>>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm/approve`)
          .set(await admin(w))
          .send({
            format,
            content: base64(format === "csv" ? statementCsv(copy) : camt053(copy)),
            reason: "own copy",
          })
          .expect(status),
      );
    // The uploader cannot be the confirming person; a copy that parses differently is refused.
    expect(await approveWith(alice, spec, 403)).toMatchObject({ error: "approval_same_person" });
    const forged = { ...spec, entries: [{ ...spec.entries[0], iban: OTHER_IBAN }] };
    expect(await approveWith(bob, forged, 409)).toMatchObject({ error: "statement_mismatch" });
    // A CSV of the camt.053 never stands for it (C7: free text compares within one format).
    expect(await approveWith(bob, spec, 409, "csv")).toMatchObject({
      error: "statement_mismatch",
    });
    // Bob's own download of the same camt.053 (another MsgId: the bytes differ) parses identically.
    const done = await approveWith(bob, { ...spec, messageId: "MSG-BOB" }, 200);
    expect(done).toMatchObject({
      approval: { status: "executed", decidedByPerson: "bob" },
      result: { matched: 1, unmatched: 0, statement: { status: "confirmed" } },
    });

    expect(await k.order(order.id)).toMatchObject({ status: "completed" });
    expect(await k.journal(order.id)).toEqual({
      "offramp.burned:customer_liability": dec("50"),
      "offramp.burned:payout_clearing": dec("-50"),
      "offramp.paid_bank:payout_clearing": dec("50"),
      "offramp.paid_bank:safeguard_bank": dec("-50"),
    });
    expect(await lineJournal(preview.statement.id)).toEqual({
      "offramp.paid_bank:payout_clearing": dec("50"),
      "offramp.paid_bank:safeguard_bank": dec("-50"),
    });
    // The first statement opens the books; the journal now equals the bank.
    expect(await balance("safeguard_bank")).toBe(dec("950"));
    expect(await balance("operator_money")).toBe(dec("-1000"));
    const item = await ctx.dataSource
      .getRepository(RampPayoutBatchItemEntity)
      .findOneByOrFail({ orderId: order.id });
    expect(item).toMatchObject({ status: "paid", paidLineId: preview.lines[0].id });
    expect(
      await ctx.dataSource
        .getRepository(RampPayoutBatchEntity)
        .findOneByOrFail({ id: draft.batch.id }),
    ).toMatchObject({ status: "settled" });
    expect(
      await ctx.dataSource.getRepository(RampBankAccountEntity).findOneByOrFail({ id: accountId }),
    ).toMatchObject({ firstPayoutOrderId: order.id });
    const view = bodyOf<{ order: ApiRampOrder }>(
      await ctx.agent.get(`/api/v1/ramp/orders/${order.id}`).set(b.headers).expect(200),
    ).order;
    expect(view.timeline.map((t) => t.status)).toEqual(
      expect.arrayContaining(["payout_queued", "payout_sent", "completed"]),
    );
    const rec = await k.reconciliation();
    for (const name of [
      "bank_statement_matches_journal",
      "bank_payout_duplicate",
      "bank_iban_mismatch",
    ])
      expect(k.checkOf(rec, name).status).toBe("green");
    expect(rec.reserve).toMatchObject({
      statementPeriodTo: day,
      statementClosing: dec("950"),
      statementFresh: true,
    });
    await k.expectIdentities();
  });

  it("a 0.01 BYN 'return' quoting the reference never reverses; a genuine camt return re-mints and credits back, and blocks the account (#2, X2)", async () => {
    const { b, accountId, order } = await paidPayout("ret", D[5]);
    // The user sends 0.01 BYN back with the reference: flagged, never proposed, nothing moves.
    const fake = await bookStatement(
      statement(nextDay(D[5]), D[6], "950", [
        {
          ref: "CR-fake",
          amount: "0.01",
          credit: true,
          date: D[6],
          iban: USER_IBAN,
          purpose: `возврат ${order.payoutReference}`,
        },
      ]),
    );
    expect(fake.preview.lines).toEqual([
      expect.objectContaining({
        status: "unmatched",
        matchKind: null,
        flags: ["reference_credit"],
      }),
    ]);
    expect(fake.result).toMatchObject({ matched: 0, unmatched: 1, flagged: 1 });
    expect((await k.order(order.id)).status).toBe("completed");
    expect(Object.keys(await k.journal(order.id))).not.toContain(
      "offramp.returned_bank:payout_clearing",
    );

    // The beneficiary bank returns the payout (camt RtrInf AC04 = closed account).
    const back = await bookStatement(
      statement(nextDay(D[6]), D[7], "950.01", [
        {
          ref: "CR-return",
          amount: "50.00",
          credit: true,
          date: D[7],
          iban: USER_IBAN,
          name: "AKB BELARUSBANK",
          purpose: `Возврат платежа ${order.payoutReference}: счет закрыт`,
          returnCode: "AC04",
        },
      ]),
    );
    expect(back.preview.lines[0]).toMatchObject({
      status: "proposed",
      matchKind: "payout_return",
      matchedOrderId: order.id,
    });
    expect(back.result).toMatchObject({ matched: 1 });
    // reversing → the re-mint lands (sync) → the Deposit back → refunded.
    await k.drive();
    expect(await k.order(order.id)).toMatchObject({ status: "refunded" });
    expect(await k.journal(order.id)).toEqual({
      "offramp.burned:customer_liability": dec("50"),
      "offramp.burned:payout_clearing": dec("-50"),
      "offramp.paid_bank:payout_clearing": dec("50"),
      "offramp.paid_bank:safeguard_bank": dec("-50"),
      "offramp.returned_bank:safeguard_bank": dec("50"),
      "offramp.returned_bank:payout_clearing": dec("-50"),
      "offramp.reminted:payout_clearing": dec("50"),
      "offramp.reminted:customer_liability": dec("-50"),
    });
    const cmds = await k.commands(order.id);
    expect(cmds.map((c) => [c.kind, c.status])).toEqual([
      ["burn", "recorded"],
      ["mint", "recorded"],
    ]);
    expect(
      await ctx.dataSource.getRepository(RampBankAccountEntity).findOneByOrFail({ id: accountId }),
    ).toMatchObject({
      status: "blocked",
      blockedReason: expect.stringMatching(/AC04/) as string,
    });
    expect(
      await ctx.dataSource
        .getRepository(RampPayoutBatchItemEntity)
        .findOneByOrFail({ orderId: order.id }),
    ).toMatchObject({
      status: "returned",
    });
    // The blocked account takes no payout until it is unblocked (four-eyes) and proved again.
    expect((await offramp(b, "10", accountId)).body).toMatchObject({
      error: "ramp_rail_unavailable",
      details: { reason: "bank_account_blocked" },
    });
    const unblocked = (await fourEyes(`/admin/ramp/bank-accounts/${accountId}/unblock`, {
      reason: "new account details confirmed",
    })) as {
      status: string;
      proof: string;
    };
    // Re-proved at once: the ERIP payment from this IBAN still matches.
    expect(unblocked).toMatchObject({ status: "active", proof: "payer_match" });
    // 1000 − 50 + 50 booked; the 0.01 waits unbooked (the bank holds 1000.01).
    expect(await balance("safeguard_bank")).toBe(dec("1000"));
    const rec = await k.reconciliation();
    expect(k.checkOf(rec, "bank_statement_matches_journal").status).not.toBe("red");
    await k.expectIdentities();
  });

  it("a second debit for a paid payout is payout_duplicate: red, payouts halt (#4)", async () => {
    const { order } = await paidPayout("dup", D[6]);
    const dup = await bookStatement(
      statement(nextDay(D[6]), D[7], "950", [payoutDebit(order, "50.00", D[7])]),
    );
    expect(dup.preview.lines[0]).toMatchObject({
      status: "unmatched",
      flags: ["payout_duplicate"],
    });
    expect((await k.order(order.id)).status).toBe("completed");
    expect(await k.journal(order.id)).toEqual({
      "offramp.burned:customer_liability": dec("50"),
      "offramp.burned:payout_clearing": dec("-50"),
      "offramp.paid_bank:payout_clearing": dec("50"),
      "offramp.paid_bank:safeguard_bank": dec("-50"),
    });
    const config = ctx.config.rampControls as { autoHalt: boolean };
    config.autoHalt = true;
    try {
      const rec = await k.reconciliation();
      expect(k.checkOf(rec, "bank_payout_duplicate")).toMatchObject({
        status: "red",
        haltScopes: ["payouts"],
      });
      expect((await ctx.get(RampControlsService).controls()).haltedScopes).toContain("payouts");
      // The payout gate now refuses every batch approval and first file.
      expect((await ctx.get(RampGatesService).payoutGate()).ok).toBe(false);
    } finally {
      config.autoHalt = false;
    }
    // Booked to suspense (four-eyes), the line stops the red check; the money stays a debit in suspense.
    const line = dup.preview.lines[0];
    await fourEyes(`/admin/ramp/bank-lines/${line.id}/classify`, {
      reason: "bank error, recall requested",
      matchKind: "suspense",
    });
    expect(await lineJournal(dup.preview.statement.id)).toEqual({
      "suspense.out:bank_suspense": dec("50"),
      "suspense.out:safeguard_bank": dec("-50"),
    });
    const rec = await k.reconciliation();
    expect(k.checkOf(rec, "bank_payout_duplicate").status).toBe("green");
    expect(k.checkOf(rec, "bank_statement_matches_journal").status).toBe("green");
    await k.expectIdentities();
  });

  it("a payout debit to another IBAN is iban_mismatch: the order goes to review, red, payouts halt (X3)", async () => {
    const { accountId, b } = await provedCustomer("mism");
    const order = await bankCashOut(b, "50", accountId);
    await sendBatch();
    // Someone changed the beneficiary IBAN in the file after export: reference and amount match.
    const st = await bookStatement(
      statement(D[7], D[7], "1000", [
        payoutDebit(order, "50.00", D[7], { iban: OTHER_IBAN, bic: "PJCBBY2X" }),
      ]),
    );
    expect(st.preview.lines[0]).toMatchObject({ status: "unmatched", flags: ["iban_mismatch"] });
    expect(await k.order(order.id)).toMatchObject({ status: "needs_review", reviewStep: "payout" });
    expect(Object.keys(await k.journal(order.id))).not.toContain(
      "offramp.paid_bank:safeguard_bank",
    );
    // It cannot be booked as the order's payout by hand either (the IBAN condition fails).
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/bank-lines/${st.preview.lines[0].id}/classify`)
          .set(await admin(alice))
          .send({ reason: "it is the payout", matchKind: "payout", orderId: order.id })
          .expect(409),
      ),
    ).toMatchObject({ error: "bank_line_state" });
    const config = ctx.config.rampControls as { autoHalt: boolean };
    config.autoHalt = true;
    try {
      const rec = await k.reconciliation();
      expect(k.checkOf(rec, "bank_iban_mismatch")).toMatchObject({
        status: "red",
        haltScopes: ["payouts"],
      });
      expect((await ctx.get(RampControlsService).controls()).haltedScopes).toContain("payouts");
    } finally {
      config.autoHalt = false;
    }
    // S4's retry resumes waiting for the debit — single control: the bank rail says nothing is sent by it.
    const retried = bodyOf<{ approval: ApiApproval; result: { status: string } }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${order.id}/retry`)
        .set(await admin(alice))
        .send({ reason: "the bank recalls the misdirected payment" })
        .expect(200),
    );
    expect(retried.result.status).toBe("payout_sent");
    await k.expectIdentities();
  });

  it("void after export: refused without proof, then statements covering the settle days with no debit void it and the orders queue again (#4, X4)", async () => {
    const { accountId, b } = await provedCustomer("void");
    const order = await bankCashOut(b, "50", accountId);
    const draft = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
    await exportBatch(draft.batch.id);
    // The file left on D[3] (Minsk noon).
    await ctx.dataSource.query(
      `UPDATE to_ramp_payout_batches SET exported_at = $2::timestamptz WHERE id = $1`,
      [draft.batch.id, `${D[3]}T09:00:00Z`],
    );
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/void`)
        .set(await admin(alice))
        .send({ reason: "bank says rejected" })
        .expect(409),
    );
    expect(refused).toMatchObject({
      error: "batch_state",
      message: expect.stringMatching(/confirmed statements must cover/) as string,
    });
    // Statements from the export day to D[7] (≥ 3 business days later): no debit for the item.
    await bookStatement(
      statement(D[3], D[7], "1000", [
        {
          ref: "FEE-1",
          amount: "1.50",
          date: D[4],
          iban: null,
          name: "Alfa-Bank",
          purpose: "Комиссия банка",
        },
      ]),
    );
    const result = (await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/void`, {
      reason: "file never executed",
    })) as {
      batch: ApiPayoutBatch;
    };
    expect(result.batch).toMatchObject({ status: "voided" });
    const voided = await k.order(order.id);
    expect(voided).toMatchObject({ status: "payout_queued", payoutBatchId: null });
    expect(voided.details.voidedBatchId).toBe(draft.batch.id);
    // The user cannot remove the account while its payout is still owed.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .delete(`/api/v1/ramp/bank-accounts/${accountId}`)
          .set(b.headers)
          .expect(409),
      ).error,
    ).toBe("bank_account_in_use");
    expect(
      await ctx.dataSource
        .getRepository(RampPayoutBatchItemEntity)
        .findOneByOrFail({ batchId: draft.batch.id, orderId: order.id }),
    ).toMatchObject({ status: "voided" });
    // Re-batched with a new document number; the void left the journal alone.
    const next = await createBatch();
    expect(next.items.map((i) => i.orderId)).toEqual([order.id]);
    expect(next.items[0].documentNo).not.toBe(draft.items[0].documentNo);
    expect(await k.journal(order.id)).toEqual({
      "offramp.burned:customer_liability": dec("50"),
      "offramp.burned:payout_clearing": dec("-50"),
    });
    // A draft (or approved) batch is cancelled by one operator; its orders queue again.
    const cancelled = bodyOf<{ batch: ApiPayoutBatch }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/payout-batches/${next.batch.id}/cancel`)
        .set(await admin(alice))
        .send({ reason: "rebuild later" })
        .expect(200),
    ).batch;
    expect(cancelled.status).toBe("cancelled");
    expect((await k.order(order.id)).payoutBatchId).toBeNull();
    await k.expectIdentities();
  });

  it("no debit after the settle days: payout_sent ages into review; bank_unpaid proves it and requeues (#5, M7)", async () => {
    const { accountId, b } = await provedCustomer("unpaid");
    const order = await bankCashOut(b, "50", accountId);
    const draft = await sendBatch();
    // Submitted on D[3]; the processor ages it after RAMP_BANK_SETTLE_DAYS business days.
    await ctx.dataSource.query(
      `UPDATE to_ramp_payout_batches SET submitted_at = $2::timestamptz, exported_at = $2::timestamptz WHERE id = $1`,
      [draft.batch.id, `${D[3]}T09:00:00Z`],
    );
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status_changed_at = $2::timestamptz WHERE id = $1`,
      [order.id, `${D[3]}T09:00:00Z`],
    );
    expect(await ctx.get(RampBankProcessor).tick()).toMatchObject({ aged: 1 });
    expect(await k.order(order.id)).toMatchObject({ status: "needs_review", reviewStep: "payout" });
    // Without statements nothing is proven.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${order.id}/bank_unpaid`)
          .set(await admin(alice))
          .send({ reason: "no debit", then: "requeue" })
          .expect(409),
      ),
    ).toMatchObject({ message: expect.stringMatching(/not proven unpaid/) as string });
    // S4's reverse is refused while the order sits in a submitted batch.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${order.id}/reverse`)
          .set(await admin(alice))
          .send({ reason: "x" })
          .expect(409),
      ).message,
    ).toMatch(/payout batch/);
    await bookStatement(statement(D[3], D[7], "1000", []));
    const after = (await fourEyes(`/admin/ramp/orders/${order.id}/bank_unpaid`, {
      reason: "no debit in 3 business days",
      then: "requeue",
    })) as {
      status: string;
    };
    expect(after.status).toBe("payout_queued");
    expect(await k.order(order.id)).toMatchObject({ status: "payout_queued", payoutBatchId: null });
    expect(
      await ctx.dataSource
        .getRepository(RampPayoutBatchItemEntity)
        .findOneByOrFail({ batchId: draft.batch.id, orderId: order.id }),
    ).toMatchObject({ status: "unpaid" });
    expect(
      await ctx.dataSource
        .getRepository(RampPayoutBatchEntity)
        .findOneByOrFail({ id: draft.batch.id }),
    ).toMatchObject({ status: "settled" });
    expect((await createBatch()).items.map((i) => i.orderId)).toEqual([order.id]);
    await k.expectIdentities();
  });

  it("an ERIP on-ramp the acquirer cannot refund: refund_bank (four-eyes) → payout_queued → batch → statement debit → refunded + refund.paid_bank (M1, #12)", async () => {
    const b = await customer("erip-refund");
    const { account } = (await addAccount(b, USER_IBAN)) as { account: ApiRampBankAccount };
    // A partial ERIP payment (C ≠ F) is refund-only and the mock acquirer refunds no ERIP payment.
    const res = await k.openOnramp(b, "50", nextKey(), "erip");
    await k.pay(b, res, "succeeded", {
      channel: "online",
      payerIban: USER_IBAN,
      payerNameSource: "bank",
      payerName: bankPayerName(b),
      capturedAmount: "40",
    });
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
    });
    await coolOff(account.id);
    // A capture held in review proves no account (C10): the refund account is proved by hand.
    expect((await accounts(b))[0]).toMatchObject({ status: "pending_proof", proof: null });
    await fourEyes(`/admin/ramp/bank-accounts/${account.id}/verify`, {
      reason: "bank letter",
      proofRef: "letter 2026/203",
    });
    expect((await accounts(b))[0]).toMatchObject({ status: "active", proof: "manual" });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${res.order.id}/refund`)
          .set(await admin(alice))
          .send({ reason: "refund" })
          .expect(409),
      ),
    ).toMatchObject({ details: { use: "refund_bank" } });
    // Another user's account is refused.
    const other = await customer("erip-other");
    const foreign = ((await addAccount(other, OTHER_IBAN)) as { account: ApiRampBankAccount })
      .account;
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${res.order.id}/refund_bank`)
          .set(await admin(alice))
          .send({ reason: "refund", bankAccountId: foreign.id })
          .expect(409),
      ).message,
    ).toMatch(/account of the order's user/);
    const queued = (await fourEyes(`/admin/ramp/orders/${res.order.id}/refund_bank`, {
      reason: "ERIP refund",
      bankAccountId: account.id,
    })) as {
      status: string;
      bankAccountId: string;
    };
    expect(queued).toMatchObject({ status: "payout_queued", bankAccountId: account.id });
    expect(await k.journal(res.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("40"),
      "onramp.captured:issuance_pending": dec("-40"),
      "onramp.refund_queued:issuance_pending": dec("40"),
      "onramp.refund_queued:payout_clearing": dec("-40"),
    });
    const draft = await sendBatch();
    expect(draft.items).toEqual([
      expect.objectContaining({ orderId: res.order.id, kind: "refund", amount: dec("40") }),
    ]);
    expect((await k.order(res.order.id)).status).toBe("payout_sent");
    const ref = res.order.payoutReference ?? "";
    await bookStatement(
      statement(D[7], D[7], "1000", [
        payoutDebit({ payoutReference: ref }, "40.00", D[7], {
          purpose: `Возврат средств по заказу ${ref}`,
        }),
      ]),
    );
    expect(await k.order(res.order.id)).toMatchObject({ status: "refunded" });
    expect(await k.journal(res.order.id)).toEqual({
      "onramp.captured:provider_clearing": dec("40"),
      "onramp.captured:issuance_pending": dec("-40"),
      "onramp.refund_queued:issuance_pending": dec("40"),
      "onramp.refund_queued:payout_clearing": dec("-40"),
      "refund.paid_bank:payout_clearing": dec("40"),
      "refund.paid_bank:safeguard_bank": dec("-40"),
    });
    expect(await k.commands(res.order.id)).toEqual([]);
    await k.expectIdentities();
  });

  it("a bank refund the bank sends back: strict camt return → refund.returned_bank, needs_review(refund), account blocked; refund_bank again (nothing re-booked) → batch → debit → refunded (S8)", async () => {
    const b = await customer("erip-bounce");
    const first = ((await addAccount(b, USER_IBAN)) as { account: ApiRampBankAccount }).account;
    const res = await k.openOnramp(b, "50", nextKey(), "erip");
    await k.pay(b, res, "succeeded", {
      channel: "online",
      payerIban: USER_IBAN,
      payerNameSource: "bank",
      payerName: bankPayerName(b),
      capturedAmount: "40",
    });
    // A capture held in review proves no account (C10): proved by hand.
    await fourEyes(`/admin/ramp/bank-accounts/${first.id}/verify`, {
      reason: "bank letter",
      proofRef: "letter 2026/202",
    });
    await coolOff(first.id);
    await fourEyes(`/admin/ramp/orders/${res.order.id}/refund_bank`, {
      reason: "ERIP refund",
      bankAccountId: first.id,
    });
    await sendBatch();
    const ref = res.order.payoutReference ?? "";
    const refundDebit = (day: string): StatementEntry =>
      payoutDebit({ payoutReference: ref }, "40.00", day, {
        purpose: `Возврат средств по заказу ${ref}`,
      });
    await bookStatement(statement(D[4], D[4], "1000", [refundDebit(D[4])]));
    expect(await k.order(res.order.id)).toMatchObject({ status: "refunded" });

    // The beneficiary bank sends it back (camt RtrInf AC04 = closed account).
    const back = await bookStatement(
      statement(nextDay(D[4]), D[5], "960", [
        {
          ref: "CR-refund-back",
          amount: "40.00",
          credit: true,
          date: D[5],
          iban: USER_IBAN,
          name: "AKB BELARUSBANK",
          purpose: `Возврат платежа ${ref}: счет закрыт`,
          returnCode: "AC04",
        },
      ]),
    );
    expect(back.preview.lines[0]).toMatchObject({
      status: "proposed",
      matchKind: "refund_return",
      matchedOrderId: res.order.id,
    });
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "refund",
      completedAt: null,
      details: { reviewFrom: "refunded", bankReturn: { code: "AC04" } },
    });
    expect(await k.journal(res.order.id)).toMatchObject({
      "refund.paid_bank:payout_clearing": dec("40"),
      "refund.returned_bank:safeguard_bank": dec("40"),
      "refund.returned_bank:payout_clearing": dec("-40"),
    });
    expect(
      await ctx.dataSource.getRepository(RampBankAccountEntity).findOneByOrFail({ id: first.id }),
    ).toMatchObject({ status: "blocked" });
    await k.expectIdentities();
    // A retry cannot pretend it was paid; the blocked account takes nothing.
    await ctx.agent
      .post(`/api/v1/admin/ramp/orders/${res.order.id}/retry`)
      .set(await admin(alice))
      .send({ reason: "retry" })
      .expect(409);
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${res.order.id}/refund_bank`)
          .set(await admin(alice))
          .send({ reason: "again", bankAccountId: first.id })
          .expect(409),
      ).message,
    ).toMatch(/blocked, not active/);

    // A second account (manual proof), then refund_bank again: queued, nothing new booked.
    const second = ((await addAccount(b, OTHER_IBAN)) as { account: ApiRampBankAccount }).account;
    await fourEyes(`/admin/ramp/bank-accounts/${second.id}/verify`, {
      reason: "bank letter",
      proofRef: "letter 2026/204",
    });
    await coolOff(second.id);
    const requeued = (await fourEyes(`/admin/ramp/orders/${res.order.id}/refund_bank`, {
      reason: "ERIP refund to the new account",
      bankAccountId: second.id,
    })) as { status: string; bankAccountId: string; payoutBatchId: string | null };
    expect(requeued).toMatchObject({
      status: "payout_queued",
      bankAccountId: second.id,
      payoutBatchId: null,
    });
    expect(Object.keys(await k.journal(res.order.id)).sort()).toEqual([
      "onramp.captured:issuance_pending",
      "onramp.captured:provider_clearing",
      "onramp.refund_queued:issuance_pending",
      "onramp.refund_queued:payout_clearing",
      "refund.paid_bank:payout_clearing",
      "refund.paid_bank:safeguard_bank",
      "refund.returned_bank:payout_clearing",
      "refund.returned_bank:safeguard_bank",
    ]);
    const draft = await sendBatch();
    expect(draft.items).toEqual([
      expect.objectContaining({ orderId: res.order.id, kind: "refund", amount: dec("40") }),
    ]);
    // The same reference pays again — to the new account, on a new line.
    await bookStatement(
      statement(nextDay(D[5]), D[6], "1000", [
        { ...refundDebit(D[6]), iban: OTHER_IBAN, bic: "PJCBBY2X" },
      ]),
    );
    expect(await k.order(res.order.id)).toMatchObject({ status: "refunded" });
    const payouts = await ctx.dataSource.query<{ n: number }[]>(
      `SELECT COUNT(DISTINCT entry_id)::int AS n FROM to_ramp_journal WHERE order_id = $1 AND kind = 'refund.paid_bank'`,
      [res.order.id],
    );
    expect(payouts[0].n).toBe(2);
    // Owed nothing any more: payout_clearing of the order nets to zero.
    const [po] = await ctx.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ramp_journal WHERE order_id = $1 AND account = 'payout_clearing'`,
      [res.order.id],
    );
    expect(parseAmount(po.total)).toBe(0n);
    expect(await balance("safeguard_bank")).toBe(dec("960"));
    expect(k.checkOf(await k.reconciliation(), "bank_statement_matches_journal").status).not.toBe(
      "red",
    );
    await k.expectIdentities();
  });

  it("PSP settlement with its fee true-up and a bank fee auto-booked; the operator's top-up and sweep and the rest (suspense) classified four-eyes (§5, X7)", async () => {
    const buyer = await k.buyer("psp");
    const card = await k.bought(buyer, "100");
    // 240 bps accrued on the card capture: provider_clearing 97.60.
    expect(await k.journal(card.id)).toMatchObject({ "psp.fee_accrued:psp_fees": dec("2.4") });
    const day = D[7];
    const spec = statement(day, day, "1000", [
      {
        ref: "PSP-1",
        amount: "97.50",
        credit: true,
        date: day,
        iban: PSP_ACC,
        name: "eComCharge",
        purpose: "settlement 2026-10",
      },
      {
        ref: "OP-IN",
        amount: "200.00",
        credit: true,
        date: day,
        iban: OPERATOR_ACC,
        name: "TruthOracle LLC",
        purpose: "top-up",
      },
      {
        ref: "OP-OUT",
        amount: "50.00",
        date: day,
        iban: OPERATOR_ACC,
        name: "TruthOracle LLC",
        purpose: "sweep",
      },
      {
        ref: "FEE-1",
        amount: "2.00",
        date: day,
        iban: null,
        name: "Alfa-Bank",
        purpose: "Комиссия за платежи",
      },
      {
        ref: "UNK-IN",
        amount: "30.00",
        credit: true,
        date: day,
        iban: OTHER_IBAN,
        name: "Someone",
        purpose: "?",
      },
      {
        ref: "UNK-OUT",
        amount: "1.00",
        date: day,
        iban: OTHER_IBAN,
        name: "Someone",
        purpose: "?",
      },
    ]);
    const preview = await upload(spec);
    const byRef = (ref: string): ApiBankLine => preview.lines.find((l) => l.lineRef === ref)!;
    expect(preview.lines.map((l) => [l.lineRef, l.status, l.matchKind])).toEqual(
      expect.arrayContaining([
        ["PSP-1", "proposed", "psp_settlement"],
        // One account: the operator's own money in / out is never auto-booked, whoever the counterparty.
        ["OP-IN", "unmatched", null],
        ["OP-OUT", "unmatched", null],
        ["FEE-1", "proposed", "bank_fee"],
        ["UNK-IN", "unmatched", null],
        ["UNK-OUT", "unmatched", null],
      ]),
    );
    const confirm = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
        .set(await admin(alice))
        .send({
          reason: "statement in",
          classifications: [
            { lineId: byRef("OP-IN").id, matchKind: "operator_topup" },
            { lineId: byRef("OP-OUT").id, matchKind: "operator_sweep" },
            { lineId: byRef("UNK-OUT").id, matchKind: "suspense" },
          ],
        })
        .expect(202),
    ).approval;
    expect(confirm.params).toEqual({
      classifications: [
        { lineId: byRef("OP-IN").id, matchKind: "operator_topup" },
        { lineId: byRef("OP-OUT").id, matchKind: "operator_sweep" },
        { lineId: byRef("UNK-OUT").id, matchKind: "suspense" },
      ],
    });
    const done = bodyOf<{ approval: ApiApproval; result: Record<string, unknown> }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm/approve`)
        .set(await admin(bob))
        .send({
          format: "camt053",
          content: base64(camt053({ ...spec, messageId: "BOB" })),
          reason: "own copy",
        })
        .expect(200),
    );
    expect(done.result).toMatchObject({ matched: 5, unmatched: 1 });
    expect(await lineJournal(preview.statement.id)).toEqual({
      "bank.fee:bank_fees": dec("2"),
      "bank.fee:safeguard_bank": dec("-2"),
      "operator.sweep:operator_money": dec("50"),
      "operator.sweep:safeguard_bank": dec("-50"),
      "operator.topup:operator_money": dec("-200"),
      "operator.topup:safeguard_bank": dec("200"),
      "psp.fee:provider_clearing": dec("-0.1"),
      "psp.fee:psp_fees": dec("0.1"),
      "psp.settlement:provider_clearing": dec("-97.5"),
      "psp.settlement:safeguard_bank": dec("97.5"),
      "suspense.out:bank_suspense": dec("1"),
      "suspense.out:safeguard_bank": dec("-1"),
    });
    expect(await balance("provider_clearing")).toBe(dec("0"));
    // The unknown credit: suspense (four-eyes, after the confirm).
    expect((await ctx.get(RampBankProcessor).tick()).aged).toBe(0);
    const before = await k.reconciliation();
    expect(k.checkOf(before, "bank_statement_matches_journal").status).toBe("green");
    await fourEyes(`/admin/ramp/bank-lines/${byRef("UNK-IN").id}/classify`, {
      reason: "unknown sender, held",
      matchKind: "suspense",
    });
    const lines = bodyOf<{ items: ApiBankLine[] }>(
      await ctx.agent
        .get(`/api/v1/admin/ramp/bank-lines?statementId=${preview.statement.id}&status=unmatched`)
        .set(await admin(alice))
        .expect(200),
    ).items;
    expect(lines).toEqual([]);
    expect(await balance("safeguard_bank")).toBe(dec("1274.5"));
    expect(await balance("bank_suspense")).toBe(dec("-29"));
    expect(k.checkOf(await k.reconciliation(), "bank_statement_matches_journal").status).toBe(
      "green",
    );
    await k.expectIdentities();
  });

  it("one account: the operator's own payments out are swept four-eyes only within its headroom — never client money (X7)", async () => {
    const buyer = await k.buyer("sweep");
    await k.bought(buyer, "100");
    // Client money: 100 owed against provider_clearing 97.60 (the PSP has not settled yet).
    const day = D[7];
    const spec = statement(day, day, "1000", [
      {
        ref: "OWN-A",
        amount: "400.00",
        date: day,
        iban: OTHER_IBAN,
        name: "Landlord",
        purpose: "rent",
      },
      {
        ref: "OWN-B",
        amount: "598.00",
        date: day,
        iban: OTHER_IBAN,
        name: "Supplier",
        purpose: "invoice",
      },
    ]);
    const preview = await upload(spec);
    const byRef = (ref: string): ApiBankLine => preview.lines.find((l) => l.lineRef === ref)!;
    expect(preview.lines.map((l) => [l.lineRef, l.status])).toEqual(
      expect.arrayContaining([
        ["OWN-A", "unmatched"],
        ["OWN-B", "unmatched"],
      ]),
    );
    // Headroom 1 000 (opening, booked first) + 97.60 − 100 = 997.60 ≥ 400: OWN-A books in the confirm.
    const classifications = [{ lineId: byRef("OWN-A").id, matchKind: "operator_sweep" }];
    await ctx.agent
      .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
      .set(await admin(alice))
      .send({ reason: "statement in", classifications })
      .expect(202);
    const done = bodyOf<{ approval: ApiApproval; result: Record<string, unknown> }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm/approve`)
        .set(await admin(bob))
        .send({
          format: "camt053",
          content: base64(camt053({ ...spec, messageId: "BOB" })),
          reason: "own copy",
        })
        .expect(200),
    );
    expect(done.result).toMatchObject({ matched: 1, unmatched: 1 });
    expect(await lineJournal(preview.statement.id)).toEqual({
      "operator.sweep:operator_money": dec("400"),
      "operator.sweep:safeguard_bank": dec("-400"),
    });
    // 598 > the 597.60 left above the client liabilities: refused at the request, whoever would approve.
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-lines/${byRef("OWN-B").id}/classify`)
        .set(await admin(alice))
        .send({ reason: "supplier invoice", matchKind: "operator_sweep" })
        .expect(409),
    );
    expect(refused.error).toBe("bank_line_state");
    expect(refused.message).toMatch(/would spend client money/);
    // The bank did pay it: 0.40 of client money is gone, and the reserve says so (red) instead of a
    // sweep hiding it. The line waits to be explained (suspense here) until the operator tops up.
    expect(k.checkOf(await k.reconciliation(), "reserve_covers_liabilities").status).toBe("red");
    await fourEyes(`/admin/ramp/bank-lines/${byRef("OWN-B").id}/classify`, {
      reason: "unexplained debit, held",
      matchKind: "suspense",
    });
    expect(await balance("safeguard_bank")).toBe(dec("2"));
    await k.expectIdentities();
  });

  it("the reserve gate reads the latest confirmed statement: fresh passes, older than RAMP_RESERVE_MAX_AGE_BDAYS business days fails closed (§6.3, X5)", async () => {
    const gates = ctx.get(RampGatesService);
    expect(await gates.statementStatus()).toMatchObject({
      ok: false,
      reason: "statement_stale",
      detail: "no confirmed bank statement",
    });
    const { preview } = await bookStatement(statement(D[7], D[7], "500", []));
    expect(await gates.statementStatus()).toMatchObject({
      ok: true,
      statement: {
        statementId: preview.statement.id,
        periodTo: D[7],
        closingBalance: parseAmount("500"),
      },
    });
    const config = ctx.config.rampControls as { reserveGate: string };
    config.reserveGate = "enforce";
    try {
      await k.reconciliation();
      const buyer = await k.buyer("reserve");
      const fresh = await k.bought(buyer, "20");
      expect(fresh.status).toBe("completed");
      // The statement's period ends four business days ago now: stale (never skipped).
      await ctx.dataSource.query(
        `UPDATE to_ramp_bank_statements SET period_from = $2::date, period_to = $2::date WHERE id = $1`,
        [preview.statement.id, D[3]],
      );
      const stale = await gates.statementStatus();
      expect(stale).toMatchObject({ ok: false, reason: "statement_stale" });
      expect(stale.ok ? "" : stale.detail).toMatch(/business days ago/);
      const res = await k.openOnramp(buyer, "20");
      await k.pay(buyer, res, "succeeded");
      await k.drive();
      expect(await k.order(res.order.id)).toMatchObject({
        status: "paid",
        lastError: expect.stringMatching(/^reserve_gate:statement_stale/) as string,
      });
      expect(await k.commands(res.order.id)).toEqual([]);
      const rec = await k.reconciliation();
      expect(k.checkOf(rec, "reserve_covers_liabilities")).toMatchObject({
        status: "red",
        detail: expect.stringMatching(/statement_stale/) as string,
      });
    } finally {
      config.reserveGate = "warn";
    }
    await k.expectIdentities();
  });

  it("statements chain: the account, the opening = the previous closing, no business day missing, no overlap, no repeat; a valid CSV chains on (#11, X3, X16)", async () => {
    await bookStatement(statement(D[5], D[5], "1000", []));
    const refuse = async (
      spec: StatementSpec,
      code: string,
      format: "camt053" | "csv" = "camt053",
    ): Promise<string> => {
      const body = await upload(spec, format, 422);
      expect(body.error).toBe(code);
      return body.message;
    };
    expect(
      await refuse(
        { ...statement(nextDay(D[5]), D[6], "1000", []), account: OTHER_IBAN },
        "statement_account",
      ),
    ).toMatch(/client-money/);
    expect(
      await refuse(statement(nextDay(D[5]), D[6], "999.99", []), "statement_continuity"),
    ).toMatch(/opening balance/);
    expect(await refuse(statement(D[7], D[7], "1000", []), "statement_continuity")).toMatch(
      /business day/,
    );
    expect(await refuse(statement(D[5], D[6], "1000", []), "statement_continuity")).toMatch(
      /inside the confirmed statement/,
    );
    const broken = { ...statement(nextDay(D[5]), D[6], "1000", []), closing: "1001.00" };
    expect(await refuse(broken, "statement_invalid")).toMatch(/add up/);
    const future = statement(nextDay(nextDay(D[7])), nextDay(nextDay(nextDay(D[7]))), "1000", []);
    expect(await refuse(future, "statement_invalid")).toMatch(/future|period/);
    // A valid next statement in the CSV layout chains on; the same file twice is refused.
    const next = statement(nextDay(D[5]), D[6], "1000", [
      { ref: "FEE-9", amount: "0.50", date: D[6], iban: null, name: "Alfa-Bank", purpose: "fee" },
    ]);
    const draft = await upload(next, "csv");
    expect(draft.statement).toMatchObject({
      status: "draft",
      format: "csv",
      openingBalance: dec("1000"),
      closingBalance: dec("999.5"),
    });
    expect(draft.lines[0]).toMatchObject({ status: "proposed", matchKind: "bank_fee" });
    expect(await refuse(next, "statement_duplicate", "csv")).toMatch(/already uploaded/);
    // Hostile XML never reaches the parser (X16).
    const hostile = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/admin/ramp/bank-statements")
        .set(await admin(alice))
        .send({
          format: "camt053",
          content: base64('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Document/>'),
        })
        .expect(400),
    );
    expect(hostile.message).toMatch(/DOCTYPE/);
    await k.expectIdentities();
  });

  it("one batch-total debit quoting the bank's file reference pays every item; a held order blocks the file (#11, #4)", async () => {
    const one = await provedCustomer("total-a", "100", USER_IBAN);
    const two = await provedCustomer("total-b", "100", byIban("POIS", "4"));
    const o1 = await bankCashOut(one.b, "30", one.accountId);
    const o2 = await bankCashOut(two.b, "20", two.accountId);
    const draft = await createBatch();
    expect(draft.items.map((i) => i.orderId).sort()).toEqual([o1.id, o2.id].sort());
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
    // A hold on an order of an approved batch blocks the file until it is lifted (or the batch cancelled).
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET details = details || '{"hold": {"reason": "chargeback"}}'::jsonb WHERE id = $1`,
      [o2.id],
    );
    expect(await exportBatch(draft.batch.id, 409)).toMatch(/batch_held/);
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET details = details - 'hold' WHERE id = $1`,
      [o2.id],
    );
    await exportBatch(draft.batch.id);
    await submitBatch(draft.batch.id, "PP-BULK-42");
    // The bank books the whole file as one debit and names the file's reference.
    const st = await bookStatement(
      statement(D[7], D[7], "1000", [
        {
          ref: "BULK-1",
          amount: "50.00",
          date: D[7],
          iban: null,
          name: "Alfa-Bank",
          purpose: "Bulk payment file PP-BULK-42",
        },
      ]),
    );
    expect(st.preview.lines[0]).toMatchObject({
      status: "proposed",
      matchKind: "payout_batch",
      matchedBatchId: draft.batch.id,
    });
    for (const o of [o1, o2]) expect((await k.order(o.id)).status).toBe("completed");
    expect(await lineJournal(st.preview.statement.id)).toEqual({
      "offramp.paid_bank:payout_clearing": dec("50"),
      "offramp.paid_bank:safeguard_bank": dec("-50"),
    });
    expect(
      await ctx.dataSource
        .getRepository(RampPayoutBatchEntity)
        .findOneByOrFail({ id: draft.batch.id }),
    ).toMatchObject({
      status: "settled",
    });
    expect(k.checkOf(await k.reconciliation(), "bank_statement_matches_journal").status).toBe(
      "green",
    );
    await k.expectIdentities();
  });

  it("bank_unpaid {reverse}: statements prove no debit; the off-ramp re-mints and credits back (#5)", async () => {
    const { accountId, b } = await provedCustomer("unpaid-rev");
    const order = await bankCashOut(b, "50", accountId);
    const draft = await sendBatch();
    await ctx.dataSource.query(
      `UPDATE to_ramp_payout_batches SET submitted_at = $2::timestamptz, exported_at = $2::timestamptz WHERE id = $1`,
      [draft.batch.id, `${D[3]}T09:00:00Z`],
    );
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status_changed_at = $2::timestamptz WHERE id = $1`,
      [order.id, `${D[3]}T09:00:00Z`],
    );
    expect(await ctx.get(RampBankProcessor).tick()).toMatchObject({ aged: 1 });
    await bookStatement(statement(D[3], D[7], "1000", []));
    await fourEyes(`/admin/ramp/orders/${order.id}/bank_unpaid`, {
      reason: "never paid",
      then: "reverse",
    });
    await k.drive();
    expect(await k.order(order.id)).toMatchObject({ status: "refunded", payoutBatchId: null });
    expect(await k.journal(order.id)).toEqual({
      "offramp.burned:customer_liability": dec("50"),
      "offramp.burned:payout_clearing": dec("-50"),
      "offramp.reminted:payout_clearing": dec("50"),
      "offramp.reminted:customer_liability": dec("-50"),
    });
    expect((await k.commands(order.id)).map((c) => [c.kind, c.status])).toEqual([
      ["burn", "recorded"],
      ["mint", "recorded"],
    ]);
    await k.expectIdentities();
  });
});

describe("bank rail: the review's money cases (C3, C4, C5)", () => {
  it("an unbooked debit of a confirmed statement comes off the reserve: the gate refuses the next mint and reserve_covers_liabilities is red; booked to suspense it stays short (C3)", async () => {
    await bookStatement(statement(D[6], D[6], "1000", []));
    const config = ctx.config.rampControls as { reserveGate: string };
    config.reserveGate = "enforce";
    try {
      await k.reconciliation();
      const buyer = await k.buyer("unbooked");
      expect((await k.bought(buyer, "20")).status).toBe("completed");
      // A debit no rule explains takes the 1000 out; the confirm leaves it unbooked.
      const st = await bookStatement(
        statement(D[7], D[7], "1000", [
          {
            ref: "UNK-OUT",
            amount: "1000.00",
            date: D[7],
            iban: OTHER_IBAN,
            name: "Someone",
            purpose: "?",
          },
        ]),
      );
      expect(st.preview.lines[0]).toMatchObject({ status: "unmatched", flags: [] });
      expect(st.result).toMatchObject({ matched: 0, unmatched: 1 });
      expect(await ctx.get(RampGatesService).reserveSnapshot()).toMatchObject({
        unbookedDebits: dec("-1000"),
        assets: dec("19.52"),
      });
      expect(k.checkOf(await k.reconciliation(), "reserve_covers_liabilities")).toMatchObject({
        status: "red",
      });
      const res = await k.openOnramp(buyer, "20");
      await k.pay(buyer, res, "succeeded");
      await k.drive();
      expect(await k.order(res.order.id)).toMatchObject({
        status: "paid",
        lastError: expect.stringMatching(/^reserve_gate:reserve_short/) as string,
      });
      expect(await k.commands(res.order.id)).toEqual([]);
      // Booked to suspense (four-eyes) the journal shows the loss itself: as short as before.
      await fourEyes(`/admin/ramp/bank-lines/${st.preview.lines[0].id}/classify`, {
        reason: "unknown debit, recall requested",
        matchKind: "suspense",
      });
      expect(await ctx.get(RampGatesService).reserveSnapshot()).toMatchObject({
        unbookedDebits: dec("0"),
        assets: dec("39.04"),
      });
      expect(k.checkOf(await k.reconciliation(), "reserve_covers_liabilities")).toMatchObject({
        status: "red",
      });
      await k.drive();
      expect(await k.order(res.order.id)).toMatchObject({
        status: "paid",
        lastError: expect.stringMatching(/^reserve_gate:reserve_short/) as string,
      });
    } finally {
      config.reserveGate = "warn";
    }
    await k.expectIdentities();
  });

  it("a returned payout whose re-mint token-app refuses parks in needs_review(reversal); the matched return proves it unpaid, so retry resumes it → refunded (C4)", async () => {
    const { order } = await paidPayout("ret-retry", D[5]);
    // token-app refuses the re-mint the return starts, for good (403).
    ctx.tokenApp.nextPost = {
      outcome: {
        outcome: "rejected",
        httpStatus: 403,
        status: null,
        code: "token_app_forbidden",
        message: "forbidden",
      },
      lands: false,
    };
    const back = await bookStatement(
      statement(nextDay(D[5]), D[6], "950", [
        {
          ref: "CR-return",
          amount: "50.00",
          credit: true,
          date: D[6],
          iban: USER_IBAN,
          name: "AKB BELARUSBANK",
          purpose: `Возврат платежа ${order.payoutReference}: счет закрыт`,
          returnCode: "AC04",
        },
      ]),
    );
    expect(back.preview.lines[0]).toMatchObject({ matchKind: "payout_return" });
    await k.drive();
    expect(await k.order(order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "reversal",
    });
    // The return left the batch behind: the order no longer names it.
    expect((await k.order(order.id)).payoutBatchId).toBeNull();
    // The re-mint is re-sent under its id (four-eyes); the return, not the batch, says nothing was paid.
    await fourEyes(`/admin/ramp/orders/${order.id}/retry`, { reason: "token-app fixed" });
    await k.drive();
    expect(await k.order(order.id)).toMatchObject({ status: "refunded" });
    expect(await k.journal(order.id)).toMatchObject({
      "offramp.returned_bank:safeguard_bank": dec("50"),
      "offramp.reminted:payout_clearing": dec("50"),
      "offramp.reminted:customer_liability": dec("-50"),
    });
    expect((await k.commands(order.id)).map((c) => [c.kind, c.status])).toEqual([
      ["burn", "recorded"],
      ["mint", "recorded"],
    ]);
    await k.expectIdentities();
  });

  it("a chargeback while the cash-out sits in an approved batch holds the file; cancelling the batch sends the order to needs_review(compliance), never back to the queue held (C5)", async () => {
    const { b, accountId } = await provedCustomer("cb-batch");
    const card = await k.bought(b, "20");
    const order = await bankCashOut(b, "50", accountId);
    const draft = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
    await k.deliver(k.mock().chargeback(card.providerPaymentId ?? "", b.user.id));
    expect(await k.order(order.id)).toMatchObject({
      status: "payout_queued",
      payoutBatchId: draft.batch.id,
      details: { hold: { reason: "chargeback" } },
    });
    expect(await exportBatch(draft.batch.id, 409)).toMatch(/batch_held/);
    await ctx.agent
      .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/cancel`)
      .set(await admin(alice))
      .send({ reason: "chargeback on the account" })
      .expect(200);
    const left = await k.order(order.id);
    expect(left).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      payoutBatchId: null,
    });
    expect(left.details.hold ?? null).toBeNull();
    expect(left.details).toMatchObject({
      holdEndedReason: "chargeback",
      cancelledBatchId: draft.batch.id,
    });
    // The charged-back account is suspended: a retry cannot queue its payout again.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${order.id}/retry`)
          .set(await admin(alice))
          .send({ reason: "pay it" })
          .expect(409),
      ).message,
    ).toMatch(/the account is not active/);
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/ramp/payout-batches")
          .set(await admin(alice))
          .send({ reason: "daily payouts" })
          .expect(409),
      ),
    ).toMatchObject({ error: "batch_state", details: { skipped: [] } });
    await k.expectIdentities();
  });

  it("a frozen order's batch is voided after a chargeback: the suspended account's order goes to review, and an unbatched one of a suspended account is never drafted (C5)", async () => {
    const { b, accountId } = await provedCustomer("cb-frozen");
    const card = await k.bought(b, "20");
    const order = await bankCashOut(b, "50", accountId);
    const draft = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
    await exportBatch(draft.batch.id);
    const freezeId = await freezeUser(b.user.id);
    // The file is not downloaded again for a frozen account (R2a-1: `submitted` would record it).
    expect(await exportBatch(draft.batch.id, 409)).toMatch(/batch_held/);
    expect((await k.order(order.id)).details.hold).toMatchObject({ reason: "frozen" });
    // The chargeback finds the order already held (frozen): the account is suspended all the same.
    await k.deliver(k.mock().chargeback(card.providerPaymentId ?? "", b.user.id));
    expect(
      (await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: b.user.id })).status,
    ).toBe("suspended");
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/void`, {
      reason: "the bank rejected the file",
      bankRejectionRef: "REJ-1",
    });
    await liftFreeze(freezeId);
    expect(await k.order(order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      payoutBatchId: null,
    });
    // A queued order of an account suspended some other way is sent to review by the draft.
    const other = await provedCustomer("suspended", "100", byIban("POIS", "4"));
    const queued = await bankCashOut(other.b, "30", other.accountId);
    await ctx.get(UserService).suspend(other.b.user.id, "operator decision", { type: "system" });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/ramp/payout-batches")
          .set(await admin(alice))
          .send({ reason: "daily payouts" })
          .expect(409),
      ),
    ).toMatchObject({
      error: "batch_state",
      details: {
        skipped: [{ orderId: queued.id, reason: expect.stringMatching(/not active/) as string }],
      },
    });
    expect(await k.order(queued.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
    });
    await k.expectIdentities();
  });
});

describe("bank rail: the review's statement cases (C6, C7, C10)", () => {
  /** Three customers' cash-outs of 30, 20 and 10 in one submitted batch, sent on D[3]. */
  async function threeSent(hint: string): Promise<{
    orders: ApiRampOrder[];
    draft: ApiPayoutBatchDraft;
  }> {
    const ibans = [USER_IBAN, byIban("POIS", "4"), byIban("BLNB", "7")];
    const orders: ApiRampOrder[] = [];
    for (const [i, amount] of ["30", "20", "10"].entries()) {
      const c = await provedCustomer(`${hint}-${i}`, "100", ibans[i]);
      orders.push(await bankCashOut(c.b, amount, c.accountId));
    }
    const draft = await sendBatch();
    expect(draft.items).toHaveLength(3);
    await sentOn(
      draft.batch.id,
      D[3],
      orders.map((o) => o.id),
    );
    return { orders, draft };
  }

  it("the bank books part of a batch as one entry naming each transaction: those items complete, the rest ages into review and only it is proven unpaid (C6)", async () => {
    const { orders, draft } = await threeSent("part");
    const doc = (o: ApiRampOrder): string =>
      draft.items.find((i) => i.orderId === o.id)!.documentNo;
    // The bank rejected the third transfer and booked the other two as one entry.
    const st = await bookStatement(
      statement(D[3], D[7], "1000", [
        {
          ref: "BULK-PART",
          amount: "50.00",
          date: D[4],
          transactions: orders.slice(0, 2).map((o) => ({
            endToEnd: o.payoutReference ?? "",
            documentNo: doc(o),
          })),
          entryInfo: "Bulk payment file PP-2026-0001",
        },
      ]),
    );
    expect(st.preview.lines[0]).toMatchObject({
      status: "proposed",
      matchKind: "payout_batch",
      matchedBatchId: draft.batch.id,
    });
    expect((await k.order(orders[0].id)).status).toBe("completed");
    expect((await k.order(orders[1].id)).status).toBe("completed");
    expect((await k.order(orders[2].id)).status).toBe("payout_sent");
    expect(await batchRow(draft.batch.id)).toMatchObject({ status: "submitted" });
    expect(await lineJournal(st.preview.statement.id)).toEqual({
      "offramp.paid_bank:payout_clearing": dec("50"),
      "offramp.paid_bank:safeguard_bank": dec("-50"),
    });
    // The third ages into review; statements prove nothing left for it.
    expect(await ctx.get(RampBankProcessor).tick()).toMatchObject({ aged: 1 });
    const requeued = (await fourEyes(`/admin/ramp/orders/${orders[2].id}/bank_unpaid`, {
      reason: "rejected by the bank",
      then: "requeue",
    })) as { status: string };
    expect(requeued.status).toBe("payout_queued");
    expect(await batchRow(draft.batch.id)).toMatchObject({ status: "settled" });
    await k.expectIdentities();
  });

  it("a batch-booked debit whose transactions name nothing blocks bank_unpaid: it names the file (C6)", async () => {
    const { orders } = await threeSent("blind");
    // One debit naming the bank's reference of the file, 50 of a 60 batch: no rule can book it.
    const st = await bookStatement(
      statement(D[3], D[7], "1000", [
        {
          ref: "BULK-BLIND",
          amount: "50.00",
          date: D[4],
          iban: null,
          name: "Alfa-Bank",
          purpose: "Bulk payment file PP-2026-0001",
        },
      ]),
    );
    expect(st.preview.lines[0]).toMatchObject({ status: "unmatched", matchKind: null });
    expect(await ctx.get(RampBankProcessor).tick()).toMatchObject({ aged: 3 });
    for (const o of orders)
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/orders/${o.id}/bank_unpaid`)
            .set(await admin(alice))
            .send({ reason: "no debit for it", then: "requeue" })
            .expect(409),
        ).message,
      ).toMatch(/not proven unpaid: statement line BULK-BLIND names the batch/);
    // Booked to suspense, it still names the file: still not proven.
    await fourEyes(`/admin/ramp/bank-lines/${st.preview.lines[0].id}/classify`, {
      reason: "unknown bulk debit",
      matchKind: "suspense",
    });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${orders[0].id}/bank_unpaid`)
          .set(await admin(alice))
          .send({ reason: "no debit for it", then: "reverse" })
          .expect(409),
      ).message,
    ).toMatch(/not proven unpaid: statement line BULK-BLIND/);
    await k.expectIdentities();
  });

  it("a debit of an exported batch's total that names nothing blocks its void: the file may have been paid (C6)", async () => {
    const c = await provedCustomer("void-blind");
    const order = await bankCashOut(c.b, "40", c.accountId);
    const draft = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
    await exportBatch(draft.batch.id);
    await ctx.dataSource.query(
      `UPDATE to_ramp_payout_batches SET exported_at = $2::timestamptz WHERE id = $1`,
      [draft.batch.id, `${D[3]}T09:00:00Z`],
    );
    await bookStatement(
      statement(D[3], D[7], "1000", [
        {
          ref: "OUT-40",
          amount: "40.00",
          date: D[4],
          iban: null,
          name: "Alfa-Bank",
          purpose: "Payment file",
        },
      ]),
    );
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/void`)
          .set(await admin(alice))
          .send({ reason: "file never executed" })
          .expect(409),
      ).message,
    ).toMatch(/cannot be voided yet: an unexplained debit .*OUT-40/);
    expect((await k.order(order.id)).payoutBatchId).toBe(draft.batch.id);
    await k.expectIdentities();
  });
});

describe("bank rail: the review's proof and key cases (C7, C10, C41, F3)", () => {
  it("the confirming person's copy must agree on every field the rules read: a copy whose batch text was blanked, or a CSV of a camt.053, is statement_mismatch (C7)", async () => {
    const one = await provedCustomer("copy-a", "100", USER_IBAN);
    const two = await provedCustomer("copy-b", "100", byIban("POIS", "4"));
    await bankCashOut(one.b, "30", one.accountId);
    await bankCashOut(two.b, "20", two.accountId);
    const draft = await sendBatch();
    // The bank books the file as one debit naming the batch; the uploader blanks that text.
    const genuine = statement(D[7], D[7], "1000", [
      {
        ref: "BULK-1",
        amount: "50.00",
        date: D[7],
        iban: null,
        name: "Alfa-Bank",
        purpose: `Bulk payment file ${draft.batch.id}`,
      },
    ]);
    const forged = { ...genuine, entries: [{ ...genuine.entries[0], purpose: "Bulk payment" }] };
    const preview = await upload(forged);
    expect(preview.lines[0]).toMatchObject({ status: "unmatched" });
    const requested = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
        .set(await admin(alice))
        .send({ reason: "statement in" })
        .expect(202),
    ).approval;
    for (const [copy, format] of [
      [camt053({ ...genuine, messageId: "MSG-BOB" }), "camt053"],
      [statementCsv(forged), "csv"],
    ] as const)
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm/approve`)
            .set(await admin(bob))
            .send({ format, content: base64(copy), reason: "my own download" })
            .expect(409),
        ),
      ).toMatchObject({ error: "statement_mismatch" });
    const audit = await ctx.dataSource.query<{ action: string }[]>(
      `SELECT action FROM to_audit_events WHERE subject_id = $1 AND action LIKE 'ramp.statement.copy_%'`,
      [preview.statement.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      "ramp.statement.copy_mismatch",
      "ramp.statement.copy_mismatch",
    ]);
    const approval = await ctx.agent
      .get(`/api/v1/admin/approvals/${requested.id}`)
      .set(await admin(alice))
      .expect(200);
    expect(bodyOf<{ approval: ApiApproval }>(approval).approval.status).toBe("pending");
  });

  it("payer_match needs the payer's bank to name the account holder: a third party's IBAN or a checkout-typed name proves nothing (C10)", async () => {
    const b = await customer("payer");
    // A third party paid the user's ERIP order from their own account; the user adds that IBAN.
    const third = ((await addAccount(b, OTHER_IBAN)) as { account: ApiRampBankAccount }).account;
    await eripBuy(b, "30", OTHER_IBAN, { payerName: "ПЕТРОВ ПЁТР" });
    await coolOff(third.id);
    expect((await accounts(b)).find((a) => a.id === third.id)).toMatchObject({
      status: "pending_proof",
      proof: null,
    });
    // The user's own IBAN with a name typed at the checkout is no evidence either.
    const own = ((await addAccount(b, USER_IBAN)) as { account: ApiRampBankAccount }).account;
    await eripBuy(b, "30", USER_IBAN, { payerName: bankPayerName(b), payerNameSource: "checkout" });
    await coolOff(own.id);
    expect((await accounts(b)).find((a) => a.id === own.id)).toMatchObject({
      status: "pending_proof",
    });
    // The payer's bank names the user from it: proved.
    await eripBuy(b, "30", USER_IBAN);
    expect((await accounts(b)).find((a) => a.id === own.id)).toMatchObject({
      status: "active",
      proof: "payer_match",
    });
    expect((await accounts(b)).find((a) => a.id === third.id)).toMatchObject({
      status: "pending_proof",
    });
    // A third party with the user's surname only (a relative) proves nothing.
    const relative = await customer("payer-rel");
    const relIban = byIban("BLNB", "7");
    const acc = ((await addAccount(relative, relIban)) as { account: ApiRampBankAccount }).account;
    const surname = NAMES.get(relative.user.id)!.last.toUpperCase();
    await eripBuy(relative, "30", relIban, { payerName: `${surname} MARYIA` });
    await coolOff(acc.id);
    expect((await accounts(relative)).find((a) => a.id === acc.id)).toMatchObject({
      status: "pending_proof",
    });
  });
});

describe("bank rail: blind-index keys and the submission's reason (C41, F3)", () => {
  it("every blind index the bank rail stores counts for the keyring's boot refusal; a draft statement moves to a new key and still confirms (C41)", async () => {
    const sealed = ctx.get(SealedDataService);
    // The registered re-indexers by name (the registry is the boot refusal's input).
    const registry = (sealed as unknown as { reindexers: Map<string, BlindIndexReindexer> })
      .reindexers;
    const counts = async (name: string): Promise<Record<string, number> | null> =>
      (await registry.get(name)?.countByKid()) ?? null;
    const ring = ctx.config.sealing.index as { activeKid: string; keys: Map<string, Buffer> };
    const oldKid = ring.activeKid;
    const oldKey = ring.keys.get(oldKid)!;
    // An ERIP payment's payer hash (payer_match evidence) and a draft statement awaiting its confirm.
    await provedCustomer("rotate");
    const spec = statement(D[7], D[7], "1000", []);
    const preview = await upload(spec);
    await ctx.agent
      .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
      .set(await admin(alice))
      .send({ reason: "statement in" })
      .expect(202);
    expect(await counts("ramp-statement-canonical")).toEqual({ [oldKid]: 1 });
    expect(await counts("ramp-payer-iban-hashes")).toEqual({ [oldKid]: 1 });
    try {
      // Rotation: a new active kid, the re-index pass, then the old kid dropped.
      ring.keys.set("i-next", Buffer.alloc(32, 9));
      ring.activeKid = "i-next";
      await sealed.resealPass();
      expect(await counts("ramp-statement-canonical")).toEqual({ "i-next": 1 });
      // The acquirer's payer hashes cannot be re-derived: they keep the old kid in the ring.
      expect(await counts("ramp-payer-iban-hashes")).toEqual({ [oldKid]: 1 });
      ring.keys.delete(oldKid);
      await expect(sealed.assertKeyringsCoverStoredData()).rejects.toThrow(
        /ramp-payer-iban-hashes has 1 row\(s\) under kid/,
      );
      // The re-indexed draft: the second person's own copy still matches.
      const done = bodyOf<{ approval: ApiApproval }>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm/approve`)
          .set(await admin(bob))
          .send({
            format: "camt053",
            content: base64(camt053({ ...spec, messageId: "MSG-BOB" })),
            reason: "my own download",
          })
          .expect(200),
      );
      expect(done.approval.status).toBe("executed");
    } finally {
      ring.keys.set(oldKid, oldKey);
      ring.activeKid = oldKid;
      ring.keys.delete("i-next");
    }
  });

  it("submitted keeps the operator's optional reason: on the batch and in its audit (F3)", async () => {
    const { b, accountId } = await provedCustomer("submit-reason");
    await bankCashOut(b, "50", accountId);
    const draft = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
    await exportBatch(draft.batch.id);
    await ctx.agent
      .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/submitted`)
      .set(await admin(alice))
      .send({ bankReference: "PP-9", reason: "uploaded to the bank portal" })
      .expect(200);
    expect((await batchRow(draft.batch.id)).details).toMatchObject({
      submitReason: "uploaded to the bank portal",
    });
    const [audit] = await ctx.dataSource.query<{ metadata: Record<string, unknown> }[]>(
      `SELECT metadata FROM to_audit_events WHERE action = 'ramp.batch.submitted' AND subject_id = $1`,
      [draft.batch.id],
    );
    expect(audit.metadata).toMatchObject({
      bankReference: "PP-9",
      reason: "uploaded to the bank portal",
    });
  });
});

describe("bank rail: the payout gate and holds on the batch path (C36, C37)", () => {
  it("a payouts halt refuses a batch approval (request and decision) and the first export; under an enforcing gate a missing run refuses the first export (C36)", async () => {
    const one = await provedCustomer("halt-a", "100", USER_IBAN);
    const two = await provedCustomer("halt-b", "100", byIban("POIS", "4"));
    const o1 = await bankCashOut(one.b, "30", one.accountId);
    const first = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${first.batch.id}/approve`, { reason: "batch ok" });
    const o2 = await bankCashOut(two.b, "20", two.accountId);
    const second = await createBatch();
    expect(second.items.map((i) => i.orderId)).toEqual([o2.id]);
    const requested = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/payout-batches/${second.batch.id}/approve`)
        .set(await admin(alice))
        .send({ reason: "batch ok" })
        .expect(202),
    ).approval;
    await ctx.agent
      .post("/api/v1/admin/ramp/controls/halt")
      .set(await admin(alice))
      .send({ scopes: ["payouts"], reason: "incident drill" })
      .expect(200);
    expect(await bobApproves(requested, 409)).toMatchObject({
      error: "approval_precondition_changed",
      details: { cause: "payout_gate", reason: "payouts_halted" },
    });
    expect(await batchRow(second.batch.id)).toMatchObject({ status: "draft", approvalId: null });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/payout-batches/${second.batch.id}/approve`)
          .set(await admin(alice))
          .send({ reason: "again" })
          .expect(409),
      ),
    ).toMatchObject({ error: "payout_gate", details: { reason: "payouts_halted" } });
    expect(await exportBatch(first.batch.id, 409)).toMatch(/payout_gate/);
    expect(await batchRow(first.batch.id)).toMatchObject({
      status: "approved",
      exportCount: 0,
      fileSha256: null,
    });
    for (const o of [o1, o2]) expect((await k.order(o.id)).status).toBe("payout_queued");
    expect(
      await ctx.dataSource.query(
        `SELECT 1 FROM to_audit_events WHERE action = 'ramp.batch.exported'`,
      ),
    ).toEqual([]);
    // The halt lifted (four-eyes) and the gate enforcing: no full run on record refuses the first file.
    await fourEyes("/admin/ramp/controls/resume", { reason: "drill over" });
    const config = ctx.config.rampControls as { payoutGate: string };
    config.payoutGate = "enforce";
    try {
      await ctx.dataSource.query(`DELETE FROM to_ramp_recon_runs`);
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/payout-batches/${first.batch.id}/export`)
            .set(await admin(alice))
            .send({})
            .expect(409),
        ),
      ).toMatchObject({ error: "payout_gate", details: { reason: "recon_missing" } });
      expect(await batchRow(first.batch.id)).toMatchObject({ status: "approved", exportCount: 0 });
    } finally {
      config.payoutGate = "warn";
    }
    await exportBatch(first.batch.id);
    expect(await batchRow(first.batch.id)).toMatchObject({ status: "exported", exportCount: 1 });
  });

  it("a freeze arriving after MarkPaid holds the payout at every batch step we control: the draft skips it, the approval and the file are refused; the bank's acceptance is still recorded and flags it (C37, R2a-1)", async () => {
    const one = await provedCustomer("hold-a", "100", USER_IBAN);
    const two = await provedCustomer("hold-b", "100", byIban("POIS", "4"));
    const o1 = await bankCashOut(one.b, "30", one.accountId);
    const o2 = await bankCashOut(two.b, "20", two.accountId);
    const approve = async (batchId: string, status: number): Promise<ErrorBody> =>
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/payout-batches/${batchId}/approve`)
          .set(await admin(alice))
          .send({ reason: "batch ok" })
          .expect(status),
      );
    const cancel = async (batchId: string): Promise<void> => {
      await ctx.agent
        .post(`/api/v1/admin/ramp/payout-batches/${batchId}/cancel`)
        .set(await admin(alice))
        .send({ reason: "rebuild" })
        .expect(200);
    };
    // The draft: the frozen account's order is skipped (it stays queued).
    const f2 = await freezeUser(two.b.user.id);
    const draft = await createBatch();
    expect(draft.items.map((i) => i.orderId)).toEqual([o1.id]);
    expect(draft.skipped).toEqual([{ orderId: o2.id, reason: "held: frozen" }]);
    // The approval: a freeze after the draft refuses the request; the hold is written on the order.
    const f1 = await freezeUser(one.b.user.id);
    expect(await approve(draft.batch.id, 409)).toMatchObject({
      error: "batch_held",
      details: { held: [{ orderId: o1.id, reason: "frozen" }] },
    });
    expect(await k.order(o1.id)).toMatchObject({ details: { hold: { reason: "frozen" } } });
    // Lifted, the draft cancelled: the hold clears and the next draft takes both.
    await liftFreeze(f1);
    await liftFreeze(f2);
    await cancel(draft.batch.id);
    expect((await k.order(o1.id)).details.hold ?? null).toBeNull();
    const next = await createBatch();
    expect(next.items.map((i) => i.orderId).sort()).toEqual([o1.id, o2.id].sort());
    // The file: a freeze after the approval refuses the first export.
    await fourEyes(`/admin/ramp/payout-batches/${next.batch.id}/approve`, { reason: "batch ok" });
    const f3 = await freezeUser(one.b.user.id);
    expect(await exportBatch(next.batch.id, 409)).toMatch(/batch_held/);
    expect(await batchRow(next.batch.id)).toMatchObject({ status: "approved", exportCount: 0 });
    await liftFreeze(f3);
    await cancel(next.batch.id);
    const third = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${third.batch.id}/approve`, { reason: "batch ok" });
    await exportBatch(third.batch.id);
    // R2a-1: a freeze after the export holds the file (no second download), but `submitted` is
    // the bank's acceptance of the file already uploaded: recorded, the frozen order flagged.
    await freezeUser(two.b.user.id);
    expect(await exportBatch(third.batch.id, 409)).toMatch(/batch_held/);
    await submitBatch(third.batch.id, "PP-HOLD");
    expect(await batchRow(third.batch.id)).toMatchObject({ status: "submitted" });
    for (const o of [o1, o2]) expect((await k.order(o.id)).status).toBe("payout_sent");
    expect((await k.order(o2.id)).details).toMatchObject({
      heldAtBank: { reason: "frozen", batchId: third.batch.id },
    });
    expect((await k.order(o1.id)).details.heldAtBank ?? null).toBeNull();
    await k.expectIdentities();
  });

  it("a compliance review that starts holding after MarkPaid holds the batch path; refund_bank is refused while a review holds the on-ramp or its account is frozen (C37)", async () => {
    const port = stubCompliance({ "offramp.create": REVIEW });
    try {
      const c = await provedCustomer("hold-aml");
      const order = await bankCashOut(c.b, "40", c.accountId);
      port.held = true;
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post("/api/v1/admin/ramp/payout-batches")
            .set(await admin(alice))
            .send({ reason: "daily payouts" })
            .expect(409),
        ),
      ).toMatchObject({
        details: { skipped: [{ orderId: order.id, reason: "held: compliance" }] },
      });
      port.held = false;
      const draft = await createBatch();
      expect(draft.items.map((i) => i.orderId)).toEqual([order.id]);
      port.held = true;
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/approve`)
            .set(await admin(alice))
            .send({ reason: "batch ok" })
            .expect(409),
        ),
      ).toMatchObject({
        error: "batch_held",
        details: { held: [{ orderId: order.id, reason: "compliance" }] },
      });
    } finally {
      port.unbind();
    }
    // An ERIP on-ramp the acquirer captured short (refund only) whose capture review still holds it.
    const review = stubCompliance({ "onramp.capture": REVIEW });
    try {
      const b = await customer("hold-refund");
      const { account } = (await addAccount(b, byIban("BLNB", "7"))) as {
        account: ApiRampBankAccount;
      };
      const res = await k.openOnramp(b, "50", nextKey(), "erip");
      await k.pay(b, res, "succeeded", {
        channel: "online",
        payerIban: byIban("BLNB", "7"),
        payerNameSource: "bank",
        payerName: bankPayerName(b),
        capturedAmount: "40",
      });
      expect(await k.order(res.order.id)).toMatchObject({ status: "needs_review" });
      const refundBank = async (): Promise<string> =>
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/orders/${res.order.id}/refund_bank`)
            .set(await admin(alice))
            .send({ reason: "refund", bankAccountId: account.id })
            .expect(409),
        ).message;
      review.held = true;
      expect(await refundBank()).toMatch(/a compliance review holds this order/);
      review.held = false;
      await freezeUser(b.user.id);
      expect(await refundBank()).toMatch(/the account is frozen/);
      expect((await k.order(res.order.id)).status).toBe("needs_review");
    } finally {
      review.unbind();
    }
  });
});

describe("bank rail: four-eyes between people on batches (C38)", () => {
  it("a batch's creator cannot approve it, and an operator linked to a payee can neither draft it, approve it (either side) nor void it", async () => {
    const one = await provedCustomer("people-a");
    const order = await bankCashOut(one.b, "30", one.accountId);
    const links = ctx.config.rampControls.operatorAccounts;
    const requestApprove = async (w: TestWallet, batchId: string): Promise<ApiApproval> =>
      bodyOf<{ approval: ApiApproval }>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/payout-batches/${batchId}/approve`)
          .set(await admin(w))
          .send({ reason: "batch ok" })
          .expect(202),
      ).approval;
    // Alice drafts, Bob requests, Alice approves: her own batch, refused at execution.
    const draft = await createBatch();
    const byBob = await requestApprove(bob, draft.batch.id);
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/approvals/${byBob.id}/approve`)
          .set(await admin(alice))
          .send({ reason: "mine" })
          .expect(409),
      ),
    ).toMatchObject({ error: "approval_failed", details: { cause: "approval_same_person" } });
    expect(await batchRow(draft.batch.id)).toMatchObject({ status: "draft", approvalId: null });
    try {
      // The approver linked to the payee (ADMIN_OPERATOR_ACCOUNTS).
      const byAlice = await requestApprove(alice, draft.batch.id);
      links.set("bob", [one.b.user.id]);
      expect(await bobApproves(byAlice, 409)).toMatchObject({
        error: "approval_failed",
        details: { cause: "approval_linked_person" },
      });
      links.delete("bob");
      // The requester linked: the approval fails all the same.
      links.set("alice", [one.b.user.id]);
      const linkedRequest = await requestApprove(alice, draft.batch.id);
      expect(await bobApproves(linkedRequest, 409)).toMatchObject({
        error: "approval_failed",
        details: { cause: "approval_linked_person" },
      });
      expect(await batchRow(draft.batch.id)).toMatchObject({ status: "draft", approvalId: null });
      // A linked operator's draft skips the payout.
      await ctx.agent
        .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/cancel`)
        .set(await admin(alice))
        .send({ reason: "rebuild" })
        .expect(200);
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post("/api/v1/admin/ramp/payout-batches")
            .set(await admin(alice))
            .send({ reason: "daily payouts" })
            .expect(409),
        ),
      ).toMatchObject({
        error: "batch_state",
        details: {
          skipped: [{ orderId: order.id, reason: "the order belongs to an account linked to you" }],
        },
      });
      links.delete("alice");
      // The void of an exported batch: the approver linked fails it.
      const next = await createBatch();
      await fourEyes(`/admin/ramp/payout-batches/${next.batch.id}/approve`, { reason: "batch ok" });
      await exportBatch(next.batch.id);
      const voidRequest = bodyOf<{ approval: ApiApproval }>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/payout-batches/${next.batch.id}/void`)
          .set(await admin(alice))
          .send({ reason: "rejected", bankRejectionRef: "REJ-9" })
          .expect(202),
      ).approval;
      links.set("bob", [one.b.user.id]);
      expect(await bobApproves(voidRequest, 409)).toMatchObject({
        error: "approval_failed",
        details: { cause: "approval_linked_person" },
      });
      expect(await batchRow(next.batch.id)).toMatchObject({ status: "exported" });
    } finally {
      links.delete("alice");
      links.delete("bob");
    }
  });
});

describe("review group A: disputes that meet a bank refund or a batched cash-out (C19, C5)", () => {
  let n = 70;
  /** A card on-ramp stuck in review (no 3-D Secure), bank-refunded four-eyes: payout_queued. */
  async function bankRefundQueued(
    hint: string,
  ): Promise<{ b: Buyer; orderId: string; paymentId: string; accountId: string }> {
    const b = await customer(hint);
    const { account } = (await addAccount(b, byIban("AKBB", String((n += 1))))) as {
      account: ApiRampBankAccount;
    };
    const res = await k.openOnramp(b, "40");
    await k.pay(b, res, "no_3ds");
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
    });
    await coolOff(account.id);
    await fourEyes(`/admin/ramp/bank-accounts/${account.id}/verify`, {
      reason: "bank letter",
      proofRef: `letter ${hint}`,
    });
    expect(
      await fourEyes(`/admin/ramp/orders/${res.order.id}/refund_bank`, {
        reason: "refund by bank transfer",
        bankAccountId: account.id,
      }),
    ).toMatchObject({ status: "payout_queued" });
    return { b, orderId: res.order.id, paymentId: k.paymentIdOf(res), accountId: account.id };
  }

  async function refused(orderId: string, action: string, body: Record<string, unknown> = {}) {
    return bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${orderId}/${action}`)
        .set(await admin(alice))
        .send({ reason: `e2e ${action}`, ...body })
        .expect(409),
    );
  }

  it("C19: a chargeback on a card on-ramp whose bank refund is queued stops that refund — needs_review(refund), the dispute booked; retry, fail and refund_bank refuse; no draft pays it", async () => {
    const { b, orderId, paymentId, accountId } = await bankRefundQueued("c19-queued");
    await k.deliver(k.mock().chargeback(paymentId, b.user.id));
    expect(await k.order(orderId)).toMatchObject({
      status: "needs_review",
      reviewStep: "refund",
      payoutBatchId: null,
      details: { chargeback: { state: "charged_back", kind: "chargeback" } },
    });
    expect(await k.journal(orderId)).toMatchObject({
      "onramp.refund_queued:payout_clearing": dec("-40"),
      "onramp.chargeback_after_refund:chargeback_receivable": dec("40"),
      "onramp.chargeback_after_refund:provider_clearing": dec("-40"),
    });
    // Even with the account reinstated, the stopped refund never queues again (the issuer paid it).
    await ctx.get(UserService).reinstate(b.user.id, "dispute reviewed", { type: "system" });
    expect((await refused(orderId, "retry")).message).toMatch(/chargeback returned this payment/);
    expect((await refused(orderId, "fail")).message).toMatch(/already released/);
    expect((await refused(orderId, "refund_bank", { bankAccountId: accountId })).message).toMatch(
      /chargeback is open/,
    );
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/ramp/payout-batches")
          .set(await admin(alice))
          .send({ reason: "daily payouts" })
          .expect(409),
      ),
    ).toMatchObject({ error: "batch_state" });
    // Read again (an event retry, the post-close poll): booked once, nothing moves.
    await k.fulfilment().refreshPayment(orderId);
    expect(await k.order(orderId)).toMatchObject({ status: "needs_review", reviewStep: "refund" });
    expect(await k.journal(orderId)).toMatchObject({
      "onramp.chargeback_after_refund:chargeback_receivable": dec("40"),
    });
    await k.expectIdentities();
  });

  it("C19: the acquirer's own reversal holds a bank refund in an approved batch (batch_held); a chargeback on one the bank already has is flagged, never an illegal transition", async () => {
    const sent = await bankRefundQueued("c19-sent");
    await sendBatch();
    expect((await k.order(sent.orderId)).status).toBe("payout_sent");
    const batched = await bankRefundQueued("c19-batched");
    const draft = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });

    await k.deliver(k.mock().pspRefund(batched.paymentId));
    expect(await k.order(batched.orderId)).toMatchObject({
      status: "payout_queued",
      payoutBatchId: draft.batch.id,
      details: {
        hold: { reason: "chargeback" },
        chargeback: { state: "charged_back", kind: "psp_reversal" },
      },
    });
    expect(await exportBatch(draft.batch.id, 409)).toMatch(/batch_held/);

    await k.deliver(k.mock().chargeback(sent.paymentId, sent.b.user.id));
    expect(await k.order(sent.orderId)).toMatchObject({
      status: "payout_sent",
      details: { chargeback: { state: "charged_back", kind: "chargeback" } },
    });
    expect(
      await ctx.dataSource.query(
        `SELECT 1 FROM to_ramp_events WHERE dead_at IS NOT NULL OR (processed_at IS NULL AND attempts > 0)`,
      ),
    ).toEqual([]);
    await k.expectIdentities();
  });

  it("C19: the acquirer's own reversal while a bank refund is queued stops it in needs_review(refund); fail refuses to release the capture a second time", async () => {
    const { orderId, paymentId } = await bankRefundQueued("c19-reversal");
    await k.deliver(k.mock().pspRefund(paymentId));
    expect(await k.order(orderId)).toMatchObject({
      status: "needs_review",
      reviewStep: "refund",
      payoutBatchId: null,
      details: { chargeback: { state: "charged_back", kind: "psp_reversal" } },
    });
    // The acquirer shows the money returned, but onramp.refund_queued already released it: a
    // `fail` (onramp.voided) would release it twice — a person settles the two.
    expect((await refused(orderId, "fail")).message).toMatch(
      /already released \(onramp\.refund_queued\)/,
    );
    expect(Object.keys(await k.journal(orderId))).not.toContain("onramp.voided:issuance_pending");
    await k.expectIdentities();
  });

  it("C5: a chargeback while a cash-out sits in a DRAFT batch takes it out of the draft into needs_review(compliance); the draft can no longer be approved", async () => {
    const { b, accountId } = await provedCustomer("c5-draft", "100", byIban("AKBB", "81"));
    const card = await k.bought(b, "20");
    const order = await bankCashOut(b, "50", accountId);
    const draft = await createBatch();
    expect((await k.order(order.id)).payoutBatchId).toBe(draft.batch.id);
    await k.deliver(k.mock().chargeback(card.providerPaymentId ?? "", b.user.id));
    const left = await k.order(order.id);
    expect(left).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      payoutBatchId: null,
      details: { leftBatchId: draft.batch.id },
    });
    expect(left.details.hold ?? null).toBeNull();
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/approve`)
          .set(await admin(alice))
          .send({ reason: "batch ok" })
          .expect(409),
      ).message,
    ).toMatch(/no longer queued in this batch/);
    await k.expectIdentities();
  });

  it("C5: a chargeback overwrites a self-lifting hold (frozen) on a batched cash-out — lifting the freeze no longer frees the file", async () => {
    const { b, accountId } = await provedCustomer("c5-frozen", "100", byIban("AKBB", "82"));
    const card = await k.bought(b, "20");
    const order = await bankCashOut(b, "50", accountId);
    const draft = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
    await exportBatch(draft.batch.id);
    const freezeId = await freezeUser(b.user.id);
    expect(await exportBatch(draft.batch.id, 409)).toMatch(/batch_held/);
    expect((await k.order(order.id)).details.hold).toMatchObject({ reason: "frozen" });
    await k.deliver(k.mock().chargeback(card.providerPaymentId ?? "", b.user.id));
    expect((await k.order(order.id)).details.hold).toMatchObject({
      reason: "chargeback",
      replaced: "frozen",
    });
    await liftFreeze(freezeId);
    expect(await exportBatch(draft.batch.id, 409)).toMatch(/batch_held/);
    expect((await k.order(order.id)).details.hold).toMatchObject({ reason: "chargeback" });
    await k.expectIdentities();
  });
});

describe("W9f: AML's return on a bank cash-out (C25)", () => {
  const pages = (paged: { mock: { calls: unknown[][] } }, message: string): number =>
    paged.mock.calls.filter((c) => c[0] === message).length;

  it("W9f C25: a returned alert never lifts by itself — an unbatched cash-out is never drafted (review; reverse re-mints and credits back); one in a draft leaves it at the approval, which then goes on without it", async () => {
    const port = stubCompliance({ "offramp.create": REVIEW });
    try {
      const one = await provedCustomer("ret-a", "100", USER_IBAN);
      const two = await provedCustomer("ret-b", "100", byIban("POIS", "4"));
      const three = await provedCustomer("ret-c", "100", byIban("AKBB", "83"));
      const o1 = await bankCashOut(one.b, "30", one.accountId);
      const o2 = await bankCashOut(two.b, "20", two.accountId);
      const o3 = await bankCashOut(three.b, "10", three.accountId);
      // AML returns o1's alert before any draft: never batched, it waits in the compliance review.
      port.returned.add(o1.id);
      const draft = await createBatch();
      expect(draft.items.map((i) => i.orderId).sort()).toEqual([o2.id, o3.id].sort());
      expect(draft.skipped).toEqual([
        { orderId: o1.id, reason: "needs review: AML decided not to pay this cash-out out" },
      ]);
      expect(await k.order(o1.id)).toMatchObject({
        status: "needs_review",
        reviewStep: "compliance",
        payoutBatchId: null,
        details: { complianceReturn: { at: expect.any(String) as string } },
      });
      // Never paid: retry says why and points to reverse, which re-mints and credits the 30 back.
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/orders/${o1.id}/retry`)
            .set(await admin(alice))
            .send({ reason: "pay it" })
            .expect(409),
        ),
      ).toMatchObject({
        message: expect.stringMatching(/AML decided to return/) as string,
        details: { use: "reverse" },
      });
      await fourEyes(`/admin/ramp/orders/${o1.id}/reverse`, { reason: "AML return" });
      await k.drive();
      expect((await k.order(o1.id)).status).toBe("refunded");
      expect(ctx.ledger.walletOf(one.b.wallet.partyId)?.balance).toBe(parseAmount("100"));
      expect(await k.journal(o1.id)).toMatchObject({
        "offramp.burned:customer_liability": dec("30"),
        "offramp.reminted:customer_liability": dec("-30"),
      });
      // AML returns o2 while it sits in the draft: the approval takes it out of the draft and refuses.
      port.returned.add(o2.id);
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/approve`)
            .set(await admin(alice))
            .send({ reason: "batch ok" })
            .expect(409),
        ),
      ).toMatchObject({ error: "batch_state", details: { left: [o2.id] } });
      expect(await k.order(o2.id)).toMatchObject({
        status: "needs_review",
        reviewStep: "compliance",
        payoutBatchId: null,
        details: { leftBatchId: draft.batch.id },
      });
      expect(await batchRow(draft.batch.id)).toMatchObject({
        status: "draft",
        itemCount: 1,
        totalAmount: parseAmount("10"),
      });
      // Approved again, the draft goes on without it: the file pays o3 only.
      await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, {
        reason: "batch ok",
      });
      const csv = await exportBatch(draft.batch.id);
      expect(csv).toContain(o3.payoutReference ?? "?");
      expect(csv).not.toContain(o2.payoutReference ?? "?");
      await k.expectIdentities();
    } finally {
      port.unbind();
    }
  });

  it("W9f C25: in an approved batch a returned cash-out is held and paged, never taken out; an unbatched one goes to review by the sweep; cancelled, the held one goes to review too; one the bank already has is flagged and paged once", async () => {
    const port = stubCompliance({ "offramp.create": REVIEW });
    const paged = jest.spyOn(ctx.get(SentryService), "captureMessage");
    try {
      const one = await provedCustomer("hold-ret-a", "100", USER_IBAN);
      const two = await provedCustomer("hold-ret-b", "100", byIban("POIS", "4"));
      const o1 = await bankCashOut(one.b, "30", one.accountId);
      const o2 = await bankCashOut(two.b, "20", two.accountId);
      const draft = await createBatch();
      await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, {
        reason: "batch ok",
      });
      const three = await provedCustomer("hold-ret-c", "100", byIban("AKBB", "84"));
      const o3 = await bankCashOut(three.b, "10", three.accountId);
      port.returned.add(o1.id);
      port.returned.add(o3.id);
      expect(await exportBatch(draft.batch.id, 409)).toMatch(/batch_held/);
      expect(await k.order(o1.id)).toMatchObject({
        status: "payout_queued",
        payoutBatchId: draft.batch.id,
        details: { hold: { reason: "aml_return" } },
      });
      expect(pages(paged, "ramp cash-out AML returned sits in a payout batch")).toBe(1);
      // The housekeeping sweep: o3 (unbatched) → review; o1 stays held in its approved batch.
      expect((await ctx.get(RampBankProcessor).tick()).returned).toBe(1);
      expect(await k.order(o3.id)).toMatchObject({
        status: "needs_review",
        reviewStep: "compliance",
        details: { complianceReturn: { at: expect.any(String) as string } },
      });
      expect(await k.order(o1.id)).toMatchObject({
        status: "payout_queued",
        payoutBatchId: draft.batch.id,
      });
      // Cancelled, the batch lets o1 into the compliance review (reverse) and o2 back to the queue.
      await ctx.agent
        .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/cancel`)
        .set(await admin(alice))
        .send({ reason: "AML return" })
        .expect(200);
      expect(await k.order(o1.id)).toMatchObject({
        status: "needs_review",
        reviewStep: "compliance",
        payoutBatchId: null,
      });
      expect(await k.order(o2.id)).toMatchObject({ status: "payout_queued", payoutBatchId: null });
      // At the bank: a return decided after the submission is flagged and paged, once.
      await sendBatch();
      expect((await k.order(o2.id)).status).toBe("payout_sent");
      port.returned.add(o2.id);
      expect((await ctx.get(RampBankProcessor).tick()).returned).toBe(1);
      expect((await ctx.get(RampBankProcessor).tick()).returned).toBe(0);
      expect(await k.order(o2.id)).toMatchObject({
        status: "payout_sent",
        details: { amlReturn: { status: "payout_sent" } },
      });
      expect(pages(paged, "ramp cash-out AML returned is already at the bank")).toBe(1);
      await k.expectIdentities();
    } finally {
      paged.mockRestore();
      port.unbind();
    }
  });
});

describe("W9f: the statement confirm says what each classification books (F3/F9)", () => {
  it("W9f F3/F9: the confirm's approval lists every classification with its line, amount and booking; its snapshot pins those lines; the audit keeps the sentence", async () => {
    const day = D[7];
    const spec = statement(day, day, "1000", [
      {
        ref: "UNK-IN",
        amount: "30.00",
        credit: true,
        date: day,
        iban: OTHER_IBAN,
        name: "Someone",
        purpose: "?",
      },
      {
        ref: "UNK-OUT",
        amount: "1.50",
        date: day,
        iban: OTHER_IBAN,
        name: "Someone",
        purpose: "?",
      },
    ]);
    const preview = await upload(spec);
    const byRef = (ref: string): ApiBankLine => preview.lines.find((l) => l.lineRef === ref)!;
    const confirm = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm`)
        .set(await admin(alice))
        .send({
          reason: "statement in",
          classifications: [
            { lineId: byRef("UNK-OUT").id, matchKind: "suspense" },
            { lineId: byRef("UNK-IN").id, matchKind: "suspense" },
          ],
        })
        .expect(202),
    ).approval;
    expect(confirm.description).toBe(
      `confirm the statement ${day} … ${day} (2 lines, closing ${dec("1028.5")}); book line UNK-OUT of ${day} (-1.50 BYN) as suspense → suspense.in / suspense.out; line UNK-IN of ${day} (30.00 BYN) as suspense → suspense.in / suspense.out`,
    );
    expect(confirm.precondition).toMatchObject({
      classified: [
        { lineId: byRef("UNK-OUT").id, lineRef: "UNK-OUT", amount: dec("-1.5"), currency: "BYN" },
        { lineId: byRef("UNK-IN").id, lineRef: "UNK-IN", amount: dec("30"), currency: "BYN" },
      ],
    });
    // The approver's own copy: the snapshot (lines fixed by the file) still equals; it executes.
    const done = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/bank-statements/${preview.statement.id}/confirm/approve`)
        .set(await admin(bob))
        .send({
          format: "camt053",
          content: base64(camt053({ ...spec, messageId: "BOB" })),
          reason: "own copy",
        })
        .expect(200),
    );
    expect(done.approval.status).toBe("executed");
    const audit = await ctx.dataSource.query<
      { action: string; metadata: { description: string } }[]
    >(
      `SELECT action, metadata FROM to_audit_events WHERE subject_id = $1 AND action LIKE 'admin.approval.%' ORDER BY id`,
      [preview.statement.id],
    );
    expect(audit.map((a) => [a.action, a.metadata.description])).toEqual([
      ["admin.approval.requested", confirm.description],
      ["admin.approval.executed", confirm.description],
    ]);
    expect(await balance("bank_suspense")).toBe(dec("-28.5"));
    await k.expectIdentities();
  });
});

describe("W9f: refund_cancel settles a bank refund a chargeback stopped (C19)", () => {
  /** A card on-ramp in review (no 3-D Secure), its bank refund queued four-eyes to an account at `iban`. */
  async function queuedRefund(
    hint: string,
    iban: string,
  ): Promise<{ b: Buyer; orderId: string; paymentId: string; accountId: string; ref: string }> {
    const b = await customer(hint);
    const { account } = (await addAccount(b, iban)) as { account: ApiRampBankAccount };
    const res = await k.openOnramp(b, "40");
    await k.pay(b, res, "no_3ds");
    await coolOff(account.id);
    await fourEyes(`/admin/ramp/bank-accounts/${account.id}/verify`, {
      reason: "bank letter",
      proofRef: `letter ${hint}`,
    });
    expect(
      await fourEyes(`/admin/ramp/orders/${res.order.id}/refund_bank`, {
        reason: "refund by bank transfer",
        bankAccountId: account.id,
      }),
    ).toMatchObject({ status: "payout_queued" });
    return {
      b,
      orderId: res.order.id,
      paymentId: k.paymentIdOf(res),
      accountId: account.id,
      ref: res.order.payoutReference ?? "",
    };
  }

  async function cancelRefused(orderId: string): Promise<string> {
    return bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${orderId}/refund_cancel`)
        .set(await admin(alice))
        .send({ reason: "the chargeback paid the user" })
        .expect(409),
    ).message;
  }

  /** Σ of one account over the order's postings. */
  async function orderBalance(orderId: string, account: string): Promise<string> {
    const [row] = await ctx.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ramp_journal WHERE order_id = $1 AND account = $2`,
      [orderId, account],
    );
    return formatAmount(parseAmount(row.total));
  }

  const reds = async (): Promise<string[]> =>
    (await k.reconciliation()).run.checks.filter((c) => c.status === "red").map((c) => c.name);

  it("W9f C19: refund_cancel (four-eyes) cancels the stopped refund — ONE onramp.refund_cancelled nets the owed refund against the receivable, the order closes as chargeback, nothing new goes red", async () => {
    const { b, orderId, paymentId, accountId } = await queuedRefund(
      "cancel-q",
      byIban("AKBB", "91"),
    );
    await k.deliver(k.mock().chargeback(paymentId, b.user.id));
    expect(await k.order(orderId)).toMatchObject({ status: "needs_review", reviewStep: "refund" });
    const redBefore = await reds();
    const requested = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${orderId}/refund_cancel`)
        .set(await admin(alice))
        .send({ reason: "the chargeback paid the user" })
        .expect(202),
    ).approval;
    expect(requested).toMatchObject({
      action: "ramp.order.refund_cancel",
      precondition: {
        fiatAmount: dec("40"),
        fiatCurrency: "BYN",
        userId: b.user.id,
        destination: { kind: "bank", bankAccountId: accountId },
      },
      description: expect.stringContaining(
        `cancel the bank refund of 40.00 BYN to bank account ${accountId} for user ${b.user.id}`,
      ) as string,
    });
    // Alice cannot approve her own request; Bob does.
    await bobApproves(requested);
    expect(await k.order(orderId)).toMatchObject({
      status: "chargeback",
      payoutBatchId: null,
      details: { refundCancelled: { amount: dec("40") } },
    });
    expect(await k.journal(orderId)).toMatchObject({
      "onramp.refund_queued:payout_clearing": dec("-40"),
      "onramp.chargeback_after_refund:chargeback_receivable": dec("40"),
      "onramp.refund_cancelled:payout_clearing": dec("40"),
      "onramp.refund_cancelled:chargeback_receivable": dec("-40"),
    });
    const entries = await ctx.dataSource.query<{ n: number }[]>(
      `SELECT COUNT(DISTINCT entry_id)::int AS n FROM to_ramp_journal WHERE order_id = $1 AND kind = 'onramp.refund_cancelled'`,
      [orderId],
    );
    expect(entries).toEqual([{ n: 1 }]);
    expect(await orderBalance(orderId, "payout_clearing")).toBe(dec("0"));
    expect(await orderBalance(orderId, "chargeback_receivable")).toBe(dec("0"));
    expect(await cancelRefused(orderId)).toBe("the bank refund is already cancelled");
    expect(await reds()).toEqual(redBefore);
    // A dispute won afterwards finds no receivable to clear (the cancelled refund took it): the
    // books never go negative; the user is owed the refund again (W9g: refund_reinstated).
    await k.deliver(k.mock().disputeWon(paymentId));
    expect(Object.keys(await k.journal(orderId))).not.toContain(
      "onramp.chargeback_reversed:chargeback_receivable",
    );
    expect(await orderBalance(orderId, "chargeback_receivable")).toBe(dec("0"));
    expect(await orderBalance(orderId, "payout_clearing")).toBe(dec("-40"));
    expect(await k.order(orderId)).toMatchObject({ status: "needs_review", reviewStep: "refund" });
    await k.expectIdentities();
  });

  it("W9f C19: a refund still in a DRAFT batch leaves it — the draft drops the item, its count and total, and is approved without it", async () => {
    const one = await queuedRefund("cancel-d1", byIban("AKBB", "92"));
    const two = await queuedRefund("cancel-d2", byIban("AKBB", "93"));
    const draft = await createBatch();
    expect(draft.items).toHaveLength(2);
    await k.deliver(k.mock().chargeback(one.paymentId, one.b.user.id));
    expect(await k.order(one.orderId)).toMatchObject({
      status: "needs_review",
      payoutBatchId: null,
      details: { leftBatchId: draft.batch.id },
    });
    await fourEyes(`/admin/ramp/orders/${one.orderId}/refund_cancel`, {
      reason: "the chargeback paid the user",
    });
    expect((await k.order(one.orderId)).status).toBe("chargeback");
    expect(
      await ctx.dataSource
        .getRepository(RampPayoutBatchItemEntity)
        .findOneByOrFail({ batchId: draft.batch.id, orderId: one.orderId }),
    ).toMatchObject({ status: "voided" });
    expect(await batchRow(draft.batch.id)).toMatchObject({
      status: "draft",
      itemCount: 1,
      totalAmount: parseAmount("40"),
    });
    await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "batch ok" });
    const csv = await exportBatch(draft.batch.id);
    expect(csv).toContain(two.ref);
    expect(csv).not.toContain(one.ref);
    await k.expectIdentities();
  });

  it("W9f C19: refused while an approved or exported batch holds the refund; once the batch lets it go (cancelled, or voided on the bank's rejection) it is cancelled", async () => {
    // Approved: the acquirer's own reversal holds the refund in the batch → refused; cancelled → review.
    const q1 = await queuedRefund("cancel-appr", byIban("AKBB", "94"));
    const approved = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${approved.batch.id}/approve`, {
      reason: "batch ok",
    });
    await k.deliver(k.mock().pspRefund(q1.paymentId));
    expect(await k.order(q1.orderId)).toMatchObject({
      status: "payout_queued",
      details: { hold: { reason: "chargeback" } },
    });
    expect(await cancelRefused(q1.orderId)).toBe(
      `the bank refund sits in approved payout batch ${approved.batch.id} with no bank return yet: cancel or void the batch first`,
    );
    await ctx.agent
      .post(`/api/v1/admin/ramp/payout-batches/${approved.batch.id}/cancel`)
      .set(await admin(alice))
      .send({ reason: "a held refund" })
      .expect(200);
    expect(await k.order(q1.orderId)).toMatchObject({
      status: "needs_review",
      payoutBatchId: null,
    });
    await fourEyes(`/admin/ramp/orders/${q1.orderId}/refund_cancel`, {
      reason: "the acquirer gave the money back",
    });
    expect((await k.order(q1.orderId)).status).toBe("chargeback");
    // Exported: refused until the bank rejects the file and the batch is voided four-eyes.
    const q2 = await queuedRefund("cancel-exp", byIban("AKBB", "95"));
    const exported = await createBatch();
    await fourEyes(`/admin/ramp/payout-batches/${exported.batch.id}/approve`, {
      reason: "batch ok",
    });
    await exportBatch(exported.batch.id);
    await k.deliver(k.mock().chargeback(q2.paymentId, q2.b.user.id));
    expect(await cancelRefused(q2.orderId)).toBe(
      `the bank refund sits in exported payout batch ${exported.batch.id} with no bank return yet: cancel or void the batch first`,
    );
    await fourEyes(`/admin/ramp/payout-batches/${exported.batch.id}/void`, {
      reason: "the bank rejected the file",
      bankRejectionRef: "REJ-2026-1",
    });
    expect(await k.order(q2.orderId)).toMatchObject({
      status: "needs_review",
      payoutBatchId: null,
    });
    await fourEyes(`/admin/ramp/orders/${q2.orderId}/refund_cancel`, {
      reason: "the issuer paid the user",
    });
    for (const id of [q1.orderId, q2.orderId]) {
      expect((await k.order(id)).status).toBe("chargeback");
      expect(await orderBalance(id, "payout_clearing")).toBe(dec("0"));
      expect(await orderBalance(id, "chargeback_receivable")).toBe(dec("0"));
    }
    await k.expectIdentities();
  });

  /**
   * What the test environment otherwise leaves unknown or stale, made real: a token sync pass, the
   * ledger index caught up (the treasury holds none of the instrument and owes none of it here),
   * and the three Belarusian lists imported and screened in full (nobody here is on them).
   */
  async function everySourceRead(): Promise<void> {
    await ctx.get(TokenAppSyncService).syncOnce("test");
    await ctx.dataSource.query(
      `INSERT INTO to_indexer_state (key, "offset", ledger_end) VALUES ('ledger', 10, 10)
       ON CONFLICT (key) DO UPDATE SET "offset" = 10, ledger_end = 10`,
    );
    for (const list of ["by_terror", "un", "decree48"] as const) {
      const rows =
        list === "decree48"
          ? [`address,,,"nobody::1220aa"`]
          : [`person,"Пятроў Пётр Пятровіч",1960,`];
      await ctx.agent
        .post("/api/v1/admin/compliance/screening-lists")
        .set(await admin(alice))
        .send({
          list,
          version: "2026-10-20",
          deliveredAt: new Date().toISOString(),
          content: base64(["kind,name_variants,birth_date,ids", ...rows].join("\r\n") + "\r\n"),
        })
        .expect(200);
    }
    expect(await ctx.get(ComplianceScreeningService).rescreen("admin", null)).toMatchObject({
      status: "done",
    });
  }

  /** Distinct entries of `kind` the order has. */
  async function entries(orderId: string, kind: string): Promise<number> {
    const [row] = await ctx.dataSource.query<{ n: number }[]>(
      `SELECT COUNT(DISTINCT entry_id)::int AS n FROM to_ramp_journal WHERE order_id = $1 AND kind = $2`,
      [orderId, kind],
    );
    return row.n;
  }

  it("W9g C19: a dispute won after refund_cancel owes the refund again — onramp.refund_reinstated, needs_review(refund); refund_bank (four-eyes) → batch → the statement shows the bank paid it → refunded: every per-order balance 0, the user paid 40 once net, every check green", async () => {
    const q = await queuedRefund("reinstate", USER_IBAN);
    await k.deliver(k.mock().chargeback(q.paymentId, q.b.user.id));
    await fourEyes(`/admin/ramp/orders/${q.orderId}/refund_cancel`, {
      reason: "the chargeback paid the user",
    });
    expect((await k.order(q.orderId)).status).toBe("chargeback");
    // The dispute is won: the issuer takes the chargeback back from the user, who is owed the
    // cancelled refund again — booked once, the order back in the refund review.
    const paged = jest.spyOn(ctx.get(SentryService), "captureMessage");
    await k.deliver(k.mock().disputeWon(q.paymentId));
    const pages = paged.mock.calls.map((c) => c[0]);
    paged.mockRestore();
    expect(pages).not.toContain("ramp dispute won without a receivable to clear");
    expect(await k.order(q.orderId)).toMatchObject({
      status: "needs_review",
      reviewStep: "refund",
      details: {
        reviewFrom: "chargeback",
        chargeback: { state: "won" },
        refundReinstated: { amount: dec("40") },
      },
    });
    expect(await k.journal(q.orderId)).toMatchObject({
      "onramp.refund_reinstated:provider_clearing": dec("40"),
      "onramp.refund_reinstated:payout_clearing": dec("-40"),
    });
    expect(await orderBalance(q.orderId, "payout_clearing")).toBe(dec("-40"));
    expect(await orderBalance(q.orderId, "chargeback_receivable")).toBe(dec("0"));
    // A second dispute-won (the post-close poll re-reads it) books nothing and moves nothing.
    await k.fulfilment().refreshPayment(q.orderId);
    expect(await entries(q.orderId, "onramp.refund_reinstated")).toBe(1);
    expect(await k.order(q.orderId)).toMatchObject({
      status: "needs_review",
      reviewStep: "refund",
    });
    // The account the chargeback suspended is reinstated, then refund_bank (four-eyes) queues the
    // refund: no refund at the acquirer, nothing booked again.
    await fourEyes(`/admin/users/${q.b.user.id}/reinstate`, { reason: "the dispute was won" });
    const queued = (await fourEyes(`/admin/ramp/orders/${q.orderId}/refund_bank`, {
      reason: "the refund is owed again",
      bankAccountId: q.accountId,
    })) as ApiRampOrder;
    expect(queued).toMatchObject({ status: "payout_queued" });
    expect(await entries(q.orderId, "onramp.refund_queued")).toBe(1);
    await sendBatch();
    expect((await k.order(q.orderId)).status).toBe("payout_sent");
    await bookStatement(
      statement(D[7], D[7], "1000", [
        payoutDebit({ payoutReference: q.ref }, "40.00", D[7], {
          purpose: `Возврат средств по заказу ${q.ref}`,
        }),
      ]),
    );
    expect((await k.order(q.orderId)).status).toBe("refunded");
    // Every per-order balance the journal tracks is 0 …
    for (const account of [
      "issuance_pending",
      "customer_liability",
      "payout_clearing",
      "chargeback_receivable",
      "fee_revenue",
    ])
      expect(`${account} ${await orderBalance(q.orderId, account)}`).toBe(`${account} ${dec("0")}`);
    // … and the user got 40 once net: the bank paid it once; the chargeback's 40 and the won
    // dispute's 40 cancel at the acquirer, which keeps the capture less its fee for settlement.
    expect(await entries(q.orderId, "refund.paid_bank")).toBe(1);
    expect(await orderBalance(q.orderId, "safeguard_bank")).toBe(dec("-40"));
    expect(await orderBalance(q.orderId, "provider_clearing")).toBe(dec("39.04"));
    expect(await orderBalance(q.orderId, "psp_fees")).toBe(dec("0.96"));
    expect(k.mock().refundsOf(q.paymentId)).toEqual([]);
    // A later poll of the won dispute books nothing more.
    await k.fulfilment().refreshPayment(q.orderId);
    expect(await entries(q.orderId, "onramp.refund_reinstated")).toBe(1);
    expect((await k.order(q.orderId)).status).toBe("refunded");
    await everySourceRead();
    const rec = await k.reconciliation();
    expect(
      rec.run.checks
        .filter((c) => c.status !== "green")
        .map((c) => `${c.name}: ${c.status} ${c.detail ?? ""}`),
    ).toEqual([]);
    await k.expectIdentities();
  });

  it("W9g C19: refund_bank stays refused on every other chargeback order — a refund a chargeback stopped, a cancelled one whose dispute is not won", async () => {
    const q = await queuedRefund("plain-cb", byIban("AKBB", "96"));
    await k.deliver(k.mock().chargeback(q.paymentId, q.b.user.id));
    await ctx.get(UserService).reinstate(q.b.user.id, "dispute reviewed", { type: "system" });
    const refundBank = async (): Promise<string> =>
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${q.orderId}/refund_bank`)
          .set(await admin(alice))
          .send({ reason: "refund by bank transfer", bankAccountId: q.accountId })
          .expect(409),
      ).message;
    expect(await k.order(q.orderId)).toMatchObject({
      status: "needs_review",
      reviewStep: "refund",
    });
    expect(await refundBank()).toBe("a chargeback is open on this order");
    await fourEyes(`/admin/ramp/orders/${q.orderId}/refund_cancel`, {
      reason: "the chargeback paid the user",
    });
    expect(await refundBank()).toBe("the order is chargeback, not needs_review");
    expect(await entries(q.orderId, "onramp.refund_queued")).toBe(1);
    expect(Object.keys(await k.journal(q.orderId))).not.toContain(
      "onramp.refund_reinstated:payout_clearing",
    );
    await k.expectIdentities();
  });

  it("W9f C19: refused while the bank has the refund, and once a statement shows the bank paid it — the receivable then stands", async () => {
    const q = await queuedRefund("cancel-paid", USER_IBAN);
    await sendBatch();
    expect((await k.order(q.orderId)).status).toBe("payout_sent");
    await k.deliver(k.mock().chargeback(q.paymentId, q.b.user.id));
    expect(await cancelRefused(q.orderId)).toMatch(/the bank has this refund/);
    await bookStatement(
      statement(D[7], D[7], "1000", [
        payoutDebit({ payoutReference: q.ref }, "40.00", D[7], {
          purpose: `Возврат средств по заказу ${q.ref}`,
        }),
      ]),
    );
    expect((await k.order(q.orderId)).status).toBe("refunded");
    expect(await cancelRefused(q.orderId)).toMatch(
      /the bank paid this refund: the chargeback receivable stands/,
    );
    expect(await orderBalance(q.orderId, "chargeback_receivable")).toBe(dec("40"));
    expect(await orderBalance(q.orderId, "payout_clearing")).toBe(dec("0"));
    await k.expectIdentities();
  });
});

describe("W9g: the AML-return sweep keeps a cursor (C25)", () => {
  it("W9g C25: with more pending bank cash-outs than RAMP_BANK_BATCH_MAX, a newer one AML returned is reached within ⌈pending / max⌉ ticks", async () => {
    const port = stubCompliance({});
    try {
      const one = await provedCustomer("sweep-a", "100", USER_IBAN);
      const template = await bankCashOut(one.b, "10", one.accountId);
      const max = ctx.config.rampBank.batchMax;
      // A backlog older than anything else: max + 5 queued bank cash-outs AML never returned.
      await ctx.dataSource.query(
        `INSERT INTO to_ramp_orders (user_id, direction, status, provider, instrument_admin, instrument_id,
           party_id, fiat_currency, fiat_amount, token_amount, fee_amount, idempotency_key, request_hash,
           payout_rail, bank_account_id, payout_reference, operator, details,
           status_changed_at, created_at, updated_at)
         SELECT user_id, direction, 'payout_queued', provider, instrument_admin, instrument_id, party_id,
                fiat_currency, fiat_amount, token_amount, fee_amount, 'w9g-sweep-' || g,
                lpad(to_hex(g), 64, '0'), payout_rail, bank_account_id, 'TO7' || lpad(g::text, 11, '0'),
                operator, '{}'::jsonb, now() - interval '1 day', now() - interval '1 day',
                now() - interval '1 day'
           FROM to_ramp_orders o, generate_series(1, $2::int) g WHERE o.id = $1`,
        [template.id, max + 5],
      );
      // The newest bank cash-out: AML returns it.
      const two = await provedCustomer("sweep-b", "100", byIban("POIS", "4"));
      const newest = await bankCashOut(two.b, "20", two.accountId);
      port.returned.add(newest.id);
      const [{ pending }] = await ctx.dataSource.query<{ pending: number }[]>(
        `SELECT COUNT(*)::int AS pending FROM to_ramp_orders
          WHERE direction = 'offramp' AND payout_rail = 'bank' AND status = 'payout_queued'`,
      );
      expect(pending).toBe(max + 7);
      const bound = Math.ceil(pending / max);
      let returned = 0;
      for (let tick = 0; tick < bound && returned === 0; tick += 1)
        returned += (await ctx.get(RampBankProcessor).tick()).returned;
      expect(returned).toBe(1);
      expect(await k.order(newest.id)).toMatchObject({
        status: "needs_review",
        reviewStep: "compliance",
        payoutBatchId: null,
        details: { complianceReturn: { at: expect.any(String) as string } },
      });
      // Nothing else was touched: the backlog and the template still wait in the queue.
      expect((await k.order(template.id)).status).toBe("payout_queued");
      await k.expectIdentities();
    } finally {
      port.unbind();
    }
  });
});

describe("W9i: review findings on the bank rail (R2a)", () => {
  it("R2a-1: a hold found after the export never refuses `submitted` (the bank accepted the file): both orders are sent, the held one flagged and paged once, and the statement books both debits as payouts", async () => {
    const paged = jest.spyOn(ctx.get(SentryService), "captureMessage");
    try {
      const one = await provedCustomer("r2a1-a", "100", USER_IBAN);
      const two = await provedCustomer("r2a1-b", "100", byIban("POIS", "4"));
      const o1 = await bankCashOut(one.b, "30", one.accountId);
      const o2 = await bankCashOut(two.b, "20", two.accountId);
      const draft = await createBatch();
      await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "ok" });
      await exportBatch(draft.batch.id);
      await freezeUser(two.b.user.id);
      expect((await submitBatch(draft.batch.id, "PP-R2A1")).status).toBe("submitted");
      expect((await k.order(o1.id)).status).toBe("payout_sent");
      expect(await k.order(o2.id)).toMatchObject({
        status: "payout_sent",
        details: { heldAtBank: { reason: "frozen", batchId: draft.batch.id } },
      });
      expect(
        paged.mock.calls.filter((c) => c[0] === "ramp held payout is already at the bank"),
      ).toHaveLength(1);
      const st = await bookStatement(
        statement(D[7], D[7], "1000", [
          payoutDebit(o1, "30.00", D[7]),
          payoutDebit(o2, "20.00", D[7], { iban: byIban("POIS", "4"), bic: "POISBY2X" }),
        ]),
      );
      expect(st.preview.lines.map((l) => [l.matchKind, l.flags])).toEqual([
        ["payout", []],
        ["payout", []],
      ]);
      for (const o of [o1, o2]) expect((await k.order(o.id)).status).toBe("completed");
      await k.expectIdentities();
    } finally {
      paged.mockRestore();
    }
  });

  it("R2a-2: a suspense line paid to the order's OWN account at another amount blocks bank_unpaid; one misdirected to another account does not", async () => {
    const own = await provedCustomer("r2a2-own");
    const mis = await provedCustomer("r2a2-mis", "100", byIban("POIS", "4"));
    const order = await bankCashOut(own.b, "50", own.accountId);
    const misdirected = await bankCashOut(mis.b, "20", mis.accountId);
    const draft = await sendBatch();
    await sentOn(draft.batch.id, D[3], [order.id, misdirected.id]);
    // The bank booked 50.50 to the user's own IBAN (a fee-inclusive booking, or an edited file);
    // the other payout went to someone else's account.
    const st = await bookStatement(
      statement(D[3], D[7], "1000", [
        payoutDebit(order, "50.50", D[4], { ref: "OWN-5050" }),
        payoutDebit(misdirected, "20.00", D[4], {
          ref: "MIS-2000",
          iban: OTHER_IBAN,
          bic: "PJCBBY2X",
        }),
      ]),
    );
    const byRef = (ref: string) => st.preview.lines.find((l) => l.lineRef === ref)!;
    expect(byRef("OWN-5050")).toMatchObject({ status: "unmatched", flags: [] });
    expect(byRef("MIS-2000")).toMatchObject({ status: "unmatched", flags: ["iban_mismatch"] });
    for (const ref of ["OWN-5050", "MIS-2000"])
      await fourEyes(`/admin/ramp/bank-lines/${byRef(ref).id}/classify`, {
        reason: "not the order's payout",
        matchKind: "suspense",
      });
    expect(await ctx.get(RampBankProcessor).tick()).toMatchObject({ aged: 1 });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${order.id}/bank_unpaid`)
          .set(await admin(alice))
          .send({ reason: "no debit for it", then: "requeue" })
          .expect(409),
      ).message,
    ).toMatch(/not proven unpaid: statement line OWN-5050 quotes it/);
    expect(await k.order(order.id)).toMatchObject({ status: "needs_review", reviewStep: "payout" });
    // The misdirected one never reached its user: proven unpaid, it may be paid again.
    const asked = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${misdirected.id}/bank_unpaid`)
        .set(await admin(alice))
        .send({ reason: "misdirected by the file", then: "requeue" })
        .expect(202),
    );
    expect(asked.approval).toMatchObject({ action: "ramp.order.bank_unpaid", status: "pending" });
    await k.expectIdentities();
  });

  /** Two customers' cash-outs of 30 (USER_IBAN) and 20 (POIS) in one submitted batch. */
  async function twoSent(hint: string): Promise<{
    o1: ApiRampOrder;
    o2: ApiRampOrder;
    doc: (o: ApiRampOrder) => string;
  }> {
    const one = await provedCustomer(`${hint}-a`, "100", USER_IBAN);
    const two = await provedCustomer(`${hint}-b`, "100", byIban("POIS", "4"));
    const o1 = await bankCashOut(one.b, "30", one.accountId);
    const o2 = await bankCashOut(two.b, "20", two.accountId);
    const draft = await sendBatch();
    return {
      o1,
      o2,
      doc: (o) => draft.items.find((i) => i.orderId === o.id)!.documentNo,
    };
  }

  it("R2a-5: a batch-booked entry is checked against what each transaction paid: one to another IBAN, or for another amount, is iban_mismatch and books nothing", async () => {
    const { o1, o2, doc } = await twoSent("r2a5");
    const entry = (ref: string, date: string, tx: [string, string][]): StatementEntry => ({
      ref,
      amount: "50.00",
      date,
      transactions: [o1, o2].map((o, i) => ({
        endToEnd: o.payoutReference ?? "",
        documentNo: doc(o),
        iban: tx[i][0],
        amount: tx[i][1],
      })),
      entryInfo: "Bulk payment file PP-2026-0001",
    });
    // The insider swapped o1's IBAN in the file the bank booked as one entry.
    const swapped = await bookStatement(
      statement(D[5], D[6], "1000", [
        entry("BULK-IBAN", D[6], [
          [OTHER_IBAN, "30.00"],
          [byIban("POIS", "4"), "20.00"],
        ]),
      ]),
    );
    expect(swapped.preview.lines[0]).toMatchObject({
      status: "unmatched",
      matchKind: null,
      flags: ["iban_mismatch"],
    });
    expect(await k.order(o1.id)).toMatchObject({ status: "needs_review", reviewStep: "payout" });
    expect((await k.order(o2.id)).status).toBe("payout_sent");
    // The right accounts, but 10 moved from o2 to o1.
    const moved = await bookStatement(
      statement(nextDay(D[6]), D[7], "950", [
        entry("BULK-AMOUNT", D[7], [
          [USER_IBAN, "40.00"],
          [byIban("POIS", "4"), "10.00"],
        ]),
      ]),
    );
    expect(moved.preview.lines[0]).toMatchObject({ matchKind: null, flags: ["iban_mismatch"] });
    expect((await k.order(o2.id)).status).toBe("payout_sent");
    expect(Object.keys(await k.journal(o1.id))).not.toContain("offramp.paid_bank:safeguard_bank");
    await k.expectIdentities();
  });

  it("R2a-6: the same batch-booked entry again (the file executed twice) is payout_duplicate and red", async () => {
    const { o1, o2, doc } = await twoSent("r2a6");
    const entry = (ref: string, date: string): StatementEntry => ({
      ref,
      amount: "50.00",
      date,
      transactions: [o1, o2].map((o) => ({
        endToEnd: o.payoutReference ?? "",
        documentNo: doc(o),
      })),
      entryInfo: "Bulk payment file PP-2026-0001",
    });
    const first = await bookStatement(statement(D[5], D[6], "1000", [entry("BULK-1", D[6])]));
    expect(first.preview.lines[0]).toMatchObject({ matchKind: "payout_batch" });
    for (const o of [o1, o2]) expect((await k.order(o.id)).status).toBe("completed");
    // Again with its transactions, and again named only by the file (the settled batch).
    const again = await bookStatement(
      statement(nextDay(D[6]), D[7], "950", [
        entry("BULK-2", D[7]),
        {
          ref: "FILE-ONLY",
          amount: "50.00",
          date: D[7],
          iban: null,
          name: "Alfa-Bank",
          purpose: "Bulk payment file PP-2026-0001",
        },
      ]),
    );
    for (const l of again.preview.lines)
      expect([l.lineRef, l.status, l.matchKind, l.flags]).toEqual([
        l.lineRef,
        "unmatched",
        null,
        ["payout_duplicate"],
      ]);
    expect(k.checkOf(await k.reconciliation(), "bank_payout_duplicate")).toMatchObject({
      status: "red",
    });
    await k.expectIdentities();
  });

  it("R2a-7: a draft pages on past the orders it skips: with RAMP_BANK_BATCH_MAX 1, two frozen cash-outs older than a payable one never hide it", async () => {
    const bank = ctx.config.rampBank as { batchMax: number };
    const max = bank.batchMax;
    bank.batchMax = 1;
    try {
      const a = await provedCustomer("r2a7-a", "100", USER_IBAN);
      const b = await provedCustomer("r2a7-b", "100", byIban("POIS", "4"));
      const c = await provedCustomer("r2a7-c", "100", byIban("AKBB", "83"));
      const o1 = await bankCashOut(a.b, "30", a.accountId);
      const o2 = await bankCashOut(b.b, "20", b.accountId);
      const o3 = await bankCashOut(c.b, "10", c.accountId);
      await freezeUser(a.b.user.id);
      await freezeUser(b.b.user.id);
      const draft = await createBatch();
      expect(draft.items.map((i) => i.orderId)).toEqual([o3.id]);
      expect(draft.skipped).toEqual([
        { orderId: o1.id, reason: "held: frozen" },
        { orderId: o2.id, reason: "held: frozen" },
      ]);
      await k.expectIdentities();
    } finally {
      bank.batchMax = max;
    }
  });

  it("R1-4: a retried MarkPaid re-checks the account: after a chargeback suspends it and holds the bank cash-out, no second MarkPaid is sent and nothing is burned", async () => {
    const { b, accountId } = await provedCustomer("r14", "100", byIban("AKBB", "84"));
    const card = await k.bought(b, "20");
    const res = await offramp(b, "50", accountId);
    expect(res.status).toBe(200);
    const order = (res.body as ApiRampOfframpResult).order;
    const markPaids = (): number =>
      ctx.wallet.submits.filter((s) => {
        const json = JSON.stringify(s.commands);
        return json.includes('"choice":"MarkPaid"') && json.includes(`"txHash":"ramp:${order.id}"`);
      }).length;
    // The ledger rejects the first MarkPaid the wallet accepted (it reports it FAILED); the
    // wallet's status reads fail for a while, so its retry waits.
    ctx.wallet.rejectNext = "LOCKED_CONTRACTS: contention";
    ctx.wallet.statusReadsFail = true;
    try {
      await ctx.agent
        .post(`/api/v1/ramp/orders/${order.id}/attach`)
        .set(b.headers)
        .send({ pendingPayoutCid: k.signWithdraw(b, "50") })
        .expect(200);
      expect(markPaids()).toBe(1);
      // A chargeback on the card purchase suspends the account and holds the cash-out.
      await k.deliver(k.mock().chargeback(card.providerPaymentId ?? "", b.user.id));
    } finally {
      ctx.wallet.statusReadsFail = false;
    }
    expect((await ctx.get(UserService).findById(b.user.id))?.status).toBe("suspended");
    expect((await k.order(order.id)).details).toMatchObject({ hold: { reason: "chargeback" } });
    await k.drive(2);
    expect(markPaids()).toBe(1);
    expect(await k.order(order.id)).toMatchObject({ status: "withdrawing", burnCommandId: null });
    expect(ctx.tokenApp.burned).toEqual([]);
    await k.expectIdentities();
  });

  it("R2a-3: a batch that lost an item in its draft is matched by its bulk debit (the file's items, not the draft's)", async () => {
    const port = stubCompliance({ "offramp.create": REVIEW });
    try {
      const one = await provedCustomer("r2a3-a", "100", USER_IBAN);
      const two = await provedCustomer("r2a3-b", "100", byIban("POIS", "4"));
      const three = await provedCustomer("r2a3-c", "100", byIban("AKBB", "83"));
      const o1 = await bankCashOut(one.b, "30", one.accountId);
      const o2 = await bankCashOut(two.b, "20", two.accountId);
      const o3 = await bankCashOut(three.b, "10", three.accountId);
      const draft = await createBatch();
      expect(draft.items).toHaveLength(3);
      // AML returns o3 while the batch is a draft: it leaves the draft at the approval.
      port.returned.add(o3.id);
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post(`/api/v1/admin/ramp/payout-batches/${draft.batch.id}/approve`)
            .set(await admin(alice))
            .send({ reason: "batch ok" })
            .expect(409),
        ),
      ).toMatchObject({ error: "batch_state", details: { left: [o3.id] } });
      await fourEyes(`/admin/ramp/payout-batches/${draft.batch.id}/approve`, { reason: "ok" });
      await exportBatch(draft.batch.id);
      await submitBatch(draft.batch.id, "PP-R2A3");
      // One debit for the whole file, named only by the bank's reference (no TxDtls).
      const st = await bookStatement(
        statement(D[7], D[7], "1000", [
          {
            ref: "BULK-R2A3",
            amount: "50.00",
            date: D[7],
            iban: null,
            name: "Alfa-Bank",
            purpose: "Bulk payment file PP-R2A3",
          },
        ]),
      );
      expect(st.preview.lines[0]).toMatchObject({
        matchKind: "payout_batch",
        matchedBatchId: draft.batch.id,
      });
      for (const o of [o1, o2]) expect((await k.order(o.id)).status).toBe("completed");
      expect((await k.order(o3.id)).status).toBe("needs_review");
      await k.expectIdentities();
    } finally {
      port.unbind();
    }
  });
});
