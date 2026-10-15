import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";

import { Config } from "../config";
import { DepositCreditEntity } from "../entities/deposit-credit.entity";
import { PayoutEntity } from "../entities/payout.entity";
import { UserEntity } from "../entities/user.entity";
import { WalletCreditEntity } from "../entities/wallet-credit.entity";
import { WalletEntity } from "../entities/wallet.entity";
import {
  type Actor,
  type ApiLedgerWallet,
  type ApiWallet,
  type ApiWalletCredit,
  instrumentKey,
  type InstrumentId,
  type InstrumentRef,
  type LedgerWallet,
  NatsSubjects,
  WALLET_KIND_ALLOWLIST,
  type WalletKind,
} from "../types";
import { ApiError } from "../util/errors";
import { formatAmount } from "../util/money";
import { AuditService } from "./audit.service";
import { InstrumentsService } from "./instruments.service";
import { LedgerClientService } from "./ledger-client.service";
import { NatsService } from "./nats.service";
import { RedisService } from "./redis.service";
import { UserService } from "./user.service";

/** Payout rows that still address the current primary and therefore pin it (§8.2). */
const PAYOUT_PINNING_STATUSES = ["queued", "settling"] as const;

export interface VerifiedWallet {
  partyId: string;
  publicKeyBase64: string;
  kind: WalletKind;
}

export interface LinkResult {
  wallet: WalletEntity;
}

/** Resolves an instrument's presentation (`InstrumentsService.refOf`), passed into the pure shapers. */
export type RefOf = (instrument: InstrumentId) => InstrumentRef;

/** Wire shape of an on-ledger UserWallet (docs/API.md `LedgerWallet`), one per instrument. */
export function ledgerWalletToApi(wallet: LedgerWallet, refOf: RefOf): ApiLedgerWallet {
  return {
    contractId: wallet.contractId,
    owner: wallet.owner,
    instrument: refOf(wallet.instrument),
    balance: formatAmount(wallet.balance),
    deposited: formatAmount(wallet.deposited),
    withdrawn: formatAmount(wallet.withdrawn),
    creditRefs: [...wallet.creditRefs],
  };
}

/** What a wallet row is shaped with: its per-instrument credits, its own ledger wallets, and (overview only) what it received per instrument key. */
export interface WalletExtras {
  credits?: WalletCreditEntity[];
  ownLedgerWallets?: LedgerWallet[];
  /** `instrumentKey` → what the party sent the treasury in that instrument; only `GET /in-app-wallet` computes it. */
  received?: Map<string, bigint>;
}

/** Wire shape of a wallet row (docs/API.md `Wallet`). */
export function walletToApi(wallet: WalletEntity, extras: WalletExtras, refOf: RefOf): ApiWallet {
  const credits: ApiWalletCredit[] = (extras.credits ?? []).map((c) => {
    const instrument: InstrumentId = { admin: c.instrumentAdmin, id: c.instrumentId };
    const credit: ApiWalletCredit = {
      instrument: refOf(instrument),
      credited: formatAmount(c.credited),
    };
    const received = extras.received?.get(instrumentKey(instrument));
    if (received !== undefined) credit.received = formatAmount(received);
    return credit;
  });
  // An instrument the party sent but was never credited in still shows what it received (the
  // reconcile will attribute it); without a credit row `credited` is simply zero. Nothing sent
  // and nothing credited is no entry at all.
  for (const [key, received] of extras.received ?? []) {
    if (received === 0n || credits.some((c) => instrumentKey(c.instrument) === key)) continue;
    const [admin, id] = splitKey(key);
    credits.push({
      instrument: refOf({ admin, id }),
      credited: formatAmount(0n),
      received: formatAmount(received),
    });
  }
  return {
    id: wallet.id,
    chain: "canton",
    kind: wallet.kind,
    partyId: wallet.partyId,
    label: wallet.label,
    isPrimary: wallet.isPrimary,
    status: wallet.status,
    verifiedAt: wallet.verifiedAt.toISOString(),
    credits,
    ownLedgerWallets: (extras.ownLedgerWallets ?? []).map((w) => ledgerWalletToApi(w, refOf)),
  };
}

