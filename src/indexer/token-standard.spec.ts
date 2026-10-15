import {
  FIXTURE_COLLATERAL,
  FIXTURE_TOKEN,
  LedgerFixture,
  parties,
  SPLICE_PACKAGE_NAME,
} from "../../test/helpers/ledger-fixtures";
import { formatAmount, parseAmount } from "../util/money";
import { parseActiveContractsPage } from "./events";
import { extractTreasuryTransfers } from "./splice";
import {
  extractTokenStandard,
  holdingViewOf,
  HOLDING_INTERFACE,
  interfaceFilterId,
  isInterface,
  TRANSFER_INSTRUCTION_INTERFACE,
  transferInstructionViewOf,
  type HoldingView,
  type TransferInstructionView,
} from "./token-standard";

const [treasury, alice, bob] = parties(3);
const empty = {
  holdings: new Map<string, HoldingView>(),
  instructions: new Map<string, TransferInstructionView>(),
};
const dec = (v: string): string => formatAmount(parseAmount(v));

describe("token-standard interfaces", () => {
  it("names the interfaces in the package-name form the JSON API's filters take, and matches package-id forms by module and entity", () => {
    expect(interfaceFilterId(HOLDING_INTERFACE)).toBe(
      "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
    );
    expect(interfaceFilterId(TRANSFER_INSTRUCTION_INTERFACE)).toBe(
      "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
    );
    expect(isInterface("abc123:Splice.Api.Token.HoldingV1:Holding", HOLDING_INTERFACE)).toBe(true);
    expect(
      isInterface("abc123:Splice.Api.Token.HoldingV1:Holding", TRANSFER_INSTRUCTION_INTERFACE),
    ).toBe(false);
    expect(isInterface(null, HOLDING_INTERFACE)).toBe(false);
  });
});

