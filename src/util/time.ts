export function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
