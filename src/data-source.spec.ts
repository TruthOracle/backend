import { resolveDbSsl, resolveDbSslCa } from "./data-source";

describe("resolveDbSsl", () => {
  const remote = "postgresql://u:p@db.railway.internal:5432/x";
  it("auto: plain TCP for local hosts, unverified TLS elsewhere", () => {
    expect(resolveDbSsl("postgresql://localhost:5432/x", "auto")).toBe(false);
    expect(resolveDbSsl("postgresql://u:p@postgres:5432/x", "auto")).toBe(false);
    expect(resolveDbSsl(remote, "auto")).toEqual({ rejectUnauthorized: false });
  });
  it("verify checks the server certificate, optionally against a private CA", () => {
    expect(resolveDbSsl(remote, "verify")).toEqual({ rejectUnauthorized: true });
    expect(resolveDbSsl(remote, "verify", "-----BEGIN CERTIFICATE-----\nabc")).toEqual({ rejectUnauthorized: true, ca: "-----BEGIN CERTIFICATE-----\nabc" });
    expect(resolveDbSsl(remote, "true")).toEqual({ rejectUnauthorized: false });
    expect(resolveDbSsl(remote, "false")).toBe(false);
  });
  it("resolveDbSslCa accepts inline PEM and nothing", () => {
    expect(resolveDbSslCa(undefined)).toBeUndefined();
    expect(resolveDbSslCa("  ")).toBeUndefined();
    expect(resolveDbSslCa("-----BEGIN CERTIFICATE-----\nxyz")).toBe("-----BEGIN CERTIFICATE-----\nxyz");
    expect(() => resolveDbSslCa("/nonexistent/ca.pem")).toThrow();
  });
});
