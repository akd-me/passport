/** R1 review, lifecycle (C1): regressions for R1-15, R1-16, R1-17, R1-26 to R1-29, R1-31, R1-32. */
import { type CompleteOptions, LlmError } from "@passport/agent";
import type { Task } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { parseResetAt } from "./limits.js";
import { recoverRuns } from "./restart.js";
import { gate, taskBackend, waitFor } from "./test-support.js";

const backends: RealBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
  vi.restoreAllMocks();
});
async function setup() {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return taskBackend(backends);
}
type Env = Awaited<ReturnType<typeof setup>>;
const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const post = async <T>(env: Env, path: string, body?: unknown) => {
  const r = await env.app.request(path, body === undefined ? { method: "POST" } : json(body));
  return { status: r.status, body: (await r.json()) as T };
};
const idle = (env: Env, taskId: string) =>
  waitFor(async () => {
    const queued = new Set((await env.service.task(taskId)).queue?.map((e) => e.runId));
    return (await env.service.tasks.runs.list(taskId)).every(
      (r) => queued.has(r.id) || (r.status !== "queued" && r.status !== "running"),
    );
  });
const fail = (error: Error) => async () => {
  throw error;
};

describe("R1 lifecycle fixes", () => {
  it("R1-15 auto-resume at reset leaves a settled or archived task where the person put it", async () => {
    for (const away of ["settle", "archive"] as const) {
      const env = await setup();
      const resetAt = Date.now() + 500;
      env.llm.script.push(
        fail(
          new LlmError(
            `Claude Code run failed: Claude AI usage limit reached|${resetAt}`,
            "HOST_AGENT_FAILED",
          ),
        ),
      );
      const { task, done } = await env.service.create({ message: "Summarise the week" });
      await done.catch(() => undefined);
      await idle(env, task.id);
      await post(env, `/api/tasks/${task.id}/resume-at-reset`);
      const put = await post<Task>(env, `/api/tasks/${task.id}/${away}`);
      expect(put.body.status).toBe(away === "settle" ? "settled" : "archived");
      expect(put.body.limited?.autoResume).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(await env.tasks.limits.maintain()).toBe(0);
      await idle(env, task.id);
      const after = await env.service.task(task.id);
      expect(after.status).toBe(away === "settle" ? "settled" : "archived");
      expect(await env.service.tasks.runs.list(task.id)).toHaveLength(1);
    }
  });

  it("R1-16 a restart continuation keeps the snooze the person chose", async () => {
    const env = await setup();
    env.llm.script.push("First.");
    const { task, done } = await env.service.create({ message: "Chase the invoice" });
    await done;
    await idle(env, task.id);
    const [message] = (await env.service.items(task.id, 0, 10)).filter(
      (i) => i.kind === "user_message",
    );
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await env.service.runner.updateTask(task.id, { status: "snoozed", snoozedUntil: until });
    await env.service.tasks.runs.insert({
      id: "01RESTARTEDRUN000000000000",
      taskId: task.id,
      status: "running",
      trigger: { kind: "message", itemId: message!.id, mode: "queue" },
      priority: "interactive",
      agentRunId: "01RESTARTEDRUN000000000000",
      createdAt: new Date().toISOString(),
      actionIds: [],
    });
    env.llm.script.push("Picked it back up.");
    await recoverRuns(env.service, env.tasks.queue);
    await idle(env, task.id);
    const after = await env.service.task(task.id);
    expect(after.status).toBe("snoozed");
    expect(after.snoozedUntil).toBe(until);
    expect((await env.service.get(task.id)).runs.find((run) => run.restartOf)?.status).toBe(
      "completed",
    );
  });

  it("R1-17 a continuation of a steered run repeats both messages and the history", async () => {
    const env = await setup();
    const g = gate();
    env.llm.script.push(async () => {
      await g.opened;
      return "ignored";
    });
    const { task } = await env.service.create({ message: "Find the Hetzner invoices" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
    env.llm.script.push("Steered done.");
    const { run: steer } = await env.tasks.queue.send(task.id, {
      text: "only the PDFs",
      mode: "steer",
    });
    g.open();
    await idle(env, task.id);
    const steerPrompt = env.llm.prompts.at(-1) ?? "";
    expect(steerPrompt).toContain("Find the Hetzner invoices");
    // Pretend the process died during the steer's run.
    await env.service.tasks.runs.update(steer.id, { status: "running" });
    await env.service.runner.updateTask(task.id, { status: "working" });
    env.llm.script.push("Continued.");
    await recoverRuns(env.service, env.tasks.queue);
    await idle(env, task.id);
    const prompt = env.llm.prompts.at(-1) ?? "";
    expect(prompt).toContain("The person's request:\nFind the Hetzner invoices\n\nonly the PDFs");
    expect(prompt).toContain("Earlier in this task");
  });

  it("R1-26 resume keeps the Approval state of pending proposals", async () => {
    const env = await setup();
    env.llm.script.push(fail(new LlmError("Codex run failed", "HOST_AGENT_RATE_LIMIT")));
    const { task, done } = await env.service.create({ message: "First request" });
    await done.catch(() => undefined);
    await idle(env, task.id);
    await env.service.runner.updateTask(task.id, {
      pendingActionIds: ["01FAKEACTION0000000000000"],
    });
    const g = gate();
    env.llm.script.push(async () => {
      await g.opened;
      return "Continued.";
    });
    const resumed = await post<{ task: Task }>(env, `/api/tasks/${task.id}/resume`);
    expect(resumed.body.task.needsUser).toBe("approval");
    expect(resumed.body.task.pendingActionIds).toHaveLength(1);
    g.open();
    await idle(env, task.id);
  });

  it("R1-27 a snooze wake goes through the status rules like /unsnooze", async () => {
    const env = await setup();
    env.llm.script.push("First.");
    const { task, done } = await env.service.create({ message: "Watch this" });
    await done;
    await idle(env, task.id);
    const handle = `${env.account.id}:thread:t1`;
    await env.service.runner.updateTask(task.id, {
      status: "snoozed",
      snoozedUntil: new Date(Date.now() - 1000).toISOString(),
      watches: [
        {
          threadHandle: handle,
          account: env.account.id,
          since: new Date().toISOString(),
          consecutiveWakes: 0,
        },
      ],
    });
    await env.service.maintain();
    const woke = await env.service.task(task.id);
    expect(woke).toMatchObject({ status: "working", unseenOutcome: "woke", snoozedUntil: null });
    await env.service.runner.updateTask(task.id, { status: "snoozed" });
    const reopened = await post<Task>(env, `/api/tasks/${task.id}/unsnooze`);
    expect(reopened.body.status).toBe("working");
  });

  it("R1-29 the run a steer starts gets the generated title", async () => {
    const env = await setup();
    const complete = env.llm.complete.bind(env.llm);
    const titleCalls: CompleteOptions[] = [];
    vi.spyOn(env.llm, "complete").mockImplementation(async (options) => {
      if (!options.json?.properties?.title) {
        return complete(options);
      }
      titleCalls.push(options);
      return {
        text: "",
        json: { title: "Generated" },
        toolCalls: [],
        model: "fast",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      };
    });
    const g = gate();
    env.llm.script.push(async () => {
      await g.opened;
      return "x";
    });
    const { task } = await env.service.create({ message: "A long first request about invoices" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
    env.llm.script.push("Steered done.");
    await env.tasks.queue.send(task.id, { text: "only PDFs", mode: "steer" });
    g.open();
    await idle(env, task.id);
    await env.tasks.titles.idle();
    const after = await env.service.task(task.id);
    expect(titleCalls).toHaveLength(1);
    expect(after).toMatchObject({ title: "Generated", titleGenerated: true });
  });

  it("R1-31 Stop leaves no Done badge", async () => {
    const env = await setup();
    const g = gate();
    env.llm.script.push(async () => {
      await g.opened;
      return "x";
    });
    const { task } = await env.service.create({ message: "Long thing" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
    await post(env, `/api/tasks/${task.id}/interrupt`);
    g.open();
    await idle(env, task.id);
    const after = await env.service.task(task.id);
    expect(after.status).toBe("inbox");
    expect(after.unseenOutcome ?? null).toBeNull();
  });

  it("R1-32 snoozing a busy task holds its queued follow-up", async () => {
    const env = await setup();
    const g = gate();
    env.llm.script.push(async () => {
      await g.opened;
      return "first";
    });
    const { task } = await env.service.create({ message: "Long thing" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
    await post(env, `/api/tasks/${task.id}/messages`, { text: "and then this" });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const snoozed = await post<Task>(env, `/api/tasks/${task.id}/snooze`, { until });
    expect(snoozed.body.status).toBe("snoozed");
    env.llm.script.push("second");
    g.open();
    await idle(env, task.id);
    const after = await env.service.task(task.id);
    expect(after).toMatchObject({ status: "snoozed", snoozedUntil: until, queueHeld: true });
    expect(after.queue).toHaveLength(1);
  });

  it("R1-28 parseResetAt reads milliseconds as milliseconds", () => {
    const NOW = "2026-10-24T12:00:00.000Z";
    expect(parseResetAt("Rate limit reached. Please try again in 340ms.", NOW)).toBe(
      "2026-10-24T12:00:00.340Z",
    );
    expect(parseResetAt("try again in 2 hours 5 minutes", NOW)).toBe("2026-10-24T14:05:00.000Z");
  });
});
