import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Echo a well-formed inbound `x-request-id` (or mint one) on `req.id` and the response so logs,
 * Sentry tags and the proxy can be correlated (docs/ARCHITECTURE.md §14).
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers["x-request-id"];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && REQUEST_ID_RE.test(candidate) ? candidate : randomUUID();
  (req as Request & { id: string }).id = id;
  res.setHeader("x-request-id", id);
  next();
}
