/**
 * The projection: one ledger transaction in, typed rows out (docs/INDEXER.md §5). Everything here
 * runs inside the EntityManager the caller opened, so the raw events, the typed tables and the
 * cursor advance in ONE Postgres transaction — a crash between them cannot leave the index
 * half-applied, and a replayed transaction is detected on `to_ledger_events.event_id` and
 * skipped as a whole.
 *
 * Numbers are never re-computed from the AMM formulas: every derived figure is a difference
 * between two ledger states (the consumed contract and its successor) or a value the ledger
 * wrote into a choice argument / a child exercise (the UserWallet Debit / Credit amount).
 */
import { Logger } from "@nestjs/common";
import { In, type EntityManager } from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";

import { AttestationEntity } from "../entities/attestation.entity";
import { INDEXER_STATE_KEY, IndexerStateEntity } from "../entities/indexer-state.entity";
import { LedgerEventEntity } from "../entities/ledger-event.entity";
import { LedgerHoldingEntity } from "../entities/ledger-holding.entity";
import { LedgerPayoutEntity } from "../entities/ledger-payout.entity";
import { LedgerTransferInstructionEntity } from "../entities/ledger-transfer-instruction.entity";
import { LedgerTransferEntity } from "../entities/ledger-transfer.entity";
import { LedgerWalletEntity } from "../entities/ledger-wallet.entity";
import { LiquidityPositionEntity } from "../entities/liquidity-position.entity";
import { MarketEventEntity } from "../entities/market-event.entity";
import { MarketSnapshotEntity } from "../entities/market-snapshot.entity";
import {
  MarketEntity,
  type StoredProposal,
  type StoredResolutionPolicy,
} from "../entities/market.entity";
import { ModelForecastEntity } from "../entities/model-forecast.entity";
import { PositionEntity } from "../entities/position.entity";
import { PredictionModelEntity } from "../entities/prediction-model.entity";
import { WalletEntryEntity } from "../entities/wallet-entry.entity";
import {
  instrumentKey,
  TICKER_PATTERN,
  TRADE_KINDS,
  type InstrumentId,
  type LedgerTransferRecord,
  type MarketEventKind,
  type MarketOutcome,
  type MarketStatus,
  type TradeSide,
  type TransferKind,
  type WalletEntryKind,
} from "../types";
import {
  asBool,
  asDecimal,
  asEnum,
  asInt,
  asList,
  asOptional,
  asOptionalDecimal,
  asOptionalInt,
  asOptionalText,
  asRecord,
  asText,
  asTextList,
} from "../util/ledger-values";
import { formatAmount } from "../util/money";
import {
  CANDLE_PERIOD_SECS,
  CANDLE_TRADE_CHOICES,
  candleUpsert,
  OPEN_INTEREST_RECOMPUTE_SQL,
  type CandleContribution,
} from "./candles";
import {
  acsEventIdOf,
  buildEventTree,
  descendantsOf,
  eventIdOf,
  flattenTree,
  type ActiveContractEntry,
  type CreatedLedgerEvent,
  type EventNode,
  type ExercisedLedgerEvent,
  type LedgerEvent,
  type LedgerTransaction,
} from "./events";
import { extractTreasuryTransfers } from "./splice";
import {
  extractTokenStandard,
  holdingViewOf,
  transferInstructionViewOf,
  type HoldingView,
  type TransferInstructionView,
} from "./token-standard";

/** Templates whose only signatory is `admin` (truthoracle-v17): projected only when `admin` is the treasury. */
const ADMIN_SIGNED = new Set([
  "Truthoracle:PredictionMarket",
  "Truthoracle:UserWallet",
  "Truthoracle:PendingPayout",
  "Truthoracle:MarketCounter",
]);

export interface ProjectionConfig {
  /** `daml.yaml` name of the deployed TruthOracle package (`truthoracle-v17`). */
  packageName: string;
  /** `packageName` the participant reports for Splice Amulet events (Canton Coin transfers are always indexed). */
  splicePackageName: string;
  treasury: string;
}

/** What one applied transaction changed — the NATS fan-out is built from this after commit. */
export interface ApplySummary {
  updateId: string;
  offset: number;
  events: number;
  marketsUpdated: { marketId: number; cause: string | null }[];
  marketEvents: { kind: MarketEventKind; marketId: number; actor: string; eventId: string }[];
  walletEntries: { owner: string; kind: WalletEntryKind; eventId: string }[];
  payouts: { contractId: string; change: "created" | "settled" }[];
  transfers: {
    direction: "in" | "out";
    counterparty: string;
    instrument: InstrumentId;
    kind: TransferKind;
    nodeId: number;
  }[];
  /** Two-step offers addressed to the treasury that were accepted in this transaction (`truthoracle.transfer.instruction_accepted`). */
  instructionsAccepted: { contractId: string; instrument: InstrumentId }[];
  /** Every collateral / wallet instrument this transaction named — the indexer registers unknown ones (docs/TOKENS.md §4.1). */
  instrumentsSeen: InstrumentId[];
}

export interface ApplyResult {
  /** false = every event of this transaction was already indexed (a replay) — nothing was written. */
  applied: boolean;
  summary: ApplySummary;
}

const TRUTHORACLE_MODULES: ReadonlySet<string> = new Set(["Truthoracle", "Marketplace"]);

/** Market choices → activity kinds (docs/INDEXER.md §5). */
const MARKET_CHOICE_KINDS: Record<string, MarketEventKind> = {
  Buy: "buy",
  Sell: "sell",
  SwapShares: "swap",
  Split: "split",
  Merge: "merge",
  ProvideLiquidity: "provide_liquidity",
  WithdrawLiquidity: "withdraw_liquidity",
  ResolveT0: "resolve_t0",
  Resolve: "resolve",
  ProposeOutcome: "propose",
  ChallengeOutcome: "challenge",
  FinalizeOutcome: "finalize",
  VoidMarket: "void",
  RedeemPosition: "redeem",
  CommitForecast: "commit_forecast",
  ScoreAndDistribute: "score_and_distribute",
  ArchiveMarket: "archive",
  Archive: "archive",
};

function outcomeOf(value: unknown): MarketOutcome | null {
  const tag = asEnum(asOptional(value));
  return tag === "Yes" || tag === "No" || tag === "VoidOutcome" ? tag : null;
}

function sideOf(value: unknown): TradeSide | null {
  const tag = asEnum(value);
  return tag === "Yes" || tag === "No" ? tag : null;
}

function statusOf(value: unknown): MarketStatus {
  const tag = asEnum(value);
  return tag === "Proposed" || tag === "Resolved" || tag === "Voided" ? tag : "Trading";
}

/**
 * `InstrumentId { admin, id }` from a v17 payload. Mandatory on every PredictionMarket, UserWallet
 * and PendingPayout, so a missing value is not tolerated into "" — an amount without its
 * instrument would be read as some default token. The error stops the index at this transaction
 * (recorded in `to_indexer_state.last_error`), which is right: a payload without the field is a
 * package the index was not built for.
 */
function instrumentOf(value: unknown, what: string): InstrumentId {
  const r = asRecord(value);
  const admin = asText(r.admin).trim();
  const id = asText(r.id).trim();
  if (!admin || !id)
    throw new Error(
      `${what} carries no instrument (admin / id): is TRUTHORACLE_PACKAGE_NAME the deployed truthoracle-v17?`,
    );
  return { admin, id };
}

function policyOf(value: unknown): StoredResolutionPolicy {
  const p = asRecord(value);
  return {
    operatorResolution: asBool(p.operatorResolution),
    sources: asTextList(p.sources),
    sourceKeys: asList(p.sourceKeys).map((k) => {
      const r = asRecord(k);
      return { sourceUri: asText(r.sourceUri), publicKey: asText(r.publicKey) };
    }),
    reporters: asTextList(p.reporters),
    quorum: asInt(p.quorum),
    challengeSecs: asInt(p.challengeSecs),
    bond: formatAmount(asDecimal(p.bond)),
  };
}

function proposalOf(value: unknown): StoredProposal | null {
  const raw = asOptional(value);
  if (!raw || typeof raw !== "object") return null;
  const p = asRecord(raw);
  const proposedOutcome = outcomeOf(p.proposedOutcome);
  if (!proposedOutcome) return null;
  return {
    proposer: asText(p.proposer),
    proposedOutcome,
    proposedAtSec: asInt(p.proposedAt),
    bond: formatAmount(asDecimal(p.bond)),
    challenger: asOptionalText(p.challenger),
    challengerOutcome: outcomeOf(p.challengerOutcome),
  };
}

