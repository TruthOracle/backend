import { randomBytes } from "node:crypto";

import {
  blindIndex,
  blindIndexes,
  type Keyring,
  parseKeyring,
  seal,
  sealAad,
  sealedKid,
  unseal,
} from "./sealed";

const ring = (active: string, keys: Record<string, Buffer>): Keyring => ({
  activeKid: active,
  keys: new Map(Object.entries(keys)),
});

/** Re-join a blob with one part replaced (index into `v2.<kid>.<iv>.<tag>.<ct>`). */
function withPart(blob: string, index: number, value: Buffer | string): string {
  const parts = blob.split(".");
  parts[index] = typeof value === "string" ? value : value.toString("base64url");
  return parts.join(".");
}

describe("sealed v2 (AES-256-GCM, SPEC §8)", () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const one = ring("k1", { k1 });
  const aad = sealAad("ramp-pm", "mock", "user-1", "card-1");

  it("decodes a fixed vector: v2.<kid>.<iv>.<tag>.<ct>, AAD-bound", () => {
    const fixed = ring("k1", { k1: Buffer.alloc(32, 1) });
    const blob = "v2.k1.AgICAgICAgICAgIC.3ZRPWoSfOCU7UI7VyANElQ.c7miFjwyoom8vg";
    expect(unseal(blob, fixed, "ramp-pm|mock|u1|c1")).toBe("tok_vector");
    expect(sealedKid(blob)).toBe("k1");
    expect(() => unseal(blob, fixed, "ramp-pm|mock|u2|c1")).toThrow();
  });

  it("round-trips under the active kid with a fresh IV every time", () => {
    const a = seal("tok_123", one, aad);
    const b = seal("tok_123", one, aad);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v2\.k1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/);
    expect(unseal(a, one, aad)).toBe("tok_123");
    expect(unseal(seal("", one, aad), one, aad)).toBe("");
  });

  it("refuses another owner's AAD, an empty AAD, another key and a tampered value", () => {
    const blob = seal("tok_123", one, aad);
    expect(() => unseal(blob, one, sealAad("ramp-pm", "mock", "user-2", "card-1"))).toThrow();
    expect(() => unseal(blob, one, "")).toThrow(/aad is required/);
    expect(() => seal("x", one, "")).toThrow(/aad is required/);
    expect(() => unseal(blob, ring("k1", { k1: k2 }), aad)).toThrow();
    const ct = Buffer.from(blob.split(".")[4], "base64url");
    ct[0] ^= 1;
    expect(() => unseal(withPart(blob, 4, ct), one, aad)).toThrow();
    const tag = Buffer.from(blob.split(".")[3], "base64url");
    tag[15] ^= 1;
    expect(() => unseal(withPart(blob, 3, tag), one, aad)).toThrow();
  });

  it("refuses truncated tags and non-12-byte IVs before decrypting (E-D6)", () => {
    const blob = seal("tok_123", one, aad);
    const tag = Buffer.from(blob.split(".")[3], "base64url");
    for (const len of [12, 8, 4]) {
      expect(() => unseal(withPart(blob, 3, tag.subarray(0, len)), one, aad)).toThrow(
        /tag must be 16 bytes/,
      );
    }
    expect(() => unseal(withPart(blob, 2, randomBytes(16)), one, aad)).toThrow(
      /IV must be 12 bytes/,
    );
  });

  it("fails closed on an unknown kid, a v1 blob and malformed parts", () => {
    const blob = seal("tok_123", one, aad);
    expect(() => unseal(blob, ring("k2", { k2 }), aad)).toThrow(/unknown key id k1/);
    expect(() => unseal("v1.aaaa.bbbb.cccc", one, aad)).toThrow(/unknown format/);
    expect(() => unseal(blob.replace(/^v2/, "v3"), one, aad)).toThrow(/unknown format/);
    expect(() => unseal(withPart(blob, 4, "not base64url!"), one, aad)).toThrow(/unknown format/);
    expect(sealedKid("v1.aaaa.bbbb.cccc")).toBeNull();
    expect(sealedKid("v2.bad kid.a.b.c")).toBeNull();
  });

  it("rotation: a keyring holding the old and the new kid opens both; dropping the old kid closes old blobs", () => {
    const old = seal("tok_old", one, aad);
    const rotated = ring("k2", { k1, k2 });
    expect(unseal(old, rotated, aad)).toBe("tok_old");
    const fresh = seal("tok_new", rotated, aad);
    expect(sealedKid(fresh)).toBe("k2");
    const resealed = seal(unseal(old, rotated, aad), rotated, aad);
    expect(sealedKid(resealed)).toBe("k2");
    const retired = ring("k2", { k2 });
    expect(unseal(resealed, retired, aad)).toBe("tok_old");
    expect(() => unseal(old, retired, aad)).toThrow(/unknown key id k1/);
  });

  it("refuses an active kid that is not in the keyring", () => {
    expect(() => seal("x", ring("k9", { k1 }), aad)).toThrow(/active key/);
  });

  it("sealAad joins with | and refuses empty parts or parts carrying |", () => {
    expect(sealAad("ramp-iban", "u", "a")).toBe("ramp-iban|u|a");
    expect(() => sealAad("ramp-pm", "mock", "", "id")).toThrow();
    expect(() => sealAad("ramp-pm", "mo|ck", "u", "id")).toThrow();
  });
});

