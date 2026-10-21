import { BlockList, isIP } from "node:net";

/**
 * CIDR lists for the webhook source allow-list and the trusted edge (SPEC §8): `RAMP_WEBHOOK_SOURCE_CIDRS`,
 * `RAMP_TRUSTED_EDGE_CIDRS`. A bare address is a /32 (/128). IPv4-mapped IPv6 peers
 * (`::ffff:203.0.113.9`, what a dual-stack socket reports) are compared as IPv4.
 */

/** Canonical form of an address for comparison and rate-limit keys; "" when it is not an IP. */
export function normaliseIp(raw: string): string {
  let ip = (raw ?? "").trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1];
  return isIP(ip) ? ip : "";
}

export interface Cidr {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

/** `203.0.113.0/24`, `2001:db8::/32` or a bare address; null when malformed. */
export function parseCidr(entry: string): Cidr | null {
  const [addr, bits, extra] = entry.trim().split("/");
  if (extra !== undefined) return null;
  const address = normaliseIp(addr ?? "");
  if (!address) return null;
  const family = isIP(address) === 4 ? "ipv4" : "ipv6";
  const max = family === "ipv4" ? 32 : 128;
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return null;
  const prefix = bits === undefined ? max : Number(bits);
  if (prefix > max) return null;
  return { address, prefix, family };
}

/** Membership test over parsed CIDRs (node:net BlockList); malformed entries are skipped (config refuses them at boot). */
export class CidrList {
  private readonly list = new BlockList();
  readonly size: number;

  constructor(entries: readonly string[]) {
    let size = 0;
    for (const entry of entries) {
      const cidr = parseCidr(entry);
      if (!cidr) continue;
      this.list.addSubnet(cidr.address, cidr.prefix, cidr.family);
      size += 1;
    }
    this.size = size;
  }

  has(ip: string): boolean {
    const address = normaliseIp(ip);
    if (!address || this.size === 0) return false;
    return this.list.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
  }
}
