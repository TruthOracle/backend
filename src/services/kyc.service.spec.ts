import type { KycVerificationEntity } from "../entities/kyc-verification.entity";
import type { KycWebhookEventEntity } from "../entities/kyc-webhook-event.entity";
import {
  canonicalDocKey,
  canonicalPersonKey,
  computeUserKycStatus,
  eventFromRow,
  fingerprintOf,
  gateDecision,
  isStaleEvent,
  nfkcUpper,
  personKeysFor,
  verificationToApi,
} from "./kyc.service";

const PEPPER = "p".repeat(32);

describe("KYC pure helpers (§9.2–9.4)", () => {
  it("canonical forms: NFKC upper-case, whitespace collapsed, alnum-only document numbers, ISO country letters", () => {
    expect(nfkcUpper("  straße  ﬁne ")).toBe("STRASSE FINE");
    expect(canonicalDocKey({ docType: "passport", country: "ind", number: " z-123 4567 " })).toBe(
      "IND|PASSPORT|Z1234567",
    );
    expect(canonicalDocKey({ docType: "VISA", country: "IND", number: "X" })).toBeNull();
    expect(canonicalDocKey({ docType: "PASSPORT", country: "", number: "X" })).toBeNull();
    expect(canonicalDocKey({ docType: "PASSPORT", country: "IND", number: "---" })).toBeNull();
    expect(
      canonicalPersonKey({
        firstName: "jane ",
        lastName: "doe",
        dob: "1990-01-01T00:00:00Z",
        country: "IND",
      }),
    ).toBe("IND|1990-01-01|DOE|JANE");
    expect(
      canonicalPersonKey({ firstName: "jane", lastName: "doe", dob: "01/01/1990", country: "IND" }),
    ).toBeNull();
    expect(
      canonicalPersonKey({ firstName: null, lastName: "doe", dob: "1990-01-01", country: "IND" }),
    ).toBeNull();
  });

  it("personKeysFor: one peppered doc key per usable document plus one person key, deduplicated", () => {
    const keys = personKeysFor(PEPPER, {
      answer: "GREEN",
      rejectType: null,
      labels: [],
      levelName: "basic-kyc-level",
      sandbox: false,
      documents: [
        { docType: "PASSPORT", country: "IND", number: "Z1234567" },
        { docType: "PASSPORT", country: "ind", number: "z-1234567" },
        { docType: "SELFIE", country: "IND", number: "" },
      ],
      person: { firstName: "Jane", lastName: "Doe", dob: "1990-01-01", country: "IND" },
    });
    expect(keys).toEqual([
      { kind: "doc", fingerprint: fingerprintOf(PEPPER, "IND|PASSPORT|Z1234567") },
      { kind: "person", fingerprint: fingerprintOf(PEPPER, "IND|1990-01-01|DOE|JANE") },
    ]);
    expect(keys[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf("other-pepper", "IND|PASSPORT|Z1234567")).not.toBe(keys[0].fingerprint);
    expect(
      personKeysFor(PEPPER, {
        answer: "GREEN",
        rejectType: null,
        labels: [],
        levelName: null,
        sandbox: false,
        documents: [],
        person: { firstName: null, lastName: null, dob: null, country: null },
      }),
    ).toEqual([]);
  });

  it("computeUserKycStatus: blocked_duplicate beats everything, a standing approval is never downgraded by a newer attempt, else the newest speaks", () => {
    const v = (
      id: string,
      status: KycVerificationEntity["status"],
    ): Pick<KycVerificationEntity, "id" | "status"> => ({ id, status });
    expect(computeUserKycStatus([v("2", "rejected_final"), v("1", "blocked_duplicate")])).toEqual({
      status: "blocked_duplicate",
      verificationId: "1",
    });
    expect(computeUserKycStatus([v("2", "initiated"), v("1", "approved")])).toEqual({
      status: "approved",
      verificationId: "1",
    });
    expect(computeUserKycStatus([v("2", "rejected_retry"), v("1", "approved")])).toEqual({
      status: "approved",
      verificationId: "1",
    });
    expect(computeUserKycStatus([v("2", "needs_review"), v("1", "rejected_final")])).toEqual({
      status: "pending",
      verificationId: "2",
    });
    expect(computeUserKycStatus([v("2", "rejected_retry"), v("1", "expired")])).toEqual({
      status: "rejected",
      verificationId: "2",
    });
    expect(computeUserKycStatus([v("1", "expired")])).toEqual({
      status: "none",
      verificationId: null,
    });
    expect(computeUserKycStatus([])).toEqual({ status: "none", verificationId: null });
  });

  it("isStaleEvent compares against the last applied provider event; nothing is stale before the first", () => {
    const t = (iso: string): Date => new Date(iso);
    expect(isStaleEvent(t("2026-09-10T09:00:00Z"), t("2026-09-10T10:00:00Z"))).toBe(true);
    expect(isStaleEvent(t("2026-09-10T10:00:00Z"), t("2026-09-10T10:00:00Z"))).toBe(false);
    expect(isStaleEvent(t("2026-09-10T11:00:00Z"), t("2026-09-10T10:00:00Z"))).toBe(false);
    expect(isStaleEvent(t("2026-09-10T09:00:00Z"), null)).toBe(false);
  });

  it("gateDecision: suspended always refused; enforcement off allows; duplicates refused; approval AND binding required", () => {
    const base = {
      enforce: true,
      userStatus: "active" as const,
      kycStatus: "approved" as const,
      hasApprovedAtLevel: true,
      hasBinding: true,
    };
    expect(gateDecision(base)).toEqual({ allowed: true });
    expect(gateDecision({ ...base, userStatus: "suspended" })).toEqual({
      allowed: false,
      reason: "user_suspended",
    });
    expect(
      gateDecision({
        ...base,
        enforce: false,
        kycStatus: "none",
        hasApprovedAtLevel: false,
        hasBinding: false,
      }),
    ).toEqual({ allowed: true });
    expect(gateDecision({ ...base, kycStatus: "blocked_duplicate" })).toEqual({
      allowed: false,
      reason: "kyc_duplicate_identity",
    });
    expect(gateDecision({ ...base, hasBinding: false })).toEqual({
      allowed: false,
      reason: "kyc_required",
    });
    expect(gateDecision({ ...base, hasApprovedAtLevel: false })).toEqual({
      allowed: false,
      reason: "kyc_required",
    });
  });

  it("eventFromRow rebuilds the stored event, maps unknown kinds to `unknown`, and returns null once the payload was purged", () => {
    const row = {
      payload: {
        event: {
          type: "applicantReviewed",
          applicantId: "a1",
          externalUserId: "u1",
          levelName: "basic-kyc-level",
          kind: "reviewed",
          answer: "RED",
          rejectType: "FINAL",
          labels: ["X", 3],
          occurredAt: "2026-09-10T10:00:00.000Z",
          sandbox: false,
          eventKey: "k",
          moderationComment: "m".repeat(600),
        },
      },
      occurredAt: new Date("2026-09-10T09:00:00.000Z"),
      sandbox: true,
      eventKey: "row-key",
      type: "applicantReviewed",
    } as Pick<KycWebhookEventEntity, "payload" | "occurredAt" | "sandbox" | "eventKey" | "type">;
    const event = eventFromRow(row);
    expect(event).toMatchObject({
      kind: "reviewed",
      answer: "RED",
      rejectType: "FINAL",
      labels: ["X"],
      eventKey: "k",
      sandbox: true,
      applicantId: "a1",
    });
    expect(event?.occurredAt.toISOString()).toBe("2026-09-10T10:00:00.000Z");
    expect(event?.moderationComment).toHaveLength(500);
    const stored = row.payload!.event as Record<string, unknown>;
    expect(
      eventFromRow({
        ...row,
        payload: {
          event: {
            ...stored,
            kind: "applicantTagsChanged",
            answer: "MAYBE",
            occurredAt: "garbage",
          },
        },
      }),
    ).toMatchObject({ kind: "unknown", occurredAt: row.occurredAt });
    expect(
      eventFromRow({
        ...row,
        payload: { event: { ...stored, kind: "applicantTagsChanged", answer: "MAYBE" } },
      })?.answer,
    ).toBeUndefined();
    expect(eventFromRow({ ...row, payload: null })).toBeNull();
  });

  it("verificationToApi exposes exactly the documented fields (never the operator's note or applicant ids)", () => {
    const api = verificationToApi({
      id: "v",
      userId: "u",
      provider: "admin",
      providerApplicantId: "app-1",
      levelName: "basic-kyc-level",
      attemptNo: 2,
      status: "approved",
      initiatedIdentityId: null,
      providerEventAt: null,
      rejectLabels: null,
      moderationComment: null,
      manual: true,
      manualReason: "secret",
      reviewedAt: new Date("2026-09-10T10:00:00.000Z"),
      createdAt: new Date("2026-09-10T09:00:00.000Z"),
      updatedAt: new Date(),
    });
    expect(api).toEqual({
      id: "v",
      provider: "admin",
      levelName: "basic-kyc-level",
      attemptNo: 2,
      status: "approved",
      rejectLabels: [],
      moderationComment: null,
      reviewedAt: "2026-09-10T10:00:00.000Z",
      createdAt: "2026-09-10T09:00:00.000Z",
    });
  });
});
