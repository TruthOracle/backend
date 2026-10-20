import { Injectable, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import type { TokenCommandEntity } from "../entities/token-command.entity";
import { ApiError } from "../util/errors";
import { formatAmount, parseAmount, tryParseAmount } from "../util/money";
import { AdminApprovalService } from "./admin-approval.service";
import { InstrumentsService } from "./instruments.service";
import { RampCompensationService } from "./ramp-compensation.service";
import { RAMP_ORDER_LOCK_TTL_MS, RampFulfilmentService } from "./ramp-fulfilment.service";
import { RampGatesService } from "./ramp-gates.service";
import { creditBackInFlight, creditBackOf, RampOrderStore } from "./ramp-order-store.service";
import { RedisService } from "./redis.service";
import { RampTokenSyncHook, remainderOf } from "./ramp-token-sync.service";
import { TokenCommandService } from "./token-command.service";
import { CREDIT_REF_PREFIX, TokenOperationsService } from "./token-operations.service";
import { TreasuryTransferService } from "./treasury-transfer.service";
import { WalletLinkService } from "./wallet-link.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A command as an approval snapshots it: what the requester saw. */
interface CommandSnapshot {
  commandId: string;
  kind: string;
  source: string;
  ref: string | null;
  partyId: string;
  amount: string;
  status: string;
  attempts: number;
  lastPostAt: string | null;
  resolvedBy: string | null;
}

/** `token.admin_mint|burn` params: the instrument is the subject (`<admin>:<id>`). */
interface AdminTokenParams extends Record<string, unknown> {
  amount: string;
  /** mint: `treasury` (default) or a party; burn: the holder party. */
  party: string;
}

/**
 * S4's four-eyes catalogue for the token side (SPEC §6.5, §7, S1's operator API):
 * `token.command.resend` (a ramp mint passes the reserve gate first), `token.command.abandon`
 * (the approval states the treasury holdings expected without the command), `token.command.
 * compensate`, `token.records.adopt` (bound to the planned set's digest) and
 * `token.admin_mint|burn` (non-ramp instruments on mainnet; S1's 403 becomes a request).
 */
@Injectable()
export class TokenApprovalActions implements OnModuleInit {
  constructor(
    private readonly config: Config,
    private readonly approvals: AdminApprovalService,
    private readonly commands: TokenCommandService,
    private readonly operations: TokenOperationsService,
    private readonly gates: RampGatesService,
    private readonly store: RampOrderStore,
    private readonly instruments: InstrumentsService,
    private readonly treasury: TreasuryTransferService,
    private readonly walletLinks: WalletLinkService,
    private readonly dataSource: DataSource,
    private readonly compensation: RampCompensationService,
    private readonly rampHook: RampTokenSyncHook,
    private readonly redis: RedisService,
    private readonly fulfilment: RampFulfilmentService,
  ) {}

  onModuleInit(): void {
    const base = {
      subjectType: "token_command",
      requestRoles: ["ops" as const],
      snapshot: (id: string) => this.commandSnapshot(id),
      subjectUser: (id: string, _p: unknown, s: CommandSnapshot) => this.commandUser(s),
      // TokenCommandService holds lock:token-command:<id> and re-checks with fresh reads.
      lockKey: () => null,
    };

    this.approvals.register<Record<string, never>, CommandSnapshot, unknown>({
      ...base,
      action: "token.command.resend",
      validate: async (_p, s) => {
        await this.commands.validateResend(s.commandId);
        await this.rampOrderWaits(s);
        await this.creditBackNeverLanded(s);
        await this.rampMintGate(s);
      },
      describe: (_p, s) =>
        `re-send ${s.kind} ${s.amount} (${s.commandId}, ${s.status}) under the same id`,
      execute: async (_p, s, ctx) =>
        this.underOrderLock(s, async () => {
          // R1-1: under the order's lock, the order still waits for the command (no refund, fail
          // or credit_back settled it since the approval was validated) and a failed credit-back
          // is still proven never to land; then the POST, before any of them can run.
          await this.rampOrderWaits(s);
          await this.creditBackNeverLanded(s);
          return commandApi(
            await this.commands.resend(s.commandId, {
              actor: ctx.actor,
              approvalId: ctx.approvalId,
              reason: ctx.reason,
            }),
          );
        }),
    });

    this.approvals.register<{ expectedTreasuryHoldings: string }, CommandSnapshot, unknown>({
      ...base,
      action: "token.command.abandon",
      params: async (raw, id) => ({
        expectedTreasuryHoldings: await this.expectedHoldings(raw, id),
      }),
      validate: async (p, s) => {
        await this.commands.validateAbandon(s.commandId, {
          expectedTreasuryHoldings: parseAmount(p.expectedTreasuryHoldings),
        });
      },
      describe: (p, s) =>
        `abandon ${s.kind} ${s.amount} (${s.commandId}): never landed; treasury holds ${p.expectedTreasuryHoldings} without it`,
      execute: async (p, s, ctx) =>
        commandApi(
          await this.commands.abandon(
            s.commandId,
            { expectedTreasuryHoldings: parseAmount(p.expectedTreasuryHoldings) },
            { actor: ctx.actor, approvalId: ctx.approvalId, reason: ctx.reason },
          ),
        ),
    });

    this.approvals.register<
      Record<string, never>,
      CommandSnapshot & { plan: Record<string, string | null> },
      unknown
    >({
      ...base,
      action: "token.command.compensate",
      snapshot: async (id) => {
        const { plan } = await this.commands.planCompensation(id);
        return {
          ...(await this.commandSnapshot(id)),
          plan: {
            kind: plan.kind,
            amount: formatAmount(plan.amount),
            expectedNet: formatAmount(plan.expectedNet),
            actualNet: formatAmount(plan.actualNet),
            compensatedNet: formatAmount(plan.compensatedNet),
          },
        };
      },
      validate: async (_p, s) => {
        await this.commands.planCompensation(s.commandId);
      },
      describe: (_p, s) =>
        s.plan.kind
          ? `compensate ${s.commandId}: ${s.plan.kind} ${s.plan.amount} (expected net ${s.plan.expectedNet}, landed ${s.plan.actualNet}${s.plan.compensatedNet && parseAmount(s.plan.compensatedNet) !== 0n ? `, earlier compensations ${s.plan.compensatedNet}` : ""})`
          : `close ${s.commandId}: the net is already right`,
      execute: async (_p, s, ctx) => {
        const out = await this.commands.compensate(s.commandId, {
          actor: ctx.actor,
          approvalId: ctx.approvalId,
          reason: ctx.reason,
        });
        // The net was already right (no compensating command, so no record will arrive): the
        // original of a ramp order counts as recorded now (RampCompensationService semantics).
        if (!out.compensation) await this.settleWithoutCommand(out.original);
        return {
          original: commandApi(out.original),
          compensation: out.compensation ? commandApi(out.compensation) : null,
        };
      },
    });

    this.approvals.register<
      { before: string; instrumentId: string | null },
      { before: string; count: number; net: string; digest: string },
      unknown
    >({
      action: "token.records.adopt",
      subjectType: "token_records",
      requestRoles: ["ops"],
      params: (raw, subjectId) => {
        const before = typeof raw.before === "string" ? raw.before : "";
        if (Number.isNaN(Date.parse(before)))
          throw new ApiError(400, "validation_failed", "before must be an ISO timestamp");
        return {
          before: new Date(before).toISOString(),
          instrumentId: subjectId === "*" ? null : subjectId,
        };
      },
      snapshot: async (_id, p) => {
        const plan = await this.commands.planAdoption(
          new Date(p.before),
          p.instrumentId ?? undefined,
        );
        return {
          before: plan.before.toISOString(),
          count: plan.records.length,
          net: formatAmount(plan.net),
          digest: plan.digest,
        };
      },
      validate: async (p) => {
        await this.commands.planAdoption(new Date(p.before), p.instrumentId ?? undefined);
      },
      describe: (p, s) =>
        `adopt ${s.count} legacy record(s) created before ${p.before} (net ${s.net})`,
      lockKey: () => "lock:approval-subject:token_records",
      execute: async (p, s, ctx) => {
        const out = await this.commands.adoptLegacy(
          {
            before: new Date(p.before),
            instrumentId: p.instrumentId ?? undefined,
            digest: s.digest,
          },
          { actor: ctx.actor, approvalId: ctx.approvalId, reason: ctx.reason },
        );
        return {
          adopted: out.adopted.length,
          digest: out.plan.digest,
          net: formatAmount(out.plan.net),
        };
      },
    });

    for (const kind of ["mint", "burn"] as const)
      this.approvals.register<AdminTokenParams, { instrument: string; enabled: boolean }, unknown>({
        action: `token.admin_${kind}`,
        subjectType: "instrument",
        requestRoles: ["ops"],
        params: (raw) => {
          const amount = typeof raw.amount === "string" ? tryParseAmount(raw.amount) : null;
          if (amount === null || amount <= 0n)
            throw new ApiError(400, "validation_failed", "amount must be a positive decimal");
          const party =
            typeof raw.party === "string" && raw.party
              ? raw.party
              : kind === "mint"
                ? "treasury"
                : "";
          if (!party) throw new ApiError(400, "validation_failed", "party is required");
          return { amount: formatAmount(amount), party };
        },
        snapshot: async (subjectId) => {
          const row = await this.instrument(subjectId);
          return { instrument: subjectId, enabled: row.enabled };
        },
        validate: async () => undefined,
        describe: (p, s) =>
          `${kind} ${p.amount} of ${s.instrument} ${kind === "mint" ? "to" : "held by"} ${p.party}`,
        subjectUser: async (_id, p) => this.partyUser(p.party),
        execute: async (p, _s, ctx) => {
          const row = await this.instrument(ctx.subjectId);
          const instrument = { admin: row.admin, id: row.id };
          return kind === "mint"
            ? this.operations.mint(
                { instrument, amount: parseAmount(p.amount), to: p.party, reason: ctx.reason },
                ctx.actor,
                { approvalId: ctx.approvalId },
              )
            : this.operations.burn(
                { instrument, amount: parseAmount(p.amount), party: p.party, reason: ctx.reason },
                ctx.actor,
                { approvalId: ctx.approvalId },
              );
        },
      });
  }

  // ───────────────────────────────────────────── helpers ────────────────────────────────────

  private async settleWithoutCommand(original: TokenCommandEntity): Promise<void> {
    if (original.source !== "ramp" || !original.ref || !UUID_RE.test(original.ref)) return;
    const ref = original.ref;
    await this.dataSource.transaction(async (m) => {
      const order = await this.store.lockForUpdate(m, ref);
      const outcome = await this.compensation.outcome(original, m);
      if (order && outcome && outcome.expectedNet !== 0n)
        await this.rampHook.apply(m, order, original.commandId, { resume: true });
    });
  }

  private async commandSnapshot(id: string): Promise<CommandSnapshot> {
    const row = await this.commands.status(id);
    if (!row) throw new ApiError(404, "not_found", "token command not found");
    return {
      commandId: row.commandId,
      kind: row.kind,
      source: row.source,
      ref: row.ref,
      partyId: row.partyId,
      amount: formatAmount(row.amount),
      status: row.status,
      attempts: row.attempts,
      lastPostAt: row.lastPostAt?.toISOString() ?? null,
      resolvedBy: row.resolvedBy,
    };
  }

  /** The account a command belongs to: a ramp order's user, a mint-and-credit's user. */
  private async commandUser(s: CommandSnapshot): Promise<string | null> {
    if (s.source === "ramp" && s.ref && UUID_RE.test(s.ref))
      return (await this.store.find(s.ref))?.userId ?? null;
    if (s.ref?.startsWith(CREDIT_REF_PREFIX)) return s.ref.slice(CREDIT_REF_PREFIX.length);
    return null;
  }

  /**
   * C2: a ramp command is re-sent only while its order still waits for it — at its step (minting,
   * burning, reversing) or parked in review there (mint, burn, reversal; a charged-back order's
   * uncredited burn). An order that settled on the command never landing (refunded, credited back,
   * failed, charged back on a mint that never landed) never has it re-sent: it would mint N with no
   * fiat behind it, or burn T the treasury already gave back. `ramp.order.retry` re-sends under the
   * order's lock. A compensation (`comp-…`) restores its original's expected net whatever the
   * order did: re-sending a lost one stays allowed.
   */
  private async rampOrderWaits(s: CommandSnapshot): Promise<void> {
    if (s.source !== "ramp" || s.commandId.startsWith("comp-")) return;
    const order = s.ref && UUID_RE.test(s.ref) ? await this.store.find(s.ref) : null;
    const at = (status: string, step: string): boolean =>
      order?.status === status || (order?.status === "needs_review" && order.reviewStep === step);
    const waits =
      !!order &&
      ((s.commandId === order.mintCommandId && at("minting", "mint")) ||
        (s.commandId === order.burnCommandId &&
          at("burning", "burn") &&
          !creditBackInFlight(order)) ||
        (s.commandId === order.remintCommandId && at("reversing", "reversal")) ||
        (order.status === "chargeback" && order.details?.cbburnCommandId === s.commandId));
    if (!waits)
      throw new ApiError(
        409,
        "token_command_state",
        `${s.commandId} belongs to ramp order ${s.ref ?? "?"} (${order?.status ?? "missing"}), which no longer waits for it; a re-send is ramp.order.retry's, from the order's review`,
        { orderId: s.ref, orderStatus: order?.status ?? null },
      );
  }

  /**
   * R1-1: an order's command (not a compensation) runs under `lock:ramp:<order>` — the lock
   * refund, fail, credit_back, burn_uncredited and retry execute under — so none of them settles
   * the order beside its re-POST. Anything else runs as it is.
   */
  private async underOrderLock<T>(s: CommandSnapshot, fn: () => Promise<T>): Promise<T> {
    if (s.source !== "ramp" || s.commandId.startsWith("comp-") || !s.ref || !UUID_RE.test(s.ref))
      return fn();
    const lock = await this.redis.acquireLock(`lock:ramp:${s.ref}`, RAMP_ORDER_LOCK_TTL_MS);
    if (!lock.acquired)
      throw new ApiError(
        409,
        "token_command_state",
        `ramp order ${s.ref} is being processed; try again in a moment`,
        { orderId: s.ref },
      );
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  /**
   * C1 (R1-1): a burn re-sent from the console needs what ramp.order.retry needs — every
   * credit-back key of the order that failed for good still proven never to land (one that did
   * landed T back with the user; burning it now would burn the treasury's own tokens).
   */
  private async creditBackNeverLanded(s: CommandSnapshot): Promise<void> {
    if (s.source !== "ramp" || s.kind !== "burn" || !s.ref || !UUID_RE.test(s.ref)) return;
    const order = await this.store.find(s.ref);
    const cb = order ? creditBackOf(order) : null;
    if (!cb) return;
    const unproven = await this.fulfilment.creditBackKeysUnproven(cb);
    if (unproven)
      throw new ApiError(
        409,
        "token_command_state",
        `the failed credit back ${unproven.commandId} is not proven never to land: ${unproven.why}`,
        { orderId: s.ref, commandId: unproven.commandId },
      );
  }

  /** A ramp mint re-sent under its id passes the reserve gate like a first send (SPEC §6.3). */
  private async rampMintGate(s: CommandSnapshot): Promise<void> {
    if (s.source !== "ramp" || s.kind !== "mint" || !s.ref || !UUID_RE.test(s.ref)) return;
    const order = await this.store.find(s.ref);
    if (!order) return;
    const remint = s.commandId.startsWith("ramp-remint-");
    // C34: a reverse_remainder's re-mint is R, not T — the caps and the reserve see R.
    const verdict = await this.gates.reserveGate(order, remint ? "remint" : "mint", {
      resendOf: s.commandId,
      remainder: remint ? (remainderOf(order) ?? undefined) : undefined,
    });
    if (!verdict.ok)
      throw new ApiError(409, "reserve_gate", `reserve_gate:${verdict.reason}: ${verdict.detail}`, {
        reason: verdict.reason,
      });
  }

  /** The approval states the holdings expected without the command; default = the indexed holdings now. */
  private async expectedHoldings(raw: Record<string, unknown>, id: string): Promise<string> {
    if (typeof raw.expectedTreasuryHoldings === "string" && raw.expectedTreasuryHoldings.trim()) {
      const v = tryParseAmount(raw.expectedTreasuryHoldings.trim());
      if (v === null || v < 0n)
        throw new ApiError(400, "validation_failed", "expectedTreasuryHoldings must be a decimal");
      return formatAmount(v);
    }
    const row = await this.commands.status(id);
    if (!row) throw new ApiError(404, "not_found", "token command not found");
    const { treasuryHoldings } = await this.treasury.indexedBalances({
      admin: row.instrumentAdmin,
      id: row.instrumentId,
    });
    return formatAmount(treasuryHoldings);
  }

  private async instrument(
    subjectId: string,
  ): Promise<{ admin: string; id: string; enabled: boolean }> {
    const at = subjectId.lastIndexOf(":");
    const row =
      at > 0 ? await this.instruments.get(subjectId.slice(0, at), subjectId.slice(at + 1)) : null;
    if (!row) throw new ApiError(404, "instrument_unknown", "instrument not registered");
    return row;
  }

  private async partyUser(party: string): Promise<string | null> {
    if (party === "treasury" || party === this.config.treasuryPartyId) return null;
    return (await this.walletLinks.findByParty(party))?.userId ?? null;
  }
}

function commandApi(row: TokenCommandEntity): Record<string, unknown> {
  return {
    commandId: row.commandId,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    lastPostAt: row.lastPostAt?.toISOString() ?? null,
    lastError: row.lastError,
    resolvedBy: row.resolvedBy,
  };
}