/** Contract ids in choice arguments: a bare string, or null / a wrapper for `Optional (ContractId a)`. */
function cidOf(value: unknown): string | null {
  const v = asOptional(value);
  return typeof v === "string" && v ? v : null;
}

/**
 * A JSON-clean copy for a jsonb column. Typed `never` on purpose: TypeORM's `QueryDeepPartialEntity`
 * maps a `Record<string, unknown>` column to a shape plain objects do not satisfy, and `never` is
 * assignable to it — the value itself is just `JSON.parse(JSON.stringify(v))`.
 */
function jsonSafe(value: unknown): never {
  return JSON.parse(JSON.stringify(value ?? {})) as never;
}

/** Same for a nullable `unknown` jsonb column (exercise results). */
function jsonOrNull(value: unknown): never {
  return (
    value === null || value === undefined ? null : JSON.parse(JSON.stringify(value))
  ) as never;
}

export class LedgerProjection {
  private readonly logger = new Logger(LedgerProjection.name);

  constructor(private readonly cfg: ProjectionConfig) {}

  /** A TruthOracle event: the deployed package by name, or (when the participant omits the name) one of the package's modules. */
  isOurs(event: LedgerEvent): boolean {
    if (event.packageName) return event.packageName === this.cfg.packageName;
    return TRUTHORACLE_MODULES.has(event.module);
  }

  // ───────────────────────────────────────────── transactions ─────────────────────────────────────────────

  async applyTransaction(manager: EntityManager, tx: LedgerTransaction): Promise<ApplyResult> {
    const summary: ApplySummary = {
      updateId: tx.updateId,
      offset: tx.offset,
      events: 0,
      marketsUpdated: [],
      marketEvents: [],
      walletEntries: [],
      payouts: [],
      transfers: [],
      instructionsAccepted: [],
      instrumentsSeen: [],
    };
    const ours = tx.events.filter((e) => this.isOurs(e));
    summary.events = ours.length;

    if (ours.length > 0) {
      const roots = buildEventTree(ours);
      const nodes = flattenTree(roots);
      const inserted = await this.insertRawEvents(manager, tx, nodes);
      if (inserted === 0) return { applied: false, summary };

      const ctx = new TxContext(manager, tx);
      // 1. state: creates and consuming exercises, in ledger (nodeId) order
      for (const node of nodes) {
        if (node.event.kind === "created") await this.applyCreated(ctx, node.event, node);
        else if (node.event.consuming) await this.applyConsumed(ctx, node.event);
      }
      // 2. activity derived from the exercises, with the before / after states at hand
      for (const node of nodes) {
        if (node.event.kind !== "exercised") continue;
        await this.deriveFromExercise(ctx, node, summary);
      }
      // 3. a consumed market without a successor version in this transaction is gone
      for (const [cid, marketId] of ctx.consumedMarkets) {
        if (ctx.createdMarketIds.has(marketId)) continue;
        await manager
          .createQueryBuilder()
          .update(MarketEntity)
          .set({ archived: true, archivedOffset: tx.offset, updatedAtLedger: tx.effectiveAt })
          .where("market_id = :marketId AND contract_id = :cid", { marketId, cid })
          .execute();
        summary.marketsUpdated.push({ marketId, cause: "archived" });
      }
      for (const [marketId, cause] of ctx.marketCauses)
        summary.marketsUpdated.push({ marketId, cause });
      // 4. candles: every market version of this transaction, with the open interest as it
      //    stands now that every Position of the transaction is applied (docs/MARKETS.md §5)
      await this.flushCandles(ctx);
      summary.instrumentsSeen = [...ctx.instrumentsSeen.values()];
    }

    // Treasury transfers, always on, in any instrument (docs/INDEXER.md §6): first the token
    // standard (holdings, two-step instructions and the TransferFactory_Transfer /
    // TransferInstruction_Accept exercises over the interface views), then Canton Coin from the
    // Splice Amulet events for whatever the first derivation did not claim.
    const claimed = await this.applyTokenStandard(manager, tx, summary);
    for (const t of extractTreasuryTransfers(
      tx,
      this.cfg.treasury,
      this.cfg.splicePackageName,
      claimed,
    ))
      await this.insertTransfer(manager, t, summary);

    return { applied: true, summary };
  }

  // ───────────────────────────────────────────── token standard ─────────────────────────────────────────────

  /**
   * Holdings, two-step instructions and transfers of every CIP-56 token in the transaction
   * (docs/TOKENS.md §4.2 step 1). The pure derivation needs to know the contracts the transaction
   * consumes — the index's own rows for the treasury's holdings and the instructions it is party
   * to — so those are read first by contract id. Returns the node ids the derivation claimed.
   */
  private async applyTokenStandard(
    manager: EntityManager,
    tx: LedgerTransaction,
    summary: ApplySummary,
  ): Promise<Set<number>> {
    const treasury = this.cfg.treasury;
    const consumed = [
      ...new Set(
        tx.events
          .filter((e): e is ExercisedLedgerEvent => e.kind === "exercised" && e.consuming)
          .map((e) => e.contractId),
      ),
    ];
    const holdings = new Map<string, HoldingView>();
    const instructions = new Map<string, TransferInstructionView>();
    if (consumed.length > 0) {
      for (const h of await manager
        .getRepository(LedgerHoldingEntity)
        .find({ where: { contractId: In(consumed) } }))
        holdings.set(h.contractId, holdingOfRow(h));
      for (const i of await manager
        .getRepository(LedgerTransferInstructionEntity)
        .find({ where: { contractId: In(consumed) } }))
        instructions.set(i.contractId, instructionOfRow(i));
    }
    const derived = extractTokenStandard(tx, treasury, { holdings, instructions });

    // 1. state: the treasury's new holdings and the offers it is party to, then what was consumed
    for (const h of derived.holdingsCreated) {
      if (h.owner !== treasury) continue;
      await this.insertHolding(manager, h, tx.offset);
    }
    for (const i of derived.instructionsCreated) {
      if (i.sender !== treasury && i.receiver !== treasury) continue;
      await this.insertInstruction(manager, i, tx.offset);
    }
    for (const c of derived.holdingsConsumed) {
      await manager
        .createQueryBuilder()
        .update(LedgerHoldingEntity)
        .set({ archivedOffset: tx.offset })
        .where("contract_id = :cid AND archived_offset IS NULL", { cid: c.contractId })
        .execute();
    }
    for (const o of derived.instructionOutcomes) {
      const res = await manager
        .createQueryBuilder()
        .update(LedgerTransferInstructionEntity)
        .set({ status: o.status, archivedOffset: tx.offset })
        .where("contract_id = :cid AND archived_offset IS NULL", { cid: o.contractId })
        .execute();
      const known = instructions.get(o.contractId);
      if ((res.affected ?? 0) > 0 && o.status === "completed" && known?.receiver === treasury)
        summary.instructionsAccepted.push({
          contractId: o.contractId,
          instrument: known.instrument,
        });
    }
    for (const u of derived.unattributed)
      this.logger.warn(
        `${u.choice} on TransferInstruction ${u.contractId} (update ${tx.updateId}, node ${u.nodeId}): the index never saw the offer, nothing attributed`,
      );
    // 2. activity
    for (const t of derived.transfers) await this.insertTransfer(manager, t, summary);
    return derived.claimedNodeIds;
  }

  private async insertHolding(
    manager: EntityManager,
    h: HoldingView,
    createdOffset: number,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(LedgerHoldingEntity)
      .updateEntity(false)
      .values({
        contractId: h.contractId,
        owner: h.owner,
        instrumentAdmin: h.instrument.admin,
        instrumentId: h.instrument.id,
        amount: h.amount,
        locked: h.locked,
        lockExpiresAt: h.lockExpiresAt,
        createdOffset,
        archivedOffset: null,
      })
      .orIgnore()
      .execute();
  }

  private async insertInstruction(
    manager: EntityManager,
    i: TransferInstructionView,
    createdOffset: number,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(LedgerTransferInstructionEntity)
      .updateEntity(false)
      .values({
        contractId: i.contractId,
        instrumentAdmin: i.instrument.admin,
        instrumentId: i.instrument.id,
        sender: i.sender,
        receiver: i.receiver,
        amount: i.amount,
        executeBefore: i.executeBefore,
        status: "pending",
        createdOffset,
        archivedOffset: null,
      })
      .orIgnore()
      .execute();
  }