describe("blind indexes (SPEC §8, X17)", () => {
  const k3 = Buffer.alloc(32, 3);
  const k4 = Buffer.alloc(32, 4);

  it("HMAC-SHA256 of purpose|value under the active kid (fixed vector)", () => {
    const idx = blindIndex(ring("i1", { i1: k3 }), "iban", "BY00TEST");
    expect(idx).toEqual({
      kid: "i1",
      hash: "06dff5cb20fee11e6d089e562a0e975a698eaeb07ade78dfb0f21192d110dbda",
    });
    expect(blindIndex(ring("i1", { i1: k3 }), "name", "BY00TEST").hash).not.toBe(idx.hash);
  });

  it("lookups get the value under every kid; the active one equals blindIndex", () => {
    const r = ring("i2", { i1: k3, i2: k4 });
    const all = blindIndexes(r, "iban", "BY00TEST");
    expect(all.map((v) => v.kid).sort()).toEqual(["i1", "i2"]);
    expect(all.find((v) => v.kid === "i2")).toEqual(blindIndex(r, "iban", "BY00TEST"));
    expect(all.find((v) => v.kid === "i1")?.hash).toBe(
      "06dff5cb20fee11e6d089e562a0e975a698eaeb07ade78dfb0f21192d110dbda",
    );
  });

  it("refuses a malformed purpose or an empty value", () => {
    const r = ring("i1", { i1: k3 });
    expect(() => blindIndex(r, "Iban|x", "v")).toThrow(/purpose/);
    expect(() => blindIndex(r, "iban", "")).toThrow(/value/);
  });
});

describe("parseKeyring", () => {
  const b64 = (fill: number, len = 32): string => Buffer.alloc(len, fill).toString("base64");

  it("parses <kid>:<base64>[,…] (standard or url-safe base64)", () => {
    const urlSafe = Buffer.alloc(32, 0xfb).toString("base64url");
    const { keys, issues } = parseKeyring(` k1:${b64(1)} , k-2:${urlSafe}`, "DATA_KEYS");
    expect(issues).toEqual([]);
    expect([...keys.keys()]).toEqual(["k1", "k-2"]);
    expect(keys.get("k-2")?.equals(Buffer.alloc(32, 0xfb))).toBe(true);
  });

  it("names every bad entry without echoing key material", () => {
    const { keys, issues } = parseKeyring(
      `bad kid:${b64(1)},k1:${b64(1, 16)},k2:${b64(2)},k2:${b64(3)},k3:@@@,nokey`,
      "DATA_INDEX_KEYS",
    );
    expect([...keys.keys()]).toEqual(["k2"]);
    expect(issues).toEqual([
      "DATA_INDEX_KEYS entry 1 must be <kid>:<base64 key> with kid [A-Za-z0-9_-]{1,32}",
      "DATA_INDEX_KEYS key k1 must be base64 of exactly 32 bytes",
      "DATA_INDEX_KEYS lists kid k2 twice",
      "DATA_INDEX_KEYS key k3 must be base64 of exactly 32 bytes",
      "DATA_INDEX_KEYS entry 6 must be <kid>:<base64 key> with kid [A-Za-z0-9_-]{1,32}",
    ]);
    expect(issues.join(" ")).not.toContain(b64(1));
  });
});
