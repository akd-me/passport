import { type CompleteOptions, LlmError } from "@passport/agent";
import type { Task, TaskItem, TaskRun } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { detectLimit, parseResetAt } from "./limits.js";
import { recoverRuns } from "./restart.js";
import { gate, taskBackend, waitFor } from "./test-support.js";

const NOW = "2026-10-24T12:00:00.000Z";

describe("usage limit detection", () => {
  it.each([
    ["provider 429", new LlmError("LLM request failed (HTTP 429)", "LLM_HTTP", 429), "provider"],
    [
      "provider 500 is a failure",
      new LlmError("LLM request failed (HTTP 500)", "LLM_HTTP", 500),
      null,
    ],
    [
      "host CLI rate limit code",
      new LlmError("Codex run failed", "HOST_AGENT_RATE_LIMIT"),
      "host_agent",
    ],
    [
      "Claude Code usage limit text",
      new LlmError(
        "Claude Code run failed: Claude AI usage limit reached|1793000000",
        "HOST_AGENT_FAILED",
      ),
      "host_agent",
    ],
    [
      "an unrelated CLI failure",
      new LlmError("Codex exited unexpectedly", "HOST_AGENT_FAILED"),
      null,
    ],
    ["a plain error", new Error("boom"), null],
  ])("%s", (_name, error, source) => {
    expect(detectLimit(error, NOW)?.source ?? null).toBe(source);
  });

  it.each([
    ["Claude AI usage limit reached|1793000000", "2026-10-26T07:33:20.000Z"],
    ["You've hit your usage limit. Try again in 2 hours 5 minutes.", "2026-10-24T14:05:00.000Z"],
    ["Rate limited, retry after 90s", "2026-10-24T12:01:30.000Z"],
    ["Limit resets at 2026-10-24T18:30:00Z", "2026-10-24T18:30:00.000Z"],
    ["Usage limit reached. Try again later.", null],
    ["Limit reset 2020-01-01T00:00:00Z", null],
  ])("parses the reset in %j", (text, expected) => {
    expect(parseResetAt(text, NOW)).toBe(expected);
  });
});

