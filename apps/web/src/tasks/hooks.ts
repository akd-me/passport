import type { ActionRecord, Page, Task, TaskItem, TaskRun } from "@passport/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { logger } from "../logger";
import { useWorkspace, useWorkspaceEvents } from "../state";
import { ITEMS_PAGE, taskApi } from "./api";
import { useTasks } from "./store";

interface ItemsState {
  taskId: string;
  items: TaskItem[];
  loaded: boolean;
  error?: string;
}

/**
 * The task's timeline: paged from `afterSeq=0`, then extended by `task.item.appended`. After a
 * reconnect (or any workspace refresh) it pages again from the last contiguous `seq` it holds.
 */
export function useTaskItems(taskId: string) {
  const { version } = useWorkspace();
  const [state, setState] = useState<ItemsState>({ taskId, items: [], loaded: false });
  const current = useRef(taskId),
    lastSeq = useRef(0),
    busy = useRef(false),
    again = useRef(false),
    mounted = useRef(false);

  const merge = useCallback((id: string, incoming: TaskItem[]) => {
    setState((s) => {
      if (s.taskId !== id) {
        return s;
      }
      const seen = new Set(s.items.map((item) => item.seq));
      const add = incoming.filter((item) => item.taskId === id && !seen.has(item.seq));
      if (!add.length) {
        return s.loaded && !s.error ? s : { ...s, loaded: true, error: undefined };
      }
      return {
        ...s,
        loaded: true,
        error: undefined,
        items: [...s.items, ...add].sort((a, b) => a.seq - b.seq),
      };
    });
  }, []);

  const load = useCallback(() => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    const id = current.current;
    const pages = async () => {
      let page: Awaited<ReturnType<typeof taskApi.items>>;
      do {
        page = await taskApi.items(id, lastSeq.current);
        if (current.current !== id) {
          return;
        }
        lastSeq.current = Math.max(lastSeq.current, page.lastSeq);
        merge(id, page.items);
      } while (page.items.length >= ITEMS_PAGE);
    };
    pages()
      .catch((error: unknown) => {
        logger.warn("Task items request failed");
        setState((s) =>
          s.taskId === id
            ? { ...s, loaded: true, error: error instanceof Error ? error.message : "Failed" }
            : s,
        );
      })
      .finally(() => {
        busy.current = false;
        if (again.current || current.current !== id) {
          again.current = false;
          load();
        }
      });
  }, [merge]);

  useEffect(() => {
    current.current = taskId;
    lastSeq.current = 0;
    setState({ taskId, items: [], loaded: false });
    load();
  }, [taskId, load]);

  useEffect(() => {
    if (mounted.current) {
      load();
    }
    mounted.current = true;
  }, [version, load]);

  useWorkspaceEvents((event) => {
    if (event.type !== "task.item.appended" || event.item.taskId !== current.current) {
      return;
    }
    const { item } = event;
    if (item.seq === lastSeq.current + 1 && !busy.current) {
      lastSeq.current = item.seq;
      merge(item.taskId, [item]);
    } else if (item.seq > lastSeq.current) {
      // A gap: show what arrived, then page the missing items in.
      merge(item.taskId, [item]);
      load();
    }
  });

  return state.taskId === taskId ? state : { taskId, items: [], loaded: false };
}

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
 * ActionRecords of the task: every run's `actionIds` (via `/api/actions?runId=`) plus the open
 * decisions, so approvals and change summaries can show the full record.
 */
export function useTaskActions(runs: TaskRun[]) {
  const { version } = useWorkspace();
  const key = runs
    .filter((run) => run.actionIds.length)
    .map((run) => `${run.agentRunId}:${run.actionIds.length}`)
    .join(",");
  const [records, setRecords] = useState<Map<string, ActionRecord>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const runIds = key ? key.split(",").map((part) => part.slice(0, part.lastIndexOf(":"))) : [];
    Promise.all([
      api.decisions().catch(() => ({ items: [] }) as Partial<Page<ActionRecord>>),
      ...runIds.map((runId) => api.actions({ runId, limit: 200 })),
    ])
      .then((pages) => {
        if (!cancelled) {
          const next = new Map<string, ActionRecord>();
          for (const page of pages) {
            for (const record of page.items ?? []) {
              next.set(record.id, record);
            }
          }
          setRecords(next);
        }
      })
      .catch(() => logger.warn("Task actions request failed"));
    return () => {
      cancelled = true;
    };
  }, [key, version]);
  return useMemo(() => records, [records]);
}
