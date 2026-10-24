import type { Task } from "@passport/types";
import type { ComponentType } from "react";
import { LimitedRowActions } from "../tasks/LimitedActions";

/**
 * One group of tasks on Needs you, by what the task waits on (`needsUser`). Groups show in this
 * order; a task joins the first group that matches it, and a task no group claims shows under
 * "Waiting on you", so a new `needsUser` kind is never hidden.
 */
export interface NeedsYouGroup {
  id: string;
  /** The section heading. */
  label: string;
  match: (task: Task) => boolean;
  /** Controls beside each row, outside its link (Resume for Limited). */
  actions?: ComponentType<{ task: Task }>;
}

/**
 * The groups, highest first. To add one, add an entry here, or call
 * `registerNeedsYouGroup` from the feature's own module; nothing else needs to change.
 */
export const needsYouGroups: NeedsYouGroup[] = [
  { id: "approval", label: "Approvals", match: (t) => t.needsUser === "approval" },
  { id: "question", label: "Questions for you", match: (t) => t.needsUser === "question" },
  {
    id: "limited",
    label: "Paused at a usage limit",
    match: (t) => t.needsUser === "limited",
    actions: LimitedRowActions,
  },
  { id: "failed", label: "Failed", match: (t) => t.needsUser === "failure" },
];

/** Adds a group before the group `before` (or last), replacing one with the same id. */
export function registerNeedsYouGroup(group: NeedsYouGroup, before?: string) {
  const known = needsYouGroups.findIndex((g) => g.id === group.id);
  if (known >= 0) {
    needsYouGroups.splice(known, 1);
  }
  const at = before ? needsYouGroups.findIndex((g) => g.id === before) : -1;
  needsYouGroups.splice(at >= 0 ? at : needsYouGroups.length, 0, group);
}

const other: NeedsYouGroup = { id: "other", label: "Waiting on you", match: () => true };

/** The non-empty groups for these tasks (already in Needs you order), each keeping that order. */
export function groupNeedsYou(tasks: Task[]): { group: NeedsYouGroup; tasks: Task[] }[] {
  const groups = [...needsYouGroups, other].map((group) => ({ group, tasks: [] as Task[] }));
  for (const task of tasks) {
    groups.find(({ group }) => group.match(task))?.tasks.push(task);
  }
  return groups.filter((g) => g.tasks.length);
}
