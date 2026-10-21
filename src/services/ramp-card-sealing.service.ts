import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { RampPaymentMethodEntity } from "../entities/ramp-payment-method.entity";
import { sealAad } from "../util/sealed";
import {
  type ResealPage,
  type ResealPageInput,
  SealedDataService,
  type SealedResealer,
  UNVERSIONED_KID,
} from "./sealed-data.service";

/**
 * AAD of a card-on-file token (SPEC §3.3): `ramp-pm|<provider>|<userId>|<id>`. Bound to the owner:
 * a DB writer who repoints a card row (or an order) at another account gets a token that no longer
 * opens. A payout unseals with the ORDER's user id, never the card row's.
 */
export function rampCardAad(provider: string, userId: string, cardId: string): string {
  return sealAad("ramp-pm", provider, userId, cardId);
}

interface CardRow {
  id: string;
  user_id: string;
  provider: string;
  token_sealed: string;
}

/**
 * The re-sealer of `to_ramp_payment_methods.token_sealed` (SPEC §8): counts rows per kid for the
 * boot refusal and moves rows onto the active kid page by page. The update is a compare-and-set on
 * the old blob, so a concurrent writer always wins.
 */
@Injectable()
export class RampCardResealer implements SealedResealer, OnModuleInit {
  readonly name = "ramp-cards";
  private readonly logger = new Logger(RampCardResealer.name);

  constructor(
    private readonly sealed: SealedDataService,
    @InjectRepository(RampPaymentMethodEntity)
    private readonly methods: Repository<RampPaymentMethodEntity>,
  ) {}

  onModuleInit(): void {
    this.sealed.registerResealer(this);
  }

  async countByKid(): Promise<Record<string, number>> {
    const rows: { kid: string; n: number }[] = await this.methods.query(
      `SELECT CASE WHEN "token_sealed" ~ '^v2\\.[A-Za-z0-9_-]{1,32}\\.' THEN split_part("token_sealed", '.', 2) ELSE $1 END AS "kid", count(*)::int AS "n"
         FROM "to_ramp_payment_methods" GROUP BY 1`,
      [UNVERSIONED_KID],
    );
    return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
  }

  async resealBatch(input: ResealPageInput): Promise<ResealPage> {
    const rows: CardRow[] = await this.methods.query(
      `SELECT "id", "user_id", "provider", "token_sealed" FROM "to_ramp_payment_methods"
        WHERE NOT starts_with("token_sealed", $1) AND ($2::uuid IS NULL OR "id" > $2::uuid)
        ORDER BY "id" LIMIT $3`,
      [`v2.${input.activeKid}.`, input.after, input.limit],
    );
    let changed = 0;
    let failed = 0;
    for (const row of rows) {
      let next: string;
      try {
        next = this.sealed.reseal(row.token_sealed, rampCardAad(row.provider, row.user_id, row.id));
      } catch (err) {
        failed += 1;
        this.logger.warn(`card ${row.id} cannot be re-sealed: ${(err as Error).message}`);
        continue;
      }
      const res = await this.methods
        .createQueryBuilder()
        .update()
        .set({ tokenSealed: next })
        .where(`"id" = :id AND "token_sealed" = :old`, { id: row.id, old: row.token_sealed })
        .execute();
      changed += res.affected ?? 0;
    }
    return { changed, failed, last: rows.length < input.limit ? null : rows[rows.length - 1].id };
  }
}
