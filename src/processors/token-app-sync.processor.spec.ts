import type { Config } from "../config";
import type { RedisLock, RedisService } from "../services/redis.service";
import type { SentryService } from "../services/sentry.service";
import {
  type TokenAppSyncService,
  TokenSyncAbortedError,
  type TokenSyncPassResult,
} from "../services/token-app-sync.service";
import { TOKEN_SYNC_LOCK_TTL_MS, TokenAppSyncProcessor } from "./token-app-sync.processor";

function setup(syncOnce: TokenAppSyncService["syncOnce"]) {
  const renew = jest.fn((_ms: number) => Promise.resolve(true));
  const release = jest.fn(() => Promise.resolve());
  const lock: RedisLock = { acquired: true, release, renew };
  const redis = { acquireLock: jest.fn(() => Promise.resolve(lock)) } as unknown as RedisService;
  const sync = {
    syncOnce: jest.fn(syncOnce),
    hasUnresolved: () => Promise.resolve(true),
  } as unknown as TokenAppSyncService;
  const captureException = jest.fn();
  const sentry = { captureException } as unknown as SentryService;
  const config = { tokenCommands: { syncSec: 60, idleSyncMin: 15 } } as unknown as Config;
  const processor = new TokenAppSyncProcessor(config, sync, redis, sentry);
  return { processor, sync, lock, renew, release, captureException };
}

describe("TokenAppSyncProcessor lock renewal (C42)", () => {
  afterEach(() => jest.useRealTimers());

  it("renews the lock every third of its TTL while a pass runs, and stops at the end", async () => {
    jest.useFakeTimers();
    let finish: (r: TokenSyncPassResult) => void = () => undefined;
    let seen: (() => boolean) | undefined;
    const { processor, renew, release } = setup((_trigger, opts) => {
      seen = opts?.stillHeld;
      return new Promise((resolve) => (finish = resolve));
    });
    const tick = processor.tick();
    await jest.advanceTimersByTimeAsync(TOKEN_SYNC_LOCK_TTL_MS);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(renew).toHaveBeenCalledWith(TOKEN_SYNC_LOCK_TTL_MS);
    expect(seen?.()).toBe(true);
    finish({ complete: true } as TokenSyncPassResult);
    await tick;
    expect(release).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(TOKEN_SYNC_LOCK_TTL_MS);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("a renewal that is refused (or fails) marks the lock lost for good", async () => {
    jest.useFakeTimers();
    const { processor, lock, renew } = setup(() => Promise.resolve({} as TokenSyncPassResult));
    renew.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const held = processor.keepRenewed(lock, 1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(held.stillHeld()).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(held.stillHeld()).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(renew).toHaveBeenCalledTimes(2);
    held.stop();

    renew.mockRejectedValueOnce(new Error("redis down"));
    const failing = processor.keepRenewed(lock, 1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(failing.stillHeld()).toBe(false);
    failing.stop();
  });

  it("a pass stopped for a lost lock is a warning, not an exception; the lock is still released", async () => {
    const { processor, release, captureException } = setup(() =>
      Promise.reject(new TokenSyncAbortedError()),
    );
    await expect(processor.tick()).resolves.toBeNull();
    expect(captureException).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
