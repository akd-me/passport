/** W2A status rules: questions, waiting on subtasks and settle at run end, as a table. */
import {
  type ConversationWatch,
  isTaskWorking,
  type Task,
  type TaskPendingQuestion,
  type TaskRunTrigger,
  taskBadge,
  taskWaitingOn,
} from "@passport/types";
import { describe, expect, it } from "vitest";
import { type RunOutcome, resolveTaskStatus, type StatusEvent } from "./status.js";

const NOW = "2026-10-24T12:00:00.000Z";
const BEFORE = "2026-10-20T12:00:00.000Z";
const WATCH: ConversationWatch = {
  threadHandle: "acc:thread:1",
  account: "acc",
  since: BEFORE,
  consecutiveWakes: 0,
};
const QUESTION: TaskPendingQuestion = {
  itemId: "q1",
  runId: "r1",
  text: "Which year?",
  blocking: true,
  askedAt: NOW,
};
const DELEGATION = {
  parentRunId: "pr",
  mode: "async" as const,
  completionWake: "settled_only" as const,
  depth: 1,
  delegatedAt: BEFORE,
};
const message: TaskRunTrigger = { kind: "message", itemId: "i1", mode: "queue" };
const wake: TaskRunTrigger = { kind: "wake", reason: "subtasks" };

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Task",
    accountIds: ["acc"],
    status: "working",
    pinned: false,
    permissionMode: "supervised",
    interactionMode: "default",
    createdBy: "user",
    kind: "task",
    needsUser: null,
    lastActivityAt: BEFORE,
    createdAt: BEFORE,
    watches: [],
    pendingActionIds: [],
    ...patch,
  };
}

function ended(trigger: TaskRunTrigger, patch: Partial<RunOutcome> = {}): StatusEvent {
  return {
    kind: "run_ended",
    outcome: {
      trigger,
      preStatus: "inbox",
      startStatus: "working",
      failed: false,
      produced: false,
      otherActiveRuns: 0,
      now: NOW,
      ...patch,
    },
  };
}

const asked: StatusEvent = { kind: "question_asked", now: NOW };
const resolved: StatusEvent = { kind: "question_resolved" };
const surfaced = (needsUser: Task["needsUser"]): Partial<Task> => ({
  status: "inbox",
  needsUser,
  snoozedUntil: null,
  lastActivityAt: NOW,
});

