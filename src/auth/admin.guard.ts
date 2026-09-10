import { type CanActivate, type ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Config } from "../config";
import { WalletEntity } from "../entities/wallet.entity";
import { IdentityService } from "../services/identity.service";
import { SessionService } from "../services/session.service";
import { publicKeysEqual } from "../util/canton-crypto";
import { ApiError } from "../util/errors";
import type { AuthedRequest } from "./request";

/**
 * Admin authority (docs/ARCHITECTURE.md §6.8): the session must be `kind = admin` AND the
 * identity that authenticated it must be a `canton_wallet` party still listed in
 * ADMIN_OPERATORS (re-read per request; pinned key re-checked against the key stored at link
 * time). A party removed from the list has its admin session revoked on the spot. Runs after
 * the global SessionGuard.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    private readonly config: Config,
    private readonly identities: IdentityService,
    private readonly sessions: SessionService,
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const session = req.session;
    if (!session || !req.user) throw new ApiError(401, "unauthenticated", "authentication required");
    if (session.kind !== "admin") throw new ApiError(403, "forbidden", "an admin session is required");

    const identity = await this.identities.findById(session.authIdentityId);
    const operator = identity && identity.provider === "canton_wallet" && identity.status === "active" ? identity.subject : null;
    const pinned = operator ? this.config.adminOperators.get(operator) : undefined;
    if (operator === null || pinned === undefined) {
      this.logger.warn(`admin session ${session.id} revoked: party is no longer an operator`);
      await this.sessions.revoke(session.id, { type: "system" });
      throw new ApiError(403, "forbidden", "this party is no longer an operator");
    }
    if (pinned) {
      const wallet = await this.wallets.findOne({ where: { partyId: operator } });
      if (wallet && !publicKeysEqual(wallet.publicKey, pinned)) {
        await this.sessions.revoke(session.id, { type: "system" });
        throw new ApiError(403, "forbidden", "operator key does not match the pinned key");
      }
    }
    return true;
  }
}
