import type { Task } from "@passport/types";
import { useEffect, useRef } from "react";
import { useTasks } from "./store";

/**
 * The open task page marks its task seen: on open, and again when it comes back with something
 * new while the page is visible. "Mark unread" while the page is open holds until it closes.
 */
export function useMarkSeen(id: string, task?: Task) {
  const { view, seen } = useTasks();
  useEffect(() => {
    view(id);
    return () => view(null);
  }, [id, view]);
  const latest = useRef(task);
  latest.current = task;
  // What matters about the task; a new object in the same state does not mark again.
  const key = task ? `${task.id}:${task.unseenOutcome ?? ""}:${task.returnedAt ?? ""}` : "";
  useEffect(() => {
    if (!key) {
      return;
    }
    const mark = () => {
      if (latest.current && document.visibilityState !== "hidden") {
        seen(latest.current);
      }
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [key, seen]);
}
