import { freshnessOf } from "./indexer.service";

describe("index freshness (docs/TOKENS.md §4.3)", () => {
  it("is fresh while the index is at most LEDGER_FRESH_OFFSETS behind the ledger end", () => {
    expect(freshnessOf(100, 100, 50)).toEqual({
      offset: 100,
      ledgerEnd: 100,
      lag: 0,
      maxLag: 50,
      fresh: true,
    });
    expect(freshnessOf(50, 100, 50)).toMatchObject({ lag: 50, fresh: true });
    expect(freshnessOf(49, 100, 50)).toMatchObject({ lag: 51, fresh: false });
    expect(freshnessOf(0, 0, 50)).toMatchObject({ lag: 0, fresh: true });
  });

  it("never reports a negative lag when the index read ran ahead of the ledger-end read", () => {
    expect(freshnessOf(101, 100, 0)).toMatchObject({ lag: 0, fresh: true });
  });
});
