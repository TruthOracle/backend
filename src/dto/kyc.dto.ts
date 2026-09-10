import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from "class-validator";

import type { KycDocType } from "../types";

/** Identity documents that can produce a `doc` fingerprint (ARCHITECTURE §9.3). */
export const KYC_DOC_TYPES = ["PASSPORT", "ID_CARD", "DRIVERS", "RESIDENCE_PERMIT"] as const;

export const KYC_MOCK_OUTCOMES = ["approved", "rejected_retry", "rejected_final"] as const;
export type KycMockOutcome = (typeof KYC_MOCK_OUTCOMES)[number];

const ISO3 = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mock provider input (docs/API.md `POST /kyc/mock/submit`). These values are fingerprinted
 * immediately and never persisted or logged — the DTO exists only for validation.
 */
export class KycMockPersonDto {
  @IsString()
  @Length(1, 200)
  firstName!: string;

  @IsString()
  @Length(1, 200)
  lastName!: string;

  @Matches(ISO_DATE, { message: "dob must be YYYY-MM-DD" })
  dob!: string;

  @Matches(ISO3, { message: "country must be an ISO-3166 alpha-3 code" })
  country!: string;
}

export class KycMockDocumentDto {
  @IsIn(KYC_DOC_TYPES as readonly string[])
  docType!: KycDocType;

  @Matches(ISO3, { message: "country must be an ISO-3166 alpha-3 code" })
  country!: string;

  @IsString()
  @Length(1, 64)
  number!: string;
}

export class KycMockSubmitDto {
  @IsUUID()
  verificationId!: string;

  @IsIn(KYC_MOCK_OUTCOMES as readonly string[])
  outcome!: KycMockOutcome;

  @ValidateNested()
  @Type(() => KycMockPersonDto)
  person!: KycMockPersonDto;

  /** May be empty: an approved outcome with no document lands in `needs_review` (§9.3). */
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => KycMockDocumentDto)
  documents!: KycMockDocumentDto[];
}
