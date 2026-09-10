/**
 * Wallets + deposits end to end (docs/API.md "Wallets" / "In-app wallet"; ARCHITECTURE §8.1–8.4).
 * Real Postgres + Redis; the ledger and the Enterprise Wallet are the in-memory fakes, so every
 * treasury-signed `Create UserWallet` / `Deposit` is applied to FakeLedgerClient the way the real
 * ledger would and can be inspected afterwards. Google sign-in is replaced by a fake verifier so a
 * wallet-less (social-login) account can be minted through the real `POST /auth/google` route.
 *
 * Every request goes through a jar-less supertest instance with an explicit `Cookie` header: a
 * supertest *agent* stores the last `Set-Cookie` it saw and merges it over an explicit header, so
 * after one user signs in through it every later request would silently carry that user's session.
 */
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";

import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { AuthIdentityEntity } from "../src/entities/auth-identity.entity";
import { DepositCreditEntity } from "../src/entities/deposit-credit.entity";
import { PayoutEntity } from "../src/entities/payout.entity";
import { UserEntity } from "../src/entities/user.entity";
import { WalletEntity } from "../src/entities/wallet.entity";
import { DepositConfirmProcessor } from "../src/processors/deposit-confirm.processor";
import { GoogleAuthService } from "../src/services/google-auth.service";
import { walletCreateCommandIdFor } from "../src/services/ledger-client.service";
import { UserService } from "../src/services/user.service";
import type {
  ApiChallenge,
  ApiIdentity,
  ApiLoginResult,
  ApiMe,
  ApiSessionState,
  ApiUser,
  ApiWallet,
  IdentityClaim,
  InAppWalletOverview,
  ReconcileResult,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { formatCC, parseCC } from "../src/util/money";
import { TEST_ORIGIN, useTestApp } from "./helpers/app";
import { bodyOf, cookieFromResponse, signInWithWallet } from "./helpers/session";
import { makeTestWallet, type TestWallet } from "./helpers/wallet";

// ─────────────────────────────────────────── fakes ───────────────────────────────────────────────

/** GoogleAuthService per §7.1 shape; the credential IS the Google `sub`, so no token is needed. */
class FakeGoogleAuthService {
  isConfigured(): boolean {
    return true;
  }

  issueNonce(): Promise<{ nonce: string; expiresAt: string }> {
    return Promise.resolve({ nonce: "e2e-nonce-unused", expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }

  verifyCredential(credential: string): Promise<IdentityClaim> {
    return Promise.resolve({ provider: "google", subject: credential, email: `${credential}@example.com`, profile: { name: "Google User" } });
  }
}

// ─────────────────────────────────────────── helpers ─────────────────────────────────────────────

/** `"12.5"` → `"12.5000000000"` (docs/API.md: money is a string with exactly 10 decimals). */
const CC = (value: string): string => formatCC(parseCC(value));
const MONEY_RE = /^-?\d+\.\d{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMAND_ID_RE = /^deposit-[0-9a-f]{40}$/;
/** What a browser sends on every non-GET (API.md "Auth"). */
const H = { Origin: TEST_ORIGIN, "Content-Type": "application/json", "x-requested-with": "truthoracle" };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function expectStatus(res: request.Response, status: number): request.Response {
  if (res.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res;
}

function expectError(res: request.Response, status: number, code: string): ErrorBody {
  expectStatus(res, status);
  const body = bodyOf<ErrorBody>(res);
  expect(body.error).toBe(code);
  expect(typeof body.message).toBe("string");
  return body;
}

interface Signed {
  user: ApiUser;
  cookie: string;
}

interface LinkResponse {
  wallet: ApiWallet;
  identity: ApiIdentity;
  seededLegacyCreditedCC: string;
}

type LedgerCommand = {
  CreateCommand?: { templateId: string; createArguments: Record<string, unknown> };
  ExerciseCommand?: { templateId: string; contractId: string; choice: string; choiceArgument: Record<string, unknown> };
};

// ─────────────────────────────────────────── spec ────────────────────────────────────────────────

describe("Wallets + deposits (e2e, DAML_USER_WALLET_HAS_DEPOSIT_REFS=true — the deployed 2.0.0 Daml)", () => {
  const refs = useTestApp({
    env: { DAML_USER_WALLET_HAS_DEPOSIT_REFS: "true" },
    configure: (b) => b.overrideProvider(GoogleAuthService).useValue(new FakeGoogleAuthService()),
  });
  const http = (): request.Agent => request(refs.app.getHttpServer() as Server);
  const credits = (): ReturnType<typeof refs.dataSource.getRepository<DepositCreditEntity>> => refs.dataSource.getRepository(DepositCreditEntity);

  it("Create carries depositRefs: [], Deposit carries the txRef, and confirmation keys on depositRefs — not on the amount", async () => {
    const A = makeTestWallet("alice");
    const { cookie } = await signInWithWallet(http(), A);
    refs.wallet.seedInbound(A.partyId, "5");

    const res = await http().post("/api/v1/in-app-wallet/deposits/reconcile").set(H).set("Cookie", cookie).send({});
    expectStatus(res, 200);
    const body = bodyOf<ReconcileResult>(res);
    expect(body).toMatchObject({ credited: CC("5"), status: "confirmed" });
    const [create] = refs.wallet.submits[0].commands as LedgerCommand[];
    expect(create.CreateCommand?.createArguments).toMatchObject({ owner: A.partyId, depositedCC: CC("0"), depositRefs: [] });
    const [deposit] = refs.wallet.submits[1].commands as LedgerCommand[];
    const txRef = `reconcile:${body.commandId ?? ""}`;
    expect(deposit.ExerciseCommand?.choiceArgument).toEqual({ amountCC: CC("5"), txRef });
    expect(refs.ledger.wallets.get(A.partyId)?.depositRefs).toEqual([txRef]);

    // A second credit: the ledger shows the RIGHT depositedCC but a FOREIGN ref → not confirmed;
    // only the row's own txRef confirms it.
    refs.wallet.seedInbound(A.partyId, "1");
    refs.wallet.lagLedger = true;
    const second = bodyOf<ReconcileResult>(expectStatus(await http().post("/api/v1/in-app-wallet/deposits/reconcile").set(H).set("Cookie", cookie).send({}), 200));
    expect(second.status).toBe("submitted");
    const row = await credits().findOneByOrFail({ commandId: second.commandId ?? "" });
    const w = refs.ledger.wallets.get(A.partyId);
    if (!w) throw new Error("wallet missing");
    refs.ledger.wallets.set(A.partyId, { ...w, contractId: refs.ledger.nextCid("uw"), balanceCC: w.balanceCC + parseCC("1"), depositedCC: w.depositedCC + parseCC("1"), depositRefs: [...w.depositRefs, "reconcile:someone-else"] });
    await expect(refs.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 0, failed: 0 });
    expect((await credits().findOneByOrFail({ id: row.id })).status).toBe("submitted");
    const w2 = refs.ledger.wallets.get(A.partyId);
    if (!w2) throw new Error("wallet missing");
    refs.ledger.wallets.set(A.partyId, { ...w2, depositRefs: [...w2.depositRefs, row.txRef] });
    await expect(refs.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 1, failed: 0 });
    expect((await credits().findOneByOrFail({ id: row.id })).status).toBe("confirmed");
    refs.wallet.lagLedger = false;
  });
});

describe("Wallets + deposits (e2e)", () => {
  const ctx = useTestApp({
    configure: (b) => b.overrideProvider(GoogleAuthService).useValue(new FakeGoogleAuthService()),
  });

  /** Jar-less: cookies are always explicit (see the header comment). */
  const http = (): request.Agent => request(ctx.app.getHttpServer() as Server);
  const get = (path: string, cookie: string): request.Test => http().get(`/api/v1${path}`).set("Cookie", cookie);
  const post = (path: string, cookie: string): request.Test => http().post(`/api/v1${path}`).set(H).set("Cookie", cookie);
  const del = (path: string, cookie: string): request.Test => http().delete(`/api/v1${path}`).set(H).set("Cookie", cookie);

  const wallets = (): ReturnType<typeof ctx.dataSource.getRepository<WalletEntity>> => ctx.dataSource.getRepository(WalletEntity);
  const credits = (): ReturnType<typeof ctx.dataSource.getRepository<DepositCreditEntity>> => ctx.dataSource.getRepository(DepositCreditEntity);
  const auditRows = (action: string): Promise<AuditEventEntity[]> => ctx.dataSource.getRepository(AuditEventEntity).find({ where: { action }, order: { id: "ASC" } });
  const walletRow = (partyId: string): Promise<WalletEntity> => wallets().findOneByOrFail({ partyId });
  const identityRow = (partyId: string): Promise<AuthIdentityEntity> => ctx.dataSource.getRepository(AuthIdentityEntity).findOneByOrFail({ provider: "canton_wallet", subject: partyId });
  const userRow = (id: string): Promise<UserEntity> => ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id });

  /** The real challenge → sign → `POST /auth/wallet` flow (purpose sign-in). */
  async function signIn(wallet: TestWallet): Promise<Signed> {
    const { user, cookie } = await signInWithWallet(http(), wallet);
    return { user, cookie };
  }

  /** A wallet-less account through the real `POST /auth/google` route (verifier faked). */
  async function googleSignIn(subject: string): Promise<Signed> {
    const res = await http().post("/api/v1/auth/google").set(H).send({ credential: subject });
    expectStatus(res, 200);
    const body = bodyOf<ApiLoginResult>(res);
    expect(body).toMatchObject({ mode: "login", kind: "user", identity: { provider: "google", subject } });
    return { user: body.user, cookie: cookieFromResponse(res) };
  }

  /** The sign-in flow, but returning the final response so refusals can be asserted. */
  async function signInAttempt(wallet: TestWallet): Promise<request.Response> {
    const challenge = await http().post("/api/v1/auth/wallet/challenge").set(H).send({ partyId: wallet.partyId, purpose: "sign-in" });
    expectStatus(challenge, 200);
    const { challengeId, message } = bodyOf<ApiChallenge>(challenge);
    return http()
      .post("/api/v1/auth/wallet")
      .set(H)
      .send({ challengeId, partyId: wallet.partyId, publicKey: wallet.publicKeyBase64, signature: wallet.sign(message), kind: "cantor8" });
  }

  /** `POST /wallets/link-challenge` → sign → `POST /wallets/link`; the raw response so 409s can be asserted. */
  async function link(cookie: string, wallet: TestWallet, extra: { label?: string } = {}): Promise<request.Response> {
    const challenge = await post("/wallets/link-challenge", cookie).send({ partyId: wallet.partyId });
    expectStatus(challenge, 200);
    const { challengeId, message, expiresAt } = bodyOf<ApiChallenge>(challenge);
    expect(challengeId).toMatch(UUID_RE);
    expect(message).toContain("TruthOracle link-wallet");
    expect(message).toContain(`Party: ${wallet.partyId}`);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    return post("/wallets/link", cookie).send({
      challengeId,
      partyId: wallet.partyId,
      publicKey: wallet.publicKeyBase64,
      signature: wallet.sign(message),
      kind: "cantor8",
      ...extra,
    });
  }

  async function linkOk(cookie: string, wallet: TestWallet, extra: { label?: string } = {}): Promise<LinkResponse> {
    const res = await link(cookie, wallet, extra);
    expectStatus(res, 200);
    const body = bodyOf<LinkResponse>(res);
    expect(body.wallet.partyId).toBe(wallet.partyId);
    expect(body.identity).toMatchObject({ provider: "canton_wallet", subject: wallet.partyId, status: "active" });
    expect(body.seededLegacyCreditedCC).toMatch(MONEY_RE);
    return body;
  }

  async function listWallets(cookie: string): Promise<ApiWallet[]> {
    const res = await get("/wallets", cookie);
    expectStatus(res, 200);
    return bodyOf<{ wallets: ApiWallet[] }>(res).wallets;
  }

  async function overview(cookie: string): Promise<InAppWalletOverview> {
    const res = await get("/in-app-wallet", cookie);
    expectStatus(res, 200);
    return bodyOf<InAppWalletOverview>(res);
  }

  const reconcile = (cookie: string): request.Test => post("/in-app-wallet/deposits/reconcile", cookie).send({});

  async function reconcileOk(cookie: string): Promise<ReconcileResult> {
    const res = await reconcile(cookie);
    expectStatus(res, 200);
    const body = bodyOf<ReconcileResult>(res);
    expect(body.credited).toMatch(MONEY_RE);
    for (const p of body.perWallet) expect(p.amountCC).toMatch(MONEY_RE);
    return body;
  }

  /** Simulate a change to the primary's on-ledger UserWallet that did not go through the backend. */
  function bumpLedger(partyId: string, deltaCC: string): void {
    const w = ctx.ledger.wallets.get(partyId);
    if (!w) throw new Error(`no on-ledger UserWallet for ${partyId}`);
    const delta = parseCC(deltaCC);
    ctx.ledger.wallets.set(partyId, { ...w, contractId: ctx.ledger.nextCid("uw"), balanceCC: w.balanceCC + delta, depositedCC: w.depositedCC + delta });
  }

  // ───────────────────────────────────────── access ────────────────────────────────────────────
  describe("access", () => {
    it("every wallet route needs a session; non-GETs are CSRF-checked", async () => {
      await http().get("/api/v1/wallets").expect(401);
      await http().get("/api/v1/in-app-wallet").expect(401);
      await http().post("/api/v1/wallets/link-challenge").set(H).send({ partyId: makeTestWallet("anon").partyId }).expect(401);
      await http().post("/api/v1/in-app-wallet/deposits/reconcile").set(H).send({}).expect(401);
      await http().delete(`/api/v1/wallets/${randomUUID()}`).set(H).expect(401);

      const a = await signIn(makeTestWallet("alice"));
      const noOrigin = await http().post("/api/v1/in-app-wallet/deposits/reconcile").set("Cookie", a.cookie).set("Content-Type", "application/json").send({});
      expectError(noOrigin, 403, "csrf_rejected");
      const badOrigin = await http().post("/api/v1/wallets/link-challenge").set("Cookie", a.cookie).set("Origin", "https://evil.test").set("Content-Type", "application/json").send({ partyId: a.user.partyId });
      expectError(badOrigin, 403, "csrf_rejected");
    });

    it("link bodies are validated (400 validation_failed) — API.md 'Wallets'", async () => {
      const a = await signIn(makeTestWallet("alice"));
      const badParty = await post("/wallets/link-challenge", a.cookie).send({ partyId: "not-a-party" });
      const issues = expectError(badParty, 400, "validation_failed").details?.issues;
      expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(/partyId/)]));

      const badLink = await post("/wallets/link", a.cookie).send({ challengeId: "nope", partyId: a.user.partyId, publicKey: "x", signature: "y", kind: "ledger" });
      expectError(badLink, 400, "validation_failed");
      // Non-UUID wallet ids are refused before any lookup.
      expectError(await post("/wallets/not-a-uuid/primary", a.cookie).send({}), 400, "validation_failed");
      expectError(await del("/wallets/not-a-uuid", a.cookie), 400, "validation_failed");
    });
  });

  // ───────────────────────────────────────── linking (§8.1) ────────────────────────────────────
  describe("linking (§8.1, API.md 'Wallets')", () => {
    it("sign-in with wallet A seeds one active primary wallet with a zero legacy seed — API.md GET /wallets", async () => {
      const A = makeTestWallet("alice");
      const a = await signIn(A);
      expect(a.user.partyId).toBe(A.partyId);

      const list = await listWallets(a.cookie);
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        id: expect.stringMatching(UUID_RE) as string,
        chain: "canton",
        kind: "cantor8",
        partyId: A.partyId,
        label: null,
        isPrimary: true,
        status: "active",
        verifiedAt: expect.any(String) as string,
        creditedCC: CC("0"),
        legacyCreditedCC: CC("0"),
        ownLedgerWallet: null,
      });
      // receivedCC is only computed for GET /in-app-wallet (API.md `Wallet`).
      expect(list[0]).not.toHaveProperty("receivedCC");

      const row = await walletRow(A.partyId);
      expect(row).toMatchObject({ userId: a.user.id, isPrimary: true, status: "active", legacyCreditedCC: 0n, creditedCC: 0n, publicKey: A.publicKeyBase64, revokedAt: null });
      expect((await userRow(a.user.id)).partyId).toBe(A.partyId);
      expect(await auditRows("wallet.linked")).toHaveLength(1);
      expect(await auditRows("wallet.legacy_seeded")).toHaveLength(1);
    });

    it("POST /wallets/link-challenge + /wallets/link attaches a second, non-primary wallet", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);

      const linked = await linkOk(a.cookie, B, { label: "cold" });
      expect(linked.wallet).toMatchObject({
        partyId: B.partyId,
        chain: "canton",
        kind: "cantor8",
        isPrimary: false,
        status: "active",
        label: "cold",
        creditedCC: CC("0"),
        legacyCreditedCC: CC("0"),
        ownLedgerWallet: null,
      });
      expect(linked.identity).toMatchObject({ provider: "canton_wallet", subject: B.partyId, status: "active", kycLocked: false });
      expect(linked.seededLegacyCreditedCC).toBe(CC("0"));

      const list = await listWallets(a.cookie);
      expect(list).toHaveLength(2);
      expect(list.find((w) => w.partyId === A.partyId)).toMatchObject({ isPrimary: true, status: "active" });
      expect(list.find((w) => w.partyId === B.partyId)).toMatchObject({ id: linked.wallet.id, isPrimary: false, status: "active", label: "cold" });

      // The primary did not move (§7.3: only the FIRST wallet becomes primary).
      const session = bodyOf<ApiSessionState>(await get("/auth/session", a.cookie).expect(200));
      expect(session.user?.partyId).toBe(A.partyId);
      expect((await userRow(a.user.id)).partyId).toBe(A.partyId);
      expect((await identityRow(B.partyId)).userId).toBe(a.user.id);

      const linkedAudits = await auditRows("wallet.linked");
      expect(linkedAudits).toHaveLength(2);
      expect(linkedAudits[1]).toMatchObject({ actorType: "user", actorUserId: a.user.id, subjectType: "wallet", subjectId: linked.wallet.id });
      expect(linkedAudits[1].actorSessionId).not.toBeNull();
      expect(ctx.nats.publishedOn("truthoracle.wallet.linked")).toHaveLength(2);
    });

    it("GET /me lists both canton_wallet identities and both wallets after a link — API.md 'Me'", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);
      await linkOk(a.cookie, B);

      const me = bodyOf<ApiMe>(expectStatus(await get("/me", a.cookie), 200));
      const cantonIdentities = me.identities.filter((i) => i.provider === "canton_wallet");
      expect(cantonIdentities).toHaveLength(2);
      expect(cantonIdentities.map((i) => i.subject).sort()).toEqual([A.partyId, B.partyId].sort());
      expect(cantonIdentities.every((i) => i.status === "active" && i.kycLocked === false)).toBe(true);
      expect(me.identities).toHaveLength(2);
      expect(me.wallets.map((w) => [w.partyId, w.isPrimary])).toEqual(expect.arrayContaining([[A.partyId, true], [B.partyId, false]]));
      expect(me.capabilities.primaryPartyId).toBe(A.partyId);
      expect(me.user.partyId).toBe(A.partyId);
    });

    it("a social-login account's first linked wallet becomes primary and sets users.partyId", async () => {
      const g = await googleSignIn("google-sub-0000000001");
      expect(g.user.partyId).toBeNull();
      expect(await listWallets(g.cookie)).toEqual([]);

      const A = makeTestWallet("alice");
      const linked = await linkOk(g.cookie, A);
      expect(linked.wallet).toMatchObject({ partyId: A.partyId, isPrimary: true, status: "active" });
      expect((await userRow(g.user.id)).partyId).toBe(A.partyId);
      expect(bodyOf<ApiSessionState>(await get("/auth/session", g.cookie).expect(200)).user?.partyId).toBe(A.partyId);
      expect((await listWallets(g.cookie)).map((w) => [w.partyId, w.isPrimary])).toEqual([[A.partyId, true]]);
    });

    it("seeds legacy_credited_cc from the party's own on-ledger UserWallet and shows it as ownLedgerWallet (§8.1)", async () => {
      const A = makeTestWallet("alice");
      const C = makeTestWallet("carol");
      const a = await signIn(A);
      // C deposited 5 CC through the legacy path before any account existed.
      const own = ctx.ledger.seedUserWallet(C.partyId, { balanceCC: "4.25", depositedCC: "5", withdrawnCC: "0.75" });
      ctx.wallet.seedInbound(C.partyId, "5");

      const linked = await linkOk(a.cookie, C);
      expect(linked.seededLegacyCreditedCC).toBe(CC("5"));
      expect(linked.wallet).toMatchObject({ partyId: C.partyId, isPrimary: false, legacyCreditedCC: CC("5"), creditedCC: CC("0") });
      expect((await walletRow(C.partyId)).legacyCreditedCC).toBe(parseCC("5"));
      const seeded = await auditRows("wallet.legacy_seeded");
      expect(seeded.map((e) => e.subjectId)).toContain(linked.wallet.id);

      const ov = await overview(a.cookie);
      const c = ov.wallets.find((w) => w.partyId === C.partyId);
      expect(c?.ownLedgerWallet).toEqual({ contractId: own.contractId, owner: C.partyId, balanceCC: CC("4.25"), depositedCC: CC("5"), withdrawnCC: CC("0.75") });
      expect(c?.legacyCreditedCC).toBe(CC("5"));
      expect(ov.wallets.find((w) => w.partyId === A.partyId)?.ownLedgerWallet).toBeNull();

      // Legacy credits are never re-credited into the primary, and C's own wallet is never folded in.
      const res = await reconcileOk(a.cookie);
      expect(res).toMatchObject({ credited: CC("0"), status: "nothing_outstanding", perWallet: [] });
      expect(ctx.wallet.submits).toHaveLength(0);
      expect(ctx.ledger.wallets.get(C.partyId)).toMatchObject({ contractId: own.contractId, depositedCC: parseCC("5") });
      expect(ctx.ledger.wallets.has(A.partyId)).toBe(false);
    });

    it("POST /wallets/:id/primary switches the primary while nothing pins it, then 409 primary_wallet_in_use (§8.2)", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);
      const linked = await linkOk(a.cookie, B);
      const before = await listWallets(a.cookie);
      const aRow = before.find((w) => w.partyId === A.partyId);
      if (!aRow) throw new Error("wallet A missing");

      const switched = await post(`/wallets/${linked.wallet.id}/primary`, a.cookie).send({});
      expectStatus(switched, 200);
      expect(bodyOf<{ wallet: ApiWallet }>(switched).wallet).toMatchObject({ id: linked.wallet.id, partyId: B.partyId, isPrimary: true, status: "active" });

      const after = await listWallets(a.cookie);
      expect(after.find((w) => w.partyId === A.partyId)).toMatchObject({ isPrimary: false, status: "active" });
      expect(after.find((w) => w.partyId === B.partyId)).toMatchObject({ isPrimary: true, status: "active" });
      expect((await userRow(a.user.id)).partyId).toBe(B.partyId);
      expect(bodyOf<ApiSessionState>(await get("/auth/session", a.cookie).expect(200)).user?.partyId).toBe(B.partyId);
      const changed = await auditRows("wallet.primary_changed");
      expect(changed.find((e) => e.metadata.from === A.partyId && e.metadata.to === B.partyId)).toMatchObject({ actorType: "user", actorUserId: a.user.id, subjectId: linked.wallet.id });
      expect(ctx.nats.publishedOn("truthoracle.wallet.primary_changed")).toHaveLength(1);

      // Idempotent on the current primary.
      expectStatus(await post(`/wallets/${linked.wallet.id}/primary`, a.cookie).send({}), 200);

      // A payout still addressed to the primary pins it …
      const payout = ctx.ledger.seedPendingPayout({ user: B.partyId, amountCC: "1", reason: "withdraw" });
      expectError(await post(`/wallets/${aRow.id}/primary`, a.cookie).send({}), 409, "primary_wallet_in_use");
      ctx.ledger.archivePayout(payout.contractId);

      // … and once the primary owns an on-ledger UserWallet it is permanent.
      ctx.ledger.seedUserWallet(B.partyId, { balanceCC: "1", depositedCC: "1" });
      expectError(await post(`/wallets/${aRow.id}/primary`, a.cookie).send({}), 409, "primary_wallet_in_use");
      expect((await listWallets(a.cookie)).find((w) => w.isPrimary)?.partyId).toBe(B.partyId);
      expect((await userRow(a.user.id)).partyId).toBe(B.partyId);

      expectError(await post(`/wallets/${randomUUID()}/primary`, a.cookie).send({}), 404, "not_found");
    });

    it("DELETE /wallets/:id: primary → 409; a secondary is revoked (identity unlinked) and relinking reactivates the same row", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);
      const linked = await linkOk(a.cookie, B);
      const aRow = (await listWallets(a.cookie)).find((w) => w.partyId === A.partyId);
      if (!aRow) throw new Error("wallet A missing");

      expectError(await del(`/wallets/${aRow.id}`, a.cookie), 409, "primary_wallet_in_use");
      expect((await walletRow(A.partyId)).status).toBe("active");

      // Credits already attributed to B survive the unlink (§8.3 attributes over revoked rows too).
      await wallets().update({ id: linked.wallet.id }, { creditedCC: parseCC("3") });

      const ok = await del(`/wallets/${linked.wallet.id}`, a.cookie);
      expectStatus(ok, 200);
      expect(ok.body).toEqual({ ok: true });

      // API.md `Wallet.status` is "active" | "revoked": the revoked row stays listed with its attribution.
      const after = await listWallets(a.cookie);
      expect(after.find((w) => w.partyId === B.partyId)).toMatchObject({ id: linked.wallet.id, status: "revoked", isPrimary: false, creditedCC: CC("3") });
      const row = await walletRow(B.partyId);
      expect(row).toMatchObject({ status: "revoked", isPrimary: false, creditedCC: parseCC("3"), userId: a.user.id });
      expect(row.revokedAt).not.toBeNull();
      const identity = await identityRow(B.partyId);
      expect(identity.status).toBe("unlinked");
      expect(identity.unlinkedAt).not.toBeNull();
      expect(await auditRows("wallet.unlinked")).toHaveLength(1);
      expect(await auditRows("identity.unlinked")).toHaveLength(1);
      expect(ctx.nats.publishedOn("truthoracle.wallet.unlinked")).toHaveLength(1);
      // Nothing active is left to unlink.
      expectError(await del(`/wallets/${linked.wallet.id}`, a.cookie), 404, "not_found");
      // §6.4: the unlinked wallet cannot open a second account.
      expectError(await signInAttempt(B), 403, "identity_unlinked");
      expect(await ctx.dataSource.getRepository(UserEntity).count()).toBe(1);

      // Relink by the same user reactivates the SAME row and identity; credited / legacy untouched.
      const relinked = await linkOk(a.cookie, B);
      expect(relinked.wallet).toMatchObject({ id: linked.wallet.id, status: "active", isPrimary: false, creditedCC: CC("3"), legacyCreditedCC: CC("0") });
      expect(relinked.identity).toMatchObject({ id: linked.identity.id, status: "active" });
      expect(relinked.seededLegacyCreditedCC).toBe(CC("0"));
      expect(await wallets().count({ where: { partyId: B.partyId } })).toBe(1);
      expect(await ctx.dataSource.getRepository(AuthIdentityEntity).count({ where: { subject: B.partyId } })).toBe(1);
      const reactivated = await walletRow(B.partyId);
      expect(reactivated).toMatchObject({ status: "active", revokedAt: null, creditedCC: parseCC("3"), legacyCreditedCC: 0n });
      expect((await identityRow(B.partyId)).status).toBe("active");
      expect(await auditRows("wallet.relinked")).toHaveLength(1);
      expect((await listWallets(a.cookie)).find((w) => w.partyId === A.partyId)).toMatchObject({ isPrimary: true });
    });

    it("a party is bound to its first account forever: another user gets 409 wallet_already_linked, active or revoked", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const D = makeTestWallet("dave");
      const a = await signIn(A);
      const linked = await linkOk(a.cookie, B);
      const x = await signIn(D);

      expectError(await link(x.cookie, B), 409, "wallet_already_linked");

      expectStatus(await del(`/wallets/${linked.wallet.id}`, a.cookie), 200);
      expectError(await link(x.cookie, B), 409, "wallet_already_linked");

      // §8.1: the link is also reachable through POST /auth/wallet in link mode — same refusal.
      const challenge = await post("/auth/wallet/challenge", x.cookie).send({ partyId: B.partyId, purpose: "link-wallet" });
      expectStatus(challenge, 200);
      const { challengeId, message } = bodyOf<ApiChallenge>(challenge);
      const viaAuth = await post("/auth/wallet", x.cookie).send({ challengeId, partyId: B.partyId, publicKey: B.publicKeyBase64, signature: B.sign(message), kind: "cantor8" });
      expectError(viaAuth, 409, "wallet_already_linked");

      // Nothing was created for X, nothing moved for A.
      expect((await listWallets(x.cookie)).map((w) => w.partyId)).toEqual([D.partyId]);
      expect(await wallets().count({ where: { partyId: B.partyId } })).toBe(1);
      expect((await walletRow(B.partyId))).toMatchObject({ userId: a.user.id, status: "revoked" });
      expect((await identityRow(B.partyId)).userId).toBe(a.user.id);
    });

    it("wallet routes are scoped to the session: another user's wallets are invisible and unaddressable", async () => {
      const A = makeTestWallet("alice");
      const D = makeTestWallet("dave");
      const x = await signIn(A);
      const y = await signIn(D);

      expect((await listWallets(x.cookie)).map((w) => w.partyId)).toEqual([A.partyId]);
      expect((await listWallets(y.cookie)).map((w) => w.partyId)).toEqual([D.partyId]);
      const [dRow] = await listWallets(y.cookie);

      expectError(await del(`/wallets/${dRow.id}`, x.cookie), 404, "not_found");
      expectError(await post(`/wallets/${dRow.id}/primary`, x.cookie).send({}), 404, "not_found");
      expect((await listWallets(y.cookie))[0]).toMatchObject({ id: dRow.id, isPrimary: true, status: "active" });

      expect((await overview(x.cookie)).partyId).toBe(A.partyId);
      expect((await overview(y.cookie)).partyId).toBe(D.partyId);

      // Y's transfers never credit X.
      ctx.wallet.seedInbound(D.partyId, "3");
      expect(await reconcileOk(x.cookie)).toMatchObject({ credited: CC("0"), status: "nothing_outstanding" });
      expect(await reconcileOk(y.cookie)).toMatchObject({ credited: CC("3"), status: "confirmed", perWallet: [{ walletId: dRow.id, partyId: D.partyId, amountCC: CC("3") }] });
      expect(ctx.ledger.wallets.has(A.partyId)).toBe(false);
      expect(ctx.ledger.wallets.get(D.partyId)?.depositedCC).toBe(parseCC("3"));
    });
  });

  // ───────────────────────────────────────── reconciliation (§8.3) ─────────────────────────────
  describe("deposit reconciliation (§8.3, API.md 'In-app wallet')", () => {
    it("credits settled inbound transfers from every linked wallet into the primary's UserWallet, attributed per wallet", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);
      const linked = await linkOk(a.cookie, B);
      const aRow = (await listWallets(a.cookie)).find((w) => w.partyId === A.partyId);
      if (!aRow) throw new Error("wallet A missing");

      ctx.wallet.seedInbound(A.partyId, "10");
      ctx.wallet.seedInbound(B.partyId, "2.5");

      const res = await reconcileOk(a.cookie);
      expect(res).toEqual({
        credited: CC("12.5"),
        status: "confirmed",
        commandId: expect.stringMatching(COMMAND_ID_RE) as string,
        perWallet: expect.arrayContaining([
          { walletId: aRow.id, partyId: A.partyId, amountCC: CC("10") },
          { walletId: linked.wallet.id, partyId: B.partyId, amountCC: CC("2.5") },
        ]) as unknown[],
        ledger: { contractId: expect.any(String) as string, owner: A.partyId, balanceCC: CC("12.5"), depositedCC: CC("12.5"), withdrawnCC: CC("0") },
      });
      expect(res.perWallet).toHaveLength(2);

      // The treasury first created A's EMPTY UserWallet under the one deterministic per-owner id
      // (shared with the in-app payout path, so two racing Creates collide on ledger dedup instead
      // of minting two wallets), then credited it with an Exercise Deposit; B's money is folded in.
      const onLedger = ctx.ledger.wallets.get(A.partyId);
      expect(onLedger).toMatchObject({ owner: A.partyId, balanceCC: parseCC("12.5"), depositedCC: parseCC("12.5"), withdrawnCC: 0n });
      expect(ctx.ledger.wallets.has(B.partyId)).toBe(false);
      expect(ctx.wallet.submits.map((x) => x.commandId)).toEqual([walletCreateCommandIdFor(A.partyId), res.commandId]);
      const [create] = ctx.wallet.submits[0].commands as LedgerCommand[];
      expect(create.CreateCommand?.templateId).toMatch(/:UserWallet$/);
      expect(create.CreateCommand?.createArguments).toEqual({ admin: ctx.config.treasuryPartyId, owner: A.partyId, balanceCC: CC("0"), depositedCC: CC("0"), withdrawnCC: CC("0") });
      const [deposit] = ctx.wallet.submits[1].commands as LedgerCommand[];
      expect(deposit.ExerciseCommand).toMatchObject({ choice: "Deposit", choiceArgument: { amountCC: CC("12.5"), txRef: `reconcile:${res.commandId ?? ""}` } });

      // Write-ahead row: submitted → confirmed (§8.3 steps 7–9), both transitions audited; the row
      // always records an Exercise against the wallet that existed before the submit.
      const rows = await credits().find();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: a.user.id,
        ownerParty: A.partyId,
        commandId: res.commandId,
        txRef: `reconcile:${res.commandId ?? ""}`,
        amountCC: parseCC("12.5"),
        depositedCCBefore: 0n,
        walletCidBefore: deposit.ExerciseCommand?.contractId,
        status: "confirmed",
        error: null,
      });
      expect(rows[0].submittedAt).toBeInstanceOf(Date);
      expect(rows[0].confirmedAt).not.toBeNull();
      expect(rows[0].attribution).toEqual(
        expect.arrayContaining([
          { walletId: aRow.id, partyId: A.partyId, amountCC: CC("10") },
          { walletId: linked.wallet.id, partyId: B.partyId, amountCC: CC("2.5") },
        ]),
      );
      const submitted = await auditRows("deposit.submitted");
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({ actorType: "user", actorUserId: a.user.id, subjectType: "deposit_credit", subjectId: rows[0].id });
      expect(submitted[0].actorSessionId).not.toBeNull();
      const credited = await auditRows("deposit.credited");
      expect(credited).toHaveLength(1);
      expect(credited[0]).toMatchObject({ actorType: "system", subjectType: "deposit_credit", subjectId: rows[0].id });
      expect(ctx.nats.publishedOn("truthoracle.deposit.credited")).toHaveLength(1);

      // Attribution landed on the rows.
      const after = await listWallets(a.cookie);
      expect(after.find((w) => w.partyId === A.partyId)).toMatchObject({ creditedCC: CC("10"), legacyCreditedCC: CC("0") });
      expect(after.find((w) => w.partyId === B.partyId)).toMatchObject({ creditedCC: CC("2.5"), legacyCreditedCC: CC("0") });

      // Second pass: nothing outstanding, no second submit, no second row.
      const again = await reconcileOk(a.cookie);
      expect(again).toEqual({
        credited: CC("0"),
        status: "nothing_outstanding",
        perWallet: [],
        ledger: expect.objectContaining({ owner: A.partyId, depositedCC: CC("12.5") }) as unknown,
      });
      expect(ctx.wallet.submits).toHaveLength(2);
      expect(await credits().count()).toBe(1);

      // A later deposit exercises Deposit on the existing UserWallet instead of creating another.
      ctx.wallet.seedInbound(A.partyId, "1");
      const third = await reconcileOk(a.cookie);
      expect(third).toMatchObject({
        credited: CC("1"),
        status: "confirmed",
        perWallet: [{ walletId: aRow.id, partyId: A.partyId, amountCC: CC("1") }],
        ledger: { owner: A.partyId, balanceCC: CC("13.5"), depositedCC: CC("13.5"), withdrawnCC: CC("0") },
      });
      expect(third.commandId).toMatch(COMMAND_ID_RE);
      expect(third.commandId).not.toBe(res.commandId);
      expect(ctx.wallet.submits).toHaveLength(3);
      const [exercise] = ctx.wallet.submits[2].commands as LedgerCommand[];
      expect(exercise.ExerciseCommand).toMatchObject({
        contractId: onLedger?.contractId,
        choice: "Deposit",
        choiceArgument: { amountCC: CC("1"), txRef: `reconcile:${third.commandId ?? ""}` },
      });
      expect(ctx.ledger.wallets.get(A.partyId)).toMatchObject({ depositedCC: parseCC("13.5"), balanceCC: parseCC("13.5") });
      expect(await credits().count({ where: { status: "confirmed" } })).toBe(2);

      // Invariant (§8.3): ledger.depositedCC == legacy[primary] + Σ credited, exactly.
      expect((await overview(a.cookie)).attribution).toEqual({ legacyPrimaryCC: CC("0"), creditedTotalCC: CC("13.5"), ledgerDepositedCC: CC("13.5"), delta: CC("0") });
    });

    it("a revoked wallet keeps receiving attribution for later transfers from its party", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);
      const linked = await linkOk(a.cookie, B);
      ctx.wallet.seedInbound(A.partyId, "10");
      ctx.wallet.seedInbound(B.partyId, "2.5");
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("12.5"), status: "confirmed" });

      expectStatus(await del(`/wallets/${linked.wallet.id}`, a.cookie), 200);
      ctx.wallet.seedInbound(B.partyId, "1");

      const res = await reconcileOk(a.cookie);
      expect(res).toMatchObject({ credited: CC("1"), status: "confirmed", perWallet: [{ walletId: linked.wallet.id, partyId: B.partyId, amountCC: CC("1") }] });
      expect((await listWallets(a.cookie)).find((w) => w.partyId === B.partyId)).toMatchObject({ status: "revoked", creditedCC: CC("3.5") });
      expect(ctx.ledger.wallets.get(A.partyId)?.depositedCC).toBe(parseCC("13.5"));

      const ov = await overview(a.cookie);
      expect(ov.wallets.find((w) => w.partyId === B.partyId)).toMatchObject({ status: "revoked", receivedCC: CC("3.5"), creditedCC: CC("3.5") });
      expect(ov.attribution).toEqual({ legacyPrimaryCC: CC("0"), creditedTotalCC: CC("13.5"), ledgerDepositedCC: CC("13.5"), delta: CC("0") });
    });

    it("counts only settled Amulet inbound rows: pending / failed / outbound / other instruments are ignored", async () => {
      const A = makeTestWallet("alice");
      const a = await signIn(A);
      ctx.wallet.seedInbound(A.partyId, "10");
      ctx.wallet.seedInbound(A.partyId, "4", "pending");
      ctx.wallet.seedInbound(A.partyId, "7", "failed");
      ctx.wallet.seedInbound(A.partyId, "3", "completed", { direction: "out" });
      ctx.wallet.seedInbound(A.partyId, "2", "completed", { instrumentId: "USDC" });

      expect((await overview(a.cookie)).wallets[0]).toMatchObject({ partyId: A.partyId, receivedCC: CC("10") });
      const res = await reconcileOk(a.cookie);
      expect(res).toMatchObject({ credited: CC("10"), status: "confirmed", perWallet: [{ partyId: A.partyId, amountCC: CC("10") }] });
      expect(ctx.ledger.wallets.get(A.partyId)?.depositedCC).toBe(parseCC("10"));

      // Once the pending transfer settles, the next pass picks it up — and nothing else.
      const pending = ctx.wallet.rows.find((r) => r.status === "pending");
      if (!pending) throw new Error("pending row missing");
      pending.status = "completed";
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("4"), status: "confirmed" });
      expect(ctx.ledger.wallets.get(A.partyId)?.depositedCC).toBe(parseCC("14"));
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("0"), status: "nothing_outstanding" });
    });

    it("self-heals a legacy-path credit: a ledger surplus matched by the primary's history is attributed to the primary and audited (step 4)", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);
      await linkOk(a.cookie, B);
      const aRow = (await listWallets(a.cookie)).find((w) => w.partyId === A.partyId);
      if (!aRow) throw new Error("wallet A missing");
      ctx.wallet.seedInbound(A.partyId, "10");
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("10"), status: "confirmed" });

      // A legacy api/wallet/deposit.mjs credit: the transfer is in the treasury history AND the
      // UserWallet already holds it, but no backend attribution exists.
      ctx.wallet.seedInbound(A.partyId, "2");
      bumpLedger(A.partyId, "2");

      const res = await reconcileOk(a.cookie);
      expect(res).toMatchObject({ credited: CC("0"), status: "nothing_outstanding", perWallet: [], ledger: { depositedCC: CC("12") } });
      // Nothing was re-credited on the ledger.
      expect(ctx.wallet.submits).toHaveLength(2);
      expect(await credits().count()).toBe(1);

      const list = await listWallets(a.cookie);
      expect(list.find((w) => w.partyId === A.partyId)?.creditedCC).toBe(CC("12"));
      expect(list.find((w) => w.partyId === B.partyId)?.creditedCC).toBe(CC("0"));
      const healed = await auditRows("deposit.attribution_healed");
      expect(healed).toHaveLength(1);
      expect(healed[0]).toMatchObject({ actorType: "user", actorUserId: a.user.id, subjectType: "wallet", subjectId: aRow.id, metadata: { amountCC: CC("2") } });
      expect(ctx.nats.publishedOn("truthoracle.deposit.healed")).toHaveLength(1);
      expect((await overview(a.cookie)).attribution).toEqual({ legacyPrimaryCC: CC("0"), creditedTotalCC: CC("12"), ledgerDepositedCC: CC("12"), delta: CC("0") });

      // Steady state afterwards.
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("0"), status: "nothing_outstanding" });
      expect(await auditRows("deposit.attribution_healed")).toHaveLength(1);
    });

    it("refuses with 409 deposit_attribution_drift when the ledger holds less than attributed — audited, nothing credited (step 4)", async () => {
      const A = makeTestWallet("alice");
      const a = await signIn(A);
      ctx.wallet.seedInbound(A.partyId, "10");
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("10"), status: "confirmed" });

      bumpLedger(A.partyId, "-1");
      // Even with a genuinely outstanding transfer, nothing may be credited on top of drift.
      ctx.wallet.seedInbound(A.partyId, "1");

      const res = await reconcile(a.cookie);
      expectError(res, 409, "deposit_attribution_drift");
      expect(ctx.wallet.submits).toHaveLength(2);
      expect(await credits().count()).toBe(1);
      expect((await listWallets(a.cookie))[0].creditedCC).toBe(CC("10"));
      // The audit row survives the thrown ApiError.
      const drift = await auditRows("deposit.attribution_drift");
      expect(drift).toHaveLength(1);
      expect(drift[0]).toMatchObject({ actorType: "user", actorUserId: a.user.id, subjectType: "wallet" });
      expect(ctx.nats.publishedOn("truthoracle.deposit.drift")).toHaveLength(1);
      expect((await overview(a.cookie)).attribution).toEqual({ legacyPrimaryCC: CC("0"), creditedTotalCC: CC("10"), ledgerDepositedCC: CC("9"), delta: CC("-1") });
      // Still refused on the next attempt — drift never self-resolves downwards.
      expectError(await reconcile(a.cookie), 409, "deposit_attribution_drift");
    });

    it("refuses with 409 deposit_attribution_drift when a wallet is attributed more than it ever sent (step 3)", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);
      const linked = await linkOk(a.cookie, B);
      ctx.wallet.seedInbound(A.partyId, "10");
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("10"), status: "confirmed" });

      // B never sent anything, yet claims 5 CC of attribution.
      await wallets().update({ id: linked.wallet.id }, { creditedCC: parseCC("5") });
      expectError(await reconcile(a.cookie), 409, "deposit_attribution_drift");
      expect(ctx.wallet.submits).toHaveLength(2);
      expect(await auditRows("deposit.attribution_drift")).toHaveLength(1);
      expect(ctx.ledger.wallets.get(A.partyId)?.depositedCC).toBe(parseCC("10"));
    });

    it("lock:deposit:<userId> serialises reconciliation: a held lock and a racing request both answer 409 deposit_in_progress", async () => {
      const A = makeTestWallet("alice");
      const a = await signIn(A);
      ctx.wallet.seedInbound(A.partyId, "10");

      const held = await ctx.redis.acquireLock(`lock:deposit:${a.user.id}`, 30_000);
      expect(held.acquired).toBe(true);
      try {
        expectError(await reconcile(a.cookie), 409, "deposit_in_progress");
      } finally {
        await held.release();
      }
      expect(ctx.wallet.submits).toHaveLength(0);
      expect(await credits().count()).toBe(0);

      // Two racing requests: the history walk is slowed so the loser reliably meets the lock.
      const original = ctx.wallet.transferHistory.bind(ctx.wallet);
      const spy = jest.spyOn(ctx.wallet, "transferHistory").mockImplementation(async (partyId: string) => {
        await sleep(300);
        return original(partyId);
      });
      let results: request.Response[];
      try {
        results = await Promise.all([reconcile(a.cookie), reconcile(a.cookie)]);
      } finally {
        spy.mockRestore();
      }
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200);
      const loser = results.find((r) => r.status === 409);
      if (!winner || !loser) throw new Error("unreachable");
      expect(bodyOf<ReconcileResult>(winner)).toMatchObject({ credited: CC("10"), status: "confirmed" });
      expect(bodyOf<ErrorBody>(loser).error).toBe("deposit_in_progress");
      expect(ctx.wallet.submits).toHaveLength(2);
      expect(await credits().count()).toBe(1);
      expect(ctx.ledger.wallets.get(A.partyId)?.depositedCC).toBe(parseCC("10"));

      // The lock is released afterwards.
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("0"), status: "nothing_outstanding" });
    });

    it("preconditions: no primary wallet → 409 no_primary_wallet; blocked_duplicate → 409 kyc_duplicate_identity; suspended → 403 user_suspended", async () => {
      const g = await googleSignIn("google-sub-0000000002");
      expect(g.user.partyId).toBeNull();
      expect(await listWallets(g.cookie)).toEqual([]);
      expectError(await reconcile(g.cookie), 409, "no_primary_wallet");
      expect(await overview(g.cookie)).toEqual({
        partyId: null,
        ledger: null,
        wallets: [],
        attribution: { legacyPrimaryCC: CC("0"), creditedTotalCC: CC("0"), ledgerDepositedCC: CC("0"), delta: CC("0") },
        pending: { submitted: 0 },
        payouts: [],
      });

      const A = makeTestWallet("alice");
      const a = await signIn(A);
      ctx.wallet.seedInbound(A.partyId, "10");
      const users = ctx.dataSource.getRepository(UserEntity);

      await users.update({ id: a.user.id }, { kycStatus: "blocked_duplicate" });
      await ctx.get(UserService).invalidate(a.user.id);
      expectError(await reconcile(a.cookie), 409, "kyc_duplicate_identity");

      await users.update({ id: a.user.id }, { kycStatus: "none", status: "suspended" });
      await ctx.get(UserService).invalidate(a.user.id);
      expectError(await reconcile(a.cookie), 403, "user_suspended");

      expect(ctx.wallet.submits).toHaveLength(0);
      expect(await credits().count()).toBe(0);
      expect(ctx.ledger.wallets.has(A.partyId)).toBe(false);
    });

    it("reuses a UserWallet another path created (an in-app payout's empty Create): no second Create, the credit is an Exercise", async () => {
      const A = makeTestWallet("alice");
      const a = await signIn(A);
      // PayoutService created A's wallet moments ago under the shared deterministic id.
      const existing = ctx.ledger.seedUserWallet(A.partyId, {});
      ctx.wallet.commandStatuses.set(walletCreateCommandIdFor(A.partyId), "completed");
      ctx.wallet.seedInbound(A.partyId, "4");

      const res = await reconcileOk(a.cookie);
      expect(res).toMatchObject({ credited: CC("4"), status: "confirmed", ledger: { owner: A.partyId, depositedCC: CC("4") } });
      expect(ctx.wallet.submits.map((x) => x.commandId)).toEqual([res.commandId]);
      const [deposit] = ctx.wallet.submits[0].commands as LedgerCommand[];
      expect(deposit.ExerciseCommand).toMatchObject({ contractId: existing.contractId, choice: "Deposit" });
      expect([...ctx.ledger.wallets.values()].filter((w) => w.owner === A.partyId)).toHaveLength(1);
    });

    it("a credit the ledger has not shown yet stays `submitted` (grace period), and the confirm processor credits it exactly once when the ledger catches up", async () => {
      const A = makeTestWallet("alice");
      const a = await signIn(A);
      ctx.wallet.seedInbound(A.partyId, "10");
      ctx.wallet.lagLedger = true;

      // The wallet accepts both the Create and the Deposit; the ACS lags. The Create is awaited
      // (the wallet must be visible before the Exercise), so let it land first.
      const first = await reconcile(a.cookie);
      expectError(first, 502, "upstream_failed"); // the empty wallet is accepted but not yet visible
      expect(ctx.wallet.submits.map((x) => x.commandId)).toEqual([walletCreateCommandIdFor(A.partyId)]);
      ctx.wallet.applyPending();
      const res = await reconcileOk(a.cookie);
      expect(res).toMatchObject({ credited: CC("10"), status: "submitted", perWallet: [{ partyId: A.partyId, amountCC: CC("10") }] });
      expect(ctx.wallet.submits).toHaveLength(2);
      let row = (await credits().find())[0];
      expect(row).toMatchObject({ status: "submitted", commandId: res.commandId, depositedCCBefore: 0n });
      expect((await listWallets(a.cookie))[0].creditedCC).toBe(CC("0"));
      expect((await overview(a.cookie)).pending).toEqual({ submitted: 1 });

      // While the credit is in flight no new derivation may run (it would double count), and the
      // processor's pass leaves the young row alone — whatever the command index says.
      expectError(await reconcile(a.cookie), 409, "deposit_in_progress");
      ctx.wallet.unknownCommandIds = true;
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 0, failed: 0 });
      ctx.wallet.unknownCommandIds = false;
      expect((await credits().findOneByOrFail({ id: row.id })).status).toBe("submitted");

      // The ledger catches up: the processor confirms and bumps the attribution — once.
      ctx.wallet.applyPending();
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 1, failed: 0 });
      row = await credits().findOneByOrFail({ id: row.id });
      expect(row.status).toBe("confirmed");
      expect(row.confirmedAt).not.toBeNull();
      expect((await listWallets(a.cookie))[0].creditedCC).toBe(CC("10"));
      expect(await auditRows("deposit.credited")).toHaveLength(1);
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 0, failed: 0 });
      expect((await listWallets(a.cookie))[0].creditedCC).toBe(CC("10"));
      ctx.wallet.lagLedger = false;
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("0"), status: "nothing_outstanding" });
      expect((await overview(a.cookie)).attribution).toEqual({ legacyPrimaryCC: CC("0"), creditedTotalCC: CC("10"), ledgerDepositedCC: CC("10"), delta: CC("0") });
    });

    it("a submit that never reached the wallet fails only after the grace period; the next reconcile re-arms the same command id", async () => {
      const A = makeTestWallet("alice");
      const a = await signIn(A);
      ctx.wallet.seedInbound(A.partyId, "3");
      ctx.ledger.seedUserWallet(A.partyId, {});
      ctx.wallet.commandStatuses.set(walletCreateCommandIdFor(A.partyId), "completed");

      // The Deposit submit dies before the wallet records anything: the row stays `submitted`.
      ctx.wallet.failNext = new Error("ECONNRESET");
      const res = await reconcile(a.cookie);
      expectError(res, 502, "upstream_failed");
      expect(bodyOf<ErrorBody>(res).details).toMatchObject({ creditStatus: "submitted" });
      const commandId = bodyOf<ErrorBody>(res).details?.commandId as string;
      expect(commandId).toMatch(COMMAND_ID_RE);
      expect(ctx.wallet.submits).toHaveLength(0);
      const row = (await credits().find())[0];
      expect(row).toMatchObject({ status: "submitted", commandId });

      // Inside the grace period the pass never touches the wallet's command index (a lagging ACS
      // looks exactly like this) and the row stays submitted.
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 0, failed: 0 });
      expect((await credits().findOneByOrFail({ id: row.id })).status).toBe("submitted");

      // Past the grace period: a failed status read still fails closed …
      await credits().update({ id: row.id }, { submittedAt: new Date(Date.now() - ctx.config.depositConfirmGraceMs - 1000) });
      ctx.wallet.statusReadsFail = true;
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 0, failed: 0 });
      ctx.wallet.statusReadsFail = false;
      expect((await credits().findOneByOrFail({ id: row.id })).status).toBe("submitted");

      // … and a wallet that does not know the command marks the row failed (audited, nothing credited).
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 0, failed: 1 });
      const failed = await credits().findOneByOrFail({ id: row.id });
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/does not know the command/);
      expect(await auditRows("deposit.failed")).toEqual([expect.objectContaining({ actorType: "system", subjectId: row.id })]);
      expect((await listWallets(a.cookie))[0].creditedCC).toBe(CC("0"));

      // The next reconcile re-arms the very same command id (ledger dedup is the backstop) and confirms.
      const again = await reconcileOk(a.cookie);
      expect(again).toMatchObject({ credited: CC("3"), status: "confirmed", commandId });
      expect(await credits().count()).toBe(1);
      const rearmed = (await auditRows("deposit.submitted")).map((e) => e.metadata.rearmed);
      expect(rearmed).toEqual([false, true]);
      expect((await credits().findOneByOrFail({ id: row.id })).submittedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect((await listWallets(a.cookie))[0].creditedCC).toBe(CC("3"));
    });

    it("a credit the wallet reports as landed but the ledger does not show after the grace period is never failed (operator alert, no re-arm)", async () => {
      const A = makeTestWallet("alice");
      const a = await signIn(A);
      ctx.wallet.seedInbound(A.partyId, "2");
      ctx.ledger.seedUserWallet(A.partyId, {});
      ctx.wallet.commandStatuses.set(walletCreateCommandIdFor(A.partyId), "completed");
      ctx.wallet.lagLedger = true;
      const res = await reconcileOk(a.cookie);
      expect(res.status).toBe("submitted");
      const row = (await credits().find())[0];
      await credits().update({ id: row.id }, { submittedAt: new Date(Date.now() - ctx.config.depositConfirmGraceMs - 1000) });
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 0, failed: 0 });
      expect((await credits().findOneByOrFail({ id: row.id })).status).toBe("submitted");
      expectError(await reconcile(a.cookie), 409, "deposit_in_progress");
      // A wallet that reports the command failed, however, does fail the row.
      ctx.wallet.rejectPending();
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({ confirmed: 0, failed: 1 });
      expect((await credits().findOneByOrFail({ id: row.id }))).toMatchObject({ status: "failed", error: expect.stringMatching(/failed/) as string });
      ctx.wallet.lagLedger = false;
    });

    it("GET /in-app-wallet composes ledger, wallets with receivedCC, attribution, pending and payouts — API.md 'In-app wallet'", async () => {
      const A = makeTestWallet("alice");
      const B = makeTestWallet("bob");
      const a = await signIn(A);
      const linked = await linkOk(a.cookie, B, { label: "cold" });
      const aRow = (await listWallets(a.cookie)).find((w) => w.partyId === A.partyId);
      if (!aRow) throw new Error("wallet A missing");
      ctx.wallet.seedInbound(A.partyId, "10");
      ctx.wallet.seedInbound(B.partyId, "2.5");
      expect(await reconcileOk(a.cookie)).toMatchObject({ credited: CC("12.5"), status: "confirmed" });

      // One queued withdrawal on the ledger with its to_payouts row, and one credit still in flight.
      const pp = ctx.ledger.seedPendingPayout({ user: A.partyId, amountCC: "2", reason: "withdraw" });
      const payouts = ctx.dataSource.getRepository(PayoutEntity);
      await payouts.save(
        payouts.create({
          pendingPayoutCid: pp.contractId,
          userId: a.user.id,
          payeeParty: A.partyId,
          payeeWalletId: aRow.id,
          amountCC: parseCC("2"),
          reason: "withdraw",
          status: "queued",
          attempts: 0,
          lastError: null,
          firstSeenAt: new Date(),
          settledAt: null,
        }),
      );
      const onLedger = ctx.ledger.wallets.get(A.partyId);
      if (!onLedger) throw new Error("primary UserWallet missing");
      await credits().save(
        credits().create({
          userId: a.user.id,
          ownerParty: A.partyId,
          commandId: `deposit-${"0".repeat(40)}`,
          txRef: `reconcile:deposit-${"0".repeat(40)}`,
          amountCC: parseCC("1"),
          attribution: [{ walletId: aRow.id, partyId: A.partyId, amountCC: CC("1") }],
          depositedCCBefore: parseCC("12.5"),
          walletCidBefore: onLedger.contractId,
          status: "submitted",
          error: null,
          confirmedAt: null,
        }),
      );

      const ov = await overview(a.cookie);
      expect(ov.partyId).toBe(A.partyId);
      expect(ov.ledger).toEqual({ contractId: onLedger.contractId, owner: A.partyId, balanceCC: CC("12.5"), depositedCC: CC("12.5"), withdrawnCC: CC("0") });
      expect(ov.wallets).toHaveLength(2);
      expect(ov.wallets.find((w) => w.partyId === A.partyId)).toEqual({
        id: aRow.id,
        chain: "canton",
        kind: "cantor8",
        partyId: A.partyId,
        label: null,
        isPrimary: true,
        status: "active",
        verifiedAt: expect.any(String) as string,
        creditedCC: CC("10"),
        legacyCreditedCC: CC("0"),
        receivedCC: CC("10"),
        ownLedgerWallet: null,
      });
      expect(ov.wallets.find((w) => w.partyId === B.partyId)).toMatchObject({
        id: linked.wallet.id,
        label: "cold",
        isPrimary: false,
        status: "active",
        creditedCC: CC("2.5"),
        legacyCreditedCC: CC("0"),
        receivedCC: CC("2.5"),
        ownLedgerWallet: null,
      });
      expect(ov.attribution).toEqual({ legacyPrimaryCC: CC("0"), creditedTotalCC: CC("12.5"), ledgerDepositedCC: CC("12.5"), delta: CC("0") });
      expect(ov.pending).toEqual({ submitted: 1 });
      expect(ov.payouts).toEqual([
        expect.objectContaining({
          pendingPayoutCid: pp.contractId,
          payeeParty: A.partyId,
          walletId: aRow.id,
          amountCC: CC("2"),
          reason: "withdraw",
          status: "queued",
          retryAfterKyc: false,
          attempts: 0,
          lastError: null,
          settledAt: null,
          onLedger: true,
        }),
      ]);
      expect(typeof ov.payouts[0].firstSeenAt).toBe("string");
      for (const v of Object.values(ov.attribution)) expect(v).toMatch(MONEY_RE);
    });
  });
});
