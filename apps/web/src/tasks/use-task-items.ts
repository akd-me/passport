import type { TaskItem } from "@passport/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "../logger";
import { useWorkspace, useWorkspaceEvents } from "../state";
import { ITEMS_PAGE, taskApi } from "./api";

interface ItemsState {
  taskId: string;
  items: TaskItem[];
  loaded: boolean;
  /** Items before the first one held exist; `loadOlder` pages them in. */
  older: boolean;
  loadingOlder: boolean;
  error?: string;
}

const initial = (taskId: string): ItemsState => ({
  taskId,
  items: [],
  loaded: false,
  older: false,
  loadingOlder: false,
});

/** Whether the task has an item after `seq` (seqs are contiguous from 1). */
const after = async (id: string, seq: number) => (await taskApi.items(id, seq, 1)).items.length > 0;

/**
 * The newest page of a task's items without reading the whole history (R5-5). The first page
 * answers small tasks; for longer ones the last seq is found by doubling and halving one-item
 * probes, then the last page or two is fetched.
 */
export async function newestItems(id: string): Promise<{ items: TaskItem[]; first: number }> {
  const head = await taskApi.items(id, 0, ITEMS_PAGE);
  if (head.items.length < ITEMS_PAGE) {
    return { items: head.items, first: 1 };
  }
  let lo = ITEMS_PAGE,
    hi = ITEMS_PAGE * 2;
  while (await after(id, hi)) {
    lo = hi;
    hi *= 2;
  }
  // The last seq is in (lo, hi].
  while (hi - lo > ITEMS_PAGE) {
    const mid = Math.floor((lo + hi) / 2);
    if (await after(id, mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const from = Math.max(0, lo - ITEMS_PAGE);
  const tail = await taskApi.items(id, from, ITEMS_PAGE * 2);
  return { items: tail.items, first: from + 1 };
}

/**
 * The task's timeline: the newest items first, older pages on demand, then extended by
 * `task.item.appended`. After a reconnect (or any workspace refresh) it pages forward from the
 * last contiguous `seq` it holds.
 */
export function useTaskItems(taskId: string) {
  const { version } = useWorkspace();
  const [state, setState] = useState<ItemsState>(() => initial(taskId));
  const current = useRef(taskId),
    lastSeq = useRef(0),
    firstSeq = useRef(1),
    started = useRef(false),
    busy = useRef(false),
    again = useRef(false),
    mounted = useRef(false);

  const merge = useCallback((id: string, incoming: TaskItem[], patch?: Partial<ItemsState>) => {
    setState((s) => {
      if (s.taskId !== id) {
        return s;
      }
      const seen = new Set(s.items.map((item) => item.seq));
      const add = incoming.filter((item) => item.taskId === id && !seen.has(item.seq));
      return {
        ...s,
        ...patch,
        loaded: true,
        error: undefined,
        items: add.length ? [...s.items, ...add].sort((a, b) => a.seq - b.seq) : s.items,
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
      if (!started.current) {
        started.current = true;
        const newest = await newestItems(id);
        if (current.current !== id) {
          return;
        }
        firstSeq.current = newest.first;
        lastSeq.current = newest.items.at(-1)?.seq ?? newest.first - 1;
        merge(id, newest.items, { older: newest.first > 1 });
        // The probes found the end; later items arrive as frames or on the next refresh.
        return;
      }
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

  /** The page before the first item held (scrolling up). */
  const loadOlder = useCallback(() => {
    const id = current.current,
      first = firstSeq.current;
    if (first <= 1) {
      return;
    }
    const from = Math.max(0, first - 1 - ITEMS_PAGE);
    setState((s) => (s.loadingOlder ? s : { ...s, loadingOlder: true }));
    taskApi
      .items(id, from, first - 1 - from)
      .then((page) => {
        if (current.current === id) {
          firstSeq.current = from + 1;
          merge(id, page.items, { older: from > 0, loadingOlder: false });
        }
      })
      .catch(() => {
        logger.warn("Older task items request failed");
        setState((s) => ({ ...s, loadingOlder: false }));
      });
  }, [merge]);

  useEffect(() => {
    // StrictMode runs this twice for one task; the first run's load is still good.
    if (current.current === taskId && started.current) {
      return;
    }
    current.current = taskId;
    lastSeq.current = 0;
    firstSeq.current = 1;
    started.current = false;
    setState(initial(taskId));
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

  const result = state.taskId === taskId ? state : initial(taskId);
  return { ...result, loadOlder };
}
