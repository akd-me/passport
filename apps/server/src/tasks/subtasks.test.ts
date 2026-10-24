/** W2A: subtasks through task_delegate, task_status and task_cancel, with parent wakes. */
import type { Page, Task, TaskItem, TaskLineage, TaskSubtaskStatus } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import type { RealBackend } from "../compose.js";
import { gate, taskBackend, toolCall, waitFor } from "./test-support.js";

type Env = Awaited<ReturnType<typeof taskBackend>>;

/** Every run of the task and its subtasks has ended. */
async function quiet(env: Env, ...taskIds: string[]) {
  await waitFor(async () => {
    for (const id of taskIds) {
      const runs = (await env.service.get(id)).runs;
      if (!runs.length || runs.some((run) => !run.endedAt)) {
        return false;
      }
    }
    return true;
  }, 5000);
}

async function children(env: Env, parentId: string): Promise<Task[]> {
  return (await env.service.tasks.list({ parentTaskId: parentId })).items;
}

const notifications = async (env: Env, taskId: string) =>
  (await env.service.items(taskId, 0, 500)).filter(
    (item): item is Extract<TaskItem, { kind: "notification" }> =>
      item.kind === "notification" && item.payload.source === "subtask",
  );

const wakes = async (env: Env, taskId: string) =>
  (await env.service.get(taskId)).runs.filter(
    (run) => run.trigger.kind === "wake" && run.trigger.reason === "subtasks",
  );

