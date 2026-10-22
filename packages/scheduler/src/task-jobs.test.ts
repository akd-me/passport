import type { DomainEvent } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import { createScheduler, type JobContext } from "./index.js";

const memory = () => {
  const data = new Map<string, string>();
  return {
    kv: {
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string) => {
        data.set(k, v);
      },
      delete: async (k: string) => {
        data.delete(k);
      },
    },
  };
};
const bus = { emit: (_: DomainEvent) => {}, on: () => () => {}, onAny: () => () => {} };

describe("task-bound jobs", () => {
  it("runs jobs with taskId through runOnTask and exposes the binding", async () => {
    const seen: JobContext[] = [];
    const runOnTask = vi.fn(
      async (
        taskId: string,
        ctx: JobContext,
        run: (c: JobContext) => Promise<{ summary?: string }>,
      ) => run({ ...ctx, agentRunOptions: { runId: `task-run:${taskId}` } }),
    );
    const scheduler = createScheduler({ store: memory(), bus, runOnTask });
    await scheduler.register({
      id: "routine",
      name: "Routine",
      kind: "user",
      taskId: "task-1",
      schedule: { type: "interval", everyMs: 60_000 },
      run: async (ctx) => {
        seen.push(ctx);
        return { summary: "ok" };
      },
    });
    await scheduler.register({
      id: "plain",
      name: "Plain",
      kind: "system",
      schedule: { type: "interval", everyMs: 60_000 },
      run: async (ctx) => {
        seen.push(ctx);
        return {};
      },
    });
    expect(scheduler.get("routine")?.taskId).toBe("task-1");
    expect(scheduler.get("plain")?.taskId).toBeUndefined();
    await scheduler.runNow("routine");
    await scheduler.runNow("plain");
    expect(runOnTask).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({
      taskId: "task-1",
      agentRunOptions: { runId: "task-run:task-1" },
    });
    expect(seen[1]?.taskId).toBeUndefined();
    await scheduler.stop();
  });
});
