import { createHash, generateKeyPairSync, sign } from "node:crypto";

import type { ApiError } from "../util/errors";
import {
  attestationAssertsRefusal,
  type AttestationFacts,
  attestationsRefusal,
  choiceArgumentOf,
  choiceRefusal,
  choicesAvailable,
  describeResolution,
  firstPartyCheck,
  isDerEncoded,
  marketIdParam,
  type ResolutionMarket,
  resolutionCommandId,
  resolutionParams,
  resolutionWindows,
} from "./market-resolution.logic";

const E = 1_800_000_000; // expiresAt
const G = 86_400; // grace
const SRC = "https://source.test/price";

function market(patch: Partial<ResolutionMarket> = {}, policy = {}): ResolutionMarket {
  return {
    marketId: 7,
    status: "Trading",
    archived: false,
    expiresAtSec: E,
    gracePeriodSecs: G,
    ...patch,
    policy: {
      operatorResolution: true,
      sources: [SRC],
      sourceKeys: [],
      reporters: ["r1", "r2", "r3"],
      quorum: 2,
      ...policy,
    },
  };
}

function att(
  cid: string,
  patch: Partial<NonNullable<AttestationFacts["row"]>> = {},
): AttestationFacts {
  return {
    cid,
    row: {
      active: true,
      marketId: 7,
      attester: "r1",
      sourceUri: SRC,
      fetchedAtSec: E + 60,
      outcome: "Yes",
      payloadHash: "ab".repeat(32),
      sourceSignature: null,
      ...patch,
    },
  };
}

const reasonOf = (r: { reason: string } | null): string | null => r?.reason ?? null;

function thrown(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    return err as ApiError;
  }
  throw new Error("expected a throw");
}

