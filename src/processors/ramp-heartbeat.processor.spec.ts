import type { Config } from "../config";
import type { RampReconRunEntity } from "../entities/ramp-recon-run.entity";
import type { RampReconciliationService } from "../services/ramp-reconciliation.service";
import type { RedisService } from "../services/redis.service";
import type { SentryService } from "../services/sentry.service";
import { RampHeartbeatProcessor } from "./ramp-heartbeat.processor";

const MIN = 60_000;

function setup(opts: { scanMs?: number; finishedAt?: Date | null }) {
  let finishedAt = opts.finishedAt;
  const reconciliation = {
    latestFullRun: () =>
      Promise.resolve(finishedAt === null ? null : ({ finishedAt } as RampReconRunEntity)),
  } as unknown as RampReconciliationService;
  const claimed = new Set<string>();
  const redis = {
    claimOnce: (key: string) => Promise.resolve(!claimed.has(key) && Boolean(claimed.add(key))),
  } as unknown as RedisService;
  const captureMessage = jest.fn();
  const sentry = { captureMessage, captureException: jest.fn() } as unknown as SentryService;
  const config = {
    ramp: { scanMs: opts.scanMs ?? 10_000 },
    rampControls: { reconMaxAgeMin: 60 },
  } as unknown as Config;
  const processor = new RampHeartbeatProcessor(config, reconciliation, redis, sentry);
  const later = (min: number) => new Date(Date.now() + min * MIN);
  return {
    processor,
    captureMessage,
    later,
    setFinished: (d: Date | null) => (finishedAt = d),
  };
}

describe("RampHeartbeatProcessor (C33)", () => {
  it("a full run inside RAMP_RECON_MAX_AGE_MIN is fine; an older one pages once an hour across instances", async () => {
    const { processor, captureMessage, later, setFinished } = setup({ finishedAt: new Date() });
    expect(await processor.check(later(90))).toEqual({ stale: true, ageMin: 90 });
    expect(captureMessage).toHaveBeenCalledWith("ramp reconciliation is stale", "error", {
      component: "ramp-recon",
      page: "true",
    });
    expect(await processor.check(later(95))).toMatchObject({ stale: true });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    setFinished(later(100));
    expect(await processor.check(later(110))).toEqual({ stale: false, ageMin: 10 });
  });

  it("no run at all pages once the boot grace (RAMP_RECON_MAX_AGE_MIN) is over, never before", async () => {
    const { processor, captureMessage, later } = setup({ finishedAt: null });
    expect(await processor.check(later(30))).toEqual({ stale: false, ageMin: null });
    expect(captureMessage).not.toHaveBeenCalled();
    expect(await processor.check(later(61))).toEqual({ stale: true, ageMin: null });
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("with the ramp's loops off (RAMP_SCAN_MS=0, off-prod only) it warns at boot and starts no timer", () => {
    const { processor } = setup({ scanMs: 0 });
    const warn = jest
      .spyOn((processor as unknown as { logger: { warn: () => void } }).logger, "warn")
      .mockImplementation(() => undefined);
    const interval = jest.spyOn(global, "setInterval");
    processor.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^RAMP_SCAN_MS=0: .*full reconciliation/),
    );
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });
});
