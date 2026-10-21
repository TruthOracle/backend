/**
 * Review findings C22 / C23 with four eyes and signed decisions on (SPEC §6.5, I8, X11): a manual
 * KYC approval opens the fiat ramp only through the four-eyes `kyc.override` (role `aml` asks,
 * another person with `approver` approves, never for an account linked to either), and the
 * single-control decisions that release value — a list hit's clear (it lifts the provisional
 * freeze), an alert's clear or return — carry the deciding operator's wallet signature over the
 * request (`truthoracle-approval:request:…`, bound to the subject's state).
 */
import { randomUUID } from "node:crypto";

import { AdminApprovalEntity } from "../src/entities/admin-approval.entity";
import { ComplianceFreezeEntity } from "../src/entities/compliance-freeze.entity";
import { KycPersonEntity } from "../src/entities/kyc-person.entity";
import { ScreeningHitEntity } from "../src/entities/screening-hit.entity";
import { KycService } from "../src/services/kyc.service";
import { RampCompliancePort } from "../src/services/ramp-compliance.port";
import type { ApiApproval, ApiKycVerification } from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { useTestApp } from "./helpers/app";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const amy = makeTestWallet("cc-amy"); // aml
const bob = makeTestWallet("cc-bob"); // approver
const erin = makeTestWallet("cc-erin"); // export only

const ctx = useTestApp({
  env: {
    ADMIN_OPERATORS: [
      `${amy.partyId}#amy@aml`,
      `${bob.partyId}#bob@approver`,
      `${erin.partyId}#erin@export`,
    ].join(","),
    RAMP_DUAL_CONTROL: "true",
    RAMP_APPROVAL_SIGNATURES: "true",
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
  },
});

async function adminAs(
  w: TestWallet,
): Promise<{ headers: Record<string, string>; userId: string }> {
  const { cookie, user } = await issueSessionDirect(ctx, w, { kind: "admin" });
  return { headers: { Cookie: cookie, ...ctx.csrf }, userId: user.id };
}

/** A signed-in account whose mock KYC ended in needs_review (no document): nothing approved. */
async function unverified(hint: string, lastName = "Doe"): Promise<{ userId: string }> {
  const w = makeTestWallet(hint);
  const { user, cookie } = await issueSessionDirect(ctx, w);
  const headers = { Cookie: cookie, ...ctx.csrf };
  const started = bodyOf<{ verificationId: string }>(
    await ctx.agent.post("/api/v1/kyc/sessions").set(headers).send({}).expect(200),
  );
  const done = bodyOf<{ verification: ApiKycVerification }>(
    await ctx.agent
      .post("/api/v1/kyc/mock/submit")
      .set(headers)
      .send({
        verificationId: started.verificationId,
        outcome: "approved",
        person: { firstName: "Jane", lastName, dob: "1990-01-01", country: "BLR" },
        documents: [],
      })
      .expect(200),
  );
  expect(done.verification.status).toBe("needs_review");
  return { userId: user.id };
}

function override(
  admin: { headers: Record<string, string> },
  userId: string,
  status: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return ctx.agent
    .post(`/api/v1/admin/users/${userId}/kyc/override`)
    .set(admin.headers)
    .send({ status, reason: "documents checked by hand" })
    .then((r) => ({ status: r.status, body: r.body as Record<string, unknown> }));
}

describe("C22: a manual KYC approval is a four-eyes kyc.override", () => {
  it("an export-only operator is refused; nobody acts on an account linked to them; aml asks, the gate stays closed until another person with approver signs the approval", async () => {
    const target = await unverified("kyc-four-eyes");
    const kyc = ctx.get(KycService);
    expect((await kyc.withdrawalGate(target.userId, { enforce: true })).allowed).toBe(false);

    const exporter = await adminAs(erin);
    const asErin = await override(exporter, target.userId, "approved");
    expect([asErin.status, (asErin.body as unknown as ErrorBody).error]).toEqual([
      403,
      "role_required",
    ]);
    // The operator's own (admin) account is linked to them.
    const amyAdmin = await adminAs(amy);
    const own = await override(amyAdmin, amyAdmin.userId, "approved");
    expect([own.status, (own.body as unknown as ErrorBody).error]).toEqual([
      403,
      "approval_linked_person",
    ]);

    const asked = await override(amyAdmin, target.userId, "approved");
    expect(asked.status).toBe(202);
    const approval = (asked.body as { approval: ApiApproval }).approval;
    expect(approval).toMatchObject({
      action: "kyc.override",
      status: "pending",
      singleControl: false,
    });
    expect((await kyc.withdrawalGate(target.userId, { enforce: true })).allowed).toBe(false);

    const bobAdmin = await adminAs(bob);
    const done = bodyOf<{ approval: ApiApproval; result: { verification: ApiKycVerification } }>(
      await ctx.agent
        .post(`/api/v1/admin/approvals/${approval.id}/approve`)
        .set(bobAdmin.headers)
        .send({
          reason: "the passport was checked in person",
          signature: bob.sign(`truthoracle-approval:${approval.id}:${approval.paramsHash}:approve`),
        })
        .expect(200),
    );
    expect(done.approval.status).toBe("executed");
    expect(done.result.verification).toMatchObject({ provider: "admin", status: "approved" });
    expect(await kyc.withdrawalGate(target.userId, { enforce: true })).toEqual({ allowed: true });

    // Closing the gate stays one aml decision.
    const expired = await override(amyAdmin, target.userId, "expired");
    expect(expired.status).toBe(200);
    expect((await kyc.withdrawalGate(target.userId, { enforce: true })).allowed).toBe(false);
  });
});

