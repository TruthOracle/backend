import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { EntityManager } from "typeorm";

import type { RampOrderEntity } from "../entities/ramp-order.entity";
import type { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import type { TokenCommandEntity } from "../entities/token-command.entity";
import type { Actor } from "../types";
import { parseAmount } from "../util/money";
import { RampCompensationService } from "./ramp-compensation.service";
import { RampDisputesService } from "./ramp-disputes.service";
import { RAMP_IP_RELEASES, RampJournalService, type RampOrderKind } from "./ramp-journal.service";
import { creditBackInFlight, RampOrderStore } from "./ramp-order-store.service";
import { SentryService } from "./sentry.service";
import { TokenAppSyncService } from "./token-app-sync.service";

const SYSTEM: Actor = { type: "system" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ramp-<kind>-<sha256(order id)[:40]>` — one token-app command id per order and purpose, every
 * attempt (I3). `remint` after an abandoned re-mint takes a `-<n>` suffix (SPEC §7);
 * `creditback` is the Deposit key of a credit-back (it mints nothing).
 */
export function rampCommandId(
  kind: "mint" | "burn" | "remint" | "cbburn" | "creditback",
  orderId: string,
  generation = 1,
): string {
  const base = `ramp-${kind}-${createHash("sha256").update(orderId).digest("hex").slice(0, 40)}`;
  return generation > 1 ? `${base}-${generation}` : base;
}

/**
 * What a recorded re-mint posts: `offramp.reversed_partial` with the remainder R when a
 * `reverse_remainder` set `details.cardPayout.reversal` (some card refund parts were paid), else
 * `offramp.reminted` (the whole T back).
 */
export function remintPosting(
  order: Pick<RampOrderEntity, "details">,
): [RampOrderKind, bigint | undefined] {
  const remainder = remainderOf(order);
  return remainder !== null
    ? ["offramp.reversed_partial", remainder]
    : ["offramp.reminted", undefined];
}

/** R of a partial reversal (`details.cardPayout.reversal.remainder`), or null. */
export function remainderOf(order: Pick<RampOrderEntity, "details">): bigint | null {
  const reversal = (order.details?.cardPayout as { reversal?: { remainder?: unknown } } | undefined)
    ?.reversal;
  return typeof reversal?.remainder === "string" ? parseAmount(reversal.remainder) : null;
}

/**
 * The ramp's half of the token sync (SPEC §7, #9): when token-app records one of an order's
 * commands, the posting it causes is written — and the order moved — in the SAME transaction
 * that marks the command recorded, whatever the order's status (a burn recorded while the order
 * sits in review still books `offramp.burned`). So customer_liability equals the recorded net
 * issuance of source `ramp` at every instant. A throw rolls the record back (the next pass
 * retries), so business surprises are logged, never thrown.
 */
@Injectable()
export class RampTokenSyncHook implements OnModuleInit {
  private readonly logger = new Logger(RampTokenSyncHook.name);

  constructor(
    private readonly sync: TokenAppSyncService,
    private readonly store: RampOrderStore,
    private readonly journal: RampJournalService,
    private readonly disputes: RampDisputesService,
    private readonly compensation: RampCompensationService,
    private readonly sentry: SentryService,
  ) {}

  onModuleInit(): void {
    this.sync.onRecorded(
      (manager, command, record) => this.onRecorded(manager, command, record),
      "ramp",
    );
  }

  async onRecorded(
    manager: EntityManager,
    command: TokenCommandEntity,
    _record: TokenAppRecordEntity,
  ): Promise<void> {
    // Ramp commands carry the order id as `ref`; anything else is not an order's (a check, a test).
    if (command.source !== "ramp" || !command.ref || !UUID_RE.test(command.ref)) return;
    const order = await this.store.lockForUpdate(manager, command.ref);
    if (!order) {
      this.logger.error(
        `ramp command ${command.commandId} recorded for unknown order ${command.ref}`,
      );
      return;
    }
    if (command.commandId.startsWith("comp-"))
      return this.compensationRecorded(manager, order, command);
    const known = await this.apply(manager, order, command.commandId, { resume: false });
    if (!known)
      this.logger.warn(
        `ramp command ${command.commandId} recorded for order ${order.id}: no posting attached`,
      );
  }

  /**
   * A compensation of one of the order's commands was recorded (S4, SPEC §7): when it made the
   * original's net right, the original counts as recorded with its EXPECTED amount — its posting
   * once, and the move a clean record would have made, out of the review its mismatch caused
   * (RampCompensationService). An original meant never to land stays that way: nothing is posted.
   */
  private async compensationRecorded(
    manager: EntityManager,
    order: RampOrderEntity,
    comp: TokenCommandEntity,
  ): Promise<void> {
    const original = await this.compensation.originalOf(manager, comp.commandId);
    if (!original || original.ref !== order.id) {
      this.logger.error(`compensation ${comp.commandId} resolves no command of order ${order.id}`);
      return;
    }
    const out = await this.compensation.outcome(original, manager);
    if (!out) {
      this.logger.error(
        `compensation ${comp.commandId} of ${original.commandId} did not restore the expected net; the order stays as it is`,
      );
      return;
    }
    if (out.expectedNet === 0n) return;
    await this.apply(manager, order, original.commandId, { resume: true });
  }

  /**
   * The effect of the order's command `id` landing — its posting (in this transaction) and its
   * move. `resume`: a compensated mismatch; an order that review parked at this command's step
   * continues where the record would have taken it. False = not one of the order's commands.
   */
  async apply(
    manager: EntityManager,
    order: RampOrderEntity,
    id: string,
    opts: { resume: boolean },
  ): Promise<boolean> {
    if (id === order.mintCommandId) {
      await this.mintRecorded(manager, order, opts.resume);
      return true;
    }
    if (id === order.burnCommandId) {
      // C2: the order settled on "the burn never lands" (credited back): booking it would hide a
      // treasury short of T behind a balanced journal — leave customer_liability red and page.
      if (order.status === "refunded" || creditBackInFlight(order)) {
        this.settledAsNeverLanding(order, id, "offramp.burned");
        return true;
      }
      if (order.status === "burning" || this.parkedAt(order, "burn", "burning", opts.resume))
        // A card cash-out pays out now; a bank one waits for S6's batches (SPEC §4.1).
        await this.store.transition(
          order,
          [order.status],
          order.payoutRail === "bank" ? "payout_queued" : "paying_out",
          { attempts: 0, lastError: null },
          {
            actor: SYSTEM,
            manager,
            within: async (m, fresh) => {
              await this.journal.post(m, fresh, "offramp.burned");
            },
          },
        );
      else await this.postOnly(manager, order, "offramp.burned");
      return true;
    }
    if (id === order.remintCommandId) {
      // A reverse_remainder re-mints only R (SPEC §4.2): `offramp.reversed_partial`, else the whole T.
      const [kind, extra] = remintPosting(order);
      if (this.parkedAt(order, "reversal", "reversing", opts.resume))
        await this.store.transition(
          order,
          ["needs_review"],
          "reversing",
          { attempts: 0, lastError: null },
          {
            actor: SYSTEM,
            manager,
            within: async (m, fresh) => {
              await this.journal.post(m, fresh, kind, extra);
            },
          },
        );
      else await this.postOnly(manager, order, kind, extra);
      return true;
    }
    // The order's chargeback burn — its current generation (R1-3: a refused one is replaced).
    if (id === order.details?.cbburnCommandId) {
      // R1-2: a dispute won while the burn was in flight: the user is owed N again — nothing is
      // posted (customer_liability no longer matches issuance: the check turns red) and it pages.
      if (await this.journal.posted(manager, order.id, "onramp.chargeback_reversed")) {
        this.settledAsNeverLanding(order, id, "onramp.uncredited_burned");
        return true;
      }
      await this.postOnly(manager, order, "onramp.uncredited_burned");
      return true;
    }
    return false;
  }

  /** In review at `step`, entered from `from` — where a compensated command's record resumes it. */
  private parkedAt(order: RampOrderEntity, step: string, from: string, resume: boolean): boolean {
    return (
      resume &&
      order.status === "needs_review" &&
      order.reviewStep === step &&
      order.details?.reviewFrom === from
    );
  }

  /** N landed: book it, then crediting — or, with a chargeback pending, the chargeback (#10). */
  private async mintRecorded(
    manager: EntityManager,
    order: RampOrderEntity,
    resume = false,
  ): Promise<void> {
    if (
      await this.disputes.resolvePending(order, "recorded", { manager, alsoPost: "onramp.minted" })
    )
      return;
    if (order.status === "minting" || this.parkedAt(order, "mint", "minting", resume)) {
      await this.store.transition(
        order,
        [order.status],
        "crediting",
        { attempts: 0, lastError: null },
        {
          actor: SYSTEM,
          manager,
          within: async (m, fresh) => {
            await this.journal.post(m, fresh, "onramp.minted");
          },
        },
      );
      return;
    }
    // C2: the capture was already given back (refunded, voided, charged back, refund queued) —
    // R1-1: or is being given back (refunding), or the order closed on no mint (failed): booking
    // N now would be an unbacked mint behind a balanced journal — keep it visible instead.
    const kinds = await this.journal.postedKinds(manager, order.id);
    if (
      order.status === "refunding" ||
      order.status === "failed" ||
      RAMP_IP_RELEASES.some((k) => kinds.has(k))
    ) {
      this.settledAsNeverLanding(order, order.mintCommandId ?? "", "onramp.minted");
      return;
    }
    await this.postOnly(manager, order, "onramp.minted");
  }

  /**
   * A command recorded for an order that already settled on its never landing: nothing is posted,
   * so issuance_matches_liability turns red (the halt) instead of the books silently absorbing it;
   * a page names it (I9).
   */
  private settledAsNeverLanding(order: RampOrderEntity, commandId: string, kind: string): void {
    this.logger.error(
      `ramp command ${commandId} recorded for order ${order.id} (${order.status}), which settled as if it never lands: ${kind} not posted`,
    );
    this.sentry.captureMessage("ramp command recorded after its order settled", "error", {
      orderId: order.id,
      commandId,
      kind,
      page: "true",
    });
  }

  /** The posting without a status change: a version-bump write (SPEC §4). */
  private async postOnly(
    manager: EntityManager,
    order: RampOrderEntity,
    kind: RampOrderKind,
    extra?: bigint,
  ): Promise<void> {
    await this.store.bump(
      order,
      {},
      {
        actor: SYSTEM,
        manager,
        within: async (m, fresh) => {
          await this.journal.post(m, fresh, kind, extra);
        },
      },
    );
  }
}
