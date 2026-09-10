import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, type EntityManager, In, Repository } from "typeorm";

import { Config } from "../config";
import { AuthIdentityEntity } from "../entities/auth-identity.entity";
import { DepositCreditEntity } from "../entities/deposit-credit.entity";
import { PayoutEntity } from "../entities/payout.entity";
import { UserEntity } from "../entities/user.entity";
import { WalletEntity } from "../entities/wallet.entity";
import {
  type Actor,
  type ApiLedgerWallet,
  type ApiWallet,
  type LedgerWallet,
  NatsSubjects,
  WALLET_KIND_ALLOWLIST,
  type WalletKind,
} from "../types";
import { partyHint } from "../util/canton-crypto";
import { ApiError } from "../util/errors";
import { formatCC } from "../util/money";
import { AuditService } from "./audit.service";
import { IdentityService } from "./identity.service";
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
  identity: AuthIdentityEntity;
  seededLegacyCreditedCC: bigint;
}

/** Wire shape of an on-ledger UserWallet (docs/API.md `LedgerWallet`). */
export function ledgerWalletToApi(wallet: LedgerWallet): ApiLedgerWallet {
  return {
    contractId: wallet.contractId,
    owner: wallet.owner,
    balanceCC: formatCC(wallet.balanceCC),
    depositedCC: formatCC(wallet.depositedCC),
    withdrawnCC: formatCC(wallet.withdrawnCC),
  };
}

/** Wire shape of a wallet row (docs/API.md `Wallet`); `receivedCC` only when the caller computed it. */
export function walletToApi(
  wallet: WalletEntity,
  extras: { ownLedgerWallet?: LedgerWallet | null; receivedCC?: bigint } = {},
): ApiWallet {
  const api: ApiWallet = {
    id: wallet.id,
    chain: "canton",
    kind: wallet.kind,
    partyId: wallet.partyId,
    label: wallet.label,
    isPrimary: wallet.isPrimary,
    status: wallet.status,
    verifiedAt: wallet.verifiedAt.toISOString(),
    creditedCC: formatCC(wallet.creditedCC),
    legacyCreditedCC: formatCC(wallet.legacyCreditedCC),
    ownLedgerWallet: extras.ownLedgerWallet ? ledgerWalletToApi(extras.ownLedgerWallet) : null,
  };
  if (extras.receivedCC !== undefined) api.receivedCC = formatCC(extras.receivedCC);
  return api;
}

/**
 * Wallet linking and the primary-wallet rules (docs/ARCHITECTURE.md §8.1–8.2).
 *
 * A party is bound to its first account forever: any `to_wallets` row (active or revoked) under
 * another user refuses the link (`409 wallet_already_linked`); a row under this user is
 * reactivated, never re-inserted, with `credited_cc` / `legacy_credited_cc` untouched. The
 * `canton_wallet` identity is created / reactivated through IdentityService so the §6 rules
 * (one identity ↔ one account, unlinked = revoked, KYC lock, last identity) apply on both the
 * identity and the wallet route.
 */
@Injectable()
export class WalletLinkService {
  private readonly logger = new Logger(WalletLinkService.name);

