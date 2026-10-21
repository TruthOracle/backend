import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, In, Repository } from "typeorm";

import { Config } from "../config";
import { RampBankAccountEntity } from "../entities/ramp-bank-account.entity";
import { RampBankLineEntity } from "../entities/ramp-bank-line.entity";
import { RampOrderEntity } from "../entities/ramp-order.entity";
import { RampPayoutBatchItemEntity } from "../entities/ramp-payout-batch-item.entity";
import { RampPayoutBatchEntity } from "../entities/ramp-payout-batch.entity";
import type {
  Actor,
  ApiPayoutBatch,
  ApiPayoutBatchDraft,
  ApiPayoutBatchItem,
  PayoutBatchStatus,
} from "../types";
import { minskDate } from "../util/by-calendar";
import { toCsv } from "../util/csv";
import { ApiError } from "../util/errors";
import { maskIban } from "../util/iban";
import { formatAmount, formatAmountWithDecimals } from "../util/money";
import { displayPayoutReference } from "../util/payout-reference";
import { RotatingScan } from "../util/rotating-scan";
import { MINUTE_MS, toIso } from "../util/time";
import { linkedRefusal } from "./admin-approval.logic";
import { AdminApprovalService, type ApprovalOutcome } from "./admin-approval.service";
import type { AdminActor } from "./admin.service";
import { AuditService } from "./audit.service";
import {
  BENEFICIARY_NAME_RE,
  nameInForm,
  RampBankAccountsService,
} from "./ramp-bank-accounts.service";
import { bankAmountOf } from "./ramp-bank-ledger.service";
import { RampBankSealing } from "./ramp-bank-sealing.service";
import { lineFromSealed } from "./ramp-bank-statement.parse";
import { RampBankStatementsService } from "./ramp-bank-statements.service";
import { RampGatesService } from "./ramp-gates.service";
import { KycIdentityPort } from "./kyc-identity.port";
import { RampOrderStore } from "./ramp-order-store.service";
import { RampReconciliationService } from "./ramp-reconciliation.service";
import { RampReleaseGuard } from "./ramp-release-guard.service";
import { RateLimitService } from "./rate-limit.service";
import { RedisService } from "./redis.service";
import { SentryService } from "./sentry.service";
import { UserService } from "./user.service";

/** The bank file's columns (SPEC §10.3). A per-bank adapter (pain.001 / 1C) replaces it once the bank is chosen. */
export const BANK_FILE_COLUMNS = [
  "batch_id",
  "document_no",
  "reference",
  "amount",
  "currency",
  "beneficiary_name",
  "beneficiary_iban",
  "beneficiary_bic",
  "beneficiary_bank",
  "purpose_code",
  "purpose_text",
  "payer_iban",
  "payer_name",
  "payer_unp",
] as const;

const BATCH_LOCK_TTL_MS = 5 * MINUTE_MS;
const SYSTEM = { type: "system" as const };
/** Holds the release guard sets that lift by themselves when the batch is voided (re-asked at the next batch). */
const SELF_LIFTING_HOLDS = new Set(["frozen", "compliance", "payout_gate"]);
/** C5: a hold that does NOT lift by itself (a chargeback, a suspended account) sends the order to review when it leaves its batch. */
export function isSelfLiftingHold(reason: string | null | undefined): boolean {
  return SELF_LIFTING_HOLDS.has(reason ?? "");
}
/** Unexplained lines a proof reads at most (more: classify them first — never a partial proof). */
const PROOF_MAX_LINES = 1000;
/** C25: a cash-out AML decided to give back (the card path's words); its value exit is `reverse`. */
const AML_RETURN_REASON = "AML decided not to pay this cash-out out";
/** C25: the hold a returned cash-out in an approved or exported batch carries (never lifts by itself). */
const AML_RETURN_HOLD = "aml_return";

function batchState(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(409, "batch_state", message, details);
}

/**
 * Operator payout batches (SPEC §10.3, #4, X4, X16). A draft (`ops`) takes the oldest
 * `payout_queued` orders of BOTH directions not in a batch — skipping held ones (a freeze, a
 * compliance hold, a chargeback), and sending to review the ones that cannot be paid (account
 * removed or blocked, a beneficiary name no bank file accepts). Approval is four-eyes after a
 * pre-batch reconciliation and the payout gate; the FIRST export needs the gate again; a
 * re-export must hash the same; nothing exports after `submitted`. `submitted` moves the orders to
 * `payout_sent` (also under a payouts halt: it records a fact). A draft or approved batch may be
 * cancelled by one operator; an exported one only voided, four-eyes, with statement proof or the
 * bank's rejection reference.
 */