describe("Limited state, restart continuation and titles", () => {
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
  const post = async <T>(env: Env, path: string) => {
    const response = await env.app.request(path, { method: "POST" });
    return { status: response.status, body: (await response.json()) as T };
  };
  const idle = (env: Env, taskId: string) =>
    waitFor(async () =>
      (await env.service.tasks.runs.list(taskId)).every(
        (r) => r.status !== "queued" && r.status !== "running",
      ),
    );
  const fail = (error: Error) => async () => {
    throw error;
  };

  it("a provider 429 stops the run as Limited; resume continues the same request", async () => {
    const env = await setup();
    env.llm.script.push(fail(new LlmError("LLM request failed (HTTP 429)", "LLM_HTTP", 429)));
    const { task, run, done } = await env.service.create({ message: "Archive the receipts" });
    await done.catch(() => undefined);
    await idle(env, task.id);
    const limited = await env.service.task(task.id);
    expect(limited).toMatchObject({
      status: "inbox",
      needsUser: "limited",
      limited: { runId: run.id, resetAt: null, autoResume: false, source: "provider" },
    });
    expect(await env.service.tasks.runs.get(run.id)).toMatchObject({
      status: "failed",
      error: "USAGE_LIMITED",
    });
    expect((await post(env, `/api/tasks/${task.id}/resume-at-reset`)).body).toMatchObject({
      error: { code: "RESET_UNKNOWN" },
    });
    env.llm.script.push("Archived them.");
    const resumed = await post<{ task: Task; run: TaskRun }>(env, `/api/tasks/${task.id}/resume`);
    expect(resumed.status).toBe(202);
    expect(resumed.body.task).toMatchObject({ limited: null, needsUser: null });
    expect(resumed.body.run.trigger).toEqual(run.trigger);
    await idle(env, task.id);
    expect(await env.service.task(task.id)).toMatchObject({
      status: "inbox",
      needsUser: null,
      unseenOutcome: "done",
    });
    const prompt = env.llm.prompts.at(-1) ?? "";
    expect(prompt).toContain("usage limit");
    expect(prompt).toContain("Archive the receipts");
    expect((await post(env, `/api/tasks/${task.id}/resume`)).body).toMatchObject({
      error: { code: "NOT_LIMITED" },
    });
  });

  it("a host CLI limit with a reset time resumes itself at the reset, then runs the queue", async () => {
    const env = await setup();
    const g = gate();
    const resetAt = Date.now() + 800;
    env.llm.script.push(async () => {
      await g.opened;
      throw new LlmError(
        `Claude Code run failed: Claude AI usage limit reached|${resetAt}`,
        "HOST_AGENT_FAILED",
      );
    });
    const { task, done } = await env.service.create({ message: "Summarise the week" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
    const { run: queued } = await env.tasks.queue.send(task.id, { text: "Then the follow-up" });
    g.open();
    await done.catch(() => undefined);
    await waitFor(async () => (await env.service.task(task.id)).needsUser === "limited");
    const limited = await env.service.task(task.id);
    expect(limited.limited).toMatchObject({
      source: "host_agent",
      resetAt: new Date(resetAt).toISOString(),
    });
    // The queue waits while the task is limited.
    expect(limited.queue?.map((e) => e.runId)).toEqual([queued.id]);
    expect((await env.service.tasks.runs.get(queued.id))?.status).toBe("queued");
    env.llm.script.push("Summary.", "Follow-up done.");
    const scheduled = await post<Task>(env, `/api/tasks/${task.id}/resume-at-reset`);
    expect(scheduled.body.limited).toMatchObject({ autoResume: true });
    await waitFor(
      async () => (await env.service.tasks.runs.get(queued.id))?.status === "completed",
      5000,
    );
    await idle(env, task.id);
    const runs = (await env.service.tasks.runs.list(task.id)).reverse();
    expect(runs.map((r) => r.status)).toEqual(["failed", "completed", "completed"]);
    expect(runs.at(-1)?.id).toBe(queued.id);
    expect(env.llm.prompts.at(-2)).toContain("Summarise the week");
    expect(await env.service.task(task.id)).toMatchObject({
      status: "inbox",
      needsUser: null,
      limited: null,
      queue: [],
    });
  });

  it("a new message while limited resumes the stopped run first", async () => {
    const env = await setup();
    env.llm.script.push(fail(new LlmError("Codex run failed", "HOST_AGENT_RATE_LIMIT")));
    const { task, done } = await env.service.create({ message: "First request" });
    await done.catch(() => undefined);
    await idle(env, task.id);
    env.llm.script.push("Continued.", "Second answered.");
    const response = await env.app.request(`/api/tasks/${task.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Second request" }),
    });
    expect(response.status).toBe(202);
    await waitFor(async () => (await env.service.tasks.runs.list(task.id)).length === 3);
    await idle(env, task.id);
    const runs = (await env.service.tasks.runs.list(task.id)).reverse();
    expect(runs.map((r) => r.status)).toEqual(["failed", "completed", "completed"]);
    expect(env.llm.prompts.at(-2)).toContain("First request");
    expect(env.llm.prompts.at(-1)).toContain("Second request");
    expect(await env.service.task(task.id)).toMatchObject({ limited: null, needsUser: null });
  });

  it("continues runs a restart interrupted once, with a RESTARTED notice", async () => {
    const env = await setup();
    env.llm.script.push("First.");
    const { task, done } = await env.service.create({ message: "Chase the invoice" });
    await done;
    await idle(env, task.id);
    const [message] = (await env.service.items(task.id, 0, 10)).filter(
      (i) => i.kind === "user_message",
    );
    const handle = `${env.account.id}:thread:t1`;
    await env.service.runner.updateTask(task.id, {
      status: "working",
      watches: [{ threadHandle: handle, account: env.account.id, since: NOW, consecutiveWakes: 0 }],
    });
    await env.backend.store.kv.set(
      "task-watch-pending",
      JSON.stringify({
        [`${task.id}\n${handle}`]: {
          taskId: task.id,
          threadHandle: handle,
          emailId: "e1",
          row: {},
          kind: "reply",
          due: Date.now() + 3_600_000,
          keys: ["<m1@example.com>"],
        },
      }),
    );
    const crashed = await env.service.tasks.runs.insert({
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
    expect(await env.service.tasks.runs.get(crashed.id)).toMatchObject({
      status: "cancelled",
      error: "SERVER_RESTARTED",
    });
    const runs = await env.service.tasks.runs.list(task.id);
    const continued = runs.find((r) => r.restartOf === crashed.id);
    expect(continued).toMatchObject({ status: "completed", trigger: crashed.trigger });
    const notice = (await env.service.items(task.id, 0, 100)).find(
      (i): i is Extract<TaskItem, { kind: "system_notice" }> =>
        i.kind === "system_notice" && i.payload.code === "RESTARTED",
    );
    expect(notice?.payload.text).toContain("your request");
    expect(notice?.payload.text).toContain("Still watching 1 conversation");
    expect(notice?.payload.text).toContain("1 pending wake will still fire");
    const prompt = env.llm.prompts.at(-1) ?? "";
    expect(prompt).toContain("Passport restarted");
    expect(prompt).toContain(JSON.stringify(handle));
    expect(prompt).toContain("Chase the invoice");
    await env.backend.store.kv.delete("task-watch-pending");

    // A continuation interrupted again fails as before.
    await env.service.tasks.runs.update(continued!.id, { status: "running" });
    await env.service.runner.updateTask(task.id, { status: "working", watches: [] });
    await recoverRuns(env.service, env.tasks.queue);
    expect(await env.service.tasks.runs.get(continued!.id)).toMatchObject({
      status: "failed",
      error: "SERVER_RESTARTED",
    });
    expect(await env.service.task(task.id)).toMatchObject({
      status: "inbox",
      needsUser: "failure",
    });
  });

  it("restart keeps queued follow-ups and runs them", async () => {
    const env = await setup();
    env.llm.script.push("First.");
    const { task, done } = await env.service.create({ message: "Start" });
    await done;
    await idle(env, task.id);
    const placeholder = await env.service.tasks.runs.insert({
      id: "01QUEUEDRUN0000000000000000",
      taskId: task.id,
      status: "queued",
      trigger: { kind: "message", itemId: "", mode: "queue" },
      priority: "interactive",
      agentRunId: "01QUEUEDRUN0000000000000000",
      createdAt: new Date().toISOString(),
      actionIds: [],
    });
    await env.service.runner.updateTask(task.id, {
      queue: [{ runId: placeholder.id, text: "Queued before the restart", createdAt: NOW }],
    });
    env.llm.script.push("Done after restart.");
    await recoverRuns(env.service, env.tasks.queue);
    await waitFor(
      async () => (await env.service.tasks.runs.get(placeholder.id))?.status === "completed",
    );
    expect(env.llm.prompts.at(-1)).toContain("Queued before the restart");
    expect((await env.service.task(task.id)).queue).toEqual([]);
  });

  it("generates a title after the first run until the person renames the task", async () => {
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
        json: { title: "  “Hetzner invoices for 2026.”  " },
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
    env.llm.script.push("Found 9 invoices.");
    const { task, done } = await env.service.create({
      message:
        "Find the Hetzner invoices from this year and attach them to the Taxes matter please",
    });
    expect(task.title.endsWith("…")).toBe(true);
    await done;
    await waitFor(async () => (await env.service.task(task.id)).titleGenerated === true);
    expect(await env.service.task(task.id)).toMatchObject({ title: "Hetzner invoices for 2026" });
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]).toMatchObject({ model: "fast" });
    expect(titleCalls[0]?.messages[0]?.content).toContain("Found 9 invoices.");
    // A second run does not regenerate; renaming clears the flag.
    env.llm.script.push("Attached.");
    await env.tasks.queue.send(task.id, { text: "Attach them" });
    await idle(env, task.id);
    await env.tasks.titles.idle();
    expect(titleCalls).toHaveLength(1);
    const renamed = await env.service.patch(task.id, { title: "Taxes" });
    expect(renamed).toMatchObject({ title: "Taxes", titleGenerated: false });

    env.llm.script.push("Ok.");
    const named = await env.service.create({ message: "Do a thing", title: "My own title" });
    await named.done;
    await env.tasks.titles.idle();
    expect(titleCalls).toHaveLength(1);
    expect((await env.service.task(named.task.id)).titleGenerated).toBeUndefined();
  });
});
