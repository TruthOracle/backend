import type { RampBankLineEntity } from "../entities/ramp-bank-line.entity";
import { parseAmount } from "../util/money";
import {
  applyOrder,
  classificationOf,
  describeStatementConfirm,
} from "./ramp-bank-statements.service";

const line = (lineRef: string, bookingDate: string, amount: string): RampBankLineEntity =>
  ({ lineRef, bookingDate, amount: parseAmount(amount) }) as RampBankLineEntity;

describe("statement application order and classification params (SPEC §10.4)", () => {
  it("applies lines by booking date, debits before credits, then by bank reference (#2: a return never precedes its debit)", () => {
    const rows = [
      line("C-1", "2026-10-16", "50"),
      line("D-2", "2026-10-16", "-50"),
      line("A-0", "2026-10-15", "10"),
      line("D-1", "2026-10-16", "-5"),
    ].sort(applyOrder);
    expect(rows.map((r) => r.lineRef)).toEqual(["A-0", "D-1", "D-2", "C-1"]);
  });

  it("accepts one classification of a known kind with uuid ids, refuses anything else", () => {
    const id = "00000000-0000-4000-8000-0000000000AB";
    expect(classificationOf({ matchKind: "payout", orderId: id })).toEqual({
      matchKind: "payout",
      orderId: id.toLowerCase(),
    });
    expect(classificationOf({ matchKind: "suspense", orderId: "" })).toEqual({
      matchKind: "suspense",
    });
    expect(() => classificationOf({ matchKind: "ignored" })).toThrow(/matchKind must be one of/);
    expect(() => classificationOf({ matchKind: "payout", orderId: "1" })).toThrow(
      /orderId must be a uuid/,
    );
  });
});

describe("W9f: what a statement confirm books, in its approval's words (F3/F9)", () => {
  const snapshot = {
    periodFrom: "2026-10-16",
    periodTo: "2026-10-16",
    lineCount: 3,
    closing: "1028.5000000000",
    classified: [
      {
        lineId: "l-1",
        lineRef: "OUT-1",
        bookingDate: "2026-10-16",
        amount: "-1500.0000000000",
        currency: "BYN",
      },
      {
        lineId: "l-2",
        lineRef: "RET-1",
        bookingDate: "2026-10-16",
        amount: "40.0000000000",
        currency: "BYN",
      },
    ],
  };

  it("names every classification with its line, amount and what it books", () => {
    expect(
      describeStatementConfirm(
        {
          classifications: [
            { lineId: "l-1", matchKind: "operator_sweep" },
            { lineId: "l-2", matchKind: "payout_return", orderId: "o-9" },
          ],
        },
        snapshot,
      ),
    ).toBe(
      "confirm the statement 2026-10-16 … 2026-10-16 (3 lines, closing 1028.5000000000); book line OUT-1 of 2026-10-16 (-1500.00 BYN) as operator_sweep → operator.sweep; line RET-1 of 2026-10-16 (40.00 BYN) as payout_return of order o-9 → offramp.returned_bank (re-mint and credit back)",
    );
    expect(describeStatementConfirm({ classifications: [] }, snapshot)).toBe(
      "confirm the statement 2026-10-16 … 2026-10-16 (3 lines, closing 1028.5000000000); no line booked by hand",
    );
  });

  it("spells out the first 50 and counts the rest", () => {
    const many = Array.from({ length: 53 }, (_, i) => ({
      lineId: `x-${i}`,
      matchKind: "suspense" as const,
    }));
    const text = describeStatementConfirm({ classifications: many }, snapshot);
    expect(text.match(/as suspense/g)).toHaveLength(50);
    expect(text).toMatch(/; and 3 more line\(s\) classified$/);
  });
});
