import type { DataSource } from "typeorm";

import type { Config } from "../config";
import type { InstrumentEntity } from "../entities/instrument.entity";
import type { Actor } from "../types";
import { parseAmount } from "../util/money";
import type { AuditService } from "./audit.service";
import type { ComplianceFreezePort } from "./compliance-freeze.port";
import type { DepositService } from "./deposit.service";
import type { InstrumentsService } from "./instruments.service";
import type { LedgerClientService } from "./ledger-client.service";
import type { NatsService } from "./nats.service";
import type { TokenAppSyncService } from "./token-app-sync.service";
import type { TokenAppService } from "./token-app.service";
import type { TokenCommandService } from "./token-command.service";
import { TokenOperationsService } from "./token-operations.service";
import type { TreasuryTransferService } from "./treasury-transfer.service";
import type { UserService } from "./user.service";

const TREASURY = "treasury::1220" + "f".repeat(64);
const AGENT = "agent::1220" + "c".repeat(64);
const TRO_ADMIN = "tro::1220" + "e".repeat(64);
const ACTOR: Actor = { type: "admin", userId: "op-user" };

const instrument = (admin: string, id: string): InstrumentEntity =>
  ({ admin, id, symbol: id, name: id, decimals: 6, enabled: true }) as InstrumentEntity;

function build(isMainnet: boolean) {
  const rows = new Map([
    ["cBYN", instrument(AGENT, "cBYN")],
    ["TRO", instrument(TRO_ADMIN, "TRO")],
  ]);
  const recordIntent = jest.fn((_m: unknown, intent: { commandId: string }) =>
    Promise.resolve({ commandId: intent.commandId }),
  );
  const submit = jest.fn((commandId: string) =>
    Promise.resolve({ commandId, status: "submitted", lastError: null }),
  );
  const svc = new TokenOperationsService(
    { isMainnet, treasuryPartyId: TREASURY } as unknown as Config,
    { transaction: (fn: (m: unknown) => unknown) => fn({}) } as unknown as DataSource,
    {
      requireEnabled: (ref: { id: string }) => Promise.resolve(rows.get(ref.id)),
      require: (_admin: string, id: string) => Promise.resolve(rows.get(id)),
      toRef: (r: InstrumentEntity) => ({ admin: r.admin, id: r.id }),
    } as unknown as InstrumentsService,
    { isConfigured: () => true } as unknown as TokenAppService,
    {
      requireCaps: () => Promise.resolve(),
      recordIntent,
      submit,
    } as unknown as TokenCommandService,
    {
      rampInstrument: () => Promise.resolve({ admin: AGENT, id: "cBYN" }),
      onPass: jest.fn(),
    } as unknown as TokenAppSyncService,
    {} as TreasuryTransferService,
    { ensureUserWallet: jest.fn() } as unknown as DepositService,
    {
      findById: () =>
        Promise.resolve({
          id: "u1",
          status: "active",
          partyId: "alice::1220" + "a".repeat(64),
          kycStatus: "approved",
        }),
    } as unknown as UserService,
    {
      fetchUserWallet: () => Promise.resolve({ contractId: "w" }),
    } as unknown as LedgerClientService,
    { record: jest.fn(() => Promise.resolve()) } as unknown as AuditService,
    { publishSafe: jest.fn(() => Promise.resolve()) } as unknown as NatsService,
    { isFrozen: () => Promise.resolve(false) } as unknown as ComplianceFreezePort,
  );
  return { svc, recordIntent, submit };
}

const mint = (id: string, extra: Record<string, unknown> = {}) => ({
  instrument: { admin: id === "cBYN" ? AGENT : TRO_ADMIN, id },
  amount: parseAmount("10"),
  reason: "test",
  ...extra,
});

describe("admin token routes on mainnet (docs/RAMP.md §7, T-D5, X12)", () => {
  it("the ramp instrument is never minted or burned here, approval or not", async () => {
    const { svc, recordIntent } = build(true);
    await expect(svc.mint(mint("cBYN"), ACTOR, { approvalId: "a1" })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: expect.stringMatching(/ramp instrument/) as string,
    });
    await expect(
      svc.burn({ ...mint("cBYN"), party: TREASURY }, ACTOR, { approvalId: "a1" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(recordIntent).not.toHaveBeenCalled();
  });

  it("another instrument needs the four-eyes approval token.admin_mint|burn; mint-and-credit is refused", async () => {
    const { svc, recordIntent, submit } = build(true);
    await expect(svc.mint(mint("TRO"), ACTOR)).rejects.toMatchObject({
      status: 403,
      details: { approvalAction: "token.admin_mint" },
    });
    await expect(svc.burn({ ...mint("TRO"), party: TREASURY }, ACTOR)).rejects.toMatchObject({
      details: { approvalAction: "token.admin_burn" },
    });
    await expect(
      svc.mint(mint("TRO", { creditUserId: "u1" }), ACTOR, { approvalId: "a1" }),
    ).rejects.toMatchObject({ status: 403, message: "mint-and-credit is refused on mainnet" });
    expect(recordIntent).not.toHaveBeenCalled();

    const res = await svc.mint(mint("TRO"), ACTOR, { approvalId: "a1" });
    expect(res).toMatchObject({ status: "submitted", party: TREASURY, credit: null });
    expect(recordIntent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        kind: "mint",
        source: "admin",
        party: TREASURY,
        ref: "admin:op-user",
      }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("devnet keeps the direct routes, ramp instrument included; mint-and-credit answers a pending credit", async () => {
    const { svc, recordIntent } = build(false);
    await expect(svc.mint(mint("cBYN"), ACTOR)).resolves.toMatchObject({ status: "submitted" });
    const credited = await svc.mint(mint("TRO", { creditUserId: "u1" }), ACTOR);
    expect(credited.credit).toMatchObject({
      status: "pending",
      txRef: `mint:${credited.commandId}`,
    });
    expect(recordIntent).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ ref: "credit:u1", source: "admin" }),
    );
  });
});
