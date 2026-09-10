import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type { LedgerWallet, PendingPayoutRecord } from "../types";
import { ApiError } from "../util/errors";
import { parseCC, tryParseCC } from "../util/money";
import { asString } from "../util/strings";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";
import { RedisService } from "./redis.service";

/**
 * Read-only access to the Canton JSON Ledger API as the treasury party. Port of
 * truthoracle-canton/api/_lib/ledgerClient.mjs.
 *
 * These exist so treasury-signed actions can be derived from what is actually on the ledger
 * instead of from what the browser claims. Read-only by design — writes go through the
 * Enterprise Wallet, which holds the signing key. On mainnet the base URL is ZKPC_LEDGER_API_URL
 * only (LEDGER_API_URL is ignored, exactly as upstream.mjs).
 */
const TRUTHORACLE_MODULE = "Truthoracle";

export interface ActiveContract {
  contractId: string;
  payload: Record<string, unknown>;
}

export interface ReadOptions {
  /** Bypass the Redis cache (the reconcile route must). */
  uncached?: boolean;
}

@Injectable()
export class LedgerClientService {
  private readonly logger = new Logger(LedgerClientService.name);

  constructor(
    private readonly config: Config,
    private readonly keycloak: KeycloakTokenService,
    private readonly redis: RedisService,
  ) {}

