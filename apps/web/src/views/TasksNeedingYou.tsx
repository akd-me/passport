import type { Task } from "@passport/types";
import { Link } from "react-router";
import { AccountDot, useAccountId } from "../accounts/AccountFilter";
import { relativeTime } from "../components/ui";
import { needsYou } from "../tasks/model";
import { QuestionsNeedingYou } from "../tasks/QuestionsNeedingYou";
import { useTasks } from "../tasks/store";
import { TaskGlyph } from "../tasks/TaskGlyph";

export function needText(task: Task) {
  const pending = task.pendingActionIds?.length ?? 0;
  switch (task.needsUser) {
    case "approval":
      return pending === 1 ? "1 change to approve" : `${pending} changes to approve`;
    case "failure":
      return "Stopped with an error";
    case "question":
      return "Has a question for you";
    default:
      return "";
  }
}

/** One line per task: what it needs and when it came back. */
export function TaskCard({ task }: { task: Task }) {
  const { running } = useTasks();
  return (
    <li>
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
        {task.accountIds.slice(0, 3).map((id) => (
          <AccountDot key={id} id={id} />
        ))}
        <time dateTime={task.lastActivityAt}>{relativeTime(task.lastActivityAt)}</time>
      </Link>
    </li>
  );
}

/** Tasks that came back needing the person, at the top of "Needs you". */
export function TasksNeedingYou() {
  const { tasks, available } = useTasks(),
    accountId = useAccountId();
  // The page's account scope applies to tasks too (R5-16).
  const all = needsYou(tasks).filter((t) => !accountId || t.accountIds.includes(accountId));
  // Questions get their own group, with the question itself (W2A).
  const questions = all.filter((t) => t.needsUser === "question");
  const list = all.filter((t) => t.needsUser !== "question");
  if (!available || !all.length) {
    return null;
  }
  return (
    <>
      <QuestionsNeedingYou tasks={questions} />
      {list.length > 0 && (
        <section className="group" aria-labelledby="tasks-need-you">
          <div className="group-head">
            <h2 id="tasks-need-you">Tasks waiting on you</h2>
            <span className="count">{list.length}</span>
          </div>
          <ul className="task-cards">
            {list.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
