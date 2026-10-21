import type { Config } from "../config";
import { cacheMarginSec, KeycloakTokenService, resolveKeycloak } from "./keycloak-token.service";
import type { RedisService } from "./redis.service";

const ZKPC = {
  ledgerApiUrl: "https://ledger.main",
  keycloakUrl: "https://kc.zkpc",
  keycloakRealm: "zkpc",
  clientId: "zkpc-client",
  clientSecret: "zkpc-secret",
};

function configOf(patch: Partial<Config>): Config {
  return {
    isMainnet: false,
    keycloak: {
      url: "https://kc.base",
      realm: "master",
      clientId: "base",
      clientSecret: "base-secret",
    },
    ledgerKeycloak: {},
    walletKeycloak: {},
    registryKeycloak: {},
    zkpc: {
      ledgerApiUrl: "",
      keycloakUrl: "",
      keycloakRealm: "master",
      clientId: "",
      clientSecret: "",
    },
    tokenApp: { url: "", appName: "truthoracle", keycloak: {} },
    ...patch,
  } as unknown as Config;
}

/** A Redis double that keeps JSON values in a map, like the `kc:*` cache. */
function fakeRedis(): {
  redis: RedisService;
  store: Map<string, unknown>;
  setJson: jest.Mock;
  del: jest.Mock;
} {
  const store = new Map<string, unknown>();
  const setJson = jest.fn((key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  });
  const del = jest.fn((...keys: string[]) => {
    for (const k of keys) store.delete(k);
    return Promise.resolve();
  });
  const redis = {
    getJson: (key: string) => Promise.resolve(store.get(key) ?? null),
    setJson,
    del,
  } as unknown as RedisService;
  return { redis, store, setJson, del };
}

function service(patch: Partial<Config>, redis = fakeRedis().redis): KeycloakTokenService {
  return new KeycloakTokenService(configOf(patch), redis);
}

describe("KeycloakTokenService targets (docs/RAMP.md §7, docs/TOKENS.md §4.4)", () => {
  it("devnet: registry and tokenApp fall back to KEYCLOAK_* field by field, and say where each field came from", () => {
    const patch = {
      registryKeycloak: { clientId: "registry-client" },
      tokenApp: {
        url: "https://token-app.test",
        appName: "truthoracle",
        keycloak: { url: "https://kc.token-app" },
      },
    } as Partial<Config>;
    const svc = service(patch);
    expect(svc.credentialsFor("registry")).toEqual({
      url: "https://kc.base",
      realm: "master",
      clientId: "registry-client",
      clientSecret: "base-secret",
    });
    expect(svc.credentialsFor("tokenApp")).toEqual({
      url: "https://kc.token-app",
      realm: "master",
      clientId: "base",
      clientSecret: "base-secret",
    });
    expect(resolveKeycloak(configOf(patch), "tokenApp").sources).toEqual({
      url: "TOKEN_APP_KEYCLOAK_URL",
      realm: "KEYCLOAK_REALM",
      clientId: "KEYCLOAK_CLIENT_ID",
      clientSecret: "KEYCLOAK_CLIENT_SECRET",
    });
    expect(svc.isConfigured("registry")).toBe(true);
    expect(svc.isConfigured("tokenApp")).toBe(true);
  });

  it("is unconfigured when neither the override nor KEYCLOAK_* completes the credentials", () => {
    const svc = service({
      keycloak: { url: "", realm: "master", clientId: "", clientSecret: "" },
      registryKeycloak: { url: "https://kc.registry", clientId: "r" },
    });
    expect(svc.credentialsFor("registry")).toBeNull();
    expect(svc.isConfigured("tokenApp")).toBe(false);
    expect(svc.isConfigured("ledger")).toBe(false);
  });

  it("mainnet: the ledger reads ZKPC_* only", () => {
    const svc = service({ isMainnet: true, zkpc: ZKPC });
    expect(svc.credentialsFor("ledger")).toEqual({
      url: "https://kc.zkpc",
      realm: "zkpc",
      clientId: "zkpc-client",
      clientSecret: "zkpc-secret",
    });
    // The wallet keeps its own Keycloak (override, then KEYCLOAK_*) on every network.
    expect(svc.credentialsFor("wallet")?.url).toBe("https://kc.base");
  });

  it("mainnet: token-app and the registry never read KEYCLOAK_* — an incomplete dedicated client is unconfigured", () => {
    // Only the URL is dedicated: devnet would have filled client id + secret from KEYCLOAK_* (T-D2).
    const partial = service({
      isMainnet: true,
      zkpc: ZKPC,
      tokenApp: {
        url: "https://token-app.main.zkpc.cantor8.tech",
        appName: "truthoracle",
        keycloak: { url: "https://auth.main.zkpc.cantor8.tech" },
      },
      registryKeycloak: { clientId: "reg", clientSecret: "reg-secret" },
    });
    expect(partial.credentialsFor("tokenApp")).toBeNull();
    expect(partial.isConfigured("tokenApp")).toBe(false);
    expect(partial.credentialsFor("registry")).toBeNull();

    const dedicated = configOf({
      isMainnet: true,
      zkpc: ZKPC,
      tokenApp: {
        url: "https://token-app.main.zkpc.cantor8.tech",
        appName: "truthoracle",
        keycloak: {
          url: "https://auth.main.zkpc.cantor8.tech",
          clientId: "truthoracle-token-app",
          clientSecret: "dedicated-secret",
        },
      },
    });
    expect(resolveKeycloak(dedicated, "tokenApp")).toEqual({
      creds: {
        url: "https://auth.main.zkpc.cantor8.tech",
        realm: "master",
        clientId: "truthoracle-token-app",
        clientSecret: "dedicated-secret",
      },
      sources: {
        url: "TOKEN_APP_KEYCLOAK_URL",
        realm: "default",
        clientId: "TOKEN_APP_KEYCLOAK_CLIENT_ID",
        clientSecret: "TOKEN_APP_KEYCLOAK_CLIENT_SECRET",
      },
    });
  });
});

