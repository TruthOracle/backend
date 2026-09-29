import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import { CatalogEventEntity } from "../entities/catalog-event.entity";
import { INDEXER_STATE_KEY, IndexerStateEntity } from "../entities/indexer-state.entity";
import { MarketEntity } from "../entities/market.entity";
import { SeriesEntity } from "../entities/series.entity";
import { NatsSubjects, type Actor, type ApiCreateMarketResult } from "../types";
import { ApiError } from "../util/errors";
import { formatCC } from "../util/money";
import { AuditService } from "./audit.service";
import { normalizeTicker } from "./catalog.service";
import { EnterpriseWalletService } from "./enterprise-wallet.service";
import { LedgerClientService } from "./ledger-client.service";
import { NatsService } from "./nats.service";

export interface CreateMarketInput {
  eventTicker: string;
  ticker: string;
  question: string;
  yesSubTitle?: string;
  noSubTitle?: string;
  imageUrl?: string;
  description?: string;
  resolutionDescription?: string;
  category?: string;
  /** ISO-8601. */
  expiresAt: string;
  gracePeriodSecs?: number;
  isDynamic?: boolean;
  liquidityPeriodSecs?: number;
  /** 10-dp decimal strings, like every amount on the wire. */
  initialProbability: string;
  initialValueCC: string;
  feeBps?: number;
  prizeFeeShareBps?: number;
  policy?: {
    operatorResolution?: boolean;
    sources?: string[];
    sourceKeys?: { sourceUri: string; publicKey: string }[];
    reporters?: string[];
    quorum?: number;
    challengeSecs?: number;
    bondCC?: string;
  };
  auditObservers?: string[];
}

/** `create-market-<sha256(ticker)[:40]>`: one CreateMarket per ticker, whoever submits it first. */
export function createMarketCommandIdFor(ticker: string): string {
  return `create-market-${createHash("sha256").update(ticker).digest("hex").slice(0, 40)}`;
}

/**
 * The operator's market factory (docs/MARKETS.md §4): `POST /admin/markets` builds the
 * `MarketCounter.CreateMarket` exercise for an event of the catalog and submits it treasury-signed
 * through the Enterprise Wallet — the same rail the frontend's admin console used from the
 * browser, now with the ticker / event / sub-title fields truthoracle-v14 ≥ 1.1.0 carries and a
 * deterministic command id so a retried request collides on ledger command-dedup instead of
 * creating a second market. The market appears in the read API once the indexer sees it.
 */
