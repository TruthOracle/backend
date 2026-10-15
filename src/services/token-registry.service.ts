import { Injectable, Logger } from "@nestjs/common";

import type { InstrumentEntity } from "../entities/instrument.entity";
import type {
  ApiDisclosedContract,
  RegistryChoiceContext,
  RegistryTransferFactory,
} from "../types";
import { ApiError } from "../util/errors";
import { asRecord, asText } from "../util/ledger-values";
import { authedJson, UpstreamError } from "../util/upstream-http";
import { KeycloakTokenService } from "./keycloak-token.service";

/** `GET /registry/metadata/v1/info` */
export interface RegistryInfo {
  adminId: string;
  supportedApis: Record<string, number>;
}

/** `GET /registry/metadata/v1/instruments/{id}` */
export interface RegistryInstrument {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  supportedApis: Record<string, number>;
  totalSupply: string | null;
}

/**
 * The CIP-56 off-ledger registry API of an instrument (docs/TOKENS.md §0, §4.4): the metadata
 * endpoints and, more importantly, the choice contexts a transfer needs — which `TransferFactory`
 * to exercise and the context / disclosed contracts the choice reads (the token's rules, config,
 * fee contracts). Per instrument: the URL and the auth mode come from `to_instruments`
 * (`registry_url`, `registry_auth`): `ledger` is the participant's own bearer (Canton Coin's
 * scan proxy sits behind the validator), `keycloak` the `REGISTRY_KEYCLOAK_*` client (Cantor8's
 * token registry), `none` sends no credentials.
 *
 * Nothing here signs or submits: the contexts are handed to `TreasuryTransferService` and the
 * acceptor processor, which build the commands and submit them through the Enterprise Wallet.
 */
@Injectable()
export class TokenRegistryService {
  private readonly logger = new Logger(TokenRegistryService.name);

  constructor(private readonly keycloak: KeycloakTokenService) {}

  /** Whether `instrument` can be talked to at all: a registry URL and, for the authenticated modes, the credentials. */
  isConfigured(instrument: InstrumentEntity): boolean {
    if (!instrument.registryUrl) return false;
    if (instrument.registryAuth === "none") return true;
    return this.keycloak.isConfigured(instrument.registryAuth === "ledger" ? "ledger" : "registry");
  }

  async info(instrument: InstrumentEntity): Promise<RegistryInfo> {
    const res = asRecord(await this.call(instrument, "/registry/metadata/v1/info"));
    return {
      adminId: asText(res.adminId),
      supportedApis: apisOf(res.supportedApis),
    };
  }

  async instrument(instrument: InstrumentEntity): Promise<RegistryInstrument> {
    const res = asRecord(
      await this.call(
        instrument,
        `/registry/metadata/v1/instruments/${encodeURIComponent(instrument.id)}`,
      ),
    );
    return {
      id: asText(res.id),
      name: asText(res.name),
      symbol: asText(res.symbol),
      decimals: typeof res.decimals === "number" ? res.decimals : Number(res.decimals ?? 0),
      supportedApis: apisOf(res.supportedApis),
      totalSupply: typeof res.totalSupply === "string" ? res.totalSupply : null,
    };
  }

  /**
   * `POST /registry/transfer-instruction/v1/transfer-factory`: which factory to exercise
   * `TransferFactory_Transfer` on for `choiceArguments` (the full choice argument with an empty
   * `extraArgs.context`), the kind of transfer it will be (`self`, `direct` or a two-step
   * `offer`), and the context plus disclosed contracts the choice needs. Debug fields are
   * excluded: payloads and blobs of the token's rules are of no use to the backend.
   */
  async transferFactory(
    instrument: InstrumentEntity,
    choiceArguments: Record<string, unknown>,
  ): Promise<RegistryTransferFactory> {
    const res = asRecord(
      await this.call(instrument, "/registry/transfer-instruction/v1/transfer-factory", {
        method: "POST",
        body: { choiceArguments, excludeDebugFields: true },
      }),
    );
    const factoryId = asText(res.factoryId);
    if (!factoryId)
      throw new ApiError(
        502,
        "upstream_failed",
        `registry of ${instrument.symbol} answered the transfer-factory lookup without a factoryId`,
      );
    return {
      factoryId,
      transferKind: asText(res.transferKind),
      choiceContext: parseChoiceContext(res.choiceContext, instrument.symbol),
    };
  }

