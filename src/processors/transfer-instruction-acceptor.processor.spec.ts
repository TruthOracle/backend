import {
  acceptCommand,
  acceptCommandId,
  acceptorDecision,
} from "./transfer-instruction-acceptor.processor";

const TREASURY = "treasury::1220" + "f".repeat(64);
const ALICE = "alice::1220" + "a".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));

describe("acceptor decisions (docs/TOKENS.md §4.4)", () => {
  const pending = {
    receiver: TREASURY,
    executeBefore: new Date(NOW.getTime() + 60_000),
    status: "pending" as const,
  };

  it("accepts a pending offer to the treasury in a known, enabled instrument that has not expired", () => {
    expect(acceptorDecision(pending, { enabled: true }, TREASURY, NOW)).toEqual({
      action: "accept",
    });
    expect(
      acceptorDecision({ ...pending, executeBefore: null }, { enabled: true }, TREASURY, NOW),
    ).toEqual({
      action: "accept",
    });
  });

  it("leaves unknown or disabled instruments pending — nobody accepts a token the platform has not vetted", () => {
    expect(acceptorDecision(pending, null, TREASURY, NOW)).toEqual({
      action: "skip",
      reason: "unknown_instrument",
    });
    expect(acceptorDecision(pending, { enabled: false }, TREASURY, NOW)).toEqual({
      action: "skip",
      reason: "instrument_disabled",
    });
  });

  it("skips expired offers and anything not addressed to the treasury or no longer pending", () => {
    expect(
      acceptorDecision({ ...pending, executeBefore: NOW }, { enabled: true }, TREASURY, NOW),
    ).toEqual({
      action: "skip",
      reason: "expired",
    });
    expect(
      acceptorDecision({ ...pending, receiver: ALICE }, { enabled: true }, TREASURY, NOW),
    ).toEqual({
      action: "skip",
      reason: "not_for_treasury",
    });
    expect(
      acceptorDecision({ ...pending, status: "completed" }, { enabled: true }, TREASURY, NOW),
    ).toEqual({
      action: "skip",
      reason: "not_for_treasury",
    });
  });

  it("builds TransferInstruction_Accept through the interface id with the registry's context, under one id per offer", () => {
    expect(acceptCommandId("00ti")).toMatch(/^ti-accept-[0-9a-f]{40}$/);
    expect(acceptCommandId("00ti")).toBe(acceptCommandId("00ti"));
    const command = acceptCommand("00ti", {
      choiceContextData: { values: { k: { tag: "AV_Text", value: "v" } } },
      disclosedContracts: [],
    });
    expect(command).toEqual({
      ExerciseCommand: {
        templateId:
          "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        contractId: "00ti",
        choice: "TransferInstruction_Accept",
        choiceArgument: {
          extraArgs: {
            context: { values: { k: { tag: "AV_Text", value: "v" } } },
            meta: { values: {} },
          },
        },
      },
    });
  });
});
