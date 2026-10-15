import { createHash } from "node:crypto";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Config } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import { LedgerTransferInstructionEntity } from "../entities/ledger-transfer-instruction.entity";
import {
  interfaceFilterId,
  TRANSFER_INSTRUCTION_ACCEPT,
  TRANSFER_INSTRUCTION_INTERFACE,
} from "../indexer/token-standard";
import { EnterpriseWalletService } from "../services/enterprise-wallet.service";
import { InstrumentsService } from "../services/instruments.service";
import { RedisService } from "../services/redis.service";
import { SentryService } from "../services/sentry.service";
import { TokenRegistryService } from "../services/token-registry.service";
import type { ApiExerciseCommand, RegistryChoiceContext } from "../types";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";

/** The scan lock only stops instances doing the same work twice; the deterministic command id guards the ledger. */
export const ACCEPTOR_SCAN_LOCK_TTL_MS = 60_000;

/** What the acceptor decides for one pending instruction, pure (unit-tested). */
export type AcceptorDecision =
  | { action: "accept" }
  | {
      action: "skip";
      reason: "unknown_instrument" | "instrument_disabled" | "expired" | "not_for_treasury";
    };

export function acceptorDecision(
  row: Pick<LedgerTransferInstructionEntity, "receiver" | "executeBefore" | "status">,
  instrument: Pick<InstrumentEntity, "enabled"> | null,
  treasury: string,
  now: Date,
): AcceptorDecision {
  if (row.receiver !== treasury || row.status !== "pending")
    return { action: "skip", reason: "not_for_treasury" };
  if (!instrument) return { action: "skip", reason: "unknown_instrument" };
  if (!instrument.enabled) return { action: "skip", reason: "instrument_disabled" };
  if (row.executeBefore !== null && row.executeBefore.getTime() <= now.getTime())
    return { action: "skip", reason: "expired" };
  return { action: "accept" };
}

/** `ti-accept-<sha256(cid)[:40]>`: one accept per instruction, whoever submits it first. */
export function acceptCommandId(instructionCid: string): string {
  return `ti-accept-${createHash("sha256").update(instructionCid).digest("hex").slice(0, 40)}`;
}

/** `TransferInstruction_Accept { extraArgs: { context, meta } }` through the TransferInstruction interface id. */
export function acceptCommand(
  instructionCid: string,
  context: RegistryChoiceContext,
): ApiExerciseCommand {
  return {
    ExerciseCommand: {
      templateId: interfaceFilterId(TRANSFER_INSTRUCTION_INTERFACE),
      contractId: instructionCid,
      choice: TRANSFER_INSTRUCTION_ACCEPT,
      choiceArgument: {
        extraArgs: { context: context.choiceContextData, meta: { values: {} } },
      },
    },
  };
}

/**
 * Completes the two-step transfers addressed to the treasury (docs/TOKENS.md §4.4): a token whose
 * rules do not auto-accept (no `AutoAccept` for the treasury yet, or a wallet that chose the
 * two-step flow) parks an incoming deposit in a `TransferInstruction` the receiver must accept.
 * Every `ACCEPTOR_SCAN_MS` (0 = off) the pending instructions the index holds for the treasury in
 * a known, enabled instrument get their accept context from the instrument's registry and a
 * `TransferInstruction_Accept` through `externalSubmit`; the index then turns the accepted offer
 * into an `in` transfer the deposit reconcile credits. Unknown or disabled instruments are left
 * pending and logged once per contract — nobody accepts a token the platform has not vetted.
 * Rejections are never automatic.
 *
 * The command id is derived from the instruction, so a scan that repeats before the index saw the
 * accept lands on ledger command-dedup, not on a second accept; `submitted` remembers the ids this
 * process already sent so it does not even try again.
 */
