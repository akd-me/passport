import type { Task, TaskItem, TaskRun } from "@passport/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../logger";
import { useWorkspace, useWorkspaceEvents } from "../state";
import { useActions } from "./actions-store";
import { taskApi } from "./api";
import { useTasks } from "./store";

export { useTaskItems } from "./use-task-items";

/** `GET /api/tasks/:id`: the task and its runs; runs follow `task.run.updated`. */
export function useTaskDetail(taskId: string) {
  const { version } = useWorkspace(),
    { upsert, trackRuns } = useTasks();
  const [state, setState] = useState<{
    taskId: string;
    task?: Task;
    runs: TaskRun[];
    loaded: boolean;
    error?: string;
    code?: string;
  }>({ taskId, runs: [], loaded: false });
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => (s.taskId === taskId ? s : { taskId, runs: [], loaded: false }));
    taskApi
      .get(taskId, controller.signal)
      .then((detail) => {
        setState({ taskId, task: detail.task, runs: detail.runs, loaded: true });
        upsert(detail.task);
        trackRuns(detail.runs);
      })
      .catch((error: unknown) => {
        logger.warn("Task detail request failed or was cancelled");
        if (!controller.signal.aborted) {
          setState((s) => ({
            ...s,
            taskId,
            loaded: true,
            error: error instanceof Error ? error.message : "The task could not load.",
            code: (error as { code?: string }).code,
          }));
        }
      });
    return () => controller.abort();
  }, [taskId, version, upsert, trackRuns]);
  useWorkspaceEvents((event) => {
    if (event.type !== "task.run.updated" || event.run.taskId !== taskId) {
      return;
    }
    setState((s) => {
      const runs = [event.run, ...s.runs.filter((run) => run.id !== event.run.id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      return { ...s, runs };
    });
  });
  return state.taskId === taskId ? state : { taskId, runs: [], loaded: false };
}

/**
 * ActionRecords for the task page, from the shared cache: the open decisions are fetched when a
 * pending id has no record; run records load when a change summary opens (R5-2).
 */
export function useTaskActions(task?: Task) {
  const actions = useActions(),
    { ensurePending } = actions;
  const key = (task?.pendingActionIds ?? []).join(",");
  useEffect(() => {
    if (key) {
      ensurePending(key.split(","));
    }
  }, [key, ensurePending]);
  return actions;
}
