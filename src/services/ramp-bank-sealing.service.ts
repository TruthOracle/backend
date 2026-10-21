import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource, type EntityTarget, type ObjectLiteral } from "typeorm";

import { RampBankAccountEntity } from "../entities/ramp-bank-account.entity";
import { RampBankLineEntity } from "../entities/ramp-bank-line.entity";
import { RampBankStatementEntity } from "../entities/ramp-bank-statement.entity";
import { RampPayoutBatchItemEntity } from "../entities/ramp-payout-batch-item.entity";
import { sealAad } from "../util/sealed";
import { RAMP_IBAN_INDEX_PURPOSE, normalizeIbanForIndex } from "./ramp-bank-rail.port";
import {
  canonicalStatement,
  lineFromSealed,
  type ParsedStatement,
  STATEMENT_CANONICAL_PURPOSE,
} from "./ramp-bank-statement.parse";
import {
  type BlindIndexReindexer,
  type ResealPage,
  type ResealPageInput,
  SealedDataService,
  type SealedResealer,
  UNVERSIONED_KID,
} from "./sealed-data.service";

/**
 * Sealed and blind-indexed columns of the bank rail (SPEC §3.4 S6, §8, I4) with their re-sealers
 * and re-indexers (S3's registry: a kid is retired only once every column reports zero rows):
 * - `to_ramp_bank_accounts.iban_sealed`, AAD `ramp-iban|<userId>|<id>` (bound to the owner: a row
 *   repointed at another account no longer opens); `iban_hash` re-indexed from it;
 * - `to_ramp_bank_lines.raw_sealed` (the whole line), AAD `ramp-line|<statementId>|<id>`;
 *   `counterparty_iban_hash` re-indexed from it;
 * - `to_ramp_payout_batch_items.iban_hash`, re-indexed from the item's account;
 * - `to_ramp_bank_statements.canonical_hash` of a DRAFT (the second person's copy is compared with
 *   it), re-indexed from the statement row and its sealed lines (C41);
 * - `to_ramp_orders.details.payment.payerIbanHash` (the acquirer's payer IBAN, payer_match): no
 *   IBAN is stored to re-derive it from, so it is only COUNTED — its kid stays in DATA_INDEX_KEYS
 *   while orders use it (C41).
 * Every update is a compare-and-set on the old value, so a concurrent writer always wins.
 */

export function rampIbanAad(userId: string, accountId: string): string {
  return sealAad("ramp-iban", userId, accountId);
}

export function rampLineAad(statementId: string, lineId: string): string {
  return sealAad("ramp-line", statementId, lineId);
}

/** What `raw_sealed` holds: the parsed line, amount as a decimal string. */
export interface SealedLine {
  counterpartyName: string | null;
  counterpartyIban: string | null;
  purpose: string | null;
  [key: string]: unknown;
}

@Injectable()
export class RampBankSealing implements OnModuleInit {
  private readonly logger = new Logger(RampBankSealing.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly sealed: SealedDataService,
  ) {}

  onModuleInit(): void {
    this.sealed.registerResealer(this.ibanResealer);
    this.sealed.registerResealer(this.lineResealer);
    this.sealed.registerReindexer(this.accountReindexer);
    this.sealed.registerReindexer(this.itemReindexer);
    this.sealed.registerReindexer(this.lineReindexer);
    this.sealed.registerReindexer(this.statementReindexer);
    this.sealed.registerReindexer(this.payerHashReindexer);
  }

  /** An IBAN's blind-index keys `<kid>:<hash>` under every index kid (as matching compares them). */
  ibanKeys(iban: string): string[] {
    return this.sealed
      .blindIndexes(RAMP_IBAN_INDEX_PURPOSE, normalizeIbanForIndex(iban))
      .map((k) => `${k.kid}:${k.hash}`);
  }

  /** The line's counterparty IBAN, sealed with the line. */
  unsealLine(line: Pick<RampBankLineEntity, "id" | "statementId" | "rawSealed">): SealedLine {
    return JSON.parse(
      this.sealed.unseal(line.rawSealed, rampLineAad(line.statementId, line.id)),
    ) as SealedLine;
  }

  readonly ibanResealer: SealedResealer = {
    name: "ramp-ibans",
    countByKid: () => this.blobKids(RampBankAccountEntity, "iban_sealed"),
    resealBatch: (input) =>
      this.walk(input, RampBankAccountEntity, "iban_sealed", true, async (row) => {
        const r = row as RampBankAccountEntity;
        const next = this.sealed.reseal(r.ibanSealed, rampIbanAad(r.userId, r.id));
        return { ibanSealed: next, where: { col: "iban_sealed", old: r.ibanSealed } };
      }),
  };

