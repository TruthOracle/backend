import type { AuthedRequest } from "../auth/request";
import type { Config } from "../config";
import type { AdminApprovalService } from "../services/admin-approval.service";
import type { AdminService } from "../services/admin.service";
import type { RampApprovalActions } from "../services/ramp-approval-actions.service";
import type { KycProvider } from "../types";
import { ApiError } from "../util/errors";
import { AdminController, adminActorOf } from "./admin.controller";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const OPERATOR = {
  party: "op::1220" + "a".repeat(64),
  personId: "ada",
  roles: ["ops", "approver"],
  publicKey: null,
} as const;

function request(overrides: Partial<AuthedRequest> = {}): AuthedRequest {
  return {
    user: { id: "admin-user" },
    session: { id: "admin-sess", kind: "admin" },
    clientIp: "10.0.0.1",
    adminOperator: { ...OPERATOR, roles: [...OPERATOR.roles] },
    ...overrides,
  } as unknown as AuthedRequest;
}

describe("adminActorOf", () => {
  it("builds an admin actor from the guarded request, with the operator's party, person and roles", () => {
    expect(adminActorOf(request())).toEqual({
      type: "admin",
      userId: "admin-user",
      sessionId: "admin-sess",
      ip: "10.0.0.1",
      operatorParty: OPERATOR.party,
      personId: "ada",
      roles: ["ops", "approver"],
      publicKey: null,
    });
    expect(adminActorOf(request({ clientIp: undefined })).ip).toBeNull();
  });

  it("refuses a request that somehow has no session or user (401) or a user session (403)", () => {
    for (const [bad, code] of [
      [request({ user: undefined }), "unauthenticated"],
      [request({ session: undefined }), "unauthenticated"],
      [
        request({ session: { id: "s", kind: "user" } as unknown as AuthedRequest["session"] }),
        "forbidden",
      ],
    ] as const) {
      try {
        adminActorOf(bad);
        throw new Error("expected an ApiError");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe(code);
      }
    }
  });
});

describe("AdminController", () => {
  const admin = {
    listUsers: jest.fn().mockResolvedValue({ items: [], page: 1, limit: 25, total: 0 }),
    settlePayout: jest.fn().mockResolvedValue({ payout: {}, mode: "external" }),
    auditTrail: jest.fn().mockResolvedValue({ items: [], page: 1, limit: 25, total: 0 }),
    listPayouts: jest.fn().mockResolvedValue({ items: [] }),
  };
  const config = {
    kycRequiredLevel: "basic-kyc-level",
    kycEnforceWithdrawals: false,
  } as unknown as Config;
  const provider = {
    name: "mock",
    isConfigured: () => true,
    healthCheck: async () => ({
      ok: true,
      message: "mock",
      upstreamStatus: null,
      checkedAt: "now",
      details: {},
    }),
  } as unknown as KycProvider;
  const approvals = {
    request: jest.fn().mockResolvedValue({ approval: { status: "pending" } }),
  };
  const controller = new AdminController(
    admin as unknown as AdminService,
    config,
    provider,
    approvals as unknown as AdminApprovalService,
    {} as unknown as RampApprovalActions,
  );
  const req = request({ clientIp: undefined });
  const actor = {
    type: "admin" as const,
    userId: "admin-user",
    sessionId: "admin-sess",
    ip: null,
    operatorParty: OPERATOR.party,
    personId: "ada",
    roles: ["ops", "approver"],
    publicKey: null,
  };

  it("applies query defaults for the user search", async () => {
    await controller.listUsers({});
    expect(admin.listUsers).toHaveBeenCalledWith("", 1, 25);
    await controller.listUsers({ q: "ada", page: 3, limit: 10 });
    expect(admin.listUsers).toHaveBeenLastCalledWith("ada", 3, 10);
  });

  it("settles directly without force; force is the four-eyes payout.force_settle (SPEC §6.5)", async () => {
    await controller.settlePayout({ cid: "pp-1" }, { reason: "why" }, req);
    expect(admin.settlePayout).toHaveBeenCalledWith("pp-1", { force: false, reason: "why" }, actor);
    await expect(
      controller.settlePayout({ cid: "pp-1" }, { reason: "why", force: true }, req),
    ).resolves.toEqual({ approval: { status: "pending" } });
    expect(admin.settlePayout).toHaveBeenCalledTimes(1);
    expect(approvals.request).toHaveBeenCalledWith(
      { action: "payout.force_settle", subjectId: "pp-1", reason: "why" },
      actor,
    );
  });

  it("passes the payout status filter and builds the audit filter with defaults", async () => {
    await controller.payouts({ status: "failed" });
    expect(admin.listPayouts).toHaveBeenCalledWith("failed");
    await controller.audit({ subjectType: "user", subjectId: USER_ID });
    expect(admin.auditTrail).toHaveBeenCalledWith({
      subjectType: "user",
      subjectId: USER_ID,
      actorUserId: undefined,
      page: 1,
      limit: 25,
    });
  });
});

describe("AdminController — KYC provider status", () => {
  it("reports the provider wiring around the health probe", async () => {
    const admin = {} as unknown as AdminService;
    const config = { kycRequiredLevel: "lvl", kycEnforceWithdrawals: true } as unknown as Config;
    const provider = {
      name: "sumsub",
      isConfigured: () => false,
      healthCheck: async () => ({
        ok: false,
        message: "unset",
        upstreamStatus: null,
        checkedAt: "now",
        details: { a: 1 },
      }),
    } as unknown as KycProvider;
    await expect(
      new AdminController(admin, config, provider, {} as never, {} as never).kycProviderStatus(),
    ).resolves.toEqual({
      provider: "sumsub",
      configured: false,
      levelName: "lvl",
      enforceWithdrawals: true,
      webhookPath: "/api/v1/webhooks/kyc/sumsub",
      health: {
        ok: false,
        message: "unset",
        upstreamStatus: null,
        checkedAt: "now",
        details: { a: 1 },
      },
    });
  });
});
