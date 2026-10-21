/**
 * Canton Coin transfers as they appear in the treasury's ledger stream (docs/INDEXER.md §6).
 *
 * A Splice transfer exercises `TransferPreapproval_Send(V2)` / `AmuletRules_Transfer` (the
 * choice argument names the sender) and creates `Splice.Amulet:Amulet` contracts for the
 * receiver — the amount that actually arrived, fees having been taken on the sender's side.
 * This is the same reading `truthoracle-canton-prod/api/_lib/ledgerClient.mjs` relies on for
 * MainNet deposits; here it feeds the ledger index the deposit reconcile reads (docs/TOKENS.md §2
 * decision 5). Pure, so the parsing is testable on fixtures.
 *
 * `in`: someone sent Canton Coin to the treasury (a deposit source). `out`: the treasury sent it
 * (a payout / withdrawal). Amulets created for the treasury in its own outbound transfer are
 * change, not income, and are not counted. Minting, rewards and transfers between third parties
 * are skipped: there is no counterparty to attribute. Canton Coin is a token-standard instrument
 * (docs/TOKENS.md §1): the rows carry `instrument = { admin: the Amulet's DSO party, id: "Amulet" }`
 * and `kind = amulet`, so the deposit reconcile reads them like any other token's transfers.
 *
 * Because it implements the standard, a Canton Coin transfer made through
 * `TransferFactory_Transfer` reaches this reader as a child `AmuletRules_Transfer` of a subtree
 * the token-standard derivation already accounted for (`src/indexer/token-standard.ts`). The
 * caller passes those node ids as `claimed` and this reader skips them, so a transfer is never
 * counted twice.
 */
import type { InstrumentId, LedgerTransferRecord } from "../types";
import { asDecimal, asRecord, asText } from "../util/ledger-values";
import {
  buildEventTree,
  descendantsOf,
  type CreatedLedgerEvent,
  type LedgerEvent,
  type LedgerTransaction,
} from "./events";

export const TRANSFER_CHOICES: ReadonlySet<string> = new Set([
  "TransferPreapproval_Send",
  "TransferPreapproval_SendV2",
  "AmuletRules_Transfer",
]);
const TRANSFER_MODULE = "Splice.AmuletRules";
const AMULET_MODULE = "Splice.Amulet";
const AMULET_ENTITY = "Amulet";

export const AMULET_INSTRUMENT_ID = "Amulet";

/** One Canton Coin transfer involving the treasury — the same row shape the token-standard reader yields. */
export type TreasuryTransfer = LedgerTransferRecord;

function senderOf(choiceArgument: Record<string, unknown>): string {
  const direct = asText(choiceArgument.sender);
  if (direct) return direct;
  return asText(asRecord(choiceArgument.transfer).sender);
}

function isAmulet(event: LedgerEvent, splicePackage: string): event is CreatedLedgerEvent {
  return (
    event.kind === "created" &&
    event.module === AMULET_MODULE &&
    event.entity === AMULET_ENTITY &&
    (!splicePackage || event.packageName === splicePackage)
  );
}

function amuletAmount(created: CreatedLedgerEvent): bigint {
  return asDecimal(asRecord(created.createArgument.amount).initialAmount);
}

/** The Amulet's `dso` party IS the instrument admin of Canton Coin (every Amulet of a network names the same DSO). */
function amuletInstrument(amulets: CreatedLedgerEvent[]): InstrumentId {
  const dso = amulets.map((a) => asText(a.createArgument.dso)).find((d) => d !== "") ?? "";
  return { admin: dso, id: AMULET_INSTRUMENT_ID };
}

/**
 * The transfers in one transaction that involve `treasury`. A transaction normally holds one
 * transfer; a batch could hold several, each attributed to its own exercise subtree.
 */
export function extractTreasuryTransfers(
  tx: LedgerTransaction,
  treasury: string,
  splicePackage: string,
  claimed: ReadonlySet<number> = new Set(),
): TreasuryTransfer[] {
  const out: TreasuryTransfer[] = [];
  const roots = buildEventTree(tx.events);
  const all = roots.flatMap((r) => [r, ...descendantsOf(r)]);
  for (const node of all) {
    const ev = node.event;
    if (
      ev.kind !== "exercised" ||
      !TRANSFER_CHOICES.has(ev.choice) ||
      ev.module !== TRANSFER_MODULE ||
      claimed.has(ev.nodeId)
    )
      continue;
    if (splicePackage && ev.packageName !== splicePackage) continue;
    const sender = senderOf(ev.choiceArgument);
    if (!sender) continue;
    const amulets = descendantsOf(node)
      .map((n) => n.event)
      .filter((e): e is CreatedLedgerEvent => isAmulet(e, splicePackage));
    const instrument = amuletInstrument(amulets);

    if (sender === treasury) {
      // Outbound: every receiver other than the treasury gets its own row (change comes back to the treasury).
      const byReceiver = new Map<string, bigint>();
      for (const a of amulets) {
        const owner = asText(a.createArgument.owner);
        if (!owner || owner === treasury) continue;
        byReceiver.set(owner, (byReceiver.get(owner) ?? 0n) + amuletAmount(a));
      }
      for (const [receiver, amount] of byReceiver) {
        if (amount <= 0n) continue;
        out.push({
          updateId: tx.updateId,
          nodeId: ev.nodeId,
          offset: tx.offset,
          direction: "out",
          counterparty: receiver,
          instrument,
          amount,
          kind: "amulet",
          choice: ev.choice,
          recordTime: tx.recordTime,
          effectiveAt: tx.effectiveAt,
          details: { commandId: tx.commandId },
        });
      }
      continue;
    }

    let received = 0n;
    for (const a of amulets) {
      if (asText(a.createArgument.owner) !== treasury) continue;
      received += amuletAmount(a);
    }
    if (received <= 0n) continue;
    out.push({
      updateId: tx.updateId,
      nodeId: ev.nodeId,
      offset: tx.offset,
      direction: "in",
      counterparty: sender,
      instrument,
      amount: received,
      kind: "amulet",
      choice: ev.choice,
      recordTime: tx.recordTime,
      effectiveAt: tx.effectiveAt,
      details: { commandId: tx.commandId },
    });
  }
  return out;
}
