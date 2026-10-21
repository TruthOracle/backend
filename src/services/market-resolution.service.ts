import { Injectable, type OnModuleInit } from "@nestjs/common";
import { DataSource, In } from "typeorm";

import { Config } from "../config";
import { AttestationEntity } from "../entities/attestation.entity";
import { MarketEntity } from "../entities/market.entity";
import type {
  ApiMarketResolution,
  ApiMarketResolutionAttestation,
  ApiMarketResolutionResult,
  ApiMarketResolutionSnapshot,
  ApiMarketResolutionSubmission,
  MarketResolutionChoice,
} from "../types";
import { ApiError } from "../util/errors";
import { asString, isUuid } from "../util/strings";
import type { LinkedPerson, Refusal } from "./admin-approval.logic";
import { AdminApprovalService, type ApprovalExecutionContext } from "./admin-approval.service";
import { AuditService } from "./audit.service";
import { commandOutcome, EnterpriseWalletService } from "./enterprise-wallet.service";
import { IndexerService } from "./indexer.service";
import { InstrumentsService } from "./instruments.service";
import { LedgerClientService } from "./ledger-client.service";
import {
  attestationAssertsRefusal,
  type AttestationFacts,
  attestationsRefusal,
  choiceArgumentOf,
  choiceRefusal,
  choicesAvailable,
  describeResolution,
  epochSeconds,
  MARKET_RESOLVE_ACTION,
  notResolvable,
  type ResolutionMarket,
  type ResolutionParams,
  resolutionCommandId,
  resolutionParams,
  resolutionWindows,
  resolvedOutcomeOf,
} from "./market-resolution.logic";
import { secToIso } from "./markets.service";

/** How long execution waits for the wallet to say what became of the exercise (review F0). */
const SUBMISSION_WAIT_MS = 15_000;
/** The GET's live read of the last submission's status. */
const STATUS_READ_MS = 2_000;

/**
 * Resolving or voiding a market is the four-eyes `market.resolve` (review F0): `ops` requests a
 * ResolveT0 / Resolve / VoidMarket of one market (the market id is the subject — a trade
 * re-creates the contract), another person with `approver` approves, and the backend submits the
 * exercise treasury-signed through the Enterprise Wallet, like CreateMarket — the only way any
 * market of any collateral is resolved. Request and execution both need a fresh index and judge
 * the status, window, policy and attestations by the BACKEND's clock; the submitted `nowSeconds`
 * is that clock, never a caller's; the contract exercised is the one the LEDGER holds at
 * execution, and the wallet's word on it is awaited briefly. Nobody holding a stake in the market
 * (through any linked account) may request or approve it. With RAMP_DUAL_CONTROL=false (dev) it
 * executes at once and, with RAMP_APPROVAL_SIGNATURES, carries the requester's signed request
 * (C23).
 */
