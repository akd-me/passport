/** R1 review (C2): R1-34 idempotent dismiss, R1-35 the question limit, R1-36 organize, R1-40. */
import type { TaskOrganizeInput } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import type { RealBackend } from "../compose.js";
import { taskSessionOptions } from "./session.js";
import { taskBackend, toolCall, waitFor } from "./test-support.js";

const backends: RealBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
});
const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };

async function finishedTask(message = "Tidy my inbox", title?: string) {
  const env = await taskBackend(backends);
  env.llm.script.push("Done.");
  const { task, done } = await env.service.create({ message, ...(title ? { title } : {}) });
  await done;
  await waitFor(async () => env.service.runner.activeRuns(task.id).length === 0);
  return { env, task, orchestrator: env.service.runner.orchestrator! };
}

describe("questions and organize after the R1 review", () => {
  it("two concurrent dismisses: one 200, one 409, one notice", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push(toolCall("ask_user", { text: "Keep or archive?" }), "Asked.");
    const { task, done } = await env.service.create({ message: "Tidy" });
    await done;
    const question = (await env.service.task(task.id)).pendingQuestions![0]!;
    const url = `/api/tasks/${task.id}/questions/${question.itemId}/dismiss`;
    const statuses = (
      await Promise.all([env.app.request(url, post), env.app.request(url, post)])
    ).map((res) => res.status);
    expect(statuses.sort()).toEqual([200, 409]);
    const notices = (await env.service.items(task.id, 0, 500)).filter(
      (item) => item.kind === "system_notice" && item.payload.code === "QUESTION_DISMISSED",
    );
    expect(notices).toHaveLength(1);
  });

  it("parallel ask_user calls stop at the question limit", async () => {
    const { env, task, orchestrator } = await finishedTask();
    const asks = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        orchestrator.ask({ taskId: task.id }, { text: `Q${i}`, blocking: false }),
      ),
    );
    expect(asks.filter((ask) => ask.status === "fulfilled")).toHaveLength(5);
    expect((await env.service.task(task.id)).pendingQuestions).toHaveLength(5);
  });

  it("task_organize never overrides the person's snooze, settle or title", async () => {
    const { env, task, orchestrator } = await finishedTask("Tidy my inbox", "Taxes 2026");
    const organize = (input: TaskOrganizeInput) =>
      orchestrator.organize({ taskId: task.id }, input);
    await expect(organize({ action: "rename", title: "Agent title" })).rejects.toMatchObject({
      code: "PERSON_CHOICE",
    });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await env.tasks.lifecycle.snooze(task.id, until);
    await expect(organize({ action: "unsnooze" })).rejects.toMatchObject({
      code: "PERSON_CHOICE",
    });
    await env.tasks.lifecycle.settle(task.id);
    await expect(organize({ action: "snooze", until })).rejects.toMatchObject({
      code: "TASK_SETTLED",
    });
    expect(await env.service.task(task.id)).toMatchObject({
      title: "Taxes 2026",
      status: "settled",
    });
  });

  it("task_organize may undo its own snooze and rename a title from the message", async () => {
    const { env, task, orchestrator } = await finishedTask();
    const organize = (input: TaskOrganizeInput) =>
      orchestrator.organize({ taskId: task.id }, input);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await organize({ action: "snooze", until });
    expect((await organize({ action: "unsnooze" })).task.status).not.toBe("snoozed");
    expect((await organize({ action: "rename", title: "Inbox tidy" })).task.title).toBe(
      "Inbox tidy",
    );
    await env.service.patch(task.id, { title: "Mine" });
    await expect(organize({ action: "rename", title: "Again" })).rejects.toMatchObject({
      code: "PERSON_CHOICE",
    });
  });

  it("the resumed turn lists proposals beyond the last 40 notices", async () => {
    const { env, task } = await finishedTask();
    const actionId = "01OLDPROPOSAL000000000000";
    await env.service.runner.appendItem({
      taskId: task.id,
      runId: null,
      kind: "approval_request",
      at: new Date().toISOString(),
      untrusted: true,
      payload: { actionId, summary: "Archive 3 newsletters" },
    });
    for (let i = 0; i < 45; i++) {
      await env.service.runner.appendItem({
        taskId: task.id,
        runId: null,
        kind: "system_notice",
        at: new Date().toISOString(),
        payload: { text: `Notice ${i}`, code: "RETRY" },
      });
    }
    await env.service.runner.updateTask(task.id, {
      providerSessionId: "session",
      providerSessionKind: "claude-code",
    });
    const resume = await taskSessionOptions(env.backend.store, env.service.tasks, task.id, {
      texts: ["Next"],
      beforeSeq: Number.MAX_SAFE_INTEGER,
    }).resolveResume!();
    expect(resume?.instruction).toContain(actionId);
  });
});