  readonly lineResealer: SealedResealer = {
    name: "ramp-bank-lines",
    countByKid: () => this.blobKids(RampBankLineEntity, "raw_sealed"),
    resealBatch: (input) =>
      this.walk(input, RampBankLineEntity, "raw_sealed", true, async (row) => {
        const r = row as RampBankLineEntity;
        const next = this.sealed.reseal(r.rawSealed, rampLineAad(r.statementId, r.id));
        return { rawSealed: next, where: { col: "raw_sealed", old: r.rawSealed } };
      }),
  };

  readonly accountReindexer: BlindIndexReindexer = {
    name: "ramp-iban-hashes",
    countByKid: () => this.hashKids(RampBankAccountEntity, "iban_hash_kid"),
    reindexBatch: (input) =>
      this.walk(input, RampBankAccountEntity, "iban_hash_kid", false, async (row) => {
        const r = row as RampBankAccountEntity;
        const iban = this.sealed.unseal(r.ibanSealed, rampIbanAad(r.userId, r.id));
        const next = this.sealed.blindIndex(RAMP_IBAN_INDEX_PURPOSE, normalizeIbanForIndex(iban));
        return {
          ibanHash: next.hash,
          ibanHashKid: next.kid,
          where: { col: "iban_hash", old: r.ibanHash },
        };
      }),
  };

  readonly itemReindexer: BlindIndexReindexer = {
    name: "ramp-batch-item-iban-hashes",
    countByKid: () => this.hashKids(RampPayoutBatchItemEntity, "iban_hash_kid"),
    reindexBatch: async (input) => {
      // Items take the hash their account holds once that is on the active kid.
      const res: [unknown, number] = await this.dataSource.query(
        `UPDATE "to_ramp_payout_batch_items" i SET "iban_hash" = a."iban_hash", "iban_hash_kid" = a."iban_hash_kid"
           FROM "to_ramp_bank_accounts" a
          WHERE a."id" = i."bank_account_id" AND i."iban_hash_kid" <> $1 AND a."iban_hash_kid" = $1`,
        [input.activeKid],
      );
      return { changed: Number(res?.[1] ?? 0), failed: 0, last: null };
    },
  };

  readonly lineReindexer: BlindIndexReindexer = {
    name: "ramp-line-iban-hashes",
    countByKid: () => this.hashKids(RampBankLineEntity, "counterparty_iban_hash_kid"),
    reindexBatch: (input) =>
      this.walk(input, RampBankLineEntity, "counterparty_iban_hash_kid", false, async (row) => {
        const r = row as RampBankLineEntity;
        const raw = this.unsealLine(r);
        if (!raw.counterpartyIban) throw new Error("no counterparty IBAN behind the hash");
        const next = this.sealed.blindIndex(
          RAMP_IBAN_INDEX_PURPOSE,
          normalizeIbanForIndex(raw.counterpartyIban),
        );
        return {
          counterpartyIbanHash: next.hash,
          counterpartyIbanHashKid: next.kid,
          where: { col: "counterparty_iban_hash", old: r.counterpartyIbanHash },
        };
      }),
  };

