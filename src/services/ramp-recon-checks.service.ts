import { Injectable, type OnModuleInit } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";

import { Config } from "../config";
import type { RampMethod, RampOrderStatus } from "../types";
import { type BusinessCalendar, minskDate } from "../util/by-calendar";
import { formatAmount, parseAmount } from "../util/money";
import { mintCreditCommandId, mintCreditTxRef } from "./deposit.service";
import { freshnessOf } from "./indexer.service";
import { LedgerClientService } from "./ledger-client.service";
import { LedgerStreamService } from "./ledger-stream.service";
import { ALL_SCOPES, clientLiabilities, reserveFigures } from "./ramp-controls.logic";
import { bankAdjusted, RampGatesService } from "./ramp-gates.service";
import { RampJournalService } from "./ramp-journal.service";
import { creditBackOf } from "./ramp-order-store.service";
import { evalTreasury, type LateCreditBack, stuckReason } from "./ramp-recon-checks.logic";
import { type ReconCheckOutcome, RampReconciliationService } from "./ramp-reconciliation.service";
import { rampCommandId } from "./ramp-token-sync.service";
import { TokenAppSyncService } from "./token-app-sync.service";

const STUCK_SCAN_LIMIT = 500;
const DAY_MS = 24 * 3_600_000;
/** stuckReason's slowest refunds (ERIP 12 days, card 1 day); the spec pins these cut-offs to it. */
const ERIP_REFUND_STUCK_MS = 12 * DAY_MS;
const CARD_REFUND_STUCK_MS = DAY_MS;

/**
 * Per-status cut-offs for the stuck-order scan (C45): an order newer than its status' cut-off
 * cannot be stuck by `stuckReason`, so the scan filters on them in SQL before its LIMIT. Each is
 * a superset of the logic (never drops a stuck order); `stuckReason` stays the exact filter.
 */
export function stuckCutoffs(
  now: Date,
  ctx: {
    calendar: BusinessCalendar;
    confirmMin: number;
    stuckAfterMin: number;
    bankSettleDays: number;
  },
): {
  awaitingExpiresBefore: Date;
  queuedBefore: Date;
  sentBefore: Date;
  eripRefundBefore: Date;
  cardRefundBefore: Date;
  confirmBefore: Date;
  otherBefore: Date;
} {
  const today = minskDate(now);
  // More than n business days in (changed, today] ⇔ changed before Minsk 00:00 of the (n+1)-th
  // business day counted back from today inclusive — exact, so a weekend cannot fill the scan
  // with orders still inside their window.
  const businessDaysBack = (n: number): Date =>
    ctx.calendar.startOfDayUtc(
      ctx.calendar.subtractBusinessDays(today, n + (ctx.calendar.isBusinessDay(today) ? 0 : 1)),
    );
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  return {
    // expiry + grace < now ⇒ expiry < now (any grace ≥ 0).
    awaitingExpiresBefore: now,
    queuedBefore: businessDaysBack(1),
    sentBefore: ctx.bankSettleDays >= 1 ? businessDaysBack(ctx.bankSettleDays) : now,
    eripRefundBefore: ago(ERIP_REFUND_STUCK_MS),
    cardRefundBefore: ago(CARD_REFUND_STUCK_MS),
    confirmBefore: ago(ctx.confirmMin * 60_000),
    otherBefore: ago(ctx.stuckAfterMin * 60_000),
  };
}

/**
 * The money and operations checks of SPEC §6.2 owned by S4: journal_balanced,
 * issuance_matches_liability, reserve_covers_liabilities, treasury_covers_in_app (both sides at
 * one index offset, #9 b), provider_clearing_aging (FIFO), operator_money_unswept, events_dead,
 * no_stuck_orders (per-status thresholds, M8). The token checks live in RampTokenChecks.
 */
