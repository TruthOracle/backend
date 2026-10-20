import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

import {
  type AdminSessionCheck,
  adminSessionCheck,
  formFields,
  jsonBodyMiddleware,
  largeBodyToken,
} from "./app.setup";
import { ApiError } from "./util/errors";

const req = (
  path: string,
  headers: Record<string, string> = {},
): Pick<Request, "path" | "headers"> => ({ path, headers }) as Pick<Request, "path" | "headers">;

/** A bare Express app with the JSON middleware: answers how many raw bytes it parsed. */
function parserApp(check: AdminSessionCheck) {
  const app = express();
  app.use(jsonBodyMiddleware(check));
  app.post(/.*/, (r: Request, res: Response) => {
    res.json({ bytes: (r as Request & { rawBody?: Buffer }).rawBody?.length ?? 0 });
  });
  app.use((err: unknown, _r: Request, res: Response, _next: NextFunction) => {
    res.status(err instanceof ApiError ? err.status : 500).json({});
  });
  return app;
}

describe("app.setup body parsing (SPEC §8)", () => {
  it("the 8 MB parser is considered for the upload routes only, with SessionGuard's token", () => {
    const cookie = { cookie: "a=b; to_session=tok" };
    const bearer = { authorization: "Bearer tok" };
    expect(largeBodyToken(req("/api/v1/admin/ramp/bank-statements", cookie))).toBe("tok");
    expect(largeBodyToken(req("/api/v1/admin/ramp/bank-statements/abc/confirm", bearer))).toBe(
      "tok",
    );
    expect(largeBodyToken(req("/api/v1/admin/compliance/screening-lists", cookie))).toBe("tok");
    expect(largeBodyToken(req("/api/v1/admin/ramp/bank-statements"))).toBe("");
    // Not a bearer: SessionGuard ignores it, so it presents nothing.
    expect(
      largeBodyToken(req("/api/v1/admin/ramp/bank-statements", { authorization: "Basic x" })),
    ).toBe("");
    expect(largeBodyToken(req("/api/v1/admin/ramp/orders", cookie))).toBe("");
    expect(largeBodyToken(req("/api/v1/ramp/onramp", bearer))).toBe("");
  });

  it("only a live, active admin session counts (C40); a lookup failure is a no", async () => {
    const session = (kind: string, status = "active") => ({
      verify: () => Promise.resolve({ session: { kind }, user: { status } } as never),
    });
    expect(await adminSessionCheck(session("admin"))("t")).toBe(true);
    expect(await adminSessionCheck(session("user"))("t")).toBe(false);
    expect(await adminSessionCheck(session("admin", "suspended"))("t")).toBe(false);
    expect(await adminSessionCheck({ verify: () => Promise.resolve(null) })("t")).toBe(false);
    expect(await adminSessionCheck({ verify: () => Promise.reject(new Error("redis")) })("t")).toBe(
      false,
    );
  });

  it("a merely present credential gets the 1 MB parser: 413 before any guard, never an 8 MB parse (C40)", async () => {
    const seen: string[] = [];
    const app = parserApp((token) => {
      seen.push(token);
      return Promise.resolve(token === "admin-token");
    });
    const big = JSON.stringify({ file: "x".repeat(2_000_000) });
    const post = (path: string, headers: Record<string, string>) =>
      request(app)
        .post(path)
        .set({ "Content-Type": "application/json", ...headers })
        .send(big);
    await post("/api/v1/admin/ramp/bank-statements", { Cookie: "to_session=1" }).expect(413);
    await post("/api/v1/admin/ramp/bank-statements", { Authorization: "Bearer nope" }).expect(413);
    await post("/api/v1/admin/ramp/bank-statements", {}).expect(413);
    const ok = await post("/api/v1/admin/compliance/screening-lists", {
      Authorization: "Bearer admin-token",
    }).expect(200);
    expect((ok.body as { bytes: number }).bytes).toBe(big.length);
    // Other routes never look the token up.
    await post("/api/v1/admin/ramp/orders", { Authorization: "Bearer admin-token" }).expect(413);
    expect(seen).toEqual(["1", "nope", "admin-token"]);
  });

  it("form fields: first value per name, null prototype, capped", () => {
    const fields = formFields(Buffer.from("a=1&b=x%20y&a=2&__proto__=p&constructor=c"));
    expect(Object.getPrototypeOf(fields)).toBeNull();
    // Own data properties, even for names that would be setters on a plain object.
    expect(Object.entries(fields)).toEqual([
      ["a", "1"],
      ["b", "x y"],
      ["__proto__", "p"],
      ["constructor", "c"],
    ]);
    expect(({} as Record<string, unknown>).p).toBeUndefined();
    const many = Array.from({ length: 1001 }, (_, i) => `f${i}=1`).join("&");
    expect(() => formFields(Buffer.from(many))).toThrow(/too many form fields/);
  });
});
