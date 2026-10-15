import { LedgerFixture, parties, SPLICE_PACKAGE_NAME } from "../../test/helpers/ledger-fixtures";
import { formatAmount, parseAmount } from "../util/money";
import { extractTreasuryTransfers } from "./splice";

const [treasury, alice, bob] = parties(3);

describe("extractTreasuryTransfers", () => {
  it("attributes an inbound transfer to the sender with the amount the treasury's Amulets hold", () => {
    const f = new LedgerFixture(treasury);
    const tx = f.spliceTransferIn(alice, "25.5");
    const out = extractTreasuryTransfers(tx, treasury, SPLICE_PACKAGE_NAME);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      direction: "in",
      counterparty: alice,
      choice: "TransferPreapproval_SendV2",
      updateId: tx.updateId,
      offset: tx.offset,
    });
    expect(formatAmount(out[0].amount)).toBe(formatAmount(parseAmount("25.5")));
  });

  it("attributes an outbound transfer to the receiver and ignores the treasury's change", () => {
    const f = new LedgerFixture(treasury);
    const tx = f.spliceTransferOut(bob, "7");
    const out = extractTreasuryTransfers(tx, treasury, SPLICE_PACKAGE_NAME);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      direction: "out",
      counterparty: bob,
      choice: "AmuletRules_Transfer",
    });
    expect(formatAmount(out[0].amount)).toBe(formatAmount(parseAmount("7")));
  });

  it("skips transfers of another package and transactions without a transfer exercise", () => {
    const f = new LedgerFixture(treasury);
    const tx = f.spliceTransferIn(alice, "1");
    expect(extractTreasuryTransfers(tx, treasury, "some-other-package")).toEqual([]);
    const { tx: marketTx } = f.createMarket({ marketId: 1 });
    expect(extractTreasuryTransfers(marketTx, treasury, SPLICE_PACKAGE_NAME)).toEqual([]);
  });

  it("skips an inbound transfer that created nothing for the treasury", () => {
    const f = new LedgerFixture(treasury);
    const tx = f.spliceTransferIn(alice, "1");
    // rewrite the Amulet owner: the transfer went somewhere else
    for (const e of tx.events) if (e.kind === "created") e.createArgument.owner = bob;
    expect(extractTreasuryTransfers(tx, treasury, SPLICE_PACKAGE_NAME)).toEqual([]);
  });
});
