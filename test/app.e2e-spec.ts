import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import request from "supertest";

import { DepositConfirmProcessor } from "../src/processors/deposit-confirm.processor";
import { KycWebhookProcessor } from "../src/processors/kyc-webhook.processor";
import { SessionCleanupProcessor } from "../src/processors/session-cleanup.processor";
import { AppService } from "../src/services/app.service";
import type {
  ApiAuditEvent,
  ApiKycSummary,
  ApiKycVerification,
  ApiMe,
  ApiPage,
  ApiSession,
  ApiUser,
  ApiWallet,
  HealthResponse,
  InAppWalletOverview,
  ReconcileResult,
} from "../src/types";
import type { ErrorBody } from "../src/util/errors";
import { TEST_ORIGIN, createTestApp, useTestApp } from "./helpers/app";
import { bodyOf, linkWallet } from "./helpers/session";
import { nextTelegramUser, signInWithTelegram } from "./helpers/telegram";
import { makeTestWallet } from "./helpers/wallet";

/** Boots the real AppModule against Postgres + Redis (NATS, ledger and wallet faked). */
describe("App (e2e)", () => {
  const ctx = useTestApp();

  it("GET /health is unprefixed and reports env + network", async () => {
    const res = await ctx.agent.get("/health").expect(200);
    const body = bodyOf<HealthResponse>(res);
    expect(body).toMatchObject({
      status: "ok",
      service: "truthoracle-backend",
      env: "dev",
      network: "devnet",
    });
    expect(typeof body.ts).toBe("string");
  });

  it("GET /health/ready is 200 when every dependency answers", async () => {
    const res = await ctx.agent.get("/health/ready").expect(200);
    expect(res.body).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok", nats: "ok" } });
  });

  it("GET /health/ready is 503 when a dependency fails", async () => {
    const spy = jest.spyOn(ctx.nats, "isConnected").mockReturnValueOnce(false);
    const res = await ctx.agent.get("/health/ready").expect(503);
    expect(res.body).toEqual({
      status: "degraded",
      checks: { postgres: "ok", redis: "ok", nats: "fail" },
    });
    spy.mockRestore();
  });

  it("unknown routes answer the JSON error envelope", async () => {
    const res = await ctx.agent.get("/api/v1/nope").expect(404);
    const body = bodyOf<ErrorBody>(res);
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("/api/v1/nope");
    expect(res.headers["x-request-id"]).toBeDefined();
    // Paths outside the global prefix get the same envelope (Express's HTML 404 never shows).
    const bare = await ctx.agent
      .post("/nope")
      .set("Origin", "http://app.test")
      .send({})
      .expect(404);
    expect(bodyOf<ErrorBody>(bare)).toEqual({ error: "not_found", message: "Cannot POST /nope" });
    expect(bare.headers["content-type"]).toMatch(/application\/json/);
  });

  it("boot recorded app_network and the pepper hash in to_settings", async () => {
    const rows = await ctx.dataSource.query<{ key: string; value: string }[]>(
      `SELECT key, value FROM to_settings ORDER BY key`,
    );
    expect(rows).toEqual([
      { key: "app_network", value: "devnet" },
      { key: "kyc_pepper_hash", value: ctx.config.kycPepperHash },
    ]);
  });

  /**
   * Integrator smoke: every feature controller reaches its service through the real DI graph
   * (the per-package specs cover the behaviour in depth). One account, one pass over each route.
   */
  describe("route wiring (integrator smoke)", () => {
    it("me / wallets / in-app-wallet / kyc / kyc-mock answer their documented shapes", async () => {
      // An account is opened by Telegram (§6.1); its first linked wallet becomes the primary (§8.1).
      const primary = makeTestWallet("wire-primary");
      const { cookie, user } = await signInWithTelegram(ctx.agent, nextTelegramUser("Wire"));
      await linkWallet(ctx.agent, cookie, primary);
      const h = { Cookie: cookie, ...ctx.csrf };

      // ── me ──
      const me = bodyOf<ApiMe>(await ctx.agent.get("/api/v1/me").set("Cookie", cookie).expect(200));
      expect(me.user.id).toBe(user.id);
      expect(me.wallets).toHaveLength(1);
      expect(me.wallets[0]).toMatchObject({
        partyId: primary.partyId,
        isPrimary: true,
        ownLedgerWallet: null,
      });
      expect(me.kyc).toMatchObject({
        provider: "mock",
        status: "none",
        requiredForWithdrawal: false,
        attachedIdentityId: null,
      });
      expect(me.kyc).not.toHaveProperty("history");
      expect(me.capabilities).toEqual({
        canDeposit: true,
        canWithdraw: true,
        kycRequiredForWithdrawal: false,
        primaryPartyId: primary.partyId,
        isAdmin: false,
      });

      const patched = await ctx.agent
        .patch("/api/v1/me")
        .set(h)
        .send({ displayName: "  Wired  " })
        .expect(200);
      expect(bodyOf<{ user: ApiUser }>(patched).user.displayName).toBe("Wired");
      await ctx.agent.patch("/api/v1/me").set(h).send({ nope: 1 }).expect(400);
      // A body-less PATCH (x-requested-with satisfies CSRF) is a no-op, not a 500.
      await ctx.agent
        .patch("/api/v1/me")
        .set("Cookie", cookie)
        .set("Origin", TEST_ORIGIN)
        .set("x-requested-with", "truthoracle")
        .expect(200);

      const sessions = bodyOf<{ sessions: ApiSession[] }>(
        await ctx.agent.get("/api/v1/me/sessions").set("Cookie", cookie).expect(200),
      );
      expect(sessions.sessions).toHaveLength(1);
      expect(sessions.sessions[0]).toMatchObject({
        kind: "user",
        authMethod: "telegram",
        current: true,
      });
      await ctx.agent.delete(`/api/v1/me/sessions/${randomUUID()}`).set(h).expect(404);

      const audit = bodyOf<ApiPage<ApiAuditEvent>>(
        await ctx.agent.get("/api/v1/me/audit").set("Cookie", cookie).expect(200),
      );
      expect(audit).toMatchObject({ page: 1, limit: 25 });
      expect(audit.items.map((e) => e.action)).toEqual(
        expect.arrayContaining(["auth.login", "user.updated", "wallet.linked"]),
      );

      // ── wallets ──
      const secondary = makeTestWallet("wire-secondary");
      const linked = await linkWallet(ctx.agent, cookie, secondary, { label: "cold" });
      expect(linked.wallet).toMatchObject({
        partyId: secondary.partyId,
        isPrimary: false,
        label: "cold",
        status: "active",
      });
      expect(Object.keys(linked)).toEqual(["wallet"]);
      const wallets = bodyOf<{ wallets: ApiWallet[] }>(
        await ctx.agent.get("/api/v1/wallets").set("Cookie", cookie).expect(200),
      );
      expect(wallets.wallets.map((w) => [w.partyId, w.isPrimary])).toEqual([
        [primary.partyId, true],
        [secondary.partyId, false],
      ]);
      const [primaryRow, secondaryRow] = wallets.wallets;
      const refused = await ctx.agent.delete(`/api/v1/wallets/${primaryRow.id}`).set(h).expect(409);
      expect(bodyOf<ErrorBody>(refused).error).toBe("primary_wallet_in_use");
      await ctx.agent.delete(`/api/v1/wallets/${secondaryRow.id}`).set(h).expect(200);
      await ctx.agent.delete(`/api/v1/wallets/${secondaryRow.id}`).set(h).expect(404);
      await ctx.agent.delete("/api/v1/wallets/not-a-uuid").set(h).expect(400);
      // Wallets are not identities (§8.1): the unlink revoked the row and left the one Telegram identity alone.
      const afterUnlink = bodyOf<ApiMe>(
        await ctx.agent.get("/api/v1/me").set("Cookie", cookie).expect(200),
      );
      expect(afterUnlink.identities.map((i) => [i.provider, i.status])).toEqual([
        ["telegram", "active"],
      ]);
      expect(afterUnlink.wallets.find((w) => w.partyId === secondary.partyId)).toMatchObject({
        status: "revoked",
        isPrimary: false,
      });

      // ── in-app wallet ──
      const overview = bodyOf<InAppWalletOverview>(
        await ctx.agent.get("/api/v1/in-app-wallet").set("Cookie", cookie).expect(200),
      );
      expect(overview).toMatchObject({
        partyId: primary.partyId,
        ledger: null,
        pending: { submitted: 0 },
        payouts: [],
      });
      expect(overview.wallets).toHaveLength(2);
      const reconcile = bodyOf<ReconcileResult>(
        await ctx.agent
          .post("/api/v1/in-app-wallet/deposits/reconcile")
          .set(h)
          .send({})
          .expect(200),
      );
      expect(reconcile).toMatchObject({
        credited: "0.0000000000",
        status: "nothing_outstanding",
        perWallet: [],
        ledger: null,
      });

      // ── kyc (mock provider) ──
      const summary = bodyOf<ApiKycSummary & { history: unknown[] }>(
        await ctx.agent.get("/api/v1/kyc").set("Cookie", cookie).expect(200),
      );
      expect(summary).toMatchObject({ provider: "mock", status: "none", history: [] });
      const started = bodyOf<{ provider: string; verificationId: string; levelName: string }>(
        await ctx.agent.post("/api/v1/kyc/sessions").set(h).send({}).expect(200),
      );
      expect(started).toMatchObject({ provider: "mock", levelName: ctx.config.kycRequiredLevel });
      await ctx.agent
        .post("/api/v1/kyc/mock/submit")
        .set(h)
        .send({ verificationId: started.verificationId, outcome: "approved" })
        .expect(400);
      const submitted = bodyOf<{ verification: ApiKycVerification; userKycStatus: string }>(
        await ctx.agent
          .post("/api/v1/kyc/mock/submit")
          .set(h)
          .send({
            verificationId: started.verificationId,
            outcome: "approved",
            person: { firstName: "Ada", lastName: "Lovelace", dob: "1815-12-10", country: "GBR" },
            documents: [{ docType: "PASSPORT", country: "GBR", number: "X 123-456" }],
          })
          .expect(200),
      );
      expect(submitted).toMatchObject({
        userKycStatus: "approved",
        verification: { id: started.verificationId, status: "approved", provider: "mock" },
      });

      // §6.5 / §9.5: the approval is attached to the session's (Telegram) identity, which is now locked.
      const approved = bodyOf<ApiMe>(
        await ctx.agent.get("/api/v1/me").set("Cookie", cookie).expect(200),
      );
      const telegramIdentity = approved.identities.find((i) => i.provider === "telegram");
      expect(approved.user.kycStatus).toBe("approved");
      expect(approved.kyc).toMatchObject({
        status: "approved",
        attachedIdentityId: telegramIdentity?.id,
      });
      expect(telegramIdentity?.kycLocked).toBe(true);
      expect(approved.capabilities.canWithdraw).toBe(true);
      expect(ctx.nats.publishedOn("truthoracle.kyc.status_changed")).toHaveLength(1);
    });

    it("processors are wired: durable consumers registered, ticks run against the real services", async () => {
      expect(ctx.nats.consumers.map((c) => c.durable).sort()).toEqual([
        "kyc-webhook-apply",
        "payout-settlement-kyc-status",
      ]);
      await expect(ctx.get(DepositConfirmProcessor).tick()).resolves.toEqual({
        confirmed: 0,
        failed: 0,
      });
      await expect(ctx.get(SessionCleanupProcessor).tick()).resolves.toBeUndefined();
      await expect(ctx.get(KycWebhookProcessor).sweep()).resolves.toBe(0);
      // A malformed trigger is terminated; a well-formed one for an unknown row is acked (skipped).
      expect(await ctx.nats.dispatch("truthoracle.kyc.webhook.mock", { nope: true })).toEqual([
        "term",
      ]);
      expect(
        await ctx.nats.dispatch("truthoracle.kyc.webhook.mock", { eventId: randomUUID() }),
      ).toEqual(["ack"]);
    });

    it("graceful shutdown: readiness turns 503 (draining) before the server closes, and a request in flight during close() completes without a 500", async () => {
      // A second app instance: closing the shared one would end the suite.
      const own = await createTestApp();
      try {
        const primary = makeTestWallet("drain");
        const server = own.app.getHttpServer() as Server;
        const { cookie } = await signInWithTelegram(request(server), nextTelegramUser("Drain"));
        await linkWallet(request(server), cookie, primary);
        own.wallet.seedInbound(primary.partyId, "1");
        // Slow the history walk so the request is still running when close() starts.
        const original = own.wallet.transferHistory.bind(own.wallet);
        jest.spyOn(own.wallet, "transferHistory").mockImplementation(async (partyId: string) => {
          await new Promise((r) => setTimeout(r, 400));
          return original(partyId);
        });
        const inFlight = Promise.resolve(
          request(server)
            .post("/api/v1/in-app-wallet/deposits/reconcile")
            .set(own.csrf)
            .set("x-requested-with", "truthoracle")
            .set("Cookie", cookie)
            .send({}),
        );
        await new Promise((r) => setTimeout(r, 100));
        // Nest: destroy → beforeApplicationShutdown (draining flag) → HTTP close (waits for the socket) → Redis / NATS teardown.
        const closing = own.app.close();
        await new Promise((r) => setTimeout(r, 20));
        expect(await own.get(AppService).readiness()).toEqual({
          status: "degraded",
          checks: expect.any(Object) as unknown,
          draining: true,
        });
        const res = await inFlight;
        await closing;
        expect(res.status).toBe(200);
        expect(bodyOf<ReconcileResult>(res)).toMatchObject({
          credited: "1.0000000000",
          status: "confirmed",
        });
      } finally {
        jest.restoreAllMocks();
      }
    });

    it("the Swagger document builds from the live routes (decorators do not break boot)", () => {
      const doc = SwaggerModule.createDocument(
        ctx.app,
        new DocumentBuilder().setTitle("t").setVersion("0").build(),
      );
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          "/api/v1/me",
          "/api/v1/wallets/link",
          "/api/v1/in-app-wallet/deposits/reconcile",
          "/api/v1/in-app-wallet/payouts/{cid}/settle",
          "/api/v1/kyc/sessions",
          "/api/v1/kyc/mock/submit",
          "/api/v1/webhooks/kyc/sumsub",
          "/api/v1/admin/users",
        ]),
      );
    });
  });
});
