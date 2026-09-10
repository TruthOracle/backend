import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { Config } from "../config";
import { GoogleLoginDto, TelegramMiniAppDto, TelegramWidgetDto, WalletChallengeDto, WalletLoginDto } from "../dto/auth.dto";
import { AuditService } from "../services/audit.service";
import { GoogleAuthService } from "../services/google-auth.service";
import { IdentityService } from "../services/identity.service";
import { LoginService } from "../services/login.service";
import { RateLimitService } from "../services/rate-limit.service";
import { SessionService } from "../services/session.service";
import { OidcCallbackError, type OidcMode, type OidcRedirectTarget, TelegramAuthService, withAuthResult } from "../services/telegram-auth.service";
import { UserService } from "../services/user.service";
import { WalletChallengeService } from "../services/wallet-challenge.service";
import { WalletLinkService } from "../services/wallet-link.service";
import type { ApiChallenge, ApiLoginResult, ApiSessionState, IdentityClaim, SessionKind } from "../types";
import { partyHint } from "../util/canton-crypto";
import { OIDC_COOKIE, clearedOidcCookie, readCookie } from "../util/cookies";
import { ApiError } from "../util/errors";

/**
 * Sign-in routes (docs/API.md "Auth", ARCHITECTURE §6–§7). Every login route is @Public: with a
 * session cookie present it runs in link mode (the identity is attached to the current account
 * and no new session is issued). Rate limits: login 10/min/IP + 5/min/subject, nonce 30/min/IP,
 * challenge 30/min/IP + 10/min/party, telegram 10/min/IP, link 10/min/user (§13).
 */
