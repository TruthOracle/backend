import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import { CatalogEventEntity } from "../entities/catalog-event.entity";
import { INDEXER_STATE_KEY, IndexerStateEntity } from "../entities/indexer-state.entity";
import { MarketMetadataEntity } from "../entities/market-metadata.entity";
import { MarketEntity } from "../entities/market.entity";
import { NatsSubjects, type Actor, type ApiCreateMarketResult, type InstrumentId } from "../types";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";
import { AuditService } from "./audit.service";
import { normalizeTicker } from "./catalog.service";
import { EnterpriseWalletService } from "./enterprise-wallet.service";
import { InstrumentsService } from "./instruments.service";
import { LedgerClientService } from "./ledger-client.service";
import { NatsService } from "./nats.service";

export interface CreateMarketInput {
  /** The instrument the market is denominated in; omitted = the default collateral (docs/TOKENS.md §4.5). */
  collateral?: InstrumentId;
  eventTicker: string;
  ticker: string;
  question: string;
  yesSubTitle?: string;
  noSubTitle?: string;
  /** Presentation — backend-owned (`to_market_metadata`), never sent to the ledger (docs/MARKETS.md §1). */
  imageUrl?: string;
  description?: string;
  resolutionDescription?: string;
  /** ISO-8601. */
  expiresAt: string;
  gracePeriodSecs?: number;
  isDynamic?: boolean;
  liquidityPeriodSecs?: number;
  /** 10-dp decimal strings, like every amount on the wire; `initialValue` is in the collateral. */
  initialProbability: string;
  initialValue: string;
  feeBps?: number;
  prizeFeeShareBps?: number;
  policy?: {
    operatorResolution?: boolean;
    sources?: string[];
    sourceKeys?: { sourceUri: string; publicKey: string }[];
    reporters?: string[];
    quorum?: number;
    challengeSecs?: number;
    bond?: string;
  };
  auditObservers?: string[];
}

/** `create-market-<sha256(ticker)[:40]>`: one CreateMarket per ticker, whoever submits it first. */
export function createMarketCommandIdFor(ticker: string): string {
  return `create-market-${createHash("sha256").update(ticker).digest("hex").slice(0, 40)}`;
}

/** A side label: trimmed, defaulting to the plain side name — the contract refuses an empty one. */
export function sideLabel(raw: string | undefined, fallback: "Yes" | "No"): string {
  const label = (raw ?? "").trim();
  if (label.length > 80)
    throw new ApiError(
      400,
      "validation_failed",
      "yesSubTitle / noSubTitle are at most 80 characters",
    );
  return label || fallback;
}

/**
 * The operator's market factory (docs/MARKETS.md §4): `POST /admin/markets` builds the
 * `MarketCounter.CreateMarket` exercise for an event of the catalog and submits it treasury-signed
 * through the Enterprise Wallet — the same rail the frontend's admin console used from the
 * browser, with the identity the contract requires (ticker, event, the two side labels) and a
 * deterministic command id so a retried request collides on ledger command-dedup instead of
 * creating a second market. The market appears in the read API once the indexer sees it. The
 * `CreateMarket` argument carries the collateral (an enabled `collateral` instrument, equal to the
 * event's once the event has one) and the regulator parties as `auditObservers` (docs/TOKENS.md §4.5).
 */
