import { randomBytes, randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type { ApiChallenge, ChallengePurpose } from "../types";
import {
  describeAttempt,
  isValidPartyId,
  publicKeyMatchesParty,
  publicKeysEqual,
  publicKeyToBase64,
  verifyPartySignature,
} from "../util/canton-crypto";
import { ApiError } from "../util/errors";
import { MINUTE_MS } from "../util/time";
import { RedisService } from "./redis.service";

export const CHALLENGE_TTL_MS = 5 * MINUTE_MS;
export const CHALLENGE_PURPOSES: readonly ChallengePurpose[] = ["sign-in", "link-wallet", "admin-sign-in"];

interface ChallengeRecord {
  partyId: string;
  purpose: ChallengePurpose;
  sessionId: string | null;
  host: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface VerifiedChallenge {
  partyId: string;
  publicKeyBase64: string;
  purpose: ChallengePurpose;
  form: string;
}

/**
 * Canton wallet challenge / signature (docs/ARCHITECTURE.md §7.3). The record lives in Redis
 * (`wc:<id>`, 5 min); the message is regenerated from it — never trusted from the client — and
 * the claim is consumed BEFORE verification so a bad signature burns the challenge.
 */
@Injectable()
export class WalletChallengeService {
  private readonly logger = new Logger(WalletChallengeService.name);

  constructor(
    private readonly config: Config,
    private readonly redis: RedisService,
  ) {}

  buildMessage(record: ChallengeRecord): string {
    return [
      `TruthOracle ${record.purpose}`,
      `Domain: ${record.host}`,
      `URI: https://${record.host}`,
      `Network: ${this.config.appNetwork}`,
      `Party: ${record.partyId}`,
      `Nonce: ${record.nonce}`,
      `Issued: ${record.issuedAt}`,
      `Expires: ${record.expiresAt}`,
    ].join("\n");
  }

  async issue(input: {
    partyId: string;
    purpose: ChallengePurpose;
    sessionId?: string | null;
    host: string;
  }): Promise<ApiChallenge> {
    const partyId = String(input.partyId ?? "").trim();
    if (!isValidPartyId(partyId)) throw new ApiError(400, "validation_failed", "partyId is not a Canton party id");
    if (!CHALLENGE_PURPOSES.includes(input.purpose)) throw new ApiError(400, "validation_failed", "unknown challenge purpose");
    if (input.purpose === "link-wallet" && !input.sessionId) {
      throw new ApiError(401, "unauthenticated", "link-wallet challenges require a session");
    }
    if (input.purpose !== "link-wallet" && input.sessionId) {
      throw new ApiError(409, "challenge_purpose_mismatch", "sign-in challenges cannot be issued to an existing session; use link-wallet");
    }
    if (input.purpose === "admin-sign-in" && !this.config.adminOperators.has(partyId)) {
      throw new ApiError(403, "forbidden", "this party is not an operator");
    }
    const host = String(input.host ?? "").trim();
    if (!host) throw new ApiError(400, "validation_failed", "request host is unknown");

    const now = new Date();
    const record: ChallengeRecord = {
      partyId,
      purpose: input.purpose,
      sessionId: input.sessionId ?? null,
      host,
      nonce: randomBytes(16).toString("hex"),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
    };
    const challengeId = randomUUID();
    await this.redis.setJson(`wc:${challengeId}`, record, CHALLENGE_TTL_MS);
    return { challengeId, message: this.buildMessage(record), expiresAt: record.expiresAt };
  }

  async verify(input: {
    challengeId: string;
    partyId: string;
    publicKey: string;
    signature: string;
    expectedPurpose: ChallengePurpose | ChallengePurpose[];
    sessionId?: string | null;
  }): Promise<VerifiedChallenge> {
    const challengeId = String(input.challengeId ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(challengeId)) throw new ApiError(401, "challenge_rejected", "unknown challenge");

    // Consume first: whatever happens next, this challenge is spent.
    const record = await this.redis.getJson<ChallengeRecord>(`wc:${challengeId}`);
    await this.redis.del(`wc:${challengeId}`);
    if (!record) throw new ApiError(401, "challenge_rejected", "challenge unknown, expired or already used");
    if (Date.parse(record.expiresAt) <= Date.now()) throw new ApiError(401, "challenge_rejected", "challenge expired");

    const partyId = String(input.partyId ?? "").trim();
    if (partyId !== record.partyId) throw new ApiError(401, "challenge_rejected", "challenge was issued for another party");

    const expected = Array.isArray(input.expectedPurpose) ? input.expectedPurpose : [input.expectedPurpose];
    if (!expected.includes(record.purpose)) {
      throw new ApiError(401, "challenge_purpose_mismatch", `challenge purpose ${record.purpose} is not accepted here`);
    }
    // Purpose isolation: a link challenge is bound to the session it was issued to; sign-in
    // challenges must not be presented with a session.
    if (record.purpose === "link-wallet") {
      if (!input.sessionId || input.sessionId !== record.sessionId) {
        throw new ApiError(401, "challenge_purpose_mismatch", "link-wallet challenge was issued to another session");
      }
    } else if (input.sessionId) {
      throw new ApiError(401, "challenge_purpose_mismatch", "sign-in challenges cannot be used while signed in");
    }

    const publicKeyBase64 = publicKeyToBase64(input.publicKey);
    if (!publicKeyBase64) throw new ApiError(400, "validation_failed", "publicKey is not a 32-byte Ed25519 key");
    if (!publicKeyMatchesParty(input.publicKey, partyId)) {
      throw new ApiError(401, "wallet_key_mismatch", "this wallet's signing key is not its namespace key");
    }
    const pinned = this.config.adminOperators.get(partyId);
    if (pinned && !publicKeysEqual(pinned, input.publicKey)) {
      throw new ApiError(401, "wallet_key_mismatch", "this key is not the operator's pinned key");
    }
    if (record.purpose === "admin-sign-in" && !this.config.adminOperators.has(partyId)) {
      throw new ApiError(403, "forbidden", "this party is not an operator");
    }

    const message = this.buildMessage(record);
    const result = verifyPartySignature({ message, signature: input.signature, publicKey: input.publicKey });
    if (!result.ok) {
      this.logger.warn(`signature rejected for ${partyId.slice(0, 16)}…: ${result.reason} (${describeAttempt({ signature: input.signature, publicKey: input.publicKey })})`);
      throw new ApiError(401, "signature_invalid", "signature did not verify");
    }
    return { partyId, publicKeyBase64, purpose: record.purpose, form: result.form };
  }
}
