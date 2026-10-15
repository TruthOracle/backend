import { Injectable, Logger } from "@nestjs/common";

import { Config, type KeycloakConfig } from "../config";
import { ApiError } from "../util/errors";
import { RedisService } from "./redis.service";

/** Who a bearer is minted for: the participant, the Enterprise Wallet, a CIP-56 registry (`registry_auth = keycloak`) or Cantor8's token-app. */
export type KeycloakTarget = "ledger" | "wallet" | "registry" | "tokenApp";

/**
 * Keycloak client_credentials token minter for the ledger, the Enterprise Wallet, the token
 * registries and token-app. Port of pm-frontend/api/proxy/_keycloakToken.mjs.
 *
 * Each field resolves independently: the per-target override (LEDGER_KEYCLOAK_* /
 * WALLET_KEYCLOAK_* / REGISTRY_KEYCLOAK_* / TOKEN_APP_KEYCLOAK_*) is consulted first and
 * KEYCLOAK_* fills whatever is blank — which is how the checked-in .env files are laid out. On
 * mainnet the LEDGER target reads ZKPC_* only — no fallback to the devnet names — so a
 * misconfigured deploy fails fast rather than minting tokens against the wrong Keycloak, which the
 * participant rejects with an opaque 401. The wallet trusts its OWN Keycloak on every network, not
 * the zkpc node's (upstream.mjs); the registries and token-app are Cantor8 services with the
 * same realm as the wallet, so they default to KEYCLOAK_* too (docs/TOKENS.md §4.4).
 *
 * Tokens are cached in Redis (`kc:<issuer>|<realm>|<clientId>`, shared across instances) and
 * in-process, with a 60 s margin before expiry. Secrets and tokens are never logged.
 */
@Injectable()
export class KeycloakTokenService {
  private readonly logger = new Logger(KeycloakTokenService.name);
  private readonly memory = new Map<string, { token: string; expiresAtSec: number }>();
  private static readonly MARGIN_SEC = 60;

  constructor(
    private readonly config: Config,
    private readonly redis: RedisService,
  ) {}

  /** Resolved credentials for a target, or null when not configured. */
  credentialsFor(target: KeycloakTarget): KeycloakConfig | null {
    let resolved: KeycloakConfig;
    if (target === "ledger" && this.config.isMainnet) {
      const z = this.config.zkpc;
      resolved = {
        url: z.keycloakUrl,
        realm: z.keycloakRealm || "master",
        clientId: z.clientId,
        clientSecret: z.clientSecret,
      };
    } else {
      const override = this.overrideFor(target);
      const base = this.config.keycloak;
      resolved = {
        url: override.url || base.url,
        realm: override.realm || base.realm || "master",
        clientId: override.clientId || base.clientId,
        clientSecret: override.clientSecret || base.clientSecret,
      };
    }
    if (!resolved.url || !resolved.clientId || !resolved.clientSecret) return null;
    return resolved;
  }

  private overrideFor(target: KeycloakTarget): Partial<KeycloakConfig> {
    switch (target) {
      case "ledger":
        return this.config.ledgerKeycloak;
      case "wallet":
        return this.config.walletKeycloak;
      case "registry":
        return this.config.registryKeycloak;
      case "tokenApp":
        return this.config.tokenApp.keycloak;
    }
  }

  isConfigured(target: KeycloakTarget): boolean {
    return this.credentialsFor(target) !== null;
  }

  /** A bearer token for the target; `ApiError(502, upstream_failed)` when it cannot be minted. */
  async bearerFor(target: KeycloakTarget): Promise<string> {
    const creds = this.credentialsFor(target);
    if (!creds) {
      throw new ApiError(
        502,
        "upstream_failed",
        `Keycloak credentials for the ${target} are not configured`,
      );
    }
    const key = `${creds.url}|${creds.realm}|${creds.clientId}`;
    const nowSec = Date.now() / 1000;

    const mem = this.memory.get(key);
    if (mem && mem.expiresAtSec > nowSec + KeycloakTokenService.MARGIN_SEC) return mem.token;

    const cached = await this.redis
      .getJson<{ token: string; expiresAtSec: number }>(`kc:${key}`)
      .catch(() => null);
    if (cached && cached.expiresAtSec > nowSec + KeycloakTokenService.MARGIN_SEC) {
      this.memory.set(key, cached);
      return cached.token;
    }

    const minted = await this.mint(creds, target);
    const entry = { token: minted.token, expiresAtSec: nowSec + minted.expiresInSec };
    this.memory.set(key, entry);
    const ttlMs = Math.max(1_000, (minted.expiresInSec - KeycloakTokenService.MARGIN_SEC) * 1000);
    await this.redis.setJson(`kc:${key}`, entry, ttlMs).catch((err: Error) => {
      this.logger.warn(`token cache write failed: ${err.message}`);
    });
    return entry.token;
  }

  private async mint(
    creds: KeycloakConfig,
    target: string,
  ): Promise<{ token: string; expiresInSec: number }> {
    let res: Response;
    try {
      res = await fetch(
        `${creds.url}/realms/${encodeURIComponent(creds.realm)}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
          }).toString(),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (err) {
      throw new ApiError(
        502,
        "upstream_failed",
        `Keycloak (${target}) unreachable: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new ApiError(
        502,
        "upstream_failed",
        `Keycloak (${target}) refused the client credentials (HTTP ${res.status})`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof data.access_token !== "string" || !data.access_token) {
      throw new ApiError(502, "upstream_failed", `Keycloak (${target}) returned no access_token`);
    }
    const expiresInSec =
      typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 900;
    return { token: data.access_token, expiresInSec };
  }

  /** Tests only. */
  clearCache(): void {
    this.memory.clear();
  }
}
