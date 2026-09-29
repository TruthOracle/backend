import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { ammStateOf, decimalToNumber, numberToDecimal } from "../amm/market-state";
import {
  quoteBuy,
  quoteProvideLiquidity,
  quoteSell,
  quoteSwap,
  marketEffectiveL,
} from "../amm/pm-amm";
import { Config } from "../config";
import { LedgerWalletEntity } from "../entities/ledger-wallet.entity";
import { LiquidityPositionEntity } from "../entities/liquidity-position.entity";
import type { MarketEntity } from "../entities/market.entity";
import { PositionEntity } from "../entities/position.entity";
import type { UserEntity } from "../entities/user.entity";
import type {
  ApiExerciseCommand,
  ApiPreparedOrder,
  ApiQuote,
  ApiQuoteBody,
  ApiQuoteBounds,
  MarketPhase,
  OrderAction,
  TradeSide,
} from "../types";
import { ApiError } from "../util/errors";
import { formatCC } from "../util/money";
import { ExchangeService } from "./exchange.service";
import { IndexerService } from "./indexer.service";
import { MarketsService } from "./markets.service";

export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 2_000;

export interface QuoteRequest {
  action: OrderAction;
  side?: TradeSide;
  /** buy: collateral · provide_liquidity: value increase · split / merge: pairs. */
  amountCC?: bigint;
  /** sell / swap: shares in. */
  shares?: bigint;
  /** withdraw_liquidity: LP tokens to burn. */
  lpTokens?: bigint;
  slippageBps?: number;
}

const TRADING_ACTIONS: ReadonlySet<OrderAction> = new Set([
  "buy",
  "sell",
  "swap",
  "split",
  "merge",
  "provide_liquidity",
  "withdraw_liquidity",
]);

/**
 * Quotes and prepared orders for the pm-AMM (docs/MARKETS.md §6–§7). A quote runs the ported
 * PmAmmMath over the indexed market version; a prepared order is the exact JSON Ledger API
 * ExerciseCommand the user's wallet signs, assembled from the index (active market version and
 * its disclosed-contract blob, the account's UserWallet and Position contract ids) — the reads
 * the browser cannot do itself on mainnet. Every rule the Daml choice asserts is pre-checked
 * here so the user sees a reason instead of a rejected transaction.
 */
