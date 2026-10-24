import {
  type Task,
  type TaskRun,
  type TaskRunStatus,
  type TaskRunTrigger,
  taskBadge,
} from "@passport/types";
import { isHiddenSubtask } from "./lineage-model";

export type SectionId = "pinned" | "inbox" | "working" | "snoozed" | "settled";
export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "inbox", label: "Inbox" },
  { id: "working", label: "Working" },
  { id: "snoozed", label: "Snoozed" },
  { id: "settled", label: "Settled" },
];

/** "When it last came back to you" (T3's inbox order); rows written before v0.4 lack it. */
export const returnedOf = (task: Task) => task.returnedAt ?? task.lastActivityAt;

/** Most recent first by `returnedAt`, then id for a stable order. */
export function byActivity(a: Task, b: Task) {
  return returnedOf(b).localeCompare(returnedOf(a)) || b.id.localeCompare(a.id);
}

/** The sidebar section a task sits in; archived tasks are not listed. */
export function sectionOf(task: Task): SectionId | null {
  if (task.status === "archived") {
    return null;
  }
  return task.pinned ? "pinned" : task.status;
}

export function groupTasks(tasks: Iterable<Task>): Record<SectionId, Task[]> {
  const groups: Record<SectionId, Task[]> = {
    pinned: [],
    inbox: [],
    working: [],
    snoozed: [],
    settled: [],
  };
  for (const task of tasks) {
    const section = isHiddenSubtask(task) ? null : sectionOf(task);
    if (section) {
      groups[section].push(task);
    }
  }
  for (const list of Object.values(groups)) {
    list.sort(byActivity);
  }
  // Snoozed tasks in the order they come back (R5-18).
  groups.snoozed.sort(
    (a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? "") || byActivity(a, b),
  );
  return groups;
}

export const needsYou = (tasks: Iterable<Task>) =>
  [...tasks].filter((t) => t.needsUser && t.status !== "archived").sort(byActivity);

/**
 * The one status vocabulary, shared by the sidebar, the task header, Needs you and the task
 * list: `taskBadge` from `@passport/types`, with `idle` for the absence of a badge.
 */
export type TaskState = NonNullable<ReturnType<typeof taskBadge>> | "idle";

/**
 * What the task's status mark shows. `active` is true when a run of the task is known to be
 * queued or running (from `task.run.updated`); a working task without watches is running too,
 * since its runs may not have reached this client yet.
 */
export function taskState(task: Task, active = false): TaskState {
  // After Stop the queue is held: a `working` task with no run known to be active is not Working.
  const running = active || (task.status === "working" && !task.watches.length && !task.queueHeld);
  // `limited` without `needsUser` (an older frame, or a resume-at-reset that kept it) still reads Limited.
  const needsUser = task.needsUser ?? (task.limited ? "limited" : null);
  return taskBadge({ ...task, needsUser }, { activeRuns: running ? 1 : 0 }) ?? "idle";
}

/** The badge word for each state, as T3 Code names them. */
export const stateLabel: Record<TaskState, string> = {
  approval: "Approval",
  input: "Input",
  waiting: "Waiting",
  working: "Working",
  limited: "Limited",
  failed: "Failed",
  woke: "Woke",
  done: "Done",
  idle: "",
};

/** The same state as a sentence, for titles and screen readers. */
export const stateText: Record<TaskState, string> = {
  approval: "Needs your approval",
  input: "Has a question for you",
  waiting: "Waiting on a reply",
  working: "Working",
  limited: "Paused at a usage limit",
  failed: "Failed",
  woke: "Woke up with something new",
  done: "Finished, not yet seen",
  idle: "",
};

/**
 * Something came back that the person has not looked at: it needs them, or it finished or woke
 * unseen. Everything else recedes (the server's rule, docs/tasks.md "Returned, seen").
 */
export const isFresh = (task: Task) => !!(task.needsUser || task.unseenOutcome);

/** The task has news `POST /seen` would clear: an unseen outcome, or a return after the last look. */
export const needsSeen = (task: Task) =>
  !!task.unseenOutcome || (!!task.returnedAt && !!task.seenAt && task.returnedAt > task.seenAt);

/**
 * The tasks ⌘1–⌘9 open: the sidebar's open sections in order (Pinned, Inbox, Working, Snoozed).
 * Settled is folded and paged on demand, so it never takes a number.
 */
export function jumpOrder(tasks: Iterable<Task>): Task[] {
  const groups = groupTasks(tasks);
  return [...groups.pinned, ...groups.inbox, ...groups.working, ...groups.snoozed].slice(0, 9);
}

export const kindLabel = (task: Task) =>
  task.kind === "inbox" ? "Inbox" : task.kind === "routine" ? "Routine" : null;

const ACTIVE: TaskRunStatus[] = ["queued", "running", "waiting"];
export const isActiveRun = (run: TaskRun) => ACTIVE.includes(run.status);

export const runStatusText: Record<TaskRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

export function triggerText(trigger: TaskRunTrigger): string {
  switch (trigger.kind) {
    case "message":
      return trigger.mode === "steer" ? "You redirected it" : "You asked";
    case "arrival":
      return "New mail arrived";
    case "schedule":
      return `Routine: ${trigger.name}`;
    case "watch":
      return "Reply on a watched conversation";
    case "wake":
      return trigger.reason === "watch_expired"
        ? "Watch ended after 14 days"
        : trigger.reason.replaceAll("_", " ");
  }
}

export function duration(run: TaskRun): string | null {
  if (!run.startedAt || !run.endedAt) {
    return null;
  }
  return milliseconds(Date.parse(run.endedAt) - Date.parse(run.startedAt));
}

export function milliseconds(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  }
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Snooze presets from `now`, all in the future, in local time. */
export function snoozePresets(now = new Date()): { label: string; until: Date }[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const presets = [{ label: "In an hour", until: new Date(now.getTime() + 3_600_000) }];
  if (now.getHours() < 17) {
    presets.push({ label: "This evening", until: at(0, 18) });
  }
  presets.push({ label: "Tomorrow morning", until: at(1, 8) });
  const toMonday = (8 - now.getDay()) % 7 || 7;
  presets.push({ label: "Next week", until: at(toMonday, 8) });
  return presets;
}
