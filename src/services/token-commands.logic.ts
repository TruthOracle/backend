/**
 * The decisions of the token-app command ledger (docs/RAMP.md §7), as pure functions so every
 * rule is unit-tested without a database: what a POST outcome does to a row, when two intents
 * under one id conflict, the caps, the preconditions of the four operator actions (resend,
 * abandon, compensate, adopt) and how token-app's records are matched to rows.
 */
import { createHash } from "node:crypto";

import {
  isDefinitiveNo,
  isUnresolved,
  type TokenCommandKind,
  type TokenCommandSource,
  type TokenCommandStatus,
} from "../entities/token-command.entity";
import { formatAmount } from "../util/money";
import type { TokenAppPostOutcome } from "./token-app.service";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Canton's default `maxDeduplicationDuration` is 7 days; abandon waits one more day (#8). */
export const ABANDON_MIN_AGE_MS = 8 * DAY_MS;
/** Two full re-pages this far apart must both miss the command: list order is unspecified, one pass can skip a row. */
export const ABANDON_REPAGE_SPREAD_MS = 60_000;
/** The later of those re-pages must be this recent. */
export const ABANDON_REPAGE_MAX_AGE_MS = 10 * 60_000;
/** token-app's monitor must have succeeded this long after the last POST. */
export const ABANDON_MONITOR_LAG_MS = HOUR_MS;

/** The fields an intent fixes; a second `recordIntent` under the same id must repeat them exactly. */
export interface TokenIntentFields {
  kind: TokenCommandKind;
  instrumentAdmin: string;
  instrumentId: string;
  partyId: string;
  amount: bigint;
  source: TokenCommandSource;
  ref: string | null;
}

/** Names of the fields that differ (empty = the same intent, the row is reused). */
export function intentConflicts(existing: TokenIntentFields, wanted: TokenIntentFields): string[] {
  return (Object.keys(wanted) as (keyof TokenIntentFields)[]).filter(
    (k) => (existing[k] ?? null) !== (wanted[k] ?? null),
  );
}

/**
 * Could an earlier POST under this id have landed? Only a row never POSTed (`pending`, 0
 * attempts) or one whose every POST was refused (`rejected`) is sure it did not.
 */
export function mayHaveLanded(status: TokenCommandStatus, attemptsBefore: number): boolean {
  if (status === "rejected") return false;
  if (status === "pending" && attemptsBefore === 0) return false;
  return true;
}

/**
 * The row's status after one POST. A definitive refusal makes it `rejected` only when no earlier
 * POST may have landed — a 403 on a re-send says nothing about the first send. `not_sent` changes
 * nothing (the caller undoes its write-ahead).
 */
export function statusAfterPost(
  before: TokenCommandStatus,
  attemptsBefore: number,
  outcome: TokenAppPostOutcome["outcome"],
): TokenCommandStatus {
  switch (outcome) {
    case "accepted":
      return "submitted";
    case "unknown":
      return before === "submitted" ? "submitted" : "unknown";
    case "rejected":
      if (!mayHaveLanded(before, attemptsBefore)) return "rejected";
      return before === "submitted" ? "submitted" : "unknown";
    case "not_sent":
      return before;
  }
}

export type CapCheck =
  { ok: true } | { ok: false; reason: "per_call" | "per_day"; limit: bigint; used: bigint };

/**
 * `TOKEN_APP_MAX_PER_CALL` on every mint and burn; `TOKEN_APP_MAX_PER_DAY` on mints, against the
 * rolling 24 h Σ of the instrument's other mints (`usedToday`, every status but definitive-no).
 */
export function evaluateCaps(input: {
  kind: TokenCommandKind;
  amount: bigint;
  maxPerCall: bigint | null;
  maxPerDay: bigint | null;
  usedToday: bigint;
}): CapCheck {
  if (input.maxPerCall !== null && input.amount > input.maxPerCall)
    return { ok: false, reason: "per_call", limit: input.maxPerCall, used: 0n };
  if (
    input.kind === "mint" &&
    input.maxPerDay !== null &&
    input.usedToday + input.amount > input.maxPerDay
  )
    return { ok: false, reason: "per_day", limit: input.maxPerDay, used: input.usedToday };
  return { ok: true };
}

/** When the last POST went out (the write-ahead time), else when the row was written. */
export function lastPostOf(row: { lastPostAt: Date | null; createdAt: Date }): Date {
  return row.lastPostAt ?? row.createdAt;
}

interface ActionRow {
  status: TokenCommandStatus;
  lastPostAt: Date | null;
  createdAt: Date;
}

