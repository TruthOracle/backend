/**
 * KYC end to end (docs/API.md "KYC" / "Webhooks" / "Me"; ARCHITECTURE §6.5, §9, §12). Real
 * Postgres + Redis, the real KycService, mock provider, Sumsub adapter, KycController /
 * KycMockController / WebhooksController / MeController and KycWebhookProcessor; users sign in
 * through the real Telegram widget route and link their wallet over `/wallets/link`; NATS and
 * the ledger are the helper fakes.
 *
 * Three apps, booted one after another: the default env (mock provider, enforcement off), the
 * mock provider with KYC_ENFORCE_WITHDRAWALS=true, and KYC_PROVIDER=sumsub (mock route absent,
 * webhook signature rules). Every request uses a jar-less `request(server)`: superagent's cookie
 * jar would otherwise override an explicit `Cookie` header with the last signed-in user's cookie,
 * which breaks every multi-account scenario (duplicates, identity lock).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";

import { getConfiguration } from "../src/config";
import type { KycMockDocumentDto, KycMockSubmitDto } from "../src/dto/kyc.dto";
import { AuditEventEntity } from "../src/entities/audit-event.entity";
import { AuthIdentityEntity } from "../src/entities/auth-identity.entity";
import { KycPersonEntity } from "../src/entities/kyc-person.entity";
import { KycVerificationEntity } from "../src/entities/kyc-verification.entity";
import { KycWebhookEventEntity } from "../src/entities/kyc-webhook-event.entity";
import { UserEntity } from "../src/entities/user.entity";
import { KycWebhookProcessor, kycWebhookNakDelayMs } from "../src/processors/kyc-webhook.processor";
import { IdentityService } from "../src/services/identity.service";
import {
  KycProviderSumsubService,
  redactSumsubPayload,
  signSumsubRequest,
} from "../src/services/kyc-provider-sumsub.service";
import { KycService, type KycSessionStart } from "../src/services/kyc.service";
import {
  type ApiKycSummary,
  type ApiKycVerification,
  type ApiMe,
  KYC_PROVIDER,
  type UserKycStatus,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { type TestApp, testEnv, useTestApp } from "./helpers/app";
import { FakeKycProvider, subjectMatches } from "./helpers/fakes";
import { bodyOf, issueSessionDirect, linkWallet, signInAsAdmin } from "./helpers/session";
import { nextTelegramUser, signInWithTelegram, type TelegramTestUser } from "./helpers/telegram";
import { makeTestWallet } from "./helpers/wallet";

// ─────────────────────────────────────────── fixtures ────────────────────────────────────────────

const PERSON = { firstName: "Jane", lastName: "Doe", dob: "1990-01-01", country: "IND" };
const OTHER_PERSON = { firstName: "Rahul", lastName: "Sharma", dob: "1985-05-05", country: "IND" };
const PASSPORT: KycMockDocumentDto = { docType: "PASSPORT", country: "IND", number: "Z1234567" };
/** Raw applicant values that must never appear in any persisted row or NATS payload (§9.7). */
const RAW_VALUES = ["Z1234567", "Jane", "Doe", "1990-01-01"];

const WEBHOOK_SECRET = "e2e-sumsub-webhook-secret";
const operator = makeTestWallet("operator");
const SUMSUB_APPLICANT = "5cb56e8e0a975a35f333cb83";

type KycSummaryBody = ApiKycSummary & { history: ApiKycVerification[] };
interface MockSubmitBody {
  verification: ApiKycVerification;
  userKycStatus: UserKycStatus;
}
interface Reply<T> {
  status: number;
  body: T | ErrorBody;
}

function submission(
  verificationId: string,
  outcome: KycMockSubmitDto["outcome"],
  person: KycMockSubmitDto["person"] = PERSON,
  documents: KycMockDocumentDto[] = [PASSPORT],
): KycMockSubmitDto {
  return { verificationId, outcome, person, documents };
}

/** HMAC-SHA256(pepper, canonical) hex — the §9.3 fingerprint, computed independently of the code. */
function fingerprint(pepper: string, canonical: string): string {
  return createHmac("sha256", pepper).update(canonical, "utf8").digest("hex");
}

/** Asymmetric matchers are typed `any`; these keep them usable inside object literals under the lint rules. */
const anyString = (): unknown => expect.any(String) as unknown;
const containing = (subset: Record<string, unknown>): unknown =>
  expect.objectContaining(subset) as unknown;

// ─────────────────────────────────────────── HTTP plumbing ───────────────────────────────────────

/** Jar-less client (see the file comment). */
const http = (ctx: TestApp): request.Agent => request(ctx.app.getHttpServer() as Server);

function reply<T>(res: request.Response): Reply<T> {
  return { status: res.status, body: res.body as T | ErrorBody };
}

/** `GET /kyc` (API.md "KYC"). */
async function kycSummary(ctx: TestApp, cookie: string): Promise<Reply<KycSummaryBody>> {
  return reply<KycSummaryBody>(await http(ctx).get("/api/v1/kyc").set("Cookie", cookie));
}

/** `POST /kyc/sessions`. */
async function kycStart(ctx: TestApp, cookie: string): Promise<Reply<KycSessionStart>> {
  return reply<KycSessionStart>(
    await http(ctx).post("/api/v1/kyc/sessions").set("Cookie", cookie).set(ctx.csrf).send({}),
  );
}

/** `POST /kyc/mock/submit` (mock provider only). */
async function kycMockSubmit(
  ctx: TestApp,
  cookie: string,
  dto: KycMockSubmitDto,
): Promise<Reply<MockSubmitBody>> {
  return reply<MockSubmitBody>(
    await http(ctx).post("/api/v1/kyc/mock/submit").set("Cookie", cookie).set(ctx.csrf).send(dto),
  );
}

/** `GET /me` (API.md "Me"). */
async function me(ctx: TestApp, cookie: string): Promise<ApiMe> {
  return bodyOf<ApiMe>(await http(ctx).get("/api/v1/me").set("Cookie", cookie).expect(200));
}

