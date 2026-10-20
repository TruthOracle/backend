import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, In, Not, Repository } from "typeorm";

import { Config } from "../config";
import { RampBankLineEntity } from "../entities/ramp-bank-line.entity";
import { RampBankStatementEntity } from "../entities/ramp-bank-statement.entity";
import { RampOrderEntity } from "../entities/ramp-order.entity";
import {
  BANK_MATCH_KINDS,
  type Actor,
  type ApiBankLine,
  type ApiBankStatement,
  type ApiStatementPreview,
  type BankLineStatus,
  type BankMatchKind,
  type BankStatementStatus,
} from "../types";
import { minskDate } from "../util/by-calendar";
import type { TextCharset } from "../util/charset";
import { ApiError } from "../util/errors";
import { ibanLast4 } from "../util/iban";
import { formatAmount, parseAmount } from "../util/money";
import { displayPayoutReference } from "../util/payout-reference";
import { DAY_MS, MINUTE_MS, toIso } from "../util/time";
import { AdminApprovalService, type ApprovalOutcome } from "./admin-approval.service";
import type { AdminActor } from "./admin.service";
import { AuditService } from "./audit.service";
import { moneyOf } from "./ramp-actions.service";
import { type Classification, type LedgerRun, RampBankLedger } from "./ramp-bank-ledger.service";
import { RAMP_IBAN_INDEX_PURPOSE, normalizeIbanForIndex } from "./ramp-bank-rail.port";
import { RampBankSealing, rampLineAad } from "./ramp-bank-sealing.service";
import {
  canonicalStatement,
  type ParsedStatement,
  parseStatement,
  sha256Hex,
  STATEMENT_CANONICAL_PURPOSE,
  STATEMENT_MAX_BYTES,
} from "./ramp-bank-statement.parse";
import { RampFulfilmentService } from "./ramp-fulfilment.service";
import { RampGatesService } from "./ramp-gates.service";
import { RampJournalService } from "./ramp-journal.service";
import { RampReconciliationService, type ReserveStatement } from "./ramp-reconciliation.service";
import { RateLimitService } from "./rate-limit.service";
import { RedisService } from "./redis.service";
import { SealedDataService } from "./sealed-data.service";

/** The canonical parse's keyed hash (no IBAN recoverable from a stored statement row). */
const CANONICAL_PURPOSE = STATEMENT_CANONICAL_PURPOSE;
/** The approver's own copy must have been checked this recently when the confirm executes. */
const SECOND_COPY_FRESH_MS = 60 * MINUTE_MS;
const APPLY_LOCK_TTL_MS = 5 * MINUTE_MS;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface StatementFileInput {
  format: "camt053" | "csv";
  /** base64 of the file as the bank produced it. */
  content: string;
  charset?: TextCharset;
}

interface ConfirmParams extends Record<string, unknown> {
  classifications: (Classification & { lineId: string })[];
}

/** F3/F9: a line a confirm classifies, as its approval snapshots it (fixed by the file). */
interface ClassifiedLine {
  lineId: string;
  lineRef: string;
  bookingDate: string;
  amount: string;
  currency: string;
}

/** F3/F9: what each classification books (SPEC §5, §10.4) — the approver reads it in the description. */
const CLASSIFICATION_BOOKS: Record<BankMatchKind, string> = {
  payout: "offramp.paid_bank / refund.paid_bank",
  payout_batch: "every item's offramp.paid_bank / refund.paid_bank",
  payout_return: "offramp.returned_bank (re-mint and credit back)",
  refund: "refund.paid_bank",
  refund_return: "refund.returned_bank",
  psp_settlement: "psp.settlement",
  psp_funding: "psp.funding",
  bank_fee: "bank.fee",
  operator_topup: "operator.topup",
  operator_sweep: "operator.sweep",
  suspense: "suspense.in / suspense.out",
};

/** F3/F9: the classifications a confirm's sentence spells out; the rest are counted (the panel lists all). */
const DESCRIBED_CLASSIFICATIONS = 50;

/** F3/F9: the confirm's sentence — the statement, then each classification with its line amount and booking. */
export function describeStatementConfirm(
  p: { classifications: (Classification & { lineId: string })[] },
  s: Record<string, unknown>,
): string {
  const head = `confirm the statement ${String(s.periodFrom)} … ${String(s.periodTo)} (${String(s.lineCount)} lines, closing ${String(s.closing)})`;
  if (!p.classifications.length) return `${head}; no line booked by hand`;
  const lines = new Map(
    (Array.isArray(s.classified) ? (s.classified as ClassifiedLine[]) : []).map((l) => [
      l.lineId,
      l,
    ]),
  );
  const booked = p.classifications.slice(0, DESCRIBED_CLASSIFICATIONS).map((c) => {
    const l = lines.get(c.lineId);
    const line = l
      ? `line ${l.lineRef} of ${l.bookingDate} (${moneyOf(l.amount, l.currency)})`
      : `line ${c.lineId}`;
    const target = c.orderId ? ` of order ${c.orderId}` : c.batchId ? ` of batch ${c.batchId}` : "";
    return `${line} as ${c.matchKind}${target} → ${CLASSIFICATION_BOOKS[c.matchKind]}`;
  });
  const more = p.classifications.length - booked.length;
  return `${head}; book ${booked.join("; ")}${more > 0 ? `; and ${more} more line(s) classified` : ""}`;
}

