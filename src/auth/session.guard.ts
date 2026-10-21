import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { Config } from "../config";
import { SessionService } from "../services/session.service";
import { UserService } from "../services/user.service";
import { SESSION_COOKIE, readCookie } from "../util/cookies";
import { ApiError } from "../util/errors";
import { ALLOW_ADMIN_SESSION_KEY, IS_PUBLIC_KEY } from "./decorators";
import { type AuthedRequest, clientIpOf, requestHostOf, requestProtoOf } from "./request";

/**
 * Global guard (docs/ARCHITECTURE.md §6.6, §6.8; INTERNALS `SessionGuard`). Resolves the session
 * from the `to_session` cookie or `Authorization: Bearer`, sets `req.session`, `req.user`,
 * `req.authIdentityId`, `req.authKind`; @Public routes pass through unauthenticated but still get
 * `req.user` when a valid session is present ("link mode"). Suspended/closed → 403 user_suspended.
 * A `kind = admin` session is admitted only to @Public routes and to handlers or controllers
 * marked @AllowAdminSession (default deny: account routes are user-only). Also resolves
 * `req.clientIp` / `req.requestHost` once per request (proxy contract §4.1).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: Config,
    private readonly sessions: SessionService,
    private readonly users: UserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.clientIp = clientIpOf(req, this.config);
    req.requestHost = requestHostOf(req, this.config);
    req.requestProto = requestProtoOf(req, this.config);

    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;

    const { token, kind } = extractToken(req);
    if (!token) {
      if (isPublic) return true;
      throw new ApiError(401, "unauthenticated", "authentication required");
    }

    const verified = await this.sessions.verify(token);
    if (!verified) {
      if (isPublic) return true;
      throw new ApiError(401, "unauthenticated", "session is invalid or expired");
    }

    // users.status is read per request (≤ 30 s cache invalidated by suspension).
    const user = (await this.users.findByIdCached(verified.user.id)) ?? verified.user;
    if (user.status !== "active") {
      throw new ApiError(403, "user_suspended", "this account is suspended");
    }

    // §6.8: an admin session is an operator credential for /admin and the session's own
    // housekeeping; every other account route refuses it unless the handler opted in.
    if (verified.session.kind === "admin" && !isPublic) {
      const allowed =
        this.reflector.getAllAndOverride<boolean>(ALLOW_ADMIN_SESSION_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) === true;
      if (!allowed)
        throw new ApiError(403, "forbidden", "admin sessions cannot use account routes");
    }

    req.session = verified.session;
    req.user = user;
    req.authIdentityId = verified.session.authIdentityId;
    req.authKind = kind;
    void this.sessions.touch(verified.session).catch(() => undefined);
    return true;
  }
}

/**
 * The credential a request presents: `Authorization: Bearer <tok>`, else the `to_session` cookie
 * ("" when neither). Also used by the body parser to pick the 8 MB limit (app.setup.ts, C40).
 */
export function extractToken(req: Pick<AuthedRequest, "headers">): {
  token: string;
  kind: "cookie" | "bearer";
} {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) {
    return { token: auth.replace(/^bearer\s+/i, "").trim(), kind: "bearer" };
  }
  return { token: readCookie(req, SESSION_COOKIE), kind: "cookie" };
}
