/**
 * The Canton token standard (CIP-56) as it appears in the treasury's ledger stream
 * (docs/INDEXER.md §6, docs/TOKENS.md §4.2). The stream and ACS requests ask for the
 * `HoldingV1.Holding` and `TransferInstructionV1.TransferInstruction` interface views next to
 * the wildcard filter, so every token that implements the standard — cBYN, TRO, Canton Coin —
 * is read the same way, without knowing its templates:
 *
 * - a created event with a `Holding` view is a holding (owner, instrument, amount, lock);
 * - a created event with a `TransferInstruction` view is a pending two-step offer;
 * - an exercised `TransferFactory_Transfer` (the choice argument names sender, receiver, amount
 *   and instrument) or `TransferInstruction_Accept` that involves the treasury is a transfer:
 *   receiver = treasury → `in`, amount = Σ holdings created for the treasury in that subtree minus
 *   the treasury's own holdings consumed in it (change); sender = treasury → `out`, amount = the
 *   transfer's amount. A `TransferFactory_Transfer` that only created an instruction (two-step)
 *   yields no transfer yet — the accept does.
 *
 * Pure: the caller supplies what the index already knows about the contracts a transaction
 * consumes (holdings and instructions by contract id), and gets rows, outcomes and the node ids
 * it claimed, so the Splice Amulet reader (`splice.ts`) leaves those subtrees alone.
 */
import type { InstrumentId, LedgerTransferRecord, TransferInstructionStatus } from "../types";
import { asDecimal, asOptional, asRecord, asText, isoToDate } from "../util/ledger-values";
import {
  buildEventTree,
  descendantsOf,
  splitTemplateId,
  type CreatedLedgerEvent,
  type EventNode,
  type ExercisedLedgerEvent,
  type LedgerTransaction,
} from "./events";

export interface TokenStandardInterface {
  packageName: string;
  module: string;
  entity: string;
}

export const HOLDING_INTERFACE: TokenStandardInterface = {
  packageName: "splice-api-token-holding-v1",
  module: "Splice.Api.Token.HoldingV1",
  entity: "Holding",
};
export const TRANSFER_INSTRUCTION_INTERFACE: TokenStandardInterface = {
  packageName: "splice-api-token-transfer-instruction-v1",
  module: "Splice.Api.Token.TransferInstructionV1",
  entity: "TransferInstruction",
};
export const TRANSFER_FACTORY_INTERFACE: TokenStandardInterface = {
  packageName: "splice-api-token-transfer-instruction-v1",
  module: "Splice.Api.Token.TransferInstructionV1",
  entity: "TransferFactory",
};

/** `#package-name:Module:Entity` — the form the JSON Ledger API's filters and interface ExerciseCommands take. */
export function interfaceFilterId(i: TokenStandardInterface): string {
  return `#${i.packageName}:${i.module}:${i.entity}`;
}

export const TRANSFER_FACTORY_CHOICE = "TransferFactory_Transfer";
export const TRANSFER_INSTRUCTION_ACCEPT = "TransferInstruction_Accept";
export const TRANSFER_INSTRUCTION_REJECT = "TransferInstruction_Reject";
export const TRANSFER_INSTRUCTION_WITHDRAW = "TransferInstruction_Withdraw";

