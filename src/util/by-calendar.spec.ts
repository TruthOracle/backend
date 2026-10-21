import { BusinessCalendar, isIsoDate, minskDate } from "./by-calendar";

// October 2026: Mon 19, Tue 20, Wed 21, Thu 22, Fri 23, Sat 24, Sun 25, Mon 26. Nov 7 2026 is a Saturday.
const plain = new BusinessCalendar();
const by = new BusinessCalendar(
  ["2026-11-02", "2026-11-03", "2026-12-25", "2027-01-01", "2027-01-07"],
  // a transferred working Saturday (the yearly resolution moves a bridge day onto it)
  ["2026-11-14"],
);

describe("Belarusian business calendar (SPEC §6.6)", () => {
  it("validates ISO dates and maps instants onto the Minsk day (UTC+3, no DST)", () => {
    expect(isIsoDate("2026-10-19")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-1-9")).toBe(false);
    expect(minskDate(new Date("2026-10-19T20:59:59Z"))).toBe("2026-10-19");
    expect(minskDate(new Date("2026-10-19T21:00:00Z"))).toBe("2026-10-20");
    // Summer and winter alike: Belarus keeps +3 all year.
    expect(minskDate(new Date("2026-01-15T21:00:00Z"))).toBe("2026-01-16");
    expect(minskDate(new Date("2026-07-15T21:00:00Z"))).toBe("2026-07-16");
  });

  it("weekends are not business days; weekdays are", () => {
    expect(plain.isBusinessDay("2026-10-23")).toBe(true);
    expect(plain.isBusinessDay("2026-10-24")).toBe(false);
    expect(plain.isBusinessDay("2026-10-25")).toBe(false);
    expect(plain.isBusinessDay("2026-10-26")).toBe(true);
    // An instant is judged by its Minsk day: Friday 21:30 UTC is already Saturday in Minsk.
    expect(plain.isBusinessDay(new Date("2026-10-23T21:30:00Z"))).toBe(false);
  });

  it("holidays are not business days; a transferred working Saturday is", () => {
    expect(by.isBusinessDay("2026-11-02")).toBe(false);
    expect(by.isBusinessDay("2026-12-25")).toBe(false);
    expect(by.isBusinessDay("2026-11-14")).toBe(true);
    expect(plain.isBusinessDay("2026-11-14")).toBe(false);
  });

  it("adds business days over weekends, holidays and working Saturdays", () => {
    expect(plain.addBusinessDays("2026-10-23", 1)).toBe("2026-10-26");
    expect(plain.addBusinessDays("2026-10-23", 2)).toBe("2026-10-27");
    // From a Saturday: Monday is the first business day, Tuesday the second.
    expect(plain.addBusinessDays("2026-10-24", 2)).toBe("2026-10-27");
    expect(plain.addBusinessDays("2026-10-24", 0)).toBe("2026-10-26");
    expect(plain.addBusinessDays("2026-10-22", 0)).toBe("2026-10-22");
    // Fri Oct 30 + 1: Mon Nov 2 and Tue Nov 3 are holidays → Wed Nov 4.
    expect(by.addBusinessDays("2026-10-30", 1)).toBe("2026-11-04");
    // Fri Nov 13 + 1 = the working Saturday Nov 14.
    expect(by.addBusinessDays("2026-11-13", 1)).toBe("2026-11-14");
    // New-year bridge: Thu Dec 31 + 1 skips Jan 1 (holiday) and the weekend.
    expect(by.addBusinessDays("2026-12-31", 1)).toBe("2027-01-04");
    expect(() => plain.addBusinessDays("2026-10-23", -1)).toThrow();
  });

  it("subtracts business days and counts business days in (from, to]", () => {
    expect(plain.subtractBusinessDays("2026-10-26", 1)).toBe("2026-10-23");
    expect(plain.subtractBusinessDays("2026-10-26", 3)).toBe("2026-10-21");
    expect(by.subtractBusinessDays("2026-11-04", 1)).toBe("2026-10-30");
    // Thursday's statement on the next Monday: Fri + Mon = 2; on Tuesday: 3.
    expect(plain.businessDaysBetween("2026-10-22", "2026-10-26")).toBe(2);
    expect(plain.businessDaysBetween("2026-10-22", "2026-10-27")).toBe(3);
    expect(plain.businessDaysBetween("2026-10-23", "2026-10-25")).toBe(0);
    expect(plain.businessDaysBetween("2026-10-26", "2026-10-22")).toBe(0);
    expect(by.businessDaysBetween("2026-10-30", "2026-11-04")).toBe(1);
    expect(by.businessDaysBetween("2026-11-13", "2026-11-16")).toBe(2);
  });

  it("a Minsk day ends at 20:59:59 UTC and starts at 21:00 UTC the day before", () => {
    expect(plain.endOfBusinessDayUtc("2026-10-19").toISOString()).toBe("2026-10-19T20:59:59.000Z");
    expect(plain.startOfDayUtc("2026-10-19").toISOString()).toBe("2026-10-18T21:00:00.000Z");
    expect(plain.endOfBusinessDayUtc(new Date("2026-10-19T22:00:00Z")).toISOString()).toBe(
      "2026-10-20T20:59:59.000Z",
    );
    expect(() => plain.endOfBusinessDayUtc("19.10.2026")).toThrow(/not an ISO date/);
  });
});
