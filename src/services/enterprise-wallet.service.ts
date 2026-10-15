import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";
import { asString } from "../util/strings";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";

/**
 * Server-side Enterprise Wallet calls. Port of pm-frontend/api/_lib/walletClient.mjs,
 * reduced to what the backend still needs from the wallet: treasury-signed submissions
 * (`externalSubmit`), the wallet's own instrument-aware transfer (`transfer`, docs/TOKENS.md §1)
 * and the two status indexes. Nothing here takes an amount or a recipient from the browser —
 * every value is either derived from upstream state or pinned in config, which is the whole point
 * of moving these flows off the open proxy. Deposits are never read from the wallet: they come
 * from the ledger index (`to_ledger_transfers`, docs/TOKENS.md §2 decision 5).
 */

// Statuses that mean "this transfer never happened" — a retry with the same commandId is safe.
// Anything else (pending, settled, or a shape we don't recognise) counts as submitted: when in
// doubt, do NOT move money again.
const NEVER_HAPPENED = new Set([
  "failed",
  "rejected",
  "error",
  "cancelled",
  "canceled",
  "not_found",
  "notfound",
]);

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
const COMMAND_FAILED = new Set([
  "failed",
  "rejected",
  "error",
  "cancelled",
  "canceled",
  "aborted",
  "timeout",
  "timed_out",
]);

@Injectable()
export class EnterpriseWalletService {
  private readonly logger = new Logger(EnterpriseWalletService.name);

  constructor(
    private readonly config: Config,
    private readonly keycloak: KeycloakTokenService,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.enterpriseWalletUrl && this.config.treasuryPartyId);
  }

  private async wallet<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    const base = this.config.enterpriseWalletUrl;
    if (!base)
      throw new ApiError(
        502,
        "upstream_failed",
        "Enterprise wallet URL is not configured (ENTERPRISE_WALLET_URL)",
      );
    const token = await this.keycloak.bearerFor("wallet");
    return authedJson<T>(base, path, { ...options, token, timeoutMs: 60_000 });
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
      const row = await this.wallet<unknown>(
        `/api/v1/transfer/${encodeURIComponent(partyId)}/${encodeURIComponent(commandId)}`,
      );
      if (!row || typeof row !== "object") return { known: true, submitted: false, status: null };
      const r = row as { status?: unknown; state?: unknown };
      const status = asString(r.status ?? r.state)
        .trim()
        .toLowerCase();
      return { known: true, submitted: !NEVER_HAPPENED.has(status), status: status || null };
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404)
        return { known: true, submitted: false, status: "not_found" };
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
      const row = await this.wallet<unknown>(
        `/api/v1/command/${encodeURIComponent(partyId)}/${encodeURIComponent(commandId)}`,
      );
      if (!row || typeof row !== "object") return { known: false, submitted: false, status: null };
      const r = row as { status?: unknown; state?: unknown };
      const status = asString(r.status ?? r.state)
        .trim()
        .toLowerCase();
      if (!status) return { known: false, submitted: false, status: null };
      return { known: true, submitted: !COMMAND_FAILED.has(status), status };
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404)
        return { known: false, submitted: false, status: "not_found" };
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
      return {
        commandId: args.commandId,
        status: asString(res?.status ?? res?.state, "submitted"),
      };
    } catch (e) {
      throw this.asApiError(e, "wallet external submit failed");
    }
  }

  /**
   * Treasury-signed transfer of `amount` of `instrumentId` (the wallet's own id for the token,
   * `to_instruments.wallet_instrument_id`). `to`, `instrumentId` and `amount` must be derived,
   * never client-supplied; the amount is already quantised to the instrument's decimals.
   */
  async transfer(args: {
    to: string;
    instrumentId: string;
    amount: bigint;
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
          instrumentId: args.instrumentId,
          transferAmount: formatAmount(args.amount),
          reason: args.reason,
          app: this.config.enterpriseWalletAppName,
          commandId: args.commandId,
          metadata: args.metadata,
        },
      });
      return {
        commandId: args.commandId,
        status: asString(res?.status ?? res?.state, "submitted"),
      };
    } catch (e) {
      throw this.asApiError(e, "wallet transfer failed");
    }
  }

  private asApiError(e: unknown, what: string): ApiError {
    if (e instanceof ApiError) return e;
    const status = e instanceof UpstreamError ? e.status : 0;
    this.logger.warn(`${what}: ${(e as Error).message}`);
    return new ApiError(
      502,
      "upstream_failed",
      `${what} (${status || "network"})`,
      status ? { upstreamStatus: status } : undefined,
    );
  }
}
