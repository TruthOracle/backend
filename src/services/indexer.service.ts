import { Injectable, Logger } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";

import { Config } from "../config";
import {
  INDEXER_STATE_KEY,
  IndexerStateEntity,
  type IndexerGap,
} from "../entities/indexer-state.entity";
import {
  isPrunedDataError,
  type ActiveContractEntry,
  type LedgerTransaction,
} from "../indexer/events";
import { LedgerProjection, type ApplySummary } from "../indexer/projection";
import { NatsSubjects, type ApiLedgerStatus } from "../types";
import { isoOrNull } from "../util/ledger-values";
import { LedgerStreamService } from "./ledger-stream.service";
import { NatsService } from "./nats.service";
import { SentryService } from "./sentry.service";

/** What one `runOnce` did. */
export interface RunResult {
  /** Transactions applied (replays excluded). */
  applied: number;
  /** Transactions the page carried. */
  seen: number;
  /** The index is at the ledger end the pass started with. */
  caughtUp: boolean;
  bootstrapped: boolean;
  resynced: boolean;
}

/**
 * The ledger indexer (docs/INDEXER.md): keeps the `to_*` ledger tables a faithful projection of
 * the treasury's view of the ledger. `runOnce` = bootstrap when needed, then one page of updates,
 * each transaction applied with its cursor advance in ONE Postgres transaction; the processor
 * loops it under a cross-instance lock. `status()` / `waitForOffset()` back `GET /ledger/*`.
 */
