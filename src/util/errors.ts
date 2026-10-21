/**
 * One error type, one envelope (docs/ARCHITECTURE.md §11): every failure leaves the process as
 * `{ error: <stable code>, message, details? }` with an HTTP status. `ApiError` is what services
 * throw; the filter maps Nest's own HttpExceptions (ValidationPipe, 404s, body-parser) onto the
 * same codes and reports anything unknown to Sentry as a 500.
 */
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";

import { ERROR_CODES, type ErrorCode } from "../types";
import { asString } from "./strings";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static is(err: unknown): err is ApiError {
    return err instanceof ApiError;
  }

  toBody(): ErrorBody {
    return this.details
      ? { error: this.code, message: this.message, details: this.details }
      : { error: this.code, message: this.message };
  }
}

export interface ErrorBody {
  error: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

const CODE_SET = new Set<string>(ERROR_CODES);

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "validation_failed";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 429:
      return "rate_limited";
    case 502:
    case 503:
    case 504:
      return "upstream_failed";
    default:
      return status >= 500 ? "internal_error" : "bad_request";
  }
}

function fromHttpException(exception: HttpException): { status: number; body: ErrorBody } {
  const status = exception.getStatus();
  const response = exception.getResponse();
  let message = exception.message;
  let details: Record<string, unknown> | undefined;
  let code = codeForStatus(status);

  if (typeof response === "string") {
    message = response;
  } else if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    // ValidationPipe: { statusCode: 400, message: string[], error: "Bad Request" }
    if (Array.isArray(r.message)) {
      code = "validation_failed";
      message = "request validation failed";
      details = { issues: r.message };
    } else if (typeof r.message === "string") {
      message = r.message;
    }
    // A service may throw `new HttpException({ error: <code>, message }, status)`.
    if (typeof r.error === "string" && CODE_SET.has(r.error)) code = r.error as ErrorCode;
  }
  return { status, body: details ? { error: code, message, details } : { error: code, message } };
}

/**
 * body-parser / raw-body errors carry `status`/`statusCode` + `type` without being HttpExceptions.
 * `app.setup.ts` translates them at the parser (before Nest's router error layer, which maps a
 * body-parser SyntaxError to a bare `BadRequestException(err.message)` and thereby loses the
 * `entity.parse.failed` type and leaks V8's parse message); the filter keeps the mapping as a
 * backstop for any other Express-level 4xx.
 */
export function bodyParserToApiError(err: unknown): ApiError | null {
  if (!err || typeof err !== "object" || err instanceof ApiError) return null;
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown; message?: unknown };
  const status =
    typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 0;
  if (status < 400 || status > 499) return null;
  const type = typeof e.type === "string" ? e.type : "";
  if (type === "entity.parse.failed" || type === "entity.verify.failed") {
    return new ApiError(400, "validation_failed", "request body is not valid JSON");
  }
  if (type === "entity.too.large") {
    return new ApiError(413, "payload_too_large", "request body too large");
  }
  if (type === "charset.unsupported" || type === "encoding.unsupported") {
    return new ApiError(415, "unsupported_media_type", asString(e.message, type));
  }
  return new ApiError(status, codeForStatus(status), asString(e.message, "request rejected"));
}

function fromExpressError(err: unknown): { status: number; body: ErrorBody } | null {
  const mapped = bodyParserToApiError(err);
  return mapped ? { status: mapped.status, body: mapped.toBody() } : null;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const routePath = asString((req.route as { path?: unknown } | undefined)?.path, req.path);

    let status: number;
    let body: ErrorBody;

    if (exception instanceof ApiError) {
      status = exception.status;
      body = exception.toBody();
    } else if (exception instanceof HttpException) {
      ({ status, body } = fromHttpException(exception));
    } else {
      const expressError = fromExpressError(exception);
      if (expressError) {
        ({ status, body } = expressError);
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        body = { error: "internal_error", message: "internal error" };
        const err = exception instanceof Error ? exception : new Error(String(exception));
        this.logger.error(
          `${req.method} ${req.originalUrl ?? req.url} → 500: ${err.message}`,
          err.stack,
        );
        // Tags only — never bodies, cookies or PII (ARCHITECTURE §14).
        Sentry.captureException(err, {
          tags: { route: `${req.method} ${routePath}`, requestId: req.id ?? "" },
        });
      }
    }

    if (status >= 500 && exception instanceof ApiError) {
      this.logger.warn(
        `${req.method} ${req.originalUrl ?? req.url} → ${status} ${body.error}: ${body.message}`,
      );
    }

    if (status === 429) {
      const retryAfter = body.details?.retryAfterSec;
      if (typeof retryAfter === "number")
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfter))));
    }
    if (res.headersSent) return;
    res.status(status);
    res.setHeader("Cache-Control", "no-store");
    if (req.id) res.setHeader("x-request-id", req.id);
    res.json(body);
  }
}

// Convenience constructors for the most common failures.
export const errors = {
  unauthenticated: (message = "authentication required"): ApiError =>
    new ApiError(401, "unauthenticated", message),
  forbidden: (message = "forbidden"): ApiError => new ApiError(403, "forbidden", message),
  notFound: (message = "not found"): ApiError => new ApiError(404, "not_found", message),
  validation: (message: string, details?: Record<string, unknown>): ApiError =>
    new ApiError(400, "validation_failed", message, details),
  upstream: (message: string, details?: Record<string, unknown>): ApiError =>
    new ApiError(502, "upstream_failed", message, details),
};
