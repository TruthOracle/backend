/**
 * Ledger transactions the way the JSON Ledger API v2 would serve them for the TruthOracle
 * package (LEDGER_EFFECTS shape, already normalised into `LedgerTransaction`), built from the
 * Daml choices in truthoracle-contracts/daml/daml/Truthoracle.daml. The AMM arithmetic is NOT
 * reproduced — the fixture just keeps every payload internally consistent (successor market
 * versions, position deltas, wallet debits / credits) so the projection's derivations have
 * something exact to compare against. Values are 10-dp strings and Ints are strings, like the
 * participant emits them with `verbose: false`.
 */
import type {
  ActiveContractEntry,
  CreatedLedgerEvent,
  ExercisedLedgerEvent,
  InterfaceView,
  LedgerTransaction,
} from "../../src/indexer/events";
import {
  HOLDING_INTERFACE,
  TRANSFER_FACTORY_INTERFACE,
  TRANSFER_INSTRUCTION_INTERFACE,
  type TokenStandardInterface,
} from "../../src/indexer/token-standard";
import type { InstrumentId } from "../../src/types";
import { formatAmount, parseAmount } from "../../src/util/money";

export const FIXTURE_PACKAGE_ID = "fakepkg";
/** Must equal TRUTHORACLE_PACKAGE_NAME in `testEnv()` (test/helpers/app.ts). */
export const FIXTURE_PACKAGE_NAME = "truthoracle-test";
export const SPLICE_PACKAGE_NAME = "splice-amulet";
/** The fixture ledger's DSO party; Canton Coin's instrument admin (must equal TEST_DSO in test/helpers/app.ts). */
export const FIXTURE_DSO = "DSO::1220" + "d".repeat(64);
/** The collateral every fixture market and wallet is in unless a scenario names another. */
export const FIXTURE_COLLATERAL: InstrumentId = { admin: FIXTURE_DSO, id: "Amulet" };
/** A CIP-56 token of another package (cBYN-like): what the token-standard scenarios move unless told otherwise. */
export const FIXTURE_TOKEN_PACKAGE = "cbyn-holding-stable";
export const FIXTURE_TOKEN_ADMIN = "agent::1220" + "c".repeat(64);
export const FIXTURE_TOKEN: InstrumentId = { admin: FIXTURE_TOKEN_ADMIN, id: "cBYN" };

/** `pkgId:Module:Entity` of a token-standard interface as the participant reports it (the fixture pins one package id per API). */
export function interfaceIdOf(iface: TokenStandardInterface): string {
  return `${iface.packageName.replace(/-/g, "")}pkg:${iface.module}:${iface.entity}`;
}

/** The `HoldingV1.HoldingView` of a created holding, as `interfaceViews[]` carries it. */
export function holdingView(input: {
  owner: string;
  instrument: InstrumentId;
  amount: string;
  lock?: { expiresAt?: Date | null } | null;
}): InterfaceView {
  const lock =
    input.lock === undefined || input.lock === null
      ? null
      : {
          holders: [input.instrument.admin],
          expiresAt: input.lock.expiresAt ? input.lock.expiresAt.toISOString() : null,
          expiresAfter: null,
          context: "transfer",
        };
  return {
    interfaceId: interfaceIdOf(HOLDING_INTERFACE),
    templateId: interfaceIdOf(HOLDING_INTERFACE),
    packageName: "",
    module: HOLDING_INTERFACE.module,
    entity: HOLDING_INTERFACE.entity,
    view: {
      owner: input.owner,
      instrumentId: { admin: input.instrument.admin, id: input.instrument.id },
      amount: formatAmount(parseAmount(input.amount)),
      lock,
      meta: { values: {} },
    },
  };
}

/** The `Transfer` record of `TransferFactory_Transfer` / a `TransferInstructionView`, JSON-encoded. */
export function transferRecord(input: {
  sender: string;
  receiver: string;
  instrument: InstrumentId;
  amount: string;
  inputHoldingCids?: string[];
  requestedAt?: Date;
  executeBefore?: Date;
  meta?: Record<string, string>;
}): Record<string, unknown> {
  // Requested now, valid ten minutes — an offer the acceptor still finds live (an expired one is skipped).
  const requestedAt = input.requestedAt ?? new Date();
  return {
    sender: input.sender,
    receiver: input.receiver,
    amount: formatAmount(parseAmount(input.amount)),
    instrumentId: { admin: input.instrument.admin, id: input.instrument.id },
    requestedAt: requestedAt.toISOString(),
    executeBefore: (input.executeBefore ?? new Date(requestedAt.getTime() + 600_000)).toISOString(),
    inputHoldingCids: input.inputHoldingCids ?? [],
    meta: { values: input.meta ?? {} },
  };
}

/** The `TransferInstructionV1.TransferInstructionView` of a pending two-step offer. */
export function transferInstructionView(input: {
  sender: string;
  receiver: string;
  instrument: InstrumentId;
  amount: string;
  executeBefore?: Date;
  originalInstructionCid?: string | null;
}): InterfaceView {
  return {
    interfaceId: interfaceIdOf(TRANSFER_INSTRUCTION_INTERFACE),
    templateId: interfaceIdOf(TRANSFER_INSTRUCTION_INTERFACE),
    packageName: "",
    module: TRANSFER_INSTRUCTION_INTERFACE.module,
    entity: TRANSFER_INSTRUCTION_INTERFACE.entity,
    view: {
      originalInstructionCid: input.originalInstructionCid ?? null,
      transfer: transferRecord(input),
      status: { tag: "TransferPendingReceiverAcceptance", value: {} },
      meta: { values: {} },
    },
  };
}

export type Payload = Record<string, unknown>;

export interface MarketFixtureState {
  cid: string;
  payload: Payload;
}

export interface WalletFixtureState {
  cid: string;
  payload: Payload;
}

