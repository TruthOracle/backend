import type { Config } from "../config";
import { parseCC } from "../util/money";
import { UpstreamError } from "../util/upstream-http";
import {
  collectHistory,
  EnterpriseWalletService,
  totalReceivedFrom,
} from "./enterprise-wallet.service";
import type { KeycloakTokenService } from "./keycloak-token.service";
import type { RedisService } from "./redis.service";

const TREASURY = "treasury::1220" + "a".repeat(64);
const USER = "user::1220" + "b".repeat(64);
const OTHER = "other::1220" + "c".repeat(64);

describe("EnterpriseWalletService pure helpers", () => {
  describe("collectHistory", () => {
    it("walks newest-first pages using the oldest timestamp as an exclusive cursor", async () => {
      const pages: Record<string, { timestamp: string }[]> = {
        undefined: [{ timestamp: "t9" }, { timestamp: "t8" }],
        t8: [{ timestamp: "t7" }, { timestamp: "t6" }],
        t6: [{ timestamp: "t5" }],
      };
      const seen: (string | undefined)[] = [];
      const all = await collectHistory(
        async (cursor) => {
          seen.push(cursor);
          return pages[String(cursor)] ?? [];
        },
        { pageSize: 2, maxPages: 10 },
      );
      expect(all.map((e) => e.timestamp)).toEqual(["t9", "t8", "t7", "t6", "t5"]);
      expect(seen).toEqual([undefined, "t8", "t6"]);
    });

    it("refuses a full page without a cursor, a stuck cursor, and too many pages", async () => {
      await expect(
        collectHistory(async () => [{}, {}], { pageSize: 2, maxPages: 3 }),
      ).rejects.toThrow(/no timestamp cursor/);
      await expect(
        collectHistory(async () => [{ timestamp: "same" }, { timestamp: "same" }], {
          pageSize: 2,
          maxPages: 3,
        }),
      ).rejects.toThrow(/did not advance/);
      let n = 0;
      await expect(
        collectHistory(
          async () => {
            n += 1;
            return [{ timestamp: `t${n}` }, { timestamp: `t${n}b` }];
          },
          { pageSize: 2, maxPages: 3 },
        ),
      ).rejects.toThrow(/exceeded 6 events/);
    });
  });

  describe("totalReceivedFrom", () => {
    const inbound = (
      amount: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      instrumentId: "Amulet",
      status: "completed",
      direction: "in",
      partyId: TREASURY,
      partyId2: USER,
      amount,
      ...extra,
    });

    it("sums settled Amulet inbound between exactly the two parties, in fixed point", () => {
      const rows = [
        inbound("0.1"),
        inbound("0.2"),
        inbound("5", { status: "Completed" }), // case-insensitive
        inbound("100", { direction: "out" }), // withdrawal
        inbound("100", { status: "pending" }),
        inbound("100", { status: "failed" }),
        inbound("100", { instrumentId: "Other" }),
        inbound("100", { partyId2: OTHER }),
        inbound("100", { partyId: USER, partyId2: USER }),
        inbound("-1"),
        inbound("abc"),
        {
          instrumentId: "Amulet",
          status: "completed",
          direction: "in",
          partyId: USER,
          partyId2: TREASURY,
          amount: "0.0000000001",
        },
      ];
      expect(totalReceivedFrom(rows, TREASURY, USER)).toBe(parseCC("5.3000000001"));
    });

    it("skips (and reports) unknown or missing statuses and unknown directions rather than guessing", () => {
      const skipped: number[] = [];
      const total = totalReceivedFrom(
        [
          inbound("1", { status: "weird" }),
          inbound("1", { status: undefined }),
          inbound("1", { direction: "sideways" }),
          inbound("1"),
        ],
        TREASURY,
        USER,
        "Amulet",
        (n) => skipped.push(n),
      );
      expect(total).toBe(parseCC("1"));
      expect(skipped).toEqual([3]);
    });
  });

  describe("transferHistory", () => {
    function service(answer: (path: string) => Promise<unknown>): {
      svc: EnterpriseWalletService;
      paths: string[];
    } {
      const config = {
        enterpriseWalletUrl: "http://wallet",
        treasuryPartyId: TREASURY,
        enterpriseWalletAppName: "truthoracle",
        ledgerCacheMs: 0,
      } as unknown as Config;
      const keycloak = {
        bearerFor: jest.fn().mockResolvedValue("token"),
      } as unknown as KeycloakTokenService;
      const svc = new EnterpriseWalletService(config, keycloak, {} as RedisService);
      const paths: string[] = [];
      jest
        .spyOn(svc as unknown as { wallet: (path: string) => Promise<unknown> }, "wallet")
        .mockImplementation((path: string) => {
          paths.push(path);
          return answer(path);
        });
      return { svc, paths };
    }

    it("flattens /api/v1/history events to their payloads", async () => {
      const { svc, paths } = service(() =>
        Promise.resolve({
          events: [
            {
              eventType: "transfer",
              timestamp: "t1",
              event: { instrumentId: "Amulet", amount: "1" },
            },
          ],
        }),
      );
      await expect(svc.transferHistory(TREASURY, { uncached: true })).resolves.toEqual([
        { instrumentId: "Amulet", amount: "1" },
      ]);
      expect(paths).toEqual([`/api/v1/history/${encodeURIComponent(TREASURY)}?limit=1000`]);
    });

    it("a 404 on /api/v1/history is an upstream failure — there is no older endpoint to fall back to", async () => {
      const { svc, paths } = service(() => Promise.reject(new UpstreamError("404", 404, "")));
      await expect(svc.transferHistory(TREASURY, { uncached: true })).rejects.toMatchObject({
        status: 502,
        code: "upstream_failed",
        details: { upstreamStatus: 404 },
      });
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(/^\/api\/v1\/history\//);
    });
  });

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
      const svc = new EnterpriseWalletService(config, keycloak, {} as RedisService);
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
  });
});
