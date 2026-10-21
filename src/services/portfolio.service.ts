import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { LedgerHoldingEntity } from "../entities/ledger-holding.entity";
import { LedgerPayoutEntity } from "../entities/ledger-payout.entity";
import { LedgerTransferInstructionEntity } from "../entities/ledger-transfer-instruction.entity";
import { LedgerTransferEntity } from "../entities/ledger-transfer.entity";
import { LedgerWalletEntity } from "../entities/ledger-wallet.entity";
import { LiquidityPositionEntity } from "../entities/liquidity-position.entity";
import { MarketEntity } from "../entities/market.entity";
import { PositionEntity } from "../entities/position.entity";
import { WalletEntryEntity } from "../entities/wallet-entry.entity";
import type { UserEntity } from "../entities/user.entity";
import type {
  ApiIndexedWallet,
  ApiLedgerHolding,
  ApiLedgerPayout,
  ApiLedgerTransfer,
  ApiLiquidityPosition,
  ApiMarketEvent,
  ApiPage,
  ApiPosition,
  ApiTransferInstruction,
  ApiWalletEntry,
  InstrumentId,
  MarketEventKind,
  WalletEntryKind,
} from "../types";
import { formatAmount } from "../util/money";
import { MarketsService, whereParties } from "./markets.service";
import { WalletLinkService } from "./wallet-link.service";

export type PositionStatusFilter = "open" | "all";