describe("market resolution rules (review F0; Truthoracle.daml ResolveT0 / Resolve / VoidMarket)", () => {
  it("windows are whole seconds, inclusive: T0 [E, E+G], Resolve from E, Void from E+G+1", () => {
    expect(resolutionWindows(E, G)).toEqual({
      resolveT0From: E,
      resolveT0To: E + G,
      resolveFrom: E,
      voidFrom: E + G + 1,
    });
    const m = market();
    const at = (choice: "ResolveT0" | "Resolve" | "VoidMarket", t: number) =>
      reasonOf(choiceRefusal(choice, m, t, SRC));
    expect(at("ResolveT0", E - 1)).toBe("not_expired");
    expect(at("ResolveT0", E)).toBeNull();
    expect(at("ResolveT0", E + G)).toBeNull();
    expect(at("ResolveT0", E + G + 1)).toBe("window_closed");
    expect(at("Resolve", E - 1)).toBe("not_expired");
    expect(at("Resolve", E)).toBeNull();
    expect(at("Resolve", E + 10 * G)).toBeNull();
    expect(at("VoidMarket", E + G)).toBe("grace_not_elapsed");
    expect(at("VoidMarket", E + G + 1)).toBeNull();
  });

  it("status, policy, source allowlist and archive refuse like the contract", () => {
    const now = E + 60;
    expect(reasonOf(choiceRefusal("ResolveT0", market({ status: "Proposed" }), now, SRC))).toBe(
      "status",
    );
    expect(
      reasonOf(choiceRefusal("Resolve", market({ status: "Proposed" }), now, null)),
    ).toBeNull();
    expect(reasonOf(choiceRefusal("Resolve", market({ status: "Resolved" }), now, null))).toBe(
      "status",
    );
    expect(
      reasonOf(choiceRefusal("VoidMarket", market({ status: "Voided" }), E + G + 1, null)),
    ).toBe("status");
    expect(
      reasonOf(choiceRefusal("ResolveT0", market({}, { operatorResolution: false }), now, SRC)),
    ).toBe("operator_resolution_off");
    expect(reasonOf(choiceRefusal("ResolveT0", market(), now, "https://other.test/x"))).toBe(
      "source_not_allowed",
    );
    // An empty allowlist admits any source (`null policy.sources`).
    expect(
      choiceRefusal("ResolveT0", market({}, { sources: [] }), now, "https://other.test/x"),
    ).toBeNull();
    expect(reasonOf(choiceRefusal("VoidMarket", market({ archived: true }), E + G + 1, null))).toBe(
      "archived",
    );
  });

  it("the choices open by the clock; Resolve only where the policy can ever admit attestations", () => {
    expect(choicesAvailable(market(), E - 1)).toEqual([]);
    expect(choicesAvailable(market(), E + 60)).toEqual(["ResolveT0", "Resolve"]);
    expect(choicesAvailable(market(), E + G + 1)).toEqual(["Resolve", "VoidMarket"]);
    expect(choicesAvailable(market({ status: "Proposed" }), E + 60)).toEqual(["Resolve"]);
    expect(choicesAvailable(market({ status: "Resolved" }), E + G + 1)).toEqual([]);
    expect(choicesAvailable(market({}, { sources: [] }), E + 60)).toEqual(["ResolveT0"]);
    expect(choicesAvailable(market({}, { quorum: 0 }), E + 60)).toEqual(["ResolveT0"]);
    expect(choicesAvailable(market({}, { quorum: 4 }), E + 60)).toEqual(["ResolveT0"]);
    expect(
      choicesAvailable(
        market({}, { quorum: 0, sourceKeys: [{ sourceUri: SRC, publicKey: "30" }] }),
        E + 60,
      ),
    ).toEqual(["ResolveT0", "Resolve"]);
  });

  it("params: exactly the fields a choice takes; Void stays the API's name", () => {
    expect(
      resolutionParams({ choice: "ResolveT0", outcome: "Void", sourceUri: ` ${SRC} ` }),
    ).toEqual({ choice: "ResolveT0", outcome: "Void", sourceUri: SRC });
    expect(resolutionParams({ choice: "Resolve", attestationCids: ["a", "b"] })).toEqual({
      choice: "Resolve",
      attestationCids: ["a", "b"],
    });
    expect(resolutionParams({ choice: "VoidMarket", outcome: null })).toEqual({
      choice: "VoidMarket",
    });
    const refused = (raw: Record<string, unknown>) => thrown(() => resolutionParams(raw));
    for (const raw of [
      { choice: "Settle" },
      { choice: "VoidMarket", nowSeconds: "1" },
      { choice: "VoidMarket", outcome: "Yes" },
      { choice: "ResolveT0", outcome: "Yes" },
      { choice: "ResolveT0", sourceUri: SRC },
      { choice: "ResolveT0", outcome: "VoidOutcome", sourceUri: SRC },
      { choice: "ResolveT0", outcome: "Yes", sourceUri: "ftp://x.test/a" },
      { choice: "ResolveT0", outcome: "Yes", sourceUri: "operator" },
      { choice: "ResolveT0", outcome: "Yes", sourceUri: `https://x.test/${"a".repeat(2040)}` },
      { choice: "ResolveT0", outcome: "Yes", sourceUri: SRC, attestationCids: ["a"] },
      { choice: "Resolve" },
      { choice: "Resolve", attestationCids: [] },
      { choice: "Resolve", attestationCids: Array.from({ length: 51 }, (_, i) => `c${i}`) },
      { choice: "Resolve", attestationCids: ["a", "a"] },
      { choice: "Resolve", attestationCids: ["a b"] },
      { choice: "Resolve", attestationCids: ["a"], sourceUri: SRC },
    ])
      expect(refused(raw)).toMatchObject({ status: 400, code: "validation_failed" });
  });

  it("the market id is canonical; the command id is the approval's", () => {
    expect(marketIdParam("007")).toBe("7");
    for (const raw of ["", "-1", "1.5", "abc", "1".repeat(16)])
      expect(thrown(() => marketIdParam(raw))).toMatchObject({ status: 400 });
    expect(resolutionCommandId("7", "a-b")).toBe("market-resolve-7-a-b");
  });
});

