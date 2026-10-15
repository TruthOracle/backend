import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";

import { partyFingerprintFromPublicKey } from "../../src/util/canton-crypto";

export interface TestWallet {
  partyId: string;
  publicKeyBase64: string;
  publicKeyHex: string;
  privateKey: KeyObject;
  /** Signs the raw UTF-8 message like Cantor8 does; returns base64. */
  sign(message: string): string;
}

/** A fresh Ed25519 keypair whose party id is `<hint>::<Canton fingerprint of the key>`. */
export function makeTestWallet(hint = "test"): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  return {
    partyId: `${hint}::${partyFingerprintFromPublicKey(raw)}`,
    publicKeyBase64: raw.toString("base64"),
    publicKeyHex: raw.toString("hex"),
    privateKey,
    sign: (message: string) =>
      cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}
