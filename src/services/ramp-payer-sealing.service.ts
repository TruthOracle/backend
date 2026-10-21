import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { RampOrderEntity } from "../entities/ramp-order.entity";
import { sealAad } from "../util/sealed";
import {
  type ResealPage,
  type ResealPageInput,
  SealedDataService,
  type SealedResealer,
  UNVERSIONED_KID,
} from "./sealed-data.service";

/**
 * AAD of the payer name an acquirer reported for an on-ramp (`details.payment.payerNameSealed`,
 * SPEC §3.1, M11): `ramp-payer|<userId>|<orderId>` — bound to the order's owner, so a row repointed
 * at another account no longer opens. Read back by compliance (TM-THIRDPARTY, S7a) and the
 * operations export (S7b).
 */
export function rampPayerAad(userId: string, orderId: string): string {
  return sealAad("ramp-payer", userId, orderId);
}

const PATH = `"details" -> 'payment' ->> 'payerNameSealed'`;

interface PayerRow {
  id: string;
  user_id: string;
  sealed: string;
}

/**
 * The re-sealer of `to_ramp_orders.details.payment.payerNameSealed` (SPEC §8): counts per kid for
 * the boot refusal, moves values onto the active kid page by page with a compare-and-set on the old
 * blob (the order's other writes merge `details` in SQL and never clobber it).
 */
@Injectable()
export class RampPayerResealer implements SealedResealer, OnModuleInit {
  readonly name = "ramp-payers";
  private readonly logger = new Logger(RampPayerResealer.name);

  constructor(
    private readonly sealed: SealedDataService,
    @InjectRepository(RampOrderEntity) private readonly orders: Repository<RampOrderEntity>,
  ) {}

  onModuleInit(): void {
    this.sealed.registerResealer(this);
  }

  async countByKid(): Promise<Record<string, number>> {
    const rows: { kid: string; n: number }[] = await this.orders.query(
      `SELECT CASE WHEN ${PATH} ~ '^v2\\.[A-Za-z0-9_-]{1,32}\\.' THEN split_part(${PATH}, '.', 2) ELSE $1 END AS "kid", count(*)::int AS "n"
         FROM "to_ramp_orders" WHERE ${PATH} IS NOT NULL GROUP BY 1`,
      [UNVERSIONED_KID],
    );
    return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
  }

  async resealBatch(input: ResealPageInput): Promise<ResealPage> {
    const rows: PayerRow[] = await this.orders.query(
      `SELECT "id", "user_id", ${PATH} AS "sealed" FROM "to_ramp_orders"
        WHERE ${PATH} IS NOT NULL AND NOT starts_with(${PATH}, $1) AND ($2::uuid IS NULL OR "id" > $2::uuid)
        ORDER BY "id" LIMIT $3`,
      [`v2.${input.activeKid}.`, input.after, input.limit],
    );
    let changed = 0;
    let failed = 0;
    for (const row of rows) {
      let next: string;
      try {
        next = this.sealed.reseal(row.sealed, rampPayerAad(row.user_id, row.id));
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `order ${row.id}: payer name cannot be re-sealed: ${(err as Error).message}`,
        );
        continue;
      }
      const res = await this.orders
        .createQueryBuilder()
        .update(RampOrderEntity)
        .set({
          details: () =>
            `jsonb_set("details", '{payment,payerNameSealed}', to_jsonb(CAST(:next AS text)))`,
        })
        .where(`"id" = :id AND ${PATH} = :old`, { id: row.id, old: row.sealed, next })
        .execute();
      changed += res.affected ?? 0;
    }
    return { changed, failed, last: rows.length < input.limit ? null : rows[rows.length - 1].id };
  }
}
