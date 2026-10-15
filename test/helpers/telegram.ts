/**
 * Telegram Login Widget stand-in (ARCHITECTURE §7.2). Payloads are signed here with the documented
 * HMAC — key = SHA256(bot token), data-check string = sorted `k=v` lines — so the real
 * TelegramAuthService verifies them. Google and Telegram are the ONLY ways a user account is
 * opened (§6.1), so every user fixture in the e2e suites starts with `signInWithTelegram`.
 */
import { createHash, createHmac } from "node:crypto";
import type request from "supertest";

import type { ApiLoginResult, ApiUser } from "../../src/types";
import { TEST_ORIGIN, TEST_TELEGRAM_BOT_TOKEN } from "./app";
import { cookieFromResponse } from "./session";

export interface TelegramTestUser {
  id: string;
  first_name: string;
  last_name?: string;
  username?: string;
}

/** Signs a Login Widget payload the way Telegram does (§7.2): key = SHA256(bot token), sorted `k=v` lines. */
export function signTelegramWidget(
  fields: Record<string, string>,
  botToken: string,
): Record<string, string> {
  const key = createHash("sha256").update(botToken, "utf8").digest();
  const dataCheckString = Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  return {
    ...fields,
    hash: createHmac("sha256", key).update(dataCheckString, "utf8").digest("hex"),
  };
}

let nextId = 700_000_000;
/** A fresh numeric Telegram user per call (ids are unique within a spec file; tables are truncated between tests anyway). */
export function nextTelegramUser(firstName: string): TelegramTestUser {
  nextId += 1;
  return { id: String(nextId), first_name: firstName };
}

/**
 * Widget payloads are single-use (`tg:<hash>` is claimed once) and `auth_date` must be fresh, so
 * every call signs anew with an auth_date this user has not been signed with before.
 */
/**
 * auth_dates already signed, per Telegram user id. The server claims every payload hash once
 * (`tg:<hash>`, the replay guard), so two payloads for the same user must never share an
 * auth_date. The previous rolling offset (`now - n`) collided whenever two consecutive calls
 * straddled a wall-clock second: the clock and the offset both advanced by one, the auth_date
 * repeated, and the second sign-in was refused as a replay (the intermittent 401 in CI).
 */
const usedAuthDates = new Map<string, Set<number>>();
/** Stay well inside TELEGRAM_AUTH_MAX_AGE_SEC (300 s by default). */
const AUTH_DATE_WINDOW_SEC = 200;

function uniqueAuthDate(userId: string): number {
  const now = Math.floor(Date.now() / 1000);
  let used = usedAuthDates.get(userId);
  if (!used) {
    used = new Set();
    usedAuthDates.set(userId, used);
  }
  for (const t of used) if (t < now - AUTH_DATE_WINDOW_SEC) used.delete(t);
  for (let k = 1; k < AUTH_DATE_WINDOW_SEC; k += 1) {
    const candidate = now - k;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error(
    `freshWidgetPayload: more than ${AUTH_DATE_WINDOW_SEC} sign-ins for Telegram user ${userId} within ${AUTH_DATE_WINDOW_SEC} s`,
  );
}
export function freshWidgetPayload(
  user: TelegramTestUser,
  botToken = TEST_TELEGRAM_BOT_TOKEN,
): Record<string, string> {
  const fields: Record<string, string> = {
    id: user.id,
    first_name: user.first_name,
    auth_date: String(uniqueAuthDate(user.id)),
  };
  if (user.last_name !== undefined) fields.last_name = user.last_name;
  if (user.username !== undefined) fields.username = user.username;
  return signTelegramWidget(fields, botToken);
}

/**
 * `POST /auth/telegram/widget` with a freshly signed payload and the CSRF headers. With
 * `opts.cookie` the route runs in link mode (the Telegram identity is attached to that session's
 * account and `cookie` is returned unchanged); otherwise the new session cookie is returned.
 * Throws with the body when the sign-in is refused.
 */
export async function signInWithTelegram(
  agent: request.Agent,
  user: TelegramTestUser,
  opts: { cookie?: string } = {},
): Promise<{ user: ApiUser; cookie: string; result: ApiLoginResult }> {
  const headers: Record<string, string> = {
    Origin: TEST_ORIGIN,
    "Content-Type": "application/json",
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await agent
    .post("/api/v1/auth/telegram/widget")
    .set(headers)
    .send(freshWidgetPayload(user));
  if (res.status !== 200) {
    throw new Error(`POST /auth/telegram/widget → ${res.status} ${JSON.stringify(res.body)}`);
  }
  const result = res.body as ApiLoginResult;
  return { user: result.user, cookie: opts.cookie ?? cookieFromResponse(res), result };
}