  /** One `to_ledger_transfers` row (unique per update and node; a replay is ignored) and its NATS announcement. */
  private async insertTransfer(
    manager: EntityManager,
    t: LedgerTransferRecord,
    summary: ApplySummary,
  ): Promise<void> {
    const res = await manager
      .createQueryBuilder()
      .insert()
      .into(LedgerTransferEntity)
      .updateEntity(false)
      .values({
        updateId: t.updateId,
        nodeId: t.nodeId,
        offset: t.offset,
        direction: t.direction,
        counterparty: t.counterparty,
        instrumentAdmin: t.instrument.admin,
        instrumentId: t.instrument.id,
        amount: t.amount,
        kind: t.kind,
        choice: t.choice,
        recordTime: t.recordTime,
        effectiveAt: t.effectiveAt,
        details: jsonSafe(t.details),
      })
      .orIgnore()
      .returning("id")
      .execute();
    if ((res.raw as unknown[]).length > 0)
      summary.transfers.push({
        direction: t.direction,
        counterparty: t.counterparty,
        instrument: t.instrument,
        kind: t.kind,
        nodeId: t.nodeId,
      });
  }

  /** Raw rows for every TruthOracle event; returns how many were new (0 = the whole transaction is a replay). */
  private async insertRawEvents(
    manager: EntityManager,
    tx: LedgerTransaction,
    nodes: EventNode[],
  ): Promise<number> {
    const rows = nodes.map((node) => this.rawRow(tx, node));
    const res = await manager
      .createQueryBuilder()
      .insert()
      .into(LedgerEventEntity)
      .updateEntity(false)
      .values(rows)
      .orIgnore()
      .returning("id")
      .execute();
    return (res.raw as unknown[]).length;
  }

  private rawRow(
    tx: LedgerTransaction,
    node: EventNode,
  ): QueryDeepPartialEntity<LedgerEventEntity> {
    const e = node.event;
    const base: QueryDeepPartialEntity<LedgerEventEntity> = {
      eventId: eventIdOf(tx.updateId, e.nodeId),
      offset: tx.offset,
      nodeId: e.nodeId,
      updateId: tx.updateId,
      kind: e.kind,
      packageName: e.packageName,
      module: e.module,
      entity: e.entity,
      templateId: e.templateId,
      contractId: e.contractId,
      witnessParties: e.witnessParties,
      parentNodeId: node.parent ? node.parent.event.nodeId : null,
      rootNodeId: node.root.event.nodeId,
      effectiveAt: tx.effectiveAt,
      recordTime: tx.recordTime,
      commandId: tx.commandId,
      workflowId: tx.workflowId,
      synchronizerId: tx.synchronizerId,
    };
    if (e.kind === "created") {
      return {
        ...base,
        choice: null,
        consuming: null,
        actingParties: [],
        signatories: e.signatories,
        observers: e.observers,
        payload: jsonSafe(e.createArgument),
        result: jsonOrNull(null),
        lastDescendantNodeId: null,
      };
    }
    return {
      ...base,
      choice: e.choice,
      consuming: e.consuming,
      actingParties: e.actingParties,
      signatories: null,
      observers: null,
      payload: jsonSafe(e.choiceArgument),
      result: jsonOrNull(e.exerciseResult),
      lastDescendantNodeId: e.lastDescendantNodeId,
    };
  }

  // ───────────────────────────────────────────── ACS snapshot ─────────────────────────────────────────────

  /**
   * Bootstrap / resync from an ACS snapshot taken at `atOffset`: every active contract becomes a
   * typed row (and a raw `acs:<cid>` event); in `resync` mode active rows the snapshot no longer
   * lists are marked archived — they were consumed inside the range the index never saw.
   */
  async applyActiveContracts(
    manager: EntityManager,
    entries: ActiveContractEntry[],
    atOffset: number,
    mode: "bootstrap" | "resync",
  ): Promise<{ inserted: number; archived: number; holdings: number; instructions: number }> {
    let inserted = 0;
    let holdings = 0;
    let instructions = 0;
    const seen = new Set<string>();
    const seeds: CandleContribution[] = [];
    // A snapshot entry normally carries the contract's ledger time; one that does not is dated at
    // the snapshot itself, never at the epoch: a candle seeded there would drag a flat line across
    // decades of empty periods.
    const snapshotTime = new Date();
    const tokenContracts = new Set<string>();
    for (const entry of entries) {
      const e = entry.created;
      // Token-standard contracts come from any package: the treasury's holdings and the offers it
      // is party to are state the snapshot carries (docs/TOKENS.md §4.2).
      const holding = holdingViewOf(e);
      if (holding && holding.owner === this.cfg.treasury) {
        await this.insertHolding(manager, holding, e.offset);
        tokenContracts.add(e.contractId);
        holdings += 1;
      }
      const instruction = transferInstructionViewOf(e);
      if (
        instruction &&
        (instruction.sender === this.cfg.treasury || instruction.receiver === this.cfg.treasury)
      ) {
        await this.insertInstruction(manager, instruction, e.offset);
        tokenContracts.add(e.contractId);
        instructions += 1;
      }
      if (!this.isOurs(e)) continue;
      seen.add(e.contractId);
      const res = await manager
        .createQueryBuilder()
        .insert()
        .into(LedgerEventEntity)
        .updateEntity(false)
        .values({
          eventId: acsEventIdOf(e.contractId),
          offset: e.offset,
          nodeId: e.nodeId,
          updateId: "acs",
          kind: "created",
          packageName: e.packageName,
          module: e.module,
          entity: e.entity,
          templateId: e.templateId,
          contractId: e.contractId,
          choice: null,
          consuming: null,
          actingParties: [],
          witnessParties: e.witnessParties,
          signatories: e.signatories,
          observers: e.observers,
          payload: jsonSafe(e.createArgument),
          result: jsonOrNull(null),
          parentNodeId: null,
          rootNodeId: null,
          lastDescendantNodeId: null,
          effectiveAt: e.createdAt ?? snapshotTime,
          recordTime: null,
          commandId: null,
          workflowId: null,
          synchronizerId: entry.synchronizerId,
        })
        .orIgnore()
        .returning("id")
        .execute();
      if ((res.raw as unknown[]).length > 0) inserted += 1;
      const pseudoTx: LedgerTransaction = {
        updateId: "acs",
        offset: e.offset,
        effectiveAt: e.createdAt ?? snapshotTime,
        recordTime: null,
        commandId: null,
        workflowId: null,
        synchronizerId: entry.synchronizerId,
        events: [e],
      };
      const ctx = new TxContext(manager, pseudoTx);
      await this.applyCreated(ctx, e, null, acsEventIdOf(e.contractId));
      seeds.push(...ctx.marketVersions);
    }

    let archived = 0;
    if (mode === "resync") {
      const cids = [...seen];
      const gone = "active = true AND NOT (contract_id = ANY(:cids::text[]))";
      const archive = { active: false, archivedOffset: atOffset, archivedChoice: "resync" };
      const consumed = { active: false, archivedOffset: atOffset };
      // One statement at a time: they share the transaction's single connection.
      const statements = [
        manager.createQueryBuilder().update(PositionEntity).set(archive).where(gone, { cids }),
        manager
          .createQueryBuilder()
          .update(LiquidityPositionEntity)
          .set(archive)
          .where(gone, { cids }),
        manager.createQueryBuilder().update(LedgerWalletEntity).set(archive).where(gone, { cids }),
        manager
          .createQueryBuilder()
          .update(LedgerPayoutEntity)
          .set({ active: false, settledKind: "archived", settledOffset: atOffset })
          .where(gone, { cids }),
        manager.createQueryBuilder().update(AttestationEntity).set(consumed).where(gone, { cids }),
        manager
          .createQueryBuilder()
          .update(ModelForecastEntity)
          .set(consumed)
          .where(gone, { cids }),
        manager
          .createQueryBuilder()
          .update(PredictionModelEntity)
          .set(consumed)
          .where(gone, { cids }),
        manager
          .createQueryBuilder()
          .update(MarketEntity)
          .set({ archived: true, archivedOffset: atOffset })
          .where("archived = false AND NOT (contract_id = ANY(:cids::text[]))", { cids }),
      ];
      for (const statement of statements) archived += (await statement.execute()).affected ?? 0;
      // A holding or an offer the snapshot no longer lists was consumed inside the range the
      // index never saw; the offer's outcome is unknown, so its status is left as it was and only
      // `archived_offset` says it is gone.
      const tokenCids = [...tokenContracts];
      const goneToken = "archived_offset IS NULL AND NOT (contract_id = ANY(:cids::text[]))";
      archived +=
        (
          await manager
            .createQueryBuilder()
            .update(LedgerHoldingEntity)
            .set({ archivedOffset: atOffset })
            .where(goneToken, { cids: tokenCids })
            .execute()
        ).affected ?? 0;
      archived +=
        (
          await manager
            .createQueryBuilder()
            .update(LedgerTransferInstructionEntity)
            .set({ archivedOffset: atOffset })
            .where(goneToken, { cids: tokenCids })
            .execute()
        ).affected ?? 0;
    }
    // Snapshot rows carry no history: open interest is recomputed from the active positions and
    // every market gets one candle at its snapshot price, so a chart starts where the index does.
    await manager.query(OPEN_INTEREST_RECOMPUTE_SQL);
    const oiCache = new Map<number, bigint>();
    for (const seed of seeds) {
      seed.openInterest = await this.openInterestOf(manager, seed.marketId, oiCache);
      for (const period of CANDLE_PERIOD_SECS) {
        const { sql, params } = candleUpsert(seed, period);
        await manager.query(sql, params);
      }
    }
    return { inserted, archived, holdings, instructions };
  }

