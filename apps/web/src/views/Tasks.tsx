import type { Page, Task } from "@passport/types";
import { useState } from "react";
import { Link } from "react-router";
import { Empty, Feedback, Loading } from "../components/ui";
import { Surface } from "../shell/Surface";
import { useResource } from "../state";
import { groupTasks, SECTIONS } from "../tasks/model";
import { useTasks } from "../tasks/store";
import { TaskCard } from "./TasksNeedingYou";

/** Every task by section; archived ones on request. j/k move, Enter opens. */
export function Tasks() {
  const { tasks, loaded, available, error } = useTasks(),
    [archived, setArchived] = useState(false);
  const old = useResource<Page<Task>>(archived ? "/tasks?status=archived&limit=100" : null);
  const groups = groupTasks(tasks);
  return (
    <Surface title="Tasks">
      <div className="queue-head">
        <h1>Tasks</h1>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setArchived(!archived)}
        >
          {archived ? "Hide archived" : "Show archived"}
        </button>
      </div>
      {!available ? (
        <Empty title="Tasks need the full backend." icon="alert">
          Run <code>passport serve</code>. The demo workspace keeps the v0.2 queue under Needs you.
        </Empty>
      ) : !loaded ? (
        <Loading />
      ) : (
        <>
          <Feedback error={error} />
          {!tasks.length && (
            <Empty title="No tasks yet." icon="sparkle">
              <Link className="btn btn-sm" to="/">
                New task
              </Link>
            </Empty>
          )}
          {SECTIONS.map(({ id, label }) =>
            groups[id].length ? (
              <section className="group" key={id} aria-labelledby={`tasks-${id}`}>
                <div className="group-head">
                  <h2 id={`tasks-${id}`}>{label}</h2>
                  <span className="count">{groups[id].length}</span>
                </div>
                <ul className="task-cards">
                  {groups[id].map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </ul>
              </section>
            ) : null,
          )}
          {archived && (
            <section className="group" aria-labelledby="tasks-archived">
              <div className="group-head">
                <h2 id="tasks-archived">Archived</h2>
                <span className="count">{old.data?.items.length ?? ""}</span>
              </div>
              <Feedback error={old.error} />
              <ul className="task-cards">
                {(old.data?.items ?? []).map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Surface>
  );
}
