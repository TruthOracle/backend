import { sanitizeMetadata } from "./audit.service";

describe("AuditService.sanitizeMetadata", () => {
  it("renders every bigint as the 10-decimal money string (one money encoding across the whole trail)", () => {
    expect(
      sanitizeMetadata({ amountCC: 125_000_000_000n, count: 3, label: "x", zero: 0n }),
    ).toEqual({ amountCC: "12.5000000000", count: 3, label: "x", zero: "0.0000000000" });
  });

  it("drops forbidden keys and undefined values", () => {
    expect(
      sanitizeMetadata({
        token: "t",
        signature: "s",
        publicKey: "k",
        firstName: "a",
        email: "e",
        keep: 1,
        gone: undefined,
      }),
    ).toEqual({ keep: 1 });
  });
});
