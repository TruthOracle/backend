import { ApiError } from "../util/errors";
import { ComplianceFreezePort } from "./compliance-freeze.port";

describe("ComplianceFreezePort (SPEC §11.6; S7b)", () => {
  it("unbound: nobody is frozen and nothing is denied", async () => {
    const port = new ComplianceFreezePort();
    await expect(port.isFrozen("u1")).resolves.toBe(false);
    await expect(port.ordersDenied("u1")).resolves.toBe(false);
    await expect(port.assertNotFrozen("u1")).resolves.toBeUndefined();
  });

  it("asks the implementation; ordersDenied falls back to isFrozen; the refusal is the neutral 403", async () => {
    const port = new ComplianceFreezePort();
    port.bind({ isFrozen: async (id) => id === "frozen" });
    await expect(port.ordersDenied("frozen")).resolves.toBe(true);
    await expect(port.ordersDenied("other")).resolves.toBe(false);
    const err = await port.assertNotFrozen("frozen").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "this operation is not available for this account",
    });
  });

  it("a later binding (a test stub) layers over the service's and its unbind restores it; a second bind of the same object throws", async () => {
    const port = new ComplianceFreezePort();
    const service = {
      isFrozen: async () => false,
      ordersDenied: async (id: string) => id === "listed",
    };
    port.bind(service);
    expect(() => port.bind(service)).toThrow(/already bound/);
    const unbind = port.bind({ isFrozen: async () => true });
    await expect(port.isFrozen("anyone")).resolves.toBe(true);
    await expect(port.ordersDenied("anyone")).resolves.toBe(true);
    unbind();
    await expect(port.isFrozen("anyone")).resolves.toBe(false);
    await expect(port.ordersDenied("listed")).resolves.toBe(true);
  });

  it("a failing implementation throws (fail closed, I7)", async () => {
    const port = new ComplianceFreezePort();
    port.bind({ isFrozen: () => Promise.reject(new Error("db down")) });
    await expect(port.isFrozen("u1")).rejects.toThrow("db down");
    await expect(port.assertNotFrozen("u1")).rejects.toThrow("db down");
  });

  it("C27: assertNotFrozen screens newly linked parties first (a hit there freezes); a screening failure refuses", async () => {
    const port = new ComplianceFreezePort();
    const frozen = new Set<string>();
    const calls: string[] = [];
    port.bind({
      isFrozen: async (id) => frozen.has(id),
      screenNewParties: async (id) => {
        calls.push(id);
        if (id === "linked-listed") frozen.add(id);
        if (id === "broken") throw new Error("lists unreadable");
      },
    });
    await expect(port.assertNotFrozen("clean")).resolves.toBeUndefined();
    await expect(port.assertNotFrozen("linked-listed")).rejects.toMatchObject({ status: 403 });
    await expect(port.assertNotFrozen("broken")).rejects.toThrow("lists unreadable");
    expect(calls).toEqual(["clean", "linked-listed", "broken"]);
    // isFrozen itself stays a plain read.
    await expect(port.isFrozen("clean")).resolves.toBe(false);
    expect(calls).toHaveLength(3);
  });
});
