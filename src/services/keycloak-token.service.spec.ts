import type { Config } from "../config";
import { KeycloakTokenService } from "./keycloak-token.service";
import type { RedisService } from "./redis.service";

function service(patch: Partial<Config>): KeycloakTokenService {
  const config = {
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
  return new KeycloakTokenService(config, {} as RedisService);
}

describe("KeycloakTokenService targets (docs/TOKENS.md §4.4)", () => {
  it("registry and tokenApp fall back to KEYCLOAK_* field by field", () => {
    const svc = service({
      registryKeycloak: { clientId: "registry-client" },
      tokenApp: {
        url: "https://token-app.test",
        appName: "truthoracle",
        keycloak: { url: "https://kc.token-app" },
      },
    });
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

  it("on mainnet the ledger reads ZKPC_* only while the other targets keep their own resolution", () => {
    const svc = service({
      isMainnet: true,
      zkpc: {
        ledgerApiUrl: "https://ledger.main",
        keycloakUrl: "https://kc.zkpc",
        keycloakRealm: "zkpc",
        clientId: "zkpc-client",
        clientSecret: "zkpc-secret",
      },
    });
    expect(svc.credentialsFor("ledger")).toEqual({
      url: "https://kc.zkpc",
      realm: "zkpc",
      clientId: "zkpc-client",
      clientSecret: "zkpc-secret",
    });
    expect(svc.credentialsFor("registry")?.url).toBe("https://kc.base");
  });
});