function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf(":");
  return [key.slice(0, at), key.slice(at + 1)];
}

/**
 * Wallet linking and the primary-wallet rules (docs/ARCHITECTURE.md §8.1–8.2).
 *
 * A wallet is a signing key and funding rail linked to a signed-in account — never an identity
 * (§6.1): linking writes a `to_wallets` row and nothing in `to_auth_identities`. A party is bound
 * to its first account forever by that row alone: any row (active or revoked) under another user
 * refuses the link (`409 wallet_already_linked`); a revoked row under this user is reactivated,
 * never re-inserted, with its `to_wallet_credits` untouched. Unlinking revokes the row; the only
 * refusal is `409 primary_wallet_in_use` while `users.party_id` points at it (§8.2).
 *
 * Linking never touches the ledger (greenfield, ARCHITECTURE §18): nothing on-ledger predates the
 * backend, so a new row starts with no credits in any instrument and linking works while the
 * ledger is down. The ledger client is used only by `setPrimary` and `ownLedgerWallets`.
 */
@Injectable()
export class WalletLinkService {
  private readonly logger = new Logger(WalletLinkService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
    @InjectRepository(WalletCreditEntity) private readonly credits: Repository<WalletCreditEntity>,
    private readonly users: UserService,
    private readonly ledger: LedgerClientService,
    private readonly instruments: InstrumentsService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly nats: NatsService,
  ) {}

  async findByParty(partyId: string): Promise<WalletEntity | null> {
    return this.wallets.findOne({ where: { partyId } });
  }

  async findById(userId: string, walletId: string): Promise<WalletEntity | null> {
    return this.wallets.findOne({ where: { id: walletId, userId } });
  }

  /** Every row of the user — active AND revoked (revoked wallets keep their attribution). */
  async listForUser(userId: string): Promise<WalletEntity[]> {
    return this.wallets.find({ where: { userId }, order: { createdAt: "ASC" } });
  }

  /** §8.1. `verified` comes from WalletChallengeService.verify (never from the client). No ledger I/O, no identity. */
  async link(
    userId: string,
    verified: VerifiedWallet,
    opts: { label?: string | null; actor: Actor },
  ): Promise<LinkResult> {
    const partyId = verified.partyId.trim();
    if (!WALLET_KIND_ALLOWLIST.includes(verified.kind)) {
      throw new ApiError(400, "validation_failed", `wallet kind ${verified.kind} is not supported`);
    }
    if (this.config.treasuryPartyId && partyId === this.config.treasuryPartyId) {
      throw new ApiError(
        400,
        "validation_failed",
        "the treasury party cannot be linked as a user wallet",
      );
    }

    // The party → first-account binding IS this row (active or revoked).
    const existing = await this.wallets.findOne({ where: { partyId } });
    if (existing && existing.userId !== userId) {
      throw new ApiError(409, "wallet_already_linked", "this wallet is linked to another account");
    }
    const wasRevoked = existing?.status === "revoked";

    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    if (user.status !== "active")
      throw new ApiError(403, "user_suspended", "this account is suspended");

    const now = new Date();
    const label = opts.label === undefined ? undefined : clipLabel(opts.label);
    const actor = opts.actor;

    const wallet = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WalletEntity);
      const fresh = await manager.getRepository(UserEntity).findOne({ where: { id: userId } });
      if (!fresh) throw new ApiError(404, "not_found", "user not found");
      const currentPrimary = await repo.findOne({
        where: { userId, isPrimary: true, status: "active" },
      });

      // The first wallet becomes primary and sets users.party_id (§8.1–8.2); a party that IS
      // users.party_id is the primary by definition (relink of the primary after an admin unlink).
      const makePrimary = fresh.partyId === partyId || (!fresh.partyId && !currentPrimary);

