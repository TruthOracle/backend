import { clearKeyCaches, getRemoteJwks } from "./jwks";

describe("util/jwks", () => {
  beforeEach(() => clearKeyCaches());

  it("memoises the remote JWKS resolver per URL", () => {
    const a = getRemoteJwks("https://oauth.telegram.org/.well-known/jwks.json");
    const b = getRemoteJwks("https://oauth.telegram.org/.well-known/jwks.json");
    const c = getRemoteJwks("https://www.googleapis.com/oauth2/v3/certs");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    clearKeyCaches();
    expect(getRemoteJwks("https://oauth.telegram.org/.well-known/jwks.json")).not.toBe(a);
  });
});
