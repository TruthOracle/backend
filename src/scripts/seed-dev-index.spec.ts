import { demoCatalog } from "./seed-dev-index";

const at = (iso: string) => Date.parse(iso) / 1000;
const DAY = 86_400;

describe("demo catalog", () => {
  it("dates every event from the run: next FOMC decision, next Saturday fixture, next month-end fix", () => {
    const now = at("2026-09-29T12:00:00Z");
    const { events, markets } = demoCatalog(now);
    expect(
      events.map((e) => [e.ticker, e.title, new Date(e.closesAtSec * 1000).toISOString()]),
    ).toEqual([
      ["DEMO-FED-26OCT", "Fed decision, October 2026", "2026-10-28T18:00:00.000Z"],
      ["DEMO-EPL-26OCT17", "Liverpool vs Brighton, 17 Oct 2026", "2026-10-17T14:00:00.000Z"],
      ["DEMO-BTC-26OCT", "Bitcoin above $150k on 31 Oct 2026?", "2026-10-31T23:59:00.000Z"],
    ]);
    for (const e of events) expect(e.closesAtSec).toBeGreaterThanOrEqual(now + 14 * DAY);
    // Every market belongs to one of the events and names the event's date, never a past one.
    expect(markets.map((m) => `${m.event}-${m.suffix}`)).toEqual([
      "DEMO-FED-26OCT-CUT25",
      "DEMO-FED-26OCT-HOLD",
      "DEMO-FED-26OCT-HIKE",
      "DEMO-EPL-26OCT17-LIV",
      "DEMO-EPL-26OCT17-DRAW",
      "DEMO-EPL-26OCT17-BHA",
      "DEMO-BTC-26OCT-150K",
    ]);
    expect(markets.find((m) => m.suffix === "HOLD")?.rules).toContain(
      "2:00 pm ET (18:00 UTC) on 28 October 2026",
    );
    expect(markets.find((m) => m.suffix === "LIV")?.question).toBe(
      "Will Liverpool beat Brighton on 17 Oct 2026?",
    );
    expect(events[1].description).toContain("kick-off 14:00 UTC");
  });

  it("kicks off at 15:00 UK: 14:00 UTC in British Summer Time, 15:00 UTC after the clocks go back", () => {
    expect(
      new Date(demoCatalog(at("2026-10-04T09:00:00Z")).events[1].closesAtSec * 1000).toISOString(),
    ).toBe("2026-10-24T14:00:00.000Z");
    expect(
      new Date(demoCatalog(at("2026-10-12T09:00:00Z")).events[1].closesAtSec * 1000).toISOString(),
    ).toBe("2026-10-31T15:00:00.000Z");
  });

  it("follows the Fed's clock change and rolls month ends and years over", () => {
    const december = demoCatalog(at("2026-11-10T00:00:00Z"));
    expect(december.events[0].ticker).toBe("DEMO-FED-26DEC");
    expect(new Date(december.events[0].closesAtSec * 1000).toISOString()).toBe(
      "2026-12-09T19:00:00.000Z",
    );
    const yearEnd = demoCatalog(at("2026-12-20T00:00:00Z"));
    expect(yearEnd.events[0].ticker).toBe("DEMO-FED-27JAN");
    expect(yearEnd.events[2].ticker).toBe("DEMO-BTC-27JAN");
    expect(new Date(yearEnd.events[2].closesAtSec * 1000).toISOString()).toBe(
      "2027-01-31T23:59:00.000Z",
    );
  });

  it("refuses to invent a Fed meeting past the published calendar", () => {
    expect(() => demoCatalog(at("2027-12-01T00:00:00Z"))).toThrow(/FOMC_MEETINGS/);
  });
});
