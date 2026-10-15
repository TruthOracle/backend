import type { Config } from "../config";
import { parseAmount } from "../util/money";
import type { KeycloakTokenService } from "./keycloak-token.service";
import { TokenAppService, tokenAppBatchBody, tokenAppCommandBody } from "./token-app.service";

const TREASURY = "treasury::1220" + "f".repeat(64);

describe("token-app request shaping (docs/TOKENS.md §4.4)", () => {
  it("sends snake_case keys and the amount in the instrument's own decimals", () => {
    expect(
      tokenAppCommandBody(
        {
          commandId: "mint-1",
          instrumentId: "cBYN",
          partyId: TREASURY,
          amount: parseAmount("12.3456789012"),
          decimals: 6,
        },
        "truthoracle",
      ),
    ).toEqual({
      command_id: "mint-1",
      instrument_id: "cBYN",
      party_id: TREASURY,
      amount: "12.345678",
      app_name: "truthoracle",
    });
    expect(
      tokenAppCommandBody(
        {
          commandId: "m",
          instrumentId: "Amulet",
          partyId: TREASURY,
          amount: parseAmount("1"),
          decimals: 10,
        },
        "truthoracle",
      ).amount,
    ).toBe("1.0000000000");
    expect(
      tokenAppBatchBody(
        {
          commandId: "batch-1",
          instrumentId: "TRO",
          decimals: 6,
          entries: [{ partyId: TREASURY, amount: parseAmount("1000") }],
        },
        "truthoracle",
      ),
    ).toEqual({
      command_id: "batch-1",
      instrument_id: "TRO",
      entries: [{ party_id: TREASURY, amount: "1000.000000" }],
      app_name: "truthoracle",
    });
  });

  it("answers 503 token_app_unconfigured for every call without TOKEN_APP_URL, and status() reports it without throwing", async () => {
    const config = {
      hasTokenApp: false,
      tokenApp: { url: "", appName: "truthoracle", keycloak: {} },
    } as unknown as Config;
    const keycloak = {
      isConfigured: () => true,
      bearerFor: jest.fn(),
    } as unknown as KeycloakTokenService;
    const svc = new TokenAppService(config, keycloak);
    expect(svc.isConfigured()).toBe(false);
    await expect(
      svc.mint({
        commandId: "m",
        instrumentId: "cBYN",
        partyId: TREASURY,
        amount: 1n,
        decimals: 6,
      }),
    ).rejects.toMatchObject({ status: 503, code: "token_app_unconfigured" });
    await expect(svc.holdings()).rejects.toMatchObject({ code: "token_app_unconfigured" });
    await expect(svc.status()).resolves.toEqual({
      configured: false,
      url: null,
      appName: "truthoracle",
      reachable: false,
      raw: null,
    });
  });
});