export interface PositionFixtureState {
  cid: string;
  payload: Payload;
}

const dec = (v: bigint | string | number): string => formatAmount(parseAmount(v));
const big = (v: unknown): bigint => parseAmount(String(v));

/**
 * A growing ledger: `offset` advances per transaction, contract ids and update ids are unique,
 * and every builder returns the transaction plus the new contract states it produced.
 */
export class LedgerFixture {
  offset = 0;
  private seq = 0;
  private nodeId = 0;
  readonly txs: LedgerTransaction[] = [];

  constructor(
    readonly admin: string,
    readonly packageName = FIXTURE_PACKAGE_NAME,
    /** The instrument markets and wallets are created in unless a builder is told otherwise. */
    readonly collateral: InstrumentId = FIXTURE_COLLATERAL,
  ) {}

  /** The JSON shape of a Daml `InstrumentId`. */
  instrument(i: InstrumentId = this.collateral): { admin: string; id: string } {
    return { admin: i.admin, id: i.id };
  }

  cid(prefix: string): string {
    this.seq += 1;
    return `00${prefix}${String(this.seq).padStart(6, "0")}`;
  }

  templateId(entity: string, module = "Truthoracle"): string {
    return `${FIXTURE_PACKAGE_ID}:${module}:${entity}`;
  }

  created(
    entity: string,
    contractId: string,
    payload: Payload,
    opts: {
      module?: string;
      signatories?: string[];
      observers?: string[];
      blob?: string | null;
      /** Interface views the stream's InterfaceFilters would attach (docs/TOKENS.md §4.2). */
      interfaceViews?: InterfaceView[];
    } = {},
  ): CreatedLedgerEvent {
    const module = opts.module ?? "Truthoracle";
    return {
      kind: "created",
      templateId: this.templateId(entity, module),
      packageName: this.packageName,
      module,
      entity,
      offset: this.offset + 1,
      nodeId: this.nodeId++,
      contractId,
      createArgument: payload,
      createdEventBlob: opts.blob === undefined ? `blob-${contractId}` : opts.blob,
      interfaceViews: opts.interfaceViews ?? [],
      signatories: opts.signatories ?? [this.admin],
      observers: opts.observers ?? [],
      witnessParties: [this.admin],
      createdAt: null,
      acsDelta: true,
    };
  }

  exercised(
    entity: string,
    contractId: string,
    choice: string,
    choiceArgument: Payload,
    opts: {
      module?: string;
      actingParties?: string[];
      consuming?: boolean;
      children?: number;
      result?: unknown;
      /** Set when the choice was exercised through an interface (token-standard transfers). */
      interfaceId?: string | null;
    } = {},
  ): ExercisedLedgerEvent {
    const module = opts.module ?? "Truthoracle";
    const nodeId = this.nodeId++;
    return {
      kind: "exercised",
      templateId: this.templateId(entity, module),
      packageName: this.packageName,
      module,
      entity,
      offset: this.offset + 1,
      nodeId,
      contractId,
      choice,
      choiceArgument,
      exerciseResult: opts.result ?? null,
      consuming: opts.consuming ?? true,
      actingParties: opts.actingParties ?? [this.admin],
      witnessParties: [this.admin],
      lastDescendantNodeId: nodeId + (opts.children ?? 0),
      interfaceId: opts.interfaceId ?? null,
    };
  }

  /** Seals the events built since the last `tx()` into one transaction at the next offset. */
  tx(
    events: (CreatedLedgerEvent | ExercisedLedgerEvent)[],
    opts: { commandId?: string; at?: Date } = {},
  ): LedgerTransaction {
    this.offset += 1;
    this.nodeId = 0;
    const at = opts.at ?? new Date(Date.UTC(2026, 0, 1) + this.offset * 60_000);
    const tx: LedgerTransaction = {
      updateId: `update-${String(this.offset).padStart(4, "0")}`,
      offset: this.offset,
      effectiveAt: at,
      recordTime: at,
      commandId: opts.commandId ?? null,
      workflowId: null,
      synchronizerId: "sync::test",
      events: events
        .map((e) => ({ ...e, offset: this.offset }))
        .sort((a, b) => a.nodeId - b.nodeId),
    };
    this.txs.push(tx);
    return tx;
  }

  // ───────────────────────────────────────────── scenarios ─────────────────────────────────────────────

  marketPayload(input: {
    marketId: number;
    question?: string;
    price?: string;
    createdAt?: number;
    expiresAt?: number;
    liquidityPeriodSecs?: number;
    feeBps?: number;
    prizeFeeShareBps?: number;
    policy?: Partial<Payload>;
    /** The market's identity (mandatory Text on truthoracle-v17); defaults are `TEST-<marketId>` in event `TEST`, `Yes` / `No`. */
    ticker?: string;
    eventTicker?: string;
    yesSubTitle?: string;
    noSubTitle?: string;
    isDynamic?: boolean;
    liquidityL?: string;
    /** The market's collateral (truthoracle-v17); defaults to the fixture's. */
    collateral?: InstrumentId;
  }): Payload {
    const createdAt = input.createdAt ?? 1_760_000_000;
    return {
      admin: this.admin,
      marketId: String(input.marketId),
      collateral: this.instrument(input.collateral),
      question: input.question ?? `Market ${input.marketId}?`,
      // no imageUrl / description / category: v17 contracts carry no presentation (docs/MARKETS.md §1)
      resolutionDescription: "resolves per source",
      createdAt: String(createdAt),
      expiresAt: String(input.expiresAt ?? createdAt + 7 * 86_400),
      gracePeriodSecs: "86400",
      isDynamic: input.isDynamic ?? false,
      liquidityPeriodSecs: String(input.liquidityPeriodSecs ?? 0),
      reserveYes: dec("100"),
      reserveNo: dec("100"),
      liquidityL: dec(input.liquidityL ?? "250.66"),
      lpTokenSupply: dec(input.liquidityL ?? "250.66"),
      currentPrice: dec(input.price ?? "0.5"),
      feeBps: String(input.feeBps ?? 100),
      prizeFeeShareBps: String(input.prizeFeeShareBps ?? 1000),
      accumulatedFees: dec(0n),
      prizePool: dec(0n),
      totalVolume: dec(0n),
      status: "Trading",
      outcome: null,
      resolvedAt: null,
      proposal: null,
      policy: {
        operatorResolution: true,
        sources: ["https://source.test/price"],
        sourceKeys: [],
        reporters: [],
        quorum: "0",
        challengeSecs: "0",
        bond: dec(0n),
        ...(input.policy ?? {}),
      },
      auditObservers: [],
      ticker: input.ticker ?? `TEST-${input.marketId}`,
      eventTicker: input.eventTicker ?? "TEST",
      yesSubTitle: input.yesSubTitle ?? "Yes",
      noSubTitle: input.noSubTitle ?? "No",
    };
  }

