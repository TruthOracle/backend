import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { DataSource } from "typeorm";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import {
  AdminLedgerEventsQueryDto,
  AdminLedgerPayoutsQueryDto,
  AdminLedgerWalletsQueryDto,
  AdminResyncDto,
  TransfersQueryDto,
} from "../dto/ledger.dto";
import { LedgerEventEntity } from "../entities/ledger-event.entity";
import { LedgerPayoutEntity } from "../entities/ledger-payout.entity";
import { LedgerTransferEntity } from "../entities/ledger-transfer.entity";
import { LedgerWalletEntity } from "../entities/ledger-wallet.entity";
import { AuditService } from "../services/audit.service";
import { IndexerService } from "../services/indexer.service";
import { MarketsService } from "../services/markets.service";
import { PortfolioService } from "../services/portfolio.service";
import type {
  ApiIndexedWallet,
  ApiLedgerPayout,
  ApiLedgerStatus,
  ApiLedgerTransfer,
  ApiLiquidityPosition,
  ApiPage,
  ApiPosition,
} from "../types";
import { adminActorOf } from "./admin.controller";

export interface ApiRawLedgerEvent {
  id: string;
  eventId: string;
  offset: number;
  nodeId: number;
  updateId: string;
  kind: "created" | "exercised";
  template: string;
  contractId: string;
  choice: string | null;
  consuming: boolean | null;
  actingParties: string[];
  payload: Record<string, unknown>;
  result: unknown;
  parentNodeId: number | null;
  effectiveAt: string;
  commandId: string | null;
}

/**
 * Operator view of the ledger index (docs/API.md "Admin — ledger"): status, a raw event
 * explorer, every indexed wallet / payout / transfer, and a market's holders. Same guard chain
 * as AdminController; the one mutation (resync) is audited with the operator's reason.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/ledger")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminLedgerController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly indexer: IndexerService,
    private readonly markets: MarketsService,
    private readonly portfolio: PortfolioService,
    private readonly audit: AuditService,
  ) {}

  @Get("status")
  status(): Promise<ApiLedgerStatus> {
    return this.indexer.status();
  }

  /** Re-snapshot the ACS at the ledger end and reconcile activeness (records a gap when the cursor was behind). */
  @Post("resync")
  @HttpCode(200)
  async resync(
    @Body() body: AdminResyncDto,
    @Req() req: AuthedRequest,
  ): Promise<{ status: ApiLedgerStatus }> {
    const actor = adminActorOf(req);
    const before = await this.indexer.status();
    const status = await this.indexer.resyncNow(body.reason);
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action: "ledger.resync",
      subjectType: "ledger",
      subjectId: "index",
      metadata: { reason: body.reason, fromOffset: before.offset, toOffset: status.offset },
      ip: actor.ip,
    });
    return { status };
  }

  @Get("events")
  async events(@Query() query: AdminLedgerEventsQueryDto): Promise<ApiPage<ApiRawLedgerEvent>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const qb = this.dataSource.getRepository(LedgerEventEntity).createQueryBuilder("e");
    if (query.updateId) qb.andWhere("e.update_id = :updateId", { updateId: query.updateId });
    if (query.contractId)
      qb.andWhere("e.contract_id = :contractId", { contractId: query.contractId });
    if (query.entity) qb.andWhere("e.entity = :entity", { entity: query.entity });
    if (query.choice) qb.andWhere("e.choice = :choice", { choice: query.choice });
    if (query.fromOffset !== undefined)
      qb.andWhere("e.offset >= :fromOffset", { fromOffset: query.fromOffset });
    if (query.marketId !== undefined)
      qb.andWhere("(e.payload ->> 'marketId') = :marketId", { marketId: String(query.marketId) });
    const [rows, total] = await qb
      .orderBy("e.offset", "DESC")
      .addOrderBy("e.node_id", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      items: rows.map((e) => ({
        id: String(e.id),
        eventId: e.eventId,
        offset: e.offset,
        nodeId: e.nodeId,
        updateId: e.updateId,
        kind: e.kind,
        template: `${e.module}:${e.entity}`,
        contractId: e.contractId,
        choice: e.choice,
        consuming: e.consuming,
        actingParties: e.actingParties ?? [],
        payload: e.payload ?? {},
        result: e.result,
        parentNodeId: e.parentNodeId,
        effectiveAt: e.effectiveAt.toISOString(),
        commandId: e.commandId,
      })),
      page,
      limit,
      total,
    };
  }

  @Get("wallets")
  async wallets(@Query() query: AdminLedgerWalletsQueryDto): Promise<ApiPage<ApiIndexedWallet>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const qb = this.dataSource
      .getRepository(LedgerWalletEntity)
      .createQueryBuilder("w")
      .where("w.active = true");
    if (query.owner) qb.andWhere("w.owner = :owner", { owner: query.owner });
    const [rows, total] = await qb
      .orderBy("w.balance_cc", "DESC")
      .addOrderBy("w.created_offset", "DESC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items: rows.map((w) => this.portfolio.toApiWallet(w)), page, limit, total };
  }

  @Get("payouts")
  async payouts(@Query() query: AdminLedgerPayoutsQueryDto): Promise<ApiPage<ApiLedgerPayout>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const qb = this.dataSource.getRepository(LedgerPayoutEntity).createQueryBuilder("p");
    if (query.active !== undefined) qb.andWhere("p.active = :active", { active: query.active });
    if (query.user) qb.andWhere("p.user_party = :user", { user: query.user });
    const [rows, total] = await qb
      .orderBy("p.active", "DESC")
      .addOrderBy("p.created_offset", "DESC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items: rows.map((p) => this.portfolio.toApiPayout(p)), page, limit, total };
  }

  @Get("transfers")
  async transfers(@Query() query: TransfersQueryDto): Promise<ApiPage<ApiLedgerTransfer>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const qb = this.dataSource.getRepository(LedgerTransferEntity).createQueryBuilder("t");
    if (query.direction) qb.andWhere("t.direction = :direction", { direction: query.direction });
    if (query.counterparty)
      qb.andWhere("t.counterparty = :counterparty", { counterparty: query.counterparty });
    const [rows, total] = await qb
      .orderBy("t.offset", "DESC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items: rows.map((t) => this.portfolio.toApiTransfer(t)), page, limit, total };
  }

  @Get("markets/:marketId/positions")
  holders(
    @Param("marketId", ParseIntPipe) marketId: number,
    @Query("page", new ParseIntPipe({ optional: true })) page?: number,
    @Query("limit", new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<ApiPage<ApiPosition>> {
    return this.markets.holders(
      marketId,
      Math.max(1, page ?? 1),
      Math.min(100, Math.max(1, limit ?? DEFAULT_PAGE_LIMIT)),
    );
  }

  @Get("markets/:marketId/liquidity")
  providers(
    @Param("marketId", ParseIntPipe) marketId: number,
    @Query("page", new ParseIntPipe({ optional: true })) page?: number,
    @Query("limit", new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<ApiPage<ApiLiquidityPosition>> {
    return this.markets.liquidityProviders(
      marketId,
      Math.max(1, page ?? 1),
      Math.min(100, Math.max(1, limit ?? DEFAULT_PAGE_LIMIT)),
    );
  }
}
