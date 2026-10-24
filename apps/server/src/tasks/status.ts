/**
 * Task lifecycle rules (docs/tasks.md "Status rules"). Pure functions over a fresh task row so
 * the service, the watch monitor and maintenance all agree. `resolveTaskStatus` is the single
 * entry point; `statusDuringRun` and `statusAfterRun` are its two run events.
 */
import {
  isTaskWorking,
  type Task,
  type TaskNeedsUser,
  type TaskRunTrigger,
  type TaskStatus,
  type TaskUnseenOutcome,
} from "@passport/types";

/** Run error codes that mean a usage limit, not a failure (`needsUser: "limited"`). */
export const LIMIT_CODES: readonly string[] = ["USAGE_LIMITED", "HOST_AGENT_RATE_LIMIT"];

export function isLimitCode(code: string | null | undefined): boolean {
  return !!code && LIMIT_CODES.includes(code);
}

/** Hidden from the sidebar's active sections; background work never brings these back. */
export function hidden(status: TaskStatus): boolean {
  return status === "snoozed" || status === "archived";
}

/**
 * Where a task rests when nothing runs: watching a conversation, or waiting on subtasks it
 * delegated with `mode: "wait"`, keeps it in Working; else the inbox.
 */
export function idleStatus(task: Pick<Task, "watches" | "waitingOnTaskIds">): TaskStatus {
  return task.watches.length || task.waitingOnTaskIds?.length ? "working" : "inbox";
}

/**
 * What the task waits on the person for, from its pending lists: approvals first, then
 * questions. A subtask's questions wait on its parent task, never on the person.
 */
export function waitingOn(
  task: Pick<Task, "pendingActionIds" | "pendingQuestions" | "delegation">,
): TaskNeedsUser {
  if (task.pendingActionIds?.length) {
    return "approval";
  }
  if (task.pendingQuestions?.length && !task.delegation) {
    return "question";
  }
  return null;
}

/** Brings a task back to the person: approval, question, failure, limit or their own message. */
export function surface(needsUser: TaskNeedsUser, now: string): Partial<Task> {
  return { status: "inbox", needsUser, snoozedUntil: null, lastActivityAt: now };
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
  /** The run's error code; a limit code surfaces `needsUser: "limited"` instead of a failure. */
  error?: string | null;
}

/** What happened to the task; `resolveTaskStatus` answers with the patch to apply. */
export type StatusEvent =
  | { kind: "run_started"; trigger: TaskRunTrigger; now: string }
  | { kind: "run_ended"; outcome: RunOutcome }
  /** Unsettle, unsnooze, unarchive and a snooze whose time came. */
  | { kind: "reopened"; activeRuns: number; now: string }
  /** v0.4: `ask_user` added a pending question (`Task.pendingQuestions` already holds it). */
  | { kind: "question_asked"; now: string }
  /** v0.4: a question was answered or dismissed (already removed from the list). */
  | { kind: "question_resolved" };

/**
 * The status rules in one place (docs/tasks.md "Status rules"):
 *
 * - `run_started`: Working while a run is active, except hidden tasks and an inbox task already
 *   waiting on the person. A user message also un-snoozes, un-settles and clears a failure.
 * - `run_ended`: see `statusAfterRun`.
 * - `reopened`: back to where the task rests (Working while the T3 Working predicate holds,
 *   else the inbox), with a fresh `lastActivityAt` (so a fresh `returnedAt`).
 */
export function resolveTaskStatus(task: Task, event: StatusEvent): Partial<Task> {
  switch (event.kind) {
    case "run_started":
      return started(task, event.trigger, event.now);
    case "run_ended":
      return ended(task, event.outcome);
    case "reopened":
      return {
        status: isTaskWorking(task, { activeRuns: event.activeRuns }) ? "working" : "inbox",
        snoozedUntil: null,
        settledAt: null,
        lastActivityAt: event.now,
        ...(task.settleRequested ? { settleRequested: false } : {}),
      };
    case "question_asked":
      return asked(task, event.now);
    case "question_resolved":
      return resolved(task);
  }
}

/**
 * A question surfaces the task like a proposal (approvals keep priority). A settled or archived
 * task records it without moving (R4-9). A subtask's question goes to its parent instead.
 */
function asked(task: Task, now: string): Partial<Task> {
  const needsUser = waitingOn(task);
  if (!needsUser) {
    return {};
  }
  if (task.status === "settled" || task.status === "archived") {
    return { needsUser };
  }
  return task.status === "inbox" && task.needsUser === needsUser ? {} : surface(needsUser, now);
}

/** An answered or dismissed question: the next thing waiting on the person, if any. */
function resolved(task: Task): Partial<Task> {
  const next = waitingOn(task);
  if (next) {
    return task.needsUser === next ? {} : { needsUser: next };
  }
  return task.needsUser === "question" ? { needsUser: null } : {};
}

/** Status while a run is queued or running. A user message also wakes a snoozed task. */
export function statusDuringRun(task: Task, trigger: TaskRunTrigger, now: string): Partial<Task> {
  return resolveTaskStatus(task, { kind: "run_started", trigger, now });
}

