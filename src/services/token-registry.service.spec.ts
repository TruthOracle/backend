import type { InstrumentEntity } from "../entities/instrument.entity";
import type { KeycloakTokenService } from "./keycloak-token.service";
import { parseChoiceContext, TokenRegistryService } from "./token-registry.service";

const instrument = (patch: Partial<InstrumentEntity> = {}): InstrumentEntity =>
  ({
    admin: "agent::1220" + "c".repeat(64),
    id: "cBYN",
    symbol: "cBYN",
    registryUrl: "https://registry.test/api/c8",
    registryAuth: "keycloak",
    ...patch,
  }) as InstrumentEntity;

describe("parseChoiceContext", () => {
  it("keeps choiceContextData verbatim and reduces disclosed contracts to the four ledger fields", () => {
    const ctx = parseChoiceContext(
      {
        choiceContextData: { values: { tokenConfigCid: { tag: "AV_ContractId", value: "00cfg" } } },
        disclosedContracts: [
          {
            templateId: "pkg:Cantor8.Token.TokenConfig:TokenConfig",
            contractId: "00cfg",
            createdEventBlob: "blob",
            synchronizerId: "sync::1",
            debugPackageName: "token-common-v5",
            debugPayload: { admin: "x" },
          },
        ],
      },
      "cBYN",
    );
    expect(ctx).toEqual({
      choiceContextData: { values: { tokenConfigCid: { tag: "AV_ContractId", value: "00cfg" } } },
      disclosedContracts: [
        {
          templateId: "pkg:Cantor8.Token.TokenConfig:TokenConfig",
          contractId: "00cfg",
          createdEventBlob: "blob",
          synchronizerId: "sync::1",
        },
      ],
    });
  });

  it("refuses a context without data or with an incomplete disclosed contract (502 upstream_failed)", () => {
    expect(() => parseChoiceContext({}, "cBYN")).toThrow(/without choiceContextData/);
    expect(() =>
      parseChoiceContext(
        { choiceContextData: {}, disclosedContracts: [{ templateId: "t", contractId: "c" }] },
        "cBYN",
      ),
    ).toThrow(/incomplete disclosed contract/);
  });
});

describe("TokenRegistryService configuration", () => {
  const keycloak = (configured: string[]): KeycloakTokenService =>
    ({
      isConfigured: (target: string) => configured.includes(target),
      bearerFor: jest.fn(),
    }) as unknown as KeycloakTokenService;

  it("is configured when the instrument has a registry URL and the auth mode's credentials exist", () => {
    const svc = new TokenRegistryService(keycloak(["ledger"]));
    expect(svc.isConfigured(instrument({ registryAuth: "ledger" }))).toBe(true);
    expect(svc.isConfigured(instrument({ registryAuth: "keycloak" }))).toBe(false);
    expect(svc.isConfigured(instrument({ registryAuth: "none" }))).toBe(true);
    expect(svc.isConfigured(instrument({ registryUrl: null }))).toBe(false);
  });

  it("answers 503 not_ready for an instrument without a registry URL before any network call", async () => {
    const svc = new TokenRegistryService(keycloak(["ledger", "registry"]));
    await expect(svc.info(instrument({ registryUrl: null }))).rejects.toMatchObject({
      status: 503,
      code: "not_ready",
    });
  });
});