  /** Step 4 of a transaction: fold the market versions into their candles (docs/MARKETS.md §5). */
  private async flushCandles(ctx: TxContext): Promise<void> {
    if (ctx.marketVersions.length === 0) return;
    const oiCache = new Map<number, bigint>();
    for (const version of ctx.marketVersions) {
      version.openInterest = await this.openInterestOf(ctx.manager, version.marketId, oiCache);
      for (const period of CANDLE_PERIOD_SECS) {
        const { sql, params } = candleUpsert(version, period);
        await ctx.manager.query(sql, params);
      }
    }
  }

  private async openInterestOf(
    manager: EntityManager,
    marketId: number,
    cache: Map<number, bigint>,
  ): Promise<bigint> {
    const hit = cache.get(marketId);
    if (hit !== undefined) return hit;
    const rows = await manager.query<{ yes: string; no: string }[]>(
      `SELECT open_interest_yes::text AS yes, open_interest_no::text AS no FROM to_markets WHERE market_id = $1`,
      [String(marketId)],
    );
    const oi = rows.length > 0 ? asDecimal(rows[0].yes) + asDecimal(rows[0].no) : 0n;
    cache.set(marketId, oi);
    return oi;
  }

  /**
   * A market's identity is the contract's own (`ticker`, `eventTicker`, `yesSubTitle`,
   * `noSubTitle` — mandatory Text on truthoracle-v17, docs/MARKETS.md §2), normalised the way
   * every ticker input is (trimmed, upper-cased). The index takes it as it is and only protects
   * itself: a ticker another market already holds is stored as `<ticker>~<marketId>` because
   * the column is unique and the index must never stall on operator data, and a malformed
   * ticker is kept but logged (the market stays addressable by id).
   */
  private async marketIdentityOf(
    m: EntityManager,
    marketId: number,
    p: Record<string, unknown>,
  ): Promise<{ ticker: string; eventTicker: string; yesSubTitle: string; noSubTitle: string }> {
    let ticker = asText(p.ticker).trim().toUpperCase();
    if (!TICKER_PATTERN.test(ticker))
      this.logger.warn(
        `market ${marketId}: on-ledger ticker "${asText(p.ticker)}" is not a valid ticker; kept as-is`,
      );
    const taken = await m.query<{ market_id: string }[]>(
      `SELECT market_id FROM to_markets WHERE ticker = $1 AND market_id <> $2`,
      [ticker, String(marketId)],
    );
    if (taken.length > 0) {
      this.logger.error(
        `market ${marketId}: on-ledger ticker ${ticker} is already used by market ${taken[0].market_id}; indexed as ${ticker}~${marketId} — void or archive the duplicate on-ledger`,
      );
      ticker = `${ticker}~${marketId}`;
    }
    const eventTicker = asText(p.eventTicker).trim().toUpperCase();
    if (!TICKER_PATTERN.test(eventTicker))
      this.logger.warn(
        `market ${marketId}: on-ledger eventTicker "${asText(p.eventTicker)}" is not a valid ticker; kept as-is`,
      );
    return {
      ticker,
      eventTicker,
      yesSubTitle: asText(p.yesSubTitle),
      noSubTitle: asText(p.noSubTitle),
    };
  }

  /**
   * The contract may name an event the operator has not written to the catalog yet (the market
   * was created first, or straight from a script). The catalog must never dangle, so the
   * projection creates a placeholder event — and a placeholder series named after the event
   * ticker's first segment — in the same transaction; an operator then edits them through
   * `/admin/events` and `/admin/series` (docs/MARKETS.md §2). The contract carries no
   * presentation, so the placeholders have no image and no category until the operator sets
   * them. Either way the first market fixes the event's collateral (docs/TOKENS.md §2 decision
   * 9): an event row without one takes this market's. Ledger-derived rows are not audited.
   */
  private async ensureCatalogEvent(
    m: EntityManager,
    marketId: number,
    eventTicker: string,
    market: { expiresAtSec: number; collateral: InstrumentId },
  ): Promise<void> {
    const exists = await m.query<unknown[]>(`SELECT 1 FROM to_events WHERE ticker = $1`, [
      eventTicker,
    ]);
    if (exists.length > 0) {
      await m.query(
        `UPDATE to_events SET collateral_admin = $2, collateral_id = $3, updated_at = now()
          WHERE ticker = $1 AND collateral_admin IS NULL`,
        [eventTicker, market.collateral.admin, market.collateral.id],
      );
      return;
    }
    const seriesTicker = placeholderSeriesTickerOf(eventTicker);
    await m.query(
      `INSERT INTO to_series (ticker, title) VALUES ($1, $1) ON CONFLICT (ticker) DO NOTHING`,
      [seriesTicker],
    );
    await m.query(
      `INSERT INTO to_events (ticker, series_ticker, title, strike_date, collateral_admin, collateral_id)
         VALUES ($1, $2, $1, to_timestamp($3), $4, $5)
       ON CONFLICT (ticker) DO NOTHING`,
      [
        eventTicker,
        seriesTicker,
        market.expiresAtSec,
        market.collateral.admin,
        market.collateral.id,
      ],
    );
    this.logger.log(
      `market ${marketId}: event ${eventTicker} was not in the catalog — placeholder event (series ${seriesTicker}) created; edit it through /admin/events`,
    );
  }

  // ───────────────────────────────────────────── creates ─────────────────────────────────────────────

