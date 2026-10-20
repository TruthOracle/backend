import { randomBytes } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import type { TokenCommandEntity, TokenCommandKind } from "../entities/token-command.entity";
import {
  NatsSubjects,
  type Actor,
  type ApiTokenMintResult,
  type ApiTokenStatus,
  type ErrorCode,
  type InstrumentId,
} from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, parseAmount, quantizeDown } from "../util/money";
import { AuditService } from "./audit.service";
import { ComplianceFreezePort } from "./compliance-freeze.port";
import { DepositService, mintCreditCommandId, mintCreditTxRef } from "./deposit.service";
import { InstrumentsService } from "./instruments.service";
import { LedgerClientService } from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { TokenAppSyncService } from "./token-app-sync.service";
import { TokenAppService } from "./token-app.service";
import { TokenCommandService } from "./token-command.service";
import { TreasuryTransferService } from "./treasury-transfer.service";
import { UserService } from "./user.service";

const SYSTEM: Actor = { type: "system" };
/** Mint-and-credit Deposits finished per sync pass. */
const CREDITS_PER_PASS = 20;

/** `mint-<24 hex>` / `burn-<24 hex>`: one token-app command per operator request (a repeat IS a second mint). */
export function tokenCommandId(kind: "mint" | "burn"): string {
  return `${kind}-${randomBytes(12).toString("hex")}`;
}

/** `credit:<userId>` — the ref of an admin mint whose Deposit the token sync submits once token-app records it. */
export const CREDIT_REF_PREFIX = "credit:";

/** What a direct route may do without an approval, and what an approval execute (S4) passes. */
export interface TokenOperationOptions {
  /** The four-eyes approval (`token.admin_mint|burn`) this runs under; required on mainnet. */
  approvalId?: string | null;
}

/**
 * The operator's token operations (docs/TOKENS.md §4.7; docs/RAMP.md §7): mint and burn through
 * Cantor8's token-app, recorded in the command ledger before they are sent; the mint-and-credit
 * on-ramp, whose `UserWallet.Deposit { amount, txRef = "mint:<commandId>" }` is submitted only
 * once token-app RECORDED the mint (the token sync's pass hook, `completePendingCredits`) — never
 * on the strength of a POST alone (T-D5); and the status view.
 *
 * On mainnet: the ramp instrument is never minted or burned here (403 — only the ramp does);
 * any other instrument needs the four-eyes approval `token.admin_mint|burn` (S4 passes its id);
 * mint-and-credit is refused. Every precondition of a credit — the account, its primary party,
 * its wallet in the instrument — is settled BEFORE the mint. Everything is audited (`token.mint`,
 * `token.burn`) and announced (`truthoracle.token.minted` / `.burned`).
 */
@Injectable()
export class TokenOperationsService implements OnModuleInit {
  private readonly logger = new Logger(TokenOperationsService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly instruments: InstrumentsService,
    private readonly tokenApp: TokenAppService,
    private readonly commands: TokenCommandService,
    private readonly sync: TokenAppSyncService,
    private readonly treasuryTransfers: TreasuryTransferService,
    private readonly deposits: DepositService,
    private readonly users: UserService,
    private readonly ledger: LedgerClientService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
    private readonly freeze: ComplianceFreezePort,
  ) {}

  onModuleInit(): void {
    this.sync.onPass(async () => {
      await this.completePendingCredits();
    }, "admin-mint-credit");
  }

  private get treasury(): string {
    const treasury = this.config.treasuryPartyId;
    if (!treasury)
      throw new ApiError(502, "upstream_failed", "TREASURY_PARTY_ID is not configured");
    return treasury;
  }