  readonly statementReindexer: BlindIndexReindexer = {
    name: "ramp-statement-canonical",
    // Only drafts are ever compared (a confirmed statement's hash is history).
    countByKid: async () => {
      const rows: { kid: string; n: number }[] = await this.dataSource.query(
        `SELECT "canonical_kid" AS "kid", count(*)::int AS "n" FROM "to_ramp_bank_statements" WHERE "status" = 'draft' GROUP BY 1`,
      );
      return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
    },
    reindexBatch: async (input) => {
      const repo = this.dataSource.getRepository(RampBankStatementEntity);
      const qb = repo
        .createQueryBuilder("s")
        .where(`s."status" = 'draft' AND s."canonical_kid" <> :kid`, { kid: input.activeKid })
        .orderBy("s.id", "ASC")
        .take(input.limit);
      if (input.after) qb.andWhere(`s."id" > :after`, { after: input.after });
      const rows = await qb.getMany();
      let changed = 0;
      let failed = 0;
      for (const st of rows) {
        try {
          const lines = await this.dataSource
            .getRepository(RampBankLineEntity)
            .find({ where: { statementId: st.id } });
          const parsed: ParsedStatement = {
            format: st.format,
            account: st.accountIban,
            currency: st.currency,
            periodFrom: st.periodFrom,
            periodTo: st.periodTo,
            opening: st.openingBalance,
            closing: st.closingBalance,
            lines: lines.map((l) => lineFromSealed(this.unsealLine(l))),
          };
          const next = this.sealed.blindIndex(
            STATEMENT_CANONICAL_PURPOSE,
            canonicalStatement(parsed),
          );
          const res = await repo
            .createQueryBuilder()
            .update()
            .set({ canonicalHash: next.hash, canonicalKid: next.kid })
            .where(`"id" = :id AND "canonical_hash" = :old AND "status" = 'draft'`, {
              id: st.id,
              old: st.canonicalHash,
            })
            .execute();
          changed += res.affected ?? 0;
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `statement ${st.id}: cannot move to the active kid: ${(err as Error).message}`,
          );
        }
      }
      return {
        changed,
        failed,
        last: rows.length < input.limit ? null : rows[rows.length - 1].id,
      };
    },
  };

  readonly payerHashReindexer: BlindIndexReindexer = {
    name: "ramp-payer-iban-hashes",
    countByKid: async () => {
      const rows: { kid: string; n: number }[] = await this.dataSource.query(
        `SELECT "details" -> 'payment' -> 'payerIbanHash' ->> 'kid' AS "kid", count(*)::int AS "n"
           FROM "to_ramp_orders" WHERE "details" -> 'payment' -> 'payerIbanHash' ->> 'kid' IS NOT NULL GROUP BY 1`,
      );
      return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
    },
    // Nothing to re-derive it from: the walk ends at once and the kid stays pinned.
    reindexBatch: () => Promise.resolve({ changed: 0, failed: 0, last: null }),
  };

  private async blobKids(
    target: EntityTarget<ObjectLiteral>,
    column: string,
  ): Promise<Record<string, number>> {
    const table = this.dataSource.getMetadata(target).tableName;
    const rows: { kid: string; n: number }[] = await this.dataSource.query(
      `SELECT CASE WHEN "${column}" ~ '^v2\\.[A-Za-z0-9_-]{1,32}\\.' THEN split_part("${column}", '.', 2) ELSE $1 END AS "kid", count(*)::int AS "n"
         FROM "${table}" GROUP BY 1`,
      [UNVERSIONED_KID],
    );
    return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
  }

  private async hashKids(
    target: EntityTarget<ObjectLiteral>,
    kidColumn: string,
  ): Promise<Record<string, number>> {
    const table = this.dataSource.getMetadata(target).tableName;
    const rows: { kid: string; n: number }[] = await this.dataSource.query(
      `SELECT "${kidColumn}" AS "kid", count(*)::int AS "n" FROM "${table}" WHERE "${kidColumn}" IS NOT NULL GROUP BY 1`,
    );
    return Object.fromEntries(rows.map((r) => [r.kid, r.n]));
  }

  /**
   * One keyset page of rows not on the active kid (a sealed column: blob prefix; a hash: its kid
   * column); `change` computes the new values and the CAS column. A row that does not open counts
   * `failed`, is logged by id and left.
   */
  private async walk(
    input: ResealPageInput,
    target: EntityTarget<ObjectLiteral>,
    column: string,
    blob: boolean,
    change: (
      row: ObjectLiteral,
    ) => Promise<Record<string, unknown> & { where: { col: string; old: unknown } }>,
  ): Promise<ResealPage> {
    const repo = this.dataSource.getRepository(target);
    const qb = repo
      .createQueryBuilder("r")
      .where(
        blob
          ? `NOT starts_with(r."${column}", :prefix)`
          : `r."${column}" IS NOT NULL AND r."${column}" <> :kid`,
        { prefix: `v2.${input.activeKid}.`, kid: input.activeKid },
      )
      .orderBy("r.id", "ASC")
      .take(input.limit);
    if (input.after) qb.andWhere("r.id > :after", { after: input.after });
    const rows = await qb.getMany();
    let changed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const { where, ...set } = await change(row);
        const res = await repo
          .createQueryBuilder()
          .update()
          .set(set)
          .where(`"id" = :id AND "${where.col}" = :old`, { id: row.id as string, old: where.old })
          .execute();
        changed += res.affected ?? 0;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `${String(row.id)}: cannot move to the active kid: ${(err as Error).message}`,
        );
      }
    }
    return {
      changed,
      failed,
      last: rows.length < input.limit ? null : (rows[rows.length - 1].id as string),
    };
  }
}
