import { generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { FindOperator } from "typeorm";

import type { Config } from "../config";
import type { AdminApprovalEntity } from "../entities/admin-approval.entity";
import type { AdminRole } from "../types";
import { partyFingerprintFromPublicKey } from "../util/canton-crypto";
import { ApiError } from "../util/errors";
import type { AdminActor } from "./admin.service";
import { approvalMessage } from "./admin-approval.logic";
import {
  AdminApprovalService,
  type ApprovalActionDefinition,
  requestMessage,
} from "./admin-approval.service";

// ───────────────────────────── an in-memory to_admin_approvals ─────────────────────────────

type Row = AdminApprovalEntity;

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const value = (row as unknown as Record<string, unknown>)[k];
    if (v instanceof FindOperator) {
      if (v.type === "in") return (v.value as unknown[]).includes(value);
      if (v.type === "lessThan") return (value as Date).getTime() < (v.value as Date).getTime();
      throw new Error(`fake repo: operator ${v.type}`);
    }
    return value === v;
  });
}

class FakeRepo {
  readonly rows: Row[] = [];
  create(o: Partial<Row>): Row {
    return { ...o } as Row;
  }
  async save(o: Row): Promise<Row> {
    if (
      o.status === "pending" &&
      this.rows.some(
        (r) =>
          r.id !== o.id &&
          r.status === "pending" &&
          r.action === o.action &&
          r.subjectType === o.subjectType &&
          r.subjectId === o.subjectId,
      )
    )
      throw new Error(
        "duplicate key value violates unique constraint uq_to_admin_approvals_pending",
      );
    const defaults: Partial<Row> = {
      decidedByUserId: null,
      decidedByParty: null,
      decidedByPerson: null,
      decidedAt: null,
      decisionReason: null,
      decisionSignature: null,
      executedAt: null,
      result: null,
      error: null,
    };
    const row: Row = Object.assign({}, defaults, o);
    row.id ??= randomUUID();
    this.rows.push(row);
    return { ...row };
  }
  async findOneBy(where: Record<string, unknown>): Promise<Row | null> {
    const r = this.rows.find((x) => matches(x, where));
    return r ? { ...r } : null;
  }
  async findOneByOrFail(where: Record<string, unknown>): Promise<Row> {
    const r = await this.findOneBy(where);
    if (!r) throw new Error("not found");
    return r;
  }
  async findBy(where: Record<string, unknown>): Promise<Row[]> {
    return this.rows.filter((x) => matches(x, where)).map((r) => ({ ...r }));
  }
  async find(opts: { where: Record<string, unknown> }): Promise<Row[]> {
    return this.findBy(opts.where);
  }
  async update(where: Record<string, unknown>, patch: Partial<Row>): Promise<{ affected: number }> {
    const hits = this.rows.filter((x) => matches(x, where));
    for (const h of hits) Object.assign(h, patch);
    return { affected: hits.length };
  }
}

// ───────────────────────────── operators ─────────────────────────────

function wallet(hint: string): { party: string; publicKey: string; sign: (m: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    party: `${hint}::${partyFingerprintFromPublicKey(raw)}`,
    publicKey: raw.toString("base64"),
    sign: (m) => cryptoSign(null, Buffer.from(m, "utf8"), privateKey).toString("base64"),
  };
}

function operator(
  person: string,
  roles: AdminRole[],
  w = wallet(person),
): AdminActor & { w: typeof w } {
  return {
    type: "admin",
    userId: randomUUID(),
    sessionId: randomUUID(),
    ip: null,
    operatorParty: w.party,
    personId: person,
    roles,
    publicKey: w.publicKey,
    w,
  };
}

const SUBJECT_USER = "6f1c2a3e-0000-4000-8000-0000000000aa";