@Injectable()
export class MarketOperatorService {
  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly wallet: EnterpriseWalletService,
    private readonly ledger: LedgerClientService,
    private readonly instruments: InstrumentsService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  async createMarket(
    input: CreateMarketInput,
    actor: Actor,
    reason?: string,
  ): Promise<ApiCreateMarketResult> {
    const ticker = normalizeTicker(input.ticker);
    const eventTicker = normalizeTicker(input.eventTicker);
    const yesSubTitle = sideLabel(input.yesSubTitle, "Yes");
    const noSubTitle = sideLabel(input.noSubTitle, "No");
    const collateral = await this.instruments.requireCollateral(input.collateral);
    const event = await this.dataSource
      .getRepository(CatalogEventEntity)
      .findOneBy({ ticker: eventTicker });
    if (!event) throw new ApiError(404, "not_found", `event ${eventTicker} does not exist`);
    if (event.archived)
      throw new ApiError(409, "catalog_conflict", `event ${eventTicker} is archived`);
    // One collateral per event (docs/TOKENS.md §2 decision 9): aggregates over its markets are sums
    // in one instrument, so a second market in another instrument is refused, not mixed in.
    if (
      event.collateralAdmin &&
      event.collateralId &&
      (event.collateralAdmin !== collateral.admin || event.collateralId !== collateral.id)
    ) {
      throw new ApiError(
        409,
        "catalog_conflict",
        `event ${eventTicker} is denominated in ${this.instruments.refFor(event.collateralAdmin, event.collateralId).symbol}; its markets must share that collateral`,
        {
          eventCollateral: { admin: event.collateralAdmin, id: event.collateralId },
          requested: { admin: collateral.admin, id: collateral.id },
        },
      );
    }
    const taken = await this.dataSource.getRepository(MarketEntity).findOneBy({ ticker });
    if (taken)
      throw new ApiError(
        409,
        "catalog_conflict",
        `ticker ${ticker} is used by market ${taken.marketId}`,
      );

    const state = await this.dataSource
      .getRepository(IndexerStateEntity)
      .findOneBy({ key: INDEXER_STATE_KEY });
    if (!state?.marketCounterCid)
      throw new ApiError(
        503,
        "not_ready",
        "the MarketCounter is not indexed yet — the indexer must see it first",
      );

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAtSec = Math.floor(Date.parse(input.expiresAt) / 1000);
    if (!Number.isFinite(expiresAtSec))
      throw new ApiError(400, "validation_failed", "expiresAt is not a date");
    const liquidityPeriodSecs = input.liquidityPeriodSecs ?? 0;
    if (expiresAtSec <= nowSec + liquidityPeriodSecs)
      throw new ApiError(400, "validation_failed", "expiresAt must be after the liquidity period");
    const p0 = Number(input.initialProbability);
    if (!(p0 >= 0.01 && p0 <= 0.99))
      throw new ApiError(
        400,
        "validation_failed",
        "initialProbability must be within [0.01, 0.99]",
      );
    if (!(Number(input.initialValue) > 0))
      throw new ApiError(400, "validation_failed", "initialValue must be positive");
    // Regulator visibility is not optional: an operator may widen the observer list, never drop
    // the configured parties (docs/TOKENS.md §2 decision 4).
    const auditObservers = [
      ...new Set([...this.config.auditObserverParties, ...(input.auditObservers ?? [])]),
    ];
    const feeBps = input.feeBps ?? 30;
    const prizeFeeShareBps = input.prizeFeeShareBps ?? 0;
    if (feeBps < 0 || feeBps > 1000)
      throw new ApiError(400, "validation_failed", "feeBps must be 0..1000");
    if (prizeFeeShareBps < 0 || prizeFeeShareBps > 10_000)
      throw new ApiError(400, "validation_failed", "prizeFeeShareBps must be 0..10000");
    const policy = input.policy ?? {};
    const reporters = policy.reporters ?? [];
    const quorum = policy.quorum ?? 0;
    if (quorum > reporters.length)
      throw new ApiError(
        400,
        "validation_failed",
        "policy.quorum cannot exceed the reporter count",
      );

    // Presentation never reaches the ledger (v17 carries none): it is written to the backend's own
    // table before the submit, keyed by ticker, so it is there the moment the indexer sees the
    // market. If the submit fails the row stays behind — harmless, the next attempt for the same
    // ticker overwrites it, and a ticker that is never minted shows nothing.
    const imageUrl = input.imageUrl?.trim();
    const description = input.description?.trim();
    if (imageUrl !== undefined || description !== undefined)
      await this.dataSource
        .createQueryBuilder()
        .insert()
        .into(MarketMetadataEntity)
        .values({
          ticker,
          imageUrl: imageUrl ?? "",
          description: description ?? "",
          updatedByUserId: actor.userId ?? null,
        })
        .orUpdate(["image_url", "description", "updated_by_user_id", "updated_at"], ["ticker"])
        .execute();

    const choiceArgument = {
      collateral: { admin: collateral.admin, id: collateral.id },
      question: input.question.trim(),
      resolutionDescription: input.resolutionDescription ?? "",
      createdAt: String(nowSec),
      expiresAt: String(expiresAtSec),
      gracePeriodSecs: String(input.gracePeriodSecs ?? 86_400),
      isDynamic: input.isDynamic ?? false,
      liquidityPeriodSecs: String(liquidityPeriodSecs),
      initialProbability: formatDecimalString(input.initialProbability),
      initialValue: formatDecimalString(input.initialValue),
      feeBps: String(feeBps),
      prizeFeeShareBps: String(prizeFeeShareBps),
      policy: {
        operatorResolution: policy.operatorResolution ?? true,
        sources: policy.sources ?? [],
        sourceKeys: policy.sourceKeys ?? [],
        reporters,
        quorum: String(quorum),
        challengeSecs: String(policy.challengeSecs ?? 0),
        bond: formatDecimalString(policy.bond ?? "0"),
      },
      auditObservers,
      // the market's identity — mandatory Text on PredictionMarket / CreateMarket (docs/MARKETS.md §2)
      ticker,
      eventTicker,
      yesSubTitle,
      noSubTitle,
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
    const expectedMarketId =
      state.marketCounterValue === null ? null : state.marketCounterValue + 1;
    // The accepted submission fixes the event's collateral right away (the indexer writes the same
    // pair when it sees the market): a second market in another instrument is refused from this
    // moment on, not only once the first one is indexed.
    await this.dataSource.query(
      `UPDATE to_events SET collateral_admin = $2, collateral_id = $3, updated_at = now()
        WHERE ticker = $1 AND collateral_admin IS NULL`,
      [eventTicker, collateral.admin, collateral.id],
    );
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "market.create_submitted",
      subjectType: "market",
      subjectId: ticker,
      metadata: {
        reason,
        eventTicker,
        collateral: { admin: collateral.admin, id: collateral.id },
        commandId,
        expectedMarketId,
        status: res.status,
        presentation: [
          imageUrl !== undefined ? "imageUrl" : null,
          description !== undefined ? "description" : null,
        ].filter(Boolean),
      },
      ip: actor.ip ?? null,
    });
    await this.nats.publishSafe(
      NatsSubjects.marketCreateSubmitted,
      {
        commandId,
        ticker,
        eventTicker,
        collateral: { admin: collateral.admin, id: collateral.id },
      },
      { msgId: commandId },
    );
    return {
      commandId,
      status: res.status,
      ticker,
      eventTicker,
      collateral: this.instruments.toRef(collateral),
      expectedMarketId,
    };
  }
}

/** A client decimal → the 10-dp string Daml wants (rejects non-decimals). */
function formatDecimalString(raw: string): string {
  try {
    return formatAmount(parseDecimal(raw));
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
