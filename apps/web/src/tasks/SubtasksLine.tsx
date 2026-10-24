import type { Task } from "@passport/types";
import { LineageRow } from "./Lineage";
import { subtasksSummary, useLineage } from "./lineage-model";

/** One collapsed timeline line for the task's subtasks; it opens to the list. */
export function SubtasksLine({ task }: { task: Task }) {
  const { children } = useLineage(task);
  const delegated = children.filter((child) => child.task.delegation);
  if (!delegated.length) {
    return null;
  }
  return (
    <details className="subtasks-line">
      <summary>{subtasksSummary(delegated)}</summary>
      <ul className="link-list lineage-children">
        {delegated.map((child) => (
          <LineageRow key={child.task.id} child={child} />
        ))}
      </ul>
    </details>
  );
}
