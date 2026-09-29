import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type { TransferRow } from "../types";
import { ApiError } from "../util/errors";
import { formatCC, tryParseCC } from "../util/money";
import { asString } from "../util/strings";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";
import { RedisService } from "./redis.service";

/**
 * Server-side Enterprise Wallet calls. Port of truthoracle-canton/api/_lib/walletClient.mjs.
 * Nothing here takes an amount or a recipient from the browser — every value is either
 * derived from upstream state or pinned in config, which is the whole point of moving these
 * flows off the open proxy.
 */

const INBOUND = new Set(["in", "incoming", "inbound", "receive", "received", "credit"]);
const OUTBOUND = new Set(["out", "outgoing", "outbound", "send", "sent", "debit"]);

// Wallet v0.1.35+ history rows carry a status ("completed" observed on DevNet). Only
// clearly-final states count toward what a user has sent in: crediting a pending or
// failed transfer would mint balance for money that never arrived. A row without a
// status is an unknown shape and is skipped (and reported) like an unknown status.
const SETTLED = new Set(["completed", "complete", "settled", "success", "succeeded", "confirmed", "final"]);
/** Non-final statuses the wallet is known to emit — skipped silently (the next reconcile picks them up once final). */
const NOT_SETTLED = new Set(["failed", "rejected", "cancelled", "canceled", "expired", "pending"]);

/**
 * Page size for history reads. The wallet's documented default (100000) is above what it can
 * actually serve: on DevNet v0.1.35 `limit=100000` returns HTTP 500 every time and anything
 * past roughly 50000 is flaky, so the "one huge page" approach the reconciliation used to rely
 * on 502'd every deposit. Page instead.
 */
export const HISTORY_PAGE_SIZE = 1000;

// Safety valve: 200 pages x 1000 = 200k events before we give up. The reconciliation must see
// the COMPLETE history (a truncated one under-credits users), so hitting this is an error, not
// a silent partial result.
export const HISTORY_MAX_PAGES = 200;

// Statuses that mean "this transfer never happened" — a retry with the same commandId is safe.
// Anything else (pending, settled, or a shape we don't recognise) counts as submitted: when in
// doubt, do NOT move money again.
const NEVER_HAPPENED = new Set(["failed", "rejected", "error", "cancelled", "canceled", "not_found", "notfound"]);

export interface HistoryEvent {
  eventType?: string;
  timestamp?: string;
  event?: TransferRow;
  [key: string]: unknown;
}

/**
 * Walk a newest-first, cursor-paged history to completion. `fetchPage(cursor)` returns one page
 * (newest first); the cursor is the `timestamp` of the oldest row returned so far. Pure so the
 * paging can be tested without a wallet.
 *
 * Verified on DevNet v0.1.35: `startDate` is an EXCLUSIVE cursor (rows strictly older than it in
 * the default desc order), and every page carries a `timestamp` per event.
 */
export async function collectHistory<T extends { timestamp?: string }>(
  fetchPage: (cursor: string | undefined) => Promise<T[]>,
  { pageSize = HISTORY_PAGE_SIZE, maxPages = HISTORY_MAX_PAGES }: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const events = await fetchPage(cursor);
    all.push(...events);
    if (events.length < pageSize) return all;
    const oldest = events[events.length - 1]?.timestamp;
    // No cursor = no way to ask for the next page; a full page with no timestamp means an
    // unknown shape. Refuse rather than return something partial.
    if (!oldest) throw new Error("wallet history page carries no timestamp cursor");
    if (oldest === cursor) throw new Error("wallet history cursor did not advance");
    cursor = oldest;
  }
  throw new Error(`wallet history exceeded ${maxPages * pageSize} events`);
}

/**
 * Total CC that `counterparty` has transferred IN to `partyId`, in fixed point.
 *
 * Direction strings are not pinned by the wallet's OpenAPI (`type: string`), so an unrecognised
 * value is skipped and logged rather than guessed at: counting an outbound transfer as inbound
 * would credit a user for money they withdrew.
 */
export function totalReceivedFrom(
  rows: TransferRow[],
  partyId: string,
  counterparty: string,
  instrumentId = "Amulet",
  onSkipped?: (count: number) => void,
): bigint {
  let total = 0n;
  let skipped = 0;
  for (const row of rows) {
    if (row?.instrumentId !== instrumentId) continue;

    const status = String(row?.status ?? "").trim().toLowerCase();
    if (!SETTLED.has(status)) {
      // Unknown (or missing) statuses are skipped too, and loudly: under-crediting is recoverable
      // (the next reconcile picks it up once the status is added), over-crediting is a mint.
      if (!NOT_SETTLED.has(status)) skipped += 1;
      continue;
    }

    const direction = String(row?.direction ?? "").trim().toLowerCase();
    if (!INBOUND.has(direction)) {
      if (!OUTBOUND.has(direction)) skipped += 1;
      continue;
    }

    // The pair must be exactly {treasury, user} in some order — a transfer merely mentioning the
    // user is not a transfer from them.
    const parties = [row?.partyId, row?.partyId2].map((p) => String(p ?? ""));
    if (!parties.includes(partyId) || !parties.includes(counterparty)) continue;
    if (partyId === counterparty) continue;

    const amount = tryParseCC(row?.amount);
    if (amount === null || amount <= 0n) continue;
    total += amount;
  }
  if (skipped && onSkipped) onSkipped(skipped);
  return total;
}

