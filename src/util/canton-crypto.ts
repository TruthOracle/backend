/**
 * Canton external-party key ↔ party binding and Ed25519 signature verification
 * (docs/ARCHITECTURE.md §7.3). Port of truthoracle-canton/api/_lib/verifyPartySignature.mjs.
 *
 * Canton external-party keys are Ed25519, so the maths is fixed. What is NOT fixed is the
 * wire encoding: `@cantor8/wallet-connect-sdk` is a pure postMessage transport for
 * `signMessage` —
 *
 *     signMessage(e, t) { return this.transport.request("signMessage", { message: e, partyId: t }, !0) }
 *
 * — so it returns the popup's string verbatim and the SDK's own types say only
 * `Promise<string>`. Neither the encoding (hex / base64 / base64url) nor the exact preimage
 * (raw UTF-8 bytes vs. a hash of them) is discoverable from the package. Rather than guess one
 * and ship a verifier that silently rejects every real login, we try the small closed set of
 * plausible combinations and report which one matched (Cantor8 signs raw UTF-8 — confirmed
 * 2026-09-01). `describeAttempt` renders the shape-only diagnostic that pins the format down
 * from a single real signature.
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

import { asString } from "./strings";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

/** Canton `HashPurpose.PublicKeyFingerprint` (= 12), big-endian uint32 prefix of the hash input. */
const HASH_PURPOSE_PUBLIC_KEY_FINGERPRINT = 12;
/** multihash header for sha2-256 with a 32-byte digest. */
const MULTIHASH_SHA256_PREFIX = Buffer.from([0x12, 0x20]);

/** `<hint>::1220<64 hex>` — exactly one `::`, hint ≤ 255 URL-safe chars (§7.3). */
export const PARTY_ID_RE = /^[A-Za-z0-9_\-.]{1,255}::1220[0-9a-f]{64}$/;

/**
 * Decode a key/signature that may arrive hex, base64, or base64url encoded. Length is the
 * discriminator: a 32-byte value is 64 hex chars but ~44 base64 chars, so an exact-length match
 * after decoding identifies the encoding unambiguously.
 */
export function decodeFixedWidth(value: unknown, expectedBytes: number): Buffer | null {
  if (Buffer.isBuffer(value)) return value.length === expectedBytes ? value : null;
  const raw = asString(value).trim();
  if (!raw) return null;

  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === expectedBytes * 2) {
    candidates.push(Buffer.from(raw, "hex"));
  }
  if (/^[A-Za-z0-9+/=]+$/.test(raw)) candidates.push(Buffer.from(raw, "base64"));
  if (/^[A-Za-z0-9_-]+$/.test(raw)) candidates.push(Buffer.from(raw, "base64url"));

  for (const buf of candidates) if (buf.length === expectedBytes) return buf;

  // Some Canton tooling prefixes the raw key with a scheme/format byte. Accept a longer decode
  // only when trimming a short prefix lands exactly on the key size.
  for (const buf of candidates) {
    if (buf.length > expectedBytes && buf.length <= expectedBytes + 8) {
      return buf.subarray(buf.length - expectedBytes);
    }
  }
  return null;
}

/**
 * `hex(0x12 0x20 ‖ sha256(uint32be(12) ‖ rawKey))` — exactly
 * `TopologyWriteService.createFingerprintFromKey` in `@canton-network/wallet-sdk`
 * (HashPurpose 12 = PublicKeyFingerprint, multihash sha2-256). Verified against the real
 * operator party in truthoracle-canton/.env.
 */
