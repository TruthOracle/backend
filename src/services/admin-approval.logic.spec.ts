import { BusinessCalendar } from "../util/by-calendar";
import {
  approvalMessage,
  approveRefusal,
  canonicalJson,
  expiresAtFor,
  linkedRefusal,
  paramsHashOf,
} from "./admin-approval.logic";

describe("four-eyes rules (SPEC §6.5)", () => {
  it("the params hash is canonical: key order, bigint and Date forms do not change it; any value does", () => {
    const base = { action: "payout.mark_paid", subjectType: "payout", subjectId: "00ab" };
    const h1 = paramsHashOf({
      ...base,
      params: { txHash: "x", n: 5n, at: new Date("2026-10-19T00:00:00Z") },
    });
    const h2 = paramsHashOf({
      ...base,
      params: { at: "2026-10-19T00:00:00.000Z", n: "5", txHash: "x" },
    });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(
      paramsHashOf({
        ...base,
        params: { txHash: "y", n: 5n, at: new Date("2026-10-19T00:00:00Z") },
      }),
    ).not.toBe(h1);
    expect(paramsHashOf({ ...base, subjectId: "00ac", params: { txHash: "x" } })).not.toBe(
      paramsHashOf({ ...base, params: { txHash: "x" } }),
    );
    expect(canonicalJson({ b: { d: 1, c: [2, { f: 1, e: 0 }] }, a: undefined })).toBe(
      '{"b":{"c":[2,{"e":0,"f":1}],"d":1}}',
    );
  });

  it("the signed message names the approval, its params hash and the decision", () => {
    expect(approvalMessage("id-1", "ab".repeat(32), "reject")).toBe(
      `truthoracle-approval:id-1:${"ab".repeat(32)}:reject`,
    );
  });

  it("a request expires at 23:59:59 Minsk of the second business day — a Friday request lives over the weekend (M9)", () => {
    // Friday 2026-10-23 15:00 Minsk → Mon (1), Tue (2) → Tuesday 20:59:59 UTC.
    expect(
      expiresAtFor(new Date("2026-10-23T12:00:00Z"), 2, new BusinessCalendar()).toISOString(),
    ).toBe("2026-10-27T20:59:59.000Z");
    // With Tuesday a holiday the second business day is Wednesday.
    expect(
      expiresAtFor(
        new Date("2026-10-23T12:00:00Z"),
        2,
        new BusinessCalendar(["2026-10-27"]),
      ).toISOString(),
    ).toBe("2026-10-28T20:59:59.000Z");
    // Saturday: counting starts on Monday.
    expect(
      expiresAtFor(new Date("2026-10-24T08:00:00Z"), 1, new BusinessCalendar()).toISOString(),
    ).toBe("2026-10-26T20:59:59.000Z");
  });

  it("approve: never the requester (user, party or PERSON), always the approve roles, nobody linked to the subject", () => {
    const requester = { userId: "u-a", party: "a::1", person: "alice" };
    const approver = { userId: "u-b", party: "b::1", person: "bob", roles: ["approver" as const] };
    const accounts = new Map([["bob", ["U-SUBJECT"]]]);
    const base = {
      requester,
      approveRoles: ["approver" as const],
      subjectUserId: null,
      accounts: new Map(),
    };
    expect(approveRefusal({ ...base, approver })).toBeNull();
    expect(approveRefusal({ ...base, approver: { ...approver, party: "a::1" } })?.code).toBe(
      "approval_self",
    );
    expect(approveRefusal({ ...base, approver: { ...approver, person: "alice" } })?.code).toBe(
      "approval_same_person",
    );
    expect(approveRefusal({ ...base, approver: { ...approver, roles: ["ops"] } })).toMatchObject({
      code: "approval_role_required",
      details: { role: "approver" },
    });
    expect(approveRefusal({ ...base, approver, subjectUserId: "u-subject", accounts })?.code).toBe(
      "approval_linked_person",
    );
    // The requester's links count at approval too, and an operator's own admin user is "linked" to itself.
    expect(linkedRefusal("u-a", [requester], new Map())?.code).toBe("approval_linked_person");
    expect(linkedRefusal(null, [requester], accounts)).toBeNull();
  });
});
