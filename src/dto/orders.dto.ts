/**
 * Quote and order DTOs (docs/API.md "Quotes and orders"; docs/MARKETS.md §6–§7). Amounts are
 * decimal strings with at most 10 decimals — never JS numbers — and parsed to fixed point by the
 * controller.
 */
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from "class-validator";

import { ORDER_ACTIONS, QUOTABLE_ACTIONS, type OrderAction, type TradeSide } from "../types";

const DECIMAL_INPUT = /^\d{1,28}(\.\d{1,10})?$/;
const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));

/** `GET /markets/:market/quote?action=&side=&amountCC=&shares=&slippageBps=` */
export class QuoteQueryDto {
  @IsIn(QUOTABLE_ACTIONS as readonly string[])
  action!: Extract<OrderAction, "buy" | "sell" | "swap" | "provide_liquidity">;

  @IsOptional()
  @IsIn(["Yes", "No"])
  side?: TradeSide;

  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT)
  amountCC?: string;

  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT)
  shares?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2000)
  slippageBps?: number;
}

/** `POST /markets/:market/orders/prepare` */
export class PrepareOrderDto {
  @IsIn(ORDER_ACTIONS as readonly string[])
  action!: OrderAction;

  @IsOptional()
  @IsIn(["Yes", "No"])
  side?: TradeSide;

  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT)
  amountCC?: string;

  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT)
  shares?: string;

  @IsOptional()
  @trimmed()
  @Matches(DECIMAL_INPUT)
  lpTokens?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  slippageBps?: number;
}
