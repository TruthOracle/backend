import {
  acsEventIdOf,
  buildEventTree,
  descendantsOf,
  eventIdOf,
  flattenTree,
  isPrunedDataError,
  parseActiveContractsPage,
  parseUpdateItem,
  parseUpdatesPage,
  splitTemplateId,
  type LedgerEvent,
} from "./events";

const created = (nodeId: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  offset: 42,
  nodeId,
  contractId: `cid-${nodeId}`,
  templateId: "pkg:Truthoracle:Position",
  packageName: "truthoracle-v16",
  createArgument: { holder: "alice::1220aa", marketId: "1" },
  witnessParties: ["treasury::1220ff"],
  signatories: ["alice::1220aa"],
  observers: ["treasury::1220ff"],
  createdAt: "2026-01-01T00:00:00Z",
  acsDelta: true,
  ...extra,
});

const exercised = (
  nodeId: number,
  last: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  offset: 42,
  nodeId,
  contractId: `cid-m`,
  templateId: "pkg:Truthoracle:PredictionMarket",
  packageName: "truthoracle-v16",
  choice: "Buy",
  choiceArgument: { buyer: "alice::1220aa", side: "Yes", amount: "10.0000000000" },
  actingParties: ["alice::1220aa"],
  consuming: true,
  witnessParties: ["treasury::1220ff"],
  lastDescendantNodeId: last,
  exerciseResult: { _1: "a", _2: "b" },
  acsDelta: true,
  ...extra,
});

describe("splitTemplateId", () => {
  it("splits package-id and package-name forms", () => {
    expect(splitTemplateId("abc123:Truthoracle:PredictionMarket")).toEqual({
      packageRef: "abc123",
      module: "Truthoracle",
      entity: "PredictionMarket",
    });
    expect(splitTemplateId("#truthoracle-v16:Splice.Amulet:Amulet")).toEqual({
      packageRef: "#truthoracle-v16",
      module: "Splice.Amulet",
      entity: "Amulet",
    });
    expect(splitTemplateId("garbage")).toEqual({ packageRef: "garbage", module: "", entity: "" });
  });
});

describe("parseUpdateItem", () => {
  const flatItem = {
    update: {
      Transaction: {
        value: {
          updateId: "u1",
          offset: 42,
          effectiveAt: "2026-01-01T00:00:00Z",
          recordTime: "2026-01-01T00:00:01Z",
          commandId: "cmd-1",
          synchronizerId: "sync::1",
          events: [
            { ExercisedEvent: exercised(0, 2) },
            { CreatedEvent: created(2) },
            { CreatedEvent: created(1, { templateId: "pkg:Truthoracle:UserWallet" }) },
          ],
        },
      },
    },
  };

  it("reads the /v2/updates (LEDGER_EFFECTS) shape, sorted by nodeId", () => {
    const tx = parseUpdateItem(flatItem);
    expect(tx).not.toBeNull();
    expect(tx!.updateId).toBe("u1");
    expect(tx!.offset).toBe(42);
    expect(tx!.commandId).toBe("cmd-1");
    expect(tx!.synchronizerId).toBe("sync::1");
    expect(tx!.recordTime?.toISOString()).toBe("2026-01-01T00:00:01.000Z");
    expect(tx!.events.map((e) => e.nodeId)).toEqual([0, 1, 2]);
    const root = tx!.events[0];
    expect(root.kind).toBe("exercised");
    if (root.kind === "exercised") {
      expect(root.choice).toBe("Buy");
      expect(root.lastDescendantNodeId).toBe(2);
      expect(root.consuming).toBe(true);
      expect(root.module).toBe("Truthoracle");
      expect(root.entity).toBe("PredictionMarket");
      expect(root.exerciseResult).toEqual({ _1: "a", _2: "b" });
    }
  });

  it("reads the flat shape without the `.value` wrapper too", () => {
    const item = {
      update: { Transaction: (flatItem.update.Transaction as { value: unknown }).value },
    };
    expect(parseUpdateItem(item)?.events).toHaveLength(3);
  });

  it("reads the interface views a created event carries (token standard), keeping a failed view's id with a null view", () => {
    const item = {
      update: {
        Transaction: {
          updateId: "u2",
          offset: 43,
          effectiveAt: "2026-01-01T00:00:00Z",
          events: [
            {
              CreatedEvent: created(0, {
                templateId: "cbynpkg:TruthOracle.CBYN.Holding:Holding",
                packageName: "cbyn-holding-stable",
                interfaceViews: [
                  {
                    interfaceId: "holdingpkg:Splice.Api.Token.HoldingV1:Holding",
                    viewStatus: { code: 0, message: "", details: [] },
                    viewValue: {
                      owner: "treasury::1220ff",
                      instrument: { admin: "agent::1220aa", id: "cBYN" },
                      amount: "12.5000000000",
                      lock: null,
                      meta: { values: {} },
                    },
                  },
                  {
                    interfaceId: "otherpkg:Some.Other.Interface:Thing",
                    viewStatus: { code: 13, message: "view failed", details: [] },
                  },
                ],
              }),
            },
            { CreatedEvent: created(1) },
          ],
        },
      },
    };
    const tx = parseUpdateItem(item);
    const [holding, plain] = tx!.events;
    expect(holding.kind).toBe("created");
    if (holding.kind === "created") {
      expect(holding.interfaceViews).toHaveLength(2);
      expect(holding.interfaceViews[0]).toMatchObject({
        interfaceId: "holdingpkg:Splice.Api.Token.HoldingV1:Holding",
        module: "Splice.Api.Token.HoldingV1",
        entity: "Holding",
      });
      expect(holding.interfaceViews[0].view).toMatchObject({ amount: "12.5000000000" });
      expect(holding.interfaceViews[1].view).toBeNull();
    }
    if (plain.kind === "created") expect(plain.interfaceViews).toEqual([]);
  });

  it("the TransactionTree shape of the removed /v2/updates/trees endpoint is not read", () => {
    expect(
      parseUpdateItem({
        update: {
          TransactionTree: {
            value: { updateId: "u2", offset: 43, eventsById: { "0": { CreatedTreeEvent: {} } } },
          },
        },
      }),
    ).toBeNull();
  });

  it("ignores checkpoints, reassignments and unreadable items", () => {
    expect(parseUpdateItem({ update: { OffsetCheckpoint: { value: { offset: 5 } } } })).toBeNull();
    expect(
      parseUpdateItem({
        update: { Reassignment: { value: { updateId: "r", offset: 9, events: [] } } },
      }),
    ).toBeNull();
    expect(parseUpdateItem(null)).toBeNull();
    expect(parseUpdateItem({})).toBeNull();
  });

  it("parseUpdatesPage keeps ledger order", () => {
    const later = {
      update: {
        Transaction: {
          value: {
            ...(flatItem.update.Transaction as { value: Record<string, unknown> }).value,
            updateId: "u9",
            offset: 99,
          },
        },
      },
    };
    const page = parseUpdatesPage([
      later,
      flatItem,
      { update: { OffsetCheckpoint: { value: { offset: 100 } } } },
    ]);
    expect(page.map((t) => t.offset)).toEqual([42, 99]);
  });
});