/** Why a re-send is refused (null = allowed): unresolved or rejected, no record, inside the dedup window. */
export function resendRefusal(
  row: ActionRow,
  ev: { now: Date; mirrorHasRecord: boolean; maxAgeHours: number },
): string | null {
  if (!isUnresolved(row.status) && row.status !== "rejected")
    return `the command is ${row.status}; only an unresolved or rejected command can be re-sent`;
  if (ev.mirrorHasRecord) return "token-app already recorded this command id";
  if (ev.now.getTime() - lastPostOf(row).getTime() >= ev.maxAgeHours * HOUR_MS)
    return `the last POST is ${ev.maxAgeHours} h old or more: past the participant's dedup window a re-send can land twice`;
  return null;
}

export interface AbandonEvidence {
  now: Date;
  mirrorHasRecord: boolean;
  /** Start times of complete full re-pages of the instrument. */
  repages: Date[];
  monitorLastSuccessAt: Date | null;
  /** Fresh Σ of the treasury's indexed holdings of the instrument; null = unreadable. */
  indexedTreasuryHoldings: bigint | null;
  /** What the approval says the treasury holds when the command never landed. */
  expectedTreasuryHoldings: bigint;
}

/**
 * Every unmet precondition of `abandon` (#8); [] = it may be abandoned. A command becomes
 * "never lands" only when it is unresolved, its last POST is past the 7-day dedup window plus a
 * day, two full re-pages ≥ 60 s apart (the later one fresh) both miss it, token-app's monitor ran
 * well after the POST, and the treasury holds exactly what it would without it.
 */
export function abandonRefusals(row: ActionRow, ev: AbandonEvidence): string[] {
  const out: string[] = [];
  const lastPost = lastPostOf(row).getTime();
  const now = ev.now.getTime();
  if (!isUnresolved(row.status)) out.push(`the command is ${row.status}, not unresolved`);
  if (now - lastPost < ABANDON_MIN_AGE_MS) out.push("the last POST is less than 8 days old");
  if (ev.mirrorHasRecord) out.push("token-app recorded this command id");
  const after = ev.repages.map((d) => d.getTime()).filter((t) => t > lastPost);
  const latest = after.length ? Math.max(...after) : null;
  if (
    latest === null ||
    now - latest > ABANDON_REPAGE_MAX_AGE_MS ||
    !after.some((t) => latest - t >= ABANDON_REPAGE_SPREAD_MS)
  )
    out.push(
      "no two full re-pages ≥ 60 s apart (the later one in the last 10 min) after the last POST",
    );
  if (
    !ev.monitorLastSuccessAt ||
    ev.monitorLastSuccessAt.getTime() <= lastPost + ABANDON_MONITOR_LAG_MS
  )
    out.push("token-app's monitor has not succeeded since one hour after the last POST");
  if (ev.indexedTreasuryHoldings === null)
    out.push("the treasury's indexed holdings are unreadable");
  else if (ev.indexedTreasuryHoldings !== ev.expectedTreasuryHoldings)
    out.push(
      `the treasury holds ${formatAmount(ev.indexedTreasuryHoldings)}, not the ${formatAmount(ev.expectedTreasuryHoldings)} expected without the command`,
    );
  return out;
}

export type MismatchReason =
  "duplicate" | "party_mismatch" | "amount_mismatch" | "recorded_after_definitive_no";

/** `last_error` of a mismatched row: `mismatch:<reason>: <detail>` — the reason drives `compensationPlan`. */
export function mismatchError(reason: MismatchReason, detail: string): string {
  return `mismatch:${reason}: ${detail}`.slice(0, 800);
}

export function mismatchReasonOf(lastError: string | null): MismatchReason | null {
  const m = /^mismatch:([a-z_]+):/.exec(lastError ?? "");
  return m ? (m[1] as MismatchReason) : null;
}

const signOf = (k: TokenCommandKind): bigint => (k === "mint" ? 1n : -1n);

/**
 * The compensating command of a `mismatch`: what restores the expected net issuance. Expected =
 * ±amount, or 0 when the command had already been declared never-landing (downstream refunded or
 * credited back on that basis); actual = Σ ± of its records; `compensatedNet` = what earlier
 * compensations of the same command recorded (C21: records that landed after one was settled
 * re-open it). `kind: null` = the net is already right (e.g. the right amount to the wrong party)
 * — nothing to send.
 */
