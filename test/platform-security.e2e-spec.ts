/**
 * Platform security end to end (SPEC §8; stage S3): the webhook receive order — configured provider
 * → source allow-list (IP-authenticated providers only, edge header honoured only from a trusted
 * edge or the relay) → signature → inbox — with the limiter counting rejected deliveries only;
 * form-encoded capture on /webhooks/ramp/* only; CORS for Idempotency-Key; the route-scoped 8 MB
 * body limit; sealing v2 rotation through the card re-sealer, the boot refusal and the re-seal job.
 * Real Postgres + Redis; the acquirer is the mock.
 */
import { randomUUID } from "node:crypto";

import { Config } from "../src/config";
import { RampEventEntity } from "../src/entities/ramp-event.entity";
import { RampPaymentMethodEntity } from "../src/entities/ramp-payment-method.entity";
import { RampProcessor } from "../src/processors/ramp.processor";
import { RampCardResealer, rampCardAad } from "../src/services/ramp-card-sealing.service";
import { MOCK_SIGNATURE_HEADER, mockSignature } from "../src/services/ramp-provider-mock.service";
import { SealedDataService } from "../src/services/sealed-data.service";
import type { ErrorBody } from "../src/util/errors";
import { type Keyring, seal, sealedKid, unseal } from "../src/util/sealed";
import { useTestApp } from "./helpers/app";
import { bodyOf, issueSessionDirect } from "./helpers/session";
import { makeTestWallet } from "./helpers/wallet";

const SECRET = "e2e-platform-mock-secret";
const RAMP_ENV = {
  RAMP_ENABLED: "true",
  RAMP_PUBLIC_APP_URL: "http://app.test",
  RAMP_SCAN_MS: "0",
  RAMP_MOCK_WEBHOOK_SECRET: SECRET,
};
const FORM = "application/x-www-form-urlencoded";

/** The mock acquirer's signature header over `body` (or a wrong one). */
function signature(body: string, secret = SECRET): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  return { [MOCK_SIGNATURE_HEADER]: `t=${t},v1=${mockSignature(secret, t, Buffer.from(body))}` };
}

function jsonEvent(id: string): string {
  return JSON.stringify({ id, type: "payment.succeeded", data: { object_id: `mockpay_${id}` } });
}

const errorOf = (res: { body: unknown }): ErrorBody => bodyOf<ErrorBody>(res as never);

