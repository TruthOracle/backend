import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import type { RampOrderEntity } from "../entities/ramp-order.entity";
import {
  TOKEN_COMMAND_DEFINITIVE_NO,
  TOKEN_COMMAND_UNRESOLVED,
} from "../entities/token-command.entity";
import type { InstrumentId } from "../types";
import { BusinessCalendar, minskDate } from "../util/by-calendar";
import { formatAmount, parseAmount } from "../util/money";
import { HOUR_MS } from "../util/time";
import {
  PAYOUT_GATE_CHECKS,
  RESERVE_GATE_CHECKS,
  reserveAfter,
  type ReserveFigures,
  reserveFigures,
  runRefusal,
} from "./ramp-controls.logic";
import { RampControlsService } from "./ramp-controls.service";
import { RampJournalService } from "./ramp-journal.service";
import { RampReconciliationService, type ReserveStatement } from "./ramp-reconciliation.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { TokenAppSyncService } from "./token-app-sync.service";
import { TokenCommandService } from "./token-command.service";

export type GateVerdict =
  { ok: true; warnings: string[] } | { ok: false; reason: string; detail: string };

export type StatementStatus =
  | { ok: true; statement: ReserveStatement; ageBdays: number }
  | {
      ok: false;
      reason: "statement_stale" | "statement_unreadable";
      detail: string;
      statement: ReserveStatement | null;
    };

/**
 * SPEC §6.3's A as the bank shows it (C3): the journal's figures less the debits of confirmed
 * statements still unbooked — money gone from the client-money account that safeguard_bank still
 * counts until someone classifies the line. Unbooked credits are not added (fail closed).
 */
export function bankAdjusted(
  f: ReserveFigures,
  statement: ReserveStatement | null,
): ReserveFigures {
  const unbooked = statement?.unbookedDebits ?? 0n;
  return unbooked < 0n ? { ...f, assets: f.assets + unbooked } : f;
}

/** Crash ceiling of `lock:ramp-mint-gate` (gate + order CAS of one mint). */
const MINT_GATE_LOCK_TTL_MS = 30_000;
const MINT_GATE_LOCK_TRIES = 10;
const MINT_GATE_LOCK_WAIT_MS = 300;

/**
 * The reserve gate (SPEC §6.3, #6, X5) before every mint and re-mint, and the payout gate (SPEC
 * §6.4, X8) before every release of fiat. Both fail closed on stale or unreadable data. The
 * reserve gate runs under `lock:ramp-mint-gate` together with the order CAS that records the mint
 * (`withMintGateLock`), so two mints never both pass on the same headroom. A failure is reported
 * once an hour per reason (Sentry); the caller leaves the order where it is.
 */
@Injectable()
export class RampGatesService {
  private readonly logger = new Logger(RampGatesService.name);
  readonly calendar: BusinessCalendar;

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly controls: RampControlsService,
    private readonly reconciliation: RampReconciliationService,
    private readonly journal: RampJournalService,
    private readonly tokenCommands: TokenCommandService,
    private readonly sync: TokenAppSyncService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {
    this.calendar = new BusinessCalendar(
      config.rampControls.bankHolidays,
      config.rampControls.bankWorkdays,
    );
  }

  /** Run `fn` holding `lock:ramp-mint-gate` (a few short tries); `acquired: false` = busy, retry next pass. */
  async withMintGateLock<T>(
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    for (let i = 0; i < MINT_GATE_LOCK_TRIES; i += 1) {
      const lock = await this.redis.acquireLock("lock:ramp-mint-gate", MINT_GATE_LOCK_TTL_MS);
      if (lock.acquired) {
        try {
          return { acquired: true, value: await fn() };
        } finally {
          await lock.release();
        }
      }
      await new Promise((r) => setTimeout(r, MINT_GATE_LOCK_WAIT_MS));
    }
    return { acquired: false };
  }