@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);
  readonly projection: LedgerProjection;
  /** Set by the processor while this process holds the lock and streams. */
  running = false;

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly stream: LedgerStreamService,
    private readonly nats: NatsService,
    private readonly sentry: SentryService,
  ) {
    this.projection = new LedgerProjection({
      packageName: config.truthoraclePackageName,
      splicePackageName: config.splicePackageName,
      treasury: config.treasuryPartyId,
      trackTransfers: config.indexerTrackTransfers,
    });
  }

  isEnabled(): boolean {
    return this.config.indexerEnabled && this.stream.isConfigured();
  }

  // ───────────────────────────────────────────── state ─────────────────────────────────────────────

  /** The cursor row, created on first use (`INSERT … ON CONFLICT DO NOTHING`, so racing replicas share one). */
  async state(manager: EntityManager = this.dataSource.manager): Promise<IndexerStateEntity> {
    const repo = manager.getRepository(IndexerStateEntity);
    const existing = await repo.findOneBy({ key: INDEXER_STATE_KEY });
    if (existing) return existing;
    await manager.query(
      `INSERT INTO to_indexer_state ("key") VALUES ($1) ON CONFLICT ("key") DO NOTHING`,
      [INDEXER_STATE_KEY],
    );
    return repo.findOneByOrFail({ key: INDEXER_STATE_KEY });
  }

  async status(): Promise<ApiLedgerStatus> {
    const s = await this.state();
    const lag = s.ledgerEnd !== null ? Math.max(0, s.ledgerEnd - s.offset) : null;
    return {
      enabled: this.isEnabled(),
      running: this.running,
      bootstrapped: s.bootstrappedAt !== null,
      bootstrappedAt: isoOrNull(s.bootstrappedAt),
      bootstrapOffset: s.bootstrapOffset,
      offset: s.offset,
      ledgerEnd: s.ledgerEnd,
      lag,
      prunedOffset: s.prunedOffset,
      lastUpdateId: s.lastUpdateId,
      lastRecordTime: isoOrNull(s.lastRecordTime),
      lastError: s.lastError,
      lastErrorAt: isoOrNull(s.lastErrorAt),
      gaps: s.gaps ?? [],
      updatedAt: isoOrNull(s.updatedAt),
    };
  }

  /** The last applied offset (what every read endpoint reports in `x-ledger-offset`). */
  async currentOffset(): Promise<number> {
    const row = await this.dataSource.query<{ offset: string }[]>(
      `SELECT "offset" FROM to_indexer_state WHERE "key" = $1`,
      [INDEXER_STATE_KEY],
    );
    return row.length > 0 ? Number(row[0].offset) : 0;
  }

  /** Resolves once the index has applied `offset` (or after `timeoutMs`, whichever first) — the "wait for my transaction" primitive. */
  async waitForOffset(
    offset: number,
    timeoutMs: number,
  ): Promise<{ reached: boolean; offset: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await this.currentOffset();
      if (current >= offset) return { reached: true, offset: current };
      if (Date.now() >= deadline) return { reached: false, offset: current };
      await sleep(Math.min(500, Math.max(50, deadline - Date.now())));
    }
  }

  // ───────────────────────────────────────────── the pass ─────────────────────────────────────────────

  async runOnce(): Promise<RunResult> {
    const result: RunResult = {
      applied: 0,
      seen: 0,
      caughtUp: false,
      bootstrapped: false,
      resynced: false,
    };
    let state = await this.state();
    try {
      if (!state.bootstrappedAt) {
        await this.bootstrap();
        result.bootstrapped = true;
        state = await this.state();
      }
      const end = await this.stream.ledgerEnd();
      if (end <= state.offset) {
        await this.touch({ ledgerEnd: end, lastError: null, lastErrorAt: null });
        result.caughtUp = true;
        return result;
      }
      let page: LedgerTransaction[];
      try {
        page = await this.stream.fetchUpdates({
          beginExclusive: state.offset,
          endInclusive: end,
          limit: this.config.indexerBatch,
        });
      } catch (err) {
        if (!isPrunedDataError(err)) throw err;
        await this.resync(state.offset, "the index fell behind the participant's prune point");
        result.resynced = true;
        return result;
      }
      result.seen = page.length;
      for (const tx of page) {
        if (await this.applyTransaction(tx)) result.applied += 1;
      }
      if (page.length === 0) {
        // Nothing for our party between the cursor and the ledger end: move the cursor to the end.
        await this.advanceTo(end, null);
        result.caughtUp = true;
      }
      await this.touch({ ledgerEnd: end, lastError: null, lastErrorAt: null });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      await this.touch({ lastError: message.slice(0, 2000), lastErrorAt: new Date() }).catch(
        () => undefined,
      );
      throw err;
    }
  }

  /**
   * First run (docs/INDEXER.md §4): on a never-pruned participant the full history is replayed
   * from `INDEXER_START_OFFSET` (default 0 = ledger begin); on a pruned one the index starts from
   * an ACS snapshot at the prune point and streams from there — everything retained is indexed.
   */
  async bootstrap(): Promise<void> {
    const pruned = await this.stream.prunedOffset();
    const start = Math.max(pruned, this.config.indexerStartOffset);
    if (start === 0) {
      await this.touch({
        bootstrappedAt: new Date(),
        bootstrapOffset: 0,
        prunedOffset: pruned,
        offset: 0,
      });
      this.logger.log("bootstrap: replaying the full ledger history from offset 0");
      return;
    }
    this.logger.log(
      `bootstrap: ACS snapshot at offset ${start} (pruned up to ${pruned}), then streaming`,
    );
    const entries = await this.stream.fetchActiveContracts(start);
    await this.applySnapshot(entries, start, "bootstrap");
    await this.touch({
      bootstrappedAt: new Date(),
      bootstrapOffset: start,
      prunedOffset: pruned,
      offset: start,
    });
  }

  /**
   * The cursor is below the prune point: the updates in between are gone for good. Re-snapshot
   * the ACS at the new prune point, reconcile activeness, record the gap and continue from there.
   */
  async resync(fromOffset: number, reason: string): Promise<void> {
    const pruned = await this.stream.prunedOffset();
    const at = Math.max(pruned, fromOffset + 1);
    this.logger.warn(`resync: ${reason}; snapshot at ${at} (cursor was ${fromOffset})`);
    const entries = await this.stream.fetchActiveContracts(at);
    const gap: IndexerGap = { fromOffset, toOffset: at, reason, at: new Date().toISOString() };
    await this.dataSource.transaction(async (manager) => {
      const { inserted, archived } = await this.projection.applyActiveContracts(
        manager,
        entries,
        at,
        "resync",
      );
      const state = await this.state(manager);
      await manager
        .getRepository(IndexerStateEntity)
        .update(
          { key: INDEXER_STATE_KEY },
          {
            offset: at,
            prunedOffset: pruned,
            gaps: [...(state.gaps ?? []), gap],
            lastError: null,
            lastErrorAt: null,
          },
        );
      this.logger.warn(`resync: ${inserted} contract(s) added, ${archived} marked archived`);
    });
    this.sentry.captureMessage("ledger indexer resynced from an ACS snapshot", "warning", {
      fromOffset: String(fromOffset),
      toOffset: String(at),
    });
    await this.nats.publishSafe(NatsSubjects.indexerGap, gap, { msgId: `gap:${fromOffset}:${at}` });
  }

  /** Operator action (`POST /admin/ledger/resync`): re-snapshot the ACS at the ledger end and reconcile activeness. */
  async resyncNow(reason: string): Promise<ApiLedgerStatus> {
    const state = await this.state();
    const end = await this.stream.ledgerEnd();
    const entries = await this.stream.fetchActiveContracts(end);
    await this.dataSource.transaction(async (manager) => {
      await this.projection.applyActiveContracts(manager, entries, end, "resync");
      const fresh = await this.state(manager);
      const gap: IndexerGap = {
        fromOffset: state.offset,
        toOffset: end,
        reason: `operator resync: ${reason}`,
        at: new Date().toISOString(),
      };
      await manager
        .getRepository(IndexerStateEntity)
        .update(
          { key: INDEXER_STATE_KEY },
          {
            offset: end,
            ledgerEnd: end,
            gaps: state.offset < end ? [...(fresh.gaps ?? []), gap] : (fresh.gaps ?? []),
            bootstrappedAt: fresh.bootstrappedAt ?? new Date(),
            bootstrapOffset: fresh.bootstrapOffset ?? end,
          },
        );
    });
    return this.status();
  }

  private async applySnapshot(
    entries: ActiveContractEntry[],
    at: number,
    mode: "bootstrap" | "resync",
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.state(manager);
      const { inserted } = await this.projection.applyActiveContracts(manager, entries, at, mode);
      this.logger.log(`${mode}: ${inserted} active contract(s) loaded from the snapshot at ${at}`);
    });
  }

  /**
   * One transaction, atomically with the cursor: rows + `offset = tx.offset` commit together, and
   * the cursor only ever moves forward (`WHERE offset < tx.offset`). Returns false for a replay.
   */
  async applyTransaction(tx: LedgerTransaction): Promise<boolean> {
    const outcome = await this.dataSource.transaction(async (manager) => {
      await this.state(manager);
      const res = await this.projection.applyTransaction(manager, tx);
      await manager
        .createQueryBuilder()
        .update(IndexerStateEntity)
        .set({
          offset: tx.offset,
          lastUpdateId: tx.updateId,
          lastRecordTime: tx.recordTime ?? tx.effectiveAt,
        })
        .where(`"key" = :key AND "offset" < :offset`, { key: INDEXER_STATE_KEY, offset: tx.offset })
        .execute();
      return res;
    });
    if (outcome.applied) await this.announce(outcome.summary);
    return outcome.applied;
  }

  private async advanceTo(offset: number, updateId: string | null): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(IndexerStateEntity)
      .set(updateId ? { offset, lastUpdateId: updateId } : { offset })
      .where(`"key" = :key AND "offset" < :offset`, { key: INDEXER_STATE_KEY, offset })
      .execute();
  }

  private async touch(patch: Partial<IndexerStateEntity>): Promise<void> {
    await this.state();
    await this.dataSource
      .getRepository(IndexerStateEntity)
      .update({ key: INDEXER_STATE_KEY }, patch);
  }

  /** Best-effort fan-out after commit (a bus outage never fails the index). Ids and parties only. */
  private async announce(s: ApplySummary): Promise<void> {
    if (s.events > 0 || s.transfers.length > 0) {
      await this.nats.publishSafe(
        NatsSubjects.ledgerTx,
        { updateId: s.updateId, offset: s.offset, events: s.events },
        { msgId: `tx:${s.updateId}` },
      );
    }
    for (const m of s.marketsUpdated) {
      await this.nats.publishSafe(
        NatsSubjects.marketUpdated,
        { marketId: m.marketId, offset: s.offset, cause: m.cause },
        { msgId: `market:${m.marketId}:${s.offset}` },
      );
    }
    for (const e of s.marketEvents) {
      await this.nats.publishSafe(
        NatsSubjects.marketEvent(e.kind),
        { marketId: e.marketId, eventId: e.eventId, actor: e.actor, offset: s.offset },
        { msgId: `me:${e.eventId}` },
      );
    }
    for (const w of s.walletEntries) {
      await this.nats.publishSafe(
        NatsSubjects.walletEntry,
        { owner: w.owner, kind: w.kind, eventId: w.eventId, offset: s.offset },
        { msgId: `we:${w.eventId}` },
      );
    }
    for (const p of s.payouts) {
      await this.nats.publishSafe(
        NatsSubjects.ledgerPayoutChanged,
        { contractId: p.contractId, change: p.change, offset: s.offset },
        { msgId: `lp:${p.contractId}:${p.change}` },
      );
    }
    for (const t of s.transfers) {
      await this.nats.publishSafe(
        NatsSubjects.transferSeen,
        {
          updateId: s.updateId,
          direction: t.direction,
          counterparty: t.counterparty,
          offset: s.offset,
        },
        { msgId: `tr:${t.eventId}` },
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
