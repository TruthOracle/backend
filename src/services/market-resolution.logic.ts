/**
 * Pure rules of the approval-backed market resolution (review F0): what PredictionMarket's
 * ResolveT0 / Resolve / VoidMarket assert (truthoracle-v17 Truthoracle.daml), judged against the
 * BACKEND's clock when a request is stored and again before the treasury signs. The ledger stays
 * the final word; these checks keep a request that cannot land away from an approver, and fix
 * `nowSeconds` to the backend's clock instead of a browser's.
 */
import { createPublicKey, verify } from "node:crypto";

import type { StoredResolutionPolicy } from "../entities/market.entity";
import {
  MARKET_RESOLUTION_CHOICES,
  MARKET_RESOLUTION_MAX_ATTESTATIONS,
  MARKET_RESOLUTION_MAX_SOURCE_URI,
  MARKET_RESOLUTION_OUTCOMES,
  type ApiMarketResolutionSnapshot,
  type MarketOutcome,
  type MarketResolutionChoice,
  type MarketResolutionOutcome,
  type MarketStatus,
} from "../types";
import { ApiError } from "../util/errors";

/** The four-eyes action (SPEC §6.5 registry): `ops` asks, another person with `approver` approves. */
export const MARKET_RESOLVE_ACTION = "market.resolve";
const MAX_CID_LENGTH = 512;

/** The stored params: the request body minus `reason` / `signature`, only the keys the choice takes. */
export type ResolutionParams = {
  choice: MarketResolutionChoice;
  /** ResolveT0 only. */
  outcome?: MarketResolutionOutcome;
  /** ResolveT0 only. */
  sourceUri?: string;
  /** Resolve only, in the order given (the ledger takes the first one's outcome). */
  attestationCids?: string[];
};

/** What the rules read of a market (`to_markets`). */
export interface ResolutionMarket {
  marketId: number;
  status: MarketStatus;
  archived: boolean;
  expiresAtSec: number;
  gracePeriodSecs: number;
  policy: Pick<
    StoredResolutionPolicy,
    "operatorResolution" | "sources" | "sourceKeys" | "reporters" | "quorum"
  >;
}

/** One requested attestation as the index holds it; `row` null = no such OutcomeAttestation. */
export interface AttestationFacts {
  cid: string;
  row: {
    active: boolean;
    marketId: number;
    attester: string;
    sourceUri: string;
    fetchedAtSec: number;
    outcome: MarketOutcome;
    payloadHash: string;
    sourceSignature: string | null;
  } | null;
}

export interface ResolutionRefusal {
  /** Stable slug for `details.reason`. */
  reason: string;
  message: string;
  details?: Record<string, unknown>;
}

/** In epoch seconds, inclusive: ResolveT0 in [expiresAt, expiresAt + grace], Resolve from expiresAt, VoidMarket after expiresAt + grace. */
export interface ResolutionWindows {
  resolveT0From: number;
  resolveT0To: number;
  resolveFrom: number;
  voidFrom: number;
}

export function epochSeconds(atMs = Date.now()): number {
  return Math.floor(atMs / 1000);
}

export function resolutionWindows(
  expiresAtSec: number,
  gracePeriodSecs: number,
): ResolutionWindows {
  const end = expiresAtSec + gracePeriodSecs;
  // VoidMarket asserts `nowSeconds > expiresAt + grace`: the first whole second after the end.
  return {
    resolveT0From: expiresAtSec,
    resolveT0To: end,
    resolveFrom: expiresAtSec,
    voidFrom: end + 1,
  };
}

/** `:marketId` → its canonical decimal string (the approval subject, so "07" and "7" are one market). */
export function marketIdParam(raw: string): string {
  if (!/^\d{1,15}$/.test(raw))
    throw new ApiError(400, "validation_failed", "marketId must be the market's decimal id");
  return String(Number(raw));
}

