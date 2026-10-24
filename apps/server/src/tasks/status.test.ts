import {
  type ConversationWatch,
  isTaskWorking,
  type Task,
  type TaskRunTrigger,
  taskBadge,
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
const message: TaskRunTrigger = { kind: "message", itemId: "i1", mode: "queue" };
const watch: TaskRunTrigger = { kind: "watch", threadHandle: WATCH.threadHandle, emailId: "e1" };
const arrival: TaskRunTrigger = { kind: "arrival", emailId: "e1" };
const schedule: TaskRunTrigger = { kind: "schedule", jobId: "j", name: "Digest" };

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

const started = (trigger: TaskRunTrigger): StatusEvent => ({
  kind: "run_started",
  trigger,
  now: NOW,
});
const reopened = (activeRuns = 0): StatusEvent => ({ kind: "reopened", activeRuns, now: NOW });

describe("resolveTaskStatus", () => {
  const cases: Array<[string, Task, StatusEvent, Partial<Task>]> = [
    // run_started
    [
      "a message wakes a snoozed task and clears a failure",
      task({ status: "snoozed", snoozedUntil: NOW, needsUser: "failure" }),
      started(message),
      {
        status: "working",
        snoozedUntil: null,
        settledAt: null,
        needsUser: null,
        lastActivityAt: NOW,
      },
    ],
    [
      "a message keeps a pending approval",
      task({ status: "inbox", needsUser: "approval" }),
      started(message),
      {
        status: "working",
        snoozedUntil: null,
        settledAt: null,
        needsUser: "approval",
        lastActivityAt: NOW,
      },
    ],
    [
      "background work starts Working",
      task({ status: "inbox" }),
      started(watch),
      { status: "working" },
    ],
    [
      "background work keeps a snoozed task hidden",
      task({ status: "snoozed" }),
      started(watch),
      {},
    ],
    [
      "background work keeps an archived task hidden",
      task({ status: "archived" }),
      started(arrival),
      {},
    ],
    [
      "an inbox task waiting on the person stays in the inbox",
      task({ status: "inbox", needsUser: "limited" }),
      started(arrival),
      {},
    ],
    // run_ended, rule 0
    ["settled during the run stays settled", task({ status: "settled" }), ended(message), {}],
    [
      "snoozed during a failed run only flags the failure",
      task({ status: "snoozed" }),
      ended(message, { failed: true, error: "RUN_FAILED" }),
      { needsUser: "failure" },
    ],
    [
      "archived during a limited run only flags the limit",
      task({ status: "archived" }),
      ended(watch, { failed: true, error: "USAGE_LIMITED" }),
      { needsUser: "limited" },
    ],
    // rule 1
    [
      "a failed run surfaces",
      task(),
      ended(message, { failed: true, error: "RUN_FAILED" }),
      { status: "inbox", needsUser: "failure", snoozedUntil: null, lastActivityAt: NOW },
    ],
    [
      "a run stopped at a usage limit surfaces as limited",
      task(),
      ended(message, { failed: true, error: "USAGE_LIMITED" }),
      { status: "inbox", needsUser: "limited", snoozedUntil: null, lastActivityAt: NOW },
    ],
    [
      "a host CLI rate limit also surfaces as limited",
      task(),
      ended(watch, { failed: true, error: "HOST_AGENT_RATE_LIMIT", preStatus: "inbox" }),
      { status: "inbox", needsUser: "limited", snoozedUntil: null, lastActivityAt: NOW },
    ],
    [
      "a failed arrival never surfaces by itself",
      task({ kind: "inbox", status: "working" }),
      ended(arrival, { failed: true, error: "RUN_FAILED" }),
      { status: "inbox" },
    ],
    // rule 2
    [
      "pending approvals surface",
      task({ pendingActionIds: ["a1"] }),
      ended(message),
      { status: "inbox", needsUser: "approval", snoozedUntil: null, lastActivityAt: NOW },
    ],
    [
      "an approval already surfaced stays put",
      task({ status: "inbox", needsUser: "approval", pendingActionIds: ["a1"] }),
      ended(watch),
      {},
    ],
    // rule 3
    [
      "another active run keeps Working",
      task(),
      ended(message, { otherActiveRuns: 1 }),
      { status: "working" },
    ],
    // rule 4
    [
      "the person's run hands the task back as done",
      task(),
      ended(message),
      { status: "inbox", lastActivityAt: NOW, unseenOutcome: "done" },
    ],
    [
      "the person's run rests in Working while watching, with no badge",
      task({ watches: [WATCH] }),
      ended(message),
      { status: "working", lastActivityAt: NOW },
    ],
    // rule 5
    [
      "background work leaves a snoozed task hidden",
      task({ status: "snoozed" }),
      ended(watch, { produced: true }),
      {},
    ],
    // rule 6
    [
      "a schedule run that produced something comes back as woke",
      task({ kind: "routine" }),
      ended(schedule, { produced: true }),
      { status: "inbox", lastActivityAt: NOW, unseenOutcome: "woke" },
    ],
    [
      "a watch run that produced nothing returns to where it was",
      task({ status: "working", watches: [WATCH] }),
      ended(watch, { preStatus: "working" }),
      { status: "working" },
    ],
    [
      "a no-op background run on an inbox task changes nothing visible",
      task({ status: "working" }),
      ended(schedule, { preStatus: "inbox" }),
      { status: "inbox" },
    ],
    [
      "resting in Working and handed back counts as surfacing (R4-10)",
      task({ status: "working" }),
      ended(watch, { preStatus: "working", produced: false }),
      { status: "inbox", lastActivityAt: NOW, unseenOutcome: "woke" },
    ],
    // rule 7
    [
      "arrival triage never moves the task",
      task({ kind: "inbox", status: "working" }),
      ended(arrival, { produced: true }),
      { status: "inbox" },
    ],
    // reopened
    [
      "reopening rests in the inbox",
      task({ status: "settled", settledAt: BEFORE }),
      reopened(),
      { status: "inbox", snoozedUntil: null, settledAt: null, lastActivityAt: NOW },
    ],
    [
      "reopening a task with an active run rests in Working",
      task({ status: "archived" }),
      reopened(1),
      { status: "working", snoozedUntil: null, settledAt: null, lastActivityAt: NOW },
    ],
    [
      "reopening a watching task that needs the person rests in the inbox",
      task({ status: "snoozed", watches: [WATCH], needsUser: "approval" }),
      reopened(),
      { status: "inbox", snoozedUntil: null, settledAt: null, lastActivityAt: NOW },
    ],
  ];

  it.each(cases)("%s", (_name, before, event, expected) => {
    expect(resolveTaskStatus(before, event)).toEqual(expected);
  });
});

describe("isTaskWorking and taskBadge", () => {
  const cases: Array<[string, Partial<Task>, number, boolean, ReturnType<typeof taskBadge>]> = [
    ["idle with nothing new", {}, 0, false, null],
    ["a run is active", {}, 1, true, "working"],
    ["watching with no run", { watches: [WATCH] }, 0, true, "waiting"],
    ["an approval beats a running run", { needsUser: "approval" }, 1, false, "approval"],
    ["a question is input", { needsUser: "question" }, 0, false, "input"],
    ["limited", { needsUser: "limited" }, 0, false, "limited"],
    ["failed", { needsUser: "failure", unseenOutcome: "done" }, 0, false, "failed"],
    ["woke and unseen", { unseenOutcome: "woke" }, 0, false, "woke"],
    ["done and unseen", { unseenOutcome: "done" }, 0, false, "done"],
    ["working hides an unseen outcome", { unseenOutcome: "done" }, 1, true, "working"],
  ];

  it.each(cases)("%s", (_name, patch, activeRuns, working, badge) => {
    const row = task(patch);
    expect(isTaskWorking(row, { activeRuns })).toBe(working);
    expect(taskBadge(row, { activeRuns })).toBe(badge);
  });
});
