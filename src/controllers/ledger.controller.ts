import { Controller, Get, Query, UseInterceptors } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/decorators";
import { InstrumentQueryDto, LeaderboardQueryDto, LedgerWaitQueryDto } from "../dto/ledger.dto";
import { IndexerService } from "../services/indexer.service";
import { MarketsService } from "../services/markets.service";
import {
  type ApiLeaderboardEntry,
  type ApiLedgerStatus,
  type ApiStats,
  type InstrumentId,
  type InstrumentRef,
  parseInstrumentKey,
} from "../types";
import { LedgerOffsetInterceptor } from "../util/ledger-offset.interceptor";

/** The DTO already shaped the key; a parse miss here can only be a bug, so it reads as "default". */
function instrumentOf(raw: string | undefined): InstrumentId | undefined {
  return raw ? (parseInstrumentKey(raw) ?? undefined) : undefined;
}

const DEFAULT_WAIT_MS = 10_000;

/**
 * Index status and platform-wide aggregates (docs/API.md "Ledger"). `GET /ledger/wait` is the
 * "did my transaction land yet" primitive: a client that submitted a command and learned its
 * offset (or simply read `x-ledger-offset` before submitting) long-polls here instead of
 * re-reading the ledger every second.
 */
@ApiTags("ledger")
@Controller()
@Public()
export class LedgerController {
  constructor(
    private readonly indexer: IndexerService,
    private readonly markets: MarketsService,
  ) {}

  @Get("ledger/status")
  status(): Promise<ApiLedgerStatus> {
    return this.indexer.status();
  }

  /** Resolves once the index reaches `offset` or after `timeoutMs` (default 10 s, max 30 s). */
  @Get("ledger/wait")
  wait(
    @Query() query: LedgerWaitQueryDto,
  ): Promise<{ reached: boolean; offset: number; requested: number }> {
    return this.indexer
      .waitForOffset(query.offset, query.timeoutMs ?? DEFAULT_WAIT_MS)
      .then((r) => ({ ...r, requested: query.offset }));
  }

  /** Aggregates over one instrument's markets (`?instrument=<admin>:<id>`, default the default collateral). */
  @Get("stats")
  @UseInterceptors(LedgerOffsetInterceptor)
  async stats(@Query() query: InstrumentQueryDto): Promise<ApiStats> {
    return this.markets.stats(await this.indexer.currentOffset(), instrumentOf(query.instrument));
  }

  @Get("leaderboard")
  @UseInterceptors(LedgerOffsetInterceptor)
  leaderboard(
    @Query() query: LeaderboardQueryDto,
  ): Promise<{ window: string; instrument: InstrumentRef; entries: ApiLeaderboardEntry[] }> {
    return this.markets.leaderboard(
      query.window ?? "30d",
      query.limit ?? 25,
      instrumentOf(query.instrument),
    );
  }
}
