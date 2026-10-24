/** R1 review, subtasks (C2): R1-11 to R1-14, R1-35 and the R1-1 delegate guard. */
import type { TaskDelegateInput } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { freshRoutineTask } from "./jobs.js";
import { recoverRuns } from "./restart.js";
import { gate, taskBackend, waitFor } from "./test-support.js";

const backends: RealBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  vi.restoreAllMocks();
});
type Env = Awaited<ReturnType<typeof taskBackend>>;
const input: TaskDelegateInput = {
  message: "Find the receipts",
  mode: "async",
  completionWake: "settled_only",
};
const idle = (env: Env, ...ids: string[]) =>
  waitFor(async () => {
    for (const id of ids) {
      const runs = await env.service.tasks.runs.list(id);
      if (runs.some((run) => run.status === "queued" || run.status === "running")) {
        return false;
      }
    }
    return true;
  }, 5000);
const notifications = async (env: Env, taskId: string) =>
  (await env.service.items(taskId, 0, 500)).flatMap((item) =>
    item.kind === "notification" ? [item.payload.summary] : [],
  );

/** A parent with one finished run and a subtask whose run waits on `hold`. */
async function withRunningChild(env: Env, extra: Partial<TaskDelegateInput> = {}) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  env.llm.script.push("Parent done.");
  const { task: parent, done } = await env.service.create({ message: "Tidy my receipts" });
  await done;
  const hold = gate();
  env.llm.script.push(async () => {
    await hold.opened;
    return "Child done.";
  });
  const orchestrator = env.service.runner.orchestrator!;
  const child = await orchestrator.delegate({ taskId: parent.id }, { ...input, ...extra });
  await waitFor(async () =>
    env.service.runner.activeRuns(child.taskId).some((run) => run.status === "running"),
  );
  return { parent, childId: child.taskId, hold, orchestrator };
}

