import { maskParty } from "./party";

describe("maskParty", () => {
  it("keeps the hint and a recognisable tail, never the fingerprint", () => {
    const party = "alice::1220" + "ab".repeat(32);
    const masked = maskParty(party);
    expect(masked).toBe("alice::1…ababab");
    expect(masked).not.toContain("1220ab");
    expect(masked.length).toBe(15);
  });
  it("returns short ids whole", () => {
    expect(maskParty("local-user::abc")).toBe("local-user::abc");
    expect(maskParty("  bob  ")).toBe("bob");
  });
});
