import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

import { Config } from "../config";
import { type DepositAttribution, DepositCreditEntity } from "../entities/deposit-credit.entity";
import { WalletEntity } from "../entities/wallet.entity";
import {
  type Actor,
  type ApiInAppBalance,
  type InAppWalletOverview,
  instrumentKey,
  type InstrumentId,
  type LedgerWallet,
  NatsSubjects,
  type ReconcileResult,
} from "../types";
import { ApiError } from "../util/errors";
import { asDecimal } from "../util/ledger-values";
import { DUST, formatAmount } from "../util/money";
import { AuditService } from "./audit.service";
import { ComplianceFreezePort } from "./compliance-freeze.port";
import { EnterpriseWalletService } from "./enterprise-wallet.service";
import { IndexerService } from "./indexer.service";
import { InstrumentsService } from "./instruments.service";
import { LedgerClientService, userWalletCreateCommand } from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { PayoutService } from "./payout.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { UserService } from "./user.service";
import { WalletLinkService } from "./wallet-link.service";

// ---------------------------------------------------------------------------------------------
// Pure derivation (ARCHITECTURE §8.3 steps 3–5, §8.4) — exact fixed point, no I/O, one instrument
// ---------------------------------------------------------------------------------------------

export interface WalletLedgerInput {
  id: string;
  partyId: string;
  /** `to_wallet_credits.credited` of this wallet in the instrument being reconciled. */
  credited: bigint;
  /** Inbound of that instrument from this party to the treasury as the ledger index holds it (`to_ledger_transfers`), in 1e-10 units. */
  received: bigint;
}

/**
 * `over_credit`: a wallet is attributed more than it ever sent. `ledger_below_expected` /
 * `ledger_above_expected`: the primary's on-ledger `deposited` differs from Σ credited in that
 * direction. None of them self-resolves; an operator looks.
 */
export type DriftKind = "over_credit" | "ledger_below_expected" | "ledger_above_expected";

export interface CreditPlan {
  /** received − credited per wallet. */
  owed: Map<string, bigint>;
  drift: { kind: DriftKind; walletId: string | null; amount: bigint } | null;
  /** Σ credited — what the ledger must show as `deposited`. */
  expected: bigint;
  ledgerDeposited: bigint;
  /** ledgerDeposited − expected. */
  delta: bigint;
  /** Σ max(owed, 0) — exact. */
  amount: bigint;
  attribution: DepositAttribution[];
}

/**
 * Derive what the treasury owes the in-app wallet in ONE instrument, per linked wallet. Amounts
 * never come from the client; the derivation covers N wallets and is exact fixed point:
 *
 *   owed_w   = received_w − credited_w
 *   expected = Σ credited ; delta = ledger.deposited − expected
 *
 * Every credit the primary's UserWallet ever received went through this backend (greenfield —
 * ARCHITECTURE §18), so `ledger.deposited == Σ credited` holds exactly after confirmation and ANY
 * deviation beyond DUST — negative owed, negative delta, positive delta — is drift the backend
 * refuses to paper over: nothing is credited, an operator is notified. Instruments never mix:
 * each has its own wallet, its own credit rows and its own plan.
 */
export function planCredit(input: {
  wallets: WalletLedgerInput[];
  primaryPartyId: string;
  ledgerDeposited: bigint;
}): CreditPlan {
  const primary = input.wallets.find((w) => w.partyId === input.primaryPartyId);
  if (!primary) throw new Error("planCredit: the primary party has no wallet row");

  const owed = new Map<string, bigint>();
  let expected = 0n;
  for (const w of input.wallets) {
    owed.set(w.id, w.received - w.credited);
    expected += w.credited;
  }
  const delta = input.ledgerDeposited - expected;
  const base = {
    owed,
    expected,
    ledgerDeposited: input.ledgerDeposited,
    delta,
    amount: 0n,
    attribution: [] as DepositAttribution[],
  };

  // Step 3: a wallet attributed more than it ever sent is an over-credit → hard error.
  for (const w of input.wallets) {
    const o = owed.get(w.id) ?? 0n;
    if (o < -DUST) return { ...base, drift: { kind: "over_credit", walletId: w.id, amount: o } };
  }
  // Step 4: the ledger must hold exactly what was attributed — in either direction.
  if (delta < -DUST)
    return {
      ...base,
      drift: { kind: "ledger_below_expected", walletId: primary.id, amount: delta },
    };
  if (delta > DUST)
    return {
      ...base,
      drift: { kind: "ledger_above_expected", walletId: primary.id, amount: delta },
    };
  // Step 5: every owed_w is already an exact 10-dp value; the sum is exact too.
  let amount = 0n;
  const attribution: DepositAttribution[] = [];
  for (const w of input.wallets) {
    const o = owed.get(w.id) ?? 0n;
    if (o <= 0n) continue;
    amount += o;
    attribution.push({ walletId: w.id, partyId: w.partyId, amount: formatAmount(o) });
  }
  return { ...base, drift: null, amount, attribution };
}

/**
 * Port of api/wallet/deposit.mjs: the commandId is DERIVED from the exact state the command was
 * computed against, so racing duplicates submit the same id (ledger command-dedup and the unique
 * write-ahead row reject all but one) while a legitimate later deposit sees new state and gets a
 * new id. The wallet contract id already identifies the instrument (one wallet per instrument).
 */
export function depositCommandId(
  primaryPartyId: string,
  walletCid: string | null,
  amount: bigint,
  deposited: bigint,
): string {
  const stateHash = createHash("sha256")
    .update(
      `${primaryPartyId}|${walletCid ?? "create"}|${formatAmount(amount)}|${formatAmount(deposited)}`,
    )
    .digest("hex")
    .slice(0, 40);
  return `deposit-${stateHash}`;
}

export function depositTxRef(commandId: string): string {
  return `reconcile:${commandId}`;
}

/**
 * The write-ahead id of the in-app credit that follows an operator mint (docs/TOKENS.md §4.7):
 * derived from the mint's own command id, so re-running the credit for the same mint lands on
 * the same row (and the same ledger command) instead of crediting twice.
 */
