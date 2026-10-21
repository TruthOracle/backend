import { CidrList, normaliseIp, parseCidr } from "./cidr";

describe("cidr (SPEC §8 webhook source checks)", () => {
  it("normalises addresses: IPv4-mapped IPv6 → IPv4, brackets and case dropped, garbage → ''", () => {
    expect(normaliseIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normaliseIp(" [2001:DB8::1] ")).toBe("2001:db8::1");
    expect(normaliseIp("203.0.113.9")).toBe("203.0.113.9");
    expect(normaliseIp("unknown")).toBe("");
    expect(normaliseIp("203.0.113.9:443")).toBe("");
  });

  it("parses v4 / v6 CIDRs and bare addresses; refuses malformed ones", () => {
    expect(parseCidr("203.0.113.0/24")).toEqual({
      address: "203.0.113.0",
      prefix: 24,
      family: "ipv4",
    });
    expect(parseCidr("2001:db8::/32")).toEqual({
      address: "2001:db8::",
      prefix: 32,
      family: "ipv6",
    });
    expect(parseCidr("192.0.2.7")).toEqual({ address: "192.0.2.7", prefix: 32, family: "ipv4" });
    for (const bad of [
      "203.0.113.0/33",
      "2001:db8::/129",
      "host/24",
      "1.2.3.4/x",
      "1.2.3.4/8/9",
      "",
    ]) {
      expect(parseCidr(bad)).toBeNull();
    }
  });

  it("matches members, including dual-stack peers, and nothing when empty", () => {
    const list = new CidrList(["203.0.113.0/24", "2001:db8::/32", "192.0.2.7", "garbage"]);
    expect(list.size).toBe(3);
    expect(list.has("203.0.113.200")).toBe(true);
    expect(list.has("::ffff:203.0.113.5")).toBe(true);
    expect(list.has("2001:db8:1::5")).toBe(true);
    expect(list.has("192.0.2.7")).toBe(true);
    expect(list.has("192.0.2.8")).toBe(false);
    expect(list.has("203.0.114.1")).toBe(false);
    expect(list.has("unknown")).toBe(false);
    expect(new CidrList([]).has("203.0.113.5")).toBe(false);
  });
});
