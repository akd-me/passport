import type { DomainEvent, EventBus } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScheduler,
  type JobDefinition,
  nextOccurrence,
  type Scheduler,
  validateSchedule,
} from "./index.js";

const deferred = () => {
  let resolve!: (value: { summary?: string }) => void;
  const promise = new Promise<{ summary?: string }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
describe("persistent scheduler", () => {
  let scheduler: Scheduler, data: Map<string, string>, events: DomainEvent[];
  const setup = (stopTimeoutMs = 50) =>
    createScheduler({
      store: {
        kv: {
          get: async (k) => data.get(k) ?? null,
          set: async (k, v) => {
            data.set(k, v);
          },
          delete: async (k) => {
            data.delete(k);
          },
        },
      },
      bus: {
        emit: (e) => {
          events.push(e);
        },
        on: () => () => {},
        onAny: () => () => {},
      } satisfies EventBus,
      now: () => Date.now(),
      stopTimeoutMs,
    });
  const job = (extra: Partial<JobDefinition> = {}): JobDefinition => ({
    id: "test",
    name: "Test",
    kind: "user",
    schedule: { type: "interval", everyMs: 1000 },
    run: vi.fn(async () => ({ summary: "done" })),
    ...extra,
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    data = new Map();
    events = [];
    scheduler = setup();
  });
  afterEach(async () => {
    const stop = scheduler.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stop;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("runs intervals from scheduled times, persists state and emits lifecycle events", async () => {
    const def = job();
    await scheduler.register(def);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(def.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2001);
    expect(def.run).toHaveBeenCalledTimes(3);
    const state = scheduler.get("test")!;
    expect(state.runCount).toBe(3);
    expect(state.lastStatus).toBe("ok");
    expect(state.history).toHaveLength(3);
    expect(JSON.parse(data.get("job:test")!).runCount).toBe(3);
    expect(events.filter((e) => e.type === "job.started")).toHaveLength(3);
    expect(events.filter((e) => e.type === "job.finished")).toHaveLength(3);
  });
  it("keeps interval cadence when a run takes time", async () => {
    await scheduler.register(
      job({
        run: async () => {
          await new Promise((r) => setTimeout(r, 300));
          return {};
        },
      }),
    );
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(2300);
    expect(scheduler.get("test")!.runCount).toBe(2);
    expect(scheduler.get("test")!.lastDurationMs).toBe(300);
    expect(scheduler.get("test")!.nextRunAt).toBe("2026-03-07T12:00:03.000Z");
  });
  it("handles daily schedules through spring DST in a named time zone", async () => {
    await scheduler.register(
      job({
        schedule: { type: "daily", at: "07:30", timeZone: "America/New_York" },
      }),
    );
    await scheduler.start();
    expect(scheduler.get("test")!.nextRunAt).toBe("2026-03-07T12:30:00.000Z");
    await vi.advanceTimersByTimeAsync(1800000);
    expect(scheduler.get("test")!.nextRunAt).toBe("2026-03-08T11:30:00.000Z");
    await vi.advanceTimersByTimeAsync(23 * 3600000);
    expect(scheduler.get("test")!.runCount).toBe(2);
  });
  it("uses the first valid time in a DST gap and runs once in a fold", () => {
    expect(
      new Date(
        nextOccurrence(
          validateSchedule({
            type: "daily",
            at: "02:30",
            timeZone: "America/New_York",
          }),
          Date.parse("2026-03-08T05:00:00Z"),
        )!,
      ).toISOString(),
    ).toBe("2026-03-08T07:00:00.000Z");
    const s = validateSchedule({
      type: "daily",
      at: "01:30",
      timeZone: "America/New_York",
    });
    expect(new Date(nextOccurrence(s, Date.parse("2026-11-01T05:30:00Z"))!).toISOString()).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });
  it("supports weekly weekdays and validates schedule inputs", () => {
    const s = validateSchedule({
      type: "weekly",
      days: [1, 2, 3, 4, 5],
      at: "07:30",
      timeZone: "UTC",
    });
    expect(new Date(nextOccurrence(s, Date.parse("2026-03-06T08:00:00Z"))!).toISOString()).toBe(
      "2026-03-09T07:30:00.000Z",
    );
    for (const bad of [
      { type: "interval", everyMs: 0 },
      { type: "daily", at: "25:00" },
      { type: "daily", at: "01:00", timeZone: "Mars/Olympus" },
      { type: "weekly", days: [], at: "07:30" },
    ])
      expect(() => validateSchedule(bad)).toThrow();
  });
  it("coalesces missed runs to one after restart and round trips overrides/history", async () => {
    await scheduler.register(job());
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    await scheduler.update("test", {
      schedule: { type: "interval", everyMs: 2000 },
    });
    await scheduler.stop();
    vi.setSystemTime(Date.now() + 100000);
    scheduler = setup();
    const def = job();
    await scheduler.register(def);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(def.run).toHaveBeenCalledTimes(1);
    expect(scheduler.get("test")!.runCount).toBe(2);
    expect(scheduler.get("test")!.schedule).toEqual({
      type: "interval",
      everyMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(def.run).toHaveBeenCalledTimes(2);
  });
  it("records single-flight skips without overlapping work", async () => {
    const d = deferred(),
      def = job({ run: vi.fn(() => d.promise) });
    await scheduler.register(def);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(def.run).toHaveBeenCalledTimes(1);
    expect(scheduler.get("test")!.history.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect((await scheduler.runNow("test")).status).toBe("skipped");
    d.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.get("test")!.runCount).toBe(1);
  });
  it("backs off exponentially, caps retries and resets after success", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"))
      .mockResolvedValue({});
    await scheduler.register(job({ run, retry: { maxAttempts: 5, baseMs: 100, maxMs: 250 } }));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(Date.parse(scheduler.get("test")!.nextRunAt!) - Date.now()).toBe(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(Date.parse(scheduler.get("test")!.nextRunAt!) - Date.now()).toBe(200);
    await vi.advanceTimersByTimeAsync(200);
    expect(Date.parse(scheduler.get("test")!.nextRunAt!) - Date.now()).toBe(250);
    await vi.advanceTimersByTimeAsync(250);
    expect(scheduler.get("test")!.consecutiveFailures).toBe(0);
    expect(scheduler.get("test")!.lastError).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(5);
  });
  it("returns to the schedule when maxAttempts is exhausted", async () => {
    await scheduler.register(
      job({
        run: async () => {
          throw new Error("offline");
        },
        retry: { maxAttempts: 2, baseMs: 100, maxMs: 500 },
      }),
    );
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(scheduler.get("test")!.consecutiveFailures).toBe(2);
    expect(Date.parse(scheduler.get("test")!.nextRunAt!) - Date.now()).toBe(1000);
  });
  it("aborts on timeout and keeps noncooperating work single-flight", async () => {
    let signal!: AbortSignal;
    const d = deferred();
    await scheduler.register(
      job({
        timeoutMs: 100,
        run: async (ctx) => {
          signal = ctx.signal;
          return d.promise;
        },
      }),
    );
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1100);
    expect(signal.aborted).toBe(true);
    expect(scheduler.get("test")!.lastStatus).toBe("error");
    expect(scheduler.get("test")!.lastError).toMatch(/timed out/);
    expect((await scheduler.runNow("test")).status).toBe("skipped");
    d.resolve({});
    await vi.advanceTimersByTimeAsync(0);
  });
  it("pauses, resumes and manually runs paused jobs; paused state survives restart", async () => {
    const def = job();
    await scheduler.register(def);
    await scheduler.pause("test");
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(def.run).not.toHaveBeenCalled();
    await scheduler.runNow("test");
    expect(scheduler.get("test")!.nextRunAt).toBeNull();
    await scheduler.stop();
    scheduler = setup();
    await scheduler.register(def);
    expect(scheduler.get("test")!.enabled).toBe(false);
    await scheduler.start();
    await scheduler.resume("test");
    await vi.advanceTimersByTimeAsync(1000);
    expect(def.run).toHaveBeenCalledTimes(2);
  });
  it("removes user jobs and rejects deleting system jobs", async () => {
    await scheduler.register(job());
    await scheduler.remove("test");
    expect(scheduler.list()).toEqual([]);
    expect(data.has("job:test")).toBe(false);
    await scheduler.register(job({ kind: "system" }));
    await expect(scheduler.remove("test")).rejects.toHaveProperty("code", "SYSTEM_JOB");
    await expect(scheduler.runNow("missing")).rejects.toHaveProperty("code", "JOB_NOT_FOUND");
  });
  it("limits history to 20 and returns independent state snapshots", async () => {
    await scheduler.register(job({ schedule: { type: "manual" } }));
    await scheduler.start();
    for (let i = 0; i < 25; i++) await scheduler.runNow("test");
    expect(scheduler.get("test")!.history).toHaveLength(20);
    scheduler.get("test")!.history.pop();
    expect(scheduler.get("test")!.history).toHaveLength(20);
  });
  it("drains work on stop, bounds uncooperative jobs and clears timers", async () => {
    const d = deferred();
    await scheduler.register(job({ run: () => d.promise }));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    const stop = scheduler.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stop;
    expect(vi.getTimerCount()).toBe(0);
    d.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("caps exponential backoff at one hour including jitter", async () => {
    vi.mocked(Math.random).mockReturnValue(0.99);
    await scheduler.register(
      job({
        run: async () => {
          throw new Error("offline");
        },
        retry: { maxAttempts: 100, baseMs: 3600000, maxMs: 7200000 },
      }),
    );
    await scheduler.runNow("test");
    expect(Date.parse(scheduler.get("test")!.nextRunAt!) - Date.now()).toBe(3600000);
    await scheduler.runNow("test");
    expect(Date.parse(scheduler.get("test")!.nextRunAt!) - Date.now()).toBe(3600000);
  });
  it("manual recovery resets a pending backoff to the regular schedule", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    await scheduler.register(
      job({ run, schedule: { type: "daily", at: "13:00", timeZone: "UTC" } }),
    );
    await scheduler.runNow("test");
    expect(Date.parse(scheduler.get("test")!.nextRunAt!) - Date.now()).toBe(1000);
    await scheduler.runNow("test");
    expect(scheduler.get("test")!.nextRunAt).toBe("2026-03-07T13:00:00.000Z");
  });
  it("drains removed handlers and clears their timeout timers", async () => {
    const d = deferred();
    await scheduler.register(job({ run: () => d.promise, timeoutMs: 10000 }));
    const run = scheduler.runNow("test");
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.remove("test");
    await expect(scheduler.register(job())).rejects.toHaveProperty("code", "JOB_STILL_RUNNING");
    let stopped = false;
    const stop = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(stopped).toBe(false);
    d.resolve({});
    await run;
    await stop;
    expect(vi.getTimerCount()).toBe(0);
    expect(data.has("job:test")).toBe(false);
    await scheduler.register(job());
  });
  it("clears handler deadlines when shutdown reaches its drain limit", async () => {
    const d = deferred();
    await scheduler.register(job({ run: () => d.promise, timeoutMs: 10000 }));
    const run = scheduler.runNow("test");
    await vi.advanceTimersByTimeAsync(0);
    const stop = scheduler.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stop;
    expect(vi.getTimerCount()).toBe(0);
    await expect(scheduler.start()).rejects.toHaveProperty("code", "JOB_STILL_RUNNING");
    d.resolve({});
    await run;
    await scheduler.start();
    await scheduler.stop();
  });
});

describe("R10 interrupted occurrence recovery", () => {
  it.each([undefined, 2000])(
    "R10 recovers an unfinished occurrence exactly once on restart (timeout %s)",
    async (timeoutMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
      const data = new Map<string, string>();
      const options = {
        store: {
          kv: {
            get: async (key: string) => data.get(key) ?? null,
            set: async (key: string, value: string) => {
              data.set(key, value);
            },
            delete: async (key: string) => {
              data.delete(key);
            },
          },
        },
        bus: { emit: () => {}, on: () => () => {}, onAny: () => () => {} } as EventBus,
        stopTimeoutMs: 1,
      };
      const original = createScheduler(options);
      let restarted: Scheduler | undefined;
      const def = {
        id: "interrupted",
        name: "Interrupted",
        kind: "user" as const,
        schedule: { type: "interval" as const, everyMs: 60_000 },
        timeoutMs,
      };
      try {
        await original.register({ ...def, run: () => new Promise(() => {}) });
        await original.start();
        await vi.advanceTimersByTimeAsync(60_000);
        const saved = JSON.parse(data.get("job:interrupted")!);
        expect(saved.activeRun).toMatchObject({
          occurrenceAt: "2026-10-20T12:01:00.000Z",
          startedAt: "2026-10-20T12:01:00.000Z",
          runId: expect.any(String),
        });
        const stop = original.stop();
        await vi.advanceTimersByTimeAsync(1);
        await stop;
        const occurrences: string[] = [];
        restarted = createScheduler(options);
        const run = vi.fn(async () => {
          occurrences.push(restarted!.get("interrupted")!.activeRun!.occurrenceAt);
          return {};
        });
        await restarted.register({ ...def, run });
        await restarted.start();
        await vi.advanceTimersByTimeAsync(0);
        if (timeoutMs) {
          expect(run).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(timeoutMs);
        }
        expect(run).toHaveBeenCalledTimes(1);
        expect(occurrences).toEqual([saved.activeRun.occurrenceAt]);
        expect(JSON.parse(data.get("job:interrupted")!).activeRun).toBeNull();
        await restarted.stop();
        const again = createScheduler(options);
        await again.register({ ...def, run });
        await again.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledTimes(1);
        await again.stop();
      } finally {
        if (restarted) await restarted.stop();
        vi.useRealTimers();
      }
    },
  );
});
