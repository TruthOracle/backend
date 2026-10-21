import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type {
  ErrorCode,
  TokenAppBatchRequest,
  TokenAppBatchResult,
  TokenAppCommandResult,
  TokenAppHolding,
  TokenAppMintRequest,
  TokenAppRecord,
  TokenAppStatus,
} from "../types";
import { ApiError } from "../util/errors";
import { asRecord, asText } from "../util/ledger-values";
import { formatAmountWithDecimals, parseAmount, quantizeDown } from "../util/money";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";

/** `/data/admin/mints|burns` page size: token-app's maximum (`limit` 1..1000, default 100 — T-D1). */
export const TOKEN_APP_PAGE_LIMIT = 1000;
/** A history longer than this many pages is refused rather than paged forever (an `offset` token-app ignores loops). */
export const TOKEN_APP_MAX_PAGES = 5000;
/** JSON numbers are accepted only below this magnitude: above it a double cannot carry 6 decimals exactly (T-D8). */
const MAX_JSON_NUMBER_AMOUNT = 1e9;

/** Positive and whole at the instrument's decimals — token-app (and the ledger) refuse anything finer, so it is never sent. */
function tokenAppAmount(amount: bigint, decimals: number): string {
  if (amount <= 0n || quantizeDown(amount, decimals) !== amount)
    throw new ApiError(
      400,
      "validation_failed",
      `token-app amounts must be positive and whole at ${decimals} decimals`,
    );
  return formatAmountWithDecimals(amount, decimals);
}

/**
 * `POST /api/admin/mint|burn` body (token-app OpenAPI `AdminMintRequest` / `AdminBurnRequest`):
 * snake_case keys, the amount as a decimal string in the instrument's own decimals (never a JSON
 * number). An amount finer than the instrument is refused here instead of truncated: what leaves
 * must be exactly what the command ledger recorded. Pure, so the shaping is unit-tested.
 */
export function tokenAppCommandBody(
  req: TokenAppMintRequest,
  appName: string,
): Record<string, string> {
  return {
    command_id: req.commandId,
    instrument_id: req.instrumentId,
    party_id: req.partyId,
    amount: tokenAppAmount(req.amount, req.decimals),
    app_name: appName,
  };
}

/** `POST /api/admin/mint-batch|burn-batch` body (`AdminMintBatchRequest`). */
export function tokenAppBatchBody(
  req: TokenAppBatchRequest,
  appName: string,
): Record<string, unknown> {
  return {
    command_id: req.commandId,
    instrument_id: req.instrumentId,
    entries: req.entries.map((e) => ({
      party_id: e.partyId,
      amount: tokenAppAmount(e.amount, req.decimals),
    })),
    app_name: appName,
  };
}

/**
 * An amount token-app served, in 1e-10 units — or a throw: an unreadable amount stops the caller
 * (fail closed) instead of reading as zero. Strings parse exactly; JSON numbers only below 1e9 and
 * only when `toFixed(decimals)` reproduces them (a double that does not round-trip carries
 * digits the instrument cannot have); anything finer than `decimals`, or negative, is corrupt.
 */
export function parseTokenAppAmount(value: unknown, decimals: number): bigint {
  let units: bigint;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!/^\+?(\d+\.?\d*|\.\d+)$/.test(raw))
      throw corrupt(`not a non-negative decimal: "${raw.slice(0, 40)}"`);
    if (fractionDigits(raw) > 10) throw corrupt(`more than 10 decimals: ${raw.slice(0, 40)}`);
    units = parseAmount(raw);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value >= MAX_JSON_NUMBER_AMOUNT)
      throw corrupt(`JSON number out of range: ${String(value)}`);
    const fixed = value.toFixed(decimals);
    if (Number(fixed) !== value)
      throw corrupt(`JSON number ${String(value)} is finer than ${decimals} decimals`);
    units = parseAmount(fixed);
  } else {
    throw corrupt(`amount is ${value === null ? "null" : typeof value}`);
  }
  if (quantizeDown(units, decimals) !== units)
    throw corrupt(`amount ${String(value)} is finer than ${decimals} decimals`);
  return units;
}

function fractionDigits(raw: string): number {
  const dot = raw.indexOf(".");
  return dot < 0 ? 0 : raw.length - dot - 1;
}

function corrupt(detail: string): ApiError {
  return new ApiError(502, "upstream_failed", `token-app served an unreadable amount (${detail})`);
}