@Injectable()
export class MarketOperatorService {
  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly wallet: EnterpriseWalletService,
    private readonly ledger: LedgerClientService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  async createMarket(input: CreateMarketInput, actor: Actor, reason?: string): Promise<ApiCreateMarketResult> {
    const ticker = normalizeTicker(input.ticker);
    const eventTicker = input.eventTicker.trim().toUpperCase();
    const event = await this.dataSource.getRepository(CatalogEventEntity).findOneBy({ ticker: eventTicker });
    if (!event) throw new ApiError(404, "not_found", `event ${eventTicker} does not exist`);
    if (event.archived) throw new ApiError(409, "catalog_conflict", `event ${eventTicker} is archived`);
    const series = await this.dataSource.getRepository(SeriesEntity).findOneBy({ ticker: event.seriesTicker });
    const taken = await this.dataSource.getRepository(MarketEntity).findOneBy({ ticker });
    if (taken) throw new ApiError(409, "catalog_conflict", `ticker ${ticker} is used by market ${taken.marketId}`);

    const state = await this.dataSource.getRepository(IndexerStateEntity).findOneBy({ key: INDEXER_STATE_KEY });
    if (!state?.marketCounterCid)
      throw new ApiError(503, "not_ready", "the MarketCounter is not indexed yet — the indexer must see it first");

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAtSec = Math.floor(Date.parse(input.expiresAt) / 1000);
    if (!Number.isFinite(expiresAtSec)) throw new ApiError(400, "validation_failed", "expiresAt is not a date");
    const liquidityPeriodSecs = input.liquidityPeriodSecs ?? 0;
    if (expiresAtSec <= nowSec + liquidityPeriodSecs)
      throw new ApiError(400, "validation_failed", "expiresAt must be after the liquidity period");
    const p0 = Number(input.initialProbability);
    if (!(p0 >= 0.01 && p0 <= 0.99))
      throw new ApiError(400, "validation_failed", "initialProbability must be within [0.01, 0.99]");
    if (!(Number(input.initialValueCC) > 0))
      throw new ApiError(400, "validation_failed", "initialValueCC must be positive");
    const feeBps = input.feeBps ?? 30;
    const prizeFeeShareBps = input.prizeFeeShareBps ?? 0;
    if (feeBps < 0 || feeBps > 1000) throw new ApiError(400, "validation_failed", "feeBps must be 0..1000");
    if (prizeFeeShareBps < 0 || prizeFeeShareBps > 10_000)
      throw new ApiError(400, "validation_failed", "prizeFeeShareBps must be 0..10000");
    const policy = input.policy ?? {};
    const reporters = policy.reporters ?? [];
    const quorum = policy.quorum ?? 0;
    if (quorum > reporters.length)
      throw new ApiError(400, "validation_failed", "policy.quorum cannot exceed the reporter count");

    const choiceArgument = {
      question: input.question.trim(),
      imageUrl: input.imageUrl ?? event.imageUrl ?? "",
      description: input.description ?? "",
      resolutionDescription: input.resolutionDescription ?? "",
      category: (input.category ?? series?.category ?? "").trim(),
      createdAt: String(nowSec),
      expiresAt: String(expiresAtSec),
      gracePeriodSecs: String(input.gracePeriodSecs ?? 86_400),
      isDynamic: input.isDynamic ?? false,
      liquidityPeriodSecs: String(liquidityPeriodSecs),
      initialProbability: formatDecimalString(input.initialProbability),
      initialValueCC: formatDecimalString(input.initialValueCC),
      feeBps: String(feeBps),
      prizeFeeShareBps: String(prizeFeeShareBps),
      policy: {
        operatorResolution: policy.operatorResolution ?? true,
        sources: policy.sources ?? [],
        sourceKeys: policy.sourceKeys ?? [],
        reporters,
        quorum: String(quorum),
        challengeSecs: String(policy.challengeSecs ?? 0),
        bondCC: formatDecimalString(policy.bondCC ?? "0"),
      },
      auditObservers: input.auditObservers ?? [],
      // truthoracle-v14 ≥ 1.1.0 (Optional Text, appended): the market's catalog identity
      ticker,
      eventTicker,
      yesSubTitle: input.yesSubTitle ?? null,
      noSubTitle: input.noSubTitle ?? null,
    };
    const commandId = createMarketCommandIdFor(ticker);
    const res = await this.wallet.externalSubmit({
      commandId,
      commands: [
        {
          ExerciseCommand: {
            templateId: this.ledger.templateId("MarketCounter"),
            contractId: state.marketCounterCid,
            choice: "CreateMarket",
            choiceArgument,
          },
        },
      ],
    });
    const expectedMarketId = state.marketCounterValue === null ? null : state.marketCounterValue + 1;
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "market.create_submitted",
      subjectType: "market",
      subjectId: ticker,
      metadata: { reason, eventTicker, commandId, expectedMarketId, status: res.status },
      ip: actor.ip ?? null,
    });
    await this.nats.publishSafe(
      NatsSubjects.marketCreateSubmitted,
      { commandId, ticker, eventTicker },
      { msgId: commandId },
    );
    return { commandId, status: res.status, ticker, eventTicker, expectedMarketId };
  }
}

/** A client decimal → the 10-dp string Daml wants (rejects non-decimals). */
function formatDecimalString(raw: string): string {
  try {
    return formatCC(parseDecimal(raw));
  } catch {
    throw new ApiError(400, "validation_failed", `"${raw}" is not a decimal`);
  }
}

function parseDecimal(raw: string): bigint {
  // Same parser as util/money — kept local to avoid a cyclic import through the barrel.
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(raw.trim());
  if (!m || (m[2] === "" && !m[3])) throw new Error("not a decimal");
  const whole = BigInt(m[2] || "0") * 10_000_000_000n;
  const frac = BigInt(((m[3] ?? "") + "0000000000").slice(0, 10));
  const units = whole + frac;
  return m[1] === "-" ? -units : units;
}
