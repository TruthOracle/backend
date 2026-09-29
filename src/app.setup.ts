import { Injectable, type INestApplication, type OnApplicationBootstrap } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { json, type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";

import type { Config } from "./config";
import { ApiError, bodyParserToApiError } from "./util/errors";
import { requestIdMiddleware } from "./util/request-id";

const JSON_BODY_LIMIT = "1mb";
const JSON_BODY_TYPES = ["application/json", "application/*+json"];

/**
 * JSON-only body parsing with raw-body capture (`req.rawBody`, needed for webhook signatures —
 * ARCHITECTURE §9.1). The parser is wrapped so a failure reaches the exception filter as an
 * `ApiError`: Nest's router error layer runs `mapExternalException` first, which turns
 * body-parser's SyntaxError into a bare `BadRequestException(err.message)` — the
 * `entity.parse.failed` type is lost and V8's parse message would leak to the client. Translating
 * here keeps `400 validation_failed "request body is not valid JSON"` deterministic.
 */
export function jsonBodyMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  const parse = json({
    limit: JSON_BODY_LIMIT,
    type: JSON_BODY_TYPES,
    verify: (req, _res, buf) => {
      if (Buffer.isBuffer(buf)) (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  });
  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      if (err === undefined || err === null) return next();
      next(bodyParserToApiError(err) ?? err);
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
 * request ids, helmet, cookie parsing, JSON-only body parsing with raw-body capture, CORS for
 * native clients, the `api/v1` prefix. Create the app with `{ rawBody: true, bodyParser: false }`
 * — Nest then installs no parser of its own and the urlencoded parser is deliberately never
 * installed (ARCHITECTURE §6.7: JSON only).
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
  express.use(jsonBodyMiddleware());

  // Browser traffic is same-origin through the proxy; CORS is only for native / direct clients.
  if (config.corsOrigins.length > 0) {
    express.enableCors({
      origin: config.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "x-requested-with", "Authorization", "x-request-id"],
      exposedHeaders: ["x-request-id", "Retry-After"],
      maxAge: 600,
    });
  }

  express.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] });
}