describe("Resolve's attestation checks (Truthoracle.daml Resolve, verifyFirstParty)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const KEY = publicKey.export({ type: "spki", format: "der" }).toString("hex");
  const HASH = createHash("sha256").update("the source's verbatim response").digest("hex");
  // DA.Crypto.Text.secp256k1 verifies over sha256 of the message BYTES (the hex decoded).
  const SIG = sign("sha256", Buffer.from(HASH, "hex"), privateKey).toString("hex");
  const t1 = (policy = {}) =>
    market({}, { quorum: 0, sourceKeys: [{ sourceUri: SRC, publicKey: KEY }], ...policy });

  it("each attestation must be indexed, active, of this market, allowlisted and read inside the window", () => {
    const m = market();
    const check = (facts: AttestationFacts[]) => reasonOf(attestationsRefusal(m, facts));
    expect(check([att("a"), att("b", { attester: "r2" })])).toBeNull();
    expect(check([att("a"), { cid: "zz", row: null }])).toBe("attestation_unknown");
    expect(check([att("a", { active: false })])).toBe("attestation_archived");
    expect(check([att("a"), att("b", { attester: "r2", marketId: 8 })])).toBe(
      "attestation_other_market",
    );
    expect(check([att("a"), att("b", { attester: "r2", sourceUri: "https://x.test" })])).toBe(
      "attestation_source",
    );
    expect(check([att("a", { fetchedAtSec: E - 1 }), att("b", { attester: "r2" })])).toBe(
      "attestation_window",
    );
    expect(
      check([att("a", { fetchedAtSec: E }), att("b", { attester: "r2", fetchedAtSec: E + G })]),
    ).toBeNull();
    expect(check([att("a"), att("b", { attester: "r2", fetchedAtSec: E + G + 1 })])).toBe(
      "attestation_window",
    );
    expect(attestationsRefusal(m, [att("a"), { cid: "zz", row: null }])).toMatchObject({
      details: { cid: "zz" },
    });
  });

  it("W9g F0: one attestation judged alone (the GET's usable / reason) is validate's own judgement: its asserts, never the set's tiers", () => {
    const m = t1();
    const alone = (f: AttestationFacts) => reasonOf(attestationAssertsRefusal(m, [f]));
    const cases: [AttestationFacts, string | null][] = [
      [att("ok", { sourceSignature: SIG, payloadHash: HASH }), null],
      [att("no-sig"), null], // usable: it fails no assert of its own (the tiers judge the set)
      [att("arch", { active: false }), "attestation_archived"],
      [att("other", { marketId: 8 }), "attestation_other_market"],
      [att("src", { sourceUri: "https://x.test" }), "attestation_source"],
      [att("early", { fetchedAtSec: E - 1 }), "attestation_window"],
      [att("bad-der", { sourceSignature: "abcd" }), "attestation_malformed"],
    ];
    for (const [f, reason] of cases) {
      expect(alone(f)).toBe(reason);
      // validate (the set with a good one) names the same reason for the same attestation.
      const set = [att("ok", { sourceSignature: SIG, payloadHash: HASH }), f];
      if (reason)
        expect(attestationsRefusal(m, set)).toMatchObject({ reason, details: { cid: f.cid } });
    }
    expect(reasonOf(attestationsRefusal(m, [att("no-sig")]))).toBe("no_tier");
  });

  it("T2: distinct allowlisted reporters reach the quorum on one outcome; all attestations agree", () => {
    const m = market();
    const check = (facts: AttestationFacts[]) => reasonOf(attestationsRefusal(m, facts));
    // One reporter twice is one signer.
    expect(check([att("a"), att("b")])).toBe("no_tier");
    // A non-reporter does not count.
    expect(check([att("a"), att("b", { attester: "outsider" })])).toBe("no_tier");
    expect(check([att("a"), att("b", { attester: "r2", outcome: "No" })])).toBe("no_tier");
    expect(
      check([
        att("a"),
        att("b", { attester: "r2" }),
        att("c", { attester: "outsider", outcome: "No" }),
      ]),
    ).toBe("attestations_disagree");
    expect(
      check([
        att("a", { outcome: "VoidOutcome" }),
        att("b", { attester: "r2", outcome: "VoidOutcome" }),
      ]),
    ).toBeNull();
  });

  it("T1: a pinned source's secp256k1 signature over sha256(payload bytes) verifies; a wrong or malformed one does not", () => {
    expect(firstPartyCheck(KEY, { sourceSignature: SIG, payloadHash: HASH })).toBe("verified");
    expect(
      reasonOf(attestationsRefusal(t1(), [att("a", { payloadHash: HASH, sourceSignature: SIG })])),
    ).toBeNull();
    // Signed over the hex TEXT instead of its bytes: not what the ledger checks.
    const overText = sign("sha256", Buffer.from(HASH, "utf8"), privateKey).toString("hex");
    expect(firstPartyCheck(KEY, { sourceSignature: overText, payloadHash: HASH })).toBe(
      "unverified",
    );
    const other = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey;
    const foreign = sign("sha256", Buffer.from(HASH, "hex"), other).toString("hex");
    expect(
      reasonOf(
        attestationsRefusal(t1(), [att("a", { payloadHash: HASH, sourceSignature: foreign })]),
      ),
    ).toBe("no_tier");
    // No signature, or no key pinned for the source: no T1.
    expect(reasonOf(attestationsRefusal(t1(), [att("a", { payloadHash: HASH })]))).toBe("no_tier");
    expect(
      reasonOf(
        attestationsRefusal(t1({ sourceKeys: [] }), [
          att("a", { payloadHash: HASH, sourceSignature: SIG }),
        ]),
      ),
    ).toBe("no_tier");
    // Hex that is not DER makes the ledger's secp256k1 abort the whole Resolve.
    expect(firstPartyCheck(KEY, { sourceSignature: "abcd", payloadHash: HASH })).toBe("malformed");
    expect(firstPartyCheck("3003abcdef", { sourceSignature: SIG, payloadHash: HASH })).toBe(
      "malformed",
    );
    expect(
      reasonOf(
        attestationsRefusal(t1(), [att("a", { payloadHash: HASH, sourceSignature: "abcd" })]),
      ),
    ).toBe("attestation_malformed");
    // Not even hex: verifyFirstParty is False before secp256k1 runs.
    expect(firstPartyCheck(KEY, { sourceSignature: "xyz!", payloadHash: HASH })).toBe("unverified");
  });

  it("DER per DA.Crypto.Text: 30, then a one-byte length covering the rest", () => {
    expect(isDerEncoded(KEY)).toBe(true);
    expect(isDerEncoded(SIG)).toBe(true);
    expect(isDerEncoded("3002abcd")).toBe(true);
    expect(isDerEncoded("3003abcd")).toBe(false);
    expect(isDerEncoded("3102abcd")).toBe(false);
    expect(isDerEncoded("3002abc")).toBe(false);
  });
});

