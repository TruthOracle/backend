import {
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
  type ArgumentsHost,
} from "@nestjs/common";

import { AllExceptionsFilter, ApiError, bodyParserToApiError } from "./errors";

beforeAll(() => {
  Logger.overrideLogger(false);
});

interface FakeRes {
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  headersSent: boolean;
}

function fakeHost(): { host: ArgumentsHost; res: FakeRes } {
  const res: FakeRes = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    headersSent: false,
  };
  const req = { method: "GET", originalUrl: "/x", url: "/x", path: "/x", id: "rid" };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe("util/errors AllExceptionsFilter", () => {
  const filter = new AllExceptionsFilter();

  it("renders ApiError as { error, message, details }", () => {
    const { host, res } = fakeHost();
    filter.catch(new ApiError(409, "last_identity", "keep one", { left: 1 }), host);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "last_identity",
      message: "keep one",
      details: { left: 1 },
    });
  });

  it("maps ValidationPipe errors to 400 validation_failed with issues", () => {
    const { host, res } = fakeHost();
    filter.catch(new BadRequestException(["partyId must be a string"]), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "validation_failed",
      message: "request validation failed",
      details: { issues: ["partyId must be a string"] },
    });
  });

  it("maps other HttpExceptions by status", () => {
    const { host, res } = fakeHost();
    filter.catch(new NotFoundException("Cannot GET /nope"), host);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "not_found", message: "Cannot GET /nope" });
    const h2 = fakeHost();
    filter.catch(
      new HttpException({ error: "kyc_required", message: "verify first" }, 409),
      h2.host,
    );
    expect(h2.res.json).toHaveBeenCalledWith({ error: "kyc_required", message: "verify first" });
  });

  it("maps body-parser failures and sets Retry-After on 429", () => {
    const { host, res } = fakeHost();
    filter.catch(
      Object.assign(new Error("Unexpected token"), { status: 400, type: "entity.parse.failed" }),
      host,
    );
    expect(res.json).toHaveBeenCalledWith({
      error: "validation_failed",
      message: "request body is not valid JSON",
    });
    const h2 = fakeHost();
    filter.catch(new ApiError(429, "rate_limited", "slow down", { retryAfterSec: 7 }), h2.host);
    expect(h2.res.setHeader).toHaveBeenCalledWith("Retry-After", "7");
  });

  it("bodyParserToApiError translates body-parser errors at the parser (before Nest maps SyntaxError)", () => {
    const parse = bodyParserToApiError(
      Object.assign(new SyntaxError("Expected property name or '}' in JSON at position 1"), {
        status: 400,
        type: "entity.parse.failed",
      }),
    );
    expect(parse?.toBody()).toEqual({
      error: "validation_failed",
      message: "request body is not valid JSON",
    });
    const large = bodyParserToApiError(
      Object.assign(new Error("request entity too large"), {
        status: 413,
        type: "entity.too.large",
      }),
    );
    expect(`${large?.status} ${large?.code}`).toBe("413 payload_too_large");
    const charset = bodyParserToApiError(
      Object.assign(new Error("unsupported charset"), {
        statusCode: 415,
        type: "charset.unsupported",
      }),
    );
    expect(`${charset?.status} ${charset?.code}`).toBe("415 unsupported_media_type");
    expect(bodyParserToApiError(new Error("plain"))).toBeNull();
    expect(bodyParserToApiError(Object.assign(new Error("boom"), { status: 500 }))).toBeNull();
    const already = new ApiError(403, "forbidden");
    expect(bodyParserToApiError(already)).toBeNull();
  });

  it("hides unknown errors behind 500 internal_error", () => {
    const { host, res } = fakeHost();
    filter.catch(new Error("db exploded: password=hunter2"), host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "internal_error", message: "internal error" });
  });
});
