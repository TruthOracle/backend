export function nowMs(): number {
  return Date.now();
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function fromNowMs(ms: number): Date {
  return new Date(Date.now() + ms);
}

export function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
