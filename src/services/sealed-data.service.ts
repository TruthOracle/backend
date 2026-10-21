import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";

import { Config } from "../config";
import {
  type BlindIndexValue,
  blindIndex,
  blindIndexes,
  type Keyring,
  seal,
  sealedKid,
  unseal,
} from "../util/sealed";

/** The kid a resealer reports for a stored value that is not a v2 blob (unreadable, never re-sealable). */
export const UNVERSIONED_KID = "(not v2)";

/** One page of a re-seal / re-index walk, in primary-key order. */
export interface ResealPage {
  /** Rows changed to the active kid. */
  changed: number;
  /** Rows that could not be opened (unknown kid, wrong AAD, tampered): left as they are and logged. */
  failed: number;
  /** The last primary key looked at; null = the walk is done. */
  last: string | null;
}

export interface ResealPageInput {
  activeKid: string;
  /** Resume after this primary key (null = from the start). */
  after: string | null;
  limit: number;
}

/**
 * A sealed column (SPEC §8): every stage that stores a sealed value registers one, so a retired
 * key id can be re-sealed away and is never dropped while rows still use it.
 */
export interface SealedResealer {
  /** Unique; named in logs and boot refusals (e.g. `ramp-cards`). */
  readonly name: string;
  /** Rows per kid of the column; values that are not v2 blobs count under UNVERSIONED_KID. */
  countByKid(): Promise<Record<string, number>>;
  /** One page of rows whose kid ≠ `activeKid`: open each with its own AAD, seal it under the active kid (CAS on the old blob). */
  resealBatch(input: ResealPageInput): Promise<ResealPage>;
}

/** A blind-index column: the same contract over `DATA_INDEX_KEYS`, re-indexing from the sealed source (X17). */
export interface BlindIndexReindexer {
  readonly name: string;
  /** Rows per stored index kid. */
  countByKid(): Promise<Record<string, number>>;
  /** One page of rows whose index kid ≠ `activeKid`: unseal the source, recompute `{kid, hash}`. */
  reindexBatch(input: ResealPageInput): Promise<ResealPage>;
}

export interface ResealPassResult {
  resealed: number;
  reindexed: number;
  failed: number;
}

const PAGE = 200;
/** One pass stops after this long; the next pass starts over (pages are cheap to skip). */
const PASS_BUDGET_MS = 20_000;

/**
 * The keyrings at runtime (SPEC §8): seal / unseal under `DATA_KEYS`, blind indexes under
 * `DATA_INDEX_KEYS`, the resealer / reindexer registries, the boot refusal for a keyring that
 * dropped a kid rows still use, and the pass RampProcessor runs to move rows onto the active kids.
 * The pure primitives live in util/sealed.ts; this is the injectable later stages register with.
 */
@Injectable()
export class SealedDataService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SealedDataService.name);
  private readonly resealers = new Map<string, SealedResealer>();
  private readonly reindexers = new Map<string, BlindIndexReindexer>();

  constructor(private readonly config: Config) {}

  get dataKeyring(): Keyring {
    return this.config.sealing.data;
  }

  get indexKeyring(): Keyring {
    return this.config.sealing.index;
  }

  seal(plaintext: string, aad: string): string {
    return seal(plaintext, this.dataKeyring, aad);
  }

  unseal(blob: string, aad: string): string {
    return unseal(blob, this.dataKeyring, aad);
  }

  /** True when `blob` is not under the active data kid (including unreadable formats). */
  needsReseal(blob: string): boolean {
    return sealedKid(blob) !== this.dataKeyring.activeKid;
  }

  /** Open under the blob's own kid, seal under the active one. Throws exactly like `unseal`. */
  reseal(blob: string, aad: string): string {
    return this.seal(this.unseal(blob, aad), aad);
  }

  /** What a new row stores next to the value: `{kid, hash}` under the active index key. */
  blindIndex(purpose: string, value: string): BlindIndexValue {
    return blindIndex(this.indexKeyring, purpose, value);
  }

  /** Uniqueness lookups: the value under every index kid (`WHERE (kid, hash) IN (…)`). */
  blindIndexes(purpose: string, value: string): BlindIndexValue[] {
    return blindIndexes(this.indexKeyring, purpose, value);
  }

  registerResealer(resealer: SealedResealer): void {
    if (this.resealers.has(resealer.name))
      throw new Error(`SealedDataService: resealer ${resealer.name} is registered twice`);
    this.resealers.set(resealer.name, resealer);
  }

  registerReindexer(reindexer: BlindIndexReindexer): void {
    if (this.reindexers.has(reindexer.name))
      throw new Error(`SealedDataService: reindexer ${reindexer.name} is registered twice`);
    this.reindexers.set(reindexer.name, reindexer);
  }

  /** Registrations happen in onModuleInit, which Nest finishes for every provider before this hook. */
  async onApplicationBootstrap(): Promise<void> {
    await this.assertKeyringsCoverStoredData();
  }

  /**
   * Boot refusal (SPEC §8): every kid that stored rows use must still be in its keyring. Rotation is
   * add the new key → make it active → let the re-seal pass finish → only then drop the old key.
   */
  async assertKeyringsCoverStoredData(): Promise<void> {
    const problems: string[] = [];
    const check = async (
      what: "DATA_KEYS" | "DATA_INDEX_KEYS",
      ring: Keyring,
      columns: Iterable<{ name: string; countByKid(): Promise<Record<string, number>> }>,
    ): Promise<void> => {
      for (const column of columns) {
        const counts = await column.countByKid();
        for (const [kid, rows] of Object.entries(counts)) {
          if (rows > 0 && !ring.keys.has(kid))
            problems.push(`${what}: ${column.name} has ${rows} row(s) under kid ${kid}`);
        }
      }
    };
    await check("DATA_KEYS", this.dataKeyring, this.resealers.values());
    await check("DATA_INDEX_KEYS", this.indexKeyring, this.reindexers.values());
    if (problems.length > 0) {
      throw new Error(
        `Refusing to boot: a keyring dropped a key id that stored data still uses (re-add the key, let the re-seal pass finish, then drop it):\n  ${problems.join("\n  ")}`,
      );
    }
  }

  /**
   * One re-seal / re-index pass over every registered column (RampProcessor's job): pages of rows
   * whose kid is not the active one, until each walk ends or the time budget runs out. A failing
   * column is logged and the others still run.
   */
  async resealPass(budgetMs = PASS_BUDGET_MS): Promise<ResealPassResult> {
    const deadline = Date.now() + budgetMs;
    const result: ResealPassResult = { resealed: 0, reindexed: 0, failed: 0 };
    const walk = async (
      name: string,
      activeKid: string,
      page: (input: ResealPageInput) => Promise<ResealPage>,
    ): Promise<number> => {
      let changed = 0;
      let after: string | null = null;
      try {
        do {
          const res = await page({ activeKid, after, limit: PAGE });
          changed += res.changed;
          result.failed += res.failed;
          after = res.last;
        } while (after !== null && Date.now() < deadline);
      } catch (err) {
        result.failed += 1;
        this.logger.error(`re-seal pass: ${name} failed: ${(err as Error).message}`);
      }
      return changed;
    };
    for (const r of this.resealers.values()) {
      result.resealed += await walk(r.name, this.dataKeyring.activeKid, (i) => r.resealBatch(i));
    }
    for (const r of this.reindexers.values()) {
      result.reindexed += await walk(r.name, this.indexKeyring.activeKid, (i) => r.reindexBatch(i));
    }
    return result;
  }
}
