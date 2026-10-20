import { authedJson, UpstreamError } from "./upstream-http";

describe("authedJson errors (SPEC §8, X17)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps the upstream body out of the message (logs, last_error) and on bodyText only", async () => {
    const body = '{"error":"payout refused","iban":"BY13NBRB3600900000002Z00AB00","name":"IVAN"}';
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status: 422 }));
    const err = (await authedJson("https://psp.test", "/payouts", {
      method: "POST",
      body: {},
    }).catch((e: unknown) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(422);
    expect(err.message).toBe("POST /payouts failed: HTTP 422");
    expect(err.message).not.toMatch(/BY13|IVAN|refused/);
    expect(err.bodyText).toBe(body);
  });

  it("a network failure carries status 0 and no body", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const err = (await authedJson("https://psp.test", "/x", {}).catch(
      (e: unknown) => e,
    )) as UpstreamError;
    expect(err).toMatchObject({ status: 0, bodyText: "", message: "GET /x failed: fetch failed" });
  });
});