describe("the submission (JSON Ledger API encoding, as the frontend's cantonCommands.ts)", () => {
  it("ResolveT0 / Resolve / VoidMarket arguments carry the backend clock as a Daml Int string", () => {
    expect(
      choiceArgumentOf({ choice: "ResolveT0", outcome: "Void", sourceUri: SRC }, E + 5),
    ).toEqual({
      resolvedOutcome: "VoidOutcome",
      sourceUri: SRC,
      nowSeconds: String(E + 5),
    });
    expect(
      choiceArgumentOf({ choice: "ResolveT0", outcome: "No", sourceUri: SRC }, E),
    ).toMatchObject({
      resolvedOutcome: "No",
    });
    expect(choiceArgumentOf({ choice: "Resolve", attestationCids: ["a", "b"] }, E)).toEqual({
      attestationCids: ["a", "b"],
      nowSeconds: String(E),
    });
    expect(choiceArgumentOf({ choice: "VoidMarket" }, E + G + 1)).toEqual({
      nowSeconds: String(E + G + 1),
    });
  });

  it("describe: <choice> market #<id> (<ticker>) → <outcome> from <source>", () => {
    const s = {
      marketId: "7",
      ticker: "FED-26MAR-CUT25",
      expiresAt: new Date(E * 1000).toISOString(),
      gracePeriodSecs: G,
    };
    expect(describeResolution({ choice: "ResolveT0", outcome: "Yes", sourceUri: SRC }, s)).toBe(
      `ResolveT0 market #7 (FED-26MAR-CUT25) → Yes from ${SRC}`,
    );
    expect(
      describeResolution(
        { choice: "Resolve", attestationCids: ["a", "b"] },
        {
          ...s,
          attestations: [
            { cid: "a", outcome: "VoidOutcome", sourceUri: SRC, fetchedAt: null },
            { cid: "b", outcome: "VoidOutcome", sourceUri: SRC, fetchedAt: null },
          ],
        },
      ),
    ).toBe("Resolve market #7 (FED-26MAR-CUT25) → Void from 2 attestations");
    expect(describeResolution({ choice: "VoidMarket" }, s)).toBe(
      `VoidMarket market #7 (FED-26MAR-CUT25) → Void from no resolution by ${new Date((E + G) * 1000).toISOString()}`,
    );
  });
});
