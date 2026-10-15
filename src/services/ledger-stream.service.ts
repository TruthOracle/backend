import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import {
  isPrunedDataError,
  parseActiveContractsPage,
  parseUpdatesPage,
  type ActiveContractEntry,
  type LedgerTransaction,
} from "../indexer/events";
import {
  HOLDING_INTERFACE,
  interfaceFilterId,
  TRANSFER_INSTRUCTION_INTERFACE,
} from "../indexer/token-standard";
import { ApiError } from "../util/errors";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";

/**
 * The indexer's read path into the Canton JSON Ledger API v2 (docs/INDEXER.md §1): the ledger
 * end, the prune point, pages of the party's transaction stream and ACS snapshots — nothing
 * cached, nothing written. Reads as `config.indexerParty` (the treasury by default: signatory or
 * observer on every TruthOracle template, so its stream is the whole application). Same base
 * URL and Keycloak target as LedgerClientService (ZKPC_* only on mainnet).
 *
 * `/v2/updates` with `TRANSACTION_SHAPE_LEDGER_EFFECTS` is the one source: it carries the
 * exercised events (choice + argument) the projection derives trades from. The deprecated
 * `/v2/updates/trees` is gone from Canton 3.6, so there is no fallback to it.
 *
 * The event filter is cumulative (docs/TOKENS.md §4.2): the wildcard (every template the party
 * sees, with the created-event blob a user-signed trade must disclose) plus the token standard's
 * `HoldingV1.Holding` and `TransferInstructionV1.TransferInstruction` interfaces with their
 * views, so any CIP-56 token the treasury holds or is offered — cBYN, TRO, Canton Coin — is read
 * generically, whatever its templates are called.
 */
@Injectable()
export class LedgerStreamService {
  private readonly logger = new Logger(LedgerStreamService.name);
  private readonly filter = {
    cumulative: [
      { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: true } } } },
      ...[HOLDING_INTERFACE, TRANSFER_INSTRUCTION_INTERFACE].map((iface) => ({
        identifierFilter: {
          InterfaceFilter: {
            value: {
              interfaceId: interfaceFilterId(iface),
              includeInterfaceView: true,
              includeCreatedEventBlob: true,
            },
          },
        },
      })),
    ],
  };

  constructor(
    private readonly config: Config,
    private readonly keycloak: KeycloakTokenService,
  ) {}

  get baseUrl(): string {
    return this.config.isMainnet ? this.config.zkpc.ledgerApiUrl : this.config.ledgerApiUrl;
  }

  get party(): string {
    return this.config.indexerParty;
  }

  isConfigured(): boolean {
    return Boolean(
      this.baseUrl &&
      this.party &&
      this.config.truthoraclePackageName &&
      this.keycloak.isConfigured("ledger"),
    );
  }

  private async ledger<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const base = this.baseUrl;
    if (!base) throw new ApiError(502, "upstream_failed", "Ledger API URL is not configured");
    const token = await this.keycloak.bearerFor("ledger");
    return authedJson<T>(base, path, { ...options, token });
  }

  async ledgerEnd(): Promise<number> {
    const end = await this.ledger<{ offset?: unknown }>("/v2/state/ledger-end", { method: "GET" });
    const n = typeof end?.offset === "number" ? end.offset : Number(end?.offset ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }

  /** `participantPrunedUpToInclusive` — 0 when the participant never pruned. */
  async prunedOffset(): Promise<number> {
    try {
      const res = await this.ledger<{ participantPrunedUpToInclusive?: unknown }>(
        "/v2/state/latest-pruned-offsets",
        { method: "GET" },
      );
      const n = Number(res?.participantPrunedUpToInclusive ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
    } catch (err) {
      // A participant without the endpoint (or a transient failure) is treated as never pruned;
      // a pruned range then surfaces as PARTICIPANT_PRUNED_DATA_ACCESSED on the first read.
      this.logger.warn(`latest-pruned-offsets unavailable: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Transactions with `beginExclusive < offset ≤ endInclusive`, oldest first, at most `limit`
   * (the participant may cap lower). Throws an Error whose message carries
   * PARTICIPANT_PRUNED_DATA_ACCESSED when the range starts before the prune point.
   */
  async fetchUpdates(args: {
    beginExclusive: number;
    endInclusive: number;
    limit: number;
  }): Promise<LedgerTransaction[]> {
    if (args.endInclusive <= args.beginExclusive) return [];
    const limit = Math.max(1, Math.min(args.limit, 1000));
    try {
      const page = await this.ledger<unknown>(`/v2/updates?limit=${limit}`, {
        method: "POST",
        body: {
          beginExclusive: args.beginExclusive,
          endInclusive: args.endInclusive,
          updateFormat: {
            includeTransactions: {
              eventFormat: { filtersByParty: { [this.party]: this.filter }, verbose: false },
              transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
            },
          },
        },
        timeoutMs: 60_000,
      });
      return parseUpdatesPage(page);
    } catch (err) {
      throw this.asStreamError(err, "updates");
    }
  }

  /**
   * Every contract of the party active at `activeAtOffset` (a wildcard snapshot with the token
   * standard's interface views; the projection keeps the TruthOracle contracts, the treasury's
   * holdings and the instructions it is party to). A page that fills `INDEXER_ACS_LIMIT` is
   * refused: the JSON API has no ACS cursor, so a full page may be a truncated snapshot
   * (docs/INDEXER.md §4).
   */
  async fetchActiveContracts(activeAtOffset: number): Promise<ActiveContractEntry[]> {
    const limit = this.config.indexerAcsLimit;
    let page: unknown;
    try {
      page = await this.ledger<unknown>(`/v2/state/active-contracts?limit=${limit}`, {
        method: "POST",
        body: {
          activeAtOffset,
          eventFormat: { filtersByParty: { [this.party]: this.filter }, verbose: false },
        },
        timeoutMs: 120_000,
      });
    } catch (err) {
      throw this.asStreamError(err, "active-contracts");
    }
    const entries = parseActiveContractsPage(page);
    const total = Array.isArray(page) ? page.length : entries.length;
    if (total >= limit) {
      throw new Error(
        `ACS snapshot at offset ${activeAtOffset} filled INDEXER_ACS_LIMIT=${limit} and may be truncated; raise the limit (and the participant's http-list-max-elements-limit)`,
      );
    }
    return entries;
  }

  private asStreamError(err: unknown, what: string): Error {
    if (err instanceof UpstreamError) {
      if (isPrunedDataError(err) || err.bodyText.includes("PARTICIPANT_PRUNED_DATA_ACCESSED")) {
        return new Error(
          `PARTICIPANT_PRUNED_DATA_ACCESSED: ${what} range starts before the participant's prune point`,
        );
      }
      return new Error(
        `ledger ${what} failed (${err.status || "network"}): ${err.bodyText.slice(0, 300) || err.message}`,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
