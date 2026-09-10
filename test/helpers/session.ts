import type request from "supertest";

import { AuthIdentityEntity } from "../../src/entities/auth-identity.entity";
import { SessionEntity } from "../../src/entities/session.entity";
import { UserEntity } from "../../src/entities/user.entity";
import { WalletEntity } from "../../src/entities/wallet.entity";
import { IdentityService } from "../../src/services/identity.service";
import { SessionService } from "../../src/services/session.service";
import type { ApiChallenge, ApiIdentity, ApiLoginResult, ApiUser, ApiWallet, ChallengePurpose, SessionKind } from "../../src/types";
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
 * Runs the real HTTP challenge → sign → login flow (`POST /auth/wallet/challenge`,
 * `POST /auth/wallet`). Pass `purpose = "admin-sign-in"` (or use `signInAsAdmin`) for an operator
 * party listed in ADMIN_OPERATORS; `opts.cookie` runs the flow in link mode for that session.
 */
export async function signInWithWallet(
  agent: request.Agent,
  wallet: TestWallet,
  purpose: ChallengePurpose = "sign-in",
  opts: { client?: "web" | "native"; cookie?: string } = {},
): Promise<{ user: ApiUser; cookie: string; token?: string; result: ApiLoginResult }> {
  const headers: Record<string, string> = { Origin: TEST_ORIGIN, "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const challenge = await agent.post("/api/v1/auth/wallet/challenge").set(headers).send({ partyId: wallet.partyId, purpose }).expect(200);
  const { challengeId, message } = challenge.body as ApiChallenge;
  const login = await agent
    .post("/api/v1/auth/wallet")
    .set(headers)
    .send({ challengeId, partyId: wallet.partyId, publicKey: wallet.publicKeyBase64, signature: wallet.sign(message), kind: "cantor8", client: opts.client ?? "web" });
  if (login.status !== 200) {
    throw new Error(`POST /auth/wallet → ${login.status} ${JSON.stringify(login.body)}`);
  }
  const result = login.body as ApiLoginResult;
  return { user: result.user, cookie: opts.cookie ?? cookieFromResponse(login), token: result.token, result };
}

/**
 * Creates a user + `canton_wallet` identity (+ wallet row, primary) and issues a session
 * directly through the services — no HTTP, so feature packages can test their routes before
 * or independently of P1's login controller.
 */
export async function issueSessionDirect(
  ctx: TestApp,
  wallet: TestWallet,
  opts: { kind?: SessionKind; withWalletRow?: boolean; ip?: string } = {},
): Promise<{ user: UserEntity; identity: AuthIdentityEntity; session: SessionEntity; token: string; cookie: string; bearer: string }> {
  const identities = ctx.get(IdentityService);
  const sessions = ctx.get(SessionService);
  const { user, identity } = await identities.resolveForLogin(
    { provider: "canton_wallet", subject: wallet.partyId, profile: { name: wallet.partyId.split("::")[0] } },
    { currentUser: null, ip: opts.ip ?? "127.0.0.1" },
  );
  if (opts.withWalletRow !== false) {
    const wallets = ctx.dataSource.getRepository(WalletEntity);
    const existing = await wallets.findOne({ where: { partyId: wallet.partyId } });
    if (!existing) {
      const isPrimary = !(await wallets.findOne({ where: { userId: user.id, isPrimary: true, status: "active" } }));
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
      if (isPrimary) await ctx.dataSource.getRepository(UserEntity).update({ id: user.id }, { partyId: wallet.partyId });
    }
  }
  const { token, session } = await sessions.issue({ userId: user.id, authIdentityId: identity.id, kind: opts.kind ?? "user", ip: opts.ip ?? "127.0.0.1", userAgent: "jest" });
  const fresh = (await ctx.dataSource.getRepository(UserEntity).findOne({ where: { id: user.id } })) ?? user;
  return { user: fresh, identity, session, token, cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`, bearer: `Bearer ${token}` };
}

/** `signInWithWallet` with purpose `admin-sign-in`: a `kind = "admin"` session for an operator party (§6.8). */
export async function signInAsAdmin(
  agent: request.Agent,
  operator: TestWallet,
  opts: { client?: "web" | "native" } = {},
): Promise<{ user: ApiUser; cookie: string; token?: string; result: ApiLoginResult }> {
  return signInWithWallet(agent, operator, "admin-sign-in", opts);
}

/**
 * Links an additional wallet to the session's account over HTTP (`POST /wallets/link-challenge`
 * → sign → `POST /wallets/link`, ARCHITECTURE §8.1). Throws with the body when the link is refused.
 */
export async function linkWallet(
  agent: request.Agent,
  cookie: string,
  wallet: TestWallet,
  opts: { label?: string } = {},
): Promise<{ wallet: ApiWallet; identity: ApiIdentity }> {
  const headers: Record<string, string> = { Origin: TEST_ORIGIN, "Content-Type": "application/json", Cookie: cookie };
  const challenge = await agent.post("/api/v1/wallets/link-challenge").set(headers).send({ partyId: wallet.partyId }).expect(200);
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
  return res.body as { wallet: ApiWallet; identity: ApiIdentity };
}
