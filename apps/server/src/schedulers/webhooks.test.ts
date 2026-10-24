import { createHmac } from "node:crypto";
import { InMemoryEventBus, openStore } from "@passport/store";
import type { Store } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HookRoutine,
  MAX_PENDING_GLOBAL,
  MAX_PENDING_PER_ROUTINE,
  RoutineWebhooks,
} from "./webhooks.js";

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
    const writes = vi.spyOn(store.kv, "set");
    expect((await send(token, "flood", "flood")).status).toBe(429);
    expect(writes).not.toHaveBeenCalled();
    dispatch.mockResolvedValueOnce({
      runId: "failed",
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: "error",
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(dispatch.mock.calls[0]![1]).toContain("59");
    expect(
      hooks.deliveries(routine.id).some((delivery) => delivery.outcome === "dispatch_failed"),
    ).toBe(true);
  });
  it("counts only accepted new windows after filtered, duplicate and expired deliveries", async () => {
    routine.schedule.filters = [{ path: "body.action", op: "equals", value: "opened" }];
    routine.schedule.maxDeliveryAgeMinutes = 1;
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    // R1 repro: ten filtered events must leave all ten real windows available.
    for (let index = 0; index < 10; index++) {
      expect((await send(token, "filtered-" + index, "ignored")).outcome).toBe("filtered");
    }
    const request = {
      body: { action: "opened" },
      headers: { "x-webhook-timestamp": "2026-10-24T11:00:00.000Z" },
      query: {},
    };
    expect((await hooks.receive(token, Buffer.from("{}"), request)).outcome).toBe("expired");
    expect((await send(token, "one", "opened")).outcome).toBe("accepted");
    for (let index = 0; index < 10; index++) {
      expect((await send(token, "one", "opened")).outcome).toBe("duplicate");
    }
    for (let index = 1; index < 10; index++) {
      expect((await send(token, "real-" + index, "opened", index + 1)).outcome).toBe("accepted");
    }
    expect((await send(token, "excess", "opened", 11)).status).toBe(429);
  });
  it("keeps correctly signed deliveries available after a flood of bad signatures", async () => {
    routine.schedule = {
      type: "webhook",
      signature: { header: "x-sig", encoding: "hex", secretRef: "installed" },
    };
    await store.encryptedKv!.set("webhook-signature:" + routine.id, "signing-key");
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    const raw = Buffer.from("{}");
    const sendSigned = (signature: string) =>
      hooks.receive(token, raw, {
        body: {},
        headers: { "x-sig": signature },
        query: {},
      });
    for (let index = 0; index < 100; index++) {
      expect((await sendSigned("0".repeat(64))).status).toBe(index < 10 ? 401 : 429);
    }
    const signature = createHmac("sha256", "signing-key").update(raw).digest("hex");
    for (let index = 0; index < 10; index++) {
      expect((await sendSigned(signature)).outcome).toBe("accepted");
    }
    expect((await sendSigned(signature)).status).toBe(429);
    expect(
      hooks.deliveries(routine.id).filter((entry) => entry.outcome === "rejected_signature"),
    ).toHaveLength(10);
  });
  it("caps queued work across minutes while dispatch is blocked and keeps full prompts out of history", async () => {
    // Adapted from the R1 pending-growth and 28 MB shared-blob reproductions.
    routine.schedule = { type: "webhook" };
    routine.instruction = "{{body}}{{body}}{{body}}{{body}}";
    dispatch.mockImplementation(() => new Promise(() => {}));
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    for (let index = 0; index < MAX_PENDING_PER_ROUTINE; index++) {
      const body = "x".repeat(250 * 1024);
      expect(
        (
          await hooks.receive(token, Buffer.from(body), {
            body,
            bodyText: body,
            headers: {},
            query: {},
          })
        ).status,
      ).toBe(202);
      await vi.advanceTimersByTimeAsync(60000);
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await send(token, "overflow", "opened")).status).toBe(429);
    const state = JSON.parse((await store.kv.get("scheduler:webhooks:" + routine.id))!);
    expect(state.pending).toHaveLength(MAX_PENDING_PER_ROUTINE);
    expect(state.pending[0].prompt.length).toBeGreaterThan(250000);
    expect(
      state.deliveries.every(
        (entry: { prompt?: string }) => !entry.prompt || entry.prompt.length <= 2048,
      ),
    ).toBe(true);
    expect(await store.kv.get("scheduler:webhooks")).toBeNull();
    await hooks.stop();
    hooks = new RoutineWebhooks(store, bus, () => routine, dispatch);
    await hooks.load();
    expect((await send(token, "restart-overflow", "opened")).status).toBe(429);
  });
  it("caps windows globally, releases capacity on removal and writes only the receiving routine", async () => {
    await hooks.stop();
    const routines = new Map<string, HookRoutine>();
    hooks = new RoutineWebhooks(store, bus, (id) => routines.get(id), dispatch);
    await hooks.load();
    for (let index = 0; index <= MAX_PENDING_GLOBAL / MAX_PENDING_PER_ROUTINE; index++) {
      const id = "global-" + index;
      routines.set(id, { ...routine, id, schedule: { type: "webhook" } });
      await hooks.ensure(id);
    }
    const writes = vi.spyOn(store.kv, "set");
    for (let index = 0; index < MAX_PENDING_GLOBAL; index++) {
      const id = "global-" + Math.floor(index / MAX_PENDING_PER_ROUTINE);
      const token = hooks.path(id)!.split("/").at(-1)!;
      expect((await send(token, String(index), "opened")).status).toBe(202);
      expect(writes.mock.lastCall?.[0]).toBe("scheduler:webhooks:" + id);
    }
    expect(writes.mock.calls.every(([key]) => key.startsWith("scheduler:webhooks:global-"))).toBe(
      true,
    );
    const token = hooks.path("global-10")!.split("/").at(-1)!;
    expect((await send(token, "full", "opened")).status).toBe(429);
    await hooks.stop();
    hooks = new RoutineWebhooks(store, bus, (id) => routines.get(id), dispatch);
    await hooks.load();
    expect((await send(token, "still-full", "opened")).status).toBe(429);
    await hooks.remove("global-0");
    expect((await send(token, "room", "opened")).status).toBe(202);
  });
  it("migrates the shared record with tokens, windows, replay and rate limits intact", async () => {
    const token = hooks.path(routine.id)!.split("/").at(-1)!;
    await send(token, "one", "opened");
    const saved = await store.kv.get("scheduler:webhooks:" + routine.id);
    await hooks.stop();
    await store.kv.set("scheduler:webhooks", JSON.stringify({ [routine.id]: JSON.parse(saved!) }));
    await store.kv.delete("scheduler:webhooks:index");
    await store.kv.delete("scheduler:webhooks:" + routine.id);
    hooks = new RoutineWebhooks(store, bus, () => routine, dispatch);
    await hooks.load();
    expect(hooks.path(routine.id)).toBe("/api/hooks/" + token);
    expect((await send(token, "one", "opened")).outcome).toBe("duplicate");
    hooks.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await store.kv.get("scheduler:webhooks")).toBeNull();
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