/**
 * A signed-in account's view of the ledger index (docs/API.md "Portfolio", "In-app wallet
 * ledger"): positions, LP claims, trades, the in-app statement, external transfers and
 * PendingPayouts for every party the account controls — the primary party plus every ACTIVE
 * linked wallet (a wallet that traded with its own key before linking). Read as the treasury,
 * so it works on mainnet where a user party's own ACS reads come back empty (docs/INDEXER.md §1).
 */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly markets: MarketsService,
    private readonly walletLinks: WalletLinkService,
  ) {}

  /** The parties an account's ledger activity is looked up under. */
  async partiesOf(user: UserEntity): Promise<string[]> {
    const wallets = await this.walletLinks.listForUser(user.id);
    const parties = new Set<string>();
    if (user.partyId) parties.add(user.partyId);
    for (const w of wallets) if (w.status === "active") parties.add(w.partyId);
    return [...parties];
  }

  async positions(
    parties: string[],
    status: PositionStatusFilter,
  ): Promise<{ parties: string[]; positions: ApiPosition[] }> {
    if (parties.length === 0) return { parties, positions: [] };
    const qb = whereParties(
      this.dataSource.getRepository(PositionEntity).createQueryBuilder("p"),
      "p.holder",
      parties,
    );
    if (status === "open") qb.andWhere("p.active = true");
    const rows = await qb
      .orderBy("p.active", "DESC")
      .addOrderBy("p.created_offset", "DESC")
      .getMany();
    const markets = await this.marketsById(rows.map((r) => r.marketId));
    const summaries = await this.markets.summariesOf([...markets.values()]);
    return {
      parties,
      positions: rows.map((p) => {
        const m = markets.get(p.marketId) ?? null;
        return this.markets.toApiPosition(p, m, summaries.get(p.marketId) ?? null);
      }),
    };
  }

  async liquidity(
    parties: string[],
    status: PositionStatusFilter,
  ): Promise<{ parties: string[]; positions: ApiLiquidityPosition[] }> {
    if (parties.length === 0) return { parties, positions: [] };
    const qb = whereParties(
      this.dataSource.getRepository(LiquidityPositionEntity).createQueryBuilder("l"),
      "l.provider",
      parties,
    );
    if (status === "open") qb.andWhere("l.active = true");
    const rows = await qb
      .orderBy("l.active", "DESC")
      .addOrderBy("l.created_offset", "DESC")
      .getMany();
    const markets = await this.marketsById(rows.map((r) => r.marketId));
    const summaries = await this.markets.summariesOf([...markets.values()]);
    return {
      parties,
      positions: rows.map((l) => {
        const m = markets.get(l.marketId) ?? null;
        return this.markets.toApiLiquidity(l, m, summaries.get(l.marketId) ?? null);
      }),
    };
  }

  trades(
    parties: string[],
    query: { marketId?: number; kind?: MarketEventKind; page: number; limit: number },
  ): Promise<ApiPage<ApiMarketEvent>> {
    return this.markets.trades({ ...query, actors: parties });
  }

  activity(
    parties: string[],
    query: { marketId?: number; kind?: MarketEventKind; page: number; limit: number },
  ): Promise<ApiPage<ApiMarketEvent>> {
    return this.markets.activity({ ...query, actors: parties });
  }

  // ───────────────────────────────────────────── in-app wallet ─────────────────────────────────────────────

  async indexedWallet(owner: string | null): Promise<ApiIndexedWallet | null> {
    if (!owner) return null;
    const row = await this.dataSource
      .getRepository(LedgerWalletEntity)
      .findOne({ where: { owner, active: true }, order: { createdOffset: "DESC" } });
    return row ? this.toApiWallet(row) : null;
  }

  async walletHistory(
    owner: string | null,
    query: { kind?: WalletEntryKind; page: number; limit: number },
  ): Promise<ApiPage<ApiWalletEntry>> {
    if (!owner) return { items: [], page: query.page, limit: query.limit, total: 0 };
    const qb = this.dataSource
      .getRepository(WalletEntryEntity)
      .createQueryBuilder("w")
      .where("w.owner = :owner", { owner });
    if (query.kind) qb.andWhere("w.kind = :kind", { kind: query.kind });
    const [rows, total] = await qb
      .orderBy("w.offset", "DESC")
      .addOrderBy("w.node_id", "DESC")
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: rows.map((r) => this.toApiEntry(r)),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async transfers(
    parties: string[],
    query: { direction?: "in" | "out"; instrument?: InstrumentId; page: number; limit: number },
  ): Promise<ApiPage<ApiLedgerTransfer>> {
    if (parties.length === 0) return { items: [], page: query.page, limit: query.limit, total: 0 };
    const qb = this.dataSource
      .getRepository(LedgerTransferEntity)
      .createQueryBuilder("t")
      .where("t.counterparty IN (:...parties)", { parties });
    if (query.direction) qb.andWhere("t.direction = :direction", { direction: query.direction });
    if (query.instrument)
      qb.andWhere("t.instrument_admin = :admin AND t.instrument_id = :id", {
        admin: query.instrument.admin,
        id: query.instrument.id,
      });
    const [rows, total] = await qb
      .orderBy("t.offset", "DESC")
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return {
      items: rows.map((r) => this.toApiTransfer(r)),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async ledgerPayouts(
    parties: string[],
    opts: { active?: boolean } = {},
  ): Promise<ApiLedgerPayout[]> {
    if (parties.length === 0) return [];
    const qb = this.dataSource
      .getRepository(LedgerPayoutEntity)
      .createQueryBuilder("p")
      .where("p.user_party IN (:...parties)", { parties });
    if (opts.active !== undefined) qb.andWhere("p.active = :active", { active: opts.active });
    const rows = await qb
      .orderBy("p.active", "DESC")
      .addOrderBy("p.created_offset", "DESC")
      .getMany();
    return rows.map((r) => this.toApiPayout(r));
  }

  // ───────────────────────────────────────────── shaping ─────────────────────────────────────────────

  toApiWallet(w: LedgerWalletEntity): ApiIndexedWallet {
    return {
      contractId: w.contractId,
      owner: w.owner,
      instrument: this.markets.instrumentRef(w.instrumentAdmin, w.instrumentId),
      balance: formatAmount(w.balance),
      deposited: formatAmount(w.deposited),
      withdrawn: formatAmount(w.withdrawn),
      creditRefs: w.creditRefs ?? [],
      updatedOffset: w.createdOffset,
      updatedAt: (w.createdAtLedger ?? w.createdAt).toISOString(),
    };
  }

  toApiEntry(e: WalletEntryEntity): ApiWalletEntry {
    return {
      id: String(e.id),
      eventId: e.eventId,
      owner: e.owner,
      instrument: this.markets.instrumentRef(e.instrumentAdmin, e.instrumentId),
      kind: e.kind,
      amount: formatAmount(e.amount),
      reason: e.reason,
      txRef: e.txRef,
      balanceAfter: e.balanceAfter === null ? null : formatAmount(e.balanceAfter),
      marketId: e.marketId,
      rootChoice: e.rootChoice,
      walletContractId: e.walletCid,
      offset: e.offset,
      updateId: e.updateId,
      effectiveAt: e.effectiveAt.toISOString(),
    };
  }

  toApiTransfer(t: LedgerTransferEntity): ApiLedgerTransfer {
    return {
      updateId: t.updateId,
      nodeId: t.nodeId,
      offset: t.offset,
      direction: t.direction,
      counterparty: t.counterparty,
      instrument: this.markets.instrumentRef(t.instrumentAdmin, t.instrumentId),
      amount: formatAmount(t.amount),
      kind: t.kind,
      choice: t.choice,
      recordTime: (t.recordTime ?? t.effectiveAt).toISOString(),
    };
  }

  toApiHolding(h: LedgerHoldingEntity): ApiLedgerHolding {
    return {
      contractId: h.contractId,
      owner: h.owner,
      instrument: this.markets.instrumentRef(h.instrumentAdmin, h.instrumentId),
      amount: formatAmount(h.amount),
      locked: h.locked,
      lockExpiresAt: h.lockExpiresAt ? h.lockExpiresAt.toISOString() : null,
      createdOffset: h.createdOffset,
      active: h.archivedOffset === null,
    };
  }

  toApiInstruction(i: LedgerTransferInstructionEntity): ApiTransferInstruction {
    return {
      contractId: i.contractId,
      instrument: this.markets.instrumentRef(i.instrumentAdmin, i.instrumentId),
      sender: i.sender,
      receiver: i.receiver,
      amount: formatAmount(i.amount),
      executeBefore: i.executeBefore ? i.executeBefore.toISOString() : null,
      status: i.status,
      createdOffset: i.createdOffset,
    };
  }

  toApiPayout(p: LedgerPayoutEntity): ApiLedgerPayout {
    return {
      contractId: p.contractId,
      user: p.userParty,
      marketId: p.marketId,
      instrument: this.markets.instrumentRef(p.instrumentAdmin, p.instrumentId),
      amount: formatAmount(p.amount),
      reason: p.reason,
      createdAt:
        p.createdAtSec > 0
          ? new Date(p.createdAtSec * 1000).toISOString()
          : (p.createdAtLedger ?? p.createdAt).toISOString(),
      createdOffset: p.createdOffset,
      active: p.active,
      settledKind: p.settledKind,
      settledAt: p.settledAtLedger ? p.settledAtLedger.toISOString() : null,
      settledOffset: p.settledOffset,
      txHash: p.txHash,
      refunded: p.refunded,
    };
  }

  private async marketsById(ids: number[]): Promise<Map<number, MarketEntity>> {
    const out = new Map<number, MarketEntity>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return out;
    const rows = await this.dataSource
      .getRepository(MarketEntity)
      .createQueryBuilder("m")
      .where("m.market_id IN (:...ids)", { ids: unique })
      .getMany();
    for (const m of rows) out.set(m.marketId, m);
    return out;
  }
}