  private async applyCreated(
    ctx: TxContext,
    e: CreatedLedgerEvent,
    node: EventNode | null,
    eventIdOverride?: string,
  ): Promise<void> {
    ctx.created.set(e.contractId, e.createArgument);
    const eventId = eventIdOverride ?? eventIdOf(ctx.tx.updateId, e.nodeId);
    const p = e.createArgument;
    const m = ctx.manager;
    const common = {
      active: true,
      createdOffset: ctx.tx.offset,
      createdEventId: eventId,
      createdAtLedger: e.createdAt ?? ctx.tx.effectiveAt,
      archivedOffset: null,
      archivedChoice: null,
      archivedAtLedger: null,
    };

    // Review R3-01: these templates are signed by `admin`, but the treasury also observes contracts any
    // party can create naming it as an audit observer. Only the ones the treasury signed are projected.
    if (ADMIN_SIGNED.has(`${e.module}:${e.entity}`) && asText(p.admin) !== this.cfg.treasury) {
      this.logger.error(
        `${e.module}:${e.entity} ${e.contractId} names admin ${asText(p.admin)}, not the treasury: not projected`,
      );
      return;
    }

    switch (`${e.module}:${e.entity}`) {
      case "Truthoracle:PredictionMarket": {
        const marketId = asInt(p.marketId);
        const cause = node ? nearestChoice(node) : null;
        const predecessorCid = node ? nearestMarketExerciseCid(node) : null;
        const before = predecessorCid ? await ctx.payloadOf(predecessorCid) : null;
        // the contract's identity, re-read on every version (successors copy it, the ledger owns it)
        const identity = await this.marketIdentityOf(m, marketId, p);
        const collateral = instrumentOf(p.collateral, `PredictionMarket ${e.contractId}`);
        ctx.instrumentsSeen.set(instrumentKey(collateral), collateral);
        const row: Partial<MarketEntity> = {
          marketId,
          contractId: e.contractId,
          templateId: e.templateId,
          ...identity,
          collateralAdmin: collateral.admin,
          collateralId: collateral.id,
          // open interest is maintained per Position event (bumpOpenInterest); a successor
          // version must not reset it, so both columns are excluded from the overwrite list too
          openInterestYes: 0n,
          openInterestNo: 0n,
          admin: asText(p.admin),
          question: asText(p.question),
          // no presentation here: v17 contracts carry none (to_market_metadata is backend-owned)
          resolutionDescription: asText(p.resolutionDescription),
          createdAtSec: asInt(p.createdAt),
          expiresAtSec: asInt(p.expiresAt),
          gracePeriodSecs: asInt(p.gracePeriodSecs),
          isDynamic: asBool(p.isDynamic),
          liquidityPeriodSecs: asInt(p.liquidityPeriodSecs),
          reserveYes: asDecimal(p.reserveYes),
          reserveNo: asDecimal(p.reserveNo),
          liquidityL: asDecimal(p.liquidityL),
          lpTokenSupply: asDecimal(p.lpTokenSupply),
          currentPrice: asDecimal(p.currentPrice),
          feeBps: asInt(p.feeBps),
          prizeFeeShareBps: asInt(p.prizeFeeShareBps),
          accumulatedFees: asDecimal(p.accumulatedFees),
          prizePool: asDecimal(p.prizePool),
          totalVolume: asDecimal(p.totalVolume),
          status: statusOf(p.status),
          outcome: outcomeOf(p.outcome),
          resolvedAtSec: asOptionalInt(asOptional(p.resolvedAt)),
          proposal: proposalOf(p.proposal),
          policy: policyOf(p.policy),
          auditObservers: asTextList(p.auditObservers),
          createdEventBlob: e.createdEventBlob,
          synchronizerId: ctx.tx.synchronizerId,
          createdOffset: ctx.tx.offset,
          updatedOffset: ctx.tx.offset,
          createdAtLedger: e.createdAt ?? ctx.tx.effectiveAt,
          updatedAtLedger: e.createdAt ?? ctx.tx.effectiveAt,
          archived: false,
          archivedOffset: null,
        };
        // Every column but the key, the first-version facts and the open-interest counters is
        // overwritten by a successor version (the identity included: the ledger owns it).
        const meta = m.connection.getMetadata(MarketEntity);
        const overwrite = Object.keys(row)
          .filter(
            (k) =>
              ![
                "marketId",
                "createdOffset",
                "createdAtLedger",
                "openInterestYes",
                "openInterestNo",
              ].includes(k),
          )
          .map((k) => meta.findColumnWithPropertyName(k)?.databaseName ?? k);
        await m
          .createQueryBuilder()
          .insert()
          .into(MarketEntity)
          .updateEntity(false)
          .values({ ...row })
          .orUpdate(overwrite, ["market_id"])
          .execute();
        // The snapshot row is the version history (one per created event; unique on event id).
        await m
          .createQueryBuilder()
          .insert()
          .into(MarketSnapshotEntity)
          .updateEntity(false)
          .values({
            eventId,
            marketId,
            contractId: e.contractId,
            offset: ctx.tx.offset,
            nodeId: e.nodeId,
            effectiveAt: e.createdAt ?? ctx.tx.effectiveAt,
            price: row.currentPrice,
            reserveYes: row.reserveYes,
            reserveNo: row.reserveNo,
            liquidityL: row.liquidityL,
            lpTokenSupply: row.lpTokenSupply,
            totalVolume: row.totalVolume,
            accumulatedFees: row.accumulatedFees,
            prizePool: row.prizePool,
            status: row.status,
            cause,
          })
          .orIgnore()
          .execute();
        await this.ensureCatalogEvent(m, marketId, identity.eventTicker, {
          expiresAtSec: row.expiresAtSec ?? 0,
          collateral,
        });
        const atLedger = e.createdAt ?? ctx.tx.effectiveAt;
        ctx.marketVersions.push({
          marketId,
          atSec: Math.floor(atLedger.getTime() / 1000),
          price: row.currentPrice ?? 0n,
          liquidityL: row.liquidityL ?? 0n,
          // A snapshot entry (node === null) is a state, not a trade: its lifetime volume must
          // not land in one candle. A first version created by CreateMarket has volume 0 anyway.
          volumeDelta: !node
            ? 0n
            : before
              ? (row.totalVolume ?? 0n) - asDecimal(before.totalVolume)
              : (row.totalVolume ?? 0n),
          trades: node && cause && CANDLE_TRADE_CHOICES.has(cause) ? 1 : 0,
          openInterest: 0n,
          offset: ctx.tx.offset,
          nodeId: e.nodeId,
        });
        ctx.createdMarketIds.add(marketId);
        ctx.marketCauses.set(marketId, cause);
        return;
      }
      case "Truthoracle:Position": {
        const res = await m
          .createQueryBuilder()
          .insert()
          .into(PositionEntity)
          .updateEntity(false)
          .values({
            contractId: e.contractId,
            holder: asText(p.holder),
            admin: asText(p.admin),
            marketId: asInt(p.marketId),
            yesShares: asDecimal(p.yesShares),
            noShares: asDecimal(p.noShares),
            costBasis: asDecimal(p.costBasis),
            auditObservers: asTextList(p.auditObservers),
            ...common,
          })
          .orIgnore()
          .returning("contract_id")
          .execute();
        if ((res.raw as unknown[]).length > 0)
          await bumpOpenInterest(
            m,
            asInt(p.marketId),
            asDecimal(p.yesShares),
            asDecimal(p.noShares),
          );
        return;
      }
      case "Truthoracle:LiquidityPosition":
        await m
          .createQueryBuilder()
          .insert()
          .into(LiquidityPositionEntity)
          .updateEntity(false)
          .values({
            contractId: e.contractId,
            provider: asText(p.provider),
            admin: asText(p.admin),
            marketId: asInt(p.marketId),
            lpTokens: asDecimal(p.lpTokens),
            deposited: asDecimal(p.deposited),
            auditObservers: asTextList(p.auditObservers),
            ...common,
          })
          .orIgnore()
          .execute();
        return;
      case "Truthoracle:UserWallet": {
        const instrument = instrumentOf(p.instrument, `UserWallet ${e.contractId}`);
        ctx.instrumentsSeen.set(instrumentKey(instrument), instrument);
        await m
          .createQueryBuilder()
          .insert()
          .into(LedgerWalletEntity)
          .updateEntity(false)
          .values({
            contractId: e.contractId,
            owner: asText(p.owner),
            admin: asText(p.admin),
            instrumentAdmin: instrument.admin,
            instrumentId: instrument.id,
            balance: asDecimal(p.balance),
            deposited: asDecimal(p.deposited),
            withdrawn: asDecimal(p.withdrawn),
            creditRefs: asTextList(p.creditRefs),
            auditObservers: asTextList(p.auditObservers),
            ...common,
          })
          .orIgnore()
          .execute();
        return;
      }
      case "Truthoracle:PendingPayout": {
        const instrument = instrumentOf(p.instrument, `PendingPayout ${e.contractId}`);
        const res = await m
          .createQueryBuilder()
          .insert()
          .into(LedgerPayoutEntity)
          .updateEntity(false)
          .values({
            contractId: e.contractId,
            admin: asText(p.admin),
            userParty: asText(p.user),
            marketId: asInt(p.marketId),
            instrumentAdmin: instrument.admin,
            instrumentId: instrument.id,
            amount: asDecimal(p.amount),
            reason: asText(p.reason),
            auditObservers: asTextList(p.auditObservers),
            createdAtSec: asInt(p.createdAt),
            active: true,
            createdOffset: ctx.tx.offset,
            createdEventId: eventId,
            createdAtLedger: e.createdAt ?? ctx.tx.effectiveAt,
            settledKind: null,
            settledOffset: null,
            settledAtLedger: null,
            txHash: null,
            refunded: null,
            settleWalletCid: null,
          })
          .orIgnore()
          .returning("contract_id")
          .execute();
        if ((res.raw as unknown[]).length > 0) ctx.createdPayouts.push(e.contractId);
        return;
      }
      case "Truthoracle:OutcomeAttestation":
        await m
          .createQueryBuilder()
          .insert()
          .into(AttestationEntity)
          .updateEntity(false)
          .values({
            contractId: e.contractId,
            attester: asText(p.attester),
            admin: asText(p.admin),
            marketId: asInt(p.marketId),
            sourceUri: asText(p.sourceUri),
            fetchedAtSec: asInt(p.fetchedAt),
            outcome: outcomeOf(p.outcome) ?? "VoidOutcome",
            payloadHash: asText(p.payloadHash),
            sourceSignature: asOptionalText(p.sourceSignature),
            responseExcerpt: asOptionalText(p.responseExcerpt),
            active: true,
            createdOffset: ctx.tx.offset,
            createdAtLedger: e.createdAt ?? ctx.tx.effectiveAt,
            archivedOffset: null,
          })
          .orIgnore()
          .execute();
        return;
      case "Truthoracle:ModelForecast":
        await m
          .createQueryBuilder()
          .insert()
          .into(ModelForecastEntity)
          .updateEntity(false)
          .values({
            contractId: e.contractId,
            author: asText(p.author),
            admin: asText(p.admin),
            marketId: asInt(p.marketId),
            modelId: asText(p.modelId),
            probabilityYes: asDecimal(p.probabilityYes),
            committedAtSec: asInt(p.committedAt),
            marketPriceAtCommit: asDecimal(p.marketPriceAtCommit),
            active: true,
            createdOffset: ctx.tx.offset,
            createdAtLedger: e.createdAt ?? ctx.tx.effectiveAt,
            archivedOffset: null,
          })
          .orIgnore()
          .execute();
        return;
      case "Marketplace:PredictionModel":
        await m
          .createQueryBuilder()
          .insert()
          .into(PredictionModelEntity)
          .updateEntity(false)
          .values({
            contractId: e.contractId,
            author: asText(p.author),
            admin: asText(p.admin),
            modelId: asText(p.modelId),
            name: asText(p.name),
            description: asText(p.description),
            payoutParty: asText(p.payoutParty),
            active: true,
            createdOffset: ctx.tx.offset,
            createdAtLedger: e.createdAt ?? ctx.tx.effectiveAt,
            archivedOffset: null,
          })
          .orIgnore()
          .execute();
        return;
      case "Truthoracle:MarketCounter":
        await m
          .createQueryBuilder()
          .update(IndexerStateEntity)
          .set({ marketCounterCid: e.contractId, marketCounterValue: asInt(p.value) })
          .where("key = :key", { key: INDEXER_STATE_KEY })
          .execute();
        return;
      default:
        // Anything else of ours is kept raw only.
        return;
    }
  }

