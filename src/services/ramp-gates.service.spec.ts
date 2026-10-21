import { parseAmount } from "../util/money";
import { reserveFigures } from "./ramp-controls.logic";
import { bankAdjusted } from "./ramp-gates.service";

const A = (v: string): bigint => parseAmount(v);

describe("the reserve's A as the bank shows it (SPEC §6.3, C3)", () => {
  const f = reserveFigures({ safeguard_bank: A("1000"), provider_clearing: A("19.52") });
  const statement = { statementId: "s1", periodTo: "2026-10-16", closingBalance: A("0") };

  it("takes the confirmed statements' unbooked debits off A, nothing else", () => {
    expect(bankAdjusted(f, { ...statement, unbookedDebits: A("-1000") })).toEqual({
      ...f,
      assets: A("19.52"),
    });
    expect(bankAdjusted(f, { ...statement, unbookedDebits: A("-1000") }).safeguardBank).toBe(
      A("1000"),
    );
  });

  it("leaves A alone without unbooked debits or a statement (never adds anything)", () => {
    expect(bankAdjusted(f, { ...statement, unbookedDebits: 0n })).toBe(f);
    expect(bankAdjusted(f, statement)).toBe(f);
    expect(bankAdjusted(f, null)).toBe(f);
    expect(bankAdjusted(f, { ...statement, unbookedDebits: A("5") }).assets).toBe(f.assets);
  });
});
