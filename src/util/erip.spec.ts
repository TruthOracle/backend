import { parseAmount } from "./money";
import { eripPaymentNext } from "./erip";
import { payoutReferenceDigits } from "./payout-reference";

describe("eripPaymentNext (SPEC §9.2; H5 re-derivation, S8)", () => {
  it("is the service code, the reference digits as account number and F — the same whoever builds it", () => {
    const reference = "TO123456789012";
    const next = eripPaymentNext({
      serviceCode: "100001",
      reference,
      amount: parseAmount("45.5"),
      currency: "BYN",
      fiatDecimals: 2,
    });
    expect(next).toEqual({
      kind: "erip",
      serviceCode: "100001",
      accountNumber: payoutReferenceDigits(reference),
      amount: "45.5000000000",
      instructions: [
        "Open your bank's app or internet banking and choose Payments → ERIP.",
        "Find the service by its code 100001.",
        `Enter the account number ${payoutReferenceDigits(reference)} and pay exactly 45.50 BYN.`,
      ],
    });
    expect(next).not.toHaveProperty("qrPng");
  });
});
