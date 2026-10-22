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
/**
 * Resource groups (first `/api` path segment) an event can change. Unlisted events refetch
 * everything. The watcher ticks every 30 s per account, so its events and job runs only touch
 * the accounts / jobs views instead of every mounted resource.
 */
const EVENT_SCOPES: Array<[prefix: string, scopes: string[]]> = [
  ["account.watch.", ["accounts", "doctor"]],
  ["account.sync", ["accounts", "doctor"]],
  ["account.changed", ["accounts", "doctor", "providers"]],
  ["email.", ["emails", "threads"]],
  ["job.", ["jobs"]],
];
export function eventScopes(type: string): string[] | null {
  return EVENT_SCOPES.find(([prefix]) => type.startsWith(prefix))?.[1] ?? null;
}
/** `/accounts?x=1` → `accounts`. */
export const resourceScope = (path: string) => path.replace(/^\//, "").split(/[/?]/)[0] ?? "";

interface WorkspaceState {
  version: number;
  /** Per-scope versions bumped by scoped events; `version` bumps everything. */
  scoped: Record<string, number>;
  subscribe: (listener: Listener) => () => void;
  refresh: () => void;
  connection: string;
  notice: string;
  notify: (message: string) => void;
}
const Workspace = createContext<WorkspaceState>({
  version: 0,
  scoped: {},
  subscribe: () => () => {},
  refresh: () => {},
  connection: "Connecting",
  notice: "",
  notify: () => {},
});
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0),
    [scoped, setScoped] = useState<Record<string, number>>({}),
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
      pending: Set<string> | "all" | null = null,
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
          const scopes = eventScopes(event.type);
          pending = pending === "all" || !scopes ? "all" : new Set([...(pending ?? []), ...scopes]);
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            const due = pending;
            pending = null;
            if (due === "all") {
              refresh();
            } else if (due) {
              setScoped((current) => {
                const next = { ...current };
                for (const scope of due) {
                  next[scope] = (next[scope] ?? 0) + 1;
                }
                return next;
              });
            }
          }, 120);
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
    <Workspace.Provider value={{ version, scoped, subscribe, refresh, connection, notice, notify }}>
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
  const { version, scoped, refresh } = useWorkspace();
  const scopeVersion = path ? (scoped[resourceScope(path)] ?? 0) : 0;
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
  }, [path, version, scopeVersion]);
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
