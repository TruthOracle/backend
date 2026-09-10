/**
 * In-memory stand-ins for the three upstreams (docs/INTERNALS.md "Test helpers"). They are
 * registered with `overrideProvider(<RealService>).useValue(<fake>)`, so they mirror the public
 * surface other services call — not the private HTTP plumbing.
 */
import type { ConsumedMessage, ConsumeHandler } from "../../src/services/nats.service";
import { totalReceivedFrom } from "../../src/services/enterprise-wallet.service";
import type {
  ApplicantSummary,
  KycEvent,
  KycProvider,
  KycProviderName,
  KycSessionResult,
  LedgerWallet,
  PendingPayoutRecord,
  TransferRow,
} from "../../src/types";
import { ApiError } from "../../src/util/errors";
import { asString } from "../../src/util/strings";
import { formatCC, parseCC } from "../../src/util/money";

// ---------------------------------------------------------------------------------------------
// NATS
// ---------------------------------------------------------------------------------------------

export interface PublishedEvent {
  subject: string;
  payload: unknown;
  msgId?: string;
}

/** NATS subject wildcards: `*` = one token, `>` = the rest. */
export function subjectMatches(filter: string, subject: string): boolean {
  const f = filter.split(".");
  const s = subject.split(".");
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (f[i] !== "*" && f[i] !== s[i]) return false;
  }
  return f.length === s.length;
}

export class FakeNatsService {
  readonly streamName = "TRUTHORACLE_TEST";
  readonly published: PublishedEvent[] = [];
  readonly consumers: { durable: string; filterSubject: string; handler: ConsumeHandler }[] = [];

  isConnected(): boolean {
    return true;
  }

  async publish(subject: string, payload: object, opts?: { msgId?: string }): Promise<void> {
    this.published.push({ subject, payload, msgId: opts?.msgId });
  }

  async consume(durable: string, filterSubject: string, handler: ConsumeHandler): Promise<void> {
    if (this.consumers.some((c) => c.durable === durable)) return;
    this.consumers.push({ durable, filterSubject, handler });
  }

