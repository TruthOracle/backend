import { Injectable } from "@nestjs/common";

import { Config } from "../config";
import type { ApplicantSummary, KycEvent, KycProvider, KycSessionResult } from "../types";
import { ApiError } from "../util/errors";

/** Staged applicant data is discarded after this long even if nobody applied it. */
const STAGE_TTL_MS = 5 * 60_000;
const MOCK_SESSION_TTL_MS = 10 * 60_000;
/** The last summary per applicant is kept (bounded) so an admin override can re-read it, as it would from a real provider. */
const REMEMBERED_MAX = 500;

/**
 * Mock provider (ARCHITECTURE §9.1) — never in prod or on mainnet (config.ts refuses to boot).
 * `POST /kyc/mock/submit` stages an ApplicantSummary here in memory, then KycService runs the
 * identical pipeline it runs for Sumsub: a stored event → `applyEvent` → `fetchApplicant` →
 * fingerprints. Nothing here is persisted or logged; the stage is one process, one call — plus
 * the last summary per applicant, remembered in memory the way a real provider keeps applicant
 * data, so `POST /admin/users/:id/kyc/override approved` can re-read it in dev / tests.
 */
@Injectable()
export class KycProviderMockService implements KycProvider {
  readonly name = "mock" as const;
  private readonly staged = new Map<string, { summary: ApplicantSummary; expiresAt: number }>();
  private readonly remembered = new Map<string, ApplicantSummary>();

  constructor(private readonly config: Config) {}

  static applicantIdFor(userId: string): string {
    return `mock-${userId}`;
  }

  isConfigured(): boolean {
    return this.config.kycProvider === "mock" && !this.config.isMainnet && this.config.appEnv !== "prod";
  }

  async createSession(
    user: { id: string; email?: string | null },
    applicantId: string | null,
    _level: string,
  ): Promise<KycSessionResult> {
    return {
      accessToken: "mock",
      expiresAt: new Date(Date.now() + MOCK_SESSION_TTL_MS),
      applicantId: applicantId ?? KycProviderMockService.applicantIdFor(user.id),
    };
  }

  /** The mock has no webhooks: the mock controller drives the pipeline directly. */
  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): KycEvent | null {
    return null;
  }

  /** Hold applicant data in memory for the one `applyEvent` call that follows (and remember it for later re-reads). */
  stage(applicantId: string, summary: ApplicantSummary): void {
    this.sweep();
    this.staged.set(applicantId, { summary, expiresAt: Date.now() + STAGE_TTL_MS });
    this.remembered.delete(applicantId);
    this.remembered.set(applicantId, summary);
    if (this.remembered.size > REMEMBERED_MAX) {
      const oldest = this.remembered.keys().next().value;
      if (oldest !== undefined) this.remembered.delete(oldest);
    }
  }

  discard(applicantId: string): void {
    this.staged.delete(applicantId);
  }

  async fetchApplicant(applicantId: string): Promise<ApplicantSummary> {
    this.sweep();
    const hit = this.staged.get(applicantId)?.summary ?? this.remembered.get(applicantId);
    if (!hit) {
      throw new ApiError(502, "upstream_failed", "mock provider: no applicant data is known for this applicant");
    }
    return hit;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.staged) if (entry.expiresAt <= now) this.staged.delete(id);
  }
}
