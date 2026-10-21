import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { AllowAdminSession, Public } from "../auth/decorators";
import { type AuthedRequest, optionalPrincipalOf } from "../auth/request";
import { Config } from "../config";
import {
  AdminChallengeDto,
  AdminLoginDto,
  GoogleLoginDto,
  TelegramMiniAppDto,
  TelegramWidgetDto,
} from "../dto/auth.dto";
import { AuditService } from "../services/audit.service";
import { GoogleAuthService } from "../services/google-auth.service";
import { LoginService } from "../services/login.service";
import { RateLimitService } from "../services/rate-limit.service";
import { SessionService } from "../services/session.service";
import {
  OidcCallbackError,
  type OidcMode,
  type OidcRedirectTarget,
  TelegramAuthService,
  withAuthResult,
} from "../services/telegram-auth.service";
import { UserService } from "../services/user.service";
import { WalletChallengeService } from "../services/wallet-challenge.service";
import type { ApiChallenge, ApiLoginResult, ApiSessionState, IdentityClaim } from "../types";
import { partyHint } from "../util/canton-crypto";
import { OIDC_COOKIE, clearedOidcCookie, readCookie } from "../util/cookies";
import { ApiError } from "../util/errors";

/**
 * Sign-in routes (docs/API.md "Auth", ARCHITECTURE §6–§7). User accounts are opened and resolved
 * ONLY by Google and Telegram (§6.1); with a session cookie present those routes run in link mode
 * (the identity is attached to the current account and no new session is issued). A Cantor8
 * wallet never signs a user in: it is linked to a signed-in account through
 * `POST /wallets/link-challenge` + `POST /wallets/link` (§7.3, §8.1). Operators sign into the
 * admin API with their wallet on `POST /auth/admin/challenge` + `POST /auth/admin` (§7.4), which
 * issue only `kind = admin` sessions and never run in link mode.
 *
 * Rate limits (§13): login 10/min/IP + 5/min/subject, nonce 30/min/IP, challenge 30/min/IP +
 * 10/min per (IP, party), telegram 10/min/IP.
 *
 * Every per-SUBJECT login limit is applied only AFTER the credential verified (Google, Telegram
 * and the operator wallet alike): a party id or account id is public, so a limit keyed on the
 * unverified body would let anyone lock the real owner out — including every ADMIN_OPERATORS party.
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
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Get("session")
  session(@Req() req: AuthedRequest): ApiSessionState {
    const principal = optionalPrincipalOf(req);
    if (!principal) return { authenticated: false };
    return {
      authenticated: true,
      kind: principal.session.kind,
      user: this.users.toApi(principal.user),
      expiresAt: principal.session.expiresAt.toISOString(),
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
  async google(
    @Body() body: GoogleLoginDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiLoginResult> {
    await this.rateLimit.enforce("login", { ip: req.clientIp });
    const claim = await this.googleAuth.verifyCredential(body.credential, body.nonce);
    await this.rateLimit.enforce("login", { subject: `google:${claim.subject}` });
    return this.login.completeLogin(res, claim, {
      req,
      kind: "user",
      client: body.client ?? "web",
    });
  }

  // ── Telegram ───────────────────────────────────────────────────────────────

  @Public()
  @Post("telegram/widget")
  @HttpCode(200)
  async telegramWidget(
    @Body() body: TelegramWidgetDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiLoginResult> {
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
  async telegramMiniApp(
    @Body() body: TelegramMiniAppDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiLoginResult> {
    await this.rateLimit.enforce("telegram", { ip: req.clientIp });
    await this.rateLimit.enforce("login", { ip: req.clientIp });
    const claim = await this.telegram.verifyMiniApp(body.initData);
    await this.rateLimit.enforce("login", { subject: `telegram:${claim.subject}` });
    return this.login.completeLogin(res, claim, {
      req,
      kind: "user",
      client: body.client ?? "web",
    });
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
        res.redirect(
          302,
          `${known.proto}://${known.host}${withAuthResult(known.returnTo, "error", err.code)}`,
        );
        return;
      }
      throw err;
    }
  }

  // ── Admin (operator wallet) ────────────────────────────────────────────────

  /**
   * §7.4: issues an `admin-sign-in` challenge. Deliberately NO operator check here: the challenge
   * is issued to any well-formed party and ADMIN_OPERATORS is consulted at verify time only, so an
   * anonymous caller cannot enumerate the operator list by watching 403 vs 200 on this route. With
   * a session present the service answers 409 challenge_purpose_mismatch — admin sign-in never
   * runs in link mode.
   */
  @Public()
  @Post("admin/challenge")
  @HttpCode(200)
  async adminChallenge(
    @Body() body: AdminChallengeDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiChallenge> {
    // The party dimension is keyed together with the IP: a stranger cannot spend the owner's quota.
    await this.rateLimit.enforce("challenge", {
      ip: req.clientIp,
      subject: `${req.clientIp ?? "unknown"}:${body.partyId}`,
    });
    return this.challenges.issue({
      partyId: body.partyId,
      purpose: "admin-sign-in",
      sessionId: optionalPrincipalOf(req)?.session.id ?? null,
      host: req.requestHost ?? "",
    });
  }

  /**
   * §6.8 / §7.4: a `kind = admin` session for a party in ADMIN_OPERATORS, web only. A present
   * session is refused BEFORE the challenge is consumed (the operator keeps it). The claim is then
   * consumed before verification, so a bad signature burns it; rejections keep the service's codes
   * (INTERNALS: 401 challenge_rejected / challenge_purpose_mismatch / wallet_key_mismatch /
   * signature_invalid; 403 forbidden for a party outside ADMIN_OPERATORS). The verified key is
   * stored on the operator's identity so AdminGuard can re-check it against the pin per request.
   */
  @Public()
  @Post("admin")
  @HttpCode(200)
  async admin(
    @Body() body: AdminLoginDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiLoginResult> {
    await this.rateLimit.enforce("login", { ip: req.clientIp });
    if (optionalPrincipalOf(req))
      throw new ApiError(403, "forbidden", "admin sign-in cannot run in link mode");

    const verified = await this.challenges.verify({
      challengeId: body.challengeId,
      partyId: body.partyId,
      publicKey: body.publicKey,
      signature: body.signature,
      expectedPurpose: "admin-sign-in",
      sessionId: null,
    });
    // Per-subject limit only once the signature proved control of the party (same order as Google / Telegram).
    await this.rateLimit.enforce("login", { subject: `wallet:${verified.partyId}` });

    const claim: IdentityClaim = {
      provider: "canton_wallet",
      subject: verified.partyId,
      profile: { name: partyHint(verified.partyId), publicKey: verified.publicKeyBase64 },
    };
    return this.login.completeLogin(res, claim, { req, kind: "admin", client: "web" });
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  @AllowAdminSession()
  @Post("logout")
  @HttpCode(200)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const principal = optionalPrincipalOf(req);
    if (principal) {
      const { session, user } = principal;
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
