/**
 * Cookie plumbing (docs/ARCHITECTURE.md §6.6, §7.2). Sessions ride in `to_session`
 * (HttpOnly; Secure; SameSite=Lax; Path=/; host-only unless COOKIE_DOMAIN is set — and it must
 * stay empty behind the proxy, which strips `Domain=` anyway). The OIDC state binder is `to_oidc`.
 */
import type { IncomingMessage } from "node:http";

import type { Config } from "../config";

export const SESSION_COOKIE = "to_session";
export const OIDC_COOKIE = "to_oidc";

interface CookieOptions {
  secure: boolean;
  domain: string;
  maxAgeMs: number;
}

function serialize(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeMs / 1000))}`,
  ];
  if (opts.secure) parts.push("Secure");
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join("; ");
}

function optionsFrom(config: Pick<Config, "cookieSecure" | "cookieDomain">, maxAgeMs: number): CookieOptions {
  return { secure: config.cookieSecure, domain: config.cookieDomain, maxAgeMs };
}

export function sessionCookie(
  token: string,
  maxAgeMs: number,
  config: Pick<Config, "cookieSecure" | "cookieDomain">,
): string {
  return serialize(SESSION_COOKIE, token, optionsFrom(config, maxAgeMs));
}

export function clearedSessionCookie(config: Pick<Config, "cookieSecure" | "cookieDomain">): string {
  return serialize(SESSION_COOKIE, "", optionsFrom(config, 0));
}

export function oidcCookie(
  value: string,
  maxAgeMs: number,
  config: Pick<Config, "cookieSecure" | "cookieDomain">,
): string {
  return serialize(OIDC_COOKIE, value, optionsFrom(config, maxAgeMs));
}

export function clearedOidcCookie(config: Pick<Config, "cookieSecure" | "cookieDomain">): string {
  return serialize(OIDC_COOKIE, "", optionsFrom(config, 0));
}

/**
 * Read one cookie from the raw header. A malformed %-sequence throws, and this runs before auth
 * on every request — treat an undecodable cookie as absent, not as a 500. Works with or without
 * cookie-parser (it never reads `req.cookies`).
 */
export function readCookie(req: Pick<IncomingMessage, "headers">, name: string): string {
  const header = req.headers.cookie;
  if (typeof header !== "string") return "";
  for (const chunk of header.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    if (chunk.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(chunk.slice(eq + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}
