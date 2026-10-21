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

/** Frames on /ws: domain events plus setup-task updates from the onboarding service. */
type WorkspaceEvent = DomainEvent | { type: "setup.task.updated"; task: unknown };
type Listener = (event: WorkspaceEvent) => void;
interface WorkspaceState {
  version: number;
  subscribe: (listener: Listener) => () => void;
  refresh: () => void;
  connection: string;
  notice: string;
  notify: (message: string) => void;
}
const Workspace = createContext<WorkspaceState>({
  version: 0,
  subscribe: () => () => {},
  refresh: () => {},
  connection: "Connecting",
  notice: "",
  notify: () => {},
});
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0),
    [connection, setConnection] = useState("Connecting"),
    [notice, notify] = useState("");
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const listeners = useRef(new Set<Listener>());
  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);
  useEffect(() => {
    let socket: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout>,
      debounce: ReturnType<typeof setTimeout>,
      stopped = false,
      attempts = 0;
    const connect = () => {
      if (stopped) {
        return;
      }
      socket = new WebSocket(websocketUrl());
      socket.onopen = () => {
        attempts = 0;
        setConnection("Live");
        refresh();
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
          clearTimeout(debounce);
          debounce = setTimeout(refresh, 120);
        } catch {
          // Workspace event frame could not be processed.
          logger.warn("Workspace event frame could not be processed");

          /* An invalid frame must not interrupt the feed. */
        }
      };
      socket.onclose = () => {
        if (!stopped) {
          void checkSession();
          setConnection("Reconnecting");
          reconnect = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempts++));
        }
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearTimeout(debounce);
      socket?.close();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => notify(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <Workspace.Provider value={{ version, subscribe, refresh, connection, notice, notify }}>
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
