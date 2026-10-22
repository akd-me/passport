import type { Matter, Task, TaskByAction, TaskItem, TaskRun } from "@passport/types";
import { mailHandle } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../accounts.js";
import type { RealBackend } from "../compose.js";
import { deliver, taskBackend, toolCall, waitFor } from "./test-support.js";

type Env = Awaited<ReturnType<typeof taskBackend>>;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const at = "2026-10-20T00:00:00.000Z";
const lease: Matter = {
  id: "matter-lease",
  title: "Lease renewal",
  summary: "Renewing the flat lease",
  status: "active",
  personIds: [],
  emailIds: [],
  eventIds: [],
  createdAt: at,
  updatedAt: at,
};

describe("task composer context and decision lookup", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    vi.restoreAllMocks();
  });

  const completed = (env: Env, run: TaskRun) =>
    waitFor(async () => {
      const current = await env.service.tasks.runs.get(run.id);
      return current?.status === "completed" && current;
    });

  it("POST /api/tasks threads matterId and emailIds (ULIDs or handles) into the first run", async () => {
    const env = await taskBackend(backends);
    const first = await deliver(env, { providerId: "m1", subject: "Lease draft $500" });
    const second = await deliver(env, { providerId: "m2", subject: "Signed copy" });
    await env.backend.drainAgentQueue();
    await env.backend.store.matters.upsert(lease);
    const response = await env.app.request(
      "/api/tasks",
      post({
        message: "Summarise where the lease stands",
        matterId: lease.id,
        emailIds: [first.id, mailHandle(env.account.id, "email", "m2")],
        accountIds: [env.account.id],
      }),
    );
    expect(response.status).toBe(201);
    const { task, run } = (await response.json()) as { task: Task; run: TaskRun };
    await completed(env, run);
    const items = (await env.service.items(task.id, 0, 50)) as TaskItem[];
    expect(items.map((item) => item.kind).slice(0, 2)).toEqual(["user_message", "notification"]);
    expect(items[1]).toMatchObject({
      runId: run.id,
      untrusted: true,
      payload: { source: "system" },
    });
    const summary = (items[1]!.payload as { summary: string }).summary;
    expect(summary).toContain("Lease renewal");
    expect(summary).toContain("2 messages");
    expect(summary).toContain("Signed copy");
    expect(summary).toContain("$​500");
    // The run's prompt received both messages and the matter.
    const prompt = env.llm.prompts.at(-1)!;
    expect(prompt).toContain(first.id);
    expect(prompt).toContain(second.id);
    expect(prompt).toContain(lease.id);
  });

  it("validates composer context with stable codes", async () => {
    const env = await taskBackend(backends);
    const email = await deliver(env, { providerId: "m1" });
    await env.backend.drainAgentQueue();
    const other = await addAccount(env.backend, {
      kind: "mock",
      emailAddress: "sam@example.com",
      displayName: "Sam",
      fields: {},
    });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ matterId: "missing" }, "UNKNOWN_MATTER"],
      [{ matterId: "" }, "INVALID_FIELD"],
      [{ emailIds: ["nope"] }, "UNKNOWN_EMAIL"],
      [{ emailIds: [mailHandle(env.account.id, "email", "gone")] }, "UNKNOWN_EMAIL"],
      [{ emailIds: "x" }, "INVALID_FIELD"],
      [{ accountIds: ["acc-missing"] }, "UNKNOWN_ACCOUNT"],
      [{ accountIds: [other.id], emailIds: [email.id] }, "ACCOUNT_MISMATCH"],
    ];
    for (const [body, code] of cases) {
      const response = await env.app.request("/api/tasks", post({ message: "Go", ...body }));
      expect([
        response.status,
        ((await response.json()) as { error: { code: string } }).error.code,
      ]).toEqual([400, code]);
    }
    expect((await env.service.list({})).items.filter((task) => task.kind === "task")).toEqual([]);
  });

  it("GET /api/tasks/by-action/:actionId resolves archived tasks and falls back to the run id", async () => {
    const env = await taskBackend(backends);
    const email = await deliver(env, { providerId: "m1" });
    await env.backend.drainAgentQueue();
    env.llm.script.push(
      toolCall("archive_emails", { emailIds: [email.id], reason: "Tidy" }),
      "Ok.",
    );
    const { task, run } = await env.service.create({
      message: "Archive it",
      permissionMode: "supervised",
    });
    const done = await completed(env, run);
    const actionId = done.actionIds[0]!;
    await env.service.archive(task.id);
    const lookup = async (id: string) => {
      const response = await env.app.request(`/api/tasks/by-action/${id}`);
      return { status: response.status, body: (await response.json()) as TaskByAction };
    };
    expect(await lookup(actionId)).toEqual({
      status: 200,
      body: { taskId: task.id, runId: run.id },
    });
    // A run that never linked the action: ActionRecord.runId → TaskRun.agentRunId.
    await env.service.tasks.runs.update(run.id, { actionIds: [] });
    expect((await lookup(actionId)).body).toEqual({ taskId: task.id, runId: run.id });
    expect((await lookup("01UNKNOWNACTION")).status).toBe(404);
  });
});
