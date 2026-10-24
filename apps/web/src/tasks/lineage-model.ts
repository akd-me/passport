import type { Task, TaskLineage, TaskLineageChild } from "@passport/types";
import { useEffect, useState } from "react";
import { orchestrationApi } from "./orchestration-api";
import { useTasks } from "./store";

/**
 * A subtask is hidden from the sidebar until it needs the person (an approval, a failure, a
 * limit); it shows in the parent's Lineage panel and timeline instead.
 */
export const isHiddenSubtask = (task: Task) => !!task.delegation && !task.needsUser;

export interface LineageChild extends TaskLineageChild {
  working: boolean;
}

/**
 * The task's parent and children, refetched when the task changes. Each child row prefers the
 * store's live copy (from `/ws`), and counts as working while a run is known to be active.
 */
export function useLineage(task: Task): { parent: Task | null; children: LineageChild[] } {
  const store = useTasks(),
    [lineage, setLineage] = useState<TaskLineage | null>(null);
  // A child the store heard of over `/ws` (a new subtask) refetches even if the parent row did
  // not change.
  const childIds = store.tasks
    .filter((other) => other.parentTaskId === task.id)
    .map((other) => other.id)
    .sort()
    .join(",");
  useEffect(() => {
    let live = true;
    orchestrationApi.lineage(task.id).then(
      (value) => live && setLineage(value),
      // Older servers have no lineage route; the panel stays empty.
      () => live && setLineage(null),
    );
    return () => {
      live = false;
    };
  }, [task.id, task.revision, childIds]);
  if (!lineage || lineage.taskId !== task.id || !Array.isArray(lineage.children)) {
    return { parent: null, children: [] };
  }
  const children = lineage.children.map((child) => {
    const current = store.get(child.task.id);
    const fresh = current && (current.revision ?? 0) > (child.task.revision ?? 0) ? current : null;
    const working = store.running(child.task.id) || (!fresh && child.activeRuns > 0);
    return { ...child, task: fresh ?? child.task, working };
  });
  return { parent: store.get(lineage.parent?.id ?? "") ?? lineage.parent, children };
}

/** "Started 3 subtasks, 2 working" (delegated children only). */
export function subtasksSummary(children: LineageChild[]): string {
  const delegated = children.filter((child) => child.task.delegation);
  const working = delegated.filter((child) => child.working).length;
  const started = `Started ${delegated.length} ${delegated.length === 1 ? "subtask" : "subtasks"}`;
  return working ? `${started}, ${working} working` : started;
}
