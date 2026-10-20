/**
 * Compliance end to end (SPEC §11; S7a) with RAMP_COMPLIANCE=on and four-eyes on (decisions are
 * not signed here — approvals.e2e-spec covers signatures). Operators are PERSONS with roles: Amy
 * (aml) decides alerts, Bob (approver) is the second person a block alert needs, Olga only runs
 * the ramp (ops), Root holds every role for the kit's reads. TM-ROUNDTRIP is lowered to 1 BV (45
 * BYN) so one small on-ramp then a cash-out fires it. Every money scenario asserts the order
 * status, its journal and token commands, then the §5 identities.
 */
import { randomUUID } from "node:crypto";

import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { ComplianceAlertEntity } from "../src/entities/compliance-alert.entity";
import { KycIdentityEntity } from "../src/entities/kyc-identity.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { RampConsentEntity } from "../src/entities/ramp-consent.entity";
import { ComplianceAlertsService } from "../src/services/compliance-alerts.service";
import { KycIdentityPort, kycIdentityAad, latinName } from "../src/services/kyc-identity.port";
import { KycIdentityService } from "../src/services/kyc-identity.service";
import { KycProviderMockService } from "../src/services/kyc-provider-mock.service";
import { PayoutService } from "../src/services/payout.service";
import { ComplianceRulesService } from "../src/services/compliance-rules.service";
import { RampCompliancePort } from "../src/services/ramp-compliance.port";
import {
  consentPepAad,
  consentPrincipalAad,
  RampConsentService,
} from "../src/services/ramp-consent.service";
import { rampCommandId } from "../src/services/ramp-fulfilment.service";
import { SealedDataService } from "../src/services/sealed-data.service";
import type {
  ApiApproval,
  ApiComplianceAlert,
  ApiRampOfframpResult,
  ApiRampOrder,
  ApiRampOverview,
} from "../src/types";
import { minskDate } from "../src/util/by-calendar";
import { ApiError, type ErrorBody } from "../src/util/errors";
import { parseAmount } from "../src/util/money";
import { TEST_COLLATERAL, useTestApp } from "./helpers/app";
import { type Buyer, dec, nextKey, rampKit } from "./helpers/ramp";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const root = makeTestWallet("c-root");
const amy = makeTestWallet("c-amy");
const bob = makeTestWallet("c-bob");
const olga = makeTestWallet("c-olga");
const TERMS = "2026-10-01";

const ctx = useTestApp({
  env: {
    ADMIN_OPERATORS: [
      `${root.partyId}#root@ops+approver+aml+export`,
      `${amy.partyId}#amy@aml`,
      `${bob.partyId}#bob@approver`,
      `${olga.partyId}#olga@ops`,
    ].join(","),
    RAMP_DUAL_CONTROL: "true",
    RAMP_APPROVAL_SIGNATURES: "false",
    RAMP_COMPLIANCE: "on",
    RAMP_TM_RULES_VERSION: "pvk-e2e-1",
    RAMP_TM_ROUNDTRIP_BV: "1",
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
    RAMP_METHODS: "card,erip",
    RAMP_OPERATOR_NAME: "TruthOracle LLC",
    RAMP_OPERATOR_UNP: "193456789",
    RAMP_OPERATOR_HTP_REF: "HTP-2026-0042",
    RAMP_TERMS_VERSION: TERMS,
    RAMP_TERMS_URL: "https://truthoracle.example/terms/ramp",
  },
});
const k = rampKit(ctx, root);

beforeEach(() => {
  k.mock().reset();
});
afterEach(() => {
  jest.restoreAllMocks();
});

let seq = 0;

async function adminAs(w: TestWallet): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, w, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

/** A KYC'd account whose mock applicant carries `identity` (and `person` overrides). */
async function buyerWith(
  hint: string,
  opts: { person?: Record<string, string>; identity?: Record<string, unknown> } = {},
): Promise<Buyer> {
  const wallet = makeTestWallet(hint);
  const { user, cookie } = await issueSessionDirect(ctx, wallet);
  const headers = { Cookie: cookie, ...ctx.csrf };
  const started = bodyOf<{ verificationId: string }>(
    await ctx.agent.post("/api/v1/kyc/sessions").set(headers).send({}).expect(200),
  );
  const n = String(2_000_000 + (seq += 1));
  await ctx.agent
    .post("/api/v1/kyc/mock/submit")
    .set(headers)
    .send({
      verificationId: started.verificationId,
      outcome: "approved",
      person: {
        firstName: `First${n}`,
        lastName: `Last${n}`,
        dob: "1990-01-01",
        country: "BLR",
        ...opts.person,
      },
      documents: [{ docType: "ID_CARD", country: "BLR", number: `KH${n}` }],
      ...(opts.identity ? { identity: opts.identity } : {}),
    })
    .expect(200);
  return { wallet, user, cookie, headers };
}

async function overview(b: Buyer): Promise<ApiRampOverview> {
  return bodyOf<ApiRampOverview>(await ctx.agent.get("/api/v1/ramp").set(b.headers).expect(200));
}

async function consent(
  b: Buyer,
  body: Record<string, unknown> = {},
  status = 200,
): Promise<Record<string, unknown>> {
  return bodyOf<Record<string, unknown>>(
    await ctx.agent
      .post("/api/v1/ramp/consent")
      .set(b.headers)
      .set("User-Agent", "e2e-agent/1.0")
      .send({ termsVersion: TERMS, actsForSelf: true, pepDeclared: false, ...body })
      .expect(status),
  );
}

/** A consented account (the default kit buyer: adult, Belarusian, resident). */
async function customer(hint: string): Promise<Buyer> {
  const b = await k.buyer(hint);
  await consent(b);
  return b;
}

async function alertsOf(userId: string): Promise<ApiComplianceAlert[]> {
  return bodyOf<{ items: ApiComplianceAlert[] }>(
    await ctx.agent
      .get(`/api/v1/admin/compliance/alerts?userId=${userId}`)
      .set(await adminAs(amy))
      .expect(200),
  ).items;
}

function decide(
  w: TestWallet,
  alertId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return adminAs(w).then((h) =>
    ctx.agent
      .post(`/api/v1/admin/compliance/alerts/${alertId}/decide`)
      .set(h)
      .send({ reason: `decided by ${w.partyId.split("::")[0]}`, ...body }),
  );
}

async function onramp(b: Buyer, amount: string): Promise<{ status: number; body: unknown }> {
  return ctx.agent
    .post("/api/v1/ramp/onramp")
    .set(b.headers)
    .set("Idempotency-Key", nextKey())
    .send({ amount, method: "card" });
}

async function orderApi(b: Buyer, id: string): Promise<ApiRampOrder> {
  return bodyOf<{ order: ApiRampOrder }>(
    await ctx.agent.get(`/api/v1/ramp/orders/${id}`).set(b.headers).expect(200),
  ).order;
}

const reasonsOf = (res: { body: unknown }): unknown => (res.body as ErrorBody).details?.reasons;