  /**
   * `POST /admin/tokens/mint`. `to` omitted or `"treasury"` mints to the treasury; a party mints
   * to that party (cBYN: it needs a MintDelegation). `creditUserId` requires the treasury as the
   * target and an active account with a primary party (`404 not_found`, `403 user_suspended`,
   * `409 no_primary_wallet`, `409 kyc_duplicate_identity`); its wallet in the instrument is
   * created first and the answer's `credit` is `pending` — the Deposit follows the mint's record.
   * `409 token_app_cap` before anything is written; a refused or unconfirmed POST answers its
   * code with `details.mint` (the command row stays: an unconfirmed one may still land).
   */
  async mint(
    input: {
      instrument: InstrumentId;
      amount: bigint;
      to?: string;
      creditUserId?: string;
      reason: string;
    },
    actor: Actor,
    opts: TokenOperationOptions = {},
  ): Promise<ApiTokenMintResult> {
    const row = await this.instruments.requireEnabled(input.instrument);
    const amount = this.requireAmount(input.amount, row);
    this.requireTokenApp();
    await this.requireMainnetGate("mint", row, Boolean(input.creditUserId), opts);
    const treasury = this.treasury;
    const party = !input.to || input.to === "treasury" ? treasury : input.to;
    let creditUserId: string | null = null;
    if (input.creditUserId) {
      if (party !== treasury)
        throw new ApiError(
          400,
          "validation_failed",
          "creditUserId needs the mint to land on the treasury (omit `to` or set it to `treasury`)",
        );
      const user = await this.users.findById(input.creditUserId);
      if (!user) throw new ApiError(404, "not_found", "user not found");
      if (user.status !== "active")
        throw new ApiError(403, "user_suspended", "this account is suspended");
      if (!user.partyId)
        throw new ApiError(409, "no_primary_wallet", "the account has no primary wallet");
      if (user.kycStatus === "blocked_duplicate")
        throw new ApiError(
          409,
          "kyc_duplicate_identity",
          "credits are disabled while an identity verification conflict is open",
        );
      const instrumentId: InstrumentId = { admin: row.admin, id: row.id };
      if (!(await this.ledger.fetchUserWallet(user.partyId, instrumentId, { uncached: true })))
        await this.deposits.ensureUserWallet(user.partyId, instrumentId);
      creditUserId = user.id;
    }
    const command = await this.send("mint", row, party, amount, {
      ref: creditUserId
        ? `${CREDIT_REF_PREFIX}${creditUserId}`
        : `admin:${actor.userId ?? "system"}`,
      actor,
      reason: input.reason,
      approvalId: opts.approvalId ?? null,
      creditUserId,
    });
    return {
      commandId: command.commandId,
      status: command.status,
      instrument: this.instruments.toRef(row),
      amount: formatAmount(amount),
      party,
      credit: creditUserId
        ? {
            commandId: mintCreditCommandId(command.commandId),
            txRef: mintCreditTxRef(command.commandId),
            status: "pending",
          }
        : null,
    };
  }

  /** `POST /admin/tokens/burn` — burn `amount` of a registered instrument (disabled ones included: winding a token down is the point) held by `party`. */
  async burn(
    input: { instrument: InstrumentId; amount: bigint; party: string; reason: string },
    actor: Actor,
    opts: TokenOperationOptions = {},
  ): Promise<ApiTokenMintResult> {
    const row = await this.instruments.require(input.instrument.admin, input.instrument.id);
    const amount = this.requireAmount(input.amount, row);
    this.requireTokenApp();
    await this.requireMainnetGate("burn", row, false, opts);
    const command = await this.send("burn", row, input.party, amount, {
      ref: `admin:${actor.userId ?? "system"}`,
      actor,
      reason: input.reason,
      approvalId: opts.approvalId ?? null,
      creditUserId: null,
    });
    return {
      commandId: command.commandId,
      status: command.status,
      instrument: this.instruments.toRef(row),
      amount: formatAmount(amount),
      party: input.party,
      credit: null,
    };
  }

