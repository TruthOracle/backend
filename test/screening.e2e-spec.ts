/**
 * Screening, freezes and the operations register end to end (SPEC §11.6; S7b; B1, B3, X6): a list
 * import re-screens every account (name-fold keys across be / ru / Latin forms, birth dates); a
 * Belarusian list hit freezes provisionally and every value point holds (the capture waits in
 * needs_review(compliance), MarkPaid is deferred, plain withdrawals are blocked_compliance, market
 * order prepare is refused neutrally); the AML decision confirms or clears; lifting a freeze is
 * four-eyes and everything resumes; a foreign-list hit denies new orders without freezing; a
 * frozen account's refunds wait; the operations export (role `export`, ≤ 31 days); retention.
 * Money scenarios check order status, journal and token commands, then the journal identities.
 */
import { createHash } from "node:crypto";

import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { ComplianceAlertEntity } from "../src/entities/compliance-alert.entity";
import { ComplianceFreezeEntity } from "../src/entities/compliance-freeze.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { ScreeningHitEntity } from "../src/entities/screening-hit.entity";
import { ScreeningRunEntity } from "../src/entities/screening-run.entity";
import { ScreeningSubjectEntity } from "../src/entities/screening-subject.entity";
import { ComplianceScreeningProcessor } from "../src/processors/compliance-screening.processor";
import { RampReconProcessor } from "../src/processors/ramp-recon.processor";
import { RampProcessor } from "../src/processors/ramp.processor";
import { SessionCleanupProcessor } from "../src/processors/session-cleanup.processor";
import { ComplianceFreezeService } from "../src/services/compliance-freeze.service";
import { ComplianceScreeningService } from "../src/services/compliance-screening.service";
import { IndexerService } from "../src/services/indexer.service";
import { KycIdentityService } from "../src/services/kyc-identity.service";
import { KycProviderMockService } from "../src/services/kyc-provider-mock.service";
import { PayoutService } from "../src/services/payout.service";
import { RampCompliancePort } from "../src/services/ramp-compliance.port";
import { OPERATIONS_COLUMNS } from "../src/services/ramp-operations-export.service";
import type {
  ApiApproval,
  ApiComplianceFreeze,
  ApiRampOfframpResult,
  ApiRampOrder,
  ApiRampOverview,
  ApiScreeningHit,
  ApiScreeningHitDetail,
  ApiScreeningImport,
} from "../src/types";
import { parseCsv } from "../src/util/csv";
import { ApiError, type ErrorBody } from "../src/util/errors";
import { TEST_TREASURY, useTestApp } from "./helpers/app";
import { LedgerFixture } from "./helpers/ledger-fixtures";
import { dec, nextKey, rampKit, type Buyer } from "./helpers/ramp";
import { bodyOf, issueSessionDirect, linkWallet } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const anna = makeTestWallet("anna"); // AML officer (+ ops: requests ramp actions)
const bob = makeTestWallet("bob"); // approver
const carl = makeTestWallet("carl"); // ops only
const erin = makeTestWallet("erin"); // exports only

const ctx = useTestApp({
  env: {
    ADMIN_OPERATORS: [
      `${anna.partyId}#anna@aml+ops`,
      `${bob.partyId}#bob@approver`,
      `${carl.partyId}#carl@ops`,
      `${erin.partyId}#erin@export`,
    ].join(","),
    RAMP_DUAL_CONTROL: "true",
    RAMP_APPROVAL_SIGNATURES: "false",
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
    RAMP_METHODS: "card,erip",
    // Consents can be given (C13: a declared principal is screened); compliance itself stays off.
    RAMP_TERMS_VERSION: "2026-10-01",
  },
});
const k = rampKit(ctx, anna);

let raise: jest.SpyInstance<
  Promise<string | null>,
  [rule: string, userId: string, figures: Record<string, unknown>]
>;
beforeEach(() => {
  k.mock().reset();
  // Whatever implements the compliance port (S7a's, or the default no-op), every alert goes through raise().
  raise = jest.spyOn(ctx.get(RampCompliancePort), "raise");
});
afterEach(() => {
  raise.mockRestore();
});

async function headers(w: TestWallet): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, w, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

let personSeq = 0;
/** A signed-in account with a primary wallet and no KYC yet. */
async function signUp(hint: string): Promise<Buyer> {
  const wallet = makeTestWallet(hint);
  const { user, cookie } = await issueSessionDirect(ctx, wallet);
  return { wallet, user, cookie, headers: { Cookie: cookie, ...ctx.csrf } };
}

/** The account passes the mock KYC with this name and birth date (its verified identity). */
async function approveKyc(
  b: Buyer,
  name: { firstName: string; lastName: string; dob: string },
): Promise<void> {
  const started = bodyOf<{ verificationId: string }>(
    await ctx.agent.post("/api/v1/kyc/sessions").set(b.headers).send({}).expect(200),
  );
  await ctx.agent
    .post("/api/v1/kyc/mock/submit")
    .set(b.headers)
    .send({
      verificationId: started.verificationId,
      outcome: "approved",
      person: { ...name, country: "BLR" },
      documents: [
        {
          docType: "PASSPORT",
          country: "BLR",
          number: `MP7${(personSeq += 1)}${Date.now() % 100000}`,
        },
      ],
    })
    .expect(200);
}

/** A KYC'd account whose verified (mock provider) identity carries the given name and birth date. */
async function person(
  hint: string,
  name: { firstName: string; lastName: string; dob: string },
): Promise<Buyer> {
  const b = await signUp(hint);
  await approveKyc(b, name);
  return b;
}

const LIST_HEADER = "kind,name_variants,birth_date,ids";
const csv64 = (rows: string[], encoding: BufferEncoding = "utf8"): string =>
  Buffer.from([LIST_HEADER, ...rows].join("\r\n") + "\r\n", encoding).toString("base64");

async function importList(
  list: "by_terror" | "un" | "decree48" | "foreign",
  version: string,
  rows: string[],
  w: TestWallet = anna,
  status = 200,
): Promise<ApiScreeningImport & ErrorBody> {
  return bodyOf(
    await ctx.agent
      .post("/api/v1/admin/compliance/screening-lists")
      .set(await headers(w))
      .send({ list, version, deliveredAt: new Date().toISOString(), content: csv64(rows) })
      .expect(status),
  );
}

async function activeFreeze(userId: string): Promise<ComplianceFreezeEntity | null> {
  return ctx.dataSource
    .getRepository(ComplianceFreezeEntity)
    .findOne({ where: { userId, active: true } });
}

async function hitsOf(userId: string): Promise<ScreeningHitEntity[]> {
  return ctx.dataSource
    .getRepository(ScreeningHitEntity)
    .find({ where: { userId }, order: { createdAt: "ASC" } });
}

/** The TM-LIST alert a hit raised (S7a's table; its id is stored on the hit). */
async function alertOfHit(hitId: string): Promise<ComplianceAlertEntity> {
  const hit = await ctx.dataSource.getRepository(ScreeningHitEntity).findOneByOrFail({ id: hitId });
  expect(hit.alertId).toEqual(expect.any(String));
  return ctx.dataSource
    .getRepository(ComplianceAlertEntity)
    .findOneByOrFail({ id: hit.alertId as string });
}

async function decide(
  hitId: string,
  decision: "confirm" | "clear",
  w: TestWallet = anna,
  status = 200,
): Promise<{ approval: ApiApproval; result?: ApiScreeningHit } & ErrorBody> {
  return bodyOf(
    await ctx.agent
      .post(`/api/v1/admin/compliance/screening-hits/${hitId}/decide`)
      .set(await headers(w))
      .send({ decision, reason: `${decision} after checking the documents` })
      .expect(status),
  );
}

