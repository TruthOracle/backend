import {
  clearedOidcCookie,
  clearedSessionCookie,
  oidcCookie,
  readCookie,
  sessionCookie,
} from "./cookies";

describe("util/cookies", () => {
  const secure = { cookieSecure: true, cookieDomain: "" };
  const dev = { cookieSecure: false, cookieDomain: "" };

  it("serialises a host-only HttpOnly Lax session cookie", () => {
    const c = sessionCookie("tok en", 3_600_000, secure);
    expect(c).toBe("to_session=tok%20en; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure");
    expect(sessionCookie("t", 1000, dev)).not.toContain("Secure");
    expect(sessionCookie("t", 1000, { cookieSecure: true, cookieDomain: "example.com" })).toContain(
      "Domain=example.com",
    );
  });

  it("clears with Max-Age=0", () => {
    expect(clearedSessionCookie(secure)).toBe(
      "to_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    );
    expect(clearedOidcCookie(dev)).toBe("to_oidc=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(oidcCookie("abc", 600_000, dev)).toBe(
      "to_oidc=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=600",
    );
  });

  it("reads a named cookie and treats undecodable values as absent", () => {
    const req = { headers: { cookie: "a=1; to_session=x%20y; b=2" } };
    expect(readCookie(req, "to_session")).toBe("x y");
    expect(readCookie(req, "b")).toBe("2");
    expect(readCookie(req, "missing")).toBe("");
    expect(readCookie({ headers: {} }, "to_session")).toBe("");
    expect(readCookie({ headers: { cookie: "to_session=%E0%A4%A" } }, "to_session")).toBe("");
  });
});
