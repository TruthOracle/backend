import { parseCC } from "../util/money";
import { collectHistory, totalReceivedFrom } from "./enterprise-wallet.service";

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
      await expect(collectHistory(async () => [{}, {}], { pageSize: 2, maxPages: 3 })).rejects.toThrow(/no timestamp cursor/);
      await expect(collectHistory(async () => [{ timestamp: "same" }, { timestamp: "same" }], { pageSize: 2, maxPages: 3 })).rejects.toThrow(/did not advance/);
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
    const inbound = (amount: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
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
        inbound("5", { status: undefined }), // pre-0.1.35 rows have no status and still count
        inbound("100", { direction: "out" }), // withdrawal
        inbound("100", { status: "pending" }),
        inbound("100", { status: "failed" }),
        inbound("100", { instrumentId: "Other" }),
        inbound("100", { partyId2: OTHER }),
        inbound("100", { partyId: USER, partyId2: USER }),
        inbound("-1"),
        inbound("abc"),
        { instrumentId: "Amulet", status: "completed", direction: "in", partyId: USER, partyId2: TREASURY, amount: "0.0000000001" },
      ];
      expect(totalReceivedFrom(rows, TREASURY, USER)).toBe(parseCC("5.3000000001"));
    });

    it("skips (and reports) unknown statuses and directions rather than guessing", () => {
      const skipped: number[] = [];
      const total = totalReceivedFrom(
        [inbound("1", { status: "weird" }), inbound("1", { direction: "sideways" }), inbound("1")],
        TREASURY,
        USER,
        "Amulet",
        (n) => skipped.push(n),
      );
      expect(total).toBe(parseCC("1"));
      expect(skipped).toEqual([2]);
    });
  });
});