/** The four-eyes lift: anna requests (202), bob approves (200). */
async function lift(freezeId: string): Promise<ApiComplianceFreeze> {
  const requested = bodyOf<{ approval: ApiApproval }>(
    await ctx.agent
      .post(`/api/v1/admin/compliance/freezes/${freezeId}/lift`)
      .set(await headers(anna))
      .send({ reason: "court order 12/2026: assets released" })
      .expect(202),
  ).approval;
  const done = bodyOf<{ approval: ApiApproval; result: ApiComplianceFreeze }>(
    await ctx.agent
      .post(`/api/v1/admin/approvals/${requested.id}/approve`)
      .set(await headers(bob))
      .send({ reason: "documents checked" })
      .expect(200),
  );
  expect(done.approval.status).toBe("executed");
  return done.result;
}

async function overview(b: Buyer): Promise<ApiRampOverview> {
  return bodyOf<ApiRampOverview>(await ctx.agent.get("/api/v1/ramp").set(b.headers).expect(200));
}

/** A card cash-out the user signed in the wallet; `attach` hands its PendingPayout over (MarkPaid follows). */
async function cashOutSigned(
  b: Buyer,
  amount: string,
): Promise<{ order: ApiRampOrder; cid: string; attach: () => Promise<void> }> {
  const card = await k.payoutCard(b);
  const res = await ctx.agent
    .post("/api/v1/ramp/offramp")
    .set(b.headers)
    .set("Idempotency-Key", nextKey())
    .send({ amount, destination: { kind: "card", paymentMethodId: card.id } })
    .expect(200);
  const order = bodyOf<ApiRampOfframpResult>(res).order;
  const cid = k.signWithdraw(b, amount);
  const attach = async (): Promise<void> => {
    await ctx.agent
      .post(`/api/v1/ramp/orders/${order.id}/attach`)
      .set(b.headers)
      .send({ pendingPayoutCid: cid })
      .expect(200);
  };
  return { order, cid, attach };
}

const markPaids = (orderId: string): number =>
  ctx.wallet.submits.filter((s) => {
    const json = JSON.stringify(s.commands);
    return json.includes('"choice":"MarkPaid"') && json.includes(`"txHash":"ramp:${orderId}"`);
  }).length;

/** A trading market and the account's funded in-app wallet in the index (for order prepare). */
async function seedMarket(party: string): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const f = new LedgerFixture(TEST_TREASURY);
  f.createMarket({
    marketId: 7,
    question: "Frozen?",
    price: "0.5",
    createdAt: nowSec - 3600,
    expiresAt: nowSec + 7 * 86_400,
    ticker: "FRZ-1",
    eventTicker: "FRZ",
    yesSubTitle: "Yes",
    noSubTitle: "No",
  });
  const w = f.createWallet(party);
  f.deposit(w.wallet, "50", "ref-frz");
  ctx.stream.push(...f.txs);
  await ctx.get(IndexerService).runOnce();
}

function prepare(b: Buyer): Promise<{ status: number; body: unknown }> {
  return ctx.agent
    .post("/api/v1/markets/FRZ-1/orders/prepare")
    .set(b.headers)
    .send({ action: "buy", side: "Yes", amount: "1" });
}

const payouts = (cid: string): Promise<PayoutEntity> =>
  ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid });

const audits = (action: string): Promise<AuditEventEntity[]> =>
  ctx.dataSource.getRepository(AuditEventEntity).find({ where: { action }, order: { id: "ASC" } });

