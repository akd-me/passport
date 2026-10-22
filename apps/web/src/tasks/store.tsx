import type { Task, TaskRun } from "@passport/types";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError } from "../api";
import { logger } from "../logger";
import { useWorkspace, useWorkspaceEvents } from "../state";
import { ActionsProvider } from "./actions-store";
import { taskApi } from "./api";
import { isActiveRun } from "./model";

export type TaskAction =
  | { kind: "pin" }
  | { kind: "unpin" }
  | { kind: "snooze"; until: string }
  | { kind: "settle" }
  | { kind: "archive" };

interface TasksState {
  /** The first list request finished (or failed). */
  loaded: boolean;
  /** False on the demo backend, which answers `501 TASKS_UNAVAILABLE`. */
  available: boolean;
  error?: string;
  tasks: Task[];
  get: (id: string) => Task | undefined;
  /** A run of the task is queued or running, as far as this client has seen. */
  running: (id: string) => boolean;
  upsert: (task: Task) => void;
  trackRuns: (runs: TaskRun[]) => void;
  /** Optimistic pin / snooze / settle / archive, rolled back if the server refuses. */
  act: (task: Task, action: TaskAction) => Promise<boolean>;
}

const Tasks = createContext<TasksState>({
  loaded: false,
  available: true,
  tasks: [],
  get: () => undefined,
  running: () => false,
  upsert: () => {},
  trackRuns: () => {},
  act: async () => false,
});

const optimistic: Record<TaskAction["kind"], (task: Task, action: TaskAction) => Partial<Task>> = {
  pin: () => ({ pinned: true }),
  unpin: () => ({ pinned: false }),
  snooze: (_task, action) => ({
    status: "snoozed",
    snoozedUntil: action.kind === "snooze" ? action.until : null,
  }),
  settle: () => ({ status: "settled", needsUser: null }),
  archive: () => ({ status: "archived" }),
};
const done: Record<TaskAction["kind"], string> = {
  pin: "Pinned.",
  unpin: "Unpinned.",
  snooze: "Snoozed. It comes back sooner if it needs you.",
  settle: "Settled.",
  archive: "Archived.",
};
function call(id: string, action: TaskAction) {
  switch (action.kind) {
    case "pin":
    case "unpin":
      return taskApi.pin(id, action.kind === "pin");
    case "snooze":
      return taskApi.snooze(id, action.until);
    case "settle":
      return taskApi.settle(id);
    case "archive":
      return taskApi.archive(id);
  }
}

const newer = (incoming: Task, known?: Task) =>
  !known || (incoming.revision ?? 0) >= (known.revision ?? 0);

/** The task list for the shell: sidebar, palette, deep links. Kept current from `/ws`. */
export function TasksProvider({ children }: { children: ReactNode }) {
  const { version, notify } = useWorkspace();
  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map()),
    [status, setStatus] = useState<{ loaded: boolean; available: boolean; error?: string }>({
      loaded: false,
      available: true,
    }),
    [active, setActive] = useState<Map<string, Set<string>>>(() => new Map());
  const latest = useRef(tasks);
  latest.current = tasks;
  /** Tasks with an optimistic change in flight: list refetches do not overwrite them. */
  const inflight = useRef(new Map<string, number>());

  const upsert = useCallback(
    (task: Task) =>
      setTasks((current) =>
        newer(task, current.get(task.id)) ? new Map(current).set(task.id, task) : current,
      ),
    [],
  );
  const trackRuns = useCallback(
    (runs: TaskRun[]) =>
      setActive((current) => {
        const next = new Map(current);
        for (const run of runs) {
          const ids = new Set(next.get(run.taskId));
          if (isActiveRun(run)) {
            ids.add(run.id);
          } else {
            ids.delete(run.id);
          }
          next.set(run.taskId, ids);
        }
        return next;
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    taskApi
      .list()
      .then((page) => {
        if (cancelled) {
          return;
        }
        setTasks((current) => {
          const next = new Map<string, Task>();
          for (const task of current.values()) {
            // Archived tasks are not listed; keep the ones this client has seen.
            if (task.status === "archived" || inflight.current.has(task.id)) {
              next.set(task.id, task);
            }
          }
          for (const task of page.items) {
            const known = current.get(task.id);
            const keep = inflight.current.has(task.id) || !newer(task, known);
            next.set(task.id, keep && known ? known : task);
          }
          return next;
        });
        setStatus({ loaded: true, available: true });
      })
      .catch((error: unknown) => {
        logger.warn("Task list request failed");
        if (!cancelled) {
          setStatus({
            loaded: true,
            available: !(error instanceof ApiError && error.code === "TASKS_UNAVAILABLE"),
            error: error instanceof Error ? error.message : "Tasks could not load.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  useWorkspaceEvents((event) => {
    if (event.type === "task.updated") {
      upsert(event.task);
    } else if (event.type === "task.run.updated") {
      trackRuns([event.run]);
    }
  });

  const act = useCallback(
    async (task: Task, action: TaskAction) => {
      const previous = latest.current.get(task.id) ?? task;
      const guess = { ...previous, ...optimistic[action.kind](previous, action) };
      inflight.current.set(task.id, (inflight.current.get(task.id) ?? 0) + 1);
      setTasks((current) => new Map(current).set(task.id, guess));
      const release = () => {
        const left = (inflight.current.get(task.id) ?? 1) - 1;
        if (left > 0) {
          inflight.current.set(task.id, left);
        } else {
          inflight.current.delete(task.id);
        }
      };
      try {
        const result = await call(task.id, action);
        release();
        upsert(result);
        notify(done[action.kind]);
        return true;
      } catch (error) {
        logger.warn("Task lifecycle change failed; rolling back");
        release();
        // Undo the guess unless the server already sent something newer.
        setTasks((current) =>
          current.get(task.id) === guess ? new Map(current).set(task.id, previous) : current,
        );
        notify(error instanceof Error ? error.message : "That change did not save.");
        return false;
      }
    },
    [notify, upsert],
  );

  const value = useMemo<TasksState>(
    () => ({
      ...status,
      tasks: [...tasks.values()],
      get: (id) => tasks.get(id),
      running: (id) => !!active.get(id)?.size,
      upsert,
      trackRuns,
      act,
    }),
    [status, tasks, active, upsert, trackRuns, act],
  );
  return (
    <Tasks.Provider value={value}>
      <ActionsProvider>{children}</ActionsProvider>
    </Tasks.Provider>
  );
}

export const useTasks = () => useContext(Tasks);