export interface TransferStatusResult {
  /** false = the read itself failed → callers must fail CLOSED (treat as possibly submitted). */
  known: boolean;
  submitted: boolean;
  status: string | null;
}

/**
 * `GET /api/v1/command/{partyId}/{commandId}` (CommandStatusResponse) — the status of an
 * `external/submit` command. `known: false` covers BOTH a failed read and a 404: the wallet's
 * command index "is not always wired through to the participant" (enterprise-wallet README), so
 * an unknown id is no evidence that the command never happened. Only an explicit terminal
 * failure status yields `known: true, submitted: false`.
 */
export type CommandStatusResult = TransferStatusResult;

/** Statuses the wallet reports for a command the ledger rejected or that never ran. */
const COMMAND_FAILED = new Set(["failed", "rejected", "error", "cancelled", "canceled", "aborted", "timeout", "timed_out"]);

@Injectable()
export class EnterpriseWalletService {
  private readonly logger = new Logger(EnterpriseWalletService.name);

  constructor(
    private readonly config: Config,
    private readonly keycloak: KeycloakTokenService,
    private readonly redis: RedisService,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.enterpriseWalletUrl && this.config.treasuryPartyId);
  }

  private async wallet<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const base = this.config.enterpriseWalletUrl;
    if (!base) throw new ApiError(502, "upstream_failed", "Enterprise wallet URL is not configured (ENTERPRISE_WALLET_URL)");
    const token = await this.keycloak.bearerFor("wallet");
    return authedJson<T>(base, path, { ...options, token, timeoutMs: 60_000 });
  }

  /**
   * Every settled transfer the treasury party has seen. Pages through the full history: the
   * reconciliation must see ALL of it — a truncated result would understate what a user has
   * sent in and silently under-credit them.
   *
   * Wallet v0.1.35+ serves `GET /api/v1/history/{partyId}` returning
   * `{ events: [{ eventType, timestamp, event }] }`, where each `event` payload is either a
   * transfer or a swap. We flatten to the payloads — swap events carry no `instrumentId`, so
   * `totalReceivedFrom` skips them naturally. There is no other history endpoint: a 404 here is
   * an upstream failure (wrong wallet version or URL), never a reason to try an older shape.
   * Cached in Redis for `ledgerCacheMs` unless `uncached` (the reconcile route).
   */
  async transferHistory(partyId: string, opts: { uncached?: boolean; pageSize?: number } = {}): Promise<TransferRow[]> {
    const cacheKey = `wallet:history:${partyId}`;
    if (!opts.uncached && this.config.ledgerCacheMs > 0) {
      const hit = await this.redis.getJson<TransferRow[]>(cacheKey).catch(() => null);
      if (hit) return hit;
    }
    const rows = await this.fetchHistory(partyId, opts.pageSize ?? HISTORY_PAGE_SIZE);
    if (this.config.ledgerCacheMs > 0) {
      await this.redis.setJson(cacheKey, rows, this.config.ledgerCacheMs).catch(() => undefined);
    }
    return rows;
  }

  private async fetchHistory(partyId: string, pageSize: number): Promise<TransferRow[]> {
    const party = encodeURIComponent(partyId);
    try {
      const events = await collectHistory<HistoryEvent>(
        async (cursor) => {
          const qs = `limit=${pageSize}${cursor ? `&startDate=${encodeURIComponent(cursor)}` : ""}`;
          const response = await this.wallet<{ events?: unknown } | unknown[]>(`/api/v1/history/${party}?${qs}`);
          if (Array.isArray(response)) return response as HistoryEvent[];
          return Array.isArray(response?.events) ? (response.events as HistoryEvent[]) : [];
        },
        { pageSize },
      );
      return events.map((item) => (item?.event ?? item) as TransferRow);
    } catch (e) {
      throw this.asApiError(e, "wallet history read failed");
    }
  }

  /** Fixed-point total of settled Amulet inbound from `counterparty` to `partyId`. */
  totalReceivedFrom(rows: TransferRow[], partyId: string, counterparty: string): bigint {
    return totalReceivedFrom(rows, partyId, counterparty, "Amulet", (skipped) =>
      this.logger.warn(`${skipped} transfer row(s) had an unrecognised direction or status and were ignored`),
    );
  }

  /**
   * Has a transfer with this commandId already been submitted (pending or settled)?
   *
   * Callers use deterministic commandIds — derived from the contract being settled — precisely so
   * this check means something: a concurrent or crashed-and-retried settlement of the same
   * contract produces the SAME id, and is caught here instead of paying twice. Ledger-level
   * command deduplication on that id is the backstop for the window this read cannot close.
   *
   * `known: false` means the read itself failed: unlike walletClient.mjs (which answered
   * "false" = "go ahead") the backend must fail CLOSED and stop, so the outcome is explicit.
   */
  async transferStatus(partyId: string, commandId: string): Promise<TransferStatusResult> {
    try {
      const row = await this.wallet<unknown>(`/api/v1/transfer/${encodeURIComponent(partyId)}/${encodeURIComponent(commandId)}`);
      if (!row || typeof row !== "object") return { known: true, submitted: false, status: null };
      const r = row as { status?: unknown; state?: unknown };
      const status = asString(r.status ?? r.state).trim().toLowerCase();
      return { known: true, submitted: !NEVER_HAPPENED.has(status), status: status || null };
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) return { known: true, submitted: false, status: "not_found" };
      this.logger.warn(`transfer status check failed for ${commandId}: ${(e as Error).message}`);
      return { known: false, submitted: false, status: null };
    }
  }

  /**
   * Status of an `external/submit` command (Create / Exercise ids such as `deposit-…`,
   * `wallet-create-…`, `settle-…`, `markpaid-…`). NOT the transfer endpoint: those ids are not
   * transfers and `/api/v1/transfer/{party}/{commandId}` answers 404 for them, which the deposit
   * confirm pass used to read as "never submitted".
   */
  async commandStatus(partyId: string, commandId: string): Promise<CommandStatusResult> {
    try {
      const row = await this.wallet<unknown>(`/api/v1/command/${encodeURIComponent(partyId)}/${encodeURIComponent(commandId)}`);
      if (!row || typeof row !== "object") return { known: false, submitted: false, status: null };
      const r = row as { status?: unknown; state?: unknown };
      const status = asString(r.status ?? r.state).trim().toLowerCase();
      if (!status) return { known: false, submitted: false, status: null };
      return { known: true, submitted: !COMMAND_FAILED.has(status), status };
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) return { known: false, submitted: false, status: "not_found" };
      this.logger.warn(`command status check failed for ${commandId}: ${(e as Error).message}`);
      return { known: false, submitted: false, status: null };
    }
  }

  /** Treasury-signed Daml commands. Callers must have built `commands` server-side. */
  async externalSubmit(args: {
    commandId: string;
    commands: unknown[];
    disclosedContracts?: unknown[];
  }): Promise<{ commandId: string; status: string }> {
    try {
      const res = await this.wallet<Record<string, unknown>>("/api/v1/external/submit", {
        method: "POST",
        body: {
          partyId: this.config.treasuryPartyId,
          appName: this.config.enterpriseWalletAppName,
          commandId: args.commandId,
          commands: args.commands,
          disclosedContracts: args.disclosedContracts ?? [],
        },
      });
      return { commandId: args.commandId, status: asString(res?.status ?? res?.state, "submitted") };
    } catch (e) {
      throw this.asApiError(e, "wallet external submit failed");
    }
  }

  /** Treasury-signed CC transfer. `to` and `amountCC` must be derived, never client-supplied. */
  async transfer(args: {
    to: string;
    amountCC: bigint;
    reason: string;
    commandId: string;
    metadata?: Record<string, string>;
  }): Promise<{ commandId: string; status: string }> {
    try {
      const res = await this.wallet<Record<string, unknown>>("/api/v1/transfer", {
        method: "POST",
        body: {
          from: this.config.treasuryPartyId,
          to: args.to,
          instrumentId: "Amulet",
          transferAmount: formatCC(args.amountCC),
          reason: args.reason,
          app: this.config.enterpriseWalletAppName,
          commandId: args.commandId,
          metadata: args.metadata,
        },
      });
      return { commandId: args.commandId, status: asString(res?.status ?? res?.state, "submitted") };
    } catch (e) {
      throw this.asApiError(e, "wallet transfer failed");
    }
  }

  private asApiError(e: unknown, what: string): ApiError {
    if (e instanceof ApiError) return e;
    const status = e instanceof UpstreamError ? e.status : 0;
    this.logger.warn(`${what}: ${(e as Error).message}`);
    return new ApiError(502, "upstream_failed", `${what} (${status || "network"})`, status ? { upstreamStatus: status } : undefined);
  }
}
