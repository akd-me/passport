import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logger } from "../logger";
import { isFinished, type SetupTask, setupApi } from "../setup-api";
import { useWorkspace, useWorkspaceEvents } from "../state";
import { isStaleSnapshot } from "./setup-task-model";

/**
 * The setup task the user is working through. It lives above the connect dialog so closing
 * the dialog does not orphan a task that still holds the server's single setup slot.
 */
export interface SetupSession {
  task?: SetupTask;
  /** Show `task` unless it is older than the snapshot on screen; `undefined` clears it. */
  update: (task: SetupTask | undefined) => void;
  /** The server accepted an answer to this prompt; it will not be shown again. */
  resolvePrompt: (promptId: string) => void;
}

const POLL_MS = 1500;

export const isActive = (task: SetupTask | undefined) => !!task && !isFinished(task);

/** Most recent first, so the first unfinished task is the one holding the slot. */
export async function findActiveTask() {
  const tasks = await setupApi.list();
  return Array.isArray(tasks) ? tasks.find((task) => isActive(task)) : undefined;
}

export function useSetupSessionState(): SetupSession {
  const [task, setTask] = useState<SetupTask>(),
    latest = useRef<SetupTask>(undefined),
    resolved = useRef(new Set<string>());
  const update = useCallback((next: SetupTask | undefined) => {
    const current = latest.current;
    if (next && isStaleSnapshot(next, current, resolved.current)) {
      return;
    }
    if (!next || next.id !== current?.id) {
      resolved.current = new Set();
    } else if (current.prompt && current.prompt.id !== next.prompt?.id) {
      // A replaced prompt is over: a late snapshot still carrying it is out of date.
      resolved.current.add(current.prompt.id);
    }
    latest.current = next;
    setTask(next);
  }, []);
  const resolvePrompt = useCallback((promptId: string) => {
    resolved.current.add(promptId);
  }, []);
  return useMemo(() => ({ task, update, resolvePrompt }), [task, update, resolvePrompt]);
}

/**
 * Keep the session current while the shell is open, whether or not the dialog is: WebSocket
 * frames are the fast path, serialized polling covers a missed frame, and on load a task that
 * is still running (after a reload, say) is picked back up.
 */
export function useSetupSessionSync({ task, update }: SetupSession) {
  const { refresh } = useWorkspace();
  const id = task?.id,
    active = isActive(task),
    shown = useRef(task);
  shown.current = task;
  useWorkspaceEvents((event) => {
    if (event.type !== "setup.task.updated") {
      return;
    }
    const next = event.task as SetupTask | undefined;
    if (!next?.id) {
      return;
    }
    if (next.id === id || (!active && isActive(next))) {
      update(next);
    }
  });
  useEffect(() => {
    let stopped = false;
    findActiveTask()
      .then((found) => {
        // A task started while the list was loading is the one to keep.
        if (!stopped && found && !isActive(shown.current)) {
          update(found);
        }
      })
      .catch(() => {
        // Setup task recovery failed (older server or demo workspace); starting fresh.
        logger.warn("Setup task recovery failed; starting fresh");
      });
    return () => {
      stopped = true;
    };
  }, [update]);
  useEffect(() => {
    if (!id || !active) {
      return;
    }
    // One request at a time: the next poll is scheduled only once the previous one settles.
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await setupApi.get(id);
        if (!stopped) {
          update(next);
        }
      } catch {
        // Setup status refresh failed; retaining the last state.
        logger.warn("Setup status refresh failed; retaining the last state");

        /* Keep the last known state; the next tick retries. */
      }
      if (!stopped) {
        timer = setTimeout(poll, POLL_MS);
      }
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, active, update]);
  const status = task?.status;
  useEffect(() => {
    if (status === "completed") {
      refresh();
    }
  }, [status, refresh]);
}