describe("views", () => {
  it("reads a Holding view (owner, instrument, amount, lock) and ignores a create without one", () => {
    const f = new LedgerFixture(treasury);
    const plain = holdingViewOf(f.holding(treasury, "12.5"));
    expect(plain).toEqual({
      contractId: expect.any(String) as string,
      owner: treasury,
      instrument: FIXTURE_TOKEN,
      amount: parseAmount("12.5"),
      locked: false,
      lockExpiresAt: null,
    });
    const expires = new Date(Date.UTC(2026, 5, 1));
    const locked = holdingViewOf(f.holding(treasury, "1", { lock: { expiresAt: expires } }));
    expect(locked).toMatchObject({ locked: true, lockExpiresAt: expires });
    const forever = holdingViewOf(f.holding(treasury, "1", { lock: {} }));
    expect(forever).toMatchObject({ locked: true, lockExpiresAt: null });
    const { market } = f.createMarket({ marketId: 1 });
    expect(holdingViewOf(f.created("PredictionMarket", market.cid, market.payload))).toBeNull();
    // Canton Coin: an Amulet carries the same view with the DSO as admin.
    expect(holdingViewOf(f.amulet(treasury, "3"))).toMatchObject({
      instrument: FIXTURE_COLLATERAL,
      amount: parseAmount("3"),
    });
  });

  it("reads a TransferInstruction view (the offer's transfer record)", () => {
    const f = new LedgerFixture(treasury);
    const executeBefore = new Date(Date.UTC(2026, 0, 2));
    const { tx, instructionCid } = f.tokenOfferIn(alice, "7", { executeBefore });
    const created = tx.events.find((e) => e.kind === "created" && e.contractId === instructionCid);
    if (!created || created.kind !== "created") throw new Error("instruction create missing");
    expect(transferInstructionViewOf(created)).toEqual({
      contractId: instructionCid,
      sender: alice,
      receiver: treasury,
      instrument: FIXTURE_TOKEN,
      amount: parseAmount("7"),
      requestedAt: expect.any(Date) as Date,
      executeBefore,
      originalInstructionCid: null,
    });
    // The locked holding of the same transaction is a holding of the SENDER, not an instruction.
    expect(tx.events.filter((e) => e.kind === "created" && holdingViewOf(e))).toHaveLength(1);
  });
  it("reads the instrument of a real DevNet Amulet holding from the ACS (the view carries `instrumentId`, not `instrument`)", () => {
    // Captured from POST /v2/state/active-contracts on the digik DevNet participant (Canton 3.6.1) on
    // 2026-10-15, createdEventBlob removed: the Holding view's wire shape is what the fixtures must mirror.
    const page = [
      {
        workflowId: "",
        contractEntry: {
          JsActiveContract: {
            createdEvent: {
              offset: 1888174,
              nodeId: 8,
              contractId:
                "003b46e0f13e86518eb6104c5ffe3ae7831ea313adfcb85f0006eaf3986de7208fca121220e5d019f29995babeeea176b7d20f947b5e36691ca4562549ac5c0507cb87558d",
              templateId:
                "a31be0483f3175647053f28965a4e6d97e3dbc433ea2338be303fae69bbcff6a:Splice.Amulet:Amulet",
              createArgument: {
                dso: "DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a",
                owner:
                  "20a2514bea1b4dd382f116c1e580197d::12205811d9301bcc2456567f882baceb8e083483c8be3f2631aedc2ce1806c424393",
                amount: {
                  initialAmount: "1.5000000000",
                  createdAt: {
                    number: "46087",
                  },
                  ratePerRound: {
                    rate: "0.0001208208",
                  },
                },
              },
              interfaceViews: [
                {
                  interfaceId:
                    "718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b:Splice.Api.Token.HoldingV1:Holding",
                  viewStatus: {
                    code: 0,
                    message: "",
                    details: [],
                  },
                  viewValue: {
                    owner:
                      "20a2514bea1b4dd382f116c1e580197d::12205811d9301bcc2456567f882baceb8e083483c8be3f2631aedc2ce1806c424393",
                    instrumentId: {
                      admin:
                        "DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a",
                      id: "Amulet",
                    },
                    amount: "1.5000000000",
                    lock: null,
                    meta: {
                      values: {
                        "amulet.splice.lfdecentralizedtrust.org/created-in-round": "46087",
                        "amulet.splice.lfdecentralizedtrust.org/rate-per-round": "0.0001208208",
                      },
                    },
                  },
                  implementationPackageId:
                    "8fe7573f5535dc5b910a1f24d7d980da0e10ab38f8d29cb397146119bbfb7b3a",
                },
              ],
              witnessParties: [
                "20a2514bea1b4dd382f116c1e580197d::12205811d9301bcc2456567f882baceb8e083483c8be3f2631aedc2ce1806c424393",
              ],
              signatories: [
                "20a2514bea1b4dd382f116c1e580197d::12205811d9301bcc2456567f882baceb8e083483c8be3f2631aedc2ce1806c424393",
                "DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a",
              ],
              observers: [],
              createdAt: "2026-05-28T07:36:36.647026Z",
              packageName: "splice-amulet",
              representativePackageId:
                "a31be0483f3175647053f28965a4e6d97e3dbc433ea2338be303fae69bbcff6a",
              acsDelta: true,
            },
            synchronizerId:
              "global-domain::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a",
            reassignmentCounter: 0,
          },
        },
      },
    ];
    const [entry] = parseActiveContractsPage(page);
    expect(entry.created.interfaceViews).toHaveLength(1);
    expect(holdingViewOf(entry.created)).toEqual({
      contractId:
        "003b46e0f13e86518eb6104c5ffe3ae7831ea313adfcb85f0006eaf3986de7208fca121220e5d019f29995babeeea176b7d20f947b5e36691ca4562549ac5c0507cb87558d",
      owner:
        "20a2514bea1b4dd382f116c1e580197d::12205811d9301bcc2456567f882baceb8e083483c8be3f2631aedc2ce1806c424393",
      instrument: {
        admin: "DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a",
        id: "Amulet",
      },
      amount: parseAmount("1.5"),
      locked: false,
      lockExpiresAt: null,
    });
  });
});

