/**
 * Four-eyes approvals end to end (SPEC §6.5; S4) with the production settings: RAMP_DUAL_CONTROL
 * and RAMP_APPROVAL_SIGNATURES on, operators declared as PERSONS with roles. Alice (ops +
 * approver) also signs in from a second party; Bob approves; Carol only runs the ramp (ops); Dave
 * approves but is linked to a customer account. Covers the order actions, approve-many, stale and
 * expired requests, cancel / reject, the four-eyes resume of a halt, the session route, the
 * operator MarkPaid and force-settle, user.reinstate, and the token command resolutions.
 */
import { randomUUID } from "node:crypto";

import { AdminApprovalEntity } from "../src/entities/admin-approval.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { RampPaymentMethodEntity } from "../src/entities/ramp-payment-method.entity";
import { TokenCommandEntity } from "../src/entities/token-command.entity";
import { UserEntity } from "../src/entities/user.entity";
import { AdminApprovalService } from "../src/services/admin-approval.service";
import type { AdminActor } from "../src/services/admin.service";
import { RampReconProcessor } from "../src/processors/ramp-recon.processor";
import { rampCommandId } from "../src/services/ramp-fulfilment.service";
import { TokenAppSyncService } from "../src/services/token-app-sync.service";
import { UserService } from "../src/services/user.service";
import type {
  ApiAdminRampOrder,
  ApiAdminRampOrderDetail,
  ApiAdminSession,
  ApiApproval,
  ApiApproveManyResult,
  ApiRampControls,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { parseAmount } from "../src/util/money";
import { PROD_CONTROLS, TEST_COLLATERAL, TEST_TREASURY, useTestApp } from "./helpers/app";
import { dec, nextKey, rampKit } from "./helpers/ramp";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

const alice = makeTestWallet("alice");
const alice2 = makeTestWallet("alice2");
const bob = makeTestWallet("bob");
const carol = makeTestWallet("carol");
const dave = makeTestWallet("dave");
const LINKED_USER = randomUUID();

const ctx = useTestApp({
  env: {
    ...PROD_CONTROLS,
    // The gates are ramp-controls.e2e-spec's subject; here they only warn.
    RAMP_RESERVE_GATE: "warn",
    RAMP_PAYOUT_GATE: "warn",
    RAMP_AUTO_HALT: "false",
    ADMIN_OPERATORS: [
      `${alice.partyId}#alice@ops+approver`,
      `${alice2.partyId}#alice@ops`,
      `${bob.partyId}#bob@approver`,
      `${carol.partyId}#carol@ops`,
      `${dave.partyId}#dave@approver`,
    ].join(","),
    ADMIN_OPERATOR_ACCOUNTS: `dave:${LINKED_USER}`,
    RAMP_ENABLED: "true",
    RAMP_PUBLIC_APP_URL: "http://app.test",
    RAMP_SCAN_MS: "0",
    RAMP_MOCK_WEBHOOK_SECRET: "e2e-ramp-mock-secret",
  },
});
const k = rampKit(ctx, alice);

beforeEach(() => {
  k.mock().reset();
});

async function headers(w: TestWallet): Promise<Record<string, string>> {
  const { cookie } = await issueSessionDirect(ctx, w, { kind: "admin" });
  return { Cookie: cookie, ...ctx.csrf };
}

function sig(
  w: TestWallet,
  a: Pick<ApiApproval, "id" | "paramsHash">,
  decision: "approve" | "reject",
): string {
  return w.sign(`truthoracle-approval:${a.id}:${a.paramsHash}:${decision}`);
}

async function decide(
  w: TestWallet,
  a: Pick<ApiApproval, "id" | "paramsHash">,
  status: number,
  opts: { decision?: "approve" | "reject"; signature?: string | null; reason?: string } = {},
): Promise<Record<string, unknown>> {
  const decision = opts.decision ?? "approve";
  const signature = opts.signature === undefined ? sig(w, a, decision) : opts.signature;
  return bodyOf<Record<string, unknown>>(
    await ctx.agent
      .post(`/api/v1/admin/approvals/${a.id}/${decision}`)
      .set(await headers(w))
      .send({
        reason: opts.reason ?? `${decision} by ${w.partyId.split("::")[0]}`,
        ...(signature ? { signature } : {}),
      })
      .expect(status),
  );
}

/** A captured on-ramp parked in needs_review(payment) (no 3-D Secure): refundable by four-eyes. */
async function inReview(hint: string, amount: string): Promise<string> {
  const b = await k.buyer(hint);
  const res = await k.openOnramp(b, amount);
  await k.pay(b, res, "no_3ds");
  expect(await k.order(res.order.id)).toMatchObject({
    status: "needs_review",
    reviewStep: "payment",
  });
  return res.order.id;
}

async function requestRefund(orderId: string, w = alice): Promise<ApiApproval> {
  return bodyOf<{ approval: ApiApproval }>(
    await ctx.agent
      .post(`/api/v1/admin/ramp/orders/${orderId}/refund`)
      .set(await headers(w))
      .send({ reason: "customer asked" })
      .expect(202),
  ).approval;
}

describe("four-eyes approvals (SPEC §6.5)", () => {
  it("GET /admin/session names the party, the PERSON and the roles", async () => {
    const session = bodyOf<ApiAdminSession>(
      await ctx.agent
        .get("/api/v1/admin/session")
        .set(await headers(alice2))
        .expect(200),
    );
    expect(session).toEqual({
      party: alice2.partyId,
      personId: "alice",
      roles: ["ops"],
      approvalSignatures: true,
      dualControl: true,
    });
  });

  it("A requests a refund; A, A's second party and an ops-only operator cannot approve; unsigned or mis-signed fails; B's signed approval executes it", async () => {
    const orderId = await inReview("fe", "40");
    const approval = await requestRefund(orderId);
    expect(approval).toMatchObject({
      action: "ramp.order.refund",
      subjectType: "ramp_order",
      subjectId: orderId,
      status: "pending",
      singleControl: false,
      requestedByPerson: "alice",
      requestedByParty: alice.partyId,
    });
    expect((await k.order(orderId)).status).toBe("needs_review");
    expect((await decide(alice, approval, 403)).error).toBe("approval_self");
    expect((await decide(alice2, approval, 403)).error).toBe("approval_same_person");
    expect((await decide(carol, approval, 403)).error).toBe("approval_role_required");
    expect((await decide(bob, approval, 400, { signature: null })).error).toBe(
      "approval_signature_required",
    );
    expect(
      (await decide(bob, approval, 401, { signature: sig(alice, approval, "approve") })).error,
    ).toBe("approval_signature_invalid");
    expect(
      (await decide(bob, approval, 401, { signature: sig(bob, approval, "reject") })).error,
    ).toBe("approval_signature_invalid");
    const done = (await decide(bob, approval, 200)) as {
      approval: ApiApproval;
      result: ApiAdminRampOrder;
    };
    expect(done.approval).toMatchObject({
      status: "executed",
      decidedByPerson: "bob",
      decidedByParty: bob.partyId,
    });
    expect(done.result).toMatchObject({
      id: orderId,
      status: "refunded",
      refundedAmount: dec("40"),
    });
    expect(await k.journal(orderId)).toMatchObject({
      "onramp.refunded:issuance_pending": dec("40"),
      "onramp.refunded:provider_clearing": dec("-40"),
    });
    // A decided approval is not decided twice.
    expect((await decide(bob, approval, 409)).error).toBe("approval_not_pending");
    const listed = bodyOf<{ items: ApiApproval[] }>(
      await ctx.agent
        .get(`/api/v1/admin/approvals?subjectId=${orderId}&status=executed`)
        .set(await headers(carol))
        .expect(200),
    );
    expect(listed.items.map((a) => a.id)).toEqual([approval.id]);
    const detail = bodyOf<ApiAdminRampOrderDetail>(
      await ctx.agent
        .get(`/api/v1/admin/ramp/orders/${orderId}`)
        .set(await headers(carol))
        .expect(200),
    );
    expect(detail.approvals).toMatchObject([
      {
        id: approval.id,
        status: "executed",
        description: expect.stringContaining("refund") as string,
      },
    ]);
    await k.expectIdentities();
  });

  it("approve-many decides one action type, each with its own signature", async () => {
    const one = await requestRefund(await inReview("m1", "10"));
    const two = await requestRefund(await inReview("m2", "20"));
    const out = bodyOf<ApiApproveManyResult>(
      await ctx.agent
        .post("/api/v1/admin/approvals/approve-many")
        .set(await headers(bob))
        .send({
          ids: [one.id, two.id],
          reason: "morning queue",
          signatures: { [one.id]: sig(bob, one, "approve"), [two.id]: "bad" },
        })
        .expect(200),
    );
    expect(out.results).toMatchObject([
      { id: one.id, approval: { status: "executed" } },
      { id: two.id, error: { error: "approval_signature_invalid" } },
    ]);
    // The order queue pages by cursor (newest first).
    const carolH = await headers(carol);
    const first = bodyOf<{ items: { id: string }[]; nextCursor: string | null; total: number }>(
      await ctx.agent.get("/api/v1/admin/ramp/orders?limit=1").set(carolH).expect(200),
    );
    expect(first).toMatchObject({ items: [{ id: two.subjectId }], total: 2 });
    const second = bodyOf<{ items: { id: string }[]; nextCursor: string | null }>(
      await ctx.agent
        .get(`/api/v1/admin/ramp/orders?limit=1&cursor=${first.nextCursor ?? ""}`)
        .set(carolH)
        .expect(200),
    );
    expect(second).toMatchObject({ items: [{ id: one.subjectId }], nextCursor: null });
    await k.expectIdentities();
  });

  it("a subject changed since the request, an expired request, a cancel and a reject never execute", async () => {
    const stale = await requestRefund(await inReview("pc", "15"));
    await ctx.dataSource.query(`UPDATE to_ramp_orders SET version = version + 1 WHERE id = $1`, [
      stale.subjectId,
    ]);
    const changed = await decide(bob, stale, 409);
    expect(changed.error).toBe("approval_precondition_changed");
    expect(
      await ctx.dataSource.getRepository(AdminApprovalEntity).findOneByOrFail({ id: stale.id }),
    ).toMatchObject({
      status: "failed",
    });

    const late = await requestRefund(await inReview("ex", "15"));
    await ctx.dataSource.query(
      `UPDATE to_admin_approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [late.id],
    );
    expect((await decide(bob, late, 409)).error).toBe("approval_expired");
    expect(
      (await ctx.dataSource.getRepository(AdminApprovalEntity).findOneByOrFail({ id: late.id }))
        .status,
    ).toBe("expired");

    const orderId = await inReview("cr", "15");
    const mine = await requestRefund(orderId);
    expect(
      ((await decide(alice2, mine, 200, { decision: "reject" })) as { approval: ApiApproval })
        .approval.status,
    ).toBe("cancelled");
    const again = await requestRefund(orderId);
    expect(
      ((await decide(bob, again, 200, { decision: "reject" })) as { approval: ApiApproval })
        .approval,
    ).toMatchObject({
      status: "rejected",
      decidedByPerson: "bob",
    });
    expect((await k.order(orderId)).status).toBe("needs_review");
  });

  it("a person linked to the subject's account cannot approve (ADMIN_OPERATOR_ACCOUNTS, I8)", async () => {
    await ctx.dataSource.query(`INSERT INTO to_users (id, status) VALUES ($1, 'suspended')`, [
      LINKED_USER,
    ]);
    const { user } = await issueSessionDirect(ctx, alice, { kind: "admin" });
    const actor: AdminActor = {
      type: "admin",
      userId: user.id,
      sessionId: randomUUID(),
      ip: null,
      operatorParty: alice.partyId,
      personId: "alice",
      roles: ["ops", "approver"],
      publicKey: alice.publicKeyBase64,
    };
    const { approval } = await ctx
      .get(AdminApprovalService)
      .request({ action: "user.reinstate", subjectId: LINKED_USER, reason: "appeal" }, actor);
    expect(approval.status).toBe("pending");
    expect((await decide(dave, approval, 403)).error).toBe("approval_linked_person");
    expect(((await decide(bob, approval, 200)) as { approval: ApiApproval }).approval.status).toBe(
      "executed",
    );
    expect(
      (await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: LINKED_USER })).status,
    ).toBe("active");
  });

  it("a halt is immediate for ops; lifting it is a four-eyes resume", async () => {
    const refused = await ctx.agent
      .post("/api/v1/admin/ramp/controls/halt")
      .set(await headers(bob))
      .send({ scopes: ["mints"], reason: "x" })
      .expect(403);
    expect(bodyOf<ErrorBody>(refused)).toMatchObject({
      error: "role_required",
      details: { role: "ops" },
    });
    const halted = bodyOf<{ controls: ApiRampControls }>(
      await ctx.agent
        .post("/api/v1/admin/ramp/controls/halt")
        .set(await headers(carol))
        .send({ scopes: ["mints", "payouts"], reason: "bank outage" })
        .expect(200),
    );
    expect(halted.controls).toMatchObject({ haltedScopes: ["mints", "payouts"], source: "admin" });
    const resume = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post("/api/v1/admin/ramp/controls/resume")
        .set(await headers(carol))
        .send({ reason: "bank is back" })
        .expect(202),
    ).approval;
    expect(
      (
        await ctx.agent
          .get("/api/v1/admin/ramp/controls")
          .set(await headers(carol))
          .expect(200)
      ).body,
    ).toMatchObject({
      controls: { haltedScopes: ["mints", "payouts"] },
    });
    expect(((await decide(alice, resume, 200)) as { approval: ApiApproval }).approval.status).toBe(
      "executed",
    );
    expect(
      bodyOf<{ controls: ApiRampControls }>(
        await ctx.agent
          .get("/api/v1/admin/ramp/controls")
          .set(await headers(carol))
          .expect(200),
      ).controls.haltedScopes,
    ).toEqual([]);
  });

  it("payout.mark_paid archives an out-of-band payment under its reference; a ramp: reference and a withdrawal a cash-out may bind are refused", async () => {
    const party = "payee::1220" + "7".repeat(64);
    const plain = ctx.ledger.seedPendingPayout({
      user: party,
      amount: "7",
      reason: "withdraw",
      marketId: "0",
      instrument: TEST_COLLATERAL,
    });
    const carolH = await headers(carol);
    const bad = await ctx.agent
      .post(`/api/v1/admin/payouts/${plain.contractId}/mark-paid`)
      .set(carolH)
      .send({ txHash: `ramp:${randomUUID()}`, reason: "x" })
      .expect(400);
    expect(bodyOf<ErrorBody>(bad).error).toBe("validation_failed");
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/payouts/${plain.contractId}/mark-paid`)
        .set(carolH)
        .send({ txHash: "bank-ref-123", reason: "paid by wire" })
        .expect(202),
    ).approval;
    expect(req).toMatchObject({ action: "payout.mark_paid", params: { txHash: "bank-ref-123" } });
    expect(ctx.ledger.payouts.has(plain.contractId)).toBe(true);
    const done = (await decide(bob, req, 200)) as {
      approval: ApiApproval;
      result: { payout: { status: string } };
    };
    expect(done.result.payout.status).toBe("settled_external");
    expect(ctx.ledger.payouts.has(plain.contractId)).toBe(false);
    expect(
      ctx.wallet.submits.filter((s) =>
        JSON.stringify(s.commands).includes('"txHash":"bank-ref-123"'),
      ),
    ).toHaveLength(1);
    expect(
      await ctx.dataSource
        .getRepository(PayoutEntity)
        .findOneByOrFail({ pendingPayoutCid: plain.contractId }),
    ).toMatchObject({ status: "settled_external" });

    // A withdrawal a cash-out of the payee's account is waiting for belongs to the ramp.
    const b = await k.buyer("mp");
    await k.bought(b, "30");
    await k.decayExposure();
    const card = await k.payoutCard(b);
    await ctx.agent
      .post("/api/v1/ramp/offramp")
      .set(b.headers)
      .set("Idempotency-Key", nextKey())
      .send({ amount: "20", destination: { kind: "card", paymentMethodId: card.id } })
      .expect(200);
    const cid = k.signWithdraw(b, "20");
    const refused = await ctx.agent
      .post(`/api/v1/admin/payouts/${cid}/mark-paid`)
      .set(carolH)
      .send({ txHash: "bank-ref-9", reason: "x" })
      .expect(409);
    expect(bodyOf<ErrorBody>(refused)).toMatchObject({
      error: "payout_blocked",
      details: { reason: "ramp_bindable" },
    });
  });

  it("payout.force_settle is four-eyes; a force the payout rules still refuse fails as approval_failed", async () => {
    const mystery = ctx.ledger.seedPendingPayout({
      user: "payee::1220" + "6".repeat(64),
      amount: "1",
      reason: "mystery",
      marketId: "0",
      instrument: TEST_COLLATERAL,
    });
    const carolH = await headers(carol);
    await ctx.agent
      .post(`/api/v1/admin/payouts/${mystery.contractId}/settle`)
      .set(carolH)
      .send({ reason: "look" })
      .expect(409);
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/payouts/${mystery.contractId}/settle`)
        .set(carolH)
        .send({ force: true, reason: "override" })
        .expect(202),
    ).approval;
    expect(req).toMatchObject({ action: "payout.force_settle", status: "pending" });
    const failed = await decide(bob, req, 409);
    expect(failed).toMatchObject({
      error: "approval_failed",
      details: { cause: "payout_blocked" },
    });
    expect(
      (await ctx.dataSource.getRepository(AdminApprovalEntity).findOneByOrFail({ id: req.id }))
        .status,
    ).toBe("failed");
  });

  it("reinstating an account with a blocked card is four-eyes (user.reinstate); without money flags it is immediate", async () => {
    const b = await k.buyer("ri");
    await k.bought(b, "10");
    await ctx.dataSource
      .getRepository(RampPaymentMethodEntity)
      .update({ userId: b.user.id }, { status: "blocked" });
    await ctx.get(UserService).suspend(b.user.id, "chargeback", { type: "system" });
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/users/${b.user.id}/reinstate`)
        .set(await headers(carol))
        .send({ reason: "dispute won" })
        .expect(202),
    ).approval;
    expect(req).toMatchObject({ action: "user.reinstate", status: "pending" });
    expect(
      (await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: b.user.id })).status,
    ).toBe("suspended");
    await decide(bob, req, 200);
    expect(
      (await ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id: b.user.id })).status,
    ).toBe("active");

    const plain = await k.buyer("ri2");
    await ctx.get(UserService).suspend(plain.user.id, "spam", { type: "system" });
    expect(
      (
        await ctx.agent
          .post(`/api/v1/admin/users/${plain.user.id}/reinstate`)
          .set(await headers(carol))
          .send({ reason: "ok" })
          .expect(200)
      ).body,
    ).toEqual({ ok: true });
  });

  it("token.command.resend re-sends a lost ramp mint under its own id once a second person approves", async () => {
    const b = await k.buyer("rs");
    const res = await k.openOnramp(b, "12");
    ctx.tokenApp.nextPost = {
      outcome: {
        outcome: "unknown",
        httpStatus: 0,
        status: null,
        code: "upstream_failed",
        message: "timeout",
      },
      lands: false,
    };
    await k.pay(b, res);
    await k.drive();
    const mintId = rampCommandId("mint", res.order.id);
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: mintId, status: "unknown", attempts: 1 },
    ]);
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/tokens/commands/${mintId}/resend`)
        .set(await headers(carol))
        .send({ reason: "token-app timed out" })
        .expect(202),
    ).approval;
    const done = (await decide(bob, req, 200)) as { result: { attempts: number; status: string } };
    expect(done.result).toMatchObject({ attempts: 2, status: "submitted" });
    await k.drive();
    expect((await k.order(res.order.id)).status).toBe("completed");
    expect(ctx.tokenApp.minted.filter((m) => m.commandId === mintId)).toHaveLength(1);
    await k.expectIdentities();
  });

  it("R1-1: a console re-send of an order's mint holds the order's lock: a refund approved while it re-pages is refused, never run beside the re-POST", async () => {
    const b = await k.buyer("r11");
    const res = await k.openOnramp(b, "12");
    ctx.tokenApp.nextPost = {
      outcome: {
        outcome: "rejected",
        httpStatus: 422,
        status: null,
        code: "token_app_invalid_request",
        message: "bad request",
      },
      lands: false,
    };
    await k.pay(b, res);
    await k.drive();
    const mintId = rampCommandId("mint", res.order.id);
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: mintId, status: "rejected" },
    ]);
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "mint",
    });
    const resend = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/tokens/commands/${mintId}/resend`)
        .set(await headers(carol))
        .send({ reason: "the 422 is fixed" })
        .expect(202),
    ).approval;
    const refund = await requestRefund(res.order.id, carol);
    // The re-send re-pages the instrument once to validate the approval and once to send; the
    // refund's approval lands during the second.
    const sync = ctx.get(TokenAppSyncService);
    const repage = sync.repageInstrument.bind(sync);
    let calls = 0;
    let refundAnswer: { status: number; body: Record<string, unknown> } | null = null;
    const spy = jest.spyOn(sync, "repageInstrument").mockImplementation(async (instrumentId) => {
      calls += 1;
      if (calls === 2) {
        const r = await ctx.agent
          .post(`/api/v1/admin/approvals/${refund.id}/approve`)
          .set(await headers(bob))
          .send({ reason: "refund it", signature: sig(bob, refund, "approve") });
        refundAnswer = { status: r.status, body: r.body as Record<string, unknown> };
      }
      return repage(instrumentId);
    });
    try {
      await decide(bob, resend, 200);
    } finally {
      spy.mockRestore();
    }
    expect(refundAnswer).toMatchObject({
      status: 409,
      body: { error: "approval_failed", details: { cause: "ramp_order_state" } },
    });
    expect(await k.order(res.order.id)).toMatchObject({
      status: "needs_review",
      reviewStep: "mint",
    });
    expect(Object.keys(await k.journal(res.order.id))).not.toContain(
      "onramp.refunded:issuance_pending",
    );
    expect((await k.commands(res.order.id)).map((c) => [c.commandId, c.status])).toEqual([
      [mintId, "submitted"],
    ]);
    await k.expectIdentities();
  });

  it("token.command.abandon declares a lost operator mint never-landing; the approval binds the expected treasury holdings", async () => {
    ctx.tokenApp.nextPost = {
      outcome: {
        outcome: "unknown",
        httpStatus: 0,
        status: null,
        code: "upstream_failed",
        message: "timeout",
      },
      lands: false,
    };
    await ctx.agent
      .post("/api/v1/admin/tokens/mint")
      .set(await headers(carol))
      .send({ instrument: TEST_COLLATERAL, amount: "3", reason: "float" })
      .expect(502);
    const row = await ctx.dataSource
      .getRepository(TokenCommandEntity)
      .findOneByOrFail({ source: "admin" });
    expect(row.status).toBe("unknown");
    await ctx.dataSource.query(
      `UPDATE to_token_commands SET last_post_at = now() - interval '9 days', created_at = now() - interval '9 days' WHERE command_id = $1`,
      [row.commandId],
    );
    const sync = ctx.get(TokenAppSyncService);
    await sync.recordRepage(TEST_COLLATERAL.id, new Date(Date.now() - 3 * 60_000));
    await sync.recordRepage(TEST_COLLATERAL.id, new Date(Date.now() - 60_000));
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/tokens/commands/${row.commandId}/abandon`)
        .set(await headers(carol))
        .send({ reason: "never landed" })
        .expect(202),
    ).approval;
    expect(req.params).toEqual({ expectedTreasuryHoldings: dec("0") });
    await decide(bob, req, 200);
    const listed = bodyOf<{ items: { commandId: string; status: string }[] }>(
      await ctx.agent
        .get("/api/v1/admin/tokens/commands?status=abandoned")
        .set(await headers(carol))
        .expect(200),
    );
    expect(listed.items).toMatchObject([{ commandId: row.commandId, status: "abandoned" }]);
  });

  it("token.records.adopt turns earlier records no command accounts for into legacy rows", async () => {
    ctx.tokenApp.extraRecords.push({
      kind: "mint",
      commandId: "old-check-mint",
      updateId: "update-old",
      partyId: TEST_TREASURY,
      instrumentId: TEST_COLLATERAL.id,
      amount: parseAmount("2"),
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const sync = ctx.get(TokenAppSyncService);
    await sync.syncOnce("test");
    expect((await sync.lastPassSummary())?.unknownRecords).toBe(1);
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post("/api/v1/admin/tokens/records/adopt")
        .set(await headers(carol))
        .send({
          before: new Date(Date.now() - 60_000).toISOString(),
          reason: "pre-launch round trip",
        })
        .expect(202),
    ).approval;
    expect(req).toMatchObject({
      action: "token.records.adopt",
      subjectId: "*",
      precondition: { count: 1 },
    });
    const done = (await decide(bob, req, 200)) as { result: { adopted: number } };
    expect(done.result.adopted).toBe(1);
    await sync.syncOnce("test");
    expect((await sync.lastPassSummary())?.unknownRecords).toBe(0);
  });
  it("ramp.payment_method.unblock: a blocked card is active again after four-eyes; payout eligibility is recomputed from its 3DS purchases", async () => {
    const b = await k.buyer("ub");
    await k.bought(b, "10");
    const card = await k.payoutCard(b);
    const methods = ctx.dataSource.getRepository(RampPaymentMethodEntity);
    await methods.update({ id: card.id }, { status: "blocked", payoutEligible: false });
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/payment-methods/${card.id}/unblock`)
        .set(await headers(carol))
        .send({ reason: "dispute withdrawn" })
        .expect(202),
    ).approval;
    expect(req).toMatchObject({ action: "ramp.payment_method.unblock", subjectId: card.id });
    const done = (await decide(bob, req, 200)) as {
      result: { status: string; payoutEligible: boolean };
    };
    expect(done.result).toEqual({ id: card.id, status: "active", payoutEligible: true });
    // Unblocking an active card is refused at request time.
    const again = await ctx.agent
      .post(`/api/v1/admin/ramp/payment-methods/${card.id}/unblock`)
      .set(await headers(carol))
      .send({ reason: "again" })
      .expect(409);
    expect(bodyOf<ErrorBody>(again).error).toBe("ramp_card_state");
  });
  it("the scheduled pass runs a full reconciliation and expires pending approvals past their business-day TTL", async () => {
    const stale = await requestRefund(await inReview("sweep", "11"));
    await ctx.dataSource.query(
      `UPDATE to_admin_approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [stale.id],
    );
    await ctx.get(RampReconProcessor).tick();
    expect(
      (await ctx.dataSource.getRepository(AdminApprovalEntity).findOneByOrFail({ id: stale.id }))
        .status,
    ).toBe("expired");
    const runs = await ctx.dataSource.query<{ trigger: string; finished_at: Date | null }[]>(
      `SELECT trigger, finished_at FROM to_ramp_recon_runs WHERE trigger = 'schedule'`,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].finished_at).not.toBeNull();
  });
  it("under dual control a retry that only re-reads the capture is single-control (SPEC §4.2): it executes at once", async () => {
    const orderId = await inReview("rt", "18");
    const out = bodyOf<{ approval: ApiApproval; result: ApiAdminRampOrder }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${orderId}/retry`)
        .set(await headers(carol))
        .send({ reason: "customer verified by phone" })
        .expect(200),
    );
    expect(out.approval).toMatchObject({
      action: "ramp.order.retry",
      status: "executed",
      singleControl: true,
      decidedByPerson: "carol",
    });
    expect(out.result.status).toBe("minting");
    await k.drive();
    expect((await k.order(orderId)).status).toBe("completed");
    await k.expectIdentities();
  });
});

