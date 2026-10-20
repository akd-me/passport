import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { request, type DomainEvent } from "./api";
interface WorkspaceState {
  version: number;
  refresh: () => void;
  connection: string;
  notice: string;
  notify: (message: string) => void;
}
const Workspace = createContext<WorkspaceState>({
  version: 0,
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
  useEffect(() => {
    let socket: WebSocket | undefined,
      reconnect: ReturnType<typeof setTimeout>,
      debounce: ReturnType<typeof setTimeout>,
      stopped = false,
      attempts = 0;
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
      );
      socket.onopen = () => {
        attempts = 0;
        setConnection("Live");
        refresh();
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as DomainEvent;
          if (!event.type) return;
          clearTimeout(debounce);
          debounce = setTimeout(refresh, 120);
        } catch {
          /* An invalid frame must not interrupt the feed. */
        }
      };
      socket.onclose = () => {
        if (!stopped) {
          setConnection("Reconnecting");
          reconnect = setTimeout(
            connect,
            Math.min(30000, 1000 * 2 ** attempts++),
          );
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
    if (!notice) return;
    const timer = setTimeout(() => notify(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <Workspace.Provider
      value={{ version, refresh, connection, notice, notify }}
    >
      {children}
    </Workspace.Provider>
  );
}
export const useWorkspace = () => useContext(Workspace);
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
        if (!controller.signal.aborted)
          setState({ error: error.message, loading: false });
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
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
      refresh();
      notify(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}
