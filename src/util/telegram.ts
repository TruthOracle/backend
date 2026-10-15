/**
 * Telegram Login Widget and Mini App `initData` verification (docs/ARCHITECTURE.md §7.2).
 *
 * Both flows sign a "data-check-string": every field except `hash`, sorted by key, rendered
 * as `key=value` and joined with "\n". They differ only in how the HMAC key is derived:
 *
 *   Login Widget : key    = SHA256(BOT_TOKEN)
 *                  hash   = hex(HMAC-SHA256(key, dataCheckString))
 *   Mini App     : secret = HMAC-SHA256(key = "WebAppData", data = BOT_TOKEN)
 *                  hash   = hex(HMAC-SHA256(secret, dataCheckString))   (`user` is a JSON string)
 *
 * The comparison is over decoded bytes with `timingSafeEqual`. `replayKey` is the payload hash
 * itself — the caller claims it once (`tg:<hash>`) so a leaked redirect URL cannot be replayed.
 * The OIDC flow (jose) lives in P1's TelegramAuthService; all three yield `subject = numeric id`.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramUser {
  /** Numeric Telegram user id as a decimal string — the identity subject. */
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  languageCode?: string;
}

export type TelegramVerifyResult =
  | { ok: true; user: TelegramUser; replayKey: string; authDate: number }
  | { ok: false; reason: string };

export interface TelegramVerifyOptions {
  maxAgeSec: number;
  /** Seconds since epoch; defaults to now. */
  now?: number;
}

const FUTURE_SKEW_SEC = 60;
const HASH_RE = /^[0-9a-f]{64}$/;

export function widgetSecret(botToken: string): Buffer {
  return createHash("sha256").update(botToken, "utf8").digest();
}

export function miniAppSecret(botToken: string): Buffer {
  return createHmac("sha256", "WebAppData").update(botToken, "utf8").digest();
}

export function dataCheckString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
}

export function computeHash(secret: Buffer, fields: Record<string, string>): string {
  return createHmac("sha256", secret).update(dataCheckString(fields), "utf8").digest("hex");
}

function hashMatches(expectedHex: string, actual: string): boolean {
  if (!HASH_RE.test(actual)) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(actual, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkFreshness(
  authDateRaw: string | undefined,
  opts: TelegramVerifyOptions,
): string | null {
  if (!authDateRaw || !/^\d{1,12}$/.test(authDateRaw)) return "auth_date missing or malformed";
  const authDate = Number(authDateRaw);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (now - authDate > opts.maxAgeSec) return "auth payload expired";
  if (authDate > now + FUTURE_SKEW_SEC) return "auth payload issued in the future";
  return null;
}

/** Only the documented widget fields are considered; anything else is dropped before hashing. */
const WIDGET_FIELDS = [
  "id",
  "first_name",
  "last_name",
  "username",
  "photo_url",
  "auth_date",
  "hash",
] as const;

/** Normalise a JSON body (numbers → strings, unknown keys dropped) into widget fields. */
export function parseWidgetPayload(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== "object") return out;
  const rec = body as Record<string, unknown>;
  for (const key of WIDGET_FIELDS) {
    const v = rec[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[key] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = String(v);
  }
  return out;
}

function userFromWidget(fields: Record<string, string>): TelegramUser | null {
  if (!/^\d{1,20}$/.test(fields.id ?? "")) return null;
  return {
    id: fields.id,
    firstName: fields.first_name ?? "",
    lastName: fields.last_name,
    username: fields.username,
    photoUrl: fields.photo_url,
  };
}

export function verifyLoginWidget(
  payload: unknown,
  botToken: string,
  opts: TelegramVerifyOptions,
): TelegramVerifyResult {
  if (!botToken) return { ok: false, reason: "telegram is not configured" };
  const fields = parseWidgetPayload(payload);
  const hash = (fields.hash ?? "").toLowerCase();
  if (!HASH_RE.test(hash)) return { ok: false, reason: "hash missing or malformed" };
  if (!hashMatches(computeHash(widgetSecret(botToken), fields), hash)) {
    return { ok: false, reason: "hash mismatch" };
  }
  const stale = checkFreshness(fields.auth_date, opts);
  if (stale) return { ok: false, reason: stale };
  const user = userFromWidget(fields);
  if (!user) return { ok: false, reason: "user id missing" };
  return { ok: true, user, replayKey: hash, authDate: Number(fields.auth_date) };
}

/** `initData` is a URL query string; `user` is a JSON-encoded object. */
export function verifyMiniAppInitData(
  initData: unknown,
  botToken: string,
  opts: TelegramVerifyOptions,
): TelegramVerifyResult {
  if (!botToken) return { ok: false, reason: "telegram is not configured" };
  if (typeof initData !== "string" || !initData || initData.length > 8192) {
    return { ok: false, reason: "initData missing or malformed" };
  }
  const params = new URLSearchParams(initData);
  const fields: Record<string, string> = {};
  for (const [k, v] of params) fields[k] = v;
  const hash = (fields.hash ?? "").toLowerCase();
  if (!HASH_RE.test(hash)) return { ok: false, reason: "hash missing or malformed" };
  if (!hashMatches(computeHash(miniAppSecret(botToken), fields), hash)) {
    return { ok: false, reason: "hash mismatch" };
  }
  const stale = checkFreshness(fields.auth_date, opts);
  if (stale) return { ok: false, reason: stale };

  let userJson: unknown;
  try {
    userJson = JSON.parse(fields.user ?? "");
  } catch {
    return { ok: false, reason: "user field is not JSON" };
  }
  if (!userJson || typeof userJson !== "object")
    return { ok: false, reason: "user field is not an object" };
  const u = userJson as Record<string, unknown>;
  const id = typeof u.id === "number" || typeof u.id === "string" ? String(u.id) : "";
  if (!/^\d{1,20}$/.test(id)) return { ok: false, reason: "user id missing" };
  const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    ok: true,
    user: {
      id,
      firstName: s(u.first_name) ?? "",
      lastName: s(u.last_name),
      username: s(u.username),
      photoUrl: s(u.photo_url),
      languageCode: s(u.language_code),
    },
    replayKey: hash,
    authDate: Number(fields.auth_date),
  };
}

/** Test/fixture helper: build a signed widget payload the way Telegram would. */
export function signWidgetPayload(
  fields: Record<string, string>,
  botToken: string,
): Record<string, string> {
  return { ...fields, hash: computeHash(widgetSecret(botToken), fields) };
}

/** Test/fixture helper: build a signed `initData` string the way Telegram would. */
export function signMiniAppInitData(fields: Record<string, string>, botToken: string): string {
  const hash = computeHash(miniAppSecret(botToken), fields);
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}
