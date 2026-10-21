import {
  displayPayoutReference,
  luhnCheckDigit,
  luhnValid,
  normalizeReferenceText,
  parsePayoutReference,
  PAYOUT_REFERENCE_RE,
  payoutReferenceDigits,
  payoutReferenceFor,
} from "./payout-reference";

const ORDER = "6f1c0b7e-3d2a-4c5b-9e8f-112233445566";

describe("payout reference (SPEC §3.1, m1)", () => {
  it("computes the Luhn check digit (known vectors)", () => {
    // 7992739871 + 3 is the classic Luhn example; 4111 1111 1111 111 + 1 is a test card number.
    expect(luhnCheckDigit("7992739871")).toBe(3);
    expect(luhnValid("79927398713")).toBe(true);
    expect(luhnValid("79927398710")).toBe(false);
    expect(luhnCheckDigit("411111111111111")).toBe(1);
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("1")).toBe(false);
    expect(luhnValid("12a4")).toBe(false);
    expect(() => luhnCheckDigit("12-3")).toThrow();
  });

  it("derives TO + 11 hash digits + a Luhn digit, deterministic per order and attempt", () => {
    const ref = payoutReferenceFor(ORDER);
    expect(ref).toMatch(PAYOUT_REFERENCE_RE);
    expect(payoutReferenceFor(ORDER)).toBe(ref);
    expect(luhnValid(payoutReferenceDigits(ref))).toBe(true);
    // A collision re-derives with a counter: a different, still valid reference.
    const second = payoutReferenceFor(ORDER, 1);
    expect(second).not.toBe(ref);
    expect(luhnValid(payoutReferenceDigits(second))).toBe(true);
    expect(payoutReferenceFor("another-order")).not.toBe(ref);
  });

  it("every derived reference is valid (zero padding included)", () => {
    for (let i = 0; i < 500; i += 1) {
      const ref = payoutReferenceFor(`order-${i}`);
      expect(ref).toMatch(/^TO\d{12}$/);
      expect(parsePayoutReference(ref)).toBe(ref);
    }
  });

  it("shows TO-<12 digits> and exposes the digits (the ERIP account number)", () => {
    const ref = payoutReferenceFor(ORDER);
    expect(displayPayoutReference(ref)).toBe(`TO-${ref.slice(2)}`);
    expect(payoutReferenceDigits(ref)).toHaveLength(12);
    expect(() => payoutReferenceDigits("TO-123")).toThrow();
  });

  it("parses typed and bank-printed variants: Cyrillic homoglyphs, case, spaces, dashes", () => {
    const ref = payoutReferenceFor(ORDER);
    const d = ref.slice(2);
    const spaced = `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8)}`;
    expect(parsePayoutReference(`TO-${d}`)).toBe(ref);
    expect(parsePayoutReference(`to${d}`)).toBe(ref);
    // Cyrillic Т and О (a Cyrillic keyboard), and lower-case Cyrillic.
    expect(parsePayoutReference(`ТО-${d}`)).toBe(ref);
    expect(parsePayoutReference(`то ${spaced}`)).toBe(ref);
    // En dash, non-breaking space, a purpose line around it.
    expect(
      parsePayoutReference(`Выплата по заказу ТО\u2013${d.slice(0, 6)}\u00a0${d.slice(6)}`),
    ).toBe(ref);
    expect(parsePayoutReference(`Возврат средств по заказу TO ${spaced}.`)).toBe(ref);
  });

  it("refuses a wrong check digit, a short or long number, and other text", () => {
    const ref = payoutReferenceFor(ORDER);
    const d = ref.slice(2);
    const wrong = `${d.slice(0, 11)}${(Number(d[11]) + 1) % 10}`;
    expect(parsePayoutReference(`TO-${wrong}`)).toBeNull();
    expect(parsePayoutReference(`TO-${d.slice(0, 11)}`)).toBeNull();
    // 13 digits: not a reference (the 12-digit prefix must not be accepted).
    expect(parsePayoutReference(`TO-${d}7`)).toBeNull();
    expect(parsePayoutReference("payment for groceries")).toBeNull();
    expect(parsePayoutReference("")).toBeNull();
    expect(parsePayoutReference(null)).toBeNull();
  });

  it("folds only the look-alike capitals (А В Е К М Н О Р С Т Х)", () => {
    expect(normalizeReferenceText("АВЕКМНОРСТХ")).toBe("ABEKMHOPCTX");
    // Not look-alikes: kept as they are (upper-cased).
    expect(normalizeReferenceText("Жд")).toBe("ЖД");
    expect(normalizeReferenceText("t o - 1 2")).toBe("TO12");
  });

  it("takes the first VALID reference when the text carries several candidates", () => {
    const a = payoutReferenceFor("a");
    const b = payoutReferenceFor("b");
    const broken = `TO${a.slice(2, 13)}${(Number(a[13]) + 1) % 10}`;
    expect(parsePayoutReference(`${broken} then ${b}`)).toBe(b);
  });
});
