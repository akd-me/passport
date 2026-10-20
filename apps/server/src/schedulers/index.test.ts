import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoBackend } from "../demo/index.js";
import type { Backend } from "../backend.js";
import { startSchedulers, type SchedulerHandle } from "./index.js";

describe("backend schedulers", () => {
  let backend: Backend, handle: SchedulerHandle | undefined;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 7, 59, 59));
    backend = await createDemoBackend();
    backend.config.syncIntervalSeconds = 3600;
    backend.config.dailyDigestHour = 8;
  });
  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    await backend.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("syncs accounts on startup and at the configured interval, discovering newly added accounts", async () => {
    const sync = vi.spyOn(backend, "syncAccount").mockResolvedValue();
    handle = startSchedulers(backend);
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    const account = (await backend.store.accounts.list())[0]!;
    await backend.store.accounts.upsert({ ...account, id: "second" });
    await vi.advanceTimersByTimeAsync(3600000);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(sync).toHaveBeenCalledWith("second");
  });
  it("releases the outbox every 30 seconds and clears all timers on shutdown", async () => {
    const release = vi
      .spyOn(backend.executor, "releaseDue")
      .mockResolvedValue([]);
    handle = startSchedulers(backend);
    await vi.advanceTimersByTimeAsync(29999);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(release).toHaveBeenCalledTimes(2);
    await handle.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(90000);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it("applies decay daily, independent of sync frequency", async () => {
    const decay = vi.spyOn(backend.policy, "applyDecay").mockResolvedValue([]);
    backend.config.syncIntervalSeconds = 604800;
    handle = startSchedulers(backend);
    vi.advanceTimersByTime(86399999);
    await vi.advanceTimersByTimeAsync(0);
    expect(decay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(decay).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(86400000);
    await vi.advanceTimersByTimeAsync(0);
    expect(decay).toHaveBeenCalledTimes(2);
  });
  it("runs daily_digest at the configured local hour and reschedules for the next day", async () => {
    const run = vi.spyOn(backend.agent, "run");
    backend.config.syncIntervalSeconds = 604800;
    handle = startSchedulers(backend);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledWith({
      kind: "schedule",
      name: "daily_digest",
    });
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(86400000);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      run.mock.calls.filter(
        ([trigger]) =>
          trigger.kind === "schedule" && trigger.name === "daily_digest",
      ),
    ).toHaveLength(2);
    expect(run).toHaveBeenCalledWith({
      kind: "schedule",
      name: "matter_review",
    });
  });
  it("does not overlap sync or outbox jobs and drains outstanding work before stop", async () => {
    let finishSync!: () => void, finishRelease!: () => void;
    const sync = vi.spyOn(backend, "syncAccount").mockImplementation(
      () =>
        new Promise<void>((r) => {
          finishSync = r;
        }),
    );
    const release = vi.spyOn(backend.executor, "releaseDue").mockImplementation(
      () =>
        new Promise((r) => {
          finishRelease = () => r([]);
        }),
    );
    backend.config.syncIntervalSeconds = 1;
    handle = startSchedulers(backend);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishSync();
    finishRelease();
    await stopping;
    expect(stopped).toBe(true);
  });
  it("consumes optional push notifications and aborts waitForChanges on shutdown", async () => {
    const account = (await backend.store.accounts.list())[0]!;
    await backend.store.accounts.upsert({
      ...account,
      capabilities: { ...account.capabilities, push: true },
    });
    const sync = vi.spyOn(backend, "syncAccount").mockResolvedValue();
    let change!: () => void;
    const wait = vi.fn(
      (_id: string, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          change = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    backend.waitForChanges = wait;
    handle = startSchedulers(backend);
    await vi.advanceTimersByTimeAsync(0);
    expect(wait).toHaveBeenCalledTimes(1);
    change();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wait).toHaveBeenCalledTimes(2);
    await handle.stop();
    expect(wait.mock.calls[1]?.[1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("recovers from a failed scheduled operation on the next interval", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const release = vi
      .spyOn(backend.executor, "releaseDue")
      .mockRejectedValueOnce(new Error("provider error"))
      .mockResolvedValue([]);
    handle = startSchedulers(backend);
    await vi.advanceTimersByTimeAsync(60000);
    expect(release).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