function ok<T>(r: Reply<T>): T {
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

function refused(r: Reply<unknown>, status: number, code: string): ErrorBody {
  expect(`${r.status} ${(r.body as Partial<ErrorBody>).error ?? ""}`).toBe(`${status} ${code}`);
  return r.body as ErrorBody;
}

// ─────────────────────────────────────────── accounts ────────────────────────────────────────────

interface Account {
  wallet: ReturnType<typeof makeTestWallet>;
  telegram: TelegramTestUser;
  user: { id: string };
  cookie: string;
  /** The Telegram identity that authenticated the session (= `session.auth_identity_id`). */
  identityId: string;
}

/** A fresh account opened by Telegram (§6.1) — its only sign-in method — with `hint`'s wallet linked as its primary (§8.1). */
async function newUser(ctx: TestApp, hint: string): Promise<Account> {
  const wallet = makeTestWallet(hint);
  const telegram = nextTelegramUser(hint);
  const { user, cookie, result } = await signInWithTelegram(http(ctx), telegram);
  await linkWallet(http(ctx), cookie, wallet);
  return { wallet, telegram, user, cookie, identityId: result.identity.id };
}

/** Attaches a second Telegram identity in link mode (the widget route with the session cookie). */
async function linkTelegram(
  ctx: TestApp,
  cookie: string,
  hint: string,
): Promise<{ telegram: TelegramTestUser; identityId: string }> {
  const telegram = nextTelegramUser(hint);
  const { result } = await signInWithTelegram(http(ctx), telegram, { cookie });
  expect(result.mode).toBe("link");
  return { telegram, identityId: result.identity.id };
}

/** A second session for the same account, authenticated by an already-linked Telegram identity (`session.auth_identity_id` = that identity). */
async function signInAgain(
  ctx: TestApp,
  telegram: TelegramTestUser,
): Promise<{ cookie: string; identityId: string }> {
  const { cookie, result } = await signInWithTelegram(http(ctx), telegram);
  expect(result).toMatchObject({ mode: "login", created: false });
  return { cookie, identityId: result.identity.id };
}

/** Session → approved submission; returns the verification id. */
async function approve(
  ctx: TestApp,
  cookie: string,
  person = PERSON,
  documents: KycMockDocumentDto[] = [PASSPORT],
): Promise<string> {
  const started = ok(await kycStart(ctx, cookie));
  const done = ok(
    await kycMockSubmit(
      ctx,
      cookie,
      submission(started.verificationId, "approved", person, documents),
    ),
  );
  expect(done.verification.status).toBe("approved");
  return started.verificationId;
}

const personsOf = (ctx: TestApp, userId: string): Promise<KycPersonEntity[]> =>
  ctx.dataSource.getRepository(KycPersonEntity).find({ where: { userId }, order: { kind: "ASC" } });
const auditRows = (ctx: TestApp, action: string): Promise<AuditEventEntity[]> =>
  ctx.dataSource.getRepository(AuditEventEntity).find({ where: { action }, order: { id: "ASC" } });
const userRow = (ctx: TestApp, id: string): Promise<UserEntity> =>
  ctx.dataSource.getRepository(UserEntity).findOneByOrFail({ id });
const identityRow = (ctx: TestApp, id: string): Promise<AuthIdentityEntity> =>
  ctx.dataSource.getRepository(AuthIdentityEntity).findOneByOrFail({ id });

/** Everything the KYC flow persisted or published, as one string, for the §9.7 "never stored" checks. */
async function persistedText(ctx: TestApp): Promise<string> {
  const [audit, events, persons, verifications, users] = await Promise.all([
    ctx.dataSource.getRepository(AuditEventEntity).find(),
    ctx.dataSource.getRepository(KycWebhookEventEntity).find(),
    ctx.dataSource.getRepository(KycPersonEntity).find(),
    ctx.dataSource.getRepository(KycVerificationEntity).find(),
    ctx.dataSource.getRepository(UserEntity).find(),
  ]);
  return JSON.stringify({ audit, events, persons, verifications, users, nats: ctx.nats.published });
}

// ─────────────────────────────────────────── Sumsub webhook plumbing ─────────────────────────────

const DIGEST_HASH: Record<string, string> = {
  HMAC_SHA256_HEX: "sha256",
  HMAC_SHA512_HEX: "sha512",
  HMAC_SHA1_HEX: "sha1",
};

/** A Sumsub applicant event; `clientComment` is present precisely so we can prove it is dropped (§5, §9.7). */
function sumsubEvent(
  userId: string,
  type = "applicantReviewed",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const reviewed = type === "applicantReviewed";
  return {
    applicantId: SUMSUB_APPLICANT,
    inspectionId: "5cb56e8e0a975a35f333cb84",
    correlationId: `req-${randomUUID()}`,
    externalUserId: userId,
    levelName: "basic-kyc-level",
    type,
    reviewResult: reviewed ? { reviewAnswer: "GREEN" } : undefined,
    reviewStatus: reviewed ? "completed" : "pending",
    createdAtMs: "2026-09-10 10:00:00.000",
    sandboxMode: false,
    clientComment: "internal moderator note — never stored",
    ...extra,
  };
}

function signed(
  body: Record<string, unknown>,
  alg = "HMAC_SHA256_HEX",
  secret = WEBHOOK_SECRET,
): { raw: Buffer; headers: Record<string, string> } {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const digest = createHmac(DIGEST_HASH[alg] ?? "sha256", secret)
    .update(raw)
    .digest("hex");
  return {
    raw,
    headers: {
      "Content-Type": "application/json",
      "x-payload-digest": digest,
      "x-payload-digest-alg": alg,
    },
  };
}

const eventKeyOf = (raw: Buffer): string => createHash("sha256").update(raw).digest("hex");

/** Raw body on the wire, exactly as signed (the digest is over the bytes, not a re-serialisation). */
const postWebhook = (ctx: TestApp, raw: Buffer, headers: Record<string, string>): request.Test =>
  http(ctx).post("/api/v1/webhooks/kyc/sumsub").set(headers).send(raw.toString("utf8"));

// ═════════════════════════════════════════════ spec ══════════════════════════════════════════════

describe("KYC (e2e)", () => {
  // ───────────────────────────────── default configuration (enforce off) ─────────────────────────
  describe("default configuration — KYC_PROVIDER=mock, KYC_ENFORCE_WITHDRAWALS=false", () => {
    const ctx = useTestApp({ env: { ADMIN_OPERATORS: operator.partyId } });

    it("GET /admin/kyc/provider reports the mock provider as configured with no upstream probe", async () => {
      const admin = await issueSessionDirect(ctx, operator, { kind: "admin" });
      const status = ok<{
        provider: string;
        configured: boolean;
        health: { ok: boolean; upstreamStatus: number | null };
      }>(await http(ctx).get("/api/v1/admin/kyc/provider").set("Cookie", admin.cookie).expect(200));
      expect(status).toMatchObject({
        provider: "mock",
        configured: true,
        health: { ok: true, upstreamStatus: null },
      });
    });

    it("GET /kyc → provider mock, status none, requiredForWithdrawal false; the §9.4 gate lets an unverified account through", async () => {
      const u = await newUser(ctx, "def");
      expect(ok(await kycSummary(ctx, u.cookie))).toEqual({
        provider: "mock",
        status: "none",
        levelName: ctx.config.kycRequiredLevel,
        requiredForWithdrawal: false,
        attachedIdentityId: null,
        verification: null,
        history: [],
      });
      expect(await ctx.get(KycService).withdrawalGate(u.user.id)).toEqual({ allowed: true });
    });

    it('GET /me: kycRequiredForWithdrawal false, canWithdraw and canDeposit true without any verification (API.md "Me", §9.4)', async () => {
      const u = await newUser(ctx, "def-me");
      const view = await me(ctx, u.cookie);
      expect(view.kyc).toEqual({
        provider: "mock",
        status: "none",
        levelName: ctx.config.kycRequiredLevel,
        requiredForWithdrawal: false,
        attachedIdentityId: null,
        verification: null,
      });
      expect(view.capabilities).toEqual({
        kycRequiredForWithdrawal: false,
        canWithdraw: true,
        canDeposit: true,
        primaryPartyId: u.wallet.partyId,
        isAdmin: false,
      });
    });

    it("GET /kyc and POST /kyc/sessions need a session; POST /kyc/sessions is CSRF-checked", async () => {
      await http(ctx).get("/api/v1/kyc").expect(401);
      await http(ctx).post("/api/v1/kyc/sessions").set(ctx.csrf).send({}).expect(401);
      const u = await newUser(ctx, "guard");
      const csrf = await http(ctx)
        .post("/api/v1/kyc/sessions")
        .set("Cookie", u.cookie)
        .set("Content-Type", "application/json")
        .send({})
        .expect(403);
      expect(bodyOf<ErrorBody>(csrf).error).toBe("csrf_rejected");
    });
  });

  // ───────────────────────────────── mock provider flows (enforce on) ────────────────────────────
  describe("mock provider — KYC_ENFORCE_WITHDRAWALS=true", () => {
    const ctx = useTestApp({ env: { KYC_ENFORCE_WITHDRAWALS: "true" } });

    it("requiredForWithdrawal is true; an unverified account cannot withdraw (gate: kyc_required) but can deposit", async () => {
      const u = await newUser(ctx, "enf");
      expect(ok(await kycSummary(ctx, u.cookie))).toMatchObject({
        provider: "mock",
        status: "none",
        requiredForWithdrawal: true,
      });
      expect(await ctx.get(KycService).withdrawalGate(u.user.id)).toEqual({
        allowed: false,
        reason: "kyc_required",
      });
      expect((await me(ctx, u.cookie)).capabilities).toMatchObject({
        kycRequiredForWithdrawal: true,
        canWithdraw: false,
        canDeposit: true,
      });
    });

    it("POST /kyc/sessions opens attempt 1 attached to the signed-in identity; GET /kyc reports pending; the refresh call reuses it (§9.1, §9.5)", async () => {
      const u = await newUser(ctx, "start");
      const started = ok(await kycStart(ctx, u.cookie));
      expect(started).toEqual({
        provider: "mock",
        verificationId: anyString(),
        levelName: ctx.config.kycRequiredLevel,
      });
      const verificationId = started.verificationId;

      const summary = ok(await kycSummary(ctx, u.cookie));
      expect(summary).toMatchObject({
        provider: "mock",
        status: "pending",
        requiredForWithdrawal: true,
        attachedIdentityId: u.identityId,
      });
      expect(summary.verification).toMatchObject({
        id: verificationId,
        provider: "mock",
        attemptNo: 1,
        status: "initiated",
        rejectLabels: [],
        moderationComment: null,
        reviewedAt: null,
      });
      expect(summary.history).toHaveLength(1);

      // The same route serves the WebSDK token refresh: an in-flight attempt is reused, not duplicated (§9.1).
      expect(ok(await kycStart(ctx, u.cookie)).verificationId).toBe(verificationId);
      expect(
        await ctx.dataSource
          .getRepository(KycVerificationEntity)
          .count({ where: { userId: u.user.id } }),
      ).toBe(1);

      const row = await ctx.dataSource
        .getRepository(KycVerificationEntity)
        .findOneByOrFail({ id: verificationId });
      expect(row.initiatedIdentityId).toBe(u.identityId);
      expect((await userRow(ctx, u.user.id)).kycStatus).toBe("pending");

      // §9.5: the session's kind and identity are on the audit event; NATS carries ids only.
      const audit = await auditRows(ctx, "kyc.session_started");
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({
        verificationId,
        provider: "mock",
        identityId: u.identityId,
        sessionKind: "user",
      });
      expect(ctx.nats.publishedOn("truthoracle.kyc.session_started")).toEqual([
        containing({ payload: { userId: u.user.id, verificationId, provider: "mock" } }),
      ]);
    });

    it("approved submission → verification approved, users.kyc_status approved, GET /me canWithdraw true; nothing raw is persisted (§9.3, §9.4, §9.7)", async () => {
      const u = await newUser(ctx, "apr");
      const verificationId = ok(await kycStart(ctx, u.cookie)).verificationId;
      const done = ok(await kycMockSubmit(ctx, u.cookie, submission(verificationId, "approved")));
      expect(done.userKycStatus).toBe("approved");
      expect(done.verification).toMatchObject({
        id: verificationId,
        provider: "mock",
        attemptNo: 1,
        status: "approved",
        rejectLabels: [],
      });
      expect(done.verification.reviewedAt).toEqual(expect.any(String));

      const summary = ok(await kycSummary(ctx, u.cookie));
      expect(summary).toMatchObject({ status: "approved", attachedIdentityId: u.identityId });
      expect(summary.verification?.id).toBe(verificationId);
      expect(await ctx.get(KycService).withdrawalGate(u.user.id)).toEqual({ allowed: true });
      expect(await userRow(ctx, u.user.id)).toMatchObject({
        kycStatus: "approved",
        kycVerificationId: verificationId,
      });

      const view = await me(ctx, u.cookie);
      expect(view.user.kycStatus).toBe("approved");
      expect(view.kyc).toMatchObject({ status: "approved", attachedIdentityId: u.identityId });
      expect(view.capabilities).toMatchObject({
        canWithdraw: true,
        canDeposit: true,
        kycRequiredForWithdrawal: true,
        primaryPartyId: u.wallet.partyId,
      });
      expect(view.identities.find((i) => i.id === u.identityId)?.kycLocked).toBe(true);

      expect(ctx.nats.publishedOn("truthoracle.kyc.status_changed")).toEqual([
        containing({
          payload: containing({
            userId: u.user.id,
            verificationId,
            status: "approved",
            userKycStatus: "approved",
          }),
        }),
      ]);
      // §9.7 audit allow-list: verificationId, provider, level, status, rejectType, labels, attemptNo.
      const changed = await auditRows(ctx, "kyc.status_changed");
      expect(changed).toHaveLength(1);
      expect(Object.keys(changed[0].metadata).sort()).toEqual([
        "attemptNo",
        "labels",
        "level",
        "provider",
        "rejectType",
        "status",
        "verificationId",
      ]);
      const text = await persistedText(ctx);
      for (const raw of RAW_VALUES) expect(text).not.toContain(raw);
    });

    it("persons binding: one doc key and one person key — peppered HMACs of the §9.3 canonical forms, bound to the approving verification", async () => {
      const u = await newUser(ctx, "bind");
      const verificationId = await approve(ctx, u.cookie);
      const rows = await personsOf(ctx, u.user.id);
      expect(rows.map((r) => r.kind)).toEqual(["doc", "person"]);
      for (const row of rows) {
        expect(row).toMatchObject({
          userId: u.user.id,
          verificationId,
          fingerprintVersion: 1,
          releasedAt: null,
          releasedBy: null,
          releaseReason: null,
        });
        expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
      const pepper = ctx.config.kycFingerprintPepper;
      expect(rows[0].fingerprint).toBe(fingerprint(pepper, "IND|PASSPORT|Z1234567"));
      expect(rows[1].fingerprint).toBe(fingerprint(pepper, "IND|1990-01-01|DOE|JANE"));
    });

    it("the same passport on a second account → blocked_duplicate; sessions refused 409 kyc_duplicate_identity; canDeposit false; nothing names the first account (§9.3)", async () => {
      const first = await newUser(ctx, "dup-a");
      const firstVerification = await approve(ctx, first.cookie);

      const second = await newUser(ctx, "dup-b");
      const verificationId = ok(await kycStart(ctx, second.cookie)).verificationId;
      const done = ok(
        await kycMockSubmit(
          ctx,
          second.cookie,
          submission(verificationId, "approved", OTHER_PERSON, [PASSPORT]),
        ),
      );
      expect(done.verification.status).toBe("blocked_duplicate");
      expect(done.userKycStatus).toBe("blocked_duplicate");
      expect(await userRow(ctx, second.user.id)).toMatchObject({
        kycStatus: "blocked_duplicate",
        kycVerificationId: verificationId,
      });

      // The binding stays with the first account; the second account gets no (partial) binding.
      expect(await personsOf(ctx, second.user.id)).toEqual([]);
      const firstRows = await personsOf(ctx, first.user.id);
      expect(firstRows).toHaveLength(2);
      expect(
        firstRows.every((r) => r.verificationId === firstVerification && r.releasedAt === null),
      ).toBe(true);

      const refusedStart = refused(
        await kycStart(ctx, second.cookie),
        409,
        "kyc_duplicate_identity",
      );
      const view = await me(ctx, second.cookie);
      expect(view.kyc.status).toBe("blocked_duplicate");
      expect(view.capabilities).toMatchObject({ canDeposit: false, canWithdraw: false });
      for (const secret of [first.user.id, first.wallet.partyId, firstVerification]) {
        expect(JSON.stringify(refusedStart)).not.toContain(secret);
        expect(JSON.stringify(done)).not.toContain(secret);
        expect(JSON.stringify(view)).not.toContain(secret);
      }

      expect(ok(await kycSummary(ctx, second.cookie))).toMatchObject({
        status: "blocked_duplicate",
      });
      expect(await ctx.get(KycService).withdrawalGate(second.user.id)).toEqual({
        allowed: false,
        reason: "kyc_duplicate_identity",
      });

      const detected = await auditRows(ctx, "kyc.duplicate_detected");
      expect(detected).toHaveLength(1);
      expect(detected[0].subjectId).toBe(verificationId);
      expect(ctx.nats.publishedOn("truthoracle.kyc.duplicate_detected")).toEqual([
        containing({ payload: containing({ userId: second.user.id, verificationId }) }),
      ]);
      const text = await persistedText(ctx);
      for (const raw of RAW_VALUES) expect(text).not.toContain(raw);
    });

    it("duplicate through the person key alone: a different document number with the same name + dob + country → blocked_duplicate (§9.3)", async () => {
      const first = await newUser(ctx, "pk-a");
      await approve(ctx, first.cookie);

      const second = await newUser(ctx, "pk-b");
      const verificationId = ok(await kycStart(ctx, second.cookie)).verificationId;
      const otherPassport: KycMockDocumentDto = { ...PASSPORT, number: "X7654321" };
      const done = ok(
        await kycMockSubmit(
          ctx,
          second.cookie,
          submission(verificationId, "approved", PERSON, [otherPassport]),
        ),
      );
      expect(done.verification.status).toBe("blocked_duplicate");
      expect(done.userKycStatus).toBe("blocked_duplicate");

      // The fresh doc key was inserted under a savepoint and rolled back with the collision.
      expect(await personsOf(ctx, second.user.id)).toEqual([]);
      const freshDocKey = fingerprint(ctx.config.kycFingerprintPepper, "IND|PASSPORT|X7654321");
      expect(
        await ctx.dataSource.getRepository(KycPersonEntity).findOneBy({ fingerprint: freshDocKey }),
      ).toBeNull();
      refused(await kycStart(ctx, second.cookie), 409, "kyc_duplicate_identity");
    });

    it("document numbers are normalised: ' z-1234567 ' collides with 'Z1234567'; a genuinely different passport does not (§9.3)", async () => {
      const first = await newUser(ctx, "norm-a");
      await approve(ctx, first.cookie);

      const second = await newUser(ctx, "norm-b");
      const v2 = ok(await kycStart(ctx, second.cookie)).verificationId;
      const messy: KycMockDocumentDto = {
        docType: "PASSPORT",
        country: "ind",
        number: " z-1234567 ",
      };
      const dup = ok(
        await kycMockSubmit(ctx, second.cookie, submission(v2, "approved", OTHER_PERSON, [messy])),
      );
      expect(dup.verification.status).toBe("blocked_duplicate");

      const third = await newUser(ctx, "norm-c");
      const v3 = ok(await kycStart(ctx, third.cookie)).verificationId;
      const different: KycMockDocumentDto = { ...PASSPORT, number: "Z1234568" };
      const fine = ok(
        await kycMockSubmit(
          ctx,
          third.cookie,
          submission(v3, "approved", OTHER_PERSON, [different]),
        ),
      );
      expect(fine.verification.status).toBe("approved");
      expect((await personsOf(ctx, third.user.id)).map((r) => r.kind)).toEqual(["doc", "person"]);
    });

    it("approved with no identity document → needs_review, never approved; no binding, gate still refuses (§9.3)", async () => {
      const u = await newUser(ctx, "nr");
      const verificationId = ok(await kycStart(ctx, u.cookie)).verificationId;
      const done = ok(
        await kycMockSubmit(ctx, u.cookie, submission(verificationId, "approved", PERSON, [])),
      );
      expect(done.verification.status).toBe("needs_review");
      expect(done.userKycStatus).toBe("pending");
      expect(ok(await kycSummary(ctx, u.cookie))).toMatchObject({
        status: "pending",
        verification: containing({ id: verificationId, status: "needs_review" }),
      });
      expect(await personsOf(ctx, u.user.id)).toEqual([]);
      expect(await ctx.get(KycService).withdrawalGate(u.user.id)).toEqual({
        allowed: false,
        reason: "kyc_required",
      });
      expect((await me(ctx, u.cookie)).capabilities.canWithdraw).toBe(false);
      expect(await auditRows(ctx, "kyc.needs_review")).toHaveLength(1);
    });

    it("rejected_retry → GET /kyc rejected; a new POST /kyc/sessions opens attempt 2 (§9.2)", async () => {
      const u = await newUser(ctx, "retry");
      const v1 = ok(await kycStart(ctx, u.cookie)).verificationId;
      const done = ok(await kycMockSubmit(ctx, u.cookie, submission(v1, "rejected_retry")));
      expect(done.verification.status).toBe("rejected_retry");
      expect(done.userKycStatus).toBe("rejected");
      expect(ok(await kycSummary(ctx, u.cookie))).toMatchObject({
        status: "rejected",
        verification: containing({ id: v1, status: "rejected_retry" }),
      });

      const v2 = ok(await kycStart(ctx, u.cookie)).verificationId;
      expect(v2).not.toBe(v1);
      const summary = ok(await kycSummary(ctx, u.cookie));
      expect(summary).toMatchObject({ status: "pending", attachedIdentityId: u.identityId });
      expect(summary.verification).toMatchObject({ id: v2, attemptNo: 2, status: "initiated" });
      expect(summary.history.map((v) => v.attemptNo)).toEqual([2, 1]);
      expect(
        (await ctx.dataSource.getRepository(KycVerificationEntity).findOneByOrFail({ id: v2 }))
          .attemptNo,
      ).toBe(2);
    });

    it("rejected_final → GET /kyc rejected; the attempt is closed to further mock outcomes, but a new session is still allowed (§9.2; API.md lists only kyc_duplicate_identity / kyc_provider_unavailable as refusals)", async () => {
      const u = await newUser(ctx, "final");
      const v1 = ok(await kycStart(ctx, u.cookie)).verificationId;
      const done = ok(await kycMockSubmit(ctx, u.cookie, submission(v1, "rejected_final")));
      expect(done.verification.status).toBe("rejected_final");
      expect(done.userKycStatus).toBe("rejected");
      expect(ok(await kycSummary(ctx, u.cookie))).toMatchObject({ status: "rejected" });
      expect(await ctx.get(KycService).withdrawalGate(u.user.id)).toEqual({
        allowed: false,
        reason: "kyc_required",
      });

      // A final decision cannot be re-driven through the same verification.
      expect((await kycMockSubmit(ctx, u.cookie, submission(v1, "approved"))).status).toBe(409);

      // The §9.2 lifecycle has no "no more sessions" state other than blocked_duplicate (§9.3).
      const v2 = ok(await kycStart(ctx, u.cookie)).verificationId;
      expect(v2).not.toBe(v1);
      expect(ok(await kycSummary(ctx, u.cookie)).verification).toMatchObject({
        id: v2,
        attemptNo: 2,
        status: "initiated",
      });
    });

    it("mock submit is scoped to the caller: another account's verification and an unknown id are 404; the body is validated", async () => {
      const owner = await newUser(ctx, "scope-a");
      const v = ok(await kycStart(ctx, owner.cookie)).verificationId;
      const intruder = await newUser(ctx, "scope-b");
      refused(
        await kycMockSubmit(ctx, intruder.cookie, submission(v, "approved")),
        404,
        "not_found",
      );
      refused(
        await kycMockSubmit(ctx, owner.cookie, submission(randomUUID(), "approved")),
        404,
        "not_found",
      );
      const bad = await http(ctx)
        .post("/api/v1/kyc/mock/submit")
        .set("Cookie", owner.cookie)
        .set(ctx.csrf)
        .send({
          verificationId: v,
          outcome: "approved",
          person: { ...PERSON, country: "India" },
          documents: [{ ...PASSPORT, docType: "VISA" }],
        })
        .expect(400);
      expect(bodyOf<ErrorBody>(bad).error).toBe("validation_failed");
      expect(
        (await ctx.dataSource.getRepository(KycVerificationEntity).findOneByOrFail({ id: v }))
          .status,
      ).toBe("initiated");
    });

    it("identity lock: the identity that started the approval cannot be unlinked (409 identity_locked_by_kyc); GET /me marks it kycLocked; the wallet is not involved (§6.5, §9.5)", async () => {
      // Telegram A opened the account; Telegram B is linked, then used for a second session so
      // the verification is attached to B — an identity only the KYC lock protects.
      const a = await newUser(ctx, "lock-a");
      const linked = await linkTelegram(ctx, a.cookie, "lock-b");
      const b = await signInAgain(ctx, linked.telegram);
      expect(b.identityId).toBe(linked.identityId);

      const verificationId = await approve(ctx, b.cookie);
      expect(ok(await kycSummary(ctx, a.cookie))).toMatchObject({
        status: "approved",
        attachedIdentityId: b.identityId,
        verification: containing({ id: verificationId }),
      });

      const locked = await http(ctx)
        .delete(`/api/v1/me/identities/${b.identityId}`)
        .set("Cookie", a.cookie)
        .set(ctx.csrf)
        .expect(409);
      expect(bodyOf<ErrorBody>(locked).error).toBe("identity_locked_by_kyc");
      expect((await identityRow(ctx, b.identityId)).status).toBe("active");

      const view = await me(ctx, a.cookie);
      expect(view.identities.map((i) => [i.id, i.kycLocked]).sort()).toEqual(
        [
          [a.identityId, false],
          [b.identityId, true],
        ].sort(),
      );
      // The linked wallet is a funding rail, not an identity (§8.1): the lock never applies to it, only §8.2 does.
      const walletA = view.wallets.find((w) => w.partyId === a.wallet.partyId);
      expect(walletA?.isPrimary).toBe(true);
      const viaWallet = await http(ctx)
        .delete(`/api/v1/wallets/${walletA?.id}`)
        .set("Cookie", a.cookie)
        .set(ctx.csrf)
        .expect(409);
      expect(bodyOf<ErrorBody>(viaWallet).error).toBe("primary_wallet_in_use");
    });

    it("identity lock at the seam: KycService.lockedIdentityId names the initiating identity; IdentityService.unlink refuses users and lets admins through (§6.5)", async () => {
      const a = await newUser(ctx, "seam-a");
      const linked = await linkTelegram(ctx, a.cookie, "seam-b");
      const b = await signInAgain(ctx, linked.telegram);
      const kyc = ctx.get(KycService);
      const identities = ctx.get(IdentityService);
      expect(await kyc.lockedIdentityId(a.user.id)).toBeNull();

      await approve(ctx, b.cookie);
      expect(await kyc.lockedIdentityId(a.user.id)).toBe(b.identityId);
      await expect(
        identities.unlink(a.user.id, b.identityId, { type: "user", userId: a.user.id }),
      ).rejects.toMatchObject({ status: 409, code: "identity_locked_by_kyc" });
      expect(
        identities.toApi(
          await identityRow(ctx, b.identityId),
          await kyc.lockedIdentityId(a.user.id),
        ).kycLocked,
      ).toBe(true);

      // Admins can (§6.5).
      await identities.unlink(a.user.id, b.identityId, { type: "admin", userId: null });
      expect((await identityRow(ctx, b.identityId)).status).toBe("unlinked");
      // The approval stands; the lock still points at the (now unlinked) identity.
      expect(await kyc.lockedIdentityId(a.user.id)).toBe(b.identityId);
      expect((await userRow(ctx, a.user.id)).kycStatus).toBe("approved");
    });

    // ARCHITECTURE §6.5 before §6.3: the initiating identity of a one-identity account is refused
    // as identity_locked_by_kyc (the refusal an operator can lift), not as last_identity.
    it("identity lock precedence: the sole identity that started the approval answers identity_locked_by_kyc, not last_identity (§6.5 vs §6.3)", async () => {
      const u = await newUser(ctx, "prec");
      await approve(ctx, u.cookie);
      const res = await http(ctx)
        .delete(`/api/v1/me/identities/${u.identityId}`)
        .set("Cookie", u.cookie)
        .set(ctx.csrf)
        .expect(409);
      expect(bodyOf<ErrorBody>(res).error).toBe("identity_locked_by_kyc");
      // Without the lock the same row is the last identity.
      const plain = await newUser(ctx, "prec-plain");
      const last = await http(ctx)
        .delete(`/api/v1/me/identities/${plain.identityId}`)
        .set("Cookie", plain.cookie)
        .set(ctx.csrf)
        .expect(409);
      expect(bodyOf<ErrorBody>(last).error).toBe("last_identity");
    });
  });

  // ───────────────────────────────── Sumsub provider ─────────────────────────────────────────────
  describe("Sumsub provider — KYC_PROVIDER=sumsub", () => {
    const ctx = useTestApp({
      env: {
        KYC_PROVIDER: "sumsub",
        SUMSUB_APP_TOKEN: "sbx:e2e-app-token",
        SUMSUB_SECRET_KEY: "e2e-secret-key-not-used-by-these-tests",
        SUMSUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
        ADMIN_OPERATORS: operator.partyId,
      },
    });
    const webhookRows = (): Promise<KycWebhookEventEntity[]> =>
      ctx.dataSource.getRepository(KycWebhookEventEntity).find({ order: { receivedAt: "ASC" } });

    it("GET /admin/kyc/provider probes Sumsub with a signed request and reports the wiring; 401 from Sumsub is named (docs/KYC.md §6)", async () => {
      const calls: { url: string; headers: Record<string, string> }[] = [];
      let answer = { status: 404, body: { description: "Applicant not found", code: 404 } };
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
      };
      try {
        const admin = await issueSessionDirect(ctx, operator, { kind: "admin" });
        const status = ok<{
          provider: string;
          configured: boolean;
          levelName: string;
          enforceWithdrawals: boolean;
          webhookPath: string;
          health: {
            ok: boolean;
            upstreamStatus: number | null;
            message: string;
            details: Record<string, unknown>;
          };
        }>(
          await http(ctx).get("/api/v1/admin/kyc/provider").set("Cookie", admin.cookie).expect(200),
        );
        expect(status).toMatchObject({
          provider: "sumsub",
          configured: true,
          levelName: "basic-kyc-level",
          enforceWithdrawals: false,
          webhookPath: "/api/v1/webhooks/kyc/sumsub",
        });
        expect(status.health).toMatchObject({ ok: true, upstreamStatus: 404 });
        expect(status.health.details).toMatchObject({
          baseUrl: "https://api.sumsub.com",
          sandboxToken: true,
          webhookSecretConfigured: true,
          acceptedDigestAlgorithms: ["HMAC_SHA256_HEX", "HMAC_SHA512_HEX"],
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toMatch(
          /^https:\/\/api\.sumsub\.com\/resources\/applicants\/-;externalUserId=health-[0-9a-f-]+\/one$/,
        );
        const h = calls[0].headers;
        expect(h["X-App-Token"]).toBe("sbx:e2e-app-token");
        expect(h["X-App-Access-Ts"]).toMatch(/^\d{10}$/);
        const path = calls[0].url.slice("https://api.sumsub.com".length);
        expect(h["X-App-Access-Sig"]).toBe(
          signSumsubRequest(
            "e2e-secret-key-not-used-by-these-tests",
            h["X-App-Access-Ts"],
            "GET",
            path,
          ),
        );

        answer = { status: 401, body: { description: "Invalid signature", code: 401 } };
        const bad = ok<{ health: { ok: boolean; upstreamStatus: number | null; message: string } }>(
          await http(ctx).get("/api/v1/admin/kyc/provider").set("Cookie", admin.cookie).expect(200),
        );
        expect(bad.health).toMatchObject({ ok: false, upstreamStatus: 401 });
        expect(bad.health.message).toContain("SUMSUB_APP_TOKEN / SUMSUB_SECRET_KEY");
      } finally {
        globalThis.fetch = realFetch;
      }
      // A user session is refused; the route sits behind AdminGuard like the rest of /admin.
      const u = await newUser(ctx, "probe");
      await http(ctx).get("/api/v1/admin/kyc/provider").set("Cookie", u.cookie).expect(403);
    });

    it("the mock controller is absent: POST /kyc/mock/submit → 404 not_found envelope; GET /kyc reports provider sumsub", async () => {
      const u = await newUser(ctx, "sumsub");
      const res = await http(ctx)
        .post("/api/v1/kyc/mock/submit")
        .set("Cookie", u.cookie)
        .set(ctx.csrf)
        .send(submission(randomUUID(), "approved"))
        .expect(404);
      expect(res.body).toEqual({
        error: "not_found",
        message: "Cannot POST /api/v1/kyc/mock/submit",
      });
      expect(ok(await kycSummary(ctx, u.cookie))).toMatchObject({
        provider: "sumsub",
        status: "none",
      });
    });

    it("POST /webhooks/kyc/sumsub: valid HMAC-SHA256 digest → 200 {received:true}, stored once on event_key without clientComment, {eventId} published (§9.2, §9.7)", async () => {
      const u = await newUser(ctx, "wh-ok");
      const body = sumsubEvent(u.user.id);
      const { raw, headers } = signed(body);
      // No cookie, no Origin: the digest is the authentication and /webhooks is CSRF-exempt (§6.7).
      const res = await postWebhook(ctx, raw, headers).expect(200);
      expect(res.body).toEqual({ received: true });

      const rows = await webhookRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "sumsub",
        eventKey: eventKeyOf(raw),
        type: "applicantReviewed",
        sandbox: false,
      });
      expect(JSON.stringify(rows[0].payload)).not.toContain("clientComment");
      expect(JSON.stringify(rows[0].payload)).toContain(SUMSUB_APPLICANT);
      expect(ctx.nats.publishedOn("truthoracle.kyc.webhook.sumsub")).toEqual([
        containing({ payload: { eventId: rows[0].id } }),
      ]);
      expect((await auditRows(ctx, "kyc.webhook_received")).map((a) => a.subjectId)).toEqual([
        rows[0].id,
      ]);

      // Replays are acknowledged and stored once (idempotent on event_key).
      await postWebhook(ctx, raw, headers).expect(200);
      expect(await webhookRows()).toHaveLength(1);
    });

    it("POST /webhooks/kyc/sumsub: bad digest → 401; missing x-payload-digest-alg → 401; HMAC_SHA1_HEX → 401 unless SUMSUB_ALLOW_SHA1; nothing stored or published (§9.1)", async () => {
      const u = await newUser(ctx, "wh-bad");
      const body = sumsubEvent(u.user.id);
      const good = signed(body);

      const tampered = await postWebhook(ctx, good.raw, {
        ...good.headers,
        "x-payload-digest": "0".repeat(64),
      }).expect(401);
      expect(bodyOf<ErrorBody>(tampered).error).toBe("webhook_rejected");
      const wrongSecret = signed(body, "HMAC_SHA256_HEX", "not-the-secret");
      await postWebhook(ctx, wrongSecret.raw, wrongSecret.headers).expect(401);
      const { "x-payload-digest-alg": _dropped, ...noAlg } = good.headers;
      await postWebhook(ctx, good.raw, noAlg).expect(401);
      const { "x-payload-digest": _noDigest, ...noDigest } = good.headers;
      await postWebhook(ctx, good.raw, noDigest).expect(401);
      const sha1 = signed(body, "HMAC_SHA1_HEX");
      await postWebhook(ctx, sha1.raw, sha1.headers).expect(401);
      expect(await webhookRows()).toEqual([]);
      expect(ctx.nats.publishedOn("truthoracle.kyc.webhook.sumsub")).toEqual([]);

      const sumsub = ctx.config.sumsub as { allowSha1: boolean };
      sumsub.allowSha1 = true;
      try {
        await postWebhook(ctx, sha1.raw, sha1.headers).expect(200);
      } finally {
        sumsub.allowSha1 = false;
      }
      expect(await webhookRows()).toHaveLength(1);
    });

    it("the durable consumer on truthoracle.kyc.webhook.<provider> re-reads the stored row, applies it and marks it processed (§9.2)", async () => {
      const u = await newUser(ctx, "wh-consume");
      expect(
        ctx.nats.consumers.some((c) =>
          subjectMatches(c.filterSubject, "truthoracle.kyc.webhook.sumsub"),
        ),
      ).toBe(true);

      // Nobody started a verification: the event is a no-op that is still recorded as processed.
      const { raw, headers } = signed(sumsubEvent(u.user.id, "applicantPending"));
      await postWebhook(ctx, raw, headers).expect(200);
      const row = await ctx.dataSource
        .getRepository(KycWebhookEventEntity)
        .findOneByOrFail({ eventKey: eventKeyOf(raw) });
      expect(row.processedAt).toBeNull();
      expect(
        await ctx.nats.dispatch("truthoracle.kyc.webhook.sumsub", { eventId: row.id }),
      ).toEqual(["ack"]);
      const after = await ctx.dataSource
        .getRepository(KycWebhookEventEntity)
        .findOneByOrFail({ id: row.id });
      expect(after.processedAt).not.toBeNull();
      expect(after.attempts).toBe(1);
      // Malformed triggers are terminated, never retried.
      expect(await ctx.nats.dispatch("truthoracle.kyc.webhook.sumsub", { nope: 1 })).toEqual([
        "term",
      ]);
    });

    it("Sumsub adapter: digest rules over the raw body — both headers required, sha256/sha512 accepted, sha1 only with SUMSUB_ALLOW_SHA1 (§9.1)", async () => {
      const u = await newUser(ctx, "wh-adapter");
      const sumsub = ctx.get(KycProviderSumsubService);
      const body = sumsubEvent(u.user.id);

      const good = signed(body);
      expect(sumsub.verifyWebhook(good.raw, good.headers)).toMatchObject({
        kind: "reviewed",
        answer: "GREEN",
        applicantId: SUMSUB_APPLICANT,
        externalUserId: u.user.id,
        levelName: "basic-kyc-level",
        sandbox: false,
        eventKey: eventKeyOf(good.raw),
        labels: [],
      });
      const sha512 = signed(body, "HMAC_SHA512_HEX");
      expect(sumsub.verifyWebhook(sha512.raw, sha512.headers)).not.toBeNull();

      expect(
        sumsub.verifyWebhook(good.raw, { ...good.headers, "x-payload-digest": "0".repeat(64) }),
      ).toBeNull();
      const wrongSecret = signed(body, "HMAC_SHA256_HEX", "not-the-secret");
      expect(sumsub.verifyWebhook(wrongSecret.raw, wrongSecret.headers)).toBeNull();
      const { "x-payload-digest-alg": _alg, ...noAlg } = good.headers;
      expect(sumsub.verifyWebhook(good.raw, noAlg)).toBeNull();
      const { "x-payload-digest": _digest, ...noDigest } = good.headers;
      expect(sumsub.verifyWebhook(good.raw, noDigest)).toBeNull();
      // A tampered body no longer matches its digest.
      expect(
        sumsub.verifyWebhook(
          Buffer.from(good.raw.toString("utf8").replace("GREEN", "RED")),
          good.headers,
        ),
      ).toBeNull();

      const sha1 = signed(body, "HMAC_SHA1_HEX");
      expect(sumsub.verifyWebhook(sha1.raw, sha1.headers)).toBeNull();
      const cfg = ctx.config.sumsub as { allowSha1: boolean };
      cfg.allowSha1 = true;
      try {
        expect(sumsub.verifyWebhook(sha1.raw, sha1.headers)).not.toBeNull();
      } finally {
        cfg.allowSha1 = false;
      }

      const sandbox = signed(sumsubEvent(u.user.id, "applicantReviewed", { sandboxMode: true }));
      expect(sumsub.verifyWebhook(sandbox.raw, sandbox.headers)?.sandbox).toBe(true);
    });

    it("KycService applies stored events in occurredAt order against the open attempt, binds the applicant, and drops stale ones (§9.2, §9.7)", async () => {
      const u = await newUser(ctx, "wh-apply");
      const kyc = ctx.get(KycService);
      const sumsub = ctx.get(KycProviderSumsubService);
      const events = ctx.dataSource.getRepository(KycWebhookEventEntity);
      const verifications = ctx.dataSource.getRepository(KycVerificationEntity);

      // The attempt a Sumsub session would have opened (no provider network in tests).
      const verification = await verifications.save(
        verifications.create({
          userId: u.user.id,
          provider: "sumsub",
          providerApplicantId: null,
          levelName: ctx.config.kycRequiredLevel,
          attemptNo: 1,
          status: "initiated",
          initiatedIdentityId: u.identityId,
          providerEventAt: null,
          rejectLabels: null,
          moderationComment: null,
          manual: false,
          manualReason: null,
          reviewedAt: null,
        }),
      );

      const pendingBody = sumsubEvent(u.user.id, "applicantPending", {
        createdAtMs: "2026-09-10 10:00:00.000",
      });
      const pending = signed(pendingBody);
      const event = sumsub.verifyWebhook(pending.raw, pending.headers);
      expect(event).not.toBeNull();

      const stored = await kyc.storeWebhookEvent(
        "sumsub",
        event!,
        redactSumsubPayload(pendingBody),
      );
      expect(stored).toMatchObject({ created: true, processed: false });
      expect(
        await kyc.storeWebhookEvent("sumsub", event!, redactSumsubPayload(pendingBody)),
      ).toMatchObject({ id: stored.id, created: false });
      expect(await events.count()).toBe(1);
      const row = await events.findOneByOrFail({ id: stored.id });
      expect(row).toMatchObject({
        provider: "sumsub",
        eventKey: eventKeyOf(pending.raw),
        type: "applicantPending",
        processedAt: null,
      });
      expect(JSON.stringify(row.payload)).not.toContain("clientComment");

      await kyc.publishWebhookTrigger("sumsub", stored.id, row.eventKey);
      expect(ctx.nats.publishedOn("truthoracle.kyc.webhook.sumsub")).toEqual([
        {
          subject: "truthoracle.kyc.webhook.sumsub",
          payload: { eventId: stored.id },
          msgId: row.eventKey,
        },
      ]);

      expect(await kyc.applyEvent(stored.id)).toEqual({
        outcome: "applied",
        verificationId: verification.id,
        status: "pending",
        changed: true,
      });
      expect((await events.findOneByOrFail({ id: stored.id })).processedAt).not.toBeNull();
      expect((await verifications.findOneByOrFail({ id: verification.id })).status).toBe("pending");
      expect(await userRow(ctx, u.user.id)).toMatchObject({
        kycStatus: "pending",
        kycProvider: "sumsub",
        kycApplicantId: SUMSUB_APPLICANT,
      });
      expect(ok(await kycSummary(ctx, u.cookie))).toMatchObject({
        provider: "sumsub",
        status: "pending",
        attachedIdentityId: u.identityId,
      });

      // An older event arriving late is dropped (§9.2 "events older than provider_event_at").
      const staleBody = sumsubEvent(u.user.id, "applicantOnHold", {
        createdAtMs: "2026-09-10 09:00:00.000",
      });
      const stale = signed(staleBody);
      const staleRow = await kyc.storeWebhookEvent(
        "sumsub",
        sumsub.verifyWebhook(stale.raw, stale.headers)!,
        redactSumsubPayload(staleBody),
      );
      expect(await kyc.applyEvent(staleRow.id)).toEqual({
        outcome: "skipped",
        reason: "stale_event",
      });
      expect((await verifications.findOneByOrFail({ id: verification.id })).status).toBe("pending");
      expect(await kyc.applyEvent(staleRow.id)).toEqual({
        outcome: "skipped",
        reason: "already_processed",
      });

      // An event kind the state machine does not act on (applicantTagsChanged) arriving with a LATER
      // timestamp must not move the ordering watermark: the real review that follows, timestamped
      // between the two, is still applied (§9.2).
      const store = async (body: Record<string, unknown>): Promise<string> => {
        const signedBody = signed(body);
        return (
          await kyc.storeWebhookEvent(
            "sumsub",
            sumsub.verifyWebhook(signedBody.raw, signedBody.headers)!,
            redactSumsubPayload(body),
          )
        ).id;
      };
      const tags = await store(
        sumsubEvent(u.user.id, "applicantTagsChanged", {
          createdAtMs: "2026-09-10 11:00:00.000",
          reviewResult: undefined,
          reviewStatus: undefined,
        }),
      );
      expect(await kyc.applyEvent(tags)).toEqual({
        outcome: "applied",
        verificationId: verification.id,
        status: "pending",
        changed: false,
      });
      expect(
        (
          await verifications.findOneByOrFail({ id: verification.id })
        ).providerEventAt?.toISOString(),
      ).toBe("2026-09-10T10:00:00.000Z");
      const red = await store(
        sumsubEvent(u.user.id, "applicantReviewed", {
          createdAtMs: "2026-09-10 10:30:00.000",
          reviewResult: {
            reviewAnswer: "RED",
            reviewRejectType: "RETRY",
            rejectLabels: ["BAD_PROOF_OF_IDENTITY"],
          },
        }),
      );
      expect(await kyc.applyEvent(red)).toEqual({
        outcome: "applied",
        verificationId: verification.id,
        status: "rejected_retry",
        changed: true,
      });
      expect(await verifications.findOneByOrFail({ id: verification.id })).toMatchObject({
        status: "rejected_retry",
        rejectLabels: ["BAD_PROOF_OF_IDENTITY"],
      });
      // A `reviewed` event with no reviewAnswer carries no decision: nothing changes (it is not a rejection).
      const noAnswer = await store(
        sumsubEvent(u.user.id, "applicantWorkflowCompleted", {
          createdAtMs: "2026-09-10 10:45:00.000",
          reviewResult: {},
          reviewStatus: "completed",
        }),
      );
      expect(await kyc.applyEvent(noAnswer)).toEqual({
        outcome: "applied",
        verificationId: verification.id,
        status: "rejected_retry",
        changed: false,
      });
      // Every status change was published AFTER its transaction committed, in order.
      expect(
        ctx.nats
          .publishedOn("truthoracle.kyc.status_changed")
          .map((e) => (e.payload as { status: string }).status),
      ).toEqual(["pending", "rejected_retry"]);
    });

    it("an exhausted webhook row is re-armed by the sweep after the cooldown, and an operator can replay it at once (RUNBOOK §4)", async () => {
      const u = await newUser(ctx, "wh-exhausted");
      const events = ctx.dataSource.getRepository(KycWebhookEventEntity);
      const { raw, headers } = signed(sumsubEvent(u.user.id, "applicantPending"));
      await postWebhook(ctx, raw, headers).expect(200);
      const row = await events.findOneByOrFail({ eventKey: eventKeyOf(raw) });
      ctx.nats.reset();

      // The consumer gave up (20 attempts) five minutes ago: the cooldown has not elapsed → left alone.
      await events.update(
        { id: row.id },
        {
          attempts: 20,
          error: "Sumsub GET /resources/applicants failed: HTTP 503",
          lastAttemptAt: new Date(Date.now() - 5 * 60_000),
        },
      );
      const processor = ctx.get(KycWebhookProcessor);
      expect(await processor.sweep()).toBe(0);
      expect((await events.findOneByOrFail({ id: row.id })).attempts).toBe(20);

      // Past the cooldown: attempts reset, trigger re-published with a fresh msgId.
      await events.update(
        { id: row.id },
        { lastAttemptAt: new Date(Date.now() - 2 * 60 * 60_000) },
      );
      expect(await processor.sweep()).toBe(1);
      expect((await events.findOneByOrFail({ id: row.id })).attempts).toBe(0);
      const republished = ctx.nats.publishedOn("truthoracle.kyc.webhook.sumsub");
      expect(republished).toEqual([containing({ payload: { eventId: row.id } })]);
      expect(republished[0].msgId).toMatch(new RegExp(`^${row.eventKey}:sweep:\\d+$`));

      // Operator replay: audited, attempts reset, distinct msgId; a processed row is refused, an unknown id is 404.
      const admin = await signInAsAdmin(http(ctx), operator);
      await events.update({ id: row.id }, { attempts: 20 });
      const bad = await http(ctx)
        .post(`/api/v1/admin/kyc/webhooks/${row.id}/replay`)
        .set("Cookie", admin.cookie)
        .set(ctx.csrf)
        .send({})
        .expect(400);
      expect(bodyOf<ErrorBody>(bad).error).toBe("validation_failed");
      const replayed = await http(ctx)
        .post(`/api/v1/admin/kyc/webhooks/${row.id}/replay`)
        .set("Cookie", admin.cookie)
        .set(ctx.csrf)
        .send({ reason: "Sumsub outage 2026-09-10" })
        .expect(200);
      expect(replayed.body).toEqual({ ok: true, eventId: row.id });
      expect((await events.findOneByOrFail({ id: row.id })).attempts).toBe(0);
      const triggers = ctx.nats.publishedOn("truthoracle.kyc.webhook.sumsub");
      expect(triggers).toHaveLength(2);
      expect(triggers[1].msgId).toMatch(new RegExp(`^${row.eventKey}:replay:\\d+$`));
      expect(await auditRows(ctx, "kyc.webhook_replayed")).toEqual([
        expect.objectContaining({
          actorType: "admin",
          actorUserId: admin.user.id,
          subjectType: "kyc_webhook_event",
          subjectId: row.id,
          metadata: containing({ reason: "Sumsub outage 2026-09-10", previousAttempts: 20 }),
        }),
      ]);
      // Applying it through the consumer marks it processed; a replay is then refused.
      expect(
        await ctx.nats.dispatch("truthoracle.kyc.webhook.sumsub", { eventId: row.id }),
      ).toEqual(["ack"]);
      const done = await http(ctx)
        .post(`/api/v1/admin/kyc/webhooks/${row.id}/replay`)
        .set("Cookie", admin.cookie)
        .set(ctx.csrf)
        .send({ reason: "again" })
        .expect(409);
      expect(bodyOf<ErrorBody>(done).error).toBe("bad_request");
      await http(ctx)
        .post(`/api/v1/admin/kyc/webhooks/${randomUUID()}/replay`)
        .set("Cookie", admin.cookie)
        .set(ctx.csrf)
        .send({ reason: "x" })
        .expect(404);
      // A user session cannot replay.
      await http(ctx)
        .post(`/api/v1/admin/kyc/webhooks/${row.id}/replay`)
        .set("Cookie", u.cookie)
        .set(ctx.csrf)
        .send({ reason: "x" })
        .expect(403);
    });

    it("the consumer's retry delay grows exponentially and is capped at 10 minutes", () => {
      expect([1, 2, 3, 4, 5, 8, 20].map((n) => kycWebhookNakDelayMs(n))).toEqual([
        5_000, 10_000, 20_000, 40_000, 80_000, 600_000, 600_000,
      ]);
    });
  });

  // ───────────────────────────────── unconfigured provider (§9.1) ────────────────────────────────
  describe("unconfigured provider — KycProvider.isConfigured() false", () => {
    const fakeProvider = new FakeKycProvider("sumsub");
    const ctx = useTestApp({
      env: { KYC_PROVIDER: "sumsub" },
      configure: (b) => b.overrideProvider(KYC_PROVIDER).useValue(fakeProvider),
    });

    it("POST /kyc/sessions → 503 kyc_provider_unavailable and GET /kyc reports provider null; configured again → a session opens", async () => {
      const u = await newUser(ctx, "unconf");
      fakeProvider.configured = false;
      refused(await kycStart(ctx, u.cookie), 503, "kyc_provider_unavailable");
      expect(ok(await kycSummary(ctx, u.cookie))).toMatchObject({ provider: null, status: "none" });
      expect(await ctx.dataSource.getRepository(KycVerificationEntity).count()).toBe(0);
      fakeProvider.configured = true;
      expect(ok(await kycStart(ctx, u.cookie))).toMatchObject({
        provider: "sumsub",
        accessToken: "fake-token-1",
      });
      expect(ok(await kycSummary(ctx, u.cookie))).toMatchObject({
        provider: "sumsub",
        status: "pending",
      });
    });
  });

  // ───────────────────────────────── configuration guard (§12) ───────────────────────────────────
  describe("configuration guard (§12) — getConfiguration", () => {
    const zkpc = {
      ZKPC_LEDGER_API_URL: "http://zkpc-ledger.fake",
      ZKPC_KEYCLOAK_URL: "http://zkpc-kc.fake",
      ZKPC_KEYCLOAK_CLIENT_ID: "zkpc-client",
      ZKPC_KEYCLOAK_CLIENT_SECRET: "zkpc-secret",
    };

    it("refuses KYC_PROVIDER=mock on APP_NETWORK=mainnet and on APP_ENV=prod", () => {
      expect(() =>
        getConfiguration(testEnv({ APP_NETWORK: "mainnet", KYC_PROVIDER: "mock", ...zkpc })),
      ).toThrow(/KYC_PROVIDER=mock/);
      expect(() => getConfiguration(testEnv({ APP_ENV: "prod", KYC_PROVIDER: "mock" }))).toThrow(
        /KYC_PROVIDER=mock/,
      );
      // The same mainnet environment boots with the real provider.
      const cfg = getConfiguration(
        testEnv({
          APP_NETWORK: "mainnet",
          KYC_PROVIDER: "sumsub",
          SUMSUB_APP_TOKEN: "prd:token",
          SUMSUB_WEBHOOK_SECRET: "wh",
          ...zkpc,
        }),
      );
      expect(cfg.kycProvider).toBe("sumsub");
      expect(cfg.isMainnet).toBe(true);
    });

    it("KYC_ENFORCE_WITHDRAWALS is a plain flag; refuses a sandbox Sumsub token on mainnet, and Sumsub without a webhook secret", () => {
      expect(
        getConfiguration(testEnv({ KYC_ENFORCE_WITHDRAWALS: "true" })).kycEnforceWithdrawals,
      ).toBe(true);
      expect(getConfiguration(testEnv()).kycEnforceWithdrawals).toBe(false);
      expect(() =>
        getConfiguration(
          testEnv({
            APP_NETWORK: "mainnet",
            KYC_PROVIDER: "sumsub",
            SUMSUB_APP_TOKEN: "sbx:token",
            SUMSUB_WEBHOOK_SECRET: "wh",
            ...zkpc,
          }),
        ),
      ).toThrow(/sbx:/);
      // Sessions would start while every webhook is 401 — refused at boot instead.
      expect(() =>
        getConfiguration(
          testEnv({
            KYC_PROVIDER: "sumsub",
            SUMSUB_APP_TOKEN: "sbx:token",
            SUMSUB_SECRET_KEY: "k",
          }),
        ),
      ).toThrow(/SUMSUB_WEBHOOK_SECRET/);
    });
  });
});
