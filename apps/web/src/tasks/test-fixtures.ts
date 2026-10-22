import type { ActionRecord, Task, TaskItem, TaskRun } from "@passport/types";

/** Builders for task tests. Times count minutes back from a fixed instant. */
export const minutesAgo = (m: number) =>
  new Date(Date.parse("2026-10-22T12:00:00Z") - m * 60_000).toISOString();

export function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    accountIds: ["acc-1"],
    status: "inbox",
    pinned: false,
    permissionMode: "supervised",
    interactionMode: "default",
    createdBy: "user",
    kind: "task",
    needsUser: null,
    pendingActionIds: [],
    lastActivityAt: minutesAgo(10),
    createdAt: minutesAgo(60),
    watches: [],
    revision: 1,
    ...patch,
  };
}

export function run(id: string, taskId: string, patch: Partial<TaskRun> = {}): TaskRun {
  return {
    id,
    taskId,
    status: "completed",
    trigger: { kind: "message", itemId: "i1", mode: "queue" },
    priority: "interactive",
    agentRunId: id,
    createdAt: minutesAgo(30),
    startedAt: minutesAgo(30),
    endedAt: minutesAgo(29),
    actionIds: [],
    ...patch,
  };
}

let seq = 0;
type Payloads = { [K in TaskItem["kind"]]: Extract<TaskItem, { kind: K }>["payload"] };
export function item<K extends TaskItem["kind"]>(
  kind: K,
  payload: Payloads[K],
  patch: Partial<Omit<TaskItem, "kind" | "payload">> = {},
): Extract<TaskItem, { kind: K }> {
  seq++;
  return {
    id: `item-${seq}`,
    runId: "r1",
    taskId: "t1",
    seq,
    kind,
    at: minutesAgo(20),
    payload,
    ...patch,
  } as Extract<TaskItem, { kind: K }>;
}

export const tool = (
  name: string,
  patch: Partial<Payloads["tool_call"]> = {},
  meta: Partial<Omit<TaskItem, "kind" | "payload">> = {},
) =>
  item(
    "tool_call",
    { name, inputSummary: "", resultSummary: "ok", durationMs: 100, isError: false, ...patch },
    meta,
  );

export function action(
  id: string,
  reversibility: ActionRecord["decision"]["reversibility"],
  patch: Partial<ActionRecord> = {},
): ActionRecord {
  return {
    id,
    status: "proposed",
    createdAt: minutesAgo(5),
    request: {
      type: reversibility === "reversible" ? "archive" : "send",
      accountId: "acc-1",
      actor: { kind: "agent", id: "agent" },
      category: "triage",
      reason: `Reason ${id}`,
      runId: "r1",
      params: {},
    },
    decision: {
      outcome: "ask",
      risk: "low",
      reversibility,
      category: "triage",
      trustLevel: "supervised",
      reason: "Asks in this mode",
    },
    ...patch,
  };
}

/** A WebSocket the test drives: `FakeSocket.last.open()`, `.send(event)`, `.drop()`. */
export class FakeSocket {
  static last: FakeSocket | undefined;
  static count = 0;
  onopen?: () => void;
  onmessage?: (message: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor() {
    FakeSocket.last = this;
    FakeSocket.count++;
  }
  close() {}
  open() {
    this.onopen?.();
  }
  send(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop() {
    this.onclose?.();
  }
}