function parseTime(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What one `POST /api/admin/mint|burn` did. Never thrown: the command ledger records every outcome. */
export interface TokenAppPostOutcome {
  /**
   * `accepted` 2xx · `rejected` definitive, the command did not run (401 after a fresh bearer,
   * 403, 422) · `unknown` timeout / network / 5xx / any other status — it may still land ·
   * `not_sent` nothing left this process (unconfigured, no bearer, an invalid body).
   */
  outcome: "accepted" | "rejected" | "unknown" | "not_sent";
  /** 0 when no HTTP status was received. */
  httpStatus: number;
  /** token-app's own `status` on a 2xx. */
  status: string | null;
  code: ErrorCode | null;
  message: string | null;
}

/** A `/data/admin/mints|burns` row, parsed strictly (amount in 1e-10 units). */
export interface TokenAppParsedRecord {
  kind: "mint" | "burn";
  commandId: string | null;
  updateId: string | null;
  partyId: string;
  instrumentId: string;
  amount: bigint;
  createdAt: Date | null;
}

/** `GET /status`, the part the reconciliation reads (docs/RAMP.md §6.2 `supply_matches_issuance`). */
export interface TokenAppMonitorSnapshot {
  updatedAt: Date | null;
  /** null when `/status` lists no entry for the instrument (monitoring off, or not a managed token). */
  token: {
    totalSupply: bigint;
    totalLockedSupply: bigint | null;
    uniqueHolders: number | null;
    updatedAt: Date | null;
  } | null;
  monitor: {
    lastSuccessAt: Date | null;
    ageSeconds: number | null;
    pollIntervalSeconds: number | null;
    monitoringEnabled: boolean | null;
  };
}

/** `GET /data/admin/holdings`, checked: every holding the scan counted is in the list (T-D8). */
export interface TokenAppHoldingsScan {
  scannedAt: Date;
  total: number;
  holdings: (TokenAppHolding & { units: bigint })[];
}

type RecordFilter = { partyId?: string; instrumentId?: string };

/**
 * Cantor8's token-app, the service that holds a token's issuer key and submits its mints and
 * burns (docs/TOKENS.md §0, §4.4; docs/RAMP.md §7). The backend never touches a Daml mint
 * factory itself. `TOKEN_APP_URL` blank = unconfigured, and every caller answers
 * `503 token_app_unconfigured`; the bearer is the `TOKEN_APP_KEYCLOAK_*` client (on devnet
 * falling back to `KEYCLOAK_*`; on mainnet the dedicated client only — `resolveKeycloak`).
 *
 * A 401 means the bearer was refused before any handler ran: the cached token is invalidated,
 * a fresh one minted and the identical request sent ONCE more; a second 401 is
 * `token_app_unauthorized`. 403 (`token_app_forbidden`) and 422 (`token_app_invalid_request`)
 * are definitive and never retried. Command ids are the caller's idempotency keys; new mint /
 * burn code goes through TokenCommandService, which records every command before it is sent.
 */
@Injectable()
export class TokenAppService {
  private readonly logger = new Logger(TokenAppService.name);

  constructor(
    private readonly config: Config,
    private readonly keycloak: KeycloakTokenService,
  ) {}

  isConfigured(): boolean {
    return this.config.hasTokenApp && this.keycloak.isConfigured("tokenApp");
  }

  /** `POST /api/admin/mint` — throws on failure. Callers outside the command ledger only (v1 paths). */
  async mint(req: TokenAppMintRequest): Promise<TokenAppCommandResult> {
    return this.command(
      "/api/admin/mint",
      tokenAppCommandBody(req, this.config.tokenApp.appName),
      req.commandId,
    );
  }

  /** `POST /api/admin/burn` — throws on failure. */
  async burn(req: TokenAppMintRequest): Promise<TokenAppCommandResult> {
    return this.command(
      "/api/admin/burn",
      tokenAppCommandBody(req, this.config.tokenApp.appName),
      req.commandId,
    );
  }

  async mintBatch(req: TokenAppBatchRequest): Promise<TokenAppBatchResult> {
    return this.batch("/api/admin/mint-batch", req);
  }

  async burnBatch(req: TokenAppBatchRequest): Promise<TokenAppBatchResult> {
    return this.batch("/api/admin/burn-batch", req);
  }

  /**
   * One `POST /api/admin/mint|burn`, classified instead of thrown (TokenCommandService records
   * the outcome): 401 → invalidate, fresh bearer, the identical body once more.
   */
  async postCommand(kind: "mint" | "burn", req: TokenAppMintRequest): Promise<TokenAppPostOutcome> {
    const path = kind === "mint" ? "/api/admin/mint" : "/api/admin/burn";
    if (!this.isConfigured())
      return notSent(
        "token_app_unconfigured",
        "token-app is not configured (TOKEN_APP_URL and its Keycloak client)",
      );
    let body: Record<string, string>;
    let token: string;
    try {
      body = tokenAppCommandBody(req, this.config.tokenApp.appName);
      token = await this.keycloak.bearerFor("tokenApp");
    } catch (err) {
      const code = ApiError.is(err) ? err.code : "upstream_failed";
      return notSent(code, (err as Error).message);
    }
    let res = await this.attempt(path, body, token);
    if (res.httpStatus === 401) {
      await this.keycloak.invalidate("tokenApp");
      try {
        token = await this.keycloak.bearerFor("tokenApp");
      } catch (err) {
        return outcome("rejected", 401, null, "token_app_unauthorized", (err as Error).message);
      }
      res = await this.attempt(path, body, token);
    }
    if (res.httpStatus >= 200 && res.httpStatus < 300)
      return outcome(
        "accepted",
        res.httpStatus,
        asText(asRecord(res.data).status) || "submitted",
        null,
        null,
      );
    this.logger.warn(`token-app POST ${path} ${req.commandId} → ${res.httpStatus || "network"}`);
    if (res.httpStatus === 401)
      return outcome("rejected", 401, null, "token_app_unauthorized", res.error);
    if (res.httpStatus === 403)
      return outcome("rejected", 403, null, "token_app_forbidden", res.error);
    if (res.httpStatus === 422)
      return outcome("rejected", 422, null, "token_app_invalid_request", res.error);
    return outcome("unknown", res.httpStatus, null, "upstream_failed", res.error);
  }

  private async attempt(
    path: string,
    body: Record<string, string>,
    token: string,
  ): Promise<{ httpStatus: number; data: unknown; error: string | null }> {
    try {
      const data = await authedJson<unknown>(this.config.tokenApp.url, path, {
        method: "POST",
        body,
        token,
        timeoutMs: 60_000,
      });
      return { httpStatus: 200, data, error: null };
    } catch (err) {
      if (err instanceof UpstreamError)
        return { httpStatus: err.status, data: null, error: err.message.slice(0, 300) };
      return { httpStatus: 0, data: null, error: (err as Error).message.slice(0, 300) };
    }
  }

  /** `GET /healthz` (no bearer): what `npm run tokenapp:check` probes first. */
  async health(): Promise<{ ok: boolean; httpStatus: number }> {
    try {
      await authedJson<unknown>(this.config.tokenApp.url, "/healthz", { timeoutMs: 15_000 });
      return { ok: true, httpStatus: 200 };
    } catch (err) {
      return { ok: false, httpStatus: err instanceof UpstreamError ? err.status : 0 };
    }
  }

  /** `GET /status` — the monitor's snapshot of the managed tokens; `reachable: false` (never a throw) when token-app is down. */
  async status(): Promise<TokenAppStatus> {
    const base = {
      configured: this.isConfigured(),
      url: this.config.tokenApp.url || null,
      appName: this.config.tokenApp.appName,
    };
    if (!base.configured) return { ...base, reachable: false, raw: null };
    try {
      const raw = asRecord(await this.call("/status"));
      return { ...base, reachable: true, raw };
    } catch (err) {
      this.logger.warn(`token-app status unavailable: ${(err as Error).message}`);
      return { ...base, reachable: false, raw: null };
    }
  }

  /** `GET /status`, parsed for one instrument; throws when token-app cannot be read or serves an unreadable supply. */
  async monitor(instrumentId: string, decimals: number): Promise<TokenAppMonitorSnapshot> {
    const raw = asRecord(await this.call("/status"));
    const tokens = asRecord(raw.tokens);
    const entry = Object.prototype.hasOwnProperty.call(tokens, instrumentId)
      ? asRecord(tokens[instrumentId])
      : null;
    const op = asRecord(asRecord(raw.operational).monitor);
    return {
      updatedAt: parseTime(raw.updated_at),
      token: entry
        ? {
            totalSupply: parseTokenAppAmount(entry.total_supply, decimals),
            totalLockedSupply:
              entry.total_locked_supply === undefined || entry.total_locked_supply === null
                ? null
                : parseTokenAppAmount(entry.total_locked_supply, decimals),
            uniqueHolders: optionalNumber(entry.unique_holders),
            updatedAt: parseTime(entry.updated_at),
          }
        : null,
      monitor: {
        lastSuccessAt: parseTime(op.last_success_at),
        ageSeconds: optionalNumber(op.age_seconds),
        pollIntervalSeconds: optionalNumber(op.poll_interval_seconds),
        monitoringEnabled:
          typeof op.monitoring_enabled === "boolean" ? op.monitoring_enabled : null,
      },
    };
  }

  /**
   * `GET /data/admin/holdings?party_id=&instrument_id=` — the monitor's last holdings scan,
   * refused when it is truncated (`holdings.length ≠ total`), carries no `scan.scanned_at` or
   * an unreadable amount (T-D8). Freshness is the caller's call (`scannedAt`).
   */
  async holdingsScan(filter: RecordFilter, decimals: number): Promise<TokenAppHoldingsScan> {
    const res = asRecord(await this.call(`/data/admin/holdings${query(filter)}`));
    if (!Array.isArray(res.holdings) || typeof res.total !== "number")
      throw new ApiError(502, "upstream_failed", "token-app holdings: no holdings list / total");
    if (res.holdings.length !== res.total)
      throw new ApiError(
        502,
        "upstream_failed",
        `token-app holdings scan is truncated (${res.holdings.length} of ${res.total})`,
      );
    const scannedAt = parseTime(asRecord(res.scan).scanned_at);
    if (!scannedAt)
      throw new ApiError(502, "upstream_failed", "token-app holdings scan has no scan.scanned_at");
    return {
      scannedAt,
      total: res.total,
      holdings: res.holdings.map((item) => {
        const h = asRecord(item);
        const units = parseTokenAppAmount(h.amount, decimals);
        return {
          contractId: asText(h.holding_cid),
          partyId: asText(h.party_id),
          instrumentId: asText(h.instrument_id),
          amount:
            typeof h.amount === "string" ? h.amount : formatAmountWithDecimals(units, decimals),
          locked: h.locked === true,
          units,
        };
      }),
    };
  }

  /** The holdings scan's list (amounts as served); throws when the scan is truncated or undated. */
  async holdings(filter: RecordFilter = {}): Promise<TokenAppHolding[]> {
    const scan = await this.holdingsScan(filter, 10);
    return scan.holdings.map(({ units: _units, ...h }) => h);
  }

  /** Every `/data/admin/mints` row (all pages); amounts as served. */
  mints(filter: RecordFilter = {}): Promise<TokenAppRecord[]> {
    return this.records("/data/admin/mints", filter);
  }

  /** Every `/data/admin/burns` row (all pages); amounts as served. */
  burns(filter: RecordFilter = {}): Promise<TokenAppRecord[]> {
    return this.records("/data/admin/burns", filter);
  }

  /**
   * Every `/data/admin/mints|burns` row of an instrument (no party filter unless asked), paged
   * `limit=1000` until a short page, amounts parsed strictly at `decimals` — the command ledger's
   * mirror reads this (docs/RAMP.md §7).
   */
  async listRecords(
    kind: "mint" | "burn",
    filter: { instrumentId: string; partyId?: string },
    decimals: number,
  ): Promise<TokenAppParsedRecord[]> {
    const rows = await this.pages(
      kind === "mint" ? "/data/admin/mints" : "/data/admin/burns",
      filter,
    );
    return rows.map((item) => {
      const r = asRecord(item);
      return {
        kind,
        commandId: asText(r.command_id) || null,
        updateId: asText(r.update_id) || null,
        partyId: asText(r.party_id),
        instrumentId: asText(r.instrument_id),
        amount: parseTokenAppAmount(r.amount, decimals),
        createdAt: parseTime(r.created_at),
      };
    });
  }

  private async records(path: string, filter: RecordFilter): Promise<TokenAppRecord[]> {
    const items = await this.pages(path, filter);
    return items.map((item) => {
      const r = asRecord(item);
      return {
        commandId: asText(r.command_id),
        partyId: asText(r.party_id),
        instrumentId: asText(r.instrument_id),
        amount: decimalText(r.amount),
        updateId: asText(r.update_id),
        createdAt: asText(r.created_at),
      };
    });
  }

  /** `limit=1000&offset=n·1000` until a short page (T-D1); a repeated full page means `offset` is ignored — refused. */
  private async pages(path: string, filter: RecordFilter): Promise<unknown[]> {
    const out: unknown[] = [];
    let previous: string | null = null;
    for (let page = 0; page < TOKEN_APP_MAX_PAGES; page++) {
      const res = await this.call(
        `${path}${query(filter, { limit: TOKEN_APP_PAGE_LIMIT, offset: page * TOKEN_APP_PAGE_LIMIT })}`,
      );
      if (!Array.isArray(res))
        throw new ApiError(502, "upstream_failed", `token-app ${path} did not answer a list`);
      if (res.length >= TOKEN_APP_PAGE_LIMIT) {
        const edge = JSON.stringify([res[0], res[res.length - 1]]);
        if (edge === previous)
          throw new ApiError(
            502,
            "upstream_failed",
            `token-app ${path} repeats a page (offset ignored)`,
          );
        previous = edge;
      }
      out.push(...(res as unknown[]));
      if (res.length < TOKEN_APP_PAGE_LIMIT) return out;
    }
    throw new ApiError(
      502,
      "upstream_failed",
      `token-app ${path}: more than ${TOKEN_APP_MAX_PAGES} pages, refusing to page further`,
    );
  }

  private async command(
    path: string,
    body: Record<string, unknown>,
    commandId: string,
  ): Promise<TokenAppCommandResult> {
    const raw = asRecord(await this.call(path, { method: "POST", body }));
    return {
      commandId: asText(raw.command_id) || commandId,
      status: asText(raw.status) || "submitted",
      raw,
    };
  }

  private async batch(path: string, req: TokenAppBatchRequest): Promise<TokenAppBatchResult> {
    const raw = asRecord(
      await this.call(path, {
        method: "POST",
        body: tokenAppBatchBody(req, this.config.tokenApp.appName),
      }),
    );
    return {
      commandId: asText(raw.command_id) || req.commandId,
      status: asText(raw.status) || "submitted",
      entryCount:
        typeof raw.entry_count === "number"
          ? raw.entry_count
          : Number(raw.entry_count ?? req.entries.length),
      raw,
    };
  }

  /** One authenticated call; a 401 is answered with a fresh bearer and the identical request once more. */
  private async call(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<unknown> {
    if (!this.isConfigured())
      throw new ApiError(
        503,
        "token_app_unconfigured",
        "token-app is not configured (TOKEN_APP_URL and its Keycloak client)",
      );
    const send = async (): Promise<unknown> =>
      authedJson<unknown>(this.config.tokenApp.url, path, {
        ...options,
        token: await this.keycloak.bearerFor("tokenApp"),
        timeoutMs: 60_000,
      });
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof UpstreamError) || err.status !== 401)
        throw this.mapError(err, path, options);
    }
    await this.keycloak.invalidate("tokenApp");
    try {
      return await send();
    } catch (err) {
      throw this.mapError(err, path, options);
    }
  }

  private mapError(err: unknown, path: string, options: { method?: string }): unknown {
    if (!(err instanceof UpstreamError)) return err;
    this.logger.warn(`token-app ${options.method ?? "GET"} ${path} → ${err.status || "network"}`);
    const code: ErrorCode =
      err.status === 401
        ? "token_app_unauthorized"
        : err.status === 403
          ? "token_app_forbidden"
          : err.status === 422
            ? "token_app_invalid_request"
            : "upstream_failed";
    return new ApiError(
      502,
      code,
      `token-app failed (${err.status || "network"})`,
      err.status ? { upstreamStatus: err.status } : undefined,
    );
  }
}

function outcome(
  kind: TokenAppPostOutcome["outcome"],
  httpStatus: number,
  status: string | null,
  code: ErrorCode | null,
  message: string | null,
): TokenAppPostOutcome {
  return { outcome: kind, httpStatus, status, code, message };
}

function notSent(code: ErrorCode, message: string): TokenAppPostOutcome {
  return outcome("not_sent", 0, null, code, message);
}

/** v1 shape: the amount as served (string), or a JSON number below 1e9; anything else blank. */
function decimalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) < MAX_JSON_NUMBER_AMOUNT
  )
    return String(value);
  return "";
}

function query(filter: RecordFilter, page?: { limit: number; offset: number }): string {
  const q = new URLSearchParams();
  if (filter.partyId) q.set("party_id", filter.partyId);
  if (filter.instrumentId) q.set("instrument_id", filter.instrumentId);
  if (page) {
    q.set("limit", String(page.limit));
    q.set("offset", String(page.offset));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