  /** `MarketCounter.CreateMarket` → new counter, the market, the admin's seed LP position. */
  createMarket(input: {
    marketId: number;
    counterCid?: string;
    question?: string;
    price?: string;
    createdAt?: number;
    expiresAt?: number;
    liquidityPeriodSecs?: number;
    feeBps?: number;
    policy?: Partial<Payload>;
    ticker?: string;
    eventTicker?: string;
    yesSubTitle?: string;
    noSubTitle?: string;
    isDynamic?: boolean;
    liquidityL?: string;
    collateral?: InstrumentId;
    /** Ledger time of the creating transaction. */
    at?: Date;
  }): { tx: LedgerTransaction; market: MarketFixtureState; counterCid: string; lpCid: string } {
    const payload = this.marketPayload(input);
    const marketCid = this.cid("mk");
    const counterCid = this.cid("mc");
    const lpCid = this.cid("lp");
    const root = this.exercised(
      "MarketCounter",
      input.counterCid ?? this.cid("mc"),
      "CreateMarket",
      {
        collateral: payload.collateral,
        question: payload.question,
        resolutionDescription: payload.resolutionDescription,
        createdAt: payload.createdAt,
        expiresAt: payload.expiresAt,
        gracePeriodSecs: payload.gracePeriodSecs,
        isDynamic: payload.isDynamic,
        liquidityPeriodSecs: payload.liquidityPeriodSecs,
        initialProbability: payload.currentPrice,
        initialValue: dec("200"),
        feeBps: payload.feeBps,
        prizeFeeShareBps: payload.prizeFeeShareBps,
        policy: payload.policy,
        auditObservers: [],
        ticker: payload.ticker,
        eventTicker: payload.eventTicker,
        yesSubTitle: payload.yesSubTitle,
        noSubTitle: payload.noSubTitle,
      },
      { children: 3, result: { _1: counterCid, _2: marketCid, _3: lpCid } },
    );
    const counter = this.created("MarketCounter", counterCid, {
      admin: this.admin,
      value: String(input.marketId),
    });
    const market = this.created("PredictionMarket", marketCid, payload);
    const lp = this.created(
      "LiquidityPosition",
      lpCid,
      {
        provider: this.admin,
        admin: this.admin,
        marketId: String(input.marketId),
        lpTokens: payload.lpTokenSupply,
        deposited: dec("100"),
        auditObservers: [],
      },
      { signatories: [this.admin], observers: [] },
    );
    const tx = this.tx([root, counter, market, lp], {
      commandId: `create-market-${input.marketId}`,
      at: input.at,
    });
    return { tx, market: { cid: marketCid, payload }, counterCid, lpCid };
  }

  /** A treasury-created empty `UserWallet` in `instrument` (top-level create, as `external/submit` does it). */
  createWallet(
    owner: string,
    instrument: InstrumentId = this.collateral,
  ): { tx: LedgerTransaction; wallet: WalletFixtureState } {
    const payload: Payload = {
      admin: this.admin,
      owner,
      instrument: this.instrument(instrument),
      balance: dec(0n),
      deposited: dec(0n),
      withdrawn: dec(0n),
      creditRefs: [],
      auditObservers: [],
    };
    const cid = this.cid("uw");
    const tx = this.tx([this.created("UserWallet", cid, payload, { observers: [owner] })], {
      commandId: `wallet-create-${owner.slice(0, 8)}`,
    });
    return { tx, wallet: { cid, payload } };
  }

  /** `UserWallet.Deposit` by the admin. */
  deposit(
    wallet: WalletFixtureState,
    amount: string,
    txRef: string,
  ): { tx: LedgerTransaction; wallet: WalletFixtureState } {
    const next = this.successorWallet(wallet, {
      balance: big(wallet.payload.balance) + parseAmount(amount),
      deposited: big(wallet.payload.deposited) + parseAmount(amount),
      ref: txRef,
    });
    const root = this.exercised(
      "UserWallet",
      wallet.cid,
      "Deposit",
      { amount: dec(amount), txRef },
      { children: 1, result: next.cid },
    );
    const created = this.created("UserWallet", next.cid, next.payload, {
      observers: [String(wallet.payload.owner)],
    });
    const tx = this.tx([root, created], { commandId: `deposit-${txRef}` });
    return { tx, wallet: next };
  }