export function mintCreditCommandId(mintCommandId: string): string {
  return `mint-credit-${createHash("sha256").update(mintCommandId).digest("hex").slice(0, 40)}`;
}

/** `mint:<token-app command id>` — the `txRef` of a mint-and-credit Deposit; what separates it from a reconcile credit in the statement. */
export function mintCreditTxRef(mintCommandId: string): string {
  return `mint:${mintCommandId}`;
}

/** What `creditMint` reports: the write-ahead row's real status after the immediate confirm pass. */
export interface MintCreditResult {
  commandId: string;
  txRef: string;
  status: "confirmed" | "submitted";
}

/** Where the credit of one mint key stands (C1, `mintCreditStanding`). */
export interface MintCreditStanding {
  commandId: string;
  txRef: string;
  /** `none`: never written ahead; else the write-ahead row's status after a confirm pass. */
  state: "none" | "submitted" | "confirmed" | "failed";
  /** `failed` only: PROVEN never to land (the wallet's FAILED, the index and the ledger agree). */
  proven: boolean;
  /** The proof, or what keeps a failure from being proven. */
  detail: string | null;
  /**
   * `failed` and unproven only because the wallet's failure is not final yet: when it is (ISO UTC;
   * the last submission + the caller's bound). Until then the key must not be re-armed.
   */
  finalAt: string | null;
}

type ConfirmOutcome = "confirmed" | "failed" | "pending";

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

/**
 * Deposit reconciliation (docs/ARCHITECTURE.md §8.3; docs/TOKENS.md §4.3), one instrument per
 * call. Money never trusts the client; every treasury-signed credit is written ahead to
 * `to_deposit_credits` and confirmed against the ledger (`creditRefs`), so a crash between submit
 * and confirm is repaired by the next confirm pass instead of crediting twice.
 *
 * The received side is the ledger index (docs/TOKENS.md §2 decision 5): `Σ amount` of the
 * `to_ledger_transfers` rows with `direction = in`, this instrument and the linked party as
 * counterparty — every token-standard or Canton Coin transfer the treasury's own transaction stream
 * showed. An index that lags the ledger end by more than `LEDGER_FRESH_OFFSETS` could be missing
 * the deposit the user is asking about, so the route refuses with `503 ledger_stale` before it
 * derives anything, and the frontend retries inside its existing window.
 */
@Injectable()
export class DepositService {
  private readonly logger = new Logger(DepositService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
    @InjectRepository(DepositCreditEntity)
    private readonly credits: Repository<DepositCreditEntity>,
    private readonly users: UserService,
    private readonly ledger: LedgerClientService,
    private readonly wallet: EnterpriseWalletService,
    private readonly instruments: InstrumentsService,
    private readonly indexer: IndexerService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
    private readonly sentry: SentryService,
    private readonly payouts: PayoutService,
    private readonly walletLinks: WalletLinkService,
    private readonly freeze: ComplianceFreezePort,
  ) {}

  private get treasury(): string {
    const treasury = this.config.treasuryPartyId;
    if (!treasury)
      throw new ApiError(502, "upstream_failed", "TREASURY_PARTY_ID is not configured");
    return treasury;
  }

  // ── §8.3 — POST /in-app-wallet/deposits/reconcile ──────────────────────────────────────────

  /** `instrumentRef` omitted = the default collateral. A disabled or unknown instrument is refused before any ledger I/O. */
  async reconcile(
    userId: string,
    actor: Actor,
    instrumentRef?: InstrumentId,
  ): Promise<ReconcileResult> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    if (user.status !== "active")
      throw new ApiError(403, "user_suspended", "this account is suspended");
    if (!user.partyId)
      throw new ApiError(409, "no_primary_wallet", "link a Canton wallet before depositing");
    if (user.kycStatus === "blocked_duplicate") {
      throw new ApiError(
        409,
        "kyc_duplicate_identity",
        "deposits are disabled while an identity verification conflict is open",
      );
    }
    // SPEC §11.6 (B3): no book transfer into a frozen account's in-app wallet — the deposit stays
    // with the treasury, uncredited, until the freeze is lifted (the neutral 403).
    await this.freeze.assertNotFrozen(user.id);
    const instrument = await this.instruments.requireEnabled(
      instrumentRef ?? (await this.instruments.requireDefaultCollateral()),
    );
    const instrumentId: InstrumentId = { admin: instrument.admin, id: instrument.id };
    const ref = this.instruments.toRef(instrument);

    // TTL sits above the worst-case pass (confirm, ledger reads, submit); correctness never
    // depends on it (the write-ahead row and ledger command-dedup do that) — it cheapens the
    // common race to a 409.
    const lock = await this.redis.acquireLock(
      `lock:deposit:${userId}`,
      this.config.depositLockTtlMs,
    );
    if (!lock.acquired)
      throw new ApiError(
        409,
        "deposit_in_progress",
        "a reconciliation for this account is already in progress",
      );