describe("subtasks", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
  });

  it("delegates a child, hears back with a notification and wakes the parent once", async () => {
    const env = await taskBackend(backends);
    env.llm.script.push(
      toolCall("task_delegate", {
        message: "Find the Hetzner invoices",
        title: "Hetzner invoices",
        permissionMode: "full_access",
      }),
      "Started a subtask.",
      "Found 2 invoices from Hetzner.",
      "Both invoices found; nothing else to do.",
    );
    const { task: parent } = await env.service.create({
      message: "Sort my invoices",
      permissionMode: "supervised",
    });
    const child = await waitFor(async () => (await children(env, parent.id))[0]);
    await quiet(env, parent.id, child.id);
    const fresh = await env.service.task(child.id);
    expect(fresh).toMatchObject({
      kind: "task",
      parentTaskId: parent.id,
      createdBy: "agent",
      title: "Hetzner invoices",
      // Never above the parent.
      permissionMode: "supervised",
      accountIds: parent.accountIds,
      delegation: expect.objectContaining({
        mode: "async",
        completionWake: "settled_only",
        depth: 1,
      }),
    });
    const notes = await notifications(env, parent.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      untrusted: true,
      payload: { subtaskId: child.id },
    });
    expect(notes[0]!.payload.summary).toContain("finished: Found 2 invoices from Hetzner.");
    const woke = await wakes(env, parent.id);
    expect(woke).toHaveLength(1);
    expect(notes[0]!.runId).toBe(woke[0]!.id);
    expect(await env.service.task(parent.id)).toMatchObject({
      status: "inbox",
      unseenOutcome: "woke",
    });
    const firstPrompt = env.llm.prompts.find((prompt) => prompt.includes('Hetzner invoices"'));
    expect(firstPrompt).toContain("The request from your parent task");

    const lineage = (await (
      await env.app.request(`/api/tasks/${parent.id}/lineage`)
    ).json()) as TaskLineage;
    expect(lineage).toMatchObject({
      taskId: parent.id,
      parent: null,
      children: [{ task: { id: child.id }, activeRuns: 0, lastRunStatus: "completed" }],
    });
    const childLineage = (await (
      await env.app.request(`/api/tasks/${child.id}/lineage`)
    ).json()) as TaskLineage;
    expect(childLineage.parent?.id).toBe(parent.id);
    const listed = (await (
      await env.app.request(`/api/tasks?parentTaskId=${parent.id}`)
    ).json()) as Page<Task>;
    expect(listed.items.map((task) => task.id)).toEqual([child.id]);
  });

  it("coalesces completions into one wake (always) and waits for all (settled_only)", async () => {
    for (const completionWake of ["always", "settled_only"] as const) {
      const env = await taskBackend(backends);
      env.llm.script.push(
        toolCall("task_delegate", { message: "One", title: "One", completionWake }),
        toolCall("task_delegate", { message: "Two", title: "Two", completionWake }),
        "Started two.",
        "One done.",
        "Two done.",
        "Wrapped up.",
      );
      const { task: parent } = await env.service.create({ message: "Two things" });
      const kids = await waitFor(async () => {
        const list = await children(env, parent.id);
        return list.length === 2 ? list : null;
      });
      await quiet(env, parent.id, ...kids.map((kid) => kid.id));
      expect(await notifications(env, parent.id)).toHaveLength(2);
      expect(await wakes(env, parent.id)).toHaveLength(1);
      expect(env.llm.script).toEqual([]);
    }
  });

  it("forwards a child's question to the parent, which answers it with task_delegate", async () => {
    const env = await taskBackend(backends);
    let childId = "";
    env.llm.script.push(
      toolCall("task_delegate", { message: "Archive old receipts", title: "Receipts" }),
      "Delegated.",
      toolCall("ask_user", { text: "Older than which year?", options: ["2020", "2023"] }),
      "Waiting for an answer.",
      async () => {
        childId = (await children(env, parentId))[0]!.id;
        return toolCall("task_status", {});
      },
      async () => toolCall("task_delegate", { taskId: childId, message: "2023" }),
      "Answered the subtask.",
      "Archived receipts older than 2023.",
      "The subtask is done.",
    );
    let parentId = "";
    const created = await env.service.create({ message: "Clean up receipts" });
    parentId = created.task.id;
    const kid = await waitFor(async () => (await children(env, parentId))[0]);
    await waitFor(async () => (await wakes(env, parentId)).length === 2, 8000);
    await quiet(env, parentId, kid.id);
    const notes = await notifications(env, parentId);
    expect(notes[0]!.payload.summary).toContain('asks: "Older than which year?"');
    expect(notes[0]!.payload.summary).toContain('Options: "2020", "2023"');
    const child = await env.service.task(kid.id);
    // The person was never asked.
    expect(child.needsUser).toBeNull();
    expect(child.pendingQuestions).toEqual([]);
    const childItems = await env.service.items(kid.id, 0, 500);
    expect(childItems.filter((item) => item.kind === "user_message").at(-1)?.payload).toEqual({
      text: "2023",
      answers: [childItems.find((item) => item.kind === "question")!.id],
    });
    expect(env.llm.prompts.some((p) => p.includes("Your parent task's answer:\n2023"))).toBe(true);
    const statusCall = (await env.service.items(parentId, 0, 500)).find(
      (item) => item.kind === "tool_call" && item.payload.name === "task_status",
    );
    expect(statusCall?.payload).toMatchObject({ isError: false });
    expect(env.llm.script).toEqual([]);
  });

  it("wait mode keeps the parent in Working until the child finishes", async () => {
    const env = await taskBackend(backends);
    const hold = gate();
    env.llm.script.push(
      toolCall("task_delegate", { message: "Slow work", title: "Slow", mode: "wait" }),
      "Waiting on the subtask.",
      async () => {
        await hold.opened;
        return "Slow work done.";
      },
      "All finished.",
    );
    const { task: parent } = await env.service.create({ message: "Do it" });
    const kid = await waitFor(async () => (await children(env, parent.id))[0]);
    const resting = await waitFor(async () => {
      const current = await env.service.task(parent.id);
      const parentIdle = env.service.runner.activeRuns(parent.id).length === 0;
      return parentIdle && current.status === "working" ? current : null;
    });
    expect(resting.waitingOnTaskIds).toEqual([kid.id]);
    hold.open();
    await quiet(env, parent.id, kid.id);
    await waitFor(async () => (await wakes(env, parent.id)).every((run) => run.endedAt));
    expect(await env.service.task(parent.id)).toMatchObject({
      status: "inbox",
      waitingOnTaskIds: [],
    });
  });

  it("task_cancel stops a subtask without waking the parent", async () => {
    const env = await taskBackend(backends);
    const hold = gate();
    env.llm.script.push(
      toolCall("task_delegate", { message: "Long job", title: "Long", mode: "wait" }),
      "Started.",
      async () => {
        await hold.opened;
        return "Too late.";
      },
    );
    const { task: parent } = await env.service.create({ message: "Go" });
    const kid = await waitFor(async () => {
      const [found] = await children(env, parent.id);
      return found &&
        env.service.runner.activeRuns(found.id).some((run) => run.status === "running")
        ? found
        : null;
    });
    const orchestrator = env.service.runner.orchestrator!;
    const cancelled: TaskSubtaskStatus = await orchestrator.cancel({ taskId: parent.id }, kid.id);
    hold.open();
    await quiet(env, parent.id, kid.id);
    expect(cancelled.taskId).toBe(kid.id);
    const [status] = await orchestrator.status({ taskId: parent.id }, kid.id);
    expect(status).toMatchObject({ workState: "cancelled", lastRun: { status: "cancelled" } });
    expect(await wakes(env, parent.id)).toEqual([]);
    expect(await notifications(env, parent.id)).toEqual([]);
    expect((await env.service.task(parent.id)).waitingOnTaskIds).toEqual([]);
    await expect(orchestrator.cancel({ taskId: kid.id }, parent.id)).rejects.toMatchObject({
      code: "NOT_A_SUBTASK",
      toolSafe: true,
    });
  });

  it("refuses depth 3, foreign accounts and a settled parent", async () => {
    const env = await taskBackend(backends);
    const orchestrator = env.service.runner.orchestrator!;
    const delegation = (depth: number) => ({
      delegation: {
        parentRunId: null,
        mode: "async" as const,
        completionWake: "settled_only" as const,
        depth,
        delegatedAt: new Date().toISOString(),
      },
    });
    env.llm.script.push("a", "b", "c", "d");
    const { task: root } = await env.service.create({ message: "Root" });
    const { task: grandchild } = await env.service.create(
      { message: "Grandchild", parentTaskId: root.id, createdBy: "agent" },
      delegation(2),
    );
    await quiet(env, root.id, grandchild.id);
    const input = {
      message: "Deeper",
      mode: "async" as const,
      completionWake: "settled_only" as const,
    };
    await expect(orchestrator.delegate({ taskId: grandchild.id }, input)).rejects.toMatchObject({
      code: "DEPTH_LIMIT",
      toolSafe: true,
    });
    await expect(
      orchestrator.delegate({ taskId: root.id }, { ...input, accountIds: ["someone-else"] }),
    ).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    await env.backend.tasks!.lifecycle.settle(root.id);
    await expect(orchestrator.delegate({ taskId: root.id }, input)).rejects.toMatchObject({
      code: "TASK_SETTLED",
    });
  });
});
