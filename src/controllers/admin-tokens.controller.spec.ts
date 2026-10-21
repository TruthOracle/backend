import type { Response } from "express";

import type { AuthedRequest } from "../auth/request";
import type { AdminApprovalService } from "../services/admin-approval.service";
import type { TokenOperationsService } from "../services/token-operations.service";
import { ApiError } from "../util/errors";
import { AdminTokensController } from "./admin-tokens.controller";

const INSTRUMENT = { admin: "tro::1220" + "e".repeat(64), id: "TRO" };

function request(): AuthedRequest {
  return {
    user: { id: "admin-user" },
    session: { id: "admin-sess", kind: "admin" },
    clientIp: null,
    adminOperator: {
      party: "op::1220" + "a".repeat(64),
      personId: "ada",
      roles: ["ops"],
      publicKey: null,
    },
  } as unknown as AuthedRequest;
}

function response(): Response & { code?: number } {
  const res = { code: undefined as number | undefined } as Response & { code?: number };
  res.status = ((c: number) => {
    res.code = c;
    return res;
  }) as Response["status"];
  return res;
}

describe("AdminTokensController (SPEC §7, X12 d)", () => {
  it("a mainnet operator mint S1 refuses with details.approvalAction becomes that four-eyes request (202)", async () => {
    const tokens = {
      mint: jest.fn().mockRejectedValue(
        new ApiError(403, "forbidden", "four-eyes on mainnet", {
          approvalAction: "token.admin_mint",
        }),
      ),
    };
    const approvals = { request: jest.fn().mockResolvedValue({ approval: { status: "pending" } }) };
    const controller = new AdminTokensController(
      tokens as unknown as TokenOperationsService,
      approvals as unknown as AdminApprovalService,
    );
    const res = response();
    await expect(
      controller.mint({ instrument: INSTRUMENT, amount: "5", reason: "float" }, request(), res),
    ).resolves.toEqual({ approval: { status: "pending" } });
    expect(res.code).toBe(202);
    expect(approvals.request).toHaveBeenCalledWith(
      {
        action: "token.admin_mint",
        subjectId: `${INSTRUMENT.admin}:${INSTRUMENT.id}`,
        params: { amount: "5", party: "treasury" },
        reason: "float",
      },
      expect.objectContaining({ type: "admin", personId: "ada" }),
    );
  });

  it("any other refusal (the ramp instrument's 403, a validation error) is the route's own answer", async () => {
    const tokens = {
      burn: jest.fn().mockRejectedValue(new ApiError(403, "forbidden", "the ramp instrument")),
    };
    const approvals = { request: jest.fn() };
    const controller = new AdminTokensController(
      tokens as unknown as TokenOperationsService,
      approvals as unknown as AdminApprovalService,
    );
    await expect(
      controller.burn(
        { instrument: INSTRUMENT, amount: "1", party: "x::1220" + "b".repeat(64), reason: "r" },
        request(),
        response(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(approvals.request).not.toHaveBeenCalled();
  });
});
