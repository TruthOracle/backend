import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

import type { CatalogValueSource, MarketOutcome, MarketStatus } from "../types";
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
  bondCC: string;
}

export interface StoredProposal {
  proposer: string;
  proposedOutcome: MarketOutcome;
  proposedAtSec: number;
  bondCC: string;
  challenger: string | null;
  challengerOutcome: MarketOutcome | null;
}

/**
 * The current version of every `PredictionMarket` (docs/INDEXER.md §3 `to_markets`): one row
 * per `marketId`, overwritten by each successor contract; the version history lives in
 * `to_market_snapshots`. `contract_id` is the ACTIVE contract (what a trade must exercise).
 */
@Entity({ name: "to_markets" })
@Index("ix_to_markets_status", ["status"])
@Index("ix_to_markets_category", ["category"])
@Index("ix_to_markets_expires_at", ["expiresAtSec"])
@Index("ix_to_markets_event_ticker", ["eventTicker"])
export class MarketEntity {
  @PrimaryColumn({ name: "market_id", type: "bigint", transformer: bigintNumberTransformer })
  marketId!: number;

  @Index("uq_to_markets_contract_id", { unique: true })
  @Column({ name: "contract_id", type: "text" })
  contractId!: string;

  @Column({ type: "text" })
  admin!: string;

  @Column({ type: "text" })
  question!: string;

  @Column({ name: "image_url", type: "text", default: "" })
  imageUrl!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ name: "resolution_description", type: "text", default: "" })
  resolutionDescription!: string;

  @Column({ type: "text", default: "" })
  category!: string;

  // ── catalog identity (docs/MARKETS.md §2): the ledger value wins, a catalog assignment fills a None ──

  /** Kalshi-style ticker: on-ledger (`PredictionMarket.ticker`), else catalog-assigned, else `MKT-<marketId>`. */
  @Index("uq_to_markets_ticker", { unique: true })
  @Column({ type: "text" })
  ticker!: string;

  @Column({ name: "ticker_source", type: "text", default: "synthetic" })
  tickerSource!: CatalogValueSource;

  /** The event this market belongs to (`to_events.ticker`); null until the ledger or an operator says. */
  @Column({ name: "event_ticker", type: "text", nullable: true })
  eventTicker!: string | null;

  @Column({ name: "event_ticker_source", type: "text", nullable: true })
  eventTickerSource!: Exclude<CatalogValueSource, "synthetic"> | null;

  @Column({ name: "yes_sub_title", type: "text", default: "" })
  yesSubTitle!: string;

  @Column({ name: "no_sub_title", type: "text", default: "" })
  noSubTitle!: string;

  /** `true` once the ledger fixed the sub titles (an operator may only fill blanks). */
  @Column({ name: "sub_titles_from_ledger", type: "boolean", default: false })
  subTitlesFromLedger!: boolean;

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
    name: "accumulated_fees_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  accumulatedFeesCC!: bigint;

  @Column({
    name: "prize_pool_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  prizePoolCC!: bigint;

  @Column({
    name: "total_volume_cc",
    type: "numeric",
    precision: 38,
    scale: 10,
    default: 0,
    transformer: moneyTransformer,
  })
  totalVolumeCC!: bigint;

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