  constructor(
    private readonly config: Config,
    private readonly dataSource: DataSource,
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
    private readonly users: UserService,
    private readonly identities: IdentityService,
    private readonly ledger: LedgerClientService,
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

  /**
   * §8.1. `verified` comes from WalletChallengeService.verify (never from the client). The seed
   * is read from the ledger BEFORE any write so an upstream failure changes nothing.
   */
  async link(userId: string, verified: VerifiedWallet, opts: { label?: string | null; actor: Actor }): Promise<LinkResult> {
    const partyId = verified.partyId.trim();
    if (!WALLET_KIND_ALLOWLIST.includes(verified.kind)) {
      throw new ApiError(400, "validation_failed", `wallet kind ${verified.kind} is not supported`);
    }
    if (this.config.treasuryPartyId && partyId === this.config.treasuryPartyId) {
      throw new ApiError(400, "validation_failed", "the treasury party cannot be linked as a user wallet");
    }

    const existing = await this.wallets.findOne({ where: { partyId } });
    if (existing && existing.userId !== userId) {
      throw new ApiError(409, "wallet_already_linked", "this wallet is linked to another account");
    }
    const wasRevoked = existing?.status === "revoked";

    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(404, "not_found", "user not found");
    if (user.status !== "active") throw new ApiError(403, "user_suspended", "this account is suspended");

    // Seed on first link only: the immutable legacy_credited_cc = the party's own on-ledger
    // depositedCC (deposits credited before the account existed). Relinks keep the stored seed.
    let seed = existing ? existing.legacyCreditedCC : 0n;
    let seededFromLedger = false;
    if (!existing) {
      const own = await this.ledger.fetchUserWallet(partyId, { uncached: true });
      seed = own?.depositedCC ?? 0n;
      seededFromLedger = own !== null;
    }

    // Identity rules (§6) — link mode for the current user. A canton_wallet identity that
    // belongs to another account (active or unlinked) surfaces as wallet_already_linked here.
    let identity: AuthIdentityEntity;
    try {
      const resolution = await this.identities.resolveForLogin(
        { provider: "canton_wallet", subject: partyId, profile: { name: partyHint(partyId) } },
        { currentUser: user, ip: opts.actor.ip ?? null, sessionId: opts.actor.sessionId ?? null },
      );
      identity = resolution.identity;
    } catch (err) {
      if (ApiError.is(err) && (err.code === "identity_already_linked" || err.code === "identity_unlinked")) {
        throw new ApiError(409, "wallet_already_linked", "this wallet is linked to another account");
      }
      throw err;
    }

    const now = new Date();
    const label = opts.label === undefined ? undefined : clipLabel(opts.label);
    const actor = opts.actor;

    const wallet = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WalletEntity);
      const fresh = await manager.getRepository(UserEntity).findOne({ where: { id: userId } });
      if (!fresh) throw new ApiError(404, "not_found", "user not found");
      const currentPrimary = await repo.findOne({ where: { userId, isPrimary: true, status: "active" } });

      // The first wallet becomes primary and sets users.party_id (§7.3); a party that IS
      // users.party_id is the primary by definition (relink of the primary after an admin unlink).
      const makePrimary = fresh.partyId === partyId || (!fresh.partyId && !currentPrimary);

      let row = await repo.findOne({ where: { partyId } });
      if (row) {
        if (row.userId !== userId) throw new ApiError(409, "wallet_already_linked", "this wallet is linked to another account");
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
          legacyCreditedCC: seed,
          creditedCC: 0n,
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
            metadata: { userId, partyId, kind: verified.kind, isPrimary: makePrimary, identityId: identity.id },
            ip: actor.ip ?? null,
          },
          manager,
        );
        await this.audit.record(
          {
            actorType: actor.type,
            actorUserId: actor.userId ?? null,
            actorSessionId: actor.sessionId ?? null,
            action: "wallet.legacy_seeded",
            subjectType: "wallet",
            subjectId: row.id,
            metadata: { userId, partyId, legacyCreditedCC: formatCC(seed), hadLedgerWallet: seededFromLedger },
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

    void this.publish(NatsSubjects.walletLinked, { userId, walletId: wallet.id, identityId: identity.id, relinked: Boolean(existing) });
    return { wallet, identity, seededLegacyCreditedCC: wallet.legacyCreditedCC };
  }

  /**
   * §8.1 / §6.5: unlink goes through IdentityService.unlink (last_identity, identity_locked_by_kyc)
   * which also revokes the wallet row; the primary is refused while users.party_id points at it.
   */
  async unlink(userId: string, walletId: string, actor: Actor): Promise<void> {
    const wallet = await this.wallets.findOne({ where: { id: walletId, userId } });
    if (!wallet || wallet.status !== "active") throw new ApiError(404, "not_found", "wallet not found");

    const user = await this.users.findById(userId);
    if (user?.partyId && user.partyId === wallet.partyId) {
      throw new ApiError(409, "primary_wallet_in_use", "the primary wallet owns the in-app balance and cannot be unlinked");
    }

    const identity = await this.identities.findByProviderSubject("canton_wallet", wallet.partyId);
    if (identity && identity.userId === userId && identity.status === "active") {
      await this.identities.unlink(userId, identity.id, actor);
    }
    // IdentityService.unlink revokes the row in its transaction; this covers a row whose identity
    // was already unlinked (e.g. seeded directly) and is a no-op otherwise.
    await this.wallets.update({ id: walletId, status: "active" }, { status: "revoked", isPrimary: false, revokedAt: new Date() });

    await this.audit.record({
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      actorSessionId: actor.sessionId ?? null,
      action: "wallet.unlinked",
      subjectType: "wallet",
      subjectId: wallet.id,
      metadata: { userId, partyId: wallet.partyId, identityId: identity?.id ?? null },
      ip: actor.ip ?? null,
    });
    void this.publish(NatsSubjects.walletUnlinked, { userId, walletId: wallet.id, identityId: identity?.id ?? null });
  }

  /**
   * §8.2: under `lock:deposit:<userId>`, re-read the ledger and succeed only while the user has NO
   * UserWallet on-ledger, no queued payouts and no deposit credit in flight. The primary is
   * therefore permanent once a deposit exists.
   */
  async setPrimary(userId: string, walletId: string, actor: Actor): Promise<WalletEntity> {
    const lock = await this.redis.acquireLock(`lock:deposit:${userId}`, this.config.depositLockTtlMs);
    if (!lock.acquired) throw new ApiError(409, "deposit_in_progress", "a deposit reconciliation is in progress; try again shortly");
    try {
      const wallet = await this.wallets.findOne({ where: { id: walletId, userId } });
      if (!wallet) throw new ApiError(404, "not_found", "wallet not found");
      if (wallet.status !== "active") throw new ApiError(409, "primary_wallet_in_use", "a revoked wallet cannot become primary; relink it first");

      const user = await this.users.findById(userId);
      if (!user) throw new ApiError(404, "not_found", "user not found");
      if (user.status !== "active") throw new ApiError(403, "user_suspended", "this account is suspended");
      if (wallet.isPrimary && user.partyId === wallet.partyId) return wallet;

      if (user.partyId) {
        const onLedger = await this.ledger.fetchUserWallet(user.partyId, { uncached: true });
        if (onLedger) {
          throw new ApiError(409, "primary_wallet_in_use", "the primary wallet already owns an on-ledger in-app balance and is permanent", {
            primaryPartyId: user.partyId,
          });
        }
        const pending = await this.ledger.fetchPendingPayouts({ uncached: true });
        if (pending.some((p) => p.user === user.partyId)) {
          throw new ApiError(409, "primary_wallet_in_use", "payouts addressed to the primary wallet are still pending");
        }
      }
      const pinned = await this.dataSource
        .getRepository(PayoutEntity)
        .count({ where: { userId, status: In([...PAYOUT_PINNING_STATUSES]) } });
      if (pinned > 0) throw new ApiError(409, "primary_wallet_in_use", "payouts addressed to the primary wallet are still queued");
      const inFlight = await this.dataSource.getRepository(DepositCreditEntity).count({ where: { userId, status: "submitted" } });
      if (inFlight > 0) throw new ApiError(409, "deposit_in_progress", "a deposit credit is still being confirmed");

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
      void this.publish(NatsSubjects.walletPrimaryChanged, { userId, walletId: wallet.id, from, to: wallet.partyId });
      return updated;
    } finally {
      await lock.release();
    }
  }

  /**
   * `ownLedgerWallet` per row: a NON-primary party's own on-ledger UserWallet (kept by that party,
   * never folded into the primary — §8.1). One ledger read serves every row.
   */
  async ownLedgerWallets(
    wallets: WalletEntity[],
    primaryPartyId: string | null,
    opts: { uncached?: boolean } = {},
  ): Promise<Map<string, LedgerWallet | null>> {
    const out = new Map<string, LedgerWallet | null>();
    if (wallets.length === 0) return out;
    let byOwner = new Map<string, LedgerWallet>();
    try {
      const all = await this.ledger.fetchAllUserWallets(opts);
      byOwner = new Map(all.map((w) => [w.owner, w]));
    } catch (err) {
      // A degraded ledger read must not hide the wallet list itself.
      this.logger.warn(`ledger read for ownLedgerWallet failed: ${(err as Error).message}`);
    }
    for (const w of wallets) {
      out.set(w.id, w.partyId === primaryPartyId ? null : (byOwner.get(w.partyId) ?? null));
    }
    return out;
  }

  toApi(wallet: WalletEntity, extras?: { ownLedgerWallet?: LedgerWallet | null; receivedCC?: bigint }): ApiWallet {
    return walletToApi(wallet, extras ?? {});
  }

  private async publish(subject: `truthoracle.${string}`, payload: object): Promise<void> {
    try {
      await this.nats.publish(subject, payload);
    } catch (err) {
      this.logger.warn(`publish ${subject} failed: ${(err as Error).message}`);
    }
  }
}

function clipLabel(label: string | null): string | null {
  if (label === null) return null;
  const trimmed = String(label).trim();
  return trimmed ? trimmed.slice(0, 64) : null;
}

/** Test/diagnostic helper — the manager form of `findById` for composing packages. */
export async function findWalletForUpdate(manager: EntityManager, walletId: string): Promise<WalletEntity | null> {
  return manager.getRepository(WalletEntity).findOne({ where: { id: walletId }, lock: { mode: "pessimistic_write" } });
}
