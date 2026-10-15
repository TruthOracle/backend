import { eventSortOrder } from "./catalog.service";
import { parseCursor } from "./markets.service";

describe("eventSortOrder", () => {
  it("ranks trending by the last 24 h of hourly candle volume, then lifetime volume", () => {
    const order = eventSortOrder("trending");
    expect(order).toHaveLength(2);
    expect(order[0].select).toContain("to_market_candles");
    expect(order[0].select).toContain("period_secs = 3600");
    expect(order[0].select).toContain("interval '24 hours'");
    expect(order[0].direction).toBe("DESC");
    expect(order[1].select).toContain("SUM(m.total_volume)");
  });
  it("closing puts the soonest still-open close first and closed events last", () => {
    const [only] = eventSortOrder("closing");
    expect(only.select).toContain("MAX(m.expires_at_sec)");
    expect(only.select).toContain("m.status = 'Trading'");
    expect(only.direction).toBe("ASC");
    expect(only.nulls).toBe("NULLS LAST");
  });
  it("newest and volume are single keys; no sort keeps the catalog's default", () => {
    expect(eventSortOrder("newest")).toEqual([{ select: "e.created_at", direction: "DESC" }]);
    expect(eventSortOrder("volume")[0].select).toContain("SUM(m.total_volume)");
    expect(eventSortOrder(undefined)).toEqual([]);
  });
});

describe("parseCursor", () => {
  it("accepts offset:nodeId and nothing else", () => {
    expect(parseCursor("4550781:3")).toEqual({ offset: 4550781, nodeId: 3 });
    expect(parseCursor("")).toBeNull();
    expect(parseCursor("abc")).toBeNull();
    expect(parseCursor("1:2:3")).toBeNull();
  });
});
