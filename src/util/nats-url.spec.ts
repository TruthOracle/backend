import { natsConnectOptions } from "./nats-url";

describe("natsConnectOptions", () => {
  it("passes a URL without credentials through as the only server", () => {
    expect(natsConnectOptions("nats://localhost:4223")).toEqual({
      servers: ["nats://localhost:4223"],
    });
  });

  it("lifts a lone value before @ out as a token (Railway's NATS)", () => {
    expect(natsConnectOptions("nats://s3cretToken@nats.railway.internal:4222")).toEqual({
      servers: ["nats://nats.railway.internal:4222"],
      token: "s3cretToken",
    });
  });

  it("lifts user:pass out as user / password", () => {
    expect(natsConnectOptions("nats://alice:s3cret@host:4222")).toEqual({
      servers: ["nats://host:4222"],
      user: "alice",
      pass: "s3cret",
    });
  });

  it("percent-decodes credentials and keeps the tls scheme", () => {
    expect(natsConnectOptions("tls://p%40ss%3Aword@host:4443")).toEqual({
      servers: ["tls://host:4443"],
      token: "p@ss:word",
    });
  });

  it("accepts a bare host:port and a comma-separated list sharing one set of credentials", () => {
    expect(natsConnectOptions("host-a:4222")).toEqual({ servers: ["nats://host-a:4222"] });
    expect(natsConnectOptions("nats://t@a:4222, nats://t@b:4222")).toEqual({
      servers: ["nats://a:4222", "nats://b:4222"],
      token: "t",
    });
  });

  it("never leaves credentials in the servers it returns", () => {
    const { servers } = natsConnectOptions(
      "nats://alice:s3cret@host:4222,nats://alice:s3cret@other:4222",
    );
    expect(servers.join(",")).not.toMatch(/alice|s3cret/);
  });

  it("refuses servers with different credentials, a password without a user, and junk, masking secrets", () => {
    expect(() => natsConnectOptions("nats://a@x:4222,nats://b@y:4222")).toThrow(
      /different credentials/,
    );
    expect(() => natsConnectOptions("nats://:s3cret@host:4222")).toThrow(/password but no user/);
    expect(() => natsConnectOptions(" , ")).toThrow(/empty/);
    let message = "";
    try {
      natsConnectOptions("nats://s3cret@exa mple:4222");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a URL/);
    expect(message).not.toContain("s3cret");
  });
});
