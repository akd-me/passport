// Main-process subscription to the server's /ws DomainEvent stream. It keeps the "needs you"
// count and announces tasks and proposals that newly need the person, even with no window open.
import { EventEmitter } from "node:events";
import {
  type Attention,
  type PendingAction,
  type Seen,
  snapshot,
  type TaskSummary,
} from "./attention";
import { log } from "./paths";

/** Task statuses that can need the person; settled and archived tasks never do. */
const OPEN_TASKS = "inbox,working,snoozed";
const TASK_PAGES = 10;

export class DecisionWatcher extends EventEmitter<{
  count: [number];
  attention: [Attention[]];
}> {
  count = 0;
  private socket: WebSocket | null = null;
  private target: { origin: string; token: string } | null = null;
  private known: Seen | null = null;
  /** False once the server answered TASKS_UNAVAILABLE (demo): count pending decisions instead. */
  private tasksAvailable = true;
  private refreshTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;

  /**
   * Keeps the last snapshot across reconnects (the app serves one data directory), so a
   * proposal that arrived while the server was away is still announced.
   */
  connect(origin: string, token: string): void {
    this.teardown();
    this.target = { origin, token };
    this.tasksAvailable = true;
    this.open();
    this.scheduleRefresh(0);
  }

  /** While no server answers there is no count to show, so the badge clears instead of going stale. */
  disconnect(): void {
    this.teardown();
    if (this.count !== 0) {
      this.count = 0;
      this.emit("count", 0);
    }
  }

  private teardown(): void {
    this.target = null;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private open(): void {
    const target = this.target;
    if (!target) {
      return;
    }
    // upgradeStatus accepts ?token= as a bearer credential; Node's WebSocket sends no Origin.
    const url = `${target.origin.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(target.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempt = 0;
      // Anything missed while disconnected shows up in the next list.
      this.scheduleRefresh(0);
    });
    socket.addEventListener("message", (event) => {
      let type: unknown;
      try {
        type = (JSON.parse(String(event.data)) as { type?: unknown }).type;
      } catch {
        // The server only sends DomainEvent JSON; ignore anything else.
        return;
      }
      if (typeof type === "string" && (type.startsWith("action.") || type === "task.updated")) {
        this.scheduleRefresh(250);
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket || !this.target) {
        return;
      }
      this.socket = null;
      const delay = Math.min(1000 * 2 ** this.attempt, 30_000);
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    });
  }

  private scheduleRefresh(delay: number): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  private async get<T>(target: { origin: string; token: string }, path: string): Promise<T> {
    const response = await fetch(`${target.origin}${path}`, {
      headers: { Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 501) {
      throw new TasksUnavailable();
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /** Open tasks, or null when the server has no task routes. */
  private async tasks(target: { origin: string; token: string }): Promise<TaskSummary[] | null> {
    if (!this.tasksAvailable) {
      return null;
    }
    const tasks: TaskSummary[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < TASK_PAGES; page += 1) {
      const query = `status=${OPEN_TASKS}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      try {
        const result = await this.get<{ items?: TaskSummary[]; nextCursor?: string | null }>(
          target,
          `/api/tasks?${query}`,
        );
        tasks.push(...(result.items ?? []));
        cursor = result.nextCursor;
      } catch (error) {
        if (error instanceof TasksUnavailable) {
          this.tasksAvailable = false;
          return null;
        }
        throw error;
      }
      if (!cursor) {
        break;
      }
    }
    return tasks;
  }

  private async refresh(): Promise<void> {
    const target = this.target;
    if (!target) {
      return;
    }
    let decisions: PendingAction[];
    let tasks: TaskSummary[] | null;
    try {
      [decisions, tasks] = await Promise.all([
        this.get<{ items?: PendingAction[] }>(target, "/api/decisions").then((r) => r.items ?? []),
        this.tasks(target),
      ]);
    } catch (error) {
      // The server may be restarting; the socket's reconnect triggers the next refresh.
      log("warn", `Could not list what needs you (${(error as Error).name})`);
      return;
    }
    if (this.target !== target) {
      return;
    }
    const first = this.known === null;
    const next = snapshot(decisions, tasks, this.known);
    this.known = next.seen;
    if (next.count !== this.count || first) {
      this.count = next.count;
      this.emit("count", this.count);
    }
    if (next.fresh.length) {
      this.emit("attention", next.fresh);
    }
  }
}

class TasksUnavailable extends Error {
  override name = "TasksUnavailable";
}
