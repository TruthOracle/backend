import { Controller, Get, Query, Req, UseInterceptors } from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";

import { type AuthedRequest, principalOf } from "../auth/request";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import { TransfersQueryDto, WalletHistoryQueryDto } from "../dto/ledger.dto";
import { PortfolioService } from "../services/portfolio.service";
import {
  parseInstrumentKey,
  type ApiIndexedWallet,
  type ApiLedgerPayout,
  type ApiLedgerTransfer,
  type ApiPage,
  type ApiWalletEntry,
} from "../types";
import { LedgerOffsetInterceptor } from "../util/ledger-offset.interceptor";

/**
 * The in-app wallet's ledger side (docs/API.md "In-app wallet ledger"): the indexed UserWallet,
 * its statement (every Deposit / Grant / Credit / Debit / Withdraw), the account's PendingPayouts
 * as the ledger sees them, and the token transfers — any instrument — between the treasury and
 * the account's wallets. Read-only companions of `GET /in-app-wallet` (which still reads the
 * ledger live).
 */
@ApiTags("in-app-wallet")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("in-app-wallet")
@UseInterceptors(LedgerOffsetInterceptor)
export class LedgerWalletController {
  constructor(private readonly portfolio: PortfolioService) {}

  /** The primary party's UserWallet as indexed plus every PendingPayout of the account's parties. */
  @Get("ledger")
  async ledger(@Req() req: AuthedRequest): Promise<{
    partyId: string | null;
    wallet: ApiIndexedWallet | null;
    payouts: ApiLedgerPayout[];
  }> {
    const { user } = principalOf(req);
    const parties = await this.portfolio.partiesOf(user);
    const [wallet, payouts] = await Promise.all([
      this.portfolio.indexedWallet(user.partyId),
      this.portfolio.ledgerPayouts(parties),
    ]);
    return { partyId: user.partyId, wallet, payouts };
  }

  /** Statement of the primary party's UserWallet, newest first. */
  @Get("history")
  history(
    @Query() query: WalletHistoryQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiPage<ApiWalletEntry>> {
    const { user } = principalOf(req);
    return this.portfolio.walletHistory(user.partyId, {
      kind: query.kind,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  /** Tokens moved between the treasury and any of the account's wallets (deposits in, payouts out), every row with its instrument and amount; `?instrument=<admin>:<id>` narrows to one. */
  @Get("transfers")
  async transfers(
    @Query() query: TransfersQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiPage<ApiLedgerTransfer>> {
    const { user } = principalOf(req);
    return this.portfolio.transfers(await this.portfolio.partiesOf(user), {
      direction: query.direction,
      instrument: query.instrument
        ? (parseInstrumentKey(query.instrument) ?? undefined)
        : undefined,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }
}
