import { BadRequestException, type Type, ValidationPipe } from "@nestjs/common";

import {
  AdminAuditQueryDto,
  AdminKycOverrideDto,
  AdminPayoutSettleDto,
  AdminPayoutsQueryDto,
  AdminPersonTransferDto,
  AdminReasonDto,
  AdminUsersQueryDto,
} from "./admin.dto";

/** Same options as AppModule's global pipe (whitelist + forbidNonWhitelisted + transform). */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const UUID = "11111111-1111-4111-8111-111111111111";

async function run<T>(
  metatype: Type<unknown>,
  value: unknown,
  type: "body" | "query" = "body",
): Promise<T> {
  return (await pipe.transform(value, { type, metatype })) as T;
}

async function issues(
  metatype: Type<unknown>,
  value: unknown,
  type: "body" | "query" = "body",
): Promise<string[]> {
  try {
    await pipe.transform(value, { type, metatype });
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    const response = (err as BadRequestException).getResponse() as { message: string[] };
    return response.message;
  }
  throw new Error("expected validation to fail");
}

describe("admin DTOs", () => {
  it("AdminReasonDto: reason is required, trimmed and capped", async () => {
    await expect(run<AdminReasonDto>(AdminReasonDto, { reason: "  abuse  " })).resolves.toEqual({
      reason: "abuse",
    });
    expect(await issues(AdminReasonDto, {})).toEqual(
      expect.arrayContaining([expect.stringMatching(/reason/)]),
    );
    expect(await issues(AdminReasonDto, { reason: "   " })).toEqual(
      expect.arrayContaining([expect.stringMatching(/reason is required/)]),
    );
    expect(await issues(AdminReasonDto, { reason: "x".repeat(501) })).toEqual(
      expect.arrayContaining([expect.stringMatching(/shorter than or equal to 500/)]),
    );
    expect(await issues(AdminReasonDto, { reason: 5 })).toEqual(
      expect.arrayContaining([expect.stringMatching(/string/)]),
    );
    // Unknown keys are refused so an operator cannot smuggle fields past the allow-list.
    expect(await issues(AdminReasonDto, { reason: "ok", force: true })).toEqual(
      expect.arrayContaining([expect.stringMatching(/force/)]),
    );
  });

  it("AdminKycOverrideDto: only approved / rejected_final / expired", async () => {
    await expect(
      run<AdminKycOverrideDto>(AdminKycOverrideDto, {
        status: "expired",
        reason: "renewal lapsed",
      }),
    ).resolves.toEqual({ status: "expired", reason: "renewal lapsed" });
    expect(await issues(AdminKycOverrideDto, { status: "pending", reason: "x" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/status must be one of/)]),
    );
    expect(await issues(AdminKycOverrideDto, { status: "approved" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/reason/)]),
    );
  });

  it("AdminPersonTransferDto: toUserId must be a UUID", async () => {
    await expect(
      run<AdminPersonTransferDto>(AdminPersonTransferDto, { toUserId: UUID, reason: "merge" }),
    ).resolves.toEqual({ toUserId: UUID, reason: "merge" });
    expect(await issues(AdminPersonTransferDto, { toUserId: "nope", reason: "merge" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/UUID/i)]),
    );
  });

  it("AdminPayoutSettleDto: force is an optional strict boolean", async () => {
    await expect(
      run<AdminPayoutSettleDto>(AdminPayoutSettleDto, { reason: "stuck" }),
    ).resolves.toEqual({ reason: "stuck" });
    await expect(
      run<AdminPayoutSettleDto>(AdminPayoutSettleDto, { reason: "stuck", force: true }),
    ).resolves.toEqual({ reason: "stuck", force: true });
    expect(await issues(AdminPayoutSettleDto, { reason: "stuck", force: "yes" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/boolean/)]),
    );
  });

  it("AdminPayoutsQueryDto: status is a closed list", async () => {
    await expect(run<AdminPayoutsQueryDto>(AdminPayoutsQueryDto, {}, "query")).resolves.toEqual({});
    await expect(
      run<AdminPayoutsQueryDto>(AdminPayoutsQueryDto, { status: "blocked_kyc" }, "query"),
    ).resolves.toEqual({ status: "blocked_kyc" });
    expect(await issues(AdminPayoutsQueryDto, { status: "bogus" }, "query")).toEqual(
      expect.arrayContaining([expect.stringMatching(/status must be one of/)]),
    );
  });

  it("AdminUsersQueryDto: page/limit coerced from strings, q trimmed, unknown keys refused", async () => {
    await expect(
      run<AdminUsersQueryDto>(AdminUsersQueryDto, { q: " ada ", page: "2", limit: "10" }, "query"),
    ).resolves.toEqual({ q: "ada", page: 2, limit: 10 });
    expect(await issues(AdminUsersQueryDto, { page: "0" }, "query")).toEqual(
      expect.arrayContaining([expect.stringMatching(/page/)]),
    );
    expect(await issues(AdminUsersQueryDto, { limit: "1000" }, "query")).toEqual(
      expect.arrayContaining([expect.stringMatching(/limit/)]),
    );
    expect(await issues(AdminUsersQueryDto, { sort: "email" }, "query")).toEqual(
      expect.arrayContaining([expect.stringMatching(/sort/)]),
    );
  });

  it("AdminAuditQueryDto: actorUserId must be a UUID; subject filters are trimmed", async () => {
    await expect(
      run<AdminAuditQueryDto>(
        AdminAuditQueryDto,
        { subjectType: " user ", subjectId: UUID, actorUserId: UUID },
        "query",
      ),
    ).resolves.toEqual({ subjectType: "user", subjectId: UUID, actorUserId: UUID });
    expect(await issues(AdminAuditQueryDto, { actorUserId: "me" }, "query")).toEqual(
      expect.arrayContaining([expect.stringMatching(/UUID/i)]),
    );
  });
});
