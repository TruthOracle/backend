import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";

import { Config } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import { MarketEventEntity } from "../entities/market-event.entity";
import { MarketEntity } from "../entities/market.entity";
import { RewardGrantEntity } from "../entities/reward-grant.entity";
import { RewardRuleEntity } from "../entities/reward-rule.entity";
import { SETTING_REWARDS_CURSOR, SettingEntity } from "../entities/setting.entity";
import type { UserEntity } from "../entities/user.entity";
import { WalletEntryEntity } from "../entities/wallet-entry.entity";
import {
  NatsSubjects,
  REWARD_GRANT_STATUSES,
  type Actor,
  type ApiPage,
  type ApiRewardGrant,
  type ApiRewardRule,
  type ApiRewardsFloat,
  type ApiRewardsOverview,
  type InstrumentId,
  type LedgerWallet,
  type RewardGrantStatus,
  type RewardRuleKind,
  sameInstrument,
} from "../types";
import { ApiError } from "../util/errors";
import { AMOUNT_SCALE, formatAmount, parseAmount, quantizeDown } from "../util/money";
import { AuditService } from "./audit.service";
import { DepositService } from "./deposit.service";
import { EnterpriseWalletService } from "./enterprise-wallet.service";
import { IndexerService } from "./indexer.service";
import { InstrumentsService } from "./instruments.service";
import { LedgerClientService } from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { SentryService } from "./sentry.service";
import { TokenAppService } from "./token-app.service";
import { TreasuryTransferService } from "./treasury-transfer.service";
import { UserService } from "./user.service";
import { WalletLinkService } from "./wallet-link.service";

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested in rewards.service.spec.ts)
// ---------------------------------------------------------------------------------------------

/** The rules the processor applies by itself; `manual` grants come from the operator and need no rule row. */
export type AutomaticRuleKind = Exclude<RewardRuleKind, "manual">;
export const AUTOMATIC_RULE_KINDS: readonly AutomaticRuleKind[] = [
  "trade_volume_rebate",
  "winning_redeem_bonus",
  "first_deposit_bonus",
];

/**
 * The documented defaults (docs/TOKENS.md §4.6): 1 % of the traded collateral as TRO on every
 * buy / sell of at least 1 unit, 5 % of a winning redemption, 10 TRO on a first deposit. Decimal
 * strings, never numbers, like every amount on the wire.
 */
export const REWARD_RULE_DEFAULTS: Readonly<Record<AutomaticRuleKind, Record<string, string>>> = {
  trade_volume_rebate: { perUnit: "0.01", minTrade: "1" },
  winning_redeem_bonus: { fraction: "0.05" },
  first_deposit_bonus: { amount: "10" },
};

const RULE_PARAM_KEYS: Readonly<Record<AutomaticRuleKind, readonly string[]>> = {
  trade_volume_rebate: ["perUnit", "minTrade"],
  winning_redeem_bonus: ["fraction"],
  first_deposit_bonus: ["amount"],
};
const PARAM_INPUT = /^\d{1,28}(\.\d{1,10})?$/;

/**
 * A rule's `params` as the operator may set them: exactly the kind's keys, each a non-negative
 * decimal string (`fraction` at most 1 — a bonus above the payout is a typo, not a policy).
 * `400 validation_failed` names the first problem. Pure: the DTO only checks for an object.
 */
export function validateRuleParams(
  kind: RewardRuleKind,
  params: Record<string, unknown>,
): Record<string, string> {
  if (kind === "manual")
    throw new ApiError(400, "validation_failed", "manual grants have no rule parameters");
  const keys = RULE_PARAM_KEYS[kind];
  const out: Record<string, string> = {};
  for (const key of Object.keys(params))
    if (!keys.includes(key))
      throw new ApiError(400, "validation_failed", `${kind} has no parameter ${key}`);
  for (const key of keys) {
    const raw = params[key];
    if (typeof raw !== "string" || !PARAM_INPUT.test(raw.trim()))
      throw new ApiError(
        400,
        "validation_failed",
        `${kind}.${key} must be a non-negative decimal string with at most 10 decimals`,
      );
    out[key] = raw.trim();
  }
  if (kind === "winning_redeem_bonus" && parseAmount(out.fraction) > AMOUNT_SCALE)
    throw new ApiError(400, "validation_failed", "winning_redeem_bonus.fraction must be at most 1");
  return out;
}

/** `to_settings.rewards_cursor`: how far the processor has read each index table (`<offset>:<wallet entry id>:<market event id>`). */
export interface RewardsCursor {
  offset: number;
  walletEntryId: bigint;
  marketEventId: bigint;
}

/** `'0'` (the migration's seed) and anything malformed read as the start: grants are idempotent per source row, so re-reading only costs time. */
export function parseRewardsCursor(raw: string | null | undefined): RewardsCursor {
  const start: RewardsCursor = { offset: 0, walletEntryId: 0n, marketEventId: 0n };
  if (!raw) return start;
  const m = /^(\d{1,15}):(\d{1,18}):(\d{1,18})$/.exec(raw.trim());
  if (!m) return start;
  return { offset: Number(m[1]), walletEntryId: BigInt(m[2]), marketEventId: BigInt(m[3]) };
}

export function formatRewardsCursor(cursor: RewardsCursor): string {
  return `${cursor.offset}:${cursor.walletEntryId.toString()}:${cursor.marketEventId.toString()}`;
}

/** `reward:<grantId>` — the `ref` the Daml `Grant` appends to `creditRefs`; the on-ledger idempotency key of the grant. */
export function grantRef(grantId: string): string {
  return `reward:${grantId}`;
}

/** `reward-grant-<grantId>-<attempt>`: a fresh command id per submission (the ref, not the command id, stops a double credit). */
export function grantCommandId(grantId: string, attempt: number): string {
  return `reward-grant-${grantId}-${attempt}`;
}