      let row = await repo.findOne({ where: { partyId } });
      if (row) {
        if (row.userId !== userId)
          throw new ApiError(
            409,
            "wallet_already_linked",
            "this wallet is linked to another account",
          );
        row.status = "active";
        row.revokedAt = null;
        row.publicKey = verified.publicKeyBase64;
        row.kind = verified.kind;
        row.verifiedAt = now;
        if (label !== undefined) row.label = label;
        if (makePrimary) row.isPrimary = true;
        row = await repo.save(row);
        if (wasRevoked) {
          await this.audit.record(
            {
              actorType: actor.type,
              actorUserId: actor.userId ?? null,
              actorSessionId: actor.sessionId ?? null,
              action: "wallet.relinked",
              subjectType: "wallet",
              subjectId: row.id,
              metadata: { userId, partyId, isPrimary: row.isPrimary },
              ip: actor.ip ?? null,
            },
            manager,
          );
        }
      } else {
        row = repo.create({
          userId,
          chain: "canton",
          kind: verified.kind,
          partyId,
          publicKey: verified.publicKeyBase64,
          label: label ?? null,
          isPrimary: makePrimary,
          status: "active",
          verifiedAt: now,
          revokedAt: null,
        });
        row = await repo.save(row);
        await this.audit.record(
          {
            actorType: actor.type,
            actorUserId: actor.userId ?? null,
            actorSessionId: actor.sessionId ?? null,
            action: "wallet.linked",
            subjectType: "wallet",
            subjectId: row.id,
            metadata: { userId, partyId, kind: verified.kind, isPrimary: makePrimary },
            ip: actor.ip ?? null,
          },
          manager,
        );
      }