function setup(
  opts: { dualControl?: boolean; signatures?: boolean; accounts?: Map<string, string[]> } = {},
) {
  const repo = new FakeRepo();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const redis = { acquireLock: async () => ({ acquired: true, release: async () => undefined }) };
  const config = {
    rampControls: {
      dualControl: opts.dualControl ?? true,
      approvalSignatures: opts.signatures ?? false,
      approvalTtlBdays: 2,
      operatorAccounts: opts.accounts ?? new Map(),
      bankHolidays: [],
      bankWorkdays: [],
    },
  } as unknown as Config;
  const service = new AdminApprovalService(
    config,
    {} as never,
    repo as never,
    audit as never,
    redis as never,
  );
  // A subject whose state the test controls: version bumps = the subject changed.
  const subject = { version: 1, valid: true, failExecute: false };
  // Each subject's version bumps when an action on it executes (another subject is not affected).
  const versions = new Map<string, number>();
  const execute = jest.fn(async (_p: unknown, _s: unknown, ctx: { subjectId: string }) => {
    if (subject.failExecute) throw new ApiError(409, "ramp_order_state", "the order moved");
    versions.set(ctx.subjectId, (versions.get(ctx.subjectId) ?? subject.version) + 1);
    return { id: "order-1", status: "refunding" };
  });
  const definition: ApprovalActionDefinition<
    Record<string, unknown>,
    { version: number },
    unknown
  > = {
    action: "test.refund",
    subjectType: "ramp_order",
    requestRoles: ["ops"],
    snapshot: async (id) => ({ version: versions.get(id) ?? subject.version }),
    validate: async () => {
      if (!subject.valid) throw new ApiError(409, "ramp_order_state", "not refundable any more");
    },
    describe: () => "refund the capture",
    subjectUser: async () => SUBJECT_USER,
    execute,
  };
  service.register(definition);
  return { service, repo, audit, subject, execute };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err.code;
    throw err;
  }
  throw new Error("expected an ApiError");
}