  /** `UserWallet.Grant` by the admin (a reward / bonus): bumps the balance only and appends `ref` to creditRefs. */
  grant(
    wallet: WalletFixtureState,
    amount: string,
    ref: string,
    reason: string,
  ): { tx: LedgerTransaction; wallet: WalletFixtureState } {
    const next = this.successorWallet(wallet, {
      balance: big(wallet.payload.balance) + parseAmount(amount),
      ref,
    });
    const root = this.exercised(
      "UserWallet",
      wallet.cid,
      "Grant",
      { amount: dec(amount), ref, reason },
      { children: 1, result: next.cid },
    );
    const created = this.created("UserWallet", next.cid, next.payload, {
      observers: [String(wallet.payload.owner)],
    });
    const tx = this.tx([root, created], { commandId: `grant-${ref}` });
    return { tx, wallet: next };
  }

  /** `UserWallet.Withdraw` by the owner → successor wallet + a PendingPayout in the wallet's instrument. */
  withdraw(
    wallet: WalletFixtureState,
    amount: string,
    nowSeconds = 1_760_000_500,
  ): { tx: LedgerTransaction; wallet: WalletFixtureState; payoutCid: string } {
    const owner = String(wallet.payload.owner);
    const next = this.successorWallet(wallet, {
      balance: big(wallet.payload.balance) - parseAmount(amount),
      withdrawn: big(wallet.payload.withdrawn) + parseAmount(amount),
    });
    const payoutCid = this.cid("pp");
    const root = this.exercised(
      "UserWallet",
      wallet.cid,
      "Withdraw",
      { amount: dec(amount), nowSeconds: String(nowSeconds) },
      { actingParties: [owner], children: 2, result: { _1: next.cid, _2: payoutCid } },
    );
    const created = this.created("UserWallet", next.cid, next.payload, { observers: [owner] });
    const payout = this.created(
      "PendingPayout",
      payoutCid,
      {
        admin: this.admin,
        user: owner,
        marketId: "0",
        instrument: wallet.payload.instrument,
        amount: dec(amount),
        reason: "withdraw",
        createdAt: String(nowSeconds),
        auditObservers: [],
      },
      { observers: [owner] },
    );
    const tx = this.tx([root, created, payout]);
    return { tx, wallet: next, payoutCid };
  }

  /** `PendingPayout.MarkPaid` by the admin. */
  markPaid(payoutCid: string, txHash: string): LedgerTransaction {
    return this.tx([this.exercised("PendingPayout", payoutCid, "MarkPaid", { txHash })], {
      commandId: `markpaid-${payoutCid}`,
    });
  }

  /**
   * `PredictionMarket.Buy`: debit the wallet, upsert the position, successor market with the
   * given price move. `sharesOut` defaults to collateral × 1.8 (a plausible fill, not the AMM).
   */
  buy(input: {
    market: MarketFixtureState;
    wallet: WalletFixtureState;
    position?: PositionFixtureState;
    buyer: string;
    side: "Yes" | "No";
    amount: string;
    sharesOut?: string;
    newPrice?: string;
    nowSeconds?: number;
    /** Ledger time of the transaction. */
    at?: Date;
  }): {
    tx: LedgerTransaction;
    market: MarketFixtureState;
    wallet: WalletFixtureState;
    position: PositionFixtureState;
  } {
    const collateral = parseAmount(input.amount);
    const feeBps = BigInt(String(input.market.payload.feeBps));
    const prizeBps = BigInt(String(input.market.payload.prizeFeeShareBps));
    const fee = (collateral * feeBps) / 10_000n;
    const prizeCut = (fee * prizeBps) / 10_000n;
    const sharesOut = parseAmount(input.sharesOut ?? formatAmount((collateral * 18n) / 10n));
    const newPrice = parseAmount(
      input.newPrice ??
        formatAmount(
          big(input.market.payload.currentPrice) +
            (input.side === "Yes" ? 500_000_000n : -500_000_000n),
        ),
    );

    const nextWallet = this.successorWallet(input.wallet, {
      balance: big(input.wallet.payload.balance) - collateral,
    });
    const before = input.position?.payload;
    const nextPosition: PositionFixtureState = {
      cid: this.cid("ps"),
      payload: {
        holder: input.buyer,
        admin: this.admin,
        marketId: input.market.payload.marketId,
        yesShares: dec(
          (before ? big(before.yesShares) : 0n) + (input.side === "Yes" ? sharesOut : 0n),
        ),
        noShares: dec(
          (before ? big(before.noShares) : 0n) + (input.side === "No" ? sharesOut : 0n),
        ),
        costBasis: dec((before ? big(before.costBasis) : 0n) + collateral),
        auditObservers: [],
      },
    };
    const nextMarket = this.successorMarket(input.market, {
      currentPrice: dec(newPrice),
      accumulatedFees: dec(big(input.market.payload.accumulatedFees) + fee - prizeCut),
      prizePool: dec(big(input.market.payload.prizePool) + prizeCut),
      totalVolume: dec(big(input.market.payload.totalVolume) + collateral),
      reserveYes: dec(
        big(input.market.payload.reserveYes) +
          collateral -
          fee -
          (input.side === "Yes" ? sharesOut : 0n),
      ),
      reserveNo: dec(
        big(input.market.payload.reserveNo) +
          collateral -
          fee -
          (input.side === "No" ? sharesOut : 0n),
      ),
    });

    const childCount = 3 + (input.position ? 1 : 0) + 1;
    const root = this.exercised(
      "PredictionMarket",
      input.market.cid,
      "Buy",
      {
        buyer: input.buyer,
        side: input.side,
        amount: dec(collateral),
        minSharesOut: dec(0n),
        nowSeconds: String(input.nowSeconds ?? 1_760_000_600),
        existingPosition: input.position ? input.position.cid : null,
        walletCid: input.wallet.cid,
      },
      {
        actingParties: [input.buyer],
        children: childCount,
        result: { _1: nextMarket.cid, _2: nextPosition.cid, _3: nextWallet.cid },
      },
    );
    const events: (CreatedLedgerEvent | ExercisedLedgerEvent)[] = [root];
    events.push(
      this.exercised(
        "UserWallet",
        input.wallet.cid,
        "Debit",
        { amount: dec(collateral), reason: "buy" },
        { actingParties: [input.buyer, this.admin], children: 1, result: nextWallet.cid },
      ),
    );
    events.push(
      this.created("UserWallet", nextWallet.cid, nextWallet.payload, { observers: [input.buyer] }),
    );
    if (input.position)
      events.push(
        this.exercised(
          "Position",
          input.position.cid,
          "Archive",
          {},
          { actingParties: [input.buyer] },
        ),
      );
    events.push(
      this.created("Position", nextPosition.cid, nextPosition.payload, {
        signatories: [input.buyer],
        observers: [this.admin],
      }),
    );
    events.push(this.created("PredictionMarket", nextMarket.cid, nextMarket.payload));
    const tx = this.tx(events, {
      commandId: `buy-${input.buyer.slice(0, 6)}-${this.offset + 1}`,
      at: input.at,
    });
    return { tx, market: nextMarket, wallet: nextWallet, position: nextPosition };
  }

