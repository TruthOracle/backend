import { Injectable, Logger } from "@nestjs/common";
import type { Response } from "express";

import type { AuthedRequest } from "../auth/request";
import { Config } from "../config";
import type { UserEntity } from "../entities/user.entity";
import { type ApiLoginResult, type IdentityClaim, NatsSubjects, type SessionKind, type WalletKind } from "../types";
import { ApiError } from "../util/errors";
import { AuditService } from "./audit.service";
import { IdentityService } from "./identity.service";
import { NatsService } from "./nats.service";
import { SessionService } from "./session.service";
import { UserService } from "./user.service";
import { WalletLinkService } from "./wallet-link.service";

export interface LoginContext {
  req: AuthedRequest;
  kind: SessionKind;
  client: "web" | "native";
  /** Overrides `req.user` (OIDC login mode ignores a session that appeared meanwhile). */
  currentUser?: UserEntity | null;
  /**
   * For `canton_wallet` claims: the verified key + kind, so the wallet row is created/seeded
   * (WalletLinkService.link — the one place the seed rule lives) BEFORE a session is issued.
   */
  wallet?: { publicKeyBase64: string; kind: WalletKind };
}

/**
 * The last mile of every sign-in method (docs/ARCHITECTURE.md §6, §7.4; INTERNALS "LoginService"):
 * IdentityService.resolveForLogin → (wallet row) → SessionService.issue → Set-Cookie or bearer
 * token → audit (`auth.login` / `auth.admin_login`) → NATS. With a session present the identity
 * is attached to the current account instead (`mode: "link"`, no new session).
 */
@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(
    private readonly config: Config,
    private readonly identities: IdentityService,
    private readonly sessions: SessionService,
    private readonly users: UserService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
    private readonly walletLink: WalletLinkService,
  ) {}

  async completeLogin(res: Response, claim: IdentityClaim, ctx: LoginContext): Promise<ApiLoginResult> {
    const req = ctx.req;
    const currentUser = ctx.currentUser === undefined ? (req.user ?? null) : ctx.currentUser;
    const currentSession = currentUser ? (req.session ?? null) : null;
    const ip = req.clientIp ?? null;
    const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;

    // §6.8 / §7.4: admin sessions come only from an admin-sign-in by an operator wallet, never in link mode.
    if (ctx.kind === "admin") {
      if (currentUser) throw new ApiError(403, "forbidden", "admin sign-in cannot run in link mode");
      if (claim.provider !== "canton_wallet" || !this.config.adminOperators.has(claim.subject)) {
        throw new ApiError(403, "forbidden", "admin sessions are issued only to operator wallets");
      }
    }

    const resolution = await this.identities.resolveForLogin(claim, {
      currentUser,
      ip,
      userAgent,
      sessionId: currentSession?.id ?? null,
    });
    let { user, identity } = resolution;
    const actorType = ctx.kind === "admin" ? "admin" : "user";

    // §7.3 "On success: identity + wallet row seeded per §8.1" — before any session exists, so a
    // failed seed never leaves a cookie behind.
    if (ctx.wallet && claim.provider === "canton_wallet") {
      const linked = await this.walletLink.link(
        user.id,
        { partyId: claim.subject, publicKeyBase64: ctx.wallet.publicKeyBase64, kind: ctx.wallet.kind },
        { actor: { type: actorType, userId: user.id, sessionId: currentSession?.id ?? null, ip } },
      );
      identity = linked.identity ?? identity;
      // The first link sets users.party_id.
      user = (await this.users.findById(user.id)) ?? user;
    }

    const locked = await this.identities.lockedIdentityId(user.id);

    if (resolution.mode === "link") {
      if (!currentSession) throw new ApiError(401, "unauthenticated", "link mode requires a session");
      return {
        mode: "link",
        user: this.users.toApi(user),
        kind: currentSession.kind,
        expiresAt: currentSession.expiresAt.toISOString(),
        identity: this.identities.toApi(identity, locked),
        created: false,
      };
    }

    const { token, session } = await this.sessions.issue({
      userId: user.id,
      authIdentityId: identity.id,
      kind: ctx.kind,
      ip,
      userAgent,
    });
    if (ctx.client !== "native") res.append("Set-Cookie", this.sessions.cookieFor(token, ctx.kind));

    await this.audit.record({
      actorType,
      actorUserId: user.id,
      actorSessionId: session.id,
      action: ctx.kind === "admin" ? "auth.admin_login" : "auth.login",
      subjectType: "user",
      subjectId: user.id,
      metadata: { provider: claim.provider, identityId: identity.id, created: resolution.created, client: ctx.client },
      ip,
    });
    void this.publish(ctx.kind === "admin" ? NatsSubjects.authAdminLogin : NatsSubjects.authLogin, {
      userId: user.id,
      identityId: identity.id,
      sessionId: session.id,
      provider: claim.provider,
      created: resolution.created,
    });

    const result: ApiLoginResult = {
      mode: "login",
      user: this.users.toApi(user),
      kind: ctx.kind,
      expiresAt: session.expiresAt.toISOString(),
      identity: this.identities.toApi(identity, locked),
      created: resolution.created,
    };
    if (ctx.client === "native") result.token = token;
    return result;
  }

  private async publish(subject: `truthoracle.${string}`, payload: object): Promise<void> {
    try {
      await this.nats.publish(subject, payload);
    } catch (err) {
      this.logger.warn(`publish ${subject} failed: ${(err as Error).message}`);
    }
  }
}
