import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { AdminGuard } from "../auth/admin.guard";
import { AllowAdminSession, RequireRoles } from "../auth/decorators";
import type { AuthedRequest } from "../auth/request";
import { AdminReasonDto } from "../dto/admin.dto";
import {
  AdminBankAccountsQueryDto,
  BankAccountVerifyDto,
  BankLineClassifyDto,
  BankLinesQueryDto,
  BankStatementApproveDto,
  BankStatementConfirmDto,
  BankStatementsQueryDto,
  BankStatementUploadDto,
  PayoutBatchesQueryDto,
  PayoutBatchSubmittedDto,
  PayoutBatchVoidDto,
  RampBankUnpaidDto,
  RampRefundBankDto,
} from "../dto/ramp-bank.dto";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import { RampBankAccountsService } from "../services/ramp-bank-accounts.service";
import { RampBankBatchesService } from "../services/ramp-bank-batches.service";
import { RampBankStatementsService } from "../services/ramp-bank-statements.service";
import type {
  ApiAdminBankAccount,
  ApiBankLine,
  ApiBankStatement,
  ApiPayoutBatch,
  ApiPayoutBatchDraft,
  ApiPayoutBatchItem,
  ApiStatementPreview,
} from "../types";
import { adminActorOf } from "./admin.controller";
import { answerApproval } from "./admin-approvals.controller";

