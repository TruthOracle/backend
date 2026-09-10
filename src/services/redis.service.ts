import { randomBytes } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Redis } from "ioredis";

import { Config } from "../config";

/**
 * Cross-instance state (docs/ARCHITECTURE.md §10): single-use claims, fixed-window rate
 * limits, short locks, JSON cache and small sets. Port of the Redis-backed half of
 * truthoracle-canton/api/_lib/sharedStore.mjs — without the in-memory fallback: here Redis is
 * REQUIRED at boot, so an outage is an error, never a silent downgrade. Only `SET NX PX`,
 * `INCR`, `PEXPIRE`, `PTTL`, `DEL`, `GET`, `SET EX/PX`, `SADD/SREM/SMEMBERS` are used.
 *
 * Every key is prefixed `truthoracle:<APP_NETWORK>:` inside this service — callers pass bare
 * keys (`sess:<hash>`, `lock:deposit:<userId>`, …).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  readonly keyPrefix: string;

  constructor(private readonly config: Config) {
    this.keyPrefix = `truthoracle:${config.appNetwork}:`;
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectionName: "truthoracle-backend",
    });
    this.client.on("error", (err: Error) => this.logger.warn(`redis error: ${err.message}`));
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    const pong = await this.client.ping();
    this.logger.log(`connected to ${this.describeUrl()} (${pong}); prefix ${this.keyPrefix}`);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
    this.logger.log("connection closed");
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === "PONG";
  }

  key(bare: string): string {
    return `${this.keyPrefix}${bare}`;
  }

  /** Claim `key` exactly once for `ttlMs`. True when this caller won (SET NX PX). */
  async claimOnce(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(this.key(key), "1", "PX", Math.max(1, Math.round(ttlMs)), "NX");
    return result === "OK";
  }

  /**
   * Count a hit against `key` in a fixed window. The first hit in the window sets the expiry; a
   * crash between INCR and PEXPIRE would leave the key eternal, so the expiry is (re)applied by
   * whichever caller sees count 1 — and, defensively, whenever PTTL reports no expiry.
   */
  async hitRateLimit(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<{ limited: boolean; count: number; retryAfterMs: number }> {
    const k = this.key(key);
    const count = await this.client.incr(k);
    let ttl = await this.client.pttl(k);
    if (count === 1 || ttl < 0) {
      await this.client.pexpire(k, Math.max(1, Math.round(windowMs)));
      ttl = windowMs;
    }
    return { limited: count > max, count, retryAfterMs: count > max ? Math.max(ttl, 1) : 0 };
  }

  /**
   * Short-lived exclusive lock. The TTL is the crash ceiling — a holder that dies un-releases
   * automatically. Release only deletes the key while it still carries this holder's token, so
   * a slow holder cannot release a lock the TTL already handed to someone else.
   */
  async acquireLock(key: string, ttlMs: number): Promise<{ acquired: boolean; release(): Promise<void> }> {
    const k = this.key(key);
    const token = randomBytes(12).toString("base64url");
    const result = await this.client.set(k, token, "PX", Math.max(1, Math.round(ttlMs)), "NX");
    if (result !== "OK") return { acquired: false, release: async () => {} };
    return {
      acquired: true,
      release: async () => {
        try {
          const current = await this.client.get(k);
          if (current === token) await this.client.del(k);
        } catch (err) {
          // TTL cleans it up.
          this.logger.warn(`lock release failed for ${key}: ${(err as Error).message}`);
        }
      },
    };
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.key(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (ttlMs !== undefined && ttlMs > 0) {
      await this.client.set(this.key(key), raw, "PX", Math.max(1, Math.round(ttlMs)));
    } else {
      await this.client.set(this.key(key), raw);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.key(key));
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined && ttlMs > 0) {
      await this.client.set(this.key(key), value, "PX", Math.max(1, Math.round(ttlMs)));
    } else {
      await this.client.set(this.key(key), value);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.del(...keys.map((k) => this.key(k)));
  }

  async sadd(key: string, member: string): Promise<void> {
    await this.client.sadd(this.key(key), member);
  }

  async srem(key: string, member: string): Promise<void> {
    await this.client.srem(this.key(key), member);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(this.key(key));
  }

  async pexpire(key: string, ttlMs: number): Promise<void> {
    await this.client.pexpire(this.key(key), Math.max(1, Math.round(ttlMs)));
  }

  /** Tests only. */
  async flushDb(): Promise<void> {
    await this.client.flushdb();
  }

  private describeUrl(): string {
    try {
      const u = new URL(this.config.redisUrl);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return "redis";
    }
  }
}
