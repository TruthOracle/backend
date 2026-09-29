/**
 * Canton Coin transfers as they appear in the treasury's ledger stream (docs/INDEXER.md §6).
 *
 * A Splice transfer exercises `TransferPreapproval_Send(V2)` / `AmuletRules_Transfer` (the
 * choice argument names the sender) and creates `Splice.Amulet:Amulet` contracts for the
 * receiver — the amount that actually arrived, fees having been taken on the sender's side.
 * This is the same reading `truthoracle-canton-prod/api/_lib/ledgerClient.mjs` relies on for
 * MainNet deposits, where the Enterprise Wallet's history endpoint returns nothing. Pure, so the
 * parsing is testable on fixtures.
 *
 * `in`: someone sent CC to the treasury (a deposit source). `out`: the treasury sent CC (a payout
 * / withdrawal). Amulets created for the treasury in its own outbound transfer are change, not
 * income, and are not counted. Minting, rewards and transfers between third parties are skipped:
 * there is no counterparty to attribute.
 */
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

export interface TreasuryTransfer {
  updateId: string;
  offset: number;
  direction: "in" | "out";
  /** The other party: the sender for `in`, the receiver for `out`. */
  counterparty: string;
  amountCC: bigint;
  choice: string;
  recordTime: Date | null;
  effectiveAt: Date;
  details: Record<string, unknown>;
}

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

/**
 * The transfers in one transaction that involve `treasury`. A transaction normally holds one
 * transfer; a batch could hold several, each attributed to its own exercise subtree.
 */
export function extractTreasuryTransfers(
  tx: LedgerTransaction,
  treasury: string,
  splicePackage: string,
): TreasuryTransfer[] {
  const out: TreasuryTransfer[] = [];
  const roots = buildEventTree(tx.events);
  const all = roots.flatMap((r) => [r, ...descendantsOf(r)]);
  for (const node of all) {
    const ev = node.event;
    if (
      ev.kind !== "exercised" ||
      !TRANSFER_CHOICES.has(ev.choice) ||
      ev.module !== TRANSFER_MODULE
    )
      continue;
    if (splicePackage && ev.packageName !== splicePackage) continue;
    const sender = senderOf(ev.choiceArgument);
    if (!sender) continue;
    const amulets = descendantsOf(node)
      .map((n) => n.event)
      .filter((e): e is CreatedLedgerEvent => isAmulet(e, splicePackage));

    if (sender === treasury) {
      // Outbound: every receiver other than the treasury gets its own row (change comes back to the treasury).
      const byReceiver = new Map<string, bigint>();
      for (const a of amulets) {
        const owner = asText(a.createArgument.owner);
        if (!owner || owner === treasury) continue;
        byReceiver.set(owner, (byReceiver.get(owner) ?? 0n) + amuletAmount(a));
      }
      for (const [receiver, amountCC] of byReceiver) {
        if (amountCC <= 0n) continue;
        out.push({
          updateId: tx.updateId,
          offset: tx.offset,
          direction: "out",
          counterparty: receiver,
          amountCC,
          choice: ev.choice,
          recordTime: tx.recordTime,
          effectiveAt: tx.effectiveAt,
          details: { nodeId: ev.nodeId, commandId: tx.commandId },
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
      offset: tx.offset,
      direction: "in",
      counterparty: sender,
      amountCC: received,
      choice: ev.choice,
      recordTime: tx.recordTime,
      effectiveAt: tx.effectiveAt,
      details: { nodeId: ev.nodeId, commandId: tx.commandId },
    });
  }
  return out;
}