  /** `PredictionMarket.Sell`: burn shares, credit proceeds, successor market. */
  sell(input: {
    market: MarketFixtureState;
    wallet: WalletFixtureState;
    position: PositionFixtureState;
    seller: string;
    side: "Yes" | "No";
    sharesIn: string;
    gross: string;
    newPrice?: string;
    at?: Date;
  }): {
    tx: LedgerTransaction;
    market: MarketFixtureState;
    wallet: WalletFixtureState;
    position: PositionFixtureState;
  } {
    const shares = parseAmount(input.sharesIn);
    const gross = parseAmount(input.gross);
    const feeBps = BigInt(String(input.market.payload.feeBps));
    const prizeBps = BigInt(String(input.market.payload.prizeFeeShareBps));
    const fee = (gross * feeBps) / 10_000n;
    const prizeCut = (fee * prizeBps) / 10_000n;
    const net = gross - fee;
    const nextWallet = this.successorWallet(input.wallet, {
      balance: big(input.wallet.payload.balance) + net,
    });
    const p = input.position.payload;
    const nextPosition: PositionFixtureState = {
      cid: this.cid("ps"),
      payload: {
        ...p,
        yesShares: dec(big(p.yesShares) - (input.side === "Yes" ? shares : 0n)),
        noShares: dec(big(p.noShares) - (input.side === "No" ? shares : 0n)),
      },
    };
    const nextMarket = this.successorMarket(input.market, {
      currentPrice: dec(
        input.newPrice ??
          formatAmount(
            big(input.market.payload.currentPrice) -
              (input.side === "Yes" ? 300_000_000n : -300_000_000n),
          ),
      ),
      accumulatedFees: dec(big(input.market.payload.accumulatedFees) + fee - prizeCut),
      prizePool: dec(big(input.market.payload.prizePool) + prizeCut),
      totalVolume: dec(big(input.market.payload.totalVolume) + gross),
    });
    const root = this.exercised(
      "PredictionMarket",
      input.market.cid,
      "Sell",
      {
        seller: input.seller,
        side: input.side,
        sharesIn: dec(shares),
        minProceeds: dec(0n),
        nowSeconds: "1760000700",
        positionCid: input.position.cid,
        walletCid: input.wallet.cid,
      },
      {
        actingParties: [input.seller],
        children: 5,
        result: { _1: nextMarket.cid, _2: nextPosition.cid, _3: nextWallet.cid },
      },
    );
    const events = [
      root,
      this.exercised(
        "Position",
        input.position.cid,
        "Archive",
        {},
        { actingParties: [input.seller] },
      ),
      this.created("Position", nextPosition.cid, nextPosition.payload, {
        signatories: [input.seller],
        observers: [this.admin],
      }),
      this.exercised(
        "UserWallet",
        input.wallet.cid,
        "Credit",
        { amount: dec(net), reason: "sell" },
        { actingParties: [this.admin], children: 1, result: nextWallet.cid },
      ),
      this.created("UserWallet", nextWallet.cid, nextWallet.payload, { observers: [input.seller] }),
      this.created("PredictionMarket", nextMarket.cid, nextMarket.payload),
    ];
    const tx = this.tx(events, { at: input.at });
    return { tx, market: nextMarket, wallet: nextWallet, position: nextPosition };
  }

  /** `PredictionMarket.ResolveT0` by the admin. */
  resolveT0(
    market: MarketFixtureState,
    outcome: "Yes" | "No" | "VoidOutcome",
    nowSeconds = 1_760_700_000,
  ): { tx: LedgerTransaction; market: MarketFixtureState } {
    const next = this.successorMarket(market, {
      status: outcome === "VoidOutcome" ? "Voided" : "Resolved",
      outcome,
      resolvedAt: String(nowSeconds),
    });
    const root = this.exercised(
      "PredictionMarket",
      market.cid,
      "ResolveT0",
      {
        resolvedOutcome: outcome,
        sourceUri: "https://source.test/price",
        nowSeconds: String(nowSeconds),
      },
      { children: 1, result: next.cid },
    );
    const tx = this.tx([root, this.created("PredictionMarket", next.cid, next.payload)], {
      commandId: `resolve-${String(market.payload.marketId)}`,
    });
    return { tx, market: next };
  }

