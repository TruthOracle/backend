import { type CanActivate, type ExecutionContext, Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import { IdentityService } from "../services/identity.service";
import { SessionService } from "../services/session.service";
import { publicKeysEqual } from "../util/canton-crypto";
import { ApiError } from "../util/errors";
import type { AuthedRequest } from "./request";

/**
 * Admin authority (docs/ARCHITECTURE.md §6.8): the session must be `kind = admin` AND the identity
 * that authenticated it must be a `canton_wallet` party still listed in ADMIN_OPERATORS (re-read
 * per request). When the operator's key is pinned, the key the identity recorded at sign-in
 * (`profile.publicKey`, written by `POST /auth/admin` from the verified signature) must still equal
 * it; a pinned operator whose identity carries no key fails closed. Every refusal revokes the admin
 * session on the spot. Runs after the global SessionGuard (which already admitted the admin kind
 * to this route).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    private readonly config: Config,
    private readonly identities: IdentityService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const session = req.session;
    if (!session || !req.user)
      throw new ApiError(401, "unauthenticated", "authentication required");
    if (session.kind !== "admin")
      throw new ApiError(403, "forbidden", "an admin session is required");

    const identity = await this.identities.findById(session.authIdentityId);
    const pinned =
      identity && identity.provider === "canton_wallet" && identity.status === "active"
        ? this.config.adminOperators.get(identity.subject)
        : undefined;
    if (!identity || pinned === undefined) {
      this.logger.warn(`admin session ${session.id} revoked: party is no longer an operator`);
      await this.sessions.revoke(session.id, { type: "system" });
      throw new ApiError(403, "forbidden", "this party is no longer an operator");
    }
    if (pinned) {
      const stored = identity.profile.publicKey;
      if (typeof stored !== "string" || !publicKeysEqual(stored, pinned)) {
        this.logger.warn(
          `admin session ${session.id} revoked: operator key does not match the pinned key`,
        );
        await this.sessions.revoke(session.id, { type: "system" });
        throw new ApiError(403, "forbidden", "operator key does not match the pinned key");
      }
    }
    return true;
  }
}