describe("extractTokenStandard", () => {
  it("a direct transfer to the treasury is an `in` row for the sender with the amount the treasury's holdings received", () => {
    const f = new LedgerFixture(treasury);
    const { tx, treasuryHoldingCid } = f.tokenTransferIn(alice, "25.5", { change: "4" });
    const out = extractTokenStandard(tx, treasury, empty);
    expect(out.transfers).toHaveLength(1);
    expect(out.transfers[0]).toMatchObject({
      direction: "in",
      counterparty: alice,
      instrument: FIXTURE_TOKEN,
      kind: "token_standard",
      choice: "TransferFactory_Transfer",
      updateId: tx.updateId,
      nodeId: 0,
    });
    expect(formatAmount(out.transfers[0].amount)).toBe(dec("25.5"));
    // Holdings of every owner are reported (the projection keeps the treasury's); the sender's
    // consumed input is unknown to the lookup, so it is not a consumption of ours.
    expect(out.holdingsCreated.map((h) => [h.owner, formatAmount(h.amount)])).toEqual([
      [treasury, dec("25.5")],
      [alice, dec("4")],
    ]);
    expect(out.holdingsCreated.find((h) => h.owner === treasury)?.contractId).toBe(
      treasuryHoldingCid,
    );
    expect(out.holdingsConsumed).toEqual([]);
    expect(out.instructionsCreated).toEqual([]);
    // The whole subtree is claimed.
    expect([...out.claimedNodeIds].sort()).toEqual([0, 1, 2, 3]);
  });

  it("a transfer from the treasury is an `out` row for the receiver with the transfer's amount; its consumed inputs are reported", () => {
    const f = new LedgerFixture(treasury);
    const first = f.tokenTransferIn(alice, "10");
    const second = f.tokenTransferIn(bob, "5");
    const known = new Map<string, HoldingView>();
    for (const tx of [first.tx, second.tx])
      for (const h of extractTokenStandard(tx, treasury, empty).holdingsCreated)
        if (h.owner === treasury) known.set(h.contractId, h);
    const { tx } = f.tokenTransferOut(
      bob,
      "12",
      [first.treasuryHoldingCid, second.treasuryHoldingCid],
      { change: "3" },
    );
    const out = extractTokenStandard(tx, treasury, { holdings: known, instructions: new Map() });
    expect(out.transfers).toHaveLength(1);
    expect(out.transfers[0]).toMatchObject({
      direction: "out",
      counterparty: bob,
      kind: "token_standard",
    });
    expect(formatAmount(out.transfers[0].amount)).toBe(dec("12"));
    expect(out.holdingsConsumed.map((c) => c.contractId).sort()).toEqual(
      [first.treasuryHoldingCid, second.treasuryHoldingCid].sort(),
    );
    // The change comes back as a new treasury holding.
    expect(
      out.holdingsCreated.filter((h) => h.owner === treasury).map((h) => formatAmount(h.amount)),
    ).toEqual([dec("3")]);
  });

  it("a two-step offer yields no transfer, the instruction instead; the accept yields the `in` row and completes it", () => {
    const f = new LedgerFixture(treasury);
    const offer = f.tokenOfferIn(alice, "7");
    const first = extractTokenStandard(offer.tx, treasury, empty);
    expect(first.transfers).toEqual([]);
    expect(first.instructionsCreated).toHaveLength(1);
    expect(first.instructionsCreated[0]).toMatchObject({
      contractId: offer.instructionCid,
      sender: alice,
      receiver: treasury,
      amount: parseAmount("7"),
    });
    const instructions = new Map(first.instructionsCreated.map((i) => [i.contractId, i]));

    const accept = f.acceptInstruction(offer.instructionCid, "7");
    const second = extractTokenStandard(accept.tx, treasury, { holdings: new Map(), instructions });
    expect(second.transfers).toHaveLength(1);
    expect(second.transfers[0]).toMatchObject({
      direction: "in",
      counterparty: alice,
      choice: "TransferInstruction_Accept",
      details: expect.objectContaining({ instructionCid: offer.instructionCid }) as unknown,
    });
    expect(formatAmount(second.transfers[0].amount)).toBe(dec("7"));
    expect(second.instructionOutcomes).toEqual([
      {
        contractId: offer.instructionCid,
        status: "completed",
        choice: "TransferInstruction_Accept",
        nodeId: 0,
      },
    ]);
    expect(second.unattributed).toEqual([]);
  });

  it("an accept of an offer the index never saw completes it without a row (reported as unattributed); reject / withdraw fail it", () => {
    const f = new LedgerFixture(treasury);
    const accept = f.acceptInstruction("00unknown", "7");
    const out = extractTokenStandard(accept.tx, treasury, empty);
    expect(out.transfers).toEqual([]);
    expect(out.instructionOutcomes).toEqual([
      expect.objectContaining({ contractId: "00unknown", status: "completed" }),
    ]);
    expect(out.unattributed).toEqual([
      { contractId: "00unknown", choice: "TransferInstruction_Accept", nodeId: 0 },
    ]);

    const offer = f.tokenOfferIn(alice, "1");
    const instructions = new Map(
      extractTokenStandard(offer.tx, treasury, empty).instructionsCreated.map((i) => [
        i.contractId,
        i,
      ]),
    );
    const rejected = extractTokenStandard(
      f.endInstruction(offer.instructionCid, "TransferInstruction_Reject", treasury),
      treasury,
      { holdings: new Map(), instructions },
    );
    expect(rejected.transfers).toEqual([]);
    expect(rejected.instructionOutcomes).toEqual([
      expect.objectContaining({
        contractId: offer.instructionCid,
        status: "failed",
        choice: "TransferInstruction_Reject",
      }),
    ]);
    const withdrawn = extractTokenStandard(
      f.endInstruction(offer.instructionCid, "TransferInstruction_Withdraw", alice),
      treasury,
      { holdings: new Map(), instructions },
    );
    expect(withdrawn.instructionOutcomes[0]).toMatchObject({ status: "failed" });
  });

  it("transfers between third parties, and a self-transfer of the treasury, are not rows", () => {
    const f = new LedgerFixture(treasury);
    const third = new LedgerFixture(alice).tokenTransferIn(bob, "3").tx; // alice is the receiver there
    expect(extractTokenStandard(third, treasury, empty).transfers).toEqual([]);
    const self = f.tokenTransferIn(treasury, "3").tx; // sender = receiver = treasury
    expect(extractTokenStandard(self, treasury, empty).transfers).toEqual([]);
    const { tx: marketTx } = f.createMarket({ marketId: 1 });
    const none = extractTokenStandard(marketTx, treasury, empty);
    expect(none.transfers).toEqual([]);
    expect(none.claimedNodeIds.size).toBe(0);
  });

  it("Canton Coin moved through the token standard is counted once: the claimed subtree is skipped by the Amulet reader", () => {
    const f = new LedgerFixture(treasury);
    const tx = f.amuletTokenStandardTransferIn(alice, "9");
    const standard = extractTokenStandard(tx, treasury, empty);
    expect(standard.transfers).toHaveLength(1);
    expect(standard.transfers[0]).toMatchObject({
      direction: "in",
      counterparty: alice,
      instrument: FIXTURE_COLLATERAL,
      kind: "token_standard",
    });
    expect(formatAmount(standard.transfers[0].amount)).toBe(dec("9"));
    // Without the claimed set the Amulet reader would count the inner AmuletRules_Transfer again.
    expect(extractTreasuryTransfers(tx, treasury, SPLICE_PACKAGE_NAME)).toHaveLength(1);
    expect(
      extractTreasuryTransfers(tx, treasury, SPLICE_PACKAGE_NAME, standard.claimedNodeIds),
    ).toEqual([]);
    // A plain Splice transfer (no TransferFactory_Transfer) is still the Amulet reader's.
    const plain = f.spliceTransferIn(bob, "2");
    expect(extractTokenStandard(plain, treasury, empty).transfers).toEqual([]);
    expect(extractTreasuryTransfers(plain, treasury, SPLICE_PACKAGE_NAME)).toHaveLength(1);
    // …while its Amulet still reaches the holdings table through the Holding view.
    expect(
      extractTokenStandard(plain, treasury, empty).holdingsCreated.map((h) => h.owner),
    ).toEqual([treasury, bob]);
  });
});