/**
 * Status when a run ends:
 *  0. a task the person settled, snoozed or archived during the run stays there; a failure
 *     only sets `needsUser`;
 *  1. a failed run (not arrivals, which retry) surfaces with `needsUser: "failure"`, or
 *     `"limited"` when it stopped at a usage limit;
 *  2. pending approvals surface with `needsUser: "approval"`, then pending questions with
 *     `needsUser: "question"` (v0.4);
 *  3. another run of the task still active keeps it Working;
 *  4. a run started by the person's message returns to the inbox (Working while watching);
 *  5. snoozed and archived tasks stay hidden through background work;
 *  6. schedule and watch runs that produced something come back (Working while watching);
 *     ones that produced nothing return to where they were;
 *  7. arrival triage never moves the task by itself.
 * A task that rested in Working (watching) and comes back to the inbox gets a fresh
 * `lastActivityAt` (R4-10), so auto-settle never takes it before the person saw it. A run that
 * hands the task back records an unseen outcome: `done` for the person's runs, `woke` for
 * schedule, watch and wake runs.
 */
export function statusAfterRun(task: Task, outcome: RunOutcome): Partial<Task> {
  return resolveTaskStatus(task, { kind: "run_ended", outcome });
}

function started(task: Task, trigger: TaskRunTrigger, now: string): Partial<Task> {
  if (trigger.kind === "message") {
    return {
      status: "working",
      snoozedUntil: null,
      settledAt: null,
      needsUser: task.needsUser === "failure" ? null : task.needsUser,
      lastActivityAt: now,
      // The person's message outranks the agent's earlier request to settle (task_organize).
      ...(task.settleRequested ? { settleRequested: false } : {}),
    };
  }
  return hidden(task.status) || (task.status === "inbox" && task.needsUser)
    ? {}
    : { status: "working" };
}

/** Settled, snoozed or archived by the person while the run was active (R4-9). */
function putAwayDuringRun(task: Task, outcome: RunOutcome): boolean {
  const away = task.status === "settled" || hidden(task.status);
  return away && outcome.startStatus !== undefined && task.status !== outcome.startStatus;
}

function failureKind(outcome: RunOutcome): TaskNeedsUser {
  return isLimitCode(outcome.error) ? "limited" : "failure";
}

function ended(task: Task, outcome: RunOutcome): Partial<Task> {
  if (putAwayDuringRun(task, outcome)) {
    // Already put away: a pending settle request (task_organize) has nothing left to do.
    const cleared = task.settleRequested ? { settleRequested: false } : {};
    return outcome.failed && outcome.trigger.kind !== "arrival"
      ? { ...cleared, needsUser: failureKind(outcome) }
      : cleared;
  }
  const next = ruleStatus(task, outcome);
  // Resting in Working (watching) before the run and handed back now: the watch ended.
  const handed =
    outcome.preStatus === "working" && next.status === "inbox"
      ? { ...next, lastActivityAt: outcome.now }
      : next;
  const unseen = unseenOutcome(task, handed, outcome);
  const result = unseen ? { ...handed, unseenOutcome: unseen } : handed;
  return task.settleRequested ? settleAtRunEnd(task, result, outcome) : result;
}

/**
 * `task_organize` settle, applied when the run ends: only when nothing then waits on the person
 * (a failure, an approval, a question), no other run is active and no follow-up is queued.
 * Otherwise the request is dropped (failure, waiting on the person) or kept for the next run end.
 */
function settleAtRunEnd(task: Task, next: Partial<Task>, outcome: RunOutcome): Partial<Task> {
  const needsUser = "needsUser" in next ? next.needsUser : task.needsUser;
  if (outcome.failed || needsUser) {
    return { ...next, settleRequested: false };
  }
  if (outcome.otherActiveRuns > 0 || task.queue?.length) {
    return next;
  }
  return {
    ...next,
    status: "settled",
    settledAt: outcome.now,
    snoozedUntil: null,
    watches: [],
    settleRequested: false,
  };
}

/** The outcome badge a run leaves when it hands the task back without needing the person. */
function unseenOutcome(task: Task, next: Partial<Task>, outcome: RunOutcome): TaskUnseenOutcome {
  const needsUser = "needsUser" in next ? next.needsUser : task.needsUser;
  const returned = next.status === "inbox" && next.lastActivityAt !== undefined && !needsUser;
  if (!returned || outcome.failed) {
    return null;
  }
  switch (outcome.trigger.kind) {
    case "message":
      return "done";
    case "arrival":
      return null;
    default:
      return "woke";
  }
}

function ruleStatus(task: Task, outcome: RunOutcome): Partial<Task> {
  const { trigger, now } = outcome;
  if (outcome.failed && trigger.kind !== "arrival") {
    return surface(failureKind(outcome), now);
  }
  if (task.pendingActionIds?.length) {
    return task.status === "inbox" && task.needsUser === "approval" ? {} : surface("approval", now);
  }
  // v0.4: an unanswered question (ask_user) waits on the person like an approval.
  if (waitingOn(task) === "question") {
    return task.status === "inbox" && task.needsUser === "question" ? {} : surface("question", now);
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