const PARAM_KEYS = ["choice", "outcome", "sourceUri", "attestationCids"] as const;
const TAKES: Record<MarketResolutionChoice, (typeof PARAM_KEYS)[number][]> = {
  ResolveT0: ["outcome", "sourceUri"],
  Resolve: ["attestationCids"],
  VoidMarket: [],
};

/** Normalise the request params (400 `validation_failed`): a field a choice does not take is refused. */
export function resolutionParams(raw: Record<string, unknown>): ResolutionParams {
  const extra = Object.keys(raw).filter((k) => !(PARAM_KEYS as readonly string[]).includes(k));
  if (extra.length) invalid(`unknown field(s): ${extra.join(", ")}`);
  const c = raw.choice;
  if (!isOneOf(MARKET_RESOLUTION_CHOICES, c))
    invalid(`choice must be one of ${MARKET_RESOLUTION_CHOICES.join(", ")}`);
  for (const key of PARAM_KEYS.slice(1)) {
    const given = raw[key] !== undefined && raw[key] !== null;
    if (TAKES[c].includes(key) && !given) invalid(`${c} requires ${key}`);
    if (!TAKES[c].includes(key) && given) invalid(`${key} does not apply to ${c}`);
  }
  if (c === "ResolveT0")
    return {
      choice: c,
      outcome: outcomeParam(raw.outcome),
      sourceUri: sourceUriParam(raw.sourceUri),
    };
  if (c === "Resolve") return { choice: c, attestationCids: cidsParam(raw.attestationCids) };
  return { choice: c };
}

function outcomeParam(raw: unknown): MarketResolutionOutcome {
  if (!isOneOf(MARKET_RESOLUTION_OUTCOMES, raw))
    invalid(`outcome must be one of ${MARKET_RESOLUTION_OUTCOMES.join(", ")}`);
  return raw;
}

function sourceUriParam(raw: unknown): string {
  const uri = typeof raw === "string" ? raw.trim() : "";
  if (!isHttpUrl(uri)) invalid("sourceUri must be an http(s) URL");
  if (uri.length > MARKET_RESOLUTION_MAX_SOURCE_URI)
    invalid(`sourceUri is at most ${MARKET_RESOLUTION_MAX_SOURCE_URI} characters`);
  return uri;
}

