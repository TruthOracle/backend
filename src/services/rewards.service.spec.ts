import { formatAmount, parseAmount } from "../util/money";
import {
  autoMintAmount,
  evaluateMarketEvent,
  evaluateWalletEntry,
  floatHeadroom,
  floatShortfall,
  formatRewardsCursor,
  grantAttemptOf,
  grantCommand,
  grantCommandId,
  grantRef,
  parseRewardsCursor,
  REWARD_RULE_DEFAULTS,
  scaledReward,
  validateRuleParams,
  type RuleParams,
} from "./rewards.service";

const DSO = "DSO::1220" + "d".repeat(64);
const CC = { admin: DSO, id: "Amulet" };
const AGENT = "agent::1220" + "c".repeat(64);
const CBYN = { admin: AGENT, id: "cBYN" };
const ALICE = "alice::1220" + "a".repeat(64);
const dec = (v: string): bigint => parseAmount(v);
const defaults = (): RuleParams =>
  new Map(
    Object.entries(REWARD_RULE_DEFAULTS) as [
      keyof typeof REWARD_RULE_DEFAULTS,
      Record<string, string>,
    ][],
  );

describe("reward rule parameters (docs/TOKENS.md §4.6)", () => {
  it("accepts exactly the kind's keys as decimal strings and trims them", () => {
    expect(validateRuleParams("trade_volume_rebate", { perUnit: " 0.02 ", minTrade: "5" })).toEqual(
      {
        perUnit: "0.02",
        minTrade: "5",
      },
    );
    expect(validateRuleParams("first_deposit_bonus", { amount: "25" })).toEqual({ amount: "25" });
  });

  it("refuses unknown keys, missing keys, numbers, negatives and a fraction above 1; manual has no params", () => {
    expect(() => validateRuleParams("trade_volume_rebate", { perUnit: "0.01" })).toThrow(
      /minTrade/,
    );
    expect(() =>
      validateRuleParams("trade_volume_rebate", { perUnit: "0.01", minTrade: "1", x: "1" }),
    ).toThrow(/no parameter x/);
    expect(() => validateRuleParams("first_deposit_bonus", { amount: 10 })).toThrow(
      /decimal string/,
    );
    expect(() => validateRuleParams("first_deposit_bonus", { amount: "-1" })).toThrow(
      /decimal string/,
    );
    expect(() => validateRuleParams("winning_redeem_bonus", { fraction: "1.5" })).toThrow(
      /at most 1/,
    );
    expect(() => validateRuleParams("manual", {})).toThrow(/manual grants/);
  });
});

describe("rewards cursor", () => {
  it("round-trips and reads the seed / junk as the start", () => {
    expect(parseRewardsCursor("0")).toEqual({ offset: 0, walletEntryId: 0n, marketEventId: 0n });
    expect(parseRewardsCursor(null)).toEqual({ offset: 0, walletEntryId: 0n, marketEventId: 0n });
    expect(parseRewardsCursor("nope")).toEqual({ offset: 0, walletEntryId: 0n, marketEventId: 0n });
    const cursor = { offset: 42, walletEntryId: 7n, marketEventId: 99n };
    expect(formatRewardsCursor(cursor)).toBe("42:7:99");
    expect(parseRewardsCursor("42:7:99")).toEqual(cursor);
  });
});

describe("grant ids", () => {
  it("derives the ref from the grant and a fresh command id per attempt", () => {
    expect(grantRef("g1")).toBe("reward:g1");
    expect(grantCommandId("g1", 1)).toBe("reward-grant-g1-1");
    expect(grantAttemptOf(null)).toBe(0);
    expect(grantAttemptOf("reward-grant-g1-3")).toBe(3);
  });

  it("shapes `UserWallet.Grant { amount, ref, reason }` with the v17 argument names", () => {
    expect(
      grantCommand(
        "pkg:Truthoracle:UserWallet",
        {
          contractId: "00uw",
          owner: ALICE,
          instrument: { admin: AGENT, id: "TRO" },
          balance: 0n,
          deposited: 0n,
          withdrawn: 0n,
          creditRefs: [],
          auditObservers: [],
        },
        {
          amount: dec("0.1"),
          ref: "reward:g1",
          reason: "trade_volume_rebate",
          kind: "trade_volume_rebate",
        },
      ),
    ).toEqual({
      ExerciseCommand: {
        templateId: "pkg:Truthoracle:UserWallet",
        contractId: "00uw",
        choice: "Grant",
        choiceArgument: {
          amount: formatAmount(dec("0.1")),
          ref: "reward:g1",
          reason: "trade_volume_rebate",
        },
      },
    });
  });
});

