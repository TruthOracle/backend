import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Sealing v2 (SPEC §8, I4): AES-256-GCM for values that must be stored but never read back in
 * bulk — card tokens, IBANs, verified identities, statement lines. Blob `v2.<kid>.<iv>.<tag>.<ct>`
 * (base64url parts): a fresh 12-byte IV per value and a 16-byte tag; any other IV or tag length is
 * refused (a truncated tag lowers the forgery bound, E-D6). `aad` is required and names the owner
 * row, so a value copied onto another row or account fails to open. The kid picks the key from a
 * keyring (`DATA_KEYS`); an unknown kid fails closed. No v1 compatibility: nothing is released.
 */
export const SEAL_VERSION = "v2";
export const SEAL_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Key ids: they sit inside blobs (dot-separated) and next to blind-index values. */
export const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Every key by id and the id new values are written with. */
export interface Keyring {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

/** A blind index value with the key id it was computed under (stored together, X17). */
export interface BlindIndexValue {
  kid: string;
  hash: string;
}

function activeKey(ring: Keyring): Buffer {
  const key = ring.keys.get(ring.activeKid);
  if (!key || key.length !== SEAL_KEY_BYTES)
    throw new Error("sealed: the active key is missing or not 32 bytes");
  return key;
}

function requireAad(aad: string): Buffer {
  if (typeof aad !== "string" || aad.length === 0) throw new Error("sealed: aad is required");
  return Buffer.from(aad, "utf8");
}

/**
 * The AAD of a sealed column: `purpose|part|…`. Parts must be non-empty and free of `|`, so two
 * different owners can never produce the same AAD.
 */
export function sealAad(purpose: string, ...parts: string[]): string {
  for (const p of [purpose, ...parts]) {
    if (typeof p !== "string" || p.length === 0 || p.includes("|"))
      throw new Error("sealAad: every part must be a non-empty string without '|'");
  }
  return [purpose, ...parts].join("|");
}

export function seal(plaintext: string, ring: Keyring, aad: string): string {
  const key = activeKey(ring);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(requireAad(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    SEAL_VERSION,
    ring.activeKid,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/** The kid of a well-formed v2 blob; null for anything else (v1, garbage). */
export function sealedKid(blob: string): string | null {
  if (typeof blob !== "string") return null;
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== SEAL_VERSION || !KEY_ID_RE.test(parts[1])) return null;
  return parts[1];
}

/** Throws on an unknown format or kid, a wrong IV / tag length, a wrong key or `aad`, or tampering. */
export function unseal(blob: string, ring: Keyring, aad: string): string {
  const kid = sealedKid(blob);
  if (!kid) throw new Error("unseal: unknown format");
  const [, , ivB64, tagB64, ctB64] = blob.split(".");
  if (![ivB64, tagB64, ctB64].every((p) => B64URL_RE.test(p)))
    throw new Error("unseal: unknown format");
  const key = ring.keys.get(kid);
  if (!key) throw new Error(`unseal: unknown key id ${kid}`);
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES) throw new Error("unseal: the IV must be 12 bytes");
  if (tag.length !== TAG_BYTES) throw new Error("unseal: the tag must be 16 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(requireAad(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

const PURPOSE_RE = /^[a-z0-9_.-]{1,64}$/;

function indexUnder(key: Buffer, kid: string, purpose: string, value: string): BlindIndexValue {
  if (!PURPOSE_RE.test(purpose))
    throw new Error("blindIndex: purpose must match [a-z0-9_.-]{1,64}");
  if (typeof value !== "string" || value.length === 0)
    throw new Error("blindIndex: value is required");
  return {
    kid,
    hash: createHmac("sha256", key).update(`${purpose}|${value}`, "utf8").digest("hex"),
  };
}

/** HMAC-SHA256 of `purpose|value` under the ACTIVE index key — what a new row stores. */
export function blindIndex(ring: Keyring, purpose: string, value: string): BlindIndexValue {
  return indexUnder(activeKey(ring), ring.activeKid, purpose, value);
}

/** The same value under EVERY index key: uniqueness lookups match any of them (rotation in progress). */
export function blindIndexes(ring: Keyring, purpose: string, value: string): BlindIndexValue[] {
  return [...ring.keys.entries()].map(([kid, key]) => indexUnder(key, kid, purpose, value));
}

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * `<kid>:<base64 of 32 bytes>[,<kid>:<key>…]` (`DATA_KEYS`, `DATA_INDEX_KEYS`) → keys by id. Every
 * problem is named by kid or position, never with key material.
 */
export function parseKeyring(
  raw: string,
  name: string,
): { keys: Map<string, Buffer>; issues: string[] } {
  const keys = new Map<string, Buffer>();
  const issues: string[] = [];
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  entries.forEach((entry, i) => {
    const at = entry.indexOf(":");
    const kid = at < 0 ? "" : entry.slice(0, at).trim();
    const b64 = at < 0 ? "" : entry.slice(at + 1).trim();
    if (!KEY_ID_RE.test(kid)) {
      issues.push(`${name} entry ${i + 1} must be <kid>:<base64 key> with kid [A-Za-z0-9_-]{1,32}`);
      return;
    }
    if (keys.has(kid)) {
      issues.push(`${name} lists kid ${kid} twice`);
      return;
    }
    const key = BASE64_RE.test(b64) ? Buffer.from(b64, "base64") : Buffer.alloc(0);
    if (key.length !== SEAL_KEY_BYTES) {
      issues.push(`${name} key ${kid} must be base64 of exactly 32 bytes`);
      return;
    }
    keys.set(kid, key);
  });
  return { keys, issues };
}
