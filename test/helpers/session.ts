import { createHash } from "node:crypto";
import type request from "supertest";

import { AuthIdentityEntity } from "../../src/entities/auth-identity.entity";
import { SessionEntity } from "../../src/entities/session.entity";
import { UserEntity } from "../../src/entities/user.entity";
import { WalletEntity } from "../../src/entities/wallet.entity";
import { IdentityService } from "../../src/services/identity.service";
import { SessionService } from "../../src/services/session.service";
import type {
  ApiChallenge,
  ApiLoginResult,
  ApiUser,
  ApiWallet,
  IdentityClaim,
  SessionKind,
} from "../../src/types";
import { SESSION_COOKIE } from "../../src/util/cookies";
import type { TestApp } from "./app";
import { TEST_ORIGIN } from "./app";
import type { TestWallet } from "./wallet";

/** Typed access to a supertest body (the raw `body` is `any`). */
export function bodyOf<T>(res: request.Response): T {
  return res.body as T;
}

export function cookieFromResponse(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = list.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!hit) throw new Error("response set no session cookie");
  return hit.split(";")[0];
}

/**
 * Operator sign-in over HTTP (`POST /auth/admin/challenge` → sign → `POST /auth/admin`,
 * ARCHITECTURE §7.4): a `kind = "admin"` session for a party listed in ADMIN_OPERATORS (§6.8).
 * Throws with the body when the sign-in is refused.
 */
export async function signInAsAdmin(
  agent: request.Agent,
  operator: TestWallet,
): Promise<{ user: ApiUser; cookie: string; result: ApiLoginResult }> {
  const headers: Record<string, string> = {
    Origin: TEST_ORIGIN,
    "Content-Type": "application/json",
  };
  const challenge = await agent
    .post("/api/v1/auth/admin/challenge")
    .set(headers)
    .send({ partyId: operator.partyId })
    .expect(200);
  const { challengeId, message } = challenge.body as ApiChallenge;
  const login = await agent
    .post("/api/v1/auth/admin")
    .set(headers)
    .send({
      challengeId,
      partyId: operator.partyId,
      publicKey: operator.publicKeyBase64,
      signature: operator.sign(message),
      kind: "cantor8",
    });
  if (login.status !== 200) {
    throw new Error(`POST /auth/admin → ${login.status} ${JSON.stringify(login.body)}`);
  }
  const result = login.body as ApiLoginResult;
  return { user: result.user, cookie: cookieFromResponse(login), result };
}

/** A stable numeric Telegram subject for a test wallet, so a directly issued fixture is reproducible per key. */
export function telegramSubjectFor(wallet: TestWallet): string {
  return BigInt(
    `0x${createHash("sha256").update(wallet.partyId, "utf8").digest("hex").slice(0, 12)}`,
  ).toString();
}

/**
 * Issues a session directly through the services — no HTTP, so feature packages can test their
 * routes independently of the login controller. Mirrors what the routes would have produced
 * (ARCHITECTURE §6.1, §6.8):
 *  - `kind: "user"` (default): a `telegram` identity whose subject derives from `wallet`, plus —
 *    unless `withWalletRow === false` — the wallet row inserted directly (primary when it is the
 *    first), so callers can rely on `user.partyId`;
 *  - `kind: "admin"`: an operator's `canton_wallet` identity carrying its verified key in
 *    `profile.publicKey` (what `POST /auth/admin` records) and NO wallet row.
 */
export async function issueSessionDirect(
  ctx: TestApp,
  wallet: TestWallet,
  opts: { kind?: SessionKind; withWalletRow?: boolean; ip?: string } = {},
): Promise<{
  user: UserEntity;
  identity: AuthIdentityEntity;
  session: SessionEntity;
  token: string;
  cookie: string;
  bearer: string;
}> {
  const identities = ctx.get(IdentityService);
  const sessions = ctx.get(SessionService);
  const kind = opts.kind ?? "user";
  const hint = wallet.partyId.split("::")[0];
  const claim: IdentityClaim =
    kind === "admin"
      ? {
          provider: "canton_wallet",
          subject: wallet.partyId,
          profile: { name: hint, publicKey: wallet.publicKeyBase64 },
        }
      : { provider: "telegram", subject: telegramSubjectFor(wallet), profile: { name: hint } };
  const { user, identity } = await identities.resolveForLogin(claim, {
    currentUser: null,
    ip: opts.ip ?? "127.0.0.1",
  });
  if (kind === "user" && opts.withWalletRow !== false) {
    const wallets = ctx.dataSource.getRepository(WalletEntity);
    const existing = await wallets.findOne({ where: { partyId: wallet.partyId } });
    if (!existing) {
      const isPrimary = !(await wallets.findOne({
        where: { userId: user.id, isPrimary: true, status: "active" },
      }));
      await wallets.save(
        wallets.create({
          userId: user.id,
          chain: "canton",
          kind: "cantor8",
          partyId: wallet.partyId,
          publicKey: wallet.publicKeyBase64,
          label: null,
          isPrimary,
          status: "active",
          creditedCC: 0n,
          verifiedAt: new Date(),
          revokedAt: null,
        }),
      );
      if (isPrimary)
        await ctx.dataSource
          .getRepository(UserEntity)
          .update({ id: user.id }, { partyId: wallet.partyId });
    }
  }
  const { token, session } = await sessions.issue({
    userId: user.id,
    authIdentityId: identity.id,
    kind,
    ip: opts.ip ?? "127.0.0.1",
    userAgent: "jest",
  });
  const fresh =
    (await ctx.dataSource.getRepository(UserEntity).findOne({ where: { id: user.id } })) ?? user;
  return {
    user: fresh,
    identity,
    session,
    token,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    bearer: `Bearer ${token}`,
  };
}

/**
 * Links a wallet to the session's account over HTTP (`POST /wallets/link-challenge` → sign →
 * `POST /wallets/link`, ARCHITECTURE §8.1); the first linked wallet becomes the primary. Throws
 * with the body when the link is refused.
 */
export async function linkWallet(
  agent: request.Agent,
  cookie: string,
  wallet: TestWallet,
  opts: { label?: string } = {},
): Promise<{ wallet: ApiWallet }> {
  const headers: Record<string, string> = {
    Origin: TEST_ORIGIN,
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  const challenge = await agent
    .post("/api/v1/wallets/link-challenge")
    .set(headers)
    .send({ partyId: wallet.partyId })
    .expect(200);
  const { challengeId, message } = challenge.body as ApiChallenge;
  const res = await agent
    .post("/api/v1/wallets/link")
    .set(headers)
    .send({
      challengeId,
      partyId: wallet.partyId,
      publicKey: wallet.publicKeyBase64,
      signature: wallet.sign(message),
      kind: "cantor8",
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    });
  if (res.status !== 200) {
    throw new Error(`POST /wallets/link → ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as { wallet: ApiWallet };
}
