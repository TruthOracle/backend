import type { BankLineFlag, BankMatchKind, PayoutBatchStatus, PayoutItemStatus } from "../types";

/**
 * The statement matching rules of SPEC §10.4 (#2, #5, #11, X2, X3, X7) as pure functions over
 * facts the ledger service gathers — so every rule is unit-tested without a database. IBANs are
 * compared as blind-index keys `<kid>:<hash>`: a line's counterparty IBAN is keyed under EVERY
 * index kid, an account under its stored kid, so a key rotation never breaks a match.
 */

/** A statement line as the rules see it. */
export interface LineView {
  /** Signed: + credit, − debit. */
  amount: bigint;
  reference: string | null;
  documentNo: string | null;
  /** Every transaction's reference / document number (a batch-booked entry names several, C6). */
  references: readonly string[];
  documentNos: readonly string[];
  /** The counterparty IBAN under every index kid; empty when the bank named none. */
  counterpartyKeys: ReadonlySet<string>;
  counterpartyBic: string | null;
  returnInfo: boolean;
  format: "camt053" | "csv";
}

/** An order a line may concern (found by its reference / document number, or as a candidate). */
export interface OrderFacts {
  orderId: string;
  direction: "onramp" | "offramp";
  status: string;
  reviewStep: string | null;
  /** What leaves the bank for it: P (off-ramp) or the bank refund (on-ramp). */
  amount: bigint;
  /** Its newest batch item and that batch's status. */
  item: { batchId: string; status: PayoutItemStatus; batchStatus: PayoutBatchStatus } | null;
  /** The destination account's key `<kid>:<hash>` and BIC. */
  accountKey: string | null;
  accountBic: string | null;
  /**
   * A debit already matched (this run or before) and not returned since — an on-ramp refund the
   * bank returned is owed again and may be paid once more (S8).
   */
  paid: boolean;
  /** A return already matched for that debit. */
  returned: boolean;
}

export interface BatchFacts {
  batchId: string;
  status: PayoutBatchStatus;
  /** Σ of the items still `included`. */
  includedTotal: bigint;
  includedCount: number;
  /** Items of the file: every item but those voided while the batch was a draft. */
  itemCount: number;
}

export interface MatchFacts {
  /** The order the line's reference (or document number) names, if any. */
  referenced: OrderFacts | null;
  /** Debits without a reference: orders awaiting exactly this debit to this IBAN. */
  candidates: readonly OrderFacts[];
  /** A submitted batch the line's text quotes (id or bank reference). */
  quotedBatch: BatchFacts | null;
  /**
   * C6: the items of ONE submitted batch that a batch-booked entry's transactions name — every
   * per-transaction reference / document number resolving to a still-included item of it — with
   * their total; null when any of them names nothing of the kind (or there are none).
   */
  namedItems: { batchId: string; orderIds: readonly string[]; total: bigint } | null;
  /**
   * R2a-5: orders a batch-booked entry's transactions name whose transaction went to another
   * account than their item's, or for another amount.
   */
  txMismatch: readonly string[];
  /** R2a-6: what an entry naming no single order names that was already paid (null = nothing). */
  duplicate: string | null;
  pspKeys: ReadonlySet<string>;
  /** RAMP_BANK_FEE_MAX (null = never a bank fee) and RAMP_BANK_RETURN_FEE_MAX. */
  feeMax: bigint | null;
  returnFeeMax: bigint;
}

export type MatchDecision =
  | { kind: "payout" | "refund"; orderId: string }
  /** `orderIds`: only these items (a partial batch entry, C6); absent = every included item. */
  | { kind: "payout_batch"; batchId: string; orderIds?: readonly string[] }
  | { kind: "payout_return" | "refund_return"; orderId: string }
  | {
      kind: "psp_settlement" | "psp_funding" | "operator_topup" | "operator_sweep" | "bank_fee";
    }
  | {
      kind: null;
      flags: BankLineFlag[];
      /** iban_mismatch: the order goes to needs_review(payout). */
      reviewOrderId?: string;
      why: string;
    };

const unmatched = (
  why: string,
  flags: BankLineFlag[] = [],
  reviewOrderId?: string,
): MatchDecision => ({
  kind: null,
  flags,
  why,
  ...(reviewOrderId ? { reviewOrderId } : {}),
});

/** Waiting for its debit: its live item is in a SUBMITTED batch, the order sent or parked in payout review (#5). */
export function awaitingDebit(o: OrderFacts): boolean {
  return (
    o.item?.status === "included" &&
    o.item.batchStatus === "submitted" &&
    !o.paid &&
    (o.status === "payout_sent" || (o.status === "needs_review" && o.reviewStep === "payout"))
  );
}

function intersects(keys: ReadonlySet<string>, other: ReadonlySet<string>): boolean {
  for (const k of keys) if (other.has(k)) return true;
  return false;
}

/** The line went to (or came from) the order's account: same IBAN key, and the same bank when the line names a BIC. */
export function sameAccount(line: LineView, o: OrderFacts): boolean {
  if (!o.accountKey || !line.counterpartyKeys.has(o.accountKey)) return false;
  if (!line.counterpartyBic || !o.accountBic) return true;
  return line.counterpartyBic.slice(0, 8) === o.accountBic.slice(0, 8);
}