  /**
   * SPEC §6.3 (d)'s statement condition: a reserve source (S6), a confirmed statement, its
   * `period_to` at most RAMP_RESERVE_MAX_AGE_BDAYS Belarusian business days old. Never skipped.
   */
  async statementStatus(now = new Date()): Promise<StatementStatus> {
    if (!this.reconciliation.hasReserveSource())
      return {
        ok: false,
        reason: "statement_stale",
        detail: "no reserve source is registered (bank statements)",
        statement: null,
      };
    let statement: ReserveStatement | null;
    try {
      statement = await this.reconciliation.reserveStatement();
    } catch (err) {
      return {
        ok: false,
        reason: "statement_unreadable",
        detail: `the reserve source failed: ${(err as Error).message}`,
        statement: null,
      };
    }
    if (!statement)
      return {
        ok: false,
        reason: "statement_stale",
        detail: "no confirmed bank statement",
        statement: null,
      };
    const ageBdays = this.calendar.businessDaysBetween(statement.periodTo, minskDate(now));
    if (ageBdays > this.config.rampControls.reserveMaxAgeBdays)
      return {
        ok: false,
        reason: "statement_stale",
        detail: `the latest confirmed statement ends ${statement.periodTo}, ${ageBdays} business days ago (max ${this.config.rampControls.reserveMaxAgeBdays})`,
        statement,
      };
    return { ok: true, statement, ageBdays };
  }

  /** The reserve figures as the gate sees them now (Δ = 0) — `GET /admin/ramp/reconciliation.reserve`. */
  async reserveSnapshot(): Promise<Record<string, string | number | boolean | null>> {
    const instrument = await this.sync.rampInstrument();
    const st = await this.statementStatus();
    const f = bankAdjusted(reserveFigures(await this.journal.balances()), st.statement);
    const supply = instrument ? await this.tokenCommands.recordedNet(instrument) : 0n;
    const unresolved = instrument ? await this.unresolvedNonRampMints(instrument) : 0n;
    const after = reserveAfter({
      figures: f,
      recordedSupply: supply,
      unresolvedNonRampMints: unresolved,
      delta: 0n,
      tolerance: this.config.rampControls.reserveTolerance,
    });
    return {
      assets: formatAmount(after.assets),
      liabilities: formatAmount(after.liabilitiesAfter),
      headroom: formatAmount(after.headroom),
      safeguardBank: formatAmount(f.safeguardBank),
      // C3: the confirmed statements' debits still unbooked, already taken off `assets`.
      unbookedDebits: formatAmount(st.statement?.unbookedDebits ?? 0n),
      providerClearing: formatAmount(f.providerClearing),
      issuancePending: formatAmount(f.issuancePending),
      customerLiability: formatAmount(f.customerLiability),
      payoutClearing: formatAmount(f.payoutClearing),
      bankSuspense: formatAmount(f.bankSuspense),
      recordedSupply: formatAmount(supply),
      unresolvedNonRampMints: formatAmount(unresolved),
      statementClosing: st.statement ? formatAmount(st.statement.closingBalance) : null,
      statementPeriodTo: st.statement?.periodTo ?? null,
      statementFresh: st.ok,
      gate: this.config.rampControls.reserveGate,
      tolerance: formatAmount(this.config.rampControls.reserveTolerance),
    };
  }