describe("resolveTaskStatus (W2A)", () => {
  const cases: Array<[string, Task, StatusEvent, Partial<Task>]> = [
    // question_asked
    [
      "a question surfaces a working task",
      task({ pendingQuestions: [QUESTION] }),
      asked,
      surfaced("question"),
    ],
    [
      "a question wakes a snoozed task early",
      task({ status: "snoozed", snoozedUntil: NOW, pendingQuestions: [QUESTION] }),
      asked,
      surfaced("question"),
    ],
    [
      "an approval keeps priority over a question",
      task({ status: "inbox", needsUser: "approval", pendingActionIds: ["a1"] }),
      asked,
      {},
    ],
    [
      "a settled task records the question without moving",
      task({ status: "settled", pendingQuestions: [QUESTION] }),
      asked,
      { needsUser: "question" },
    ],
    [
      "a subtask's question never reaches the person",
      task({ pendingQuestions: [QUESTION], delegation: DELEGATION }),
      asked,
      {},
    ],
    // question_resolved
    [
      "the last answered question clears",
      task({ needsUser: "question" }),
      resolved,
      { needsUser: null },
    ],
    [
      "another pending question keeps it waiting",
      task({ needsUser: "question", pendingQuestions: [QUESTION] }),
      resolved,
      {},
    ],
    [
      "a pending approval takes over",
      task({ needsUser: "question", pendingActionIds: ["a1"] }),
      resolved,
      { needsUser: "approval" },
    ],
    [
      "a failure is not cleared by a dismissed question",
      task({ needsUser: "failure" }),
      resolved,
      {},
    ],
    // run_ended with a question
    [
      "a run that asked hands back waiting on the person, without a Done badge",
      task({ pendingQuestions: [QUESTION] }),
      ended(message),
      surfaced("question"),
    ],
    [
      "a subtask that asked hands back like any run (its parent hears of it)",
      task({ pendingQuestions: [QUESTION], delegation: DELEGATION }),
      ended(message),
      { status: "inbox", lastActivityAt: NOW, unseenOutcome: "done" },
    ],
    // waiting on subtasks
    [
      "a run that delegated with wait rests in Working",
      task({ waitingOnTaskIds: ["c1"] }),
      ended(message),
      { status: "working", lastActivityAt: NOW },
    ],
    // settle at run end
    [
      "a requested settle applies when the run ends",
      task({ settleRequested: true, watches: [WATCH] }),
      ended(message),
      {
        status: "settled",
        settledAt: NOW,
        snoozedUntil: null,
        watches: [],
        settleRequested: false,
        lastActivityAt: NOW,
      },
    ],
    [
      "settle is dropped when an approval waits",
      task({ settleRequested: true, pendingActionIds: ["a1"] }),
      ended(message),
      { ...surfaced("approval"), settleRequested: false },
    ],
    [
      "settle is dropped when the run failed",
      task({ settleRequested: true }),
      ended(message, { failed: true, error: "RUN_FAILED" }),
      { ...surfaced("failure"), settleRequested: false },
    ],
    [
      "settle waits for another active run",
      task({ settleRequested: true }),
      ended(wake, { otherActiveRuns: 1 }),
      { status: "working" },
    ],
    [
      "settle waits for a queued follow-up",
      task({ settleRequested: true, queue: [{ runId: "q", text: "more", createdAt: NOW }] }),
      ended(message),
      { status: "inbox", lastActivityAt: NOW, unseenOutcome: "done" },
    ],
    [
      "the person's message cancels a requested settle",
      task({ status: "inbox", settleRequested: true }),
      { kind: "run_started", trigger: message, now: NOW },
      {
        status: "working",
        snoozedUntil: null,
        settledAt: null,
        needsUser: null,
        lastActivityAt: NOW,
        settleRequested: false,
      },
    ],
    [
      "a task the person put away during the run forgets the request",
      task({ status: "snoozed", settleRequested: true }),
      ended(message),
      { settleRequested: false },
    ],
  ];

  it.each(cases)("%s", (_name, before, event, expected) => {
    expect(resolveTaskStatus(before, event)).toEqual(expected);
  });

  it("taskWaitingOn orders approvals before questions and ignores a subtask's questions", () => {
    expect(taskWaitingOn(task({ pendingActionIds: ["a"], pendingQuestions: [QUESTION] }))).toBe(
      "approval",
    );
    expect(taskWaitingOn(task({ pendingQuestions: [QUESTION] }))).toBe("question");
    expect(
      taskWaitingOn(task({ pendingQuestions: [QUESTION], delegation: DELEGATION })),
    ).toBeNull();
    expect(taskWaitingOn(task())).toBeNull();
  });
});

describe("isTaskWorking and taskBadge (W2A)", () => {
  const cases: Array<[string, Partial<Task>, number, boolean, ReturnType<typeof taskBadge>]> = [
    ["waiting on a wait-mode subtask", { waitingOnTaskIds: ["c1"] }, 0, true, "waiting"],
    [
      "a subtask's blocking question is input, not working",
      { pendingQuestions: [QUESTION], delegation: DELEGATION },
      0,
      false,
      "input",
    ],
    [
      "a subtask's non-blocking question keeps it working",
      { pendingQuestions: [{ ...QUESTION, blocking: false }], delegation: DELEGATION },
      1,
      true,
      "input",
    ],
    [
      "the person's question",
      { needsUser: "question", pendingQuestions: [QUESTION] },
      1,
      false,
      "input",
    ],
  ];

  it.each(cases)("%s", (_name, patch, activeRuns, working, badge) => {
    const row = task(patch);
    expect(isTaskWorking(row, { activeRuns })).toBe(working);
    expect(taskBadge(row, { activeRuns })).toBe(badge);
  });
});
