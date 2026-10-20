import { Injectable, Logger } from "@nestjs/common";
import type { EntityManager } from "typeorm";

import { Config } from "../config";
import { RampBankAccountEntity } from "../entities/ramp-bank-account.entity";
import { RampBankLineEntity } from "../entities/ramp-bank-line.entity";
import type { RampAccount } from "../entities/ramp-journal.entity";
import { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPayoutBatchItemEntity } from "../entities/ramp-payout-batch-item.entity";
import { RampPayoutBatchEntity } from "../entities/ramp-payout-batch.entity";
import type { Actor, BankLineFlag, BankMatchKind, PayoutItemStatus } from "../types";
import { ApiError } from "../util/errors";
import { formatAmount, parseAmount } from "../util/money";
import { AuditService } from "./audit.service";
import { RampBankAccountsService } from "./ramp-bank-accounts.service";
import {
  awaitingDebit,
  type BatchFacts,
  classificationAllowed,
  decideLine,
  type LineView,
  type MatchDecision,
  type MatchFacts,
  type OrderFacts,
  pspResidual,
  returnAmountOk,
  sameAccount,
} from "./ramp-bank-matching.logic";
import { RAMP_IBAN_INDEX_PURPOSE, normalizeIbanForIndex } from "./ramp-bank-rail.port";
import { RampBankSealing } from "./ramp-bank-sealing.service";
import { lineFromSealed } from "./ramp-bank-statement.parse";
import {
  onrampBasis,
  postingFor,
  RampJournalService,
  type RampOrderKind,
} from "./ramp-journal.service";
import { RampOrderStore } from "./ramp-order-store.service";
import { SealedDataService } from "./sealed-data.service";
import { SentryService } from "./sentry.service";

/** What one run (a preview, a confirm, a classification) carries. */
export interface LedgerRun {
  /** preview: decide only (the overlay records what earlier lines would do); apply: write. */
  mode: "preview" | "apply";
  actor: Actor;
  approvalId: string | null;
  format: "camt053" | "csv";
  /** Simulated effects of earlier lines (preview only; an apply run reads its own writes). */
  overlay: Map<
    string,
    Partial<Pick<OrderFacts, "status" | "paid" | "returned">> & { itemStatus?: PayoutItemStatus }
  >;
  /** Orders the run moved to `reversing` (advanced after the commit). */
  reversing: string[];
  operatorKeys: ReadonlySet<string>;
  pspKeys: ReadonlySet<string>;
}

export interface LineOutcome {
  status: "unmatched" | "proposed" | "matched";
  matchKind: BankMatchKind | null;
  matchedOrderId: string | null;
  matchedBatchId: string | null;
  flags: BankLineFlag[];
  why: string | null;
}

export interface Classification {
  matchKind: BankMatchKind;
  orderId?: string | null;
  batchId?: string | null;
}

