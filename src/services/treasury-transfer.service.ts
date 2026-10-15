import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";

import { Config } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import { LedgerHoldingEntity } from "../entities/ledger-holding.entity";
import {
  interfaceFilterId,
  TRANSFER_FACTORY_CHOICE,
  TRANSFER_FACTORY_INTERFACE,
} from "../indexer/token-standard";
import {
  type Actor,
  type ApiExerciseCommand,
  type ApiInstrumentSetupResult,
  type InstrumentId,
  type TreasuryTransferMode,
  type TreasuryTransferRequest,
  type TreasuryTransferResult,
} from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, parseAmount } from "../util/money";
import { AuditService } from "./audit.service";
import { EnterpriseWalletService, type TransferStatusResult } from "./enterprise-wallet.service";
import { InstrumentsService } from "./instruments.service";
import { TokenRegistryService } from "./token-registry.service";

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested in treasury-transfer.service.spec.ts)
// ---------------------------------------------------------------------------------------------

/** What `selectHoldings` needs to know about a holding of the treasury. */
export interface SpendableHolding {
  contractId: string;
  amount: bigint;
  locked: boolean;
  lockExpiresAt: Date | null;
}

/** A holding can fund a transfer when it carries no lock, or a lock that has already expired. */
export function isSpendable(h: SpendableHolding, now: Date): boolean {
  if (!h.locked) return true;
  return h.lockExpiresAt !== null && h.lockExpiresAt.getTime() <= now.getTime();
}

/**
 * The input holdings of a registry-mode transfer (docs/TOKENS.md §4.4): the treasury's spendable
 * holdings of the instrument, largest first, until they cover `amount`. Largest first keeps the
 * input list short (every input is a contract the command consumes) and leaves the small change
 * holdings to be merged by a later transfer. `null` when the holdings do not cover the amount —
 * the caller answers `409 insufficient_treasury_holdings`; `total` is what was selected.
 */
export function selectHoldings(
  holdings: SpendableHolding[],
  amount: bigint,
  now: Date,
): { contractIds: string[]; total: bigint } | null {
  if (amount <= 0n) return { contractIds: [], total: 0n };
  const spendable = holdings
    .filter((h) => isSpendable(h, now) && h.amount > 0n)
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  const contractIds: string[] = [];
  let total = 0n;
  for (const h of spendable) {
    contractIds.push(h.contractId);
    total += h.amount;
    if (total >= amount) return { contractIds, total };
  }
  return null;
}

