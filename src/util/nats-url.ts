/**
 * NATS_URL → NATS client connection options.
 *
 * The NATS client ignores credentials written into a server URL: with @nats-io/transport-node
 * 3.4, `nats://<token>@host` and `nats://<user>:<pass>@host` both fail with "Authorization
 * Violation" against a server that requires them. They are lifted out here and passed as the
 * client's explicit options instead:
 *
 *   nats://host:4222                 → { servers }                no auth (local dev)
 *   nats://<token>@host:4222         → { servers, token }         token auth (Railway's NATS)
 *   nats://<user>:<pass>@host:4222   → { servers, user, pass }    user / password auth
 *
 * A comma-separated server list is accepted; every entry must carry the same credentials, or
 * none. Credentials are percent-decoded, so a token or password with reserved characters can be
 * written percent-encoded. The returned `servers` never contain credentials, so they are safe to
 * log, and error messages mask them.
 */
export interface NatsConnectOptions {
  servers: string[];
  token?: string;
  user?: string;
  pass?: string;
}

type Credentials = Omit<NatsConnectOptions, "servers">;

/** `nats://secret@host` → `nats://***@host`, for error messages. */
function maskCredentials(entry: string): string {
  return entry.replace(/\/\/[^@/]*@/, "//***@");
}

export function natsConnectOptions(natsUrl: string): NatsConnectOptions {
  const entries = natsUrl
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error("NATS_URL is empty");

  let shared: Credentials | undefined;
  const servers = entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry.includes("://") ? entry : `nats://${entry}`);
    } catch {
      throw new Error(`NATS_URL entry is not a URL: ${maskCredentials(entry)}`);
    }
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password);
    if (!user && pass)
      throw new Error(`NATS_URL entry has a password but no user: ${maskCredentials(entry)}`);
    // NATS convention: a lone value before `@` is a token; `user:pass` is user / password.
    const credentials: Credentials = !user ? {} : pass ? { user, pass } : { token: user };
    if (shared === undefined) shared = credentials;
    else if (JSON.stringify(shared) !== JSON.stringify(credentials)) {
      throw new Error(
        "NATS_URL servers carry different credentials; one connection can only present one set",
      );
    }
    return `${url.protocol}//${url.host}`;
  });
  return { servers, ...shared };
}
