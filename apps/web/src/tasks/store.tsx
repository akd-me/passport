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
import { isOpen, listOpen, listSettled } from "./list-loader";
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
  /** Unpinned settled tasks page in on demand (the folded section, R5-3). */
  settled: { loaded: boolean; loading: boolean; more: boolean };
  loadSettled: () => void;
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
  settled: { loaded: false, loading: false, more: false },
  loadSettled: () => {},
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
  // No route reverses these (R5-9); the toast says where the task went instead of offering Undo.
  settle: "Settled. A message to it opens it again.",
  archive: "Archived. Find it under Show archived on Tasks.",
};
/** The change that reverses an action, where the API has one. */
const inverse: Partial<Record<TaskAction["kind"], TaskAction>> = {
  pin: { kind: "unpin" },
  unpin: { kind: "pin" },
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
  const { version, reconnects, notify } = useWorkspace();
  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map()),
    [status, setStatus] = useState<{ loaded: boolean; available: boolean; error?: string }>({
      loaded: false,
      available: true,
    }),
    [settled, setSettled] = useState({ loaded: false, loading: false, more: false }),
    [active, setActive] = useState<Map<string, Set<string>>>(() => new Map());
  const latest = useRef(tasks);
  latest.current = tasks;
  /**
   * Tasks with an optimistic change in flight, and its fields: list refetches do not overwrite
   * them and frames are read with the guess on top (R5-11).
   */
  const inflight = useRef(new Map<string, { count: number; fields: Partial<Task> }>());
  /** When a frame or a create last wrote each task: a list request older than that is stale (R5-13). */
  const seenAt = useRef(new Map<string, number>());
  /** Runs seen finished; a late detail response cannot mark them running again (R5-4). */
  const ended = useRef(new Set<string>());
  const activeIds = useRef<string[]>([]);
  activeIds.current = [...active].filter(([, runs]) => runs.size).map(([id]) => id);
  const settledCursor = useRef<string | null | undefined>(undefined),
    settledShown = useRef(0);

  const upsert = useCallback((task: Task) => {
    seenAt.current.set(task.id, Date.now());
    const guess = inflight.current.get(task.id)?.fields;
    const incoming = guess ? { ...task, ...guess } : task;
    setTasks((current) =>
      newer(incoming, current.get(task.id)) ? new Map(current).set(task.id, incoming) : current,
    );
  }, []);
  const trackRuns = useCallback(
    /** `replaceFor`: these are all the task's runs, so forget what was thought active. */
    (runs: TaskRun[], replaceFor?: string) =>
      setActive((current) => {
        const next = new Map(current);
        for (const run of runs) {
          if (!isActiveRun(run)) {
            ended.current.add(run.id);
          }
        }
        if (replaceFor) {
          next.set(replaceFor, new Set());
        }
        for (const run of runs) {
          const ids = new Set(next.get(run.taskId));
          if (isActiveRun(run) && !ended.current.has(run.id)) {
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

  /** Merge a list response over the store: `covers` says which known tasks it is complete for. */
  const merge = useCallback((items: Task[], covers: (task: Task) => boolean, startedAt: number) => {
    setTasks((current) => {
      const next = new Map<string, Task>();
      for (const task of current.values()) {
        // Archived and other uncovered tasks stay; so do tasks written after the request began.
        if (
          !covers(task) ||
          inflight.current.has(task.id) ||
          (seenAt.current.get(task.id) ?? 0) >= startedAt
        ) {
          next.set(task.id, task);
        }
      }
      for (const task of items) {
        const known = next.get(task.id) ?? current.get(task.id);
        const keep = inflight.current.has(task.id) || !newer(task, known);
        next.set(task.id, keep && known ? known : task);
      }
      return next;
    });
  }, []);

  const loadSettled = useCallback(
    (refetch = false) => {
      const startedAt = Date.now();
      setSettled((s) => ({ ...s, loading: true }));
      const cursor = refetch ? undefined : settledCursor.current;
      listSettled(cursor, refetch ? settledShown.current : undefined)
        .then((page) => {
          settledCursor.current = page.nextCursor;
          settledShown.current = (refetch ? 0 : settledShown.current) + page.items.length;
          merge(
            page.items,
            (task) => refetch && task.status === "settled" && !task.pinned,
            startedAt,
          );
          setSettled({ loaded: true, loading: false, more: !!page.nextCursor });
        })
        .catch(() => {
          logger.warn("Settled tasks request failed");
          setSettled((s) => ({ ...s, loading: false }));
        });
    },
    [merge],
  );

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    listOpen()
      .then((items) => {
        if (cancelled) {
          return;
        }
        merge(items, isOpen, startedAt);
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
    if (version && settledShown.current) {
      loadSettled(true);
    }
    return () => {
      cancelled = true;
    };
  }, [version, merge, loadSettled]);

  // After a reconnect, runs may have ended while frames were lost: ask each task that looked
  // busy for its runs again, replacing what this client thought (R5-4).
  useEffect(() => {
    if (!reconnects) {
      return;
    }
    const busy = [...latest.current.values()].filter((task) => task.status === "working");
    const ids = new Set([...busy.map((task) => task.id), ...activeIds.current]);
    for (const id of ids) {
      taskApi
        .get(id)
        .then((detail) => {
          upsert(detail.task);
          trackRuns(detail.runs, id);
        })
        .catch(() => logger.warn("Task refresh after reconnect failed"));
    }
  }, [reconnects, upsert, trackRuns]);

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
      const fields = optimistic[action.kind](previous, action),
        guess = { ...previous, ...fields };
      const held = inflight.current.get(task.id);
      inflight.current.set(task.id, {
        count: (held?.count ?? 0) + 1,
        fields: { ...held?.fields, ...fields },
      });
      setTasks((current) => new Map(current).set(task.id, guess));
      const release = () => {
        const left = inflight.current.get(task.id);
        if (left && left.count > 1) {
          inflight.current.set(task.id, { ...left, count: left.count - 1 });
        } else {
          inflight.current.delete(task.id);
        }
      };
      try {
        const result = await call(task.id, action);
        release();
        upsert(result);
        const undo = inverse[action.kind];
        notify(
          done[action.kind],
          undo && { label: "Undo", undo: true, run: () => void actRef.current(result, undo) },
        );
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
  const actRef = useRef(act);
  actRef.current = act;

  const value = useMemo<TasksState>(
    () => ({
      ...status,
      tasks: [...tasks.values()],
      get: (id) => tasks.get(id),
      settled,
      loadSettled: () => loadSettled(),
      running: (id) => !!active.get(id)?.size,
      upsert,
      trackRuns,
      act,
    }),
    [status, tasks, settled, loadSettled, active, upsert, trackRuns, act],
  );
  return (
    <Tasks.Provider value={value}>
      <ActionsProvider>{children}</ActionsProvider>
    </Tasks.Provider>
  );
}

export const useTasks = () => useContext(Tasks);