/** The attempt number a `grantCommandId` carries; 0 when the grant was never submitted. */
export function grantAttemptOf(commandId: string | null): number {
  const m = commandId ? /-(\d+)$/.exec(commandId) : null;
  return m ? Number(m[1]) : 0;
}

/** `reward-float-<grantId>`: the one auto-mint a blocked grant may trigger (token-app dedups on it). */
export function autoMintCommandId(grantId: string): string {
  return `reward-float-${grantId}`;
}

/** Resubmissions after the ledger refused a grant; past this the row is `failed` for an operator. */
export const MAX_GRANT_ATTEMPTS = 5;

/**
 * `amount × rate` in exact fixed point (both 1e-10 units), rounded down and then quantised to the
 * rewards instrument's decimals: a reward finer than the token can leave the platform would be
 * dust in the wallet forever. 0 when either side is 0.
 */
export function scaledReward(amount: bigint, rate: bigint, decimals: number): bigint {
  if (amount <= 0n || rate <= 0n) return 0n;
  return quantizeDown((amount * rate) / AMOUNT_SCALE, decimals);
}

/** What the float rule sees (docs/TOKENS.md §4.6), all in 1e-10 units of the rewards instrument. */
export interface FloatState {
  /** Σ of the treasury's active holdings of the rewards instrument (index). */
  treasuryHoldings: bigint;
  /** Σ `UserWallet.balance` in the rewards instrument (index). */
  liabilities: bigint;
  /** Σ grants submitted or credited that the index does not show in a wallet balance yet. */
  pending: bigint;
}

/** `treasuryHoldings − liabilities − pending`: what the treasury can still grant without owing more than it holds. */
export function floatHeadroom(state: FloatState): bigint {
  return state.treasuryHoldings - state.liabilities - state.pending;
}

/** How much the float is short of covering `amount` (0 when it covers it). */
export function floatShortfall(state: FloatState, amount: bigint): bigint {
  const missing = amount - floatHeadroom(state);
  return missing > 0n ? missing : 0n;
}

/** `max(shortfall, REWARDS_MINT_MIN)`, quantised to the instrument. */
export function autoMintAmount(shortfall: bigint, minimum: bigint, decimals: number): bigint {
  const raw = shortfall > minimum ? shortfall : minimum;
  const quantized = quantizeDown(raw, decimals);
  // A shortfall below one unit of the token still needs one unit minted to clear.
  return quantized < raw ? quantized + 10n ** BigInt(10 - decimals) : quantized;
}

/** A grant a rule derived from one index row, before the account lookup. */
export interface GrantCandidate {
  kind: AutomaticRuleKind;
  /** The on-ledger party that earned it (the trader, the redeemer, the depositor). */
  party: string;
  sourceEventId: string;
  amount: bigint;
  reason: string;
}

export type RuleParams = ReadonlyMap<AutomaticRuleKind, Record<string, string>>;

/**
 * The trade rebate and the redeem bonus, from one `to_market_events` row (docs/TOKENS.md §4.6).
 * Both price the reward off an amount in the market's collateral, so only markets in the
 * default collateral qualify — a rebate on a cBYN trade and one on a Canton Coin trade cannot
 * share a `perUnit`. `buy` / `sell` carry the collateral moved (`amount`: in on a buy, gross on a
 * sell); `redeem` carries the payout and the market's outcome (a voided market refunds, it does
 * not win). Null when no enabled rule applies or the reward rounds to nothing.
 */
export function evaluateMarketEvent(
  event: Pick<MarketEventEntity, "eventId" | "kind" | "actor" | "amount" | "outcome">,
  market: Pick<MarketEntity, "collateralAdmin" | "collateralId"> | null,
  rules: RuleParams,
  collateral: InstrumentId,
  decimals: number,
): GrantCandidate | null {
  if (!market || !event.actor) return null;
  if (!sameInstrument({ admin: market.collateralAdmin, id: market.collateralId }, collateral))
    return null;
  const amount = event.amount ?? 0n;
  if (event.kind === "buy" || event.kind === "sell") {
    const rule = rules.get("trade_volume_rebate");
    if (!rule) return null;
    if (amount < parseAmount(rule.minTrade)) return null;
    const reward = scaledReward(amount, parseAmount(rule.perUnit), decimals);
    if (reward <= 0n) return null;
    return {
      kind: "trade_volume_rebate",
      party: event.actor,
      sourceEventId: event.eventId,
      amount: reward,
      reason: "trade_volume_rebate",
    };
  }
  if (event.kind === "redeem") {
    const rule = rules.get("winning_redeem_bonus");
    if (!rule) return null;
    if (event.outcome !== "Yes" && event.outcome !== "No") return null;
    const reward = scaledReward(amount, parseAmount(rule.fraction), decimals);
    if (reward <= 0n) return null;
    return {
      kind: "winning_redeem_bonus",
      party: event.actor,
      sourceEventId: event.eventId,
      amount: reward,
      reason: "winning_redeem_bonus",
    };
  }
  return null;
}

/**
 * The first-deposit bonus, from one `to_wallet_entries` row: a `deposit` in the default collateral
 * that the owner's own transfer funded (an operator's mint credit — `txRef` `mint:…` — is an
 * on-ramp, not the user's deposit). Whether it IS the first one is the service's question (it
 * needs the earlier rows); here only the shape and the amount.
 */
