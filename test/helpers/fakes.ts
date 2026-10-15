/**
 * In-memory stand-ins for the three upstreams (docs/INTERNALS.md "Test helpers"). They are
 * registered with `overrideProvider(<RealService>).useValue(<fake>)`, so they mirror the public
 * surface other services call — not the private HTTP plumbing.
 */
import type { InstrumentEntity } from "../../src/entities/instrument.entity";
import type { ActiveContractEntry, LedgerTransaction } from "../../src/indexer/events";
import type { ConsumedMessage, ConsumeHandler } from "../../src/services/nats.service";
import { walletCreateCommandIdFor } from "../../src/services/ledger-client.service";
import {
  type ApplicantSummary,
  instrumentKey,
  type InstrumentId,
  type KycEvent,
  type KycProvider,
  type KycProviderHealth,
  type KycProviderName,
  type KycSessionResult,
  type LedgerWallet,
  type PendingPayoutRecord,
  type RegistryChoiceContext,
  type RegistryTransferFactory,
  sameInstrument,
  type TokenAppBatchRequest,
  type TokenAppBatchResult,
  type TokenAppCommandResult,
  type TokenAppHolding,
  type TokenAppMintRequest,
  type TokenAppRecord,
  type TokenAppStatus,
} from "../../src/types";
import { ApiError } from "../../src/util/errors";
import { asString } from "../../src/util/strings";
import { formatAmount, parseAmount } from "../../src/util/money";

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

  async publishSafe(subject: string, payload: object, opts?: { msgId?: string }): Promise<void> {
    await this.publish(subject, payload, opts);
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

/** `<owner>|<admin>:<id>` — the fake's wallet key: one UserWallet per (owner, instrument), like the ledger. */
export function walletKeyOf(owner: string, instrument: InstrumentId): string {
  return `${owner}|${instrumentKey(instrument)}`;
}

/**
 * In-memory ledger (UserWallets keyed by owner + instrument, PendingPayouts by cid). Every read is
 * recorded in `reads` (`"fetchUserWallet:<party>"`, `"fetchAllUserWallets"`, `"fetchPendingPayouts"`,
 * `"fetchPendingPayout:<cid>"`) so specs can assert a route never touched the ledger; `failReads`
 * makes every read throw (the ledger / its Keycloak being down). `defaultInstrument` (the test
 * env's collateral) is what `seedUserWallet` / `seedPendingPayout` use when a spec names none.
 */
export class FakeLedgerClient {
  /** `walletKeyOf(owner, instrument)` → active UserWallet */
  readonly wallets = new Map<string, LedgerWallet>();
  /** contractId → active PendingPayout */
  readonly payouts = new Map<string, PendingPayoutRecord>();
  readonly archived = new Set<string>();
  /** Every read made through this fake, in order. */
  readonly reads: string[] = [];
  /** When set, every read throws it (nothing is recorded as read); use an `ApiError(502, "upstream_failed")` to mirror the real client. */
  failReads: Error | null = null;
  readonly defaultInstrument: InstrumentId;
  private seq = 0;

  constructor(defaultInstrument: InstrumentId) {
    this.defaultInstrument = { admin: defaultInstrument.admin, id: defaultInstrument.id };
  }

  isConfigured(): boolean {
    return true;
  }

  templateId(entity: string, module = "Truthoracle"): string {
    return `fakepkg:${module}:${entity}`;
  }

  filterTemplateId(entity: string, module = "Truthoracle"): string {
    return `#truthoracle-test:${module}:${entity}`;
  }

  /** The real id scheme under the test package name, exactly as the real client derives it. */
  walletCreateCommandId(owner: string, instrument: InstrumentId): string {
    return walletCreateCommandIdFor("truthoracle-test", owner, instrument);
  }

  nextCid(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }

  seedUserWallet(
    owner: string,
    fields: {
      balance?: bigint | string;
      deposited?: bigint | string;
      withdrawn?: bigint | string;
      creditRefs?: string[];
      instrument?: InstrumentId;
      auditObservers?: string[];
    } = {},
  ): LedgerWallet {
    const instrument = fields.instrument ?? this.defaultInstrument;
    const wallet: LedgerWallet = {
      contractId: this.nextCid("uw"),
      owner,
      instrument: { admin: instrument.admin, id: instrument.id },
      balance: parseAmount(fields.balance ?? 0n),
      deposited: parseAmount(fields.deposited ?? 0n),
      withdrawn: parseAmount(fields.withdrawn ?? 0n),
      creditRefs: [...(fields.creditRefs ?? [])],
      auditObservers: [...(fields.auditObservers ?? [])],
    };
    this.wallets.set(walletKeyOf(owner, instrument), wallet);
    return wallet;
  }

  /** The owner's active wallet in `instrument` (the default collateral when omitted), without recording a read. */
  walletOf(
    owner: string,
    instrument: InstrumentId = this.defaultInstrument,
  ): LedgerWallet | undefined {
    return this.wallets.get(walletKeyOf(owner, instrument));
  }

  /** Replace the owner's wallet in its instrument (a spec simulating a ledger move). */
  setWallet(wallet: LedgerWallet): void {
    this.wallets.set(walletKeyOf(wallet.owner, wallet.instrument), wallet);
  }

  seedPendingPayout(fields: {
    user: string;
    amount: bigint | string;
    reason: string;
    marketId?: string;
    instrument?: InstrumentId;
  }): PendingPayoutRecord {
    const instrument = fields.instrument ?? this.defaultInstrument;
    const record: PendingPayoutRecord = {
      contractId: this.nextCid("pp"),
      user: fields.user,
      marketId: fields.marketId ?? "1",
      instrument: { admin: instrument.admin, id: instrument.id },
      amount: parseAmount(fields.amount),
      reason: fields.reason,
      createdAt: new Date(),
      auditObservers: [],
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

  /** Reads made to `fetchUserWallet`, as owner parties. */
  fetchUserWalletCalls(): string[] {
    return this.reads
      .filter((r) => r.startsWith("fetchUserWallet:"))
      .map((r) => r.slice("fetchUserWallet:".length));
  }

  private read(what: string): void {
    if (this.failReads) throw this.failReads;
    this.reads.push(what);
  }

  async fetchUserWallet(
    ownerParty: string,
    instrument: InstrumentId,
  ): Promise<LedgerWallet | null> {
    this.read(`fetchUserWallet:${ownerParty}`);
    const w = this.wallets.get(walletKeyOf(ownerParty, instrument));
    return w ? { ...w, creditRefs: [...w.creditRefs] } : null;
  }

  async fetchUserWallets(ownerParty: string): Promise<LedgerWallet[]> {
    this.read(`fetchUserWallets:${ownerParty}`);
    return [...this.wallets.values()]
      .filter((w) => w.owner === ownerParty)
      .map((w) => ({ ...w, creditRefs: [...w.creditRefs] }));
  }

  async fetchAllUserWallets(): Promise<LedgerWallet[]> {
    this.read("fetchAllUserWallets");
    return [...this.wallets.values()].map((w) => ({ ...w, creditRefs: [...w.creditRefs] }));
  }

  async fetchPendingPayouts(): Promise<PendingPayoutRecord[]> {
    this.read("fetchPendingPayouts");
    return [...this.payouts.values()].map((p) => ({ ...p }));
  }

  async fetchPendingPayout(cid: string): Promise<PendingPayoutRecord | null> {
    this.read(`fetchPendingPayout:${cid}`);
    const p = this.payouts.get(cid);
    return p ? { ...p } : null;
  }

  async activeContracts(
    _party: string,
    entity: string,
  ): Promise<{ contractId: string; payload: Record<string, unknown> }[]> {
    this.read(`activeContracts:${entity}`);
    if (entity === "UserWallet") {
      return [...this.wallets.values()].map((w) => ({
        contractId: w.contractId,
        payload: {
          owner: w.owner,
          instrument: { admin: w.instrument.admin, id: w.instrument.id },
          balance: formatAmount(w.balance),
          deposited: formatAmount(w.deposited),
          withdrawn: formatAmount(w.withdrawn),
          creditRefs: w.creditRefs,
          auditObservers: w.auditObservers,
        },
      }));
    }
    if (entity === "PendingPayout") {
      return [...this.payouts.values()].map((p) => ({
        contractId: p.contractId,
        payload: {
          user: p.user,
          marketId: p.marketId,
          instrument: { admin: p.instrument.admin, id: p.instrument.id },
          amount: formatAmount(p.amount),
          reason: p.reason,
          auditObservers: p.auditObservers,
        },
      }));
    }
    return [];
  }

  reset(): void {
    this.wallets.clear();
    this.payouts.clear();
    this.archived.clear();
    this.reads.length = 0;
    this.failReads = null;
    this.seq = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Enterprise Wallet
// ---------------------------------------------------------------------------------------------

const NEVER_HAPPENED = new Set([
  "failed",
  "rejected",
  "error",
  "cancelled",
  "canceled",
  "not_found",
  "notfound",
]);

export interface RecordedSubmit {
  commandId: string;
  commands: unknown[];
  disclosedContracts: unknown[];
}

export interface RecordedTransfer {
  to: string;
  instrumentId: string;
  amount: bigint;
  reason: string;
  commandId: string;
  metadata?: Record<string, string>;
}

/**
 * Applies treasury-signed commands to the FakeLedgerClient the way the real ledger would
 * (Deposit / Create UserWallet / SettleToWallet / MarkPaid), records every submit and transfer,
 * and dedups on commandId. Token-standard exercises (`TransferFactory_Transfer`,
 * `TransferInstruction_Accept`, the factory setup choices) are recorded without being applied:
 * the tokens they move reach the index through FakeLedgerStream, never through this fake. Two
 * status books mirror the real wallet: `statuses` is the TRANSFER index
 * (`/api/v1/transfer/{party}/{commandId}` — only `transfer()` ids live there) and
 * `commandStatuses` the COMMAND index (`/api/v1/command/{party}/{commandId}` — external submits).
 * Toggles: `statusReadsFail` (both reads fail), `unknownCommandIds` (the command index answers
 * 404 for everything, the "not wired through" wallet), `lagLedger` (submits are accepted and
 * recorded but the ledger does not move until `applyPending()`; `rejectPending()` instead marks
 * them failed, the ledger-rejected-after-accept case). There is no history: deposits are read
 * from the ledger index (docs/TOKENS.md §2 decision 5), so specs push transfers through
 * FakeLedgerStream and run the indexer.
 */
export class FakeEnterpriseWallet {
  readonly submits: RecordedSubmit[] = [];
  readonly transfers: RecordedTransfer[] = [];
  /** Transfer index: `transfer()` command ids only. */
  readonly statuses = new Map<string, string>();
  /** Command index: `externalSubmit()` command ids only. */
  readonly commandStatuses = new Map<string, string>();
  statusReadsFail = false;
  unknownCommandIds = false;
  lagLedger = false;
  /** Set to make the next externalSubmit / transfer throw (then cleared). */
  failNext: Error | null = null;
  private readonly pending: RecordedSubmit[] = [];

  constructor(
    readonly ledger: FakeLedgerClient,
    readonly treasury: string,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async transferStatus(
    _partyId: string,
    commandId: string,
  ): Promise<{ known: boolean; submitted: boolean; status: string | null }> {
    if (this.statusReadsFail) return { known: false, submitted: false, status: null };
    const status = this.statuses.get(commandId);
    if (status === undefined) return { known: true, submitted: false, status: "not_found" };
    return { known: true, submitted: !NEVER_HAPPENED.has(status), status };
  }

  async commandStatus(
    _partyId: string,
    commandId: string,
  ): Promise<{ known: boolean; submitted: boolean; status: string | null }> {
    if (this.statusReadsFail) return { known: false, submitted: false, status: null };
    const status = this.unknownCommandIds ? undefined : this.commandStatuses.get(commandId);
    if (status === undefined) return { known: false, submitted: false, status: "not_found" };
    return { known: true, submitted: !NEVER_HAPPENED.has(status), status };
  }

  async externalSubmit(args: {
    commandId: string;
    commands: unknown[];
    disclosedContracts?: unknown[];
  }): Promise<{ commandId: string; status: string }> {
    this.consumeFailNext();
    if (this.commandStatuses.has(args.commandId)) {
      throw new ApiError(502, "upstream_failed", `DUPLICATE_COMMAND ${args.commandId}`, {
        upstreamStatus: 409,
      });
    }
    const submit = {
      commandId: args.commandId,
      commands: args.commands,
      disclosedContracts: args.disclosedContracts ?? [],
    };
    if (this.lagLedger) {
      this.submits.push(submit);
      this.pending.push(submit);
      this.commandStatuses.set(args.commandId, "submitted");
      return { commandId: args.commandId, status: "submitted" };
    }
    for (const command of args.commands) this.apply(command);
    this.submits.push(submit);
    this.commandStatuses.set(args.commandId, "completed");
    return { commandId: args.commandId, status: "completed" };
  }

  /** `lagLedger`: the ledger catches up — every accepted command lands (or is recorded as failed when it cannot). */
  applyPending(): void {
    for (const submit of this.pending.splice(0)) {
      try {
        for (const command of submit.commands) this.apply(command);
        this.commandStatuses.set(submit.commandId, "completed");
      } catch {
        this.commandStatuses.set(submit.commandId, "failed");
      }
    }
  }

  /** `lagLedger`: the ledger rejects every accepted command (stale contract id, assertion) — nothing lands. */
  rejectPending(): void {
    for (const submit of this.pending.splice(0))
      this.commandStatuses.set(submit.commandId, "failed");
  }

  async transfer(args: {
    to: string;
    instrumentId: string;
    amount: bigint;
    reason: string;
    commandId: string;
    metadata?: Record<string, string>;
  }): Promise<{ commandId: string; status: string }> {
    this.consumeFailNext();
    if (this.statuses.has(args.commandId)) {
      throw new ApiError(502, "upstream_failed", `DUPLICATE_COMMAND ${args.commandId}`, {
        upstreamStatus: 409,
      });
    }
    this.transfers.push({ ...args });
    this.statuses.set(args.commandId, "completed");
    return { commandId: args.commandId, status: "completed" };
  }

  reset(): void {
    this.submits.length = 0;
    this.transfers.length = 0;
    this.pending.length = 0;
    this.statuses.clear();
    this.commandStatuses.clear();
    this.statusReadsFail = false;
    this.unknownCommandIds = false;
    this.lagLedger = false;
    this.failNext = null;
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
      ExerciseCommand?: {
        templateId: string;
        contractId: string;
        choice: string;
        choiceArgument: Record<string, unknown>;
      };
    };
    if (c.CreateCommand) {
      const { templateId, createArguments: a } = c.CreateCommand;
      if (!templateId.endsWith(":UserWallet"))
        throw new Error(`fake ledger: cannot create ${templateId}`);
      const owner = asString(a.owner);
      // `instrument : InstrumentId`, `creditRefs : [Text]` and `auditObservers : [Party]` are mandatory
      // on truthoracle-v17: the real ledger rejects a Create without them.
      const inst = (a.instrument ?? {}) as { admin?: unknown; id?: unknown };
      if (!asString(inst.admin) || !asString(inst.id))
        throw new Error("fake ledger: UserWallet.instrument is mandatory ({ admin, id })");
      if (!Array.isArray(a.creditRefs))
        throw new Error("fake ledger: UserWallet.creditRefs is mandatory (missing or not a list)");
      if (!Array.isArray(a.auditObservers))
        throw new Error(
          "fake ledger: UserWallet.auditObservers is mandatory (missing or not a list)",
        );
      const instrument: InstrumentId = { admin: asString(inst.admin), id: asString(inst.id) };
      if (this.ledger.walletOf(owner, instrument))
        throw new Error(`fake ledger: UserWallet already exists for ${owner} in ${instrument.id}`);
      this.ledger.seedUserWallet(owner, {
        instrument,
        balance: asString(a.balance, "0"),
        deposited: asString(a.deposited, "0"),
        withdrawn: asString(a.withdrawn, "0"),
        creditRefs: a.creditRefs.map(String),
        auditObservers: a.auditObservers.map(String),
      });
      return;
    }
    if (c.ExerciseCommand) {
      const { templateId, contractId, choice, choiceArgument: arg } = c.ExerciseCommand;
      if (!templateId.includes(":Truthoracle:")) {
        // An exercise on another package's contract — a token-standard interface choice
        // (TransferFactory_Transfer, TransferInstruction_Accept) or a token factory's setup
        // choice (docs/TOKENS.md §4.4): the tokens it moves reach the index through
        // FakeLedgerStream; the fake wallet only records the accepted command for the spec.
        return;
      }
      if (choice === "Deposit" || choice === "Grant") {
        const wallet = this.ledger.walletByCid(contractId);
        if (!wallet) throw new Error(`fake ledger: CONTRACT_NOT_ACTIVE ${contractId}`);
        const amount = parseAmount(asString(arg.amount, "0"));
        const ref = asString(choice === "Deposit" ? arg.txRef : arg.ref);
        // The Daml refuses a repeated ref — the idempotency the confirm passes key on.
        if (wallet.creditRefs.includes(ref))
          throw new Error(`fake ledger: ${choice} ref already credited (${ref})`);
        this.ledger.setWallet({
          ...wallet,
          contractId: this.ledger.nextCid("uw"),
          balance: wallet.balance + amount,
          // Grant bumps the balance only; Deposit also counts toward lifetime deposits.
          deposited: choice === "Deposit" ? wallet.deposited + amount : wallet.deposited,
          creditRefs: [...wallet.creditRefs, ref],
        });
        return;
      }
      if (choice === "MarkPaid") {
        if (!this.ledger.payouts.has(contractId))
          throw new Error(`fake ledger: CONTRACT_NOT_ACTIVE ${contractId}`);
        this.ledger.archivePayout(contractId);
        return;
      }
      if (choice === "SettleToWallet") {
        const payout = this.ledger.payouts.get(contractId);
        if (!payout) throw new Error(`fake ledger: CONTRACT_NOT_ACTIVE ${contractId}`);
        const wallet = this.ledger.walletByCid(asString(arg.walletCid));
        if (!wallet) throw new Error(`fake ledger: CONTRACT_NOT_ACTIVE ${asString(arg.walletCid)}`);
        // v17 asserts `wallet.instrument == payout.instrument`: a bond cannot land in another token's wallet.
        if (!sameInstrument(wallet.instrument, payout.instrument))
          throw new Error("fake ledger: wallet holds a different instrument than the payout");
        this.ledger.setWallet({
          ...wallet,
          contractId: this.ledger.nextCid("uw"),
          balance: wallet.balance + payout.amount,
        });
        this.ledger.archivePayout(contractId);
        return;
      }
      if (choice === "CreateMarket") {
        // The market itself reaches the index through FakeLedgerStream (docs/MARKETS.md §4); the
        // fake wallet only records that the treasury accepted the exercise.
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
  /** false → the service answers 503 kyc_provider_unavailable. */
  configured = true;
  private seq = 0;

  constructor(name: KycProviderName = "sumsub") {
    this.name = name;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async healthCheck(): Promise<KycProviderHealth> {
    return {
      ok: this.configured,
      message: this.configured ? "fake provider" : "fake provider unconfigured",
      upstreamStatus: null,
      checkedAt: new Date().toISOString(),
      details: {},
    };
  }

  async createSession(
    user: { id: string },
    applicantId: string | null,
    level: string,
  ): Promise<KycSessionResult> {
    this.seq += 1;
    this.sessions.push({ userId: user.id, applicantId, level });
    return {
      accessToken: `fake-token-${this.seq}`,
      expiresAt: new Date(Date.now() + 600_000),
      applicantId: applicantId ?? `applicant-${user.id}`,
    };
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
    this.configured = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Ledger stream (the indexer's source)
// ---------------------------------------------------------------------------------------------

/**
 * In-memory stand-in for LedgerStreamService: `transactions` is the party's stream (push with
 * `push()`), `acs` the snapshot `fetchActiveContracts` serves (or `acsAt(offset)` when set),
 * `pruned` the participant's prune point — a read that starts below it throws the same
 * PARTICIPANT_PRUNED_DATA_ACCESSED error the real participant answers with. `calls` records
 * every read so specs can assert paging and bootstrap behaviour.
 */
export class FakeLedgerStream {
  configured = true;
  pruned = 0;
  /** When set, overrides the ledger end derived from `transactions`. */
  end: number | null = null;
  readonly transactions: LedgerTransaction[] = [];
  acs: ActiveContractEntry[] = [];
  acsAt: ((offset: number) => ActiveContractEntry[]) | null = null;
  readonly calls: string[] = [];
  /** When set, the next `fetchUpdates` throws it (then cleared). */
  failNext: Error | null = null;
  readonly party: string;

  constructor(party: string) {
    this.party = party;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  push(...txs: LedgerTransaction[]): void {
    this.transactions.push(...txs);
    this.transactions.sort((a, b) => a.offset - b.offset);
  }

  async ledgerEnd(): Promise<number> {
    this.calls.push("ledgerEnd");
    if (this.end !== null) return this.end;
    return this.transactions.length > 0
      ? this.transactions[this.transactions.length - 1].offset
      : 0;
  }

  async prunedOffset(): Promise<number> {
    this.calls.push("prunedOffset");
    return this.pruned;
  }

  async fetchUpdates(args: {
    beginExclusive: number;
    endInclusive: number;
    limit: number;
  }): Promise<LedgerTransaction[]> {
    this.calls.push(`fetchUpdates:${args.beginExclusive}:${args.endInclusive}:${args.limit}`);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (args.beginExclusive < this.pruned) {
      throw new Error("PARTICIPANT_PRUNED_DATA_ACCESSED: range starts before the prune point");
    }
    return this.transactions
      .filter((t) => t.offset > args.beginExclusive && t.offset <= args.endInclusive)
      .slice(0, args.limit);
  }

  async fetchActiveContracts(activeAtOffset: number): Promise<ActiveContractEntry[]> {
    this.calls.push(`fetchActiveContracts:${activeAtOffset}`);
    return this.acsAt ? this.acsAt(activeAtOffset) : this.acs;
  }

  reset(): void {
    this.configured = true;
    this.pruned = 0;
    this.end = null;
    this.transactions.length = 0;
    this.acs = [];
    this.acsAt = null;
    this.calls.length = 0;
    this.failNext = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Token registry (CIP-56 off-ledger API)
// ---------------------------------------------------------------------------------------------

export interface RecordedRegistryCall {
  instrument: string;
  kind: "transferFactory" | "accept" | "reject" | "withdraw";
  /** The choice argument of a transfer-factory lookup, the instruction cid otherwise. */
  input: unknown;
}

/**
 * In-memory stand-in for TokenRegistryService: every lookup answers a canned factory / context
 * whose disclosed contracts name the factory with a concrete template (`factoryTemplateId`), and
 * is recorded in `calls`. `failNext` makes the next call throw (a registry down or refusing the
 * client). A fake registry is configured for every instrument that has a registry URL.
 */
export class FakeTokenRegistry {
  readonly calls: RecordedRegistryCall[] = [];
  factoryId = "00factory0001";
  factoryTemplateId = "tokenpkg:TruthOracle.CBYN.Factory:CbynFactory";
  transferKind = "direct";
  failNext: Error | null = null;

  isConfigured(instrument: InstrumentEntity): boolean {
    return Boolean(instrument.registryUrl);
  }

  private context(): RegistryChoiceContext {
    return {
      choiceContextData: {
        values: { tokenConfigCid: { tag: "AV_ContractId", value: "00tokenconfig0001" } },
      },
      disclosedContracts: [
        {
          templateId: this.factoryTemplateId,
          contractId: this.factoryId,
          createdEventBlob: "blob-factory",
          synchronizerId: "sync::test",
        },
        {
          templateId: "tokenpkg:Cantor8.Token.TokenConfig:TokenConfig",
          contractId: "00tokenconfig0001",
          createdEventBlob: "blob-config",
          synchronizerId: "sync::test",
        },
      ],
    };
  }

  private consumeFailNext(): void {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  async transferFactory(
    instrument: InstrumentEntity,
    choiceArguments: Record<string, unknown>,
  ): Promise<RegistryTransferFactory> {
    this.consumeFailNext();
    this.calls.push({ instrument: instrument.id, kind: "transferFactory", input: choiceArguments });
    return {
      factoryId: this.factoryId,
      transferKind: this.transferKind,
      choiceContext: this.context(),
    };
  }

  async acceptContext(instrument: InstrumentEntity, cid: string): Promise<RegistryChoiceContext> {
    this.consumeFailNext();
    this.calls.push({ instrument: instrument.id, kind: "accept", input: cid });
    return this.context();
  }

  async rejectContext(instrument: InstrumentEntity, cid: string): Promise<RegistryChoiceContext> {
    this.consumeFailNext();
    this.calls.push({ instrument: instrument.id, kind: "reject", input: cid });
    return this.context();
  }

  async withdrawContext(instrument: InstrumentEntity, cid: string): Promise<RegistryChoiceContext> {
    this.consumeFailNext();
    this.calls.push({ instrument: instrument.id, kind: "withdraw", input: cid });
    return this.context();
  }

  reset(): void {
    this.calls.length = 0;
    this.failNext = null;
    this.factoryId = "00factory0001";
    this.factoryTemplateId = "tokenpkg:TruthOracle.CBYN.Factory:CbynFactory";
    this.transferKind = "direct";
  }
}

// ---------------------------------------------------------------------------------------------
// token-app (Cantor8 mint / burn)
// ---------------------------------------------------------------------------------------------

/**
 * In-memory stand-in for TokenAppService (docs/TOKENS.md §4.4, §4.7): every mint / burn is
 * recorded (`minted` / `burned`) and answered `submitted`; nothing reaches the ledger index — a
 * spec that needs the minted holding to show up pushes it through FakeLedgerStream, exactly as
 * the real token-app's mint would arrive. `configured = false` makes every command answer
 * `503 token_app_unconfigured` (and `status()` report it); `failNext` makes the next command
 * throw (token-app down).
 */
export class FakeTokenApp {
  configured = true;
  reachable = true;
  readonly minted: TokenAppMintRequest[] = [];
  readonly burned: TokenAppMintRequest[] = [];
  failNext: Error | null = null;

  isConfigured(): boolean {
    return this.configured;
  }

  async mint(req: TokenAppMintRequest): Promise<TokenAppCommandResult> {
    this.ensure();
    this.minted.push({ ...req });
    return { commandId: req.commandId, status: "submitted", raw: { command_id: req.commandId } };
  }

  async burn(req: TokenAppMintRequest): Promise<TokenAppCommandResult> {
    this.ensure();
    this.burned.push({ ...req });
    return { commandId: req.commandId, status: "submitted", raw: { command_id: req.commandId } };
  }

  async mintBatch(req: TokenAppBatchRequest): Promise<TokenAppBatchResult> {
    this.ensure();
    for (const e of req.entries) this.minted.push(this.entryOf(req, e));
    return {
      commandId: req.commandId,
      status: "submitted",
      entryCount: req.entries.length,
      raw: {},
    };
  }

  async burnBatch(req: TokenAppBatchRequest): Promise<TokenAppBatchResult> {
    this.ensure();
    for (const e of req.entries) this.burned.push(this.entryOf(req, e));
    return {
      commandId: req.commandId,
      status: "submitted",
      entryCount: req.entries.length,
      raw: {},
    };
  }

  async status(): Promise<TokenAppStatus> {
    const up = this.configured && this.reachable;
    return {
      configured: this.configured,
      url: this.configured ? "http://token-app.fake" : null,
      appName: "truthoracle",
      reachable: up,
      raw: up ? { tokens: [], mints: this.minted.length, burns: this.burned.length } : null,
    };
  }

  async holdings(): Promise<TokenAppHolding[]> {
    this.ensure();
    return [];
  }

  async mints(): Promise<TokenAppRecord[]> {
    this.ensure();
    return this.minted.map((m) => this.recordOf(m));
  }

  async burns(): Promise<TokenAppRecord[]> {
    this.ensure();
    return this.burned.map((m) => this.recordOf(m));
  }

  reset(): void {
    this.configured = true;
    this.reachable = true;
    this.minted.length = 0;
    this.burned.length = 0;
    this.failNext = null;
  }

  private entryOf(
    req: TokenAppBatchRequest,
    e: TokenAppBatchRequest["entries"][number],
  ): TokenAppMintRequest {
    return {
      commandId: req.commandId,
      instrumentId: req.instrumentId,
      partyId: e.partyId,
      amount: e.amount,
      decimals: req.decimals,
    };
  }

  private recordOf(m: TokenAppMintRequest): TokenAppRecord {
    return {
      commandId: m.commandId,
      partyId: m.partyId,
      instrumentId: m.instrumentId,
      amount: formatAmount(m.amount),
      updateId: `update-${m.commandId}`,
      createdAt: new Date(0).toISOString(),
    };
  }

  private ensure(): void {
    if (!this.configured)
      throw new ApiError(
        503,
        "token_app_unconfigured",
        "token-app is not configured (TOKEN_APP_URL and its Keycloak client)",
      );
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }
}
