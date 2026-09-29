import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type { LedgerWallet, PendingPayoutRecord } from "../types";
import { ApiError } from "../util/errors";
import { formatCC, tryParseCC } from "../util/money";
import { asString } from "../util/strings";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";

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
    private readonly sentry: SentryService,
  ) {}

  get baseUrl(): string {
    return this.config.isMainnet ? this.config.zkpc.ledgerApiUrl : this.config.ledgerApiUrl;
  }

  isConfigured(): boolean {
    return Boolean(
      this.baseUrl && this.config.treasuryPartyId && this.config.truthoraclePackageName,
    );
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

  private async ledger<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    const base = this.baseUrl;
    if (!base) throw new ApiError(502, "upstream_failed", "Ledger API URL is not configured");
    const token = await this.keycloak.bearerFor("ledger");
    try {
      return await authedJson<T>(base, path, { ...options, token });
    } catch (err) {
      if (err instanceof UpstreamError) {
        this.logger.warn(`ledger ${options.method ?? "GET"} ${path} → ${err.status || "network"}`);
        throw new ApiError(
          502,
          "upstream_failed",
          `ledger read failed (${err.status || "network"})`,
        );
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
                      value: {
                        templateId: this.filterTemplateId(entity, module),
                        includeCreatedEventBlob: false,
                      },
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
        ? (r as { activeContracts: unknown[] }).activeContracts
        : Array.isArray((r as { contracts?: unknown }).contracts)
          ? (r as { contracts: unknown[] }).contracts
          : [];
    const out: ActiveContract[] = [];
    for (const item of items) {
      const event = (
        item as {
          contractEntry?: {
            JsActiveContract?: {
              createdEvent?: { contractId?: unknown; createArgument?: unknown };
            };
          };
        }
      )?.contractEntry?.JsActiveContract?.createdEvent;
      if (!event?.contractId) continue;
      out.push({
        contractId: asString(event.contractId),
        payload: (event.createArgument && typeof event.createArgument === "object"
          ? event.createArgument
          : {}) as Record<string, unknown>,
      });
    }
    if (this.config.ledgerCacheMs > 0) {
      await this.redis.setJson(cacheKey, out, this.config.ledgerCacheMs).catch(() => undefined);
    }
    return out;
  }

  /**
   * `depositRefs` is mandatory on the deployed Daml (truthoracle-v16 `UserWallet.depositRefs :
   * [Text]`) and is THE confirmation rule of the deposit confirm pass, so a payload without it is
   * not "an older wallet" — it is the wrong package (or a changed JSON shape) and every read fails
   * closed as an upstream error rather than pretending the wallet carries no credits.
   */
  private walletFrom(row: ActiveContract): LedgerWallet {
    const p = row.payload;
    let depositRefs: string[];
    try {
      depositRefs = parseDepositRefs(p.depositRefs);
    } catch (err) {
      this.logger.error(
        `UserWallet ${row.contractId} (owner ${asString(p.owner)}): ${(err as Error).message}; is TRUTHORACLE_PACKAGE_ID the deployed truthoracle-v16?`,
      );
      throw new ApiError(
        502,
        "upstream_failed",
        "ledger returned a UserWallet without depositRefs",
        { contractId: row.contractId },
      );
    }
    return {
      contractId: row.contractId,
      owner: asString(p.owner),
      balanceCC: tryParseCC(p.balanceCC) ?? 0n,
      depositedCC: tryParseCC(p.depositedCC) ?? 0n,
      withdrawnCC: tryParseCC(p.withdrawnCC) ?? 0n,
      depositRefs,
    };
  }

  /**
   * The owner's UserWallet, read as the treasury (signatory, so it sees every wallet). Returns
   * null when the user has never deposited — the caller creates one.
   *
   * UserWallet has no contract key, so two racing Creates could mint two wallets for one owner.
   * The backend keys every Create on one deterministic command id per owner precisely so that
   * cannot happen; should it happen anyway (a hand-run command, another tool) the balance is
   * split across contracts and every attribution invariant is void. That is never silently
   * resolved to "the first one": it is reported and refused as attribution drift.
   */
  async fetchUserWallet(ownerParty: string, opts: ReadOptions = {}): Promise<LedgerWallet | null> {
    const rows = await this.activeContracts(this.config.treasuryPartyId, "UserWallet", opts);
    const mine = rows.filter((row) => asString(row.payload.owner) === ownerParty);
    if (mine.length > 1) {
      const cids = mine.map((r) => r.contractId);
      this.logger.error(`${mine.length} active UserWallets for ${ownerParty}: ${cids.join(", ")}`);
      this.sentry.captureMessage("duplicate UserWallet contracts for one owner", "error", {
        owner: ownerParty,
        count: String(mine.length),
      });
      throw new ApiError(
        409,
        "deposit_attribution_drift",
        "more than one in-app wallet exists for this party; an operator has been notified",
        {
          kind: "duplicate_user_wallet",
          contractIds: cids,
        },
      );
    }
    return mine.length === 1 ? this.walletFrom(mine[0]) : null;
  }

  async fetchAllUserWallets(opts: ReadOptions = {}): Promise<LedgerWallet[]> {
    const rows = await this.activeContracts(this.config.treasuryPartyId, "UserWallet", opts);
    return rows.map((r) => this.walletFrom(r));
  }

  private payoutFrom(row: ActiveContract): PendingPayoutRecord {
    const p = row.payload;
    // Field names mirror truthoracle-contracts/daml/daml/Truthoracle.daml (PendingPayout) — the payee is `user`.
    const createdAtRaw = p.createdAt ?? p.created_at;
    const createdAt =
      typeof createdAtRaw === "string" && !Number.isNaN(Date.parse(createdAtRaw))
        ? new Date(createdAtRaw)
        : null;
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
  async fetchPendingPayout(
    cid: string,
    opts: ReadOptions = {},
  ): Promise<PendingPayoutRecord | null> {
    const rows = await this.activeContracts(this.config.treasuryPartyId, "PendingPayout", opts);
    for (const row of rows) {
      if (row.contractId !== cid) continue;
      return this.payoutFrom(row);
    }
    return null;
  }
}

/**
 * The one shape of a treasury-created UserWallet: empty (0 / 0 / 0, no refs). Both the deposit
 * path and the in-app payout path create wallets through this with the SAME deterministic command
 * id (`walletCreateCommandIdFor(owner)`), so two racing Creates collide on ledger command-dedup
 * instead of minting two wallets — UserWallet has no contract key to stop that on-ledger. The
 * credit itself is always an `Exercise Deposit { amountCC, txRef }` on the wallet that exists,
 * which is what appends `txRef` to `depositRefs` (mandatory `[Text]` on truthoracle-v16).
 */
export function userWalletCreateCommand(input: {
  templateId: string;
  admin: string;
  owner: string;
}): unknown {
  const zero = formatCC(0n);
  return {
    CreateCommand: {
      templateId: input.templateId,
      createArguments: {
        admin: input.admin,
        owner: input.owner,
        balanceCC: zero,
        depositedCC: zero,
        withdrawnCC: zero,
        depositRefs: [],
      },
    },
  };
}

/** `wallet-create-<sha256(owner)[:40]>` — one Create per owner, whoever submits it first. */
export function walletCreateCommandIdFor(ownerParty: string): string {
  return `wallet-create-${createHash("sha256").update(ownerParty).digest("hex").slice(0, 40)}`;
}

/**
 * Daml `[Text]` arrives as a JSON array on the JSON Ledger API v2. The field is mandatory on
 * truthoracle-v16, so anything else — missing, null, an Optional wrapper from another package
 * version — is a hard parse error: the caller must fail the read, never default to "no refs"
 * (which would let the confirm pass mistake a landed credit for one that never happened).
 */
export function parseDepositRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `UserWallet.depositRefs is ${value === undefined ? "missing" : `not a list (${JSON.stringify(value)})`}`,
    );
  }
  return value.map((v) => String(v));
}