describe("a Belarusian list hit freezes provisionally; every value point holds (B1, B3, X6)", () => {
  it("import → re-screen matches the passport's Latin name to the list's be / ru forms → provisional freeze + TM-LIST due today; capture held, MarkPaid deferred, withdrawal blocked, prepare refused; confirm keeps the freeze; the lift is four-eyes; everything resumes", async () => {
    const b = await person("listed", {
      firstName: "SIARHEI",
      lastName: "IVANOU",
      dob: "1975-03-15",
    });
    const dormant = await k.buyer("dormant");
    await k.bought(b, "100", "card-listed");
    await k.decayExposure();
    await seedMarket(b.wallet.partyId);
    expect((await prepare(b)).status).toBe(200);
    // Value in flight when the list arrives: an unpaid checkout and a cash-out signed in the wallet.
    const open = await k.openOnramp(b, "20");
    const { order: off, cid: offCid, attach } = await cashOutSigned(b, "30");

    const imported = await importList("by_terror", "2026-10-19", [
      `person,"Іваноў Сяргей Мікалаевіч|Иванов Сергей Николаевич",15.03.1975,`,
      `person,"Пятроў Пётр",1960,`,
    ]);
    expect(imported).toMatchObject({
      list: { list: "by_terror", version: "2026-10-19", entryCount: 2, importedByPerson: "anna" },
      hits: 1,
      run: { scope: "full", trigger: "import", status: "done", hits: 1, failures: 0 },
    });
    // Every account was re-screened, the dormant one included.
    const run = await ctx.dataSource
      .getRepository(ScreeningRunEntity)
      .findOneByOrFail({ id: imported.run!.id });
    expect(run.identities).toBeGreaterThanOrEqual(2);
    const covered = await ctx.dataSource.query<{ user_id: string }[]>(
      `SELECT user_id FROM to_screening_subjects WHERE $1 = ANY(list_ids)`,
      [imported.list.id],
    );
    expect(covered.map((r) => r.user_id)).toEqual(
      expect.arrayContaining([b.user.id, dormant.user.id]),
    );
    const [hit] = await hitsOf(b.user.id);
    expect(hit).toMatchObject({
      status: "open",
      match: {
        basis: "name",
        script: "lat",
        birthDate: "exact",
        entryName: "Іваноў Сяргей Мікалаевіч",
        entryBirthDate: "1975-03-15",
      },
    });
    const freeze = await activeFreeze(b.user.id);
    expect(freeze).toMatchObject({ provisional: true, source: "screening", createdByUserId: null });
    expect(hit.freezeId).toBe(freeze!.id);
    expect(await activeFreeze(dormant.user.id)).toBeNull();
    expect(raise).toHaveBeenCalledWith(
      "TM-LIST",
      b.user.id,
      expect.objectContaining({ severity: "block", list: "by_terror", hitId: hit.id }),
    );
    // Due at the end of the same Belarusian business day (23:59:59 Minsk = 20:59:59 UTC).
    const due = new Date((raise.mock.calls[0][2] as { dueAt: string }).dueAt);
    expect(due.getUTCHours()).toBe(20);
    expect(due.getTime()).toBeGreaterThan(Date.now());
    expect(due.getTime() - Date.now()).toBeLessThan(4 * 86_400_000);
    // raise() honours every hint: severity, the hit's window and its due date (S8).
    expect(await alertOfHit(hit.id)).toMatchObject({
      rule: "TM-LIST",
      severity: "block",
      status: "open",
      windowKey: `hit:${hit.id}`,
      dueAt: due,
    });

    // New orders: refused neutrally.
    expect((await overview(b)).eligibility).toEqual({
      onramp: { allowed: false, reasons: ["compliance"] },
      offramp: { allowed: false, reasons: ["compliance"] },
    });
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/ramp/onramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "10" })
        .expect(403),
    );
    expect(refused).toMatchObject({
      error: "ramp_not_eligible",
      details: { reasons: ["compliance"] },
    });
    expect(JSON.stringify(refused)).not.toMatch(/screen|list|frozen|freeze/i);
    // The checkout is paid: captured and booked, never minted.
    await k.pay(b, open);
    await k.drive();
    expect(await k.order(open.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      mintCommandId: null,
      details: { complianceHold: { point: "freeze" } },
    });
    expect(await k.journal(open.order.id)).toMatchObject({
      "onramp.captured:provider_clearing": dec("20"),
      "onramp.captured:issuance_pending": dec("-20"),
    });
    expect(Object.keys(await k.journal(open.order.id))).not.toContain(
      "onramp.minted:customer_liability",
    );
    expect(await k.commands(open.order.id)).toEqual([]);
    // The cash-out's MarkPaid is deferred; a plain withdrawal is blocked; nothing leaves.
    await attach();
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(await k.order(off.id)).toMatchObject({
      status: "withdrawing",
      burnCommandId: null,
      details: { hold: { reason: "compliance" } },
    });
    expect(await payouts(offCid)).toMatchObject({ status: "blocked_compliance" });
    expect(markPaids(off.id)).toBe(0);
    expect(await k.commands(off.id)).toEqual([]);
    const plain = k.signWithdraw(b, "10");
    await ctx.get(PayoutService).scan();
    expect(await payouts(plain)).toMatchObject({ status: "blocked_compliance" });
    expect(ctx.wallet.transfers).toEqual([]);
    // The backend prepares no trade for the account (the neutral 403).
    expect(await prepare(b)).toMatchObject({
      status: 403,
      body: { error: "forbidden", message: "this operation is not available for this account" },
    });

    // The AML officer confirms (single control, role aml): the same freeze, no longer provisional.
    expect(await decide(hit.id, "confirm", carl, 403)).toMatchObject({ error: "role_required" });
    const confirmed = await decide(hit.id, "confirm");
    expect(confirmed).toMatchObject({
      approval: { action: "compliance.hit.decide", status: "executed" },
      result: { status: "confirmed", decidedByPerson: "anna", freezeId: freeze!.id },
    });
    expect(await activeFreeze(b.user.id)).toMatchObject({ id: freeze!.id, provisional: false });
    // The hit's TM-LIST alert is decided with it: escalated, the special form still owed (S8).
    const escalated = await alertOfHit(hit.id);
    expect(escalated).toMatchObject({ status: "escalated", decidedAt: expect.any(Date) as Date });
    expect(escalated.decisionReason).toMatch(/^list hit confirmed: /);
    expect(await audits("compliance.alert_decided")).toEqual([
      expect.objectContaining({
        subjectId: escalated.id,
        metadata: expect.objectContaining({
          decision: "escalate",
          to: "escalated",
          screeningHitId: hit.id,
        }) as object,
      }),
    ]);
    expect(await decide(hit.id, "clear", anna, 409)).toMatchObject({
      error: "screening_hit_state",
    });

    // Lifting is four-eyes: aml requests, another PERSON with `approver` approves.
    await ctx.agent
      .post(`/api/v1/admin/compliance/freezes/${freeze!.id}/lift`)
      .set(await headers(carl))
      .send({ reason: "no" })
      .expect(403);
    const requested = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/compliance/freezes/${freeze!.id}/lift`)
        .set(await headers(anna))
        .send({ reason: "court order 12/2026: assets released" })
        .expect(202),
    ).approval;
    expect(requested).toMatchObject({
      action: "compliance.freeze.lift",
      status: "pending",
      subjectId: freeze!.id,
    });
    for (const w of [anna, carl])
      await ctx.agent
        .post(`/api/v1/admin/approvals/${requested.id}/approve`)
        .set(await headers(w))
        .send({ reason: "self / wrong role" })
        .expect(403);
    expect(await activeFreeze(b.user.id)).not.toBeNull();
    const lifted = bodyOf<{ approval: ApiApproval; result: ApiComplianceFreeze }>(
      await ctx.agent
        .post(`/api/v1/admin/approvals/${requested.id}/approve`)
        .set(await headers(bob))
        .send({ reason: "documents checked" })
        .expect(200),
    );
    expect(lifted.result).toMatchObject({
      id: freeze!.id,
      active: false,
      liftApprovalId: requested.id,
    });
    expect(await activeFreeze(b.user.id)).toBeNull();
    expect(await audits("compliance.freeze.lifted")).toHaveLength(1);

    // Everything the freeze held resumes on the next pass of each loop.
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(await k.order(open.order.id)).toMatchObject({ status: "completed" });
    expect(await k.journal(open.order.id)).toMatchObject({
      "onramp.minted:customer_liability": dec("-20"),
    });
    expect(await k.commands(open.order.id)).toMatchObject([{ kind: "mint", status: "recorded" }]);
    expect(markPaids(off.id)).toBe(1);
    expect(await k.order(off.id)).toMatchObject({ status: "completed" });
    expect(await k.journal(off.id)).toMatchObject({
      "offramp.burned:customer_liability": dec("30"),
      "offramp.paid_card:payout_clearing": dec("30"),
    });
    expect(await k.commands(off.id)).toMatchObject([{ kind: "burn", status: "recorded" }]);
    expect(await payouts(plain)).toMatchObject({ status: "settled_external" });
    expect((await prepare(b)).status).toBe(200);
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    await k.expectIdentities();
  });

  it("clearing lifts the provisional freeze only once no other freezing-list hit is open; a lift request waits for the hits; a cleared hit stays cleared on re-screens", async () => {
    const b = await person("twice", { firstName: "Olga", lastName: "Sidorova", dob: "1980-06-01" });
    await importList("by_terror", "v1", [
      `person,"Сідарава Вольга|Сидорова Ольга|SIDOROVA OLGA",1980,`,
    ]);
    await importList("un", "2026/10", [`person,SIDOROVA Olga,,`]);
    const [first, second] = await hitsOf(b.user.id);
    const freeze = await activeFreeze(b.user.id);
    expect([first.freezeId, second.freezeId]).toEqual([freeze!.id, freeze!.id]);
    expect(first.match).toMatchObject({ birthDate: "partial" });
    expect(second.match).toMatchObject({ birthDate: "unknown" });
    // A four-eyes lift cannot jump the open hits.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/compliance/freezes/${freeze!.id}/lift`)
          .set(await headers(anna))
          .send({ reason: "lift" })
          .expect(409),
      ),
    ).toMatchObject({ error: "screening_hits_open" });
    await decide(first.id, "clear");
    expect(await activeFreeze(b.user.id)).toMatchObject({ id: freeze!.id, provisional: true });
    await decide(second.id, "clear");
    expect(await activeFreeze(b.user.id)).toBeNull();
    // Each cleared hit cleared its own TM-LIST alert: nothing is left for the overdue check (S8).
    for (const h of [first, second])
      expect(await alertOfHit(h.id)).toMatchObject({
        status: "cleared",
        decisionReason: expect.stringMatching(/^list hit cleared: /) as string,
      });
    expect(
      await ctx.dataSource
        .getRepository(ComplianceFreezeEntity)
        .findOneByOrFail({ id: freeze!.id }),
    ).toMatchObject({
      active: false,
      liftApprovalId: null,
      liftReason: expect.stringContaining("list hit cleared") as string,
    });
    // A re-screen against the same versions finds nothing new.
    const rerun = bodyOf<{ run: { hits: number; status: string } }>(
      await ctx.agent
        .post("/api/v1/admin/compliance/screening-runs")
        .set(await headers(anna))
        .send({ reason: "monthly check" })
        .expect(200),
    ).run;
    expect(rerun).toMatchObject({ hits: 0, status: "done" });
    expect((await hitsOf(b.user.id)).map((h) => h.status)).toEqual(["cleared", "cleared"]);
    const ADMIN = await headers(anna);
    const runs = bodyOf<{ items: { trigger: string; scope: string }[] }>(
      await ctx.agent.get("/api/v1/admin/compliance/screening-runs").set(ADMIN).expect(200),
    ).items;
    expect(runs[0]).toMatchObject({ trigger: "admin", scope: "full" });
    expect(
      bodyOf<{ freeze: ApiComplianceFreeze }>(
        await ctx.agent
          .get(`/api/v1/admin/compliance/freezes/${freeze!.id}`)
          .set(ADMIN)
          .expect(200),
      ).freeze,
    ).toMatchObject({ active: false, provisional: true, liftedAt: expect.any(String) as string });
    // The single hit shows the account's verified identity next to the entry (an audited PII read).
    expect(
      bodyOf<ApiScreeningHitDetail>(
        await ctx.agent
          .get(`/api/v1/admin/compliance/screening-hits/${first.id}`)
          .set(ADMIN)
          .expect(200),
      ),
    ).toMatchObject({
      hit: { status: "cleared", decidedByPerson: "anna", list: "by_terror", listVersion: "v1" },
      identity: {
        names: [{ script: "lat", last: "Sidorova", first: "Olga" }],
        birthDate: "1980-06-01",
      },
    });
    expect(await audits("compliance.screening.identity_viewed")).toEqual([
      expect.objectContaining({ subjectId: first.id }),
    ]);
    await ctx.agent
      .get("/api/v1/admin/compliance/screening-runs")
      .set(await headers(carl))
      .expect(403);
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
  });

  it("a Decree No. 48 address hit matches the account's party id and freezes it; an operator freeze needs aml and refuses a second active one", async () => {
    const b = await k.buyer("decree48");
    const imported = await importList("decree48", "reg-2026-41", [
      `address,,,"${b.wallet.partyId}|0xdeadbeef"`,
    ]);
    expect(imported.hits).toBe(1);
    const [hit] = await hitsOf(b.user.id);
    expect(hit.match).toEqual({
      basis: "party",
      party: b.wallet.partyId,
      listed: b.wallet.partyId,
    });
    const freeze = await activeFreeze(b.user.id);
    expect(freeze).toMatchObject({ provisional: true });
    const other = await k.buyer("manual");
    for (const w of [carl, bob])
      await ctx.agent
        .post("/api/v1/admin/compliance/freezes")
        .set(await headers(w))
        .send({ userId: other.user.id, reason: "x", source: "manual" })
        .expect(403);
    const placed = bodyOf<{ freeze: ApiComplianceFreeze }>(
      await ctx.agent
        .post("/api/v1/admin/compliance/freezes")
        .set(await headers(anna))
        .send({ userId: other.user.id, reason: "court ruling 2-117/2026", source: "court" })
        .expect(200),
    ).freeze;
    expect(placed).toMatchObject({
      userId: other.user.id,
      source: "court",
      provisional: false,
      active: true,
      createdByPerson: "anna",
    });
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/compliance/freezes")
          .set(await headers(anna))
          .send({ userId: b.user.id, reason: "again", source: "aml" })
          .expect(409),
      ),
    ).toMatchObject({ error: "freeze_active", details: { freezeId: freeze!.id } });
    const listed = bodyOf<{ items: ApiComplianceFreeze[] }>(
      await ctx.agent
        .get("/api/v1/admin/compliance/freezes?active=true")
        .set(await headers(bob))
        .expect(200),
    ).items;
    expect(listed.map((f) => f.userId).sort()).toEqual([b.user.id, other.user.id].sort());
    expect(await audits("compliance.freeze.created")).toHaveLength(1);
  });
});

