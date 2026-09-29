import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import { Config } from "../config";
import { SettingEntity } from "../entities/setting.entity";
import { NatsSubjects, type Actor, type ApiExchangeHalt, type ApiExchangeStatus } from "../types";
import { AuditService } from "./audit.service";
import { IndexerService } from "./indexer.service";
import { NatsService } from "./nats.service";

/** `to_settings` key holding the operator's trading halt as JSON (`ApiExchangeHalt`). */
export const SETTING_EXCHANGE_HALT = "exchange_halt";

const NO_HALT: ApiExchangeHalt = { active: false, reason: null, since: null, estimatedResumeAt: null };

/**
 * `GET /exchange/status` and the operator's trading halt (docs/MARKETS.md §8; Kalshi's
 * `exchange_active` / `trading_active`). Trades are user-signed Daml choices, so the halt cannot
 * stop a determined party at the ledger; it is what the UI and `orders/prepare` honour, and the
 * documented operator lever while a market or the participant is under investigation.
 */
@Injectable()
export class ExchangeService {
  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    private readonly indexer: IndexerService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  async halt(): Promise<ApiExchangeHalt> {
    const row = await this.dataSource
      .getRepository(SettingEntity)
      .findOneBy({ key: SETTING_EXCHANGE_HALT });
    if (!row) return NO_HALT;
    try {
      const parsed = JSON.parse(row.value) as Partial<ApiExchangeHalt>;
      return {
        active: parsed.active === true,
        reason: typeof parsed.reason === "string" ? parsed.reason : null,
        since: typeof parsed.since === "string" ? parsed.since : null,
        estimatedResumeAt: typeof parsed.estimatedResumeAt === "string" ? parsed.estimatedResumeAt : null,
      };
    } catch {
      return NO_HALT;
    }
  }

  async setHalt(
    input: { active: boolean; reason: string; estimatedResumeAt?: string | null },
    actor: Actor,
  ): Promise<ApiExchangeHalt> {
    const current = await this.halt();
    const next: ApiExchangeHalt = input.active
      ? {
          active: true,
          reason: input.reason,
          since: current.active ? current.since : new Date().toISOString(),
          estimatedResumeAt: input.estimatedResumeAt ?? null,
        }
      : NO_HALT;
    await this.dataSource.transaction(async (manager) => {
      // No halt = no row: the setting exists only while trading is paused.
      if (next.active)
        await manager
          .getRepository(SettingEntity)
          .upsert({ key: SETTING_EXCHANGE_HALT, value: JSON.stringify(next) }, ["key"]);
      else await manager.getRepository(SettingEntity).delete({ key: SETTING_EXCHANGE_HALT });
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "exchange.halt_changed",
          subjectType: "exchange",
          subjectId: "trading",
          metadata: { active: next.active, reason: input.reason, estimatedResumeAt: next.estimatedResumeAt },
          ip: actor.ip ?? null,
        },
        manager,
      );
    });
    await this.nats.publishSafe(NatsSubjects.exchangeHaltChanged, {
      active: next.active,
      reason: input.reason,
    });
    return next;
  }

  async status(): Promise<ApiExchangeStatus> {
    const [ledger, halt] = await Promise.all([this.indexer.status(), this.halt()]);
    const touched = ledger.updatedAt ? Date.parse(ledger.updatedAt) : NaN;
    const stale =
      ledger.enabled &&
      (!Number.isFinite(touched) || Date.now() - touched > this.config.exchangeStaleAfterSec * 1000);
    return {
      exchangeActive: ledger.enabled,
      tradingActive: !halt.active,
      halt,
      ledger: {
        indexEnabled: ledger.enabled,
        indexRunning: ledger.running,
        offset: ledger.offset,
        ledgerEnd: ledger.ledgerEnd,
        lag: ledger.lag,
        lastRecordTime: ledger.lastRecordTime,
        lastError: ledger.lastError,
        stale,
      },
      network: this.config.appNetwork,
      packageName: this.config.truthoraclePackageName,
      serverTime: new Date().toISOString(),
    };
  }
}
