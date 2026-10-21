import { Injectable, type INestApplication, type OnApplicationBootstrap } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { json, raw, type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

import { extractToken } from "./auth/session.guard";
import type { Config } from "./config";
import { SessionService } from "./services/session.service";
import { ApiError, bodyParserToApiError } from "./util/errors";
import { requestIdMiddleware } from "./util/request-id";

const JSON_BODY_LIMIT = "1mb";
const JSON_BODY_TYPES = ["application/json", "application/*+json"];
/** Base64 statement / screening-list uploads (SPEC §8, X16): the only routes with a larger body. */
const LARGE_BODY_LIMIT = "8mb";
const LARGE_BODY_PREFIXES = [
  "/api/v1/admin/ramp/bank-statements",
  "/api/v1/admin/compliance/screening-lists",
];
const FORM_BODY_TYPE = "application/x-www-form-urlencoded";
const RAMP_WEBHOOK_PREFIX = "/api/v1/webhooks/ramp/";
const FORM_FIELD_LIMIT = 1000;

type RawBodyRequest = Request & { rawBody?: Buffer };

function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  if (Buffer.isBuffer(buf)) (req as RawBodyRequest).rawBody = buf;
}

/** Whether a session token belongs to a live admin session (the same lookup SessionGuard makes). */
export type AdminSessionCheck = (token: string) => Promise<boolean>;

/**
 * The token to verify before an 8 MB parse: the admin upload routes only, and only when the
 * request presents a credential the way SessionGuard reads it ("" = the 1 MB parser, no lookup).
 */
export function largeBodyToken(req: Pick<Request, "path" | "headers">): string {
  const path = req.path ?? "";
  if (!LARGE_BODY_PREFIXES.some((prefix) => path.startsWith(prefix))) return "";
  return extractToken(req).token;
}

/** A live, active admin session — anything else (unknown, expired, a user session, an error) is no. */
export function adminSessionCheck(sessions: Pick<SessionService, "verify">): AdminSessionCheck {
  return (token) =>
    sessions
      .verify(token)
      .then((v) => v?.session.kind === "admin" && v.user.status === "active")
      .catch(() => false);
}

/**
 * JSON body parsing with raw-body capture (`req.rawBody`, needed for webhook signatures —
 * ARCHITECTURE §9.1); 1 MB, or 8 MB on the upload routes for a VERIFIED admin session only: the
 * parse runs before the guards, so a credential that is merely present (a forged cookie, any
 * bearer) must not buy an 8 MB parse (C40). The parser is wrapped so a failure reaches the
 * exception filter as an `ApiError`: Nest's router error layer
 * runs `mapExternalException` first, which turns body-parser's SyntaxError into a bare
 * `BadRequestException(err.message)` — the `entity.parse.failed` type is lost and V8's parse
 * message would leak to the client. Translating here keeps `400 validation_failed "request body
 * is not valid JSON"` deterministic.
 */
export function jsonBodyMiddleware(
  isAdminSession: AdminSessionCheck = () => Promise.resolve(false),
): (req: Request, res: Response, next: NextFunction) => void {
  const parseDefault = json({
    limit: JSON_BODY_LIMIT,
    type: JSON_BODY_TYPES,
    verify: captureRawBody,
  });
  const parseLarge = json({
    limit: LARGE_BODY_LIMIT,
    type: JSON_BODY_TYPES,
    verify: captureRawBody,
  });
  return (req, res, next) => {
    const run = (parse: typeof parseDefault): void =>
      parse(req, res, (err?: unknown) => {
        if (err === undefined || err === null) return next();
        next(bodyParserToApiError(err) ?? err);
      });
    const token = largeBodyToken(req);
    if (!token) return run(parseDefault);
    isAdminSession(token)
      .catch(() => false)
      .then((admin) => run(admin ? parseLarge : parseDefault))
      .catch(next);
  };
}

/** Form fields as a null-prototype map (first value per name); more than FORM_FIELD_LIMIT → 413. */
export function formFields(body: Buffer): Record<string, string> {
  const fields = Object.create(null) as Record<string, string>;
  let count = 0;
  for (const [name, value] of new URLSearchParams(body.toString("utf8"))) {
    count += 1;
    if (count > FORM_FIELD_LIMIT)
      throw new ApiError(413, "payload_too_large", "too many form fields");
    if (!(name in fields)) fields[name] = value;
  }
  return fields;
}

