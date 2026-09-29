import { candleUpsert, periodStartSec } from "./candles";

describe("candles", () => {
  it("buckets epoch seconds to the period start", () => {
    expect(periodStartSec(1_760_000_123, 60)).toBe(1_760_000_100);
    expect(periodStartSec(1_760_000_123, 3600)).toBe(1_759_996_800);
    expect(periodStartSec(1_760_000_123, 86_400)).toBe(1_759_968_000);
  });

  it("builds one upsert per period with 10-dp strings and the notional as price × Δvolume", () => {
    const { sql, params } = candleUpsert(
      {
        marketId: 7,
        atSec: 1_760_000_123,
        price: 5_500_000_000n,
        liquidityL: 2_506_600_000_000n,
        volumeDelta: 100_000_000_000n,
        trades: 1,
        openInterest: 180_000_000_000n,
        offset: 4,
        nodeId: 3,
      },
      60,
    );
    expect(sql).toContain("ON CONFLICT (market_id, period_secs, period_start)");
    expect(params).toEqual([
      "7",
      60,
      1_760_000_100,
      "0.5500000000",
      "10.0000000000",
      "5.5000000000",
      1,
      "18.0000000000",
      "250.6600000000",
      "4",
      3,
    ]);
  });
});