export function partyFingerprintFromPublicKey(raw: Buffer): string {
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new TypeError(
      `partyFingerprintFromPublicKey: expected ${PUBLIC_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  const purpose = Buffer.alloc(4);
  purpose.writeUInt32BE(HASH_PURPOSE_PUBLIC_KEY_FINGERPRINT, 0);
  const digest = createHash("sha256")
    .update(Buffer.concat([purpose, raw]))
    .digest();
  return Buffer.concat([MULTIHASH_SHA256_PREFIX, digest]).toString("hex");
}

export function isValidPartyId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.indexOf("::") !== id.lastIndexOf("::")) return false;
  return PARTY_ID_RE.test(id);
}

/** The `1220…` namespace fingerprint of a party id (throws on a malformed id). */
export function partyNamespace(id: string): string {
  if (!isValidPartyId(id)) throw new TypeError("partyNamespace: not a Canton party id");
  return id.split("::")[1];
}

/** The party hint (everything before `::`). */
export function partyHint(id: string): string {
  if (!isValidPartyId(id)) throw new TypeError("partyHint: not a Canton party id");
  return id.split("::")[0];
}

/**
 * Key ↔ party binding: the fingerprint of the supplied key must be the party's namespace.
 * Parties whose signing key was rotated, or that were allocated under a participant namespace,
 * fail this check (documented limitation → `wallet_key_mismatch`).
 */
export function publicKeyMatchesParty(publicKey: unknown, partyId: string): boolean {
  if (!isValidPartyId(partyId)) return false;
  const raw = decodeFixedWidth(publicKey, PUBLIC_KEY_BYTES);
  if (!raw) return false;
  return partyFingerprintFromPublicKey(raw) === partyNamespace(partyId);
}

/** Raw 32-byte key → base64 (the canonical form stored in `to_wallets.public_key`). */
export function publicKeyToBase64(publicKey: unknown): string | null {
  const raw = decodeFixedWidth(publicKey, PUBLIC_KEY_BYTES);
  return raw ? raw.toString("base64") : null;
}

/** Two encodings of the same 32-byte key compare equal regardless of hex/base64/base64url. */
export function publicKeysEqual(a: unknown, b: unknown): boolean {
  const ra = decodeFixedWidth(a, PUBLIC_KEY_BYTES);
  const rb = decodeFixedWidth(b, PUBLIC_KEY_BYTES);
  return Boolean(ra && rb && ra.equals(rb));
}

function publicKeyFrom(raw: unknown): KeyObject | null {
  const keyBytes = decodeFixedWidth(raw, PUBLIC_KEY_BYTES);
  if (!keyBytes) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

export type SignaturePreimageForm = "utf8" | "sha256(utf8)";

/**
 * Candidate preimages, in the order a wallet is most likely to have signed them. Ed25519 hashes
 * internally, so signing the raw message is the norm; the sha256 variant covers wallets that
 * pre-hash before handing bytes to the signer.
 */
function preimages(message: string): { form: SignaturePreimageForm; bytes: Buffer }[] {
  const utf8 = Buffer.from(message, "utf8");
  return [
    { form: "utf8", bytes: utf8 },
    { form: "sha256(utf8)", bytes: createHash("sha256").update(utf8).digest() },
  ];
}

export type VerifyResult =
  { ok: true; form: SignaturePreimageForm } | { ok: false; reason: string };

export function verifyPartySignature(input: {
  message: string;
  signature: unknown;
  publicKey: unknown;
}): VerifyResult {
  const { message, signature, publicKey } = input;
  if (!message) return { ok: false, reason: "missing message" };

  const key = publicKeyFrom(publicKey);
  if (!key) return { ok: false, reason: "public key is not a 32-byte Ed25519 key" };

  const sigBytes = decodeFixedWidth(signature, SIGNATURE_BYTES);
  if (!sigBytes) return { ok: false, reason: "signature is not a 64-byte Ed25519 signature" };

  for (const { form, bytes } of preimages(message)) {
    // Ed25519 takes a null algorithm — the scheme fixes its own hash.
    if (cryptoVerify(null, bytes, key, sigBytes)) return { ok: true, form };
  }
  return { ok: false, reason: "signature did not verify against the account public key" };
}

/**
 * Shape-only description of a failed attempt, safe to log: lengths and character classes,
 * never the signature bytes or anything that would help forge one.
 */
export function describeAttempt(input: { signature: unknown; publicKey: unknown }): string {
  const shape = (value: unknown): string => {
    const raw = asString(value).trim();
    if (!raw) return "empty";
    const charset = /^[0-9a-fA-F]+$/.test(raw)
      ? "hex"
      : /^[A-Za-z0-9_-]+$/.test(raw)
        ? "base64url"
        : /^[A-Za-z0-9+/=]+$/.test(raw)
          ? "base64"
          : "other";
    const decoded = (["hex", "base64", "base64url"] as const)
      .map((enc) => {
        try {
          return `${enc}=${Buffer.from(raw, enc).length}B`;
        } catch {
          return `${enc}=?`;
        }
      })
      .join(" ");
    return `${raw.length} chars, charset=${charset}, decodes ${decoded}`;
  };
  return `signature: ${shape(input.signature)}; publicKey: ${shape(input.publicKey)}`;
}
