import type { AuthedRequest } from "../auth/request";
import type { AdminService } from "../services/admin.service";
import { ApiError } from "../util/errors";
import { AdminController, adminActorOf } from "./admin.controller";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function request(overrides: Partial<AuthedRequest> = {}): AuthedRequest {
  return {
    user: { id: "admin-user" },
    session: { id: "admin-sess" },
    clientIp: "10.0.0.1",
    ...overrides,
  } as unknown as AuthedRequest;
}

describe("adminActorOf", () => {
  it("builds an admin actor from the guarded request", () => {
    expect(adminActorOf(request())).toEqual({ type: "admin", userId: "admin-user", sessionId: "admin-sess", ip: "10.0.0.1" });
    expect(adminActorOf(request({ clientIp: undefined })).ip).toBeNull();
  });

  it("refuses a request that somehow has no session or user", () => {
    for (const bad of [request({ user: undefined }), request({ session: undefined })]) {
      try {
        adminActorOf(bad);
        throw new Error("expected an ApiError");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe("unauthenticated");
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
  const controller = new AdminController(admin as unknown as AdminService);
  const actor = { type: "admin" as const, userId: "admin-user", sessionId: "admin-sess", ip: null };

  it("applies query defaults for the user search", async () => {
    await controller.listUsers({});
    expect(admin.listUsers).toHaveBeenCalledWith("", 1, 25);
    await controller.listUsers({ q: "ada", page: 3, limit: 10 });
    expect(admin.listUsers).toHaveBeenLastCalledWith("ada", 3, 10);
  });

  it("coerces force to a strict boolean on settle", async () => {
    await controller.settlePayout("pp-1", { reason: "why" }, actor);
    expect(admin.settlePayout).toHaveBeenCalledWith("pp-1", { force: false, reason: "why" }, actor);
    await controller.settlePayout("pp-1", { reason: "why", force: true }, actor);
    expect(admin.settlePayout).toHaveBeenLastCalledWith("pp-1", { force: true, reason: "why" }, actor);
  });

  it("passes the payout status filter and builds the audit filter with defaults", async () => {
    await controller.payouts({ status: "failed" });
    expect(admin.listPayouts).toHaveBeenCalledWith("failed");
    await controller.audit({ subjectType: "user", subjectId: USER_ID });
    expect(admin.auditTrail).toHaveBeenCalledWith({ subjectType: "user", subjectId: USER_ID, actorUserId: undefined, page: 1, limit: 25 });
  });
});
