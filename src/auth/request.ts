import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Request } from "express";

import type { Config } from "../config";
import type { SessionEntity } from "../entities/session.entity";
import type { UserEntity } from "../entities/user.entity";
import type { Actor } from "../types";
import { ApiError } from "../util/errors";

export type AuthKind = "cookie" | "bearer";

/** The request as seen after the global guards ran. */
export interface AuthedRequest extends Request {
  id?: string;
  rawBody?: Buffer;
  session?: SessionEntity;
  user?: UserEntity;
  authIdentityId?: string;
  authKind?: AuthKind;
  /** Resolved once per request by SessionGuard (proxy contract §4.1). */
  clientIp?: string;
  requestHost?: string;
  requestProto?: string;
}

/** The slice of an Express request these helpers read (lets tests pass plain objects). */
export interface MinimalRequest {
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined };
  protocol?: string;
}

function header(req: Pick<MinimalRequest, "headers">, name: string): string {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

/** Timing-safe: does this request carry the proxy secret? False whenever none is configured. */
export function isTrustedProxyRequest(req: Pick<MinimalRequest, "headers">, config: Pick<Config, "backendProxySecret">): boolean {
  const secret = config.backendProxySecret;
  if (!secret) return false;
  const presented = header(req, "x-truthoracle-proxy");
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Client IP per the proxy contract: `x-real-ip` (Vercel's platform header) only when the
 * proxy secret matches; otherwise the socket address. `x-forwarded-for` is never consulted.
 */
export function clientIpOf(req: MinimalRequest, config: Pick<Config, "backendProxySecret">): string {
  if (isTrustedProxyRequest(req, config)) {
    const real = header(req, "x-real-ip");
    if (real) return real;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** The host the browser addressed: `x-forwarded-host` when proxied, else `Host`. */
export function requestHostOf(req: MinimalRequest, config: Pick<Config, "backendProxySecret">): string {
  if (isTrustedProxyRequest(req, config)) {
    const fwd = header(req, "x-forwarded-host");
    if (fwd) return fwd.split(",")[0].trim().toLowerCase();
  }
  return header(req, "host").toLowerCase();
}

export function requestProtoOf(req: MinimalRequest, config: Pick<Config, "backendProxySecret">): string {
  if (isTrustedProxyRequest(req, config)) {
    const proto = header(req, "x-forwarded-proto").split(",")[0].trim().toLowerCase();
    if (proto === "https" || proto === "http") return proto;
  }
  return req.protocol === "https" ? "https" : "http";
}

/** Parse the origin of a URL-ish header value (`Origin`, `Referer`) into `scheme://host[:port]`. */
export function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Exact origin or a `https://*.vercel.app`-style pattern (one wildcard label). */
export function originMatchesPattern(origin: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/\/$/, "");
  if (!p.includes("*")) return origin === p;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+");
  return new RegExp(`^${escaped}$`).test(origin);
}

/**
 * The authenticated principal of a session-only route. The global SessionGuard guarantees both
 * are set on every non-@Public route; the 401 is a belt-and-braces guard for misuse.
 */
export function principalOf(req: AuthedRequest): { user: UserEntity; session: SessionEntity } {
  if (!req.user || !req.session) throw new ApiError(401, "unauthenticated", "authentication required");
  return { user: req.user, session: req.session };
}

/** The audit actor behind a session-only request (admin sessions act as `admin`). */
export function actorOf(req: AuthedRequest): Actor {
  const { user, session } = principalOf(req);
  return { type: session.kind === "admin" ? "admin" : "user", userId: user.id, sessionId: session.id, ip: req.clientIp ?? null };
}
