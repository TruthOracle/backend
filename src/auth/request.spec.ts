import {
  clientIpOf,
  isTrustedProxyRequest,
  originMatchesPattern,
  originOf,
  requestHostOf,
  requestProtoOf,
  webhookSourceIpOf,
} from "./request";

const SECRET = "p".repeat(40);
const withSecret = { backendProxySecret: SECRET };
const noSecret = { backendProxySecret: "" };

function req(
  headers: Record<string, string>,
  remote = "10.0.0.9",
): { headers: Record<string, string>; socket: { remoteAddress: string }; protocol: string } {
  return { headers, socket: { remoteAddress: remote }, protocol: "http" };
}

describe("auth/request proxy contract (§4.1)", () => {
  it("trusts x-real-ip / x-forwarded-host only with the matching secret", () => {
    const proxied = req({
      "x-truthoracle-proxy": SECRET,
      "x-real-ip": "203.0.113.5",
      "x-forwarded-host": "App.Test",
      "x-forwarded-proto": "https",
      host: "backend.internal",
    });
    expect(isTrustedProxyRequest(proxied, withSecret)).toBe(true);
    expect(clientIpOf(proxied, withSecret)).toBe("203.0.113.5");
    expect(requestHostOf(proxied, withSecret)).toBe("app.test");
    expect(requestProtoOf(proxied, withSecret)).toBe("https");
  });

  it("ignores every x-forwarded-* header without the secret or with a wrong one", () => {
    const spoofed = req({
      "x-truthoracle-proxy": "wrong",
      "x-real-ip": "203.0.113.5",
      "x-forwarded-host": "evil.test",
      "x-forwarded-for": "1.1.1.1",
      host: "backend.internal",
    });
    expect(isTrustedProxyRequest(spoofed, withSecret)).toBe(false);
    expect(clientIpOf(spoofed, withSecret)).toBe("10.0.0.9");
    expect(requestHostOf(spoofed, withSecret)).toBe("backend.internal");
    expect(requestProtoOf(spoofed, withSecret)).toBe("http");
    const unconfigured = req({
      "x-truthoracle-proxy": SECRET,
      "x-real-ip": "203.0.113.5",
      host: "h",
    });
    expect(clientIpOf(unconfigured, noSecret)).toBe("10.0.0.9");
  });

  it("parses origins and matches wildcard patterns", () => {
    expect(originOf("https://App.Test/path?x")).toBe("https://app.test");
    expect(originOf("chrome-extension://abc")).toBeNull();
    expect(originOf("garbage")).toBeNull();
    expect(originMatchesPattern("https://foo.vercel.app", "https://*.vercel.app")).toBe(true);
    expect(originMatchesPattern("https://foo.bar.vercel.app", "https://*.vercel.app")).toBe(false);
    expect(originMatchesPattern("https://vercel.app", "https://*.vercel.app")).toBe(false);
    expect(originMatchesPattern("https://app.test", "https://app.test/")).toBe(true);
    expect(originMatchesPattern("http://app.test", "https://app.test")).toBe(false);
  });
});

describe("webhookSourceIpOf (SPEC §8, X13)", () => {
  const hooks = (over: Partial<{ ipHeader: string; trustedEdgeCidrs: string[] }> = {}) => ({
    ipAuthProviders: [],
    sourceCidrs: new Map<string, string[]>(),
    ipHeader: "x-forwarded-for",
    trustedEdgeCidrs: ["10.0.0.0/8"],
    ...over,
  });

  it("takes the RIGHT-most header value (the one our edge appended) from a trusted edge peer", () => {
    const fromEdge = req({ "x-forwarded-for": "198.51.100.1, 203.0.113.7" }, "::ffff:10.1.2.3");
    expect(webhookSourceIpOf(fromEdge, { ...noSecret, rampWebhooks: hooks() })).toBe("203.0.113.7");
    // Repeated header lines join in order; the last value still wins.
    const repeated = {
      headers: { "x-forwarded-for": ["198.51.100.1", "203.0.113.8"] },
      socket: { remoteAddress: "10.0.0.1" },
    };
    expect(webhookSourceIpOf(repeated, { ...noSecret, rampWebhooks: hooks() })).toBe("203.0.113.8");
  });

  it("ignores the header from an untrusted peer (spoofing) and falls back to the socket", () => {
    const direct = req({ "x-forwarded-for": "203.0.113.7" }, "::ffff:198.51.100.20");
    expect(webhookSourceIpOf(direct, { ...noSecret, rampWebhooks: hooks() })).toBe("198.51.100.20");
    // No header configured: the proxy contract alone.
    expect(
      webhookSourceIpOf(req({ "x-forwarded-for": "203.0.113.7" }, "10.1.1.1"), {
        ...noSecret,
        rampWebhooks: hooks({ ipHeader: "" }),
      }),
    ).toBe("10.1.1.1");
  });

  it("honours the header for the relay (proxy secret) even outside the edge CIDRs", () => {
    const relayed = req(
      {
        "x-truthoracle-proxy": SECRET,
        "x-real-ip": "198.51.100.9",
        "x-forwarded-for": "203.0.113.7",
      },
      "172.16.0.5",
    );
    expect(webhookSourceIpOf(relayed, { ...withSecret, rampWebhooks: hooks() })).toBe(
      "203.0.113.7",
    );
    // A trusted request whose header is missing or garbage falls back to the proxy contract.
    const noHeader = req(
      { "x-truthoracle-proxy": SECRET, "x-real-ip": "198.51.100.9" },
      "10.0.0.2",
    );
    expect(webhookSourceIpOf(noHeader, { ...withSecret, rampWebhooks: hooks() })).toBe(
      "198.51.100.9",
    );
    const garbage = req({ "x-forwarded-for": "not-an-ip" }, "10.0.0.2");
    expect(webhookSourceIpOf(garbage, { ...noSecret, rampWebhooks: hooks() })).toBe("10.0.0.2");
  });
});
