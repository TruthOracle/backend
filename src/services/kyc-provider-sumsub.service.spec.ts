import { createHmac } from "node:crypto";

import {
  acceptedDigestAlgorithms,
  interpretSumsubProbe,
  normaliseSumsubApplicant,
  parseSumsubEvent,
  parseSumsubTimestamp,
  redactSumsubPayload,
  signSumsubRequest,
  verifySumsubDigest,
} from "./kyc-provider-sumsub.service";

describe("Sumsub adapter (§9.1) — locally computed vectors", () => {
  it("signs requests as hex(HMAC-SHA256(secret, ts + METHOD + path + body))", () => {
    const expected = createHmac("sha256", "secret-key").update("1700000000GET/resources/applicants/abc/one", "utf8").digest("hex");
    expect(signSumsubRequest("secret-key", 1700000000, "get", "/resources/applicants/abc/one")).toBe(expected);
    const withBody = createHmac("sha256", "secret-key").update('1700000000POST/resources/accessTokens/sdk{"userId":"u"}', "utf8").digest("hex");
    expect(signSumsubRequest("secret-key", "1700000000", "POST", "/resources/accessTokens/sdk", '{"userId":"u"}')).toBe(withBody);
  });

  it("verifies the webhook digest over the raw body with both headers required and the algorithm allow-listed", () => {
    const raw = Buffer.from('{"type":"applicantReviewed"}', "utf8");
    const sha256 = createHmac("sha256", "wh").update(raw).digest("hex");
    const sha1 = createHmac("sha1", "wh").update(raw).digest("hex");
    expect(verifySumsubDigest(raw, { "x-payload-digest": sha256, "x-payload-digest-alg": "HMAC_SHA256_HEX" }, "wh", false)).toBe(true);
    expect(verifySumsubDigest(raw, { "X-Payload-Digest": sha256.toUpperCase(), "X-Payload-Digest-Alg": "hmac_sha256_hex" }, "wh", false)).toBe(true);
    expect(verifySumsubDigest(raw, { "x-payload-digest": sha256 }, "wh", false)).toBe(false);
    expect(verifySumsubDigest(raw, { "x-payload-digest-alg": "HMAC_SHA256_HEX" }, "wh", false)).toBe(false);
    expect(verifySumsubDigest(raw, { "x-payload-digest": sha256, "x-payload-digest-alg": "HMAC_MD5_HEX" }, "wh", false)).toBe(false);
    expect(verifySumsubDigest(raw, { "x-payload-digest": sha1, "x-payload-digest-alg": "HMAC_SHA1_HEX" }, "wh", false)).toBe(false);
    expect(verifySumsubDigest(raw, { "x-payload-digest": sha1, "x-payload-digest-alg": "HMAC_SHA1_HEX" }, "wh", true)).toBe(true);
    expect(verifySumsubDigest(raw, { "x-payload-digest": "zz", "x-payload-digest-alg": "HMAC_SHA256_HEX" }, "wh", false)).toBe(false);
    expect(verifySumsubDigest(raw, { "x-payload-digest": sha256, "x-payload-digest-alg": "HMAC_SHA256_HEX" }, "", false)).toBe(false);
  });

  it("parses Sumsub timestamps: UTC without designator, ISO, epoch ms, and falls back otherwise", () => {
    expect(parseSumsubTimestamp("2020-02-21 13:23:19.002").toISOString()).toBe("2020-02-21T13:23:19.002Z");
    expect(parseSumsubTimestamp("2020-02-21T13:23:19Z").toISOString()).toBe("2020-02-21T13:23:19.000Z");
    expect(parseSumsubTimestamp(1582291399002).toISOString()).toBe("2020-02-21T13:23:19.002Z");
    const fallback = new Date("2026-01-01T00:00:00Z");
    expect(parseSumsubTimestamp("not a date", fallback)).toBe(fallback);
    expect(parseSumsubTimestamp(undefined, fallback)).toBe(fallback);
  });

  it("normalises webhook events: type → kind, answer / reject type / labels, sandbox flags, comment cap", () => {
    const event = parseSumsubEvent(
      {
        type: "applicantReviewed",
        applicantId: "a1",
        externalUserId: "u1",
        levelName: "basic-kyc-level",
        reviewResult: { reviewAnswer: "RED", reviewRejectType: "RETRY", rejectLabels: ["bad_proof_of_identity"], moderationComment: "x".repeat(600), clientComment: "internal" },
        createdAtMs: "2026-09-10 10:00:00.000",
        sandboxMode: true,
      },
      "key",
    );
    expect(event).toMatchObject({ kind: "reviewed", answer: "RED", rejectType: "RETRY", labels: ["BAD_PROOF_OF_IDENTITY"], sandbox: true, eventKey: "key", applicantId: "a1", externalUserId: "u1" });
    expect(event?.moderationComment).toHaveLength(500);
    expect(parseSumsubEvent({ type: "applicantPending" }, "k")).toMatchObject({ kind: "pending", labels: [] });
    expect(parseSumsubEvent({ type: "applicantWorkflowCompleted", reviewResult: {} }, "k")).toMatchObject({ kind: "reviewed" });
    expect(parseSumsubEvent({ type: "applicantWorkflowCompleted", reviewResult: {} }, "k")?.answer).toBeUndefined();
    expect(parseSumsubEvent({ type: "applicantTagsChanged" }, "k")?.kind).toBe("unknown");
    for (const t of ["applicantReset", "applicantDeleted", "applicantDeactivated"]) expect(parseSumsubEvent({ type: t }, "k")?.kind).toBe("reset");
    expect(parseSumsubEvent({ type: "applicantOnHold" }, "k")?.kind).toBe("onHold");
    // Waiting states and partial resets keep the attempt in flight; a failed workflow needs an operator.
    for (const t of ["applicantAwaitingUser", "applicantAwaitingService", "applicantStepsReset"]) expect(parseSumsubEvent({ type: t }, "k")?.kind).toBe("pending");
    expect(parseSumsubEvent({ type: "applicantWorkflowFailed" }, "k")?.kind).toBe("onHold");
    for (const t of ["applicantLevelChanged", "applicantActivated", "applicantPersonalInfoChanged", "applicantActionReviewed"]) expect(parseSumsubEvent({ type: t }, "k")?.kind).toBe("unknown");
    expect(parseSumsubEvent({}, "k")).toBeNull();
    expect(parseSumsubEvent("nope", "k")).toBeNull();
  });

  it("redacts clientComment wherever it appears and keeps everything else", () => {
    expect(redactSumsubPayload({ a: 1, clientComment: "x", reviewResult: { clientComment: "y", reviewAnswer: "GREEN" }, list: [{ clientComment: "z", ok: true }] })).toEqual({
      a: 1,
      reviewResult: { reviewAnswer: "GREEN" },
      list: [{ ok: true }],
    });
  });

  it("normalises an applicant: the answer counts only once the review is completed; documents keep type/country/number; names prefer the transliterated fields", () => {
    const completed = normaliseSumsubApplicant({
      review: { reviewStatus: "completed", levelName: "basic-kyc-level", reviewResult: { reviewAnswer: "GREEN", rejectLabels: [] } },
      info: { firstName: "Йана", firstNameEn: "Jana", lastName: "Доу", lastNameEn: "Doe", dob: "1990-01-01", country: "IND", idDocs: [{ idDocType: "PASSPORT", country: "IND", number: "Z1", dob: "1990-01-01" }, { idDocType: "", country: "IND", number: "x" }] },
      sandboxMode: false,
    });
    expect(completed).toEqual({
      answer: "GREEN",
      rejectType: null,
      labels: [],
      levelName: "basic-kyc-level",
      sandbox: false,
      documents: [{ docType: "PASSPORT", country: "IND", number: "Z1", dob: "1990-01-01" }],
      person: { firstName: "Jana", lastName: "Doe", dob: "1990-01-01", country: "IND" },
    });
    const pending = normaliseSumsubApplicant({ review: { reviewStatus: "pending", reviewResult: { reviewAnswer: "GREEN" } }, info: {} });
    expect(pending).toMatchObject({ answer: null, rejectType: null, documents: [], person: { firstName: null, lastName: null, dob: null, country: null }, levelName: null });
    const red = normaliseSumsubApplicant({ review: { reviewStatus: "completed", reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL", rejectLabels: ["duplicate"] } }, testMode: true });
    expect(red).toMatchObject({ answer: "RED", rejectType: "FINAL", labels: ["DUPLICATE"], sandbox: true });
  });
});

describe("Sumsub adapter — operator probe (docs/KYC.md §6)", () => {
  it("accepts sha256 / sha512 digests by default and sha1 only when allowed", () => {
    expect(acceptedDigestAlgorithms(false)).toEqual(["HMAC_SHA256_HEX", "HMAC_SHA512_HEX"]);
    expect(acceptedDigestAlgorithms(true)).toEqual(["HMAC_SHA256_HEX", "HMAC_SHA512_HEX", "HMAC_SHA1_HEX"]);
  });

  it("reads the probe: 404 = credentials and signature accepted; 401 / 403 / unreachable are named", () => {
    expect(interpretSumsubProbe(404)).toEqual({ ok: true, message: "Sumsub accepted the app token and the request signature" });
    expect(interpretSumsubProbe(200).ok).toBe(true);
    expect(interpretSumsubProbe(401).ok).toBe(false);
    expect(interpretSumsubProbe(401).message).toContain("SUMSUB_APP_TOKEN / SUMSUB_SECRET_KEY");
    expect(interpretSumsubProbe(403).ok).toBe(false);
    expect(interpretSumsubProbe(403).message).toContain("View applicants");
    expect(interpretSumsubProbe(0, "getaddrinfo ENOTFOUND")).toEqual({ ok: false, message: "Sumsub is unreachable: getaddrinfo ENOTFOUND" });
    expect(interpretSumsubProbe(500)).toMatchObject({ ok: false, message: "Sumsub answered HTTP 500" });
  });
});