describe("AdminApprovalService (SPEC §6.5 four-eyes)", () => {
  const alice = operator("alice", ["ops", "approver"]);
  const alice2 = operator("alice", ["ops", "approver"]); // the same person behind a second party
  const bob = operator("bob", ["approver"]);
  const carol = operator("carol", ["ops"]);

  it("A requests; A, A's second party and a non-approver cannot approve; B approves and it executes once", async () => {
    const { service, execute, audit } = setup();
    const req = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "card refund" },
      alice,
    );
    expect(req.approval).toMatchObject({
      status: "pending",
      singleControl: false,
      requestedByPerson: "alice",
    });
    expect(req.result).toBeUndefined();
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, alice))).toBe(
      "approval_self",
    );
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, alice2))).toBe(
      "approval_same_person",
    );
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, carol))).toBe(
      "approval_role_required",
    );
    const done = await service.approve(req.approval.id, { reason: "verified" }, bob);
    expect(done.approval).toMatchObject({
      status: "executed",
      decidedByPerson: "bob",
      decisionReason: "verified",
    });
    expect(done.result).toEqual({ id: "order-1", status: "refunding" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]).toEqual([
      {},
      { version: 1 },
      expect.objectContaining({ actor: bob, reason: "card refund" }),
    ]);
    expect(audit.record.mock.calls.map((c: [{ action: string }]) => c[0].action)).toEqual([
      "admin.approval.requested",
      "admin.approval.executed",
    ]);
    expect(await code(service.approve(req.approval.id, { reason: "again" }, bob))).toBe(
      "approval_not_pending",
    );
  });

  it("a request needs its roles; the same request answers the pending one, other params are 409 approval_pending", async () => {
    const { service } = setup();
    expect(
      await code(
        service.request({ action: "test.refund", subjectId: "order-1", reason: "x" }, bob),
      ),
    ).toBe("role_required");
    const first = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    const again = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "y" },
      carol,
    );
    expect(again.approval.id).toBe(first.approval.id);
    expect(
      await code(
        service.request(
          { action: "test.refund", subjectId: "order-1", params: { a: 1 }, reason: "z" },
          alice,
        ),
      ),
    ).toBe("approval_pending");
  });

  it("a person linked to the subject's account can neither request nor approve (I8)", async () => {
    const accounts = new Map([
      ["carol", [SUBJECT_USER]],
      ["bob", [SUBJECT_USER]],
    ]);
    const { service } = setup({ accounts });
    expect(
      await code(
        service.request({ action: "test.refund", subjectId: "order-1", reason: "x" }, carol),
      ),
    ).toBe("approval_linked_person");
    const req = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, bob))).toBe(
      "approval_linked_person",
    );
  });

  it("W9g: an action's conflict hook (I8 beyond one account) is asked of the requester at request, of both persons at approval and again before execute — each person once, with their linked accounts", async () => {
    const BOB_OWN = "6f1c2a3e-0000-4000-8000-0000000000bb";
    const { service } = setup({ accounts: new Map([["bob", [BOB_OWN]]]) });
    const stake = (person: string) => ({
      status: 403,
      code: "approval_linked_person" as const,
      message: `${person} holds a stake`,
      details: { person, reason: "position_in_market" },
    });
    const conflict = jest
      .fn()
      .mockResolvedValueOnce(stake("carol")) // carol's first request
      .mockResolvedValueOnce(null) // carol's second request
      .mockResolvedValueOnce(stake("bob")) // bob's first approval
      .mockResolvedValueOnce(null) // bob's second approval
      .mockResolvedValueOnce(stake("bob")); // under the subject lock, before execute
    const execute = jest.fn(async () => ({ ok: true }));
    service.register({
      action: "test.resolve",
      subjectType: "market",
      requestRoles: ["ops"],
      snapshot: async () => ({}),
      validate: async () => undefined,
      describe: () => "resolve market 15",
      conflict,
      execute,
    });
    const ask = () =>
      service.request({ action: "test.resolve", subjectId: "15", reason: "resolve" }, carol);
    expect(await code(ask())).toBe("approval_linked_person");
    const req = await ask();
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, bob))).toBe(
      "approval_linked_person",
    );
    expect((await service.get(req.approval.id)).status).toBe("pending");
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, bob))).toBe(
      "approval_precondition_changed",
    );
    expect((await service.get(req.approval.id)).status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
    const asked = (person: { personId: string; operatorParty: string; userId: string }) => ({
      person: person.personId,
      party: person.operatorParty,
      userIds: [person.userId, ...(person.personId === "bob" ? [BOB_OWN] : [])],
    });
    expect(conflict.mock.calls.map((c: unknown[]) => [c[0], c[3]])).toEqual([
      ["15", [asked(carol)]],
      ["15", [asked(carol)]],
      ["15", [asked(bob), asked(carol)]],
      ["15", [asked(bob), asked(carol)]],
      ["15", [asked(bob), asked(carol)]],
    ]);
  });

  it("an approval past its business-day TTL is expired, not executed", async () => {
    const { service, repo, execute } = setup();
    const req = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    expect(new Date(req.approval.expiresAt).toISOString()).toMatch(/T20:59:59\.000Z$/);
    repo.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await code(service.approve(req.approval.id, { reason: "late" }, bob))).toBe(
      "approval_expired",
    );
    expect(repo.rows[0].status).toBe("expired");
    expect(execute).not.toHaveBeenCalled();
  });

  it("a subject that changed since the request (snapshot or fresh validate) fails the approval: approval_precondition_changed", async () => {
    const { service, repo, subject, execute } = setup();
    const req = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    subject.version = 2;
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, bob))).toBe(
      "approval_precondition_changed",
    );
    expect(repo.rows[0]).toMatchObject({ status: "failed" });
    // An equal snapshot is necessary, not sufficient: the fresh validate must pass too.
    const again = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    subject.valid = false;
    expect(await code(service.approve(again.approval.id, { reason: "ok" }, bob))).toBe(
      "approval_precondition_changed",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("an action that throws on execution leaves the approval failed: approval_failed (the requester's single-control call answers its own error)", async () => {
    const { service, subject } = setup();
    const req = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    subject.failExecute = true;
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, bob))).toBe(
      "approval_failed",
    );
    const single = setup({ dualControl: false });
    single.subject.failExecute = true;
    expect(
      await code(
        single.service.request({ action: "test.refund", subjectId: "order-1", reason: "x" }, alice),
      ),
    ).toBe("ramp_order_state");
    expect(single.repo.rows[0].status).toBe("failed");
  });

  it("RAMP_DUAL_CONTROL=false executes at once, single_control, through the same path", async () => {
    const { service, execute } = setup({ dualControl: false });
    const out = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    expect(out.approval).toMatchObject({
      status: "executed",
      singleControl: true,
      decidedByPerson: "alice",
    });
    expect(out.result).toEqual({ id: "order-1", status: "refunding" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("with signatures on, a decision carries the approver's wallet signature over the exact message", async () => {
    const { service } = setup({ signatures: true });
    const req = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    const message = approvalMessage(req.approval.id, req.approval.paramsHash, "approve");
    expect(message).toBe(
      `truthoracle-approval:${req.approval.id}:${req.approval.paramsHash}:approve`,
    );
    expect(await code(service.approve(req.approval.id, { reason: "ok" }, bob))).toBe(
      "approval_signature_required",
    );
    // Signed by someone else, or signed for "reject": refused.
    expect(
      await code(
        service.approve(req.approval.id, { reason: "ok", signature: alice.w.sign(message) }, bob),
      ),
    ).toBe("approval_signature_invalid");
    const rejectMsg = approvalMessage(req.approval.id, req.approval.paramsHash, "reject");
    expect(
      await code(
        service.approve(req.approval.id, { reason: "ok", signature: bob.w.sign(rejectMsg) }, bob),
      ),
    ).toBe("approval_signature_invalid");
    const done = await service.approve(
      req.approval.id,
      { reason: "ok", signature: bob.w.sign(message) },
      bob,
    );
    expect(done.approval.status).toBe("executed");
  });

  it("C23: with signatures on, a single-control decision that releases value is signed over the request (nothing saved unsigned); others are not", async () => {
    for (const signatures of [false, true]) {
      const { service, repo } = setup({ signatures });
      const state = { status: "open" };
      service.register<{ decision: string }, { status: string }, unknown>({
        action: "test.clear",
        subjectType: "compliance_alert",
        requestRoles: ["ops"],
        params: (raw) => ({ decision: String(raw.decision) }),
        singleControl: () => true,
        signSingleControl: (p) => p.decision === "clear",
        snapshot: async () => ({ ...state }),
        validate: async () => undefined,
        describe: (p) => `${p.decision} it`,
        execute: async (p) => {
          state.status = p.decision;
          return { status: p.decision };
        },
      });
      const ask = (decision: string, signature?: string) =>
        service.request(
          {
            action: "test.clear",
            subjectId: "alert-1",
            params: { decision },
            reason: "x",
            signature,
          },
          carol,
        );
      if (!signatures) {
        expect((await ask("clear")).approval.status).toBe("executed");
        continue;
      }
      const missing = await ask("clear").catch((e: unknown) => e as ApiError);
      expect(missing).toMatchObject({ status: 400, code: "approval_signature_required" });
      const message = (missing as ApiError).details?.message as string;
      expect(message).toMatch(
        /^truthoracle-approval:request:test\.clear:alert-1:[0-9a-f]{64}:[0-9a-f]{64}$/,
      );
      expect(
        requestMessage("test.clear", "alert-1", message.split(":")[4], { status: "open" }),
      ).toBe(message);
      expect(repo.rows).toHaveLength(0);
      expect(await code(ask("clear", bob.w.sign(message)))).toBe("approval_signature_invalid");
      expect(repo.rows).toHaveLength(0);
      const done = await ask("clear", carol.w.sign(message));
      expect(done.approval).toMatchObject({ status: "executed", singleControl: true });
      expect(repo.rows[0].decisionSignature).toBe(carol.w.sign(message));
      // The same signature no longer verifies once the subject moved (its state is in the message).
      expect(state.status).toBe("clear");
      expect(await code(ask("clear", carol.w.sign(message)))).toBe("approval_signature_invalid");
      // A decision that keeps the hold is not signed.
      expect((await ask("escalate")).approval.status).toBe("executed");
    }
  });

  it("reject: the requester cancels; another approver rejects; someone without the role cannot", async () => {
    const { service } = setup();
    const a = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    expect((await service.reject(a.approval.id, { reason: "typo" }, alice2)).approval.status).toBe(
      "cancelled",
    );
    const b = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    expect(await code(service.reject(b.approval.id, { reason: "no" }, carol))).toBe(
      "approval_role_required",
    );
    expect((await service.reject(b.approval.id, { reason: "no" }, bob)).approval).toMatchObject({
      status: "rejected",
      decidedByPerson: "bob",
    });
  });

  it("approve-many decides one action type, each id on its own", async () => {
    const { service } = setup();
    const one = await service.request(
      { action: "test.refund", subjectId: "order-1", reason: "x" },
      alice,
    );
    const two = await service.request(
      { action: "test.refund", subjectId: "order-2", reason: "x" },
      alice,
    );
    const out = await service.approveMany(
      { ids: [one.approval.id, two.approval.id, randomUUID()], reason: "batch" },
      bob,
    );
    expect(out.results.map((r) => r.approval?.status ?? r.error?.error)).toEqual([
      "executed",
      "executed",
      "not_found",
    ]);
  });
});
