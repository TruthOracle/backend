import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import {
  decodeFixedWidth,
  describeAttempt,
  isValidPartyId,
  partyFingerprintFromPublicKey,
  partyNamespace,
  publicKeyMatchesParty,
  publicKeysEqual,
  publicKeyToBase64,
  verifyPartySignature,
} from "./canton-crypto";

/** The real TruthOracle operator party and its pinned key (truthoracle-canton/.env, public data). */
const OPERATOR_PARTY = "20a2514bea1b4dd382f116c1e580197d::12205811d9301bcc2456567f882baceb8e083483c8be3f2631aedc2ce1806c424393";
const OPERATOR_KEY_HEX = "e47140308293759b1e20d90348c2455e2cddfbf43667b196dfa166e6c0a6fcd1";

function freshKeypair(): { raw: Buffer; privateKey: import("node:crypto").KeyObject; partyId: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  return { raw, privateKey, partyId: `test::${partyFingerprintFromPublicKey(raw)}` };
}

describe("util/canton-crypto", () => {
  describe("fingerprint", () => {
    it("matches the real operator party (HashPurpose 12, multihash sha2-256)", () => {
      const raw = Buffer.from(OPERATOR_KEY_HEX, "hex");
      expect(partyFingerprintFromPublicKey(raw)).toBe(OPERATOR_PARTY.split("::")[1]);
      expect(publicKeyMatchesParty(OPERATOR_KEY_HEX, OPERATOR_PARTY)).toBe(true);
      expect(publicKeyMatchesParty(raw.toString("base64"), OPERATOR_PARTY)).toBe(true);
      expect(publicKeyMatchesParty(raw.toString("base64url"), OPERATOR_PARTY)).toBe(true);
    });

    it("round-trips a fresh keypair and rejects a different key", () => {
      const a = freshKeypair();
      const b = freshKeypair();
      expect(a.partyId).toMatch(/^test::1220[0-9a-f]{64}$/);
      expect(publicKeyMatchesParty(a.raw, a.partyId)).toBe(true);
      expect(publicKeyMatchesParty(b.raw, a.partyId)).toBe(false);
      expect(partyNamespace(a.partyId)).toBe(partyFingerprintFromPublicKey(a.raw));
    });

    it("is the documented formula", () => {
      const raw = Buffer.alloc(32, 7);
      const purpose = Buffer.from([0, 0, 0, 12]);
      const expected = "1220" + createHash("sha256").update(Buffer.concat([purpose, raw])).digest("hex");
      expect(partyFingerprintFromPublicKey(raw)).toBe(expected);
    });
  });

  describe("party id regex", () => {
    it("accepts exactly one :: with a 1220 fingerprint", () => {
      expect(isValidPartyId(OPERATOR_PARTY)).toBe(true);
      expect(isValidPartyId("a.b-c_d::1220" + "0".repeat(64))).toBe(true);
    });

    it("rejects malformed ids", () => {
      const fp = "1220" + "a".repeat(64);
      expect(isValidPartyId(`x::y::${fp}`)).toBe(false);
      expect(isValidPartyId(`::${fp}`)).toBe(false);
      expect(isValidPartyId(`hint::1221${"a".repeat(64)}`)).toBe(false);
      expect(isValidPartyId(`hint::1220${"A".repeat(64)}`)).toBe(false);
      expect(isValidPartyId(`hint::1220${"a".repeat(63)}`)).toBe(false);
      expect(isValidPartyId(`hi nt::${fp}`)).toBe(false);
      expect(isValidPartyId(`${"h".repeat(256)}::${fp}`)).toBe(false);
      expect(isValidPartyId(42)).toBe(false);
      expect(() => partyNamespace("nope")).toThrow();
    });
  });

  describe("decodeFixedWidth", () => {
    it("identifies hex / base64 / base64url by decoded length and tolerates short prefixes", () => {
      const raw = Buffer.alloc(32, 9);
      expect(decodeFixedWidth(raw.toString("hex"), 32)?.equals(raw)).toBe(true);
      expect(decodeFixedWidth(raw.toString("base64"), 32)?.equals(raw)).toBe(true);
      expect(decodeFixedWidth(raw.toString("base64url"), 32)?.equals(raw)).toBe(true);
      // A scheme/format byte in front of the key is tolerated (base64; hex is length-pinned).
      const prefixed = Buffer.concat([Buffer.from([0x0c]), raw]);
      expect(decodeFixedWidth(prefixed.toString("base64"), 32)?.equals(raw)).toBe(true);
      expect(decodeFixedWidth(prefixed.toString("hex"), 32)).toBeNull();
      expect(decodeFixedWidth(raw, 32)).toBe(raw);
      expect(decodeFixedWidth("", 32)).toBeNull();
      expect(decodeFixedWidth("zz", 32)).toBeNull();
      expect(decodeFixedWidth(Buffer.alloc(64, 1).toString("hex"), 32)).toBeNull();
    });

    it("compares keys across encodings", () => {
      const raw = Buffer.alloc(32, 3);
      expect(publicKeysEqual(raw.toString("hex"), raw.toString("base64"))).toBe(true);
      expect(publicKeysEqual(raw.toString("hex"), Buffer.alloc(32, 4).toString("hex"))).toBe(false);
      expect(publicKeyToBase64(raw.toString("hex"))).toBe(raw.toString("base64"));
    });
  });

  describe("verifyPartySignature", () => {
    const message = "TruthOracle link-wallet\nDomain: app.test\nNonce: abc";

    it("accepts a raw-UTF-8 Ed25519 signature in any encoding", () => {
      const kp = freshKeypair();
      const sig = cryptoSign(null, Buffer.from(message, "utf8"), kp.privateKey);
      expect(verifyPartySignature({ message, signature: sig.toString("base64"), publicKey: kp.raw.toString("base64") })).toEqual({ ok: true, form: "utf8" });
      expect(verifyPartySignature({ message, signature: sig.toString("hex"), publicKey: kp.raw.toString("hex") })).toEqual({ ok: true, form: "utf8" });
      expect(verifyPartySignature({ message, signature: sig.toString("base64url"), publicKey: kp.raw.toString("base64url") })).toEqual({ ok: true, form: "utf8" });
    });

    it("falls back to the sha256(utf8) preimage", () => {
      const kp = freshKeypair();
      const digest = createHash("sha256").update(Buffer.from(message, "utf8")).digest();
      const sig = cryptoSign(null, digest, kp.privateKey);
      expect(verifyPartySignature({ message, signature: sig.toString("base64"), publicKey: kp.raw.toString("base64") })).toEqual({ ok: true, form: "sha256(utf8)" });
    });

    it("rejects a wrong key, a tampered message, and malformed input", () => {
      const kp = freshKeypair();
      const other = freshKeypair();
      const sig = cryptoSign(null, Buffer.from(message, "utf8"), kp.privateKey);
      expect(verifyPartySignature({ message, signature: sig.toString("base64"), publicKey: other.raw.toString("base64") }).ok).toBe(false);
      expect(verifyPartySignature({ message: message + "!", signature: sig.toString("base64"), publicKey: kp.raw.toString("base64") }).ok).toBe(false);
      expect(verifyPartySignature({ message: "", signature: sig.toString("base64"), publicKey: kp.raw.toString("base64") })).toEqual({ ok: false, reason: "missing message" });
      expect(verifyPartySignature({ message, signature: "nope", publicKey: kp.raw.toString("base64") }).ok).toBe(false);
      expect(verifyPartySignature({ message, signature: sig.toString("base64"), publicKey: "nope" }).ok).toBe(false);
    });

    it("describes attempts by shape only", () => {
      const text = describeAttempt({ signature: "abcd", publicKey: "" });
      expect(text).toContain("signature: 4 chars, charset=hex");
      expect(text).toContain("publicKey: empty");
      expect(text).not.toContain("abcd=");
    });
  });
});