export function compensationPlan(
  row: { kind: TokenCommandKind; amount: bigint; lastError: string | null },
  records: { kind: TokenCommandKind; amount: bigint }[],
  expectedNetOverride?: bigint,
  compensatedNet = 0n,
): {
  expectedNet: bigint;
  actualNet: bigint;
  compensatedNet: bigint;
  kind: TokenCommandKind | null;
  amount: bigint;
} {
  const expectedNet =
    expectedNetOverride ??
    (mismatchReasonOf(row.lastError) === "recorded_after_definitive_no"
      ? 0n
      : signOf(row.kind) * row.amount);
  const actualNet = records.reduce((s, r) => s + signOf(r.kind) * r.amount, 0n);
  const delta = actualNet + compensatedNet - expectedNet;
  if (delta === 0n) return { expectedNet, actualNet, compensatedNet, kind: null, amount: 0n };
  return {
    expectedNet,
    actualNet,
    compensatedNet,
    kind: delta > 0n ? "burn" : "mint",
    amount: delta > 0n ? delta : -delta,
  };
}

/**
 * `comp-<sha256(original)[:40]>`, the first compensation of a mismatched command; a later
 * generation (its records changed after an earlier compensation settled it, C21) hashes
 * `<original>#<generation>` — a new id, so it is never mistaken for the one already recorded.
 */