export function evaluateWalletEntry(
  entry: Pick<
    WalletEntryEntity,
    "eventId" | "kind" | "owner" | "instrumentAdmin" | "instrumentId" | "txRef"
  >,
  rules: RuleParams,
  collateral: InstrumentId,
  decimals: number,
): GrantCandidate | null {
  if (entry.kind !== "deposit" || !entry.owner) return null;
  if (!sameInstrument({ admin: entry.instrumentAdmin, id: entry.instrumentId }, collateral))
    return null;
  if (entry.txRef?.startsWith("mint:")) return null;
  const rule = rules.get("first_deposit_bonus");
  if (!rule) return null;
  const amount = quantizeDown(parseAmount(rule.amount), decimals);
  if (amount <= 0n) return null;
  return {
    kind: "first_deposit_bonus",
    party: entry.owner,
    sourceEventId: entry.eventId,
    amount,
    reason: "first_deposit_bonus",
  };
}

/** `UserWallet.Grant { amount, ref, reason }` on the wallet that exists (v17 argument names). */
export function grantCommand(
  templateId: string,
  wallet: LedgerWallet,
  grant: Pick<RewardGrantEntity, "amount" | "ref" | "reason" | "kind">,
): unknown {
  return {
    ExerciseCommand: {
      templateId,
      contractId: wallet.contractId,
      choice: "Grant",
      choiceArgument: { amount: formatAmount(grant.amount), ref: grant.ref, reason: grant.kind },
    },
  };
}

/** One `scan()` pass, for logs and tests. */
export interface RewardsScanResult {
  /** Index rows read this pass. */
  walletEntries: number;
  marketEvents: number;
  /** Grants written `queued`. */
  queued: number;
  submitted: number;
  credited: number;
  /** Grants re-queued after the ledger refused the submission. */
  requeued: number;
  failed: number;
  blocked: number;
  /** The auto-mint command id, when the pass minted. */
  minted: string | null;
  /** Why the pass did nothing (or stopped early). */
  skipped: string | null;
}

/** Index rows per table per pass; a backlog takes several passes (each pass loops up to `MAX_BATCHES`). */
const BATCH = 500;
const MAX_BATCHES = 10;

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

/**
 * TRO rewards (docs/TOKENS.md §4.6). Grants are COMPUTED off-ledger from the index — new
 * `to_wallet_entries` / `to_market_events` past `to_settings.rewards_cursor`, run through the
 * enabled rules — and CREDITED on-ledger with `UserWallet.Grant { amount, ref = "reward:<id>",
 * reason = <kind> }` on the account's rewards wallet (created on demand under the shared
 * deterministic id), confirmed when the wallet's `creditRefs` carries the ref — the deposit
 * credit's pattern, with the same grace period. Before a grant is submitted the FLOAT RULE must
 * hold: the treasury's indexed holdings of the rewards instrument cover every in-app balance in
 * it, the grants in flight and this one; otherwise the grant waits `blocked_float` (Sentry,
 * NATS) and, on DevNet with `REWARDS_AUTO_MINT`, the shortfall is minted to the treasury through
 * token-app so the next pass can clear it. `RewardsProcessor` drives `scan()`; the admin routes
 * manage the rules and the manual grants; `GET /me/rewards` is the account's view.
 */