describe("identity (SPEC §11.1, M2, M11)", () => {
  it("is stored sealed on KYC approval: every name form, the art.8 data, alpha-2 countries, the refresh due by risk", async () => {
    const b = await buyerWith("id-full", {
      person: { firstName: "SIARHEI", lastName: "IVANOU", dob: "1990-05-17" },
      identity: {
        names: [
          { firstName: "Сяргей", lastName: "Іваноў", middleName: "Мікалаевіч" },
          { firstName: "Сергей", lastName: "Иванов", middleName: "Николаевич" },
          { firstName: "SIARHEI", lastName: "IVANOU" },
        ],
        birthPlace: "Minsk",
        residenceCountry: "BLR",
        addressLine: "Nezavisimosti 4-12, Minsk",
        personalNumber: "3170590A001PB1",
        docIssuedAt: "2021-03-01",
        docExpiresAt: "2031-03-01",
      },
    });
    const row = await ctx.dataSource
      .getRepository(KycIdentityEntity)
      .findOneByOrFail({ userId: b.user.id });
    expect(row).toMatchObject({
      provider: "mock",
      applicantId: `mock-${b.user.id}`,
      citizenship: "BY",
      residenceCountry: "BY",
      docExpiresAt: "2031-03-01",
      riskLevel: "low",
      vendorPep: null,
      vendorSanctions: null,
      vendorAdverseMedia: null,
    });
    expect(row.identitySealed).toMatch(/^v2\./);
    expect(row.verifiedAt).not.toBeNull();
    const due = new Date(row.verifiedAt as Date);
    due.setUTCFullYear(due.getUTCFullYear() + 3);
    expect(row.refreshDueAt?.toISOString()).toBe(due.toISOString());
    // Sealed to the account: it opens with its own AAD only.
    const sealed = ctx.get(SealedDataService);
    const data = JSON.parse(sealed.unseal(row.identitySealed, kycIdentityAad(b.user.id))) as Record<
      string,
      unknown
    >;
    expect(data).toMatchObject({
      birthDate: "1990-05-17",
      birthPlace: "Minsk",
      citizenship: "BY",
      address: { country: "BY", line: "Nezavisimosti 4-12, Minsk" },
      doc: {
        type: "ID_CARD",
        country: "BY",
        personalNumber: "3170590A001PB1",
        expiresAt: "2031-03-01",
      },
    });
    expect(() => sealed.unseal(row.identitySealed, kycIdentityAad(randomUUID()))).toThrow();
    const id = await ctx.get(KycIdentityPort).get(b.user.id);
    expect(id?.names.map((n) => [n.script, n.last])).toEqual([
      ["be", "Іваноў"],
      ["ru", "Иванов"],
      ["lat", "IVANOU"],
    ]);
    expect(latinName(id)).toMatchObject({ last: "IVANOU", first: "SIARHEI" });
    // Audited without personal data.
    const [audit] = await ctx.dataSource
      .getRepository(AuditEventEntity)
      .find({ where: { action: "kyc.identity_refreshed", subjectId: b.user.id } });
    expect(audit.metadata).toMatchObject({ forms: 3, risk: "low" });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/IVANOU|Іваноў|3170590A001PB1/);
  });

  it("a vendor sanctions flag raises TM-SANCTIONS (block, due today) and refuses the account; a vendor PEP flag raises TM-PEP", async () => {
    const b = await buyerWith("id-sanctioned", {
      identity: { aml: { sanctions: true, pep: true } },
    });
    await consent(b);
    expect(
      await ctx.dataSource.getRepository(KycIdentityEntity).findOneByOrFail({ userId: b.user.id }),
    ).toMatchObject({
      vendorSanctions: true,
      vendorPep: true,
      vendorAdverseMedia: null,
      riskLevel: "high",
    });
    const alerts = await alertsOf(b.user.id);
    expect(alerts.map((a) => [a.rule, a.severity, a.point, a.status]).sort()).toEqual([
      ["TM-PEP", "block", "identity", "open"],
      ["TM-SANCTIONS", "block", "identity", "open"],
    ]);
    expect(new Date(alerts[0].dueAt as string).getTime()).toBeGreaterThan(Date.now());
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    const refused = await onramp(b, "20");
    expect(refused.status).toBe(403);
    expect(reasonsOf(refused)).toEqual(["compliance"]);
  });

  it("fails closed when the provider cannot be read: a stale identity refuses (neutral), the port throws; it refreshes once the provider is back", async () => {
    const b = await customer("id-down");
    expect((await overview(b)).eligibility.onramp.allowed).toBe(true);
    await ctx.dataSource.query(
      `UPDATE to_kyc_identities SET refreshed_at = now() - interval '31 days' WHERE user_id = $1`,
      [b.user.id],
    );
    const spy = jest
      .spyOn(ctx.get(KycProviderMockService), "fetchApplicant")
      .mockRejectedValue(new ApiError(502, "upstream_failed", "provider down"));
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    const refused = await onramp(b, "20");
    expect(refused.status).toBe(403);
    expect(reasonsOf(refused)).toEqual(["compliance"]);
    await expect(ctx.get(KycIdentityPort).get(b.user.id)).rejects.toMatchObject({
      code: "kyc_identity_unavailable",
    });
    spy.mockRestore();
    expect((await overview(b)).eligibility.onramp.allowed).toBe(true);
    const row = await ctx.dataSource
      .getRepository(KycIdentityEntity)
      .findOneByOrFail({ userId: b.user.id });
    expect(Date.now() - row.refreshedAt.getTime()).toBeLessThan(60_000);
  });
});

