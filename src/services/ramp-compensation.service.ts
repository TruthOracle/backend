import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, type EntityManager, type Repository } from "typeorm";

import { TokenAppRecordEntity } from "../entities/token-app-record.entity";
import { TokenCommandEntity } from "../entities/token-command.entity";
import {
  compensationIds,
  compensationPlan,
  compensationsSoFar,
  inGenerations,
} from "./token-commands.logic";

/** How a mismatched command stands once its compensation is in. */
export interface CompensationOutcome {
  /** The compensation landed (or none was needed) and the original's net is what it was meant to be. */
  settled: boolean;
  /** What the original was meant to do: ±amount, or 0 for a command declared never-landing (late landing undone). */
  expectedNet: bigint;
}

/**
 * Compensation semantics for ramp commands (SPEC §7, S2's open issue; decided by S4). A `mismatch`
 * is resolved only by the four-eyes `token.command.compensate`: a NEW command `comp-…` (source
 * ramp, ref = the order) that brings the net of the original's records back to the EXPECTED net.
 * Once that compensation is recorded — or immediately, when the net was already right and no
 * command was needed (`resolved_by` = the approval) — the original counts, for its order, as having
 * done exactly what it was meant to:
 *
 * - expected ±amount → the original is effectively RECORDED with its expected amount: the sync hook
 *   posts its token-driven kind once (`onramp.minted`, `offramp.burned`, `offramp.reminted`,
 *   `onramp.uncredited_burned`) with the order's figures and moves the order exactly as a clean
 *   record would have — also out of the review its mismatch caused (minting → crediting, burning →
 *   paying_out, reversing resumes);
 * - expected 0 (a rejected / abandoned command that landed late) → it stays "never landed": nothing
 *   is posted, the order's refund / credit-back path stands, and a reversal mints a new generation.
 *
 * customer_liability then equals the recorded net issuance of source `ramp` again: the original's
 * landed amount plus the compensation's is the expected amount the posting books.
 */
@Injectable()
export class RampCompensationService {
  constructor(
    @InjectRepository(TokenCommandEntity) private readonly commands: Repository<TokenCommandEntity>,
    @InjectRepository(TokenAppRecordEntity)
    private readonly records: Repository<TokenAppRecordEntity>,
  ) {}

  /**
   * null = not a resolved mismatch (or not settled yet). Every generation of its compensations
   * counts (C21): a record that landed after an earlier compensation settled it re-opened the
   * mismatch, and the next compensation restores the net on top of what the earlier ones recorded.
   */
  async outcome(
    original: TokenCommandEntity,
    manager?: EntityManager,
  ): Promise<CompensationOutcome | null> {
    if (original.status !== "mismatch" || !original.resolvedBy) return null;
    const commands = manager?.getRepository(TokenCommandEntity) ?? this.commands;
    const records = await (manager?.getRepository(TokenAppRecordEntity) ?? this.records).findBy({
      kind: original.kind,
      commandId: original.commandId,
      instrumentId: original.instrumentId,
    });
    const earlier = inGenerations(
      original.commandId,
      await commands.findBy({ commandId: In(compensationIds(original.commandId)) }),
    );
    if (
      original.resolvedBy.startsWith("comp-") &&
      !earlier.some((c) => c.commandId === original.resolvedBy)
    )
      return null;
    // R1-5: a compensation that itself mismatched counts once ITS compensations settled it.
    const settledNets: (bigint | null)[] = [];
    for (const c of earlier)
      settledNets.push(
        c.status === "mismatch" ? ((await this.outcome(c, manager))?.expectedNet ?? null) : null,
      );
    const so = compensationsSoFar(earlier.map((c, i) => ({ ...c, settledNet: settledNets[i] })));
    if (so.unsettled.length) return null;
    const plan = compensationPlan(original, records, undefined, so.net);
    return plan.kind === null ? { settled: true, expectedNet: plan.expectedNet } : null;
  }

  /**
   * The command row as an order's steps and actions must read it: a settled compensated mismatch
   * reads `recorded` (meant to land) or `abandoned` (meant never to land); anything else as stored.
   */
  async effectiveRow(
    commandId: string,
    manager?: EntityManager,
  ): Promise<TokenCommandEntity | null> {
    const row = await (manager?.getRepository(TokenCommandEntity) ?? this.commands).findOneBy({
      commandId,
    });
    if (!row) return null;
    const out = await this.outcome(row, manager);
    if (!out) return row;
    return Object.assign(new TokenCommandEntity(), row, {
      status: out.expectedNet === 0n ? "abandoned" : "recorded",
    });
  }

  /** The mismatched original a compensation resolved (`resolved_by = comp id`). */
  async originalOf(
    manager: EntityManager,
    compensationId: string,
  ): Promise<TokenCommandEntity | null> {
    return manager.getRepository(TokenCommandEntity).findOneBy({ resolvedBy: compensationId });
  }
}