describe("reward amounts", () => {
  it("scales in exact fixed point and quantises down to the instrument's decimals", () => {
    expect(scaledReward(dec("10"), dec("0.01"), 6)).toBe(dec("0.1"));
    expect(scaledReward(dec("18"), dec("0.05"), 6)).toBe(dec("0.9"));
    // 1.2345678 × 0.01 = 0.012345678 → 0.012345 at 6 decimals
    expect(scaledReward(dec("1.2345678"), dec("0.01"), 6)).toBe(dec("0.012345"));
    expect(scaledReward(0n, dec("0.01"), 6)).toBe(0n);
    expect(scaledReward(dec("10"), 0n, 6)).toBe(0n);
  });

  it("the float rule: headroom = holdings − liabilities − pending; the shortfall covers the grant; the auto-mint is at least the minimum", () => {
    const state = { treasuryHoldings: dec("100"), liabilities: dec("60"), pending: dec("30") };
    expect(floatHeadroom(state)).toBe(dec("10"));
    expect(floatShortfall(state, dec("10"))).toBe(0n);
    expect(floatShortfall(state, dec("12.5"))).toBe(dec("2.5"));
    expect(autoMintAmount(dec("2.5"), dec("1000"), 6)).toBe(dec("1000"));
    expect(autoMintAmount(dec("2500"), dec("1000"), 6)).toBe(dec("2500"));
    // A shortfall finer than the token's unit still needs one unit minted.
    expect(autoMintAmount(dec("0.0000001"), 0n, 6)).toBe(dec("0.000001"));
  });
});

describe("rule evaluation", () => {
  it("rebates buys and sells of default-collateral markets at or above minTrade, in TRO units", () => {
    const market = { collateralAdmin: DSO, collateralId: "Amulet" };
    expect(
      evaluateMarketEvent(
        { eventId: "e1", kind: "buy", actor: ALICE, amount: dec("10"), outcome: null },
        market,
        defaults(),
        CC,
        6,
      ),
    ).toEqual({
      kind: "trade_volume_rebate",
      party: ALICE,
      sourceEventId: "e1",
      amount: dec("0.1"),
      reason: "trade_volume_rebate",
    });
    expect(
      evaluateMarketEvent(
        { eventId: "e2", kind: "sell", actor: ALICE, amount: dec("0.5"), outcome: null },
        market,
        defaults(),
        CC,
        6,
      ),
    ).toBeNull();
    // Another collateral, an unknown market, a non-trade kind, a disabled rule: nothing.
    expect(
      evaluateMarketEvent(
        { eventId: "e3", kind: "buy", actor: ALICE, amount: dec("10"), outcome: null },
        { collateralAdmin: AGENT, collateralId: "cBYN" },
        defaults(),
        CC,
        6,
      ),
    ).toBeNull();
    expect(
      evaluateMarketEvent(
        { eventId: "e4", kind: "buy", actor: ALICE, amount: dec("10"), outcome: null },
        null,
        defaults(),
        CC,
        6,
      ),
    ).toBeNull();
    expect(
      evaluateMarketEvent(
        {
          eventId: "e5",
          kind: "provide_liquidity",
          actor: ALICE,
          amount: dec("10"),
          outcome: null,
        },
        market,
        defaults(),
        CC,
        6,
      ),
    ).toBeNull();
    expect(
      evaluateMarketEvent(
        { eventId: "e6", kind: "buy", actor: ALICE, amount: dec("10"), outcome: null },
        market,
        new Map([["winning_redeem_bonus", { fraction: "0.05" }]]),
        CC,
        6,
      ),
    ).toBeNull();
  });

  it("pays the redeem bonus on a winning redemption only (a voided market refunds)", () => {
    const market = { collateralAdmin: DSO, collateralId: "Amulet" };
    expect(
      evaluateMarketEvent(
        { eventId: "r1", kind: "redeem", actor: ALICE, amount: dec("18"), outcome: "Yes" },
        market,
        defaults(),
        CC,
        6,
      ),
    ).toMatchObject({ kind: "winning_redeem_bonus", amount: dec("0.9"), sourceEventId: "r1" });
    expect(
      evaluateMarketEvent(
        { eventId: "r2", kind: "redeem", actor: ALICE, amount: dec("18"), outcome: "VoidOutcome" },
        market,
        defaults(),
        CC,
        6,
      ),
    ).toBeNull();
    expect(
      evaluateMarketEvent(
        { eventId: "r3", kind: "redeem", actor: ALICE, amount: 0n, outcome: "No" },
        market,
        defaults(),
        CC,
        6,
      ),
    ).toBeNull();
  });

  it("the deposit bonus wants a deposit entry in the default collateral that is not an operator mint credit", () => {
    const entry = {
      eventId: "d1",
      kind: "deposit" as const,
      owner: ALICE,
      instrumentAdmin: DSO,
      instrumentId: "Amulet",
      txRef: "reconcile:deposit-abc",
    };
    expect(evaluateWalletEntry(entry, defaults(), CC, 6)).toEqual({
      kind: "first_deposit_bonus",
      party: ALICE,
      sourceEventId: "d1",
      amount: dec("10"),
      reason: "first_deposit_bonus",
    });
    expect(evaluateWalletEntry({ ...entry, txRef: "mint:mint-abc" }, defaults(), CC, 6)).toBeNull();
    expect(evaluateWalletEntry({ ...entry, kind: "grant" }, defaults(), CC, 6)).toBeNull();
    expect(
      evaluateWalletEntry(
        { ...entry, instrumentAdmin: CBYN.admin, instrumentId: CBYN.id },
        defaults(),
        CC,
        6,
      ),
    ).toBeNull();
    expect(
      evaluateWalletEntry(
        entry,
        new Map([["trade_volume_rebate", REWARD_RULE_DEFAULTS.trade_volume_rebate]]),
        CC,
        6,
      ),
    ).toBeNull();
  });
});
