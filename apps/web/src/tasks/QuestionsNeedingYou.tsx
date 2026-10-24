import type { Task } from "@passport/types";
import { Link } from "react-router";
import { relativeTime } from "../components/ui";
import { TaskGlyph } from "./TaskGlyph";

/** Needs you: tasks whose agent asked the person something, with the question itself. */
export function QuestionsNeedingYou({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) {
    return null;
  }
  return (
    <section className="group" aria-labelledby="questions-need-you">
      <div className="group-head">
        <h2 id="questions-need-you">Questions for you</h2>
        <span className="count">{tasks.length}</span>
      </div>
      <ul className="task-cards">
        {tasks.map((task) => {
          const question = task.pendingQuestions?.[0];
          return (
            <li key={task.id}>
              <Link
                to={`/tasks/${encodeURIComponent(task.id)}`}
                className="task-card"
                data-task-row={task.id}
              >
                <TaskGlyph task={task} />
                <span className="task-card-what">
                  <strong>{task.title}</strong>
                  <span className="need question">
                    {question?.text ?? "Has a question for you"}
                  </span>
                </span>
                <time dateTime={question?.askedAt ?? task.lastActivityAt}>
                  {relativeTime(question?.askedAt ?? task.lastActivityAt)}
                </time>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
