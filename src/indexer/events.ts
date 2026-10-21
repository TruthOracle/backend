/**
 * The indexer's view of a ledger transaction (docs/INDEXER.md §2): one normalised shape for what
 * the JSON Ledger API v2 serves as `POST /v2/updates` (`TRANSACTION_SHAPE_LEDGER_EFFECTS`,
 * `events[]`). The one-of members (`{ CreatedEvent }`, `{ ExercisedEvent }`, `{ Transaction }`)
 * are read with and without the `{ value }` wrapper some participant versions add. A created
 * event carries the interface views the request's `InterfaceFilter`s asked for (the token
 * standard's `Holding` / `TransferInstruction` views, docs/TOKENS.md §4.2), each with the
 * interface id it was computed for.
 *
 * Pure: no I/O, so the parsers and the tree builder are unit-tested on fixtures.
 */
import {
  asBool,
  asInt,
  asOptionalInt,
  asRecord,
  asText,
  asTextList,
  isoToDate,
} from "../util/ledger-values";

export interface TemplateRef {
  /** `pkgId:Module:Entity` as the participant reports it. */
  templateId: string;
  packageName: string;
  module: string;
  entity: string;
}

/**
 * One `JsInterfaceView` of a created event: the view the participant computed for an interface the
 * stream filter named. `view` is null when the participant reported a non-OK `viewStatus` (the
 * contract's view function failed) — the contract still implements the interface, but nothing
 * can be read from it.
 */
export interface InterfaceView extends TemplateRef {
  /** `pkgId:Module:Entity` of the interface as the participant reports it. */
  interfaceId: string;
  view: Record<string, unknown> | null;
}

export interface CreatedLedgerEvent extends TemplateRef {
  kind: "created";
  offset: number;
  nodeId: number;
  contractId: string;
  createArgument: Record<string, unknown>;
  createdEventBlob: string | null;
  /** Interface views requested through `InterfaceFilter { includeInterfaceView }`; empty without one. */
  interfaceViews: InterfaceView[];
  signatories: string[];
  observers: string[];
  witnessParties: string[];
  /** Ledger effective time of the creating transaction. */
  createdAt: Date | null;
  /** Would this event be part of an ACS_DELTA stream (i.e. does it change activeness for the requesting party)? */
  acsDelta: boolean;
}

export interface ExercisedLedgerEvent extends TemplateRef {
  kind: "exercised";
  offset: number;
  nodeId: number;
  contractId: string;
  choice: string;
  choiceArgument: Record<string, unknown>;
  exerciseResult: unknown;
  consuming: boolean;
  actingParties: string[];
  witnessParties: string[];
  lastDescendantNodeId: number;
  interfaceId: string | null;
}

export type LedgerEvent = CreatedLedgerEvent | ExercisedLedgerEvent;

export interface LedgerTransaction {
  updateId: string;
  offset: number;
  effectiveAt: Date;
  recordTime: Date | null;
  commandId: string | null;
  workflowId: string | null;
  synchronizerId: string | null;
  /** Sorted by nodeId (pre-order of the transaction tree). */
  events: LedgerEvent[];
}

/** An entry of an ACS snapshot (`POST /v2/state/active-contracts`). */
export interface ActiveContractEntry {
  created: CreatedLedgerEvent;
  synchronizerId: string | null;
}

// ---------------------------------------------------------------------------------------------
// Template ids
// ---------------------------------------------------------------------------------------------

/** `pkgId:Module:Entity` (or `#name:Module:Entity`) → its parts; module / entity empty when malformed. */
export function splitTemplateId(templateId: string): {
  packageRef: string;
  module: string;
  entity: string;
} {
  const parts = templateId.split(":");
  if (parts.length < 3) return { packageRef: templateId, module: "", entity: "" };
  const entity = parts[parts.length - 1];
  const module = parts[parts.length - 2];
  return { packageRef: parts.slice(0, -2).join(":"), module, entity };
}

export function qualifiedName(ref: Pick<TemplateRef, "module" | "entity">): string {
  return `${ref.module}:${ref.entity}`;
}

// ---------------------------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------------------------

/** One-of member with or without the `{ value }` wrapper the tree endpoints add. */
function unwrap(member: unknown): Record<string, unknown> | null {
  if (!member || typeof member !== "object") return null;
  const m = member as Record<string, unknown>;
  if (m.value && typeof m.value === "object" && !("contractId" in m))
    return m.value as Record<string, unknown>;
  return m;
}

