import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { Config } from "../config";
import { ApiError } from "../util/errors";
import { IS_PUBLIC_KEY } from "./decorators";
import { type AuthedRequest, originMatchesPattern, originOf } from "./request";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF (docs/ARCHITECTURE.md §6.7): EVERY non-GET request must carry an `Origin` (or `Referer`)
 * whose origin is allowed — the request host or an entry/pattern in FRONTEND_ORIGINS — AND either
 * `Content-Type: application/json` or `x-requested-with: truthoracle`. Missing Origin is rejected.
 * Exempt: @Public routes under /webhooks (signature-verified, no cookies) and bearer-authenticated
 * requests (no cookie involved). Runs after SessionGuard so `req.authKind` is known.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: Config,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    if (req.authKind === "bearer") return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]) === true;
    const path = (req.originalUrl ?? req.url ?? "").split("?")[0];
    if (isPublic && /^\/api\/v1\/webhooks(\/|$)/.test(path)) return true;

    const originHeader = firstHeader(req.headers.origin) || firstHeader(req.headers.referer);
    if (!originHeader) throw new ApiError(403, "csrf_rejected", "Origin header is required on non-GET requests");
    const origin = originOf(originHeader);
    if (!origin || !this.originAllowed(origin, req)) {
      throw new ApiError(403, "csrf_rejected", "request origin is not allowed");
    }

    const contentType = firstHeader(req.headers["content-type"]).toLowerCase();
    const requestedWith = firstHeader(req.headers["x-requested-with"]).toLowerCase();
    const isJson = contentType.startsWith("application/json");
    if (!isJson && requestedWith !== "truthoracle") {
      throw new ApiError(403, "csrf_rejected", "non-GET requests must be application/json or carry x-requested-with: truthoracle");
    }
    return true;
  }

  /** The request's own origin (scheme AND host from the proxy contract) or an allowed frontend origin. */
  private originAllowed(origin: string, req: AuthedRequest): boolean {
    const host = (req.requestHost ?? "").toLowerCase();
    if (host && origin === `${req.requestProto ?? "https"}://${host}`) return true;
    return this.config.frontendOrigins.some((pattern) => originMatchesPattern(origin, pattern));
  }
}

function firstHeader(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" ? v.trim() : "";
}