describe("KeycloakTokenService cache (T-D7) and invalidate (T-D3)", () => {
  const realFetch = global.fetch;
  let grants: number;
  let lifetimeSec: number;

  beforeEach(() => {
    grants = 0;
    lifetimeSec = 60;
    global.fetch = jest.fn(() => {
      grants += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `tok-${grants}`, expires_in: lifetimeSec }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it("margin is min(60 s, expires_in / 2)", () => {
    expect(cacheMarginSec(900)).toBe(60);
    expect(cacheMarginSec(120)).toBe(60);
    expect(cacheMarginSec(60)).toBe(30);
    expect(cacheMarginSec(10)).toBe(5);
  });

  it("a 60 s token is served from cache for 30 s, then refreshed", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-19T10:00:00Z"), doNotFake: ["nextTick"] });
    const fake = fakeRedis();
    const svc = service({}, fake.redis);
    await expect(svc.bearerFor("tokenApp")).resolves.toBe("tok-1");
    jest.setSystemTime(new Date("2026-10-19T10:00:29Z"));
    await expect(svc.bearerFor("tokenApp")).resolves.toBe("tok-1");
    expect(grants).toBe(1);
    jest.setSystemTime(new Date("2026-10-19T10:00:31Z"));
    await expect(svc.bearerFor("tokenApp")).resolves.toBe("tok-2");
    expect(grants).toBe(2);
    // Redis keeps the entry only until its refresh point.
    expect(fake.setJson).toHaveBeenLastCalledWith(
      "kc:https://kc.base|master|base",
      expect.objectContaining({ token: "tok-2" }),
      30_000,
    );
  });

  it("invalidate drops the bearer from memory and Redis, so the next call mints a fresh one", async () => {
    lifetimeSec = 900;
    const fake = fakeRedis();
    const svc = service({}, fake.redis);
    await expect(svc.bearerFor("tokenApp")).resolves.toBe("tok-1");
    await expect(svc.bearerFor("tokenApp")).resolves.toBe("tok-1");
    expect(fake.store.has("kc:https://kc.base|master|base")).toBe(true);
    await svc.invalidate("tokenApp");
    expect(fake.del).toHaveBeenCalledWith("kc:https://kc.base|master|base");
    expect(fake.store.has("kc:https://kc.base|master|base")).toBe(false);
    await expect(svc.bearerFor("tokenApp")).resolves.toBe("tok-2");
    expect(grants).toBe(2);
    // An unconfigured target has nothing to invalidate.
    await expect(
      service({ keycloak: { url: "", realm: "", clientId: "", clientSecret: "" } }).invalidate(
        "tokenApp",
      ),
    ).resolves.toBeUndefined();
  });
});