function templateRefOf(raw: Record<string, unknown>): TemplateRef {
  const templateId = asText(raw.templateId);
  const { module, entity } = splitTemplateId(templateId);
  return { templateId, packageName: asText(raw.packageName), module, entity };
}

/** `interfaceViews[]` of a created event → the readable views (a non-OK `viewStatus` keeps the id and nulls the view). */
export function parseInterfaceViews(raw: unknown): InterfaceView[] {
  if (!Array.isArray(raw)) return [];
  const out: InterfaceView[] = [];
  for (const item of raw) {
    const v = asRecord(item);
    const interfaceId = asText(v.interfaceId);
    if (!interfaceId) continue;
    const status = asRecord(v.viewStatus);
    const ok = status.code === undefined || asInt(status.code) === 0;
    const { module, entity } = splitTemplateId(interfaceId);
    out.push({
      interfaceId,
      templateId: interfaceId,
      packageName: "",
      module,
      entity,
      view:
        ok && v.viewValue && typeof v.viewValue === "object" && !Array.isArray(v.viewValue)
          ? (v.viewValue as Record<string, unknown>)
          : null,
    });
  }
  return out;
}

export function parseCreatedEvent(raw: Record<string, unknown>): CreatedLedgerEvent | null {
  const contractId = asText(raw.contractId);
  if (!contractId) return null;
  return {
    kind: "created",
    ...templateRefOf(raw),
    offset: asInt(raw.offset),
    nodeId: asInt(raw.nodeId),
    contractId,
    createArgument: asRecord(raw.createArgument),
    createdEventBlob:
      typeof raw.createdEventBlob === "string" && raw.createdEventBlob
        ? raw.createdEventBlob
        : null,
    interfaceViews: parseInterfaceViews(raw.interfaceViews),
    signatories: asTextList(raw.signatories),
    observers: asTextList(raw.observers),
    witnessParties: asTextList(raw.witnessParties),
    createdAt: isoToDate(raw.createdAt),
    acsDelta: asBool(raw.acsDelta, true),
  };
}

export function parseExercisedEvent(raw: Record<string, unknown>): ExercisedLedgerEvent | null {
  const contractId = asText(raw.contractId);
  const choice = asText(raw.choice);
  if (!contractId || !choice) return null;
  const nodeId = asInt(raw.nodeId);
  return {
    kind: "exercised",
    ...templateRefOf(raw),
    offset: asInt(raw.offset),
    nodeId,
    contractId,
    choice,
    choiceArgument: asRecord(raw.choiceArgument),
    exerciseResult: raw.exerciseResult ?? null,
    consuming: asBool(raw.consuming, false),
    actingParties: asTextList(raw.actingParties),
    witnessParties: asTextList(raw.witnessParties),
    lastDescendantNodeId: asOptionalInt(raw.lastDescendantNodeId) ?? nodeId,
    interfaceId: typeof raw.interfaceId === "string" && raw.interfaceId ? raw.interfaceId : null,
  };
}

/** One `Event` one-of → a normalised event (ArchivedEvents are ignored: LEDGER_EFFECTS never carries them). */
export function parseEvent(raw: unknown): LedgerEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const created = unwrap(r.CreatedEvent);
  if (created) return parseCreatedEvent(created);
  const exercised = unwrap(r.ExercisedEvent);
  if (exercised) return parseExercisedEvent(exercised);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Transaction parsing
// ---------------------------------------------------------------------------------------------

function transactionFrom(
  tx: Record<string, unknown>,
  events: LedgerEvent[],
): LedgerTransaction | null {
  const updateId = asText(tx.updateId);
  const offset = asInt(tx.offset);
  if (!updateId || offset <= 0) return null;
  const effectiveAt = isoToDate(tx.effectiveAt) ?? isoToDate(tx.recordTime) ?? new Date(0);
  return {
    updateId,
    offset,
    effectiveAt,
    recordTime: isoToDate(tx.recordTime),
    commandId: typeof tx.commandId === "string" && tx.commandId ? tx.commandId : null,
    workflowId: typeof tx.workflowId === "string" && tx.workflowId ? tx.workflowId : null,
    synchronizerId:
      typeof tx.synchronizerId === "string" && tx.synchronizerId ? tx.synchronizerId : null,
    events: events.sort((a, b) => a.nodeId - b.nodeId),
  };
}

/**
 * One item of a `/v2/updates` response → a transaction, or null for the other update kinds
 * (OffsetCheckpoint, Reassignment, TopologyTransaction) and unreadable items.
 */
