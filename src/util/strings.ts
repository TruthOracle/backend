/** Stringify only scalars; objects/arrays/null → `fallback` (never "[object Object]"). */
export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return fallback;
}
