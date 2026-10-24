import { InMemoryEventBus, openStore } from "@passport/store";
import type { Store } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HookRoutine, RoutineWebhooks } from "./webhooks.js";

describe("durable webhook delivery windows", () => {
  let store: Store;
  let hooks: RoutineWebhooks;
  let routine: HookRoutine;
  let dispatch: ReturnType<typeof vi.fn>;
  const bus = new InMemoryEventBus();
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));
    store = openStore({ path: ":memory:" });
    await store.migrate();
    routine = {
      id: "routine:hook",
      enabled: true,
      running: false,
      schedule: {
        type: "webhook",
        dedupe: {
          replayKey: "{{headers.x-delivery}}",
          coalesceKey: "{{body.issue}}",
          coalesceWindowSeconds: 10,
        },
      },
      instruction: "Handle {{body.action}} {{request}}",
    };
    dispatch = vi.fn(async () => ({
      runId: "run",
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: "ok" as const,
    }));
    hooks = new RoutineWebhooks(store, bus, () => routine, dispatch);
    await hooks.load();
    await hooks.ensure(routine.id);
  });
  afterEach(async () => {
    await hooks.stop();
    await store.close();
    vi.useRealTimers();
  });
  const send = (token: string, id: string, action: string, issue = 1) => {
    const request = { body: { issue, action }, headers: { "x-delivery": id }, query: {} };
    return hooks.receive(token, Buffer.from(JSON.stringify(request.body)), request);
  };
  it("keeps the first window deadline and dispatches the latest payload after restart", async () => {
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    expect((await send(token, "one", "opened")).outcome).toBe("accepted");
    await vi.advanceTimersByTimeAsync(9000);
    expect((await send(token, "two", "edited")).outcome).toBe("coalesced");
    expect((await send(token, "two", "duplicate")).outcome).toBe("duplicate");
    expect(dispatch).not.toHaveBeenCalled();
    await hooks.stop();
    hooks = new RoutineWebhooks(store, bus, () => routine, dispatch);
    await hooks.load();
    hooks.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const prompt = dispatch.mock.calls[0]![1];
    expect(prompt).toContain("edited");
    expect(prompt).not.toContain("opened");
    expect(prompt).not.toContain("duplicate");
    await vi.advanceTimersByTimeAsync(30000);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("retains replay memory for seven days across restarts and expires it at the boundary", async () => {
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    await send(token, "one", "opened");
    await vi.advanceTimersByTimeAsync(10000);
    await hooks.stop();
    hooks = new RoutineWebhooks(store, bus, () => routine, dispatch);
    await hooks.load();
    hooks.start();
    vi.setSystemTime(new Date("2026-10-31T11:59:59.999Z"));
    expect((await send(token, "one", "old")).outcome).toBe("duplicate");
    vi.setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
    expect((await send(token, "one", "new")).outcome).toBe("accepted");
  });
  it("keeps keys separate and bounds the per-routine log to the most recent 50", async () => {
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    for (let minute = 0; minute < 6; minute++) {
      for (let index = 0; index < 10; index++) {
        const id = String(minute * 10 + index);
        await send(token, id, id, minute * 10 + index);
      }
      await vi.advanceTimersByTimeAsync(60000);
    }
    expect(dispatch).toHaveBeenCalledTimes(60);
    expect(hooks.deliveries(routine.id)).toHaveLength(50);
    expect(hooks.deliveries(routine.id)[0]?.prompt).toContain("10");
  });
  it("limits coalesced updates and regular deliveries independently", async () => {
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    await send(token, "first", "first");
    for (let index = 0; index < 60; index++) {
      expect((await send(token, "update-" + index, String(index))).outcome).toBe("coalesced");
    }
    expect((await send(token, "excess", "excess")).status).toBe(429);
    await vi.advanceTimersByTimeAsync(10000);
    expect(dispatch.mock.calls[0]![1]).toContain("59");
  });
  it("expires an overdue window and drops paused or deleted work on restart", async () => {
    routine.schedule.maxDeliveryAgeMinutes = 1;
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    await send(token, "one", "opened");
    await hooks.stop();
    vi.setSystemTime(new Date("2026-10-24T12:02:00.000Z"));
    hooks = new RoutineWebhooks(store, bus, () => routine, dispatch);
    await hooks.load();
    hooks.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(hooks.deliveries(routine.id)[0]?.outcome).toBe("expired");
    await send(token, "two", "paused");
    routine.enabled = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(hooks.deliveries(routine.id).at(-1)?.outcome).toBe("disabled");
    routine.enabled = true;
    await send(token, "three", "removed");
    await hooks.remove(routine.id);
    await vi.advanceTimersByTimeAsync(10000);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
