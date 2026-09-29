import {
  clientIpOf,
  isTrustedProxyRequest,
  originMatchesPattern,
  originOf,
  requestHostOf,
  requestProtoOf,
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
