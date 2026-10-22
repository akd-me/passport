import type { TaskStatus } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { deliver, gate, taskBackend, toolCall, waitFor } from "./test-support.js";

/** Review r4 regressions: lifecycle writes during runs, steer and maintenance. */
describe("R4 task lifecycle", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((b) => b.close()));
    vi.restoreAllMocks();
  });

  async function setup() {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return taskBackend(backends);
  }
  const ended = (env: Awaited<ReturnType<typeof setup>>, taskId: string) =>
    waitFor(async () =>
      (await env.service.tasks.runs.list(taskId)).every(
        (r) => r.status !== "queued" && r.status !== "running",
      ),
    );

  for (const action of ["archive", "settle", "snooze"] as const) {
    it(`R4-9 ${action} during an active run wins when the run ends`, async () => {
      const env = await setup();
      const g = gate();
      env.llm.script.push(async () => {
        await g.opened;
        return "Done.";
      });
      const { task, done } = await env.service.create({ message: "Long thing" });
      await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
      if (action === "snooze") {
        await env.service.snooze(task.id, new Date(Date.now() + 86_400_000).toISOString());
      } else {
        await env.service[action](task.id);
      }
      g.open();
      await done.catch(() => undefined);
      await ended(env, task.id);
      const expected: Record<typeof action, TaskStatus> = {
        archive: "archived",
        settle: "settled",
        snooze: "snoozed",
      };
      expect((await env.service.task(task.id)).status).toBe(expected[action]);
    });
  }

  it("R4-9 a run cannot start watching after the person settled the task", async () => {
    const env = await setup();
    const first = await deliver(env, {
      providerId: "q1",
      subject: "Quote",
      from: [{ email: "sam@example.com" }],
    });
    await env.backend.drainAgentQueue();
    const g = gate();
    env.llm.script.push(async () => {
      await g.opened;
      return toolCall("watch_conversation", { threadHandle: first.threadId });
    }, "ok");
    const { task, done } = await env.service.create({ message: "Watch Sam" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
    // Settle without the interrupt: models a run that reaches the tool after the person settled.
    await env.service.tasks.update(task.id, {
      status: "settled",
      settledAt: new Date().toISOString(),
    });
    g.open();
    await done.catch(() => undefined);
    await ended(env, task.id);
    const after = await env.service.task(task.id);
    expect(after).toMatchObject({ status: "settled", watches: [] });
    const call = (await env.service.items(task.id, 0, 500)).find((i) => i.kind === "tool_call");
    expect(call?.payload).toMatchObject({ name: "watch_conversation", isError: true });
  });

  it("R4-19 steer keeps the cancelled message on a long task", async () => {
    const env = await setup();
    const { task, done } = await env.service.create({ message: "Start" });
    await done;
    for (let i = 0; i < 520; i++) {
      await env.service.runner.appendItem({
        taskId: task.id,
        runId: null,
        kind: "system_notice",
        at: new Date().toISOString(),
        payload: { text: `filler ${i}` },
      });
    }
    const g = gate();
    env.llm.script.push(async () => {
      await g.opened;
      return "Never shown.";
    }, "Steered.");
    const slow = await env.service.sendMessage(task.id, { text: "Search 2025 too" });
    await waitFor(
      async () => (await env.service.tasks.runs.get(slow.run.id))?.status === "running",
    );
    const statuses: TaskStatus[] = [];
    const off = env.backend.bus.on("task.updated", ({ task: t }) => {
      if (t.id === task.id) {
        statuses.push(t.status);
      }
    });
    await env.service.sendMessage(task.id, { text: "Only Hetzner", mode: "steer" });
    g.open();
    await ended(env, task.id);
    off();
    expect(env.llm.prompts.at(-1)).toContain("Search 2025 too");
    expect(env.llm.prompts.at(-1)).toContain("Only Hetzner");
    // R4-20: no bounce through the inbox while the replacement run starts.
    expect(statuses.slice(0, -1)).not.toContain("inbox");
  });

  it("R4-21 maintenance wakes every due snoozed task, not just the first 500", async () => {
    const env = await setup();
    const past = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    for (let i = 0; i < 510; i++) {
      await env.service.tasks.insert({
        id: `snoozed-${String(i).padStart(4, "0")}`,
        title: `Snoozed ${i}`,
        accountIds: [env.account.id],
        status: "snoozed",
        snoozedUntil: past,
        pinned: false,
        permissionMode: "supervised",
        interactionMode: "default",
        createdBy: "user",
        kind: "task",
        parentTaskId: null,
        needsUser: null,
        lastActivityAt: now,
        createdAt: now,
        watches: [],
        pendingActionIds: [],
      });
    }
    expect(await env.service.maintain()).toMatchObject({ woken: 510 });
    expect((await env.service.list({ status: ["snoozed"], limit: 10 })).items).toEqual([]);
  });
});