describe("a foreign-list hit denies new orders, never freezes (B1)", () => {
  it("TM-LIST review alert; no freeze, so payouts, withdrawals and trades go on; confirm keeps the deny, clear lifts it", async () => {
    const b = await person("foreign", { firstName: "John", lastName: "Doe", dob: "1970-01-01" });
    await k.bought(b, "40", "card-foreign");
    await k.decayExposure();
    await seedMarket(b.wallet.partyId);
    const imported = await importList("foreign", "OFAC-SDN-2026-10-18", [
      `person,"DOE, John|ДОУ Джон",1970-01-01,`,
      `org,"Doe Holdings Ltd",,`,
    ]);
    expect(imported.hits).toBe(1);
    const [hit] = await hitsOf(b.user.id);
    expect(hit).toMatchObject({
      status: "open",
      freezeId: null,
      match: { basis: "name", entryName: "DOE, John" },
    });
    expect(await activeFreeze(b.user.id)).toBeNull();
    expect(raise).toHaveBeenCalledWith(
      "TM-LIST",
      b.user.id,
      expect.objectContaining({ severity: "review", list: "foreign", freezeId: null }),
    );
    // New orders: the neutral refusal.
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    await ctx.agent
      .post("/api/v1/ramp/onramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount: "10" })
      .expect(403);
    // Not frozen: value already owned still moves (a plain withdrawal, a trade).
    const plain = k.signWithdraw(b, "5");
    await ctx.get(PayoutService).scan();
    expect(await payouts(plain)).toMatchObject({ status: "settled_external" });
    expect((await prepare(b)).status).toBe(200);
    // Confirmed: still denied (no freeze). Cleared afterwards: allowed again.
    await decide(hit.id, "confirm");
    expect(await activeFreeze(b.user.id)).toBeNull();
    expect((await overview(b)).eligibility.offramp.reasons).toContain("compliance");
    expect(await alertOfHit(hit.id)).toMatchObject({ severity: "review", status: "escalated" });
    const cleared = await decide(hit.id, "clear");
    expect(cleared.result).toMatchObject({ status: "cleared" });
    expect(await alertOfHit(hit.id)).toMatchObject({ status: "cleared" });
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    await k.expectIdentities();
  });
});

describe("a frozen account's refunds wait (B3)", () => {
  it("a refund request is refused while frozen; a refund already approved holds before the acquirer call; both go on after the four-eyes lift", async () => {
    const b = await k.buyer("refunds");
    const first = await k.openOnramp(b, "15");
    await k.pay(b, first, "no_3ds");
    expect(await k.order(first.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
    });
    // The approved refund cannot reach the acquirer yet (its reference lookup fails: fail closed).
    k.mock().lookupFailure = new Error("acquirer API down");
    const requested = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${first.order.id}/refund`)
        .set(await headers(anna))
        .send({ reason: "no 3-D Secure: refund" })
        .expect(202),
    ).approval;
    await ctx.agent
      .post(`/api/v1/admin/approvals/${requested.id}/approve`)
      .set(await headers(bob))
      .send({ reason: "ok" })
      .expect(200);
    expect((await k.order(first.order.id)).status).toBe("refunding");
    const second = await k.openOnramp(b, "12");
    await k.pay(b, second, "no_3ds");

    const placed = bodyOf<{ freeze: ApiComplianceFreeze }>(
      await ctx.agent
        .post("/api/v1/admin/compliance/freezes")
        .set(await headers(anna))
        .send({ userId: b.user.id, reason: "suspicious operations, DFM form filed", source: "aml" })
        .expect(200),
    ).freeze;
    // A new refund is refused at the request (validate: frozen); the approved one holds.
    expect(
      bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/ramp/orders/${second.order.id}/refund`)
          .set(await headers(anna))
          .send({ reason: "refund" })
          .expect(409),
      ),
    ).toMatchObject({
      error: "ramp_order_state",
      message: expect.stringContaining("frozen") as string,
    });
    k.mock().lookupFailure = null;
    await k.drive();
    expect(await k.order(first.order.id)).toMatchObject({
      status: "refunding",
      details: { hold: { reason: "frozen" } },
    });
    expect(k.mock().refundsOf(k.paymentIdOf(first))).toEqual([]);

    await lift(placed.id);
    await k.drive();
    expect(await k.order(first.order.id)).toMatchObject({ status: "refunded" });
    expect(k.mock().refundsOf(k.paymentIdOf(first))).toHaveLength(1);
    expect(await k.journal(first.order.id)).toMatchObject({
      "onramp.refunded:issuance_pending": dec("15"),
      "onramp.refunded:provider_clearing": dec("-15"),
    });
    expect(await k.commands(first.order.id)).toEqual([]);
    await ctx.agent
      .post(`/api/v1/admin/ramp/orders/${second.order.id}/refund`)
      .set(await headers(anna))
      .send({ reason: "refund" })
      .expect(202);
    await k.expectIdentities();
  });
});

/** Windows-1251 bytes of `text` (ASCII, Russian and Belarusian letters only: what the test needs). */
function cp1251(text: string): Buffer {
  const extra: Record<string, number> = { Ё: 0xa8, ё: 0xb8, І: 0xb2, і: 0xb3, Ў: 0xa1, ў: 0xa2 };
  return Buffer.from(
    [...text].map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c < 0x80) return c;
      if (extra[ch] !== undefined) return extra[ch];
      if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
      throw new Error(`no cp1251 byte for ${ch}`);
    }),
  );
}

