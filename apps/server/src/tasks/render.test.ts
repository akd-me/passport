import { createToolRegistry } from "@passport/tools";
import type { ActionRecord, DraftInput, TaskItem } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { taskBackend, toolCall } from "./test-support.js";

const backends: RealBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  vi.restoreAllMocks();
});
const body = (value: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
const renderArgs = {
  title: "Today",
  html: '<h2>Day</h2><script>bad()</script><table><tr><td onclick="bad()">1</td></tr></table>',
};

describe("render task output", () => {
  it("records a sanitised untrusted item through an API-provider run and its HTTP timeline", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push(toolCall("render", renderArgs), "Ready.");
    const { task, done } = await env.service.create({ message: "Summarise today" });
    await done;
    const response = await env.app.request(`/api/tasks/${task.id}/items`);
    const { items } = (await response.json()) as { items: TaskItem[] };
    const item = items.find((item) => item.kind === "render");
    expect(item).toMatchObject({
      taskId: task.id,
      untrusted: true,
      payload: {
        title: "Today",
        html: "<h2>Day</h2><table><tr><td>1</td></tr></table>",
        height: expect.any(Number),
      },
    });
    expect((await env.service.get(task.id)).runs[0]?.usage?.toolCalls).toBe(1);
    expect(JSON.stringify(items.filter((item) => item.kind === "tool_call"))).not.toContain(
      "bad()",
    );
  });

  it("caps ten concurrent renders across registries, persists the count, and resets per run", async () => {
    const env = await taskBackend(backends);
    const { task, run, done } = await env.service.create({ message: "Start" });
    await done;
    await env.service.tasks.runs.update(run.id, { status: "running" });
    const make = () =>
      createToolRegistry({
        store: env.backend.store,
        policy: env.backend.policy,
        executor: env.backend.executor,
        bus: env.backend.bus,
        selfAddresses: [],
        actor: { kind: "agent", id: run.agentRunId },
      }).find((tool) => tool.name === "render")!;
    const context = { runId: run.agentRunId, taskId: task.id };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => make().handler(renderArgs, context)),
    );
    expect(results.filter((result) => result.status === "rendered")).toHaveLength(10);
    expect(results.filter((result) => result.error === "RENDER_LIMIT")).toHaveLength(2);
    expect(await make().handler(renderArgs, context)).toMatchObject({ error: "RENDER_LIMIT" });
    await env.service.tasks.runs.update(run.id, { status: "completed" });
    env.llm.script.push(toolCall("render", { ...renderArgs, height: 80 }), "Ready.");
    await env.service.sendMessage(task.id, { text: "Another" });
    const { waitFor } = await import("./test-support.js");
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "completed");
    expect(
      (await env.service.items(task.id, 0, 500)).filter((item) => item.kind === "render"),
    ).toHaveLength(11);
    expect(await make().handler(renderArgs)).toMatchObject({ error: "TASK_REQUIRED" });
  });

  it("asks the daily digest routine for one render from framed evidence", async () => {
    const env = await taskBackend(backends);
    const task = await env.backend.tasks!.triggers.ensureRoutine("digest-test", "Daily digest");
    const run = await env.service.tasks.runs.insert({
      id: "digest-run",
      agentRunId: "digest-run",
      taskId: task.id,
      trigger: { kind: "schedule", name: "Daily digest", jobId: "digest-test" },
      status: "running",
      priority: "background",
      createdAt: new Date().toISOString(),
      actionIds: [],
    });
    env.llm.script.push(
      toolCall("render", { title: "Day", html: "<p>No changes today.</p>" }),
      "Ready.",
    );
    const result = await env.backend.agent.run(
      { kind: "schedule", name: "daily_digest" },
      { taskId: task.id, runId: run.id },
    );
    expect(result.error).toBeUndefined();
    expect(env.llm.prompts.join("\n")).toContain("Create exactly one render summarising the day");
    expect(env.llm.prompts.join("\n")).toMatch(
      /<untrusted-data-[\da-f]+ source="daily digest evidence">/,
    );
    expect(
      (await env.service.items(task.id, 0, 500)).filter((item) => item.kind === "render"),
    ).toHaveLength(1);
  });
});

describe("rich preview and draft save routes", () => {
  it("sanitises preview HTML with the tool's parser and rejects oversized/invalid input", async () => {
    const env = await taskBackend(backends);
    const response = await env.app.request("/api/render/preview", body({ html: renderArgs.html }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      html: "<h2>Day</h2><table><tr><td>1</td></tr></table>",
    });
    for (const input of [
      { html: "é".repeat(33000) },
      { html: "x", height: 79 },
      { html: "x", height: "80" },
      { html: "x", extra: true },
    ]) {
      expect((await env.app.request("/api/render/preview", body(input))).status).toBe(400);
    }
  });

  it("saves a pending draft without approving, preserving policy/recipients, then approves the saved body", async () => {
    const env = await taskBackend(backends);
    const action = await env.backend.executor.submit({
      type: "draft_create",
      accountId: env.account.id,
      category: "replies_stranger",
      reason: "Draft for review",
      actor: { kind: "agent", id: "test" },
      params: {
        draft: {
          accountId: env.account.id,
          to: [{ email: "dana@example.com" }],
          subject: "Reply",
          textBody: "Before",
          htmlBody: "<p>Before</p>",
        },
      },
    });
    const events: string[] = [];
    const off = env.backend.bus.onAny((event) => events.push(event.type));
    const response = await env.app.request(
      `/api/actions/${action.id}/draft`,
      body({ textBody: "After" }, "PATCH"),
    );
    expect(response.status).toBe(200);
    const saved = (await response.json()) as ActionRecord;
    expect(saved.status).toBe("proposed");
    expect(saved.request.actor).toEqual(action.request.actor);
    expect(saved.decision).toEqual(action.decision);
    expect((saved.request.params as { draft: DraftInput }).draft).toMatchObject({
      textBody: "After",
      htmlBody: null,
      to: [{ email: "dana@example.com" }],
    });
    expect(events).toContain("action.updated");
    expect(events).not.toContain("action.decided");
    off();
    expect(
      (await env.app.request(`/api/actions/${action.id}/draft`, body({ textBody: "  " }, "PATCH")))
        .status,
    ).toBe(400);
    expect(
      (
        await env.app.request(
          `/api/actions/${action.id}/draft`,
          body({ textBody: "After", category: "other" }, "PATCH"),
        )
      ).status,
    ).toBe(400);
    const approved = await env.app.request(`/api/actions/${action.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect(
      (
        await env.app.request(
          `/api/actions/${action.id}/draft`,
          body({ textBody: "Too late" }, "PATCH"),
        )
      ).status,
    ).toBe(409);
    const drafts = await env.backend.store.emails.query({ includeBodies: true, limit: 100 });
    expect(drafts.items.some((email) => email.textBody === "After" && email.keywords.$draft)).toBe(
      true,
    );
  });
});
