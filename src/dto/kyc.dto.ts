import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
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

// ── compliance identity (SPEC §11.1; stage S7a): the mock applicant beyond the fingerprinted person ──

/** One more way the document writes the name (be / ru Cyrillic, Latin). */
export class KycMockNameDto {
  @IsString()
  @Length(1, 200)
  firstName!: string;

  @IsString()
  @Length(1, 200)
  lastName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  middleName?: string;
}

/** The provider's AML screening as the mock reports it (absent = not screened). */
export class KycMockAmlDto {
  @IsOptional()
  @IsBoolean()
  pep?: boolean;

  @IsOptional()
  @IsBoolean()
  sanctions?: boolean;

  @IsOptional()
  @IsBoolean()
  adverseMedia?: boolean;
}

/** The art.8 data a real provider holds (names, birth place, residence, document dates, AML). */
export class KycMockIdentityDto {
  /** Every name form; default: the person's name. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => KycMockNameDto)
  names?: KycMockNameDto[];

  @IsOptional()
  @IsString()
  @Length(1, 200)
  birthPlace?: string;

  /** Default: the person's country. */
  @IsOptional()
  @Matches(ISO3, { message: "nationality must be an ISO-3166 alpha-3 code" })
  nationality?: string;

  /** Default: the person's country. */
  @IsOptional()
  @Matches(ISO3, { message: "residenceCountry must be an ISO-3166 alpha-3 code" })
  residenceCountry?: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  addressLine?: string;

  /** The first document's personal (identification) number. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  personalNumber?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: "docIssuedAt must be YYYY-MM-DD" })
  docIssuedAt?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: "docExpiresAt must be YYYY-MM-DD" })
  docExpiresAt?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => KycMockAmlDto)
  aml?: KycMockAmlDto;
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

  /** SPEC §11.1 (S7a): optional identity data beyond the person (defaults derive from it). */
  @IsOptional()
  @ValidateNested()
  @Type(() => KycMockIdentityDto)
  identity?: KycMockIdentityDto;
}