describe("list imports (role aml, normalized CSV, charset)", () => {
  it("refuses other roles, malformed files and a version already imported; decodes Windows-1251; lists the imports", async () => {
    const b = await person("cp1251", {
      firstName: "SIARHEI",
      lastName: "KAVALIOU",
      dob: "1981-02-03",
    });
    await ctx.agent
      .post("/api/v1/admin/compliance/screening-lists")
      .set(await headers(carl))
      .send({
        list: "by_terror",
        version: "x",
        deliveredAt: new Date().toISOString(),
        content: csv64(["person,A B,,"]),
      })
      .expect(403);
    await ctx.agent
      .get("/api/v1/admin/compliance/screening-lists")
      .set(await headers(carl))
      .expect(403);
    const ADMIN = await headers(anna);
    const send = async (body: Record<string, unknown>, status: number): Promise<ErrorBody> =>
      bodyOf<ErrorBody>(
        await ctx.agent
          .post("/api/v1/admin/compliance/screening-lists")
          .set(ADMIN)
          .send({
            list: "by_terror",
            version: "v1",
            deliveredAt: new Date().toISOString(),
            ...body,
          })
          .expect(status),
      );
    expect(await send({ content: "not base64!" }, 400)).toMatchObject({
      error: "screening_list_invalid",
    });
    expect(await send({ content: csv64(["person,A B,,", "ship,X,,"]) }, 400)).toMatchObject({
      error: "screening_list_invalid",
      details: { line: 2 },
    });
    expect(await send({ list: "ofac", content: csv64(["person,A B,,"]) }, 400)).toMatchObject({
      error: "validation_failed",
    });
    expect(
      await send({ content: csv64(["person,A B,,"]), deliveredAt: "2999-01-01T00:00:00Z" }, 400),
    ).toMatchObject({
      error: "validation_failed",
    });
    const bytes = cp1251(`${LIST_HEADER}\r\nperson,"Кавалёў Сяргей Мікалаевіч",03.02.1981,\r\n`);
    const imported = bodyOf<ApiScreeningImport>(
      await ctx.agent
        .post("/api/v1/admin/compliance/screening-lists")
        .set(ADMIN)
        .send({
          list: "by_terror",
          version: "v1",
          deliveredAt: new Date(Date.now() - 3_600_000).toISOString(),
          content: bytes.toString("base64"),
          charset: "windows-1251",
        })
        .expect(200),
    );
    expect(imported).toMatchObject({ list: { charset: "windows-1251", entryCount: 1 }, hits: 1 });
    expect(imported.list.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect((await hitsOf(b.user.id))[0].match).toMatchObject({
      entryName: "Кавалёў Сяргей Мікалаевіч",
    });
    // The same bytes as UTF-8 would not decode: the charset is named, never sniffed.
    expect(await send({ version: "v2", content: bytes.toString("base64") }, 400)).toMatchObject({
      error: "validation_failed",
    });
    expect(await send({ content: csv64(["person,A B,,"]) }, 409)).toMatchObject({
      error: "screening_list_exists",
    });
    const lists = bodyOf<{ items: { version: string; importedByPerson: string }[] }>(
      await ctx.agent.get("/api/v1/admin/compliance/screening-lists").set(ADMIN).expect(200),
    ).items;
    expect(lists).toEqual([expect.objectContaining({ version: "v1", importedByPerson: "anna" })]);
    const hits = bodyOf<{ items: ApiScreeningHit[] }>(
      await ctx.agent
        .get(`/api/v1/admin/compliance/screening-hits?status=open&userId=${b.user.id}`)
        .set(ADMIN)
        .expect(200),
    ).items;
    expect(hits).toEqual([
      expect.objectContaining({
        list: "by_terror",
        listVersion: "v1",
        entryKind: "person",
        status: "open",
      }),
    ]);
    expect(await audits("compliance.screening.imported")).toHaveLength(1);
    expect(await audits("compliance.screening.hit")).toHaveLength(1);
  });
});

describe("the operations register (role export, ≤ 31 days)", () => {
  it("exports every order of the range with the KYC name, payment / payout facts and the reference — formula-safe, export id in the first record, row count audited; other roles 403, a longer range 400", async () => {
    const b = await person("register", {
      firstName: "Anna",
      lastName: "Kavaliova",
      dob: "1990-04-05",
    });
    const card = await k.bought(b, "10", "card-register");
    const erip = await k.openOnramp(b, "25", nextKey(), "erip");
    await k.pay(b, erip, "succeeded", {
      payerName: "=1+1 KAVALIOVA",
      payerNameSource: "bank",
      channel: "online",
    });
    await k.drive();
    expect((await k.order(erip.order.id)).status).toBe("completed");
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    for (const w of [anna, carl, bob])
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post("/api/v1/admin/ramp/operations/export")
            .set(await headers(w))
            .send({ from, to })
            .expect(403),
        ),
      ).toMatchObject({ error: "role_required", details: { role: "export" } });
    const ERIN = await headers(erin);
    for (const range of [
      { from, to: new Date(Date.parse(from) + 31 * 86_400_000 + 1).toISOString() },
      { from: to, to: from },
    ])
      expect(
        bodyOf<ErrorBody>(
          await ctx.agent
            .post("/api/v1/admin/ramp/operations/export")
            .set(ERIN)
            .send(range)
            .expect(400),
        ),
      ).toMatchObject({ error: "export_range" });

    const res = await ctx.agent
      .post("/api/v1/admin/ramp/operations/export")
      .set(ERIN)
      .send({ from, to })
      .buffer(true)
      .parse((r, done) => {
        let text = "";
        r.on("data", (c: Buffer) => (text += c.toString("utf8")));
        r.on("end", () => done(null, text));
      })
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="ramp-operations-.*\.csv"$/,
    );
    const records = parseCsv(res.body as string);
    const [meta, header, ...rows] = records;
    expect(meta.slice(0, 2)).toEqual(["export_id", res.headers["x-export-id"]]);
    expect(meta.slice(-2)).toEqual(["rows", "2"]);
    expect(header).toEqual([...OPERATIONS_COLUMNS]);
    const byId = new Map(
      rows.map((r) => [r[0], Object.fromEntries(header.map((h, i) => [h, r[i]]))]),
    );
    const cardRow = byId.get(card.id)!;
    expect(cardRow).toMatchObject({
      direction: "onramp",
      method: "card",
      status: "completed",
      fiat_currency: "BYN",
      fiat_amount: dec("10"),
      user_id: b.user.id,
      kyc_name_lat: "Kavaliova Anna",
      kyc_birth_date: "1990-04-05",
      payout_reference: expect.stringMatching(/^TO-\d{12}$/) as string,
      payment_three_ds: "authenticated",
    });
    expect(cardRow.payment_provider_txn_id).toBeTruthy();
    expect(cardRow.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // The bank-supplied payer name, unsealed, with a formula guard in front.
    expect(byId.get(erip.order.id)).toMatchObject({
      method: "erip",
      payment_channel: "online",
      payment_payer_name_source: "bank",
      payment_payer_name: "'=1+1 KAVALIOVA",
    });
    const [audit] = await audits("ramp.operations.exported");
    expect(audit).toMatchObject({
      subjectId: res.headers["x-export-id"],
      metadata: { rows: 2, from, to, operatorPerson: "erin" },
    });
  });
});

