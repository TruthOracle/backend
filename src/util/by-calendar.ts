/**
 * The Belarusian banking calendar (SPEC §6.6): weekends + `RAMP_BANK_HOLIDAYS` − `RAMP_BANK_WORKDAYS`
 * (the Saturdays the yearly transfer resolution makes working days). Statement staleness, PSP and
 * bank settle days, approval TTLs and alert due dates count business days with it. Minsk keeps
 * UTC+3 all year (no DST since 2011), so a calendar day there is a fixed UTC window: 00:00 Minsk =
 * 21:00 UTC the day before, 23:59:59 Minsk = 20:59:59 UTC. Everything is stored and shown in UTC;
 * only the DAY boundaries are Minsk's.
 */
import { DAY_MS, HOUR_MS } from "./time";

/** Europe/Minsk = UTC+3, fixed. */
export const MINSK_OFFSET_MS = 3 * HOUR_MS;

/** `YYYY-MM-DD`, a calendar day in Minsk. */
export type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Is `value` a real `YYYY-MM-DD` date (no 2026-02-30)? */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/** The Minsk calendar day an instant falls on. */
export function minskDate(instant: Date): IsoDate {
  return new Date(instant.getTime() + MINSK_OFFSET_MS).toISOString().slice(0, 10);
}

function dayOf(day: IsoDate | Date): IsoDate {
  if (day instanceof Date) return minskDate(day);
  if (!isIsoDate(day)) throw new Error(`not an ISO date: ${day}`);
  return day;
}

function shift(day: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, of the calendar day itself. */
function weekday(day: IsoDate): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Guard against a calendar that has no business day for months (a typo in RAMP_BANK_HOLIDAYS). */
const MAX_SCAN_DAYS = 3660;

export class BusinessCalendar {
  private readonly holidays: ReadonlySet<string>;
  private readonly workdays: ReadonlySet<string>;

  constructor(holidays: Iterable<string> = [], workdays: Iterable<string> = []) {
    this.holidays = new Set(holidays);
    this.workdays = new Set(workdays);
  }

  /** A transferred working Saturday counts; a holiday never does; otherwise Monday to Friday. */
  isBusinessDay(day: IsoDate | Date): boolean {
    const d = dayOf(day);
    if (this.workdays.has(d)) return true;
    if (this.holidays.has(d)) return false;
    const wd = weekday(d);
    return wd !== 0 && wd !== 6;
  }

  /**
   * The business day `n` business days after `day` (`n` ≥ 0). `n = 0` is `day` itself when it is
   * a business day, else the next one — so a TTL of 2 counted from a Saturday ends on Tuesday.
   */
  addBusinessDays(day: IsoDate | Date, n: number): IsoDate {
    if (!Number.isInteger(n) || n < 0) throw new Error(`business days must be ≥ 0: ${n}`);
    let d = dayOf(day);
    let left = n;
    if (left === 0) {
      for (let i = 0; !this.isBusinessDay(d); i += 1) {
        if (i > MAX_SCAN_DAYS) throw new Error("no business day within ten years");
        d = shift(d, 1);
      }
      return d;
    }
    for (let i = 0; left > 0; i += 1) {
      if (i > MAX_SCAN_DAYS) throw new Error("no business day within ten years");
      d = shift(d, 1);
      if (this.isBusinessDay(d)) left -= 1;
    }
    return d;
  }

  /** The business day `n` business days before `day` (`n` ≥ 1), counting back over non-business days. */
  subtractBusinessDays(day: IsoDate | Date, n: number): IsoDate {
    if (!Number.isInteger(n) || n < 1) throw new Error(`business days must be ≥ 1: ${n}`);
    let d = dayOf(day);
    let left = n;
    for (let i = 0; left > 0; i += 1) {
      if (i > MAX_SCAN_DAYS) throw new Error("no business day within ten years");
      d = shift(d, -1);
      if (this.isBusinessDay(d)) left -= 1;
    }
    return d;
  }

  /** Business days in (`from`, `to`] by Minsk calendar day; 0 when `to` is not after `from`. */
  businessDaysBetween(from: IsoDate | Date, to: IsoDate | Date): number {
    const a = dayOf(from);
    const b = dayOf(to);
    if (b <= a) return 0;
    let count = 0;
    let d = a;
    for (let i = 0; d < b; i += 1) {
      if (i > MAX_SCAN_DAYS * 10) throw new Error("business-day range too long");
      d = shift(d, 1);
      if (this.isBusinessDay(d)) count += 1;
    }
    return count;
  }

  /** 23:59:59 Minsk of `day` = 20:59:59 UTC. */
  endOfBusinessDayUtc(day: IsoDate | Date): Date {
    return new Date(Date.parse(`${dayOf(day)}T23:59:59Z`) - MINSK_OFFSET_MS);
  }

  /** 00:00 Minsk of `day` = 21:00 UTC of the previous calendar day. */
  startOfDayUtc(day: IsoDate | Date): Date {
    return new Date(Date.parse(`${dayOf(day)}T00:00:00Z`) - MINSK_OFFSET_MS);
  }
}