    try {
      const primary = user.partyId;

      // 1. confirm pass — anything still in flight blocks a new derivation (its amount is
      //    neither on the ledger nor attributed yet, so a new derivation would double count).
      const pass = await this.confirmForUser(userId);
      if (pass.pending.length > 0) {
        throw new ApiError(
          409,
          "deposit_in_progress",
          "a previous deposit credit is still being confirmed; try again shortly",
          {
            submitted: pass.pending.length,
            commandIds: pass.pending.map((r) => r.commandId),
          },
        );
      }

      // 2. the index must be fresh before anything is read from it (503 ledger_stale otherwise).
      await this.indexer.requireFresh();

      // 3–5. per-wallet attribution over every row (active AND revoked) in exact fixed point.
      const rows = await this.wallets.find({ where: { userId }, order: { createdAt: "ASC" } });
      const primaryRow = rows.find((w) => w.partyId === primary);
      if (!primaryRow)
        throw new ApiError(409, "no_primary_wallet", "the primary party has no linked wallet row");
      const received = await this.receivedByWallet(rows, instrumentId);
      const credited = await this.creditedByWallet(rows, instrumentId);
      const ledgerBefore = await this.ledger.fetchUserWallet(primary, instrumentId, {
        uncached: true,
      });
      const plan = planCredit({
        wallets: rows.map((w) => ({
          id: w.id,
          partyId: w.partyId,
          credited: credited.get(w.id) ?? 0n,
          received: received.get(w.id) ?? 0n,
        })),
        primaryPartyId: primary,
        ledgerDeposited: ledgerBefore?.deposited ?? 0n,
      });

      if (plan.drift) {
        await this.reportDrift(userId, primaryRow, instrumentId, plan, actor);
        throw new ApiError(
          409,
          "deposit_attribution_drift",
          "the in-app balance does not match the attributed deposits; an operator has been notified",
          {
            kind: plan.drift.kind,
            walletId: plan.drift.walletId,
            instrument: instrumentId,
            amount: formatAmount(plan.drift.amount),
          },
        );
      }

      if (plan.amount <= DUST) {
        return {
          instrument: ref,
          credited: formatAmount(0n),
          status: "nothing_outstanding",
          perWallet: [],
          ledger: ledgerBefore ? this.walletLinks.ledgerWalletToApi(ledgerBefore) : null,
        };
      }

      // 6. the primary's UserWallet in this instrument must exist BEFORE the write-ahead: it is
      //    created empty (0/0/0) under the one deterministic id every path uses
      //    (`wallet-create-<hash(package name, owner, instrument)>`), so a Create racing
      //    PayoutService's in-app path or the rewards processor collides on ledger command-dedup
      //    instead of minting a second wallet. The credit itself is then always an Exercise
      //    Deposit, whose txRef the Daml refuses to credit twice.
      const ledgerWallet = ledgerBefore ?? (await this.ensureUserWallet(primary, instrumentId));

      // 7. write-ahead row keyed by the deterministic command id.
      const commandId = depositCommandId(
        primary,
        ledgerWallet.contractId,
        plan.amount,
        ledgerWallet.deposited,
      );
      const txRef = depositTxRef(commandId);
      const credit = await this.writeAhead(userId, {
        ownerParty: primary,
        instrument: instrumentId,
        commandId,
        txRef,
        amount: plan.amount,
        attribution: plan.attribution,
        depositedBefore: ledgerWallet.deposited,
        walletCidBefore: ledgerWallet.contractId,
        actor,
      });

      // 8. submit as treasury.
      let submitError: unknown = null;
      try {
        await this.wallet.externalSubmit({
          commandId,
          commands: [this.depositCommand(ledgerWallet, plan.amount, txRef)],
        });
      } catch (err) {
        // The command may or may not have reached the ledger: the row stays `submitted` and the
        // confirm pass below (or the next one) decides — never resubmit blindly.
        submitError = err;
        this.logger.warn(`deposit submit ${commandId} failed: ${(err as Error).message}`);
      }

      // 9. confirm immediately (best effort) and answer with the attribution and the row's REAL
      //    status — a row the pass could not confirm is `submitted` (the processor finishes it),
      //    never a guess.
      await this.confirmForUser(userId).catch((err: unknown) => {
        this.logger.warn(
          `post-submit confirm pass failed for ${commandId}: ${(err as Error).message}`,
        );
      });
      const row = (await this.credits.findOne({ where: { id: credit.id } })) ?? credit;
      const ledgerAfter = await this.ledger
        .fetchUserWallet(primary, instrumentId, { uncached: true })
        .catch(() => ledgerWallet);
      const perWallet = plan.attribution.map((a) => ({
        walletId: a.walletId,
        partyId: a.partyId,
        amount: a.amount,
      }));
      const ledger = ledgerAfter ? this.walletLinks.ledgerWalletToApi(ledgerAfter) : null;

      if (row.status === "confirmed") {
        return {
          instrument: ref,
          credited: formatAmount(plan.amount),
          status: "confirmed",
          commandId,
          perWallet,
          ledger,
        };
      }
      if (row.status === "failed") {
        throw new ApiError(
          502,
          "upstream_failed",
          "the deposit credit was not accepted by the ledger; retry the reconciliation",
          {
            commandId,
            creditStatus: row.status,
            creditId: row.id,
          },
        );
      }
      if (submitError) {
        // Whatever the transport threw, the answer is an upstream failure that names the row: the
        // credit is written ahead and the confirm pass owns it from here.
        const base = ApiError.is(submitError)
          ? submitError
          : new ApiError(
              502,
              "upstream_failed",
              `deposit submit failed: ${submitError instanceof Error ? submitError.message : "unknown error"}`,
            );
        throw new ApiError(base.status, base.code, base.message, {
          ...(base.details ?? {}),
          commandId,
          creditStatus: row.status,
          creditId: row.id,
        });
      }
      return {
        instrument: ref,
        credited: formatAmount(plan.amount),
        status: "submitted",
        commandId,
        perWallet,
        ledger,
      };
    } finally {
      await lock.release();
    }
  }

  /**
   * What each linked wallet (active AND revoked) sent the treasury in `instrument`, from the
   * ledger index: `SUM(amount)` of the `in` transfers whose counterparty is the wallet's party.
   * Only settled ledger facts land there (a transaction is either committed or not), so there is
   * no pending / failed state to filter; a transfer in another instrument is simply another row.
   */
  private async receivedByWallet(
    rows: WalletEntity[],
    instrument: InstrumentId,
  ): Promise<Map<string, bigint>> {
    const byParty = await this.receivedByParty(
      rows.map((w) => w.partyId),
      [instrument],
    );
    const out = new Map<string, bigint>();
    for (const w of rows)
      out.set(w.id, byParty.get(w.partyId)?.get(instrumentKey(instrument)) ?? 0n);
    // An operator's mint-and-credit (docs/TOKENS.md §4.7) is a Deposit nothing was sent for: it
    // counts as received by the wallet it was attributed to, or the next reconcile would read the
    // credit it left in `to_wallet_credits` as an over-credit and refuse.
    for (const [walletId, amount] of await this.mintCreditsByWallet(rows, instrument))
      out.set(walletId, (out.get(walletId) ?? 0n) + amount);
    return out;
  }

  /** wallet row → Σ confirmed `mint:` credits attributed to it in `instrument` (0n where none). */
  private async mintCreditsByWallet(
    rows: WalletEntity[],
    instrument: InstrumentId,
  ): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (rows.length === 0) return out;
    const credits = await this.credits.find({
      where: {
        userId: rows[0].userId,
        instrumentAdmin: instrument.admin,
        instrumentId: instrument.id,
        status: "confirmed",
      },
    });
    const known = new Set(rows.map((w) => w.id));
    for (const c of credits) {
      if (!c.txRef.startsWith("mint:")) continue;
      for (const a of c.attribution)
        if (known.has(a.walletId))
          out.set(a.walletId, (out.get(a.walletId) ?? 0n) + asDecimal(a.amount));
    }
    return out;
  }

  /** party → instrumentKey → Σ inbound, over `to_ledger_transfers` (0n where nothing arrived). */
  private async receivedByParty(
    parties: string[],
    instruments: InstrumentId[],
  ): Promise<Map<string, Map<string, bigint>>> {
    const out = new Map<string, Map<string, bigint>>();
    if (parties.length === 0 || instruments.length === 0) return out;
    const rows = await this.dataSource.query<
      { counterparty: string; instrument_admin: string; instrument_id: string; total: string }[]
    >(
      `SELECT counterparty, instrument_admin, instrument_id, SUM(amount)::text AS total
         FROM to_ledger_transfers
        WHERE direction = 'in' AND counterparty = ANY($1::text[])
          AND (instrument_admin, instrument_id) IN (SELECT a, i FROM unnest($2::text[], $3::text[]) AS t(a, i))
        GROUP BY counterparty, instrument_admin, instrument_id`,
      [parties, instruments.map((i) => i.admin), instruments.map((i) => i.id)],
    );
    for (const r of rows) {
      const perParty = out.get(r.counterparty) ?? new Map<string, bigint>();
      perParty.set(
        instrumentKey({ admin: r.instrument_admin, id: r.instrument_id }),
        asDecimal(r.total),
      );
      out.set(r.counterparty, perParty);
    }
    return out;
  }

  /** `to_wallet_credits.credited` per wallet row in one instrument (0n without a row). */
  private async creditedByWallet(
    rows: WalletEntity[],
    instrument: InstrumentId,
  ): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (rows.length === 0) return out;
    const credits = await this.walletLinks.creditsFor(rows.map((w) => w.id));
    for (const w of rows) {
      const row = (credits.get(w.id) ?? []).find(
        (c) => c.instrumentAdmin === instrument.admin && c.instrumentId === instrument.id,
      );
      out.set(w.id, row?.credited ?? 0n);
    }
    return out;
  }

  // ── mint-and-credit (docs/TOKENS.md §4.7; TokenOperationsService) ─────────────────────────

  /**
   * Credit an operator's mint to the account's in-app wallet: `UserWallet.Deposit { amount, txRef =
   * "mint:<mint command id>" }` on the primary party's wallet in `instrument`, through the same
   * write-ahead row, submit and confirm pass a reconcile credit takes — so a crash anywhere is
   * repaired by the DepositConfirmProcessor, never by a second Deposit. The attribution names the
   * primary wallet row (`receivedByWallet` counts it as received, keeping the reconcile invariant).
   * Idempotent per mint: the row id derives from the mint command id, so a repeat for the same
   * mint answers the existing row (`confirmed`), `409 deposit_in_progress` while it is in flight,
   * or re-arms a `failed` one. The caller validated the account (active, primary party, KYC) and
   * created the wallet BEFORE minting; here only the credit itself can fail.
   */
  async creditMint(input: {
    userId: string;
    instrument: InstrumentId;
    amount: bigint;
    mintCommandId: string;
    actor: Actor;
  }): Promise<MintCreditResult> {
    const commandId = mintCreditCommandId(input.mintCommandId);
    const txRef = mintCreditTxRef(input.mintCommandId);
    const existing = await this.credits.findOne({ where: { commandId } });
    if (existing?.status === "confirmed") return { commandId, txRef, status: "confirmed" };

    const user = await this.users.findById(input.userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    if (!user.partyId)
      throw new ApiError(409, "no_primary_wallet", "the account has no primary wallet");
    const primary = user.partyId;
    const primaryRow = await this.wallets.findOne({
      where: { userId: input.userId, partyId: primary },
    });
    if (!primaryRow)
      throw new ApiError(409, "no_primary_wallet", "the primary party has no linked wallet row");

    // The mint already happened: wait a little for a reconcile holding the lock rather than refuse.
    const lock = await this.acquireDepositLock(input.userId, 5_000);
    if (!lock)
      throw new ApiError(
        409,
        "deposit_in_progress",
        "a reconciliation for this account is in progress; the credit was not submitted",
        { mintCommandId: input.mintCommandId },
      );
    try {
      const pass = await this.confirmForUser(input.userId);
      const pending = pass.pending.filter((r) => r.commandId !== commandId);
      if (pending.length > 0)
        throw new ApiError(
          409,
          "deposit_in_progress",
          "a previous deposit credit is still being confirmed; the credit was not submitted",
          { submitted: pending.length, commandIds: pending.map((r) => r.commandId) },
        );
      const row = await this.credits.findOne({ where: { commandId } });
      if (row?.status === "confirmed") return { commandId, txRef, status: "confirmed" };
      if (row?.status === "submitted")
        throw new ApiError(
          409,
          "deposit_in_progress",
          "this mint credit is still being confirmed",
          {
            commandId,
          },
        );

      const ledgerWallet =
        (await this.ledger.fetchUserWallet(primary, input.instrument, { uncached: true })) ??
        (await this.ensureUserWallet(primary, input.instrument));
      await this.writeAhead(input.userId, {
        ownerParty: primary,
        instrument: input.instrument,
        commandId,
        txRef,
        amount: input.amount,
        attribution: [
          { walletId: primaryRow.id, partyId: primary, amount: formatAmount(input.amount) },
        ],
        depositedBefore: ledgerWallet.deposited,
        walletCidBefore: ledgerWallet.contractId,
        actor: input.actor,
      });
      try {
        await this.wallet.externalSubmit({
          commandId,
          commands: [this.depositCommand(ledgerWallet, input.amount, txRef)],
        });
      } catch (err) {
        // Written ahead: the confirm pass owns the row from here (see reconcile step 8).
        this.logger.warn(`mint credit submit ${commandId} failed: ${(err as Error).message}`);
      }
      await this.confirmForUser(input.userId).catch((err: unknown) => {
        this.logger.warn(
          `post-submit confirm pass failed for ${commandId}: ${(err as Error).message}`,
        );
      });
      const after = await this.credits.findOne({ where: { commandId } });
      if (after?.status === "failed")
        throw new ApiError(
          502,
          "upstream_failed",
          "the mint credit was not accepted by the ledger; the mint stands on the treasury",
          {
            commandId,
            creditStatus: after.status,
            creditId: after.id,
            mintCommandId: input.mintCommandId,
          },
        );
      return {
        commandId,
        txRef,
        status: after?.status === "confirmed" ? "confirmed" : "submitted",
      };
    } finally {
      await lock.release();
    }
  }

  /**
   * C1: where the credit of `mintCommandId` stands — failed for good ONLY on proof, never on an
   * HTTP status: the confirm pass failed its write-ahead row, the wallet reports the command
   * FAILED (known, not submitted: an unknown or unreadable status proves nothing) and its last
   * submission is older than `finalAfterMs` (a timeout the ledger may still apply is no failure
   * yet), the ledger index is fresh and holds no Deposit with its txRef, and a fresh ledger read
   * shows the wallet without it. A submitted row goes through the confirm pass first (its user's
   * deposit lock; busy → it stays as it was). Nothing is re-armed or submitted here.
   */
  async mintCreditStanding(
    mintCommandId: string,
    opts: { finalAfterMs: number },
  ): Promise<MintCreditStanding> {
    const commandId = mintCreditCommandId(mintCommandId);
    const txRef = mintCreditTxRef(mintCommandId);
    const out = (
      state: MintCreditStanding["state"],
      proven = false,
      detail: string | null = null,
      finalAt: string | null = null,
    ): MintCreditStanding => ({ commandId, txRef, state, proven, detail, finalAt });
    let row = await this.credits.findOne({ where: { commandId } });
    if (!row) return out("none");
    if (row.status === "submitted") {
      await this.confirmPending(row.userId);
      row = (await this.credits.findOne({ where: { commandId } })) ?? row;
    }
    if (row.status !== "failed") return out(row.status);
    const missing = await this.failureUnproven(row, opts.finalAfterMs);
    return missing
      ? out("failed", false, missing.detail, missing.finalAt)
      : out("failed", true, row.error ?? "the wallet reports the Deposit failed");
  }

  /** What keeps a failed credit from being proven never to land; null = proven (C1). */
  private async failureUnproven(
    row: DepositCreditEntity,
    finalAfterMs: number,
  ): Promise<{ detail: string; finalAt: string | null } | null> {
    const unproven = (detail: string): { detail: string; finalAt: null } => ({
      detail,
      finalAt: null,
    });
    const status = await this.wallet.commandStatus(this.treasury, row.commandId);
    if (!status.known)
      return unproven(
        `the wallet does not report ${row.commandId} (${status.status ?? "unreadable"})`,
      );
    if (status.submitted)
      return unproven(`the wallet reports ${row.commandId} as ${status.status ?? "submitted"}`);
    // The ledger may still apply the last submission until its command lifetime ends: until
    // then the wallet's FAILED (a timeout above all) proves nothing, and nothing re-arms the key.
    const finalAt = row.submittedAt.getTime() + finalAfterMs;
    if (Date.now() <= finalAt)
      return {
        detail: `the wallet reports ${row.commandId} as ${status.status ?? "failed"}, final only after ${new Date(finalAt).toISOString()}`,
        finalAt: new Date(finalAt).toISOString(),
      };
    try {
      await this.indexer.requireFresh();
    } catch (err) {
      return unproven(`the ledger index is not fresh: ${(err as Error).message}`);
    }
    const indexed = await this.dataSource.query<unknown[]>(
      `SELECT 1 FROM to_wallet_entries WHERE kind = 'deposit' AND tx_ref = $1 LIMIT 1`,
      [row.txRef],
    );
    if (indexed.length > 0) return unproven(`the ledger index shows a Deposit with ${row.txRef}`);
    let onLedger: LedgerWallet | null;
    try {
      onLedger = await this.ledger.fetchUserWallet(
        row.ownerParty,
        { admin: row.instrumentAdmin, id: row.instrumentId },
        { uncached: true },
      );
    } catch (err) {
      return unproven(`the ledger could not be read: ${(err as Error).message}`);
    }
    if (!this.ledgerShowsPreState(row, onLedger))
      return unproven(`the ledger does not show the wallet without ${row.txRef}`);
    return null;
  }

  /** `lock:deposit:<userId>`, retried for up to `waitMs` (a reconcile in flight finishes in seconds); null when still busy. */
  private async acquireDepositLock(
    userId: string,
    waitMs: number,
  ): Promise<{ acquired: boolean; release(): Promise<void> } | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const lock = await this.redis.acquireLock(
        `lock:deposit:${userId}`,
        this.config.depositLockTtlMs,
      );
      if (lock.acquired) return lock;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  // ── confirm pass (§8.3 step 1; DepositConfirmProcessor every 60 s and on boot) ────────────

  /**
   * Confirm every `submitted` credit (of one user, or of everyone). Without `lockHeld` the
   * per-user deposit lock is taken and users whose lock is busy are skipped — the reconcile
   * holding it runs its own pass. Transitions are atomic (`WHERE status = 'submitted'`), so a
   * concurrent confirmer can never apply the attribution twice.
   */
  async confirmPending(
    userId?: string,
    opts: { lockHeld?: boolean } = {},
  ): Promise<{ confirmed: number; failed: number }> {
    const rows = await this.credits.find({
      where: userId ? { userId, status: "submitted" } : { status: "submitted" },
      order: { createdAt: "ASC" },
    });
    const byUser = new Map<string, DepositCreditEntity[]>();
    for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

    let confirmed = 0;
    let failed = 0;
    for (const [uid, userRows] of byUser) {
      let lock: { acquired: boolean; release(): Promise<void> } | null = null;
      if (!opts.lockHeld) {
        lock = await this.redis.acquireLock(`lock:deposit:${uid}`, this.config.depositLockTtlMs);
        if (!lock.acquired) continue;
      }
      try {
        for (const row of userRows) {
          const outcome = await this.confirmRow(row);
          if (outcome === "confirmed") confirmed += 1;
          else if (outcome === "failed") failed += 1;
        }
      } catch (err) {
        // One user's upstream trouble must not stall everyone else's confirmations.
        this.logger.warn(`confirm pass for user ${uid} failed: ${(err as Error).message}`);
        this.sentry.captureException(err, { processor: "deposit-confirm", userId: uid });
        if (userId) throw err;
      } finally {
        if (lock) await lock.release();
      }
    }
    return { confirmed, failed };
  }

  private async confirmForUser(
    userId: string,
  ): Promise<{ confirmed: number; failed: number; pending: DepositCreditEntity[] }> {
    const result = await this.confirmPending(userId, { lockHeld: true });
    const pending = await this.credits.find({
      where: { userId, status: "submitted" },
      order: { createdAt: "ASC" },
    });
    return { ...result, pending };
  }

  private async confirmRow(row: DepositCreditEntity): Promise<ConfirmOutcome> {
    const instrument: InstrumentId = { admin: row.instrumentAdmin, id: row.instrumentId };
    const onLedger = await this.ledger.fetchUserWallet(row.ownerParty, instrument, {
      uncached: true,
    });
    if (this.isConfirmedOnLedger(row, onLedger)) {
      return (await this.markConfirmed(row)) ? "confirmed" : "pending";
    }
    // Only a ledger that still shows the PRE-state, after the grace period, AND a wallet that
    // reports the command as failed or unknown may fail the row; anything else is "in flight" and
    // stays submitted (fail closed). The grace period exists because the ACS lags an accepted
    // command and a wrong `failed` would re-arm the same command id for a second submission.
    if (!this.ledgerShowsPreState(row, onLedger)) return "pending";
    const ageMs = Date.now() - row.submittedAt.getTime();
    if (ageMs < this.config.depositConfirmGraceMs) return "pending";
    const status = await this.wallet.commandStatus(this.treasury, row.commandId);
    if (status.known && status.submitted) {
      // The wallet says it went through but the ledger disagrees past the grace period: an
      // operator must look — nothing is credited and nothing is re-armed.
      this.logger.warn(
        `deposit ${row.commandId}: wallet reports "${status.status ?? "submitted"}" but the ledger still shows the pre-state after ${Math.round(ageMs / 1000)} s`,
      );
      this.sentry.captureMessage(
        "deposit credit accepted by the wallet but absent from the ledger",
        "warning",
        { commandId: row.commandId },
      );
      return "pending";
    }
    if (!status.known && status.status !== "not_found") return "pending";
    const reason = status.known
      ? `wallet reports the command as ${status.status ?? "failed"}`
      : "wallet does not know the command after the grace period";
    return (await this.markFailed(row, reason)) ? "failed" : "pending";
  }

  /**
   * THE confirmation rule: the Daml `Deposit` choice appends `txRef` to `UserWallet.creditRefs`
   * and refuses a repeat, so the wallet carrying the row's txRef is the on-ledger proof this exact
   * credit landed — whatever `deposited` did meanwhile (another Deposit, a rotated contract id).
   */
  private isConfirmedOnLedger(row: DepositCreditEntity, onLedger: LedgerWallet | null): boolean {
    return onLedger !== null && onLedger.creditRefs.includes(row.txRef);
  }

  /**
   * Pre-state: the wallet exists (every row records the wallet the Exercise was addressed to) and
   * does not carry the row's txRef — by the same Daml rule, this credit has not landed. No wallet
   * at all for a row that recorded one is anomalous and is treated as "in flight" (fail closed).
   */
  private ledgerShowsPreState(row: DepositCreditEntity, onLedger: LedgerWallet | null): boolean {
    return onLedger !== null && !onLedger.creditRefs.includes(row.txRef);
  }

  /**
   * The party's empty UserWallet in `instrument`, created under the shared deterministic id with
   * the regulator parties as observers. A dedup collision (PayoutService, the rewards processor or
   * another instance created it a moment ago) is not an error: the fresh read decides. A wallet
   * that is accepted but not yet visible is a 502 the caller retries. Public because it is THE
   * wallet-creation primitive: the rewards grant and the operator's mint credit need the same
   * wallet under the same id.
   */
  async ensureUserWallet(owner: string, instrument: InstrumentId): Promise<LedgerWallet> {
    const commandId = this.ledger.walletCreateCommandId(owner, instrument);
    try {
      await this.wallet.externalSubmit({
        commandId,
        commands: [
          userWalletCreateCommand({
            templateId: this.ledger.templateId("UserWallet"),
            admin: this.treasury,
            owner,
            instrument,
            auditObservers: this.config.auditObserverParties,
          }),
        ],
      });
    } catch (err) {
      this.logger.warn(
        `UserWallet create ${commandId} did not succeed (${(err as Error).message}); re-reading the ledger`,
      );
    }
    const created = await this.ledger.fetchUserWallet(owner, instrument, { uncached: true });
    if (!created) {
      throw new ApiError(
        502,
        "upstream_failed",
        "the in-app wallet is not yet visible on the ledger; try again shortly",
        { commandId },
      );
    }
    return created;
  }

  /** Atomic `submitted → confirmed` + attribution bumps (per wallet, in the row's instrument) + audit, in one transaction. */
  private async markConfirmed(row: DepositCreditEntity): Promise<boolean> {
    const walletIds = row.attribution.map((a) => a.walletId);
    const done = await this.dataSource.transaction(async (manager) => {
      const res = await manager
        .getRepository(DepositCreditEntity)
        .update(
          { id: row.id, status: "submitted" },
          { status: "confirmed", confirmedAt: new Date(), error: null },
        );
      if (!res.affected) return false;
      const walletRepo = manager.getRepository(WalletEntity);
      for (const a of row.attribution) {
        const w = await walletRepo.findOne({
          where: { id: a.walletId },
          lock: { mode: "pessimistic_write" },
        });
        if (!w) throw new Error(`attribution wallet ${a.walletId} of credit ${row.id} is missing`);
        // Running total per (wallet, instrument): the first credit creates the row.
        await manager.query(
          `INSERT INTO to_wallet_credits (wallet_id, instrument_admin, instrument_id, credited)
             VALUES ($1, $2, $3, $4)
           ON CONFLICT (wallet_id, instrument_admin, instrument_id)
           DO UPDATE SET credited = to_wallet_credits.credited + EXCLUDED.credited, updated_at = now()`,
          [w.id, row.instrumentAdmin, row.instrumentId, a.amount],
        );
      }
      await this.audit.record(
        {
          actorType: "system",
          action: "deposit.credited",
          subjectType: "deposit_credit",
          subjectId: row.id,
          metadata: {
            userId: row.userId,
            commandId: row.commandId,
            instrument: { admin: row.instrumentAdmin, id: row.instrumentId },
            amount: formatAmount(row.amount),
            walletIds,
            attribution: row.attribution,
          },
        },
        manager,
      );
      return true;
    });
    if (done) {
      this.logger.log(
        `deposit ${row.commandId} confirmed: ${formatAmount(row.amount)} ${row.instrumentId} across ${walletIds.length} wallet(s)`,
      );
      void this.nats.publishSafe(NatsSubjects.depositCredited, {
        userId: row.userId,
        depositCreditId: row.id,
        commandId: row.commandId,
        instrument: { admin: row.instrumentAdmin, id: row.instrumentId },
        amount: formatAmount(row.amount),
        walletIds,
      });
    }
    return done;
  }

  private async markFailed(row: DepositCreditEntity, error: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const res = await manager
        .getRepository(DepositCreditEntity)
        .update(
          { id: row.id, status: "submitted" },
          { status: "failed", error: error.slice(0, 500) },
        );
      if (!res.affected) return false;
      await this.audit.record(
        {
          actorType: "system",
          action: "deposit.failed",
          subjectType: "deposit_credit",
          subjectId: row.id,
          metadata: {
            userId: row.userId,
            commandId: row.commandId,
            instrument: { admin: row.instrumentAdmin, id: row.instrumentId },
            amount: formatAmount(row.amount),
            error: error.slice(0, 200),
          },
        },
        manager,
      );
      this.logger.warn(`deposit ${row.commandId} marked failed: ${error}`);
      this.sentry.captureMessage("deposit credit marked failed", "warning", {
        commandId: row.commandId,
      });
      return true;
    });
  }

  // ── write-ahead, drift ────────────────────────────────────────────────────────────────────

  /**
   * INSERT … ON CONFLICT (command_id) DO NOTHING. No row inserted means the same state is
   * already being credited (`409 deposit_in_progress`) — except a row the confirm pass marked
   * `failed` (past the grace period, ledger in the pre-state, wallet reporting the command as
   * failed or unknown): that one is re-armed under the same id with a fresh `submitted_at`.
   * Ledger command-dedup and the Daml txRef assertion are the backstops should the original
   * command land after all.
   */
  private async writeAhead(
    userId: string,
    input: {
      ownerParty: string;
      instrument: InstrumentId;
      commandId: string;
      txRef: string;
      amount: bigint;
      attribution: DepositAttribution[];
      depositedBefore: bigint;
      walletCidBefore: string | null;
      actor: Actor;
    },
  ): Promise<DepositCreditEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(DepositCreditEntity);
      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(DepositCreditEntity)
        .values({
          userId,
          ownerParty: input.ownerParty,
          instrumentAdmin: input.instrument.admin,
          instrumentId: input.instrument.id,
          commandId: input.commandId,
          txRef: input.txRef,
          amount: input.amount,
          attribution: input.attribution,
          depositedBefore: input.depositedBefore,
          walletCidBefore: input.walletCidBefore,
          status: "submitted",
          error: null,
          submittedAt: new Date(),
          confirmedAt: null,
        })
        .orIgnore()
        .returning("id")
        .updateEntity(false)
        .execute();
      const raw = result.raw as unknown;
      const inserted = Array.isArray(raw) && raw.length > 0;

      let rearmed = false;
      if (!inserted) {
        const clash = await repo.findOne({ where: { commandId: input.commandId } });
        if (!clash || clash.status !== "failed") {
          throw new ApiError(409, "deposit_in_progress", "this deposit is already being credited", {
            commandId: input.commandId,
          });
        }
        const res = await repo.update(
          { id: clash.id, status: "failed" },
          {
            status: "submitted",
            error: null,
            submittedAt: new Date(),
            confirmedAt: null,
            attribution: input.attribution,
            amount: input.amount,
            depositedBefore: input.depositedBefore,
            walletCidBefore: input.walletCidBefore,
            ownerParty: input.ownerParty,
            instrumentAdmin: input.instrument.admin,
            instrumentId: input.instrument.id,
            txRef: input.txRef,
          },
        );
        if (!res.affected)
          throw new ApiError(409, "deposit_in_progress", "this deposit is already being credited", {
            commandId: input.commandId,
          });
        rearmed = true;
      }
      const row = await repo.findOne({ where: { commandId: input.commandId } });
      if (!row) throw new Error("write-ahead row vanished");

      await this.audit.record(
        {
          actorType: input.actor.type,
          actorUserId: input.actor.userId ?? null,
          actorSessionId: input.actor.sessionId ?? null,
          action: "deposit.submitted",
          subjectType: "deposit_credit",
          subjectId: row.id,
          metadata: {
            userId,
            commandId: input.commandId,
            instrument: input.instrument,
            amount: formatAmount(input.amount),
            walletIds: input.attribution.map((a) => a.walletId),
            attribution: input.attribution,
            depositedBefore: formatAmount(input.depositedBefore),
            walletCidBefore: input.walletCidBefore,
            rearmed,
          },
          ip: input.actor.ip ?? null,
        },
        manager,
      );
      return row;
    });
  }

  /** `UserWallet.Deposit { amount, txRef }` — the one shape every credit takes (v17 argument names). */
  private depositCommand(onLedger: LedgerWallet, amount: bigint, txRef: string): unknown {
    return {
      ExerciseCommand: {
        templateId: this.ledger.templateId("UserWallet"),
        contractId: onLedger.contractId,
        choice: "Deposit",
        choiceArgument: { amount: formatAmount(amount), txRef },
      },
    };
  }

  /** Audit + Sentry + NATS for a refused reconciliation; the audit row is written outside the (absent) transaction so it survives the 409. */
  private async reportDrift(
    userId: string,
    primaryRow: WalletEntity,
    instrument: InstrumentId,
    plan: CreditPlan,
    actor: Actor,
  ): Promise<void> {
    const drift = plan.drift;
    if (!drift) return;
    const subjectId = drift.walletId ?? primaryRow.id;
    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "deposit.attribution_drift",
      subjectType: "wallet",
      subjectId,
      metadata: {
        userId,
        kind: drift.kind,
        instrument,
        amount: formatAmount(drift.amount),
        ledgerDeposited: formatAmount(plan.ledgerDeposited),
        expected: formatAmount(plan.expected),
        delta: formatAmount(plan.delta),
      },
      ip: actor.ip ?? null,
    });
    this.logger.error(
      `deposit attribution drift for user ${userId} in ${instrument.id}: ${drift.kind} ${formatAmount(drift.amount)} (ledger ${formatAmount(plan.ledgerDeposited)}, expected ${formatAmount(plan.expected)})`,
    );
    this.sentry.captureMessage(`deposit attribution drift: ${drift.kind}`, "error", {
      userId,
      walletId: subjectId,
      kind: drift.kind,
      instrument: instrument.id,
    });
    void this.nats.publishSafe(NatsSubjects.depositDrift, {
      userId,
      walletId: subjectId,
      kind: drift.kind,
      instrument,
      amount: formatAmount(drift.amount),
    });
  }

  // ── GET /in-app-wallet ────────────────────────────────────────────────────────────────────

  /**
   * One balance row per instrument the account has a wallet or a credit in, plus the default
   * collateral and the rewards instrument even before a wallet exists (docs/TOKENS.md §4.3, §5):
   * the UI offers a deposit per instrument, so an instrument with nothing yet still has a row.
   * The 15 s cached ledger view is fine here and the `received` figures come from the index as it
   * stands (no freshness gate: the overview informs, the reconcile route decides).
   */
  async overview(userId: string): Promise<InAppWalletOverview> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    const primary = user.partyId;
    const rows = await this.wallets.find({ where: { userId }, order: { createdAt: "ASC" } });

    const ledgerWallets = primary ? await this.ledger.fetchUserWallets(primary) : [];
    const own = await this.walletLinks.ownLedgerWallets(rows, primary);
    const credits = await this.walletLinks.creditsFor(rows.map((w) => w.id));

    // The instruments with a balance row: default collateral, rewards, then whatever has a wallet or a credit.
    const ordered = new Map<string, InstrumentId>();
    const add = (i: InstrumentId | null | undefined): void => {
      if (i && !ordered.has(instrumentKey(i)))
        ordered.set(instrumentKey(i), { admin: i.admin, id: i.id });
    };
    add(await this.instruments.defaultCollateral());
    add(await this.instruments.rewardsInstrument());
    for (const w of ledgerWallets) add(w.instrument);
    for (const list of credits.values())
      for (const c of list) add({ admin: c.instrumentAdmin, id: c.instrumentId });

    // What each party sent in each listed instrument, from the index (0 where nothing arrived).
    const byParty = await this.receivedByParty(
      rows.map((w) => w.partyId),
      [...ordered.values()],
    );
    const received = new Map<string, Map<string, bigint>>();
    for (const w of rows) {
      const perWallet = new Map<string, bigint>();
      for (const key of ordered.keys()) perWallet.set(key, byParty.get(w.partyId)?.get(key) ?? 0n);
      received.set(w.id, perWallet);
    }

    const wallets = rows.map((w) =>
      this.walletLinks.toApi(w, {
        credits: credits.get(w.id) ?? [],
        ownLedgerWallets: own.get(w.id) ?? [],
        received: received.get(w.id),
      }),
    );

    const balances: ApiInAppBalance[] = [];
    for (const [key, instrument] of ordered) {
      const ledger = ledgerWallets.find((w) => instrumentKey(w.instrument) === key) ?? null;
      let creditedTotal = 0n;
      for (const list of credits.values())
        for (const c of list)
          if (c.instrumentAdmin === instrument.admin && c.instrumentId === instrument.id)
            creditedTotal += c.credited;
      const ledgerDeposited = ledger?.deposited ?? 0n;
      balances.push({
        instrument: this.instruments.refOf(instrument),
        ledger: ledger ? this.walletLinks.ledgerWalletToApi(ledger) : null,
        attribution: {
          creditedTotal: formatAmount(creditedTotal),
          ledgerDeposited: formatAmount(ledgerDeposited),
          delta: formatAmount(ledgerDeposited - creditedTotal),
        },
      });
    }

    const submitted = await this.credits.count({ where: { userId, status: "submitted" } });
    const payoutRows = await this.payouts.listForUser(userId);
    let active = new Set<string>();
    if (payoutRows.length > 0) {
      try {
        active = new Set((await this.ledger.fetchPendingPayouts()).map((p) => p.contractId));
      } catch (err) {
        this.logger.warn(`pending payouts read failed for overview: ${(err as Error).message}`);
      }
    }

    return {
      partyId: primary,
      wallets,
      balances,
      pending: { submitted },
      // C8 / C11: the payee's own view (every internal hold reads `processing`, no reason).
      payouts: payoutRows.map((p) => this.payouts.toUserApi(p, active.has(p.pendingPayoutCid))),
    };
  }
}