describe("re-screen schedule, screening_stale and retention", () => {
  it("screening_stale is amber until every freezing list is imported and re-screened; the processor re-screens every RAMP_RESCREEN_DAYS", async () => {
    const staleOf = async () => k.checkOf(await k.reconciliation(), "screening_stale");
    expect(await staleOf()).toMatchObject({
      status: "amber",
      detail:
        "no complete full re-screen yet; by_terror never imported; un never imported; decree48 never imported",
    });
    await k.buyer("scheduled");
    for (const list of ["by_terror", "un", "decree48"] as const)
      await importList(
        list,
        "2026-10",
        list === "decree48" ? [`address,,,"nobody::1220aa"`] : [`person,Nobody Known,,`],
      );
    expect(await staleOf()).toMatchObject({ status: "green" });
    const processor = ctx.get(ComplianceScreeningProcessor);
    expect(await processor.tick()).toEqual({ rescreen: null, frozenActivity: 0 });
    // RAMP_RESCREEN_DAYS (30) after the last complete run, the processor runs a full re-screen.
    await ctx.dataSource.query(
      `UPDATE to_screening_runs SET started_at = started_at - interval '30 days'`,
    );
    const { rescreen } = await processor.tick();
    expect(rescreen).toMatchObject({ scope: "full", trigger: "schedule", status: "done", hits: 0 });
    expect(rescreen!.subjects).toBeGreaterThanOrEqual(1);
    expect(await processor.tick()).toMatchObject({ rescreen: null });
    // A list not imported for RAMP_SCREENING_LIST_MAX_AGE_DAYS (30) turns the check amber again.
    await ctx.dataSource.query(
      `UPDATE to_screening_lists SET imported_at = imported_at - interval '31 days' WHERE list = 'un'`,
    );
    expect(await staleOf()).toMatchObject({
      status: "amber",
      detail: "un last imported 31 days ago",
    });
  });

  it("no housekeeping deletes ramp, journal, token, approval, consent, identity, screening or compliance rows — only acquirer event payloads go after 30 days; DELETE on screening / freeze rows is refused", async () => {
    const b = await person("retained", {
      firstName: "Ivan",
      lastName: "Retainov",
      dob: "1950-01-01",
    });
    await k.bought(b, "10", "card-retained");
    await importList("by_terror", "old", [`person,Retainov Ivan,1950,`]);
    const freeze = await activeFreeze(b.user.id);
    const [hit] = await hitsOf(b.user.id);
    await decide(hit.id, "confirm");
    await ctx.agent
      .post(`/api/v1/admin/compliance/freezes/${freeze!.id}/lift`)
      .set(await headers(anna))
      .send({ reason: "pending lift" })
      .expect(202);
    // Everything is years old (the journal is append-only: its rows keep their dates).
    for (const sql of [
      `UPDATE to_ramp_orders SET created_at = now() - interval '6 years'`,
      `UPDATE to_ramp_events SET received_at = now() - interval '6 years'`,
      `UPDATE to_token_commands SET created_at = now() - interval '6 years'`,
      `UPDATE to_admin_approvals SET requested_at = now() - interval '6 years'`,
      `UPDATE to_compliance_freezes SET created_at = now() - interval '6 years'`,
      `UPDATE to_screening_lists SET imported_at = now() - interval '6 years'`,
      `UPDATE to_screening_hits SET created_at = now() - interval '6 years'`,
      `UPDATE to_screening_runs SET started_at = now() - interval '6 years'`,
    ])
      await ctx.dataSource.query(sql);
    const tables = (
      await ctx.dataSource.query<{ name: string }[]>(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = 'public' AND (table_name LIKE 'to\\_ramp\\_%' OR table_name LIKE 'to\\_token\\_%'
             OR table_name LIKE 'to\\_compliance\\_%' OR table_name LIKE 'to\\_screening\\_%'
             OR table_name IN ('to_admin_approvals', 'to_kyc_identities', 'to_audit_events'))
          ORDER BY 1`,
      )
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "to_ramp_orders",
        "to_ramp_journal",
        "to_token_commands",
        "to_admin_approvals",
        "to_compliance_freezes",
        "to_screening_hits",
      ]),
    );
    const counts = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of tables)
        out[t] = Number(
          (await ctx.dataSource.query<{ n: string }[]>(`SELECT count(*) AS n FROM "${t}"`))[0].n,
        );
      return out;
    };
    const before = await counts();
    expect(before.to_ramp_events).toBeGreaterThan(0);
    await ctx.get(SessionCleanupProcessor).tick();
    await ctx.get(RampReconProcessor).tick();
    await ctx.get(ComplianceScreeningProcessor).tick();
    await ctx.get(RampProcessor).tick();
    // Rows may be added (a reconciliation run, audit rows), never removed.
    const after = await counts();
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(tables.filter((t) => after[t] < before[t])).toEqual([]);
    const [events] = await ctx.dataSource.query<{ n: string; kept: string }[]>(
      `SELECT count(*) AS n, count(payload) AS kept FROM to_ramp_events`,
    );
    expect(events).toEqual({ n: String(before.to_ramp_events), kept: "0" });
    for (const t of [
      "to_compliance_freezes",
      "to_screening_hits",
      "to_screening_lists",
      "to_screening_entries",
      "to_screening_runs",
      "to_screening_subjects",
    ])
      await expect(ctx.dataSource.query(`DELETE FROM "${t}"`)).rejects.toThrow(/retained/);
  });
});

describe("screening before contracting (art.9-1)", () => {
  it("an account that appears after the import is screened before its first order — again once its KYC identity is verified", async () => {
    const imported = await importList("by_terror", "2026-10-19", [`person,Петров Иван,1980,`]);
    expect(imported.hits).toBe(0);
    const b = await signUp("newcomer");
    // Before KYC: screened by party ids only (no identity yet).
    expect((await overview(b)).eligibility.onramp.reasons).toContain("kyc_required");
    expect(await activeFreeze(b.user.id)).toBeNull();
    const [subject] = await ctx.dataSource.query<
      { identity: boolean; kyc_verification_id: string | null }[]
    >(`SELECT identity, kyc_verification_id FROM to_screening_subjects WHERE user_id = $1`, [
      b.user.id,
    ]);
    expect(subject).toEqual({ identity: false, kyc_verification_id: null });
    // Verified as Ivan Petrov, born 1980: the next eligibility check screens the identity.
    await approveKyc(b, { firstName: "Ivan", lastName: "Petrov", dob: "1980-05-05" });
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    const [hit] = await hitsOf(b.user.id);
    expect(hit).toMatchObject({ status: "open", match: { basis: "name", birthDate: "partial" } });
    expect(await activeFreeze(b.user.id)).toMatchObject({ provisional: true, source: "screening" });
    const runs = await ctx.dataSource
      .getRepository(ScreeningRunEntity)
      .find({ where: { userId: b.user.id }, order: { startedAt: "ASC" } });
    expect(runs.map((r) => [r.scope, r.trigger, r.status, r.hits])).toEqual([
      ["user", "user", "done", 0],
      ["user", "user", "done", 1],
    ]);
  });
});

describe("identities for re-screens (S8: S7a ↔ S7b)", () => {
  it("a full re-screen reads stored identities (no KYC provider call per account); a refreshed identity is screened again, once, before the next order", async () => {
    const b = await person("stored-id", {
      firstName: "Anna",
      lastName: "Karpava",
      dob: "1990-02-02",
    });
    const runs = ctx.dataSource.getRepository(ScreeningRunEntity);
    // The provider is down: the import's full re-screen still screens every stored identity.
    const fetch = jest
      .spyOn(ctx.get(KycProviderMockService), "fetchApplicant")
      .mockRejectedValue(new ApiError(502, "upstream_failed", "provider down"));
    try {
      const imported = await importList("by_terror", "2026-10-19", [`person,"Пятроў Пётр",1960,`]);
      expect(imported.run).toMatchObject({ scope: "full", status: "done", failures: 0 });
      expect(imported.run!.identities).toBeGreaterThanOrEqual(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
    // Screened against the latest lists under its current identity: GET /ramp screens nothing.
    const before = await runs.count();
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    expect(await runs.count()).toBe(before);
    // A refresh may carry a corrected name: the account is screened again before its next order.
    await ctx.get(KycIdentityService).refresh(b.user.id);
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    const [latest] = await runs.find({
      where: { userId: b.user.id },
      order: { startedAt: "DESC" },
    });
    expect(latest).toMatchObject({ scope: "user", trigger: "user", status: "done", identities: 1 });
    expect(await runs.count()).toBe(before + 1);
    expect((await overview(b)).eligibility.onramp.allowed).toBe(true);
    expect(await runs.count()).toBe(before + 1);
  });
});

describe("review findings C8 / C11 / C29: a hold is never told to the payee; MarkPaid by hand respects a freeze", () => {
  it("C8/C11/C29: a frozen account's payouts read 'processing' with no reason (list, wallet, settle 409); payout.mark_paid refuses its withdrawal; operators keep the detail", async () => {
    const b = await k.buyer("tip-off");
    await k.bought(b, "60", "card-tip-off");
    await k.decayExposure();
    const { cid: offCid, attach } = await cashOutSigned(b, "30");
    await ctx.agent
      .post("/api/v1/admin/compliance/freezes")
      .set(await headers(anna))
      .send({ userId: b.user.id, source: "aml", reason: "suspicious activity report 7/2026" })
      .expect(200);
    await attach();
    const plain = k.signWithdraw(b, "10");
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(await payouts(offCid)).toMatchObject({ status: "blocked_compliance" });
    expect((await payouts(plain)).lastError).toMatch(/frozen/);

    // The payee's own views: one neutral status, no reason, nothing that names the hold.
    const LEAK = /compliance|frozen|freeze|deny|review|payout_gate|screen/i;
    const list = bodyOf<{ payouts: { pendingPayoutCid: string }[] }>(
      await ctx.agent.get("/api/v1/in-app-wallet/payouts").set(b.headers).expect(200),
    ).payouts;
    for (const cid of [offCid, plain])
      expect(list.find((p) => p.pendingPayoutCid === cid)).toMatchObject({
        status: "processing",
        lastError: null,
      });
    expect(JSON.stringify(list)).not.toMatch(LEAK);
    const wallet = bodyOf<{ payouts: unknown[] }>(
      await ctx.agent.get("/api/v1/in-app-wallet").set(b.headers).expect(200),
    );
    expect(wallet.payouts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(wallet.payouts)).not.toMatch(LEAK);
    const settle = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/in-app-wallet/payouts/${plain}/settle`)
        .set(b.headers)
        .send({})
        .expect(409),
    );
    expect(settle).toMatchObject({ error: "payout_blocked", details: { status: "processing" } });
    expect(JSON.stringify(settle)).not.toMatch(LEAK);

    // C29: an operator cannot record the frozen account's withdrawal as paid by hand.
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post(`/api/v1/admin/payouts/${plain}/mark-paid`)
        .set(await headers(carl))
        .send({ txHash: "bank-ref-frozen-1", reason: "paid from the bank by hand" })
        .expect(409),
    );
    expect(refused).toMatchObject({
      error: "payout_blocked",
      details: { reason: "compliance_hold" },
    });
    expect(ctx.ledger.payouts.has(plain)).toBe(true);
    expect(JSON.stringify(ctx.wallet.submits)).not.toContain("bank-ref-frozen-1");
    // Operators keep the detail (admin view of the same row).
    const admin = bodyOf<{
      items: { pendingPayoutCid: string; status: string; lastError: string }[];
    }>(
      await ctx.agent
        .get("/api/v1/admin/payouts")
        .set(await headers(anna))
        .expect(200),
    ).items.find((p) => p.pendingPayoutCid === plain);
    expect(admin).toMatchObject({
      status: "blocked_compliance",
      lastError: expect.stringMatching(/frozen/) as string,
    });
  });
});