  /**
   * Caps, then the command row (its own transaction), then one POST. Answers the row when
   * token-app accepted it; otherwise throws the outcome's code with `details.<kind>` — the row
   * stays as the record of what may or may not have happened.
   */
  private async send(
    kind: TokenCommandKind,
    row: InstrumentEntity,
    party: string,
    amount: bigint,
    ctx: {
      ref: string;
      actor: Actor;
      reason: string;
      approvalId: string | null;
      creditUserId: string | null;
    },
  ): Promise<TokenCommandEntity> {
    const instrument: InstrumentId = { admin: row.admin, id: row.id };
    await this.commands.requireCaps(kind, instrument, amount);
    const commandId = tokenCommandId(kind);
    await this.dataSource.transaction((manager) =>
      this.commands.recordIntent(manager, {
        commandId,
        kind,
        instrument,
        party,
        amount,
        source: "admin",
        ref: ctx.ref,
      }),
    );
    const command = await this.commands.submit(commandId);
    await this.audit.record({
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId ?? null,
      actorSessionId: ctx.actor.sessionId ?? null,
      action: kind === "mint" ? "token.mint" : "token.burn",
      subjectType: "instrument",
      subjectId: `${row.admin}:${row.id}`,
      metadata: {
        commandId,
        status: command.status,
        instrument,
        amount: formatAmount(amount),
        party,
        ...(kind === "mint" ? { creditUserId: ctx.creditUserId } : {}),
        reason: ctx.reason,
        approvalId: ctx.approvalId,
      },
      ip: ctx.actor.ip ?? null,
    });
    if (command.status === "submitted") {
      void this.nats.publishSafe(
        kind === "mint" ? NatsSubjects.tokenMinted : NatsSubjects.tokenBurned,
        {
          commandId,
          instrument,
          amount: formatAmount(amount),
          party,
          ...(kind === "mint" ? { creditUserId: ctx.creditUserId } : {}),
          source: "admin",
        },
      );
      this.logger.log(
        `${kind} ${formatAmount(amount)} ${row.symbol} ${kind === "mint" ? "to" : "held by"} ${party.slice(0, 24)}… (${commandId}, submitted)`,
      );
      return command;
    }
    const code = errorCodeOf(command.lastError);
    const outcome =
      command.status === "unknown"
        ? "was not confirmed; it may still land and the token sync will record it"
        : command.status === "rejected"
          ? "was refused"
          : "was not sent";
    throw new ApiError(
      code === "token_app_unconfigured" ? 503 : code === "token_app_cap" ? 409 : 502,
      code,
      `token-app ${kind} ${commandId} ${outcome}: ${command.lastError ?? ""}`.slice(0, 500),
      { [kind]: { commandId, status: command.status, amount: formatAmount(amount), party } },
    );
  }

  /**
   * Mint-and-credit, second half (a token sync pass hook): Deposit every admin mint with a
   * `credit:<userId>` ref that token-app has RECORDED and whose credit is neither confirmed nor
   * in flight. Idempotent per mint (`DepositService.creditMint` keys its row on the mint's id); an
   * account that is no longer active, or whose KYC conflicts, waits for an operator.
   */
  async completePendingCredits(limit = CREDITS_PER_PASS): Promise<number> {
    const rows = await this.dataSource.query<
      {
        command_id: string;
        ref: string;
        instrument_admin: string;
        instrument_id: string;
        amount: string;
      }[]
    >(
      `SELECT c.command_id, c.ref, c.instrument_admin, c.instrument_id, c.amount::text AS amount
         FROM to_token_commands c
        WHERE c.source = 'admin' AND c.kind = 'mint' AND c.status = 'recorded' AND c.ref LIKE 'credit:%'
          AND NOT EXISTS (SELECT 1 FROM to_deposit_credits d
                           WHERE d.tx_ref = 'mint:' || c.command_id AND d.status IN ('confirmed', 'submitted'))
        ORDER BY c.recorded_at ASC, c.command_id ASC
        LIMIT $1`,
      [limit],
    );
    let credited = 0;
    for (const r of rows) {
      const userId = r.ref.slice(CREDIT_REF_PREFIX.length);
      const user = await this.users.findById(userId);
      // SPEC §11.6 (B3): nothing is credited into a frozen account; the minted tokens wait in the treasury.
      if (
        !user ||
        user.status !== "active" ||
        user.kycStatus === "blocked_duplicate" ||
        (await this.freeze.isFrozen(userId))
      ) {
        this.logger.warn(`mint ${r.command_id}: account ${userId} cannot be credited now; waiting`);
        continue;
      }
      try {
        await this.deposits.creditMint({
          userId,
          instrument: { admin: r.instrument_admin, id: r.instrument_id },
          amount: parseAmount(r.amount),
          mintCommandId: r.command_id,
          actor: SYSTEM,
        });
        credited += 1;
      } catch (err) {
        this.logger.warn(
          `mint ${r.command_id}: credit failed (${(err as Error).message}); next pass retries`,
        );
      }
    }
    return credited;
  }

