import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export const DEFAULT_PAGE_LIMIT = 25;

/** Telegram's widget posts `id` / `auth_date` as JSON numbers; the verifier wants strings. */
export const numberToString = ({ value }: { value: unknown }): unknown =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : value;
