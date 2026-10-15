import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type {
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
import { formatAmountWithDecimals } from "../util/money";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";

/**
 * `POST /api/admin/mint|burn` body (token-app OpenAPI `AdminMintRequest` / `AdminBurnRequest`):
 * snake_case keys, the amount as a decimal string in the instrument's own decimals — token-app
 * validates it against `^[+-]?0*\d*\.?\d*$` and the token's precision, so a 10-dp string for a
 * 6-dp token would be refused. Pure, so the shaping is unit-tested.
 */
export function tokenAppCommandBody(
  req: TokenAppMintRequest,
  appName: string,
): Record<string, string> {
  return {
    command_id: req.commandId,
    instrument_id: req.instrumentId,
    party_id: req.partyId,
    amount: formatAmountWithDecimals(req.amount, req.decimals),
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
      amount: formatAmountWithDecimals(e.amount, req.decimals),
    })),
    app_name: appName,
  };
}

/**
 * Cantor8's token-app, the service that holds a token's issuer key and submits its mints and
 * burns (docs/TOKENS.md §0, §2 decision 7, §4.4). The backend never touches a Daml mint factory
 * itself: the DevNet faucet, the rewards float top-up and the operator's mint / burn all go
 * through here. `TOKEN_APP_URL` blank = unconfigured, and every caller answers
 * `503 token_app_unconfigured`; the bearer is the `TOKEN_APP_KEYCLOAK_*` client (falling back to
 * `KEYCLOAK_*`). Command ids are the caller's idempotency keys (token-app records them on the
 * confirmed mint / burn rows).
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

  /** `POST /api/admin/mint` — mint `amount` of `instrumentId` to `partyId` (cBYN: the recipient needs a MintDelegation; the treasury has one). */
  async mint(req: TokenAppMintRequest): Promise<TokenAppCommandResult> {
    return this.command(
      "/api/admin/mint",
      tokenAppCommandBody(req, this.config.tokenApp.appName),
      req.commandId,
    );
  }

  /** `POST /api/admin/burn` — burn `amount` of `instrumentId` held by `partyId`. */
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

  /** `GET /data/admin/holdings?party_id=&instrument_id=` — the monitor's last holdings scan. */
  async holdings(
    filter: { partyId?: string; instrumentId?: string } = {},
  ): Promise<TokenAppHolding[]> {
    const res = asRecord(await this.call(`/data/admin/holdings${query(filter)}`));
    const items = Array.isArray(res.holdings) ? res.holdings : [];
    return items.map((item) => {
      const h = asRecord(item);
      return {
        contractId: asText(h.holding_cid),
        partyId: asText(h.party_id),
        instrumentId: asText(h.instrument_id),
        amount: decimalText(h.amount),
        locked: h.locked === true,
      };
    });
  }

  mints(filter: { partyId?: string; instrumentId?: string } = {}): Promise<TokenAppRecord[]> {
    return this.records("/data/admin/mints", filter);
  }

  burns(filter: { partyId?: string; instrumentId?: string } = {}): Promise<TokenAppRecord[]> {
    return this.records("/data/admin/burns", filter);
  }

  private async records(
    path: string,
    filter: { partyId?: string; instrumentId?: string },
  ): Promise<TokenAppRecord[]> {
    const res = await this.call(`${path}${query(filter)}`);
    const items = Array.isArray(res) ? res : [];
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
    const token = await this.keycloak.bearerFor("tokenApp");
    try {
      return await authedJson<unknown>(this.config.tokenApp.url, path, {
        ...options,
        token,
        timeoutMs: 60_000,
      });
    } catch (err) {
      if (err instanceof UpstreamError) {
        this.logger.warn(
          `token-app ${options.method ?? "GET"} ${path} → ${err.status || "network"}`,
        );
        throw new ApiError(
          502,
          "upstream_failed",
          `token-app failed (${err.status || "network"})`,
          err.status ? { upstreamStatus: err.status } : undefined,
        );
      }
      throw err;
    }
  }
}

/** token-app serves amounts as a decimal string or a JSON number; anything else is unreadable and left blank. */
function decimalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function query(filter: { partyId?: string; instrumentId?: string }): string {
  const q = new URLSearchParams();
  if (filter.partyId) q.set("party_id", filter.partyId);
  if (filter.instrumentId) q.set("instrument_id", filter.instrumentId);
  const s = q.toString();
  return s ? `?${s}` : "";
}