describe("webhooks: verified deliveries always land, rejections are limited (SPEC §8, X13)", () => {
  const ctx = useTestApp({
    env: {
      ...RAMP_ENV,
      // The edge (loopback here) appends the client address; mock is NOT IP-authenticated, so
      // its CIDRs below are never consulted.
      RAMP_WEBHOOK_IP_HEADER: "x-forwarded-for",
      RAMP_TRUSTED_EDGE_CIDRS: "127.0.0.0/8,::1/128",
      RAMP_WEBHOOK_SOURCE_CIDRS: "mock:192.0.2.0/24",
      CORS_ORIGINS: "https://native.test",
    },
  });
  const events = () => ctx.dataSource.getRepository(RampEventEntity);
  const post = (body: string, ip: string, headers: Record<string, string>, provider = "mock") =>
    ctx.agent
      .post(`/api/v1/webhooks/ramp/${provider}`)
      .set({ "Content-Type": "application/json", "x-forwarded-for": ip, ...headers })
      .send(body);

  it("rejections count per (provider, source) and turn 429 past 60/min; a delivery that verifies is still accepted from that source", async () => {
    const body = jsonEvent("evt_limit_1");
    const forged = signature(body, "wrong-secret");
    for (let i = 0; i < 60; i += 1) {
      const res = await post(body, "203.0.113.10", forged).expect(401);
      expect(errorOf(res).error).toBe("webhook_rejected");
    }
    const limited = await post(body, "203.0.113.10", forged).expect(429);
    expect(errorOf(limited)).toMatchObject({ error: "rate_limited" });
    expect(limited.headers["retry-after"]).toBeDefined();

    // The real acquirer behind the same exhausted address: verified → stored, never limited.
    await post(body, "203.0.113.10", signature(body)).expect(200);
    const second = jsonEvent("evt_limit_2");
    await post(second, "203.0.113.10", signature(second)).expect(200);
    expect(await events().countBy({ provider: "mock" })).toBe(2);
    // Other sources and other providers have their own buckets.
    await post(body, "203.0.113.11", forged).expect(401);
    await ctx.agent
      .post("/api/v1/webhooks/kyc/sumsub")
      .set({ "Content-Type": "application/json", "x-forwarded-for": "203.0.113.10" })
      .send({ a: 1 })
      .expect(401);
  });

  it("an unconfigured provider is a 404 and counts nothing; a source outside the CIDRs is fine for a non-IP-authenticated provider", async () => {
    const body = jsonEvent("evt_open_1");
    for (let i = 0; i < 70; i += 1) await post(body, "203.0.113.12", {}, "acme").expect(404);
    await post(body, "203.0.113.12", signature(body, "nope")).expect(401);
    await post(body, "198.51.100.7", signature(body)).expect(200);
    expect(await events().findOneByOrFail({ eventKey: "mock:evt_open_1" })).toMatchObject({
      type: "payment.succeeded",
      objectId: "mockpay_evt_open_1",
    });
  });

  it("captures form-encoded deliveries raw on /webhooks/ramp/* only", async () => {
    const form = "id=evt_form_1&type=payment.succeeded&object_id=mockpay_f1&order_id=x&card=4111";
    await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set({ "Content-Type": FORM, ...signature(form) })
      .send(form)
      .expect(200);
    const stored = await events().findOneByOrFail({ eventKey: "mock:evt_form_1" });
    expect(stored).toMatchObject({ kind: "payment", objectId: "mockpay_f1" });
    // Only the allow-listed keys of the parsed fields reach the inbox payload.
    expect(stored.payload).toEqual({ id: "evt_form_1", type: "payment.succeeded" });
    // A field changed after signing fails over the raw bytes.
    await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set({ "Content-Type": FORM, ...signature(form) })
      .send(form.replace("mockpay_f1", "mockpay_f2"))
      .expect(401);
    // No form parser anywhere else: the KYC webhook sees no body at all.
    const kyc = await ctx.agent
      .post("/api/v1/webhooks/kyc/sumsub")
      .set({ "Content-Type": FORM })
      .send("a=1")
      .expect(401);
    expect(errorOf(kyc).message).toMatch(/missing or not JSON/);
  });

  it("CORS: a native client's preflight may send Idempotency-Key (E-D10)", async () => {
    const res = await ctx.agent
      .options("/api/v1/ramp/onramp")
      .set({
        Origin: "https://native.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key",
      })
      .expect(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://native.test");
    expect(String(res.headers["access-control-allow-headers"])).toMatch(/Idempotency-Key/);
  });

  it("CORS: a cross-origin console reads an export's file name, export id and file hash (S8)", async () => {
    const res = await ctx.agent.get("/health").set({ Origin: "https://native.test" }).expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://native.test");
    const exposed = String(res.headers["access-control-expose-headers"]).split(",");
    expect(exposed).toEqual(
      expect.arrayContaining(["Content-Disposition", "X-Export-Id", "X-Content-SHA256"]),
    );
  });

  it("the 8 MB body limit covers the upload routes only, and only for a verified admin session (X16, C40)", async () => {
    const big = JSON.stringify({ file: "x".repeat(2_000_000) });
    const upload = (path: string, body: string, headers: Record<string, string>) =>
      ctx.agent
        .post(path)
        .set({ "Content-Type": "application/json", ...headers })
        .send(body);
    const tooLarge = async (path: string, headers: Record<string, string>) => {
      const res = await upload(path, big, headers).expect(413);
      expect(errorOf(res).error).toBe("payload_too_large");
    };
    const user = await issueSessionDirect(ctx, makeTestWallet("bigbody-user"));
    const routes = [
      "/api/v1/admin/ramp/bank-statements",
      "/api/v1/admin/compliance/screening-lists",
    ];
    for (const path of routes) {
      // A credential that is merely present gets the 1 MB parser: 413 before any guard runs.
      await tooLarge(path, {});
      await tooLarge(path, { Authorization: "Bearer nope" });
      await tooLarge(path, { Authorization: "Basic x" });
      await tooLarge(path, { Cookie: "to_session=1" });
      await tooLarge(path, { Cookie: `to_session=${"f".repeat(64)}` });
      await tooLarge(path, { Cookie: user.cookie, ...ctx.csrf });
      await tooLarge(path, { Authorization: user.bearer });
      // A verified admin session is parsed, then refused by AdminGuard (this party is no operator).
      const admin = await issueSessionDirect(ctx, makeTestWallet("bigbody-admin"), {
        kind: "admin",
      });
      const parsed = await upload(path, big, { Cookie: admin.cookie, ...ctx.csrf }).expect(403);
      expect(errorOf(parsed).message).toMatch(/no longer an operator/);
    }
    // Every other route keeps 1 MB, even for an admin session; 9 MB is over the 8 MB limit.
    const admin = await issueSessionDirect(ctx, makeTestWallet("bigbody-admin"), { kind: "admin" });
    await tooLarge("/api/v1/admin/ramp/orders", { Authorization: admin.bearer });
    const huge = JSON.stringify({ file: "x".repeat(9 * 1024 * 1024) });
    await upload(routes[0], huge, { Authorization: admin.bearer }).expect(413);
  });
});

describe("webhooks: source allow-list for IP-authenticated providers (SPEC §8)", () => {
  const ctx = useTestApp({
    env: {
      ...RAMP_ENV,
      RAMP_IP_AUTH_PROVIDERS: "mock",
      RAMP_WEBHOOK_SOURCE_CIDRS: "mock:203.0.113.0/24",
      RAMP_WEBHOOK_IP_HEADER: "x-forwarded-for",
      RAMP_TRUSTED_EDGE_CIDRS: "127.0.0.0/8,::1/128",
    },
  });
  const deliver = (id: string, xff: string, secret = SECRET) => {
    const body = jsonEvent(id);
    return ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set({
        "Content-Type": "application/json",
        "x-forwarded-for": xff,
        ...signature(body, secret),
      })
      .send(body);
  };

  it("checks the source before the signature, with the right-most (edge-appended) address", async () => {
    const outside = await deliver("evt_ip_1", "198.51.100.7").expect(401);
    expect(errorOf(outside).message).toBe("webhook source is not allowed");
    // A caller cannot prepend an allowed address: only the value the edge appended counts.
    await deliver("evt_ip_2", "203.0.113.9, 198.51.100.7").expect(401);
    await deliver("evt_ip_3", "198.51.100.7, 203.0.113.9").expect(200);
    // Allowed source, bad signature: still refused (the allow-list is not the authentication alone).
    const forged = await deliver("evt_ip_4", "203.0.113.9", "wrong").expect(401);
    expect(errorOf(forged).message).toBe("webhook signature rejected");
    const keys = (await ctx.dataSource.getRepository(RampEventEntity).find()).map(
      (e) => e.eventKey,
    );
    expect(keys).toEqual(["mock:evt_ip_3"]);
  });
});

describe("webhooks: the edge header is honoured only from a trusted edge or the relay (SPEC §8)", () => {
  const PROXY_SECRET = "e2e-proxy-secret-that-is-at-least-32-chars-long";
  const ctx = useTestApp({
    env: {
      ...RAMP_ENV,
      BACKEND_PROXY_SECRET: PROXY_SECRET,
      RAMP_IP_AUTH_PROVIDERS: "mock",
      RAMP_WEBHOOK_SOURCE_CIDRS: "mock:203.0.113.0/24",
      RAMP_WEBHOOK_IP_HEADER: "x-forwarded-for",
      // Loopback (the test client) is NOT a trusted edge here.
      RAMP_TRUSTED_EDGE_CIDRS: "10.0.0.0/8",
    },
  });

  it("ignores a spoofed header from an untrusted peer; the relay (proxy secret) may set it", async () => {
    const body = jsonEvent("evt_edge_1");
    const headers = { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" };
    const spoofed = await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set({ ...headers, ...signature(body) })
      .send(body)
      .expect(401);
    expect(errorOf(spoofed).message).toBe("webhook source is not allowed");
    await ctx.agent
      .post("/api/v1/webhooks/ramp/mock")
      .set({ ...headers, "x-truthoracle-proxy": PROXY_SECRET, ...signature(body) })
      .send(body)
      .expect(200);
  });
});

describe("sealing v2: rotation, the boot refusal and the re-seal job (SPEC §8, X17)", () => {
  const OLD = Buffer.alloc(32, 0x0a);
  const NEW = Buffer.alloc(32, 0x0b);
  const oldRing: Keyring = { activeKid: "old", keys: new Map([["old", OLD]]) };
  // Rows other files sealed under the default kid would (rightly) refuse the boot below, and this
  // file's rows would refuse theirs: `useTestApp` purges the database before the boot and after.
  const ctx = useTestApp({
    env: {
      ...RAMP_ENV,
      DATA_KEYS: `old:${OLD.toString("base64")},new:${NEW.toString("base64")}`,
      DATA_KEY_ID: "new",
    },
  });

  async function insertCard(userId: string, tokenAadUser = userId): Promise<string> {
    const id = randomUUID();
    await ctx.dataSource.getRepository(RampPaymentMethodEntity).insert({
      id,
      userId,
      provider: "mock",
      fingerprint: `fp-${id}`,
      tokenSealed: seal(`mocktok_${id}`, oldRing, rampCardAad("mock", tokenAadUser, id)),
      status: "active",
    });
    return id;
  }

  /** The same app config with a keyring that no longer holds `old`. */
  function withoutOld(): SealedDataService {
    const config = Object.assign(new Config(), ctx.config, {
      sealing: {
        ...ctx.config.sealing,
        data: { activeKid: "new", keys: new Map([["new", NEW]]) },
      },
    });
    const narrowed = new SealedDataService(config);
    narrowed.registerResealer(ctx.get(RampCardResealer));
    return narrowed;
  }

  it("boot refuses to drop a kid in use; the job re-seals onto the active kid; then the old kid can go", async () => {
    const processor = ctx.get(RampProcessor);
    // A pass with nothing to do leaves the job idle (whatever ran before in this file).
    expect(await processor.resealTick(true)).toEqual({ resealed: 0, reindexed: 0, failed: 0 });
    expect(await processor.resealTick()).toBeNull();
    const { user } = await issueSessionDirect(ctx, makeTestWallet("sealer"));
    const id = await insertCard(user.id);
    const resealer = ctx.get(RampCardResealer);
    expect(await resealer.countByKid()).toEqual({ old: 1 });
    await expect(withoutOld().assertKeyringsCoverStoredData()).rejects.toThrow(
      /DATA_KEYS: ramp-cards has 1 row\(s\) under kid old/,
    );

    // A forced pass that re-seals ends the idle: the scheduled passes run again until nothing is left.
    expect(await processor.resealTick(true)).toEqual({ resealed: 1, reindexed: 0, failed: 0 });
    const row = await ctx.dataSource.getRepository(RampPaymentMethodEntity).findOneByOrFail({ id });
    expect(sealedKid(row.tokenSealed)).toBe("new");
    expect(unseal(row.tokenSealed, ctx.config.sealing.data, rampCardAad("mock", user.id, id))).toBe(
      `mocktok_${id}`,
    );
    expect(await resealer.countByKid()).toEqual({ new: 1 });
    await expect(withoutOld().assertKeyringsCoverStoredData()).resolves.toBeUndefined();
    // Nothing left: a scheduled pass changes nothing, after which the job idles until forced.
    expect(await processor.resealTick()).toEqual({ resealed: 0, reindexed: 0, failed: 0 });
    expect(await processor.resealTick()).toBeNull();
  });

  it("a row repointed at another account no longer opens: it is not re-sealed and still blocks dropping its kid", async () => {
    const { user: owner } = await issueSessionDirect(ctx, makeTestWallet("owner"));
    const { user: other } = await issueSessionDirect(ctx, makeTestWallet("other"));
    // Sealed for `owner`, but the row says `other` (a DB writer moved it).
    const id = await insertCard(other.id, owner.id);
    expect(await ctx.get(RampProcessor).resealTick(true)).toEqual({
      resealed: 0,
      reindexed: 0,
      failed: 1,
    });
    const row = await ctx.dataSource.getRepository(RampPaymentMethodEntity).findOneByOrFail({ id });
    expect(sealedKid(row.tokenSealed)).toBe("old");
    expect(() =>
      unseal(row.tokenSealed, ctx.config.sealing.data, rampCardAad("mock", other.id, id)),
    ).toThrow();
    await expect(withoutOld().assertKeyringsCoverStoredData()).rejects.toThrow(/under kid old/);
  });
});