/** The rules' view of a line plus the texts that may name a payment file (sealed: never stored plain). */
export type LedgerLineView = LineView & {
  purpose: string | null;
  batchRefs: string[];
  /** R2a-5: a batch-booked entry's transactions, their accounts keyed under every kid. */
  transactions: {
    reference: string | null;
    documentNo: string | null;
    keys: ReadonlySet<string>;
    amount: bigint | null;
  }[];
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function abort(message: string): ApiError {
  return new ApiError(409, "bank_line_state", message);
}

/** What leaves the bank for an order: P of an off-ramp, the refund (C, or F) of an on-ramp. */
export function bankAmountOf(order: RampOrderEntity): bigint {
  return order.direction === "offramp" ? order.fiatAmount : onrampBasis(order).charged;
}

/**
 * The statement ledger (SPEC §10.4, §5): gathers the facts SPEC's matching rules need (the order a
 * line names, the IBAN candidates, a quoted batch, our own accounts) and applies a decision in the
 * caller's transaction — order compare-and-sets, the postings (each with `statement_line_id`),
 * batch items, accounts, the line. A lost compare-and-set throws: the whole confirm aborts.
 */
@Injectable()
export class RampBankLedger {
  private readonly logger = new Logger(RampBankLedger.name);

  constructor(
    private readonly config: Config,
    private readonly sealed: SealedDataService,
    private readonly sealing: RampBankSealing,
    private readonly journal: RampJournalService,
    private readonly store: RampOrderStore,
    private readonly accounts: RampBankAccountsService,
    private readonly audit: AuditService,
    private readonly sentry: SentryService,
  ) {}

  /** A run's context: our operator and PSP IBANs keyed under every index kid. */
  run(
    mode: LedgerRun["mode"],
    format: LedgerRun["format"],
    actor: Actor,
    approvalId: string | null,
  ): LedgerRun {
    const keys = (ibans: string[]): Set<string> =>
      new Set(
        ibans.flatMap((iban) =>
          this.sealed
            .blindIndexes(RAMP_IBAN_INDEX_PURPOSE, normalizeIbanForIndex(iban))
            .map((k) => `${k.kid}:${k.hash}`),
        ),
      );
    return {
      mode,
      actor,
      approvalId,
      format,
      overlay: new Map(),
      reversing: [],
      operatorKeys: keys(this.config.rampBank.operatorAccountIbans),
      pspKeys: keys(this.config.rampBank.pspSettlementIbans),
    };
  }

  /** The line as the rules see it (the counterparty IBAN keyed under every kid, from the sealed line). */
  view(line: RampBankLineEntity, format: LedgerRun["format"]): LedgerLineView {
    const raw = this.sealing.unsealLine(line);
    const parsed = lineFromSealed(raw);
    const keys = raw.counterpartyIban ? this.sealing.ibanKeys(raw.counterpartyIban) : [];
    return {
      amount: line.amount,
      reference: line.reference,
      documentNo: line.documentNo,
      // C6: every transaction's reference (a line sealed before they were kept: its own).
      references: parsed.references.length
        ? parsed.references
        : line.reference
          ? [line.reference]
          : [],
      documentNos: parsed.documentNos.length
        ? parsed.documentNos
        : line.documentNo
          ? [line.documentNo]
          : [],
      counterpartyKeys: new Set(keys),
      counterpartyBic: line.counterpartyBic,
      returnInfo: line.returnInfo,
      format,
      purpose: raw.purpose,
      batchRefs: parsed.batchRefs,
      transactions: parsed.transactions.map((t) => ({
        reference: t.reference,
        documentNo: t.documentNo,
        keys: new Set(t.iban ? this.sealing.ibanKeys(t.iban) : []),
        amount: t.amount === null ? null : parseAmount(t.amount),
      })),
    };
  }

  /** The texts a line names a payment file by: its purpose and the bank's file ids (camt Btch). */
  static fileTexts(view: Pick<LedgerLineView, "purpose" | "batchRefs">): string | null {
    const texts = [view.purpose, ...view.batchRefs].filter((t): t is string => !!t);
    return texts.length ? texts.join(" | ") : null;
  }

  // ───────────────────────────────────────────── facts ──────────────────────────────────────

  async orderFacts(m: EntityManager, order: RampOrderEntity, run: LedgerRun): Promise<OrderFacts> {
    const item = await m
      .getRepository(RampPayoutBatchItemEntity)
      .findOne({ where: { orderId: order.id }, order: { createdAt: "DESC" } });
    const batch = item
      ? await m.getRepository(RampPayoutBatchEntity).findOne({ where: { id: item.batchId } })
      : null;
    const account = order.bankAccountId
      ? await m.getRepository(RampBankAccountEntity).findOne({ where: { id: order.bankAccountId } })
      : null;
    const posted = await this.journal.postedKinds(m, order.id);
    const ov = run.overlay.get(order.id) ?? {};
    // An on-ramp's bank refund may be returned and paid again (S8): paid = a payment not returned.
    const refundOutstanding =
      order.direction === "onramp" && posted.has("refund.paid_bank")
        ? (await this.journal.postedCount(m, order.id, "refund.paid_bank")) >
          (await this.journal.postedCount(m, order.id, "refund.returned_bank"))
        : false;
    return {
      orderId: order.id,
      direction: order.direction,
      status: ov.status ?? order.status,
      reviewStep: ov.status ? null : order.reviewStep,
      amount: bankAmountOf(order),
      item:
        item && batch
          ? {
              batchId: item.batchId,
              status: ov.itemStatus ?? item.status,
              batchStatus: batch.status,
            }
          : null,
      accountKey: account ? `${account.ibanHashKid}:${account.ibanHash}` : null,
      accountBic: account?.bic ?? null,
      paid:
        ov.paid ??
        (order.direction === "offramp" ? posted.has("offramp.paid_bank") : refundOutstanding),
      returned:
        ov.returned ?? (order.direction === "offramp" && posted.has("offramp.returned_bank")),
    };
  }

  /** The order a line names: its `TO` reference, else its document number (one item per number). */
  private async referencedOrder(
    m: EntityManager,
    line: RampBankLineEntity,
  ): Promise<RampOrderEntity | null> {
    const orders = m.getRepository(RampOrderEntity);
    if (line.reference) {
      const o = await orders.findOne({ where: { payoutReference: line.reference } });
      if (o) return o;
    }
    if (line.documentNo) {
      const item = await m
        .getRepository(RampPayoutBatchItemEntity)
        .findOne({ where: { documentNo: line.documentNo } });
      if (item) return orders.findOne({ where: { id: item.orderId } });
    }
    return null;
  }

  async batchFacts(m: EntityManager, batchId: string): Promise<BatchFacts | null> {
    const batch = await m.getRepository(RampPayoutBatchEntity).findOne({ where: { id: batchId } });
    if (!batch) return null;
    const items = await m.getRepository(RampPayoutBatchItemEntity).find({ where: { batchId } });
    const included = items.filter((i) => i.status === "included");
    return {
      batchId,
      status: batch.status,
      includedTotal: included.reduce((s, i) => s + i.amount, 0n),
      includedCount: included.length,
      // R2a-3: the items of the FILE — in a live batch only a draft removal voids one (C19, C25),
      // and that item never reached the bank.
      itemCount: items.filter((i) => i.status !== "voided").length,
    };
  }

  /** A SUBMITTED batch the line's text quotes, by id or by the bank's reference for the file. */
  private async quotedBatch(m: EntityManager, purpose: string | null): Promise<BatchFacts | null> {
    if (!purpose) return null;
    const ids = [...new Set((purpose.match(UUID_RE) ?? []).map((s) => s.toLowerCase()))];
    const repo = m.getRepository(RampPayoutBatchEntity);
    for (const id of ids) {
      const b = await repo.findOne({ where: { id, status: "submitted" } });
      if (b) return this.batchFacts(m, b.id);
    }
    const text = purpose.toUpperCase();
    const refs = await repo.find({
      where: { status: "submitted" },
      select: { id: true, bankReference: true },
    });
    const hit = refs.find(
      (b) =>
        b.bankReference &&
        b.bankReference.length >= 4 &&
        text.includes(b.bankReference.toUpperCase()),
    );
    return hit ? this.batchFacts(m, hit.id) : null;
  }

  /**
   * C6: the items of ONE submitted batch a batch-booked debit's transactions name (each by its
   * reference or document number) — null unless EVERY name resolves to an item still included and
   * awaiting its debit (this run's earlier lines counted), all in that one batch. A line quoting a
   * single order is the order rule's.
   */
  async namedItems(
    m: EntityManager,
    view: LedgerLineView,
    run: LedgerRun,
  ): Promise<MatchFacts["namedItems"]> {
    if (view.amount >= 0n || view.reference || view.documentNo) return null;
    if (!view.references.length && !view.documentNos.length) return null;
    // R2a-8: a camt entry without transaction details names payouts in its text only — never
    // booked on those names (a proof still reads them; no rule books it as a fee).
    if (view.format === "camt053" && view.transactions.length === 0) return null;
    const items = m.getRepository(RampPayoutBatchItemEntity);
    const orders = m.getRepository(RampOrderEntity);
    const found = new Map<string, RampPayoutBatchItemEntity>();
    for (const reference of view.references) {
      const o = await orders.findOne({ where: { payoutReference: reference } });
      const item = o ? await items.findOne({ where: { orderId: o.id, status: "included" } }) : null;
      if (!item) return null;
      found.set(item.orderId, item);
    }
    for (const documentNo of view.documentNos) {
      const item = await items.findOne({ where: { documentNo, status: "included" } });
      if (!item) return null;
      found.set(item.orderId, item);
    }
    const list = [...found.values()];
    const batchIds = new Set(list.map((i) => i.batchId));
    if (batchIds.size !== 1) return null;
    for (const item of list) {
      const o = await orders.findOne({ where: { id: item.orderId } });
      if (!o || !awaitingDebit(await this.orderFacts(m, o, run))) return null;
    }
    return {
      batchId: list[0].batchId,
      orderIds: list.map((i) => i.orderId).sort(),
      total: list.reduce((s, i) => s + i.amount, 0n),
    };
  }

  /**
   * R2a-5: the orders a batch-booked entry's transactions name (by reference or document number)
   * whose transaction went to another account than the item's, or for another amount — what the
   * bank says it paid, checked whenever it says it.
   */
  private async txMismatch(m: EntityManager, view: LedgerLineView): Promise<string[]> {
    const out: string[] = [];
    const items = m.getRepository(RampPayoutBatchItemEntity);
    for (const t of view.transactions) {
      if (t.keys.size === 0 && t.amount === null) continue;
      const o = t.reference
        ? await m
            .getRepository(RampOrderEntity)
            .findOne({ where: { payoutReference: t.reference } })
        : null;
      const item = o
        ? await items.findOne({ where: { orderId: o.id, status: "included" } })
        : t.documentNo
          ? await items.findOne({ where: { documentNo: t.documentNo, status: "included" } })
          : null;
      if (!item) continue;
      const ownAccount = t.keys.size === 0 || t.keys.has(`${item.ibanHashKid}:${item.ibanHash}`);
      if (!ownAccount || (t.amount !== null && t.amount !== item.amount)) out.push(item.orderId);
    }
    return [...new Set(out)];
  }

  /**
   * R2a-6: a debit naming no single order that names a payout already paid (a transaction's or
   * the text's reference or document number), or a settled / voided batch by its file names — the
   * file executed (or uploaded) twice. Null = none; else what it names.
   */
  private async duplicateOf(
    m: EntityManager,
    view: LedgerLineView,
    run: LedgerRun,
  ): Promise<string | null> {
    const orders = m.getRepository(RampOrderEntity);
    const items = m.getRepository(RampPayoutBatchItemEntity);
    for (const reference of view.references) {
      const o = await orders.findOne({ where: { payoutReference: reference } });
      if (o && (await this.orderFacts(m, o, run)).paid) return `order ${o.id} was paid`;
    }
    for (const documentNo of view.documentNos) {
      const item = await items.findOne({ where: { documentNo } });
      const o = item ? await orders.findOne({ where: { id: item.orderId } }) : null;
      if (o && (await this.orderFacts(m, o, run)).paid) return `order ${o.id} was paid`;
    }
    const text = RampBankLedger.fileTexts(view);
    if (!text) return null;
    const [hit] = await m.query<{ id: string; status: string }[]>(
      `SELECT id, status FROM to_ramp_payout_batches
        WHERE status IN ('settled', 'voided')
          AND (strpos($1, upper(id::text)) > 0
            OR (length(bank_reference) >= 4 AND strpos($1, upper(bank_reference)) > 0))
        LIMIT 1`,
      [text.toUpperCase()],
    );
    return hit ? `payout batch ${hit.id} is ${hit.status}` : null;
  }

  async facts(
    m: EntityManager,
    line: RampBankLineEntity,
    view: LedgerLineView,
    run: LedgerRun,
  ): Promise<MatchFacts> {
    const referenced = await this.referencedOrder(m, line);
    let candidates: OrderFacts[] = [];
    if (!referenced && line.amount < 0n && view.counterpartyKeys.size > 0) {
      const hashes = [...view.counterpartyKeys].map((k) => k.slice(k.indexOf(":") + 1));
      const rows = await m.query<{ order_id: string }[]>(
        `SELECT i.order_id FROM to_ramp_payout_batch_items i JOIN to_ramp_payout_batches b ON b.id = i.batch_id
          WHERE i.status = 'included' AND b.status = 'submitted' AND i.amount = $1 AND i.iban_hash = ANY($2::text[]) LIMIT 20`,
        [formatAmount(-line.amount), hashes],
      );
      for (const r of rows) {
        const o = await m.getRepository(RampOrderEntity).findOne({ where: { id: r.order_id } });
        if (o) candidates.push(await this.orderFacts(m, o, run));
      }
      candidates = candidates.filter((c) => awaitingDebit(c));
    }
    return {
      referenced: referenced ? await this.orderFacts(m, referenced, run) : null,
      candidates,
      quotedBatch: referenced ? null : await this.quotedBatch(m, RampBankLedger.fileTexts(view)),
      namedItems: referenced ? null : await this.namedItems(m, view, run),
      txMismatch: line.amount < 0n ? await this.txMismatch(m, view) : [],
      duplicate: line.amount < 0n && !referenced ? await this.duplicateOf(m, view, run) : null,
      operatorKeys: run.operatorKeys,
      pspKeys: run.pspKeys,
      feeMax: this.config.rampBank.feeMax,
      returnFeeMax: this.config.rampBank.returnFeeMax,
    };
  }

  // ───────────────────────────────────────────── decide + book ──────────────────────────────

  /** SPEC §10.4's rules for one line, then (apply runs) its effects. */
  async process(m: EntityManager, line: RampBankLineEntity, run: LedgerRun): Promise<LineOutcome> {
    const view = this.view(line, run.format);
    const decision = decideLine(view, await this.facts(m, line, view, run));
    return this.effect(m, line, decision, run);
  }

  /**
   * An operator's classification (confirm params or the four-eyes `ramp.bank_line.classify`):
   * `suspense`, or a kind whose conditions hold for THIS line — nothing books a theft as a fee or
   * a sweep (X7). Throws 409 `bank_line_state` with the reason otherwise.
   */
  async classify(
    m: EntityManager,
    line: RampBankLineEntity,
    c: Classification,
    run: LedgerRun,
  ): Promise<LineOutcome> {
    if (line.status === "matched") throw abort("the line is already booked");
    const debit = line.amount < 0n;
    const abs = debit ? -line.amount : line.amount;
    if (!classificationAllowed(c.matchKind, debit))
      throw abort(`a ${debit ? "debit" : "credit"} cannot be classified as ${c.matchKind}`);
    if (c.matchKind === "suspense") {
      if (run.mode === "apply")
        await this.postLine(m, line, run, debit ? "suspense.out" : "suspense.in", [
          ["safeguard_bank", line.amount],
          ["bank_suspense", -line.amount],
        ]);
      return outcome(run, "suspense", null, null);
    }
    const view = this.view(line, run.format);
    const hits = (keys: ReadonlySet<string>): boolean =>
      [...view.counterpartyKeys].some((k) => keys.has(k));
    const order = async (direction: "onramp" | "offramp"): Promise<OrderFacts> => {
      const o = c.orderId
        ? await m.getRepository(RampOrderEntity).findOne({ where: { id: c.orderId } })
        : null;
      if (!o || o.direction !== direction) throw abort(`orderId must name an ${direction} order`);
      return this.orderFacts(m, o, run);
    };
    let decision: MatchDecision;
    switch (c.matchKind) {
      case "bank_fee": {
        const max = this.config.rampBank.feeMax;
        if (view.counterpartyKeys.size > 0 || max === null || abs > max)
          throw abort("a bank fee has no counterparty and is at most RAMP_BANK_FEE_MAX");
        decision = { kind: "bank_fee" };
        break;
      }
      case "operator_topup":
      case "operator_sweep":
        if (!hits(run.operatorKeys)) throw abort("the counterparty is not an operator account");
        decision = { kind: c.matchKind };
        break;
      case "psp_settlement":
      case "psp_funding":
        if (!hits(run.pspKeys)) throw abort("the counterparty is not a PSP settlement account");
        decision = { kind: c.matchKind };
        break;
      case "payout":
      case "refund": {
        const o = await order(c.matchKind === "payout" ? "offramp" : "onramp");
        if (!awaitingDebit(o) || o.amount !== abs || !sameAccount(view, o))
          throw abort("the order is not awaiting exactly this debit to its own account");
        decision = { kind: c.matchKind, orderId: o.orderId };
        break;
      }
      case "payout_return": {
        const o = await order("offramp");
        const ok =
          o.paid &&
          !o.returned &&
          returnAmountOk(abs, o.amount, this.config.rampBank.returnFeeMax) &&
          (sameAccount(view, o) || line.returnInfo);
        if (!ok) throw abort("not a return of a paid payout (amount, IBAN or return information)");
        decision = { kind: "payout_return", orderId: o.orderId };
        break;
      }
      case "refund_return": {
        const o = await order("onramp");
        const ok =
          o.paid &&
          !o.returned &&
          o.status === "refunded" &&
          returnAmountOk(abs, o.amount, this.config.rampBank.returnFeeMax) &&
          (sameAccount(view, o) || line.returnInfo);
        if (!ok)
          throw abort("not a return of a paid bank refund (amount, IBAN or return information)");
        decision = { kind: "refund_return", orderId: o.orderId };
        break;
      }
      case "payout_batch": {
        const b = c.batchId ? await this.batchFacts(m, c.batchId) : null;
        if (b?.status !== "submitted")
          throw abort("the batch is not a submitted batch whose total is this debit");
        if (b.includedCount === b.itemCount && b.includedTotal === abs) {
          decision = { kind: "payout_batch", batchId: b.batchId };
          break;
        }
        // C6: the bank executed part of the file — exactly the items the entry's transactions name.
        const named = await this.namedItems(m, view, run);
        if (named?.batchId !== b.batchId || named.total !== abs)
          throw abort(
            "the batch is not a submitted batch whose total (or the items this entry names) is this debit",
          );
        decision = { kind: "payout_batch", batchId: b.batchId, orderIds: named.orderIds };
        break;
      }
      default:
        throw abort(`${String(c.matchKind)} cannot be classified by hand`);
    }
    return this.effect(m, line, decision, run);
  }

  private async effect(
    m: EntityManager,
    line: RampBankLineEntity,
    d: MatchDecision,
    run: LedgerRun,
  ): Promise<LineOutcome> {
    const X = line.amount < 0n ? -line.amount : line.amount;
    switch (d.kind) {
      case null:
        if (run.mode === "apply") {
          if (d.reviewOrderId) await this.mismatchReview(m, d.reviewOrderId, line, run);
          if (d.flags.length) await this.flagged(m, line, d.flags, d.why, run);
          else if (line.amount < 0n) await this.unbookedDebit(m, line, d.why, run);
        }
        return {
          status: "unmatched",
          matchKind: null,
          matchedOrderId: null,
          matchedBatchId: null,
          flags: d.flags,
          why: d.why,
        };
      case "payout":
      case "refund": {
        const batchId = await this.settleOrder(m, d.orderId, line, run);
        return outcome(run, d.kind, d.orderId, batchId);
      }
      case "payout_batch": {
        const items = await m.getRepository(RampPayoutBatchItemEntity).find({
          where: { batchId: d.batchId, status: "included" },
          order: { documentNo: "ASC" },
        });
        // A partial entry (C6) settles only the items it names; the rest wait for their own debit.
        const chosen = d.orderIds ? items.filter((i) => d.orderIds!.includes(i.orderId)) : items;
        if (d.orderIds && chosen.length !== d.orderIds.length)
          throw abort(`an item batch ${d.batchId} names is no longer in it; propose again`);
        for (const item of chosen) await this.settleOrder(m, item.orderId, line, run);
        return outcome(run, "payout_batch", null, d.batchId);
      }
      case "payout_return":
        await this.returnOrder(m, d.orderId, line, run);
        return outcome(run, "payout_return", d.orderId, null);
      case "refund_return":
        await this.returnRefund(m, d.orderId, line, run);
        return outcome(run, "refund_return", d.orderId, null);
      case "psp_settlement":
        if (run.mode === "apply") await this.pspSettlement(m, line, run);
        return outcome(run, d.kind, null, null);
      case "psp_funding":
        await this.postLine(m, line, run, "psp.funding", [
          ["provider_clearing", X],
          ["safeguard_bank", -X],
        ]);
        return outcome(run, d.kind, null, null);
      case "operator_topup":
        await this.postLine(m, line, run, "operator.topup", [
          ["safeguard_bank", X],
          ["operator_money", -X],
        ]);
        return outcome(run, d.kind, null, null);
      case "operator_sweep":
        await this.postLine(m, line, run, "operator.sweep", [
          ["operator_money", X],
          ["safeguard_bank", -X],
        ]);
        return outcome(run, d.kind, null, null);
      case "bank_fee":
        await this.postLine(m, line, run, "bank.fee", [
          ["bank_fees", X],
          ["safeguard_bank", -X],
        ]);
        return outcome(run, d.kind, null, null);
    }
  }

  /**
   * A matched payout debit: the order → completed (`offramp.paid_bank`) or, an on-ramp bank refund,
   * → refunded (`refund.paid_bank`), its item paid, the account's first payout recorded, the batch
   * settled once nothing is left in it. Returns the batch.
   */
  private async settleOrder(
    m: EntityManager,
    orderId: string,
    line: RampBankLineEntity,
    run: LedgerRun,
  ): Promise<string | null> {
    const items = m.getRepository(RampPayoutBatchItemEntity);
    const item = await items.findOne({ where: { orderId, status: "included" } });
    if (run.mode === "preview") {
      const o = await m.getRepository(RampOrderEntity).findOne({ where: { id: orderId } });
      run.overlay.set(orderId, {
        ...run.overlay.get(orderId),
        paid: true,
        itemStatus: "paid",
        status: o?.direction === "onramp" ? "refunded" : "completed",
      });
      return item?.batchId ?? null;
    }
    const order = await this.store.lockForUpdate(m, orderId);
    if (!order || !item) throw abort(`order ${orderId} has no live batch item`);
    const offramp = order.direction === "offramp";
    const kind: RampOrderKind = offramp ? "offramp.paid_bank" : "refund.paid_bank";
    // An on-ramp refund is paid again only after its last payment came back (S8).
    const paidBefore = await this.journal.postedCount(m, order.id, kind);
    const returned = offramp
      ? 0
      : await this.journal.postedCount(m, order.id, "refund.returned_bank");
    if (paidBefore > returned) throw abort(`order ${order.id} is already paid`);
    const account = order.bankAccountId
      ? await m.getRepository(RampBankAccountEntity).findOne({ where: { id: order.bankAccountId } })
      : null;
    const won = await this.store.transition(
      order,
      [order.status],
      offramp ? "completed" : "refunded",
      { attempts: 0, lastError: null },
      {
        actor: run.actor,
        manager: m,
        detail: `bank statement line ${line.lineRef}`,
        expect: { payoutBatchId: item.batchId },
        details: {
          payout: {
            bankBic: account?.bic ?? null,
            bankName: account?.bankName ?? null,
            ibanLast4: account?.ibanLast4 ?? null,
            executedAt: line.bookingDate,
            statementLineId: line.id,
          },
        },
        within: (mm, fresh) => this.postOrder(mm, fresh, kind, line.id),
      },
    );
    if (!won)
      throw abort(`order ${order.id} changed while the statement was applied; propose again`);
    await items.update({ batchId: item.batchId, orderId }, { status: "paid", paidLineId: line.id });
    if (account) await this.accounts.markPaid(m, account.id, order.id);
    await this.settleBatchIfDone(m, item.batchId);
    return item.batchId;
  }

  /** A strict return (SPEC §10.4): → reversing with `offramp.returned_bank` at the LINE amount; the account is blocked. */
  private async returnOrder(
    m: EntityManager,
    orderId: string,
    line: RampBankLineEntity,
    run: LedgerRun,
  ): Promise<void> {
    if (run.mode === "preview") {
      run.overlay.set(orderId, {
        ...run.overlay.get(orderId),
        returned: true,
        status: "reversing",
        itemStatus: "returned",
      });
      return;
    }
    const order = await this.store.lockForUpdate(m, orderId);
    if (!order) throw abort(`order ${orderId} not found`);
    const items = m.getRepository(RampPayoutBatchItemEntity);
    const item = await items.findOne({
      where: { orderId, status: "paid" },
      order: { createdAt: "DESC" },
    });
    const won = await this.store.transition(
      order,
      [order.status],
      "reversing",
      // C4: the payment came back, so the order leaves its batch (as bank_unpaid does): its
      // reversal's exits must not read it as still in a batch. The item keeps the history.
      { attempts: 0, lastError: null, payoutBatchId: null },
      {
        actor: run.actor,
        manager: m,
        detail: `bank return on statement line ${line.lineRef} (${line.returnCode ?? "credit"})`,
        details: {
          bankReturn: {
            statementLineId: line.id,
            amount: formatAmount(line.amount),
            code: line.returnCode,
            at: line.bookingDate,
          },
        },
        within: (mm, fresh) =>
          this.postOrder(mm, fresh, "offramp.returned_bank", line.id, line.amount),
      },
    );
    if (!won)
      throw abort(`order ${order.id} changed while the statement was applied; propose again`);
    if (item)
      await items.update(
        { batchId: item.batchId, orderId },
        { status: "returned", returnedLineId: line.id },
      );
    if (order.bankAccountId)
      await this.accounts.block(
        m,
        order.bankAccountId,
        `bank return ${line.returnCode ?? "credit"} on ${line.lineRef}`,
      );
    run.reversing.push(order.id);
  }

  /**
   * An on-ramp's bank refund the bank sent back (S8, the strict return rule): `refund.returned_bank`
   * at the LINE amount (the money is owed again), the order back to needs_review(refund) so a new
   * `refund_bank` can pay it, the item returned and the account blocked (closed, or the name failed).
   */
  private async returnRefund(
    m: EntityManager,
    orderId: string,
    line: RampBankLineEntity,
    run: LedgerRun,
  ): Promise<void> {
    if (run.mode === "preview") {
      run.overlay.set(orderId, {
        ...run.overlay.get(orderId),
        returned: true,
        status: "needs_review",
        itemStatus: "returned",
      });
      return;
    }
    const order = await this.store.lockForUpdate(m, orderId);
    if (!order) throw abort(`order ${orderId} not found`);
    const items = m.getRepository(RampPayoutBatchItemEntity);
    const item = await items.findOne({
      where: { orderId, status: "paid" },
      order: { createdAt: "DESC" },
    });
    const won = await this.store.review(
      order,
      ["refunded"],
      "refund",
      `the bank returned the refund on statement line ${line.lineRef} (${line.returnCode ?? "credit"}); refund_bank again`,
      run.actor,
      { attempts: 0, completedAt: null },
      {
        manager: m,
        details: {
          bankReturn: {
            statementLineId: line.id,
            amount: formatAmount(line.amount),
            code: line.returnCode,
            at: line.bookingDate,
          },
        },
        within: (mm, fresh) =>
          this.postOrder(mm, fresh, "refund.returned_bank", line.id, line.amount),
      },
    );
    if (!won)
      throw abort(`order ${order.id} changed while the statement was applied; propose again`);
    if (item)
      await items.update(
        { batchId: item.batchId, orderId },
        { status: "returned", returnedLineId: line.id },
      );
    if (order.bankAccountId)
      await this.accounts.block(
        m,
        order.bankAccountId,
        `bank return ${line.returnCode ?? "credit"} on ${line.lineRef}`,
      );
  }

  /** A payout debit to another IBAN (X3): the order → needs_review(payout); the red check halts payouts. */
  private async mismatchReview(
    m: EntityManager,
    orderId: string,
    line: RampBankLineEntity,
    run: LedgerRun,
  ): Promise<void> {
    const order = await this.store.lockForUpdate(m, orderId);
    if (!order || order.status !== "payout_sent") return;
    const won = await this.store.review(
      order,
      ["payout_sent"],
      "payout",
      `statement line ${line.lineRef}: the payout debit went to another account (iban_mismatch)`,
      run.actor,
      {},
      { manager: m },
    );
    if (!won)
      throw abort(`order ${order.id} changed while the statement was applied; propose again`);
  }

  private async flagged(
    m: EntityManager,
    line: RampBankLineEntity,
    flags: BankLineFlag[],
    why: string,
    run: LedgerRun,
  ): Promise<void> {
    await this.audit.record(
      {
        actorType: run.actor.type,
        actorUserId: run.actor.userId ?? null,
        actorSessionId: run.actor.sessionId ?? null,
        action: "ramp.bank.flagged",
        subjectType: "ramp_bank_line",
        subjectId: line.id,
        metadata: {
          flags,
          why,
          lineRef: line.lineRef,
          statementId: line.statementId,
          approvalId: run.approvalId,
        },
        ip: run.actor.ip ?? null,
      },
      m,
    );
    if (flags.some((f) => f !== "reference_credit")) {
      this.logger.error(`statement line ${line.lineRef}: ${flags.join(", ")} — ${why}`);
      this.sentry.captureMessage(`ramp bank: ${flags.join(", ")} on a statement line`, "error", {
        component: "ramp-bank",
        page: "true",
      });
    }
  }

  /**
   * C3: a confirmed debit no rule explains stays unbooked — the reserve takes it off A until it is
   * classified, and it is audited; above RAMP_BANK_FEE_MAX (a fee's size) it is also reported.
   */
  private async unbookedDebit(
    m: EntityManager,
    line: RampBankLineEntity,
    why: string,
    run: LedgerRun,
  ): Promise<void> {
    await this.audit.record(
      {
        actorType: run.actor.type,
        actorUserId: run.actor.userId ?? null,
        actorSessionId: run.actor.sessionId ?? null,
        action: "ramp.bank.unbooked_debit",
        subjectType: "ramp_bank_line",
        subjectId: line.id,
        metadata: {
          why,
          amount: formatAmount(line.amount),
          lineRef: line.lineRef,
          statementId: line.statementId,
          approvalId: run.approvalId,
        },
        ip: run.actor.ip ?? null,
      },
      m,
    );
    const feeMax = this.config.rampBank.feeMax;
    if (feeMax === null || -line.amount > feeMax) {
      this.logger.warn(`statement line ${line.lineRef}: an unbooked debit — ${why}`);
      this.sentry.captureMessage(
        "ramp bank: an unbooked debit on a confirmed statement",
        "warning",
        {
          component: "ramp-bank",
        },
      );
    }
  }

  /**
   * `psp.settlement` (Dr safeguard / Cr PC) and the fee true-up: the residual PC would keep is
   * booked to psp_fees when it is within the fees accrued since the previous settlement (SPEC §5).
   */
  private async pspSettlement(
    m: EntityManager,
    line: RampBankLineEntity,
    run: LedgerRun,
  ): Promise<void> {
    const X = line.amount;
    const pc = (await this.journal.balances(m)).provider_clearing ?? 0n;
    const [row] = await m.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM to_ramp_journal
        WHERE account = 'psp_fees' AND kind = 'psp.fee_accrued'
          AND id > COALESCE((SELECT MAX(id) FROM to_ramp_journal WHERE kind = 'psp.settlement'), 0)`,
    );
    await this.postLine(m, line, run, "psp.settlement", [
      ["safeguard_bank", X],
      ["provider_clearing", -X],
    ]);
    const residual = pspResidual(pc, X, parseAmount(row?.total ?? "0"));
    if (residual !== null)
      await this.postLine(m, line, run, "psp.fee", [
        ["psp_fees", residual],
        ["provider_clearing", -residual],
      ]);
  }

  /** A line-scoped posting (once per line and kind; the unique index is the backstop). */
  private async postLine(
    m: EntityManager,
    line: RampBankLineEntity,
    run: LedgerRun,
    kind: string,
    lines: [RampAccount, bigint][],
  ): Promise<void> {
    if (run.mode !== "apply") return;
    await this.journal.postEntry(m, {
      kind,
      currency: line.currency,
      lines,
      statementLineId: line.id,
    });
  }

  /** An order-scoped bank kind booked ON its statement line (SPEC §5; `bank_statement_matches_journal` reads the link). */
  private async postOrder(
    m: EntityManager,
    order: RampOrderEntity,
    kind: RampOrderKind,
    lineId: string,
    extra?: bigint,
  ): Promise<void> {
    await this.journal.postEntry(m, {
      kind,
      currency: order.fiatCurrency,
      lines: postingFor(kind, order, extra),
      orderId: order.id,
      statementLineId: lineId,
      userId: order.userId,
    });
  }

  /** Every item resolved (none `included`) → the batch is settled. */
  private async settleBatchIfDone(m: EntityManager, batchId: string): Promise<void> {
    const left = await m
      .getRepository(RampPayoutBatchItemEntity)
      .count({ where: { batchId, status: "included" } });
    if (left === 0)
      await m
        .getRepository(RampPayoutBatchEntity)
        .update({ id: batchId, status: "submitted" }, { status: "settled", settledAt: new Date() });
  }
}

function outcome(
  run: LedgerRun,
  kind: BankMatchKind,
  orderId: string | null,
  batchId: string | null,
): LineOutcome {
  return {
    status: run.mode === "apply" ? "matched" : "proposed",
    matchKind: kind,
    matchedOrderId: orderId,
    matchedBatchId: batchId,
    flags: [],
    why: null,
  };
}
