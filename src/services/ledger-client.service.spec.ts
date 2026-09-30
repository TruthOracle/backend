import type { Config } from "../config";
import { ApiError } from "../util/errors";
import type { KeycloakTokenService } from "./keycloak-token.service";
import { type ActiveContract, LedgerClientService, parseDepositRefs, userWalletCreateCommand, walletCreateCommandIdFor } from "./ledger-client.service";
import type { RedisService } from "./redis.service";
import type { SentryService } from "./sentry.service";

const TREASURY = "treasury::1220" + "f".repeat(64);
const OWNER = "alice::1220" + "a".repeat(64);

function build(rows: ActiveContract[]): { service: LedgerClientService; sentry: { captureMessage: jest.Mock } } {
  const config = { treasuryPartyId: TREASURY, truthoraclePackageId: "pkg", truthoraclePackageName: "truthoracle-v16", ledgerApiUrl: "http://ledger", isMainnet: false, ledgerCacheMs: 0 } as unknown as Config;
  const sentry = { captureMessage: jest.fn(), captureException: jest.fn() };
  const service = new LedgerClientService(config, {} as KeycloakTokenService, {} as RedisService, sentry as unknown as SentryService);
  jest.spyOn(service, "activeContracts").mockResolvedValue(rows);
  return { service, sentry };
}

const walletRow = (contractId: string, owner: string, depositedCC = "1.0000000000", depositRefs: unknown = []): ActiveContract => ({
  contractId,
  payload: { owner, balanceCC: depositedCC, depositedCC, withdrawnCC: "0.0000000000", depositRefs },
});

describe("LedgerClientService.fetchUserWallet", () => {
  it("returns the owner's wallet (with its depositRefs), or null when none exists", async () => {
    const { service } = build([walletRow("uw-1", OWNER, "1.0000000000", ["reconcile:deposit-1"]), walletRow("uw-2", "other::1220" + "b".repeat(64))]);
    await expect(service.fetchUserWallet(OWNER)).resolves.toMatchObject({ contractId: "uw-1", owner: OWNER, depositedCC: 10_000_000_000n, depositRefs: ["reconcile:deposit-1"] });
    await expect(service.fetchUserWallet("nobody::1220" + "c".repeat(64))).resolves.toBeNull();
  });

  it("refuses to pick 'the first one' when an owner has two active UserWallets: 409 deposit_attribution_drift + Sentry", async () => {
    const { service, sentry } = build([walletRow("uw-1", OWNER), walletRow("uw-2", OWNER, "3.0000000000")]);
    await expect(service.fetchUserWallet(OWNER)).rejects.toMatchObject({ status: 409, code: "deposit_attribution_drift", details: { kind: "duplicate_user_wallet", contractIds: ["uw-1", "uw-2"] } });
    await service.fetchUserWallet(OWNER).catch((e: ApiError) => expect(e).toBeInstanceOf(ApiError));
    expect(sentry.captureMessage).toHaveBeenCalledWith("duplicate UserWallet contracts for one owner", "error", { owner: OWNER, count: "2" });
  });

  it("a UserWallet without depositRefs (wrong package deployed) is a 502 upstream_failed, never an empty list", async () => {
    const missing = build([{ contractId: "uw-1", payload: { owner: OWNER, balanceCC: "1.0000000000", depositedCC: "1.0000000000", withdrawnCC: "0.0000000000" } }]);
    await expect(missing.service.fetchUserWallet(OWNER)).rejects.toMatchObject({ status: 502, code: "upstream_failed", details: { contractId: "uw-1" } });
    await expect(missing.service.fetchAllUserWallets()).rejects.toMatchObject({ status: 502, code: "upstream_failed" });
    const optional = build([walletRow("uw-1", OWNER, "1.0000000000", null)]);
    await expect(optional.service.fetchUserWallet(OWNER)).rejects.toMatchObject({ status: 502, code: "upstream_failed" });
  });
});

describe("UserWallet Create command (shared by deposits and in-app payouts)", () => {
  it("is always the empty wallet with depositRefs: [] (mandatory on truthoracle-v16)", () => {
    const create = userWalletCreateCommand({ templateId: "pkg:Truthoracle:UserWallet", admin: TREASURY, owner: OWNER }) as { CreateCommand: { templateId: string; createArguments: Record<string, unknown> } };
    expect(create.CreateCommand.templateId).toBe("pkg:Truthoracle:UserWallet");
    expect(create.CreateCommand.createArguments).toEqual({ admin: TREASURY, owner: OWNER, balanceCC: "0.0000000000", depositedCC: "0.0000000000", withdrawnCC: "0.0000000000", depositRefs: [] });
  });
});

describe("UserWallet Create command id", () => {
  it("is one fixed id per owner and package name, in a pinned format", () => {
    expect(walletCreateCommandIdFor("truthoracle-v16", OWNER)).toBe("wallet-create-352c032020ce2161a7f406bf51fee745598ac722");
    expect(walletCreateCommandIdFor("truthoracle-v16", OWNER)).toBe(walletCreateCommandIdFor("truthoracle-v16", OWNER));
    expect(walletCreateCommandIdFor("truthoracle-v16", "other::1220" + "b".repeat(64))).not.toBe(walletCreateCommandIdFor("truthoracle-v16", OWNER));
  });

  it("changes with the package name, so a Create spent under an older package cannot block the current one", () => {
    expect(walletCreateCommandIdFor("truthoracle-v16", OWNER)).not.toBe(walletCreateCommandIdFor("truthoracle-v14", OWNER));
  });

  it("refuses to build an id without a package name or an owner", () => {
    expect(() => walletCreateCommandIdFor("", OWNER)).toThrow();
    expect(() => walletCreateCommandIdFor("truthoracle-v16", "")).toThrow();
  });

  it("the service applies the configured package name, and fails closed without one", () => {
    const { service } = build([]);
    expect(service.walletCreateCommandId(OWNER)).toBe(walletCreateCommandIdFor("truthoracle-v16", OWNER));
    const unnamed = new LedgerClientService({ truthoraclePackageName: "" } as unknown as Config, {} as KeycloakTokenService, {} as RedisService, {} as SentryService);
    expect(() => unnamed.walletCreateCommandId(OWNER)).toThrow(ApiError);
  });
});

describe("parseDepositRefs", () => {
  it("accepts a JSON list and nothing else — a missing or Optional-shaped field is a hard parse error", () => {
    expect(parseDepositRefs([])).toEqual([]);
    expect(parseDepositRefs(["a", "b"])).toEqual(["a", "b"]);
    expect(() => parseDepositRefs(undefined)).toThrow(/missing/);
    expect(() => parseDepositRefs(null)).toThrow(/not a list/);
    expect(() => parseDepositRefs("None")).toThrow(/not a list/);
    expect(() => parseDepositRefs({ Some: ["a"] })).toThrow(/not a list/);
    expect(() => parseDepositRefs(42)).toThrow(/not a list/);
  });
});
