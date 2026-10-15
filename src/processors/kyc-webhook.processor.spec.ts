import {
  KYC_WEBHOOK_MAX_ATTEMPTS,
  KYC_WEBHOOK_NAK_DELAY_MAX_MS,
  kycWebhookNakDelayMs,
} from "./kyc-webhook.processor";

describe("KycWebhookProcessor retry schedule", () => {
  it("doubles from 5 s and caps at 10 min, giving a horizon of hours rather than 100 s", () => {
    expect(kycWebhookNakDelayMs(1)).toBe(5_000);
    expect(kycWebhookNakDelayMs(2)).toBe(10_000);
    expect(kycWebhookNakDelayMs(7)).toBe(320_000);
    expect(kycWebhookNakDelayMs(8)).toBe(KYC_WEBHOOK_NAK_DELAY_MAX_MS);
    expect(kycWebhookNakDelayMs(KYC_WEBHOOK_MAX_ATTEMPTS)).toBe(KYC_WEBHOOK_NAK_DELAY_MAX_MS);
    let total = 0;
    for (let n = 1; n < KYC_WEBHOOK_MAX_ATTEMPTS; n += 1) total += kycWebhookNakDelayMs(n);
    expect(total).toBeGreaterThan(2 * 60 * 60_000);
  });
});