  // ───────────────────────────────────────────── archives ─────────────────────────────────────────────

  private async applyConsumed(ctx: TxContext, e: ExercisedLedgerEvent): Promise<void> {
    const m = ctx.manager;
    const archive = {
      active: false,
      archivedOffset: ctx.tx.offset,
      archivedChoice: e.choice,
      archivedAtLedger: ctx.tx.effectiveAt,
    };
    switch (`${e.module}:${e.entity}`) {
      case "Truthoracle:PredictionMarket": {
        const before = await ctx.payloadOf(e.contractId);
        const marketId = before ? asInt(before.marketId) : null;
        if (marketId !== null) ctx.consumedMarkets.set(e.contractId, marketId);
        return;
      }
      case "Truthoracle:Position": {
        const res = await m
          .createQueryBuilder()
          .update(PositionEntity)
          .set(archive)
          .where("contract_id = :cid AND active = true", { cid: e.contractId })
          .execute();
        if ((res.affected ?? 0) > 0) {
          const before = await ctx.payloadOf(e.contractId);
          if (before)
            await bumpOpenInterest(
              m,
              asInt(before.marketId),
              -asDecimal(before.yesShares),
              -asDecimal(before.noShares),
            );
        }
        return;
      }
      case "Truthoracle:LiquidityPosition":
        await m
          .createQueryBuilder()
          .update(LiquidityPositionEntity)
          .set(archive)
          .where("contract_id = :cid AND active = true", { cid: e.contractId })
          .execute();
        return;
      case "Truthoracle:UserWallet":
        await m
          .createQueryBuilder()
          .update(LedgerWalletEntity)
          .set(archive)
          .where("contract_id = :cid AND active = true", { cid: e.contractId })
          .execute();
        return;
      case "Truthoracle:PendingPayout": {
        const a = e.choiceArgument;
        const settledKind =
          e.choice === "MarkPaid"
            ? "mark_paid"
            : e.choice === "SettleToWallet"
              ? "settle_to_wallet"
              : e.choice === "CancelPayout"
                ? "cancelled"
                : "archived";
        await m
          .createQueryBuilder()
          .update(LedgerPayoutEntity)
          .set({
            active: false,
            settledKind,
            settledOffset: ctx.tx.offset,
            settledAtLedger: ctx.tx.effectiveAt,
            txHash: e.choice === "MarkPaid" ? asOptionalText(a.txHash) : null,
            refunded: e.choice === "CancelPayout" ? cidOf(a.refundWalletCid) !== null : null,
            settleWalletCid: e.choice === "SettleToWallet" ? cidOf(a.walletCid) : null,
          })
          .where("contract_id = :cid AND active = true", { cid: e.contractId })
          .execute();
        ctx.settledPayouts.push(e.contractId);
        return;
      }
      case "Truthoracle:OutcomeAttestation":
        await m
          .createQueryBuilder()
          .update(AttestationEntity)
          .set({ active: false, archivedOffset: ctx.tx.offset })
          .where("contract_id = :cid", { cid: e.contractId })
          .execute();
        return;
      case "Truthoracle:ModelForecast":
        await m
          .createQueryBuilder()
          .update(ModelForecastEntity)
          .set({ active: false, archivedOffset: ctx.tx.offset })
          .where("contract_id = :cid", { cid: e.contractId })
          .execute();
        return;
      case "Marketplace:PredictionModel":
        await m
          .createQueryBuilder()
          .update(PredictionModelEntity)
          .set({ active: false, archivedOffset: ctx.tx.offset })
          .where("contract_id = :cid", { cid: e.contractId })
          .execute();
        return;
      default:
        return;
    }
  }

  // ───────────────────────────────────────────── derived activity ─────────────────────────────────────────────

  private async deriveFromExercise(
    ctx: TxContext,
    node: EventNode,
    summary: ApplySummary,
  ): Promise<void> {
    const e = node.event as ExercisedLedgerEvent;
    const key = `${e.module}:${e.entity}`;
    if (key === "Truthoracle:UserWallet") {
      await this.deriveWalletEntry(ctx, node, e, summary);
      return;
    }
    if (key === "Truthoracle:PredictionMarket") {
      await this.deriveMarketEvent(ctx, node, e, summary);
      return;
    }
    if (key === "Truthoracle:MarketCounter" && e.choice === "CreateMarket") {
      await this.deriveMarketCreated(ctx, node, e, summary);
      return;
    }
    // PendingPayout settlements were recorded by applyConsumed; announce them here (once per exercise).
    if (key === "Truthoracle:PendingPayout" && e.consuming) {
      summary.payouts.push({ contractId: e.contractId, change: "settled" });
    }
  }

  private async deriveWalletEntry(
    ctx: TxContext,
    node: EventNode,
    e: ExercisedLedgerEvent,
    summary: ApplySummary,
  ): Promise<void> {
    const kinds: Record<string, WalletEntryKind> = {
      Deposit: "deposit",
      Grant: "grant",
      Credit: "credit",
      Debit: "debit",
      Withdraw: "withdraw",
    };
    const kind = kinds[e.choice];
    if (!kind) return;
    const a = e.choiceArgument;
    const before = await ctx.payloadOf(e.contractId);
    const successor = createdUnder(node, "Truthoracle", "UserWallet")[0] ?? null;
    const owner =
      asText(before?.owner) || asText(successor?.createArgument.owner) || e.actingParties[0] || "";
    // The wallet's instrument: from the consumed version, else the successor (every version copies it).
    const instrument = instrumentOf(
      before?.instrument ?? successor?.createArgument.instrument,
      `UserWallet ${e.contractId} (${e.choice})`,
    );
    const root = node.root.event;
    const rootExercise = root.kind === "exercised" && root !== e ? root : null;
    const rootMarketId = rootExercise ? await ctx.marketIdOfRoot(rootExercise) : null;
    const eventId = eventIdOf(ctx.tx.updateId, e.nodeId);
    const res = await ctx.manager
      .createQueryBuilder()
      .insert()
      .into(WalletEntryEntity)
      .updateEntity(false)
      .values({
        eventId,
        owner,
        walletCid: e.contractId,
        newWalletCid: successor?.contractId ?? null,
        instrumentAdmin: instrument.admin,
        instrumentId: instrument.id,
        kind,
        amount: asDecimal(a.amount),
        // Grant { amount, ref, reason }: the ref lands in `tx_ref` like a deposit's, the reason names the rule.
        reason:
          kind === "withdraw" ? "withdraw" : kind === "deposit" ? null : asOptionalText(a.reason),
        txRef:
          kind === "deposit"
            ? asOptionalText(a.txRef)
            : kind === "grant"
              ? asOptionalText(a.ref)
              : null,
        balanceAfter: successor ? asDecimal(successor.createArgument.balance) : null,
        marketId: rootMarketId,
        rootChoice: rootExercise ? rootExercise.choice : null,
        rootTemplate: rootExercise ? `${rootExercise.module}:${rootExercise.entity}` : null,
        offset: ctx.tx.offset,
        nodeId: e.nodeId,
        updateId: ctx.tx.updateId,
        effectiveAt: ctx.tx.effectiveAt,
        recordTime: ctx.tx.recordTime,
      })
      .orIgnore()
      .returning("id")
      .execute();
    if ((res.raw as unknown[]).length > 0) summary.walletEntries.push({ owner, kind, eventId });
    if (kind === "withdraw") {
      for (const cid of createdUnder(node, "Truthoracle", "PendingPayout").map((c) => c.contractId))
        summary.payouts.push({ contractId: cid, change: "created" });
    }
  }

