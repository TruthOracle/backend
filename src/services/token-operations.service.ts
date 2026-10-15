import { randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";

import { Config } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import {
  NatsSubjects,
  type Actor,
  type ApiTokenMintResult,
  type ApiTokenStatus,
  type InstrumentId,
} from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, quantizeDown } from "../util/money";
import { AuditService } from "./audit.service";
import { DepositService } from "./deposit.service";
import { InstrumentsService } from "./instruments.service";
import { LedgerClientService } from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { TokenAppService } from "./token-app.service";
import { TreasuryTransferService } from "./treasury-transfer.service";
import { UserService } from "./user.service";

/** `mint-<24 hex>` / `burn-<24 hex>`: one token-app command per operator request (a repeat IS a second mint). */
export function tokenCommandId(kind: "mint" | "burn"): string {
  return `${kind}-${randomBytes(12).toString("hex")}`;
}

/**
 * The operator's token operations (docs/TOKENS.md §4.7): mint and burn through Cantor8's
 * token-app, the mint-and-credit on-ramp (`UserWallet.Deposit { amount, txRef = "mint:<commandId>" }`
 * on an account's wallet right after the mint landed on the treasury), and the status view that
 * puts token-app's own snapshot next to the index's float per instrument. Every preconditon of a
 * credit — the account, its primary party, its wallet in the instrument — is settled BEFORE the
 * mint, so the only step a failure can leave behind is the credit itself, which the deposit
 * machinery (write-ahead row, confirm pass) finishes. Everything is audited (`token.mint`,
 * `token.burn`) and announced (`truthoracle.token.minted` / `.burned`).
 */
@Injectable()
export class TokenOperationsService {
  private readonly logger = new Logger(TokenOperationsService.name);

  constructor(
    private readonly config: Config,
    private readonly instruments: InstrumentsService,
    private readonly tokenApp: TokenAppService,
    private readonly treasuryTransfers: TreasuryTransferService,
    private readonly deposits: DepositService,
    private readonly users: UserService,
    private readonly ledger: LedgerClientService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

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
   * created first. When the credit step fails after the mint, the error names the mint
   * (`details.mint`) — the tokens are on the treasury, and a `mint:` write-ahead row, if one was
   * written, is finished by the confirm pass.
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
  ): Promise<ApiTokenMintResult> {
    const row = await this.instruments.requireEnabled(input.instrument);
    const amount = this.requireAmount(input.amount, row);
    this.requireTokenApp();
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

    const commandId = tokenCommandId("mint");
    const res = await this.tokenApp.mint({
      commandId,
      instrumentId: row.id,
      partyId: party,
      amount,
      decimals: row.decimals,
    });
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "token.mint",
      subjectType: "instrument",
      subjectId: `${row.admin}:${row.id}`,
      metadata: {
        commandId,
        status: res.status,
        instrument: { admin: row.admin, id: row.id },
        amount: formatAmount(amount),
        party,
        creditUserId,
        reason: input.reason,
      },
      ip: actor.ip ?? null,
    });
    void this.nats.publishSafe(NatsSubjects.tokenMinted, {
      commandId,
      instrument: { admin: row.admin, id: row.id },
      amount: formatAmount(amount),
      party,
      creditUserId,
      source: "admin",
    });
    this.logger.log(
      `minted ${formatAmount(amount)} ${row.symbol} to ${party.slice(0, 24)}… (${commandId}, ${res.status})`,
    );

    let credit: ApiTokenMintResult["credit"] = null;
    if (creditUserId) {
      try {
        credit = await this.deposits.creditMint({
          userId: creditUserId,
          instrument: { admin: row.admin, id: row.id },
          amount,
          mintCommandId: commandId,
          actor,
        });
      } catch (err) {
        const base = ApiError.is(err)
          ? err
          : new ApiError(
              502,
              "upstream_failed",
              `the credit after the mint failed: ${err instanceof Error ? err.message : "unknown error"}`,
            );
        throw new ApiError(base.status, base.code, base.message, {
          ...(base.details ?? {}),
          mint: { commandId, status: res.status, amount: formatAmount(amount), party },
        });
      }
    }
    return {
      commandId,
      status: res.status,
      instrument: this.instruments.toRef(row),
      amount: formatAmount(amount),
      party,
      credit,
    };
  }

  /** `POST /admin/tokens/burn` — burn `amount` of a registered instrument (disabled ones included: winding a token down is the point) held by `party`. */
  async burn(
    input: { instrument: InstrumentId; amount: bigint; party: string; reason: string },
    actor: Actor,
  ): Promise<ApiTokenMintResult> {
    const row = await this.instruments.require(input.instrument.admin, input.instrument.id);
    const amount = this.requireAmount(input.amount, row);
    this.requireTokenApp();
    const commandId = tokenCommandId("burn");
    const res = await this.tokenApp.burn({
      commandId,
      instrumentId: row.id,
      partyId: input.party,
      amount,
      decimals: row.decimals,
    });
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "token.burn",
      subjectType: "instrument",
      subjectId: `${row.admin}:${row.id}`,
      metadata: {
        commandId,
        status: res.status,
        instrument: { admin: row.admin, id: row.id },
        amount: formatAmount(amount),
        party: input.party,
        reason: input.reason,
      },
      ip: actor.ip ?? null,
    });
    void this.nats.publishSafe(NatsSubjects.tokenBurned, {
      commandId,
      instrument: { admin: row.admin, id: row.id },
      amount: formatAmount(amount),
      party: input.party,
    });
    this.logger.log(
      `burned ${formatAmount(amount)} ${row.symbol} held by ${input.party.slice(0, 24)}… (${commandId}, ${res.status})`,
    );
    return {
      commandId,
      status: res.status,
      instrument: this.instruments.toRef(row),
      amount: formatAmount(amount),
      party: input.party,
      credit: null,
    };
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
}
