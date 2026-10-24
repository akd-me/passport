import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type DomainEvent, request } from "./api";
import { checkSession, websocketUrl } from "./auth";
import { logger } from "./logger";
import { createRefreshThrottle } from "./refresh-throttle";

/** Frames on /ws: domain events plus setup-task updates from the onboarding service. */
type WorkspaceEvent = DomainEvent | { type: "setup.task.updated"; task: unknown };
type Listener = (event: WorkspaceEvent) => void;
/** A toast button, such as Undo; it disappears with the toast. */
export interface NoticeAction {
  label: string;
  run: () => void;
  /** ⌘Z runs it too, while the toast shows. */
  undo?: boolean;
}
interface WorkspaceState {
  version: number;
  /** Counts reconnects of `/ws` (not the first connect): what may have changed offline. */
  reconnects: number;
  subscribe: (listener: Listener) => () => void;
  refresh: () => void;
  connection: string;
  notice: string;
  noticeAction?: NoticeAction;
  notify: (message: string, action?: NoticeAction) => void;
}
const Workspace = createContext<WorkspaceState>({
  version: 0,
  reconnects: 0,
  subscribe: () => () => {},
  refresh: () => {},
  connection: "Connecting",
  notice: "",
  notify: () => {},
});
/** How long a toast, and its Undo, stays. */
export const NOTICE_MS = 5000;
/** Window focus refetches only data older than this (R5-2, R5-12). */
export const FOCUS_STALE_MS = 30_000;
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0),
    [reconnects, setReconnects] = useState(0),
    [connection, setConnection] = useState("Connecting"),
    [toast, setToast] = useState<{ notice: string; noticeAction?: NoticeAction }>({ notice: "" });
  const notify = useCallback(
    (message: string, action?: NoticeAction) =>
      setToast({ notice: message, noticeAction: message ? action : undefined }),
    [],
  );
  const refreshedAt = useRef(Date.now());
  const refresh = useCallback(() => {
    refreshedAt.current = Date.now();
    setVersion((v) => v + 1);
  }, []);
  const listeners = useRef(new Set<Listener>());
  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);
  useEffect(() => {
    let socket: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout>,
      stopped = false,
      dropped = false,
      attempts = 0;
    const throttle = createRefreshThrottle(refresh);
    const connect = () => {
      if (stopped) {
        return;
      }
      socket = new WebSocket(websocketUrl());
      socket.onopen = () => {
        attempts = 0;
        setConnection("Live");
        // The first connect follows the first fetches; only a reconnect may have missed events.
        if (dropped) {
          dropped = false;
          setReconnects((n) => n + 1);
          refresh();
        }
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as WorkspaceEvent;
          if (!event.type) {
            return;
          }
          for (const listener of listeners.current) {
            listener(event);
          }
          throttle.push(event as { type: string });
        } catch {
          // Workspace event frame could not be processed.
          logger.warn("Workspace event frame could not be processed");

          /* An invalid frame must not interrupt the feed. */
        }
      };
      socket.onclose = () => {
        if (!stopped) {
          dropped = true;
          void checkSession();
          setConnection("Reconnecting");
          reconnect = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempts++));
        }
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    const onFocus = () => {
      if (Date.now() - refreshedAt.current > FOCUS_STALE_MS) {
        refresh();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      throttle.cancel();
      socket?.close();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast.notice) {
      return;
    }
    const timer = setTimeout(() => notify(""), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [toast, notify]);
  return (
    <Workspace.Provider
      value={{ version, reconnects, subscribe, refresh, connection, ...toast, notify }}
    >
      {children}
    </Workspace.Provider>
  );
}
export const useWorkspace = () => useContext(Workspace);
/** Run `handler` for every event frame; the latest handler is always used. */
export function useWorkspaceEvents(handler: Listener) {
  const { subscribe } = useWorkspace(),
    latest = useRef(handler);
  latest.current = handler;
  useEffect(() => subscribe((event) => latest.current(event)), [subscribe]);
}
export function useResource<T>(path: string | null) {
  const { version, refresh } = useWorkspace();
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  useEffect(() => {
    if (!path) {
      setState({ loading: false });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, error: undefined, loading: true }));
    request<T>(path, { signal: controller.signal })
      .then((data) => setState({ data, loading: false }))
      .catch((error) => {
        // Resource request failed or was cancelled.
        logger.warn("Resource request failed or was cancelled");

        if (!controller.signal.aborted) {
          setState({ error: error.message, loading: false });
        }
      });
    return () => controller.abort();
  }, [path, version]);
  return { ...state, refresh };
}
export function useTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    running = useRef(false);
  const { refresh, notify } = useWorkspace();
  const run = async (task: () => Promise<unknown>, message = "Saved.") => {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
      refresh();
      notify(message);
      return true;
    } catch (e) {
      // Workspace action failed.
      logger.warn("Workspace action failed");

      setError(e instanceof Error ? e.message : "Please try again.");
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}