function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** Lines in the order a statement is applied: by booking date, debits before credits (#2). */
export function applyOrder(a: RampBankLineEntity, b: RampBankLineEntity): number {
  if (a.bookingDate !== b.bookingDate) return a.bookingDate < b.bookingDate ? -1 : 1;
  const da = a.amount < 0n ? 0 : 1;
  const db = b.amount < 0n ? 0 : 1;
  if (da !== db) return da - db;
  return a.lineRef < b.lineRef ? -1 : a.lineRef > b.lineRef ? 1 : 0;
}

/**
 * Client-money statements (SPEC §10.4, #11, X3, X7, X16). An upload (`ops`) is parsed from the
 * FILE (account, period, balances), must be the client-money account, chain on to the latest
 * confirmed statement (opening = its closing, no business day missing) and add up; its lines are
 * sealed and the rules' matches PROPOSED. The four-eyes `ramp.statement.confirm` executes only
 * after the approver uploaded their OWN copy and its canonical parse hashed the same; execution is
 * ONE transaction (lines by booking date, debits first; any lost compare-and-set aborts it).
 * Unmatched lines stay visible until classified (`ramp.bank_line.classify`); non-zero lines are
 * never ignored. Registers the bank reconciliation checks and the reserve gate's statement source.
 */
@Injectable()
export class RampBankStatementsService implements OnModuleInit {
  private readonly logger = new Logger(RampBankStatementsService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(RampBankStatementEntity)
    readonly statements: Repository<RampBankStatementEntity>,
    @InjectRepository(RampBankLineEntity) readonly lines: Repository<RampBankLineEntity>,
    private readonly sealed: SealedDataService,
    private readonly sealing: RampBankSealing,
    private readonly ledger: RampBankLedger,
    private readonly journal: RampJournalService,
    private readonly approvals: AdminApprovalService,
    private readonly reconciliation: RampReconciliationService,
    private readonly gates: RampGatesService,
    private readonly fulfilment: RampFulfilmentService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
  ) {}

  onModuleInit(): void {
    this.registerApprovals();
    const r = this.reconciliation;
    r.registerCheck({
      name: "bank_statement_matches_journal",
      haltScopes: ["mints", "payouts"],
      run: () => this.statementMatchesJournal(),
    });
    r.registerCheck({
      name: "bank_payout_duplicate",
      haltScopes: ["payouts"],
      page: true,
      run: () => this.flagCheck("payout_duplicate"),
    });
    r.registerCheck({
      name: "bank_iban_mismatch",
      haltScopes: ["payouts"],
      page: true,
      run: () => this.flagCheck("iban_mismatch"),
    });
    // The reserve gate's statement (SPEC §6.3): only with a client-money account to read.
    if (this.config.rampBank.accountIban) r.registerReserveSource(() => this.reserveStatement());
  }

  // ───────────────────────────────────────────── upload ─────────────────────────────────────

  /** Decode, parse and check a file (the uploader's or the approver's copy). */
  parse(input: StatementFileInput): { parsed: ParsedStatement; bytes: Buffer } {
    const compact = input.content.replace(/\s+/g, "");
    if (!BASE64_RE.test(compact) || compact.length % 4 !== 0)
      throw new ApiError(400, "validation_failed", "content must be the file in base64");
    if ((compact.length / 4) * 3 > STATEMENT_MAX_BYTES + 3)
      throw new ApiError(
        422,
        "statement_invalid",
        "statement refused: the file is larger than 5 MB",
      );
    const bytes = Buffer.from(compact, "base64");
    const parsed = parseStatement(
      { format: input.format, bytes, charset: input.charset },
      { currency: this.config.ramp.fiatCurrency, fiatDecimals: this.config.ramp.fiatDecimals },
    );
    const account = this.config.rampBank.accountIban;
    if (!account || parsed.account !== account)
      throw new ApiError(
        422,
        "statement_account",
        "the statement is not of the client-money account (RAMP_BANK_ACCOUNT_IBAN)",
      );
    if (parsed.periodTo > minskDate(new Date()))
      throw new ApiError(
        422,
        "statement_invalid",
        "statement refused: the period ends in the future",
      );
    return { parsed, bytes };
  }

  async upload(input: StatementFileInput, actor: AdminActor): Promise<ApiStatementPreview> {
    await this.rateLimit.enforce("admin_import", { userId: actor.userId });
    const { parsed, bytes } = this.parse(input);
    const fileSha256 = sha256Hex(bytes);
    if (await this.statements.findOne({ where: { fileSha256, status: Not("rejected") } }))
      throw new ApiError(422, "statement_duplicate", "this file was already uploaded");
    const chain = await this.continuityProblem(parsed, this.dataSource.manager);
    if (chain) throw new ApiError(422, "statement_continuity", `statement refused: ${chain}`);
    await this.refuseKnownLines(
      this.dataSource.manager,
      parsed.lines.map((l) => l.lineRef),
    );
    const canonical = this.sealed.blindIndex(CANONICAL_PURPOSE, canonicalStatement(parsed));
    const id = await this.dataSource.transaction(async (m) => {
      const st = await m.getRepository(RampBankStatementEntity).save(
        m.getRepository(RampBankStatementEntity).create({
          accountIban: parsed.account,
          format: parsed.format,
          fileSha256,
          canonicalHash: canonical.hash,
          canonicalKid: canonical.kid,
          periodFrom: parsed.periodFrom,
          periodTo: parsed.periodTo,
          openingBalance: parsed.opening,
          closingBalance: parsed.closing,
          currency: parsed.currency,
          prevStatementId: null,
          status: "draft",
          importedByUserId: actor.userId,
          importedByPerson: actor.personId,
          lineCount: parsed.lines.length,
        }),
      );
      const repo = m.getRepository(RampBankLineEntity);
      for (const l of parsed.lines) {
        const lineId = randomUUID();
        const index = l.counterpartyIban
          ? this.sealed.blindIndex(
              RAMP_IBAN_INDEX_PURPOSE,
              normalizeIbanForIndex(l.counterpartyIban),
            )
          : null;
        await repo.insert(
          repo.create({
            id: lineId,
            statementId: st.id,
            lineRef: l.lineRef,
            bookingDate: l.bookingDate,
            valueDate: l.valueDate,
            amount: l.amount,
            currency: l.currency,
            counterpartyIbanHash: index?.hash ?? null,
            counterpartyIbanHashKid: index?.kid ?? null,
            counterpartyIbanLast4: l.counterpartyIban ? ibanLast4(l.counterpartyIban) : null,
            counterpartyBic: l.counterpartyBic,
            bankTxCode: l.bankTxCode?.slice(0, 64) ?? null,
            returnInfo: l.returnInfo,
            returnCode: l.returnCode?.slice(0, 35) ?? null,
            reference: l.reference,
            documentNo: l.documentNo,
            // The whole line, sealed to its statement and id (I4).
            rawSealed: this.sealed.seal(
              JSON.stringify({ ...l, amount: formatAmount(l.amount) }),
              rampLineAad(st.id, lineId),
            ),
            status: "unmatched",
            flags: [],
          }),
        );
      }
      await this.propose(m, st);
      await this.audit.record(
        {
          actorType: "admin",
          actorUserId: actor.userId,
          actorSessionId: actor.sessionId,
          action: "ramp.statement.imported",
          subjectType: "ramp_bank_statement",
          subjectId: st.id,
          metadata: {
            fileSha256,
            format: parsed.format,
            periodFrom: parsed.periodFrom,
            periodTo: parsed.periodTo,
            lines: parsed.lines.length,
          },
          ip: actor.ip,
        },
        m,
      );
      return st.id;
    });
    return this.view(id);
  }

  /** The rules' PROPOSED matches (a dry run: nothing moves; earlier lines' effects are simulated). */
  private async propose(m: EntityManager, st: RampBankStatementEntity): Promise<void> {
    const run = this.ledger.run("preview", st.format, { type: "system" }, null);
    const rows = (
      await m.getRepository(RampBankLineEntity).find({ where: { statementId: st.id } })
    ).sort(applyOrder);
    for (const line of rows)
      await this.saveOutcome(m, line, await this.ledger.process(m, line, run), null);
  }

  private async saveOutcome(
    m: EntityManager,
    line: RampBankLineEntity,
    o: Awaited<ReturnType<RampBankLedger["process"]>>,
    approvalId: string | null,
  ): Promise<void> {
    await m.getRepository(RampBankLineEntity).update(
      { id: line.id },
      {
        status: o.status,
        matchKind: o.matchKind,
        matchedOrderId: o.matchedOrderId,
        matchedBatchId: o.matchedBatchId,
        flags: o.flags,
        ...(o.status === "matched" ? { approvalId } : {}),
      },
    );
    Object.assign(line, { status: o.status, matchKind: o.matchKind, flags: o.flags });
  }

  /**
   * The chain (SPEC §10.4, #11): after the latest CONFIRMED statement, no overlap, no business day
   * missing in between, opening = its closing. The first statement of the account opens the chain.
   */
  async continuityProblem(
    s: Pick<ParsedStatement, "periodFrom" | "opening">,
    m: EntityManager,
  ): Promise<string | null> {
    const latest = await this.latestConfirmed(m);
    if (!latest) return null;
    if (s.periodFrom <= latest.periodTo)
      return `the period starts ${s.periodFrom}, inside the confirmed statement ending ${latest.periodTo}`;
    const gap = this.gates.calendar.businessDaysBetween(latest.periodTo, dayBefore(s.periodFrom));
    if (gap > 0)
      return `${gap} business day(s) between ${latest.periodTo} and ${s.periodFrom} have no statement`;
    if (s.opening !== latest.closingBalance)
      return `the opening balance ${formatAmount(s.opening)} is not the previous closing ${formatAmount(latest.closingBalance)}`;
    return null;
  }

  async latestConfirmed(
    m: EntityManager = this.dataSource.manager,
  ): Promise<RampBankStatementEntity | null> {
    return m.getRepository(RampBankStatementEntity).findOne({
      where: { status: "confirmed", accountIban: this.config.rampBank.accountIban },
      order: { periodTo: "DESC" },
    });
  }

  /** A bank transaction id is booked once per account across confirmed statements. */
  private async refuseKnownLines(m: EntityManager, refs: string[]): Promise<void> {
    if (!refs.length) return;
    const [hit] = await m.query<{ line_ref: string }[]>(
      `SELECT l.line_ref FROM to_ramp_bank_lines l JOIN to_ramp_bank_statements s ON s.id = l.statement_id
        WHERE s.status = 'confirmed' AND s.account_iban = $1 AND l.line_ref = ANY($2::text[]) LIMIT 1`,
      [this.config.rampBank.accountIban, refs],
    );
    if (hit)
      throw new ApiError(
        422,
        "statement_duplicate",
        `the line ${hit.line_ref} is in a confirmed statement`,
      );
  }

  // ───────────────────────────────────────────── confirm (four-eyes, own copy) ──────────────

  /** `POST …/:id/confirm {reason, classifications?}` — the REQUEST of `ramp.statement.confirm`. */
  requestConfirm(
    id: string,
    body: { reason: string; classifications?: ConfirmParams["classifications"] },
    actor: AdminActor,
  ): Promise<ApprovalOutcome> {
    return this.approvals.request(
      {
        action: "ramp.statement.confirm",
        subjectId: id,
        params: { classifications: body.classifications ?? [] },
        reason: body.reason,
      },
      actor,
    );
  }

  /**
   * `POST …/:id/confirm/approve {format, content, charset?, reason, signature?}`: the second person
   * uploads THEIR OWN copy; its canonical parse must hash like the upload's (else 409
   * `statement_mismatch`, X3), then their decision is taken on the pending confirm.
   */
  async approveWithCopy(
    id: string,
    body: StatementFileInput & { reason: string; signature?: string | null },
    actor: AdminActor,
  ): Promise<ApprovalOutcome> {
    await this.rateLimit.enforce("admin_import", { userId: actor.userId });
    const st = await this.statements.findOne({ where: { id } });
    if (!st) throw new ApiError(404, "not_found", "statement not found");
    if (st.status !== "draft")
      throw new ApiError(409, "statement_invalid", `the statement is ${st.status}`);
    const [pending] = await this.approvals.list({
      action: "ramp.statement.confirm",
      subjectType: "ramp_bank_statement",
      subjectId: id,
      status: "pending",
    });
    if (!pending)
      throw new ApiError(409, "approval_not_pending", "no confirm is pending for this statement");
    if (actor.personId === st.importedByPerson)
      throw new ApiError(
        403,
        "approval_same_person",
        "the person who uploaded the statement cannot confirm it",
      );
    const { parsed } = this.parse(body);
    // C7: what is stored and matched is the uploader's parse, so the copy must agree on every
    // field the matcher and the proofs read — free text only compares within one format.
    const sameFormat = parsed.format === st.format;
    const same =
      sameFormat &&
      this.sealed
        .blindIndexes(CANONICAL_PURPOSE, canonicalStatement(parsed))
        .some((k) => k.kid === st.canonicalKid && k.hash === st.canonicalHash);
    await this.audit.record({
      actorType: "admin",
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      action: same ? "ramp.statement.copy_verified" : "ramp.statement.copy_mismatch",
      subjectType: "ramp_bank_statement",
      subjectId: id,
      metadata: { approvalId: pending.id, format: body.format },
      ip: actor.ip,
    });
    if (!same)
      throw new ApiError(
        409,
        "statement_mismatch",
        sameFormat
          ? "your copy of the statement does not match the uploaded one (account, period, balances or a line differ)"
          : `your copy must be the same kind of file as the uploaded one (${st.format})`,
      );
    await this.statements.update(
      { id, status: "draft" },
      { secondCopyPerson: actor.personId, secondCopyAt: new Date() },
    );
    return this.approvals.approve(
      pending.id,
      { reason: body.reason, signature: body.signature ?? null },
      actor,
    );
  }

  /**
   * The confirm's ONE transaction (SPEC §10.4): the chain re-checked, lines applied by booking date
   * with debits first (the rules decide afresh on locked rows), then the confirm's classifications,
   * the first statement's `opening.balance`, the statement confirmed. Any lost compare-and-set
   * throws: nothing is written and the approval fails (re-propose).
   */
  async applyConfirm(
    id: string,
    params: ConfirmParams,
    ctx: { actor: AdminActor; approvalId: string },
  ): Promise<{ statement: ApiBankStatement; matched: number; unmatched: number; flagged: number }> {
    const lock = await this.redis.acquireLock("lock:ramp-bank-statements", APPLY_LOCK_TTL_MS);
    if (!lock.acquired)
      throw new ApiError(409, "bank_line_state", "another statement is being applied; try again");
    let run: LedgerRun | null = null;
    const counts = { matched: 0, unmatched: 0, flagged: 0 };
    try {
      await this.dataSource.transaction(async (m) => {
        const st = await m
          .getRepository(RampBankStatementEntity)
          .createQueryBuilder("s")
          .setLock("pessimistic_write")
          .where("s.id = :id", { id })
          .getOne();
        if (!st || st.status !== "draft")
          throw new ApiError(409, "statement_invalid", "the statement is not a draft");
        const chain = await this.continuityProblem(
          { periodFrom: st.periodFrom, opening: st.openingBalance },
          m,
        );
        if (chain) throw new ApiError(409, "statement_continuity", `statement refused: ${chain}`);
        const lineRows = (
          await m.getRepository(RampBankLineEntity).find({ where: { statementId: id } })
        ).sort(applyOrder);
        await this.refuseKnownLines(
          m,
          lineRows.map((l) => l.lineRef),
        );
        const prev = await this.latestConfirmed(m);
        run = this.ledger.run("apply", st.format, ctx.actor, ctx.approvalId);
        for (const line of lineRows)
          await this.saveOutcome(m, line, await this.ledger.process(m, line, run), ctx.approvalId);
        for (const c of params.classifications) {
          const line = lineRows.find((l) => l.id === c.lineId);
          if (!line)
            throw new ApiError(
              400,
              "validation_failed",
              `line ${c.lineId} is not in this statement`,
            );
          await this.saveOutcome(
            m,
            line,
            await this.ledger.classify(m, line, c, run),
            ctx.approvalId,
          );
        }
        // The first statement of the account opens the books: its opening balance is operator money until shown otherwise.
        if (!prev && st.openingBalance !== 0n)
          await this.journal.postEntry(m, {
            kind: "opening.balance",
            currency: st.currency,
            lines: [
              ["safeguard_bank", st.openingBalance],
              ["operator_money", -st.openingBalance],
            ],
          });
        await m.getRepository(RampBankStatementEntity).update(
          { id, status: "draft" },
          {
            status: "confirmed",
            confirmedAt: new Date(),
            approvalId: ctx.approvalId,
            prevStatementId: prev?.id ?? null,
          },
        );
        for (const l of lineRows) {
          if (l.status === "matched") counts.matched += 1;
          else counts.unmatched += 1;
          if (l.flags.length) counts.flagged += 1;
        }
        await this.audit.record(
          {
            actorType: "admin",
            actorUserId: ctx.actor.userId,
            actorSessionId: ctx.actor.sessionId,
            action: "ramp.statement.confirmed",
            subjectType: "ramp_bank_statement",
            subjectId: id,
            metadata: { approvalId: ctx.approvalId, ...counts, periodTo: st.periodTo },
            ip: ctx.actor.ip,
          },
          m,
        );
      });
    } finally {
      await lock.release();
    }
    await this.advance((run as LedgerRun | null)?.reversing ?? []);
    const statement = this.toApi(await this.statements.findOneByOrFail({ id }));
    return { statement, ...counts };
  }

  /** Returned payouts re-mint and credit back at once (the scan would pick them up anyway). */
  private async advance(orderIds: string[]): Promise<void> {
    for (const id of orderIds)
      await this.fulfilment.advance(id).catch((err: Error) => {
        this.logger.warn(`order ${id}: reversal not advanced yet: ${err.message}`);
      });
  }

  // ───────────────────────────────────────────── classify (four-eyes) ───────────────────────

  /** `POST /admin/ramp/bank-lines/:id/classify` — the REQUEST of `ramp.bank_line.classify`. */
  requestClassify(
    lineId: string,
    body: { reason: string; matchKind: BankMatchKind; orderId?: string; batchId?: string },
    actor: AdminActor,
  ): Promise<ApprovalOutcome> {
    return this.approvals.request(
      {
        action: "ramp.bank_line.classify",
        subjectId: lineId,
        params: {
          matchKind: body.matchKind,
          ...(body.orderId ? { orderId: body.orderId } : {}),
          ...(body.batchId ? { batchId: body.batchId } : {}),
        },
        reason: body.reason,
      },
      actor,
    );
  }

  /** One unmatched line of a CONFIRMED statement booked as classified, in one transaction. */
  async applyClassify(
    lineId: string,
    c: Classification,
    ctx: { actor: Actor; approvalId: string | null },
    mode: LedgerRun["mode"],
  ): Promise<ApiBankLine> {
    let run: LedgerRun | null = null;
    await this.dataSource.transaction(async (m) => {
      const line = await m
        .getRepository(RampBankLineEntity)
        .createQueryBuilder("l")
        .setLock("pessimistic_write")
        .where("l.id = :id", { id: lineId })
        .getOne();
      if (!line) throw new ApiError(404, "not_found", "statement line not found");
      const st = await m
        .getRepository(RampBankStatementEntity)
        .findOneByOrFail({ id: line.statementId });
      if (st.status !== "confirmed")
        throw new ApiError(
          409,
          "bank_line_state",
          "lines of a draft are classified with the confirm",
        );
      if (line.status === "matched")
        throw new ApiError(409, "bank_line_state", "the line is already booked");
      run = this.ledger.run(mode, st.format, ctx.actor, ctx.approvalId);
      const out = await this.ledger.classify(m, line, c, run);
      if (mode === "apply") {
        await this.saveOutcome(m, line, out, ctx.approvalId);
        await this.audit.record(
          {
            actorType: ctx.actor.type,
            actorUserId: ctx.actor.userId ?? null,
            actorSessionId: ctx.actor.sessionId ?? null,
            action: "ramp.bank_line.classified",
            subjectType: "ramp_bank_line",
            subjectId: lineId,
            metadata: {
              approvalId: ctx.approvalId,
              matchKind: c.matchKind,
              orderId: c.orderId ?? null,
              batchId: c.batchId ?? null,
            },
            ip: ctx.actor.ip ?? null,
          },
          m,
        );
      }
    });
    if (mode === "apply") await this.advance((run as LedgerRun | null)?.reversing ?? []);
    return this.lineToApi(await this.lines.findOneByOrFail({ id: lineId }));
  }

  private registerApprovals(): void {
    this.approvals.register<ConfirmParams, Record<string, unknown>, unknown>({
      action: "ramp.statement.confirm",
      subjectType: "ramp_bank_statement",
      requestRoles: ["ops"],
      params: (raw) => ({ classifications: classificationsOf(raw.classifications) }),
      snapshot: (id, p) => this.statementSnapshot(id, p),
      validate: async (p, s, id) => {
        if (s.status !== "draft")
          throw new ApiError(409, "statement_invalid", `the statement is ${String(s.status)}`);
        const st = await this.statements.findOneByOrFail({ id });
        const chain = await this.continuityProblem(
          { periodFrom: st.periodFrom, opening: st.openingBalance },
          this.dataSource.manager,
        );
        if (chain) throw new ApiError(409, "statement_continuity", `statement refused: ${chain}`);
        const ids = new Set(
          (await this.lines.find({ where: { statementId: id }, select: { id: true } })).map(
            (l) => l.id,
          ),
        );
        for (const c of p.classifications)
          if (!ids.has(c.lineId))
            throw new ApiError(
              400,
              "validation_failed",
              `line ${c.lineId} is not in this statement`,
            );
      },
      // F3/F9: each classification with its line amount and what it books.
      describe: (p, s) => describeStatementConfirm(p, s),
      execute: async (p, _s, ctx) => {
        const st = await this.statements.findOneByOrFail({ id: ctx.subjectId });
        if (ctx.actor.personId === st.importedByPerson)
          throw new ApiError(
            403,
            "approval_same_person",
            "the person who uploaded the statement cannot confirm it",
          );
        // Dual control: the approver's own copy must have parsed identically (dev/test without dual control: n/a).
        if (this.config.rampControls.dualControl) {
          const fresh =
            st.secondCopyPerson === ctx.actor.personId &&
            st.secondCopyAt !== null &&
            Date.now() - st.secondCopyAt.getTime() <= SECOND_COPY_FRESH_MS;
          if (!fresh)
            throw new ApiError(
              409,
              "statement_mismatch",
              "confirm with your own copy of the statement (POST …/bank-statements/:id/confirm/approve)",
            );
        }
        return this.applyConfirm(ctx.subjectId, p, {
          actor: ctx.actor,
          approvalId: ctx.approvalId,
        });
      },
    });

    this.approvals.register<
      Classification & Record<string, unknown>,
      Record<string, unknown>,
      unknown
    >({
      action: "ramp.bank_line.classify",
      subjectType: "ramp_bank_line",
      requestRoles: ["ops"],
      params: (raw) => classificationOf(raw),
      snapshot: (id) => this.lineSnapshot(id),
      validate: async (p, _s, id) => {
        // A dry run of the classification: its conditions must hold now.
        await this.applyClassify(id, p, { actor: { type: "system" }, approvalId: null }, "preview");
      },
      describe: (p, s) => `book line ${String(s.lineRef)} (${String(s.amount)}) as ${p.matchKind}`,
      subjectUser: async (_id, p) =>
        p.orderId
          ? ((
              await this.dataSource
                .getRepository(RampOrderEntity)
                .findOne({ where: { id: p.orderId } })
            )?.userId ?? null)
          : null,
      execute: (p, _s, ctx) =>
        this.applyClassify(
          ctx.subjectId,
          p,
          { actor: ctx.actor, approvalId: ctx.approvalId },
          "apply",
        ),
    });
  }

  private async statementSnapshot(
    id: string,
    params?: ConfirmParams,
  ): Promise<Record<string, unknown>> {
    const st = await this.statements.findOne({ where: { id } });
    if (!st) throw new ApiError(404, "not_found", "statement not found");
    // F3/F9: the lines the request classifies, as the file fixed them (ref, date, amount) — those
    // its description spells out.
    const ids = (params?.classifications ?? [])
      .slice(0, DESCRIBED_CLASSIFICATIONS)
      .map((c) => c.lineId);
    const rows = ids.length
      ? await this.lines.find({ where: { statementId: id, id: In(ids) } })
      : [];
    const classified: ClassifiedLine[] = ids.flatMap((lineId) => {
      const l = rows.find((r) => r.id === lineId);
      return l
        ? [
            {
              lineId,
              lineRef: l.lineRef,
              bookingDate: l.bookingDate,
              amount: formatAmount(l.amount),
              currency: l.currency,
            },
          ]
        : [];
    });
    // The file's hash pins the parse; the canonical hash is left out because a key rotation
    // re-indexes it (C41) and must not fail a pending confirm.
    return {
      id: st.id,
      status: st.status,
      fileSha256: st.fileSha256,
      periodFrom: st.periodFrom,
      periodTo: st.periodTo,
      opening: formatAmount(st.openingBalance),
      closing: formatAmount(st.closingBalance),
      lineCount: st.lineCount,
      classified,
    };
  }

  private async lineSnapshot(id: string): Promise<Record<string, unknown>> {
    const line = await this.lines.findOne({ where: { id } });
    if (!line) throw new ApiError(404, "not_found", "statement line not found");
    return {
      id: line.id,
      statementId: line.statementId,
      lineRef: line.lineRef,
      amount: formatAmount(line.amount),
      status: line.status,
      flags: [...line.flags].sort(),
    };
  }

  // ───────────────────────────────────────────── reconciliation ─────────────────────────────

  /**
   * SPEC §6.3's statement for the reserve gate: the latest confirmed one's period end and closing
   * balance, and (C3) the debits of the confirmed statements still unbooked — money the bank shows
   * gone that the journal's safeguard_bank still counts. A read failure throws (the gate: unreadable).
   */
  async reserveStatement(): Promise<ReserveStatement | null> {
    const st = await this.latestConfirmed();
    if (!st) return null;
    const [row] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(l.amount), 0)::text AS total FROM to_ramp_bank_lines l
         JOIN to_ramp_bank_statements s ON s.id = l.statement_id AND s.status = 'confirmed' AND s.account_iban = $1
        WHERE l.amount < 0 AND l.status <> 'matched'`,
      [this.config.rampBank.accountIban],
    );
    return {
      statementId: st.id,
      periodTo: st.periodTo,
      closingBalance: st.closingBalance,
      confirmedAt: st.confirmedAt,
      unbookedDebits: parseAmount(row?.total ?? "0"),
    };
  }

  /**
   * `bank_statement_matches_journal` (SPEC §6.2, #11): red when the confirmed chain breaks, a
   * statement's lines do not add up, a line's safeguard_bank postings differ from its amount (a
   * booked line exactly, an unbooked one zero), or the journal's safeguard_bank differs from the
   * latest closing balance less the lines still unbooked; amber when a line stays unbooked past
   * RAMP_BANK_UNMATCHED_DAYS business days.
   */
  async statementMatchesJournal(): Promise<{
    status: "green" | "amber" | "red";
    detail: string;
    figures?: Record<string, unknown>;
  }> {
    const chain = await this.statements.find({
      where: { status: "confirmed", accountIban: this.config.rampBank.accountIban || "-" },
      order: { periodTo: "ASC" },
    });
    const safeguard = (await this.journal.balances()).safeguard_bank ?? 0n;
    if (!chain.length)
      return safeguard === 0n
        ? { status: "green", detail: "no confirmed statement yet" }
        : {
            status: "amber",
            detail: `safeguard_bank ${formatAmount(safeguard)} is booked without a confirmed statement`,
          };
    for (let i = 1; i < chain.length; i += 1) {
      const [a, b] = [chain[i - 1], chain[i]];
      const gap = this.gates.calendar.businessDaysBetween(a.periodTo, dayBefore(b.periodFrom));
      if (
        b.prevStatementId !== a.id ||
        b.openingBalance !== a.closingBalance ||
        b.periodFrom <= a.periodTo ||
        gap > 0
      )
        return {
          status: "red",
          detail: `the statement chain breaks between ${a.periodTo} and ${b.periodFrom}`,
        };
    }
    const sums = await this.dataSource.query<
      { id: string; opening: string; closing: string; lines: string }[]
    >(
      `SELECT s.id, s.opening_balance::text AS opening, s.closing_balance::text AS closing, COALESCE(SUM(l.amount), 0)::text AS lines
         FROM to_ramp_bank_statements s LEFT JOIN to_ramp_bank_lines l ON l.statement_id = s.id
        WHERE s.status = 'confirmed' GROUP BY s.id HAVING COALESCE(SUM(l.amount), 0) <> s.closing_balance - s.opening_balance`,
    );
    if (sums.length)
      return { status: "red", detail: `statement ${sums[0].id}: lines ≠ closing − opening` };
    const wrong = await this.dataSource.query<{ id: string; line_ref: string }[]>(
      `SELECT l.id, l.line_ref FROM to_ramp_bank_lines l
         JOIN to_ramp_bank_statements s ON s.id = l.statement_id AND s.status = 'confirmed'
         LEFT JOIN to_ramp_journal j ON j.statement_line_id = l.id AND j.account = 'safeguard_bank'
        GROUP BY l.id, l.line_ref, l.status, l.amount
       HAVING COALESCE(SUM(j.amount), 0) <> CASE WHEN l.status = 'matched' THEN l.amount ELSE 0 END LIMIT 5`,
    );
    if (wrong.length)
      return {
        status: "red",
        detail: `line ${wrong[0].line_ref}: its safeguard_bank postings ≠ its amount`,
      };
    const [open] = await this.dataSource.query<{ total: string; oldest: string | null }[]>(
      `SELECT COALESCE(SUM(l.amount), 0)::text AS total, MIN(l.booking_date)::text AS oldest
         FROM to_ramp_bank_lines l JOIN to_ramp_bank_statements s ON s.id = l.statement_id AND s.status = 'confirmed'
        WHERE l.status <> 'matched'`,
    );
    const latest = chain[chain.length - 1];
    const expected = latest.closingBalance - parseAmount(open.total);
    const figures = {
      safeguardBank: formatAmount(safeguard),
      statementClosing: formatAmount(latest.closingBalance),
      unbooked: formatAmount(parseAmount(open.total)),
      periodTo: latest.periodTo,
    };
    if (safeguard !== expected)
      return {
        status: "red",
        detail: `journal safeguard_bank ${formatAmount(safeguard)} ≠ closing ${formatAmount(latest.closingBalance)} − unbooked lines`,
        figures,
      };
    if (open.oldest) {
      const age = this.gates.calendar.businessDaysBetween(open.oldest, minskDate(new Date()));
      if (age > this.config.rampBank.unmatchedDays)
        return {
          status: "amber",
          detail: `a statement line has waited ${age} business days to be booked`,
          figures,
        };
    }
    return { status: "green", detail: "the journal matches the confirmed statements", figures };
  }

  /** `bank_payout_duplicate` / `bank_iban_mismatch`: red while a flagged line of a confirmed statement is unbooked. */
  async flagCheck(
    flag: "payout_duplicate" | "iban_mismatch",
  ): Promise<{ status: "green" | "red"; detail: string; figures?: Record<string, unknown> }> {
    const rows = await this.dataSource.query<{ id: string; line_ref: string }[]>(
      `SELECT l.id, l.line_ref FROM to_ramp_bank_lines l JOIN to_ramp_bank_statements s ON s.id = l.statement_id
        WHERE s.status = 'confirmed' AND $1 = ANY(l.flags) AND l.status <> 'matched' LIMIT 20`,
      [flag],
    );
    return rows.length
      ? {
          status: "red",
          detail: `${rows.length} statement line(s) flagged ${flag}: ${rows[0].line_ref}`,
          figures: { lines: rows.map((r) => r.id) },
        }
      : { status: "green", detail: `no unbooked ${flag} line` };
  }

  // ───────────────────────────────────────────── views ──────────────────────────────────────

  async list(filter: { status?: BankStatementStatus }): Promise<ApiBankStatement[]> {
    const rows = await this.statements.find({
      where: filter.status ? { status: filter.status } : {},
      order: { periodTo: "DESC", createdAt: "DESC" },
      take: 200,
    });
    return rows.map((r) => this.toApi(r));
  }

  async view(id: string): Promise<ApiStatementPreview> {
    const st = await this.statements.findOne({ where: { id } });
    if (!st) throw new ApiError(404, "not_found", "statement not found");
    const rows = (await this.lines.find({ where: { statementId: id } })).sort(applyOrder);
    return { statement: this.toApi(st), lines: rows.map((l) => this.lineToApi(l)) };
  }

  async listLines(filter: {
    status?: BankLineStatus;
    statementId?: string;
  }): Promise<ApiBankLine[]> {
    const rows = await this.lines.find({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.statementId ? { statementId: filter.statementId } : {}),
      },
      order: { bookingDate: "DESC", createdAt: "DESC" },
      take: 500,
    });
    return rows.map((l) => this.lineToApi(l));
  }

  toApi(r: RampBankStatementEntity): ApiBankStatement {
    return {
      id: r.id,
      accountIban: r.accountIban,
      format: r.format,
      fileSha256: r.fileSha256,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      openingBalance: formatAmount(r.openingBalance),
      closingBalance: formatAmount(r.closingBalance),
      currency: r.currency,
      status: r.status,
      prevStatementId: r.prevStatementId,
      importedByUserId: r.importedByUserId,
      approvalId: r.approvalId,
      confirmedAt: toIso(r.confirmedAt),
      lineCount: r.lineCount,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** The operator's view of a line: the counterparty's name is unsealed (admin only), never the IBAN. */
  lineToApi(l: RampBankLineEntity): ApiBankLine {
    let counterpartyName: string | null;
    try {
      counterpartyName = this.sealing.unsealLine(l).counterpartyName;
    } catch {
      counterpartyName = null;
    }
    return {
      id: l.id,
      statementId: l.statementId,
      lineRef: l.lineRef,
      bookingDate: l.bookingDate,
      valueDate: l.valueDate,
      amount: formatAmount(l.amount),
      currency: l.currency,
      counterpartyName,
      counterpartyIbanLast4: l.counterpartyIbanLast4,
      counterpartyBic: l.counterpartyBic,
      bankTxCode: l.bankTxCode,
      returnInfo: l.returnInfo,
      returnCode: l.returnCode,
      reference: l.reference ? displayPayoutReference(l.reference) : null,
      documentNo: l.documentNo,
      matchKind: l.matchKind,
      matchedOrderId: l.matchedOrderId,
      matchedBatchId: l.matchedBatchId,
      status: l.status,
      flags: l.flags,
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One classification as params (400 on anything else). */
export function classificationOf(
  raw: Record<string, unknown>,
): Classification & Record<string, unknown> {
  const kind = raw.matchKind;
  if (typeof kind !== "string" || !(BANK_MATCH_KINDS as readonly string[]).includes(kind))
    throw new ApiError(
      400,
      "validation_failed",
      `matchKind must be one of ${BANK_MATCH_KINDS.join(", ")}`,
    );
  const id = (v: unknown, name: string): string | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || !UUID_RE.test(v))
      throw new ApiError(400, "validation_failed", `${name} must be a uuid`);
    return v.toLowerCase();
  };
  const orderId = id(raw.orderId, "orderId");
  const batchId = id(raw.batchId, "batchId");
  return {
    matchKind: kind as BankMatchKind,
    ...(orderId ? { orderId } : {}),
    ...(batchId ? { batchId } : {}),
  };
}

function classificationsOf(raw: unknown): ConfirmParams["classifications"] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50_000)
    throw new ApiError(400, "validation_failed", "classifications must be a list");
  const seen = new Set<string>();
  return raw.map((c: unknown) => {
    const o = (c ?? {}) as Record<string, unknown>;
    if (typeof o.lineId !== "string" || !UUID_RE.test(o.lineId))
      throw new ApiError(400, "validation_failed", "every classification names a lineId (uuid)");
    const lineId = o.lineId.toLowerCase();
    if (seen.has(lineId))
      throw new ApiError(400, "validation_failed", `line ${lineId} is classified twice`);
    seen.add(lineId);
    return { lineId, ...classificationOf(o) };
  });
}
