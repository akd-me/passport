import type { Task, TaskRun, TaskRunStatus, TaskRunTrigger } from "@passport/types";
import { isHiddenSubtask } from "./lineage-model";

export type SectionId = "pinned" | "inbox" | "working" | "snoozed" | "settled";
export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "inbox", label: "Inbox" },
  { id: "working", label: "Working" },
  { id: "snoozed", label: "Snoozed" },
  { id: "settled", label: "Settled" },
];

/** Most recent first: "when it last came back to you", then id for a stable order. */
export function byActivity(a: Task, b: Task) {
  return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id);
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

export type TaskGlyph = "running" | "watching" | "approval" | "failure" | "question" | "idle";

/**
 * What the row's status mark shows. `active` is true when a run of the task is known to be
 * queued or running (from `task.run.updated`); a working task without watches is running too.
 */
export function glyphOf(task: Task, active = false): TaskGlyph {
  if (task.needsUser === "failure") {
    return "failure";
  }
  if (task.needsUser === "approval") {
    return "approval";
  }
  if (task.needsUser === "question") {
    return "question";
  }
  if (active || (task.status === "working" && !task.watches.length)) {
    return "running";
  }
  return task.watches.length ? "watching" : "idle";
}

export const glyphText: Record<TaskGlyph, string> = {
  running: "Working",
  watching: "Watching a conversation",
  approval: "Needs your approval",
  failure: "Failed",
  question: "Has a question",
  idle: "",
};

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