  /** `PredictionMarket.RedeemPosition` (non-consuming on the market): archive the position, credit the payout. */
  redeem(input: {
    market: MarketFixtureState;
    wallet: WalletFixtureState;
    position: PositionFixtureState;
    holder: string;
  }): { tx: LedgerTransaction; wallet: WalletFixtureState } {
    const p = input.position.payload;
    const m = input.market.payload;
    const payout =
      m.status === "Resolved"
        ? m.outcome === "Yes"
          ? big(p.yesShares)
          : big(p.noShares)
        : big(p.costBasis);
    const reason = m.status === "Voided" ? "void-refund" : "resolve";
    const nextWallet = this.successorWallet(input.wallet, {
      balance: big(input.wallet.payload.balance) + payout,
    });
    const root = this.exercised(
      "PredictionMarket",
      input.market.cid,
      "RedeemPosition",
      {
        holder: input.holder,
        nowSeconds: "1760800000",
        positionCid: input.position.cid,
        walletCid: input.wallet.cid,
      },
      { actingParties: [input.holder], consuming: false, children: 3, result: nextWallet.cid },
    );
    const events = [
      root,
      this.exercised(
        "Position",
        input.position.cid,
        "Archive",
        {},
        { actingParties: [input.holder] },
      ),
      this.exercised(
        "UserWallet",
        input.wallet.cid,
        "Credit",
        { amount: dec(payout), reason },
        { actingParties: [this.admin], children: 1, result: nextWallet.cid },
      ),
      this.created("UserWallet", nextWallet.cid, nextWallet.payload, { observers: [input.holder] }),
    ];
    return { tx: this.tx(events), wallet: nextWallet };
  }

  /** A Splice transfer of `amount` from `sender` to the treasury (the shape the prod deposit reader relies on). */
  spliceTransferIn(sender: string, amount: string): LedgerTransaction {
    const events = [
      this.spliceExercised(
        "TransferPreapproval",
        this.cid("tp"),
        "TransferPreapproval_SendV2",
        { sender, amount: dec(amount), description: "deposit" },
        2,
        sender,
      ),
      this.amulet(this.admin, amount),
      this.amulet(sender, "3"),
    ];
    return this.tx(events);
  }

  /** A Splice transfer from the treasury to `receiver` (a payout), with change back to the treasury. */
  spliceTransferOut(receiver: string, amount: string): LedgerTransaction {
    const events = [
      this.spliceExercised(
        "AmuletRules",
        this.cid("ar"),
        "AmuletRules_Transfer",
        { transfer: { sender: this.admin, outputs: [] } },
        2,
        this.admin,
      ),
      this.amulet(receiver, amount),
      this.amulet(this.admin, "41"),
    ];
    return this.tx(events);
  }

  /** A `Splice.Amulet:Amulet` create — Canton Coin implements the token standard, so it carries a Holding view. */
  amulet(owner: string, amount: string, contractId = this.cid("am")): CreatedLedgerEvent {
    return this.spliceCreated(
      "Amulet",
      contractId,
      { dso: FIXTURE_DSO, owner, amount: { initialAmount: dec(amount) } },
      "Splice.Amulet",
      [holdingView({ owner, instrument: FIXTURE_COLLATERAL, amount })],
    );
  }

  // ───────────────────────────────────────── token standard (docs/TOKENS.md §4.2) ─────────────────────────────────────

  /** A token-standard `Holding` create of another package (cBYN-like), with its interface view. */
  holding(
    owner: string,
    amount: string,
    opts: {
      instrument?: InstrumentId;
      lock?: { expiresAt?: Date | null } | null;
      contractId?: string;
    } = {},
  ): CreatedLedgerEvent {
    const instrument = opts.instrument ?? FIXTURE_TOKEN;
    const e = this.created(
      "Holding",
      opts.contractId ?? this.cid("hd"),
      {
        owner,
        instrument: this.instrument(instrument),
        amount: dec(amount),
        lock: opts.lock ? {} : null,
        meta: { values: {} },
      },
      {
        module: "TruthOracle.CBYN.Holding",
        signatories: [instrument.admin, owner],
        blob: null,
        interfaceViews: [holdingView({ owner, instrument, amount, lock: opts.lock ?? null })],
      },
    );
    return {
      ...e,
      packageName: FIXTURE_TOKEN_PACKAGE,
      templateId: `tokenpkg:TruthOracle.CBYN.Holding:Holding`,
    };
  }