  /**
   * SPEC §6.3 before a mint (`kind = mint`: an on-ramp's N) or a re-mint (`remint`: a reversal's
   * T). (a) the applicable `mints` halt; (b) a full run younger than RAMP_RECON_MAX_AGE_MIN with
   * no red on journal_balanced or the token checks; (c) token-app caps and, for mints, the
   * rolling-24 h RAMP_MINT_DAILY_CAP over ramp mints in every status but definitive-no (re-mints
   * excluded); (d) a fresh confirmed statement and `L_after ≤ A + tolerance`. (b) and (d) only
   * warn under RAMP_RESERVE_GATE=warn and are skipped under `off` (off-prod only).
   */
  async reserveGate(
    order: RampOrderEntity,
    kind: "mint" | "remint",
    opts: { now?: Date; resendOf?: string; remainder?: bigint } = {},
  ): Promise<GateVerdict> {
    const now = opts.now ?? new Date();
    const mode = this.config.rampControls.reserveGate;
    const instrument = { admin: order.instrumentAdmin, id: order.instrumentId };
    // A reverse_remainder re-mints only R (S5): R into S, R out of PO — Δ = 0.
    const amount = opts.remainder ?? order.tokenAmount;
    if (await this.controls.mintsHalted(kind))
      return this.refuse("reserve", "mints_halted", "the mints scope is halted");

    const warnings: string[] = [];
    const soft = async (reason: string, detail: string): Promise<GateVerdict | null> => {
      if (mode === "enforce") return this.refuse("reserve", reason, detail);
      warnings.push(`${reason}: ${detail}`);
      await this.alertOnce("reserve", reason, detail, true);
      return null;
    };

    if (mode !== "off") {
      const refusal = runRefusal(await this.reconciliation.latestFullRun(), RESERVE_GATE_CHECKS, {
        now,
        maxAgeMin: this.config.rampControls.reconMaxAgeMin,
        refuseUnknown: false,
      });
      if (refusal) {
        const out = await soft(refusal.reason, refusal.detail);
        if (out) return out;
      }
    }

    // A re-send POSTs a row that already counts in the rolling sums: count it once.
    const cap = await this.tokenCommands.checkCaps("mint", instrument, amount, {
      excludeCommandId: opts.resendOf,
    });
    if (!cap.ok)
      return this.refuse(
        "reserve",
        "token_app_cap",
        `token-app ${cap.reason} cap ${formatAmount(cap.limit)} (used ${formatAmount(cap.used)})`,
      );
    const daily = this.config.rampControls.mintDailyCap;
    if (kind === "mint" && daily !== null) {
      const used = await this.rampMintsLastDay(instrument, opts.resendOf);
      if (used + amount > daily)
        return this.refuse(
          "reserve",
          "daily_cap",
          `ramp mints in the last 24 h ${formatAmount(used)} + ${formatAmount(amount)} exceed RAMP_MINT_DAILY_CAP ${formatAmount(daily)}`,
        );
    }

    if (mode !== "off") {
      const st = await this.statementStatus(now);
      if (!st.ok) {
        const out = await soft(st.reason, st.detail);
        if (out) return out;
      }
      // C3: a debit the bank booked that no line explains yet is gone from A all the same.
      const f = bankAdjusted(reserveFigures(await this.journal.balances()), st.statement);
      const after = reserveAfter({
        figures: f,
        recordedSupply: await this.tokenCommands.recordedNet(instrument),
        unresolvedNonRampMints: await this.unresolvedNonRampMints(instrument),
        // A re-mint puts T back into S while the burn moved only P into PO (#6 b).
        delta:
          kind === "remint" && opts.remainder === undefined
            ? order.tokenAmount - order.fiatAmount
            : 0n,
        tolerance: this.config.rampControls.reserveTolerance,
      });
      if (!after.ok) {
        const out = await soft(
          "reserve_short",
          `liabilities after ${formatAmount(after.liabilitiesAfter)} exceed assets ${formatAmount(after.assets)} (+ tolerance)`,
        );
        if (out) return out;
      }
    }
    return { ok: true, warnings };
  }

