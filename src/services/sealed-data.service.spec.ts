import type { Config } from "../config";
import { type Keyring, sealedKid } from "../util/sealed";
import {
  type BlindIndexReindexer,
  type ResealPageInput,
  SealedDataService,
  type SealedResealer,
  UNVERSIONED_KID,
} from "./sealed-data.service";

const keyring = (active: string, kids: string[], fill = 1): Keyring => ({
  activeKid: active,
  keys: new Map(kids.map((k, i) => [k, Buffer.alloc(32, fill + i)])),
});

function service(data: Keyring, index: Keyring = keyring("i1", ["i1"], 9)): SealedDataService {
  const config = { sealing: { data, index, derived: { data: false, index: false } } };
  return new SealedDataService(config as unknown as Config);
}

/** An in-memory sealed column: rows of {id, blob, aad}, walked in id order like the SQL ones. */
function memoryColumn(svc: SealedDataService, name: string, rows: { id: string; blob: string }[]) {
  const aad = (id: string): string => `test|${id}`;
  const resealer: SealedResealer & { rows: typeof rows } = {
    name,
    rows,
    async countByKid() {
      const out: Record<string, number> = {};
      for (const r of rows) {
        const kid = sealedKid(r.blob) ?? UNVERSIONED_KID;
        out[kid] = (out[kid] ?? 0) + 1;
      }
      return out;
    },
    async resealBatch({ activeKid, after, limit }: ResealPageInput) {
      const page = rows
        .filter((r) => sealedKid(r.blob) !== activeKid && (after === null || r.id > after))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit);
      let changed = 0;
      let failed = 0;
      for (const r of page) {
        try {
          r.blob = svc.reseal(r.blob, aad(r.id));
          changed += 1;
        } catch {
          failed += 1;
        }
      }
      return { changed, failed, last: page.length < limit ? null : page[page.length - 1].id };
    },
  };
  return { resealer, aad };
}

describe("SealedDataService (SPEC §8)", () => {
  it("seals under the active kid, opens every kid of the ring, and says what needs re-sealing", () => {
    const old = service(keyring("k1", ["k1"]));
    const blob = old.seal("tok", "a|1");
    const rotated = service(keyring("k2", ["k1", "k2"]));
    expect(rotated.unseal(blob, "a|1")).toBe("tok");
    expect(rotated.needsReseal(blob)).toBe(true);
    const fresh = rotated.reseal(blob, "a|1");
    expect(sealedKid(fresh)).toBe("k2");
    expect(rotated.needsReseal(fresh)).toBe(false);
    expect(() => rotated.reseal(blob, "a|2")).toThrow();
  });

  it("blind indexes: the active kid for writes, every kid for lookups", () => {
    const svc = service(keyring("k1", ["k1"]), keyring("i2", ["i1", "i2"], 5));
    expect(svc.blindIndex("iban", "BY1").kid).toBe("i2");
    expect(svc.blindIndexes("iban", "BY1").map((v) => v.kid)).toEqual(["i1", "i2"]);
  });

  it("refuses a second registration under the same name", () => {
    const svc = service(keyring("k1", ["k1"]));
    const { resealer } = memoryColumn(svc, "cards", []);
    svc.registerResealer(resealer);
    expect(() => svc.registerResealer(resealer)).toThrow(/registered twice/);
  });

  it("boot refuses a keyring that dropped a kid rows still use (sealed and index columns), and unversioned rows", async () => {
    const writer = service(keyring("k1", ["k1"]));
    const rows = [{ id: "a", blob: writer.seal("x", "test|a") }];
    const svc = service(keyring("k2", ["k2"]), keyring("i2", ["i2"]));
    svc.registerResealer(memoryColumn(svc, "cards", rows).resealer);
    const reindexer: BlindIndexReindexer = {
      name: "ibans",
      countByKid: async () => ({ i1: 2, i2: 1 }),
      reindexBatch: async () => ({ changed: 0, failed: 0, last: null }),
    };
    svc.registerReindexer(reindexer);
    await expect(svc.onApplicationBootstrap()).rejects.toThrow(
      /DATA_KEYS: cards has 1 row\(s\) under kid k1[\s\S]*DATA_INDEX_KEYS: ibans has 2 row\(s\) under kid i1/,
    );

    const v1 = service(keyring("k1", ["k1"]));
    v1.registerResealer(memoryColumn(v1, "legacy", [{ id: "z", blob: "v1.a.b.c" }]).resealer);
    await expect(v1.assertKeyringsCoverStoredData()).rejects.toThrow(/under kid \(not v2\)/);
  });

  it("boots when every kid in use is in the ring (or a dropped kid has zero rows)", async () => {
    const svc = service(keyring("k2", ["k1", "k2"]));
    const writer = service(keyring("k1", ["k1"]));
    svc.registerResealer(
      memoryColumn(svc, "cards", [{ id: "a", blob: writer.seal("x", "test|a") }]).resealer,
    );
    svc.registerReindexer({
      name: "ibans",
      countByKid: async () => ({ i0: 0, i1: 3 }),
      reindexBatch: async () => ({ changed: 0, failed: 0, last: null }),
    });
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it("the re-seal pass walks every page, re-seals onto the active kid, skips unreadable rows and lets the old kid go", async () => {
    const writer = service(keyring("k1", ["k1"]));
    const rows = Array.from({ length: 450 }, (_, i) => {
      const id = `r${String(i).padStart(4, "0")}`;
      return { id, blob: writer.seal(`tok-${i}`, `test|${id}`) };
    });
    rows.push({ id: "r9998", blob: writer.seal("moved", "test|elsewhere") }); // wrong AAD: tampered
    const svc = service(keyring("k2", ["k1", "k2"]));
    const { resealer, aad } = memoryColumn(svc, "cards", rows);
    svc.registerResealer(resealer);

    const first = await svc.resealPass();
    expect(first).toEqual({ resealed: 450, reindexed: 0, failed: 1 });
    expect(await resealer.countByKid()).toEqual({ k2: 450, k1: 1 });
    expect(svc.unseal(rows[449].blob, aad(rows[449].id))).toBe("tok-449");
    // Nothing left but the broken row: a second pass changes nothing.
    expect(await svc.resealPass()).toEqual({ resealed: 0, reindexed: 0, failed: 1 });

    rows.pop();
    const retired = service(keyring("k2", ["k2"]));
    retired.registerResealer(memoryColumn(retired, "cards", rows).resealer);
    await expect(retired.assertKeyringsCoverStoredData()).resolves.toBeUndefined();
  });

  it("a failing column is counted and does not stop the others", async () => {
    const svc = service(keyring("k1", ["k1"]));
    svc.registerResealer({
      name: "broken",
      countByKid: async () => ({}),
      resealBatch: async () => {
        throw new Error("db down");
      },
    });
    const reindexed: string[] = [];
    svc.registerReindexer({
      name: "ok",
      countByKid: async () => ({}),
      reindexBatch: async ({ activeKid }) => {
        reindexed.push(activeKid);
        return { changed: 2, failed: 0, last: null };
      },
    });
    expect(await svc.resealPass()).toEqual({ resealed: 0, reindexed: 2, failed: 1 });
    expect(reindexed).toEqual(["i1"]);
  });
});