  get baseUrl(): string {
    return this.config.isMainnet ? this.config.zkpc.ledgerApiUrl : this.config.ledgerApiUrl;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.config.treasuryPartyId && this.config.truthoraclePackageName);
  }

  /** Package-id form, for Create/Exercise commands (pins the exact package version). */
  templateId(entity: string, module = TRUTHORACLE_MODULE): string {
    const pkg = this.config.truthoraclePackageId;
    if (!pkg) throw new ApiError(502, "upstream_failed", "TRUTHORACLE_PACKAGE_ID is not set");
    return `${pkg}:${module}:${entity}`;
  }

  /**
   * Package-NAME form, for active-contracts filters. The JSON Ledger API rejects the package-id
   * form there ("Invalid field packageId: Received an identifier with package ID ..., but
   * expected a package name") — frontend/utils/activeContracts.ts hit the same wall. Responses
   * still carry templateId in package-id form.
   */
  filterTemplateId(entity: string, module = TRUTHORACLE_MODULE): string {
    const name = this.config.truthoraclePackageName;
    if (!name) throw new ApiError(502, "upstream_failed", "TRUTHORACLE_PACKAGE_NAME is not set");
    return `#${name}:${module}:${entity}`;
  }

  private async ledger<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const base = this.baseUrl;
    if (!base) throw new ApiError(502, "upstream_failed", "Ledger API URL is not configured");
    const token = await this.keycloak.bearerFor("ledger");
    try {
      return await authedJson<T>(base, path, { ...options, token });
    } catch (err) {
      if (err instanceof UpstreamError) {
        this.logger.warn(`ledger ${options.method ?? "GET"} ${path} → ${err.status || "network"}`);
        throw new ApiError(502, "upstream_failed", `ledger read failed (${err.status || "network"})`);
      }
      throw err;
    }
  }

  private async ledgerEnd(): Promise<string> {
    const end = await this.ledger<{ offset?: unknown }>("/v2/state/ledger-end", { method: "GET" });
    return String(typeof end?.offset === "number" ? end.offset : 0);
  }

  /** Active contracts of one template visible to `party` (raw rows; cached `ledgerCacheMs`). */
  async activeContracts(
    party: string,
    entity: string,
    opts: ReadOptions = {},
    module = TRUTHORACLE_MODULE,
  ): Promise<ActiveContract[]> {
    const cacheKey = `ledger:ac:${party}:${module}:${entity}`;
    if (!opts.uncached && this.config.ledgerCacheMs > 0) {
      const hit = await this.redis.getJson<ActiveContract[]>(cacheKey).catch(() => null);
      if (hit) return hit;
    }
    const activeAtOffset = await this.ledgerEnd();
    const response = await this.ledger<unknown>("/v2/state/active-contracts", {
      method: "POST",
      body: {
        verbose: false,
        activeAtOffset,
        eventFormat: {
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: {
                      value: { templateId: this.filterTemplateId(entity, module), includeCreatedEventBlob: false },
                    },
                  },
                },
              ],
            },
          },
          verbose: false,
        },
      },
    });

    const r = response as { activeContracts?: unknown; contracts?: unknown } | unknown[];
    const items: unknown[] = Array.isArray(r)
      ? r
      : Array.isArray((r as { activeContracts?: unknown }).activeContracts)
        ? ((r as { activeContracts: unknown[] }).activeContracts)
        : Array.isArray((r as { contracts?: unknown }).contracts)
          ? ((r as { contracts: unknown[] }).contracts)
          : [];
    const out: ActiveContract[] = [];
    for (const item of items) {
      const event = (item as { contractEntry?: { JsActiveContract?: { createdEvent?: { contractId?: unknown; createArgument?: unknown } } } })
        ?.contractEntry?.JsActiveContract?.createdEvent;
      if (!event?.contractId) continue;
      out.push({
        contractId: asString(event.contractId),
        payload: (event.createArgument && typeof event.createArgument === "object" ? event.createArgument : {}) as Record<string, unknown>,
      });
    }
    if (this.config.ledgerCacheMs > 0) {
      await this.redis.setJson(cacheKey, out, this.config.ledgerCacheMs).catch(() => undefined);
    }
    return out;
  }

  private walletFrom(row: ActiveContract): LedgerWallet {
    const p = row.payload;
    return {
      contractId: row.contractId,
      owner: asString(p.owner),
      balanceCC: tryParseCC(p.balanceCC) ?? 0n,
      depositedCC: tryParseCC(p.depositedCC) ?? 0n,
      withdrawnCC: tryParseCC(p.withdrawnCC) ?? 0n,
      depositRefs: parseDepositRefs(p.depositRefs),
    };
  }

  /**
   * The owner's UserWallet, read as the treasury (signatory, so it sees every wallet). Returns
   * null when the user has never deposited — the caller creates one.
   */
  async fetchUserWallet(ownerParty: string, opts: ReadOptions = {}): Promise<LedgerWallet | null> {
    const rows = await this.activeContracts(this.config.treasuryPartyId, "UserWallet", opts);
    for (const row of rows) {
      if (asString(row.payload.owner) !== ownerParty) continue;
      return this.walletFrom(row);
    }
    return null;
  }

  async fetchAllUserWallets(opts: ReadOptions = {}): Promise<LedgerWallet[]> {
    const rows = await this.activeContracts(this.config.treasuryPartyId, "UserWallet", opts);
    return rows.map((r) => this.walletFrom(r));
  }

  private payoutFrom(row: ActiveContract): PendingPayoutRecord {
    const p = row.payload;
    // Field names mirror truthoracle-contracts/daml/daml/Truthoracle.daml (PendingPayout) — the payee is `user`.
    const createdAtRaw = p.createdAt ?? p.created_at;
    const createdAt = typeof createdAtRaw === "string" && !Number.isNaN(Date.parse(createdAtRaw)) ? new Date(createdAtRaw) : null;
    return {
      contractId: row.contractId,
      user: asString(p.user),
      marketId: asString(p.marketId),
      amountCC: tryParseCC(p.amountCC) ?? 0n,
      reason: asString(p.reason),
      createdAt,
    };
  }

  async fetchPendingPayouts(opts: ReadOptions = {}): Promise<PendingPayoutRecord[]> {
    const rows = await this.activeContracts(this.config.treasuryPartyId, "PendingPayout", opts);
    return rows.map((r) => this.payoutFrom(r));
  }

  /** One PendingPayout by contract id, or null when it is already archived. */
  async fetchPendingPayout(cid: string, opts: ReadOptions = {}): Promise<PendingPayoutRecord | null> {
    const rows = await this.activeContracts(this.config.treasuryPartyId, "PendingPayout", opts);
    for (const row of rows) {
      if (row.contractId !== cid) continue;
      return this.payoutFrom(row);
    }
    return null;
  }

  /** Test/diagnostic helper: parse a Daml Decimal string strictly. */
  static parseDecimal(value: unknown): bigint {
    return parseCC(String(value));
  }
}

/**
 * Daml `Optional [Text]` arrives as `null` / `["…"]` on the JSON Ledger API v2; older tooling
 * (and nested optionals) use `{ "Some": [...] }` / `"None"`. Missing = pre-2.0.0 Daml.
 */
export function parseDepositRefs(value: unknown): string[] {
  if (value === null || value === undefined || value === "None") return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "object") {
    const some = (value as { Some?: unknown; value?: unknown }).Some ?? (value as { value?: unknown }).value;
    if (Array.isArray(some)) return some.map((v) => String(v));
  }
  return [];
}