describe("R2b-1: a KYC person transfer is the four-eyes kyc.person_transfer", () => {
  /** A signed-in account whose mock KYC carries the same passport: the first approved, the next blocked_duplicate. */
  async function passportHolder(hint: string): Promise<{ userId: string; status: string }> {
    const { user, cookie } = await issueSessionDirect(ctx, makeTestWallet(hint));
    const headers = { Cookie: cookie, ...ctx.csrf };
    const started = bodyOf<{ verificationId: string }>(
      await ctx.agent.post("/api/v1/kyc/sessions").set(headers).send({}).expect(200),
    );
    const done = bodyOf<{ verification: ApiKycVerification }>(
      await ctx.agent
        .post("/api/v1/kyc/mock/submit")
        .set(headers)
        .send({
          verificationId: started.verificationId,
          outcome: "approved",
          person: { firstName: "Rahul", lastName: "Sharma", dob: "1985-05-05", country: "IND" },
          documents: [{ docType: "PASSPORT", country: "IND", number: "Z7654321" }],
        })
        .expect(200),
    );
    return { userId: user.id, status: done.verification.status };
  }

  function transfer(
    admin: { headers: Record<string, string> },
    fingerprint: string,
    toUserId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return ctx.agent
      .post(`/api/v1/admin/kyc/persons/${fingerprint}/transfer`)
      .set(admin.headers)
      .send({ toUserId, reason: "account merge ticket 7" })
      .then((r) => ({ status: r.status, body: r.body as Record<string, unknown> }));
  }

  it("an export-only operator is refused; nobody moves a person to an account linked to them; aml asks, the target's KYC stays closed until another person with approver signs", async () => {
    const kyc = ctx.get(KycService);
    const a = await passportHolder("pt-source");
    const b = await passportHolder("pt-target");
    expect([a.status, b.status]).toEqual(["approved", "blocked_duplicate"]);
    const doc = await ctx.dataSource
      .getRepository(KycPersonEntity)
      .findOneByOrFail({ userId: a.userId, kind: "doc" });

    const asErin = await transfer(await adminAs(erin), doc.fingerprint, b.userId);
    expect([asErin.status, (asErin.body as unknown as ErrorBody).error]).toEqual([
      403,
      "role_required",
    ]);
    const amyAdmin = await adminAs(amy);
    const own = await transfer(amyAdmin, doc.fingerprint, amyAdmin.userId);
    expect([own.status, (own.body as unknown as ErrorBody).error]).toEqual([
      403,
      "approval_linked_person",
    ]);
    expect((await kyc.withdrawalGate(b.userId, { enforce: true })).allowed).toBe(false);

    const asked = await transfer(amyAdmin, doc.fingerprint, b.userId);
    expect(asked.status).toBe(202);
    const approval = (asked.body as { approval: ApiApproval }).approval;
    expect(approval).toMatchObject({
      action: "kyc.person_transfer",
      status: "pending",
      singleControl: false,
    });
    expect((await kyc.withdrawalGate(b.userId, { enforce: true })).allowed).toBe(false);
    expect((await kyc.withdrawalGate(a.userId, { enforce: true })).allowed).toBe(true);

    const bob2 = await adminAs(bob);
    const done = bodyOf<{ approval: ApiApproval; result: { ok: true } }>(
      await ctx.agent
        .post(`/api/v1/admin/approvals/${approval.id}/approve`)
        .set(bob2.headers)
        .send({
          reason: "the merge ticket was checked",
          signature: bob.sign(`truthoracle-approval:${approval.id}:${approval.paramsHash}:approve`),
        })
        .expect(200),
    );
    expect(done).toMatchObject({ approval: { status: "executed" }, result: { ok: true } });
    expect(await kyc.withdrawalGate(b.userId, { enforce: true })).toEqual({ allowed: true });
    expect((await kyc.withdrawalGate(a.userId, { enforce: true })).allowed).toBe(false);
  });
});