/** Does a `pkgId:Module:Entity` (or `#name:Module:Entity`) id name this interface? Package ids are not pinned: every vetted version of the API package qualifies. */
export function isInterface(id: string | null | undefined, i: TokenStandardInterface): boolean {
  if (!id) return false;
  const { module, entity } = splitTemplateId(id);
  return module === i.module && entity === i.entity;
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/** `Splice.Api.Token.HoldingV1.HoldingView` as read from a created event. */
export interface HoldingView {
  contractId: string;
  owner: string;
  instrument: InstrumentId;
  amount: bigint;
  /** A lock (`lock : Optional Lock`) makes the holding unspendable as a transfer input until it expires. */
  locked: boolean;
  lockExpiresAt: Date | null;
}

/** `Splice.Api.Token.TransferInstructionV1.TransferInstructionView` as read from a created event. */
export interface TransferInstructionView {
  contractId: string;
  sender: string;
  receiver: string;
  instrument: InstrumentId;
  amount: bigint;
  requestedAt: Date | null;
  executeBefore: Date | null;
  /** The first version of a multi-step instruction (`TransferInstruction_Update` chains); null for the first. */
  originalInstructionCid: string | null;
}

function instrumentOf(value: unknown): InstrumentId | null {
  const r = asRecord(value);
  const admin = asText(r.admin).trim();
  const id = asText(r.id).trim();
  return admin && id ? { admin, id } : null;
}

/** The readable view of `iface` on a created event, or null when the contract does not implement it (or its view failed). */
export function viewOf(
  e: CreatedLedgerEvent,
  iface: TokenStandardInterface,
): Record<string, unknown> | null {
  for (const v of e.interfaceViews) {
    if (v.module === iface.module && v.entity === iface.entity) return v.view;
  }
  return null;
}

/**
 * `Splice.Api.Token.HoldingV1.HoldingView` = `{ owner, instrumentId, amount, lock, meta }` — the
 * instrument travels as `instrumentId` (verified against a DevNet Amulet holding, token-standard.spec.ts).
 */
export function holdingViewOf(e: CreatedLedgerEvent): HoldingView | null {
  const view = viewOf(e, HOLDING_INTERFACE);
  if (!view) return null;
  const owner = asText(view.owner).trim();
  const instrument = instrumentOf(view.instrumentId);
  if (!owner || !instrument) return null;
  const lock = asOptional(view.lock);
  const lockRecord = lock && typeof lock === "object" ? asRecord(lock) : null;
  return {
    contractId: e.contractId,
    owner,
    instrument,
    amount: asDecimal(view.amount),
    locked: lockRecord !== null,
    lockExpiresAt: lockRecord ? isoToDate(asOptional(lockRecord.expiresAt)) : null,
  };
}

/** The `Transfer` record (sender, receiver, amount, instrumentId, requestedAt, executeBefore) of a view or a choice argument. */
export interface TransferRecord {
  sender: string;
  receiver: string;
  instrument: InstrumentId;
  amount: bigint;
  requestedAt: Date | null;
  executeBefore: Date | null;
}

export function transferRecordOf(value: unknown): TransferRecord | null {
  const t = asRecord(value);
  const sender = asText(t.sender).trim();
  const receiver = asText(t.receiver).trim();
  const instrument = instrumentOf(t.instrumentId);
  if (!sender || !receiver || !instrument) return null;
  return {
    sender,
    receiver,
    instrument,
    amount: asDecimal(t.amount),
    requestedAt: isoToDate(t.requestedAt),
    executeBefore: isoToDate(t.executeBefore),
  };
}

export function transferInstructionViewOf(e: CreatedLedgerEvent): TransferInstructionView | null {
  const view = viewOf(e, TRANSFER_INSTRUCTION_INTERFACE);
  if (!view) return null;
  const transfer = transferRecordOf(view.transfer);
  if (!transfer) return null;
  const original = asOptional(view.originalInstructionCid);
  return {
    contractId: e.contractId,
    sender: transfer.sender,
    receiver: transfer.receiver,
    instrument: transfer.instrument,
    amount: transfer.amount,
    requestedAt: transfer.requestedAt,
    executeBefore: transfer.executeBefore,
    originalInstructionCid: typeof original === "string" && original ? original : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------

/** What the index already knows about contracts this transaction may consume (plus the ones it creates itself). */
export interface TokenStandardLookup {
  holdings: ReadonlyMap<string, HoldingView>;
  instructions: ReadonlyMap<string, TransferInstructionView>;
}

export interface InstructionOutcome {
  contractId: string;
  status: Exclude<TransferInstructionStatus, "pending">;
  choice: string;
  nodeId: number;
}

export interface TokenStandardDerivation {
  transfers: LedgerTransferRecord[];
  /** Holdings created in this transaction, any owner (the caller keeps the treasury's). */
  holdingsCreated: HoldingView[];
  /** Holding contracts (known to the lookup) consumed in this transaction. */
  holdingsConsumed: { contractId: string; nodeId: number }[];
  instructionsCreated: TransferInstructionView[];
  /** TransferInstruction contracts consumed in this transaction and how they ended. */
  instructionOutcomes: InstructionOutcome[];
  /** Node ids (the transfer exercise and its whole subtree) this derivation accounted for. */
  claimedNodeIds: Set<number>;
  /** Accepted instructions the index never saw the create of: nothing can be attributed, an operator should look. */
  unattributed: { contractId: string; choice: string; nodeId: number }[];
}

function isPendingResult(result: unknown): boolean {
  // TransferInstructionResult { output: TransferInstructionResult_Pending { transferInstructionCid } | _Completed | _Failed, ... }
  const output = asRecord(result).output;
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  if (typeof o.tag === "string") return o.tag === "TransferInstructionResult_Pending";
  return "TransferInstructionResult_Pending" in o;
}

/**
 * Derive the token-standard activity of one transaction for `treasury`. The holdings map must hold
 * every holding the transaction may consume (from the index) — the function adds the ones the
 * transaction creates itself, so a holding spent in the transaction that created it is seen too.
 */
export function extractTokenStandard(
  tx: LedgerTransaction,
  treasury: string,
  lookup: TokenStandardLookup,
): TokenStandardDerivation {
  const holdingsCreated: HoldingView[] = [];
  const instructionsCreated: TransferInstructionView[] = [];
  for (const e of tx.events) {
    if (e.kind !== "created") continue;
    const h = holdingViewOf(e);
    if (h) holdingsCreated.push(h);
    const i = transferInstructionViewOf(e);
    if (i) instructionsCreated.push(i);
  }
  const holdings = new Map(lookup.holdings);
  for (const h of holdingsCreated) holdings.set(h.contractId, h);
  const instructions = new Map(lookup.instructions);
  for (const i of instructionsCreated) instructions.set(i.contractId, i);

  const roots = buildEventTree(tx.events);
  const all = roots.flatMap((r) => [r, ...descendantsOf(r)]);
  const out: TokenStandardDerivation = {
    transfers: [],
    holdingsCreated,
    holdingsConsumed: [],
    instructionsCreated,
    instructionOutcomes: [],
    claimedNodeIds: new Set<number>(),
    unattributed: [],
  };

  for (const node of all) {
    const ev = node.event;
    if (ev.kind !== "exercised") continue;
    // Consumption is state, not activity: recorded whether or not the exercise sits inside a
    // subtree a transfer already claimed.
    if (ev.consuming && holdings.has(ev.contractId))
      out.holdingsConsumed.push({ contractId: ev.contractId, nodeId: ev.nodeId });
    const knownInstruction = instructions.has(ev.contractId);
    if (ev.consuming && (knownInstruction || ev.choice === TRANSFER_INSTRUCTION_ACCEPT))
      out.instructionOutcomes.push({
        contractId: ev.contractId,
        // Accept completes the offer; a reject, a withdraw, an update (superseded by a new
        // version) or any other archive ends this contract without delivering.
        status: ev.choice === TRANSFER_INSTRUCTION_ACCEPT ? "completed" : "failed",
        choice: ev.choice,
        nodeId: ev.nodeId,
      });
    if (out.claimedNodeIds.has(ev.nodeId)) continue;

    if (ev.choice === TRANSFER_FACTORY_CHOICE) {
      if (ev.interfaceId && !isInterface(ev.interfaceId, TRANSFER_FACTORY_INTERFACE)) continue;
      const transfer = transferRecordOf(ev.choiceArgument.transfer);
      if (!transfer) continue;
      const subtree = claim(out.claimedNodeIds, node);
      const pending =
        isPendingResult(ev.exerciseResult) ||
        subtree.some((n) => n.event.kind === "created" && transferInstructionViewOf(n.event));
      const row = transferRow(tx, ev, treasury, transfer, subtree, holdings, pending, {
        factoryCid: ev.contractId,
      });
      if (row) out.transfers.push(row);
      continue;
    }

    if (ev.choice === TRANSFER_INSTRUCTION_ACCEPT) {
      if (ev.interfaceId && !isInterface(ev.interfaceId, TRANSFER_INSTRUCTION_INTERFACE)) continue;
      const subtree = claim(out.claimedNodeIds, node);
      const instruction = instructions.get(ev.contractId);
      if (!instruction) {
        out.unattributed.push({ contractId: ev.contractId, choice: ev.choice, nodeId: ev.nodeId });
        continue;
      }
      const row = transferRow(tx, ev, treasury, instruction, subtree, holdings, false, {
        instructionCid: ev.contractId,
      });
      if (row) out.transfers.push(row);
    }
  }
  return out;
}

/** Marks the exercise and its whole subtree as accounted for; returns the subtree. */
function claim(claimed: Set<number>, node: EventNode): EventNode[] {
  claimed.add(node.event.nodeId);
  const subtree = descendantsOf(node);
  for (const n of subtree) claimed.add(n.event.nodeId);
  return subtree;
}

function transferRow(
  tx: LedgerTransaction,
  ev: ExercisedLedgerEvent,
  treasury: string,
  transfer: Pick<TransferRecord, "sender" | "receiver" | "amount" | "instrument">,
  subtree: EventNode[],
  holdings: ReadonlyMap<string, HoldingView>,
  pending: boolean,
  details: Record<string, unknown>,
): LedgerTransferRecord | null {
  const base = {
    updateId: tx.updateId,
    nodeId: ev.nodeId,
    offset: tx.offset,
    instrument: transfer.instrument,
    kind: "token_standard" as const,
    choice: ev.choice,
    recordTime: tx.recordTime,
    effectiveAt: tx.effectiveAt,
    details: { commandId: tx.commandId, interfaceId: ev.interfaceId, ...details },
  };
  if (transfer.receiver === treasury && transfer.sender !== treasury) {
    let received = 0n;
    for (const n of subtree) {
      const e = n.event;
      if (e.kind === "created") {
        const h = holdingViewOf(e);
        if (h && h.owner === treasury) received += h.amount;
      } else if (e.consuming) {
        const h = holdings.get(e.contractId);
        if (h && h.owner === treasury) received -= h.amount;
      }
    }
    if (received <= 0n) return null;
    return { ...base, direction: "in", counterparty: transfer.sender, amount: received };
  }
  if (transfer.sender === treasury && transfer.receiver !== treasury) {
    if (pending || transfer.amount <= 0n) return null;
    return { ...base, direction: "out", counterparty: transfer.receiver, amount: transfer.amount };
  }
  return null;
}