export function parseUpdateItem(item: unknown): LedgerTransaction | null {
  if (!item || typeof item !== "object") return null;
  const update = (item as { update?: unknown }).update;
  if (!update || typeof update !== "object") return null;
  const u = update as Record<string, unknown>;
  const tx = unwrap(u.Transaction);
  if (!tx || !Array.isArray(tx.events)) return null;
  const events = tx.events.map(parseEvent).filter((e): e is LedgerEvent => e !== null);
  return transactionFrom(tx, events);
}

/** A whole `/v2/updates` page → transactions in ledger order. */
export function parseUpdatesPage(page: unknown): LedgerTransaction[] {
  const items = Array.isArray(page) ? page : [];
  const out: LedgerTransaction[] = [];
  for (const item of items) {
    const tx = parseUpdateItem(item);
    if (tx) out.push(tx);
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** A `/v2/state/active-contracts` response → the active contracts it lists (JsEmpty / incomplete entries skipped). */
export function parseActiveContractsPage(page: unknown): ActiveContractEntry[] {
  const r = page as { activeContracts?: unknown; contracts?: unknown } | unknown[];
  const items: unknown[] = Array.isArray(r)
    ? r
    : Array.isArray((r as { activeContracts?: unknown })?.activeContracts)
      ? (r as { activeContracts: unknown[] }).activeContracts
      : Array.isArray((r as { contracts?: unknown })?.contracts)
        ? (r as { contracts: unknown[] }).contracts
        : [];
  const out: ActiveContractEntry[] = [];
  for (const item of items) {
    const entry = (
      item as {
        contractEntry?: { JsActiveContract?: { createdEvent?: unknown; synchronizerId?: unknown } };
      }
    )?.contractEntry?.JsActiveContract;
    if (!entry?.createdEvent || typeof entry.createdEvent !== "object") continue;
    const created = parseCreatedEvent(entry.createdEvent as Record<string, unknown>);
    if (!created) continue;
    out.push({
      created,
      synchronizerId: typeof entry.synchronizerId === "string" ? entry.synchronizerId : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tree structure
// ---------------------------------------------------------------------------------------------

export interface EventNode {
  event: LedgerEvent;
  parent: EventNode | null;
  /** The top-level exercise / create this event belongs to (itself for a root). */
  root: EventNode;
  children: EventNode[];
  depth: number;
}

/**
 * Rebuilds parent/child relations from `nodeId` order and `lastDescendantNodeId`: an exercised
 * event at node `n` with last descendant `m` is the parent of every later event whose node id is
 * ≤ `m` and not already claimed by a nearer ancestor. Created events have no children.
 */
export function buildEventTree(events: LedgerEvent[]): EventNode[] {
  const roots: EventNode[] = [];
  const stack: EventNode[] = [];
  for (const event of [...events].sort((a, b) => a.nodeId - b.nodeId)) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const last =
        top.event.kind === "exercised" ? top.event.lastDescendantNodeId : top.event.nodeId;
      if (event.nodeId > last) stack.pop();
      else break;
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    const node: EventNode = {
      event,
      parent,
      root: null as unknown as EventNode,
      children: [],
      depth: parent ? parent.depth + 1 : 0,
    };
    node.root = parent ? parent.root : node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (event.kind === "exercised") stack.push(node);
  }
  return roots;
}

/** Every node of the tree, pre-order (= nodeId order). */
export function flattenTree(roots: EventNode[]): EventNode[] {
  const out: EventNode[] = [];
  const visit = (n: EventNode): void => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}

/** All descendants of a node, pre-order. */
export function descendantsOf(node: EventNode): EventNode[] {
  const out: EventNode[] = [];
  const visit = (n: EventNode): void => {
    for (const c of n.children) {
      out.push(c);
      visit(c);
    }
  };
  visit(node);
  return out;
}

/** Canton's error code for "this range was pruned" — the indexer must resync from an ACS snapshot (docs/INDEXER.md §4). */
export const PRUNED_ERROR_CODE = "PARTICIPANT_PRUNED_DATA_ACCESSED";

export function isPrunedDataError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.includes(PRUNED_ERROR_CODE);
}

/** The unique key of an event across the whole index: `<updateId>:<nodeId>` (ACS rows use `acs:<contractId>`). */
export function eventIdOf(updateId: string, nodeId: number): string {
  return `${updateId}:${nodeId}`;
}

export function acsEventIdOf(contractId: string): string {
  return `acs:${contractId}`;
}
