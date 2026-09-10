import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { type AuthedRequest, actorOf, principalOf } from "../auth/request";
import { Config } from "../config";
import { DEFAULT_PAGE_LIMIT, PageQueryDto } from "../dto/common.dto";
import { ReattachIdentityDto, UpdateMeDto } from "../dto/me.dto";
import type { AuthIdentityEntity } from "../entities/auth-identity.entity";
import type { SessionEntity } from "../entities/session.entity";
import type { UserEntity } from "../entities/user.entity";
import { AuditService } from "../services/audit.service";
import { GoogleAuthService } from "../services/google-auth.service";
import { IdentityService } from "../services/identity.service";
import { KycService } from "../services/kyc.service";
import { RateLimitService } from "../services/rate-limit.service";
import { SessionService } from "../services/session.service";
import { TelegramAuthService } from "../services/telegram-auth.service";
import { UserService } from "../services/user.service";
import { WalletChallengeService } from "../services/wallet-challenge.service";
import { WalletLinkService } from "../services/wallet-link.service";
import type {
  ApiAuditEvent,
  ApiCapabilities,
  ApiIdentity,
  ApiMe,
  ApiPage,
  ApiSession,
  ApiUser,
  IdentityClaim,
  IdentityProvider,
} from "../types";
import { partyHint } from "../util/canton-crypto";
import { ApiError } from "../util/errors";

/**
 * Account routes (docs/API.md "Me"; ARCHITECTURE §6, §8.1, §9.4). Every route is session-only
 * (the global SessionGuard); the rules live in the owning services — this controller composes
 * them and shapes the wire objects.
 */
@ApiTags("me")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("me")
export class MeController {
  constructor(
    private readonly config: Config,
    private readonly users: UserService,
    private readonly identities: IdentityService,
    private readonly walletLinks: WalletLinkService,
    private readonly kyc: KycService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly googleAuth: GoogleAuthService,
    private readonly telegram: TelegramAuthService,
    private readonly challenges: WalletChallengeService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** `{ user, identities, wallets (+ ownLedgerWallet), kyc, capabilities }` in one read. */
  @Get()
  async me(@Req() req: AuthedRequest): Promise<ApiMe> {
    const { user, session } = principalOf(req);
    const [identities, walletRows, summary, locked, gate] = await Promise.all([
      this.identities.listForUser(user.id),
      this.walletLinks.listForUser(user.id),
      this.kyc.summaryForUser(user.id),
      this.kyc.lockedIdentityId(user.id),
      this.kyc.withdrawalGate(user.id),
    ]);
    const ownLedger = await this.walletLinks.ownLedgerWallets(walletRows, user.partyId);
    // API.md: `/me.kyc` is the summary; the attempt history is `GET /kyc`.
    const { history: _history, ...kyc } = summary;
    return {
      user: this.users.toApi(user),
      identities: identities.map((i) => this.identities.toApi(i, locked)),
      wallets: walletRows.map((w) => this.walletLinks.toApi(w, { ownLedgerWallet: ownLedger.get(w.id) ?? null })),
      kyc,
      capabilities: this.capabilities(user, session, gate.allowed),
    };
  }

  @Patch()
  @HttpCode(200)
  async update(@Body() body: UpdateMeDto, @Req() req: AuthedRequest): Promise<{ user: ApiUser }> {
    const { user, session } = principalOf(req);
    const patch: { displayName?: string | null; avatarUrl?: string | null } = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.avatarUrl !== undefined) patch.avatarUrl = body.avatarUrl;
    const fields = Object.keys(patch);
    if (fields.length === 0) return { user: this.users.toApi(user) };

    const updated = await this.users.update(user.id, patch);
    await this.audit.record({
      actorType: session.kind === "admin" ? "admin" : "user",
      actorUserId: user.id,
      actorSessionId: session.id,
      action: "user.updated",
      subjectType: "user",
      subjectId: user.id,
      metadata: { fields },
      ip: req.clientIp ?? null,
    });
    return { user: this.users.toApi(updated) };
  }

  // ── identities ─────────────────────────────────────────────────────────────

