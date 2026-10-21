import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import {
  sameInstrument,
  type InstrumentId,
  type LedgerWallet,
  type PendingPayoutRecord,
} from "../types";
import { ApiError } from "../util/errors";
import { asTextList } from "../util/ledger-values";
import { formatAmount, tryParseAmount } from "../util/money";
import { asString } from "../util/strings";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";

/**
 * Read-only access to the Canton JSON Ledger API as the treasury party. Port of
 * pm-frontend/api/_lib/ledgerClient.mjs.
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
  /** Contract ids already reported by `treasurySigned`, so a planted contract alerts once, not every scan. */
  private readonly foreignSeen = new Set<string>();

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

  /**
   * The UserWallet Create command id for `owner` in `instrument` under the configured package name.
   * Deposits, in-app payouts and reward grants all take it from here, so a Create racing another
   * path collides on command dedup instead of minting a second wallet (docs/TOKENS.md §4.3).
   */
  walletCreateCommandId(owner: string, instrument: InstrumentId): string {
    const name = this.config.truthoraclePackageName;
    if (!name) throw new ApiError(502, "upstream_failed", "TRUTHORACLE_PACKAGE_NAME is not set");
    return walletCreateCommandIdFor(name, owner, instrument);
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

  /**
   * Active contracts of one template visible to `party` (raw rows; cached `ledgerCacheMs`).
   *
   * The request body is `{ activeAtOffset, eventFormat }` and nothing else. Canton 3.6 disables
   * the legacy top-level `filter` / `verbose` fields of `GetActiveContractsRequest`
   * (`DEPRECATED_API_DISABLED`, docs/TOKENS.md §1) and refuses a body that still carries them —
   * and this read sits behind every wallet and payout lookup, so one stray field turns every
   * deposit credit, in-app payout and reward grant into a 502. The `verbose` that counts is the
   * one inside `eventFormat`; ledger-client.service.spec.ts pins the body's keys.
   */
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
   * Active contracts of a template the treasury signs as `admin` (UserWallet, PendingPayout,
   * PredictionMarket). Review R3-01: the treasury's ACS also holds contracts it only observes, and
   * any party can create one naming the treasury as an audit observer — a PendingPayout { admin = P,
   * user = P } would otherwise be paid out of the treasury, and a UserWallet { admin = P, owner =
   * victim } would block the victim as a duplicate wallet. Only rows whose `admin` is the treasury,
   * which the treasury had to sign, count; the others are reported once each and never used.
   */
  private async treasurySigned(entity: string, opts: ReadOptions): Promise<ActiveContract[]> {
    const treasury = this.config.treasuryPartyId;
    const rows = await this.activeContracts(treasury, entity, opts);
    const foreign = rows.filter((r) => asString(r.payload.admin) !== treasury);
    for (const row of foreign) {
      if (this.foreignSeen.has(row.contractId)) continue;
      this.foreignSeen.add(row.contractId);
      this.logger.error(
        `${entity} ${row.contractId} names admin ${asString(row.payload.admin)}, not the treasury: ignored`,
      );
      this.sentry.captureMessage(
        "contract naming the treasury only as an observer ignored",
        "error",
        {
          entity,
          contractId: row.contractId,
          admin: asString(row.payload.admin),
        },
      );
    }
    return foreign.length === 0 ? rows : rows.filter((r) => asString(r.payload.admin) === treasury);
  }

  /**
   * `creditRefs` and `instrument` are mandatory on the deployed Daml (truthoracle-v17
   * `UserWallet.creditRefs : [Text]`, `UserWallet.instrument : InstrumentId`): the first is THE
   * confirmation rule of the deposit and grant confirm passes, the second decides which balance a
   * wallet is. A payload without either is not "an older wallet" — it is the wrong package (or a
   * changed JSON shape) and every read fails closed as an upstream error rather than pretending
   * the wallet carries no credits or is in some default instrument.
   */
  private walletFrom(row: ActiveContract): LedgerWallet {
    const p = row.payload;
    let creditRefs: string[];
    let instrument: InstrumentId;
    try {
      creditRefs = parseCreditRefs(p.creditRefs);
      instrument = parseInstrumentId(p.instrument);
    } catch (err) {
      this.logger.error(
        `UserWallet ${row.contractId} (owner ${asString(p.owner)}): ${(err as Error).message}; is TRUTHORACLE_PACKAGE_ID the deployed truthoracle-v17?`,
      );
      throw new ApiError(
        502,
        "upstream_failed",
        "ledger returned a UserWallet without creditRefs / instrument",
        { contractId: row.contractId },
      );
    }
    return {
      contractId: row.contractId,
      owner: asString(p.owner),
      instrument,
      balance: tryParseAmount(p.balance) ?? 0n,
      deposited: tryParseAmount(p.deposited) ?? 0n,
      withdrawn: tryParseAmount(p.withdrawn) ?? 0n,
      creditRefs,
      auditObservers: asTextList(p.auditObservers),
    };
  }

  /**
   * The owner's UserWallet in `instrument`, read as the treasury (signatory, so it sees every
   * wallet). Returns null when the user has never been credited in that instrument — the caller
   * creates one. A party legitimately holds one wallet per instrument (a cBYN wallet and a TRO
   * wallet), so the duplicate check is per (owner, instrument).
   *
   * UserWallet has no contract key, so two racing Creates could mint two wallets for one owner and
   * instrument. The backend keys every Create on one deterministic command id per (owner,
   * instrument) precisely so that cannot happen; should it happen anyway (a hand-run command,
   * another tool) the balance is split across contracts and every attribution invariant is void.
   * That is never silently resolved to "the first one": it is reported and refused as attribution
   * drift.
   */
  async fetchUserWallet(
    ownerParty: string,
    instrument: InstrumentId,
    opts: ReadOptions = {},
  ): Promise<LedgerWallet | null> {
    const all = await this.fetchAllUserWallets(opts);
    const mine = all.filter(
      (w) => w.owner === ownerParty && sameInstrument(w.instrument, instrument),
    );
    if (mine.length > 1) {
      const cids = mine.map((r) => r.contractId);
      this.logger.error(
        `${mine.length} active UserWallets for ${ownerParty} in ${instrument.id}: ${cids.join(", ")}`,
      );
      this.sentry.captureMessage(
        "duplicate UserWallet contracts for one owner and instrument",
        "error",
        {
          owner: ownerParty,
          instrument: instrument.id,
          count: String(mine.length),
        },
      );
      throw new ApiError(
        409,
        "deposit_attribution_drift",
        "more than one in-app wallet exists for this party and instrument; an operator has been notified",
        {
          kind: "duplicate_user_wallet",
          instrument,
          contractIds: cids,
        },
      );
    }
    return mine.length === 1 ? mine[0] : null;
  }

  /** Every active UserWallet the treasury signs, one row per contract with its instrument. */
  async fetchAllUserWallets(opts: ReadOptions = {}): Promise<LedgerWallet[]> {
    const rows = await this.treasurySigned("UserWallet", opts);
    return rows.map((r) => this.walletFrom(r));
  }

  /** The owner's wallets across every instrument (the in-app overview). */
  async fetchUserWallets(ownerParty: string, opts: ReadOptions = {}): Promise<LedgerWallet[]> {
    return (await this.fetchAllUserWallets(opts)).filter((w) => w.owner === ownerParty);
  }

  private payoutFrom(row: ActiveContract): PendingPayoutRecord {
    const p = row.payload;
    // Field names mirror truthoracle-contracts/daml/daml/Truthoracle.daml (PendingPayout) — the payee is `user`.
    const createdAtRaw = p.createdAt ?? p.created_at;
    const createdAt =
      typeof createdAtRaw === "string" && !Number.isNaN(Date.parse(createdAtRaw))
        ? new Date(createdAtRaw)
        : null;
    let instrument: InstrumentId;
    try {
      instrument = parseInstrumentId(p.instrument);
    } catch (err) {
      this.logger.error(
        `PendingPayout ${row.contractId}: ${(err as Error).message}; is TRUTHORACLE_PACKAGE_ID the deployed truthoracle-v17?`,
      );
      throw new ApiError(
        502,
        "upstream_failed",
        "ledger returned a PendingPayout without an instrument",
        { contractId: row.contractId },
      );
    }
    return {
      contractId: row.contractId,
      user: asString(p.user),
      marketId: asString(p.marketId),
      instrument,
      amount: tryParseAmount(p.amount) ?? 0n,
      reason: asString(p.reason),
      createdAt,
      auditObservers: asTextList(p.auditObservers),
    };
  }

  async fetchPendingPayouts(opts: ReadOptions = {}): Promise<PendingPayoutRecord[]> {
    const rows = await this.treasurySigned("PendingPayout", opts);
    return rows.map((r) => this.payoutFrom(r));
  }

  /** One PendingPayout by contract id, or null when it is already archived. */
  async fetchPendingPayout(
    cid: string,
    opts: ReadOptions = {},
  ): Promise<PendingPayoutRecord | null> {
    const rows = await this.treasurySigned("PendingPayout", opts);
    for (const row of rows) {
      if (row.contractId !== cid) continue;
      return this.payoutFrom(row);
    }
    return null;
  }

  /**
   * The contract ids of market `marketId`'s active PredictionMarket as the treasury (its
   * signatory) sees it at the ledger end — one, unless the market is gone. Review F0: a resolution
   * exercises what the ledger holds now, never the index's version a trade may have replaced.
   */
  async fetchMarketContracts(marketId: string, opts: ReadOptions = {}): Promise<string[]> {
    const rows = await this.treasurySigned("PredictionMarket", opts);
    return rows.filter((r) => asString(r.payload.marketId) === marketId).map((r) => r.contractId);
  }
}

