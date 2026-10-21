import type { RampPaymentNext } from "../types";
import { formatAmount, formatAmountWithDecimals } from "./money";
import { payoutReferenceDigits } from "./payout-reference";

/** The ERIP details a user pays an on-ramp with (SPEC §9.2). */
export type EripPaymentNext = Extract<RampPaymentNext, { kind: "erip" }>;

/**
 * ERIP payment details from what we own: the merchant's service code, the order's reference digits
 * as the account number and F. The mock acquirer answers with them; an ERIP order adopted after a
 * lost createPayment answer gets them re-derived (H5, S8) — the acquirer's QR and bank links are
 * not re-derivable, the rest is the same whoever builds it.
 */
export function eripPaymentNext(input: {
  serviceCode: string;
  reference: string;
  amount: bigint;
  currency: string;
  fiatDecimals: number;
}): EripPaymentNext {
  const accountNumber = payoutReferenceDigits(input.reference);
  const shown = formatAmountWithDecimals(input.amount, input.fiatDecimals);
  return {
    kind: "erip",
    serviceCode: input.serviceCode,
    accountNumber,
    amount: formatAmount(input.amount),
    instructions: [
      "Open your bank's app or internet banking and choose Payments → ERIP.",
      `Find the service by its code ${input.serviceCode}.`,
      `Enter the account number ${accountNumber} and pay exactly ${shown} ${input.currency}.`,
    ],
  };
}