      if (makePrimary) {
        // Clear any other primary flag first: the partial unique index allows one per user.
        await repo
          .createQueryBuilder()
          .update(WalletEntity)
          .set({ isPrimary: false })
          .where("user_id = :userId AND id <> :id AND is_primary = true", { userId, id: row.id })
          .execute();
        if (!row.isPrimary) {
          row.isPrimary = true;
          row = await repo.save(row);
        }
        if (fresh.partyId !== partyId) {
          await this.users.setPrimaryParty(userId, partyId, manager);
          await this.audit.record(
            {
              actorType: actor.type,
              actorUserId: actor.userId ?? null,
              actorSessionId: actor.sessionId ?? null,
              action: "wallet.primary_changed",
              subjectType: "wallet",
              subjectId: row.id,
              metadata: { userId, from: fresh.partyId, to: partyId, reason: "first_link" },
              ip: actor.ip ?? null,
            },
            manager,
          );
        }
      }
      return row;
    });

    void this.nats.publishSafe(NatsSubjects.walletLinked, {
      userId,
      walletId: wallet.id,
      relinked: Boolean(existing),
    });
    return { wallet };
  }

  /**
   * §8.1 / §8.2: unlink revokes the row (never deletes it — its attribution survives, §8.3). The
   * only refusal is `409 primary_wallet_in_use` while `users.party_id` points at the wallet. No
   * identity is involved: a linked wallet has none, so `DELETE /wallets/:id` leaves exactly one
   * `wallet.unlinked` audit row and event and never touches a session.
   */
  async unlink(userId: string, walletId: string, actor: Actor): Promise<void> {
    const wallet = await this.wallets.findOne({ where: { id: walletId, userId } });
    if (!wallet || wallet.status !== "active")
      throw new ApiError(404, "not_found", "wallet not found");

    const user = await this.users.findById(userId);
    if (user?.partyId && user.partyId === wallet.partyId) {
      throw new ApiError(
        409,
        "primary_wallet_in_use",
        "the primary wallet owns the in-app balance and cannot be unlinked",
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(WalletEntity)
        .update(
          { id: walletId, status: "active" },
          { status: "revoked", isPrimary: false, revokedAt: new Date() },
        );
      await this.audit.record(
        {
          actorType: actor.type,
          actorUserId: actor.userId ?? null,
          actorSessionId: actor.sessionId ?? null,
          action: "wallet.unlinked",
          subjectType: "wallet",
          subjectId: wallet.id,
          metadata: { userId, partyId: wallet.partyId },
          ip: actor.ip ?? null,
        },
        manager,
      );
    });
    void this.nats.publishSafe(NatsSubjects.walletUnlinked, { userId, walletId: wallet.id });
  }

  /**
   * §8.2: under `lock:deposit:<userId>`, re-read the ledger and succeed only while the user has NO
   * UserWallet on-ledger, no queued payouts and no deposit credit in flight. The primary is
   * therefore permanent once a deposit exists.
   */
  async setPrimary(userId: string, walletId: string, actor: Actor): Promise<WalletEntity> {
    const lock = await this.redis.acquireLock(
      `lock:deposit:${userId}`,
      this.config.depositLockTtlMs,
    );
    if (!lock.acquired)
      throw new ApiError(
        409,
        "deposit_in_progress",
        "a deposit reconciliation is in progress; try again shortly",
      );
    try {
      const wallet = await this.wallets.findOne({ where: { id: walletId, userId } });
      if (!wallet) throw new ApiError(404, "not_found", "wallet not found");
      if (wallet.status !== "active")
        throw new ApiError(
          409,
          "primary_wallet_in_use",
          "a revoked wallet cannot become primary; relink it first",
        );

      const user = await this.users.findById(userId);
      if (!user) throw new ApiError(404, "not_found", "user not found");
      if (user.status !== "active")
        throw new ApiError(403, "user_suspended", "this account is suspended");
      if (wallet.isPrimary && user.partyId === wallet.partyId) return wallet;

      if (user.partyId) {
        // Any instrument: a TRO rewards wallet pins the primary as much as a collateral one does.
        const onLedger = await this.ledger.fetchUserWallets(user.partyId, { uncached: true });
        if (onLedger.length > 0) {
          throw new ApiError(
            409,
            "primary_wallet_in_use",
            "the primary wallet already owns an on-ledger in-app balance and is permanent",
            {
              primaryPartyId: user.partyId,
              instruments: onLedger.map((w) => w.instrument),
            },
          );
        }
        const pending = await this.ledger.fetchPendingPayouts({ uncached: true });
        if (pending.some((p) => p.user === user.partyId)) {
          throw new ApiError(
            409,
            "primary_wallet_in_use",
            "payouts addressed to the primary wallet are still pending",
          );
        }
      }
      const pinned = await this.dataSource
        .getRepository(PayoutEntity)
        .count({ where: { userId, status: In([...PAYOUT_PINNING_STATUSES]) } });
      if (pinned > 0)
        throw new ApiError(
          409,
          "primary_wallet_in_use",
          "payouts addressed to the primary wallet are still queued",
        );
      const inFlight = await this.dataSource
        .getRepository(DepositCreditEntity)
        .count({ where: { userId, status: "submitted" } });
      if (inFlight > 0)
        throw new ApiError(409, "deposit_in_progress", "a deposit credit is still being confirmed");

      const from = user.partyId;
      const updated = await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(WalletEntity);
        await repo
          .createQueryBuilder()
          .update(WalletEntity)
          .set({ isPrimary: false })
          .where("user_id = :userId AND is_primary = true", { userId })
          .execute();
        await repo.update({ id: wallet.id }, { isPrimary: true });
        await this.users.setPrimaryParty(userId, wallet.partyId, manager);
        await this.audit.record(
          {
            actorType: actor.type,
            actorUserId: actor.userId ?? null,
            actorSessionId: actor.sessionId ?? null,
            action: "wallet.primary_changed",
            subjectType: "wallet",
            subjectId: wallet.id,
            metadata: { userId, from, to: wallet.partyId },
            ip: actor.ip ?? null,
          },
          manager,
        );
        return (await repo.findOne({ where: { id: wallet.id } })) ?? { ...wallet, isPrimary: true };
      });
      void this.nats.publishSafe(NatsSubjects.walletPrimaryChanged, {
        userId,
        walletId: wallet.id,
        from,
        to: wallet.partyId,
      });
      return updated;
    } finally {
      await lock.release();
    }
  }

  /**
   * `ownLedgerWallets` per row: a NON-primary party's own on-ledger UserWallets, one per instrument
   * (kept by that party, never folded into the primary — §8.1). One ledger read serves every row.
   */
  async ownLedgerWallets(
    wallets: WalletEntity[],
    primaryPartyId: string | null,
    opts: { uncached?: boolean } = {},
  ): Promise<Map<string, LedgerWallet[]>> {
    const out = new Map<string, LedgerWallet[]>();
    if (wallets.length === 0) return out;
    const byOwner = new Map<string, LedgerWallet[]>();
    try {
      for (const w of await this.ledger.fetchAllUserWallets(opts)) {
        byOwner.set(w.owner, [...(byOwner.get(w.owner) ?? []), w]);
      }
    } catch (err) {
      // A degraded ledger read must not hide the wallet list itself.
      this.logger.warn(`ledger read for ownLedgerWallets failed: ${(err as Error).message}`);
    }
    for (const w of wallets) {
      out.set(w.id, w.partyId === primaryPartyId ? [] : (byOwner.get(w.partyId) ?? []));
    }
    return out;
  }

  /** The per-instrument attribution rows of many wallets (`to_wallet_credits`), keyed by wallet id. */
  async creditsFor(walletIds: string[]): Promise<Map<string, WalletCreditEntity[]>> {
    const out = new Map<string, WalletCreditEntity[]>();
    if (walletIds.length === 0) return out;
    const rows = await this.credits.find({
      where: { walletId: In(walletIds) },
      order: { instrumentId: "ASC" },
    });
    for (const r of rows) out.set(r.walletId, [...(out.get(r.walletId) ?? []), r]);
    return out;
  }

  /** One wallet's credit in one instrument (0n without a row). */
  async creditOf(walletId: string, instrument: InstrumentId): Promise<bigint> {
    const row = await this.credits.findOneBy({
      walletId,
      instrumentAdmin: instrument.admin,
      instrumentId: instrument.id,
    });
    return row?.credited ?? 0n;
  }

  /** `GET /wallets`, `GET /me`, the admin detail: every row shaped with its credits and own ledger wallets. */
  async toApiMany(rows: WalletEntity[], primaryPartyId: string | null): Promise<ApiWallet[]> {
    const [own, credits] = await Promise.all([
      this.ownLedgerWallets(rows, primaryPartyId),
      this.creditsFor(rows.map((w) => w.id)),
    ]);
    return rows.map((w) =>
      this.toApi(w, { ownLedgerWallets: own.get(w.id) ?? [], credits: credits.get(w.id) ?? [] }),
    );
  }

  toApi(wallet: WalletEntity, extras: WalletExtras = {}): ApiWallet {
    return walletToApi(wallet, extras, (i) => this.instruments.refOf(i));
  }

  /** One row with its credits and NO ledger read — the link / primary responses (linking never touches the ledger, §8.1). */
  async toApiWithCredits(wallet: WalletEntity): Promise<ApiWallet> {
    const credits = await this.creditsFor([wallet.id]);
    return this.toApi(wallet, { credits: credits.get(wallet.id) ?? [] });
  }

  ledgerWalletToApi(wallet: LedgerWallet): ApiLedgerWallet {
    return ledgerWalletToApi(wallet, (i) => this.instruments.refOf(i));
  }
}

function clipLabel(label: string | null): string | null {
  if (label === null) return null;
  const trimmed = String(label).trim();
  return trimmed ? trimmed.slice(0, 64) : null;
}
