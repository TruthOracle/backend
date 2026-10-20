import type { Config } from "../config";
import { UpstreamError } from "../util/upstream-http";
import { commandOutcome, EnterpriseWalletService } from "./enterprise-wallet.service";
import type { KeycloakTokenService } from "./keycloak-token.service";

const TREASURY = "treasury::1220" + "a".repeat(64);

describe("EnterpriseWalletService", () => {
  describe("status reads: two indexes, two failure semantics", () => {
    function service(answer: () => Promise<unknown>): EnterpriseWalletService {
      const config = {
        enterpriseWalletUrl: "http://wallet",
        treasuryPartyId: TREASURY,
        enterpriseWalletAppName: "truthoracle",
      } as unknown as Config;
      const keycloak = {
        bearerFor: jest.fn().mockResolvedValue("token"),
      } as unknown as KeycloakTokenService;
      const svc = new EnterpriseWalletService(config, keycloak);
      jest
        .spyOn(svc as unknown as { wallet: () => Promise<unknown> }, "wallet")
        .mockImplementation(answer);
      return svc;
    }

    it("transferStatus: a 404 on the transfer index means the transfer never happened (known, not submitted)", async () => {
      await expect(
        service(() => Promise.reject(new UpstreamError("404", 404, ""))).transferStatus(
          TREASURY,
          "payout-1",
        ),
      ).resolves.toEqual({ known: true, submitted: false, status: "not_found" });
      await expect(
        service(() => Promise.resolve({ status: "Completed" })).transferStatus(
          TREASURY,
          "payout-1",
        ),
      ).resolves.toEqual({ known: true, submitted: true, status: "completed" });
      await expect(
        service(() => Promise.resolve({ status: "failed" })).transferStatus(TREASURY, "payout-1"),
      ).resolves.toEqual({ known: true, submitted: false, status: "failed" });
      await expect(
        service(() => Promise.reject(new UpstreamError("503", 503, ""))).transferStatus(
          TREASURY,
          "payout-1",
        ),
      ).resolves.toEqual({ known: false, submitted: false, status: null });
    });

    it("commandStatus: a 404 on the command index is UNKNOWN (the index is not always wired through), only an explicit failure is a failure", async () => {
      await expect(
        service(() => Promise.reject(new UpstreamError("404", 404, ""))).commandStatus(
          TREASURY,
          "deposit-1",
        ),
      ).resolves.toEqual({ known: false, submitted: false, status: "not_found" });
      await expect(
        service(() => Promise.resolve({ status: "completed", updateId: "u" })).commandStatus(
          TREASURY,
          "deposit-1",
        ),
      ).resolves.toEqual({ known: true, submitted: true, status: "completed" });
      await expect(
        service(() => Promise.resolve({ status: "pending" })).commandStatus(TREASURY, "deposit-1"),
      ).resolves.toEqual({ known: true, submitted: true, status: "pending" });
      await expect(
        service(() => Promise.resolve({ status: "REJECTED" })).commandStatus(TREASURY, "deposit-1"),
      ).resolves.toEqual({ known: true, submitted: false, status: "rejected" });
      await expect(
        service(() => Promise.resolve({})).commandStatus(TREASURY, "deposit-1"),
      ).resolves.toEqual({ known: false, submitted: false, status: null });
      await expect(
        service(() => Promise.reject(new UpstreamError("boom", 0, ""))).commandStatus(
          TREASURY,
          "deposit-1",
        ),
      ).resolves.toEqual({ known: false, submitted: false, status: null });
    });

    it("W9g F0: commandStatus carries a failed command's reason and honours a caller's timeout; commandOutcome reads succeeded / failed / pending / unknown", async () => {
      const svc = service(() =>
        Promise.resolve({ status: "FAILED", reason: "CONTRACT_NOT_ACTIVE" }),
      );
      await expect(
        svc.commandStatus(TREASURY, "market-resolve-1-a", { timeoutMs: 2_000 }),
      ).resolves.toEqual({
        known: true,
        submitted: false,
        status: "failed",
        reason: "CONTRACT_NOT_ACTIVE",
      });
      expect((svc as unknown as { wallet: jest.Mock }).wallet).toHaveBeenCalledWith(
        `/api/v1/command/${encodeURIComponent(TREASURY)}/market-resolve-1-a`,
        { timeoutMs: 2_000 },
      );
      expect(commandOutcome({ known: true, submitted: true, status: "completed" })).toBe(
        "succeeded",
      );
      expect(commandOutcome({ known: true, submitted: true, status: "pending" })).toBe("pending");
      expect(commandOutcome({ known: true, submitted: false, status: "timeout" })).toBe("failed");
      expect(commandOutcome({ known: false, submitted: false, status: "not_found" })).toBe(
        "unknown",
      );
    });
  });
});
