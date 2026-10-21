import { Injectable, Logger } from "@nestjs/common";

import { Config, type KeycloakConfig } from "../config";
import { ApiError } from "../util/errors";
import { RedisService } from "./redis.service";

/** Who a bearer is minted for: the participant, the Enterprise Wallet, a CIP-56 registry (`registry_auth = keycloak`) or Cantor8's token-app. */
export type KeycloakTarget = "ledger" | "wallet" | "registry" | "tokenApp";

/** The env prefix of each target's own client. */
const TARGET_PREFIX: Record<KeycloakTarget, string> = {
  ledger: "LEDGER_KEYCLOAK",
  wallet: "WALLET_KEYCLOAK",
  registry: "REGISTRY_KEYCLOAK",
  tokenApp: "TOKEN_APP_KEYCLOAK",
};

type KeycloakField = keyof KeycloakConfig;
const FIELD_ENV: Record<KeycloakField, string> = {
  url: "URL",
  realm: "REALM",
  clientId: "CLIENT_ID",
  clientSecret: "CLIENT_SECRET",
};

/** What the resolution reads; a structural slice of Config so `npm run tokenapp:check` and the specs can pass plain objects. */
export type KeycloakSourceConfig = Pick<
  Config,
  "isMainnet" | "keycloak" | "ledgerKeycloak" | "walletKeycloak" | "registryKeycloak" | "zkpc"
> & { tokenApp: Pick<Config["tokenApp"], "keycloak"> };

/**
 * A target's resolved client and, per field, the env var it came from (`null` = unset) — the
 * check script prints the sources, never a secret's value.
 */
export interface KeycloakResolution {
  creds: KeycloakConfig | null;
  sources: Record<KeycloakField, string | null>;
}

/**
 * Credential resolution, shared by the service and `npm run tokenapp:check` (docs/RAMP.md §7).
 *
 * - Mainnet ledger: `ZKPC_*` only.
 * - Mainnet token-app and registry: their own `TOKEN_APP_KEYCLOAK_*` / `REGISTRY_KEYCLOAK_*` only
 *   (realm default `master`). Merging field by field with `KEYCLOAK_*` posted the wallet's (devnet)
 *   secret to the zkpc Keycloak, or the zkpc secret to the wallet's, and failed only at runtime
 *   (T-D2); an incomplete dedicated client is "unconfigured" instead.
 * - Everything else: the per-target override first, `KEYCLOAK_*` filling each blank field — how the
 *   devnet `.env` files are laid out.
 */
export function resolveKeycloak(
  config: KeycloakSourceConfig,
  target: KeycloakTarget,
): KeycloakResolution {
  if (target === "ledger" && config.isMainnet) {
    const z = config.zkpc;
    return finish(
      {
        url: z.keycloakUrl,
        realm: z.keycloakRealm || "master",
        clientId: z.clientId,
        clientSecret: z.clientSecret,
      },
      (field) => `ZKPC_KEYCLOAK_${FIELD_ENV[field]}`,
    );
  }
  const override = overrideOf(config, target);
  const prefix = TARGET_PREFIX[target];
  if (config.isMainnet && (target === "tokenApp" || target === "registry")) {
    return finish(
      {
        url: override.url ?? "",
        realm: override.realm || "master",
        clientId: override.clientId ?? "",
        clientSecret: override.clientSecret ?? "",
      },
      (field) =>
        override[field] ? `${prefix}_${FIELD_ENV[field]}` : field === "realm" ? "default" : null,
    );
  }
  const base = config.keycloak;
  const pick = (field: KeycloakField): string => override[field] || base[field] || "";
  return finish(
    {
      url: pick("url"),
      realm: override.realm || base.realm || "master",
      clientId: pick("clientId"),
      clientSecret: pick("clientSecret"),
    },
    (field) =>
      override[field]
        ? `${prefix}_${FIELD_ENV[field]}`
        : base[field]
          ? `KEYCLOAK_${FIELD_ENV[field]}`
          : field === "realm"
            ? "default"
            : null,
  );
}

