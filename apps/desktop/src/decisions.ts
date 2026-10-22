// Main-process subscription to the server's /ws DomainEvent stream. It keeps the "needs you"
// count and announces new proposals even while no window is open.
import { EventEmitter } from "node:events";
import { log } from "./paths";

/** The slice of ActionRecord (packages/types) this process reads. */
interface PendingAction {
  id: string;
  status: string;
  request?: { type?: string; params?: Record<string, unknown> };
}

export interface NewDecision {
  id: string;
  /** Never message content: an action label and, at most, a subject line. */
  title: string;
}

const LABELS: Record<string, string> = {
  send: "Send a message",
  draft_create: "Save a draft",
  draft_update: "Update a draft",
  draft_delete: "Delete a draft",
  delete: "Delete mail",
  move: "Move mail",
  archive: "Archive mail",
  label: "Label mail",
  unsubscribe: "Unsubscribe",
  calendar_propose: "Propose a meeting",
  calendar_create: "Create an event",
  calendar_update: "Update an event",
  calendar_respond: "Answer an invitation",
  calendar_delete: "Delete an event",
  profile_update: "Update your profile",
};

function describe(action: PendingAction): string {
  const type = action.request?.type ?? "";
  const label = LABELS[type] ?? `Review: ${type.replaceAll("_", " ") || "action"}`;
  const subject = action.request?.params?.subject;
  if (typeof subject !== "string" || !subject.trim()) {
    return label;
  }
  const line = subject.replace(/\s+/g, " ").trim();
  return `${label}: ${line.length > 80 ? `${line.slice(0, 79)}…` : line}`;
}

export class DecisionWatcher extends EventEmitter<{
  count: [number];
  proposed: [NewDecision[]];
}> {
  count = 0;
  private socket: WebSocket | null = null;
  private target: { origin: string; token: string } | null = null;
  private known: Set<string> | null = null;
  private refreshTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;

  connect(origin: string, token: string): void {
    this.disconnect();
    this.target = { origin, token };
    this.known = null;
    this.open();
    this.scheduleRefresh(0);
  }

  disconnect(): void {
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
      if (typeof type === "string" && type.startsWith("action.")) {
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

  private async refresh(): Promise<void> {
    const target = this.target;
    if (!target) {
      return;
    }
    let items: PendingAction[];
    try {
      const response = await fetch(`${target.origin}/api/decisions`, {
        headers: { Authorization: `Bearer ${target.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      items = ((await response.json()) as { items?: PendingAction[] }).items ?? [];
    } catch (error) {
      // The server may be restarting; the socket's reconnect triggers the next refresh.
      log("warn", `Could not list decisions (${(error as Error).name})`);
      return;
    }
    if (this.target !== target) {
      return;
    }
    const proposed = items.filter((item) => item.status === "proposed");
    const known = this.known;
    const first = known === null;
    const fresh = known ? proposed.filter((item) => !known.has(item.id)) : [];
    this.known = new Set(proposed.map((item) => item.id));
    if (proposed.length !== this.count || first) {
      this.count = proposed.length;
      this.emit("count", this.count);
    }
    if (fresh.length) {
      this.emit(
        "proposed",
        fresh.map((item) => ({ id: item.id, title: describe(item) })),
      );
    }
  }
}
