import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
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
import { RampHaltDto } from "../dto/admin-controls.dto";
import { AdminReasonDto } from "../dto/admin.dto";
import { DEFAULT_PAGE_LIMIT } from "../dto/common.dto";
import { AdminRampEventsQueryDto, AdminRampOrdersQueryDto } from "../dto/ramp.dto";
import { AdminApprovalService, type ApprovalOutcome } from "../services/admin-approval.service";
import type { RampAction } from "../services/ramp-actions.service";
import { RampControlsService } from "../services/ramp-controls.service";
import { RampFulfilmentService } from "../services/ramp-fulfilment.service";
import { RampGatesService } from "../services/ramp-gates.service";
import { RampJournalService } from "../services/ramp-journal.service";
import { RampReconciliationService } from "../services/ramp-reconciliation.service";
import { RampService } from "../services/ramp.service";
import {
  RAMP_PROVIDER,
  type ApiAdminRampOrder,
  type ApiAdminRampOrderDetail,
  type ApiPage,
  type ApiRampEventRow,
  type ApiRampControls,
  type ApiRampReconciliation,
  type ApiReconRun,
  type RampProvider,
  type RampProviderHealth,
} from "../types";
import { formatAmount } from "../util/money";
import { adminActorOf } from "./admin.controller";
import { answerApproval } from "./admin-approvals.controller";

/**
 * The operator's view of the fiat ramp (SPEC §4.2, §6, §12.2): the order queue, one order with its
 * webhooks / journal / token commands / approvals / audit trail, and the §4.2 actions as four-eyes
 * approvals (`ramp.order.<action>`; 202 `{approval}` pending, 200 `{approval, result}` executed — a
 * plain retry that only re-reads is single-control); the halts (set at once by `ops`, lifted by
 * the four-eyes `ramp.controls.resume`), the reconciliation (latest full run, reserve figures,
 * on-demand run), card unblocks (`ramp.payment_method.unblock`), the acquirer probe, and the
 * webhook inbox (C31): dead / unapplied events, replayed at once by `ops` or closed four-eyes.
 */
@ApiTags("admin")
@ApiCookieAuth("to_session")
@ApiBearerAuth()
@Controller("admin/ramp")
@AllowAdminSession()
@UseGuards(AdminGuard)
export class AdminRampController {
  constructor(
    private readonly ramp: RampService,
    private readonly fulfilment: RampFulfilmentService,
    private readonly approvals: AdminApprovalService,
    private readonly controls: RampControlsService,
    private readonly reconciliation: RampReconciliationService,
    private readonly gates: RampGatesService,
    private readonly journal: RampJournalService,
    @Inject(RAMP_PROVIDER) private readonly provider: RampProvider,
  ) {}

  @Get("orders")
  orders(
    @Query() query: AdminRampOrdersQueryDto,
  ): Promise<ApiPage<ApiAdminRampOrder> & { nextCursor: string | null }> {
    return this.ramp.adminList({
      status: query.status,
      direction: query.direction,
      userId: query.userId,
      page: query.page,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
      cursor: query.cursor,
    });
  }

  @Get("orders/:id")
  order(@Param("id", ParseUUIDPipe) id: string): Promise<ApiAdminRampOrderDetail> {
    return this.ramp.adminDetail(id);
  }

  /** `details.reviewFrom`'s entry conditions hold now; single control unless it re-sends a token command. */
  @Post("orders/:id/retry")
  retry(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("retry", id, body, req, res);
  }

  /** On-ramp: captured, the mint never lands (or was never created). */
  @Post("orders/:id/refund")
  refund(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("refund", id, body, req, res);
  }

  /** Off-ramp: the burn is recorded and the acquirer shows no payout (or a failed one). */
  @Post("orders/:id/reverse")
  reverse(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("reverse", id, body, req, res);
  }

  /**
   * Off-ramp card cash-out by refunds (S5): some parts paid, the rest definitively not — re-mint the
   * unpaid remainder and credit it back (four-eyes, `ramp.order.reverse_remainder`).
   */
  @Post("orders/:id/reverse_remainder")
  reverseRemainder(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("reverse_remainder", id, body, req, res);
  }

  /** Off-ramp: the ledger shows our MarkPaid and the burn never lands. */
  @Post("orders/:id/credit_back")
  creditBack(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("credit_back", id, body, req, res);
  }

  /** Nothing is held (no capture, or a PendingPayout MarkPaid never took). */
  @Post("orders/:id/fail")
  fail(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("fail", id, body, req, res);
  }

