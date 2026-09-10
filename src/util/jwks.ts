import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * Lazily-built, memoised key resolvers for the OIDC providers we accept id_tokens from
 * (Telegram OIDC via `jose` remote JWKS, Google via `google-auth-library`). Both libraries
 * are consumed from CommonJS output: `jose` 6 ships a `require` export condition and
 * `google-auth-library` 11 is CommonJS, so plain `import` compiles to `require()` under
 * `module: nodenext` with no dynamic-import workaround needed.
 */
const remoteJwks = new Map<string, JWTVerifyGetKey>();
const googleClients = new Map<string, OAuth2Client>();

export function getRemoteJwks(jwksUrl: string): JWTVerifyGetKey {
  let resolver = remoteJwks.get(jwksUrl);
  if (!resolver) {
    // Fetches on first verify and caches keys (jose handles rotation + cooldown).
    resolver = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000 });
    remoteJwks.set(jwksUrl, resolver);
  }
  return resolver;
}

export function getGoogleClient(clientId: string): OAuth2Client {
  let client = googleClients.get(clientId);
  if (!client) {
    client = new OAuth2Client({ clientId });
    googleClients.set(clientId, client);
  }
  return client;
}

export interface IdTokenExpectations {
  issuer: string | string[];
  audience: string | string[];
  /** Key resolver; defaults to the remote JWKS for `jwksUrl`. */
  getKey?: JWTVerifyGetKey;
  jwksUrl?: string;
}

/** Verifies signature, issuer, audience and time claims of a JWS id_token. */
export async function verifyIdToken(token: string, opts: IdTokenExpectations): Promise<JWTPayload> {
  const getKey = opts.getKey ?? (opts.jwksUrl ? getRemoteJwks(opts.jwksUrl) : undefined);
  if (!getKey) throw new Error("verifyIdToken requires getKey or jwksUrl");
  const { payload } = await jwtVerify(token, getKey, {
    issuer: opts.issuer,
    audience: opts.audience,
  });
  return payload;
}

/** Verifies a Google Identity Services id_token against our client id. */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
): Promise<TokenPayload | undefined> {
  const ticket = await getGoogleClient(clientId).verifyIdToken({ idToken, audience: clientId });
  return ticket.getPayload();
}

/** Test hook. */
export function clearKeyCaches(): void {
  remoteJwks.clear();
  googleClients.clear();
}