export function compensationCommandId(original: string, generation = 1): string {
  const seed = generation <= 1 ? original : `${original}#${generation}`;
  return `comp-${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
}

/** The most compensation generations one command may have: a stuck loop, not a ledger, beyond it. */
export const MAX_COMPENSATIONS = 8;

/** Every id a compensation of `original` may take, generation 1 onwards. */
export function compensationIds(original: string): string[] {
  return Array.from({ length: MAX_COMPENSATIONS }, (_, i) =>
    compensationCommandId(original, i + 1),
  );
}

/** `rows` (any order) as the generations of `original`'s compensations: 1, 2, … up to the first gap. */
export function inGenerations<R extends { commandId: string }>(original: string, rows: R[]): R[] {
  const out: R[] = [];
  for (const id of compensationIds(original)) {
    const row = rows.find((r) => r.commandId === id);
    if (!row) break;
    out.push(row);
  }
  return out;
}

/**
 * Earlier compensations of one command, generation 1 onwards: the net they recorded, and those
 * not settled yet (still in flight, or themselves mismatched) — a new generation waits for them,
 * and the original does not count as settled meanwhile. A definitive-no one moved nothing. R1-5:
 * a mismatched one whose own compensations settled it (`settledNet`) counts at that net.
 */
export function compensationsSoFar(
  rows: {
    commandId: string;
    kind: TokenCommandKind;
    status: TokenCommandStatus;
    recordedAmount: bigint | null;
    settledNet?: bigint | null;
  }[],
): { net: bigint; unsettled: string[] } {
  let net = 0n;
  const unsettled: string[] = [];
  for (const r of rows) {
    if (r.settledNet !== undefined && r.settledNet !== null) net += r.settledNet;
    else if (r.status === "recorded" && r.recordedAmount !== null)
      net += signOf(r.kind) * r.recordedAmount;
    else if (!isDefinitiveNo(r.status)) unsettled.push(r.commandId);
  }
  return { net, unsettled };
}

// ───────────────────────────────────────────── matching ─────────────────────────────────────────────

/** A mirrored token-app record, as matching sees it. */
export interface MirrorRecordView {
  kind: TokenCommandKind;
  commandId: string | null;
  updateId: string | null;
  instrumentId: string;
  partyId: string;
  amount: bigint;
  recordCreatedAt: Date | null;
}

/** A command row, as matching sees it. */
export interface CommandRowView {
  commandId: string;
  kind: TokenCommandKind;
  instrumentId: string;
  partyId: string;
  amount: bigint;
  source: TokenCommandSource;
  status: TokenCommandStatus;
  /** A mismatch's Σ of records when it was flagged (`recorded_amount`); unknown = not given. */
  recordedAmount?: bigint | null;
  /** `mismatch:<reason>: …` of a mismatch — a re-opened one keeps its reason (it drives the expected net). */
  lastError?: string | null;
}

/**
 * The id an adopted record's `legacy` row gets: derived from the record's identity (the mirror's
 * unique key), never its own command id — two legacy records may share one, and a legacy row must
 * match exactly one record.
 */
export function legacyCommandId(r: MirrorRecordView): string {
  const key = `${r.kind}|${r.updateId ?? ""}|${r.commandId ?? ""}|${r.partyId}|${formatAmount(r.amount)}`;
  return `legacy-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

export interface MatchResult<C extends CommandRowView, R extends MirrorRecordView> {
  /** Unresolved rows with exactly one record of the same party and amount → `recorded`. */
  toRecord: { command: C; record: R }[];
  /** Rows that must become `mismatch` now (not already). */
  toMismatch: { command: C; records: R[]; reason: MismatchReason; detail: string }[];
  /** Records no row accounts for (I9 for the ramp instrument). */
  unknownRecords: R[];
  /** Rows with two or more records (a command that landed twice). */
  duplicates: C[];
}

/**
 * Match one instrument's rows and mirror (both already filtered to that instrument id). A
 * record belongs to the non-legacy row with its kind and command id, or to the legacy row adopted
 * for it. Per row: no record → unchanged; two or more → duplicate (mismatch); one record of
 * another party or amount → mismatch; one record after the row was declared never-landing →
 * mismatch; one matching record of an unresolved row → recorded. A mismatch whose records changed
 * since it was flagged (Σ ≠ `recordedAmount`: a later landing under an id already compensated) is
 * flagged again under its own reason (C21) — I9: no token movement of the ramp is ever silent.
 */
export function matchCommands<C extends CommandRowView, R extends MirrorRecordView>(
  commands: C[],
  records: R[],
): MatchResult<C, R> {
  const byKey = new Map<string, R[]>();
  for (const r of records) {
    if (!r.commandId) continue;
    const key = `${r.kind}|${r.commandId}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const live = new Set<string>();
  const legacy = new Set<string>();
  for (const c of commands) {
    if (c.source === "legacy") legacy.add(c.commandId);
    else live.add(`${c.kind}|${c.commandId}`);
  }
  const result: MatchResult<C, R> = {
    toRecord: [],
    toMismatch: [],
    unknownRecords: [],
    duplicates: [],
  };
  for (const r of records) {
    const known =
      (r.commandId !== null && live.has(`${r.kind}|${r.commandId}`)) ||
      legacy.has(legacyCommandId(r));
    if (!known) result.unknownRecords.push(r);
  }
  for (const c of commands) {
    if (c.source === "legacy") continue;
    const recs = byKey.get(`${c.kind}|${c.commandId}`) ?? [];
    if (recs.length === 0) continue;
    if (c.status === "mismatch") {
      if (recs.length >= 2) result.duplicates.push(c);
      const total = recs.reduce((s, r) => s + r.amount, 0n);
      if (c.recordedAmount === undefined || c.recordedAmount === null || total !== c.recordedAmount)
        result.toMismatch.push({
          command: c,
          records: recs,
          reason: mismatchReasonOf(c.lastError ?? null) ?? "duplicate",
          detail: `records changed after the mismatch was flagged: ${recs.length} records, Σ ${formatAmount(total)} (was ${c.recordedAmount == null ? "unknown" : formatAmount(c.recordedAmount)})`,
        });
      continue;
    }
    if (recs.length >= 2) {
      result.duplicates.push(c);
      result.toMismatch.push({
        command: c,
        records: recs,
        reason: "duplicate",
        detail: `token-app recorded it ${recs.length} times`,
      });
      continue;
    }
    const r = recs[0];
    if (c.status === "recorded") continue;
    const detail = `record ${r.updateId ?? "?"}: ${formatAmount(r.amount)} to ${r.partyId.slice(0, 24)}…`;
    if (isDefinitiveNo(c.status))
      result.toMismatch.push({
        command: c,
        records: recs,
        reason: "recorded_after_definitive_no",
        detail: `${c.status}, then ${detail}`,
      });
    else if (r.partyId !== c.partyId)
      result.toMismatch.push({ command: c, records: recs, reason: "party_mismatch", detail });
    else if (r.amount !== c.amount)
      result.toMismatch.push({ command: c, records: recs, reason: "amount_mismatch", detail });
    else result.toRecord.push({ command: c, record: r });
  }
  return result;
}

/**
 * The records `token.records.adopt {before}` would write `legacy` rows for: unknown records
 * created before the cutoff (#14). A record with no `created_at` is never adopted.
 */
export function adoptionSet<R extends MirrorRecordView>(
  commands: CommandRowView[],
  records: R[],
  before: Date,
): R[] {
  return matchCommands(commands, records).unknownRecords.filter(
    (r) => r.recordCreatedAt !== null && r.recordCreatedAt.getTime() < before.getTime(),
  );
}

/** Σ mints − Σ burns. */
export function netOf(items: { kind: TokenCommandKind; amount: bigint }[]): bigint {
  return items.reduce((s, i) => s + (i.kind === "mint" ? i.amount : -i.amount), 0n);
}
