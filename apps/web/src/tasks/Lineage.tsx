import type { Task } from "@passport/types";
import { Link } from "react-router";
import { type LineageChild, useLineage } from "./lineage-model";
import { TaskGlyph } from "./TaskGlyph";

const stateText = (child: LineageChild) =>
  child.working
    ? "Working"
    : child.task.pendingQuestions?.length
      ? "Asked a question"
      : child.task.needsUser === "approval"
        ? "Needs your approval"
        : child.lastRunStatus === "failed"
          ? "Failed"
          : child.lastRunStatus === "cancelled"
            ? "Stopped"
            : "Done";

/** One child row: status mark, title link, state word. */
export function LineageRow({ child }: { child: LineageChild }) {
  return (
    <li>
      <TaskGlyph task={child.task} running={child.working} />
      <Link to={`/tasks/${encodeURIComponent(child.task.id)}`}>{child.task.title}</Link>
      <small className="muted">{stateText(child)}</small>
    </li>
  );
}

/** Task details: the parent this task was delegated from, and the tasks it started. */
export function Lineage({ task }: { task: Task }) {
  const { parent, children } = useLineage(task);
  if (!parent && !children.length) {
    return null;
  }
  return (
    <section className="lineage">
      <h3>Lineage</h3>
      {parent && (
        <p className="lineage-parent">
          {task.delegation ? "Subtask of " : "Started by "}
          <Link to={`/tasks/${encodeURIComponent(parent.id)}`}>{parent.title}</Link>
        </p>
      )}
      {children.length > 0 && (
        <ul className="link-list lineage-children">
          {children.map((child) => (
            <LineageRow key={child.task.id} child={child} />
          ))}
        </ul>
      )}
    </section>
  );
}
