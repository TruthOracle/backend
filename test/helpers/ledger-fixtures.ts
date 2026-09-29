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
  LedgerTransaction,
} from "../../src/indexer/events";
import { formatCC, parseCC } from "../../src/util/money";

export const FIXTURE_PACKAGE_ID = "fakepkg";
/** Must equal TRUTHORACLE_PACKAGE_NAME in `testEnv()` (test/helpers/app.ts). */
export const FIXTURE_PACKAGE_NAME = "truthoracle-test";
export const SPLICE_PACKAGE_NAME = "splice-amulet";

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

const dec = (v: bigint | string | number): string => formatCC(parseCC(v));
const big = (v: unknown): bigint => parseCC(String(v));

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
  ) {}

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
      interfaceId: null,
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
    /** The market's identity (mandatory Text on truthoracle-v16); defaults are `TEST-<marketId>` in event `TEST`, `Yes` / `No`. */
    ticker?: string;
    eventTicker?: string;
    yesSubTitle?: string;
    noSubTitle?: string;
    isDynamic?: boolean;
    liquidityL?: string;
  }): Payload {
    const createdAt = input.createdAt ?? 1_760_000_000;
    return {
      admin: this.admin,
      marketId: String(input.marketId),
      question: input.question ?? `Market ${input.marketId}?`,
      // no imageUrl / description / category: v16 contracts carry no presentation (docs/MARKETS.md §1)
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
      accumulatedFeesCC: dec(0n),
      prizePoolCC: dec(0n),
      totalVolumeCC: dec(0n),
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
        bondCC: dec(0n),
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
        question: payload.question,
        resolutionDescription: payload.resolutionDescription,
        createdAt: payload.createdAt,
        expiresAt: payload.expiresAt,
        gracePeriodSecs: payload.gracePeriodSecs,
        isDynamic: payload.isDynamic,
        liquidityPeriodSecs: payload.liquidityPeriodSecs,
        initialProbability: payload.currentPrice,
        initialValueCC: dec("200"),
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
        depositedCC: dec("100"),
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

  /** A treasury-created empty `UserWallet` (top-level create, as `external/submit` does it). */
  createWallet(owner: string): { tx: LedgerTransaction; wallet: WalletFixtureState } {
    const payload: Payload = {
      admin: this.admin,
      owner,
      balanceCC: dec(0n),
      depositedCC: dec(0n),
      withdrawnCC: dec(0n),
      depositRefs: [],
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
    amountCC: string,
    txRef: string,
  ): { tx: LedgerTransaction; wallet: WalletFixtureState } {
    const next = this.successorWallet(wallet, {
      balance: big(wallet.payload.balanceCC) + parseCC(amountCC),
      deposited: big(wallet.payload.depositedCC) + parseCC(amountCC),
      ref: txRef,
    });
    const root = this.exercised(
      "UserWallet",
      wallet.cid,
      "Deposit",
      { amountCC: dec(amountCC), txRef },
      { children: 1, result: next.cid },
    );
    const created = this.created("UserWallet", next.cid, next.payload, {
      observers: [String(wallet.payload.owner)],
    });
    const tx = this.tx([root, created], { commandId: `deposit-${txRef}` });
    return { tx, wallet: next };
  }

  /** `UserWallet.Withdraw` by the owner → successor wallet + a PendingPayout. */
  withdraw(
    wallet: WalletFixtureState,
    amountCC: string,
    nowSeconds = 1_760_000_500,
  ): { tx: LedgerTransaction; wallet: WalletFixtureState; payoutCid: string } {
    const owner = String(wallet.payload.owner);
    const next = this.successorWallet(wallet, {
      balance: big(wallet.payload.balanceCC) - parseCC(amountCC),
      withdrawn: big(wallet.payload.withdrawnCC) + parseCC(amountCC),
    });
    const payoutCid = this.cid("pp");
    const root = this.exercised(
      "UserWallet",
      wallet.cid,
      "Withdraw",
      { amountCC: dec(amountCC), nowSeconds: String(nowSeconds) },
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
        amountCC: dec(amountCC),
        reason: "withdraw",
        createdAt: String(nowSeconds),
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
    collateralCC: string;
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
    const collateral = parseCC(input.collateralCC);
    const feeBps = BigInt(String(input.market.payload.feeBps));
    const prizeBps = BigInt(String(input.market.payload.prizeFeeShareBps));
    const fee = (collateral * feeBps) / 10_000n;
    const prizeCut = (fee * prizeBps) / 10_000n;
    const sharesOut = parseCC(input.sharesOut ?? formatCC((collateral * 18n) / 10n));
    const newPrice = parseCC(
      input.newPrice ??
        formatCC(
          big(input.market.payload.currentPrice) +
            (input.side === "Yes" ? 500_000_000n : -500_000_000n),
        ),
    );

    const nextWallet = this.successorWallet(input.wallet, {
      balance: big(input.wallet.payload.balanceCC) - collateral,
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
        costBasisCC: dec((before ? big(before.costBasisCC) : 0n) + collateral),
        auditObservers: [],
      },
    };
    const nextMarket = this.successorMarket(input.market, {
      currentPrice: dec(newPrice),
      accumulatedFeesCC: dec(big(input.market.payload.accumulatedFeesCC) + fee - prizeCut),
      prizePoolCC: dec(big(input.market.payload.prizePoolCC) + prizeCut),
      totalVolumeCC: dec(big(input.market.payload.totalVolumeCC) + collateral),
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
        collateralCC: dec(collateral),
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
        { amountCC: dec(collateral), reason: "buy" },
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
    grossCC: string;
    newPrice?: string;
    at?: Date;
  }): {
    tx: LedgerTransaction;
    market: MarketFixtureState;
    wallet: WalletFixtureState;
    position: PositionFixtureState;
  } {
    const shares = parseCC(input.sharesIn);
    const gross = parseCC(input.grossCC);
    const feeBps = BigInt(String(input.market.payload.feeBps));
    const prizeBps = BigInt(String(input.market.payload.prizeFeeShareBps));
    const fee = (gross * feeBps) / 10_000n;
    const prizeCut = (fee * prizeBps) / 10_000n;
    const net = gross - fee;
    const nextWallet = this.successorWallet(input.wallet, {
      balance: big(input.wallet.payload.balanceCC) + net,
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
          formatCC(
            big(input.market.payload.currentPrice) -
              (input.side === "Yes" ? 300_000_000n : -300_000_000n),
          ),
      ),
      accumulatedFeesCC: dec(big(input.market.payload.accumulatedFeesCC) + fee - prizeCut),
      prizePoolCC: dec(big(input.market.payload.prizePoolCC) + prizeCut),
      totalVolumeCC: dec(big(input.market.payload.totalVolumeCC) + gross),
    });
    const root = this.exercised(
      "PredictionMarket",
      input.market.cid,
      "Sell",
      {
        seller: input.seller,
        side: input.side,
        sharesIn: dec(shares),
        minProceedsCC: dec(0n),
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
        { amountCC: dec(net), reason: "sell" },
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
        : big(p.costBasisCC);
    const reason = m.status === "Voided" ? "void-refund" : "resolve";
    const nextWallet = this.successorWallet(input.wallet, {
      balance: big(input.wallet.payload.balanceCC) + payout,
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
        { amountCC: dec(payout), reason },
        { actingParties: [this.admin], children: 1, result: nextWallet.cid },
      ),
      this.created("UserWallet", nextWallet.cid, nextWallet.payload, { observers: [input.holder] }),
    ];
    return { tx: this.tx(events), wallet: nextWallet };
  }

  /** A Splice transfer of `amountCC` from `sender` to the treasury (the shape the prod deposit reader relies on). */
  spliceTransferIn(sender: string, amountCC: string): LedgerTransaction {
    const events = [
      this.spliceExercised(
        "TransferPreapproval",
        this.cid("tp"),
        "TransferPreapproval_SendV2",
        { sender, amount: dec(amountCC), description: "deposit" },
        2,
        sender,
      ),
      this.spliceCreated(
        "Amulet",
        this.cid("am"),
        { owner: this.admin, amount: { initialAmount: dec(amountCC) } },
        "Splice.Amulet",
      ),
      this.spliceCreated(
        "Amulet",
        this.cid("am"),
        { owner: sender, amount: { initialAmount: dec("3") } },
        "Splice.Amulet",
      ),
    ];
    return this.tx(events);
  }

  /** A Splice transfer from the treasury to `receiver` (a payout), with change back to the treasury. */
  spliceTransferOut(receiver: string, amountCC: string): LedgerTransaction {
    const events = [
      this.spliceExercised(
        "AmuletRules",
        this.cid("ar"),
        "AmuletRules_Transfer",
        { transfer: { sender: this.admin, outputs: [] } },
        2,
        this.admin,
      ),
      this.spliceCreated(
        "Amulet",
        this.cid("am"),
        { owner: receiver, amount: { initialAmount: dec(amountCC) } },
        "Splice.Amulet",
      ),
      this.spliceCreated(
        "Amulet",
        this.cid("am"),
        { owner: this.admin, amount: { initialAmount: dec("41") } },
        "Splice.Amulet",
      ),
    ];
    return this.tx(events);
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
        balanceCC: dec(change.balance ?? big(p.balanceCC)),
        depositedCC: dec(change.deposited ?? big(p.depositedCC)),
        withdrawnCC: dec(change.withdrawn ?? big(p.withdrawnCC)),
        depositRefs: change.ref
          ? [change.ref, ...(p.depositRefs as string[])]
          : [...(p.depositRefs as string[])],
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
  ): CreatedLedgerEvent {
    const e = this.created(entity, contractId, payload, { module, blob: null });
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
