/**
 * Query DTOs for the ledger-index reads (docs/API.md "Markets", "Portfolio", "Ledger", "Admin —
 * ledger"). All GET; the global ValidationPipe (`whitelist`, `forbidNonWhitelisted`) rejects
 * unknown keys, so these are the complete allow-list.
 */
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import {
  CANDLE_PERIOD_MINUTES,
  MARKET_EVENT_KINDS,
  TRANSFER_INSTRUCTION_STATUSES,
  WALLET_ENTRY_KINDS,
  type CandlePeriodMinutes,
  type MarketEventKind,
  type TransferInstructionStatus,
  type WalletEntryKind,
} from "../types";
import { AdminReasonDto } from "./admin.dto";
import { PageQueryDto } from "./common.dto";

const MARKET_STATUS_FILTERS = [
  "Trading",
  "Proposed",
  "Resolved",
  "Voided",
  "active",
  "settled",
] as const;
const MARKET_SORTS = ["newest", "oldest", "volume", "expiry", "activity"] as const;
const PRICE_RESOLUTIONS = ["raw", "1m", "5m", "15m", "1h", "4h", "1d"] as const;
const LEADERBOARD_WINDOWS = ["24h", "7d", "30d", "all"] as const;

const trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));
const toBool = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : value,
  );

/** `GET /markets?status=&category=&q=&sort=&includeArchived=&page=&limit=` */
export class MarketsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(MARKET_STATUS_FILTERS)
  status?: (typeof MARKET_STATUS_FILTERS)[number];

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
  @IsIn(MARKET_SORTS)
  sort?: (typeof MARKET_SORTS)[number];

  @IsOptional()
  @toBool()
  @IsBoolean()
  includeArchived?: boolean;

  /** Members of one event. */
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/)
  event?: string;

  /** Members of every event of one series. */
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/)
  series?: string;

  /** Comma-separated tickers (at most 50). */
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}(,[A-Za-z0-9][A-Za-z0-9._-]{1,63}){0,49}$/)
  tickers?: string;

  /** Attach `sparkline` (the last 24 hourly closes) to every market of the page — one extra query. */
  @IsOptional()
  @toBool()
  @IsBoolean()
  withSparkline?: boolean;
}

/** `GET /markets/:market/candlesticks?startTs=&endTs=&periodInterval=` (epoch seconds; period in minutes: 1, 60, 1440) */
export class CandlesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  startTs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  endTs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsIn(CANDLE_PERIOD_MINUTES)
  periodInterval?: CandlePeriodMinutes;
}

/** `GET /markets/:id/activity?kind=` · `GET /markets/:id/trades?cursor=` · `GET /me/activity` · `GET /me/trades` */
export class ActivityQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(MARKET_EVENT_KINDS)
  kind?: MarketEventKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  marketId?: number;

  /**
   * Keyset mode for feeds: `cursor=` (empty for the first page) returns rows after the cursor
   * and `nextCursor`, ignoring `page`. Value is the `nextCursor` of the previous answer.
   */
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(/^(\d{1,20}:\d{1,10})?$/)
  cursor?: string;
}

/** `GET /markets/:id/price-history?from=&to=&resolution=&limit=` */
export class PriceHistoryQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn(PRICE_RESOLUTIONS)
  resolution?: (typeof PRICE_RESOLUTIONS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(5000)
  limit?: number;
}

/** `GET /me/positions?status=` · `GET /me/liquidity?status=` */
export class PositionsQueryDto {
  @IsOptional()
  @IsIn(["open", "all"])
  status?: "open" | "all";
}

/** `GET /in-app-wallet/history?kind=` */
export class WalletHistoryQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(WALLET_ENTRY_KINDS)
  kind?: WalletEntryKind;
}

/** `?instrument=<admin>:<id>` — the instrument an aggregate is computed over (default: the default collateral). */
export class InstrumentQueryDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,255}::1220[0-9a-f]{64}:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, {
    message: "instrument must be <admin party>:<token id>",
  })
  instrument?: string;
}

/** `?instrument=` on a paged list (no default: omitted = every instrument). */
export class InstrumentPageQueryDto extends PageQueryDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,255}::1220[0-9a-f]{64}:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, {
    message: "instrument must be <admin party>:<token id>",
  })
  instrument?: string;
}

/** `GET /in-app-wallet/transfers?direction=&instrument=` · `GET /admin/ledger/transfers?direction=&counterparty=&instrument=` */
export class TransfersQueryDto extends InstrumentPageQueryDto {
  @IsOptional()
  @IsIn(["in", "out"])
  direction?: "in" | "out";

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(400)
  counterparty?: string;
}

/** `GET /admin/ledger/holdings?instrument=&active=` — the treasury's token-standard holdings as indexed. */
export class HoldingsQueryDto extends InstrumentPageQueryDto {
  @IsOptional()
  @toBool()
  @IsBoolean()
  active?: boolean;
}

/** `GET /admin/ledger/transfer-instructions?instrument=&status=&party=` */
export class TransferInstructionsQueryDto extends InstrumentPageQueryDto {
  @IsOptional()
  @IsIn(TRANSFER_INSTRUCTION_STATUSES)
  status?: TransferInstructionStatus;

  /** Sender or receiver. */
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(400)
  party?: string;
}

/** `GET /leaderboard?window=&limit=&instrument=` */
export class LeaderboardQueryDto extends InstrumentQueryDto {
  @IsOptional()
  @IsIn(LEADERBOARD_WINDOWS)
  window?: (typeof LEADERBOARD_WINDOWS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** `GET /ledger/wait?offset=&timeoutMs=` */
export class LedgerWaitQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30_000)
  timeoutMs?: number;
}

/** `GET /admin/ledger/events?updateId=&contractId=&marketId=&entity=&choice=` */
export class AdminLedgerEventsQueryDto extends PageQueryDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(400)
  updateId?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(400)
  contractId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  marketId?: number;

  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]*$/)
  @MaxLength(80)
  entity?: string;

  @IsOptional()
  @trimmed()
  @IsString()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]*$/)
  @MaxLength(80)
  choice?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromOffset?: number;
}

/** `GET /admin/ledger/wallets?owner=` */
export class AdminLedgerWalletsQueryDto extends PageQueryDto {
  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(400)
  owner?: string;
}

/** `GET /admin/ledger/payouts?active=&user=` */
export class AdminLedgerPayoutsQueryDto extends PageQueryDto {
  @IsOptional()
  @toBool()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @trimmed()
  @IsString()
  @MaxLength(400)
  user?: string;
}

/** `POST /admin/ledger/resync` */
export class AdminResyncDto extends AdminReasonDto {}
