import type { RampMethod, RampOrderStatus } from "../types";
import { BusinessCalendar } from "../util/by-calendar";
import { stuckReason } from "./ramp-recon-checks.logic";
import { stuckCutoffs } from "./ramp-recon-checks.service";

const HOUR_MS = 3_600_000;

/**
 * The SQL pre-filter of no_stuck_orders (C45) must never drop an order `stuckReason` calls stuck:
 * an order changed AT its status' cut-off (or later) is not stuck, and for the business-day
 * statuses one changed just before it is (exact, so a weekend cannot fill the scan's window).
 */
describe("stuckCutoffs (C45) against stuckReason", () => {
  // Holidays (a Wednesday, a Saturday) and a transferred working Saturday inside the span.
  const calendar = new BusinessCalendar(["2026-11-04", "2026-11-07"], ["2026-11-14"]);
  const ctx = { calendar, confirmMin: 30, stuckAfterMin: 30, bankSettleDays: 3 };
  // Every 5 hours for five weeks: every weekday, weekend and Minsk midnight neighbourhood.
  const nows = Array.from(
    { length: 168 },
    (_, i) => new Date(Date.parse("2026-10-30T00:30:00Z") + i * 5 * HOUR_MS),
  );
  const stuck = (
    status: RampOrderStatus,
    changed: Date,
    now: Date,
    extra: { expiresAt?: Date; method?: RampMethod; bankSettleDays?: number } = {},
  ): boolean =>
    stuckReason(
      {
        status,
        statusChangedAt: changed,
        expiresAt: extra.expiresAt ?? null,
        held: false,
        method: extra.method ?? null,
      },
      { ...ctx, now, bankSettleDays: extra.bankSettleDays ?? ctx.bankSettleDays },
    ) !== null;
  const before = (d: Date): Date => new Date(d.getTime() - 1);

  it("payout_queued / payout_sent: exact at the Minsk-midnight cut-off, for 1..5 settle days", () => {
    for (const now of nows)
      for (const days of [1, 2, 3, 5]) {
        const c = stuckCutoffs(now, { ...ctx, bankSettleDays: days });
        expect(stuck("payout_queued", c.queuedBefore, now)).toBe(false);
        expect(stuck("payout_queued", before(c.queuedBefore), now)).toBe(true);
        expect(stuck("payout_sent", c.sentBefore, now, { bankSettleDays: days })).toBe(false);
        expect(stuck("payout_sent", before(c.sentBefore), now, { bankSettleDays: days })).toBe(
          true,
        );
      }
  });

  it("refunds, token confirmations and the rest: nothing at or after the cut-off is stuck", () => {
    for (const now of nows) {
      const c = stuckCutoffs(now, ctx);
      expect(stuck("refunding", c.eripRefundBefore, now, { method: "erip" })).toBe(false);
      expect(stuck("refunding", c.cardRefundBefore, now, { method: "card" })).toBe(false);
      expect(stuck("refunding", c.cardRefundBefore, now)).toBe(false);
      for (const s of ["minting", "burning"] as const)
        expect(stuck(s, c.confirmBefore, now)).toBe(false);
      for (const s of ["paying_out", "crediting", "paid", "reversing", "withdrawing"] as const)
        expect(stuck(s, c.otherBefore, now)).toBe(false);
      // A checkout is stuck only once expired (plus grace): never while expires_at ≥ the cut-off.
      expect(
        stuck("awaiting_payment", new Date(0), now, { expiresAt: c.awaitingExpiresBefore }),
      ).toBe(false);
      // And the cut-offs are not looser than they need be where the logic is a plain age.
      expect(stuck("refunding", before(c.eripRefundBefore), now, { method: "erip" })).toBe(true);
      expect(stuck("refunding", before(c.cardRefundBefore), now, { method: "card" })).toBe(true);
      expect(stuck("minting", before(c.confirmBefore), now)).toBe(true);
      expect(stuck("paying_out", before(c.otherBefore), now)).toBe(true);
    }
  });
});
