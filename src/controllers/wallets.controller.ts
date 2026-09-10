import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, actorOf, principalOf } from "../auth/request";
import { LinkChallengeDto, LinkWalletDto } from "../dto/wallets.dto";
import { IdentityService } from "../services/identity.service";
import { RateLimitService } from "../services/rate-limit.service";
import { WalletChallengeService } from "../services/wallet-challenge.service";
import { WalletLinkService } from "../services/wallet-link.service";
import type { ApiChallenge, ApiIdentity, ApiWallet } from "../types";

/**
 * Wallet routes (docs/API.md "Wallets"; ARCHITECTURE §8.1–8.2). Linking runs the same
 * challenge/signature crypto as sign-in with purpose `link-wallet` bound to this session, and the
 * link itself is WalletLinkService.link — the one place the wallet-row rules live, shared with
 * `POST /auth/wallet` in link mode. Linking never reads the ledger.
 */
@ApiTags("wallets")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly walletLinks: WalletLinkService,
    private readonly identities: IdentityService,
    private readonly challenges: WalletChallengeService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Every row (active AND revoked — revoked wallets keep their attribution), with ownLedgerWallet. */
  @Get()
  async list(@Req() req: AuthedRequest): Promise<{ wallets: ApiWallet[] }> {
    const { user } = principalOf(req);
    const rows = await this.walletLinks.listForUser(user.id);
    const own = await this.walletLinks.ownLedgerWallets(rows, user.partyId);
    return { wallets: rows.map((w) => this.walletLinks.toApi(w, { ownLedgerWallet: own.get(w.id) ?? null })) };
  }

  /** Rate limits: challenge 30/min/IP + 10/min per (IP, party) — the party alone is public and must not be spendable by strangers (§13). */
  @Post("link-challenge")
  @HttpCode(200)
  async linkChallenge(@Body() body: LinkChallengeDto, @Req() req: AuthedRequest): Promise<ApiChallenge> {
    const { session } = principalOf(req);
    await this.rateLimit.enforce("challenge", { ip: req.clientIp, subject: `${req.clientIp ?? "unknown"}:${body.partyId}` });
    return this.challenges.issue({ partyId: body.partyId, purpose: "link-wallet", sessionId: session.id, host: req.requestHost ?? "" });
  }

  /**
   * `200 { wallet, identity }` | `409 wallet_already_linked`. The claim is consumed before
   * verification; rejections keep the challenge service's codes (INTERNALS).
   * Rate limit: link 10/min/user.
   */
  @Post("link")
  @HttpCode(200)
  async link(@Body() body: LinkWalletDto, @Req() req: AuthedRequest): Promise<{ wallet: ApiWallet; identity: ApiIdentity }> {
    const { user, session } = principalOf(req);
    await this.rateLimit.enforce("link", { userId: user.id });
    const verified = await this.challenges.verify({
      challengeId: body.challengeId,
      partyId: body.partyId,
      publicKey: body.publicKey,
      signature: body.signature,
      expectedPurpose: "link-wallet",
      sessionId: session.id,
    });
    const linked = await this.walletLinks.link(
      user.id,
      { partyId: verified.partyId, publicKeyBase64: verified.publicKeyBase64, kind: body.kind },
      { label: body.label, actor: actorOf(req) },
    );
    const locked = await this.identities.lockedIdentityId(user.id);
    return {
      wallet: this.walletLinks.toApi(linked.wallet),
      identity: this.identities.toApi(linked.identity, locked),
    };
  }

  /** `409 primary_wallet_in_use | last_identity | identity_locked_by_kyc` (one IdentityService.unlink, §6.5). */
  @Delete(":id")
  @HttpCode(200)
  async unlink(@Param("id", ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<{ ok: true }> {
    const { user } = principalOf(req);
    await this.walletLinks.unlink(user.id, id, actorOf(req));
    return { ok: true };
  }

  /** §8.2: only while the user has no UserWallet on-ledger and no queued payouts → `409 primary_wallet_in_use`. */
  @Post(":id/primary")
  @HttpCode(200)
  async setPrimary(@Param("id", ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<{ wallet: ApiWallet }> {
    const { user } = principalOf(req);
    const wallet = await this.walletLinks.setPrimary(user.id, id, actorOf(req));
    return { wallet: this.walletLinks.toApi(wallet) };
  }
}