  private async deriveMarketCreated(
    ctx: TxContext,
    node: EventNode,
    e: ExercisedLedgerEvent,
    summary: ApplySummary,
  ): Promise<void> {
    const market = createdUnder(node, "Truthoracle", "PredictionMarket")[0];
    if (!market) return;
    const p = market.createArgument;
    const a = e.choiceArgument;
    await this.insertMarketEvent(ctx, summary, {
      eventId: eventIdOf(ctx.tx.updateId, e.nodeId),
      marketId: asInt(p.marketId),
      kind: "market_created",
      actor: asText(p.admin) || e.actingParties[0] || "",
      priceAfter: asDecimal(p.currentPrice),
      amount: asOptionalDecimal(a.initialValue),
      lpTokens: asDecimal(p.lpTokenSupply),
      details: {
        initialProbability: formatAmount(asDecimal(a.initialProbability)),
        initialValue: formatAmount(asDecimal(a.initialValue)),
        liquidityL: formatAmount(asDecimal(p.liquidityL)),
        reserveYes: formatAmount(asDecimal(p.reserveYes)),
        reserveNo: formatAmount(asDecimal(p.reserveNo)),
        marketContractId: market.contractId,
      },
      node: e,
    });
  }

  private async deriveMarketEvent(
    ctx: TxContext,
    node: EventNode,
    e: ExercisedLedgerEvent,
    summary: ApplySummary,
  ): Promise<void> {
    const kind = MARKET_CHOICE_KINDS[e.choice];
    if (!kind) return;
    const a = e.choiceArgument;
    const before = await ctx.payloadOf(e.contractId);
    const after = createdUnder(node, "Truthoracle", "PredictionMarket")[0]?.createArgument ?? null;
    const marketId = asInt(before?.marketId ?? after?.marketId ?? 0);
    if (!marketId) return;

    const priceBefore = before ? asDecimal(before.currentPrice) : null;
    const priceAfter = after ? asDecimal(after.currentPrice) : null;
    const feePot = (p: Record<string, unknown> | null): bigint =>
      p ? asDecimal(p.accumulatedFees) + asDecimal(p.prizePool) : 0n;
    const fee = before && after ? feePot(after) - feePot(before) : null;
    const volumeDelta =
      before && after ? asDecimal(after.totalVolume) - asDecimal(before.totalVolume) : null;
    const debit = exercisedUnder(node, "Truthoracle", "UserWallet", "Debit")[0] ?? null;
    const credit = exercisedUnder(node, "Truthoracle", "UserWallet", "Credit")[0] ?? null;
    const debitAmount = debit ? asDecimal(debit.choiceArgument.amount) : null;
    const creditAmount = credit ? asDecimal(credit.choiceArgument.amount) : null;
    const actorArg = asText(
      a.buyer ??
        a.seller ??
        a.swapper ??
        a.user ??
        a.provider ??
        a.proposer ??
        a.challenger ??
        a.finalizer ??
        a.holder ??
        a.author,
    );
    const actor = actorArg || e.actingParties[0] || asText(before?.admin) || "";

    const row: MarketEventInput = {
      eventId: eventIdOf(ctx.tx.updateId, e.nodeId),
      marketId,
      kind,
      actor,
      priceBefore,
      priceAfter,
      fee,
      details: { choice: e.choice, args: jsonSafe(stripCids(a)) },
      node: e,
    };

    switch (kind) {
      case "buy": {
        const side = sideOf(a.side);
        const delta = await positionDelta(ctx, node, cidOf(a.existingPosition), actor);
        row.side = side;
        row.amount = asDecimal(a.amount);
        row.net = fee !== null ? asDecimal(a.amount) - fee : null;
        row.shares = delta ? (side === "No" ? delta.no : delta.yes) : null;
        row.details.minSharesOut = formatAmount(asDecimal(a.minSharesOut));
        break;
      }
      case "sell": {
        const side = sideOf(a.side);
        row.side = side;
        row.shares = asDecimal(a.sharesIn);
        row.amount = volumeDelta;
        row.net = creditAmount;
        row.details.minProceeds = formatAmount(asDecimal(a.minProceeds));
        break;
      }
      case "swap": {
        const side = sideOf(a.fromSide);
        const delta = await positionDelta(ctx, node, cidOf(a.positionCid), actor);
        row.side = side;
        row.shares = asDecimal(a.sharesIn);
        row.sharesOut = delta ? (side === "Yes" ? delta.no : delta.yes) : null;
        row.amount = volumeDelta;
        row.fee = null;
        row.details.feeShares = formatAmount(
          (asDecimal(a.sharesIn) * BigInt(asInt(before?.feeBps))) / 10_000n,
        );
        break;
      }
      case "split":
      case "merge":
        row.amount = asDecimal(a.amount);
        row.shares = asDecimal(a.amount);
        row.net = kind === "split" ? debitAmount : creditAmount;
        break;
      case "provide_liquidity":
        row.amount = asDecimal(a.valueIncrease);
        row.net = debitAmount;
        row.lpTokens =
          before && after ? asDecimal(after.lpTokenSupply) - asDecimal(before.lpTokenSupply) : null;
        row.details.maxCost = formatAmount(asDecimal(a.maxCost));
        break;
      case "withdraw_liquidity": {
        row.lpTokens = asDecimal(a.lpTokensToBurn);
        row.net = creditAmount;
        row.amount = creditAmount;
        const delta = await positionDelta(ctx, node, cidOf(a.existingPosition), actor);
        if (delta) {
          row.shares = delta.yes;
          row.sharesOut = delta.no;
        }
        break;
      }
      case "propose":
      case "challenge":
        row.outcome = outcomeOf(a.proposedOutcome ?? a.challengerOutcome);
        row.amount = debitAmount;
        break;
      case "resolve_t0":
      case "resolve":
      case "finalize":
      case "void": {
        row.outcome = after ? outcomeOf(after.outcome) : outcomeOf(a.resolvedOutcome);
        row.details.attestationCids = asList(a.attestationCids)
          .map((c) => cidOf(c))
          .filter(Boolean);
        row.details.sourceUri = asOptionalText(a.sourceUri);
        row.details.bondPayouts = createdUnder(node, "Truthoracle", "PendingPayout").map((c) => ({
          contractId: c.contractId,
          user: asText(c.createArgument.user),
          amount: formatAmount(asDecimal(c.createArgument.amount)),
          reason: asText(c.createArgument.reason),
        }));
        break;
      }
      case "redeem": {
        const pos = await ctx.payloadOf(cidOf(a.positionCid));
        row.amount = creditAmount;
        row.net = creditAmount;
        row.shares = pos ? maxBig(asDecimal(pos.yesShares), asDecimal(pos.noShares)) : null;
        row.outcome = before ? outcomeOf(before.outcome) : null;
        row.details.yesShares = pos ? formatAmount(asDecimal(pos.yesShares)) : null;
        row.details.noShares = pos ? formatAmount(asDecimal(pos.noShares)) : null;
        row.details.costBasis = pos ? formatAmount(asDecimal(pos.costBasis)) : null;
        row.details.reason = credit ? asOptionalText(credit.choiceArgument.reason) : null;
        break;
      }
      case "commit_forecast": {
        const forecast = createdUnder(node, "Truthoracle", "ModelForecast")[0] ?? null;
        row.details.modelId = asText(a.modelId);
        row.details.probabilityYes = formatAmount(asDecimal(a.probabilityYes));
        row.details.marketPriceAtCommit = forecast
          ? formatAmount(asDecimal(forecast.createArgument.marketPriceAtCommit))
          : null;
        row.details.forecastContractId = forecast?.contractId ?? null;
        break;
      }
      case "score_and_distribute": {
        row.amount =
          before && after ? asDecimal(before.prizePool) - asDecimal(after.prizePool) : null;
        row.details.payouts = createdUnder(node, "Truthoracle", "PendingPayout").map((c) => ({
          contractId: c.contractId,
          user: asText(c.createArgument.user),
          amount: formatAmount(asDecimal(c.createArgument.amount)),
        }));
        break;
      }
      case "archive":
      default:
        break;
    }

    await this.insertMarketEvent(ctx, summary, row);
    for (const cid of createdUnder(node, "Truthoracle", "PendingPayout").map((c) => c.contractId))
      summary.payouts.push({ contractId: cid, change: "created" });
  }