@Injectable()
export class QuoteService {
  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly markets: MarketsService,
    private readonly indexer: IndexerService,
    private readonly exchange: ExchangeService,
  ) {}

  // ───────────────────────────────────────────── quotes ─────────────────────────────────────────────

  quote(market: MarketEntity, req: QuoteRequest, nowSec = Math.floor(Date.now() / 1000)): ApiQuote {
    const phase = this.markets.phaseOf(market, nowSec);
    this.assertTradable(market, req.action, phase, nowSec);
    const slippageBps = clampSlippage(req.slippageBps);
    const state = ammStateOf(market);
    const { body, bounds } = this.computeQuote(market, req, slippageBps, nowSec);
    return {
      marketId: market.marketId,
      ticker: market.ticker,
      contractId: market.contractId,
      updatedOffset: market.updatedOffset,
      nowSeconds: nowSec,
      phase,
      effectiveL: formatCC(numberToDecimal(marketEffectiveL(state, nowSec))),
      quote: body,
      bounds,
    };
  }

  private computeQuote(
    market: MarketEntity,
    req: QuoteRequest,
    slippageBps: number,
    nowSec: number,
  ): { body: ApiQuoteBody; bounds: ApiQuoteBounds } {
    const state = ammStateOf(market);
    const down = (n: number): bigint => numberToDecimal(n * (1 - slippageBps / 10_000));
    const up = (n: number): bigint => numberToDecimal(n * (1 + slippageBps / 10_000));
    const dec = (n: number): string => formatCC(numberToDecimal(n));
    switch (req.action) {
      case "buy": {
        const side = requireSide(req.side);
        const collateral = requirePositive(req.amountCC, "amountCC");
        const q = quoteBuy(state, side, decimalToNumber(collateral), nowSec);
        if (!q) throw new ApiError(409, "quote_unavailable", "the pool cannot fill this order");
        return {
          body: {
            action: "buy",
            side,
            collateralCC: formatCC(collateral),
            feeCC: dec(q.feeCC),
            netCC: dec(q.netCC),
            sharesOut: dec(q.sharesOut),
            avgPrice: dec(q.avgPrice),
            priceBefore: dec(q.priceBefore),
            priceAfter: dec(q.priceAfter),
            priceImpact: dec(q.priceImpact),
            maxPayoutCC: dec(q.sharesOut),
          },
          bounds: { slippageBps, minSharesOut: formatCC(down(q.sharesOut)) },
        };
      }
      case "sell": {
        const side = requireSide(req.side);
        const shares = requirePositive(req.shares, "shares");
        const q = quoteSell(state, side, decimalToNumber(shares), nowSec);
        if (!q) throw new ApiError(409, "quote_unavailable", "the pool cannot fill this order");
        return {
          body: {
            action: "sell",
            side,
            sharesIn: formatCC(shares),
            grossCC: dec(q.grossCC),
            feeCC: dec(q.feeCC),
            netCC: dec(q.netCC),
            avgPrice: dec(q.avgPrice),
            priceBefore: dec(q.priceBefore),
            priceAfter: dec(q.priceAfter),
            priceImpact: dec(q.priceImpact),
          },
          bounds: { slippageBps, minProceedsCC: formatCC(down(q.netCC)) },
        };
      }
      case "swap": {
        const fromSide = requireSide(req.side);
        const shares = requirePositive(req.shares, "shares");
        const q = quoteSwap(state, fromSide, decimalToNumber(shares), nowSec);
        if (!q) throw new ApiError(409, "quote_unavailable", "the pool cannot fill this swap");
        return {
          body: {
            action: "swap",
            fromSide,
            sharesIn: formatCC(shares),
            feeShares: dec(q.feeShares),
            sharesOut: dec(q.sharesOut),
            priceBefore: dec(q.priceBefore),
            priceAfter: dec(q.priceAfter),
            priceImpact: dec(q.priceImpact),
          },
          bounds: { slippageBps, minSharesOut: formatCC(down(q.sharesOut)) },
        };
      }
      case "provide_liquidity": {
        const value = requirePositive(req.amountCC, "amountCC");
        const q = quoteProvideLiquidity(state, decimalToNumber(value), nowSec);
        if (!q) throw new ApiError(409, "quote_unavailable", "the pool cannot take this deposit");
        return {
          body: {
            action: "provide_liquidity",
            valueIncreaseCC: formatCC(value),
            costCC: dec(q.costCC),
            lpMinted: dec(q.lpMinted),
            poolShare: dec(q.poolShare),
            newL: dec(q.newL),
          },
          bounds: { slippageBps, maxCostCC: formatCC(up(q.costCC)) },
        };
      }
      default:
        throw new ApiError(400, "validation_failed", `${req.action} has no quote (it is exact)`);
    }
  }

  /** Mirrors the asserts of the Daml choices so a user learns why before signing (docs/MARKETS.md §7). */
  assertTradable(
    market: MarketEntity,
    action: OrderAction,
    phase: MarketPhase,
    nowSec: number,
  ): void {
    const refuse = (reason: string): never => {
      throw new ApiError(409, "market_not_tradable", reason, { phase, action });
    };
    if (market.archived) refuse("market is archived");
    switch (action) {
      case "buy":
      case "sell":
      case "swap":
        if (market.status !== "Trading") refuse("market is not trading");
        if (nowSec < market.createdAtSec + market.liquidityPeriodSecs)
          refuse("trading has not started (liquidity period)");
        if (nowSec >= market.expiresAtSec) refuse("market has expired");
        return;
      case "split":
      case "provide_liquidity":
        if (market.status !== "Trading") refuse("market is not trading");
        if (nowSec >= market.expiresAtSec) refuse("market has expired");
        return;
      case "merge":
        return;
      case "withdraw_liquidity":
        if (market.status === "Proposed") refuse("cannot withdraw while a proposal is pending");
        if (market.status === "Trading" && market.isDynamic)
          refuse("dynamic-pool liquidity is locked until resolution");
        return;
      case "redeem":
        if (market.status !== "Resolved" && market.status !== "Voided")
          refuse("market not settled");
        return;
    }
  }

  // ───────────────────────────────────────────── orders ─────────────────────────────────────────────

  async prepare(
    user: UserEntity,
    market: MarketEntity,
    req: QuoteRequest,
  ): Promise<ApiPreparedOrder> {
    const nowSec = Math.floor(Date.now() / 1000);
    const party = user.partyId;
    if (!party) throw new ApiError(409, "no_primary_wallet", "link a wallet before trading");
    if (TRADING_ACTIONS.has(req.action)) {
      const halt = await this.exchange.halt();
      if (halt.active)
        throw new ApiError(409, "trading_halted", halt.reason ?? "trading is halted", {
          estimatedResumeAt: halt.estimatedResumeAt,
        });
    }
    const phase = this.markets.phaseOf(market, nowSec);
    this.assertTradable(market, req.action, phase, nowSec);
    if (!market.createdEventBlob)
      throw new ApiError(
        409,
        "quote_unavailable",
        "the market's disclosed-contract blob is not indexed yet",
      );

    const [wallet, position, lpPosition] = await Promise.all([
      this.dataSource
        .getRepository(LedgerWalletEntity)
        .findOne({ where: { owner: party, active: true }, order: { createdOffset: "DESC" } }),
      this.dataSource
        .getRepository(PositionEntity)
        .findOne({
          where: { holder: party, marketId: market.marketId, active: true },
          order: { createdOffset: "DESC" },
        }),
      this.dataSource
        .getRepository(LiquidityPositionEntity)
        .findOne({
          where: { provider: party, marketId: market.marketId, active: true },
          order: { createdOffset: "DESC" },
        }),
    ]);
    if (!wallet)
      throw new ApiError(
        409,
        "no_in_app_wallet",
        "deposit first: this account has no in-app wallet on the ledger",
      );

    const slippageBps = clampSlippage(req.slippageBps);
    const quote = ["buy", "sell", "swap", "provide_liquidity"].includes(req.action)
      ? this.quote(market, { ...req, slippageBps }, nowSec)
      : null;
    const argument = this.choiceArgument(req, {
      party,
      nowSec,
      walletCid: wallet.contractId,
      walletBalance: wallet.balanceCC,
      position,
      lpPosition,
      quote,
    });
    const templateId =
      market.templateId ?? `${this.config.truthoraclePackageId}:Truthoracle:PredictionMarket`;
    const command: ApiExerciseCommand = {
      ExerciseCommand: {
        templateId,
        contractId: market.contractId,
        choice: argument.choice,
        choiceArgument: argument.value,
      },
    };
    return {
      action: req.action,
      marketId: market.marketId,
      ticker: market.ticker,
      actAs: party,
      command,
      disclosedContracts: [
        {
          templateId,
          contractId: market.contractId,
          createdEventBlob: market.createdEventBlob,
          synchronizerId: market.synchronizerId,
        },
      ],
      quote,
      inputs: {
        marketContractId: market.contractId,
        walletContractId: wallet.contractId,
        positionContractId: position?.contractId ?? null,
        lpPositionContractId: lpPosition?.contractId ?? null,
      },
      ledgerOffset: await this.indexer.currentOffset(),
      nowSeconds: nowSec,
      expiresAt: new Date((nowSec + this.config.orderPrepareTtlSec) * 1000).toISOString(),
    };
  }

  private choiceArgument(
    req: QuoteRequest,
    ctx: {
      party: string;
      nowSec: number;
      walletCid: string;
      walletBalance: bigint;
      position: PositionEntity | null;
      lpPosition: LiquidityPositionEntity | null;
      quote: ApiQuote | null;
    },
  ): { choice: string; value: Record<string, unknown> } {
    const now = String(ctx.nowSec);
    const needPosition = (): PositionEntity => {
      if (!ctx.position) throw new ApiError(409, "no_position", "no open position in this market");
      return ctx.position;
    };
    const needBalance = (cost: bigint, what: string): void => {
      if (ctx.walletBalance < cost)
        throw new ApiError(409, "insufficient_balance", `in-app balance is below the ${what}`, {
          balanceCC: formatCC(ctx.walletBalance),
          requiredCC: formatCC(cost),
        });
    };
    const needShares = (pos: PositionEntity, side: TradeSide, shares: bigint): void => {
      const held = side === "Yes" ? pos.yesShares : pos.noShares;
      if (held < shares)
        throw new ApiError(409, "insufficient_shares", `the position holds fewer ${side} shares`, {
          heldShares: formatCC(held),
          requestedShares: formatCC(shares),
        });
    };
    switch (req.action) {
      case "buy": {
        const side = requireSide(req.side);
        const collateral = requirePositive(req.amountCC, "amountCC");
        needBalance(collateral, "collateral");
        return {
          choice: "Buy",
          value: {
            buyer: ctx.party,
            side,
            collateralCC: formatCC(collateral),
            minSharesOut: ctx.quote?.bounds.minSharesOut ?? formatCC(0n),
            nowSeconds: now,
            existingPosition: ctx.position?.contractId ?? null,
            walletCid: ctx.walletCid,
          },
        };
      }
      case "sell": {
        const side = requireSide(req.side);
        const shares = requirePositive(req.shares, "shares");
        const pos = needPosition();
        needShares(pos, side, shares);
        return {
          choice: "Sell",
          value: {
            seller: ctx.party,
            side,
            sharesIn: formatCC(shares),
            minProceedsCC: ctx.quote?.bounds.minProceedsCC ?? formatCC(0n),
            nowSeconds: now,
            positionCid: pos.contractId,
            walletCid: ctx.walletCid,
          },
        };
      }
      case "swap": {
        const fromSide = requireSide(req.side);
        const shares = requirePositive(req.shares, "shares");
        const pos = needPosition();
        needShares(pos, fromSide, shares);
        return {
          choice: "SwapShares",
          value: {
            swapper: ctx.party,
            fromSide,
            sharesIn: formatCC(shares),
            minSharesOut: ctx.quote?.bounds.minSharesOut ?? formatCC(0n),
            nowSeconds: now,
            positionCid: pos.contractId,
          },
        };
      }
      case "split": {
        const amount = requirePositive(req.amountCC, "amountCC");
        needBalance(amount, "amount");
        return {
          choice: "Split",
          value: {
            user: ctx.party,
            amount: formatCC(amount),
            nowSeconds: now,
            existingPosition: ctx.position?.contractId ?? null,
            walletCid: ctx.walletCid,
          },
        };
      }
      case "merge": {
        const amount = requirePositive(req.amountCC, "amountCC");
        const pos = needPosition();
        needShares(pos, "Yes", amount);
        needShares(pos, "No", amount);
        return {
          choice: "Merge",
          value: {
            user: ctx.party,
            amount: formatCC(amount),
            nowSeconds: now,
            positionCid: pos.contractId,
            walletCid: ctx.walletCid,
          },
        };
      }
      case "provide_liquidity": {
        const value = requirePositive(req.amountCC, "amountCC");
        const maxCost = ctx.quote?.bounds.maxCostCC ?? formatCC(value);
        needBalance(BigInt(Math.ceil(Number(maxCost))) * 10_000_000_000n, "liquidity cost");
        return {
          choice: "ProvideLiquidity",
          value: {
            provider: ctx.party,
            valueIncreaseCC: formatCC(value),
            maxCostCC: maxCost,
            nowSeconds: now,
            existingLpPosition: ctx.lpPosition?.contractId ?? null,
            walletCid: ctx.walletCid,
          },
        };
      }
      case "withdraw_liquidity": {
        const lpTokens = requirePositive(req.lpTokens, "lpTokens");
        if (!ctx.lpPosition)
          throw new ApiError(409, "no_position", "no liquidity position in this market");
        if (ctx.lpPosition.lpTokens < lpTokens)
          throw new ApiError(409, "insufficient_shares", "the position holds fewer LP tokens", {
            heldShares: formatCC(ctx.lpPosition.lpTokens),
            requestedShares: formatCC(lpTokens),
          });
        return {
          choice: "WithdrawLiquidity",
          value: {
            provider: ctx.party,
            lpTokensToBurn: formatCC(lpTokens),
            nowSeconds: now,
            lpPositionCid: ctx.lpPosition.contractId,
            existingPosition: ctx.position?.contractId ?? null,
            walletCid: ctx.walletCid,
          },
        };
      }
      case "redeem": {
        const pos = needPosition();
        return {
          choice: "RedeemPosition",
          value: {
            holder: ctx.party,
            nowSeconds: now,
            positionCid: pos.contractId,
            walletCid: ctx.walletCid,
          },
        };
      }
    }
  }
}

function clampSlippage(bps: number | undefined): number {
  if (bps === undefined) return DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS)
    throw new ApiError(
      400,
      "validation_failed",
      `slippageBps must be an integer in 0..${MAX_SLIPPAGE_BPS}`,
    );
  return bps;
}

function requireSide(side: TradeSide | undefined): TradeSide {
  if (side !== "Yes" && side !== "No")
    throw new ApiError(400, "validation_failed", "side must be Yes or No");
  return side;
}

function requirePositive(value: bigint | undefined, name: string): bigint {
  if (value === undefined || value <= 0n)
    throw new ApiError(400, "validation_failed", `${name} must be positive`);
  return value;
}
