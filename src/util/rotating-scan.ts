import type { ObjectLiteral, SelectQueryBuilder } from "typeorm";

/**
 * Read cursors of scan queues (C17, C25). Rows that wait — blocked by a gate, a hold, an AML
 * decision — write nothing, so a queue read oldest first hands the same `take` of them to every
 * pass and never reaches the rest. Each pass continues after the id the previous pass of this
 * instance stopped at and wraps round: every row is read within ⌈rows / take⌉ passes. Read-only:
 * nothing is written to keep the place (I6), and a restart only starts the round again.
 */
export class RotatingScan {
  private readonly cursors = new Map<string, string>();

  /**
   * Up to `take` ids of `queue`. `select` builds the queue's query with its id selected as `id`
   * under `idColumn`; this adds the cursor, the id order and the limit.
   */
  async next<T extends ObjectLiteral>(
    queue: string,
    select: () => SelectQueryBuilder<T>,
    take: number,
    idColumn = "o.id",
  ): Promise<string[]> {
    const after = this.cursors.get(queue);
    const page = async (side: ">" | "<=" | null, n: number): Promise<string[]> => {
      const qb = select();
      if (side) qb.andWhere(`${idColumn} ${side} :after`, { after });
      const rows = await qb.orderBy(idColumn, "ASC").limit(n).getRawMany<{ id: string }>();
      return rows.map((r) => r.id);
    };
    const ids = await page(after ? ">" : null, take);
    if (after && ids.length < take) ids.push(...(await page("<=", take - ids.length)));
    const last = ids[ids.length - 1];
    if (last) this.cursors.set(queue, last);
    else this.cursors.delete(queue);
    return ids;
  }
}
