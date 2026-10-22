import type { Task } from "@passport/types";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AccountDot } from "../accounts/AccountFilter";
import { Empty, Loading } from "../components/ui";
import { Surface } from "../shell/Surface";
import { useTaskActions, useTaskDetail, useTaskItems } from "../tasks/hooks";
import { glyphOf, glyphText, isActiveRun, kindLabel } from "../tasks/model";
import { useTasks } from "../tasks/store";
import { TaskComposer } from "../tasks/TaskComposer";
import { statusLabel, TaskDetails } from "../tasks/TaskDetails";
import { TaskMenu } from "../tasks/TaskMenu";
import type { Clamp } from "../tasks/TaskModes";
import { Timeline } from "../tasks/Timeline";

/** The store and the detail request can each be ahead; the higher revision wins. */
const newest = (a?: Task, b?: Task) =>
  !a ? b : !b ? a : (a.revision ?? 0) >= (b.revision ?? 0) ? a : b;

/** Navigation state from the new-task composer when the server lowered the requested mode. */
export interface TaskLocationState {
  clamp?: Clamp | null;
}

function TaskHeader({ task, running }: { task: Task; running: boolean }) {
  const glyph = glyphOf(task, running),
    kind = kindLabel(task);
  return (
    <header className="task-head">
      <h1>{task.title}</h1>
      <div className="task-meta">
        <span className={`task-status ${task.status}`}>{statusLabel(task)}</span>
        {kind && <span className={`kind-badge ${task.kind}`}>{kind}</span>}
        {glyph !== "idle" && <span className={`task-state ${glyph}`}>{glyphText[glyph]}</span>}
        {task.accountIds.map((id) => (
          <AccountDot key={id} id={id} />
        ))}
      </div>
    </header>
  );
}

/** One task: its timeline, run headers with change summaries, and the composer. */
export function TaskPage() {
  const { id = "" } = useParams(),
    location = useLocation(),
    navigate = useNavigate(),
    [params] = useSearchParams();
  const tasks = useTasks(),
    detail = useTaskDetail(id),
    timeline = useTaskItems(id);
  const task = newest(tasks.get(id), detail.task);
  const actions = useTaskActions(task),
    { records, loadRun } = actions;
  const focus = params.get("approval") ?? undefined;
  const [selected, setSelected] = useState(focus),
    [clamp, setClamp] = useState<Clamp | null>(
      (location.state as TaskLocationState | null)?.clamp ?? null,
    );
  useEffect(() => {
    setSelected(focus);
  }, [focus]);
  useEffect(() => {
    setClamp((location.state as TaskLocationState | null)?.clamp ?? null);
  }, [id, location.state]);
  useEffect(() => {
    if (focus && timeline.loaded) {
      document
        .querySelector(
          `[data-approval="${CSS.escape(focus)}"], [data-decision="${CSS.escape(focus)}"]`,
        )
        ?.scrollIntoView?.({ block: "center" });
    }
  }, [focus, timeline.loaded, records]);
  const { summaries, runOf } = useMemo(() => {
    const summaries = new Map<string, string>(),
      runOf = new Map<string, string | null>();
    for (const item of timeline.items) {
      if (item.kind === "approval_request") {
        summaries.set(item.payload.actionId, item.payload.summary);
        runOf.set(item.payload.actionId, item.runId);
      }
    }
    return { summaries, runOf };
  }, [timeline.items]);
  // A decided approval's record comes with its run's records.
  const selectedRun = selected && !records.has(selected) ? runOf.get(selected) : undefined;
  useEffect(() => {
    const run = detail.runs.find((r) => r.id === selectedRun);
    if (run) {
      loadRun(run);
    }
  }, [selectedRun, detail.runs, loadRun]);
  if (!task) {
    return (
      <Surface title="Task" crumbs={[{ label: "Tasks", to: "/tasks" }, { label: "Task" }]}>
        {detail.loaded ? (
          <Empty title="This task is not available." icon="alert">
            {detail.code === "TASKS_UNAVAILABLE" ? (
              "Tasks need the full backend (passport serve)."
            ) : (
              <>
                {detail.error} <Link to="/tasks">See all tasks</Link>
              </>
            )}
          </Empty>
        ) : (
          <Loading />
        )}
      </Surface>
    );
  }
  const running = tasks.running(id) || detail.runs.some(isActiveRun);
  return (
    <Surface
      title={task.title}
      crumbs={[{ label: "Tasks", to: "/tasks" }, { label: task.title }]}
      actions={
        <TaskMenu
          task={task}
          onDone={(action) => action.kind === "archive" && navigate("/tasks")}
        />
      }
      details={
        <TaskDetails
          task={task}
          runs={detail.runs}
          selected={selected ? records.get(selected) : undefined}
        />
      }
      detailsLabel="Task details"
      composer={
        <TaskComposer
          task={task}
          running={running}
          summaries={summaries}
          clamp={clamp}
          onClamp={setClamp}
          onSelectApproval={setSelected}
        />
      }
    >
      <TaskHeader task={task} running={running} />
      <Timeline
        task={task}
        items={timeline.items}
        runs={detail.runs}
        records={records}
        pending={actions.pending}
        onRetry={actions.retryPending}
        loaded={timeline.loaded}
        error={timeline.error}
        older={timeline.older}
        loadingOlder={timeline.loadingOlder}
        onOlder={timeline.loadOlder}
        selected={selected}
        onSelect={setSelected}
      />
    </Surface>
  );
}