describe("review group A: four-eyes that outlives the post-close poll; closing a dead webhook (C39, C31)", () => {
  it("C39: a burn_uncredited requested on a charged-back order is still approvable after the 15-minute post-close poll re-read it", async () => {
    const b = await k.buyer("c39");
    const res = await k.openOnramp(b, "50");
    const mintId = rampCommandId("mint", res.order.id);
    ctx.tokenApp.unrecorded.add(mintId);
    await k.pay(b, res);
    await k.drive(1);
    expect((await k.order(res.order.id)).status).toBe("minting");
    await k.deliver(k.mock().chargeback(k.paymentIdOf(res), b.user.id));
    ctx.tokenApp.unrecorded.delete(mintId);
    await k.drive();
    expect(await k.order(res.order.id)).toMatchObject({
      status: "chargeback",
      creditCommandId: null,
      details: { chargeback: { state: "charged_back" } },
    });
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/orders/${res.order.id}/burn_uncredited`)
        .set(await headers(carol))
        .send({ reason: "N was never credited" })
        .expect(202),
    ).approval;
    // The poll is due again (RAMP_CLOSED_POLL_HOURS): it re-reads the payment, the order version stays.
    const before = await k.order(res.order.id);
    await ctx.dataSource.query(
      `UPDATE to_ramp_orders SET last_polled_at = now() - interval '20 minutes' WHERE id = $1`,
      [res.order.id],
    );
    await k.fulfilment().scan();
    const after = await k.order(res.order.id);
    const done = (await decide(bob, req, 200)) as { approval: ApiApproval };
    expect(done.approval).toMatchObject({ status: "executed" });
    expect(after.lastPolledAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect([after.version, after.updatedAt.toISOString()]).toEqual([
      before.version,
      before.updatedAt.toISOString(),
    ]);
    await k.drive(2);
    expect(await k.commands(res.order.id)).toMatchObject([
      { commandId: mintId, status: "recorded" },
      { commandId: rampCommandId("cbburn", res.order.id), kind: "burn", status: "recorded" },
    ]);
    await k.expectIdentities();
  });

  it("C31: closing a dead webhook is four-eyes (ramp.event.close): ops asks, an approver closes it; events_dead clears", async () => {
    const delivery = k.mock().delivery("chargeback.created", "mockpay_nobody", null);
    const from = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).length;
    await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set(delivery.headers)
      .send(delivery.rawBody.toString("utf8"))
      .expect(200);
    const [trigger] = ctx.nats.publishedOn(k.WEBHOOK_SUBJECT).slice(from);
    const { eventId } = trigger.payload as { eventId: string };
    expect(await ctx.nats.dispatch(trigger.subject, trigger.payload)).toEqual(["nak"]);
    await ctx.dataSource.query(
      `UPDATE to_ramp_events SET received_at = now() - interval '73 hours' WHERE id = $1`,
      [eventId],
    );
    expect(await ctx.nats.dispatch(trigger.subject, trigger.payload)).toEqual(["term"]);
    const req = bodyOf<{ approval: ApiApproval }>(
      await ctx.agent
        .post(`/api/v1/admin/ramp/events/${eventId}/close`)
        .set(await headers(carol))
        .send({ reason: "not a payment of ours" })
        .expect(202),
    ).approval;
    expect(req).toMatchObject({
      action: "ramp.event.close",
      subjectId: eventId,
      status: "pending",
    });
    const listed = (): Promise<{ items: { id: string }[] }> =>
      headers(carol).then(async (h) =>
        bodyOf(await ctx.agent.get("/api/v1/admin/ramp/events?status=dead").set(h).expect(200)),
      );
    expect((await listed()).items.map((e) => e.id)).toEqual([eventId]);
    // Carol (ops only, and the requester) cannot approve it; Bob, an approver, does.
    await decide(carol, req, 403);
    const done = (await decide(bob, req, 200)) as { result: { event: { closedAt: string } } };
    expect(done.result.event.closedAt).toEqual(expect.any(String));
    expect((await listed()).items).toEqual([]);
    expect(
      await ctx.dataSource.query(
        `SELECT 1 FROM to_audit_events WHERE action = 'ramp.event_closed' AND subject_id = $1`,
        [eventId],
      ),
    ).toHaveLength(1);
  });
});

describe("W9f: a ramp order approval carries the figures it moves (F2/F8)", () => {
  it("F2/F8: ramp.order.refund snapshots the amounts, the user and the card; its description says what it moves and for whom; the audit rows keep both", async () => {
    const orderId = await inReview("figures", "40");
    const order = await k.order(orderId);
    const card = await ctx.dataSource
      .getRepository(RampPaymentMethodEntity)
      .findOneByOrFail({ id: order.paymentMethodId ?? "" });
    const approval = await requestRefund(orderId);
    expect(approval.precondition).toMatchObject({
      id: orderId,
      direction: "onramp",
      userId: order.userId,
      partyId: order.partyId,
      fiatAmount: dec("40"),
      fiatCurrency: "BYN",
      tokenAmount: dec("40"),
      instrument: { admin: TEST_COLLATERAL.admin, id: TEST_COLLATERAL.id },
      destination: {
        kind: "card",
        paymentMethodId: card.id,
        brand: card.brand,
        last4: card.last4,
      },
    });
    const cardText = `card ${[card.brand, `••${card.last4}`].filter(Boolean).join(" ")} (${card.id})`;
    expect(approval.description).toBe(
      `refund 40.00 BYN to ${cardText} of user ${order.userId} (wallet ${order.partyId}); nothing minted (onramp ${orderId} (needs_review, review payment))`,
    );
    // The snapshot's figures never change on the order: a second person approves it unchanged.
    await decide(bob, approval, 200);
    const audit = await ctx.dataSource.query<
      { action: string; metadata: Record<string, unknown> }[]
    >(
      `SELECT action, metadata FROM to_audit_events WHERE subject_id = $1 AND action IN ('admin.approval.requested', 'admin.approval.executed', 'ramp.admin_action') ORDER BY id`,
      [orderId],
    );
    expect(audit.map((a) => a.action)).toEqual([
      "admin.approval.requested",
      "ramp.admin_action",
      "admin.approval.executed",
    ]);
    for (const a of audit.filter((x) => x.action.startsWith("admin.approval.")))
      expect(a.metadata.description).toBe(approval.description);
    expect(audit[1].metadata.figures).toMatchObject({
      fiatAmount: dec("40"),
      fiatCurrency: "BYN",
      tokenAmount: dec("40"),
      userId: order.userId,
      destination: { kind: "card", paymentMethodId: card.id },
    });
    await k.expectIdentities();
  });
});