  /** §6.3–6.5 via IdentityService.unlink: 409 last_identity | identity_locked_by_kyc | primary_wallet_in_use. */
  @Delete("identities/:id")
  @HttpCode(200)
  async unlinkIdentity(@Param("id", ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<{ ok: true }> {
    const { user } = principalOf(req);
    await this.identities.unlink(user.id, id, actorOf(req));
    return { ok: true };
  }

  /**
   * §6.4 (a): only the original owner, with a fresh proof for that provider — the body is the
   * matching login route's body (Google credential, Telegram widget/initData, or a `link-wallet`
   * challenge signed by the wallet). The proof is verified BEFORE the row is touched.
   */
  @Post("identities/:id/reattach")
  @HttpCode(200)
  async reattachIdentity(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ReattachIdentityDto,
    @Req() req: AuthedRequest,
  ): Promise<{ identity: ApiIdentity }> {
    const { user, session } = principalOf(req);
    const identity = await this.identities.findById(id);
    if (!identity || identity.userId !== user.id) throw new ApiError(404, "not_found", "identity not found");
    await this.rateLimit.enforce("link", { userId: user.id });
    const claim = await this.proofFor(identity, body, session);
    const reattached = await this.identities.reattach(user.id, id, claim, actorOf(req));
    const locked = await this.kyc.lockedIdentityId(user.id);
    return { identity: this.identities.toApi(reattached, locked) };
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  @Get("sessions")
  async listSessions(@Req() req: AuthedRequest): Promise<{ sessions: ApiSession[] }> {
    const { user, session } = principalOf(req);
    const [rows, identities] = await Promise.all([this.sessions.listForUser(user.id), this.identities.listForUser(user.id)]);
    const providerOf = new Map<string, IdentityProvider>(identities.map((i) => [i.id, i.provider]));
    const out: ApiSession[] = [];
    for (const s of rows) {
      let provider = providerOf.get(s.authIdentityId);
      if (!provider) {
        const identity = await this.identities.findById(s.authIdentityId);
        if (!identity) throw new ApiError(500, "internal_error", "session references an unknown identity");
        provider = identity.provider;
      }
      out.push(this.sessions.toApi(s, provider, session.id));
    }
    return { sessions: out };
  }

  /** Revoking the current session also clears the cookie so the browser drops it at once. */
  @Delete("sessions/:id")
  @HttpCode(200)
  async revokeSession(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const { user, session } = principalOf(req);
    const target = await this.sessions.findById(id);
    if (!target || target.userId !== user.id) throw new ApiError(404, "not_found", "session not found");
    await this.sessions.revoke(id, actorOf(req));
    if (id === session.id) res.append("Set-Cookie", this.sessions.clearedCookie());
    return { ok: true };
  }

  @Post("sessions/revoke-others")
  @HttpCode(200)
  async revokeOthers(@Req() req: AuthedRequest): Promise<{ revoked: number }> {
    const { user, session } = principalOf(req);
    const revoked = await this.sessions.revokeAllForUser(user.id, session.id);
    if (revoked > 0) {
      await this.audit.record({
        actorType: session.kind === "admin" ? "admin" : "user",
        actorUserId: user.id,
        actorSessionId: session.id,
        action: "session.revoked_all",
        subjectType: "user",
        subjectId: user.id,
        metadata: { revoked, keptSessionId: session.id },
        ip: req.clientIp ?? null,
      });
    }
    return { revoked };
  }

  // ── audit ──────────────────────────────────────────────────────────────────

  /** The user's own trail: events they performed or that concern their account. */
  @Get("audit")
  async auditTrail(@Query() query: PageQueryDto, @Req() req: AuthedRequest): Promise<ApiPage<ApiAuditEvent>> {
    const { user } = principalOf(req);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const { items, total } = await this.audit.listForUser(user.id, page, limit);
    return { items: items.map((e) => this.audit.toApi(e)), page, limit, total };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * §9.4 / §9.3: `canWithdraw` is the payee gate (KYC_ENFORCE_WITHDRAWALS=false → allowed) and
   * needs an in-app wallet owner; `canDeposit` needs a primary wallet and no open duplicate
   * conflict; `isAdmin` is a property of the session, never of the account (§6.8).
   */
  private capabilities(user: UserEntity, session: SessionEntity, withdrawAllowed: boolean): ApiCapabilities {
    const active = user.status === "active";
    const hasPrimary = user.partyId !== null;
    return {
      canDeposit: active && hasPrimary && user.kycStatus !== "blocked_duplicate",
      canWithdraw: active && hasPrimary && withdrawAllowed,
      kycRequiredForWithdrawal: this.config.kycEnforceWithdrawals,
      primaryPartyId: user.partyId,
      isAdmin: session.kind === "admin",
    };
  }

  private async proofFor(identity: AuthIdentityEntity, body: ReattachIdentityDto, session: SessionEntity): Promise<IdentityClaim> {
    switch (identity.provider) {
      case "google": {
        if (!body.credential) throw new ApiError(400, "validation_failed", "credential is required to re-attach a Google identity");
        return this.googleAuth.verifyCredential(body.credential, body.nonce);
      }
      case "telegram": {
        if (body.initData) return this.telegram.verifyMiniApp(body.initData);
        if (body.id && body.hash && body.auth_date) {
          const { id, first_name, last_name, username, photo_url, auth_date, hash } = body;
          return this.telegram.verifyWidget({ id, first_name, last_name, username, photo_url, auth_date, hash });
        }
        throw new ApiError(400, "validation_failed", "a Telegram widget payload or initData is required to re-attach a Telegram identity");
      }
      case "canton_wallet": {
        if (!body.challengeId || !body.partyId || !body.publicKey || !body.signature) {
          throw new ApiError(400, "validation_failed", "challengeId, partyId, publicKey and signature are required to re-attach a wallet identity");
        }
        // The session-bound `link-wallet` challenge (§7.3 purpose isolation); the claim is consumed before verification.
        const verified = await this.challenges.verify({
          challengeId: body.challengeId,
          partyId: body.partyId,
          publicKey: body.publicKey,
          signature: body.signature,
          expectedPurpose: "link-wallet",
          sessionId: session.id,
        });
        return { provider: "canton_wallet", subject: verified.partyId, profile: { name: partyHint(verified.partyId) } };
      }
      default:
        throw new ApiError(400, "validation_failed", "unsupported identity provider");
    }
  }
}