  private async insertMarketEvent(
    ctx: TxContext,
    summary: ApplySummary,
    input: MarketEventInput,
  ): Promise<void> {
    const res = await ctx.manager
      .createQueryBuilder()
      .insert()
      .into(MarketEventEntity)
      .updateEntity(false)
      .values({
        eventId: input.eventId,
        marketId: input.marketId,
        kind: input.kind,
        actor: input.actor,
        side: input.side ?? null,
        amount: input.amount ?? null,
        net: input.net ?? null,
        shares: input.shares ?? null,
        sharesOut: input.sharesOut ?? null,
        fee: input.fee ?? null,
        priceBefore: input.priceBefore ?? null,
        priceAfter: input.priceAfter ?? null,
        lpTokens: input.lpTokens ?? null,
        outcome: input.outcome ?? null,
        details: jsonSafe(input.details),
        offset: ctx.tx.offset,
        nodeId: input.node.nodeId,
        updateId: ctx.tx.updateId,
        commandId: ctx.tx.commandId,
        effectiveAt: ctx.tx.effectiveAt,
        recordTime: ctx.tx.recordTime,
      })
      .orIgnore()
      .returning("id")
      .execute();
    if ((res.raw as unknown[]).length === 0) return;
    summary.marketEvents.push({
      kind: input.kind,
      marketId: input.marketId,
      actor: input.actor,
      eventId: input.eventId,
    });
    if (TRADE_KINDS.includes(input.kind)) {
      await ctx.manager
        .createQueryBuilder()
        .update(MarketEntity)
        .set({ tradeCount: () => "trade_count + 1", lastTradeAt: ctx.tx.effectiveAt })
        .where("market_id = :marketId", { marketId: input.marketId })
        .execute();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Per-transaction context and tree helpers
// ---------------------------------------------------------------------------------------------

interface MarketEventInput {
  eventId: string;
  marketId: number;
  kind: MarketEventKind;
  actor: string;
  side?: TradeSide | null;
  amount?: bigint | null;
  net?: bigint | null;
  shares?: bigint | null;
  sharesOut?: bigint | null;
  fee?: bigint | null;
  priceBefore?: bigint | null;
  priceAfter?: bigint | null;
  lpTokens?: bigint | null;
  outcome?: MarketOutcome | null;
  details: Record<string, unknown>;
  node: ExercisedLedgerEvent;
}

class TxContext {
  /** Payloads of contracts created earlier in this transaction (a batch may consume them again). */
  readonly created = new Map<string, Record<string, unknown>>();
  readonly consumedMarkets = new Map<string, number>();
  readonly createdMarketIds = new Set<number>();
  readonly marketCauses = new Map<number, string | null>();
  readonly createdPayouts: string[] = [];
  readonly settledPayouts: string[] = [];
  /** Market versions created in this transaction, folded into the candles once every Position is applied. */
  readonly marketVersions: CandleContribution[] = [];
  /** Collateral / wallet instruments this transaction named, by key. */
  readonly instrumentsSeen = new Map<string, InstrumentId>();
  private readonly payloadCache = new Map<string, Record<string, unknown> | null>();

  constructor(
    readonly manager: EntityManager,
    readonly tx: LedgerTransaction,
  ) {}

  /** The create argument of a contract: from this transaction, else from the raw event table (every create the index ever saw). */
  async payloadOf(contractId: string | null): Promise<Record<string, unknown> | null> {
    if (!contractId) return null;
    const own = this.created.get(contractId);
    if (own) return own;
    if (this.payloadCache.has(contractId)) return this.payloadCache.get(contractId) ?? null;
    const row = await this.manager
      .getRepository(LedgerEventEntity)
      .findOne({ where: { contractId, kind: "created" }, order: { id: "DESC" } });
    const payload = row ? row.payload : null;
    this.payloadCache.set(contractId, payload);
    return payload;
  }

  /** The market a root exercise acted on (PredictionMarket choices; SettleToWallet / CancelPayout via the payout's marketId). */
  async marketIdOfRoot(root: ExercisedLedgerEvent): Promise<number | null> {
    if (root.module !== "Truthoracle") return null;
    if (root.entity === "PredictionMarket" || root.entity === "PendingPayout") {
      const p = await this.payloadOf(root.contractId);
      const id = p ? asInt(p.marketId) : 0;
      return id > 0 ? id : null;
    }
    return null;
  }
}

function createdUnder(node: EventNode, module: string, entity: string): CreatedLedgerEvent[] {
  return descendantsOf(node)
    .map((n) => n.event)
    .filter(
      (e): e is CreatedLedgerEvent =>
        e.kind === "created" && e.module === module && e.entity === entity,
    );
}

function exercisedUnder(
  node: EventNode,
  module: string,
  entity: string,
  choice?: string,
): ExercisedLedgerEvent[] {
  return descendantsOf(node)
    .map((n) => n.event)
    .filter(
      (e): e is ExercisedLedgerEvent =>
        e.kind === "exercised" &&
        e.module === module &&
        e.entity === entity &&
        (choice === undefined || e.choice === choice),
    );
}

/** The contract id of the nearest consuming PredictionMarket exercise above a market version — its predecessor. */
function nearestMarketExerciseCid(node: EventNode): string | null {
  let p = node.parent;
  while (p) {
    const ev = p.event;
    if (ev.kind === "exercised") {
      return ev.module === "Truthoracle" && ev.entity === "PredictionMarket" && ev.consuming
        ? ev.contractId
        : null;
    }
    p = p.parent;
  }
  return null;
}

/** `to_markets.open_interest_*` += (yes, no) — the market row may not exist yet (a Position indexed before its market on a resync); then the recompute after the snapshot settles it. */
async function bumpOpenInterest(
  manager: EntityManager,
  marketId: number,
  yes: bigint,
  no: bigint,
): Promise<void> {
  if (yes === 0n && no === 0n) return;
  await manager.query(
    `UPDATE to_markets SET open_interest_yes = open_interest_yes + $1, open_interest_no = open_interest_no + $2 WHERE market_id = $3`,
    [formatAmount(yes), formatAmount(no), String(marketId)],
  );
}

/** The choice of the nearest exercised ancestor (what caused this create), or null for a top-level create. */
function nearestChoice(node: EventNode): string | null {
  let p = node.parent;
  while (p) {
    if (p.event.kind === "exercised") return p.event.choice;
    p = p.parent;
  }
  return null;
}

/** Share delta of the actor's position under a market exercise: the created successor minus the consumed predecessor (if any). */
async function positionDelta(
  ctx: TxContext,
  node: EventNode,
  beforeCid: string | null,
  holder: string,
): Promise<{ yes: bigint; no: bigint; cost: bigint } | null> {
  const after =
    createdUnder(node, "Truthoracle", "Position").find(
      (c) => !holder || asText(c.createArgument.holder) === holder,
    ) ?? null;
  if (!after) return null;
  const before = await ctx.payloadOf(beforeCid);
  const a = after.createArgument;
  return {
    yes: asDecimal(a.yesShares) - (before ? asDecimal(before.yesShares) : 0n),
    no: asDecimal(a.noShares) - (before ? asDecimal(before.noShares) : 0n),
    cost: asDecimal(a.costBasis) - (before ? asDecimal(before.costBasis) : 0n),
  };
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Choice arguments for `details`: contract ids are kept (they are ids), everything else verbatim. */
function stripCids(args: Record<string, unknown>): Record<string, unknown> {
  return args;
}

/** A `to_ledger_holdings` row as the pure derivation wants to see it. */
function holdingOfRow(h: LedgerHoldingEntity): HoldingView {
  return {
    contractId: h.contractId,
    owner: h.owner,
    instrument: { admin: h.instrumentAdmin, id: h.instrumentId },
    amount: h.amount,
    locked: h.locked,
    lockExpiresAt: h.lockExpiresAt,
  };
}

function instructionOfRow(i: LedgerTransferInstructionEntity): TransferInstructionView {
  return {
    contractId: i.contractId,
    sender: i.sender,
    receiver: i.receiver,
    instrument: { admin: i.instrumentAdmin, id: i.instrumentId },
    amount: i.amount,
    requestedAt: null,
    executeBefore: i.executeBefore,
    originalInstructionCid: null,
  };
}

/**
 * The series a placeholder event is filed under: the event ticker's first segment (Kalshi's
 * `SERIES-EVENT` convention, `FED-26MAR` → `FED`), the whole ticker when there is no usable
 * segment. An operator moves the event to the right series with `PATCH /admin/events/:ticker`.
 */
export function placeholderSeriesTickerOf(eventTicker: string): string {
  const head = eventTicker.split("-")[0];
  return head.length >= 2 ? head : eventTicker;
}