@Injectable()
export class RampReconChecks implements OnModuleInit {
  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly reconciliation: RampReconciliationService,
    private readonly journal: RampJournalService,
    private readonly gates: RampGatesService,
    private readonly sync: TokenAppSyncService,
    private readonly stream: LedgerStreamService,
    private readonly ledger: LedgerClientService,
  ) {}

  onModuleInit(): void {
    const r = this.reconciliation;
    r.registerCheck({
      name: "journal_balanced",
      haltScopes: [...ALL_SCOPES],
      run: () => this.journalBalanced(),
    });
    r.registerCheck({
      name: "issuance_matches_liability",
      haltScopes: ["mints", "payouts"],
      run: () => this.issuanceMatchesLiability(),
    });
    r.registerCheck({
      name: "reserve_covers_liabilities",
      haltScopes: ["mints"],
      run: () => this.reserveCovers(),
    });
    r.registerCheck({
      name: "treasury_covers_in_app",
      haltScopes: [...ALL_SCOPES],
      page: true,
      run: () => this.treasuryCovers(),
    });
    r.registerCheck({
      name: "provider_clearing_aging",
      haltScopes: [],
      run: () => this.pspAging(),
    });
    r.registerCheck({
      name: "operator_money_unswept",
      haltScopes: [],
      run: () => this.operatorMoney(),
    });
    r.registerCheck({
      name: "events_dead",
      haltScopes: [],
      page: true,
      run: () => this.eventsDead(),
    });
    r.registerCheck({ name: "no_stuck_orders", haltScopes: [], run: () => this.stuckOrders() });
    // Report-only (C16): another instrument's sync failure must stay visible without halting.
    r.registerCheck({
      name: "token_sync_other_instruments",
      haltScopes: [],
      run: () => this.otherInstruments(),
    });
  }

  /** red: an entry whose lines do not sum to zero. */
  async journalBalanced(): Promise<ReconCheckOutcome> {
    const bad = await this.journal.unbalancedEntries();
    return bad.length
      ? {
          status: "red",
          detail: `${bad.length} entries do not sum to zero: ${bad.slice(0, 5).join(", ")}`,
        }
      : { status: "green", detail: "every entry sums to zero" };
  }

  /** red: customer_liability ≠ the recorded net issuance of source `ramp` — one snapshot of both. */
  async issuanceMatchesLiability(): Promise<ReconCheckOutcome> {
    const instrument = await this.sync.rampInstrument();
    if (!instrument) return { status: "green", detail: "no ramp instrument configured" };
    return this.dataSource.transaction("REPEATABLE READ", async (m) => {
      const cl = -((await this.journal.balances(m)).customer_liability ?? 0n);
      const [row] = await m.query<{ net: string }[]>(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'mint' THEN recorded_amount ELSE -recorded_amount END), 0)::text AS net
           FROM to_token_commands
          WHERE instrument_admin = $1 AND instrument_id = $2 AND source = 'ramp'
            AND status IN ('recorded', 'mismatch') AND recorded_amount IS NOT NULL`,
        [instrument.admin, instrument.id],
      );
      const issued = parseAmount(row?.net ?? "0");
      const figures = {
        customerLiability: formatAmount(cl),
        recordedIssuance: formatAmount(issued),
      };
      return cl === issued
        ? {
            status: "green",
            detail: "customer liability equals the recorded ramp issuance",
            figures,
          }
        : {
            status: "red",
            detail: `customer_liability ${formatAmount(cl)} vs recorded ramp issuance ${formatAmount(issued)}`,
            figures,
          };
    });
  }

  /**
   * SPEC §5's identity A ≥ L − tolerance (A = safeguard_bank + PC less the confirmed statements'
   * unbooked debits, C3; L = IP + CL + PO + max(0, suspense)); under `enforce` also a fresh
   * confirmed statement — none, or no reserve source at all, is red, never skipped (X5). Under
   * `warn` a stale statement is amber.
   */
  async reserveCovers(): Promise<ReconCheckOutcome> {
    const mode = this.config.rampControls.reserveGate;
    // C3: A as the bank shows it — the confirmed statements' unbooked debits come off it (every mode).
    const bank = await this.gates.statementStatus();
    const f = bankAdjusted(reserveFigures(await this.journal.balances()), bank.statement);
    const liabilities = clientLiabilities(f);
    const tolerance = this.config.rampControls.reserveTolerance;
    const st = mode === "off" ? null : bank;
    const figures = {
      assets: formatAmount(f.assets),
      liabilities: formatAmount(liabilities),
      headroom: formatAmount(f.assets - liabilities),
      unbookedDebits: formatAmount(bank.statement?.unbookedDebits ?? 0n),
      gate: mode,
      statementPeriodTo: st?.statement?.periodTo ?? null,
      statementClosing: st?.statement ? formatAmount(st.statement.closingBalance) : null,
    };
    if (f.assets < liabilities - tolerance)
      return {
        status: "red",
        detail: `client assets ${formatAmount(f.assets)} < client liabilities ${formatAmount(liabilities)}`,
        figures,
      };
    if (st && !st.ok) {
      if (st.reason === "statement_unreadable")
        return { status: "unknown", detail: st.detail, figures };
      return {
        status: mode === "enforce" ? "red" : "amber",
        detail: `statement_stale: ${st.detail}`,
        figures,
      };
    }
    return { status: "green", detail: "client assets cover client liabilities", figures };
  }

  /**
   * Treasury holdings ≥ in-app balances + live PendingPayouts + market collateral + T of cash-outs
   * our MarkPaid took whose burn has not landed — every figure from ONE snapshot of the index
   * (the indexer advances its offset in the same transaction as its rows, #9 b).
   */
  async treasuryCovers(): Promise<ReconCheckOutcome> {
    const instrument = await this.sync.rampInstrument();
    const treasury = this.config.treasuryPartyId;
    if (!instrument || !treasury)
      return { status: "green", detail: "no ramp instrument or treasury configured" };
    // The LIVE ledger end, read before the snapshot (C30): the cached to_indexer_state.ledger_end
    // freezes together with the offset when the indexer stalls (a failed pass only writes
    // last_error), so it would vouch for an hours-old index. A cursor advance between this read
    // and the snapshot only shrinks the measured lag.
    if (!this.stream.isConfigured())
      return { status: "unknown", detail: "no participant to check the ledger index against" };
    let liveEnd: number;
    try {
      liveEnd = await this.stream.ledgerEnd();
    } catch (err) {
      return {
        status: "unknown",
        detail: `the ledger end could not be read: ${(err as Error).message.slice(0, 200)}`,
      };
    }
    return this.dataSource.transaction("REPEATABLE READ", async (m) => {
      const [state] = await m.query<{ offset: string }[]>(
        `SELECT "offset"::text AS "offset" FROM to_indexer_state WHERE key = 'ledger'`,
      );
      if (!state) return { status: "unknown", detail: "the ledger index has no state yet" };
      const offset = Number(state.offset);
      const fresh = freshnessOf(offset, liveEnd, this.config.ledgerFreshOffsets);
      const lagFigures = { offset, ledgerEnd: fresh.ledgerEnd, lag: fresh.lag };
      if (!fresh.fresh)
        return {
          status: "unknown",
          detail: `the ledger index is ${fresh.lag} offsets behind the ledger end`,
          figures: lagFigures,
        };
      const sum = async (sql: string, params: unknown[]): Promise<bigint> =>
        parseAmount((await m.query<{ total: string }[]>(sql, params))[0]?.total ?? "0");
      const ins = [instrument.admin, instrument.id];
      const holdings = await sum(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ledger_holdings
          WHERE owner = $3 AND instrument_admin = $1 AND instrument_id = $2 AND archived_offset IS NULL`,
        [...ins, treasury],
      );
      const walletBalances = await sum(
        `SELECT COALESCE(SUM(balance), 0)::text AS total FROM to_ledger_wallets
          WHERE instrument_admin = $1 AND instrument_id = $2 AND active = true`,
        ins,
      );
      const livePayouts = await sum(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ledger_payouts
          WHERE instrument_admin = $1 AND instrument_id = $2 AND active = true`,
        ins,
      );
      // Users' money inside markets: what market choices debited minus what they credited back,
      // minus the PendingPayouts markets queued (live ones are counted above, settled ones left).
      const marketNet = await sum(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'debit' THEN amount ELSE -amount END), 0)::text AS total
           FROM to_wallet_entries
          WHERE instrument_admin = $1 AND instrument_id = $2 AND kind IN ('debit', 'credit')
            AND root_template = 'Truthoracle:PredictionMarket'`,
        ins,
      );
      const marketPayouts = await sum(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ledger_payouts
          WHERE instrument_admin = $1 AND instrument_id = $2 AND market_id <> 0`,
        ins,
      );
      const burns = await this.burnsNotLanded(m, ins);
      if (burns.unreadable)
        return {
          status: "unknown",
          detail: `the ledger could not be read to re-prove failed credit-backs: ${burns.unreadable}`,
          figures: lagFigures,
        };
      const out = evalTreasury({
        holdings,
        walletBalances,
        livePayouts,
        marketCollateral: marketNet - marketPayouts,
        pendingBurns: burns.certain,
        inFlightBurns: burns.inFlight,
        lateCreditBacks: burns.late,
        surplusMax: this.config.rampControls.treasurySurplusMax,
        offset,
      });
      return { ...out, figures: { ...out.figures, ...lagFigures } };
    });
  }

  /**
   * T of every cash-out whose PendingPayout our MarkPaid archived (index) while its burn has not
   * landed: certain when the burn was never created or never lands (and no credit-back Deposit of
   * any generation is indexed — then T is a wallet balance again), ambiguous while the burn is in
   * flight. C1: every credit-back key proven never to land (each earlier generation, and the
   * current one once it failed) is re-proven, whatever became of its order since (a retry may
   * have burned and paid T) — the index and an uncached ledger read; one that landed is `late`
   * (T may be credited twice). An unreadable ledger → `unreadable`.
   */
  private async burnsNotLanded(
    m: EntityManager,
    ins: string[],
  ): Promise<{
    certain: bigint;
    inFlight: bigint;
    late: LateCreditBack[];
    unreadable: string | null;
  }> {
    const rows = await m.query<
      { id: string; token_amount: string; status: string | null; credit_back: unknown }[]
    >(
      `SELECT o.id, o.token_amount::text AS token_amount, c.status,
              o.details -> 'creditBack' AS credit_back
         FROM to_ramp_orders o
         JOIN to_ledger_payouts p ON p.contract_id = o.pending_payout_cid
         LEFT JOIN to_token_commands c ON c.command_id = o.burn_command_id
        WHERE o.direction = 'offramp' AND o.instrument_admin = $1 AND o.instrument_id = $2
          AND p.active = false AND p.settled_kind = 'mark_paid' AND p.tx_hash = 'ramp:' || o.id::text
          AND (c.status IS NULL OR c.status NOT IN ('recorded', 'mismatch'))`,
      ins,
    );
    const failedRows = await m.query<{ id: string; credit_back: unknown }[]>(
      `SELECT o.id, o.details -> 'creditBack' AS credit_back FROM to_ramp_orders o
        WHERE o.direction = 'offramp' AND o.instrument_admin = $1 AND o.instrument_id = $2
          AND (o.details -> 'creditBack' ->> 'state' = 'failed'
            OR CASE WHEN jsonb_typeof(o.details -> 'creditBack' -> 'failed') = 'array'
                    THEN jsonb_array_length(o.details -> 'creditBack' -> 'failed') > 0 ELSE false END)`,
      ins,
    );
    const keysOf = (r: {
      id: string;
      credit_back: unknown;
    }): { all: string[]; failed: string[] } => {
      const cb = creditBackOf({ details: { creditBack: r.credit_back } });
      const failed = [
        ...(cb?.failed ?? []).map((f) => f.commandId),
        ...(cb?.state === "failed" ? [cb.commandId] : []),
      ];
      return { all: [cb?.commandId ?? rampCommandId("creditback", r.id), ...failed], failed };
    };
    const refs = [...rows, ...failedRows].flatMap((r) => keysOf(r).all.map(mintCreditTxRef));
    const credited = new Set(
      refs.length
        ? (
            await m.query<{ tx_ref: string }[]>(
              `SELECT tx_ref FROM to_wallet_entries WHERE kind = 'deposit' AND tx_ref = ANY($1::text[])`,
              [refs],
            )
          ).map((r) => r.tx_ref)
        : [],
    );
    let late: LateCreditBack[];
    try {
      late = await this.lateCreditBacks(
        m,
        failedRows.map((r) => ({ orderId: r.id, ...keysOf(r) })),
        credited,
      );
    } catch (err) {
      const unreadable = (err as Error).message.slice(0, 200);
      return { certain: 0n, inFlight: 0n, late: [], unreadable };
    }
    let certain = 0n;
    let inFlight = 0n;
    for (const r of rows) {
      if (keysOf(r).all.some((key) => credited.has(mintCreditTxRef(key)))) continue;
      if (late.some((l) => l.orderId === r.id)) continue;
      const t = parseAmount(r.token_amount);
      if (r.status === "pending" || r.status === "submitted" || r.status === "unknown")
        inFlight += t;
      else certain += t;
    }
    return { certain, inFlight, late, unreadable: null };
  }

  /**
   * C1: the credit-back keys proven never to land that landed after all — a Deposit with the key's
   * txRef in the index, else on the owner's wallet in an uncached ledger read (one read for every
   * order; none when no order has such a key) — and whether another key of the same order landed
   * too (`twice`). Throws when the ledger cannot be read.
   */
  private async lateCreditBacks(
    m: EntityManager,
    orders: { orderId: string; all: string[]; failed: string[] }[],
    indexed: ReadonlySet<string>,
  ): Promise<LateCreditBack[]> {
    if (!orders.length) return [];
    const owners = new Map(
      (
        await m.query<
          {
            command_id: string;
            owner_party: string;
            instrument_admin: string;
            instrument_id: string;
          }[]
        >(
          `SELECT command_id, owner_party, instrument_admin, instrument_id FROM to_deposit_credits
            WHERE command_id = ANY($1::text[])`,
          [orders.flatMap((o) => o.all.map(mintCreditCommandId))],
        )
      ).map((r) => [r.command_id, r]),
    );
    const wallets = await this.ledger.fetchAllUserWallets({ uncached: true });
    const onLedger = (key: string): boolean => {
      const owner = owners.get(mintCreditCommandId(key));
      const ref = mintCreditTxRef(key);
      return (
        !!owner &&
        wallets.some(
          (w) =>
            w.owner === owner.owner_party &&
            w.instrument.admin === owner.instrument_admin &&
            w.instrument.id === owner.instrument_id &&
            w.creditRefs.includes(ref),
        )
      );
    };
    const late: LateCreditBack[] = [];
    for (const o of orders) {
      const where = (key: string): "index" | "ledger" | null =>
        indexed.has(mintCreditTxRef(key)) ? "index" : onLedger(key) ? "ledger" : null;
      const landed = [...new Set(o.all)].filter((key) => where(key) !== null);
      for (const commandId of o.failed) {
        const at = where(commandId);
        if (at) late.push({ orderId: o.orderId, commandId, where: at, twice: landed.length > 1 });
      }
    }
    return late;
  }

  /**
   * FIFO (SPEC §6.2): provider_clearing debits (captures) older than RAMP_PSP_SETTLE_DAYS business
   * days that every later credit (settlements, fees, refunds, card payouts) has not consumed.
   */
  async pspAging(): Promise<ReconCheckOutcome> {
    const days = this.config.rampControls.pspSettleDays;
    const cal = this.gates.calendar;
    const cutoff = cal.startOfDayUtc(cal.subtractBusinessDays(minskDate(new Date()), days));
    const [row] = await this.dataSource.query<{ old_debits: string; credits: string }[]>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0 AND created_at < $1), 0)::text AS old_debits,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0)::text AS credits
         FROM to_ramp_journal WHERE account = 'provider_clearing'`,
      [cutoff],
    );
    const aged = parseAmount(row?.old_debits ?? "0") - parseAmount(row?.credits ?? "0");
    const figures = {
      unsettled: formatAmount(aged > 0n ? aged : 0n),
      olderThan: cutoff.toISOString(),
      businessDays: days,
    };
    return aged > 0n
      ? {
          status: "amber",
          detail: `${formatAmount(aged)} captured before ${cutoff.toISOString()} is not settled`,
          figures,
        }
      : { status: "green", detail: "captures settle within the PSP window", figures };
  }

  /** amber: operator money in the client account above RAMP_OPERATOR_MONEY_MAX now and a business day ago. */
  async operatorMoney(): Promise<ReconCheckOutcome> {
    const max = this.config.rampControls.operatorMoneyMax;
    if (max === null) return { status: "green", detail: "RAMP_OPERATOR_MONEY_MAX is not set" };
    const cal = this.gates.calendar;
    const dayAgo = cal.startOfDayUtc(cal.subtractBusinessDays(minskDate(new Date()), 1));
    const [row] = await this.dataSource.query<{ now: string; then: string }[]>(
      `SELECT COALESCE(SUM(-amount), 0)::text AS now,
              COALESCE(SUM(-amount) FILTER (WHERE created_at <= $1), 0)::text AS then
         FROM to_ramp_journal WHERE account = 'operator_money'`,
      [dayAgo],
    );
    const held = parseAmount(row?.now ?? "0");
    const before = parseAmount(row?.then ?? "0");
    const figures = {
      operatorMoney: formatAmount(held),
      aBusinessDayAgo: formatAmount(before),
      max: formatAmount(max),
    };
    return held > max && before > max
      ? {
          status: "amber",
          detail: `operator money ${formatAmount(held)} above ${formatAmount(max)} for over a business day`,
          figures,
        }
      : { status: "green", detail: "operator money is swept", figures };
  }

  /** amber: a dead webhook event; red when it is a chargeback (paged). */
  async eventsDead(): Promise<ReconCheckOutcome> {
    const rows = await this.dataSource.query<{ id: string; kind: string; type: string }[]>(
      `SELECT id, kind, type FROM to_ramp_events WHERE dead_at IS NOT NULL AND processed_at IS NULL ORDER BY dead_at LIMIT 100`,
    );
    if (!rows.length) return { status: "green", detail: "no dead webhook event" };
    const chargebacks = rows.filter(
      (r) => r.kind === "chargeback" || r.type.startsWith("chargeback"),
    );
    const figures = { dead: rows.length, chargebacks: chargebacks.length };
    return chargebacks.length
      ? {
          status: "red",
          detail: `dead chargeback event(s): ${chargebacks
            .slice(0, 5)
            .map((r) => r.id)
            .join(", ")}`,
          figures,
        }
      : { status: "amber", detail: `${rows.length} dead webhook event(s)`, figures };
  }

  /**
   * amber: orders past their status' expected time (M8 thresholds; deferred orders excluded).
   * Held orders and each status' window are filtered in SQL BEFORE the limit (C45): taken first,
   * the oldest 500 filled up with orders waiting on purpose and hid a newer stuck one.
   */
  async stuckOrders(): Promise<ReconCheckOutcome> {
    const now = new Date();
    const ctx = {
      now,
      calendar: this.gates.calendar,
      confirmMin: this.config.tokenCommands.confirmMin,
      stuckAfterMin: this.config.ramp.stuckAfterMin,
      // S6: RAMP_BANK_SETTLE_DAYS (the default lives in the logic for the unit specs).
      bankSettleDays: this.config.rampBank.settleDays,
    };
    const c = stuckCutoffs(now, ctx);
    const rows = await this.dataSource.query<
      {
        id: string;
        status: RampOrderStatus;
        status_changed_at: Date;
        expires_at: Date | null;
        held: boolean;
        method: RampMethod | null;
      }[]
    >(
      `SELECT id, status, status_changed_at, expires_at, method, false AS held
         FROM to_ramp_orders
        WHERE status NOT IN ('completed', 'failed', 'expired', 'cancelled', 'refunded', 'chargeback', 'needs_review')
          AND NOT (details ? 'hold' AND details -> 'hold' <> 'null'::jsonb)
          AND CASE status
                WHEN 'awaiting_payment' THEN expires_at < $1
                WHEN 'payout_queued' THEN status_changed_at < $2
                WHEN 'payout_sent' THEN status_changed_at < $3
                WHEN 'refunding' THEN status_changed_at < (CASE WHEN method = 'erip' THEN $4 ELSE $5 END)::timestamptz
                WHEN 'minting' THEN status_changed_at < $6
                WHEN 'burning' THEN status_changed_at < $6
                ELSE status_changed_at < $7
              END
        ORDER BY status_changed_at ASC LIMIT ${STUCK_SCAN_LIMIT + 1}`,
      [
        c.awaitingExpiresBefore,
        c.queuedBefore,
        c.sentBefore,
        c.eripRefundBefore,
        c.cardRefundBefore,
        c.confirmBefore,
        c.otherBefore,
      ],
    );
    const truncated = rows.length > STUCK_SCAN_LIMIT;
    const stuck = rows
      .slice(0, STUCK_SCAN_LIMIT)
      .map((r) => ({
        id: r.id,
        status: r.status,
        why: stuckReason(
          {
            status: r.status,
            statusChangedAt: new Date(r.status_changed_at),
            expiresAt: r.expires_at ? new Date(r.expires_at) : null,
            held: r.held,
            method: r.method,
          },
          ctx,
        ),
      }))
      .filter((r) => r.why !== null);
    const byStatus: Record<string, number> = {};
    for (const s of stuck) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const figures = {
      stuck: stuck.length,
      byStatus,
      orders: stuck.slice(0, 10).map((s) => s.id),
      // More candidates than the scan reads: the count is a floor, never a silent undercount.
      truncated,
    };
    if (!stuck.length && !truncated)
      return { status: "green", detail: "no order past its expected time", figures };
    const count = truncated ? `at least ${stuck.length}` : `${stuck.length}`;
    return {
      status: "amber",
      detail: stuck.length
        ? `${count} order(s) past their expected time: ${stuck[0].why}`
        : `more than ${STUCK_SCAN_LIMIT} orders past their status' cut-off`,
      figures,
    };
  }

  /**
   * amber: an instrument other than the ramp's could not be synced in full by the last token sync
   * pass (a client not scoped to it, a 403, a corrupt amount). Report-only (C16): it halts and
   * pages nothing and no gate reads it; the ramp instrument's own sync is the token checks'.
   */
  async otherInstruments(): Promise<ReconCheckOutcome> {
    const last = await this.sync.lastPassSummary();
    if (!last)
      return { status: "green", detail: "no token sync pass yet (the token checks report it)" };
    const rampId = last.rampInstrument?.id ?? null;
    const failing = (last.instruments ?? []).filter(
      (i) => i.instrumentId !== rampId && !i.complete,
    );
    const figures = {
      passFinishedAt: last.finishedAt,
      failing: failing.map((i) => ({ instrumentId: i.instrumentId, error: i.error })),
    };
    return failing.length
      ? {
          status: "amber",
          detail: `the last token sync could not read ${failing
            .map((i) => `${i.instrumentId}: ${i.error ?? "incomplete"}`)
            .join("; ")}`,
          figures,
        }
      : { status: "green", detail: "every other instrument synced in full", figures };
  }
}