  /** A `TransferFactory_Transfer` exercise through the TransferFactory interface on the token's factory. */
  private transferFactoryExercise(
    transfer: Record<string, unknown>,
    children: number,
    actor: string,
    result: unknown,
    factoryCid = this.cid("fy"),
  ): ExercisedLedgerEvent {
    const e = this.exercised(
      "CbynFactory",
      factoryCid,
      "TransferFactory_Transfer",
      {
        expectedAdmin: FIXTURE_TOKEN_ADMIN,
        transfer,
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
      {
        module: "TruthOracle.CBYN.Factory",
        actingParties: [actor],
        consuming: false,
        children,
        result,
        interfaceId: interfaceIdOf(TRANSFER_FACTORY_INTERFACE),
      },
    );
    return {
      ...e,
      packageName: FIXTURE_TOKEN_PACKAGE,
      templateId: "tokenpkg:TruthOracle.CBYN.Factory:CbynFactory",
    };
  }

  /** A consuming `Archive` of a holding (an input spent by a transfer). */
  private archiveHolding(contractId: string, actor: string): ExercisedLedgerEvent {
    const e = this.exercised(
      "Holding",
      contractId,
      "Archive",
      {},
      { module: "TruthOracle.CBYN.Holding", actingParties: [actor], consuming: true },
    );
    return {
      ...e,
      packageName: FIXTURE_TOKEN_PACKAGE,
      templateId: "tokenpkg:TruthOracle.CBYN.Holding:Holding",
    };
  }

  /**
   * A direct (one-step) token-standard transfer of `amount` from `sender` to the treasury: the
   * sender's input holding is consumed, the treasury receives a holding, the sender its change.
   */
  tokenTransferIn(
    sender: string,
    amount: string,
    opts: { instrument?: InstrumentId; change?: string } = {},
  ): { tx: LedgerTransaction; treasuryHoldingCid: string } {
    const instrument = opts.instrument ?? FIXTURE_TOKEN;
    const inputCid = this.cid("hd");
    const treasuryHoldingCid = this.cid("hd");
    const changeCid = this.cid("hd");
    const root = this.transferFactoryExercise(
      transferRecord({
        sender,
        receiver: this.admin,
        instrument,
        amount,
        inputHoldingCids: [inputCid],
      }),
      3,
      sender,
      {
        output: {
          tag: "TransferInstructionResult_Completed",
          value: { receiverHoldingCids: [treasuryHoldingCid] },
        },
        senderChangeCids: [changeCid],
        meta: { values: {} },
      },
    );
    const tx = this.tx([
      root,
      this.archiveHolding(inputCid, sender),
      this.holding(this.admin, amount, { instrument, contractId: treasuryHoldingCid }),
      this.holding(sender, opts.change ?? "1", { instrument, contractId: changeCid }),
    ]);
    return { tx, treasuryHoldingCid };
  }

  /**
   * A direct token-standard transfer from the treasury to `receiver` (a payout): the treasury's
   * `inputs` holdings are consumed, the receiver gets a holding, the treasury its change.
   */
  tokenTransferOut(
    receiver: string,
    amount: string,
    inputs: string[],
    opts: { instrument?: InstrumentId; change?: string } = {},
  ): { tx: LedgerTransaction; changeCid: string | null } {
    const instrument = opts.instrument ?? FIXTURE_TOKEN;
    const receiverCid = this.cid("hd");
    const changeCid = opts.change ? this.cid("hd") : null;
    const children = inputs.length + 1 + (changeCid ? 1 : 0);
    const root = this.transferFactoryExercise(
      transferRecord({
        sender: this.admin,
        receiver,
        instrument,
        amount,
        inputHoldingCids: inputs,
      }),
      children,
      this.admin,
      {
        output: {
          tag: "TransferInstructionResult_Completed",
          value: { receiverHoldingCids: [receiverCid] },
        },
        senderChangeCids: changeCid ? [changeCid] : [],
        meta: { values: {} },
      },
    );
    const events: (CreatedLedgerEvent | ExercisedLedgerEvent)[] = [root];
    for (const cid of inputs) events.push(this.archiveHolding(cid, this.admin));
    events.push(this.holding(receiver, amount, { instrument, contractId: receiverCid }));
    if (changeCid && opts.change)
      events.push(this.holding(this.admin, opts.change, { instrument, contractId: changeCid }));
    return { tx: this.tx(events), changeCid };
  }

  /**
   * A two-step offer of `amount` from `sender` to the treasury: `TransferFactory_Transfer` locks the
   * sender's input and creates a pending `TransferInstruction` (no holding reaches the treasury yet).
   */
  tokenOfferIn(
    sender: string,
    amount: string,
    opts: { instrument?: InstrumentId; executeBefore?: Date } = {},
  ): { tx: LedgerTransaction; instructionCid: string } {
    const instrument = opts.instrument ?? FIXTURE_TOKEN;
    const inputCid = this.cid("hd");
    const lockedCid = this.cid("hd");
    const instructionCid = this.cid("ti");
    const root = this.transferFactoryExercise(
      transferRecord({
        sender,
        receiver: this.admin,
        instrument,
        amount,
        inputHoldingCids: [inputCid],
        executeBefore: opts.executeBefore,
      }),
      3,
      sender,
      {
        output: {
          tag: "TransferInstructionResult_Pending",
          value: { transferInstructionCid: instructionCid },
        },
        senderChangeCids: [],
        meta: { values: {} },
      },
    );
    const instruction = this.created(
      "TransferInstruction",
      instructionCid,
      { lockedHoldingCid: lockedCid },
      {
        module: "TruthOracle.CBYN.Transfer",
        signatories: [instrument.admin, sender],
        observers: [this.admin],
        blob: null,
        interfaceViews: [
          transferInstructionView({
            sender,
            receiver: this.admin,
            instrument,
            amount,
            executeBefore: opts.executeBefore,
          }),
        ],
      },
    );
    const tx = this.tx([
      root,
      this.archiveHolding(inputCid, sender),
      this.holding(sender, amount, {
        instrument,
        lock: { expiresAt: opts.executeBefore ?? null },
        contractId: lockedCid,
      }),
      {
        ...instruction,
        packageName: FIXTURE_TOKEN_PACKAGE,
        templateId: "tokenpkg:TruthOracle.CBYN.Transfer:TransferInstruction",
      },
    ]);
    return { tx, instructionCid };
  }

  /** `TransferInstruction_Accept` by the treasury: the offer is consumed and the treasury receives its holding. */
  acceptInstruction(
    instructionCid: string,
    amount: string,
    opts: { instrument?: InstrumentId } = {},
  ): { tx: LedgerTransaction; treasuryHoldingCid: string } {
    const instrument = opts.instrument ?? FIXTURE_TOKEN;
    const treasuryHoldingCid = this.cid("hd");
    const accept = this.exercised(
      "TransferInstruction",
      instructionCid,
      "TransferInstruction_Accept",
      { extraArgs: { context: { values: {} }, meta: { values: {} } } },
      {
        module: "TruthOracle.CBYN.Transfer",
        actingParties: [this.admin],
        consuming: true,
        children: 1,
        interfaceId: interfaceIdOf(TRANSFER_INSTRUCTION_INTERFACE),
        result: {
          output: {
            tag: "TransferInstructionResult_Completed",
            value: { receiverHoldingCids: [treasuryHoldingCid] },
          },
          senderChangeCids: [],
          meta: { values: {} },
        },
      },
    );
    const tx = this.tx(
      [
        {
          ...accept,
          packageName: FIXTURE_TOKEN_PACKAGE,
          templateId: "tokenpkg:TruthOracle.CBYN.Transfer:TransferInstruction",
        },
        this.holding(this.admin, amount, { instrument, contractId: treasuryHoldingCid }),
      ],
      { commandId: `ti-accept-${instructionCid}` },
    );
    return { tx, treasuryHoldingCid };
  }

  /** `TransferInstruction_Reject` / `_Withdraw`: the offer is consumed without delivering. */
  endInstruction(
    instructionCid: string,
    choice: "TransferInstruction_Reject" | "TransferInstruction_Withdraw",
    actor: string,
  ): LedgerTransaction {
    const e = this.exercised(
      "TransferInstruction",
      instructionCid,
      choice,
      { extraArgs: { context: { values: {} }, meta: { values: {} } } },
      {
        module: "TruthOracle.CBYN.Transfer",
        actingParties: [actor],
        consuming: true,
        interfaceId: interfaceIdOf(TRANSFER_INSTRUCTION_INTERFACE),
      },
    );
    return this.tx([
      {
        ...e,
        packageName: FIXTURE_TOKEN_PACKAGE,
        templateId: "tokenpkg:TruthOracle.CBYN.Transfer:TransferInstruction",
      },
    ]);
  }

  /**
   * Canton Coin moved THROUGH the token standard (`TransferFactory_Transfer` on the DSO's
   * ExternalPartyAmuletRules, which calls `AmuletRules_Transfer` underneath): the subtree an
   * Amulet-only reader would count once more.
   */
  amuletTokenStandardTransferIn(sender: string, amount: string): LedgerTransaction {
    const treasuryCid = this.cid("am");
    const root = this.exercised(
      "ExternalPartyAmuletRules",
      this.cid("ep"),
      "TransferFactory_Transfer",
      {
        expectedAdmin: FIXTURE_DSO,
        transfer: transferRecord({
          sender,
          receiver: this.admin,
          instrument: FIXTURE_COLLATERAL,
          amount,
        }),
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
      {
        module: "Splice.ExternalPartyAmuletRules",
        actingParties: [sender],
        consuming: false,
        children: 3,
        interfaceId: interfaceIdOf(TRANSFER_FACTORY_INTERFACE),
        result: {
          output: {
            tag: "TransferInstructionResult_Completed",
            value: { receiverHoldingCids: [treasuryCid] },
          },
          senderChangeCids: [],
          meta: { values: {} },
        },
      },
    );
    const inner = this.spliceExercised(
      "AmuletRules",
      this.cid("ar"),
      "AmuletRules_Transfer",
      { transfer: { sender, outputs: [] } },
      2,
      sender,
    );
    return this.tx([
      {
        ...root,
        packageName: SPLICE_PACKAGE_NAME,
        templateId: "splicepkg:Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules",
      },
      inner,
      this.amulet(this.admin, amount, treasuryCid),
      this.amulet(sender, "2"),
    ]);
  }

  /** An ACS snapshot entry of a token-standard holding (its interface view included). */
  holdingAcsEntry(
    owner: string,
    amount: string,
    opts: { instrument?: InstrumentId; offset?: number; contractId?: string } = {},
  ): ActiveContractEntry {
    const created = this.holding(owner, amount, {
      instrument: opts.instrument,
      contractId: opts.contractId,
    });
    return {
      created: { ...created, offset: opts.offset ?? this.offset, nodeId: 0 },
      synchronizerId: "sync::test",
    };
  }

  /** An ACS snapshot entry for a contract (its own create offset / node id preserved). */
  acsEntry(
    entity: string,
    contractId: string,
    payload: Payload,
    opts: { module?: string; offset?: number; observers?: string[] } = {},
  ): ActiveContractEntry {
    const created = this.created(entity, contractId, payload, {
      module: opts.module,
      observers: opts.observers,
    });
    return {
      created: { ...created, offset: opts.offset ?? this.offset, nodeId: 0 },
      synchronizerId: "sync::test",
    };
  }

  // ───────────────────────────────────────────── internals ─────────────────────────────────────────────

  successorWallet(
    wallet: WalletFixtureState,
    change: { balance?: bigint; deposited?: bigint; withdrawn?: bigint; ref?: string },
  ): WalletFixtureState {
    const p = wallet.payload;
    return {
      cid: this.cid("uw"),
      payload: {
        ...p,
        balance: dec(change.balance ?? big(p.balance)),
        deposited: dec(change.deposited ?? big(p.deposited)),
        withdrawn: dec(change.withdrawn ?? big(p.withdrawn)),
        creditRefs: change.ref
          ? [change.ref, ...(p.creditRefs as string[])]
          : [...(p.creditRefs as string[])],
      },
    };
  }

  successorMarket(market: MarketFixtureState, patch: Payload): MarketFixtureState {
    return { cid: this.cid("mk"), payload: { ...market.payload, ...patch } };
  }

  private spliceCreated(
    entity: string,
    contractId: string,
    payload: Payload,
    module: string,
    interfaceViews: InterfaceView[] = [],
  ): CreatedLedgerEvent {
    const e = this.created(entity, contractId, payload, { module, blob: null, interfaceViews });
    return { ...e, packageName: SPLICE_PACKAGE_NAME, templateId: `splicepkg:${module}:${entity}` };
  }

  private spliceExercised(
    entity: string,
    contractId: string,
    choice: string,
    arg: Payload,
    children: number,
    actor: string,
  ): ExercisedLedgerEvent {
    const e = this.exercised(entity, contractId, choice, arg, {
      module: "Splice.AmuletRules",
      actingParties: [actor],
      consuming: false,
      children,
    });
    return {
      ...e,
      packageName: SPLICE_PACKAGE_NAME,
      templateId: `splicepkg:Splice.AmuletRules:${entity}`,
    };
  }
}

export function parties(n: number, hint = "party"): string[] {
  return Array.from(
    { length: n },
    (_, i) => `${hint}${i + 1}::1220${String(i + 1).padStart(64, "0")}`,
  );
}