describe("subtasks after the R1 review", () => {
  it("archiving a subtask notifies the parent without waking it; follow-ups are refused", async () => {
    const env = await taskBackend(backends);
    const { parent, childId, hold, orchestrator } = await withRunningChild(env);
    const archived = await env.app.request(`/api/tasks/${childId}/archive`, { method: "POST" });
    expect(archived.status).toBe(200);
    hold.open();
    await idle(env, parent.id, childId);
    expect((await env.service.get(parent.id)).runs).toHaveLength(1);
    expect(await notifications(env, parent.id)).toEqual([expect.stringContaining("was stopped")]);
    await expect(
      orchestrator.delegate({ taskId: parent.id }, { ...input, taskId: childId }),
    ).rejects.toMatchObject({ code: "TASK_SETTLED" });
    expect((await env.service.task(childId)).status).toBe("archived");
  });

  it("the person's Stop on a subtask is not undone by its parent", async () => {
    const env = await taskBackend(backends);
    const { parent, childId, hold, orchestrator } = await withRunningChild(env);
    await env.app.request(`/api/tasks/${childId}/interrupt`, { method: "POST" });
    hold.open();
    await idle(env, parent.id, childId);
    expect((await env.service.get(parent.id)).runs).toHaveLength(1);
    const status = await orchestrator.delegate(
      { taskId: parent.id },
      { ...input, taskId: childId, message: "Carry on" },
    );
    expect(status.queued).toBe(1);
    const child = await env.service.task(childId);
    expect(child).toMatchObject({ queueHeld: true });
    expect((await env.service.get(childId)).runs.map((run) => run.status)).toEqual([
      "queued",
      "cancelled",
    ]);
  });

  it("Stop on a parent: a finishing subtask notifies it without a wake", async () => {
    const env = await taskBackend(backends);
    const { parent, childId, hold } = await withRunningChild(env);
    await env.app.request(`/api/tasks/${parent.id}/interrupt`, { method: "POST" });
    hold.open();
    await idle(env, parent.id, childId);
    expect((await env.service.get(parent.id)).runs).toHaveLength(1);
    expect(await notifications(env, parent.id)).toEqual([expect.stringContaining("finished")]);
  });

  it("a limited parent is not woken", async () => {
    const env = await taskBackend(backends);
    const { parent, childId, hold } = await withRunningChild(env, { mode: "wait" });
    const [first] = await env.service.tasks.runs.list(parent.id);
    await env.service.runner.updateTask(parent.id, {
      needsUser: "limited",
      limited: {
        runId: first!.id,
        resetAt: null,
        autoResume: false,
        source: "host_agent",
        at: new Date().toISOString(),
      },
    });
    hold.open();
    await idle(env, parent.id, childId);
    expect((await env.service.get(parent.id)).runs).toHaveLength(1);
    expect((await env.service.task(parent.id)).waitingOnTaskIds).toEqual([]);
  });

  it("restart recovery reports a subtask's end to a waiting parent", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push("Parent.", "Child.", "Woke.");
    const { task: parent, done } = await env.service.create({ message: "Parent" });
    await done;
    const child = await env.service.runner.orchestrator!.delegate(
      { taskId: parent.id },
      { ...input, mode: "wait" },
    );
    await idle(env, parent.id, child.taskId);
    await env.service.runner.updateTask(parent.id, {
      waitingOnTaskIds: [child.taskId],
      status: "working",
    });
    await env.service.tasks.runs.insert({
      id: "run-cut",
      taskId: child.taskId,
      status: "running",
      trigger: { kind: "message", itemId: "item", mode: "queue" },
      priority: "interactive",
      agentRunId: "run-cut",
      createdAt: new Date().toISOString(),
      actionIds: [],
      restartOf: "run-earlier",
    });
    await recoverRuns(env.service, env.tasks.queue, {
      afterRunEnded: (run) => env.tasks.subtasks.afterRunEnded(run),
    });
    await idle(env, parent.id);
    const after = await env.service.get(parent.id);
    expect(after.task.waitingOnTaskIds).toEqual([]);
    expect(after.runs[0]).toMatchObject({ trigger: { kind: "wake", reason: "subtasks" } });
  });

  it("counts the real ancestry for the depth limit", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push("routine", "child");
    const { task: routine, done } = await env.service.create({ message: "Routine stand-in" });
    await done;
    const fresh = await freshRoutineTask(env.service, routine);
    const orchestrator = env.service.runner.orchestrator!;
    const child = await orchestrator.delegate({ taskId: fresh.id }, input);
    expect((await env.service.task(child.taskId)).delegation?.depth).toBe(2);
    await idle(env, child.taskId);
    await expect(orchestrator.delegate({ taskId: child.taskId }, input)).rejects.toMatchObject({
      code: "DEPTH_LIMIT",
    });
  });

  it("parallel delegations respect the working-subtask limit", async () => {
    const env = await taskBackend(backends);
    const hold = gate();
    env.llm.script.push(async () => {
      await hold.opened;
      return "Parent.";
    });
    const { task } = await env.service.create({ message: "Root" });
    const orchestrator = env.service.runner.orchestrator!;
    const results = await Promise.allSettled(
      Array.from({ length: 14 }, () => orchestrator.delegate({ taskId: task.id }, input)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "SUBTASK_LIMIT" },
    });
    hold.open();
  });

  it("arrival runs and inbox tasks cannot delegate", async () => {
    const env = await taskBackend(backends);
    const inbox = await env.tasks.triggers.ensureInbox(env.account.id);
    const orchestrator = env.service.runner.orchestrator!;
    await expect(orchestrator.delegate({ taskId: inbox.id }, input)).rejects.toMatchObject({
      code: "DELEGATE_UNAVAILABLE",
    });
    env.llm.script.push("Routine.");
    const { task, done } = await env.service.create({ message: "Routine-like" });
    await done;
    await env.service.tasks.runs.insert({
      id: "scheduled",
      taskId: task.id,
      status: "running",
      trigger: { kind: "schedule", jobId: "job", name: "Job" },
      priority: "background",
      agentRunId: "scheduled",
      createdAt: new Date().toISOString(),
      actionIds: [],
    });
    await expect(
      orchestrator.delegate({ taskId: task.id, runId: "scheduled" }, input),
    ).rejects.toMatchObject({ code: "DELEGATE_UNAVAILABLE" });
  });
});
