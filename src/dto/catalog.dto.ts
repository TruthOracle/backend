/**
 * Request DTOs for the market catalog (docs/API.md "Catalog", "Admin — catalog"; docs/MARKETS.md).
 * The global ValidationPipe (`whitelist`, `forbidNonWhitelisted`) rejects unknown keys, so these
 * are the complete allow-list. Tickers are normalised (trimmed, upper-cased) by the service.
 */
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

import { EVENT_STATUS_FILTERS, SERIES_FREQUENCIES, type EventStatus, type SeriesFrequency } from "../types";
import { REASON_MAX_LENGTH } from "./admin.dto";
import { PageQueryDto } from "./common.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
const toBool = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    value === "true" || value === "1" || value === true
      ? true
      : value === "false" || value === "0" || value === false
        ? false
        : value,
  );

/** Loose on the wire (normalised by the service); tight enough to refuse junk early. */
const TICKER_INPUT = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const DECIMAL_INPUT = /^\d{1,28}(\.\d{1,10})?$/;

export class SettlementSourceDto {
  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @trimmed()
  @IsString()
  @MaxLength(2000)
  url!: string;
}

/** Optional operator note recorded on the audit row (catalog edits are presentational, so it is not required). */
export class CatalogReasonDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(REASON_MAX_LENGTH)
  reason?: string;
}

/** `GET /series?category=&status=&q=&page=&limit=` */
export class SeriesListQueryDto extends PageQueryDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsIn(["active", "archived", "all"])
  status?: "active" | "archived" | "all";

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class CreateSeriesDto extends CatalogReasonDto {
  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  ticker!: string;

  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsIn(SERIES_FREQUENCIES)
  frequency?: SeriesFrequency;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SettlementSourceDto)
  settlementSources?: SettlementSourceDto[];

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(2000)
  contractUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsObject()
  productMetadata?: Record<string, unknown>;
}

export class UpdateSeriesDto extends CatalogReasonDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsIn(SERIES_FREQUENCIES)
  frequency?: SeriesFrequency;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SettlementSourceDto)
  settlementSources?: SettlementSourceDto[];

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(2000)
  contractUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsObject()
  productMetadata?: Record<string, unknown>;

  @IsOptional()
  @IsIn(["active", "archived"])
  status?: "active" | "archived";
}

/** `GET /events?series=&status=&category=&q=&withNestedMarkets=&includeArchived=&page=&limit=` */
export class EventListQueryDto extends PageQueryDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  series?: string;

  @IsOptional()
  @IsIn(EVENT_STATUS_FILTERS)
  status?: EventStatus | "all";

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @toBool()
  @IsBoolean()
  withNestedMarkets?: boolean;

  @IsOptional()
  @toBool()
  @IsBoolean()
  includeArchived?: boolean;
}

export class CreateEventDto extends CatalogReasonDto {
  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  ticker!: string;

  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  seriesTicker!: string;

  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  subTitle?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(2000)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  mutuallyExclusive?: boolean;

  @IsOptional()
  @IsISO8601()
  strikeDate?: string | null;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  strikePeriod?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SettlementSourceDto)
  settlementSources?: SettlementSourceDto[];

  @IsOptional()
  @IsObject()
  productMetadata?: Record<string, unknown>;
}

export class UpdateEventDto extends CatalogReasonDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  seriesTicker?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(300)
  subTitle?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(2000)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  mutuallyExclusive?: boolean;

  @IsOptional()
  @IsISO8601()
  strikeDate?: string | null;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  strikePeriod?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SettlementSourceDto)
  settlementSources?: SettlementSourceDto[];

  @IsOptional()
  @IsObject()
  productMetadata?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

/** `PATCH /admin/markets/:marketId/catalog` — only what the ledger left open (409 ledger_value_fixed otherwise). */
export class MarketCatalogPatchDto extends CatalogReasonDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  ticker?: string;

  /** `null` detaches the market from its event. */
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  eventTicker?: string | null;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  yesSubTitle?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  noSubTitle?: string;
}

export class ResolutionPolicyDto {
  @IsOptional()
  @IsBoolean()
  operatorResolution?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  sources?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  sourceKeys?: { sourceUri: string; publicKey: string }[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  reporters?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  quorum?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  challengeSecs?: number;

  @IsOptional()
  @Matches(DECIMAL_INPUT)
  bondCC?: string;
}

/** `POST /admin/markets` — a market inside an event, created on-ledger through the treasury. */
export class CreateMarketDto extends CatalogReasonDto {
  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  eventTicker!: string;

  @trimmed()
  @IsString()
  @Matches(TICKER_INPUT)
  ticker!: string;

  @trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  question!: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  yesSubTitle?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  noSubTitle?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(2000)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  resolutionDescription?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsISO8601()
  expiresAt!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  gracePeriodSecs?: number;

  @IsOptional()
  @IsBoolean()
  isDynamic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  liquidityPeriodSecs?: number;

  @Matches(DECIMAL_INPUT)
  initialProbability!: string;

  @Matches(DECIMAL_INPUT)
  initialValueCC!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  feeBps?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  prizeFeeShareBps?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResolutionPolicyDto)
  policy?: ResolutionPolicyDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  auditObservers?: string[];
}

/** `POST /admin/exchange/halt` */
export class ExchangeHaltDto {
  @IsBoolean()
  active!: boolean;

  @trimmed()
  @IsString()
  @IsNotEmpty({ message: "reason is required" })
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;

  @IsOptional()
  @IsISO8601()
  estimatedResumeAt?: string | null;
}