  /** `POST /registry/transfer-instruction/v1/{cid}/choice-contexts/accept` — what `TransferInstruction_Accept` needs. */
  acceptContext(
    instrument: InstrumentEntity,
    instructionCid: string,
  ): Promise<RegistryChoiceContext> {
    return this.choiceContext(instrument, instructionCid, "accept");
  }

  rejectContext(
    instrument: InstrumentEntity,
    instructionCid: string,
  ): Promise<RegistryChoiceContext> {
    return this.choiceContext(instrument, instructionCid, "reject");
  }

  withdrawContext(
    instrument: InstrumentEntity,
    instructionCid: string,
  ): Promise<RegistryChoiceContext> {
    return this.choiceContext(instrument, instructionCid, "withdraw");
  }

  private async choiceContext(
    instrument: InstrumentEntity,
    instructionCid: string,
    action: "accept" | "reject" | "withdraw",
  ): Promise<RegistryChoiceContext> {
    const res = await this.call(
      instrument,
      `/registry/transfer-instruction/v1/${encodeURIComponent(instructionCid)}/choice-contexts/${action}`,
      { method: "POST", body: { excludeDebugFields: true } },
    );
    return parseChoiceContext(res, instrument.symbol);
  }

  private async call(
    instrument: InstrumentEntity,
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<unknown> {
    const base = instrument.registryUrl?.replace(/\/$/, "");
    if (!base)
      throw new ApiError(
        503,
        "not_ready",
        `instrument ${instrument.symbol} has no registry URL configured (PATCH /admin/instruments)`,
      );
    let token: string | undefined;
    if (instrument.registryAuth === "ledger") token = await this.keycloak.bearerFor("ledger");
    else if (instrument.registryAuth === "keycloak")
      token = await this.keycloak.bearerFor("registry");
    try {
      return await authedJson<unknown>(base, path, { ...options, token, timeoutMs: 30_000 });
    } catch (err) {
      if (err instanceof UpstreamError) {
        this.logger.warn(
          `registry ${instrument.symbol} ${options.method ?? "GET"} ${path} → ${err.status || "network"}`,
        );
        throw new ApiError(
          502,
          "upstream_failed",
          `registry of ${instrument.symbol} failed (${err.status || "network"})`,
          err.status ? { upstreamStatus: err.status } : undefined,
        );
      }
      throw err;
    }
  }
}

function apisOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(value))) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

/**
 * The registry's `ChoiceContext`: `choiceContextData` is passed verbatim as `extraArgs.context`
 * of the choice (it is already in the ledger's JSON encoding), the disclosed contracts are
 * reduced to the four fields the JSON Ledger API's `DisclosedContract` takes.
 */
export function parseChoiceContext(value: unknown, symbol: string): RegistryChoiceContext {
  const r = asRecord(value);
  const data = r.choiceContextData;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ApiError(
      502,
      "upstream_failed",
      `registry of ${symbol} answered a choice context without choiceContextData`,
    );
  const disclosed: ApiDisclosedContract[] = [];
  for (const item of Array.isArray(r.disclosedContracts) ? r.disclosedContracts : []) {
    const d = asRecord(item);
    const templateId = asText(d.templateId);
    const contractId = asText(d.contractId);
    const createdEventBlob = asText(d.createdEventBlob);
    if (!templateId || !contractId || !createdEventBlob)
      throw new ApiError(
        502,
        "upstream_failed",
        `registry of ${symbol} returned an incomplete disclosed contract`,
      );
    disclosed.push({
      templateId,
      contractId,
      createdEventBlob,
      synchronizerId:
        typeof d.synchronizerId === "string" && d.synchronizerId ? d.synchronizerId : null,
    });
  }
  return { choiceContextData: data as Record<string, unknown>, disclosedContracts: disclosed };
}