@Injectable()
export class MarketResolutionService implements OnModuleInit {
  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly approvals: AdminApprovalService,
    private readonly indexer: IndexerService,
    private readonly wallet: EnterpriseWalletService,
    private readonly ledger: LedgerClientService,
    private readonly instruments: InstrumentsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.register<
      ResolutionParams,
      ApiMarketResolutionSnapshot,
      ApiMarketResolutionResult
    >({
      action: MARKET_RESOLVE_ACTION,
      subjectType: "market",
      requestRoles: ["ops"],
      params: (raw) => resolutionParams(raw),
      // Deciding who a market pays releases value: a dev single-control request is signed (C23).
      signSingleControl: () => true,
      snapshot: (id, p) => this.snapshot(id, p),
      validate: (p, s) => this.validate(p, s),
      describe: (p, s) => describeResolution(p, s),
      execute: (p, s, ctx) => this.execute(p, s, ctx),
      // I8 in spirit: nobody decides who a market pays while holding a stake in it.
      conflict: (id, _p, _s, people) => this.stakeRefusal(id, people),
    });
  }

  /** `GET /admin/markets/:marketId/resolution`: the terms, the windows and what is open now. */
  async view(marketId: string): Promise<ApiMarketResolution> {
    const m = await this.market(marketId);
    const nowSec = epochSeconds();
    const w = resolutionWindows(m.expiresAtSec, m.gracePeriodSecs);
    const [pending] = await this.approvals.list({
      status: "pending",
      action: MARKET_RESOLVE_ACTION,
      subjectType: "market",
      subjectId: String(m.marketId),
    });
    const { collateral, ...terms } = termsOf(m);
    return {
      market: { ...terms, collateral: this.instruments.refFor(collateral.admin, collateral.id) },
      windows: {
        resolveT0From: secToIso(w.resolveT0From),
        resolveT0To: secToIso(w.resolveT0To),
        resolveFrom: secToIso(w.resolveFrom),
        voidFrom: secToIso(w.voidFrom),
      },
      choicesAvailable: choicesAvailable(rulesOf(m), nowSec),
      pending: pending ?? null,
      lastSubmission: await this.lastSubmission(String(m.marketId)),
      attestations: await this.indexedAttestations(m),
      asOf: secToIso(nowSec),
    };
  }

  /**
   * The latest `market.resolution_submitted` / `market.resolution_failed` audit row of the market
   * and, for a submission, what the wallet says of it now (STATUS_READ_MS; `unknown` when it cannot
   * say). A failed one stays failed with the reason it was audited with.
   */
  private async lastSubmission(marketId: string): Promise<ApiMarketResolutionSubmission | null> {
    const [row] = await this.dataSource.query<
      { action: string; metadata: Record<string, unknown>; created_at: Date }[]
    >(
      `SELECT action, metadata, created_at FROM to_audit_events
        WHERE subject_type = 'market' AND subject_id = $1
          AND action IN ('market.resolution_submitted', 'market.resolution_failed')
        ORDER BY id DESC LIMIT 1`,
      [marketId],
    );
    if (!row) return null;
    const commandId = asString(row.metadata.commandId);
    const base = {
      commandId,
      choice: asString(row.metadata.choice) as MarketResolutionChoice,
      at: new Date(row.created_at).toISOString(),
    };
    if (row.action === "market.resolution_failed")
      return { ...base, status: "failed", error: asString(row.metadata.error) || null };
    let s;
    try {
      s = await this.wallet.commandStatus(this.config.treasuryPartyId, commandId, {
        timeoutMs: STATUS_READ_MS,
      });
    } catch {
      return { ...base, status: "unknown", error: null };
    }
    const outcome = commandOutcome(s);
    if (outcome === "failed")
      return { ...base, status: "failed", error: s.reason ?? `the wallet reports ${s.status}` };
    return { ...base, status: outcome === "pending" ? "submitted" : outcome, error: null };
  }

  /** Every indexed active attestation of the market, each judged alone by Resolve's own asserts. */
  private async indexedAttestations(m: MarketEntity): Promise<ApiMarketResolutionAttestation[]> {
    const rows = await this.dataSource.getRepository(AttestationEntity).find({
      where: { marketId: m.marketId, active: true },
      order: { createdOffset: "ASC", contractId: "ASC" },
    });
    const rules = rulesOf(m);
    return rows.map((r) => {
      const refused = attestationAssertsRefusal(rules, [{ cid: r.contractId, row: r }]);
      return {
        cid: r.contractId,
        outcome: r.outcome,
        sourceUri: r.sourceUri,
        fetchedAt: secToIso(r.fetchedAtSec),
        usable: refused === null,
        reason: refused?.reason ?? null,
      };
    });
  }

  /** Fresh index first (503 `ledger_stale`), then the market (404) and the named attestations. */
  private async snapshot(
    marketId: string,
    p: ResolutionParams,
  ): Promise<ApiMarketResolutionSnapshot> {
    await this.indexer.requireFresh();
    const snapshot: ApiMarketResolutionSnapshot = termsOf(await this.market(marketId));
    if (p.choice === "Resolve")
      snapshot.attestations = (await this.attestations(p.attestationCids ?? [])).map(
        ({ cid, row }) => ({
          cid,
          outcome: row?.outcome ?? null,
          sourceUri: row?.sourceUri ?? null,
          fetchedAt: row ? secToIso(row.fetchedAtSec) : null,
        }),
      );
    return snapshot;
  }

  /** At request and again under the subject lock before execution (fresh reads, the backend clock). */
  private async validate(p: ResolutionParams, s: ApiMarketResolutionSnapshot): Promise<void> {
    if (!this.wallet.isConfigured())
      throw new ApiError(503, "not_ready", "the Enterprise Wallet is not configured");
    const rules = rulesOf(await this.market(s.marketId));
    const refused =
      choiceRefusal(p.choice, rules, epochSeconds(), p.sourceUri ?? null) ??
      (p.choice === "Resolve"
        ? attestationsRefusal(rules, await this.attestations(p.attestationCids ?? []))
        : null);
    if (refused) throw notResolvable(refused, p.choice, s.marketId);
  }

  /**
   * Exercises the choice on the market's CURRENT contract — read from the LEDGER as the treasury,
   * uncached (the index may trail it by a trade) — with `nowSeconds` = this clock reading,
   * re-checked against the window first; the command id is the approval's own, so a re-execute
   * dedups. Then waits up to SUBMISSION_WAIT_MS for the wallet's word: FAILED → audited
   * `market.resolution_failed` and thrown (the approval closes failed with the wallet's reason);
   * committed → `succeeded`; no word yet → `submitted` (GET …/resolution follows it).
   */
  private async execute(
    p: ResolutionParams,
    s: ApiMarketResolutionSnapshot,
    ctx: ApprovalExecutionContext,
  ): Promise<ApiMarketResolutionResult> {
    const m = await this.market(s.marketId);
    const nowSec = epochSeconds();
    const refused = choiceRefusal(p.choice, rulesOf(m), nowSec, p.sourceUri ?? null);
    if (refused) throw notResolvable(refused, p.choice, s.marketId);
    const contractId = await this.currentContract(s.marketId, p.choice);
    const commandId = resolutionCommandId(s.marketId, ctx.approvalId);
    const res = await this.wallet.externalSubmit({
      commandId,
      commands: [
        {
          ExerciseCommand: {
            templateId: this.ledger.templateId("PredictionMarket"),
            contractId,
            choice: p.choice,
            choiceArgument: choiceArgumentOf(p, nowSec),
          },
        },
      ],
    });
    const audit = (
      action: "market.resolution_submitted" | "market.resolution_failed",
      metadata: Record<string, unknown>,
    ) =>
      this.audit.record({
        actorType: "admin",
        actorUserId: ctx.actor.userId,
        actorSessionId: ctx.actor.sessionId,
        action,
        subjectType: "market",
        subjectId: s.marketId,
        metadata: { marketId: s.marketId, choice: p.choice, commandId, ...metadata },
        ip: ctx.actor.ip,
      });
    await audit("market.resolution_submitted", {
      outcome: resolvedOutcomeOf(p, s),
      approvalId: ctx.approvalId,
      requester: ctx.requester.person,
      contractId,
      nowSeconds: nowSec,
      sourceUri: p.sourceUri,
      attestationCids: p.attestationCids,
      status: res.status,
    });
    const settled = await this.settledSubmission(commandId);
    if (settled.status === "failed") {
      await audit("market.resolution_failed", { error: settled.error });
      throw new ApiError(
        502,
        "upstream_failed",
        `the ledger rejected ${p.choice} of market #${s.marketId}: ${settled.error}`,
        { marketId: s.marketId, choice: p.choice, commandId, reason: settled.error },
      );
    }
    return { marketId: s.marketId, choice: p.choice, commandId, status: settled.status };
  }

  /**
   * The market's CURRENT PredictionMarket contract on the LEDGER (an uncached read as the
   * treasury, like RampPolicyService.signedInTime): none or several → `market_not_resolvable`;
   * unreadable → refused (I7; the approval closes failed and is asked again).
   */
  private async currentContract(marketId: string, choice: MarketResolutionChoice): Promise<string> {
    let cids: string[];
    try {
      cids = await this.ledger.fetchMarketContracts(marketId, { uncached: true });
    } catch (err) {
      throw new ApiError(
        502,
        "upstream_failed",
        `the ledger could not be read for market #${marketId}'s contract: ${(err as Error).message}`,
      );
    }
    if (cids.length === 1) return cids[0];
    throw notResolvable(
      cids.length
        ? {
            reason: "ledger_ambiguous",
            message: `market #${marketId} has ${cids.length} active contracts on the ledger`,
            details: { contractIds: cids },
          }
        : {
            reason: "not_on_ledger",
            message: `market #${marketId} has no active contract on the ledger`,
          },
      choice,
      marketId,
    );
  }

  /** The wallet's word on the command within SUBMISSION_WAIT_MS (the status fail() reads for MarkPaid). */
  private async settledSubmission(
    commandId: string,
  ): Promise<{ status: "succeeded" | "submitted" } | { status: "failed"; error: string }> {
    const deadline = Date.now() + SUBMISSION_WAIT_MS;
    for (let pause = 250; ; pause = Math.min(pause * 2, 2_000)) {
      const s = await this.wallet.commandStatus(this.config.treasuryPartyId, commandId);
      const outcome = commandOutcome(s);
      if (outcome === "succeeded") return { status: "succeeded" };
      if (outcome === "failed")
        return { status: "failed", error: s.reason ?? `the wallet reports ${s.status}` };
      const left = deadline - Date.now();
      if (left <= 0) return { status: "submitted" };
      await new Promise((resolve) => setTimeout(resolve, Math.min(pause, left)));
    }
  }

  /**
   * I8 in spirit (the `conflict` hook): a person any of whose linked accounts — or whose operator
   * party — holds what the index records as a stake in the market (a position with shares, LP
   * shares) may neither request nor approve its resolution, nor see it executed.
   */
  private async stakeRefusal(marketId: string, people: LinkedPerson[]): Promise<Refusal | null> {
    for (const p of people) {
      const users = p.userIds.filter((u) => isUuid(u));
      const [row] = await this.dataSource.query<{ held: boolean }[]>(
        `WITH parties AS (
           SELECT party_id FROM to_wallets WHERE user_id = ANY($2::uuid[])
           UNION SELECT party_id FROM to_users WHERE id = ANY($2::uuid[]) AND party_id IS NOT NULL
           UNION SELECT $3::text)
         SELECT EXISTS (SELECT 1 FROM to_positions
                         WHERE market_id = $1 AND active AND holder IN (SELECT party_id FROM parties)
                           AND (yes_shares > 0 OR no_shares > 0))
             OR EXISTS (SELECT 1 FROM to_liquidity_positions
                         WHERE market_id = $1 AND active AND provider IN (SELECT party_id FROM parties)
                           AND lp_tokens > 0) AS held`,
        [marketId, users, p.party],
      );
      if (row?.held)
        return {
          status: 403,
          code: "approval_linked_person",
          message: `${p.person} holds a position in market #${marketId} through a linked account; another person must act`,
          details: { person: p.person, reason: "position_in_market", marketId },
        };
    }
    return null;
  }

  private async market(marketId: string): Promise<MarketEntity> {
    const m = await this.dataSource
      .getRepository(MarketEntity)
      .findOneBy({ marketId: Number(marketId) });
    if (!m) throw new ApiError(404, "not_found", `market #${marketId} is not indexed`);
    return m;
  }

  private async attestations(cids: string[]): Promise<AttestationFacts[]> {
    const rows = cids.length
      ? await this.dataSource.getRepository(AttestationEntity).findBy({ contractId: In(cids) })
      : [];
    const byCid = new Map(rows.map((r) => [r.contractId, r]));
    return cids.map((cid) => ({ cid, row: byCid.get(cid) ?? null }));
  }
}

/** The decision fields of a market (the snapshot without attestations). */
function termsOf(m: MarketEntity): ApiMarketResolutionSnapshot {
  return {
    marketId: String(m.marketId),
    ticker: m.ticker,
    question: m.question,
    status: m.status,
    expiresAt: secToIso(m.expiresAtSec),
    gracePeriodSecs: m.gracePeriodSecs,
    collateral: { admin: m.collateralAdmin, id: m.collateralId },
    operatorResolution: m.policy?.operatorResolution === true,
    sources: [...(m.policy?.sources ?? [])],
    outcome: m.outcome,
  };
}

function rulesOf(m: MarketEntity): ResolutionMarket {
  const p = m.policy;
  return {
    marketId: m.marketId,
    status: m.status,
    archived: m.archived,
    expiresAtSec: m.expiresAtSec,
    gracePeriodSecs: m.gracePeriodSecs,
    policy: {
      operatorResolution: p?.operatorResolution === true,
      sources: p?.sources ?? [],
      sourceKeys: p?.sourceKeys ?? [],
      reporters: p?.reporters ?? [],
      quorum: p?.quorum ?? 0,
    },
  };
}
