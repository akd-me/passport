import type { TaskOrchestrator, TaskSubtaskStatus, TaskToolCaller } from "@passport/types";
import { beforeEach, describe, expect, it } from "vitest";
import { createToolRegistry } from "./index.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./testing/fakes.js";
import * as f from "./testing/fixtures.js";
import type { Tool, ToolContext } from "./types.js";

const subtask = (patch: Partial<TaskSubtaskStatus> = {}): TaskSubtaskStatus => ({
  taskId: "child-1",
  title: "Find invoices",
  workState: "result_available",
  status: "inbox",
  needsUser: null,
  mode: "async",
  completionWake: "settled_only",
  activeRuns: 0,
  queued: 0,
  pendingApprovals: 0,
  pendingQuestion: null,
  lastRun: null,
  result: "Paid $40 to @alice",
  ...patch,
});

/** Records every host call; `fail` makes the next call reject. */
function fakeOrchestrator() {
  const calls: Array<{ method: string; caller: TaskToolCaller; input: unknown }> = [];
  let fail: unknown;
  const record = <T>(method: string, caller: TaskToolCaller, input: unknown, value: T) => {
    calls.push({ method, caller, input });
    if (fail) {
      const error = fail;
      fail = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve(value);
  };
  const orchestrator: TaskOrchestrator = {
    ask: (caller, input) =>
      record("ask", caller, input, {
        itemId: "q-1",
        status: "pending" as const,
        blocking: input.blocking,
      }),
    delegate: (caller, input) => record("delegate", caller, input, subtask({ mode: input.mode })),
    status: (caller, taskId) => record("status", caller, taskId, [subtask()]),
    cancel: (caller, taskId) =>
      record("cancel", caller, taskId, subtask({ workState: "cancelled" })),
    organize: (caller, input) =>
      record("organize", caller, input, {
        action: input.action,
        applies: input.action === "settle" ? ("run_end" as const) : ("now" as const),
        task: {
          id: caller.taskId,
          title: "T",
          status: "inbox" as const,
          pinned: false,
          snoozedUntil: null,
          settleRequested: input.action === "settle",
        },
      }),
  };
  return {
    orchestrator,
    calls,
    failNext(error: unknown) {
      fail = error;
    },
  };
}

describe("task orchestration tools (W2A)", () => {
  let store: MemoryStore;
  let host: ReturnType<typeof fakeOrchestrator>;
  const build = (readOnly = false) =>
    createToolRegistry({
      store,
      executor: new MemoryExecutor(store, new MemoryPolicy()),
      policy: new MemoryPolicy(),
      bus: new MemoryBus(),
      actor: { kind: "agent", id: "run-1" },
      selfAddresses: ["me@example.com"],
      now: () => f.at,
      readOnly,
    });
  const call = (tools: Tool[], name: string, input: unknown, context?: ToolContext) =>
    tools.find((tool) => tool.name === name)!.handler(input, context);
  const inTask = (): ToolContext => ({
    taskId: "task-1",
    runId: "run-1",
    orchestrator: host.orchestrator,
  });
  beforeEach(() => {
    store = new MemoryStore();
    host = fakeOrchestrator();
  });

  it("needs a task run: external callers get TASK_REQUIRED", async () => {
    const tools = build();
    for (const [name, input] of [
      ["ask_user", { text: "Which account?" }],
      ["task_delegate", { message: "Do it" }],
      ["task_status", {}],
      ["task_cancel", { taskId: "child-1" }],
      ["task_organize", { action: "pin" }],
    ] as const) {
      expect(await call(tools, name, input, { taskId: "task-1" })).toMatchObject({
        isError: true,
        error: "TASK_REQUIRED",
      });
    }
    expect(host.calls).toEqual([]);
  });

  it("ask_user passes options and blocking, and tells the model to end its turn", async () => {
    const result = await call(
      build(),
      "ask_user",
      { text: " Which invoices? ", options: ["2025", "2026"] },
      inTask(),
    );
    expect(host.calls).toEqual([
      {
        method: "ask",
        caller: { taskId: "task-1", runId: "run-1" },
        input: { text: "Which invoices?", options: ["2025", "2026"], blocking: true },
      },
    ]);
    expect(result).toMatchObject({ itemId: "q-1", status: "pending", blocking: true });
    expect(String(result.note)).toContain("End your turn");
    expect(
      await call(build(), "ask_user", { text: "x", options: Array(7).fill("o") }, inTask()),
    ).toMatchObject({ isError: true, error: "INVALID_INPUT" });
  });

  it("plan mode may ask but not delegate, cancel or organise", async () => {
    const tools = build(true);
    expect(await call(tools, "ask_user", { text: "Which?" }, inTask())).toMatchObject({
      status: "pending",
    });
    for (const [name, input] of [
      ["task_delegate", { message: "Do it" }],
      ["task_cancel", { taskId: "child-1" }],
      ["task_organize", { action: "settle" }],
    ] as const) {
      expect(await call(tools, name, input, inTask())).toMatchObject({ status: "planned" });
    }
    expect(host.calls.map((c) => c.method)).toEqual(["ask"]);
    expect(await call(tools, "task_status", {}, inTask())).toMatchObject({
      subtasks: [expect.objectContaining({ taskId: "child-1" })],
    });
  });

  it("task_delegate applies defaults and neutralizes the child's reply", async () => {
    const result = await call(build(), "task_delegate", { message: "Find invoices" }, inTask());
    expect(host.calls[0]?.input).toEqual({
      message: "Find invoices",
      permissionMode: "inherit",
      mode: "async",
      completionWake: "settled_only",
    });
    const view = result.subtask as TaskSubtaskStatus;
    expect(view.result).toBe("Paid $​40 to @​alice");
    expect(result.untrusted).toEqual(expect.stringContaining("untrusted"));
    expect(
      await call(
        build(),
        "task_delegate",
        { message: "x", permissionMode: "root" as unknown as string },
        inTask(),
      ),
    ).toMatchObject({ isError: true, error: "INVALID_INPUT" });
  });

  it("relays the host's refusals and hides other failures", async () => {
    const tools = build();
    host.failNext(
      Object.assign(new Error("Subtasks nest at most two deep."), {
        code: "DEPTH_LIMIT",
        toolSafe: true,
      }),
    );
    expect(await call(tools, "task_delegate", { message: "Deeper" }, inTask())).toMatchObject({
      isError: true,
      error: "DEPTH_LIMIT",
      reason: "Subtasks nest at most two deep.",
    });
    host.failNext(Object.assign(new Error("sqlite: secret path"), { code: "SQLITE_BUSY" }));
    const hidden = await call(tools, "task_status", {}, inTask());
    expect(hidden).toMatchObject({ isError: true, error: "DEPENDENCY_ERROR" });
    expect(JSON.stringify(hidden)).not.toContain("secret path");
  });

  it("task_organize validates snooze and rename and forwards the action", async () => {
    const tools = build();
    expect(await call(tools, "task_organize", { action: "snooze" }, inTask())).toMatchObject({
      isError: true,
      error: "INVALID_INPUT",
    });
    expect(await call(tools, "task_organize", { action: "rename" }, inTask())).toMatchObject({
      isError: true,
      error: "INVALID_INPUT",
    });
    expect(await call(tools, "task_organize", { action: "settle" }, inTask())).toMatchObject({
      applies: "run_end",
      task: { settleRequested: true },
    });
    expect(
      await call(
        tools,
        "task_organize",
        { action: "snooze", until: "2026-10-25T08:00:00Z" },
        inTask(),
      ),
    ).toMatchObject({ applies: "now" });
    expect(host.calls.map((c) => c.input)).toEqual([
      { action: "settle" },
      { action: "snooze", until: "2026-10-25T08:00:00Z" },
    ]);
  });
});