function finish(
  resolved: KeycloakConfig,
  sourceOf: (field: KeycloakField) => string | null,
): KeycloakResolution {
  const sources = {} as Record<KeycloakField, string | null>;
  for (const field of Object.keys(FIELD_ENV) as KeycloakField[])
    sources[field] = resolved[field] ? sourceOf(field) : null;
  const complete = Boolean(resolved.url && resolved.clientId && resolved.clientSecret);
  return { creds: complete ? resolved : null, sources };
}

function overrideOf(config: KeycloakSourceConfig, target: KeycloakTarget): Partial<KeycloakConfig> {
  switch (target) {
    case "ledger":
      return config.ledgerKeycloak;
    case "wallet":
      return config.walletKeycloak;
    case "registry":
      return config.registryKeycloak;
    case "tokenApp":
      return config.tokenApp.keycloak;
  }
}

/**
 * Seconds before expiry at which a cached bearer is refreshed: 60 s, or half the lifetime of a
 * shorter token. A flat 60 s margin never let a ≤ 60 s token (Keycloak master realm default)
 * be served from cache — one client_credentials grant per call (T-D7).
 */
export function cacheMarginSec(expiresInSec: number): number {
  return Math.min(60, expiresInSec / 2);
}

interface CachedBearer {
  token: string;
  expiresAtSec: number;
  /** Serve from cache only while now < this (expiry minus `cacheMarginSec`). */
  refreshAtSec: number;
}

/**
 * Keycloak client_credentials token minter for the ledger, the Enterprise Wallet, the token
 * registries and token-app. Port of pm-frontend/api/proxy/_keycloakToken.mjs; who reads which
 * client is `resolveKeycloak` above. The wallet trusts its OWN Keycloak on every network
 * (upstream.mjs).
 *
 * Tokens are cached in Redis (`kc:<issuer>|<realm>|<clientId>`, shared across instances) and
 * in-process until `cacheMarginSec` before expiry; `invalidate` drops both after an upstream 401.
 * Secrets and tokens are never logged.
 */
@Injectable()
export class KeycloakTokenService {
  private readonly logger = new Logger(KeycloakTokenService.name);
  private readonly memory = new Map<string, CachedBearer>();

  constructor(
    private readonly config: Config,
    private readonly redis: RedisService,
  ) {}

  /** Resolved credentials for a target, or null when not configured. */
  credentialsFor(target: KeycloakTarget): KeycloakConfig | null {
    return resolveKeycloak(this.config, target).creds;
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
    const key = cacheKey(creds);
    const nowSec = Date.now() / 1000;

    const mem = this.memory.get(key);
    if (mem && mem.refreshAtSec > nowSec) return mem.token;

    const cached = await this.redis.getJson<CachedBearer>(`kc:${key}`).catch(() => null);
    if (cached && typeof cached.refreshAtSec === "number" && cached.refreshAtSec > nowSec) {
      this.memory.set(key, cached);
      return cached.token;
    }

    const minted = await this.mint(creds, target);
    const entry: CachedBearer = {
      token: minted.token,
      expiresAtSec: nowSec + minted.expiresInSec,
      refreshAtSec: nowSec + minted.expiresInSec - cacheMarginSec(minted.expiresInSec),
    };
    this.memory.set(key, entry);
    const ttlMs = Math.max(1_000, Math.floor((entry.refreshAtSec - nowSec) * 1000));
    await this.redis.setJson(`kc:${key}`, entry, ttlMs).catch((err: Error) => {
      this.logger.warn(`token cache write failed: ${err.message}`);
    });
    return entry.token;
  }

  /**
   * Forget the target's cached bearer, in this process and in Redis: an upstream answered 401, so
   * the token was revoked or rotated before its expiry and every instance must mint a fresh one.
   */
  async invalidate(target: KeycloakTarget): Promise<void> {
    const creds = this.credentialsFor(target);
    if (!creds) return;
    const key = cacheKey(creds);
    this.memory.delete(key);
    await this.redis.del(`kc:${key}`).catch((err: Error) => {
      this.logger.warn(`token cache delete failed: ${err.message}`);
    });
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

function cacheKey(creds: KeycloakConfig): string {
  return `${creds.url}|${creds.realm}|${creds.clientId}`;
}