@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly config: Config,
    private readonly googleAuth: GoogleAuthService,
    private readonly telegram: TelegramAuthService,
    private readonly login: LoginService,
    private readonly challenges: WalletChallengeService,
    private readonly walletLink: WalletLinkService,
    private readonly identities: IdentityService,
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Get("session")
  session(@Req() req: AuthedRequest): ApiSessionState {
    if (!req.user || !req.session) return { authenticated: false };
    return {
      authenticated: true,
      kind: req.session.kind,
      user: this.users.toApi(req.user),
      expiresAt: req.session.expiresAt.toISOString(),
    };
  }

  // ── Google ─────────────────────────────────────────────────────────────────

  @Public()
  @Post("google/nonce")
  @HttpCode(200)
  async googleNonce(@Req() req: AuthedRequest): Promise<{ nonce: string; expiresAt: string }> {
    await this.rateLimit.enforce("nonce", { ip: req.clientIp });
    return this.googleAuth.issueNonce(req.clientIp ?? "unknown");
  }

  @Public()
  @Post("google")
  @HttpCode(200)
  async google(@Body() body: GoogleLoginDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<ApiLoginResult> {
    await this.rateLimit.enforce("login", { ip: req.clientIp });
    const claim = await this.googleAuth.verifyCredential(body.credential, body.nonce);
    await this.rateLimit.enforce("login", { subject: `google:${claim.subject}` });
    return this.login.completeLogin(res, claim, { req, kind: "user", client: body.client ?? "web" });
  }

  // ── Telegram ───────────────────────────────────────────────────────────────

  @Public()
  @Post("telegram/widget")
  @HttpCode(200)
  async telegramWidget(@Body() body: TelegramWidgetDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<ApiLoginResult> {
    await this.rateLimit.enforce("telegram", { ip: req.clientIp });
    await this.rateLimit.enforce("login", { ip: req.clientIp });
    const { client, ...payload } = body;
    const claim = await this.telegram.verifyWidget(payload);
    await this.rateLimit.enforce("login", { subject: `telegram:${claim.subject}` });
    return this.login.completeLogin(res, claim, { req, kind: "user", client: client ?? "web" });
  }

  @Public()
  @Post("telegram/miniapp")
  @HttpCode(200)
  async telegramMiniApp(@Body() body: TelegramMiniAppDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<ApiLoginResult> {
    await this.rateLimit.enforce("telegram", { ip: req.clientIp });
    await this.rateLimit.enforce("login", { ip: req.clientIp });
    const claim = await this.telegram.verifyMiniApp(body.initData);
    await this.rateLimit.enforce("login", { subject: `telegram:${claim.subject}` });
    return this.login.completeLogin(res, claim, { req, kind: "user", client: body.client ?? "web" });
  }

  /**
   * §7.2: with a session the flow is a link (the stored state records the user); `mode=link`
   * without a session is refused. `returnTo` is validated by the service (same-origin path).
   */
  @Public()
  @Get("telegram/oidc/start")
  async telegramOidcStart(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query("mode") mode?: string,
    @Query("returnTo") returnTo?: string,
  ): Promise<void> {
    await this.rateLimit.enforce("telegram", { ip: req.clientIp });
    if (mode !== undefined && mode !== "login" && mode !== "link") {
      throw new ApiError(400, "validation_failed", "mode must be login or link");
    }
    const effectiveMode: OidcMode = req.user && req.session ? "link" : (mode ?? "login");
    const started = await this.telegram.oidcStart({
      mode: effectiveMode,
      returnTo: returnTo ?? "/",
      host: req.requestHost ?? "",
      proto: req.requestProto,
      userId: req.user?.id ?? null,
      sessionId: req.session?.id ?? null,
    });
    res.setHeader("Cache-Control", "no-store");
    res.append("Set-Cookie", started.cookie);
    res.redirect(302, started.redirectUrl);
  }

  /**
   * Browser redirect target: success and every failure after the state is known end in a 302
   * back to the app (`?auth=ok` / `?auth=error&code=`). Only an unknown state (nothing safe to
   * redirect to) answers the JSON envelope.
   */
  @Public()
  @Get("telegram/oidc/callback")
  async telegramOidcCallback(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Query("error") providerError?: string,
  ): Promise<void> {
    await this.rateLimit.enforce("telegram", { ip: req.clientIp });
    res.setHeader("Cache-Control", "no-store");
    let target: OidcRedirectTarget | null = null;
    try {
      const callback = await this.telegram.oidcCallback({
        code,
        state,
        cookieValue: readCookie(req, OIDC_COOKIE),
        currentUserId: req.user?.id ?? null,
        providerError,
      });
      target = callback;
      // Login mode ignores a session that appeared meanwhile: it must never silently become a link.
      await this.login.completeLogin(res, callback.claim, {
        req,
        kind: "user",
        client: "web",
        currentUser: callback.mode === "link" ? (req.user ?? null) : null,
      });
      res.append("Set-Cookie", clearedOidcCookie(this.config));
      res.redirect(302, `${target.proto}://${target.host}${withAuthResult(target.returnTo, "ok")}`);
    } catch (err) {
      const known = err instanceof OidcCallbackError ? err.target : target;
      if (known && err instanceof ApiError) {
        res.append("Set-Cookie", clearedOidcCookie(this.config));
        res.redirect(302, `${known.proto}://${known.host}${withAuthResult(known.returnTo, "error", err.code)}`);
        return;
      }
      throw err;
    }
  }

  // ── Canton wallet ──────────────────────────────────────────────────────────

  @Public()
  @Post("wallet/challenge")
  @HttpCode(200)
  async walletChallenge(@Body() body: WalletChallengeDto, @Req() req: AuthedRequest): Promise<ApiChallenge> {
    await this.rateLimit.enforce("challenge", { ip: req.clientIp, subject: body.partyId });
    return this.challenges.issue({
      partyId: body.partyId,
      purpose: body.purpose,
      sessionId: req.session?.id ?? null,
      host: req.requestHost ?? "",
    });
  }

  /**
   * §7.3 purpose isolation: with a session only a `link-wallet` challenge issued to that session
   * is accepted (the link itself is WalletLinkService.link, so the wallet row + seed rule live in
   * one place); without one, `sign-in` / `admin-sign-in`. The claim is consumed before
   * verification, so a bad signature burns the challenge. Rejections keep the service's codes
   * (INTERNALS: 401 challenge_rejected / challenge_purpose_mismatch / wallet_key_mismatch / signature_invalid).
   */
  @Public()
  @Post("wallet")
  @HttpCode(200)
  async wallet(@Body() body: WalletLoginDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<ApiLoginResult> {
    await this.rateLimit.enforce("login", { ip: req.clientIp, subject: `wallet:${body.partyId}` });
    const session = req.user && req.session ? req.session : null;
    const user = session ? (req.user ?? null) : null;

    const verified = await this.challenges.verify({
      challengeId: body.challengeId,
      partyId: body.partyId,
      publicKey: body.publicKey,
      signature: body.signature,
      expectedPurpose: session ? "link-wallet" : ["sign-in", "admin-sign-in"],
      sessionId: session?.id ?? null,
    });

    if (session && user) {
      await this.rateLimit.enforce("link", { userId: user.id });
      const linked = await this.walletLink.link(
        user.id,
        { partyId: verified.partyId, publicKeyBase64: verified.publicKeyBase64, kind: body.kind },
        { actor: { type: session.kind === "admin" ? "admin" : "user", userId: user.id, sessionId: session.id, ip: req.clientIp ?? null } },
      );
      const fresh = (await this.users.findById(user.id)) ?? user;
      const locked = await this.identities.lockedIdentityId(user.id);
      return {
        mode: "link",
        user: this.users.toApi(fresh),
        kind: session.kind,
        expiresAt: session.expiresAt.toISOString(),
        identity: this.identities.toApi(linked.identity, locked),
        created: false,
      };
    }

    const kind: SessionKind = verified.purpose === "admin-sign-in" ? "admin" : "user";
    const claim: IdentityClaim = {
      provider: "canton_wallet",
      subject: verified.partyId,
      profile: { name: partyHint(verified.partyId) },
    };
    return this.login.completeLogin(res, claim, {
      req,
      kind,
      client: body.client ?? "web",
      wallet: { publicKeyBase64: verified.publicKeyBase64, kind: body.kind },
    });
  }


  // ── Logout ─────────────────────────────────────────────────────────────────

  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const session = req.session;
    const user = req.user;
    if (session && user) {
      await this.sessions.revoke(session.id);
      await this.audit.record({
        actorType: session.kind === "admin" ? "admin" : "user",
        actorUserId: user.id,
        actorSessionId: session.id,
        action: "auth.logout",
        subjectType: "session",
        subjectId: session.id,
        metadata: { userId: user.id, kind: session.kind },
        ip: req.clientIp ?? null,
      });
    }
    res.append("Set-Cookie", this.sessions.clearedCookie());
    return { ok: true };
  }
}