describe("consent (SPEC §11.2, B4)", () => {
  it("is required until given for the current terms; append-only with IP and user agent; the order stores it", async () => {
    const b = await k.buyer("consent-1");
    const before = await overview(b);
    expect(before.consent).toEqual({
      required: true,
      termsVersion: TERMS,
      termsUrl: "https://truthoracle.example/terms/ramp",
    });
    expect(before.eligibility.onramp).toEqual({ allowed: false, reasons: ["consent_required"] });
    const refused = await onramp(b, "20");
    expect(refused.status).toBe(403);
    expect(reasonsOf(refused)).toEqual(["consent_required"]);

    // Stale terms and a principal while acting for oneself are refused.
    await consent(b, { termsVersion: "2025-01-01" }, 400);
    await consent(b, { principal: "my brother" }, 400);
    await consent(b, { pepDetail: "nothing" }, 400);
    expect(await consent(b)).toEqual({ consent: { required: false, termsVersion: TERMS } });
    const after = await overview(b);
    expect(after.consent.required).toBe(false);
    expect(after.eligibility.onramp).toEqual({ allowed: true, reasons: [] });

    const rows = await ctx.dataSource
      .getRepository(RampConsentEntity)
      .find({ where: { userId: b.user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      termsVersion: TERMS,
      actsForSelf: true,
      principalSealed: null,
      pepDeclared: false,
      pepDetailSealed: null,
      userAgent: "e2e-agent/1.0",
    });
    expect(rows[0].ip).toBeTruthy();
    const res = await k.openOnramp(b, "20");
    expect((await k.order(res.order.id)).consentId).toBe(rows[0].id);

    // Append-only: the trigger refuses edits and deletes.
    await expect(
      ctx.dataSource.query(`UPDATE to_ramp_consents SET pep_declared = true WHERE id = $1`, [
        rows[0].id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.dataSource.query(`DELETE FROM to_ramp_consents WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/append-only/);
  });

  it("a PEP declaration refuses the account and raises TM-PEP (block, due today); a block alert needs four eyes — aml asks, another person approves — then the account is eligible", async () => {
    const b = await k.buyer("consent-pep");
    await consent(b, {
      pepDeclared: true,
      pepDetail: "Deputy head of a district executive committee",
    });
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    expect(reasonsOf(await onramp(b, "20"))).toEqual(["compliance"]);

    const [alert] = await alertsOf(b.user.id);
    expect(alert).toMatchObject({
      rule: "TM-PEP",
      severity: "block",
      point: "consent",
      status: "open",
      orderId: null,
      rulesVersion: "pvk-e2e-1",
      bvByn: dec("45"),
    });
    // Due at 23:59:59 Minsk of today's (or the next) business day.
    expect(alert.dueAt).toMatch(/T20:59:59\.000Z$/);
    const [row] = await ctx.dataSource
      .getRepository(RampConsentEntity)
      .find({ where: { userId: b.user.id } });
    // C13: one window per declaration (its consent), so a changed declaration is reviewed again.
    expect(alert.windowKey).toBe(`pep:${row.id}`);
    const sealed = ctx.get(SealedDataService);
    expect(sealed.unseal(row.pepDetailSealed as string, consentPepAad(b.user.id, row.id))).toBe(
      "Deputy head of a district executive committee",
    );
    expect(() =>
      sealed.unseal(row.pepDetailSealed as string, consentPrincipalAad(b.user.id, row.id)),
    ).toThrow();

    // Ops cannot decide; aml asks (pending: a block alert); aml cannot approve its own; bob approves.
    const ops = await decide(olga, alert.id, { decision: "clear" });
    expect(ops.status).toBe(403);
    expect((ops.body as unknown as ErrorBody).error).toBe("role_required");
    const asked = await decide(amy, alert.id, { decision: "clear" });
    expect(asked.status).toBe(202);
    const approval = (asked.body as { approval: ApiApproval }).approval;
    expect(approval).toMatchObject({ action: "compliance.alert.decide", status: "pending" });
    const self = await ctx.agent
      .post(`/api/v1/admin/approvals/${approval.id}/approve`)
      .set(await adminAs(amy))
      .send({ reason: "my own" });
    expect([self.status, (self.body as ErrorBody).error]).toEqual([403, "approval_self"]);
    const approved = bodyOf<{ approval: ApiApproval; result: { alert: ApiComplianceAlert } }>(
      await ctx.agent
        .post(`/api/v1/admin/approvals/${approval.id}/approve`)
        .set(await adminAs(bob))
        .send({ reason: "senior approval of the PEP relationship on file" })
        .expect(200),
    );
    expect(approved.approval.status).toBe("executed");
    expect(approved.result.alert).toMatchObject({
      status: "cleared",
      decisionReason: "decided by c-amy",
    });
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    const [decided] = await ctx.dataSource
      .getRepository(AuditEventEntity)
      .find({ where: { action: "compliance.alert_decided", subjectId: alert.id } });
    expect(decided.metadata).toMatchObject({
      decision: "clear",
      from: "open",
      to: "cleared",
      rule: "TM-PEP",
      operatorPerson: "bob",
    });
    // A cleared alert is final.
    expect((await decide(amy, alert.id, { decision: "report", reportRef: "SF-1" })).status).toBe(
      409,
    );
  });

  it("acting for another person raises TM-PRINCIPAL and refuses; the principal is sealed to the consent", async () => {
    const b = await k.buyer("consent-principal");
    await consent(b, { actsForSelf: false }, 400);
    await consent(b, { actsForSelf: false, principal: "Petrov Petr, father" });
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    const alerts = await alertsOf(b.user.id);
    const [row] = await ctx.dataSource
      .getRepository(RampConsentEntity)
      .find({ where: { userId: b.user.id } });
    expect(alerts.map((a) => [a.rule, a.severity, a.windowKey])).toEqual([
      ["TM-PRINCIPAL", "block", `principal:${row.id}`],
    ]);
    expect(
      ctx
        .get(SealedDataService)
        .unseal(row.principalSealed as string, consentPrincipalAad(b.user.id, row.id)),
    ).toBe("Petrov Petr, father");
    // R2b-7: a second declaration waits for AML's decision on the first (one undecided alert per
    // rule and account); a consent without a declaration is still recorded.
    expect(await consent(b, { actsForSelf: false, principal: "Petrov Petr" }, 429)).toMatchObject({
      error: "rate_limited",
      details: { scope: "ramp_consent_declaration" },
    });
    expect(
      await ctx.dataSource.getRepository(RampConsentEntity).count({ where: { userId: b.user.id } }),
    ).toBe(1);
    expect((await alertsOf(b.user.id)).map((a) => a.rule)).toEqual(["TM-PRINCIPAL"]);
  });

  it("R2b-7: a declaration needs an approved KYC and waits while the account's last one of its kind is undecided; consents without one are unaffected", async () => {
    const anon = makeTestWallet("consent-no-kyc");
    const { user, cookie } = await issueSessionDirect(ctx, anon);
    const noKyc: Buyer = { wallet: anon, user, cookie, headers: { Cookie: cookie, ...ctx.csrf } };
    for (const body of [
      { actsForSelf: false, principal: "Petrov Petr" },
      { pepDeclared: true, pepDetail: "a city council member" },
    ])
      expect(await consent(noKyc, body, 409)).toMatchObject({ error: "kyc_required" });
    await consent(noKyc);
    const b = await k.buyer("consent-one-open");
    await consent(b, { pepDeclared: true });
    await consent(b, { actsForSelf: false, principal: "Petrov Petr" });
    for (const body of [
      { pepDeclared: true, pepDetail: "MP" },
      { actsForSelf: false, principal: "Sidorov Ivan" },
    ])
      expect(await consent(b, body, 429)).toMatchObject({ error: "rate_limited" });
    expect(
      (await alertsOf(b.user.id))
        .map((a) => [a.rule, a.status])
        .sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    ).toEqual([
      ["TM-PEP", "open"],
      ["TM-PRINCIPAL", "open"],
    ]);
  });

  it("C13: a new principal after TM-PRINCIPAL was cleared is reviewed again (refused, a new alert); only AML opens the declaration behind an alert, audited", async () => {
    const b = await k.buyer("consent-renewed");
    await consent(b, { actsForSelf: false, principal: "Petrov Petr, father" });
    const [first] = await alertsOf(b.user.id);
    expect(first).toMatchObject({ rule: "TM-PRINCIPAL", severity: "block", status: "open" });
    const url = `/api/v1/admin/compliance/alerts/${first.id}/declaration`;
    await ctx.agent
      .get(url)
      .set(await adminAs(olga))
      .expect(403);
    const opened = await ctx.agent
      .get(url)
      .set(await adminAs(amy))
      .expect(200);
    expect(opened.headers["cache-control"]).toBe("no-store");
    expect(bodyOf<{ declaration: Record<string, unknown> }>(opened).declaration).toMatchObject({
      rule: "TM-PRINCIPAL",
      termsVersion: TERMS,
      actsForSelf: false,
      principal: "Petrov Petr, father",
    });
    const [viewed] = await ctx.dataSource
      .getRepository(AuditEventEntity)
      .find({ where: { action: "compliance.consent_unsealed" } });
    expect(viewed.metadata).toMatchObject({ alertId: first.id, operatorPerson: "amy" });
    expect(JSON.stringify(viewed.metadata)).not.toMatch(/Petrov/);
    // Four eyes clear it: the account is eligible.
    const asked = await decide(amy, first.id, { decision: "clear" });
    expect(asked.status).toBe(202);
    await ctx.agent
      .post(
        `/api/v1/admin/approvals/${(asked.body as { approval: ApiApproval }).approval.id}/approve`,
      )
      .set(await adminAs(bob))
      .send({ reason: "the principal checked" })
      .expect(200);
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
    // A new principal under the same terms: refused again until AML decides the new alert.
    await consent(b, { actsForSelf: false, principal: "Sidorov Ivan" });
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    const open = (await alertsOf(b.user.id)).filter((a) => a.status === "open");
    expect(open.map((a) => a.rule)).toEqual(["TM-PRINCIPAL"]);
    expect(open[0].id).not.toBe(first.id);
    expect(
      bodyOf<{ declaration: Record<string, unknown> }>(
        await ctx.agent
          .get(`/api/v1/admin/compliance/alerts/${open[0].id}/declaration`)
          .set(await adminAs(amy))
          .expect(200),
      ).declaration,
    ).toMatchObject({ principal: "Sidorov Ivan" });
  });
});

describe("eligibility (SPEC §11.3)", () => {
  it("refuses an under-18 and a non-resident with the neutral reason; an adult resident is allowed", async () => {
    const today = minskDate(new Date());
    const seventeen = `${Number(today.slice(0, 4)) - 17}${today.slice(4)}`;
    const minor = await buyerWith("elig-minor", { person: { dob: seventeen } });
    await consent(minor);
    expect((await overview(minor)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["compliance"],
    });
    expect(reasonsOf(await onramp(minor, "20"))).toEqual(["compliance"]);

    const abroad = await buyerWith("elig-abroad", { identity: { residenceCountry: "LTU" } });
    await consent(abroad);
    expect((await overview(abroad)).eligibility.offramp.reasons).toContain("compliance");
    expect(reasonsOf(await onramp(abroad, "20"))).toEqual(["compliance"]);

    const adult = await buyerWith("elig-adult", {
      person: { dob: `${Number(today.slice(0, 4)) - 18}${today.slice(4)}` },
    });
    await consent(adult);
    expect((await overview(adult)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
  });

  it("an expired identity document asks for additional information (the one distinct compliance reason)", async () => {
    const b = await buyerWith("elig-expired", { identity: { docExpiresAt: "2026-01-31" } });
    await consent(b);
    expect((await overview(b)).eligibility.onramp).toEqual({
      allowed: false,
      reasons: ["additional_info_required"],
    });
  });
});

describe("monitoring rules hold the value; the AML decision releases it (SPEC §11.4, §11.5, I10)", () => {
  const markPaids = (orderId: string): number =>
    ctx.wallet.submits.filter((s) => {
      const json = JSON.stringify(s.commands);
      return json.includes('"choice":"MarkPaid"') && json.includes(`"txHash":"ramp:${orderId}"`);
    }).length;

  async function cashOutHeld(
    b: Buyer,
    cardId: string,
    amount: string,
  ): Promise<{ id: string; cid: string }> {
    const created = await ctx.agent
      .post("/api/v1/ramp/offramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount, destination: { kind: "card", paymentMethodId: cardId } })
      .expect(200);
    const id = (created.body as ApiRampOfframpResult).order.id;
    expect((await k.order(id)).risk).toMatchObject({
      "offramp.create": { decision: "review", rules: ["TM-ROUNDTRIP"] },
    });
    const cid = k.signWithdraw(b, amount);
    await ctx.agent
      .post(`/api/v1/ramp/orders/${id}/attach`)
      .set(b.headers)
      .send({ pendingPayoutCid: cid })
      .expect(200);
    await k.drive();
    // The PendingPayout stays live; MarkPaid is deferred with a neutral payout status.
    expect(await k.order(id)).toMatchObject({
      status: "withdrawing",
      burnCommandId: null,
      details: { hold: { reason: "compliance" } },
    });
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({ status: "blocked_compliance" });
    expect(markPaids(id)).toBe(0);
    expect(await orderApi(b, id)).toMatchObject({
      status: "withdrawing",
      statusText: "processing",
      reviewStep: null,
    });
    return { id, cid };
  }

  it("TM-ROUNDTRIP: a cash-out after an untraded on-ramp is created, its MarkPaid held (the user may cancel); clearing its alert releases the next one, which completes", async () => {
    const b = await customer("roundtrip");
    await k.bought(b, "100", "card-rt");
    const card = await k.payoutCard(b);

    const first = await cashOutHeld(b, card.id, "40");
    const [alert1] = (await alertsOf(b.user.id)).filter((a) => a.orderId === first.id);
    expect(alert1).toMatchObject({
      rule: "TM-ROUNDTRIP",
      severity: "review",
      point: "offramp.create",
      status: "open",
      figures: { onramps: dec("100"), trading: dec("0"), thresholdBv: 1, threshold: dec("45") },
    });
    // A series: due 9 business days after the analysis month.
    expect(new Date(alert1.dueAt as string).getTime()).toBeGreaterThan(Date.now() + 9 * 86_400_000);
    // The user cancels the held cash-out: T back in the wallet, nothing burned or paid.
    k.cancelPayout(b, first.cid);
    await k.drive();
    expect(await k.order(first.id)).toMatchObject({ status: "cancelled", burnCommandId: null });
    expect(await k.journal(first.id)).toEqual({});
    expect(await k.commands(first.id)).toEqual([]);

    const second = await cashOutHeld(b, card.id, "40");
    const [alert2] = (await alertsOf(b.user.id)).filter((a) => a.orderId === second.id);
    // A review alert is decided by one aml person at once (200 executed).
    const cleared = await decide(amy, alert2.id, { decision: "clear" });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({
      approval: { status: "executed", singleControl: true },
      result: { alert: { status: "cleared" } },
    });
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(markPaids(second.id)).toBe(1);
    expect(await k.order(second.id)).toMatchObject({
      status: "completed",
      risk: {
        "offramp.create": { decision: "review", rules: ["TM-ROUNDTRIP"], alertIds: [alert2.id] },
        "offramp.payout": { decision: "allow" },
      },
    });
    expect(await k.journal(second.id)).toEqual({
      "offramp.burned:customer_liability": dec("40"),
      "offramp.burned:payout_clearing": dec("-40"),
      "offramp.paid_card:payout_clearing": dec("40"),
      "offramp.paid_card:provider_clearing": dec("-40"),
    });
    expect(await k.commands(second.id)).toMatchObject([
      { commandId: rampCommandId("burn", second.id), status: "recorded" },
    ]);
    // The first cash-out's alert is still the officer's to decide (nothing else changed).
    expect((await alertsOf(b.user.id)).find((a) => a.id === alert1.id)?.status).toBe("open");
    await k.expectIdentities();
  });

  it("TM-CASH: an ERIP cash payment stops at capture in needs_review(compliance) — money in, nothing minted; clearing it mints and completes", async () => {
    const b = await customer("cash");
    const res = await k.openOnramp(b, "50", nextKey(), "erip");
    await k.pay(b, res, "succeeded", { channel: "cash" });
    await k.drive();
    const id = res.order.id;
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      mintCommandId: null,
      risk: { "onramp.capture": { decision: "review", rules: ["payer_unverified", "TM-CASH"] } },
      details: { complianceHold: { point: "onramp.capture" } },
    });
    expect(await orderApi(b, id)).toMatchObject({ statusText: "processing", reviewStep: null });
    expect(await k.journal(id)).toEqual({
      "onramp.captured:provider_clearing": dec("50"),
      "onramp.captured:issuance_pending": dec("-50"),
      "psp.fee_accrued:psp_fees": dec("0.6"),
      "psp.fee_accrued:provider_clearing": dec("-0.6"),
    });
    expect(await k.commands(id)).toEqual([]);
    const alerts = (await alertsOf(b.user.id)).filter((a) => a.orderId === id);
    expect(alerts.map((a) => [a.rule, a.severity]).sort()).toEqual([
      ["TM-CASH", "review"],
      ["payer_unverified", "info"],
    ]);
    // Not released by the scan while the review alert is open; the info alert never holds.
    await k.drive();
    expect((await k.order(id)).status).toBe("needs_review");

    const cash = alerts.find((a) => a.rule === "TM-CASH") as ApiComplianceAlert;
    expect((await decide(amy, cash.id, { decision: "clear" })).status).toBe(200);
    await k.drive();
    expect(await k.order(id)).toMatchObject({
      status: "completed",
      details: { complianceHold: null },
    });
    expect(await k.journal(id)).toEqual({
      "onramp.captured:provider_clearing": dec("50"),
      "onramp.captured:issuance_pending": dec("-50"),
      "psp.fee_accrued:psp_fees": dec("0.6"),
      "psp.fee_accrued:provider_clearing": dec("-0.6"),
      "onramp.minted:issuance_pending": dec("50"),
      "onramp.minted:customer_liability": dec("-50"),
    });
    expect(await k.commands(id)).toMatchObject([
      { commandId: rampCommandId("mint", id), status: "recorded" },
    ]);
    await k.expectIdentities();
  });

  it("TM-THIRDPARTY: an ERIP payer named by the bank unlike every verified form (≥ 20 BV) is held; the same person in another form (ru Cyrillic vs Latin / be) is not", async () => {
    const b = await buyerWith("thirdparty", {
      person: { firstName: "SIARHEI", lastName: "IVANOU" },
      identity: {
        names: [
          { firstName: "Сяргей", lastName: "Іваноў" },
          { firstName: "Сергей", lastName: "Иванов" },
          { firstName: "SIARHEI", lastName: "IVANOU" },
        ],
      },
    });
    await consent(b);
    const own = await k.openOnramp(b, "900", nextKey(), "erip");
    await k.pay(b, own, "succeeded", {
      channel: "online",
      payerName: "Иванов Сергей Николаевич",
      payerNameSource: "bank",
    });
    await k.drive();
    expect(await k.order(own.order.id)).toMatchObject({
      status: "completed",
      risk: { "onramp.capture": { decision: "allow", rules: [] } },
    });
    const other = await k.openOnramp(b, "900", nextKey(), "erip");
    await k.pay(b, other, "succeeded", {
      channel: "online",
      payerName: "PETROV PAVEL",
      payerNameSource: "bank",
    });
    await k.drive();
    expect(await k.order(other.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      mintCommandId: null,
      risk: { "onramp.capture": { decision: "review", rules: ["TM-THIRDPARTY"] } },
    });
    const [alert] = (await alertsOf(b.user.id)).filter((a) => a.orderId === other.order.id);
    expect(alert).toMatchObject({
      rule: "TM-THIRDPARTY",
      severity: "review",
      figures: { amount: dec("900"), thresholdBv: 20, threshold: dec("900"), forms: 3 },
    });
    // The payer's name never reaches an alert.
    expect(JSON.stringify(alert)).not.toMatch(/PETROV/);
    expect(await k.journal(other.order.id)).toMatchObject({
      "onramp.captured:provider_clearing": dec("900"),
    });
    expect(await k.commands(other.order.id)).toEqual([]);
    await k.expectIdentities();
  });

  it("TM-STRUCT: the third on-ramp in 24 h reaching 90 % of the daily max is created, and its capture holds the value", async () => {
    const b = await customer("struct");
    await k.bought(b, "1000", "card-s1");
    await k.bought(b, "1000", "card-s1");
    const third = await k.openOnramp(b, "700");
    expect(await k.order(third.order.id)).toMatchObject({
      status: "awaiting_payment",
      risk: { "onramp.create": { decision: "review", rules: ["TM-STRUCT"] } },
    });
    const [alert] = (await alertsOf(b.user.id)).filter((a) => a.orderId === third.order.id);
    expect(alert).toMatchObject({
      rule: "TM-STRUCT",
      point: "onramp.create",
      figures: { count: 3, sum: dec("2700"), dailyMax: dec("3000"), pct: 90 },
    });
    await k.pay(b, third, "succeeded", { cardSeed: "card-s1" });
    await k.drive();
    expect(await k.order(third.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      mintCommandId: null,
      risk: { "onramp.capture": { decision: "allow" } },
    });
    expect(await k.commands(third.order.id)).toEqual([]);
    expect((await decide(amy, alert.id, { decision: "clear" })).status).toBe(200);
    await k.drive();
    expect((await k.order(third.order.id)).status).toBe("completed");
    expect(await k.journal(third.order.id)).toMatchObject({
      "onramp.minted:customer_liability": dec("-700"),
    });
    await k.expectIdentities();
  });

  it("TM-AGE, TM-NETOUT and TM-CARDS read the account's own history (orders, distinct cards, in-app deposits)", async () => {
    const rules = ctx.get(ComplianceRulesService);
    const today = minskDate(new Date());
    const young = await buyerWith("age-young", {
      person: { dob: `${Number(today.slice(0, 4)) - 19}${today.slice(4)}` },
    });
    await consent(young);
    const base = {
      direction: "onramp" as const,
      method: "card" as const,
      rail: null,
      tokenAmount: 0n,
      currency: "BYN",
    };
    const ageCheck = await rules.check("onramp.create", {
      ...base,
      point: "onramp.create",
      userId: young.user.id,
      orderId: randomUUID(),
      fiatAmount: parseAmount("4500"),
      tokenAmount: parseAmount("4500"),
    });
    expect(ageCheck).toMatchObject({ decision: "review", rules: ["TM-AGE"] });

    const b = await customer("history");
    for (const seed of ["card-h1", "card-h2", "card-h3"]) await k.bought(b, "20", seed);
    // A fourth distinct card in 30 days.
    const cards = await rules.check("onramp.capture", {
      ...base,
      point: "onramp.capture",
      userId: b.user.id,
      orderId: randomUUID(),
      fiatAmount: parseAmount("20"),
      tokenAmount: parseAmount("20"),
      paymentMethodId: randomUUID(),
      payer: { name: null, nameSource: "checkout", channel: "card" },
    });
    expect(cards).toMatchObject({ decision: "review", rules: ["TM-CARDS"] });
    // 60 in by card; a 9 100 cash-out would be 9 040 out beyond it: net-out (> 200 BV = 9 000) …
    const out = await rules.check("offramp.create", {
      ...base,
      point: "offramp.create",
      direction: "offramp",
      method: null,
      rail: "card",
      userId: b.user.id,
      orderId: randomUUID(),
      fiatAmount: parseAmount("9100"),
      tokenAmount: parseAmount("9100"),
    });
    expect(out.rules).toEqual(["TM-ROUNDTRIP", "TM-NETOUT"]);
    // … unless deposits from outside the ramp explain it.
    await ctx.dataSource.query(
      `INSERT INTO to_wallet_entries (event_id, owner, wallet_cid, instrument_admin, instrument_id, kind, amount, tx_ref, "offset", node_id, update_id, effective_at)
       VALUES ('ev-dep-1', $1, 'uw-1', $2, $3, 'deposit', 100, 'reconcile:cmd-1', 1, 0, 'up-1', now())`,
      [b.wallet.partyId, TEST_COLLATERAL.admin, TEST_COLLATERAL.id],
    );
    const explained = await rules.check("offramp.create", {
      ...base,
      point: "offramp.create",
      direction: "offramp",
      method: null,
      rail: "card",
      userId: b.user.id,
      orderId: randomUUID(),
      fiatAmount: parseAmount("9100"),
      tokenAmount: parseAmount("9100"),
    });
    expect(explained.rules).toEqual(["TM-ROUNDTRIP"]);
  });

  it("an account that stops being eligible between create and capture (re-verification overdue) is held on TM-INELIGIBLE until AML decides", async () => {
    const b = await customer("ineligible");
    const res = await k.openOnramp(b, "40");
    await ctx.dataSource.query(
      `UPDATE to_kyc_identities SET refresh_due_at = now() - interval '1 day' WHERE user_id = $1`,
      [b.user.id],
    );
    await k.pay(b, res, "succeeded");
    await k.drive();
    const id = res.order.id;
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      mintCommandId: null,
      risk: { "onramp.capture": { decision: "deny", rules: ["TM-INELIGIBLE"] } },
    });
    const [alert] = (await alertsOf(b.user.id)).filter((a) => a.orderId === id);
    expect(alert).toMatchObject({
      rule: "TM-INELIGIBLE",
      severity: "review",
      figures: { reasons: ["kyc_refresh_required"] },
    });
    // The user is asked for additional information; new orders wait for it.
    expect((await overview(b)).eligibility.onramp.reasons).toEqual(["additional_info_required"]);
    expect((await decide(amy, alert.id, { decision: "clear" })).status).toBe(200);
    await k.drive();
    expect((await k.order(id)).status).toBe("completed");
    expect(await k.commands(id)).toMatchObject([
      { commandId: rampCommandId("mint", id), status: "recorded" },
    ]);
    await k.expectIdentities();
  });

  it("report keeps the hold (with the special-form number); escalate keeps it; clear after report releases", async () => {
    const b = await customer("report");
    const res = await k.openOnramp(b, "30", nextKey(), "erip");
    await k.pay(b, res, "succeeded", { channel: "unknown" });
    await k.drive();
    const id = res.order.id;
    const cash = (await alertsOf(b.user.id)).find(
      (a) => a.rule === "TM-CASH" && a.orderId === id,
    ) as ApiComplianceAlert;
    expect((await decide(amy, cash.id, { decision: "report" })).status).toBe(400);
    expect((await decide(amy, cash.id, { decision: "escalate" })).status).toBe(200);
    await k.drive();
    expect((await k.order(id)).status).toBe("needs_review");
    expect(
      (await decide(amy, cash.id, { decision: "report", reportRef: "SF-2026/0042" })).status,
    ).toBe(200);
    await k.drive();
    expect((await k.order(id)).status).toBe("needs_review");
    expect(
      await ctx.dataSource.getRepository(ComplianceAlertEntity).findOneByOrFail({ id: cash.id }),
    ).toMatchObject({ status: "reported", reportRef: "SF-2026/0042" });
    expect((await decide(amy, cash.id, { decision: "clear" })).status).toBe(200);
    await k.drive();
    expect((await k.order(id)).status).toBe("completed");
    await k.expectIdentities();
  });
});

describe("alerts for the AML officer (SPEC §11.6, §6.2)", () => {
  it("lists due-first with filters, shows one alert with its approvals, and exports a CSV for aml only (≤ 31 days, audited)", async () => {
    const pep = await k.buyer("adm-pep");
    await consent(pep, { pepDeclared: true });
    const principal = await k.buyer("adm-principal");
    await consent(principal, { actsForSelf: false, principal: '=HYPERLINK("x")' });
    const h = await adminAs(amy);
    const all = bodyOf<{ items: ApiComplianceAlert[]; nextCursor: null }>(
      await ctx.agent.get("/api/v1/admin/compliance/alerts?status=open").set(h).expect(200),
    );
    expect(all.items.map((a) => a.rule).sort()).toEqual(["TM-PEP", "TM-PRINCIPAL"]);
    expect(
      bodyOf<{ items: ApiComplianceAlert[] }>(
        await ctx.agent.get("/api/v1/admin/compliance/alerts?rule=TM-PEP").set(h).expect(200),
      ).items.map((a) => a.userId),
    ).toEqual([pep.user.id]);
    await ctx.agent.get("/api/v1/admin/compliance/alerts?status=closed").set(h).expect(400);
    const one = bodyOf<{ alert: ApiComplianceAlert; approvals: ApiApproval[] }>(
      await ctx.agent.get(`/api/v1/admin/compliance/alerts/${all.items[0].id}`).set(h).expect(200),
    );
    expect(one).toMatchObject({ alert: { id: all.items[0].id }, approvals: [] });

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    for (const w of [olga, bob]) {
      const refused = await ctx.agent
        .post("/api/v1/admin/compliance/alerts/export")
        .set(await adminAs(w))
        .send({ from, to });
      expect([refused.status, (refused.body as ErrorBody).error]).toEqual([403, "role_required"]);
    }
    const tooLong = await ctx.agent
      .post("/api/v1/admin/compliance/alerts/export")
      .set(h)
      .send({ from: "2026-01-01T00:00:00.000Z", to: "2026-02-15T00:00:00.000Z" });
    expect([tooLong.status, (tooLong.body as ErrorBody).error]).toEqual([400, "export_range"]);
    const file = await ctx.agent
      .post("/api/v1/admin/compliance/alerts/export")
      .set(h)
      .send({ from, to, status: "open" })
      .expect(200);
    expect(file.headers["content-type"]).toMatch(/^text\/csv/);
    expect(file.headers["content-disposition"]).toMatch(
      /^attachment; filename="compliance-alerts-.*\.csv"$/,
    );
    const lines = file.text.trim().split("\r\n");
    expect(lines[0]).toMatch(/^"alert_id","created_at_utc","user_id","rule",/);
    expect(lines).toHaveLength(3);
    expect(file.text).toContain('"TM-PRINCIPAL"');
    // The principal's free text is sealed, never exported; figures are formula-safe JSON.
    expect(file.text).not.toContain("HYPERLINK");
    const [audit] = await ctx.dataSource
      .getRepository(AuditEventEntity)
      .find({ where: { action: "compliance.alerts_exported" } });
    expect(audit).toMatchObject({
      subjectType: "compliance_export",
      subjectId: file.headers["x-export-id"],
      metadata: { rows: 2, status: "open", operatorPerson: "amy" },
    });
    // The admin_export limit (10 an hour per operator; the refused range counted too).
    for (let i = 0; i < 8; i += 1)
      await ctx.agent
        .post("/api/v1/admin/compliance/alerts/export")
        .set(h)
        .send({ from, to })
        .expect(200);
    const limited = await ctx.agent
      .post("/api/v1/admin/compliance/alerts/export")
      .set(h)
      .send({ from, to });
    expect([limited.status, (limited.body as ErrorBody).error]).toEqual([429, "rate_limited"]);
  });

  it("other stages raise through the port (S6 TM-SHAREDIBAN, S7b TM-LIST): catalogue severity and due date, deduplicated by window", async () => {
    const b = await k.buyer("adm-raise");
    const port = ctx.get(RampCompliancePort);
    const bankAccountId = randomUUID();
    const id = await port.raise("TM-SHAREDIBAN", b.user.id, { bankAccountId, otherAccounts: 1 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await port.raise("TM-SHAREDIBAN", b.user.id, { bankAccountId, otherAccounts: 1 }),
    ).toBeNull();
    const listed = await port.raise("TM-LIST", b.user.id, {
      hitId: randomUUID(),
      list: "by_terror",
    });
    // S7b names the severity: a foreign list's hit is a review (B1), still due the same business day.
    const foreign = await port.raise("TM-LIST", b.user.id, {
      severity: "review",
      hitId: randomUUID(),
      list: "foreign",
    });
    const alerts = await alertsOf(b.user.id);
    expect(alerts.find((a) => a.id === id)).toMatchObject({
      rule: "TM-SHAREDIBAN",
      severity: "review",
      point: "bank_account",
      windowKey: `bank-account:${bankAccountId}`,
      orderId: null,
    });
    expect(alerts.find((a) => a.id === listed)).toMatchObject({
      rule: "TM-LIST",
      severity: "block",
      point: "screening",
    });
    const foreignAlert = alerts.find((a) => a.id === foreign) as ApiComplianceAlert;
    expect(foreignAlert).toMatchObject({ rule: "TM-LIST", severity: "review" });
    expect(foreignAlert.dueAt).toBe(alerts.find((a) => a.id === listed)?.dueAt);
    // A list hit's hold is S7b's (the hit and its provisional freeze), not a second refusal here.
    await consent(b);
    expect((await overview(b)).eligibility.onramp).toEqual({ allowed: true, reasons: [] });
  });

  it("compliance_alerts_overdue: amber within 2 h of a due date, red past it (paged); cleared alerts do not count", async () => {
    const b = await k.buyer("adm-overdue");
    await consent(b, { pepDeclared: true });
    const [alert] = await alertsOf(b.user.id);
    const service = ctx.get(ComplianceAlertsService);
    await ctx.dataSource.query(
      `UPDATE to_compliance_alerts SET due_at = now() + interval '1 hour' WHERE id = $1`,
      [alert.id],
    );
    expect(await service.overdueCheck()).toMatchObject({
      status: "amber",
      figures: { overdue: 0, dueWithin2h: 1 },
    });
    await ctx.dataSource.query(
      `UPDATE to_compliance_alerts SET due_at = now() - interval '1 minute' WHERE id = $1`,
      [alert.id],
    );
    const rec = await k.reconciliation();
    expect(k.checkOf(rec, "compliance_alerts_overdue")).toMatchObject({ status: "red" });
    expect(k.checkOf(rec, "compliance_bv_table")).toMatchObject({ status: "green" });
    const overdue = bodyOf<{ items: ApiComplianceAlert[] }>(
      await ctx.agent
        .get("/api/v1/admin/compliance/alerts?due=overdue")
        .set(await adminAs(amy))
        .expect(200),
    );
    expect(overdue.items.map((a) => a.id)).toEqual([alert.id]);
    await ctx.dataSource.query(
      `UPDATE to_compliance_alerts SET status = 'cleared', decided_at = now() WHERE id = $1`,
      [alert.id],
    );
    expect((await service.overdueCheck()).status).toBe("green");
  });
});

describe("re-sealers (SPEC §8): identities and consent answers", () => {
  it("count per kid, move every value onto the active kid through the append-only trigger, and leave a value that does not open", async () => {
    const b = await k.buyer("reseal");
    await consent(b, {
      actsForSelf: false,
      principal: "Petrov Petr",
      pepDeclared: true,
      pepDetail: "MP",
    });
    const sealed = ctx.get(SealedDataService);
    const kid = sealed.dataKeyring.activeKid;
    const identities = ctx.get(KycIdentityService);
    const consents = ctx.get(RampConsentService);
    expect(await identities.countByKid()).toEqual({ [kid]: 1 });
    expect(await consents.countByKid()).toEqual({ [kid]: 2 });
    // As if another kid were active: every value is re-sealed (under the real active kid) by CAS.
    expect(await identities.resealBatch({ activeKid: "other", after: null, limit: 10 })).toEqual({
      changed: 1,
      failed: 0,
      last: null,
    });
    expect(await consents.resealBatch({ activeKid: "other", after: null, limit: 10 })).toEqual({
      changed: 1,
      failed: 0,
      last: null,
    });
    const [row] = await ctx.dataSource
      .getRepository(RampConsentEntity)
      .find({ where: { userId: b.user.id } });
    expect(consents.unsealed(row)).toEqual({ principal: "Petrov Petr", pepDetail: "MP" });
    expect((await ctx.get(KycIdentityPort).get(b.user.id))?.userId).toBe(b.user.id);
    // Nothing left on another kid: a pass with the real kid changes nothing.
    expect(await consents.resealBatch({ activeKid: kid, after: null, limit: 10 })).toEqual({
      changed: 0,
      failed: 0,
      last: null,
    });
    // A value that does not open is counted, logged and left as it is. Restored before the file
    // ends: a non-v2 value left behind makes the NEXT file's boot refuse (S3's keyring check).
    const [{ original }] = await ctx.dataSource.query<{ original: string }[]>(
      `SELECT pep_detail_sealed AS original FROM to_ramp_consents WHERE id = $1`,
      [row.id],
    );
    await ctx.dataSource.query(
      `UPDATE to_ramp_consents SET pep_detail_sealed = 'garbage' WHERE id = $1`,
      [row.id],
    );
    try {
      expect(await consents.countByKid()).toEqual({ [kid]: 1, "(not v2)": 1 });
      expect(await consents.resealBatch({ activeKid: kid, after: null, limit: 10 })).toEqual({
        changed: 0,
        failed: 1,
        last: null,
      });
    } finally {
      await ctx.dataSource.query(
        `UPDATE to_ramp_consents SET pep_detail_sealed = $2 WHERE id = $1`,
        [row.id, original],
      );
    }
    expect(await consents.countByKid()).toEqual({ [kid]: 2 });
  });
});

describe("review findings C26 / C28 / C25: who releases value, alerts only for real orders, a refused payment goes back", () => {
  const markPaids = (orderId: string): number =>
    ctx.wallet.submits.filter((s) => {
      const json = JSON.stringify(s.commands);
      return json.includes('"choice":"MarkPaid"') && json.includes(`"txHash":"ramp:${orderId}"`);
    }).length;

  async function approveAs(w: TestWallet, approvalId: string): Promise<void> {
    await ctx.agent
      .post(`/api/v1/admin/approvals/${approvalId}/approve`)
      .set(await adminAs(w))
      .send({ reason: "second person checked the file" })
      .expect(200);
  }

  it("C26: a PEP declared while a cash-out is open holds its MarkPaid on a BLOCK TM-INELIGIBLE: one aml person cannot release it; four eyes on it and on TM-PEP release it", async () => {
    const b = await customer("pep-in-flight");
    // Below TM-ROUNDTRIP's 1 BV (45 BYN) here: only the PEP declaration holds the cash-out.
    await k.bought(b, "40", "card-pep");
    const card = await k.payoutCard(b);
    const created = await ctx.agent
      .post("/api/v1/ramp/offramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount: "20", destination: { kind: "card", paymentMethodId: card.id } })
      .expect(200);
    const id = (created.body as ApiRampOfframpResult).order.id;
    await consent(b, { pepDeclared: true, pepDetail: "Member of a city council" });
    const cid = k.signWithdraw(b, "20");
    await ctx.agent
      .post(`/api/v1/ramp/orders/${id}/attach`)
      .set(b.headers)
      .send({ pendingPayoutCid: cid })
      .expect(200);
    await k.drive();
    expect(await k.order(id)).toMatchObject({
      status: "withdrawing",
      details: { hold: { reason: "compliance" } },
    });
    expect(markPaids(id)).toBe(0);
    const ineligible = (await alertsOf(b.user.id)).find(
      (a) => a.rule === "TM-INELIGIBLE" && a.orderId === id,
    ) as ApiComplianceAlert;
    expect(ineligible).toMatchObject({ severity: "block", status: "open" });
    expect((ineligible.figures as { reasons: string[] }).reasons).toEqual(
      expect.arrayContaining(["pep_declared"]),
    );
    // One aml person asks: pending (four eyes), MarkPaid still waits.
    const asked = await decide(amy, ineligible.id, { decision: "clear" });
    expect(asked.status).toBe(202);
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(markPaids(id)).toBe(0);
    await approveAs(bob, (asked.body as { approval: ApiApproval }).approval.id);
    // TM-PEP (the account's block alert) is still undecided: the order stays held.
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(markPaids(id)).toBe(0);
    const pep = (await alertsOf(b.user.id)).find((a) => a.rule === "TM-PEP") as ApiComplianceAlert;
    const pepAsked = await decide(amy, pep.id, { decision: "clear" });
    expect(pepAsked.status).toBe(202);
    await approveAs(bob, (pepAsked.body as { approval: ApiApproval }).approval.id);
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(markPaids(id)).toBe(1);
    expect((await k.order(id)).status).toBe("completed");
    await k.expectIdentities();
  });

  it("C28: a refused create (an open order) leaves no alert behind; a racing same-key retry neither", async () => {
    const b = await customer("struct-open");
    await k.bought(b, "1000", "card-s9");
    await k.bought(b, "1000", "card-s9");
    const ids = async (): Promise<(string | null)[]> =>
      (await alertsOf(b.user.id)).map((a) => a.orderId);
    // Two concurrent retries of one purchase (same Idempotency-Key): one order, its alert only.
    const key = nextKey();
    const send = () =>
      ctx.agent
        .post("/api/v1/ramp/onramp")
        .set(b.headers)
        .set("Idempotency-Key", key)
        .send({ amount: "700", method: "card" });
    const raced = await Promise.all([send(), send()]);
    expect(raced.some((r) => r.status === 200)).toBe(true);
    const orders = await ctx.dataSource.query<{ id: string }[]>(
      `SELECT id FROM to_ramp_orders WHERE user_id = $1 AND status = 'awaiting_payment'`,
      [b.user.id],
    );
    expect(orders).toHaveLength(1);
    expect(await ids()).toEqual([orders[0].id]);
    // A fourth buy while that one is open: TM-STRUCT would fire, but no order is created.
    const refused = await onramp(b, "200");
    expect([refused.status, (refused.body as ErrorBody).error]).toEqual([409, "ramp_order_open"]);
    expect(await ids()).toEqual([orders[0].id]);
  });

  it("C25: AML may decide `return` for a held payment: the alert is final (returned), holds nothing, and the ramp is told the money goes back; an account-level alert cannot be returned", async () => {
    const b = await customer("cash-return");
    const res = await k.openOnramp(b, "50", nextKey(), "erip");
    await k.pay(b, res, "succeeded", { channel: "cash" });
    await k.drive();
    const id = res.order.id;
    expect(await k.order(id)).toMatchObject({ status: "needs_review", reviewStep: "compliance" });
    const cash = (await alertsOf(b.user.id)).find(
      (a) => a.orderId === id && a.rule === "TM-CASH",
    ) as ApiComplianceAlert;
    const port = ctx.get(RampCompliancePort) as RampCompliancePort & {
      returnRequested(orderId: string): Promise<boolean>;
    };
    expect(await port.returnRequested(id)).toBe(false);
    const returned = await decide(amy, cash.id, { decision: "return" });
    expect([returned.status, returned.body]).toMatchObject([
      200,
      { approval: { status: "executed" }, result: { alert: { status: "returned" } } },
    ]);
    expect(await port.isHeld(id)).toBe(false);
    expect(await port.returnRequested(id)).toBe(true);
    expect((await decide(amy, cash.id, { decision: "clear" })).status).toBe(409);
    // A consent alert has no payment to give back.
    const p = await customer("return-consent");
    await consent(p, { pepDeclared: true, pepDetail: "Head of a state enterprise" });
    const pep = (await alertsOf(p.user.id)).find((a) => a.rule === "TM-PEP") as ApiComplianceAlert;
    const refused = await decide(amy, pep.id, { decision: "return" });
    expect([refused.status, (refused.body as unknown as ErrorBody).error]).toEqual([
      409,
      "compliance_alert_state",
    ]);
  });
});

describe("review group A: a compliance hold outlives a payment review; AML's return gives the money back (C9, C25)", () => {
  const markPaids = (orderId: string): number =>
    ctx.wallet.submits.filter((s) => {
      const json = JSON.stringify(s.commands);
      return json.includes('"choice":"MarkPaid"') && json.includes(`"txHash":"ramp:${orderId}"`);
    }).length;

  /** A four-eyes order action: Olga (ops) asks, Bob (approver) approves → the executed result. */
  async function fourEyes(orderId: string, action: string): Promise<Record<string, unknown>> {
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${orderId}/${action}`)
        .set(await adminAs(olga))
        .send({ reason: `e2e ${action}` })
        .expect(202),
    ).approval;
    return bodyOf<{ result: Record<string, unknown> }>(
      await ctx.agent
        .post(`/api/v1/admin/approvals/${req.id}/approve`)
        .set(await adminAs(bob))
        .send({ reason: "second person checked" })
        .expect(200),
    ).result;
  }

  async function retry(orderId: string, status: number): Promise<Record<string, unknown>> {
    return bodyOf<Record<string, unknown>>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${orderId}/retry`)
        .set(await adminAs(olga))
        .send({ reason: "e2e retry" })
        .expect(status),
    );
  }

  /**
   * A consented account's on-ramp whose capture-point check holds it: the re-verification fell
   * overdue between create and capture (TM-INELIGIBLE, review).
   */
  async function heldAtCapture(
    hint: string,
    outcome: "succeeded" | "no_3ds",
  ): Promise<{ b: Buyer; id: string }> {
    const b = await customer(hint);
    const res = await k.openOnramp(b, "40");
    await ctx.dataSource.query(
      `UPDATE to_kyc_identities SET refresh_due_at = now() - interval '1 day' WHERE user_id = $1`,
      [b.user.id],
    );
    await k.pay(b, res, outcome);
    await k.drive();
    return { b, id: res.order.id };
  }

  async function ineligibleAlert(b: Buyer, id: string): Promise<ApiComplianceAlert> {
    return (await alertsOf(b.user.id)).find(
      (a) => a.orderId === id && a.rule === "TM-INELIGIBLE",
    ) as ApiComplianceAlert;
  }

  it("C9: a payment problem never hides a capture review — a single-control retry is refused while AML holds the order; whatever path reaches paid, the mint waits for AML", async () => {
    const { b, id } = await heldAtCapture("c9", "no_3ds");
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      reviewStep: "payment",
      risk: { "onramp.capture": { decision: "deny", rules: ["TM-INELIGIBLE"] } },
    });
    expect(await retry(id, 409)).toMatchObject({
      error: "ramp_order_state",
      message: "a compliance review holds this order",
    });
    // The operator sees both: the payment problem and the hold.
    expect((await k.order(id)).lastError).toBe(
      "3ds_missing; compliance onramp.capture: deny (TM-INELIGIBLE) holds it too",
    );
    expect(await k.commands(id)).toEqual([]);
    // Any other way into `paid` (a stale approval, a hand repair) still stops before the mint.
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status = 'paid', review_step = NULL WHERE id = $1`,
      [id],
    );
    await k.fulfilment().advance(id);
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      reviewStep: "compliance",
      details: { complianceHold: { point: "onramp.capture" } },
    });
    expect(await k.commands(id)).toEqual([]);
    // AML clears it: the processor resumes the order, which mints and completes.
    const alert = await ineligibleAlert(b, id);
    expect((await decide(amy, alert.id, { decision: "clear" })).status).toBe(200);
    await k.drive();
    expect((await k.order(id)).status).toBe("completed");
    expect(await k.commands(id)).toMatchObject([
      { commandId: rampCommandId("mint", id), status: "recorded" },
    ]);
    await k.expectIdentities();
  });

  it("C25: AML's `return` on a held card capture ends the hold in the refund review — never minted, retry refused, a four-eyes refund gives it back", async () => {
    const { b, id } = await heldAtCapture("c25on", "succeeded");
    expect(await k.order(id)).toMatchObject({ status: "needs_review", reviewStep: "compliance" });
    const alert = await ineligibleAlert(b, id);
    expect((await decide(amy, alert.id, { decision: "return" })).status).toBe(200);
    await k.drive();
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      reviewStep: "refund",
      mintCommandId: null,
      details: { complianceHold: null, complianceReturn: { at: expect.any(String) as string } },
    });
    expect(await k.commands(id)).toEqual([]);
    expect(await retry(id, 409)).toMatchObject({ error: "ramp_order_state" });
    expect(await fourEyes(id, "refund")).toMatchObject({ status: "refunded" });
    expect(await k.commands(id)).toEqual([]);
    expect(await k.journal(id)).not.toHaveProperty(["onramp.minted:customer_liability"]);
    expect(await k.journal(id)).toHaveProperty(["onramp.refunded:provider_clearing"]);
    await k.expectIdentities();
  });

  it("C25: a payment review whose capture AML returned is never retried into a mint — the refusal points to refund, which gives it back", async () => {
    const { b, id } = await heldAtCapture("c25pay", "no_3ds");
    expect(await k.order(id)).toMatchObject({ status: "needs_review", reviewStep: "payment" });
    const alert = await ineligibleAlert(b, id);
    expect((await decide(amy, alert.id, { decision: "return" })).status).toBe(200);
    await k.drive();
    expect(await retry(id, 409)).toMatchObject({
      error: "ramp_order_state",
      message: expect.stringMatching(/AML decided to return/) as string,
      details: { use: "refund" },
    });
    // Any other way into `paid` still never mints: the mint step sends it to the refund review.
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET status = 'paid', review_step = NULL WHERE id = $1`,
      [id],
    );
    await k.fulfilment().advance(id);
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      reviewStep: "refund",
      details: { complianceReturn: { at: expect.any(String) as string } },
    });
    expect(await k.commands(id)).toEqual([]);
    expect(await fourEyes(id, "refund")).toMatchObject({ status: "refunded" });
    expect(await k.commands(id)).toEqual([]);
    await k.expectIdentities();
  });

  it("C25: AML's `return` on a held cash-out is never MarkPaid — the order waits in the withdrawal review, the user cancels, a four-eyes fail closes it", async () => {
    const b = await customer("c25off");
    await k.bought(b, "100", "card-c25off");
    const card = await k.payoutCard(b);
    const created = await ctx.agent
      .post("/api/v1/ramp/offramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount: "40", destination: { kind: "card", paymentMethodId: card.id } })
      .expect(200);
    const id = (created.body as ApiRampOfframpResult).order.id;
    const cid = k.signWithdraw(b, "40");
    await ctx.agent
      .post(`/api/v1/ramp/orders/${id}/attach`)
      .set(b.headers)
      .send({ pendingPayoutCid: cid })
      .expect(200);
    await k.drive();
    expect(await k.order(id)).toMatchObject({
      status: "withdrawing",
      details: { hold: { reason: "compliance" } },
    });
    const roundtrip = (await alertsOf(b.user.id)).find(
      (a) => a.orderId === id && a.rule === "TM-ROUNDTRIP",
    ) as ApiComplianceAlert;
    expect((await decide(amy, roundtrip.id, { decision: "return" })).status).toBe(200);
    await ctx.get(PayoutService).scan();
    await k.drive();
    expect(markPaids(id)).toBe(0);
    expect(await k.order(id)).toMatchObject({
      status: "needs_review",
      reviewStep: "withdrawal",
      burnCommandId: null,
      details: { hold: null },
    });
    expect(
      await ctx.dataSource.getRepository(PayoutEntity).findOneByOrFail({ pendingPayoutCid: cid }),
    ).toMatchObject({ status: "blocked_compliance" });
    k.cancelPayout(b, cid);
    await k.drive();
    expect(await fourEyes(id, "fail")).toMatchObject({ status: "failed" });
    expect(markPaids(id)).toBe(0);
    expect(await k.commands(id)).toEqual([]);
    expect(await k.journal(id)).toEqual({});
    expect(ctx.ledger.walletOf(b.wallet.partyId)?.balance).toBe(parseAmount("100"));
    await k.expectIdentities();
  });

  it("W9f C25: retry of a returned capture hold says why — AML's return is asked before the legality check (the order would resume at awaiting_payment)", async () => {
    const { b, id } = await heldAtCapture("c25why", "succeeded");
    const alert = await ineligibleAlert(b, id);
    expect((await decide(amy, alert.id, { decision: "return" })).status).toBe(200);
    await k.drive();
    expect(await k.order(id)).toMatchObject({ status: "needs_review", reviewStep: "refund" });
    expect(await retry(id, 409)).toMatchObject({
      error: "ramp_order_state",
      message: "AML decided to return this order's money; it is never minted or paid out",
      details: { use: "refund" },
    });
    expect(await k.commands(id)).toEqual([]);
    await k.expectIdentities();
  });
});