/** Daml `Time` as the JSON Ledger API takes it: ISO-8601 with microseconds. */
export function damlTime(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

export interface TransferFactoryArgumentInput {
  admin: string;
  sender: string;
  receiver: string;
  instrument: InstrumentId;
  amount: bigint;
  inputHoldingCids: string[];
  requestedAt: Date;
  executeBefore: Date;
  /** `transfer.meta.values` — what the receiver's wallet shows (reason, payout reference). */
  meta: Record<string, string>;
  /** `extraArgs.context` — the registry's `choiceContextData`; `{ values: {} }` for the factory lookup. */
  context: Record<string, unknown>;
}

/**
 * The `TransferFactory_Transfer` choice argument (`Splice.Api.Token.TransferInstructionV1`):
 * `expectedAdmin` pins the instrument's admin so a factory of another token is refused, the
 * `transfer` record names the parties, the amount, the instrument, the validity window and the
 * holdings to spend and, on `transfer.meta`, our metadata; `extraArgs` carries the registry's
 * context and an empty `meta`. The reason and the payout reference ride on `transfer.meta` rather
 * than on `extraArgs.meta` (docs/TOKENS.md §10): the standard's `Transfer.meta` is part of the
 * `transfer` record every `TransferInstructionView` exposes to sender and receiver, so the
 * receiver's wallet shows the memo, while `ExtraArgs.meta` is caller-to-implementer input whose
 * meaning the standard leaves to be agreed case by case — and no registry has agreed on ours.
 * Amounts are 10-dp strings, times ISO-8601 — what the JSON Ledger API encodes a Daml `Decimal` /
 * `Time` as.
 */
export function transferFactoryArgument(
  input: TransferFactoryArgumentInput,
): Record<string, unknown> {
  return {
    expectedAdmin: input.admin,
    transfer: {
      sender: input.sender,
      receiver: input.receiver,
      amount: formatAmount(input.amount),
      instrumentId: { admin: input.instrument.admin, id: input.instrument.id },
      requestedAt: damlTime(input.requestedAt),
      executeBefore: damlTime(input.executeBefore),
      inputHoldingCids: [...input.inputHoldingCids],
      meta: { values: { ...input.meta } },
    },
    extraArgs: { context: input.context, meta: { values: {} } },
  };
}

/** The interface exercise the Enterprise Wallet submits: the factory's `TransferFactory_Transfer` through the TransferFactory interface id. */
export function transferFactoryCommand(
  factoryId: string,
  choiceArgument: Record<string, unknown>,
): ApiExerciseCommand {
  return {
    ExerciseCommand: {
      templateId: interfaceFilterId(TRANSFER_FACTORY_INTERFACE),
      contractId: factoryId,
      choice: TRANSFER_FACTORY_CHOICE,
      choiceArgument,
    },
  };
}

/** Metadata keys follow the token standard's `<app>/<key>` convention. */
export function transferMeta(
  reason: string,
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { "truthoracle/reason": reason };
  for (const [k, v] of Object.entries(metadata ?? {})) out[`truthoracle/${k}`] = v;
  return out;
}

const SETUP_DEFAULT_CHOICES = {
  autoAccept: "CreateAutoAccept",
  mintDelegation: "CreateMintDelegation",
} as const;
type SetupKind = keyof typeof SETUP_DEFAULT_CHOICES;

/** `setup-<kind>-<sha256(admin|id|treasury)[:40]>`: one Create per instrument, action and treasury — a repeat collides on command dedup. */
export function setupCommandId(
  kind: SetupKind,
  instrument: InstrumentId,
  treasury: string,
): string {
  return `setup-${kind.toLowerCase()}-${createHash("sha256")
    .update(`${instrument.admin}|${instrument.id}|${treasury}`)
    .digest("hex")
    .slice(0, 40)}`;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

/**
 * The one way an instrument leaves the treasury (docs/TOKENS.md §2 decision 6, §4.4). Two
 * modes, chosen per instrument (`to_instruments.transfer_mode`, else `TREASURY_TRANSFER_MODE`):
 *
 * - `wallet`: the Enterprise Wallet's own `POST /api/v1/transfer` with the instrument's wallet id
 *   — the wallet picks the inputs and the factory itself. Status: its transfer index.
 * - `registry`: the backend builds `TransferFactory_Transfer` from the instrument's CIP-56
 *   registry (factory + choice context + disclosed contracts), spends the treasury's unlocked
 *   holdings from the index (largest first; `409 insufficient_treasury_holdings` when they do
 *   not cover the amount) and submits through `externalSubmit`. Status: the wallet's command
 *   index. This is how a token the Enterprise Wallet does not list yet is still paid out.
 *
 * Amounts arrive already quantised to the instrument's decimals (PayoutService does that and
 * records the dust); the command id is the caller's idempotency key, so a retry of a settlement
 * collides on ledger command-dedup instead of paying twice.
 */
@Injectable()
export class TreasuryTransferService {
  private readonly logger = new Logger(TreasuryTransferService.name);

  constructor(
    private readonly config: Config,
    @InjectRepository(LedgerHoldingEntity)
    private readonly holdings: Repository<LedgerHoldingEntity>,
    private readonly wallet: EnterpriseWalletService,
    private readonly registry: TokenRegistryService,
    private readonly instruments: InstrumentsService,
    private readonly audit: AuditService,
  ) {}

  private get treasury(): string {
    const treasury = this.config.treasuryPartyId;
    if (!treasury)
      throw new ApiError(502, "upstream_failed", "TREASURY_PARTY_ID is not configured");
    return treasury;
  }

  /** The mode a transfer of `instrument` uses right now (the row's override, else the process default). */
  async modeFor(instrument: InstrumentId): Promise<TreasuryTransferMode> {
    const row = await this.instruments.get(instrument.admin, instrument.id);
    return row ? this.instruments.transferModeOf(row) : this.config.treasuryTransferMode;
  }

  /** `404 instrument_unknown` / `409 instrument_disabled` before any upstream call: a disabled token never leaves. */
  async transfer(req: TreasuryTransferRequest): Promise<TreasuryTransferResult> {
    if (req.amount <= 0n)
      throw new ApiError(400, "validation_failed", "a transfer amount must be positive");
    const instrument = await this.instruments.requireEnabled(req.instrument);
    const mode = this.instruments.transferModeOf(instrument);
    if (mode === "wallet") {
      const res = await this.wallet.transfer({
        to: req.to,
        instrumentId: instrument.walletInstrumentId,
        amount: req.amount,
        reason: req.reason,
        commandId: req.commandId,
        metadata: req.metadata,
      });
      return { commandId: req.commandId, mode, status: res.status };
    }
    return this.transferThroughRegistry(instrument, req);
  }

  /**
   * The status of a transfer submitted earlier: the wallet's transfer index for `wallet` mode,
   * its command index for `registry` mode (an `externalSubmit`). The two indexes have different
   * failure semantics (`EnterpriseWalletService`): callers already branch on `known` / `submitted`.
   */
  status(mode: TreasuryTransferMode, commandId: string): Promise<TransferStatusResult> {
    return mode === "wallet"
      ? this.wallet.transferStatus(this.treasury, commandId)
      : this.wallet.commandStatus(this.treasury, commandId);
  }

  /** The treasury's active holdings of `instrument` as the index holds them (spendable or not). */
  async treasuryHoldings(instrument: InstrumentId): Promise<LedgerHoldingEntity[]> {
    return this.holdings.find({
      where: {
        owner: this.treasury,
        instrumentAdmin: instrument.admin,
        instrumentId: instrument.id,
        archivedOffset: IsNull(),
      },
      order: { amount: "DESC" },
    });
  }

  /**
   * The treasury's float in `instrument` against what the in-app wallets owe, both from the index
   * (docs/TOKENS.md §4.6 float rule, §4.7 `GET /admin/tokens/status`): Σ of the treasury's active
   * holdings, and Σ `UserWallet.balance` of every active wallet in the instrument. Canton Coin
   * counts the same way — its Amulets are indexed as holdings (docs/INDEXER.md §6).
   */
  async indexedBalances(
    instrument: InstrumentId,
  ): Promise<{ treasuryHoldings: bigint; liabilities: bigint }> {
    const [held] = await this.holdings.manager.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM to_ledger_holdings
        WHERE owner = $1 AND instrument_admin = $2 AND instrument_id = $3 AND archived_offset IS NULL`,
      [this.treasury, instrument.admin, instrument.id],
    );
    const [owed] = await this.holdings.manager.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(balance), 0)::text AS total
         FROM to_ledger_wallets
        WHERE instrument_admin = $1 AND instrument_id = $2 AND active = true`,
      [instrument.admin, instrument.id],
    );
    return { treasuryHoldings: parseAmount(held.total), liabilities: parseAmount(owed.total) };
  }

  private async transferThroughRegistry(
    instrument: InstrumentEntity,
    req: TreasuryTransferRequest,
  ): Promise<TreasuryTransferResult> {
    const treasury = this.treasury;
    const now = new Date();
    const held = await this.treasuryHoldings(instrument);
    const selected = selectHoldings(held, req.amount, now);
    if (!selected) {
      const spendable = held.filter((h) => isSpendable(h, now)).reduce((s, h) => s + h.amount, 0n);
      throw new ApiError(
        409,
        "insufficient_treasury_holdings",
        `the treasury holds ${formatAmount(spendable)} spendable ${instrument.symbol} in the index, ${formatAmount(req.amount)} requested`,
        {
          instrument: { admin: instrument.admin, id: instrument.id },
          requested: formatAmount(req.amount),
          spendable: formatAmount(spendable),
          holdings: held.length,
        },
      );
    }
    const base: Omit<TransferFactoryArgumentInput, "context"> = {
      admin: instrument.admin,
      sender: treasury,
      receiver: req.to,
      instrument: { admin: instrument.admin, id: instrument.id },
      amount: req.amount,
      inputHoldingCids: selected.contractIds,
      requestedAt: now,
      executeBefore: new Date(now.getTime() + this.config.treasuryTransferTtlSec * 1000),
      meta: transferMeta(req.reason, req.metadata),
    };
    // The registry decides the factory and computes the context for THIS argument (fees, rules
    // version); the submitted argument differs only by that context.
    const factory = await this.registry.transferFactory(
      instrument,
      transferFactoryArgument({ ...base, context: { values: {} } }),
    );
    const command = transferFactoryCommand(
      factory.factoryId,
      transferFactoryArgument({ ...base, context: factory.choiceContext.choiceContextData }),
    );
    const res = await this.wallet.externalSubmit({
      commandId: req.commandId,
      commands: [command],
      disclosedContracts: factory.choiceContext.disclosedContracts,
    });
    this.logger.log(
      `registry transfer ${req.commandId}: ${formatAmount(req.amount)} ${instrument.symbol} to ${req.to.slice(0, 24)}… via factory ${factory.factoryId.slice(0, 16)}… (${factory.transferKind}, ${selected.contractIds.length} input(s))`,
    );
    return { commandId: req.commandId, mode: "registry", status: res.status };
  }

  // ───────────────────────────────────────────── setup action ────────────────────────────────

  /**
   * `POST /admin/instruments/:admin/:id/setup` (docs/TOKENS.md §4.4): what a Cantor8 token needs
   * from the treasury once — an `AutoAccept` so incoming transfers land without a two-step
   * accept, a `MintDelegation` so token-app may mint to the treasury. The registry's
   * transfer-factory lookup for a self-transfer of 0 names the factory contract and discloses it,
   * which is how its concrete template id is learnt; the configured choice (per token package,
   * `to_instruments.setup_choices`) is then exercised on it as the treasury. Not applicable to
   * Canton Coin (the Enterprise Wallet account pre-approves Amulet transfers). Audited `token.setup`.
   */
  async setup(
    instrument: InstrumentEntity,
    actions: { autoAccept?: boolean; mintDelegation?: boolean },
    actor: Actor,
    reason?: string,
  ): Promise<ApiInstrumentSetupResult> {
    const kinds = (Object.keys(SETUP_DEFAULT_CHOICES) as SetupKind[]).filter((k) => actions[k]);
    if (kinds.length === 0)
      throw new ApiError(
        400,
        "validation_failed",
        "name at least one of autoAccept, mintDelegation",
      );
    const treasury = this.treasury;
    const ref: InstrumentId = { admin: instrument.admin, id: instrument.id };
    const now = new Date();
    const factory = await this.registry.transferFactory(
      instrument,
      transferFactoryArgument({
        admin: instrument.admin,
        sender: treasury,
        receiver: treasury,
        instrument: ref,
        amount: 0n,
        inputHoldingCids: [],
        requestedAt: now,
        executeBefore: new Date(now.getTime() + this.config.treasuryTransferTtlSec * 1000),
        meta: { "truthoracle/reason": "setup" },
        context: { values: {} },
      }),
    );
    const disclosedFactory = factory.choiceContext.disclosedContracts.find(
      (d) => d.contractId === factory.factoryId,
    );
    if (!disclosedFactory)
      throw new ApiError(
        502,
        "upstream_failed",
        `registry of ${instrument.symbol} did not disclose the factory contract ${factory.factoryId}; its template cannot be learnt`,
      );
    const result: ApiInstrumentSetupResult = {
      instrument: this.instruments.toRef(instrument),
      factoryId: factory.factoryId,
      factoryTemplateId: disclosedFactory.templateId,
      actions: [],
    };
    for (const kind of kinds) {
      const choice = instrument.setupChoices?.[kind] || SETUP_DEFAULT_CHOICES[kind];
      const commandId = setupCommandId(kind, ref, treasury);
      const choiceArgument =
        kind === "autoAccept" ? { receiver: treasury } : { recipient: treasury };
      const res = await this.wallet.externalSubmit({
        commandId,
        commands: [
          {
            ExerciseCommand: {
              templateId: disclosedFactory.templateId,
              contractId: factory.factoryId,
              choice,
              choiceArgument,
            },
          },
        ],
        disclosedContracts: factory.choiceContext.disclosedContracts,
      });
      await this.audit.record({
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        actorSessionId: actor.sessionId ?? null,
        action: "token.setup",
        subjectType: "instrument",
        subjectId: `${instrument.admin}:${instrument.id}`,
        metadata: {
          reason,
          kind,
          choice,
          commandId,
          factoryId: factory.factoryId,
          factoryTemplateId: disclosedFactory.templateId,
          status: res.status,
        },
        ip: actor.ip ?? null,
      });
      this.logger.log(
        `instrument ${instrument.symbol}: ${choice} exercised on factory ${factory.factoryId.slice(0, 16)}… (${commandId}, ${res.status})`,
      );
      result.actions.push({ kind, choice, commandId, status: res.status });
    }
    return result;
  }
}