function isHttpUrl(s: string): boolean {
  try {
    const { protocol } = new URL(s);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function cidsParam(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MARKET_RESOLUTION_MAX_ATTESTATIONS)
    invalid(`attestationCids must list 1 to ${MARKET_RESOLUTION_MAX_ATTESTATIONS} contract ids`);
  const cids = raw as unknown[];
  for (const cid of cids)
    if (typeof cid !== "string" || !/^\S+$/.test(cid) || cid.length > MAX_CID_LENGTH)
      invalid("each attestation contract id is a non-blank string without spaces");
  if (new Set(cids).size !== cids.length) invalid("attestationCids lists a contract id twice");
  return cids as string[];
}

// ───────────────────────────────────────────── the choice's own asserts ──────────────────────

/**
 * Status, clock and policy — in Truthoracle.daml's order. `sourceUri` null skips ResolveT0's
 * allowlist check (the choices a market offers, before anyone names a source).
 */
export function choiceRefusal(
  choice: MarketResolutionChoice,
  m: ResolutionMarket,
  nowSec: number,
  sourceUri: string | null,
): ResolutionRefusal | null {
  const id = `market #${m.marketId}`;
  if (m.archived) return { reason: "archived", message: `${id} is archived on the ledger` };
  const w = resolutionWindows(m.expiresAtSec, m.gracePeriodSecs);
  if (choice === "ResolveT0") {
    if (!m.policy.operatorResolution)
      return {
        reason: "operator_resolution_off",
        message: `T0 operator resolution is not enabled for ${id}`,
      };
    if (m.status !== "Trading") return statusRefusal(id, choice, m.status, "Trading");
    if (nowSec < w.resolveT0From) return notExpired(id, choice, w.resolveT0From);
    if (nowSec > w.resolveT0To)
      return {
        reason: "window_closed",
        message: `the ResolveT0 window of ${id} closed at ${iso(w.resolveT0To)}`,
        details: { closedAt: iso(w.resolveT0To) },
      };
    if (sourceUri !== null && m.policy.sources.length > 0 && !m.policy.sources.includes(sourceUri))
      return {
        reason: "source_not_allowed",
        message: `${sourceUri} is not in the source allowlist of ${id}`,
        details: { sourceUri, sources: m.policy.sources },
      };
    return null;
  }
  if (m.status !== "Trading" && m.status !== "Proposed")
    return statusRefusal(id, choice, m.status, "Trading or Proposed");
  if (choice === "Resolve")
    return nowSec < w.resolveFrom ? notExpired(id, choice, w.resolveFrom) : null;
  if (nowSec < w.voidFrom)
    return {
      reason: "grace_not_elapsed",
      message: `the grace period of ${id} ends at ${iso(w.resolveT0To)}; VoidMarket opens after it`,
      details: { opensAt: iso(w.voidFrom) },
    };
  return null;
}

/**
 * The choices open at `nowSec`. Resolve also needs a policy that can ever admit attestations:
 * allowlisted sources and a pinned key for one of them (T1) or a reachable reporter quorum (T2).
 */
export function choicesAvailable(m: ResolutionMarket, nowSec: number): MarketResolutionChoice[] {
  const p = m.policy;
  const resolvable =
    p.sources.length > 0 &&
    (p.sourceKeys.some((k) => p.sources.includes(k.sourceUri)) ||
      (p.quorum > 0 && new Set(p.reporters).size >= p.quorum));
  return MARKET_RESOLUTION_CHOICES.filter(
    (c) => choiceRefusal(c, m, nowSec, null) === null && (c !== "Resolve" || resolvable),
  );
}

/**
 * Resolve's asserts on the attestations themselves, in Truthoracle.daml's order — each assert over
 * every attestation before the next: fetched (known and active), of this market, from an
 * allowlisted source, read inside [expiresAt, expiresAt + grace], a signature and pinned key the
 * ledger's secp256k1 can parse. The ONE judgement of an attestation: `validate` passes the
 * requested set (through `attestationsRefusal`), the GET one indexed attestation at a time.
 */
export function attestationAssertsRefusal(
  m: ResolutionMarket,
  facts: AttestationFacts[],
): ResolutionRefusal | null {
  const id = `market #${m.marketId}`;
  const rows: NonNullable<AttestationFacts["row"]>[] = [];
  for (const { cid, row } of facts) {
    if (!row)
      return refusal("attestation_unknown", `attestation ${cid} is not in the ledger index`, cid);
    if (!row.active)
      return refusal("attestation_archived", `attestation ${cid} is no longer active`, cid);
    rows.push(row);
  }
  const cidOf = (i: number): string => facts[i].cid;
  const other = rows.findIndex((a) => a.marketId !== m.marketId);
  if (other >= 0)
    return refusal(
      "attestation_other_market",
      `attestation ${cidOf(other)} is about market #${rows[other].marketId}, not ${id}`,
      cidOf(other),
    );
  const source = rows.findIndex((a) => !m.policy.sources.includes(a.sourceUri));
  if (source >= 0)
    return refusal(
      "attestation_source",
      `attestation ${cidOf(source)} reads ${rows[source].sourceUri}, which is not in the source allowlist of ${id}`,
      cidOf(source),
    );
  const w = resolutionWindows(m.expiresAtSec, m.gracePeriodSecs);
  const late = rows.findIndex(
    (a) => a.fetchedAtSec < w.resolveFrom || a.fetchedAtSec > w.resolveT0To,
  );
  if (late >= 0)
    return refusal(
      "attestation_window",
      `attestation ${cidOf(late)} was read at ${iso(rows[late].fetchedAtSec)}, outside ${iso(w.resolveFrom)} … ${iso(w.resolveT0To)}`,
      cidOf(late),
    );
  const malformed = rows.findIndex((a) => firstPartyOf(m, a) === "malformed");
  if (malformed >= 0)
    return refusal(
      "attestation_malformed",
      `attestation ${cidOf(malformed)}: its signature or the pinned key of ${rows[malformed].sourceUri} is not DER-encoded; the ledger would abort`,
      cidOf(malformed),
    );
  return null;
}

/**
 * Resolve's attestation asserts, in Truthoracle.daml's order: each attestation's own
 * (`attestationAssertsRefusal`); then T1 (a pinned source's signature verifies) or T2 (the
 * reporter quorum agrees); then one outcome.
 */
export function attestationsRefusal(
  m: ResolutionMarket,
  facts: AttestationFacts[],
): ResolutionRefusal | null {
  const own = attestationAssertsRefusal(m, facts);
  if (own) return own;
  const rows = facts.flatMap((f) => (f.row ? [f.row] : []));
  const firstParty = rows.some((a) => firstPartyOf(m, a) === "verified");
  const reporters = rows.filter((a) => m.policy.reporters.includes(a.attester));
  const quorumMet =
    m.policy.quorum > 0 &&
    new Set(reporters.map((a) => a.attester)).size >= m.policy.quorum &&
    new Set(reporters.map((a) => a.outcome)).size === 1;
  if (!firstParty && !quorumMet)
    return {
      reason: "no_tier",
      message: `no resolution tier is satisfied: no pinned source's signature verifies and the reporter quorum (${m.policy.quorum}) is not met`,
    };
  if (rows.some((a) => a.outcome !== rows[0].outcome))
    return { reason: "attestations_disagree", message: "the attestations disagree on the outcome" };
  return null;
}

/**
 * lookupSourceKey (the first pinned key of the attestation's source), then `firstPartyCheck`;
 * null when the source has no pinned key.
 */
function firstPartyOf(
  m: ResolutionMarket,
  a: NonNullable<AttestationFacts["row"]>,
): ReturnType<typeof firstPartyCheck> | null {
  const key = m.policy.sourceKeys.find((k) => k.sourceUri === a.sourceUri)?.publicKey;
  return key === undefined ? null : firstPartyCheck(key, a);
}

/**
 * Truthoracle.daml `verifyFirstParty`: the source's secp256k1 signature (DER hex) over
 * sha256(bytes of payloadHash) under the pinned DER public key — what DA.Crypto.Text.secp256k1
 * verifies. "malformed": hex the ledger's secp256k1 refuses with an error (the whole Resolve
 * aborts) — a non-DER signature or key, or a key that does not parse.
 */
export function firstPartyCheck(
  pinnedKey: string,
  a: { sourceSignature: string | null; payloadHash: string },
): "verified" | "unverified" | "malformed" {
  const sig = a.sourceSignature;
  if (sig === null || !isBytesHex(sig) || !isBytesHex(a.payloadHash) || !isBytesHex(pinnedKey))
    return "unverified";
  if (!isDerEncoded(sig) || !isDerEncoded(pinnedKey)) return "malformed";
  try {
    const key = createPublicKey({
      key: Buffer.from(pinnedKey, "hex"),
      format: "der",
      type: "spki",
    });
    return verify("sha256", Buffer.from(a.payloadHash, "hex"), key, Buffer.from(sig, "hex"))
      ? "verified"
      : "unverified";
  } catch {
    return "malformed";
  }
}

/** Daml's isBytesHex: even-length hex. */
export function isBytesHex(t: string): boolean {
  return t.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(t);
}

/** DA.Crypto.Text's isDEREncoded: a SEQUENCE whose one-byte length covers exactly the rest. */
export function isDerEncoded(t: string): boolean {
  return (
    isBytesHex(t) && t.slice(0, 2) === "30" && t.length === 2 * (2 + parseInt(t.slice(2, 4), 16))
  );
}

// ───────────────────────────────────────────── the submission ─────────────────────────────────

/** The contract's Outcome constructor for a requested outcome (JSON Ledger API: the bare name). */
export function damlOutcome(o: MarketResolutionOutcome): MarketOutcome {
  return o === "Void" ? "VoidOutcome" : o;
}

export function apiOutcome(o: MarketOutcome): MarketResolutionOutcome {
  return o === "VoidOutcome" ? "Void" : o;
}

/** The exercise argument, `nowSeconds` from the backend's clock (Daml `Int` → a decimal string). */
export function choiceArgumentOf(p: ResolutionParams, nowSec: number): Record<string, unknown> {
  const nowSeconds = String(nowSec);
  if (p.choice === "ResolveT0")
    return {
      resolvedOutcome: damlOutcome(p.outcome as MarketResolutionOutcome),
      sourceUri: p.sourceUri,
      nowSeconds,
    };
  if (p.choice === "Resolve")
    return { attestationCids: [...(p.attestationCids ?? [])], nowSeconds };
  return { nowSeconds };
}

/** One submission per approval: a re-executed approval collides on ledger command dedup. */
export function resolutionCommandId(marketId: string, approvalId: string): string {
  return `market-resolve-${marketId}-${approvalId}`;
}

/** The outcome the submission decides: the request's, the attestations' (Resolve), Void (VoidMarket). */
export function resolvedOutcomeOf(
  p: ResolutionParams,
  s: Pick<ApiMarketResolutionSnapshot, "attestations">,
): MarketResolutionOutcome | null {
  if (p.choice === "ResolveT0") return p.outcome ?? null;
  if (p.choice === "VoidMarket") return "Void";
  const first = s.attestations?.[0]?.outcome;
  return first ? apiOutcome(first) : null;
}

/** `<choice> market #<id> (<ticker>) → <outcome> from <source>`. */
export function describeResolution(
  p: ResolutionParams,
  s: Pick<
    ApiMarketResolutionSnapshot,
    "marketId" | "ticker" | "expiresAt" | "gracePeriodSecs" | "attestations"
  >,
): string {
  const head = `${p.choice} market #${s.marketId} (${s.ticker}) → ${resolvedOutcomeOf(p, s) ?? "?"}`;
  if (p.choice === "ResolveT0") return `${head} from ${p.sourceUri}`;
  if (p.choice === "Resolve") {
    const n = p.attestationCids?.length ?? 0;
    return `${head} from ${n} attestation${n === 1 ? "" : "s"}`;
  }
  const end = Date.parse(s.expiresAt) / 1000 + s.gracePeriodSecs;
  return `${head} from no resolution by ${iso(end)}`;
}

/** A refusal on the wire: `409 market_not_resolvable` with the slug in `details.reason`. */
export function notResolvable(
  r: ResolutionRefusal,
  choice: MarketResolutionChoice,
  marketId: string,
): ApiError {
  return new ApiError(409, "market_not_resolvable", r.message, {
    reason: r.reason,
    choice,
    marketId,
    ...(r.details ?? {}),
  });
}

function statusRefusal(
  id: string,
  choice: MarketResolutionChoice,
  status: MarketStatus,
  needs: string,
): ResolutionRefusal {
  return {
    reason: "status",
    message: `${id} is ${status}; ${choice} needs ${needs}`,
    details: { status },
  };
}

function notExpired(id: string, choice: MarketResolutionChoice, at: number): ResolutionRefusal {
  return {
    reason: "not_expired",
    message: `${id} expires at ${iso(at)}; ${choice} opens then`,
    details: { opensAt: iso(at) },
  };
}

function refusal(reason: string, message: string, cid: string): ResolutionRefusal {
  return { reason, message, details: { cid } };
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function invalid(message: string): never {
  throw new ApiError(400, "validation_failed", message);
}