describe("review findings C12 / C27 / C13: screening reaches every form, party and principal", () => {
  it("C12: a Russian-only by_terror entry freezes an identity verified with the Latin passport form only", async () => {
    const b = await person("bridged", {
      firstName: "SIARHEI",
      lastName: "IVANOU",
      dob: "1980-05-01",
    });
    const imported = await importList("by_terror", "2026-10-20", [
      `person,ИВАНОВ Сергей Николаевич,01.05.1980,`,
    ]);
    expect(imported.hits).toBe(1);
    const [hit] = await hitsOf(b.user.id);
    expect(hit.match).toMatchObject({
      basis: "name",
      script: "lat",
      birthDate: "exact",
      via: "bridge",
    });
    expect(await activeFreeze(b.user.id)).toMatchObject({ provisional: true, source: "screening" });
  });

  it("C27: a party linked after the account was screened is screened before the next order (Decree No. 48 namespace)", async () => {
    const listed = makeTestWallet("listed-later");
    const namespace = listed.partyId.slice(listed.partyId.indexOf("::") + 2);
    await importList("decree48", "2026-10-20", [`address,,,"${namespace}"`]);
    const b = await k.buyer("late-party");
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    expect(await hitsOf(b.user.id)).toEqual([]);
    await linkWallet(ctx.agent, b.cookie, listed);
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/ramp/onramp")
        .set(b.headers)
        .set("Idempotency-Key", nextKey())
        .send({ amount: "10" })
        .expect(403),
    );
    expect(refused).toMatchObject({
      error: "ramp_not_eligible",
      details: { reasons: ["compliance"] },
    });
    const [hit] = await hitsOf(b.user.id);
    expect(hit).toMatchObject({ status: "open", match: { basis: "party", listed: namespace } });
    expect(await activeFreeze(b.user.id)).toMatchObject({ provisional: true });
  });

  it("C27: before value moves outside an order (market order prepare), a newly linked listed party is screened and freezes the account", async () => {
    const listed = makeTestWallet("listed-prepare");
    const namespace = listed.partyId.slice(listed.partyId.indexOf("::") + 2);
    await importList("decree48", "2026-10-21", [`address,,,"${namespace}"`]);
    const b = await k.buyer("prepare-party");
    expect((await overview(b)).eligibility.onramp.allowed).toBe(true);
    await seedMarket(b.wallet.partyId);
    expect((await prepare(b)).status).toBe(200);
    await linkWallet(ctx.agent, b.cookie, listed);
    expect(await prepare(b)).toMatchObject({
      status: 403,
      body: { error: "forbidden", message: "this operation is not available for this account" },
    });
    const [hit] = await hitsOf(b.user.id);
    expect(hit).toMatchObject({ status: "open", match: { basis: "party", listed: namespace } });
    expect(await activeFreeze(b.user.id)).toMatchObject({ provisional: true });
  });

  it("R2b-5: an account never screened (no ramp view yet) has a newly linked listed party screened before value moves, and no subject is written", async () => {
    const listed = makeTestWallet("listed-never");
    const namespace = listed.partyId.slice(listed.partyId.indexOf("::") + 2);
    await importList("decree48", "2026-10-23", [`address,,,"${namespace}"`]);
    const b = await k.buyer("never-screened");
    await seedMarket(b.wallet.partyId);
    await linkWallet(ctx.agent, b.cookie, listed);
    const subjects = (): Promise<number> =>
      ctx.dataSource.getRepository(ScreeningSubjectEntity).countBy({ userId: b.user.id });
    expect(await subjects()).toBe(0);
    expect(await prepare(b)).toMatchObject({
      status: 403,
      body: { error: "forbidden", message: "this operation is not available for this account" },
    });
    const [hit, ...more] = await hitsOf(b.user.id);
    expect(more).toEqual([]);
    expect(hit).toMatchObject({ status: "open", match: { basis: "party", listed: namespace } });
    expect(await activeFreeze(b.user.id)).toMatchObject({ provisional: true });
    // Its first order still screens it in full (needsScreening: no subject yet).
    expect(await subjects()).toBe(0);
  });

  it("R2b-3: a freezing-list hit recorded while a freeze lift executes is counted again under the account lock: the lift fails and the account stays frozen", async () => {
    const listed = makeTestWallet("listed-lift-race");
    const namespace = listed.partyId.slice(listed.partyId.indexOf("::") + 2);
    const b = await k.buyer("lift-race");
    await linkWallet(ctx.agent, b.cookie, listed);
    const placed = bodyOf<{ freeze: ApiComplianceFreeze }>(
      await ctx.agent
        .post("/api/v1/admin/compliance/freezes")
        .set(await headers(anna))
        .send({ userId: b.user.id, reason: "AML decision 2026-10-20", source: "aml" })
        .expect(200),
    ).freeze;
    const requested = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/compliance/freezes/${placed.id}/lift`)
        .set(await headers(anna))
        .send({ reason: "court order: assets released" })
        .expect(202),
    ).approval;
    // The approval validated (no open hit); before the lift's write a list import hits the account.
    const freezes = ctx.get(ComplianceFreezeService) as unknown as {
      liftApproved: (...args: unknown[]) => Promise<unknown>;
    };
    const original = freezes.liftApproved.bind(freezes);
    const race = jest.spyOn(freezes, "liftApproved").mockImplementation(async (...args) => {
      expect((await importList("decree48", "2026-10-24", [`address,,,"${namespace}"`])).hits).toBe(
        1,
      );
      return original(...args);
    });
    try {
      const failed = bodyOf<ErrorBody>(
        await ctx.agent
          .post(`/api/v1/admin/approvals/${requested.id}/approve`)
          .set(await headers(bob))
          .send({ reason: "documents checked" })
          .expect(409),
      );
      expect(failed).toMatchObject({
        error: "approval_failed",
        details: { cause: "screening_hits_open" },
      });
    } finally {
      race.mockRestore();
    }
    const [hit] = await hitsOf(b.user.id);
    expect(hit).toMatchObject({ status: "open", freezeId: placed.id });
    expect(await activeFreeze(b.user.id)).toMatchObject({ id: placed.id });
  });

  it("C13: the principal a consent names is screened before the next order; a listed principal freezes the account", async () => {
    await importList("by_terror", "2026-10-20", [`person,ИВАНОВ Сергей Николаевич,01.05.1980,`]);
    const b = await k.buyer("acts-for");
    expect((await overview(b)).eligibility.onramp.allowed).toBe(true);
    await ctx.agent
      .post("/api/v1/ramp/consent")
      .set(b.headers)
      .send({
        termsVersion: ctx.config.ramp.termsVersion,
        actsForSelf: false,
        principal: "Сергей Николаевич Иванов, my uncle",
        pepDeclared: false,
      })
      .expect(200);
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    const [hit] = await hitsOf(b.user.id);
    expect(hit).toMatchObject({ status: "open", match: { basis: "principal" } });
    expect(await activeFreeze(b.user.id)).toMatchObject({ provisional: true });
  });
});

/** Remove an account's stored identity behind the retention triggers (a test-only shortcut). */
async function forget(userId: string): Promise<void> {
  for (const table of ["to_kyc_identities", "to_kyc_identity_versions"]) {
    const [exists] = await ctx.dataSource.query<{ t: string | null }[]>(
      `SELECT to_regclass($1)::text AS t`,
      [table],
    );
    if (!exists?.t) continue;
    await ctx.dataSource.query(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
    try {
      await ctx.dataSource.query(`DELETE FROM "${table}" WHERE user_id = $1`, [userId]);
    } finally {
      await ctx.dataSource.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
    }
  }
}

describe("review findings C14 / C15: the identity each operation was made under is kept and exported", () => {
  async function exportRows(): Promise<Map<string, Record<string, string>>> {
    const res = await ctx.agent
      .post("/api/v1/admin/ramp/operations/export")
      .set(await headers(erin))
      .send({
        from: new Date(Date.now() - 86_400_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      })
      .buffer(true)
      .parse((r, done) => {
        let text = "";
        r.on("data", (c: Buffer) => (text += c.toString("utf8")));
        r.on("end", () => done(null, text));
      })
      .expect(200);
    const [, header, ...rows] = parseCsv(res.body as string);
    return new Map(rows.map((r) => [r[0], Object.fromEntries(header.map((h, i) => [h, r[i]]))]));
  }

  it("C14/C15: a re-verification opens a new identity version (the old one kept, append-only); the register shows each order's own identity, also after the approval ended", async () => {
    const b = await person("history", {
      firstName: "Anna",
      lastName: "Kavaliova",
      dob: "1990-04-05",
    });
    const first = await k.bought(b, "10", "card-history");
    // Married: re-verified under a new surname with a new document.
    await approveKyc(b, { firstName: "Anna", lastName: "Shauchenka", dob: "1990-04-05" });
    const second = await k.bought(b, "12", "card-history");
    const versions = (): Promise<{ version: number; open: boolean; changed: string[] }[]> =>
      ctx.dataSource.query(
        `SELECT version, valid_to IS NULL AS open, changed_fields AS changed FROM to_kyc_identity_versions WHERE user_id = $1 ORDER BY version`,
        [b.user.id],
      );
    const [v1, v2] = await versions();
    expect([v1.version, v1.open, v2.version, v2.open]).toEqual([1, false, 2, true]);
    expect(v2.changed).toEqual(expect.arrayContaining(["names", "doc"]));
    // An unchanged refresh adds no version.
    await ctx.get(KycIdentityService).refresh(b.user.id);
    expect(await versions()).toHaveLength(2);
    // Append-only: no delete, no rewrite of a version; identities are never deleted.
    await expect(
      ctx.dataSource.query(`DELETE FROM to_kyc_identity_versions WHERE user_id = $1`, [b.user.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.dataSource.query(
        `UPDATE to_kyc_identity_versions SET citizenship = 'PL' WHERE user_id = $1`,
        [b.user.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.dataSource.query(`DELETE FROM to_kyc_identities WHERE user_id = $1`, [b.user.id]),
    ).rejects.toThrow(/retained/);

    // The approval ends: the register still names the person, each order as it was made.
    await ctx.agent
      .post(`/api/v1/admin/users/${b.user.id}/kyc/override`)
      .set(await headers(anna))
      .send({ status: "expired", reason: "renewal lapsed" })
      .expect(200);
    const rows = await exportRows();
    expect(rows.get(first.id)).toMatchObject({
      kyc_name_lat: "Kavaliova Anna",
      kyc_birth_date: "1990-04-05",
    });
    expect(rows.get(second.id)).toMatchObject({ kyc_name_lat: "Shauchenka Anna" });
  });

  it("C15: an order whose account has no stored identity at all fails the export (409 naming the account), never blank cells", async () => {
    const b = await person("no-identity", {
      firstName: "Ivan",
      lastName: "Sidarau",
      dob: "1985-01-01",
    });
    await k.bought(b, "10", "card-no-identity");
    // As if the identity was never stored (approved before identities were kept), and KYC since ended.
    await forget(b.user.id);
    await ctx.dataSource.query(`UPDATE to_users SET kyc_status = 'none' WHERE id = $1`, [
      b.user.id,
    ]);
    const refused = bodyOf<ErrorBody>(
      await ctx.agent
        .post("/api/v1/admin/ramp/operations/export")
        .set(await headers(erin))
        .send({
          from: new Date(Date.now() - 86_400_000).toISOString(),
          to: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(409),
    );
    expect(refused).toMatchObject({
      error: "kyc_identity_unavailable",
      details: { userId: b.user.id },
    });
  });
});

describe("review finding C44: an account whose identity cannot be read does not loop the full re-screen", () => {
  it("C44: its parties are still screened, the failure is recorded on the account, the run is done (not retried hourly) and the account stays refused", async () => {
    const ok = await k.buyer("readable");
    const lost = await k.buyer("unreadable");
    // Approved under the other provider, nothing stored: every read fails for good.
    await forget(lost.user.id);
    await ctx.dataSource.query(`UPDATE to_users SET kyc_provider = 'sumsub' WHERE id = $1`, [
      lost.user.id,
    ]);
    const imported = await importList("by_terror", "2026-10-20", [`person,Петров Иван,1980,`]);
    expect(imported.run).toMatchObject({ status: "done", failures: 0, unreadable: 1 });
    const [subject] = await ctx.dataSource.query<
      { identity: boolean; error: string | null; parties: string[] }[]
    >(
      `SELECT identity, identity_error AS error, party_ids AS parties FROM to_screening_subjects WHERE user_id = $1`,
      [lost.user.id],
    );
    expect(subject).toMatchObject({ identity: false, parties: [lost.wallet.partyId] });
    expect(subject.error).toMatch(/cannot be read/);
    // Not due again an hour later (the run covered every readable account).
    expect(
      await ctx.get(ComplianceScreeningService).rescreenIfDue(new Date(Date.now() + 2 * 3_600_000)),
    ).toBeNull();
    // Fail closed for the unreadable account; the readable one is unaffected.
    expect((await overview(lost)).eligibility.onramp.allowed).toBe(false);
    expect((await overview(ok)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    expect(k.checkOf(await k.reconciliation(), "screening_stale").detail).toMatch(
      /identity cannot be read/,
    );
  });
});