  /** On-ramp `chargeback`: the mint is recorded and was never credited. */
  @Post("orders/:id/burn_uncredited")
  burnUncredited(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    return this.act("burn_uncredited", id, body, req, res);
  }

  private async act(
    action: RampAction,
    id: string,
    body: AdminReasonDto,
    req: AuthedRequest,
    res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      { action: `ramp.order.${action}`, subjectId: id, reason: body.reason },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  // ───────────────────────────────────────────── webhook inbox (C31) ────────────────────────

  /** Dead (failed past RAMP_EVENT_DEAD_AFTER_HOURS) or still unapplied acquirer webhooks, oldest first. */
  @Get("events")
  events(
    @Query() query: AdminRampEventsQueryDto,
  ): Promise<{ items: ApiRampEventRow[]; nextCursor: string | null }> {
    return this.fulfilment.listEvents({
      status: query.status,
      cursor: query.cursor,
      limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    });
  }

  /**
   * At once (role `ops`): the event is applied again — the acquirer re-read decides (I2) — with a
   * fresh dead-after window; audited `ramp.event_replayed`.
   */
  @Post("events/:id/replay")
  @HttpCode(200)
  @RequireRoles("ops")
  async replayEvent(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<{ event: ApiRampEventRow }> {
    return { event: await this.fulfilment.replayEvent(id, body.reason, adminActorOf(req)) };
  }

  /** Four-eyes `ramp.event.close` (`ops` asks, `approver` approves): set aside without applying it. */
  @Post("events/:id/close")
  async closeEvent(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      { action: "ramp.event.close", subjectId: id, reason: body.reason },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  /** `ramp.payment_method.unblock`: a card blocked after a chargeback becomes usable again. */
  @Post("payment-methods/:id/unblock")
  async unblockCard(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      { action: "ramp.payment_method.unblock", subjectId: id, reason: body.reason },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  // ───────────────────────────────────────────── controls ───────────────────────────────────

  @Get("controls")
  async getControls(): Promise<{ controls: ApiRampControls }> {
    return { controls: await this.controls.controls() };
  }

  /** At once (role `ops`): a halt only reduces risk. */
  @Post("controls/halt")
  @HttpCode(200)
  @RequireRoles("ops")
  async halt(
    @Body() body: RampHaltDto,
    @Req() req: AuthedRequest,
  ): Promise<{ controls: ApiRampControls }> {
    return { controls: await this.controls.halt(body.scopes, body.reason, adminActorOf(req)) };
  }

  /** Lifting every halt is four-eyes (`ramp.controls.resume`); `409` when nothing is halted. */
  @Post("controls/resume")
  async resume(
    @Body() body: AdminReasonDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApprovalOutcome> {
    const outcome = await this.approvals.request(
      { action: "ramp.controls.resume", subjectId: "ramp", reason: body.reason },
      adminActorOf(req),
    );
    return answerApproval(res, outcome);
  }

  // ───────────────────────────────────────────── reconciliation ─────────────────────────────

  /** The latest full run (and whether one is running), the reserve figures the gate uses, the journal. */
  @Get("reconciliation")
  async getReconciliation(): Promise<ApiRampReconciliation> {
    const { run, running } = await this.reconciliation.latest();
    const balances = await this.journal.balances();
    return {
      run: run ? this.reconciliation.toApi(run) : null,
      running,
      reserve: await this.gates.reserveSnapshot(),
      journal: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, formatAmount(v)])),
    };
  }

  /** On demand (rate-limited): the run in progress, or one finished under a minute ago, else a new one. */
  @Post("reconciliation/run")
  @HttpCode(200)
  async runReconciliation(): Promise<{ run: ApiReconRun }> {
    return { run: this.reconciliation.toApi(await this.reconciliation.runOnDemand("admin")) };
  }

  /** The acquirer adapter's wiring and a live probe; never card data. */
  @Get("provider")
  async providerStatus(): Promise<{
    provider: string;
    configured: boolean;
    capabilities: RampProvider["capabilities"];
    /** What the acquirer is told to post to (RAMP_PUBLIC_API_URL); null until it is configured. */
    webhookUrl: string | null;
    health: RampProviderHealth;
  }> {
    return {
      provider: this.provider.name,
      configured: this.provider.isConfigured(),
      capabilities: this.provider.capabilities,
      webhookUrl: this.fulfilment.notificationUrl() || null,
      health: await this.provider.healthCheck(),
    };
  }
}