/**
 * `application/x-www-form-urlencoded` on `/webhooks/ramp/*` ONLY (SPEC §8): form-posting acquirers
 * sign the raw bytes, so they are kept as `req.rawBody` and `req.body` becomes the fields (only
 * the redacted inbox payload reads them). Every other route still has no form parser, and the
 * CSRF guard refuses form posts there.
 */
export function rampWebhookFormMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  const capture = raw({ type: FORM_BODY_TYPE, limit: JSON_BODY_LIMIT });
  return (req, res, next) => {
    if (!(req.path ?? "").startsWith(RAMP_WEBHOOK_PREFIX)) return next();
    capture(req, res, (err?: unknown) => {
      if (err !== undefined && err !== null) return next(bodyParserToApiError(err) ?? err);
      const body: unknown = req.body;
      if (Buffer.isBuffer(body)) {
        (req as RawBodyRequest).rawBody = body;
        try {
          req.body = formFields(body);
        } catch (parseErr) {
          return next(parseErr);
        }
      }
      next();
    });
  };
}

/** The `{ error: "not_found" }` envelope for a route nothing handled (ARCHITECTURE §11). */
export function notFoundHandler(req: Request, res: Response): void {
  const body = new ApiError(
    404,
    "not_found",
    `Cannot ${req.method} ${req.originalUrl ?? req.url}`,
  ).toBody();
  res.status(404);
  res.setHeader("Cache-Control", "no-store");
  const id = (req as Request & { id?: string }).id;
  if (id) res.setHeader("x-request-id", id);
  res.json(body);
}

/**
 * Unknown routes answer the JSON envelope. Nest 12's own not-found layer is mounted at the bare
 * global prefix (`use("api/v1", router)` — no leading slash, prefix only) and never fires under
 * Express 5, which then serves its HTML 404 for every unmatched path. This provider appends a
 * catch-all AFTER every controller route: `onApplicationBootstrap` runs once the router and its
 * hooks are registered (`registerRouter → callInitHook → registerRouterHooks → callBootstrapHook`),
 * and the handler writes the envelope directly so it depends on no error layer either.
 * Registered explicitly by AppModule (not through a barrel).
 */
@Injectable()
export class NotFoundFallback implements OnApplicationBootstrap {
  constructor(private readonly host: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    const instance = this.host.httpAdapter.getInstance<Express>();
    instance.use(notFoundHandler);
  }
}

/**
 * HTTP-level setup shared by main.ts and the e2e test helper so both run the same pipeline:
 * request ids, helmet, cookie parsing, JSON body parsing with raw-body capture, CORS for native
 * clients, the `api/v1` prefix. Create the app with `{ rawBody: true, bodyParser: false }` — Nest
 * then installs no parser of its own. The API is JSON only (ARCHITECTURE §6.7): the one form
 * parser is the raw capture for acquirer webhooks on `/webhooks/ramp/*` (SPEC §8).
 */
export function setupHttpApp(app: INestApplication, config: Config): void {
  const express = app as NestExpressApplication;
  // Express `trust proxy` stays OFF: the proxy contract (§4.1) decides what to trust, per request.
  express.set("trust proxy", false);
  express.set("etag", false);
  express.disable("x-powered-by");

  // Request ids first so even a body-parser rejection carries x-request-id.
  express.use(requestIdMiddleware);
  // JSON API only — CSP belongs to the frontend; the rest of helmet's defaults apply.
  express.use(helmet({ contentSecurityPolicy: false }));
  express.use(cookieParser());
  express.use(jsonBodyMiddleware(adminSessionCheck(app.get(SessionService))));
  express.use(rampWebhookFormMiddleware());

  // Browser traffic is same-origin through the proxy; CORS is only for native / direct clients.
  if (config.corsOrigins.length > 0) {
    express.enableCors({
      origin: config.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      // Idempotency-Key: money POSTs carry it (E-D10).
      allowedHeaders: [
        "Content-Type",
        "x-requested-with",
        "Authorization",
        "x-request-id",
        "Idempotency-Key",
      ],
      // Exports (S6 / S7a / S7b): a cross-origin console reads the file name, the export id and
      // the batch file's hash (S8).
      exposedHeaders: [
        "x-request-id",
        "Retry-After",
        "Content-Disposition",
        "X-Export-Id",
        "X-Content-SHA256",
      ],
      maxAge: 600,
    });
  }

  express.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] });
}
