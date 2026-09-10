import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/**
 * Lazily-built, memoised remote JWKS resolvers for the OIDC issuer we accept id_tokens from
 * (Telegram OIDC, via `jose`). `jose` 6 ships a `require` export condition, so plain `import`
 * compiles to `require()` under `module: nodenext` with no dynamic-import workaround needed.
 */
const remoteJwks = new Map<string, JWTVerifyGetKey>();

export function getRemoteJwks(jwksUrl: string): JWTVerifyGetKey {
  let resolver = remoteJwks.get(jwksUrl);
  if (!resolver) {
    // Fetches on first verify and caches keys (jose handles rotation + cooldown).
    resolver = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000 });
    remoteJwks.set(jwksUrl, resolver);
  }
  return resolver;
}

/** Test hook. */
export function clearKeyCaches(): void {
  remoteJwks.clear();
}
