import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { clearKeyCaches, getGoogleClient, getRemoteJwks, verifyIdToken } from "./jwks";

describe("util/jwks", () => {
  beforeEach(() => clearKeyCaches());

  it("memoises the remote JWKS resolver per URL", () => {
    const a = getRemoteJwks("https://oauth.telegram.org/.well-known/jwks.json");
    const b = getRemoteJwks("https://oauth.telegram.org/.well-known/jwks.json");
    const c = getRemoteJwks("https://www.googleapis.com/oauth2/v3/certs");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("memoises the Google OAuth2 client per client id", () => {
    const a = getGoogleClient("client-a");
    expect(getGoogleClient("client-a")).toBe(a);
    expect(getGoogleClient("client-b")).not.toBe(a);
    expect(a._clientId).toBe("client-a");
  });

  it("verifies an ES256 id_token against a local key set (jose from CommonJS)", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256" };
    const token = await new SignJWT({ sub: "42", name: "Ada" })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer("https://issuer.test")
      .setAudience("truthoracle")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const payload = await verifyIdToken(token, {
      issuer: "https://issuer.test",
      audience: "truthoracle",
      getKey: createLocalJWKSet({ keys: [jwk] }),
    });
    expect(payload.sub).toBe("42");
    expect(payload.name).toBe("Ada");
  });

  it("rejects an id_token issued for another audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
    const token = await new SignJWT({ sub: "1" })
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .setIssuer("https://issuer.test")
      .setAudience("someone-else")
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyIdToken(token, {
        issuer: "https://issuer.test",
        audience: "truthoracle",
        getKey: createLocalJWKSet({ keys: [jwk] }),
      }),
    ).rejects.toThrow(/"aud"/);
  });

  it("requires a key source", async () => {
    await expect(verifyIdToken("x.y.z", { issuer: "i", audience: "a" })).rejects.toThrow(
      /getKey or jwksUrl/,
    );
  });
});