/**
 * The one shape of a treasury-created UserWallet: empty (0 / 0 / 0, no refs) in exactly one
 * instrument, with the regulator parties as observers (docs/TOKENS.md §2 decision 4). The deposit
 * path, the in-app payout path and the rewards processor all create wallets through this with the
 * SAME deterministic command id (`LedgerClientService.walletCreateCommandId(owner, instrument)`), so
 * two racing Creates collide on ledger command-dedup instead of minting two wallets — UserWallet
 * has no contract key to stop that on-ledger. The credit itself is always an `Exercise Deposit
 * { amount, txRef }` (or `Grant { amount, ref, reason }`) on the wallet that exists, which is what
 * appends the ref to `creditRefs` (mandatory `[Text]` on truthoracle-v17).
 */
export function userWalletCreateCommand(input: {
  templateId: string;
  admin: string;
  owner: string;
  instrument: InstrumentId;
  auditObservers: string[];
}): unknown {
  const zero = formatAmount(0n);
  return {
    CreateCommand: {
      templateId: input.templateId,
      createArguments: {
        admin: input.admin,
        owner: input.owner,
        instrument: { admin: input.instrument.admin, id: input.instrument.id },
        balance: zero,
        deposited: zero,
        withdrawn: zero,
        creditRefs: [],
        auditObservers: [...input.auditObservers],
      },
    },
  };
}