/**
 * The operator's bank rail (SPEC §10, §12.2): the bank order actions (`refund_bank`,
 * `bank_unpaid`, `refund_cancel`), payout batches (draft `ops`; four-eyes approval after a pre-batch
 * reconciliation and the payout gate; the file by POST with role `export`; submitted / cancel
 * `ops`; four-eyes void), client-money statements (upload `ops`; four-eyes confirm whose approver
 * uploads their own copy), unmatched lines (four-eyes classify) and users' bank accounts (four-eyes
 * manual proof / unblock). Approval-backed routes answer 202 `{approval}` or 200 `{approval, result}`.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/ramp")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminRampBankController {
  constructor(
    private readonly batches: RampBankBatchesService,
    private readonly statements: RampBankStatementsService,
    private readonly accounts: RampBankAccountsService,
    private readonly approvals: AdminApprovalService,
  ) {}

  private async request(
    req: AuthedRequest,
    res: Response,
    action: string,
    subjectId: string,
    reason: string,
    params?: Record<string, unknown>,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      { action, subjectId, reason, ...(params ? { params } : {}) },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  // ───────────────────────────────────────────── order actions (SPEC §4.2) ──────────────────

  /** On-ramp the acquirer cannot refund (ERIP): a bank refund to the user's proved account. */
  @Post("orders/:id/refund_bank")
  refundBank(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RampRefundBankDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.request(req, res, "ramp.order.refund_bank", id, body.reason, {
      bankAccountId: body.bankAccountId,
    });
  }

  /**
   * C19: a chargeback (or the acquirer's own reversal) returned an on-ramp's money while its bank
   * refund was owed and the bank never got it, or gave it back: cancel the refund (four-eyes) —
   * `onramp.refund_cancelled` nets it against the chargeback receivable; the order closes as
   * `chargeback`.
   */
  @Post("orders/:id/refund_cancel")
  refundCancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.request(req, res, "ramp.order.refund_cancel", id, body.reason);
  }

  /** A submitted payout statements prove unpaid: requeue it, or (off-ramp) reverse it. */
  @Post("orders/:id/bank_unpaid")
  bankUnpaid(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RampBankUnpaidDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.request(req, res, "ramp.order.bank_unpaid", id, body.reason, { then: body.then });
  }

  // ───────────────────────────────────────────── payout batches (SPEC §10.3) ────────────────

  @Get("payout-batches")
  async listBatches(@Query() q: PayoutBatchesQueryDto): Promise<{ items: ApiPayoutBatch[] }> {
    return { items: await this.batches.list({ status: q.status }) };
  }

  @Get("payout-batches/:id")
  batch(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{ batch: ApiPayoutBatch; items: ApiPayoutBatchItem[] }> {
    return this.batches.view(id);
  }

  @Post("payout-batches")
  @HttpCode(200)
  @RequireRoles("ops")
  createBatch(
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiPayoutBatchDraft> {
    return this.batches.create(body.reason, adminActorOf(req));
  }

  @Post("payout-batches/:id/approve")
  approveBatch(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.request(req, res, "ramp.batch.approve", id, body.reason);
  }

  /** The bank file (CSV, bank mode). A POST: the first export changes state and is gated (X16). */
  @Post("payout-batches/:id/export")
  @RequireRoles("export")
  async exportBatch(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.batches.export(id, adminActorOf(req));
    res
      .status(200)
      .setHeader("Content-Type", "text/csv; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${file.filename}"`)
      .setHeader("Cache-Control", "no-store")
      .setHeader("X-Content-SHA256", file.sha256)
      .send(file.csv);
  }

  @Post("payout-batches/:id/submitted")
  @HttpCode(200)
  @RequireRoles("ops")
  async submitted(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: PayoutBatchSubmittedDto,
    @Req() req: AuthedRequest,
  ): Promise<{ batch: ApiPayoutBatch }> {
    return this.batches.submitted(id, body.bankReference, adminActorOf(req), body.reason ?? null);
  }

  @Post("payout-batches/:id/cancel")
  @HttpCode(200)
  @RequireRoles("ops")
  cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<{ batch: ApiPayoutBatch }> {
    return this.batches.cancel(id, body.reason, adminActorOf(req));
  }

  @Post("payout-batches/:id/void")
  voidBatch(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: PayoutBatchVoidDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.request(
      req,
      res,
      "ramp.batch.void",
      id,
      body.reason,
      body.bankRejectionRef ? { bankRejectionRef: body.bankRejectionRef } : {},
    );
  }

  // ───────────────────────────────────────────── statements and lines (SPEC §10.4) ──────────

  @Get("bank-statements")
  async listStatements(@Query() q: BankStatementsQueryDto): Promise<{ items: ApiBankStatement[] }> {
    return { items: await this.statements.list({ status: q.status }) };
  }

  @Get("bank-statements/:id")
  statement(@Param("id", ParseUUIDPipe) id: string): Promise<ApiStatementPreview> {
    return this.statements.view(id);
  }

  /** `{statement, lines}`: a draft with PROPOSED matches. `422 statement_*` when refused. */
  @Post("bank-statements")
  @HttpCode(200)
  @RequireRoles("ops")
  upload(
    @Body() body: BankStatementUploadDto,
    @Req() req: AuthedRequest,
  ): Promise<ApiStatementPreview> {
    return this.statements.upload(
      { format: body.format, content: body.content, charset: body.charset },
      adminActorOf(req),
    );
  }

  /** The REQUEST of `ramp.statement.confirm` (optionally booking unmatched lines). */
  @Post("bank-statements/:id/confirm")
  confirm(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: BankStatementConfirmDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.statements
      .requestConfirm(
        id,
        {
          reason: body.reason,
          classifications: (body.classifications ?? []).map((c) => ({
            lineId: c.lineId,
            matchKind: c.matchKind,
            ...(c.orderId ? { orderId: c.orderId } : {}),
            ...(c.batchId ? { batchId: c.batchId } : {}),
          })),
        },
        adminActorOf(req),
      )
      .then((outcome) => answerApproval(res, outcome));
  }

  /** The second person's decision with THEIR OWN copy (`409 statement_mismatch` when it parses differently). */
  @Post("bank-statements/:id/confirm/approve")
  @HttpCode(200)
  approveWithCopy(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: BankStatementApproveDto,
    @Req() req: AuthedRequest,
  ): Promise<ApprovalOutcome> {
    return this.statements.approveWithCopy(
      id,
      {
        format: body.format,
        content: body.content,
        charset: body.charset,
        reason: body.reason,
        signature: body.signature ?? null,
      },
      adminActorOf(req),
    );
  }

  @Get("bank-lines")
  async lines(@Query() q: BankLinesQueryDto): Promise<{ items: ApiBankLine[] }> {
    return {
      items: await this.statements.listLines({ status: q.status, statementId: q.statementId }),
    };
  }

  @Post("bank-lines/:id/classify")
  classify(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: BankLineClassifyDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.statements
      .requestClassify(
        id,
        {
          reason: body.reason,
          matchKind: body.matchKind,
          orderId: body.orderId,
          batchId: body.batchId,
        },
        adminActorOf(req),
      )
      .then((outcome) => answerApproval(res, outcome));
  }

  // ───────────────────────────────────────────── users' bank accounts (SPEC §10.2) ──────────

  @Get("bank-accounts")
  async bankAccounts(
    @Query() q: AdminBankAccountsQueryDto,
  ): Promise<{ items: ApiAdminBankAccount[] }> {
    return { items: await this.accounts.adminList({ status: q.status, userId: q.userId }) };
  }

  @Post("bank-accounts/:id/verify")
  verify(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: BankAccountVerifyDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.request(req, res, "ramp.bank_account.verify", id, body.reason, {
      proofRef: body.proofRef,
    });
  }

  @Post("bank-accounts/:id/unblock")
  unblock(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.request(req, res, "ramp.bank_account.unblock", id, body.reason);
  }
}
