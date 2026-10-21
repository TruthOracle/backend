/**
 * Request DTOs for the fiat ramp (docs/RAMP.md §8). Amounts are decimal strings; the service
 * re-quotes them (fiat decimals, token decimals, fee) — a client never sends the other side of a
 * trade, only what it expects it to be (`expected*`, refused with `409 ramp_quote_changed` on a
 * mismatch). The global ValidationPipe rejects unknown keys, so these are the complete allow-list.
 */
import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from "class-validator";

import {
  RAMP_DIRECTIONS,
  RAMP_METHODS,
  RAMP_ORDER_STATUSES,
  RAMP_PAYOUT_RAILS,
  type RampDirection,
  type RampMethod,
  type RampOrderStatus,
  type RampPayerChannel,
  type RampPayoutRail,
} from "../types";
import { PageQueryDto } from "./common.dto";

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
const DECIMAL_INPUT = /^\d{1,28}(\.\d{1,10})?$/;
const DECIMAL_MESSAGE = "must be a decimal string with at most 10 decimals";

/** `Idempotency-Key` header on order creation: the client's retry token, unique per account. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * A cash-out destination (SPEC §12.1): `{kind: "card", paymentMethodId}` (back to a funding card)
 * or `{kind: "bank", bankAccountId}` (S6) — exactly the id its kind needs.
 */
export class RampDestinationDto {
  @IsIn(RAMP_PAYOUT_RAILS as readonly string[])
  kind!: RampPayoutRail;

  @ValidateIf((d: RampDestinationDto) => d.kind === "card" || d.paymentMethodId !== undefined)
  @IsUUID()
  paymentMethodId?: string;

  @ValidateIf((d: RampDestinationDto) => d.kind === "bank" || d.bankAccountId !== undefined)
  @IsUUID()
  bankAccountId?: string;
}

/** `POST /ramp/quote { direction, amount, method?, destination? }` */
export class RampQuoteDto {
  @IsIn(RAMP_DIRECTIONS as readonly string[])
  direction!: RampDirection;

  @trimmed()
  @Matches(DECIMAL_INPUT, { message: `amount ${DECIMAL_MESSAGE}` })
  amount!: string;

  @IsOptional()
  @IsIn(RAMP_METHODS as readonly string[])
  method?: RampMethod;

  @IsOptional()
  @ValidateNested()
  @Type(() => RampDestinationDto)
  destination?: RampDestinationDto;
}

/** `POST /ramp/onramp { amount, method?, expectedTokenAmount? }` — `amount` is the fiat paid; method card (default) | erip. */
export class RampOnrampDto {
  @trimmed()
  @Matches(DECIMAL_INPUT, { message: `amount ${DECIMAL_MESSAGE}` })
  amount!: string;

  @IsOptional()
  @IsIn(RAMP_METHODS as readonly string[])
  method?: RampMethod;

  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT, { message: `expectedTokenAmount ${DECIMAL_MESSAGE}` })
  expectedTokenAmount?: string;
}

/** `POST /ramp/offramp { amount, destination, expectedFiatAmount? }` — `amount` is the tokens withdrawn. */
export class RampOfframpDto {
  @trimmed()
  @Matches(DECIMAL_INPUT, { message: `amount ${DECIMAL_MESSAGE}` })
  amount!: string;

  @ValidateNested()
  @Type(() => RampDestinationDto)
  destination!: RampDestinationDto;

  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT, { message: `expectedFiatAmount ${DECIMAL_MESSAGE}` })
  expectedFiatAmount?: string;
}

/** `POST /ramp/orders/:id/attach { pendingPayoutCid }` — same character class as PayoutCidParamDto. */
export class RampAttachDto {
  @IsString()
  @Length(1, 1024)
  @Matches(/^[A-Za-z0-9._:-]+$/, { message: "pendingPayoutCid must be a contract id" })
  pendingPayoutCid!: string;
}

/** `GET /ramp/orders?direction=&cursor=&limit=` (admin lists still page with `page`). */
export class RampOrdersQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(RAMP_DIRECTIONS as readonly string[])
  direction?: RampDirection;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "cursor must be the nextCursor of a previous page" })
  cursor?: string;
}

/** `GET /admin/ramp/orders?status=&direction=&userId=&page=&limit=` */
export class AdminRampOrdersQueryDto extends RampOrdersQueryDto {
  @IsOptional()
  @IsIn(RAMP_ORDER_STATUSES as readonly string[])
  status?: RampOrderStatus;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

/** Review group A (C31): `GET /admin/ramp/events?status=dead|unprocessed&cursor=&limit=` */
export class AdminRampEventsQueryDto extends PageQueryDto {
  @IsIn(["dead", "unprocessed"])
  status!: "dead" | "unprocessed";

  @IsOptional()
  @IsString()
  @Length(1, 256)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "cursor must be the nextCursor of a previous page" })
  cursor?: string;
}

/**
 * `POST /ramp/mock/payments/:id/complete { outcome, cardSeed?, cardCountry?, payerName?,
 * payerNameSource?, channel?, capturedAmount?, payerIban?, payerBankBic? }` — mock acquirer only
 * (SPEC §9.2: partial captures, cash channel, foreign cards). `:id` is the payment or the order id.
 */
export class RampMockCompleteDto {
  @IsIn(["succeeded", "declined", "no_3ds"])
  outcome!: "succeeded" | "declined" | "no_3ds";

  /** Pick a different test card (default: one card per account). */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  cardSeed?: string;

  /** Capture another amount than the checkout's (C ≠ F: partial or over-capture). */
  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT, { message: `capturedAmount ${DECIMAL_MESSAGE}` })
  capturedAmount?: string;

  /** The card's issuer country (ISO alpha-2; default BY). */
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/, { message: "cardCountry must be an ISO 3166 alpha-2 code" })
  cardCountry?: string;

  /** The payer name the acquirer reports (ERIP: from the payer's bank). */
  @IsOptional()
  @IsString()
  @Length(1, 140)
  payerName?: string;

  @IsOptional()
  @IsIn(["bank", "checkout"])
  payerNameSource?: "bank" | "checkout";

  /** ERIP: how the money came in (cash at a kiosk, …). */
  @IsOptional()
  @IsIn(["online", "cash", "card", "unknown"])
  channel?: RampPayerChannel;

  /** ERIP: the payer's IBAN (hashed at once) and bank BIC. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9 ]{15,40}$/, { message: "payerIban must be an IBAN" })
  payerIban?: string;

  @IsOptional()
  @Matches(/^[A-Za-z0-9]{8,11}$/, { message: "payerBankBic must be a BIC" })
  payerBankBic?: string;
}
