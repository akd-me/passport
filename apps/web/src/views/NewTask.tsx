import { Link } from "react-router";
import { Composer } from "../shell/Composer";
import { Surface } from "../shell/Surface";
import { needsYou } from "../tasks/model";
import { useTasks } from "../tasks/store";
import { TaskCard } from "./TasksNeedingYou";
import { PromotionPrompts } from "./Trust";

/** Home: start a task. What already needs the person sits underneath, a click away. */
export function NewTask() {
  const { tasks, available } = useTasks();
  const waiting = needsYou(tasks);
  return (
    <Surface title="New task">
      <div className="new-task">
        <h1>What should Passport do?</h1>
        <p className="muted">
          It reads your mail on demand, shows every step in the task, and asks before anything your
          permission mode doesn’t cover.
        </p>
        {!available && (
          <p className="side-note new-task-note" role="note">
            Tasks need the full backend (<code>passport serve</code>). The demo workspace can’t
            start them; its proposals are under <Link to="/needs-you">Needs you</Link>.
          </p>
        )}
        <PromotionPrompts />
        <Composer showSuggestions autoFocus />
        {waiting.length > 0 && (
          <section className="group new-task-waiting" aria-labelledby="home-waiting">
            <div className="group-head">
              <h2 id="home-waiting">Waiting on you</h2>
              <Link to="/needs-you" className="quiet-link">
                Needs you
              </Link>
            </div>
            <ul className="task-cards">
              {waiting.slice(0, 5).map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </Surface>
  );
}
