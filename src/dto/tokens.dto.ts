/**
 * Request DTOs for the operator's token operations (docs/TOKENS.md §4.7; docs/API.md "Admin —
 * tokens"): mint and burn through Cantor8's token-app. Amounts are decimal strings in the
 * instrument's own precision (a finer amount is refused by the service, not silently truncated).
 * The global ValidationPipe rejects unknown keys, so these are the complete allow-list.
 */
import { Transform, Type } from "class-transformer";
import { IsOptional, IsString, IsUUID, Matches, ValidateNested } from "class-validator";

import { PARTY_ID_RE } from "../util/canton-crypto";
import { AdminReasonDto } from "./admin.dto";
import { InstrumentIdDto } from "./instruments.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
const DECIMAL_INPUT = /^\d{1,28}(\.\d{1,10})?$/;
/** `treasury` or a Canton party id. */
const MINT_TARGET_INPUT = /^(treasury|[A-Za-z0-9_\-.]{1,255}::1220[0-9a-f]{64})$/;

/** `POST /admin/tokens/mint { instrument, amount, to?, creditUserId?, reason }` */
export class MintTokensDto extends AdminReasonDto {
  @ValidateNested()
  @Type(() => InstrumentIdDto)
  instrument!: InstrumentIdDto;

  @trimmed()
  @Matches(DECIMAL_INPUT, { message: "amount must be a decimal string with at most 10 decimals" })
  amount!: string;

  /** `treasury` (default) or the party the tokens are minted to. */
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(MINT_TARGET_INPUT, { message: "to must be `treasury` or a Canton party id" })
  to?: string;

  /** Mint-and-credit: the account whose in-app wallet receives the minted amount (the mint must land on the treasury). */
  @IsOptional()
  @IsUUID()
  creditUserId?: string;
}

/** `POST /admin/tokens/burn { instrument, amount, party, reason }` */
export class BurnTokensDto extends AdminReasonDto {
  @ValidateNested()
  @Type(() => InstrumentIdDto)
  instrument!: InstrumentIdDto;

  @trimmed()
  @Matches(DECIMAL_INPUT, { message: "amount must be a decimal string with at most 10 decimals" })
  amount!: string;

  /** The holder whose tokens are burned. */
  @trimmed()
  @IsString()
  @Matches(PARTY_ID_RE, { message: "party must be a Canton party id (<hint>::1220<64 hex>)" })
  party!: string;
}
