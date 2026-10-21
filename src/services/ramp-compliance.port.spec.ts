import { KycIdentityPort, type KycIdentityImpl } from "./kyc-identity.port";
import { RampCompliancePort, type RampComplianceImpl } from "./ramp-compliance.port";

function impl(tag: string, held: boolean): RampComplianceImpl {
  return {
    eligibility: async () => ({ allowed: false, reasons: [tag] }),
    consent: async () => ({ required: true, consentId: tag }),
    check: async () => ({ decision: "review", rules: [tag], alertIds: [] }),
    isHeld: async () => held,
    raise: async () => tag,
  };
}

describe("the S7a ports: the bound service, a stub layered over it (SPEC §9.4)", () => {
  it("compliance: default allows; the last bound answers; unbinding restores the one below; a double bind throws", async () => {
    const port = new RampCompliancePort();
    expect(await port.eligibility("u")).toEqual({ allowed: true, reasons: [] });
    expect(await port.isHeld("o")).toBe(false);
    expect(await port.raise("TM-X", "u", {})).toBeNull();
    const service = impl("service", true);
    port.bind(service);
    const unbindStub = port.bind(impl("stub", false));
    expect(port.bound).toBe(true);
    expect((await port.eligibility("u")).reasons).toEqual(["stub"]);
    expect(await port.isHeld("o")).toBe(false);
    unbindStub();
    expect((await port.eligibility("u")).reasons).toEqual(["service"]);
    expect(await port.isHeld("o")).toBe(true);
    expect(await port.consent("u")).toEqual({ required: true, consentId: "service" });
    expect(() => port.bind(service)).toThrow(/already bound/);
  });

  it("identity: the bound implementation answers; a stub layered over it wins until unbound", async () => {
    const port = new KycIdentityPort(
      { findById: async () => null } as never,
      {} as never,
      {} as never,
    );
    expect(await port.get("u")).toBeNull();
    const service: KycIdentityImpl = { get: async (userId) => ({ userId }) as never };
    port.bind(service);
    const unbind = port.bind({ get: async () => null });
    expect(await port.get("u")).toBeNull();
    unbind();
    expect(await port.get("u")).toEqual({ userId: "u" });
    // `stored` falls back to `get` for an implementation that keeps nothing.
    expect(await port.stored("u")).toEqual({ userId: "u" });
    const unbindStore = port.bind({
      get: async () => null,
      stored: async (userId) => ({ userId, stored: true }) as never,
    });
    expect(await port.stored("u")).toEqual({ userId: "u", stored: true });
    unbindStore();
    expect(() => port.bind(service)).toThrow(/already bound/);
  });

  it("C28 / C25: checkCreate falls back to check (alerts raised at once); pending alerts are raised only through recordCreate, never dropped; returnRequested defaults to false", async () => {
    const port = new RampCompliancePort();
    const ctx = { point: "onramp.create", userId: "u", orderId: "o" } as never;
    expect(await port.checkCreate("onramp.create", ctx)).toEqual({
      decision: "allow",
      rules: [],
      alertIds: [],
      pending: [],
    });
    expect(await port.returnRequested("o")).toBe(false);
    const stub = impl("stub", false);
    port.bind(stub);
    expect(await port.checkCreate("onramp.create", ctx)).toMatchObject({
      decision: "review",
      rules: ["stub"],
      pending: [],
    });
    expect(await port.recordCreate([], {} as never)).toEqual([]);
    const pending = [{ rule: "TM-STRUCT" }] as never[];
    await expect(port.recordCreate(pending, {} as never)).rejects.toThrow(/no implementation/);
    const recorded: unknown[] = [];
    port.bind({
      ...impl("service", true),
      checkCreate: async () => ({
        decision: "review",
        rules: ["TM-STRUCT"],
        alertIds: [],
        pending,
      }),
      recordCreate: async (p, manager) => {
        recorded.push([p, manager]);
        return ["alert-1"];
      },
      returnRequested: async (orderId) => orderId === "returned",
    });
    expect((await port.checkCreate("onramp.create", ctx)).pending).toBe(pending);
    expect(await port.recordCreate(pending, "tx" as never)).toEqual(["alert-1"]);
    expect(recorded).toEqual([[pending, "tx"]]);
    expect(await port.returnRequested("returned")).toBe(true);
    expect(await port.returnRequested("o")).toBe(false);
  });

  it("C14 / C15: identity asOf asks the implementation, else falls back to stored", async () => {
    const port = new KycIdentityPort(
      { findById: async () => null } as never,
      {} as never,
      {} as never,
    );
    port.bind({
      get: async () => null,
      stored: async (userId) => ({ userId, v: "current" }) as never,
    });
    expect(await port.asOf("u", new Date())).toEqual({ userId: "u", v: "current" });
    port.bind({
      get: async () => null,
      asOf: async (userId, at) => ({ userId, at: at.toISOString() }) as never,
    });
    expect(await port.asOf("u", new Date("2026-03-01T00:00:00Z"))).toEqual({
      userId: "u",
      at: "2026-03-01T00:00:00.000Z",
    });
  });
});