/**
 * `wallet-create-<sha256("<packageName>|<owner>|<admin>|<id>")[:40]>`: one Create per owner,
 * instrument and package NAME, whoever submits it first (docs/TOKENS.md §4.3).
 *
 * The package name is part of the key because command dedup compares ids, never what a command
 * creates. With an owner-only key, the Create that a party's wallet had spent under an older
 * package (truthoracle-v14) was refused as a duplicate on the current one, and every deposit
 * credit for that party answered 502. The name, not the package id, is the scope: every version
 * under one name is an upgrade-compatible build of the same wallet family (the contracts CI
 * refuses anything else) and wallets are read by name, so racing Creates from instances on
 * different versions of one name still collide. A breaking change always gets a new name, and
 * with it fresh ids. The instrument is part of the key because a party holds one wallet PER
 * instrument: its cBYN wallet and its TRO wallet are two Creates that must not collide.
 */
export function walletCreateCommandIdFor(
  packageName: string,
  ownerParty: string,
  instrument: InstrumentId,
): string {
  if (!packageName || !ownerParty)
    throw new Error("walletCreateCommandIdFor needs both the package name and the owner party");
  if (!instrument?.admin || !instrument.id)
    throw new Error("walletCreateCommandIdFor needs the instrument's admin and id");
  return `wallet-create-${createHash("sha256")
    .update(`${packageName}|${ownerParty}|${instrument.admin}|${instrument.id}`)
    .digest("hex")
    .slice(0, 40)}`;
}

/**
 * Daml `[Text]` arrives as a JSON array on the JSON Ledger API v2. The field is mandatory on
 * truthoracle-v17, so anything else — missing, null, an Optional wrapper from another package
 * version — is a hard parse error: the caller must fail the read, never default to "no refs"
 * (which would let the confirm pass mistake a landed credit for one that never happened).
 */
export function parseCreditRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `UserWallet.creditRefs is ${value === undefined ? "missing" : `not a list (${JSON.stringify(value)})`}`,
    );
  }
  return value.map((v) => String(v));
}

/**
 * Daml `InstrumentId { admin : Party, id : Text }` as the JSON API serialises it (a record with
 * both fields; the same shape as `Splice.Api.Token.HoldingV1.InstrumentId`). Mandatory on every
 * v17 UserWallet / PendingPayout / PredictionMarket, so a missing or partial value is a hard parse
 * error — an amount without its instrument must never be read as being in some default one.
 */
export function parseInstrumentId(value: unknown): InstrumentId {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `instrument is ${value === undefined ? "missing" : `not a record (${JSON.stringify(value)})`}`,
    );
  }
  const v = value as { admin?: unknown; id?: unknown };
  const admin = typeof v.admin === "string" ? v.admin.trim() : "";
  const id = typeof v.id === "string" ? v.id.trim() : "";
  if (!admin || !id) throw new Error(`instrument needs admin and id (${JSON.stringify(value)})`);
  return { admin, id };
}
