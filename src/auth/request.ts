import type { IncomingHttpHeaders } from "node:http";
import type { Request } from "express";

import type { Config } from "../config";
import type { SessionEntity } from "../entities/session.entity";
import type { UserEntity } from "../entities/user.entity";
import type { Actor, AdminRole } from "../types";
import { CidrList, normaliseIp } from "../util/cidr";
import { ApiError } from "../util/errors";
import { timingSafeStringEqual } from "../util/strings";

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
  /** Set by AdminGuard (SPEC §6.5): the operator behind an admin session. */
  adminOperator?: AdminOperatorContext;
}

/** The operator's party, PERSON and roles, and the key their decisions are verified against. */
export interface AdminOperatorContext {
  party: string;
  personId: string;
  roles: AdminRole[];
  /** The pinned key, else the key the admin sign-in verified (base64 raw Ed25519); null = none known. */
  publicKey: string | null;
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
export function isTrustedProxyRequest(
  req: Pick<MinimalRequest, "headers">,
  config: Pick<Config, "backendProxySecret">,
): boolean {
  const secret = config.backendProxySecret;
  if (!secret) return false;
  const presented = header(req, "x-truthoracle-proxy");
  if (!presented) return false;
  return timingSafeStringEqual(presented, secret);
}

/**
 * Client IP per the proxy contract: `x-real-ip` (Vercel's platform header) only when the
 * proxy secret matches; otherwise the socket address. `x-forwarded-for` is never consulted.
 */
export function clientIpOf(
  req: MinimalRequest,
  config: Pick<Config, "backendProxySecret">,
): string {
  if (isTrustedProxyRequest(req, config)) {
    const real = header(req, "x-real-ip");
    if (real) return real;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Source address of a provider webhook (SPEC §8, X13): the right-most value of
 * `RAMP_WEBHOOK_IP_HEADER` — the one our edge appended; anything left of it is caller-controlled —
 * honoured only when the socket peer ∈ `RAMP_TRUSTED_EDGE_CIDRS` or the proxy secret matches;
 * otherwise the proxy contract's client IP. Always normalised (IPv4-mapped IPv6 → IPv4).
 */
export function webhookSourceIpOf(
  req: MinimalRequest,
  config: Pick<Config, "backendProxySecret" | "rampWebhooks">,
): string {
  const name = config.rampWebhooks.ipHeader;
  if (name) {
    const peer = req.socket?.remoteAddress ?? "";
    const trusted =
      new CidrList(config.rampWebhooks.trustedEdgeCidrs).has(peer) ||
      isTrustedProxyRequest(req, config);
    if (trusted) {
      const v = req.headers[name];
      const joined = Array.isArray(v) ? v.join(",") : (v ?? "");
      const rightMost = joined
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      const ip = normaliseIp(rightMost ?? "");
      if (ip) return ip;
    }
  }
  const fallback = clientIpOf(req, config);
  return normaliseIp(fallback) || fallback;
}

/** The host the browser addressed: `x-forwarded-host` when proxied, else `Host`. */
export function requestHostOf(
  req: MinimalRequest,
  config: Pick<Config, "backendProxySecret">,
): string {
  if (isTrustedProxyRequest(req, config)) {
    const fwd = header(req, "x-forwarded-host");
    if (fwd) return fwd.split(",")[0].trim().toLowerCase();
  }
  return header(req, "host").toLowerCase();
}

export function requestProtoOf(
  req: MinimalRequest,
  config: Pick<Config, "backendProxySecret">,
): string {
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
  if (!req.user || !req.session)
    throw new ApiError(401, "unauthenticated", "authentication required");
  return { user: req.user, session: req.session };
}

/** The session on a @Public route, when the browser presented one (the login routes' "link mode"). */
export function optionalPrincipalOf(
  req: AuthedRequest,
): { user: UserEntity; session: SessionEntity } | null {
  return req.user && req.session ? { user: req.user, session: req.session } : null;
}

/** The audit actor behind a session-only request (admin sessions act as `admin`). */
export function actorOf(req: AuthedRequest): Actor {
  const { user, session } = principalOf(req);
  return {
    type: session.kind === "admin" ? "admin" : "user",
    userId: user.id,
    sessionId: session.id,
    ip: req.clientIp ?? null,
  };
}
