/**
 * Authenticated JSON call to an upstream (ledger / Enterprise Wallet). Port of
 * `authedJson` in truthoracle-canton/api/_lib/upstream.mjs: throws with the upstream status
 * and a bounded slice of the body so callers can branch on 404 without ever logging a token.
 */

export class UpstreamError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(message: string, status: number, bodyText: string) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export interface UpstreamRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  token: string;
  timeoutMs?: number;
}

export async function authedJson<T = unknown>(
  baseUrl: string,
  path: string,
  opts: UpstreamRequest,
): Promise<T> {
  const method = opts.method ?? "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/json",
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new UpstreamError(
      `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      0,
      "",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new UpstreamError(`${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 600)}`, res.status, text.slice(0, 2000));
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