@Injectable()
export class RampBankBatchesService implements OnModuleInit {
  private readonly logger = new Logger(RampBankBatchesService.name);
  /** C25: where this instance's previous AML-return sweep stopped (`amlReturns`). */
  private readonly amlSweep = new RotatingScan();

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(RampPayoutBatchEntity) readonly batches: Repository<RampPayoutBatchEntity>,
    @InjectRepository(RampPayoutBatchItemEntity)
    readonly items: Repository<RampPayoutBatchItemEntity>,
    private readonly store: RampOrderStore,
    private readonly accounts: RampBankAccountsService,
    private readonly identity: KycIdentityPort,
    private readonly release: RampReleaseGuard,
    private readonly gates: RampGatesService,
    private readonly reconciliation: RampReconciliationService,
    private readonly approvals: AdminApprovalService,
    private readonly statements: RampBankStatementsService,
    private readonly sealing: RampBankSealing,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
    private readonly users: UserService,
    private readonly sentry: SentryService,
  ) {}

  onModuleInit(): void {
    this.approvals.register<Record<string, never>, Record<string, unknown>, unknown>({
      action: "ramp.batch.approve",
      subjectType: "ramp_payout_batch",
      requestRoles: ["ops"],
      snapshot: (id) => this.snapshot(id),
      validate: (_p, _s, id) => this.validateApprove(id),
      describe: (_p, s) =>
        `approve payout batch ${String(s.id)}: ${String(s.itemCount)} item(s), ${String(s.totalAmount)}`,
      execute: (_p, _s, ctx) =>
        this.executeApprove(ctx.subjectId, ctx.actor, ctx.requester, ctx.approvalId),
    });
    this.approvals.register<{ bankRejectionRef?: string }, Record<string, unknown>, unknown>({
      action: "ramp.batch.void",
      subjectType: "ramp_payout_batch",
      requestRoles: ["ops"],
      params: (raw) => {
        const ref = typeof raw.bankRejectionRef === "string" ? raw.bankRejectionRef.trim() : "";
        if (ref && !/^[\x20-\x7e]{1,64}$/.test(ref))
          throw new ApiError(
            400,
            "validation_failed",
            "bankRejectionRef must be 1–64 printable characters",
          );
        return ref ? { bankRejectionRef: ref } : {};
      },
      snapshot: (id) => this.snapshot(id),
      validate: (p, _s, id) => this.validateVoid(id, p.bankRejectionRef ?? null),
      describe: (p, s) =>
        `void exported batch ${String(s.id)} (${String(s.itemCount)} item(s)) — ${p.bankRejectionRef ? `bank rejection ${p.bankRejectionRef}` : "statements show no debit"}`,
      execute: (p, _s, ctx) =>
        this.executeVoid(
          ctx.subjectId,
          p.bankRejectionRef ?? null,
          ctx.actor,
          ctx.requester,
          ctx.approvalId,
        ),
    });
  }

  // ───────────────────────────────────────────── draft ──────────────────────────────────────

  /** `POST /admin/ramp/payout-batches` (`ops`): a draft of the oldest payable `payout_queued` orders. */
  async create(reason: string, actor: AdminActor): Promise<ApiPayoutBatchDraft> {
    if (!this.accounts.configured)
      throw new ApiError(409, "ramp_rail_unavailable", "bank payouts are not configured", {
        rail: "bank",
      });
    const lock = await this.redis.acquireLock("lock:ramp-bank-batches", BATCH_LOCK_TTL_MS);
    if (!lock.acquired) throw batchState("another batch is being built; try again");
    try {
      const max = this.config.rampBank.batchMax;
      const skipped: ApiPayoutBatchDraft["skipped"] = [];
      const chosen: { order: RampOrderEntity; account: RampBankAccountEntity }[] = [];
      // R2a-7: oldest first, page after page — the orders a draft skips (held, linked, an account
      // not yet usable) stay queued and never hide the payable ones behind them.
      let after: { at: Date; id: string } | null = null;
      for (;;) {
        // Keyed on the millisecond a JS Date holds (the column keeps microseconds).
        const at = "date_trunc('milliseconds', o.status_changed_at)";
        const page = this.store.orders
          .createQueryBuilder("o")
          .where("o.status = 'payout_queued' AND o.payout_batch_id IS NULL");
        if (after) page.andWhere(`(${at}, o.id) > (:at, :id)`, after);
        const queued = await page
          .orderBy(at, "ASC")
          .addOrderBy("o.id", "ASC")
          .take(max * 2)
          .getMany();
        for (const order of queued) {
          if (chosen.length >= max) break;
          const why = await this.unbatchable(order, actor);
          if (why) skipped.push({ orderId: order.id, reason: why });
          else chosen.push({ order, account: (await this.accounts.forOrder(order))! });
        }
        if (chosen.length >= max || queued.length < max * 2) break;
        const last = queued[queued.length - 1];
        after = { at: last.statusChangedAt, id: last.id };
      }
      if (!chosen.length) throw batchState("no payout is ready to batch", { skipped });
      const batch = await this.dataSource.transaction(async (m) => {
        const b = await m.getRepository(RampPayoutBatchEntity).save(
          m.getRepository(RampPayoutBatchEntity).create({
            status: "draft",
            currency: this.config.ramp.fiatCurrency,
            itemCount: chosen.length,
            totalAmount: chosen.reduce((s, c) => s + bankAmountOf(c.order), 0n),
            createdByUserId: actor.userId,
            createdByPerson: actor.personId,
            details: { reason },
          }),
        );
        for (const { order, account } of chosen) {
          const [{ n }] = await m.query<{ n: string }[]>(
            `SELECT nextval('to_ramp_payout_document_no_seq')::text AS n`,
          );
          await m.getRepository(RampPayoutBatchItemEntity).insert({
            batchId: b.id,
            orderId: order.id,
            kind: order.direction === "offramp" ? "payout" : "refund",
            documentNo: n,
            amount: bankAmountOf(order),
            userId: order.userId,
            bankAccountId: account.id,
            ibanHash: account.ibanHash,
            ibanHashKid: account.ibanHashKid,
            status: "included",
          });
          const won = await this.store.bump(
            order,
            { payoutBatchId: b.id },
            {
              actor,
              manager: m,
              expect: { payoutBatchId: null },
              detail: `in payout batch ${b.id}`,
            },
          );
          if (!won)
            throw batchState(`order ${order.id} changed while the batch was built; try again`);
        }
        await this.auditBatch(m, "ramp.batch.created", b, actor, {
          reason,
          skipped: skipped.length,
        });
        return b;
      });
      return { ...(await this.view(batch.id)), skipped };
    } finally {
      await lock.release();
    }
  }

  /**
   * Why an order cannot go into a batch now (null = it can). A hold that lifts by itself skips it
   * (it stays queued); a problem only an operator can solve sends it to needs_review(payout).
   */
  private async unbatchable(order: RampOrderEntity, actor: AdminActor): Promise<string | null> {
    const hold = order.details?.hold as { reason?: string } | undefined;
    if (hold) return `held: ${hold.reason ?? "?"}`;
    const linked = linkedRefusal(
      order.userId,
      [{ userId: actor.userId, party: actor.operatorParty, person: actor.personId }],
      this.config.rampControls.operatorAccounts,
    );
    if (linked) return "the order belongs to an account linked to you";
    // C5 (M2, E-D3): a suspended account (a chargeback, an operator) is paid nothing; review.
    const user = await this.users.findById(order.userId);
    if (user?.status !== "active") {
      const why = "the account is not active";
      await this.store.review(order, ["payout_queued"], "compliance", why, actor);
      return `needs review: ${why}`;
    }
    // C25: AML decided this cash-out's money goes back — a hold that never lifts by itself: review,
    // whose value exit is `reverse` (re-mint and credit back).
    try {
      if (await this.amlReturned(order)) {
        await this.store.review(
          order,
          ["payout_queued"],
          "compliance",
          AML_RETURN_REASON,
          actor,
          {},
          {
            details: { complianceReturn: { at: new Date().toISOString() } },
          },
        );
        return `needs review: ${AML_RETURN_REASON}`;
      }
    } catch (err) {
      return `compliance could not be asked: ${(err as Error).message}`;
    }
    try {
      const h = await this.release.hold(
        order,
        order.direction === "offramp" ? "offramp.payout" : null,
      );
      if (h) return `held: ${h.reason}`;
    } catch (err) {
      return `compliance could not be asked: ${(err as Error).message}`;
    }
    const account = await this.accounts.forOrder(order);
    const toReview = async (why: string): Promise<string> => {
      await this.store.review(order, ["payout_queued"], "payout", why, actor);
      return `needs review: ${why}`;
    };
    if (!account || account.userId !== order.userId)
      return toReview("the payout's bank account is missing or not the user's");
    if (account.status === "removed" || account.status === "blocked")
      return toReview(`the bank account is ${account.status}`);
    if (account.status !== "active") return `the bank account is ${account.status}`;
    let name: string | null;
    try {
      name = nameInForm(await this.identity.get(order.userId), account.nameForm);
    } catch (err) {
      return `the verified identity could not be read: ${(err as Error).message}`;
    }
    if (!name || !BENEFICIARY_NAME_RE.test(name))
      return toReview("the verified name cannot go into a bank file (letters, spaces . ' - only)");
    return null;
  }

  // ───────────────────────────────────────────── approve (four-eyes) ────────────────────────

  /** `POST …/:id/approve {reason}` — the REQUEST of `ramp.batch.approve`. */
  requestApprove(id: string, reason: string, actor: AdminActor): Promise<ApprovalOutcome> {
    return this.approvals.request({ action: "ramp.batch.approve", subjectId: id, reason }, actor);
  }

  private async snapshot(id: string): Promise<Record<string, unknown>> {
    const b = await this.batches.findOne({ where: { id } });
    if (!b) throw new ApiError(404, "not_found", "payout batch not found");
    const items = await this.items.find({ where: { batchId: id }, order: { documentNo: "ASC" } });
    const itemsHash = createHash("sha256")
      .update(
        items
          .map((i) => `${i.orderId}:${i.documentNo}:${formatAmount(i.amount)}:${i.status}`)
          .join("\n"),
      )
      .digest("hex");
    return {
      id: b.id,
      status: b.status,
      itemCount: b.itemCount,
      totalAmount: formatAmount(b.totalAmount),
      fileSha256: b.fileSha256,
      itemsHash,
    };
  }

  /**
   * Fresh, at request and at execution: still a draft, every order still queued in it, nothing
   * held, the account still active; then a pre-batch reconciliation and the payout gate (§6.4).
   */
  private async validateApprove(id: string): Promise<void> {
    const b = await this.batches.findOne({ where: { id } });
    if (!b || b.status !== "draft")
      throw batchState(`the batch is ${b?.status ?? "missing"}, not a draft`);
    await this.requireItemsQueued(id, "approve");
    await this.reconciliation.runOnDemand("pre_batch");
    const gate = await this.gates.payoutGate();
    if (!gate.ok)
      throw new ApiError(409, "payout_gate", `payout_gate:${gate.reason}: ${gate.detail}`, {
        reason: gate.reason,
      });
  }

  private async executeApprove(
    id: string,
    approver: AdminActor,
    requester: { userId: string; party: string; person: string },
    approvalId: string,
  ): Promise<{ batch: ApiPayoutBatch }> {
    const b = await this.batches.findOneByOrFail({ id });
    if (b.createdByPerson === approver.personId)
      throw new ApiError(403, "approval_same_person", "the batch's creator cannot approve it");
    await this.refuseLinked(id, approver, requester);
    const res = await this.batches.update(
      { id, status: "draft" },
      { status: "approved", approvalId },
    );
    if (!res.affected) throw batchState("the batch changed meanwhile");
    await this.auditBatch(this.dataSource.manager, "ramp.batch.approved", b, approver, {
      approvalId,
    });
    return { batch: this.toApi(await this.batches.findOneByOrFail({ id })) };
  }

  /** I8: neither deciding person may be linked to an account the batch pays. */
  private async refuseLinked(
    batchId: string,
    approver: AdminActor,
    requester: { userId: string; party: string; person: string },
  ): Promise<void> {
    const people = [
      { userId: approver.userId, party: approver.operatorParty, person: approver.personId },
      requester,
    ];
    for (const item of await this.items.find({ where: { batchId } })) {
      const r = linkedRefusal(item.userId, people, this.config.rampControls.operatorAccounts);
      if (r)
        throw new ApiError(r.status, r.code, `${r.message} (order ${item.orderId})`, r.details);
    }
  }

  /**
   * Every live item's order is still `payout_queued` in this batch and not held; for an approval
   * also its account still active. A hold found now is written on the order (it blocks the file).
   * C25: a cash-out AML decided to give back leaves a draft (into review: approve again without
   * it); in an approved or exported batch it is held (`aml_return`) and paged, never taken out.
   */
  private async requireItemsQueued(
    batchId: string,
    step: "approve" | "export",
  ): Promise<RampOrderEntity[]> {
    const items = await this.items.find({
      where: { batchId, status: "included" },
      order: { documentNo: "ASC" },
    });
    const orders: RampOrderEntity[] = [];
    const held: { orderId: string; reason: string }[] = [];
    const left: string[] = [];
    for (const item of items) {
      const order = await this.store.find(item.orderId);
      if (!order || order.status !== "payout_queued" || order.payoutBatchId !== batchId)
        throw batchState(
          `order ${item.orderId} is no longer queued in this batch (${order?.status ?? "missing"}); cancel or void it`,
        );
      const existing = order.details?.hold as { reason?: string } | undefined;
      let reason = existing?.reason ?? null;
      // C25: the return outlives a hold that lifts by itself (a freeze, a compliance review).
      if ((!reason || isSelfLiftingHold(reason)) && (await this.amlReturned(order))) {
        if (step === "approve") {
          await this.leaveDraftReturned(order, batchId);
          left.push(order.id);
          continue;
        }
        await this.holdReturned(order, reason);
        reason = AML_RETURN_HOLD;
      }
      if (!reason) {
        // C5: a suspended account holds its items too — a hold that never lifts by itself.
        const user = await this.users.findById(order.userId);
        const h =
          user?.status !== "active"
            ? { reason: "account_not_active", detail: "the account is not active" }
            : await this.release.hold(
                order,
                order.direction === "offramp" ? "offramp.payout" : null,
              );
        if (h) {
          reason = h.reason;
          await this.store.bump(
            order,
            {},
            {
              actor: SYSTEM,
              details: {
                hold: { reason: h.reason, detail: h.detail, at: new Date().toISOString() },
              },
            },
          );
        }
      }
      if (reason) held.push({ orderId: order.id, reason });
      if (step === "approve") {
        const account = await this.accounts.forOrder(order);
        if (account?.status !== "active")
          throw batchState(
            `order ${order.id}: the bank account is ${account?.status ?? "missing"}; cancel the batch`,
          );
      }
      orders.push(order);
    }
    if (left.length)
      throw batchState(
        `${left.length} cash-out(s) left the draft: AML decided not to pay them out (${left.join(", ")}); request the approval again`,
        { left },
      );
    if (held.length)
      throw new ApiError(
        409,
        "batch_held",
        "an order in the batch is held; void or cancel the batch",
        { held },
      );
    return orders;
  }

  // ───────────────────────────────────────────── AML returns (C25) ───────────────────────────

  /** C25: did AML decide to give this cash-out's money back? (An on-ramp's bank refund IS the way back.) */
  private async amlReturned(order: RampOrderEntity): Promise<boolean> {
    return order.direction === "offramp" && (await this.release.returnRequested(order));
  }

  /**
   * C25 (RampBankProcessor): bank cash-outs whose alert AML returned — a hold that never lifts by
   * itself. Queued → needs_review(compliance), whose value exit is `reverse` (re-mint and credit
   * back); in a draft batch → out of it, same review; in an approved or exported batch → held
   * (`aml_return`: the file and the submission refuse) and paged, never taken out; at the bank
   * (payout_sent) → flagged (`details.amlReturn`) and paged. Returns how many it acted on. Orders
   * already stopped (held for good, flagged) are not read again; the rest are read
   * RAMP_BANK_BATCH_MAX a pass in a round (`RotatingScan`, as the C17 scan queues), so a backlog
   * that AML did not return never hides a newer one it did.
   */
  async amlReturns(): Promise<number> {
    const ids = await this.amlSweep.next(
      "aml_return",
      () =>
        this.store.orders
          .createQueryBuilder("o")
          .select("o.id", "id")
          .where("o.direction = 'offramp' AND o.payout_rail = 'bank'")
          .andWhere(
            `((o.status = 'payout_sent' AND COALESCE(o.details -> 'amlReturn', 'null'::jsonb) = 'null'::jsonb)
              OR (o.status = 'payout_queued' AND (COALESCE(o.details -> 'hold', 'null'::jsonb) = 'null'::jsonb
                OR o.details -> 'hold' ->> 'reason' IN (:...lifting))))`,
            { lifting: [...SELF_LIFTING_HOLDS] },
          ),
      this.config.rampBank.batchMax,
    );
    const rows = ids.length ? await this.store.orders.findBy({ id: In(ids) }) : [];
    let acted = 0;
    for (const order of rows) {
      try {
        if (await this.returnedOne(order)) acted += 1;
      } catch (err) {
        this.logger.warn(`order ${order.id}: AML return not applied: ${(err as Error).message}`);
      }
    }
    return acted;
  }

  private async returnedOne(order: RampOrderEntity): Promise<boolean> {
    if (order.status === "payout_sent") {
      if (order.details?.amlReturn || !(await this.amlReturned(order))) return false;
      const won = await this.store.bump(
        order,
        {},
        {
          actor: SYSTEM,
          detail: `${AML_RETURN_REASON}: the bank already has it`,
          absent: ["amlReturn"],
          details: {
            amlReturn: {
              at: new Date().toISOString(),
              status: order.status,
              batchId: order.payoutBatchId,
            },
          },
        },
      );
      if (won)
        this.sentry.captureMessage("ramp cash-out AML returned is already at the bank", "error", {
          orderId: order.id,
          batchId: order.payoutBatchId ?? "none",
        });
      return won;
    }
    const hold = order.details?.hold as { reason?: string } | null | undefined;
    // A hold that never lifts by itself (a chargeback, an earlier AML return) already stops it.
    if (hold && !isSelfLiftingHold(hold.reason)) return false;
    if (!(await this.amlReturned(order))) return false;
    const batch = order.payoutBatchId
      ? await this.batches.findOne({ where: { id: order.payoutBatchId } })
      : null;
    if (batch?.status === "draft") {
      await this.leaveDraftReturned(order, batch.id);
      return true;
    }
    if (batch) {
      await this.holdReturned(order, hold?.reason ?? null);
      return true;
    }
    return this.store.review(
      order,
      ["payout_queued"],
      "compliance",
      AML_RETURN_REASON,
      SYSTEM,
      {},
      {
        expect: { payoutBatchId: null },
        details: {
          complianceReturn: { at: new Date().toISOString() },
          ...(hold ? { hold: null, holdEndedReason: hold.reason ?? null } : {}),
        },
      },
    );
  }

  /** C25: a returned cash-out leaves its DRAFT batch into needs_review(compliance), in one transaction. */
  private async leaveDraftReturned(order: RampOrderEntity, batchId: string): Promise<void> {
    const hold = order.details?.hold as { reason?: string } | null | undefined;
    const why = `${AML_RETURN_REASON}; it left draft payout batch ${batchId}`;
    await this.dataSource.transaction(async (m) => {
      if (!(await this.removeFromDraft(m, batchId, order.id, SYSTEM, AML_RETURN_REASON)))
        throw batchState(`payout batch ${batchId} is no longer a draft`);
      const won = await this.store.review(
        order,
        ["payout_queued"],
        "compliance",
        why,
        SYSTEM,
        { payoutBatchId: null },
        {
          manager: m,
          expect: { payoutBatchId: batchId },
          details: {
            leftBatchId: batchId,
            complianceReturn: { at: new Date().toISOString() },
            ...(hold ? { hold: null, holdEndedReason: hold.reason ?? null } : {}),
          },
        },
      );
      if (!won) throw batchState(`order ${order.id} changed meanwhile; try again`);
    });
  }

  /** C25: a returned cash-out in an approved or exported batch is held (it blocks the file) and paged once. */
  private async holdReturned(order: RampOrderEntity, replaced: string | null): Promise<void> {
    const won = await this.store.bump(
      order,
      {},
      {
        actor: SYSTEM,
        detail: `${AML_RETURN_REASON}: held in payout batch ${order.payoutBatchId ?? "?"}`,
        details: {
          hold: {
            reason: AML_RETURN_HOLD,
            detail: AML_RETURN_REASON,
            at: new Date().toISOString(),
            ...(replaced ? { replaced } : {}),
          },
        },
      },
    );
    if (won)
      this.sentry.captureMessage("ramp cash-out AML returned sits in a payout batch", "error", {
        orderId: order.id,
        batchId: order.payoutBatchId ?? "none",
      });
  }

  /**
   * Take `orderId`'s live item out of DRAFT batch `batchId` inside `m` (the order's own move is the
   * caller's, in the same transaction): the item voided, the draft's count and total reduced, a
   * draft left empty cancelled; audited. False when the batch is no longer a draft (nothing written).
   */
  async removeFromDraft(
    m: EntityManager,
    batchId: string,
    orderId: string,
    actor: Actor,
    why: string,
  ): Promise<boolean> {
    const batches = m.getRepository(RampPayoutBatchEntity);
    const b = await batches.findOne({
      where: { id: batchId },
      lock: { mode: "pessimistic_write" },
    });
    if (b?.status !== "draft") return false;
    const items = m.getRepository(RampPayoutBatchItemEntity);
    const item = await items.findOne({ where: { batchId, orderId, status: "included" } });
    if (!item) return true;
    await items.update({ batchId, orderId, status: "included" }, { status: "voided" });
    const itemCount = b.itemCount - 1;
    const totalAmount = itemCount > 0 ? b.totalAmount - item.amount : 0n;
    await batches.update(
      { id: batchId, status: "draft" },
      itemCount > 0
        ? { itemCount, totalAmount }
        : {
            itemCount,
            totalAmount,
            status: "cancelled",
            details: { ...b.details, cancelReason: `its last item left the draft: ${why}` },
          },
    );
    await this.audit.record(
      {
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        actorSessionId: actor.sessionId ?? null,
        action: "ramp.batch.item_removed",
        subjectType: "ramp_payout_batch",
        subjectId: batchId,
        metadata: {
          orderId,
          documentNo: item.documentNo,
          amount: formatAmount(item.amount),
          why,
          itemCount,
          totalAmount: formatAmount(totalAmount),
          cancelled: itemCount === 0,
        },
        ip: actor.ip ?? null,
      },
      m,
    );
    return true;
  }

  // ───────────────────────────────────────────── export / submitted / cancel ────────────────

  /**
   * `POST …/:id/export` (`export`): the bank file of an approved or exported batch. The FIRST export
   * needs the payout gate; a re-export must hash the same (a changed name or account shows here);
   * a held order blocks it. Every export is audited (operator, sha256, items).
   */
  async export(
    id: string,
    actor: AdminActor,
  ): Promise<{ filename: string; csv: string; sha256: string }> {
    await this.rateLimit.enforce("admin_export", { userId: actor.userId });
    const b = await this.batches.findOne({ where: { id } });
    if (!b) throw new ApiError(404, "not_found", "payout batch not found");
    if (b.status !== "approved" && b.status !== "exported")
      throw batchState(
        b.status === "draft"
          ? "approve the batch first"
          : `a ${b.status} batch is never exported again`,
      );
    const orders = await this.requireItemsQueued(id, "export");
    const first = b.status === "approved";
    if (first) {
      const gate = await this.gates.payoutGate();
      if (!gate.ok)
        throw new ApiError(409, "payout_gate", `payout_gate:${gate.reason}: ${gate.detail}`, {
          reason: gate.reason,
        });
    }
    const csv = await this.buildFile(b, orders);
    const sha256 = createHash("sha256").update(csv, "utf8").digest("hex");
    if (!first && sha256 !== b.fileSha256)
      throw new ApiError(
        409,
        "batch_export_mismatch",
        "the file would differ from the one exported; void the batch",
        {
          exported: b.fileSha256,
        },
      );
    const res = first
      ? await this.batches.update(
          { id, status: "approved" },
          {
            status: "exported",
            fileFormat: "csv",
            fileSha256: sha256,
            exportedAt: new Date(),
            exportedByUserId: actor.userId,
            exportCount: 1,
          },
        )
      : await this.batches.increment({ id, status: "exported" }, "exportCount", 1);
    if (!res.affected) throw batchState("the batch changed meanwhile");
    await this.auditBatch(this.dataSource.manager, "ramp.batch.exported", b, actor, {
      sha256,
      items: orders.length,
      first,
    });
    return { filename: `ramp-payout-batch-${id}.csv`, csv, sha256 };
  }

  /** The bank-mode CSV (no formula escaping; names checked against the bank's alphabet first). */
  private async buildFile(b: RampPayoutBatchEntity, orders: RampOrderEntity[]): Promise<string> {
    const items = await this.items.find({ where: { batchId: b.id, status: "included" } });
    items.sort((x, y) => (BigInt(x.documentNo) < BigInt(y.documentNo) ? -1 : 1));
    const bank = this.config.rampBank;
    const rows = [];
    for (const item of items) {
      const order = orders.find((o) => o.id === item.orderId)!;
      const account = await this.accounts.forOrder(order);
      if (!account) throw batchState(`order ${order.id} has no bank account`);
      const name = nameInForm(await this.identity.get(order.userId), account.nameForm);
      if (!name || !BENEFICIARY_NAME_RE.test(name))
        throw batchState(
          `order ${order.id}: the beneficiary name cannot go into a bank file; cancel the batch`,
        );
      const ref = displayPayoutReference(order.payoutReference);
      rows.push([
        b.id,
        item.documentNo,
        ref,
        formatAmountWithDecimals(item.amount, this.config.ramp.fiatDecimals),
        b.currency,
        name,
        this.accounts.ibanFor(account, order.userId),
        account.bic,
        account.bankName,
        bank.payoutPurposeCode,
        (item.kind === "refund" ? bank.refundPurposeText : bank.payoutPurposeText).replace(
          "{ref}",
          ref,
        ),
        bank.accountIban,
        bank.holderName,
        bank.holderUnp,
      ]);
    }
    return toCsv(rows, "bank", BANK_FILE_COLUMNS);
  }

  /**
   * `POST …/:id/submitted {bankReference, reason?}` (`ops`; also under a payouts halt): the orders
   * → payout_sent; the optional reason is kept on the batch and in its audit (F3). R2a-1: it
   * records a fact — the bank accepted the exported file — so a hold found now (a freeze, a
   * suspension, a chargeback, an AML return) never refuses it: the money is the bank's to move,
   * and a refusal would leave the batch exported and its debits read as duplicates. Each held
   * order is flagged (`details.heldAtBank`; an AML return also `amlReturn`) and paged instead.
   */
  async submitted(
    id: string,
    bankReference: string,
    actor: AdminActor,
    reason: string | null = null,
  ): Promise<{ batch: ApiPayoutBatch }> {
    const ref = bankReference.trim();
    const why = reason?.trim() || null;
    if (!/^[\x20-\x7e]{1,64}$/.test(ref))
      throw new ApiError(
        400,
        "validation_failed",
        "bankReference must be 1–64 printable characters",
      );
    const b = await this.batches.findOne({ where: { id } });
    if (!b) throw new ApiError(404, "not_found", "payout batch not found");
    if (b.status !== "exported")
      throw batchState(`only an exported batch is submitted (it is ${b.status})`);
    const orders = await this.requireItemsMembers(id);
    const held = new Map<string, { reason: string; detail: string | null }>();
    for (const order of orders) {
      const h = await this.holdAtBank(order);
      if (h) held.set(order.id, h);
    }
    const at = new Date().toISOString();
    await this.dataSource.transaction(async (m) => {
      for (const order of orders) {
        const h = held.get(order.id);
        const won = await this.store.transition(
          order,
          ["payout_queued"],
          "payout_sent",
          {},
          {
            actor,
            manager: m,
            expect: { payoutBatchId: id },
            detail: `payout batch ${id} submitted to the bank (${ref})${h ? `; held (${h.reason}) but already at the bank` : ""}`,
            ...(h
              ? {
                  details: {
                    heldAtBank: { reason: h.reason, detail: h.detail, at, batchId: id },
                    ...(h.reason === AML_RETURN_HOLD
                      ? { amlReturn: { at, status: "payout_sent", batchId: id } }
                      : {}),
                  },
                }
              : {}),
          },
        );
        if (!won) throw batchState(`order ${order.id} changed meanwhile; try again`);
      }
      const res = await m.getRepository(RampPayoutBatchEntity).update(
        { id, status: "exported" },
        {
          status: "submitted",
          submittedAt: new Date(),
          submittedByUserId: actor.userId,
          bankReference: ref,
          ...(why ? { details: { ...b.details, submitReason: why } } : {}),
        },
      );
      if (!res.affected) throw batchState("the batch changed meanwhile");
      await this.auditBatch(m, "ramp.batch.submitted", b, actor, {
        bankReference: ref,
        items: orders.length,
        ...(why ? { reason: why } : {}),
        ...(held.size
          ? { held: [...held].map(([orderId, h]) => ({ orderId, reason: h.reason })) }
          : {}),
      });
    });
    for (const [orderId, h] of held)
      this.sentry.captureMessage(
        h.reason === AML_RETURN_HOLD
          ? "ramp cash-out AML returned is already at the bank"
          : "ramp held payout is already at the bank",
        "error",
        { orderId, batchId: id, reason: h.reason },
      );
    return { batch: this.toApi(await this.batches.findOneByOrFail({ id })) };
  }

  /** R2a-1: every live item's order is still `payout_queued` in this batch (membership and status only). */
  private async requireItemsMembers(batchId: string): Promise<RampOrderEntity[]> {
    const items = await this.items.find({
      where: { batchId, status: "included" },
      order: { documentNo: "ASC" },
    });
    const orders: RampOrderEntity[] = [];
    for (const item of items) {
      const order = await this.store.find(item.orderId);
      if (!order || order.status !== "payout_queued" || order.payoutBatchId !== batchId)
        throw batchState(
          `order ${item.orderId} is no longer queued in this batch (${order?.status ?? "missing"}); cancel or void it`,
        );
      orders.push(order);
    }
    return orders;
  }

  /**
   * R2a-1: what would hold this order were it not at the bank (the checks of the file's steps): a
   * hold that never lifts by itself as written, anything else asked again now.
   */
  private async holdAtBank(
    order: RampOrderEntity,
  ): Promise<{ reason: string; detail: string | null } | null> {
    const existing = order.details?.hold as { reason?: string; detail?: string } | undefined;
    if (existing?.reason && !isSelfLiftingHold(existing.reason))
      return { reason: existing.reason, detail: existing.detail ?? null };
    if (await this.amlReturned(order))
      return { reason: AML_RETURN_HOLD, detail: AML_RETURN_REASON };
    const user = await this.users.findById(order.userId);
    if (user?.status !== "active")
      return { reason: "account_not_active", detail: "the account is not active" };
    const h = await this.release.hold(
      order,
      order.direction === "offramp" ? "offramp.payout" : null,
    );
    return h ? { reason: h.reason, detail: h.detail ?? null } : null;
  }

  /** `POST …/:id/cancel {reason}` (`ops`): a draft or approved batch only — its orders go back to the queue. */
  async cancel(id: string, reason: string, actor: AdminActor): Promise<{ batch: ApiPayoutBatch }> {
    const b = await this.batches.findOne({ where: { id } });
    if (!b) throw new ApiError(404, "not_found", "payout batch not found");
    if (b.status !== "draft" && b.status !== "approved")
      throw batchState(
        b.status === "exported"
          ? "an exported batch may be at the bank: void it (four-eyes) instead"
          : `a ${b.status} batch cannot be cancelled`,
      );
    await this.dataSource.transaction(async (m) => {
      const res = await m
        .getRepository(RampPayoutBatchEntity)
        .update(
          { id, status: b.status },
          { status: "cancelled", details: { ...b.details, cancelReason: reason } },
        );
      if (!res.affected) throw batchState("the batch changed meanwhile");
      await this.releaseOrders(m, id, actor, { cancelledBatchId: id });
      await this.auditBatch(m, "ramp.batch.cancelled", b, actor, { reason });
    });
    return { batch: this.toApi(await this.batches.findOneByOrFail({ id })) };
  }

  /** Items voided; every order of the batch leaves it (its self-lifting hold cleared — re-asked at the next batch). */
  private async releaseOrders(
    m: EntityManager,
    batchId: string,
    actor: AdminActor,
    details: Record<string, unknown>,
  ): Promise<void> {
    await m
      .getRepository(RampPayoutBatchItemEntity)
      .update({ batchId, status: "included" }, { status: "voided" });
    const orders = await m
      .getRepository(RampOrderEntity)
      .find({ where: { payoutBatchId: batchId } });
    for (const order of orders) {
      const hold = order.details?.hold as { reason?: string; orderId?: string } | undefined;
      const lifting = !hold || isSelfLiftingHold(hold.reason);
      const active = (await this.users.findById(order.userId, m))?.status === "active";
      // C5: a hold that never lifts by itself (a chargeback) or a suspended account: the order
      // leaves the batch straight into review — never back to the queue still held, nor to be paid.
      const why =
        order.status !== "payout_queued"
          ? null
          : !lifting
            ? `${hold?.reason === "chargeback" ? `account chargeback on ${hold.orderId ?? "?"}` : `held: ${hold?.reason ?? "?"}`}; it left payout batch ${batchId}`
            : !active
              ? `the account is not active; it left payout batch ${batchId}`
              : null;
      const leaveDetails = {
        ...details,
        ...(hold ? { hold: null, ...(why ? { holdEndedReason: hold.reason ?? null } : {}) } : {}),
      };
      const won = why
        ? await this.store.review(
            order,
            ["payout_queued"],
            "compliance",
            why,
            actor,
            { payoutBatchId: null },
            { manager: m, expect: { payoutBatchId: batchId }, details: leaveDetails },
          )
        : await this.store.bump(
            order,
            { payoutBatchId: null },
            {
              actor,
              manager: m,
              expect: { payoutBatchId: batchId },
              detail: `left payout batch ${batchId}`,
              details: leaveDetails,
            },
          );
      if (!won) throw batchState(`order ${order.id} changed meanwhile; try again`);
    }
  }

  // ───────────────────────────────────────────── void (four-eyes) ───────────────────────────

  /** `POST …/:id/void {reason, bankRejectionRef?}` — the REQUEST of `ramp.batch.void`. */
  requestVoid(
    id: string,
    body: { reason: string; bankRejectionRef?: string },
    actor: AdminActor,
  ): Promise<ApprovalOutcome> {
    return this.approvals.request(
      {
        action: "ramp.batch.void",
        subjectId: id,
        params: body.bankRejectionRef ? { bankRejectionRef: body.bankRejectionRef } : {},
        reason: body.reason,
      },
      actor,
    );
  }

  /** Exported only; without the bank's rejection reference, confirmed statements must prove nothing was paid (X4). */
  private async validateVoid(id: string, bankRejectionRef: string | null): Promise<void> {
    const b = await this.batches.findOne({ where: { id } });
    if (!b || b.status !== "exported")
      throw batchState(`only an exported batch is voided (it is ${b?.status ?? "missing"})`);
    if (bankRejectionRef) return;
    const items = await this.items.find({ where: { batchId: id } });
    const orders = await this.store.orders.find({ where: { id: In(items.map((i) => i.orderId)) } });
    const problem = await this.unpaidProof({
      from: b.exportedAt!,
      references: orders.map((o) => o.payoutReference),
      documentNos: items.map((i) => i.documentNo),
      accountKeys: items.map((i) => `${i.ibanHashKid}:${i.ibanHash}`),
      batch: { id, total: b.totalAmount, bankReference: b.bankReference },
      minAmount: items.reduce((min, i) => (i.amount < min ? i.amount : min), b.totalAmount),
      credits: false,
    });
    if (problem) throw batchState(`the batch cannot be voided yet: ${problem}`);
  }

  private async executeVoid(
    id: string,
    bankRejectionRef: string | null,
    approver: AdminActor,
    requester: { userId: string; party: string; person: string },
    approvalId: string,
  ): Promise<{ batch: ApiPayoutBatch }> {
    await this.refuseLinked(id, approver, requester);
    const b = await this.batches.findOneByOrFail({ id });
    await this.dataSource.transaction(async (m) => {
      const res = await m.getRepository(RampPayoutBatchEntity).update(
        { id, status: "exported" },
        {
          status: "voided",
          voidApprovalId: approvalId,
          details: { ...b.details, ...(bankRejectionRef ? { bankRejectionRef } : {}) },
        },
      );
      if (!res.affected) throw batchState("the batch changed meanwhile");
      await this.releaseOrders(m, id, approver, { voidedBatchId: id });
      await this.auditBatch(m, "ramp.batch.voided", b, approver, { approvalId, bankRejectionRef });
    });
    return { batch: this.toApi(await this.batches.findOneByOrFail({ id })) };
  }

  /**
   * Statement proof that money did NOT leave (X4, #5, M7, C6): confirmed statements cover every
   * business day from `from` to + RAMP_BANK_SETTLE_DAYS, and since `from` none of their lines
   * - quotes a reference or document number of the proof (a debit; with `credits` also a credit —
   *   a return), by its single reference or by one of its transactions' (a batch-booked entry);
   * - names the batch (its id, or the bank's reference for the file), in its text or file ids;
   * - is a debit of at least `minAmount` that nothing explains: unbooked or booked to suspense, and
   *   naming no order at all (it may be the file, booked as one entry, C6).
   * Fail closed: such a line must be classified first. The one exemption: a suspense line quoting
   * the order's own reference that went to ANOTHER account than every one the proof covers (a
   * payout misdirected, X3 — money that did not reach the user); one to the order's own account,
   * or naming none, is a payment (R2a-2). Null = proven; else what is missing.
   */
  async unpaidProof(input: {
    from: Date;
    references: string[];
    documentNos: string[];
    /** The covered items' account keys `<kid>:<hash>` (R2a-2: a debit to one of them paid it). */
    accountKeys: string[];
    batch?: { id: string; total: bigint; bankReference?: string | null };
    /** The smallest payment the proof covers: an unexplained debit this large may have paid it. */
    minAmount: bigint;
    credits: boolean;
  }): Promise<string | null> {
    const d0 = minskDate(input.from);
    const need = this.gates.calendar.addBusinessDays(d0, this.config.rampBank.settleDays);
    const latest = await this.statements.latestConfirmed();
    if (!latest || latest.periodTo < need)
      return `confirmed statements must cover ${d0} … ${need} (the latest ends ${latest?.periodTo ?? "nowhere"})`;
    const [first] = await this.dataSource.query<{ period_from: string }[]>(
      `SELECT MIN(period_from)::text AS period_from FROM to_ramp_bank_statements WHERE status = 'confirmed' AND account_iban = $1`,
      [this.config.rampBank.accountIban],
    );
    if (!first?.period_from || first.period_from > d0)
      return `the confirmed statements start after ${d0}`;
    const accountKeys = new Set(input.accountKeys);
    // X3 / R2a-2: a suspense line is money that did not reach the user only when it went to
    // another account than every one the proof covers (an IBAN, and none of theirs).
    const misdirected = (l: RampBankLineEntity): boolean => {
      const iban = this.sealing.unsealLine(l).counterpartyIban;
      return !!iban && !this.sealing.ibanKeys(iban).some((k) => accountKeys.has(k));
    };
    const quoted = await this.dataSource.query<{ id: string }[]>(
      `SELECT l.id FROM to_ramp_bank_lines l JOIN to_ramp_bank_statements s ON s.id = l.statement_id AND s.status = 'confirmed'
        WHERE l.booking_date >= $1::date AND (l.amount < 0 OR $4::boolean)
          AND (l.reference = ANY($2::text[]) OR l.document_no = ANY($3::text[]))
        ORDER BY l.booking_date, l.line_ref LIMIT ${PROOF_MAX_LINES + 1}`,
      [d0, input.references, input.documentNos, input.credits],
    );
    const quoting = quoted.length
      ? await this.dataSource
          .getRepository(RampBankLineEntity)
          .find({ where: { id: In(quoted.map((r) => r.id)) } })
      : [];
    for (const l of quoting)
      if (!(l.status === "matched" && l.matchKind === "suspense" && misdirected(l)))
        return `statement line ${l.lineRef} quotes it`;
    // C6: every line since `from` that no rule booked (unbooked, or booked to suspense): its
    // transactions' references (R2a-2: whatever its single reference says), and when it names no
    // order at all — a batch-booked entry, or money gone without a name — its size.
    const open = await this.dataSource.query<{ id: string }[]>(
      `SELECT l.id FROM to_ramp_bank_lines l JOIN to_ramp_bank_statements s ON s.id = l.statement_id AND s.status = 'confirmed' AND s.account_iban = $1
        WHERE l.booking_date >= $2::date AND (l.amount < 0 OR $3::boolean)
          AND (l.status <> 'matched' OR l.match_kind = 'suspense')
        ORDER BY l.booking_date, l.line_ref LIMIT ${PROOF_MAX_LINES + 1}`,
      [this.config.rampBank.accountIban, d0, input.credits],
    );
    if (open.length > PROOF_MAX_LINES)
      return `more than ${PROOF_MAX_LINES} statement lines since ${d0} are unexplained; classify them first`;
    const lines = open.length
      ? (
          await this.dataSource
            .getRepository(RampBankLineEntity)
            .find({ where: { id: In(open.map((r) => r.id)) } })
        ).sort((a, b) =>
          a.bookingDate === b.bookingDate
            ? a.lineRef.localeCompare(b.lineRef)
            : a.bookingDate.localeCompare(b.bookingDate),
        )
      : [];
    const refs = new Set(input.references);
    const docs = new Set(input.documentNos);
    const fileNames = input.batch
      ? [input.batch.id, input.batch.bankReference ?? ""]
          .map((t) => t.trim().toUpperCase())
          .filter((t) => t.length >= 4)
      : [];
    for (const l of lines) {
      const raw = lineFromSealed(this.sealing.unsealLine(l));
      const suspense = l.status === "matched" && l.matchKind === "suspense";
      if (
        (raw.references.some((r) => refs.has(r)) || raw.documentNos.some((d) => docs.has(d))) &&
        !(suspense && misdirected(l))
      )
        return `statement line ${l.lineRef} quotes it`;
      if (l.amount >= 0n) continue;
      const text = [raw.purpose, ...raw.batchRefs].join(" | ").toUpperCase();
      if (fileNames.some((name) => text.includes(name)))
        return `statement line ${l.lineRef} names the batch; classify it first`;
      const namesNoOrder = !raw.references.length && !raw.documentNos.length;
      if (namesNoOrder && -l.amount >= input.minAmount)
        return `an unexplained debit (statement line ${l.lineRef}) since ${d0} must be classified first`;
    }
    if (input.batch) {
      // Booked lines of exactly the batch total that name the batch (an explicit numeric compare).
      const ids = await this.dataSource.query<{ id: string }[]>(
        `SELECT l.id FROM to_ramp_bank_lines l JOIN to_ramp_bank_statements s ON s.id = l.statement_id AND s.status = 'confirmed'
          WHERE l.amount = $1::numeric AND l.booking_date >= $2::date LIMIT 50`,
        [formatAmount(-input.batch.total), d0],
      );
      const totals = ids.length
        ? await this.dataSource
            .getRepository(RampBankLineEntity)
            .find({ where: { id: In(ids.map((r) => r.id)) } })
        : [];
      for (const l of totals) {
        if (l.status === "matched" && l.matchKind === "suspense" && l.reference && misdirected(l))
          continue;
        const raw = lineFromSealed(this.sealing.unsealLine(l));
        const text = [raw.purpose, ...raw.batchRefs].join(" | ").toUpperCase();
        if (fileNames.some((name) => text.includes(name)))
          return `statement line ${l.lineRef} pays the batch total`;
      }
    }
    return null;
  }

  // ───────────────────────────────────────────── views ──────────────────────────────────────

  async list(filter: { status?: PayoutBatchStatus }): Promise<ApiPayoutBatch[]> {
    const rows = await this.batches.find({
      where: filter.status ? { status: filter.status } : {},
      order: { createdAt: "DESC" },
      take: 200,
    });
    return rows.map((r) => this.toApi(r));
  }

  async view(id: string): Promise<{ batch: ApiPayoutBatch; items: ApiPayoutBatchItem[] }> {
    const b = await this.batches.findOne({ where: { id } });
    if (!b) throw new ApiError(404, "not_found", "payout batch not found");
    const items = await this.items.find({ where: { batchId: id } });
    items.sort((x, y) => (BigInt(x.documentNo) < BigInt(y.documentNo) ? -1 : 1));
    const orders = await this.store.orders.find({ where: { id: In(items.map((i) => i.orderId)) } });
    const accounts = await this.dataSource
      .getRepository(RampBankAccountEntity)
      .find({ where: { id: In(items.map((i) => i.bankAccountId)) } });
    return {
      batch: this.toApi(b),
      items: items.map((i) => {
        const order = orders.find((o) => o.id === i.orderId);
        const account = accounts.find((a) => a.id === i.bankAccountId);
        return {
          batchId: i.batchId,
          orderId: i.orderId,
          kind: i.kind,
          documentNo: i.documentNo,
          amount: formatAmount(i.amount),
          status: i.status,
          payoutReference: order ? displayPayoutReference(order.payoutReference) : "",
          userId: i.userId,
          bankAccountId: i.bankAccountId,
          ibanMasked: account ? maskIban(account.ibanLast4) : null,
          bankName: account?.bankName ?? null,
          paidLineId: i.paidLineId,
          returnedLineId: i.returnedLineId,
        };
      }),
    };
  }

  toApi(b: RampPayoutBatchEntity): ApiPayoutBatch {
    return {
      id: b.id,
      status: b.status,
      currency: b.currency,
      itemCount: b.itemCount,
      totalAmount: formatAmount(b.totalAmount),
      createdByUserId: b.createdByUserId,
      approvalId: b.approvalId,
      fileFormat: b.fileFormat,
      fileSha256: b.fileSha256,
      exportedAt: toIso(b.exportedAt),
      exportedByUserId: b.exportedByUserId,
      exportCount: b.exportCount,
      submittedAt: toIso(b.submittedAt),
      submittedByUserId: b.submittedByUserId,
      bankReference: b.bankReference,
      settledAt: toIso(b.settledAt),
      voidApprovalId: b.voidApprovalId,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    };
  }

  private async auditBatch(
    m: EntityManager,
    action:
      | "ramp.batch.created"
      | "ramp.batch.approved"
      | "ramp.batch.exported"
      | "ramp.batch.submitted"
      | "ramp.batch.cancelled"
      | "ramp.batch.voided",
    b: RampPayoutBatchEntity,
    actor: AdminActor,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      {
        actorType: "admin",
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        action,
        subjectType: "ramp_payout_batch",
        subjectId: b.id,
        metadata: { ...metadata, itemCount: b.itemCount, totalAmount: formatAmount(b.totalAmount) },
        ip: actor.ip,
      },
      m,
    );
  }
}
