const httpIntegration = jest.fn((options: unknown) => ({ name: "Http", options }));
jest.mock("@sentry/node", () => ({ httpIntegration }));

import { sentryInitOptions } from "./sentry-options";

describe("sentryInitOptions (SPEC §8, X17)", () => {
  it("replaces the Http integration with one that captures no request body, and sends no PII", () => {
    const options = sentryInitOptions({
      sentryDsn: "https://k@o.ingest.sentry.io/1",
      appEnv: "prod",
    });
    expect(httpIntegration).toHaveBeenCalledWith({ maxIncomingRequestBodySize: "none" });
    expect(options.integrations).toEqual([
      { name: "Http", options: { maxIncomingRequestBodySize: "none" } },
    ]);
    expect(options).toMatchObject({
      dsn: "https://k@o.ingest.sentry.io/1",
      environment: "prod",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
    expect(options.release).toMatch(/^truthoracle-backend@/);
  });
});