/** A return of R for a payout of P: R = P, or short by at most RAMP_BANK_RETURN_FEE_MAX (X2). */
export function returnAmountOk(r: bigint, p: bigint, returnFeeMax: bigint): boolean {
  return r > 0n && r <= p && p - r <= returnFeeMax;
}

/** SPEC §10.4 for one line, given the facts. Debits before credits is the caller's ordering. */
export function decideLine(line: LineView, f: MatchFacts): MatchDecision {
  const debit = line.amount < 0n;
  const abs = debit ? -line.amount : line.amount;
  // The PSP's accounts first: whatever the text says, that money stays ours. The operator's own
  // money in and out of this (single) account is never auto-booked: it is classified four-eyes.
  if (intersects(line.counterpartyKeys, f.pspKeys))
    return { kind: debit ? "psp_funding" : "psp_settlement" };
  return debit ? decideDebit(line, abs, f) : decideCredit(line, abs, f);
}

function decideDebit(line: LineView, p: bigint, f: MatchFacts): MatchDecision {
  const o = f.referenced;
  if (o) {
    if (o.paid)
      return unmatched("a second debit for a payout already matched", ["payout_duplicate"]);
    if (!awaitingDebit(o))
      return unmatched(`a debit for an order we did not submit (${o.status})`, [
        "payout_duplicate",
      ]);
    // R2a-4: the account before the amount — a kopeck added never hides an IBAN swap.
    if (!sameAccount(line, o))
      return unmatched(
        "the payout debit went to another account than the order's",
        ["iban_mismatch"],
        o.orderId,
      );
    if (p !== o.amount) return unmatched("the debit quotes the order but the amount differs");
    return { kind: o.direction === "offramp" ? "payout" : "refund", orderId: o.orderId };
  }
  // R2a-6: the file executed (or uploaded) twice; R2a-5: a transaction paid elsewhere or another sum.
  if (f.duplicate)
    return unmatched(`a debit for payouts already paid: ${f.duplicate}`, ["payout_duplicate"]);
  if (f.txMismatch.length)
    return unmatched(
      "a transaction of the entry went to another account, or for another amount, than its order's",
      ["iban_mismatch"],
      f.txMismatch[0],
    );
  const b = f.quotedBatch;
  if (b && b.status === "submitted" && b.includedCount === b.itemCount && b.includedTotal === p)
    return { kind: "payout_batch", batchId: b.batchId };
  // C6: the bank executed part of the file as one entry naming each transaction — exactly those
  // items, when every transaction names one and their amounts add up to the debit.
  const named = f.namedItems;
  if (named && named.orderIds.length > 0 && named.total === p)
    return { kind: "payout_batch", batchId: named.batchId, orderIds: named.orderIds };
  const hits = f.candidates.filter(
    (c) => awaitingDebit(c) && c.amount === p && sameAccount(line, c),
  );
  if (hits.length === 1)
    return {
      kind: hits[0].direction === "offramp" ? "payout" : "refund",
      orderId: hits[0].orderId,
    };
  if (hits.length > 1) return unmatched(`${hits.length} payouts of this amount to this account`);
  // A line naming payouts (its transactions' references) is never a fee, whatever its size.
  const namesPayouts = line.references.length > 0 || line.documentNos.length > 0;
  if (line.counterpartyKeys.size === 0 && !namesPayouts && f.feeMax !== null && p <= f.feeMax)
    return { kind: "bank_fee" };
  return unmatched("no rule matches this debit");
}

function decideCredit(line: LineView, r: bigint, f: MatchFacts): MatchDecision {
  const o = f.referenced;
  if (!o) return unmatched("no rule matches this credit");
  const strict =
    o.paid &&
    !o.returned &&
    returnAmountOk(r, o.amount, f.returnFeeMax) &&
    line.format === "camt053" &&
    (sameAccount(line, o) || line.returnInfo);
  if (strict && o.direction === "offramp") return { kind: "payout_return", orderId: o.orderId };
  // S8: an on-ramp's bank refund the bank sent back, while the order still reads refunded by it.
  if (strict && o.direction === "onramp" && o.status === "refunded")
    return { kind: "refund_return", orderId: o.orderId };
  // A credit quoting an order that is not a strict return never moves money (X2: the 0.01 BYN "return").
  return unmatched("a credit quoting an order is not a return under the strict rules", [
    "reference_credit",
  ]);
}

/**
 * The PSP fee true-up after a settlement (SPEC §5 `psp.fee`): the residual provider_clearing
 * would keep (B − X) is booked to psp_fees when it is no larger than the fees accrued since the
 * previous settlement; negative = we over-accrued. Null = nothing to true up.
 */
export function pspResidual(
  pcBefore: bigint,
  settlement: bigint,
  accruedSince: bigint,
): bigint | null {
  const residual = pcBefore - settlement;
  if (residual === 0n || accruedSince <= 0n) return null;
  const abs = residual < 0n ? -residual : residual;
  return abs <= accruedSince ? residual : null;
}

/** What a classification may book, by direction (SPEC §10.4: suspense, or a kind whose conditions hold). */
export function classificationAllowed(kind: BankMatchKind, debit: boolean): boolean {
  switch (kind) {
    case "suspense":
      return true;
    case "payout":
    case "refund":
    case "payout_batch":
    case "psp_funding":
    case "operator_sweep":
    case "bank_fee":
      return debit;
    case "payout_return":
    case "refund_return":
    case "psp_settlement":
    case "operator_topup":
      return !debit;
    default:
      return false;
  }
}