describe("parseActiveContractsPage", () => {
  it("reads JsActiveContract entries and skips the rest", () => {
    const page = [
      {
        contractEntry: {
          JsActiveContract: {
            createdEvent: created(0, { createdEventBlob: "blob" }),
            synchronizerId: "sync::1",
            reassignmentCounter: 0,
          },
        },
      },
      { contractEntry: { JsEmpty: {} } },
      { contractEntry: { JsIncompleteUnassigned: {} } },
    ];
    const entries = parseActiveContractsPage(page);
    expect(entries).toHaveLength(1);
    expect(entries[0].created.contractId).toBe("cid-0");
    expect(entries[0].created.createdEventBlob).toBe("blob");
    expect(entries[0].synchronizerId).toBe("sync::1");
  });
});

describe("buildEventTree", () => {
  const ev = (kind: "created" | "exercised", nodeId: number, last = nodeId): LedgerEvent =>
    kind === "created"
      ? {
          kind,
          nodeId,
          offset: 1,
          contractId: `c${nodeId}`,
          templateId: "p:M:E",
          packageName: "p",
          module: "M",
          entity: "E",
          createArgument: {},
          createdEventBlob: null,
          interfaceViews: [],
          signatories: [],
          observers: [],
          witnessParties: [],
          createdAt: null,
          acsDelta: true,
        }
      : {
          kind,
          nodeId,
          offset: 1,
          contractId: `c${nodeId}`,
          templateId: "p:M:E",
          packageName: "p",
          module: "M",
          entity: "E",
          choice: "X",
          choiceArgument: {},
          exerciseResult: null,
          consuming: true,
          actingParties: [],
          witnessParties: [],
          lastDescendantNodeId: last,
          interfaceId: null,
        };

  it("nests by lastDescendantNodeId", () => {
    // 0 Buy [1 Debit [2 create wallet], 3 archive position, 4 create position, 5 create market], 6 top-level create
    const roots = buildEventTree([
      ev("exercised", 0, 5),
      ev("exercised", 1, 2),
      ev("created", 2),
      ev("exercised", 3),
      ev("created", 4),
      ev("created", 5),
      ev("created", 6),
    ]);
    expect(roots.map((r) => r.event.nodeId)).toEqual([0, 6]);
    const buy = roots[0];
    expect(buy.children.map((c) => c.event.nodeId)).toEqual([1, 3, 4, 5]);
    expect(buy.children[0].children.map((c) => c.event.nodeId)).toEqual([2]);
    expect(descendantsOf(buy).map((n) => n.event.nodeId)).toEqual([1, 2, 3, 4, 5]);
    expect(flattenTree(roots).map((n) => n.event.nodeId)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(buy.children[0].children[0].root).toBe(buy);
    expect(buy.children[0].children[0].depth).toBe(2);
    expect(roots[1].parent).toBeNull();
  });

  it("tolerates unsorted input", () => {
    const roots = buildEventTree([ev("created", 2), ev("exercised", 0, 2), ev("created", 1)]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((c) => c.event.nodeId)).toEqual([1, 2]);
  });
});

describe("ids and errors", () => {
  it("event ids", () => {
    expect(eventIdOf("u1", 3)).toBe("u1:3");
    expect(acsEventIdOf("cid")).toBe("acs:cid");
  });

  it("recognises the pruned-data error", () => {
    expect(
      isPrunedDataError(
        new Error("FAILED_PRECONDITION: PARTICIPANT_PRUNED_DATA_ACCESSED(9,abc): ..."),
      ),
    ).toBe(true);
    expect(isPrunedDataError("PARTICIPANT_PRUNED_DATA_ACCESSED")).toBe(true);
    expect(isPrunedDataError(new Error("timeout"))).toBe(false);
    expect(isPrunedDataError({ message: "PARTICIPANT_PRUNED_DATA_ACCESSED" })).toBe(false);
  });
});
