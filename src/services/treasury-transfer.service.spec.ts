import { parseAmount } from "../util/money";
import {
  damlTime,
  isSpendable,
  selectHoldings,
  setupCommandId,
  transferFactoryArgument,
  transferFactoryCommand,
  transferMeta,
  type SpendableHolding,
} from "./treasury-transfer.service";

const NOW = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));
const TREASURY = "treasury::1220" + "f".repeat(64);
const AGENT = "agent::1220" + "c".repeat(64);
const ALICE = "alice::1220" + "a".repeat(64);

const holding = (
  contractId: string,
  amount: string,
  lock: Partial<Pick<SpendableHolding, "locked" | "lockExpiresAt">> = {},
): SpendableHolding => ({
  contractId,
  amount: parseAmount(amount),
  locked: lock.locked ?? false,
  lockExpiresAt: lock.lockExpiresAt ?? null,
});

describe("holding selection (docs/TOKENS.md §4.4)", () => {
  it("spends the largest unlocked holdings first and stops once the amount is covered", () => {
    const picked = selectHoldings(
      [holding("a", "1"), holding("b", "50"), holding("c", "10"), holding("d", "0")],
      parseAmount("55"),
      NOW,
    );
    expect(picked).toEqual({ contractIds: ["b", "c"], total: parseAmount("60") });
  });

  it("skips locked holdings unless their lock has expired, and refuses when the rest does not cover the amount", () => {
    const expired = new Date(NOW.getTime() - 1000);
    const live = new Date(NOW.getTime() + 1000);
    expect(isSpendable(holding("x", "1"), NOW)).toBe(true);
    expect(isSpendable(holding("x", "1", { locked: true }), NOW)).toBe(false);
    expect(isSpendable(holding("x", "1", { locked: true, lockExpiresAt: live }), NOW)).toBe(false);
    expect(isSpendable(holding("x", "1", { locked: true, lockExpiresAt: expired }), NOW)).toBe(
      true,
    );
    const holdings = [
      holding("locked", "100", { locked: true, lockExpiresAt: live }),
      holding("was-locked", "6", { locked: true, lockExpiresAt: expired }),
      holding("free", "5"),
    ];
    expect(selectHoldings(holdings, parseAmount("11"), NOW)).toEqual({
      contractIds: ["was-locked", "free"],
      total: parseAmount("11"),
    });
    expect(selectHoldings(holdings, parseAmount("11.0000000001"), NOW)).toBeNull();
    expect(selectHoldings([], parseAmount("1"), NOW)).toBeNull();
    expect(selectHoldings([], 0n, NOW)).toEqual({ contractIds: [], total: 0n });
  });
});

describe("TransferFactory_Transfer argument and command", () => {
  const base = {
    admin: AGENT,
    sender: TREASURY,
    receiver: ALICE,
    instrument: { admin: AGENT, id: "cBYN" },
    amount: parseAmount("12.5"),
    inputHoldingCids: ["00h1", "00h2"],
    requestedAt: NOW,
    executeBefore: new Date(NOW.getTime() + 600_000),
    meta: transferMeta("withdraw", { pending_payout_cid: "00pp" }),
    context: { values: { tokenConfigCid: { tag: "AV_ContractId", value: "00cfg" } } },
  };

  it("encodes the Daml values the JSON Ledger API expects: 10-dp amount, microsecond times, the registry context verbatim", () => {
    expect(damlTime(NOW)).toBe("2026-10-15T12:00:00.000000Z");
    expect(transferFactoryArgument(base)).toEqual({
      expectedAdmin: AGENT,
      transfer: {
        sender: TREASURY,
        receiver: ALICE,
        amount: "12.5000000000",
        instrumentId: { admin: AGENT, id: "cBYN" },
        requestedAt: "2026-10-15T12:00:00.000000Z",
        executeBefore: "2026-10-15T12:10:00.000000Z",
        inputHoldingCids: ["00h1", "00h2"],
        meta: {
          values: { "truthoracle/reason": "withdraw", "truthoracle/pending_payout_cid": "00pp" },
        },
      },
      extraArgs: { context: base.context, meta: { values: {} } },
    });
  });

  it("exercises the choice through the TransferFactory interface id on the registry's factory", () => {
    const command = transferFactoryCommand("00factory", transferFactoryArgument(base));
    expect(command.ExerciseCommand).toMatchObject({
      templateId:
        "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
      contractId: "00factory",
      choice: "TransferFactory_Transfer",
    });
    expect(command.ExerciseCommand.choiceArgument.expectedAdmin).toBe(AGENT);
  });

  it("derives one setup command id per instrument, action and treasury", () => {
    const a = setupCommandId("autoAccept", { admin: AGENT, id: "cBYN" }, TREASURY);
    expect(a).toMatch(/^setup-autoaccept-[0-9a-f]{40}$/);
    expect(setupCommandId("autoAccept", { admin: AGENT, id: "cBYN" }, TREASURY)).toBe(a);
    expect(setupCommandId("mintDelegation", { admin: AGENT, id: "cBYN" }, TREASURY)).toMatch(
      /^setup-mintdelegation-/,
    );
    expect(setupCommandId("autoAccept", { admin: AGENT, id: "TRO" }, TREASURY)).not.toBe(a);
  });
});