@Injectable()
export class TransferInstructionAcceptorProcessor
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TransferInstructionAcceptorProcessor.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly submitted = new Set<string>();
  private readonly loggedSkips = new Set<string>();

  constructor(
    private readonly config: Config,
    @InjectRepository(LedgerTransferInstructionEntity)
    private readonly instructions: Repository<LedgerTransferInstructionEntity>,
    private readonly instrumentsService: InstrumentsService,
    private readonly registry: TokenRegistryService,
    private readonly wallet: EnterpriseWalletService,
    private readonly redis: RedisService,
    private readonly sentry: SentryService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.acceptorScanMs === 0) {
      this.logger.log("transfer-instruction acceptor off (ACCEPTOR_SCAN_MS=0)");
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.config.acceptorScanMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scan; null when another instance (or this one) is already scanning. */
  async tick(): Promise<{ accepted: number; skipped: number; failed: number } | null> {
    if (this.running) return null;
    this.running = true;
    const lock = await this.redis
      .acquireLock("lock:transfer-acceptor", ACCEPTOR_SCAN_LOCK_TTL_MS)
      .catch(() => ({ acquired: false, release: async (): Promise<void> => {} }));
    if (!lock.acquired) {
      this.running = false;
      return null;
    }
    try {
      return await this.scan();
    } catch (err) {
      this.logger.error(`scan failed: ${(err as Error).message}`);
      this.sentry.captureException(err, { processor: "transfer-acceptor" });
      return null;
    } finally {
      await lock.release();
      this.running = false;
    }
  }

  async scan(): Promise<{ accepted: number; skipped: number; failed: number }> {
    const treasury = this.config.treasuryPartyId;
    const result = { accepted: 0, skipped: 0, failed: 0 };
    if (!treasury) return result;
    const rows = await this.instructions
      .createQueryBuilder("i")
      .where("i.status = 'pending' AND i.archived_offset IS NULL AND i.receiver = :treasury", {
        treasury,
      })
      .orderBy("i.created_offset", "ASC")
      .getMany();
    const now = new Date();
    for (const row of rows) {
      if (this.submitted.has(row.contractId)) {
        result.skipped += 1;
        continue;
      }
      const instrument = await this.instrumentsService.get(row.instrumentAdmin, row.instrumentId);
      const decision = acceptorDecision(row, instrument, treasury, now);
      if (decision.action === "skip") {
        result.skipped += 1;
        this.logSkipOnce(row, decision.reason);
        continue;
      }
      try {
        await this.accept(row, instrument!);
        result.accepted += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.warn(
          `TransferInstruction ${row.contractId} (${row.instrumentId}) could not be accepted: ${(err as Error).message}`,
        );
        if (!(err instanceof ApiError))
          this.sentry.captureException(err, {
            processor: "transfer-acceptor",
            instrument: row.instrumentId,
          });
      }
    }
    if (result.accepted || result.failed)
      this.logger.log(
        `scan: ${result.accepted} instruction(s) accepted, ${result.skipped} skipped, ${result.failed} failed`,
      );
    return result;
  }

  private async accept(
    row: LedgerTransferInstructionEntity,
    instrument: InstrumentEntity,
  ): Promise<void> {
    const context = await this.registry.acceptContext(instrument, row.contractId);
    const commandId = acceptCommandId(row.contractId);
    await this.wallet.externalSubmit({
      commandId,
      commands: [acceptCommand(row.contractId, context)],
      disclosedContracts: context.disclosedContracts,
    });
    this.submitted.add(row.contractId);
    this.logger.log(
      `accepted TransferInstruction ${row.contractId}: ${formatAmount(row.amount)} ${instrument.symbol} from ${row.sender.slice(0, 24)}… (${commandId})`,
    );
  }

  private logSkipOnce(row: LedgerTransferInstructionEntity, reason: string): void {
    const key = `${row.contractId}:${reason}`;
    if (this.loggedSkips.has(key)) return;
    this.loggedSkips.add(key);
    if (reason === "unknown_instrument" || reason === "instrument_disabled")
      this.logger.warn(
        `TransferInstruction ${row.contractId} offers ${row.instrumentId} (${row.instrumentAdmin.slice(0, 24)}…) to the treasury but the instrument is ${reason === "unknown_instrument" ? "not registered" : "disabled"}; left pending`,
      );
  }

  /** Tests only. */
  reset(): void {
    this.submitted.clear();
    this.loggedSkips.clear();
  }
}
