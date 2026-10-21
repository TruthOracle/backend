import type { VerifiedName } from "./kyc-identity.port";
import { payerIsHolder } from "./ramp-bank-accounts.service";

const ivanou: VerifiedName[] = [
  { script: "lat", last: "Ivanou", first: "Ivan", middle: null },
  { script: "ru", last: "Иванов", first: "Иван", middle: "Петрович" },
];

describe("payer_match: the bank-reported payer is the account holder (X10, C10)", () => {
  it("accepts the holder's surname and first name, in any order and script", () => {
    for (const payer of ["IVANOU IVAN", "Ivan Ivanou", "ИВАНОВ ИВАН ПЕТРОВИЧ", "Іваноў Іван"])
      expect(payerIsHolder(payer, ivanou)).toBe(true);
  });

  it("refuses a third party, a relative sharing only the surname, and a surname or first name alone", () => {
    for (const payer of ["ПЕТРОВ ПЁТР", "IVANOU MARYIA", "IVANOU", "IVAN", "", "  "])
      expect(payerIsHolder(payer, ivanou)).toBe(false);
  });
});