describe("C23: single-control decisions that release value are signed", () => {
  async function listedAccount(): Promise<{ userId: string; hitId: string }> {
    const target = await unverified("listed", "Ivanova");
    const amyAdmin = await adminAs(amy);
    // Approve by hand first (four eyes), so the identity is screened by name.
    const asked = await override(amyAdmin, target.userId, "approved");
    const approval = (asked.body as { approval: ApiApproval }).approval;
    await ctx.agent
      .post(`/api/v1/admin/approvals/${approval.id}/approve`)
      .set((await adminAs(bob)).headers)
      .send({
        reason: "checked",
        signature: bob.sign(`truthoracle-approval:${approval.id}:${approval.paramsHash}:approve`),
      })
      .expect(200);
    const content = Buffer.from(
      "kind,name_variants,birth_date,ids\r\nperson,Ivanova Jane,1990-01-01,\r\n",
      "utf8",
    ).toString("base64");
    await ctx.agent
      .post("/api/v1/admin/compliance/screening-lists")
      .set(amyAdmin.headers)
      .send({ list: "by_terror", version: "c23", deliveredAt: new Date().toISOString(), content })
      .expect(200);
    const hit = await ctx.dataSource
      .getRepository(ScreeningHitEntity)
      .findOneByOrFail({ userId: target.userId });
    return { userId: target.userId, hitId: hit.id };
  }

  const activeFreeze = (userId: string) =>
    ctx.dataSource
      .getRepository(ComplianceFreezeEntity)
      .findOne({ where: { userId, active: true } });

  it("clearing a list hit: unsigned → 400 with the message to sign (nothing saved, the freeze stays); another wallet's signature → 401; the decider's own → executed, freeze lifted, signature kept", async () => {
    const { userId, hitId } = await listedAccount();
    expect(await activeFreeze(userId)).toMatchObject({ provisional: true });
    const amyAdmin = await adminAs(amy);
    const url = `/api/v1/admin/compliance/screening-hits/${hitId}/decide`;
    const body = { decision: "clear", reason: "a different person: passport compared" };
    const before = await ctx.dataSource.getRepository(AdminApprovalEntity).count();
    const unsigned = bodyOf<ErrorBody>(
      await ctx.agent.post(url).set(amyAdmin.headers).send(body).expect(400),
    );
    expect(unsigned.error).toBe("approval_signature_required");
    const message = (unsigned.details as { message: string }).message;
    expect(message).toMatch(
      new RegExp(
        `^truthoracle-approval:request:compliance\\.hit\\.decide:${hitId}:[0-9a-f]{64}:[0-9a-f]{64}$`,
      ),
    );
    expect(await ctx.dataSource.getRepository(AdminApprovalEntity).count()).toBe(before);
    expect(await activeFreeze(userId)).not.toBeNull();
    const forged = bodyOf<ErrorBody>(
      await ctx.agent
        .post(url)
        .set(amyAdmin.headers)
        .send({ ...body, signature: bob.sign(message) })
        .expect(401),
    );
    expect(forged.error).toBe("approval_signature_invalid");
    expect(await activeFreeze(userId)).not.toBeNull();
    const signed = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(url)
        .set(amyAdmin.headers)
        .send({ ...body, signature: amy.sign(message) })
        .expect(200),
    );
    expect(signed.approval).toMatchObject({ status: "executed", singleControl: true });
    expect(await activeFreeze(userId)).toBeNull();
    const row = await ctx.dataSource
      .getRepository(AdminApprovalEntity)
      .findOneByOrFail({ id: signed.approval.id });
    expect(row.decisionSignature).toBe(amy.sign(message));
  });

  it("a review alert: clear is signed, escalate (keeps the hold) is not", async () => {
    const { userId } = await unverified("alerted");
    const alertId = await ctx
      .get(RampCompliancePort)
      .raise("TM-SHAREDIBAN", userId, { bankAccountId: randomUUID(), severity: "review" });
    const amyAdmin = await adminAs(amy);
    const url = `/api/v1/admin/compliance/alerts/${alertId}/decide`;
    const unsigned = bodyOf<ErrorBody>(
      await ctx.agent
        .post(url)
        .set(amyAdmin.headers)
        .send({ decision: "clear", reason: "the shared IBAN is a family account" })
        .expect(400),
    );
    expect(unsigned.error).toBe("approval_signature_required");
    const escalated = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(url)
        .set(amyAdmin.headers)
        .send({ decision: "escalate", reason: "needs the bank's statement" })
        .expect(200),
    );
    expect(escalated.approval.status).toBe("executed");
  });
});
