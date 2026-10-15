/**
 * Request DTOs for the instruments API (docs/TOKENS.md §4.1; docs/API.md "Instruments"). The
 * global ValidationPipe (`whitelist`, `forbidNonWhitelisted`) rejects unknown keys, so these are
 * the complete allow-list of what a client may send. `admin` is always a Canton party id and `id`
 * a token identifier; the pair is immutable once registered.
 */
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

import {
  INSTRUMENT_KINDS,
  REGISTRY_AUTHS,
  TREASURY_TRANSFER_MODES,
  type InstrumentKind,
  type RegistryAuth,
  type TreasuryTransferMode,
} from "../types";
import { PARTY_ID_RE } from "../util/canton-crypto";
import { AMOUNT_DECIMALS } from "../util/money";
import { REASON_MAX_LENGTH } from "./admin.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));

/** A CIP-56 token id as the registries spell them (`cBYN`, `TRO`, `Amulet`): 1–64 chars, no whitespace. */
export const INSTRUMENT_ID_INPUT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const URL_INPUT = /^https?:\/\/\S+$/i;

/** `{ admin, id }` — an instrument named in a request body (`POST /admin/markets.collateral`, reconcile). */
export class InstrumentIdDto {
  @trimmed()
  @IsString()
  @Matches(PARTY_ID_RE, { message: "admin must be a Canton party id (<hint>::1220<64 hex>)" })
  admin!: string;

  @trimmed()
  @IsString()
  @Matches(INSTRUMENT_ID_INPUT, {
    message: "id must be a token identifier (1–64 chars, no whitespace)",
  })
  id!: string;
}

/** `:admin/:id` route params of `/admin/instruments/:admin/:id`. */
export class InstrumentParamsDto extends InstrumentIdDto {}

/** Optional operator note recorded on the audit row. */
export class InstrumentReasonDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(REASON_MAX_LENGTH)
  reason?: string;
}

/** `POST /admin/instruments` */
export class CreateInstrumentDto extends InstrumentReasonDto {
  @trimmed()
  @IsString()
  @Matches(PARTY_ID_RE, { message: "admin must be a Canton party id (<hint>::1220<64 hex>)" })
  admin!: string;

  @trimmed()
  @IsString()
  @Matches(INSTRUMENT_ID_INPUT)
  id!: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(16)
  symbol?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsInt()
  @Min(0)
  @Max(AMOUNT_DECIMALS)
  decimals!: number;

  @IsIn(INSTRUMENT_KINDS)
  kind!: InstrumentKind;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefaultCollateral?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @trimmed()
  @IsString()
  @Matches(URL_INPUT, { message: "registryUrl must be an absolute http(s) URL" })
  @MaxLength(2000)
  registryUrl?: string | null;

  @IsOptional()
  @IsIn(REGISTRY_AUTHS)
  registryAuth?: RegistryAuth;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(TREASURY_TRANSFER_MODES)
  transferMode?: TreasuryTransferMode | null;

  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(INSTRUMENT_ID_INPUT)
  walletInstrumentId?: string;

  @IsOptional()
  @IsObject()
  setupChoices?: Record<string, string>;
}

/**
 * `POST /admin/instruments/:admin/:id/setup { autoAccept?, mintDelegation?, reason? }` — which
 * factory choices to exercise for the treasury (docs/TOKENS.md §4.4); at least one must be true.
 */
export class InstrumentSetupDto extends InstrumentReasonDto {
  @IsOptional()
  @IsBoolean()
  autoAccept?: boolean;

  @IsOptional()
  @IsBoolean()
  mintDelegation?: boolean;
}

/** `PATCH /admin/instruments/:admin/:id` — every field optional; the pair itself cannot change. */
export class UpdateInstrumentDto extends InstrumentReasonDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(16)
  symbol?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(AMOUNT_DECIMALS)
  decimals?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefaultCollateral?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @trimmed()
  @IsString()
  @Matches(URL_INPUT, { message: "registryUrl must be an absolute http(s) URL" })
  @MaxLength(2000)
  registryUrl?: string | null;

  @IsOptional()
  @IsIn(REGISTRY_AUTHS)
  registryAuth?: RegistryAuth;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(TREASURY_TRANSFER_MODES)
  transferMode?: TreasuryTransferMode | null;

  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(INSTRUMENT_ID_INPUT)
  walletInstrumentId?: string;

  @IsOptional()
  @IsObject()
  setupChoices?: Record<string, string>;
}
