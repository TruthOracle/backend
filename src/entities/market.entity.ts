import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

import type { MarketOutcome, MarketStatus } from "../types";
import { bigintNumberTransformer } from "../util/ledger-values";
import { moneyTransformer } from "../util/money";

/** `PredictionMarket.policy` as stored (Decimals as 10-dp strings — jsonb cannot hold bigint). */
export interface StoredResolutionPolicy {
  operatorResolution: boolean;
  sources: string[];
  sourceKeys: { sourceUri: string; publicKey: string }[];
  reporters: string[];
  quorum: number;
  challengeSecs: number;
  bond: string;
}

export interface StoredProposal {
  proposer: string;
  proposedOutcome: MarketOutcome;
  proposedAtSec: number;
  bond: string;
  challenger: string | null;
  challengerOutcome: MarketOutcome | null;
}

/**
 * The current version of every `PredictionMarket` (docs/INDEXER.md §3 `to_markets`): one row
 * per `marketId`, overwritten by each successor contract; the version history lives in
 * `to_market_snapshots`. `contract_id` is the ACTIVE contract (what a trade must exercise).
 * Only what the ledger holds is here — presentation lives in `to_market_metadata`.
 */
@Entity({ name: "to_markets" })
@Index("ix_to_markets_status", ["status"])
@Index("ix_to_markets_expires_at", ["expiresAtSec"])
@Index("ix_to_markets_event_ticker", ["eventTicker"])
@Index("ix_to_markets_collateral", ["collateralAdmin", "collateralId"])
export class MarketEntity {
  @PrimaryColumn({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Index("uq_to_markets_contract_id", { unique: true })
  @Column({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  admin!: string;

  /** `PredictionMarket.collateral` — the instrument every amount of this market is in (docs/TOKENS.md §2). Immutable. */
  @Column({ name: "collateral_admin", type: "text" })
  collateralAdmin!: string;

  @Column({ name: "collateral_id", type: "text" })
  collateralId!: string;

  @Column({ type: "text" })
  question!: string;

  /** The resolution terms — part of what a trader signs for, so the contract's own. */
  @Column({ name: "resolution_description", type: "text", default: "" })
  resolutionDescription!: string;

  // Presentation (image, description) is NOT here: it is `to_market_metadata`, backend-owned
  // (docs/MARKETS.md §1); the category is the series' through the event.

  // ── identity (docs/MARKETS.md §2): the contract's own ticker, event and side labels, nothing else ──

  /**
   * Kalshi-style ticker from `PredictionMarket.ticker` (trimmed, upper-cased). Unique: a later
   * contract naming a ticker the index already holds is stored as `<ticker>~<marketId>` and logged.
   */
  @Index("uq_to_markets_ticker", { unique: true })
  @Column({ type: "text" })
  ticker!: string;

  /** The event this market is one leg of (`to_events.ticker`); the projection creates a placeholder row when none exists. */
  @Column({ name: "event_ticker", type: "text" })
  eventTicker!: string;

  @Column({ name: "yes_sub_title", type: "text" })
  yesSubTitle!: string;

  @Column({ name: "no_sub_title", type: "text" })
  noSubTitle!: string;

  /** Package-id template of the ACTIVE version — what a disclosed contract must name. */
  @Column({ name: "template_id", type: "text", nullable: true })
  templateId!: string | null;

  /** Outstanding shares across the market's active positions, maintained by the projection (docs/INDEXER.md §5). */
  @Column({
    name: "open_interest_yes",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  openInterestYes!: bigint;

  @Column({
    name: "open_interest_no",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  openInterestNo!: bigint;

  @Column({ name: "created_at_sec", type: "bigint", transformer: bigintNumberTransformer })
  createdAtSec!: number;

  @Column({ name: "expires_at_sec", type: "bigint", transformer: bigintNumberTransformer })
  expiresAtSec!: number;

  @Column({ name: "grace_period_secs", type: "integer", default: 0 })
  gracePeriodSecs!: number;

  @Column({ name: "is_dynamic", type: "boolean", default: false })
  isDynamic!: boolean;

  @Column({ name: "liquidity_period_secs", type: "integer", default: 0 })
  liquidityPeriodSecs!: number;

  @Column({
    name: "reserve_yes",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  reserveYes!: bigint;

  @Column({
    name: "reserve_no",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  reserveNo!: bigint;

  @Column({
    name: "liquidity_l",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  liquidityL!: bigint;

  @Column({
    name: "lp_token_supply",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  lpTokenSupply!: bigint;

  @Column({
    name: "current_price",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  currentPrice!: bigint;

  @Column({ name: "fee_bps", type: "integer", default: 0 })
  feeBps!: number;

  @Column({ name: "prize_fee_share_bps", type: "integer", default: 0 })
  prizeFeeShareBps!: number;

  @Column({
    name: "accumulated_fees",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  accumulatedFees!: bigint;

  @Column({
    name: "prize_pool",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  prizePool!: bigint;

  @Column({
    name: "total_volume",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  totalVolume!: bigint;

  @Column({ type: "text", default: "Trading" })
  status!: MarketStatus;

  @Column({ type: "text", nullable: true })
  outcome!: MarketOutcome | null;

  @Column({
    name: "resolved_at_sec",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  resolvedAtSec!: number | null;

  @Column({ type: "jsonb", nullable: true })
  proposal!: StoredProposal | null;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  policy!: StoredResolutionPolicy;

  @Column({ name: "audit_observers", type: "jsonb", default: () => "'[]'::jsonb" })
  auditObservers!: string[];

  /** The disclosed-contract blob of the ACTIVE version (a user-signed trade must disclose the market). */
  @Column({ name: "created_event_blob", type: "text", nullable: true })
  createdEventBlob!: string | null;

  @Column({ name: "synchronizer_id", type: "text", nullable: true })
  synchronizerId!: string | null;

  /** Offset of the transaction that created the FIRST version (CreateMarket). */
  @Column({ name: "created_offset", type: "bigint", transformer: bigintNumberTransformer })
  createdOffset!: number;

  /** Offset of the transaction that produced the current version. */
  @Index("ix_to_markets_updated_offset")
  @Column({ name: "updated_offset", type: "bigint", transformer: bigintNumberTransformer })
  updatedOffset!: number;

  @Column({ name: "created_at_ledger", type: "timestamptz", nullable: true })
  createdAtLedger!: Date | null;

  @Column({ name: "updated_at_ledger", type: "timestamptz", nullable: true })
  updatedAtLedger!: Date | null;

  /** Consumed with no successor version (ArchiveMarket / Archive). */
  @Column({ type: "boolean", default: false })
  archived!: boolean;

  @Column({
    name: "archived_offset",
    type: "bigint",
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  archivedOffset!: number | null;

  @Column({ name: "trade_count", type: "integer", default: 0 })
  tradeCount!: number;

  @Column({ name: "last_trade_at", type: "timestamptz", nullable: true })
  lastTradeAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
