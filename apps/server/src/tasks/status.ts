/**
 * Task lifecycle rules (docs/tasks.md "Status rules"). Pure functions over a fresh task row so
 * the service, the watch monitor and maintenance all agree.
 */
import type { Task, TaskNeedsUser, TaskRunTrigger, TaskStatus } from "@passport/types";

/** Hidden from the sidebar's active sections; background work never brings these back. */
export function hidden(status: TaskStatus): boolean {
  return status === "snoozed" || status === "archived";
}

/** Where a task rests when nothing runs: watching keeps it in Working, else the inbox. */
export function idleStatus(task: Pick<Task, "watches">): TaskStatus {
  return task.watches.length ? "working" : "inbox";
}

/** Brings a task back to the person: approval, question, failure or their own message. */
export function surface(needsUser: TaskNeedsUser, now: string): Partial<Task> {
  return { status: "inbox", needsUser, snoozedUntil: null, lastActivityAt: now };
}

/** Status while a run is queued or running. A user message also wakes a snoozed task. */
export function statusDuringRun(task: Task, trigger: TaskRunTrigger, now: string): Partial<Task> {
  if (trigger.kind === "message") {
    return {
      status: "working",
      snoozedUntil: null,
      settledAt: null,
      needsUser: task.needsUser === "failure" ? null : task.needsUser,
      lastActivityAt: now,
    };
  }
  return hidden(task.status) || (task.status === "inbox" && task.needsUser)
    ? {}
    : { status: "working" };
}

export interface RunOutcome {
  trigger: TaskRunTrigger;
  /** Status before the run started. */
  preStatus: TaskStatus;
  /** Status once the run started (after `statusDuringRun`). */
  startStatus?: TaskStatus;
  failed: boolean;
  /** Created ActionRecords or said something (assistant text) during the run. */
  produced: boolean;
  /** Other queued or running runs of the same task. */
  otherActiveRuns: number;
  now: string;
}

/** Settled, snoozed or archived by the person while the run was active (R4-9). */
function putAwayDuringRun(task: Task, outcome: RunOutcome): boolean {
  const away = task.status === "settled" || hidden(task.status);
  return away && outcome.startStatus !== undefined && task.status !== outcome.startStatus;
}

/**
 * Status when a run ends:
 *  0. a task the person settled, snoozed or archived during the run stays there; a failure
 *     only sets `needsUser`;
 *  1. a failed run (not arrivals, which retry) surfaces with `needsUser: "failure"`;
 *  2. pending approvals surface with `needsUser: "approval"`;
 *  3. another run of the task still active keeps it Working;
 *  4. a run started by the person's message returns to the inbox (Working while watching);
 *  5. snoozed and archived tasks stay hidden through background work;
 *  6. schedule and watch runs that produced something come back (Working while watching);
 *     ones that produced nothing return to where they were;
 *  7. arrival triage never moves the task by itself.
 * A task that rested in Working (watching) and comes back to the inbox gets a fresh
 * `lastActivityAt` (R4-10), so auto-settle never takes it before the person saw it.
 */
export function statusAfterRun(task: Task, outcome: RunOutcome): Partial<Task> {
  if (putAwayDuringRun(task, outcome)) {
    return outcome.failed && outcome.trigger.kind !== "arrival" ? { needsUser: "failure" } : {};
  }
  const next = ruleStatus(task, outcome);
  // Resting in Working (watching) before the run and handed back now: the watch ended.
  return outcome.preStatus === "working" && next.status === "inbox"
    ? { ...next, lastActivityAt: outcome.now }
    : next;
}

function ruleStatus(task: Task, outcome: RunOutcome): Partial<Task> {
  const { trigger, now } = outcome;
  if (outcome.failed && trigger.kind !== "arrival") {
    return surface("failure", now);
  }
  if (task.pendingActionIds?.length) {
    return task.status === "inbox" && task.needsUser === "approval" ? {} : surface("approval", now);
  }
  if (outcome.otherActiveRuns > 0) {
    return hidden(task.status) ? {} : { status: "working" };
  }
  const rest = outcome.preStatus === "working" ? idleStatus(task) : outcome.preStatus;
  if (trigger.kind === "message") {
    return { status: idleStatus(task), lastActivityAt: now };
  }
  if (hidden(task.status)) {
    return {};
  }
  if (trigger.kind === "arrival") {
    return { status: task.watches.length ? "working" : rest };
  }
  if (outcome.produced) {
    const status = idleStatus(task);
    return status === "inbox" ? { status, lastActivityAt: now } : { status };
  }
  return { status: task.watches.length ? "working" : rest };
}
