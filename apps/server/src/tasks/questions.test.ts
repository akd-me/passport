/** W2A: ask_user questions, their answer and dismiss routes, and task_organize, over HTTP. */
import type { Task, TaskDetail, TaskItem, TaskRun } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import type { RealBackend } from "../compose.js";
import { taskBackend, toolCall, waitFor } from "./test-support.js";

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

type Env = Awaited<ReturnType<typeof taskBackend>>;

async function idle(env: Env, taskId: string) {
  await waitFor(async () => {
    const detail = (await (await env.app.request(`/api/tasks/${taskId}`)).json()) as TaskDetail;
    return detail.runs.length > 0 && detail.runs.every((run) => run.endedAt);
  });
  return env.service.task(taskId);
}

async function items(env: Env, taskId: string): Promise<TaskItem[]> {
  return env.service.items(taskId, 0, 500);
}

describe("ask_user questions", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
  });

  it("asks, surfaces as a question, and the answer becomes the next run's message", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push(
      toolCall("ask_user", { text: "Which year, $boss?", options: ["2025", "2026"] }),
      "I asked which year.",
      "Got it: 2026.",
    );
    const { task } = await env.service.create({ message: "Find my invoices" });
    const asked = await idle(env, task.id);
    expect(asked).toMatchObject({ status: "inbox", needsUser: "question" });
    expect(asked.unseenOutcome ?? null).toBeNull();
    const question = (await items(env, task.id)).find((item) => item.kind === "question");
    expect(question).toMatchObject({
      untrusted: true,
      payload: { text: "Which year, $​boss?", options: ["2025", "2026"], blocking: true },
    });
    expect(asked.pendingQuestions).toEqual([
      expect.objectContaining({ itemId: question!.id, blocking: true, runId: question!.runId }),
    ]);

    const answered = await env.app.request(
      `/api/tasks/${task.id}/questions/${question!.id}/answer`,
      json({ text: "2026" }),
    );
    expect(answered.status).toBe(202);
    const { run } = (await answered.json()) as { task: Task; run: TaskRun };
    const after = await idle(env, task.id);
    expect(after).toMatchObject({ needsUser: null, pendingQuestions: [], status: "inbox" });
    const message = (await items(env, task.id)).find(
      (item) => item.kind === "user_message" && item.runId === run.id,
    );
    expect(message?.payload).toEqual({ text: "2026", answers: [question!.id] });
    const prompt = env.llm.prompts.at(-1) ?? "";
    expect(prompt).toContain('You asked:\n- "Which year, $​boss?"');
    expect(prompt).toContain("The person's answer:\n2026");

    expect(
      (
        await env.app.request(
          `/api/tasks/${task.id}/questions/${question!.id}/answer`,
          json({ text: "again" }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await env.app.request(`/api/tasks/${task.id}/questions/nope/dismiss`, json({}))).status,
    ).toBe(404);
    expect(
      (
        await env.app.request(
          `/api/tasks/${task.id}/questions/${question!.id}/answer`,
          json({ text: "x", extra: 1 }),
        )
      ).status,
    ).toBe(400);
  });

  it("a message sent while a question is pending answers it; dismiss resolves without a run", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push(
      toolCall("ask_user", { text: "Archive or keep?", blocking: false }),
      "Asked.",
      "Archived.",
      toolCall("ask_user", { text: "Anything else?" }),
      "Asked again.",
    );
    const { task } = await env.service.create({ message: "Tidy up" });
    await idle(env, task.id);
    const first = (await env.service.task(task.id)).pendingQuestions![0]!;
    expect(first.blocking).toBe(false);
    await env.app.request(`/api/tasks/${task.id}/messages`, json({ text: "Archive" }));
    await idle(env, task.id);
    const reply = (await items(env, task.id)).filter((item) => item.kind === "user_message").at(-1);
    expect(reply?.payload).toEqual({ text: "Archive", answers: [first.itemId] });

    await env.app.request(`/api/tasks/${task.id}/messages`, json({ text: "Thanks" }));
    const waiting = await waitFor(async () => {
      const current = await env.service.task(task.id);
      const done = env.service.runner.activeRuns(task.id).length === 0;
      return done && current.pendingQuestions?.length ? current : null;
    });
    expect(waiting.needsUser).toBe("question");
    const runsBefore = (await env.service.get(task.id)).runs.length;
    const dismissed = await env.app.request(
      `/api/tasks/${task.id}/questions/${waiting.pendingQuestions![0]!.itemId}/dismiss`,
      json({}),
    );
    expect(await dismissed.json()).toMatchObject({ needsUser: null, pendingQuestions: [] });
    expect((await env.service.get(task.id)).runs).toHaveLength(runsBefore);
    expect((await items(env, task.id)).at(-1)).toMatchObject({
      kind: "system_notice",
      runId: null,
      payload: { code: "QUESTION_DISMISSED" },
    });
  });

  it("an approval keeps priority, and deciding it hands over to the question", async () => {
    const env = await taskBackend(backends);
    const { task } = await env.service.create({ message: "Hello" });
    await idle(env, task.id);
    await env.service.runner.updateTask(task.id, {
      pendingActionIds: ["a1"],
      needsUser: "approval",
    });
    await env.backend.tasks!.questions.ask({ taskId: task.id }, { text: "Which?", blocking: true });
    expect((await env.service.task(task.id)).needsUser).toBe("approval");
    // A dismissed question leaves the approval in place.
    const [question] = (await env.service.task(task.id)).pendingQuestions!;
    await env.backend.tasks!.questions.dismiss(task.id, question!.itemId);
    expect((await env.service.task(task.id)).needsUser).toBe("approval");
  });
});

describe("task_organize", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
  });

  it("settles when the run ends, renames as generated, pins and refuses a past snooze", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push(
      toolCall("task_organize", { action: "rename", title: "Hetzner invoices 2026" }),
      toolCall("task_organize", { action: "pin" }),
      toolCall("task_organize", { action: "snooze", until: "2001-01-01T00:00:00Z" }),
      async () => {
        // Mid-run: settle is only requested.
        return toolCall("task_organize", { action: "settle" });
      },
      async () => {
        const mid = await env.service.task(taskId);
        expect(mid).toMatchObject({ status: "working", settleRequested: true });
        return "All done.";
      },
    );
    let taskId = "";
    const created = await env.service.create({ message: "Find the invoices" });
    taskId = created.task.id;
    const after = await idle(env, taskId);
    expect(after).toMatchObject({
      status: "settled",
      settleRequested: false,
      pinned: true,
      title: "Hetzner invoices 2026",
      titleGenerated: true,
    });
    const calls = (await items(env, taskId)).filter((item) => item.kind === "tool_call");
    const snooze = calls.find(
      (item) => item.kind === "tool_call" && item.payload.inputSummary.includes("snooze"),
    );
    expect(snooze?.payload).toMatchObject({ isError: true });
    expect(snooze?.payload.resultSummary).toContain("INVALID_FIELD");
  });

  it("drops a requested settle when a question waits on the person", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push(
      toolCall("task_organize", { action: "settle" }),
      toolCall("ask_user", { text: "Before I file this: anything else?" }),
      "Asked.",
    );
    const { task } = await env.service.create({ message: "Wrap up" });
    expect(await idle(env, task.id)).toMatchObject({
      status: "inbox",
      needsUser: "question",
      settleRequested: false,
    });
  });
});