  /** `GET /admin/tokens/status`: token-app's `/status` (never a throw) plus the index's float per registered instrument, disabled ones included. */
  async status(): Promise<ApiTokenStatus> {
    const [tokenApp, rows] = await Promise.all([
      this.tokenApp.status(),
      this.instruments.list({ includeDisabled: true }),
    ]);
    const instruments: ApiTokenStatus["instruments"] = [];
    for (const row of rows) {
      const balances = await this.treasuryTransfers.indexedBalances(row);
      instruments.push({
        instrument: this.instruments.toRef(row),
        treasuryHoldings: formatAmount(balances.treasuryHoldings),
        liabilities: formatAmount(balances.liabilities),
        pendingPayouts: formatAmount(balances.pendingPayouts),
      });
    }
    return { tokenApp, instruments };
  }

  /** Positive and whole in the instrument's decimals — token-app refuses finer amounts, so the operator hears it first. */
  private requireAmount(amount: bigint, row: InstrumentEntity): bigint {
    if (amount <= 0n) throw new ApiError(400, "validation_failed", "amount must be positive");
    if (quantizeDown(amount, row.decimals) !== amount)
      throw new ApiError(
        400,
        "validation_failed",
        `${row.symbol} carries ${row.decimals} decimals; the amount is finer than that`,
      );
    return amount;
  }

  /** Checked before any state changes, so a missing token-app is a clean 503 and not a half-done operation. */
  private requireTokenApp(): void {
    if (!this.tokenApp.isConfigured())
      throw new ApiError(
        503,
        "token_app_unconfigured",
        "token-app is not configured (TOKEN_APP_URL and its Keycloak client)",
      );
  }

  /**
   * Mainnet (SPEC §7, T-D5, X12 d): the ramp instrument is the ramp's alone — 403 always;
   * mint-and-credit is refused; anything else runs only under a four-eyes approval.
   */
  private async requireMainnetGate(
    kind: TokenCommandKind,
    row: InstrumentEntity,
    withCredit: boolean,
    opts: TokenOperationOptions,
  ): Promise<void> {
    if (!this.config.isMainnet) return;
    const ramp = await this.sync.rampInstrument();
    if (ramp && ramp.admin === row.admin && ramp.id === row.id)
      throw new ApiError(
        403,
        "forbidden",
        `${row.symbol} is the ramp instrument: on mainnet only the ramp mints and burns it`,
      );
    if (withCredit) throw new ApiError(403, "forbidden", "mint-and-credit is refused on mainnet");
    if (!opts.approvalId)
      throw new ApiError(
        403,
        "forbidden",
        `on mainnet an operator ${kind} of ${row.symbol} runs only under the four-eyes approval token.admin_${kind}`,
        { approvalAction: `token.admin_${kind}` },
      );
  }
}

const KNOWN_CODES = new Set<string>([
  "token_app_unconfigured",
  "token_app_unauthorized",
  "token_app_forbidden",
  "token_app_invalid_request",
  "token_app_cap",
  "validation_failed",
  "forbidden",
  "upstream_failed",
]);

/** The error code a command row's `last_error` starts with (`<code>: <message>`), else `upstream_failed`. */
function errorCodeOf(lastError: string | null): ErrorCode {
  const m = /^([a-z_]+):/.exec(lastError ?? "");
  return m && KNOWN_CODES.has(m[1]) ? (m[1] as ErrorCode) : "upstream_failed";
}