@Injectable()
export class RewardsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(RewardRuleEntity) private readonly rules: Repository<RewardRuleEntity>,
    @InjectRepository(RewardGrantEntity) private readonly grants: Repository<RewardGrantEntity>,
    private readonly users: UserService,
    private readonly walletLinks: WalletLinkService,
    private readonly instruments: InstrumentsService,
    private readonly ledger: LedgerClientService,
    private readonly wallet: EnterpriseWalletService,
    private readonly deposits: DepositService,
    private readonly treasuryTransfers: TreasuryTransferService,
    private readonly indexer: IndexerService,
    private readonly tokenApp: TokenAppService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
    private readonly sentry: SentryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedRules();
  }

  private get treasury(): string {
    const treasury = this.config.treasuryPartyId;
    if (!treasury)
      throw new ApiError(502, "upstream_failed", "TREASURY_PARTY_ID is not configured");
    return treasury;
  }

  // ───────────────────────────────────────────── rules ─────────────────────────────────────────────

  /**
   * The three automatic rules exist from the first boot on, with their documented defaults —
   * `enabled` only on `APP_ENV=dev`, where a fresh stack should hand out rewards without an
   * operator's click; everywhere else an operator enables them. Idempotent (`ON CONFLICT (kind)`):
   * a rule the operator already touched is never reset.
   */
  async seedRules(): Promise<void> {
    const enabled = this.config.appEnv === "dev";
    for (const kind of AUTOMATIC_RULE_KINDS)
      await this.rules
        .createQueryBuilder()
        .insert()
        .values({ kind, params: { ...REWARD_RULE_DEFAULTS[kind] }, enabled })
        .orIgnore()
        .execute();
  }

  async listRules(): Promise<RewardRuleEntity[]> {
    return this.rules.find({ order: { kind: "ASC" } });
  }

  /** `PUT /admin/rewards/rules/:id` — `404 not_found`; params validated per kind; audited `reward.rule_updated`. */
  async updateRule(
    id: string,
    patch: { params?: Record<string, unknown>; enabled?: boolean },
    actor: Actor,
    reason: string,
  ): Promise<RewardRuleEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RewardRuleEntity);
      const row = await repo.findOneBy({ id });
      if (!row) throw new ApiError(404, "not_found", `reward rule ${id} does not exist`);
      const before = { params: row.params, enabled: row.enabled };
      if (patch.params !== undefined) row.params = validateRuleParams(row.kind, patch.params);
      if (patch.enabled !== undefined) row.enabled = patch.enabled;
      await repo.save(row);
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "reward.rule_updated",
          subjectType: "reward_rule",
          subjectId: row.id,
          metadata: {
            kind: row.kind,
            reason,
            before,
            after: { params: row.params, enabled: row.enabled },
          },
          ip: actor.ip ?? null,
        },
        manager,
      );
      return row;
    });
  }

  toApiRule(row: RewardRuleEntity): ApiRewardRule {
    return {
      id: row.id,
      kind: row.kind,
      params: { ...row.params },
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ───────────────────────────────────────────── grants ─────────────────────────────────────────────

  /** The rewards instrument, or `503 not_ready` when none is registered (REWARDS_INSTRUMENT_ADMIN blank). */
  async requireInstrument(): Promise<InstrumentEntity> {
    const row = await this.instruments.rewardsInstrument();
    if (!row)
      throw new ApiError(
        503,
        "not_ready",
        "no rewards instrument is configured (REWARDS_INSTRUMENT_ADMIN / REWARDS_INSTRUMENT_ID)",
      );
    return row;
  }

  /**
   * `POST /admin/rewards/grant { userId | party, amount, reason }` (docs/TOKENS.md §4.6): a
   * `manual` grant written `queued` for the next pass. By `userId` it goes to the account's
   * primary party; by `party` to that party, attributed to its account when one links it (a
   * party nobody linked is allowed — the operator chose it). The amount must be whole in the
   * instrument's decimals: an operator types what the token can carry. Audited
   * `reward.grant_requested`; `reward.granted` follows when the ledger confirms it.
   */
  async grantManual(
    input: { userId?: string; party?: string; amount: bigint; reason: string },
    actor: Actor,
  ): Promise<RewardGrantEntity> {
    const instrument = await this.requireInstrument();
    if (input.amount <= 0n)
      throw new ApiError(400, "validation_failed", "a grant amount must be positive");
    if (quantizeDown(input.amount, instrument.decimals) !== input.amount)
      throw new ApiError(
        400,
        "validation_failed",
        `${instrument.symbol} carries ${instrument.decimals} decimals; the amount is finer than that`,
      );
    let party: string;
    let userId: string | null;
    if (input.userId) {
      const user = await this.users.findById(input.userId);
      if (!user) throw new ApiError(404, "not_found", "user not found");
      if (user.status !== "active")
        throw new ApiError(403, "user_suspended", "this account is suspended");
      if (!user.partyId)
        throw new ApiError(409, "no_primary_wallet", "the account has no primary wallet");
      party = user.partyId;
      userId = user.id;
    } else if (input.party) {
      party = input.party;
      userId = (await this.walletLinks.findByParty(party))?.userId ?? null;
    } else {
      throw new ApiError(400, "validation_failed", "userId or party is required");
    }
    const id = randomUUID();
    const row = this.grants.create({
      id,
      userId,
      party,
      ruleId: null,
      kind: "manual",
      sourceEventId: null,
      instrumentAdmin: instrument.admin,
      instrumentId: instrument.id,
      amount: input.amount,
      reason: input.reason,
      status: "queued",
      commandId: null,
      ref: grantRef(id),
      error: null,
      submittedAt: null,
      creditedAt: null,
    });
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(RewardGrantEntity).save(row);
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "reward.grant_requested",
          subjectType: "reward_grant",
          subjectId: id,
          metadata: {
            userId,
            party,
            instrument: { admin: instrument.admin, id: instrument.id },
            amount: formatAmount(input.amount),
            reason: input.reason,
          },
          ip: actor.ip ?? null,
        },
        manager,
      );
    });
    return row;
  }

  /** `GET /admin/rewards/grants?status=&userId=&page=&limit=`, newest first. */
  async listGrants(filter: {
    status?: RewardGrantStatus;
    userId?: string;
    page: number;
    limit: number;
  }): Promise<ApiPage<ApiRewardGrant>> {
    const qb = this.grants.createQueryBuilder("g");
    if (filter.status) qb.andWhere("g.status = :status", { status: filter.status });
    if (filter.userId) qb.andWhere("g.user_id = :userId", { userId: filter.userId });
    const [rows, total] = await qb
      .orderBy("g.created_at", "DESC")
      .addOrderBy("g.id", "DESC")
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();
    return {
      items: rows.map((r) => this.toApiGrant(r)),
      page: filter.page,
      limit: filter.limit,
      total,
    };
  }

  toApiGrant(row: RewardGrantEntity): ApiRewardGrant {
    return {
      id: row.id,
      userId: row.userId,
      party: row.party,
      ruleId: row.ruleId,
      kind: row.kind,
      sourceEventId: row.sourceEventId,
      instrument: this.instruments.refFor(row.instrumentAdmin, row.instrumentId),
      amount: formatAmount(row.amount),
      reason: row.reason,
      status: row.status,
      commandId: row.commandId,
      ref: row.ref,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      creditedAt: row.creditedAt ? row.creditedAt.toISOString() : null,
    };
  }

  /**
   * `GET /me/rewards`: the account's rewards wallet as the ledger shows it (the cached read is
   * fine: the grants list says what is still in flight), its totals and its last grants. `404
   * not_found` on a platform without a rewards instrument — there is nothing to show, not a
   * missing account.
   */
  async overview(userId: string): Promise<ApiRewardsOverview> {
    const instrument = await this.instruments.rewardsInstrument();
    if (!instrument)
      throw new ApiError(404, "not_found", "rewards are not enabled (no rewards instrument)");
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    const instrumentId: InstrumentId = { admin: instrument.admin, id: instrument.id };
    const wallet = user.partyId
      ? await this.ledger.fetchUserWallet(user.partyId, instrumentId).catch((err: unknown) => {
          this.logger.warn(`rewards wallet read failed for ${userId}: ${(err as Error).message}`);
          return null;
        })
      : null;
    const rows = await this.grants.find({
      where: { userId, instrumentAdmin: instrument.admin, instrumentId: instrument.id },
      order: { createdAt: "DESC", id: "DESC" },
      take: 100,
    });
    let credited = 0n;
    let queued = 0n;
    for (const g of rows) {
      if (g.status === "credited") credited += g.amount;
      else if (g.status !== "failed") queued += g.amount;
    }
    return {
      instrument: this.instruments.toRef(instrument),
      wallet: wallet ? this.walletLinks.ledgerWalletToApi(wallet) : null,
      totals: { credited: formatAmount(credited), queued: formatAmount(queued) },
      grants: rows.map((r) => this.toApiGrant(r)),
    };
  }

  /** `GET /admin/rewards/float` (docs/TOKENS.md §4.6). */
  async float(): Promise<ApiRewardsFloat> {
    const instrument = await this.requireInstrument();
    const state = await this.floatState(instrument);
    return {
      instrument: this.instruments.toRef(instrument),
      treasuryHoldings: formatAmount(state.treasuryHoldings),
      liabilities: formatAmount(state.liabilities),
      pending: formatAmount(state.pending),
      headroom: formatAmount(floatHeadroom(state)),
    };
  }

  /**
   * The float rule's inputs from the index. `pending` counts the grants whose balance the index
   * does not show yet: every `submitted` one, and a `credited` one until a `grant` wallet entry
   * carries its ref — counting a grant on both sides for a moment only makes the rule stricter,
   * never looser.
   */
  private async floatState(instrument: InstrumentEntity): Promise<FloatState> {
    const balances = await this.treasuryTransfers.indexedBalances(instrument);
    const [pending] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(g.amount), 0)::text AS total
         FROM to_reward_grants g
        WHERE g.instrument_admin = $1 AND g.instrument_id = $2
          AND (g.status = 'submitted'
               OR (g.status = 'credited'
                   AND NOT EXISTS (SELECT 1 FROM to_wallet_entries e WHERE e.kind = 'grant' AND e.tx_ref = g.ref)))`,
      [instrument.admin, instrument.id],
    );
    return { ...balances, pending: parseAmount(pending.total) };
  }

  // ───────────────────────────────────────────── the pass ─────────────────────────────────────────────

  /**
   * One processor pass: (1) read the index past the cursor and queue what the enabled rules earn,
   * (2) submit the queued (and retry the float-blocked) grants under the float rule, (3) confirm
   * the submitted ones against the ledger. Each step is independent and idempotent, so a crash
   * anywhere is finished by the next pass. Without a rewards instrument nothing runs; with one
   * disabled, nothing is submitted (the cursor still advances — a disabled token earns nothing).
   */
  async scan(): Promise<RewardsScanResult> {
    const result: RewardsScanResult = {
      walletEntries: 0,
      marketEvents: 0,
      queued: 0,
      submitted: 0,
      credited: 0,
      requeued: 0,
      failed: 0,
      blocked: 0,
      minted: null,
      skipped: null,
    };
    const instrument = await this.instruments.rewardsInstrument();
    if (!instrument) {
      result.skipped = "no rewards instrument";
      return result;
    }
    const collateral = await this.instruments.defaultCollateral();
    const rules = new Map<AutomaticRuleKind, Record<string, string>>();
    const ruleRows = await this.rules.find({ where: { enabled: true } });
    for (const r of ruleRows) if (r.kind !== "manual") rules.set(r.kind, r.params);
    const ruleIds = new Map(ruleRows.map((r) => [r.kind, r.id]));

    await this.deriveGrants(instrument, collateral, rules, ruleIds, result);
    if (!instrument.enabled) {
      result.skipped = "rewards instrument disabled";
      return result;
    }
    await this.submitQueued(instrument, result);
    await this.confirmSubmitted(instrument, result);
    if (result.queued || result.submitted || result.credited || result.blocked || result.failed)
      this.logger.log(
        `rewards pass: ${result.queued} queued, ${result.submitted} submitted, ${result.credited} credited, ${result.blocked} blocked, ${result.requeued} requeued, ${result.failed} failed${result.minted ? `, auto-mint ${result.minted}` : ""}`,
      );
    return result;
  }

  // ── step 1: index → queued grants ──────────────────────────────────────────────────────────

  private async deriveGrants(
    instrument: InstrumentEntity,
    collateral: InstrumentEntity | null,
    rules: RuleParams,
    ruleIds: ReadonlyMap<RewardRuleKind, string>,
    result: RewardsScanResult,
  ): Promise<void> {
    const settings = this.dataSource.getRepository(SettingEntity);
    let cursor = parseRewardsCursor(
      (await settings.findOneBy({ key: SETTING_REWARDS_CURSOR }))?.value,
    );
    const collateralId: InstrumentId | null = collateral
      ? { admin: collateral.admin, id: collateral.id }
      : null;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const entries = await this.dataSource
        .getRepository(WalletEntryEntity)
        .createQueryBuilder("e")
        .where("e.id > :id", { id: cursor.walletEntryId.toString() })
        .orderBy("e.id", "ASC")
        .take(BATCH)
        .getMany();
      const events = await this.dataSource
        .getRepository(MarketEventEntity)
        .createQueryBuilder("e")
        .where("e.id > :id", { id: cursor.marketEventId.toString() })
        .orderBy("e.id", "ASC")
        .take(BATCH)
        .getMany();
      if (entries.length === 0 && events.length === 0) break;
      result.walletEntries += entries.length;
      result.marketEvents += events.length;

      const marketIds = [...new Set(events.map((e) => e.marketId))];
      const markets = new Map<number, MarketEntity>();
      if (marketIds.length > 0)
        for (const m of await this.dataSource
          .getRepository(MarketEntity)
          .find({ where: { marketId: In(marketIds) } }))
          markets.set(m.marketId, m);

      const next: RewardsCursor = { ...cursor };
      for (const entry of entries) {
        next.walletEntryId = BigInt(entry.id);
        next.offset = Math.max(next.offset, entry.offset);
        if (!collateralId) continue;
        const candidate = evaluateWalletEntry(entry, rules, collateralId, instrument.decimals);
        if (!candidate) continue;
        if (!(await this.isFirstDeposit(entry))) continue;
        if (await this.queueGrant(instrument, candidate, ruleIds, { oncePerUser: true }))
          result.queued += 1;
      }
      for (const event of events) {
        next.marketEventId = BigInt(event.id);
        next.offset = Math.max(next.offset, event.offset);
        if (!collateralId) continue;
        const candidate = evaluateMarketEvent(
          event,
          markets.get(event.marketId) ?? null,
          rules,
          collateralId,
          instrument.decimals,
        );
        if (!candidate) continue;
        if (await this.queueGrant(instrument, candidate, ruleIds, {})) result.queued += 1;
      }
      await settings.upsert({ key: SETTING_REWARDS_CURSOR, value: formatRewardsCursor(next) }, [
        "key",
      ]);
      cursor = next;
      if (entries.length < BATCH && events.length < BATCH) break;
    }
  }

  /** No earlier `deposit` entry of the same owner in the same instrument — the row IS the first deposit. */
  private async isFirstDeposit(entry: WalletEntryEntity): Promise<boolean> {
    const earlier = await this.dataSource
      .getRepository(WalletEntryEntity)
      .createQueryBuilder("e")
      .where(
        "e.owner = :owner AND e.kind = 'deposit' AND e.instrument_admin = :admin AND e.instrument_id = :id AND e.id < :before",
        {
          owner: entry.owner,
          admin: entry.instrumentAdmin,
          id: entry.instrumentId,
          before: entry.id,
        },
      )
      .getCount();
    return earlier === 0;
  }

  /**
   * Write a candidate `queued` for the account that owns the earning party, or skip it: a party
   * nobody linked, a suspended account or one without a primary party earns nothing (the row is
   * consumed — rules apply when the activity happens, not retroactively). The grant goes to the
   * account's PRIMARY party (its rewards wallet), whichever linked wallet traded. Idempotent per
   * source row (`uq_to_reward_grants_source_event_id`); `oncePerUser` kinds (the deposit bonus)
   * are also unique per account.
   */
  private async queueGrant(
    instrument: InstrumentEntity,
    candidate: GrantCandidate,
    ruleIds: ReadonlyMap<RewardRuleKind, string>,
    opts: { oncePerUser?: boolean },
  ): Promise<boolean> {
    const account = await this.accountOf(candidate.party);
    if (!account) return false;
    if (opts.oncePerUser) {
      const already = await this.grants.countBy({ userId: account.user.id, kind: candidate.kind });
      if (already > 0) return false;
    }
    const id = randomUUID();
    const res = await this.grants
      .createQueryBuilder()
      .insert()
      .values({
        id,
        userId: account.user.id,
        party: account.party,
        ruleId: ruleIds.get(candidate.kind) ?? null,
        kind: candidate.kind,
        sourceEventId: candidate.sourceEventId,
        instrumentAdmin: instrument.admin,
        instrumentId: instrument.id,
        amount: candidate.amount,
        reason: candidate.reason,
        status: "queued",
        commandId: null,
        ref: grantRef(id),
        error: null,
        submittedAt: null,
        creditedAt: null,
      })
      .orIgnore()
      .returning("id")
      .updateEntity(false)
      .execute();
    return Array.isArray(res.raw) && res.raw.length > 0;
  }

  /** The account a party belongs to (any linked wallet, active or revoked) and its primary party; null when there is none to grant to. */
  private async accountOf(party: string): Promise<{ user: UserEntity; party: string } | null> {
    const row = await this.walletLinks.findByParty(party);
    if (!row) return null;
    const user = await this.users.findById(row.userId);
    if (!user || user.status !== "active" || !user.partyId) return null;
    return { user, party: user.partyId };
  }

  // ── step 2: queued → submitted (float rule) ────────────────────────────────────────────────

  private async submitQueued(
    instrument: InstrumentEntity,
    result: RewardsScanResult,
  ): Promise<void> {
    const rows = await this.grants.find({
      where: {
        status: In(["queued", "blocked_float"]),
        instrumentAdmin: instrument.admin,
        instrumentId: instrument.id,
      },
      order: { createdAt: "ASC", id: "ASC" },
      take: 100,
    });
    if (rows.length === 0) return;
    // The float rule reads the index; a stale one under-counts the liabilities, so nothing is
    // submitted until it caught up (the grants simply wait).
    try {
      await this.indexer.requireFresh();
    } catch (err) {
      result.skipped = `ledger_stale: ${(err as Error).message}`;
      this.logger.warn(
        `rewards: ${rows.length} grant(s) wait for the index: ${(err as Error).message}`,
      );
      return;
    }
    const state = await this.floatState(instrument);
    let mintedThisPass = result.minted !== null;
    for (const row of rows) {
      const shortfall = floatShortfall(state, row.amount);
      if (shortfall > 0n) {
        const minted = await this.blockForFloat(row, instrument, state, shortfall, !mintedThisPass);
        if (minted) {
          mintedThisPass = true;
          result.minted = minted;
        }
        result.blocked += 1;
        continue;
      }
      try {
        if (await this.submitGrant(row, instrument)) {
          state.pending += row.amount;
          result.submitted += 1;
        }
      } catch (err) {
        this.logger.warn(`grant ${row.id} could not be submitted: ${(err as Error).message}`);
        if (!(err instanceof ApiError))
          this.sentry.captureException(err, { processor: "rewards", grantId: row.id });
      }
    }
  }

  /**
   * Claim the row (`queued | blocked_float → submitted`, fresh attempt id), make sure the rewards
   * wallet exists, submit the `Grant`. A submit that throws leaves the row `submitted`: the
   * command may have reached the ledger, and only the confirm pass may decide (fail closed).
   */
  private async submitGrant(
    row: RewardGrantEntity,
    instrument: InstrumentEntity,
  ): Promise<boolean> {
    const instrumentId: InstrumentId = { admin: instrument.admin, id: instrument.id };
    const wallet =
      (await this.ledger.fetchUserWallet(row.party, instrumentId, { uncached: true })) ??
      (await this.deposits.ensureUserWallet(row.party, instrumentId));
    const commandId = grantCommandId(row.id, grantAttemptOf(row.commandId) + 1);
    const claimed = await this.grants.update(
      { id: row.id, status: In(["queued", "blocked_float"]) },
      { status: "submitted", commandId, submittedAt: new Date(), error: null },
    );
    if (!claimed.affected) return false;
    try {
      await this.wallet.externalSubmit({
        commandId,
        commands: [grantCommand(this.ledger.templateId("UserWallet"), wallet, row)],
      });
    } catch (err) {
      this.logger.warn(`grant submit ${commandId} failed: ${(err as Error).message}`);
    }
    return true;
  }

  /**
   * The grant waits: `blocked_float` with the figures in `error`; the first time, an audit row, a
   * Sentry message and `truthoracle.reward.blocked_float`. With `REWARDS_AUTO_MINT` (DevNet) and a
   * configured token-app, `max(shortfall, REWARDS_MINT_MIN)` is minted to the treasury once per
   * grant (`reward-float-<grantId>`) and once per pass — the index shows the new holding on the
   * next pass, which then submits. Returns the mint command id when it minted.
   */
  private async blockForFloat(
    row: RewardGrantEntity,
    instrument: InstrumentEntity,
    state: FloatState,
    shortfall: bigint,
    mayMint: boolean,
  ): Promise<string | null> {
    const figures = `holdings ${formatAmount(state.treasuryHoldings)}, liabilities ${formatAmount(state.liabilities)}, pending ${formatAmount(state.pending)}`;
    let error = `blocked_float: shortfall ${formatAmount(shortfall)} ${instrument.symbol} (${figures})`;
    let minted: string | null = null;
    const alreadyMinted = row.error?.includes("auto-mint") && row.error.includes("submitted");
    if (mayMint && this.config.rewardsAutoMint && this.tokenApp.isConfigured() && !alreadyMinted) {
      const amount = autoMintAmount(shortfall, this.config.rewardsMintMin, instrument.decimals);
      const commandId = autoMintCommandId(row.id);
      try {
        const res = await this.tokenApp.mint({
          commandId,
          instrumentId: instrument.id,
          partyId: this.treasury,
          amount,
          decimals: instrument.decimals,
        });
        error += `; auto-mint ${commandId} submitted (${formatAmount(amount)} ${instrument.symbol}, ${res.status})`;
        minted = commandId;
        await this.audit.record({
          actorType: "system",
          action: "token.mint",
          subjectType: "instrument",
          subjectId: `${instrument.admin}:${instrument.id}`,
          metadata: {
            commandId,
            status: res.status,
            instrument: { admin: instrument.admin, id: instrument.id },
            amount: formatAmount(amount),
            party: this.treasury,
            reason: `rewards float: grant ${row.id} short by ${formatAmount(shortfall)}`,
          },
        });
        void this.nats.publishSafe(NatsSubjects.tokenMinted, {
          commandId,
          instrument: { admin: instrument.admin, id: instrument.id },
          amount: formatAmount(amount),
          party: this.treasury,
          source: "rewards_float",
          grantId: row.id,
        });
        this.logger.log(
          `rewards float short by ${formatAmount(shortfall)} ${instrument.symbol}: minted ${formatAmount(amount)} to the treasury (${commandId})`,
        );
      } catch (err) {
        error += `; auto-mint failed: ${(err as Error).message}`.slice(0, 300);
        this.logger.warn(`rewards auto-mint for grant ${row.id} failed: ${(err as Error).message}`);
      }
    } else if (alreadyMinted && row.error) {
      // Keep the record of the mint already sent for this grant.
      error = row.error.replace(/^blocked_float:[^;]*/, error);
    }
    const first = row.status === "queued";
    await this.grants.update(
      { id: row.id, status: In(["queued", "blocked_float"]) },
      { status: "blocked_float", error: error.slice(0, 500) },
    );
    if (first) {
      await this.audit.record({
        actorType: "system",
        action: "reward.blocked_float",
        subjectType: "reward_grant",
        subjectId: row.id,
        metadata: {
          userId: row.userId,
          party: row.party,
          kind: row.kind,
          instrument: { admin: instrument.admin, id: instrument.id },
          amount: formatAmount(row.amount),
          shortfall: formatAmount(shortfall),
          treasuryHoldings: formatAmount(state.treasuryHoldings),
          liabilities: formatAmount(state.liabilities),
          pending: formatAmount(state.pending),
          autoMint: minted,
        },
      });
      this.sentry.captureMessage(
        "rewards grant blocked: treasury float does not cover it",
        "warning",
        {
          grantId: row.id,
          instrument: instrument.id,
        },
      );
      void this.nats.publishSafe(NatsSubjects.rewardBlockedFloat, {
        grantId: row.id,
        userId: row.userId,
        party: row.party,
        kind: row.kind,
        instrument: { admin: instrument.admin, id: instrument.id },
        amount: formatAmount(row.amount),
        shortfall: formatAmount(shortfall),
        autoMint: minted,
      });
      this.logger.warn(
        `grant ${row.id} (${formatAmount(row.amount)} ${instrument.symbol}) blocked: float short by ${formatAmount(shortfall)} (${figures})`,
      );
    }
    return minted;
  }

  // ── step 3: submitted → credited | queued again | failed ───────────────────────────────────

  private async confirmSubmitted(
    instrument: InstrumentEntity,
    result: RewardsScanResult,
  ): Promise<void> {
    const rows = await this.grants.find({
      where: {
        status: "submitted",
        instrumentAdmin: instrument.admin,
        instrumentId: instrument.id,
      },
      order: { submittedAt: "ASC" },
    });
    for (const row of rows) {
      try {
        const outcome = await this.confirmGrant(row, instrument);
        if (outcome === "credited") result.credited += 1;
        else if (outcome === "requeued") result.requeued += 1;
        else if (outcome === "failed") result.failed += 1;
      } catch (err) {
        this.logger.warn(`grant ${row.id} could not be confirmed: ${(err as Error).message}`);
        this.sentry.captureException(err, { processor: "rewards", grantId: row.id });
      }
    }
  }

  /**
   * THE confirmation rule, the deposit credit's: the Daml `Grant` appends `ref` to `creditRefs`
   * and refuses a repeat, so the wallet carrying the row's ref is the proof the grant landed.
   * Only a wallet still without the ref, past the grace period, with the command index reporting
   * the command failed or unknown, re-queues the grant for a fresh attempt (a stale wallet cid is
   * the usual cause: the user traded in between) — up to `MAX_GRANT_ATTEMPTS`, then `failed` for
   * an operator. Anything else is in flight and stays `submitted` (fail closed).
   */
  private async confirmGrant(
    row: RewardGrantEntity,
    instrument: InstrumentEntity,
  ): Promise<"credited" | "requeued" | "failed" | "pending"> {
    const instrumentId: InstrumentId = { admin: instrument.admin, id: instrument.id };
    const onLedger = await this.ledger.fetchUserWallet(row.party, instrumentId, { uncached: true });
    if (onLedger?.creditRefs.includes(row.ref))
      return (await this.markCredited(row, instrument, onLedger)) ? "credited" : "pending";
    if (!onLedger) return "pending";
    const ageMs = Date.now() - (row.submittedAt ?? row.createdAt).getTime();
    if (ageMs < this.config.depositConfirmGraceMs) return "pending";
    const status = await this.wallet.commandStatus(this.treasury, row.commandId ?? "");
    if (status.known && status.submitted) {
      this.logger.warn(
        `grant ${row.id}: wallet reports "${status.status ?? "submitted"}" but the ledger shows no ref after ${Math.round(ageMs / 1000)} s`,
      );
      this.sentry.captureMessage(
        "reward grant accepted by the wallet but absent from the ledger",
        "warning",
        {
          grantId: row.id,
          commandId: row.commandId ?? "",
        },
      );
      return "pending";
    }
    if (!status.known && status.status !== "not_found") return "pending";
    const reason = status.known
      ? `wallet reports the command as ${status.status ?? "failed"}`
      : "wallet does not know the command after the grace period";
    const attempts = grantAttemptOf(row.commandId);
    if (attempts < MAX_GRANT_ATTEMPTS) {
      const res = await this.grants.update(
        { id: row.id, status: "submitted" },
        { status: "queued", error: `attempt ${attempts}: ${reason}`.slice(0, 500) },
      );
      if (res.affected)
        this.logger.warn(`grant ${row.id} re-queued after attempt ${attempts}: ${reason}`);
      return res.affected ? "requeued" : "pending";
    }
    return (await this.markFailed(row, instrument, `${reason} (after ${attempts} attempts)`))
      ? "failed"
      : "pending";
  }

  private async markCredited(
    row: RewardGrantEntity,
    instrument: InstrumentEntity,
    onLedger: LedgerWallet,
  ): Promise<boolean> {
    const done = await this.dataSource.transaction(async (manager) => {
      const res = await manager
        .getRepository(RewardGrantEntity)
        .update(
          { id: row.id, status: "submitted" },
          { status: "credited", creditedAt: new Date(), error: null },
        );
      if (!res.affected) return false;
      await this.audit.record(
        {
          actorType: "system",
          action: "reward.granted",
          subjectType: "reward_grant",
          subjectId: row.id,
          metadata: {
            userId: row.userId,
            party: row.party,
            kind: row.kind,
            sourceEventId: row.sourceEventId,
            instrument: { admin: instrument.admin, id: instrument.id },
            amount: formatAmount(row.amount),
            commandId: row.commandId,
            ref: row.ref,
            walletContractId: onLedger.contractId,
          },
        },
        manager,
      );
      return true;
    });
    if (done) {
      this.logger.log(
        `grant ${row.id} credited: ${formatAmount(row.amount)} ${instrument.symbol} to ${row.party.slice(0, 24)}… (${row.kind})`,
      );
      void this.nats.publishSafe(NatsSubjects.rewardGranted, {
        grantId: row.id,
        userId: row.userId,
        party: row.party,
        kind: row.kind,
        sourceEventId: row.sourceEventId,
        instrument: { admin: instrument.admin, id: instrument.id },
        amount: formatAmount(row.amount),
        ref: row.ref,
      });
    }
    return done;
  }

  private async markFailed(
    row: RewardGrantEntity,
    instrument: InstrumentEntity,
    error: string,
  ): Promise<boolean> {
    const done = await this.dataSource.transaction(async (manager) => {
      const res = await manager
        .getRepository(RewardGrantEntity)
        .update(
          { id: row.id, status: "submitted" },
          { status: "failed", error: error.slice(0, 500) },
        );
      if (!res.affected) return false;
      await this.audit.record(
        {
          actorType: "system",
          action: "reward.failed",
          subjectType: "reward_grant",
          subjectId: row.id,
          metadata: {
            userId: row.userId,
            party: row.party,
            kind: row.kind,
            instrument: { admin: instrument.admin, id: instrument.id },
            amount: formatAmount(row.amount),
            commandId: row.commandId,
            error: error.slice(0, 200),
          },
        },
        manager,
      );
      return true;
    });
    if (done) {
      this.logger.warn(`grant ${row.id} marked failed: ${error}`);
      this.sentry.captureMessage("reward grant marked failed", "warning", { grantId: row.id });
    }
    return done;
  }
}

/** Type guard for the `?status=` filter. */
export function isRewardGrantStatus(value: string): value is RewardGrantStatus {
  return (REWARD_GRANT_STATUSES as readonly string[]).includes(value);
}
