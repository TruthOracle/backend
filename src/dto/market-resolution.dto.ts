/**
 * `POST /admin/markets/:marketId/resolution` (review F0; docs/API.md "Admin — catalog"). The
 * global ValidationPipe rejects unknown keys, so this class is the complete allow-list; which
 * fields a choice takes (and refuses) is checked by the `market.resolve` approval's params.
 */
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from "class-validator";

import {
  MARKET_RESOLUTION_CHOICES,
  MARKET_RESOLUTION_MAX_ATTESTATIONS,
  MARKET_RESOLUTION_MAX_SOURCE_URI,
  MARKET_RESOLUTION_OUTCOMES,
  type MarketResolutionChoice,
  type MarketResolutionOutcome,
} from "../types";
import { AdminReasonDto } from "./admin.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));

export class MarketResolutionDto extends AdminReasonDto {
  @IsIn(MARKET_RESOLUTION_CHOICES as readonly string[])
  choice!: MarketResolutionChoice;

  /** ResolveT0 only (required there). */
  @IsOptional()
  @IsIn(MARKET_RESOLUTION_OUTCOMES as readonly string[])
  outcome?: MarketResolutionOutcome;

  /** ResolveT0 only (required there): an http(s) URL, one of the market's sources when it lists any. */
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(MARKET_RESOLUTION_MAX_SOURCE_URI)
  sourceUri?: string;

  /** Resolve only (required there): the OutcomeAttestation contract ids, in the order to submit. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MARKET_RESOLUTION_MAX_ATTESTATIONS)
  @IsString({ each: true })
  @Length(1, 512, { each: true })
  attestationCids?: string[];

  /** C23 (RAMP_DUAL_CONTROL=false only): the requester's signature over the request message a 400 names. */
  @IsOptional()
  @IsString()
  @Length(1, 512)
  signature?: string;
}
