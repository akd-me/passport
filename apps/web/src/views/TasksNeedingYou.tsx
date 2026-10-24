import type { Task } from "@passport/types";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAccountId } from "../accounts/AccountFilter";
import { markdownToText } from "../components/Markdown";
import { relativeTime } from "../components/ui";
import { needsYou, returnedOf } from "../tasks/model";
import { useTasks } from "../tasks/store";
import { TaskGlyph } from "../tasks/TaskGlyph";
import { groupNeedsYou } from "./needs-you-groups";

export function needText(task: Task) {
  const pending = task.pendingActionIds?.length ?? 0;
  switch (task.needsUser) {
    case "approval":
      return pending === 1 ? "1 change to approve" : `${pending} changes to approve`;
    case "failure":
      return "Stopped with an error";
    case "question":
      // The question is markdown; a one-line row shows it as plain text.
      return markdownToText(task.pendingQuestions?.[0]?.text ?? "") || "Has a question for you";
    case "limited":
      return "Paused at a usage limit";
    default:
      return "";
  }
}

/** One line per task: what it needs and when it came back; `actions` sit beside the link. */
export function TaskCard({ task, actions }: { task: Task; actions?: ReactNode }) {
  const { running } = useTasks();
  return (
    <li className={actions ? "task-card-row" : undefined}>
      <Link
        to={`/tasks/${encodeURIComponent(task.id)}`}
        className="task-card"
        data-task-row={task.id}
      >
        <TaskGlyph task={task} running={running(task.id)} />
        <span className="task-card-what">
          <strong>{task.title}</strong>
          {needText(task) && <span className={`need ${task.needsUser}`}>{needText(task)}</span>}
        </span>
        <time dateTime={returnedOf(task)}>{relativeTime(returnedOf(task))}</time>
      </Link>
      {actions}
    </li>
  );
}

/**
 * Tasks that came back needing the person, at the top of "Needs you", grouped by what they wait
 * on (`needs-you-groups.ts`): approvals, then usage limits with their recovery actions, then
 * failures.
 */
/** Tasks waiting on the person, in the page's account scope (R5-16). */
export function useTasksNeedingYou() {
  const { tasks, available } = useTasks(),
    accountId = useAccountId();
  return available
    ? needsYou(tasks).filter((t) => !accountId || t.accountIds.includes(accountId))
    : [];
}

export function TasksNeedingYou() {
  const list = useTasksNeedingYou();
  if (!list.length) {
    return null;
  }
  return (
    <>
      {groupNeedsYou(list).map(({ group, tasks: members }) => {
        const Actions = group.actions;
        return (
          <section
            key={group.id}
            className="group needs-group"
            aria-labelledby={`needs-${group.id}`}
            data-needs={group.id}
          >
            <div className="group-head">
              <h2 id={`needs-${group.id}`}>{group.label}</h2>
              <span className="count">{members.length}</span>
            </div>
            <ul className="task-cards">
              {members.map((task) => (
                <TaskCard key={task.id} task={task} actions={Actions && <Actions task={task} />} />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