  /** Deliver a message to every registered consumer whose filter matches; returns the outcomes. */
  async dispatch(subject: string, payload: unknown): Promise<("ack" | "nak" | "term")[]> {
    const outcomes: ("ack" | "nak" | "term")[] = [];
    for (const c of this.consumers) {
      if (!subjectMatches(c.filterSubject, subject)) continue;
      let outcome: "ack" | "nak" | "term" = "ack";
      const msg: ConsumedMessage = {
        subject,
        data: payload,
        redelivered: false,
        ack: () => {
          outcome = "ack";
        },
        nak: () => {
          outcome = "nak";
        },
        term: () => {
          outcome = "term";
        },
      };
      try {
        await c.handler(msg);
      } catch {
        outcome = "nak";
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  publishedOn(subject: string): PublishedEvent[] {
    return this.published.filter((p) => p.subject === subject);
  }

  reset(): void {
    this.published.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

export class FakeLedgerClient {
  /** owner party → active UserWallet */
  readonly wallets = new Map<string, LedgerWallet>();
  /** contractId → active PendingPayout */
  readonly payouts = new Map<string, PendingPayoutRecord>();
  readonly archived = new Set<string>();
  private seq = 0;

  isConfigured(): boolean {
    return true;
  }

  templateId(entity: string, module = "Truthoracle"): string {
    return `fakepkg:${module}:${entity}`;
  }

  filterTemplateId(entity: string, module = "Truthoracle"): string {
    return `#truthoracle-test:${module}:${entity}`;
  }

  nextCid(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }

  seedUserWallet(
    owner: string,
    fields: { balanceCC?: bigint | string; depositedCC?: bigint | string; withdrawnCC?: bigint | string; depositRefs?: string[] } = {},
  ): LedgerWallet {
    const wallet: LedgerWallet = {
      contractId: this.nextCid("uw"),
      owner,
      balanceCC: parseCC(fields.balanceCC ?? 0n),
      depositedCC: parseCC(fields.depositedCC ?? 0n),
      withdrawnCC: parseCC(fields.withdrawnCC ?? 0n),
      depositRefs: [...(fields.depositRefs ?? [])],
    };
    this.wallets.set(owner, wallet);
    return wallet;
  }

  seedPendingPayout(fields: { user: string; amountCC: bigint | string; reason: string; marketId?: string }): PendingPayoutRecord {
    const record: PendingPayoutRecord = {
      contractId: this.nextCid("pp"),
      user: fields.user,
      marketId: fields.marketId ?? "1",
      amountCC: parseCC(fields.amountCC),
      reason: fields.reason,
      createdAt: new Date(),
    };
    this.payouts.set(record.contractId, record);
    return record;
  }

  archivePayout(cid: string): void {
    this.payouts.delete(cid);
    this.archived.add(cid);
  }

  walletByCid(cid: string): LedgerWallet | null {
    for (const w of this.wallets.values()) if (w.contractId === cid) return w;
    return null;
  }

  async fetchUserWallet(ownerParty: string): Promise<LedgerWallet | null> {
    const w = this.wallets.get(ownerParty);
    return w ? { ...w, depositRefs: [...w.depositRefs] } : null;
  }

  async fetchAllUserWallets(): Promise<LedgerWallet[]> {
    return [...this.wallets.values()].map((w) => ({ ...w, depositRefs: [...w.depositRefs] }));
  }

  async fetchPendingPayouts(): Promise<PendingPayoutRecord[]> {
    return [...this.payouts.values()].map((p) => ({ ...p }));
  }

  async fetchPendingPayout(cid: string): Promise<PendingPayoutRecord | null> {
    const p = this.payouts.get(cid);
    return p ? { ...p } : null;
  }

  async activeContracts(_party: string, entity: string): Promise<{ contractId: string; payload: Record<string, unknown> }[]> {
    if (entity === "UserWallet") {
      return [...this.wallets.values()].map((w) => ({
        contractId: w.contractId,
        payload: { owner: w.owner, balanceCC: formatCC(w.balanceCC), depositedCC: formatCC(w.depositedCC), withdrawnCC: formatCC(w.withdrawnCC), depositRefs: w.depositRefs },
      }));
    }
    if (entity === "PendingPayout") {
      return [...this.payouts.values()].map((p) => ({
        contractId: p.contractId,
        payload: { user: p.user, marketId: p.marketId, amountCC: formatCC(p.amountCC), reason: p.reason },
      }));
    }
    return [];
  }

  reset(): void {
    this.wallets.clear();
    this.payouts.clear();
    this.archived.clear();
    this.seq = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Enterprise Wallet
// ---------------------------------------------------------------------------------------------

const NEVER_HAPPENED = new Set(["failed", "rejected", "error", "cancelled", "canceled", "not_found", "notfound"]);

export interface RecordedSubmit {
  commandId: string;
  commands: unknown[];
}

export interface RecordedTransfer {
  to: string;
  amountCC: bigint;
  reason: string;
  commandId: string;
  metadata?: Record<string, string>;
}

/**
 * Applies treasury-signed commands to the FakeLedgerClient the way the real ledger would
 * (Deposit / Create UserWallet / SettleToWallet / MarkPaid), records every submit and transfer,
 * and dedups on commandId. Toggle `statusReadsFail` to exercise the fail-closed paths.
 */
export class FakeEnterpriseWallet {
  readonly rows: TransferRow[] = [];
  readonly submits: RecordedSubmit[] = [];
  readonly transfers: RecordedTransfer[] = [];
  readonly statuses = new Map<string, string>();
  statusReadsFail = false;
  /** Set to make the next externalSubmit / transfer throw (then cleared). */
  failNext: Error | null = null;
  private tick = 0;

  constructor(
    readonly ledger: FakeLedgerClient,
    readonly treasury: string,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  seedInbound(fromParty: string, amountCC: bigint | string, status = "completed", extra: Partial<TransferRow> = {}): TransferRow {
    this.tick += 1;
    const row: TransferRow = {
      instrumentId: "Amulet",
      status,
      direction: "in",
      partyId: this.treasury,
      partyId2: fromParty,
      amount: formatCC(parseCC(amountCC)),
      timestamp: new Date(Date.UTC(2026, 0, 1) + this.tick * 1000).toISOString(),
      ...extra,
    };
    this.rows.unshift(row);
    return row;
  }

  async transferHistory(partyId: string): Promise<TransferRow[]> {
    return this.rows.filter((r) => r.partyId === partyId || r.partyId2 === partyId).map((r) => ({ ...r }));
  }

  totalReceivedFrom(rows: TransferRow[], partyId: string, counterparty: string): bigint {
    return totalReceivedFrom(rows, partyId, counterparty);
  }

  async transferStatus(_partyId: string, commandId: string): Promise<{ known: boolean; submitted: boolean; status: string | null }> {
    if (this.statusReadsFail) return { known: false, submitted: false, status: null };
    const status = this.statuses.get(commandId);
    if (status === undefined) return { known: true, submitted: false, status: "not_found" };
    return { known: true, submitted: !NEVER_HAPPENED.has(status), status };
  }

  async transferAlreadySubmitted(partyId: string, commandId: string): Promise<{ known: boolean; submitted: boolean }> {
    const { known, submitted } = await this.transferStatus(partyId, commandId);
    return { known, submitted };
  }

  async externalSubmit(args: { commandId: string; commands: unknown[]; disclosedContracts?: unknown[] }): Promise<{ commandId: string; status: string }> {
    this.consumeFailNext();
    if (this.statuses.has(args.commandId)) {
      throw new ApiError(502, "upstream_failed", `DUPLICATE_COMMAND ${args.commandId}`, { upstreamStatus: 409 });
    }
    for (const command of args.commands) this.apply(command);
    this.submits.push({ commandId: args.commandId, commands: args.commands });
    this.statuses.set(args.commandId, "completed");
    return { commandId: args.commandId, status: "completed" };
  }

  async transfer(args: { to: string; amountCC: bigint; reason: string; commandId: string; metadata?: Record<string, string> }): Promise<{ commandId: string; status: string }> {
    this.consumeFailNext();
    if (this.statuses.has(args.commandId)) {
      throw new ApiError(502, "upstream_failed", `DUPLICATE_COMMAND ${args.commandId}`, { upstreamStatus: 409 });
    }
    this.transfers.push({ ...args });
    this.statuses.set(args.commandId, "completed");
    this.tick += 1;
    this.rows.unshift({
      instrumentId: "Amulet",
      status: "completed",
      direction: "out",
      partyId: this.treasury,
      partyId2: args.to,
      amount: formatCC(args.amountCC),
      commandId: args.commandId,
      timestamp: new Date(Date.UTC(2026, 0, 1) + this.tick * 1000).toISOString(),
    });
    return { commandId: args.commandId, status: "completed" };
  }

  reset(): void {
    this.rows.length = 0;
    this.submits.length = 0;
    this.transfers.length = 0;
    this.statuses.clear();
    this.statusReadsFail = false;
    this.failNext = null;
    this.tick = 0;
  }

  private consumeFailNext(): void {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  private apply(command: unknown): void {
    const c = command as {
      CreateCommand?: { templateId: string; createArguments: Record<string, unknown> };
      ExerciseCommand?: { templateId: string; contractId: string; choice: string; choiceArgument: Record<string, unknown> };
    };
    if (c.CreateCommand) {
      const { templateId, createArguments: a } = c.CreateCommand;
      if (!templateId.endsWith(":UserWallet")) throw new Error(`fake ledger: cannot create ${templateId}`);
      const owner = asString(a.owner);
      if (this.ledger.wallets.has(owner)) throw new Error(`fake ledger: UserWallet already exists for ${owner}`);
      this.ledger.seedUserWallet(owner, {
        balanceCC: asString(a.balanceCC, "0"),
        depositedCC: asString(a.depositedCC, "0"),
        withdrawnCC: asString(a.withdrawnCC, "0"),
        depositRefs: Array.isArray(a.depositRefs) ? a.depositRefs.map(String) : [],
      });
      return;
    }
    if (c.ExerciseCommand) {
      const { contractId, choice, choiceArgument: arg } = c.ExerciseCommand;
      if (choice === "Deposit") {
        const wallet = this.ledger.walletByCid(contractId);
        if (!wallet) throw new Error(`fake ledger: CONTRACT_NOT_ACTIVE ${contractId}`);
        const amount = parseCC(asString(arg.amountCC, "0"));
        this.ledger.wallets.set(wallet.owner, {
          ...wallet,
          contractId: this.ledger.nextCid("uw"),
          balanceCC: wallet.balanceCC + amount,
          depositedCC: wallet.depositedCC + amount,
          depositRefs: [...wallet.depositRefs, asString(arg.txRef)],
        });
        return;
      }
      if (choice === "MarkPaid") {
        if (!this.ledger.payouts.has(contractId)) throw new Error(`fake ledger: CONTRACT_NOT_ACTIVE ${contractId}`);
        this.ledger.archivePayout(contractId);
        return;
      }
      if (choice === "SettleToWallet") {
        const payout = this.ledger.payouts.get(contractId);
        if (!payout) throw new Error(`fake ledger: CONTRACT_NOT_ACTIVE ${contractId}`);
        const wallet = this.ledger.walletByCid(asString(arg.walletCid));
        if (!wallet) throw new Error(`fake ledger: CONTRACT_NOT_ACTIVE ${asString(arg.walletCid)}`);
        this.ledger.wallets.set(wallet.owner, { ...wallet, contractId: this.ledger.nextCid("uw"), balanceCC: wallet.balanceCC + payout.amountCC });
        this.ledger.archivePayout(contractId);
        return;
      }
      throw new Error(`fake ledger: unsupported choice ${choice}`);
    }
    throw new Error("fake ledger: unrecognised command shape");
  }
}

// ---------------------------------------------------------------------------------------------
// KYC provider (optional)
// ---------------------------------------------------------------------------------------------

export class FakeKycProvider implements KycProvider {
  readonly name: KycProviderName;
  readonly applicants = new Map<string, ApplicantSummary>();
  readonly sessions: { userId: string; applicantId: string | null; level: string }[] = [];
  nextEvent: KycEvent | null = null;
  private seq = 0;

  constructor(name: KycProviderName = "sumsub") {
    this.name = name;
  }

  async createSession(user: { id: string }, applicantId: string | null, level: string): Promise<KycSessionResult> {
    this.seq += 1;
    this.sessions.push({ userId: user.id, applicantId, level });
    return { accessToken: `fake-token-${this.seq}`, expiresAt: new Date(Date.now() + 600_000), applicantId: applicantId ?? `applicant-${user.id}` };
  }

  verifyWebhook(): KycEvent | null {
    return this.nextEvent;
  }

  async fetchApplicant(applicantId: string): Promise<ApplicantSummary> {
    const a = this.applicants.get(applicantId);
    if (!a) throw new ApiError(502, "upstream_failed", "fake provider: unknown applicant");
    return a;
  }

  reset(): void {
    this.applicants.clear();
    this.sessions.length = 0;
    this.nextEvent = null;
  }
}