  /**
   * SPEC §6.4 (X8) before MarkPaid, every card payout / refund part / OCT, a batch approval and the
   * first batch download: `payouts` not halted; the latest full run younger than
   * RAMP_RECON_MAX_AGE_MIN with no red and no unknown on the token, treasury and supply checks; the
   * last token sync pass complete with zero unknown records. Under RAMP_PAYOUT_GATE=warn only the
   * halt refuses.
   */
  async payoutGate(now = new Date()): Promise<GateVerdict> {
    if (await this.controls.isHalted("payouts"))
      return this.refuse("payout", "payouts_halted", "the payouts scope is halted");
    const mode = this.config.rampControls.payoutGate;
    if (mode === "off") return { ok: true, warnings: [] };
    const problems: { reason: string; detail: string }[] = [];
    const refusal = runRefusal(await this.reconciliation.latestFullRun(), PAYOUT_GATE_CHECKS, {
      now,
      maxAgeMin: this.config.rampControls.reconMaxAgeMin,
      refuseUnknown: true,
    });
    if (refusal) problems.push(refusal);
    const pass = await this.sync.lastPassSummary();
    if (!pass) problems.push({ reason: "token_sync", detail: "no token sync pass on record" });
    else if (!pass.complete)
      problems.push({
        reason: "token_sync",
        detail: `the last token sync pass was incomplete: ${pass.error ?? "?"}`,
      });
    else if (pass.unknownRecords !== 0)
      problems.push({
        reason: "token_sync",
        detail: `the last token sync pass found ${pass.unknownRecords} unknown record(s)`,
      });
    if (!problems.length) return { ok: true, warnings: [] };
    if (mode === "enforce")
      return this.refuse("payout", problems[0].reason, problems.map((p) => p.detail).join("; "));
    for (const p of problems) await this.alertOnce("payout", p.reason, p.detail, true);
    return { ok: true, warnings: problems.map((p) => `${p.reason}: ${p.detail}`) };
  }

  // ───────────────────────────────────────────── internals ──────────────────────────────────

  /** U: mints of other sources that may still land (they raise S without a journal line). */
  private async unresolvedNonRampMints(instrument: InstrumentId): Promise<bigint> {
    return this.tokenCommands.sumCommands({
      instrument,
      kind: "mint",
      statuses: TOKEN_COMMAND_UNRESOLVED,
      excludeSources: ["ramp"],
    });
  }

  /** Rolling 24 h ramp mints in every status but definitive-no; re-mints and compensations excluded. */
  private async rampMintsLastDay(instrument: InstrumentId, exclude?: string): Promise<bigint> {
    const [row] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_token_commands
        WHERE instrument_admin = $1 AND instrument_id = $2 AND source = 'ramp' AND kind = 'mint'
          AND status <> ALL($3::text[]) AND created_at > now() - interval '24 hours'
          AND command_id NOT LIKE 'ramp-remint-%' AND command_id NOT LIKE 'comp-%'
          AND command_id <> $4`,
      [instrument.admin, instrument.id, [...TOKEN_COMMAND_DEFINITIVE_NO], exclude ?? ""],
    );
    return parseAmount(row?.total ?? "0");
  }

  private async refuse(
    gate: "reserve" | "payout",
    reason: string,
    detail: string,
  ): Promise<GateVerdict> {
    await this.alertOnce(gate, reason, detail, false);
    return { ok: false, reason, detail };
  }

  /** One Sentry event per gate, reason and hour (any instance); a log line every time. */
  private async alertOnce(
    gate: "reserve" | "payout",
    reason: string,
    detail: string,
    warnOnly: boolean,
  ): Promise<void> {
    this.logger.warn(`${gate} gate ${warnOnly ? "warning" : "refused"}: ${reason} (${detail})`);
    const once = await this.redis
      .acquireLock(`alert:${gate}-gate:${reason}`, HOUR_MS)
      .catch(() => ({ acquired: true }));
    if (!once.acquired) return;
    this.sentry.captureMessage(
      `${gate} gate ${warnOnly ? "warning" : "refused"}: ${reason}`,
      warnOnly ? "warning" : "error",
      {
        component: "ramp-gates",
        gate,
        reason,
      },
    );
  }
}
